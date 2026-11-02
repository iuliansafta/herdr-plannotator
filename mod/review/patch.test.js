import { test, expect, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePatch } from "./patch.js";

let repo, patch, files;
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 1 << 26 });
const write = (p, text) => { mkdirSync(join(repo, p, ".."), { recursive: true }); writeFileSync(join(repo, p), text); };
const byPath = (p) => files.find((f) => f.path === p);

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "patch-test-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  write("big.ts", Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  write("moved.js", "a\nb\nc\nd\ne\n");
  write("pure-rename.txt", "same\n");
  write("gone.md", "bye\nnow\n");
  write("nonl.txt", "no newline");
  write("tail.txt", "keep\nlast");
  write("img.bin", Buffer.from([0, 1, 2, 3, 255, 0, 7]));
  write("dir with space/é.txt", "one\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  const big = readFileSync(join(repo, "big.ts"), "utf8").split("\n");
  big[9] = "line 10 changed";
  big.splice(200, 2);
  big.splice(300, 0, "inserted A", "inserted B");
  write("big.ts", big.join("\n"));
  mkdirSync(join(repo, "src"));
  git("mv", "moved.js", "src/moved.js");
  write("src/moved.js", "a\nB\nc\nd\ne\n");
  git("mv", "pure-rename.txt", "renamed.txt");
  git("rm", "-q", "gone.md");
  write("nonl.txt", "no newline, edited");
  write("tail.txt", "keep\nlast\n");
  write("img.bin", Buffer.from([0, 9, 9, 9, 255, 0, 7]));
  write("fresh.ts", "export const x = 1;\nexport const y = 2;\n");
  write("dir with space/é.txt", "one\ntwo\n");
  git("add", "-A");
  patch = git("diff", "--cached", "-M", "--no-color");
  files = parsePatch(patch);
  return () => rmSync(repo, { recursive: true, force: true });
});

test("every file git reports is parsed, with git's own +/- counts", () => {
  const numstat = git("diff", "--cached", "-M", "--numstat", "-z").split("\0");
  const expected = [];
  for (let i = 0; i < numstat.length - 1; i++) {
    const [add, del, path] = numstat[i].split("\t");
    const target = path === "" ? numstat[(i += 2)] : path;
    expected.push({ path: target, additions: add === "-" ? 0 : +add, deletions: del === "-" ? 0 : +del });
  }
  expect(files.map(({ path, additions, deletions }) => ({ path, additions, deletions })).sort((a, b) => a.path.localeCompare(b.path)))
    .toEqual(expected.sort((a, b) => a.path.localeCompare(b.path)));
});

test("statuses: added, deleted, renamed (with and without edits), binary", () => {
  expect(byPath("fresh.ts").status).toBe("added");
  expect(byPath("gone.md").status).toBe("deleted");
  expect(byPath("gone.md").oldPath).toBe(null);
  expect(byPath("src/moved.js")).toMatchObject({ status: "renamed", oldPath: "moved.js" });
  expect(byPath("renamed.txt")).toMatchObject({ status: "renamed", oldPath: "pure-rename.txt", hunks: [] });
  expect(byPath("img.bin")).toMatchObject({ binary: true, hunks: [] });
  expect(byPath("big.ts")).toMatchObject({ status: "modified", oldPath: null, binary: false });
});

test("quoted paths (space, non-ASCII) decode to the real path", () => {
  expect(byPath("dir with space/é.txt")).toBeTruthy();
});

// Line numbers are what a comment's lineStart/lineEnd mean: each numbered
// line must be that line of the file on its side.
test("old/new line numbers point at the real lines of each side", () => {
  for (const f of files.filter((f) => f.hunks.length)) {
    const now = f.status === "deleted" ? [] : readFileSync(join(repo, f.path), "utf8").split("\n");
    const before = f.status === "added" ? [] : git("show", `HEAD:${f.oldPath ?? f.path}`).split("\n");
    for (const h of f.hunks) for (const l of h.lines) {
      if (l.newNo !== null) expect(now[l.newNo - 1]).toBe(l.text);
      if (l.oldNo !== null) expect(before[l.oldNo - 1]).toBe(l.text);
      expect(l.kind === "add" ? l.oldNo === null : l.kind === "del" ? l.newNo === null : l.oldNo && l.newNo).toBeTruthy();
    }
  }
});

test("'\\ No newline at end of file' marks the line instead of becoming one", () => {
  const nonl = byPath("nonl.txt").hunks[0].lines;
  expect(nonl).toEqual([
    { kind: "del", oldNo: 1, newNo: null, text: "no newline", noEol: true },
    { kind: "add", oldNo: null, newNo: 1, text: "no newline, edited", noEol: true },
  ]);
  const tail = byPath("tail.txt").hunks[0].lines;
  expect(tail.map((l) => [l.kind, l.text, !!l.noEol])).toEqual([
    ["ctx", "keep", false],
    ["del", "last", true],
    ["add", "last", false],
  ]);
});

test("a big file splits into its hunks with correct starts", () => {
  const big = byPath("big.ts");
  expect(big.hunks.map((h) => [h.oldStart, h.newStart])).toEqual([[7, 7], [198, 198], [300, 298]]);
  expect(big.hunks[0].header.startsWith("@@ -7,7 +7,7 @@")).toBe(true);
});

test("a new file's lines are all additions numbered from 1", () => {
  expect(byPath("fresh.ts").hunks[0].lines.map((l) => [l.kind, l.newNo])).toEqual([["add", 1], ["add", 2]]);
});
