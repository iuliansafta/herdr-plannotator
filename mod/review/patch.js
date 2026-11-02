// Unified diff (`git diff` output) -> files, hunks and numbered lines.
//
// DiffFile  { path, oldPath, status, additions, deletions, binary, hunks }
// DiffHunk  { header, oldStart, newStart, lines }
// DiffLine  { kind: "add" | "del" | "ctx", oldNo, newNo, text, noEol? }
//
// `path` is the new path, or the old one for a deleted file: the same path
// upstream's parseDiffToFiles gives, which is what CodeAnnotation.filePath holds.

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(raw) {
  const files = [];
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git ")) {
      i++;
      continue;
    }
    const header = gitHeaderPaths(lines[i]);
    const file = { path: "", oldPath: null, status: "modified", additions: 0, deletions: 0, binary: false, hunks: [] };
    let oldPath = header.old, newPath = header.new;
    i++;
    for (; i < lines.length && !lines[i].startsWith("diff --git ") && !lines[i].startsWith("@@"); i++) {
      const l = lines[i];
      if (l.startsWith("new file mode")) file.status = "added";
      else if (l.startsWith("deleted file mode")) file.status = "deleted";
      else if (l.startsWith("rename from ")) { file.status = "renamed"; oldPath = unquote(l.slice(12)); }
      else if (l.startsWith("rename to ")) newPath = unquote(l.slice(10));
      else if (l.startsWith("copy from ")) { file.status = "renamed"; oldPath = unquote(l.slice(10)); }
      else if (l.startsWith("copy to ")) newPath = unquote(l.slice(8));
      else if (l.startsWith("Binary files ") || l === "GIT binary patch") file.binary = true;
      else if (l.startsWith("--- ")) oldPath = sidePath(l.slice(4)) ?? oldPath;
      else if (l.startsWith("+++ ")) newPath = sidePath(l.slice(4)) ?? newPath;
    }
    while (i < lines.length && lines[i].startsWith("@@")) {
      const m = HUNK.exec(lines[i]);
      if (!m) break;
      const hunk = { header: lines[i], oldStart: +m[1], newStart: +m[3], lines: [] };
      let oldLeft = m[2] === undefined ? 1 : +m[2];
      let newLeft = m[4] === undefined ? 1 : +m[4];
      let oldNo = hunk.oldStart, newNo = hunk.newStart;
      i++;
      while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i].startsWith("\\"))) {
        const l = lines[i], c = l[0];
        if (c === "\\") hunk.lines[hunk.lines.length - 1].noEol = true;
        else if (c === "+") { hunk.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: l.slice(1) }); newLeft--; file.additions++; }
        else if (c === "-") { hunk.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: l.slice(1) }); oldLeft--; file.deletions++; }
        else if (c === " " || l === "") { hunk.lines.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: l.slice(1) }); oldLeft--; newLeft--; }
        else break;
        i++;
      }
      file.hunks.push(hunk);
    }
    if (file.status === "modified" && oldPath && newPath && oldPath !== newPath) file.status = "renamed";
    file.path = (file.status === "deleted" ? oldPath : newPath) ?? oldPath ?? "";
    file.oldPath = file.status === "renamed" ? oldPath : null;
    if (file.path) files.push(file);
  }
  return files;
}

// `diff --git a/x b/x`: exact for unquoted paths without " b/" inside them;
// the ---/+++ and rename lines that follow override it when present.
function gitHeaderPaths(line) {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const end = closingQuote(rest);
    const second = rest.slice(end + 2);
    return { old: sidePath(rest.slice(0, end + 1)), new: sidePath(second) };
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3)) {
    return { old: rest.slice(2, half), new: rest.slice(half + 3) };
  }
  const split = rest.search(/ [a-z]\//);
  return split < 0 ? {} : { old: sidePath(rest.slice(0, split)), new: sidePath(rest.slice(split + 1)) };
}

function closingQuote(s) {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i;
  }
  return s.length - 1;
}

function sidePath(token) {
  const t = token.startsWith('"') ? token.slice(0, closingQuote(token) + 1) : token.split("\t")[0];
  if (t === "/dev/null") return null;
  const p = unquote(t);
  // a/ and b/, or i/ w/ c/ o/ under diff.mnemonicPrefix.
  return /^[a-z]\//.test(p) ? p.slice(2) : null;
}

const ESC = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", a: "\x07", b: "\b", f: "\f", v: "\v" };

// git's C-style quoting; octal escapes are UTF-8 bytes.
function unquote(s) {
  if (!s.startsWith('"') || !s.endsWith('"')) return s;
  let out = "";
  const inner = s.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== "\\") { out += inner[i]; continue; }
    const n = inner[i + 1];
    if (/[0-7]/.test(n)) {
      let bytes = "";
      while (inner[i] === "\\" && /[0-7]{3}/.test(inner.slice(i + 1, i + 4))) {
        bytes += "%" + parseInt(inner.slice(i + 1, i + 4), 8).toString(16).padStart(2, "0");
        i += 4;
      }
      i--;
      try { out += decodeURIComponent(bytes); } catch { out += bytes; }
    } else {
      out += ESC[n] ?? n;
      i++;
    }
  }
  return out;
}
