// Review state that has no UI in it: annotation factories that produce what
// Plannotator's review app produces for the same click, the line-range rule,
// and the rows one file's diff draws as.
//
// Row  { kind: "hunk", key, text }
//    | { kind: "line", key, i, line, selected, noted }   i: index into fileLines(file)
//    | { kind: "note", key, ann }                         a line comment, under its last line

/** The file's diff lines in display order (hunks concatenated). */
export function fileLines(file) {
  return file.hunks.flatMap((h) => h.lines);
}

/** Which side a clicked line belongs to: removed lines are old, the rest new. */
export const sideOf = (line) => (line.kind === "del" ? "old" : "new");
const numberOn = (line, side) => (side === "old" ? line.oldNo : line.newNo);

/**
 * A selection of diff lines (anchor..focus indices) as CodeAnnotation coordinates.
 * The anchor's side wins; lineStart/lineEnd are the lowest and highest numbers on
 * that side among the selected lines, so a range dragged across both sides keeps
 * the side the reviewer started on.
 */
export function rangeOf(lines, anchor, focus) {
  const side = sideOf(lines[anchor]);
  const nums = lines.slice(Math.min(anchor, focus), Math.max(anchor, focus) + 1)
    .map((l) => numberOn(l, side)).filter((n) => n !== null);
  return { side, lineStart: Math.min(...nums), lineEnd: Math.max(...nums) };
}

// review-editor/utils/generateId.ts
const shortId = () => Math.random().toString(36).substring(2, 9);
// ui/utils/generateId.ts
const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Math.random().toString(36).slice(2));

const withAuthor = (author) => (author ? { author } : {});

/** App.tsx handleAddAnnotationForFile, for a plain comment (no suggestion, label or token). */
// review-editor/hooks/useAnnotationFactory.ts withPRContext, without the
// GitButler fields and the line anchors (captureAnchor) this view doesn't make.
export function stamp(ann, session) {
  const pr = session.prMetadata;
  const sha = /^commit:([0-9a-f]{4,64})$/i.exec(session.diffType ?? "")?.[1];
  const subject = sha && session.commitInfo?.sha === sha ? session.commitInfo.subject : undefined;
  return {
    ...ann,
    ...(pr ? {
      prUrl: pr.url,
      prNumber: pr.platform === "gitlab" ? pr.iid : pr.number,
      prTitle: pr.title,
      prRepo: pr.platform === "github" ? `${pr.owner}/${pr.repo}` : pr.platform === "bitbucket" ? `${pr.workspace}/${pr.repo}` : pr.projectPath,
      ...(session.prDiffScope ? { diffScope: session.prDiffScope } : {}),
    } : {}),
    ...(sha ? { commitSha: sha, ...(subject ? { commitSubject: subject } : {}) } : {}),
    ...(session.localDraftTarget ? { localReviewTarget: session.localDraftTarget } : {}),
  };
}

export function lineComment({ filePath, side, lineStart, lineEnd, text, author }) {
  return { id: shortId(), type: "comment", scope: "line", filePath, lineStart, lineEnd, side, text, createdAt: Date.now(), ...withAuthor(author) };
}

/** App.tsx handleAddFileComment. */
export function fileComment({ filePath, text, author }) {
  return { id: shortId(), type: "comment", scope: "file", filePath, lineStart: 1, lineEnd: 1, side: "new", text, createdAt: Date.now(), ...withAuthor(author) };
}

/** reviewDecision.ts createGeneralReviewComment. */
export function generalComment({ text, author }) {
  return { id: `review-note-${uuid()}`, type: "comment", scope: "general", filePath: "", lineStart: 0, lineEnd: 0, side: "new", text, createdAt: Date.now(), ...withAuthor(author) };
}

export const scopeOf = (ann) => ann.scope ?? "line";

/** The diff rows for one file: hunk headers, lines, and line comments under their last line. */
export function buildRows(file, annotations, selection) {
  const lines = fileLines(file);
  const notes = annotations.filter((a) => a.filePath === file.path && scopeOf(a) === "line");
  const sel = selection ? [Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus)] : null;
  const rows = [];
  let i = 0;
  file.hunks.forEach((h, hi) => {
    rows.push({ kind: "hunk", key: `h${hi}`, text: h.header });
    for (const line of h.lines) {
      const noted = notes.some((a) => covers(a, line));
      rows.push({ kind: "line", key: `l${i}`, i, line, selected: !!sel && i >= sel[0] && i <= sel[1], noted });
      for (const ann of notes) if (numberOn(line, ann.side) === ann.lineEnd) rows.push({ kind: "note", key: `a${ann.id}`, ann });
      i++;
    }
  });
  return rows;
}

function covers(ann, line) {
  const n = numberOn(line, ann.side);
  return n !== null && n >= ann.lineStart && n <= ann.lineEnd;
}

/** "L12" or "L12-15", with the side when it is the old one. */
export function lineLabel(ann) {
  const range = ann.lineStart === ann.lineEnd ? `L${ann.lineStart}` : `L${ann.lineStart}-${ann.lineEnd}`;
  return ann.side === "old" ? `${range} (old)` : range;
}
