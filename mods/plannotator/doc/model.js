// The document as the reader sees it: every block's rendered text (what the
// browser's selection would give: markdown markers gone, one space between
// words), cut into word tokens, all laid end to end in one flat string.
// Annotations, selections and highlights are ranges of that flat string.

/** @typedef {{ text: string, bold?: boolean, italic?: boolean, code?: boolean, strike?: boolean, link?: string }} Seg */
/** @typedef {{ k: number, b: number, i: number, segs: Seg[], start: number, end: number, gs: number, ge: number, space: Seg | null, row?: number, col?: number }} Token */
/** @typedef {{ block: any, text: string, base: number, tokens: Token[], rows?: Token[][][], lines?: string[], index?: number | null }} Unit */

const INLINE = [
  { re: /^\\([\\`*_{}\[\]()#+\-.!|~>])/, run: (m) => [{ text: m[1] }] },
  { re: /^(`+)([\s\S]+?)\1(?!`)/, run: (m) => [{ text: m[2].replace(/^ (.*) $/, "$1"), code: true }] },
  { re: /^!\[([^\]]*)\]\(([^)\s]*)[^)]*\)/, run: (m) => [{ text: m[1], italic: true }] },
  { re: /^\[([^\]]+)\]\(([^)\s]*)[^)]*\)/, run: (m, st) => inline(m[1], { ...st, link: m[2] }) },
  { re: /^<(https?:\/\/[^>\s]+)>/, run: (m, st) => [{ ...st, text: m[1], link: m[1] }] },
  { re: /^(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/, run: (m, st) => inline(m[2], { ...st, bold: true, italic: true }) },
  { re: /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/, run: (m, st) => inline(m[2], { ...st, bold: true }) },
  { re: /^~~(?=\S)([\s\S]*?\S)~~/, run: (m, st) => inline(m[1], { ...st, strike: true }) },
  { re: /^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/, run: (m, st) => inline(m[1], { ...st, italic: true }) },
  { re: /^_(?=[^\s_])([\s\S]*?[^\s_])_(?![A-Za-z0-9_])/, run: (m, st) => inline(m[1], { ...st, italic: true }) },
];

/** Inline markdown to styled runs. Whitespace is kept as written. */
export function inline(md, style = {}) {
  /** @type {Seg[]} */
  const out = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ ...style, text: plain });
    plain = "";
  };
  let s = md;
  let prevWord = false;
  while (s.length) {
    let hit = null;
    // `_x_` only opens at a word boundary (snake_case stays plain).
    if (!(s[0] === "_" && prevWord)) {
      for (const rule of INLINE) {
        const m = rule.re.exec(s);
        if (m) {
          hit = { m, rule };
          break;
        }
      }
    }
    if (hit) {
      flush();
      for (const seg of hit.rule.run(hit.m, style)) out.push({ ...style, ...seg });
      s = s.slice(hit.m[0].length);
      prevWord = true;
    } else {
      plain += s[0];
      prevWord = /\w/.test(s[0]);
      s = s.slice(1);
    }
  }
  flush();
  return out;
}

/** Runs to word tokens: whitespace splits, a style change inside a word does not. */
function words(segs) {
  const toks = [];
  let cur = null;
  let pendingSpace = null;
  for (const seg of segs) {
    for (const ch of seg.text) {
      if (/\s/.test(ch)) {
        if (cur) {
          pendingSpace = seg;
          toks.push(cur);
          cur = null;
        }
        continue;
      }
      if (!cur) {
        if (toks.length && pendingSpace) toks[toks.length - 1].space = pendingSpace;
        cur = { segs: [], space: null };
        pendingSpace = null;
      }
      const last = cur.segs[cur.segs.length - 1];
      if (last && sameStyle(last, seg)) last.text += ch;
      else cur.segs.push({ ...seg, text: ch });
    }
  }
  if (cur) toks.push(cur);
  return toks;
}

function sameStyle(a, b) {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.code === !!b.code && !!a.strike === !!b.strike && a.link === b.link;
}

const tokenText = (t) => t.segs.map((s) => s.text).join("");

/** Words laid out with single spaces; sets start/end, returns the text. */
function layoutWords(toks, offset = 0) {
  let text = "";
  toks.forEach((t, n) => {
    if (n) text += " ";
    t.start = offset + text.length;
    text += tokenText(t);
    t.end = offset + text.length;
  });
  return text;
}

export function parseTableContent(content) {
  const lines = content.split("\n").filter((l) => l.trim());
  const parseRow = (line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, "|"));
  const rows = [];
  lines.forEach((line, n) => {
    if (n > 0 && /^[\|\-:\s]+$/.test(line.trim())) return;
    rows.push(parseRow(line));
  });
  return rows;
}

/** Upstream `computeListIndices` (packages/ui/utils/parser.ts), for one run of list items. */
function listIndices(items) {
  const counters = [];
  const lastOrdered = [];
  return items.map((block) => {
    const lvl = block.level || 0;
    counters.length = lvl + 1;
    lastOrdered.length = lvl + 1;
    if (!block.ordered) {
      lastOrdered[lvl] = false;
      return null;
    }
    counters[lvl] = lastOrdered[lvl] ? (counters[lvl] ?? 0) + 1 : (block.orderedStart ?? 1);
    lastOrdered[lvl] = true;
    return counters[lvl];
  });
}

const LINE_KINDS = new Set(["code", "html", "math"]);

/** One block's rendered text and tokens (offsets local to the block). */
function unitOf(block) {
  if (block.type === "hr") return { block, text: "", tokens: [] };
  if (LINE_KINDS.has(block.type)) {
    const lines = block.content.split("\n");
    const tokens = [];
    let at = 0;
    lines.forEach((line, n) => {
      if (line.length) tokens.push({ segs: [{ text: line, code: true }], space: null, start: at, end: at + line.length, row: n });
      at += line.length + 1;
    });
    return { block, text: block.content, tokens, lines };
  }
  if (block.type === "table") {
    const rows = parseTableContent(block.content);
    const tokens = [];
    const cells = [];
    let text = "";
    rows.forEach((row, r) => {
      if (r) text += "\n";
      cells.push(
        row.map((cell, c) => {
          if (c) text += "\t";
          const toks = words(inline(cell, r === 0 ? { bold: true } : {}));
          text += layoutWords(toks, text.length);
          toks.forEach((t) => Object.assign(t, { row: r, col: c }));
          tokens.push(...toks);
          return toks;
        }),
      );
    });
    return { block, text, tokens, rows: cells };
  }
  const toks = words(inline(block.content));
  return { block, text: layoutWords(toks), tokens: toks };
}

/**
 * What a browser selection string puts between two blocks. Inferred from
 * Chrome's TextIterator (a paragraph or heading ends with a blank line, a
 * div with one newline); not measured against a browser.
 */
const blockSeparator = (prev) => (prev.type === "paragraph" || prev.type === "heading" ? "\n\n" : "\n");

/** @returns {{ units: Unit[], tokens: Token[], text: string, byId: Map<string, Unit> }} */
export function buildDoc(blocks) {
  const units = [];
  const tokens = [];
  let text = "";
  let listRun = [];
  const closeList = () => {
    listIndices(listRun.map((u) => u.block)).forEach((n, j) => (listRun[j].index = n));
    listRun = [];
  };
  blocks.forEach((block, b) => {
    const u = unitOf(block);
    if (b) text += blockSeparator(blocks[b - 1]);
    u.base = text.length;
    text += u.text;
    u.tokens.forEach((t, i) => {
      Object.assign(t, { k: tokens.length, b, i, gs: u.base + t.start, ge: u.base + t.end });
      tokens.push(t);
    });
    if (block.type === "list-item") listRun.push(u);
    else closeList();
    units.push(u);
  });
  closeList();
  return { units, tokens, text, byId: new Map(units.map((u) => [u.block.id, u])) };
}

/** Upstream `compactText`: whitespace-insensitive comparison. */
export const compactText = (s) => s.replace(/\s+/g, "");

/** The fields of an Annotation for the token range [a, b] (either order). */
export function rangeFields(doc, a, b) {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const first = doc.tokens[lo];
  const originalText = doc.text.slice(first.gs, doc.tokens[hi].ge);
  const startOffset = first.start;
  return { blockId: doc.units[first.b].block.id, startOffset, endOffset: startOffset + originalText.length, originalText };
}

/** Where an annotation's text sits in the flat text, as [gs, ge), or null. */
export function locate(doc, ann) {
  const quote = ann.originalText ?? "";
  if (!quote || !compactText(quote)) return null;
  const unit = doc.byId.get(ann.blockId);
  if (unit) {
    const at = unit.base + (ann.startOffset ?? 0);
    if (doc.text.startsWith(quote, at)) return [at, at + quote.length];
    const near = doc.text.indexOf(quote, unit.base);
    if (near >= 0) return [near, near + quote.length];
  }
  const any = doc.text.indexOf(quote);
  if (any >= 0) return [any, any + quote.length];
  return compactSearch(doc, quote, unit ? unit.base : 0);
}

function compactSearch(doc, quote, from) {
  if (!doc.compact) {
    let c = "";
    const map = [];
    for (let i = 0; i < doc.text.length; i++) {
      if (/\s/.test(doc.text[i])) continue;
      c += doc.text[i];
      map.push(i);
    }
    doc.compact = { c, map };
  }
  const { c, map } = doc.compact;
  const q = compactText(quote);
  let fromC = map.findIndex((i) => i >= from);
  let hit = c.indexOf(q, Math.max(fromC, 0));
  if (hit < 0) hit = c.indexOf(q);
  if (hit < 0) return null;
  return [map[hit], map[hit + q.length - 1] + 1];
}

/** Token indexes [lo, hi] that overlap the flat range [gs, ge). */
export function tokensIn(doc, gs, ge) {
  const ts = doc.tokens;
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid].ge <= gs) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;
  let last = first - 1;
  while (last + 1 < ts.length && ts[last + 1].gs < ge) last++;
  return last >= first ? [first, last] : null;
}

/** `---` frontmatter as [key, value] pairs, or null. */
export function frontmatter(markdown) {
  const m = /^\s*---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(markdown);
  if (!m) return null;
  const pairs = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w.-]+):\s*(.*)$/.exec(line);
    if (kv) pairs.push([kv[1], kv[2].replace(/^["']|["']$/g, "")]);
    else if (pairs.length && line.trim()) pairs[pairs.length - 1][1] += " " + line.trim().replace(/^-\s*/, "");
  }
  return pairs.length ? pairs : null;
}

export function newId(prefix) {
  const id = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 3) | 8).toString(16);
      });
  return prefix ? `${prefix}-${id}` : id;
}
