// Each expected body is written in the key order the React app serializes,
// and compared through JSON.stringify so the order is part of the assertion.
import { describe, expect, test } from "bun:test";
import * as P from "../mod/vendor/plannotator.js";

const sameWire = (actual: unknown, expected: unknown) => expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));

const PLAN_MD = "# Plan\n\nStep one: add the cache.\n\nStep two: delete the old table.\n";
const blocks = P.parseMarkdownToBlocks(PLAN_MD);
const annotations = [
  { id: "a1", blockId: "block-1", startOffset: 10, endOffset: 24, type: "COMMENT", text: "Which cache?", originalText: "add the cache.", createdA: 1, images: [] },
  { id: "a2", blockId: "block-2", startOffset: 10, endOffset: 30, type: "DELETION", originalText: "delete the old table", createdA: 2, images: [] },
  { id: "g1", blockId: "", startOffset: 0, endOffset: 0, type: "GLOBAL_COMMENT", text: "Looks good otherwise.", originalText: "", createdA: 3, images: [] },
];

const feedbackFor = (title: string, subject: string) =>
  `# ${title}\n\nI've reviewed this ${subject} and have 3 pieces of feedback:\n\n` +
  `## 1. General feedback about the ${subject}\n> Looks good otherwise.\n\n` +
  `## 2. (line 3) Feedback on: "add the cache."\n> Which cache?\n\n` +
  `## 3. (line 5) Remove this\n\`\`\`\ndelete the old table\n\`\`\`\n> I don't want this in the ${subject}.\n\n---\n`;
const PLAN_FEEDBACK = feedbackFor("Plan Feedback", "plan");
const FILE_FEEDBACK = feedbackFor("File Feedback", "file");
const NO_FEEDBACK = "User reviewed the document and has no feedback.";

const planSession = { plan: PLAN_MD, origin: "claude-code", permissionMode: "default", approvalNotesSupported: false, serverSession: "nonce-1" };
const annotateSession = { plan: PLAN_MD, origin: "claude-code", mode: "annotate", filePath: "/tmp/x.md", gate: false, approvalNotesSupported: true, serverSession: "nonce-2" };

describe("plan review", () => {
  test("the agent reads the plan export, global comment first", () => {
    expect(P.docFeedback({ session: planSession, blocks, annotations })).toBe(PLAN_FEEDBACK);
  });

  test("deny sends the export with planSave on and the next draft generation", () => {
    sameWire(P.planDeny({ session: planSession, blocks, annotations, draftGeneration: 4 }), {
      method: "POST",
      path: "/api/deny",
      body: { draftGeneration: 5, feedback: PLAN_FEEDBACK, planSave: { enabled: true }, serverSession: "nonce-1" },
    });
  });

  test("a revised-plan session names the revision on screen", () => {
    const body = P.planDeny({ session: { ...planSession, planRevision: 2 }, blocks, annotations }).body;
    sameWire(body, { draftGeneration: 1, planRevision: 2, feedback: PLAN_FEEDBACK, planSave: { enabled: true }, serverSession: "nonce-1" });
  });

  test("Claude Code approve carries the default permission mode and agent switch, and drops notes the hook cannot deliver", () => {
    sameWire(P.planApprove({ session: planSession, blocks, annotations }).body, {
      draftGeneration: 1,
      permissionMode: "acceptEdits",
      agentSwitch: "build",
      planSave: { enabled: true },
      serverSession: "nonce-1",
    });
  });

  test("a host that delivers approval notes gets the export as feedback", () => {
    const session = { ...planSession, origin: "opencode", approvalNotesSupported: true };
    sameWire(P.planApprove({ session, blocks, annotations }).body, {
      draftGeneration: 1,
      agentSwitch: "build",
      planSave: { enabled: true },
      feedback: PLAN_FEEDBACK,
      serverSession: "nonce-1",
    });
  });

  test("approve with nothing to say sends no feedback even where notes are delivered", () => {
    const session = { ...planSession, origin: "opencode", approvalNotesSupported: true };
    expect(P.planApprove({ session, blocks, annotations: [] }).body).not.toHaveProperty("feedback");
  });

  test("config.json's agent switch wins over the default", () => {
    const off = { ...planSession, serverConfig: { agentSwitch: "disabled" } };
    expect(P.planApprove({ session: off, blocks, annotations: [] }).body).not.toHaveProperty("agentSwitch");
    const custom = { ...planSession, serverConfig: { agentSwitch: { switchTo: "custom", customName: "deploy" } } };
    expect((P.planApprove({ session: custom, blocks, annotations: [] }).body as any).agentSwitch).toBe("deploy");
  });

  test("a server that advertises no nonce gets none", () => {
    const { serverSession: _, ...old } = planSession;
    expect(P.planDeny({ session: old, blocks, annotations }).body).not.toHaveProperty("serverSession");
  });
});

