import { test, expect } from "bun:test";
import { parsePatch } from "./patch.js";
import { fileLines, rangeOf, lineComment, fileComment, generalComment, buildRows } from "./model.js";
import { exportReviewFeedback } from "../vendor/plannotator.js";

const PATCH = `diff --git a/src/server.ts b/src/server.ts
index e7c70fb..087f995 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,6 +1,7 @@
 import { createServer } from "node:http";
+import { log } from "./log";

-const PORT = 3000;
+const PORT = Number(process.env.PORT ?? 3000);

 export function start() {
   const server = createServer();
`;
const [file] = parsePatch(PATCH);
const lines = fileLines(file);
// lines: 0 ctx(1,1) 1 add(-,2) 2 ctx(2,3) 3 del(3,-) 4 add(-,4) 5 ctx(4,5) ...

test("a click on an added or context line comments the new side, a removed line the old side", () => {
  expect(rangeOf(lines, 1, 1)).toEqual({ side: "new", lineStart: 2, lineEnd: 2 });
  expect(rangeOf(lines, 3, 3)).toEqual({ side: "old", lineStart: 3, lineEnd: 3 });
  expect(rangeOf(lines, 0, 0)).toEqual({ side: "new", lineStart: 1, lineEnd: 1 });
});

test("a shift-extended range keeps the anchor's side, in either direction", () => {
  expect(rangeOf(lines, 4, 1)).toEqual({ side: "new", lineStart: 2, lineEnd: 4 });
  expect(rangeOf(lines, 3, 5)).toEqual({ side: "old", lineStart: 3, lineEnd: 4 });
});

test("a line comment renders under the last line of its range, on its side", () => {
  const ann = lineComment({ filePath: "src/server.ts", side: "new", lineStart: 2, lineEnd: 4, text: "x" });
  const rows = buildRows(file, [ann], null);
  const at = rows.findIndex((r) => r.kind === "note");
  expect(rows[at - 1].line).toMatchObject({ kind: "add", newNo: 4 });
  expect(rows.filter((r) => r.kind === "line" && r.noted).map((r) => r.line.newNo)).toEqual([2, 3, 4]);
});

test("annotations have the fields upstream's review app gives them", () => {
  const line = lineComment({ filePath: "src/server.ts", side: "old", lineStart: 3, lineEnd: 3, text: "why?" });
  expect(Object.keys(line)).toEqual(["id", "type", "scope", "filePath", "lineStart", "lineEnd", "side", "text", "createdAt"]);
  expect(line).toMatchObject({ type: "comment", scope: "line", side: "old" });
  expect(line.id).toMatch(/^[0-9a-z]{1,7}$/);
  expect(fileComment({ filePath: "a.ts", text: "t" })).toMatchObject({ scope: "file", lineStart: 1, lineEnd: 1, side: "new" });
  const general = generalComment({ text: "overall", author: "me" });
  expect(general).toMatchObject({ scope: "general", filePath: "", lineStart: 0, lineEnd: 0, side: "new", author: "me" });
  expect(general.id).toMatch(/^review-note-/);
});

// The agent reads the export, so this is the contract that matters.
test("upstream's export places each kind where the agent expects it", () => {
  const md = exportReviewFeedback([
    lineComment({ filePath: "src/server.ts", side: "new", lineStart: 2, lineEnd: 4, text: "log before parse" }),
    lineComment({ filePath: "src/server.ts", side: "old", lineStart: 3, lineEnd: 3, text: "keep the default" }),
    fileComment({ filePath: "src/server.ts", text: "needs a test" }),
    generalComment({ text: "Looks good overall" }),
  ]);
  expect(md).toContain("## src/server.ts\n\n### File Comment\nneeds a test");
  expect(md).toContain("### Lines 2-4 (new)\nlog before parse");
  expect(md).toContain("### Line 3 (old)\nkeep the default");
  expect(md).toContain("## General\n\nLooks good overall");
});
