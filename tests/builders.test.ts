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

  test("Claude Code approve carries the default permission mode and agent switch", () => {
    sameWire(P.planApprove({ session: planSession, blocks, annotations: [] }).body, {
      draftGeneration: 1,
      permissionMode: "acceptEdits",
      agentSwitch: "build",
      planSave: { enabled: true },
      serverSession: "nonce-1",
    });
  });

  test("approve with annotations carries the export whatever the host, as the web's handleApprove does", () => {
    expect((P.planApprove({ session: planSession, blocks, annotations }).body as any).feedback).toBe(PLAN_FEEDBACK);
    expect(P.planApprove({ session: planSession, blocks, annotations }, { discardFeedback: true }).body).not.toHaveProperty("feedback");
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

  test("approve with notes carries the comments and their export", () => {
    sameWire(P.reviewSend({ session: diffSession, annotations: codeAnnotations, approved: true, withAnnotations: true }).body, {
      draftGeneration: 1, approved: true, feedback: REVIEW_FEEDBACK, annotations: codeAnnotations, serverSession: "nonce-3",
    });
  });

  test("bare approve sends empty feedback and drops the comments", () => {
    sameWire(P.reviewSend({ session: diffSession, annotations: codeAnnotations, approved: true }).body, {
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

describe("the pin", () => {
  test("the bundle names the release it was built from", () => {
    expect(P.PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("an every-file diff reads as 0.28.45 labels it", () => {
    const session = { rawPatch: "", diffType: "all", gitContext: { defaultBranch: "main" } };
    const anns = [{ id: "c", type: "comment", filePath: "a", lineStart: 1, lineEnd: 1, side: "new", text: "x", createdAt: 1 }];
    expect(P.reviewFeedback({ session, annotations: anns })).toStartWith("# Code Review Feedback\n\n**Diff:** Every file\n\n");
  });
});

describe("page id", () => {
  const CLIENT = "1730000000000-0b1e7a9c-2f4d-4c1a-9e8f-6a5b4c3d2e1f";
  const doc = { session: planSession, blocks, annotations, clientId: CLIENT };

  test("a fresh id is a timestamp and a UUID, which the server's id check accepts", () => {
    const id = P.newClientId();
    expect(id).toMatch(/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    expect(P.newClientId()).not.toBe(id);
  });

  test("every document decision names the page after its own query", () => {
    expect(P.planApprove(doc).path).toBe(`/api/approve?client=${CLIENT}`);
    expect(P.planDeny(doc).path).toBe(`/api/deny?client=${CLIENT}`);
    const annotate = { ...doc, session: annotateSession };
    expect(P.annotateSend(annotate).path).toBe(`/api/feedback?client=${CLIENT}`);
    expect(P.annotateApprove(annotate).path).toBe(`/api/approve?client=${CLIENT}`);
    expect(P.annotateExit({ ...annotate, draftGeneration: 2 }).path).toBe(`/api/exit?draftGeneration=3&serverSession=nonce-2&client=${CLIENT}`);
  });

  test("the document session draft carries no page id", () => {
    expect(P.draftSave({ ...doc, session: annotateSession }).path).toBe("/api/draft");
    expect(P.draftDismiss({ ...doc, session: annotateSession }).path).toBe("/api/draft?generation=1");
    expect(P.draftLoad({ session: annotateSession, clientId: CLIENT }).path).toBe("/api/draft");
  });

  test("review decisions put the page first; exit then carries generation and nonce", () => {
    const review = { session: { rawPatch: "", serverSession: "n s" }, annotations: [], clientId: CLIENT, draftGeneration: 4 };
    expect(P.reviewSend({ ...review, approved: false }).path).toBe(`/api/feedback?client=${CLIENT}`);
    expect(P.reviewExit(review)).toEqual({ method: "POST", path: `/api/exit?client=${CLIENT}&draftGeneration=5&serverSession=n%20s` });
    expect(P.reviewExit({ ...review, clientId: undefined }).path).toBe("/api/exit?draftGeneration=5&serverSession=n%20s");
  });

  test("a local review's draft is pinned to the target on screen and names the page", () => {
    const anns = [{ id: "c1", type: "comment", filePath: "a", lineStart: 1, lineEnd: 1, side: "new", text: "x", createdAt: 1 }];
    const review = { session: { rawPatch: "", localDraftTarget: "/w/repo:uncommitted" }, annotations: anns, clientId: CLIENT };
    const target = `/api/draft?target=${encodeURIComponent("/w/repo:uncommitted")}&client=${CLIENT}`;
    expect(P.draftLoad(review)).toEqual({ method: "GET", path: target });
    expect(P.draftSave(review).path).toBe(target);
    expect(P.draftSave({ ...review, annotations: [], draftGeneration: 2 }).path).toBe(`${target}&generation=3`);
    expect(P.draftDismiss({ ...review, draftGeneration: 5 }).path).toBe(`${target}&generation=6`);
  });

  test("a PR review has no target and keeps the plain draft URL", () => {
    expect(P.draftLoad({ session: { rawPatch: "", localDraftTarget: null }, clientId: CLIENT }).path).toBe("/api/draft");
  });
});

describe("browser settings", () => {
  test("the cookie choices replace the first-time defaults on plan approve and deny", () => {
    const settings = { permissionMode: "bypassPermissions", planSave: { enabled: true, customPath: "/plans" }, agentSwitch: { switchTo: "custom", customName: "ship" } };
    sameWire(P.planApprove({ session: planSession, blocks, annotations: [], settings }).body, {
      draftGeneration: 1,
      permissionMode: "bypassPermissions",
      agentSwitch: "ship",
      planSave: { enabled: true, customPath: "/plans" },
      serverSession: "nonce-1",
    });
    sameWire(P.planDeny({ session: planSession, blocks, annotations, settings: { planSave: { enabled: false } } }).body, {
      draftGeneration: 1, feedback: PLAN_FEEDBACK, planSave: { enabled: false }, serverSession: "nonce-1",
    });
  });

  test("permission mode rides only Claude Code's approval", () => {
    const session = { ...planSession, origin: "opencode" };
    expect(P.planApprove({ session, blocks, annotations: [], settings: { permissionMode: "default" } }).body).not.toHaveProperty("permissionMode");
  });

  test("config.json's agent switch wins over the cookie's", () => {
    const session = { ...planSession, serverConfig: { agentSwitch: "disabled" } };
    expect(P.planApprove({ session, blocks, annotations: [], settings: { agentSwitch: { switchTo: "plan" } } }).body).not.toHaveProperty("agentSwitch");
  });

  test("a review sends the cookie's agent switch with its feedback, none by default", () => {
    const session = { rawPatch: "", diffType: "uncommitted" };
    const anns = [{ id: "c", type: "comment", filePath: "a", lineStart: 1, lineEnd: 1, side: "new", text: "x", createdAt: 1 }];
    expect(P.reviewSend({ session, annotations: anns, approved: false }).body).not.toHaveProperty("agentSwitch");
    expect((P.reviewSend({ session, annotations: anns, approved: false, settings: { agentSwitch: { switchTo: "build" } } }).body as any).agentSwitch).toBe("build");
  });

  test("a note's author is config.json's name, then the cookie's, then a tater name", () => {
    const authorOf = (input: any) => (P.decisionRequest("request-changes", input, "Note.")!.note as any).author;
    const base = { session: planSession, blocks, annotations: [] };
    expect(authorOf({ ...base, session: { ...planSession, serverConfig: { displayName: "Ada" } }, settings: { displayName: "Bob" } })).toBe("Ada");
    expect(authorOf({ ...base, settings: { displayName: "Bob" } })).toBe("Bob");
    expect(authorOf(base)).toMatch(/^[a-z]+-[a-z]+-tater$/);
  });
});

describe("decision control", () => {
  const CLIENT = "page-1";
  const NOTE = "Ship it after the migration.";
  const noteExport = (title: string, subject: string) =>
    `# ${title}\n\nI've reviewed this ${subject} and have 1 piece of feedback:\n\n## 1. General feedback about the ${subject}\n> ${NOTE}\n\n---\n`;
  const ids = (spec: any) => [spec.primary.label, ...spec.items.map((i: any) => i.id)];
  const wire = (r: any) => r && { requests: r.requests, note: r.note };

  /** The note the web commits before sending: a fresh id and timestamp, so the expectation takes them from it. */
  const expectDocNote = (note: any) => {
    expect(note.id).toStartWith("global-note-");
    sameWire({ ...note, id: "", createdA: 0 }, { id: "", blockId: "", startOffset: 0, endOffset: 0, type: "GLOBAL_COMMENT", text: NOTE, originalText: "", createdA: 0, author: "Ada" });
  };
  const settings = { displayName: "Ada" };

  describe("plan review", () => {
    const empty = { session: planSession, blocks, annotations: [], clientId: CLIENT, settings };
    const full = { ...empty, annotations };
    const approveBody = (extra: object = {}) => ({ draftGeneration: 1, permissionMode: "acceptEdits", agentSwitch: "build", planSave: { enabled: true }, ...extra, serverSession: "nonce-1" });
    const approve = (extra?: object) => ({ method: "POST", path: `/api/approve?client=${CLIENT}`, body: approveBody(extra) });
    const deny = (feedback: string) => ({ method: "POST", path: `/api/deny?client=${CLIENT}`, body: { draftGeneration: 1, feedback, planSave: { enabled: true }, serverSession: "nonce-1" } });

    test("the spec input is what the web computes, and drives the web's menu", () => {
      sameWire(P.decisionSpecInput("plan", full), {
        app: "plan", gate: true, count: 3, hasFeedback: true, approvalNotesSupported: false,
        plan: { answers: 0, directEdits: false, answersOnly: false, agentName: "Claude Code" },
      });
      expect(ids(P.buildDecisionSpec(P.decisionSpecInput("plan", full)))).toEqual(["Send Feedback", "note-with-feedback", "discard-and-finish"]);
      expect(ids(P.buildDecisionSpec(P.decisionSpecInput("plan", empty)))).toEqual(["Approve", "request-changes"]);
      const notes = { ...full, session: { ...planSession, approvalNotesSupported: true } };
      expect(ids(P.buildDecisionSpec(P.decisionSpecInput("plan", notes)))).toEqual(["Send Feedback", "note-with-feedback", "approve-with-notes", "discard-and-finish"]);
    });

    test("only OpenCode's approval names the agent it hands off to", () => {
      expect(P.decisionSpecInput("plan", { ...empty, approveTarget: "build" }).plan?.approveTarget).toBeUndefined();
      const opencode = { ...empty, session: { ...planSession, origin: "opencode" }, approveTarget: "build" };
      expect(P.buildDecisionSpec(P.decisionSpecInput("plan", opencode)).primary.label).toBe("Approve → build");
    });

    test("the primary approves when there is nothing to send, else denies with the feedback", () => {
      sameWire(wire(P.decisionRequest("primary", empty)), { requests: [approve()] });
      sameWire(wire(P.decisionRequest("primary", full)), { requests: [deny(PLAN_FEEDBACK)] });
    });

    test("a change-request note is a general comment on the deny", () => {
      for (const id of ["request-changes", "note-with-feedback"] as const) {
        const r = P.decisionRequest(id, empty, `  ${NOTE}  `)!;
        expectDocNote(r.note);
        sameWire(wire(r), { requests: [deny(noteExport("Plan Feedback", "plan"))], note: r.note });
      }
    });

    test("an approval note rides the approval's feedback", () => {
      const r = P.decisionRequest("note-with-approval", empty, NOTE)!;
      sameWire(wire(r), { requests: [approve({ feedback: noteExport("Plan Feedback", "plan") })], note: r.note });
    });

    test("approve with notes carries the export; discard approves bare", () => {
      sameWire(wire(P.decisionRequest("approve-with-notes", full)), { requests: [approve({ feedback: PLAN_FEEDBACK })] });
      sameWire(wire(P.decisionRequest("discard-and-finish", full)), { requests: [approve()] });
    });

    test("a blank note sends nothing", () => {
      expect(P.decisionRequest("request-changes", empty, "   ")).toBeNull();
      expect(P.decisionRequest("note-with-approval", empty)).toBeNull();
    });
  });

  describe("annotate", () => {
    const empty = { session: annotateSession, blocks, annotations: [], clientId: CLIENT, settings, draftGeneration: 2 };
    const full = { ...empty, annotations };
    const feedback = (body: object) => ({ method: "POST", path: `/api/feedback?client=${CLIENT}`, body: { draftGeneration: 3, ...body, serverSession: "nonce-2" } });
    const approve = (body: object) => ({ method: "POST", path: `/api/approve?client=${CLIENT}`, body: { draftGeneration: 3, ...body, serverSession: "nonce-2" } });
    const dismiss = { method: "DELETE", path: "/api/draft?generation=3", draftGeneration: 3 };
    const NOTHING = { feedback: NO_FEEDBACK, annotations: [], codeAnnotations: [], nothingToSend: true };

    test("the spec input is what the web computes", () => {
      sameWire(P.decisionSpecInput("annotate", full), { app: "annotate", gate: false, count: 3, hasFeedback: true, approvalNotesSupported: true, feedbackDelivered: false });
      expect(ids(P.buildDecisionSpec(P.decisionSpecInput("annotate", empty)))).toEqual(["Done", "request-changes"]);
      const gate = { ...full, session: { ...annotateSession, gate: true } };
      expect(ids(P.buildDecisionSpec(P.decisionSpecInput("annotate", gate)))).toEqual(["Send Feedback", "note-with-feedback", "approve-with-notes", "discard-and-finish"]);
    });

    test("Done records no feedback; Send Feedback sends the export; both then clear the draft", () => {
      sameWire(wire(P.decisionRequest("primary", empty)), { requests: [feedback(NOTHING), dismiss] });
      sameWire(wire(P.decisionRequest("primary", full)), {
        requests: [feedback({ feedback: FILE_FEEDBACK, annotations, codeAnnotations: [] }), dismiss],
      });
    });

    test("a note joins the annotations as a general comment", () => {
      for (const id of ["request-changes", "note-with-feedback", "note-with-approval"] as const) {
        const r = P.decisionRequest(id, empty, NOTE)!;
        expectDocNote(r.note);
        sameWire(wire(r), {
          requests: [feedback({ feedback: noteExport("File Feedback", "file"), annotations: [r.note], codeAnnotations: [] }), dismiss],
          note: r.note,
        });
      }
    });

    test("discard finishes with the no-feedback record and no annotations", () => {
      sameWire(wire(P.decisionRequest("discard-and-finish", full)), { requests: [feedback(NOTHING), dismiss] });
    });

    describe("with a gate", () => {
      const gEmpty = { ...empty, session: { ...annotateSession, gate: true } };
      const gFull = { ...gEmpty, annotations };

      test("the primary approves an empty review and sends feedback otherwise", () => {
        sameWire(wire(P.decisionRequest("primary", gEmpty)), { requests: [approve({ feedback: "", annotations: [], codeAnnotations: [] }), dismiss] });
        sameWire(wire(P.decisionRequest("primary", gFull)), {
          requests: [feedback({ feedback: FILE_FEEDBACK, annotations, codeAnnotations: [] }), dismiss],
        });
      });

      test("an approval note rides the approval", () => {
        const r = P.decisionRequest("note-with-approval", gEmpty, NOTE)!;
        sameWire(wire(r), {
          requests: [approve({ feedback: noteExport("File Feedback", "file"), annotations: [r.note], codeAnnotations: [] }), dismiss],
          note: r.note,
        });
      });

      test("approve with notes carries the export; discard approves with nothing", () => {
        sameWire(wire(P.decisionRequest("approve-with-notes", gFull)), {
          requests: [approve({ feedback: FILE_FEEDBACK, annotations, codeAnnotations: [] }), dismiss],
        });
        sameWire(wire(P.decisionRequest("discard-and-finish", gFull)), {
          requests: [approve({ feedback: "", annotations: [], codeAnnotations: [] }), dismiss],
        });
      });
    });
  });

  describe("code review", () => {
    const codeAnnotations = [{ id: "c1", type: "comment", filePath: "src/a.ts", lineStart: 3, lineEnd: 4, side: "new", text: "Rename this.", createdAt: 1 }];
    const session = { rawPatch: "", gitRef: "Uncommitted changes", diffType: "uncommitted", approvalNotesSupported: true, serverSession: "nonce-3", localDraftTarget: "t-1" };
    const empty = { session, annotations: [], clientId: CLIENT, settings };
    const full = { ...empty, annotations: codeAnnotations };
    const send = (body: object) => ({ method: "POST", path: `/api/feedback?client=${CLIENT}`, body: { draftGeneration: 1, ...body, serverSession: "nonce-3" } });
    const BARE = { approved: true, feedback: "", annotations: [] };
    const LINE_FEEDBACK = "# Code Review Feedback\n\n**Diff:** Uncommitted changes\n\n## src/a.ts\n\n### Lines 3-4 (new)\nRename this.\n\n";

    test("the spec input is what the web computes", () => {
      sameWire(P.decisionSpecInput("review", full), { app: "review", gate: true, count: 1, hasFeedback: true, approvalNotesSupported: true });
      expect(ids(P.buildDecisionSpec(P.decisionSpecInput("review", empty)))).toEqual(["Approve", "note-with-approval", "request-changes"]);
    });

    test("the primary approves bare when empty and sends the comments otherwise", () => {
      sameWire(wire(P.decisionRequest("primary", empty)), { requests: [send(BARE)] });
      sameWire(wire(P.decisionRequest("primary", full)), { requests: [send({ approved: false, feedback: LINE_FEEDBACK, annotations: codeAnnotations })] });
    });

    test("a change-request note is a general comment on the target on screen", () => {
      for (const id of ["request-changes", "note-with-feedback"] as const) {
        const r = P.decisionRequest(id, full, NOTE)!;
        const note = r.note as any;
        expect(note.id).toStartWith("review-note-");
        sameWire({ ...note, id: "", createdAt: 0 }, {
          id: "", type: "comment", scope: "general", filePath: "", lineStart: 0, lineEnd: 0, side: "new", text: NOTE, createdAt: 0, author: "Ada", localReviewTarget: "t-1",
        });
        sameWire(wire(r), {
          requests: [send({ approved: false, feedback: `${LINE_FEEDBACK}## General\n\n${NOTE}\n\n`, annotations: [...codeAnnotations, note] })],
          note,
        });
      }
    });

    test("an approval note is the approval's feedback and adds no comment", () => {
      sameWire(wire(P.decisionRequest("note-with-approval", empty, NOTE)), { requests: [send({ approved: true, feedback: NOTE, annotations: [] })] });
    });

    test("approve with notes carries the comments; discard approves bare", () => {
      sameWire(wire(P.decisionRequest("approve-with-notes", full)), { requests: [send({ approved: true, feedback: LINE_FEEDBACK, annotations: codeAnnotations })] });
      sameWire(wire(P.decisionRequest("discard-and-finish", full)), { requests: [send(BARE)] });
    });
  });

  test("an archive session has no decision control", () => {
    expect(() => P.decisionApp({ session: { mode: "archive" }, blocks: [], annotations: [] })).toThrow();
    expect(P.decisionApp({ session: annotateSession, blocks, annotations: [] })).toBe("annotate");
    expect(P.decisionApp({ session: planSession, blocks, annotations: [] })).toBe("plan");
    expect(P.decisionApp({ session: {}, annotations: [] })).toBe("review");
  });
});
