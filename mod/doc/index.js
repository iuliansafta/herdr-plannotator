import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { theme, settings, props, exec } from "herdr";
import * as P from "../vendor/plannotator.js";
import { buildDoc, rangeFields, locate, tokensIn, frontmatter, newId } from "./model.js";

const PANEL_W = 320;
const COMPOSER_W = 360;
const HEADING = { 1: [26, 16, 10], 2: [21, 22, 8], 3: [17, 18, 6], 4: [15, 14, 4], 5: [14, 12, 4], 6: [13, 12, 4] };
const KIND = {
  COMMENT: { label: "Comment", color: (t) => t.accent },
  DELETION: { label: "Delete", color: (t) => t.blocked },
  GLOBAL_COMMENT: { label: "General", color: (t) => t.muted },
};
const ALERT = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

/** A token's runs with its trailing space folded into the last run when styles agree. */
function shownSegs(tok) {
  if (!tok.space) return tok.segs;
  const last = tok.segs[tok.segs.length - 1];
  const same = ["bold", "italic", "code", "strike", "link"].every((k) => last[k] === tok.space[k]);
  return same ? [...tok.segs.slice(0, -1), { ...last, text: last.text + " " }] : [...tok.segs, { ...tok.space, text: " " }];
}

function alpha(color, a) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color ?? "");
  if (!hex) return color;
  const full = hex[1].length === 3 ? hex[1].replace(/./g, "$&$&") : hex[1];
  return `#${full}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
}

/**
 * Selection state, one of:
 *   { name: "idle" }
 *   { name: "pressed", anchor, focus, moved }   mouse is down on a token
 *   { name: "selected", anchor, focus, at }     toolbar open at `at`
 *   { name: "composing", anchor, focus, at }    comment box open
 * anchor/focus are token indexes into doc.tokens.
 */
const IDLE = { name: "idle" };

const span = (sel) => (sel.name === "idle" ? null : [Math.min(sel.anchor, sel.focus), Math.max(sel.anchor, sel.focus)]);

/** Tokens whose selection paint differs between two spans, as ranges. */
function spanDiff(a, b) {
  if (!a || !b) return [a ?? b].filter(Boolean);
  const out = [];
  if (a[0] !== b[0]) out.push([Math.min(a[0], b[0]), Math.max(a[0], b[0])]);
  if (a[1] !== b[1]) out.push([Math.min(a[1], b[1]), Math.max(a[1], b[1])]);
  return out;
}

// Retained views: a block rebuilds only when it is notified, so dragging a
// selection rebuilds the one or two blocks whose paint changed, not the document.
class BlockView extends View {
  init(p) {
    this.owner = p.owner;
    this.b = p.b;
  }
  render() {
    return this.owner.block(theme(), this.owner.doc.units[this.b]);
  }
}

class BodyView extends View {
  init(p) {
    this.owner = p.owner;
  }
  render() {
    return this.owner.body(theme());
  }
}

export class DocumentView {
  constructor(host) {
    this.host = host;
    this.annotations = [];
    this.blocks = [];
    this.sel = IDLE;
    this.focusedId = null;
    this.editingId = null;
    this.ranges = new Map();
    this.size = { width: 900, height: 600 };
  }

  init(cx) {
    const markdown = this.host.session?.plan ?? "";
    this.blocks = P.parseMarkdownToBlocks(markdown);
    this.doc = buildDoc(this.blocks);
    this.front = frontmatter(markdown);
    this.mono = settings().font_family ?? "JetBrains Mono";
    this.composer = TextareaState.new({ placeholder: "Add a comment…" });
    this.composer.set_auto_grow(3, 10);
    this.globalInput = TextareaState.new({ placeholder: "Add a general comment about the whole document…" });
    this.globalInput.set_auto_grow(2, 8);
    this.editInput = TextareaState.new();
    this.editInput.set_auto_grow(2, 10);
    this.focus = cx.focus_handle();
    this.relocate();
    this.replay(cx);
    this.blockViews = this.doc.units.map((_u, b) => cx.new(BlockView, { owner: this, b }));
    this.bodyView = cx.new(BodyView, { owner: this });
  }

  restore(annotations) {
    this.annotations = annotations;
    this.relocate();
  }

  /** Rebuild the blocks holding these token ranges, and the body (panel, composer) when asked. */
  redraw(cx, ranges, body = true) {
    if (!cx || !this.bodyView) return;
    const seen = new Set();
    for (const [lo, hi] of ranges) {
      for (let b = this.doc.tokens[lo].b; b <= this.doc.tokens[hi].b; b++) {
        if (seen.has(b)) continue;
        seen.add(b);
        cx.notify(this.blockViews[b]);
      }
    }
    if (body) cx.notify(this.bodyView);
  }

  setSel(next, cx) {
    const prev = this.sel;
    this.sel = next;
    this.redraw(cx, spanDiff(span(prev), span(next)), prev.name !== next.name || next.name === "selected" || next.name === "composing");
  }

  focusRange(id) {
    const r = id && this.ranges.get(id);
    return r ? [r] : [];
  }

  // --- named actions (mouse handlers and the dev script call only these) ---

  ref(r) {
    return typeof r === "number" ? r : this.doc.byId.get(r.blockId)?.tokens[r.i]?.k;
  }

  press(r, cx) {
    const k = this.ref(r);
    if (k === undefined) return;
    const unfocus = this.focusRange(this.focusedId);
    this.focusedId = null;
    this.redraw(cx, unfocus, false);
    this.setSel({ name: "pressed", anchor: k, focus: k, moved: false }, cx);
  }

  selectWord(r, cx) {
    const k = this.ref(r);
    if (k === undefined) return;
    this.setSel({ name: "pressed", anchor: k, focus: k, moved: true }, cx);
  }

  extend(r, cx) {
    const k = this.ref(r);
    if (this.sel.name !== "pressed" || k === undefined || k === this.sel.focus) return;
    this.setSel({ ...this.sel, focus: k, moved: true }, cx);
  }

  release(at, cx) {
    if (this.sel.name !== "pressed") return;
    const { anchor, focus, moved } = this.sel;
    this.setSel(moved ? { name: "selected", anchor, focus, at: at ?? { x: 80, y: 120 } } : IDLE, cx);
  }

  cancel(cx) {
    this.editingId = null;
    this.setSel(IDLE, cx);
  }

  openComposer(cx) {
    if (this.sel.name !== "selected") return;
    this.composer.set_value("");
    this.setSel({ ...this.sel, name: "composing" }, cx);
    this.composer.focus();
  }

  addComment(text, cx) {
    const body = String(text ?? this.composer.value()).trim();
    if (!body || (this.sel.name !== "selected" && this.sel.name !== "composing")) return;
    this.add("COMMENT", body, cx);
  }

  addDeletion(cx) {
    if (this.sel.name !== "selected" && this.sel.name !== "composing") return;
    this.add("DELETION", undefined, cx);
  }

  add(type, text, cx) {
    const { anchor, focus } = this.sel;
    const fields = rangeFields(this.doc, anchor, focus);
    this.setSel(IDLE, cx);
    if (!fields.originalText.trim()) return;
    const id = newId();
    this.annotations = [...this.annotations, { id, ...fields, type, text, createdA: Date.now(), images: [] }];
    this.changed(cx, [id]);
  }

  addGlobal(text, cx) {
    const body = String(text ?? this.globalInput.value()).trim();
    if (!body) return;
    this.globalInput.set_value("");
    this.annotations = [
      ...this.annotations,
      { id: newId("global"), blockId: "", startOffset: 0, endOffset: 0, type: "GLOBAL_COMMENT", text: body, originalText: "", createdA: Date.now(), images: [] },
    ];
    this.changed(cx, []);
  }

  startEdit(id, cx) {
    const ann = this.annotations.find((a) => a.id === id);
    if (!ann) return;
    this.editingId = id;
    this.editInput.set_value(ann.text ?? "");
    this.redraw(cx, []);
    this.editInput.focus();
  }

  editAnnotation(id, text, cx) {
    const body = String(text ?? this.editInput.value()).trim();
    this.editingId = null;
    if (!body) return this.redraw(cx, []);
    this.annotations = this.annotations.map((a) => (a.id === id ? { ...a, text: body } : a));
    this.changed(cx, []);
  }

  removeAnnotation(id, cx) {
    const gone = this.focusRange(id);
    this.annotations = this.annotations.filter((a) => a.id !== id);
    if (this.focusedId === id) this.focusedId = null;
    if (this.editingId === id) this.editingId = null;
    this.changed(cx, [], gone);
  }

  focusAnnotation(id, cx) {
    const before = this.focusRange(this.focusedId);
    this.focusedId = this.focusedId === id ? null : id;
    this.redraw(cx, [...before, ...this.focusRange(this.focusedId)]);
  }

  /** After the annotation list changed: re-anchor, repaint `ids` (and `ranges`), tell main.js. */
  changed(cx, ids, ranges = []) {
    this.relocate();
    this.redraw(cx, [...ranges, ...ids.flatMap((id) => this.focusRange(id))]);
    if (cx) this.host.changed(cx);
  }

  /** Token range of every anchored annotation, recomputed when they change. */
  relocate() {
    this.ranges = new Map();
    this.annAt = new Array(this.doc.tokens.length);
    for (const a of this.annotations) {
      if (a.type === "GLOBAL_COMMENT") continue;
      const at = locate(this.doc, a);
      const toks = at && tokensIn(this.doc, at[0], at[1]);
      if (!toks) continue;
      this.ranges.set(a.id, toks);
      for (let k = toks[0]; k <= toks[1]; k++) (this.annAt[k] ??= []).push(a);
    }
  }

  /** Dev only: props().script = [[method, ...args], ...] replayed after load. */
  replay(cx) {
    const { script, dump } = props() ?? {};
    if (!Array.isArray(script)) return;
    for (const [method, ...args] of script) {
      if (typeof this[method] !== "function") throw new Error(`script: no method ${method}`);
      this[method](...args, cx);
    }
    if (dump) exec("sh", ["-c", 'printf "%s" "$1" > "$2"', "sh", JSON.stringify(this.annotations), dump]).catch(() => {});
  }

  // --- rendering ---

  token(t, tok, sel, extra) {
    const k = tok.k;
    const inSel = sel && k >= sel[0] && k <= sel[1];
    const anns = this.annAt[k];
    const a = anns && (anns.find((x) => x.id === this.focusedId) ?? anns[0]);
    const focused = a && a.id === this.focusedId;
    const deleted = a?.type === "DELETION";
    const segs = (tok.show ??= shownSegs(tok));
    const ref = { blockId: this.doc.units[tok.b].block.id, i: tok.i };
    let el = (segs.length === 1 ? this.seg(t, segs[0], deleted, div()) : h_flex())
      .id(`doc-t${k}`)
      .flex_none()
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        if (e.click_count >= 2) this.selectWord(ref, cx);
        else this.press(ref, cx);
      })
      .on_mouse_move((_e, cx) => this.extend(ref, cx));
    if (a?.type === "COMMENT") el = el.bg(alpha(t.accent, focused ? 0.45 : 0.2)).border_b(2).border_color(t.accent);
    if (a?.type === "DELETION") el = el.bg(alpha(t.blocked, focused ? 0.35 : 0.14)).line_through().text_color(t.blocked);
    if (inSel) el = el.bg(t.selection);
    if (extra) el = extra(el);
    return segs.length === 1 ? el : el.children(segs.map((s) => this.seg(t, s, deleted, div())));
  }

  seg(t, s, deleted, el) {
    el = el.child(s.text);
    if (s.bold) el = el.font_bold();
    if (s.bold && !deleted) el = el.text_color(t.foreground);
    if (s.italic) el = el.italic();
    if (s.strike || deleted) el = el.line_through();
    if (s.code) el = el.font_family(this.mono).text_size(13).bg(alpha(t.foreground, 0.08));
    if (s.link && !deleted) el = el.text_color(t.accent).underline();
    return el;
  }

  words(t, tokens, size = 15) {
    const sel = span(this.sel);
    return h_flex()
      .flex_wrap()
      .items_baseline()
      .cursor_text()
      .text_size(size)
      .line_height(1.65)
      .children(tokens.map((tok) => this.token(t, tok, sel)));
  }

  block(t, u) {
    const b = u.block;
    switch (b.type) {
      case "heading": {
        const [size, mt, mb] = HEADING[b.level] ?? HEADING[6];
        return div().mt(mt).mb(mb).font_weight(b.level === 1 ? 700 : 600).text_color(b.level >= 3 ? alpha(t.foreground, 0.85) : t.foreground).child(this.words(t, u.tokens, size));
      }
      case "list-item": {
        const checked = b.checked;
        const marker =
          checked === true ? div().text_color(t.done).child("✓")
          : checked === false ? div().text_color(t.dim).child("○")
          : u.index != null ? div().text_color(alpha(t.accent, 0.8)).child(`${u.index}.`)
          : div().text_color(alpha(t.accent, 0.8)).child("•");
        return h_flex()
          .items_start()
          .gap(10)
          .my(3)
          .ml((b.level || 0) * 22)
          .child(div().flex_none().min_w(18).text_size(15).line_height(1.65).child(marker))
          .child(div().flex_1().min_w(0).text_color(checked === true ? t.muted : alpha(t.foreground, 0.8)).child(this.words(t, u.tokens)));
      }
      case "blockquote": {
        const title = b.alertKind && (ALERT[b.alertKind] ?? b.alertKind);
        const color = b.alertKind === "warning" || b.alertKind === "caution" ? t.blocked : b.alertKind ? t.accent : t.border;
        return v_flex()
          .my(10)
          .pl(14)
          .py(2)
          .border_l(3)
          .border_color(color)
          .text_color(t.muted)
          .when(!!title, (e) => e.child(div().text_size(13).font_semibold().text_color(color).child(title)))
          .child(this.words(t, u.tokens));
      }
      case "code":
      case "html":
      case "math":
        return this.code(t, u);
      case "table":
        return this.table(t, u);
      case "hr":
        return div().my(20).h(1).bg(t.border);
      default:
        return div().mb(12).text_color(alpha(t.foreground, 0.8)).child(this.words(t, u.tokens));
    }
  }

  code(t, u) {
    const sel = span(this.sel);
    const byRow = new Map(u.tokens.map((tok) => [tok.row, tok]));
    const lineH = 20;
    return v_flex()
      .my(10)
      .rounded(8)
      .border(1)
      .border_color(t.border)
      .bg(t.surface)
      .overflow_hidden()
      .when(!!u.block.language, (e) =>
        e.child(div().px(12).pt(6).text_size(11).text_color(t.dim).child(u.block.language)))
      .child(
        v_flex()
          .id(`doc-code-${u.block.id}`)
          .overflow_x_scroll()
          .px(12)
          .py(8)
          .font_family(this.mono)
          .text_size(13)
          .children(
            u.lines.map((line, n) => {
              const tok = byRow.get(n);
              if (!tok) return div().h(lineH);
              const shown = { ...tok, segs: [{ text: line.replace(/\t/g, "    ") }] };
              return this.token(t, shown, sel, (el) => el.h(lineH).items_center().min_w_full());
            }),
          ),
      );
  }

  table(t, u) {
    return v_flex()
      .my(10)
      .rounded(6)
      .border(1)
      .border_color(t.border)
      .overflow_hidden()
      .children(
        u.rows.map((row, r) =>
          h_flex()
            .when(r === 0, (e) => e.bg(t.surface))
            .when(r > 0, (e) => e.border_t(1).border_color(t.border))
            .children(
              row.map((cell, c) =>
                div()
                  .flex_1()
                  .min_w(0)
                  .px(12)
                  .py(6)
                  .when(c > 0, (e) => e.border_l(1).border_color(t.border))
                  .child(this.words(t, cell, 14)),
              ),
            ),
        ),
      );
  }

  frontCard(t) {
    return v_flex()
      .mb(18)
      .rounded(6)
      .border(1)
      .border_color(t.border)
      .text_size(12)
      .children(
        this.front.map(([k, v], n) =>
          h_flex()
            .px(10)
            .py(4)
            .gap(12)
            .when(n > 0, (e) => e.border_t(1).border_color(t.border))
            .child(div().w(110).flex_none().text_color(t.dim).font_family(this.mono).child(k))
            .child(div().flex_1().min_w(0).text_color(t.muted).child(v)),
        ),
      );
  }

  button(t, id, label, onClick, { primary = false, danger = false } = {}) {
    const fg = primary ? t.solid_foreground : danger ? t.blocked : t.foreground;
    return div()
      .id(id)
      .px(10)
      .py(4)
      .rounded(6)
      .text_size(12)
      .cursor_pointer()
      .border(1)
      .border_color(primary ? t.solid : t.border)
      .bg(primary ? t.solid : t.surface)
      .text_color(fg)
      .hover((s) => s.bg(primary ? t.accent : t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => onClick(cx))
      .child(label);
  }

  /** The toolbar after a selection, or the comment box. */
  composerEl(t) {
    const { at, name } = this.sel;
    const maxX = Math.max(8, this.size.width - PANEL_W - COMPOSER_W - 16);
    const x = Math.min(Math.max(8, at.x - 40), maxX);
    const y = Math.max(8, at.y + 14);
    const card = v_flex()
      .id("doc-composer")
      .absolute()
      .left(x)
      .top(y)
      .p(8)
      .gap(8)
      .rounded(10)
      .border(1)
      .border_color(t.border)
      .bg(t.popover)
      .shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation());
    if (name === "selected") {
      return card.child(
        h_flex()
          .gap(6)
          .child(this.button(t, "doc-act-comment", "Comment", (cx) => this.openComposer(cx), { primary: true }))
          .child(this.button(t, "doc-act-delete", "Delete", (cx) => this.addDeletion(cx), { danger: true }))
          .child(this.button(t, "doc-act-cancel", "✕", (cx) => this.cancel(cx))),
      );
    }
    const quote = rangeFields(this.doc, this.sel.anchor, this.sel.focus).originalText;
    return card
      .w(COMPOSER_W)
      .on_key_down((e, cx) => {
        if (e.keystroke === "cmd-enter" || e.keystroke === "ctrl-enter") {
          cx.stop_propagation();
          this.addComment(undefined, cx);
        }
      })
      .child(this.quote(t, quote, t.accent))
      .child(
        div()
          .id("doc-composer-input")
          .rounded(6)
          .border(1)
          .border_color(t.input)
          .bg(t.background)
          .px(8)
          .py(6)
          .child(Textarea.new(this.composer).text_size(13).text_color(t.foreground)),
      )
      .child(
        h_flex()
          .gap(6)
          .child(div().flex_1().text_size(11).text_color(t.dim).child("Ctrl+Enter to save, Esc to cancel"))
          .child(this.button(t, "doc-composer-cancel", "Cancel", (cx) => this.cancel(cx)))
          .child(this.button(t, "doc-composer-save", "Add comment", (cx) => this.addComment(undefined, cx), { primary: true })),
      );
  }

  quote(t, text, color) {
    const short = text.length > 220 ? text.slice(0, 220) + "…" : text;
    return div()
      .pl(8)
      .border_l(2)
      .border_color(color)
      .text_size(12)
      .italic()
      .text_color(t.muted)
      .child(short.replace(/\t/g, "  "));
  }

  /** Annotations in export order: general comments, then by position. */
  ordered() {
    const pos = (a) => {
      if (a.type === "GLOBAL_COMMENT") return -1;
      const r = this.ranges.get(a.id);
      return r ? r[0] : Number.MAX_SAFE_INTEGER;
    };
    return [...this.annotations].sort((a, b) => pos(a) - pos(b) || a.createdA - b.createdA);
  }

  card(t, a, n) {
    const kind = KIND[a.type] ?? KIND.COMMENT;
    const color = kind.color(t);
    const editing = this.editingId === a.id;
    const focused = this.focusedId === a.id;
    const anchored = a.type === "GLOBAL_COMMENT" || this.ranges.has(a.id);
    return v_flex()
      .id(`doc-ann-${a.id}`)
      .p(10)
      .gap(6)
      .rounded(8)
      .border(1)
      .border_color(focused ? color : t.border)
      .bg(focused ? t.selected : t.background)
      .cursor_pointer()
      .hover((s) => s.border_color(color))
      .on_click((_e, cx) => this.focusAnnotation(a.id, cx))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().w(8).h(8).rounded(4).bg(color))
          .child(div().text_size(11).font_semibold().text_color(color).child(`${n}. ${kind.label}`))
          .when(!anchored, (e) => e.child(div().text_size(11).text_color(t.dim).child("text not found")))
          .child(div().flex_1())
          .when(a.type !== "DELETION" && !editing, (e) => e.child(this.iconButton(t, `doc-edit-${a.id}`, "Edit", (cx) => this.startEdit(a.id, cx))))
          .child(this.iconButton(t, `doc-del-${a.id}`, "Remove", (cx) => this.removeAnnotation(a.id, cx))),
      )
      .when(!!a.originalText, (e) => e.child(this.quote(t, a.originalText, color)))
      .when(!editing && !!a.text, (e) => e.child(div().text_size(13).text_color(t.foreground).child(a.text)))
      .when(editing, (e) =>
        e.child(
          v_flex()
            .gap(6)
            .on_key_down((ev, cx) => {
              if (ev.keystroke === "cmd-enter" || ev.keystroke === "ctrl-enter") this.editAnnotation(a.id, undefined, cx);
              if (ev.key === "escape") this.cancel(cx);
            })
            .child(div().rounded(6).border(1).border_color(t.input).bg(t.background).px(8).py(6).child(Textarea.new(this.editInput).text_size(13).text_color(t.foreground)))
            .child(
              h_flex()
                .gap(6)
                .justify_end()
                .child(this.button(t, `doc-edit-cancel-${a.id}`, "Cancel", (cx) => this.cancel(cx)))
                .child(this.button(t, `doc-edit-save-${a.id}`, "Save", (cx) => this.editAnnotation(a.id, undefined, cx), { primary: true })),
            ),
        ),
      );
  }

  iconButton(t, id, label, onClick) {
    return div()
      .id(id)
      .px(6)
      .py(1)
      .rounded(4)
      .text_size(11)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(label);
  }

  panel(t) {
    const list = this.ordered();
    return v_flex()
      .w(PANEL_W)
      .flex_none()
      .h_full()
      .bg(t.chrome)
      .border_l(1)
      .border_color(t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(
        h_flex()
          .h(40)
          .flex_none()
          .px(14)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().text_size(13).font_semibold().child("Annotations"))
          .child(div().ml(8).px(6).rounded(8).bg(t.surface).text_size(11).text_color(t.muted).child(String(list.length))),
      )
      .child(
        v_flex()
          .id("doc-panel-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(10)
          .gap(8)
          .when(list.length === 0, (e) =>
            e.child(div().p(6).text_size(12).text_color(t.dim).child("Select text in the document to comment on it or mark it for deletion. A general comment goes below.")))
          .children(list.map((a, n) => this.card(t, a, n + 1))),
      )
      .child(
        v_flex()
          .flex_none()
          .p(10)
          .gap(6)
          .border_t(1)
          .border_color(t.border)
          .on_key_down((e, cx) => {
            if (e.keystroke === "cmd-enter" || e.keystroke === "ctrl-enter") this.addGlobal(undefined, cx);
          })
          .child(div().rounded(6).border(1).border_color(t.input).bg(t.background).px(8).py(6).child(Textarea.new(this.globalInput).text_size(13).text_color(t.foreground)))
          .child(h_flex().justify_end().child(this.button(t, "doc-global-add", "Add general comment", (cx) => this.addGlobal(undefined, cx)))),
      );
  }

  render(_cx) {
    return this.bodyView;
  }

  body(t) {
    const open = this.sel.name === "selected" || this.sel.name === "composing";
    return h_flex()
      .id("doc-root")
      .flex_1()
      .size_full()
      .min_h(0)
      .relative()
      .track_focus(this.focus)
      .on_size_change((size, cx) => {
        this.size = size;
        cx.notify();
      })
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.sel.name !== "idle") this.cancel(cx);
      })
      .on_mouse_down("left", (_e, cx) => {
        if (this.sel.name !== "idle") this.cancel(cx);
        this.focus.focus();
      })
      .on_mouse_up("left", (e, cx) => this.release(e.local_position ?? { x: e.position.x, y: e.position.y }, cx))
      .child(
        div()
          .id("doc-scroll")
          .flex_1()
          .min_w(0)
          .h_full()
          .overflow_y_scrollbar()
          .child(
            v_flex()
              .w_full()
              .max_w(860)
              .mx_auto()
              .px(40)
              .py(28)
              .text_color(t.foreground)
              .when(!!this.front, (e) => e.child(this.frontCard(t)))
              .children(this.blockViews),
          ),
      )
      .child(this.panel(t))
      .when(open, (e) => e.child(this.composerEl(t)));
  }
}