describe("annotate", () => {
  test("the agent reads the file export", () => {
    expect(P.docFeedback({ session: annotateSession, blocks, annotations })).toBe(FILE_FEEDBACK);
  });

  test("send feedback posts the export and the annotations", () => {
    sameWire(P.annotateSend({ session: annotateSession, blocks, annotations, draftGeneration: 1 }), {
      method: "POST",
      path: "/api/feedback",
      body: { draftGeneration: 2, feedback: FILE_FEEDBACK, annotations, codeAnnotations: [], serverSession: "nonce-2" },
    });
  });

  test("send with no annotations is the no-feedback sentence, marked nothing to send", () => {
    sameWire(P.annotateSend({ session: annotateSession, blocks, annotations: [] }).body, {
      draftGeneration: 1,
      feedback: NO_FEEDBACK,
      annotations: [],
      codeAnnotations: [],
      nothingToSend: true,
      serverSession: "nonce-2",
    });
  });

  test("gate approve carries the notes where the host delivers them", () => {
    sameWire(P.annotateApprove({ session: annotateSession, blocks, annotations }).body, {
      draftGeneration: 1,
      feedback: FILE_FEEDBACK,
      annotations,
      codeAnnotations: [],
      serverSession: "nonce-2",
    });
    sameWire(P.annotateApprove({ session: annotateSession, blocks, annotations: [] }).body, {
      draftGeneration: 1,
      feedback: "",
      annotations: [],
      codeAnnotations: [],
      serverSession: "nonce-2",
    });
  });

  test("gate approve is bare where approval notes are not delivered", () => {
    const session = { ...annotateSession, approvalNotesSupported: false };
    sameWire(P.annotateApprove({ session, blocks, annotations }).body, { draftGeneration: 1, serverSession: "nonce-2" });
  });

  test("close posts no body; generation and nonce ride the query", () => {
    sameWire(P.annotateExit({ session: { ...annotateSession, serverSession: "a b" }, blocks, annotations, draftGeneration: 6 }), {
      method: "POST",
      path: "/api/exit?draftGeneration=7&serverSession=a%20b",
    });
  });

  test("a converted source warns that line numbers refer to the markdown", () => {
    const feedback = P.docFeedback({ session: { ...annotateSession, sourceConverted: true }, blocks, annotations });
    expect(feedback.startsWith("# File Feedback\n\n> Note: Line numbers below refer to the converted markdown, not the original HTML/URL source.\n\nI've reviewed this file")).toBe(true);
  });
});

