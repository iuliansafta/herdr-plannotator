import { expect, test } from "bun:test";
import * as P from "../mods/plannotator/vendor/plannotator.js";
import * as M from "../mods/plannotator/doc/model.js";

const md = await Bun.file(import.meta.dir + "/fixtures/plan.md").text();
const blocks = P.parseMarkdownToBlocks(md);
const doc = M.buildDoc(blocks);
const tok = (blockId: string, word: string, nth = 0) => {
  const u = doc.byId.get(blockId)!;
  const hits = u.tokens.filter((t: any) => t.segs.map((s: any) => s.text).join("") === word);
  if (!hits[nth]) throw new Error(`no token ${word} in ${blockId}`);
  return hits[nth].k;
};
const ann = (a: number, b: number, type: string, text?: string) => ({
  id: "x" + a, ...M.rangeFields(doc, a, b), type, text, createdA: 1, images: [],
});

test("a selection across a soft line break quotes what the browser shows", () => {
  const a = ann(tok("block-2", "no"), tok("block-2", "else."), "COMMENT", "why?");
  expect(a.originalText).toBe("no per-tenant limits, so a single noisy client can starve everyone else.");
  expect(a.blockId).toBe("block-2");
  const out = P.exportAnnotations(blocks, [a], []);
  expect(out).toContain('## 1. (lines 11–13) Feedback on: "no per-tenant limits, so a single noisy client can starve everyone else."\n> why?');
});

test("markdown markers never reach the quote", () => {
  const a = ann(tok("block-6", "Return"), tok("block-6", "header."), "DELETION");
  expect(a.originalText).toBe("Return 429 Too Many Requests with a Retry-After header.");
  expect(P.exportAnnotations(blocks, [a], [])).toContain("(line 21) Remove this\n```\nReturn 429 Too Many Requests with a Retry-After header.\n```");
});

test("code lines join with newlines and keep indentation", () => {
  const u = doc.byId.get("block-16")!;
  const a = ann(u.tokens[3].k, u.tokens[4].k, "COMMENT", "x");
  expect(a.originalText).toBe('\t\t\tif !l.Allow(r.Context(), tenantID(r)) {\n\t\t\t\tw.Header().Set("Retry-After", "1")');
});

test("table cells are tab separated, rows newline separated", () => {
  const a = ann(tok("block-18", "rate"), tok("block-18", "100"), "COMMENT", "x");
  expect(a.originalText).toBe("rate\t100");
});

test("annotations are exported in document order, not creation order", () => {
  const late = ann(tok("block-23", "Flip"), tok("block-23", "off."), "COMMENT", "second");
  const early = ann(tok("block-5", "Cap"), tok("block-5", "tenant"), "COMMENT", "first");
  const out = P.exportAnnotations(blocks, [late, early], []);
  expect(out.indexOf("first")).toBeLessThan(out.indexOf("second"));
});

test("locate finds an annotation by its quote even when offsets drifted", () => {
  const a = ann(tok("block-21", "5"), tok("block-21", "timeout"), "COMMENT", "x");
  expect(M.locate(doc, a)).toEqual([doc.tokens[a.startOffset === 0 ? 0 : tok("block-21", "5")].gs, doc.tokens[tok("block-21", "timeout")].ge]);
  const drifted = { ...a, blockId: "block-2", startOffset: 0 };
  expect(M.tokensIn(doc, ...(M.locate(doc, drifted) as [number, number]))).toEqual([tok("block-21", "5"), tok("block-21", "timeout")]);
  expect(M.locate(doc, { ...a, originalText: "5  ms\ntimeout" })).not.toBeNull();
});