describe("code review", () => {
  const codeAnnotations = [
    { id: "c1", type: "comment", filePath: "src/a.ts", lineStart: 3, lineEnd: 4, side: "new", text: "Rename this.", createdAt: 1 },
    { id: "c2", type: "comment", scope: "general", filePath: "", lineStart: 0, lineEnd: 0, side: "new", text: "Add tests.", createdAt: 2 },
  ];
  const diffSession = { rawPatch: "", gitRef: "Uncommitted changes", origin: "claude-code", diffType: "uncommitted", gitContext: { defaultBranch: "main" }, approvalNotesSupported: true, serverSession: "nonce-3" };
  const REVIEW_FEEDBACK = "# Code Review Feedback\n\n**Diff:** Uncommitted changes\n\n## src/a.ts\n\n### Lines 3-4 (new)\nRename this.\n\n## General\n\nAdd tests.\n\n";

  test("the agent reads line comments by file, then the general comment", () => {
    expect(P.reviewFeedback({ session: diffSession, annotations: codeAnnotations })).toBe(REVIEW_FEEDBACK);
  });

  test("the diff line names the worktree and base the reviewer was on", () => {
    const session = { ...diffSession, diffType: "worktree:/w/feat:branch", base: "develop" };
    expect(P.reviewFeedback({ session, annotations: codeAnnotations })).toStartWith(
      "# Code Review Feedback\n\n**Diff:** Branch diff vs `develop` _(worktree: /w/feat)_\n\n",
    );
  });

  test("no comments reads as no feedback", () => {
    expect(P.reviewFeedback({ session: diffSession, annotations: [] })).toBe("# Code Review\n\nNo feedback provided.");
  });

  test("send feedback posts approved false with the export, no agent switch by default", () => {
    sameWire(P.reviewSend({ session: diffSession, annotations: codeAnnotations, approved: false, draftGeneration: 2 }), {
      method: "POST",
      path: "/api/feedback",
      body: { draftGeneration: 3, approved: false, feedback: REVIEW_FEEDBACK, annotations: codeAnnotations, serverSession: "nonce-3" },
    });
  });

  test("approve with comments carries them where the host delivers approval notes", () => {
    sameWire(P.reviewSend({ session: diffSession, annotations: codeAnnotations, approved: true }).body, {
      draftGeneration: 1, approved: true, feedback: REVIEW_FEEDBACK, annotations: codeAnnotations, serverSession: "nonce-3",
    });
  });

  test("bare approve sends empty feedback", () => {
    const session = { ...diffSession, approvalNotesSupported: false };
    sameWire(P.reviewSend({ session, annotations: codeAnnotations, approved: true }).body, {
      draftGeneration: 1, approved: true, feedback: "", annotations: [], serverSession: "nonce-3",
    });
  });
});

describe("drafts", () => {
  const withoutTs = (d: any) => ({ ...d, body: { ...d.body, ts: 0 } });

  test("a document draft saves the annotations one generation up", () => {
    const d = P.draftSave({ session: annotateSession, blocks, annotations, draftGeneration: 3 });
    expect(typeof d.body.ts).toBe("number");
    sameWire(withoutTs(d), {
      method: "POST",
      path: "/api/draft",
      body: { annotations, codeAnnotations: [], globalAttachments: [], draftGeneration: 4, ts: 0 },
      draftGeneration: 4,
    });
  });

  test("a review draft saves the code annotations", () => {
    const anns = [{ id: "c1", type: "comment", filePath: "a", lineStart: 1, lineEnd: 1, side: "new", text: "x", createdAt: 1 }];
    sameWire(withoutTs(P.draftSave({ session: {}, annotations: anns })), {
      method: "POST",
      path: "/api/draft",
      body: { codeAnnotations: anns, descriptionAnnotations: [], commentAnnotations: [], draftGeneration: 1, ts: 0 },
      draftGeneration: 1,
    });
  });

  test("clearing every annotation deletes the draft with a tombstone generation", () => {
    sameWire(P.draftSave({ session: annotateSession, blocks, annotations: [], draftGeneration: 7 }), {
      method: "DELETE",
      path: "/api/draft?generation=8",
      draftGeneration: 8,
    });
  });

  test("dismiss after an annotate decision deletes at the decision's generation", () => {
    const sent = (P.annotateSend({ session: annotateSession, blocks, annotations, draftGeneration: 2 }).body as any).draftGeneration;
    expect(P.draftDismiss({ draftGeneration: 2 })).toEqual({ method: "DELETE", path: `/api/draft?generation=${sent}`, draftGeneration: sent });
  });

  test("restore returns saved annotations and adopts the stored generation", () => {
    const r = P.draftRestore({ annotations, codeAnnotations: [], globalAttachments: [], draftGeneration: 9, ts: 1 });
    expect(r).toEqual({ annotations, globalAttachments: [], draftGeneration: 9 });
  });

  test("a missing draft still moves the counter past the server's tombstone", () => {
    expect(P.draftRestore({ found: false, draftGeneration: 12 }, 3)).toEqual({ annotations: [], globalAttachments: [], draftGeneration: 12 });
    expect(P.draftRestore({ found: false }, 3).draftGeneration).toBe(3);
  });

  test("a review draft restores its code annotations", () => {
    const anns = [{ id: "c1" }];
    expect(P.draftRestore({ codeAnnotations: anns, draftGeneration: 2, ts: 1 }).annotations).toEqual(anns);
  });
});
