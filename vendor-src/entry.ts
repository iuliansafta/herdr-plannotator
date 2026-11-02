// The vendor bundle's surface. Upstream code is re-exported untouched; the
// builders below reproduce what Plannotator's React app POSTs, so the server
// and the agent cannot tell this client from the browser.

declare const PLANNOTATOR_PINNED_VERSION: string;
/** The plannotator release this bundle was built from (tools/build-vendor.ts). */
export const PINNED_VERSION: string = PLANNOTATOR_PINNED_VERSION;

export {
  parseMarkdownToBlocks,
  exportAnnotations,
  wrapFeedbackForAgent,
} from "@plannotator/ui/utils/parser";
export { exportReviewFeedback } from "@plannotator/review-editor/utils/exportFeedback";
export { planDenyFeedback } from "@plannotator/core/feedback-templates";

import { exportAnnotations } from "@plannotator/ui/utils/parser";
import { commitShaFromMode, exportReviewFeedback } from "@plannotator/review-editor/utils/exportFeedback";
import { buildReviewApprovalBody } from "@plannotator/review-editor/reviewDecision";
import { planDenyFeedbackFields } from "@plannotator/editor/questionDecision";
import { parseAgentSwitchConfig } from "@plannotator/core/agent-switch";
import { SERVER_SESSION_FIELD } from "@plannotator/core/server-session";
import type { Annotation, Block, CodeAnnotation, ImageAttachment } from "@plannotator/ui/types";

/** `/api/plan` JSON for plan and annotate sessions. */
export type PlanSession = Record<string, any>;
/** `/api/diff` JSON for review sessions. */
export type DiffSession = Record<string, any>;

/**
 * `draftGeneration` is the client's draft counter: the highest generation it
 * has sent or adopted (0 at start). A decision sends counter + 1; `draftSave`
 * and `draftDismiss` advance it and return the new value.
 */
export interface DocInput {
  session: PlanSession;
  blocks: Block[];
  annotations: Annotation[];
  globalAttachments?: ImageAttachment[];
  draftGeneration?: number;
}

export interface ReviewInput {
  session: DiffSession;
  annotations: CodeAnnotation[];
  draftGeneration?: number;
}

/** One HTTP request the web app would send. */
export interface Decision {
  method: "POST" | "DELETE";
  /** Path plus query, relative to the session origin. */
  path: string;
  body?: unknown;
  /** Draft requests only: the counter to pass as the next input's `draftGeneration`. */
  draftGeneration?: number;
}

export interface RestoredDraft {
  annotations: Annotation[] | CodeAnnotation[];
  globalAttachments: ImageAttachment[];
  /** The counter after adopting the server's generation. */
  draftGeneration: number;
}

// Ported from packages/editor/annotateSubmission.ts and directEdits.ts, which
// import the `diff` npm package for direct edits this client never makes.
const ANNOTATE_NO_FEEDBACK_SENTENCE = "User reviewed the document and has no feedback.";
const EMPTY_FEEDBACK_SENTINELS = new Set([
  "",
  ANNOTATE_NO_FEEDBACK_SENTENCE,
  "User reviewed the messages and has no feedback.",
]);

const nextGeneration = (input: { draftGeneration?: number }) => (input.draftGeneration ?? 0) + 1;

// packages/ui/utils/serverSession.ts withServerSession / withServerSessionQuery
const withServerSession = <T extends object>(body: T, session: Record<string, any>) =>
  typeof session.serverSession === "string" && session.serverSession
    ? { ...body, [SERVER_SESSION_FIELD]: session.serverSession }
    : body;
const withServerSessionQuery = (url: string, session: Record<string, any>) =>
  typeof session.serverSession === "string" && session.serverSession
    ? `${url}${url.includes("?") ? "&" : "?"}${SERVER_SESSION_FIELD}=${encodeURIComponent(session.serverSession)}`
    : url;

const post = (path: string, body: object, session: Record<string, any>): Decision => ({
  method: "POST",
  path,
  body: withServerSession(body, session),
});

// packages/ui/utils/agentSwitch.ts getAgentSwitchSettings + getEffectiveAgentName,
// with config.json (`serverConfig.agentSwitch`) over the surface default.
function effectiveAgent(session: Record<string, any>, surface: "plan" | "review"): string | undefined {
  const settings = parseAgentSwitchConfig(session.serverConfig?.agentSwitch)
    ?? { switchTo: surface === "plan" ? "build" : "disabled" };
  if (settings.switchTo === "disabled") return undefined;
  if (settings.switchTo === "custom") return settings.customName || undefined;
  return settings.switchTo;
}

// Defaults a first-time browser sends (no cookies): planSave on, permission
// mode `acceptEdits`, Obsidian / Bear / Octarine off.
const PLAN_SAVE_DEFAULT = { enabled: true };
const PERMISSION_MODE_DEFAULT = "acceptEdits";

/** Who the export is about, from the session mode (App.tsx setAnnotateSource). */
function feedbackHeading(session: PlanSession): { title: string; subject: string } {
  switch (session.mode) {
    case "annotate":
    case "annotate-app":
      return { title: "File Feedback", subject: "file" };
    case "annotate-last":
      return { title: "Message Feedback", subject: "message" };
    case "annotate-folder":
      return { title: "Folder Feedback", subject: "folder" };
    case "annotate-bundle":
      return { title: "Review Feedback", subject: "folder" };
    default:
      return { title: "Plan Feedback", subject: "plan" };
  }
}

const hasDocFeedback = (input: DocInput) =>
  input.annotations.length > 0 || (input.globalAttachments?.length ?? 0) > 0;

/** The `feedback` markdown the agent receives for a document session. */
// packages/editor/App.tsx:3540 getCurrentFeedbackPayload (buildCompleteAnnotateFeedback)
export function docFeedback(input: DocInput): string {
  if (!hasDocFeedback(input)) return ANNOTATE_NO_FEEDBACK_SENTENCE;
  const { title, subject } = feedbackHeading(input.session);
  return exportAnnotations(input.blocks, input.annotations, input.globalAttachments ?? [], title, subject, {
    sourceConverted: !!input.session.sourceConverted,
  }).replace(/^\n+/, "");
}

const planRevisionField = (session: PlanSession) =>
  session.mode === undefined && typeof session.planRevision === "number" ? { planRevision: session.planRevision } : {};

// packages/editor/App.tsx:4434 handleApprove
export function planApprove(input: DocInput): Decision {
  const { session } = input;
  const agentSwitch = effectiveAgent(session, "plan");
  const withNotes = session.approvalNotesSupported === true && hasDocFeedback(input);
  return post("/api/approve", {
    draftGeneration: nextGeneration(input),
    ...planRevisionField(session),
    ...(session.origin === "claude-code" ? { permissionMode: PERMISSION_MODE_DEFAULT } : {}),
    ...(agentSwitch ? { agentSwitch } : {}),
    planSave: PLAN_SAVE_DEFAULT,
    ...(withNotes ? { feedback: docFeedback(input) } : {}),
  }, session);
}

// packages/editor/App.tsx:4553 handleDeny
export function planDeny(input: DocInput): Decision {
  return post("/api/deny", {
    draftGeneration: nextGeneration(input),
    ...planRevisionField(input.session),
    ...planDenyFeedbackFields(docFeedback(input), false),
    planSave: PLAN_SAVE_DEFAULT,
  }, input.session);
}

// packages/editor/App.tsx:4630 handleAnnotateFeedback
export function annotateSend(input: DocInput): Decision {
  const feedback = docFeedback(input);
  return post("/api/feedback", {
    draftGeneration: nextGeneration(input),
    feedback,
    annotations: input.annotations,
    codeAnnotations: [],
    ...(EMPTY_FEEDBACK_SENTINELS.has(feedback) ? { nothingToSend: true } : {}),
  }, input.session);
}

// packages/editor/App.tsx:4728 handleAnnotateApprove
export function annotateApprove(input: DocInput): Decision {
  const draftGeneration = nextGeneration(input);
  if (input.session.approvalNotesSupported !== true) return post("/api/approve", { draftGeneration }, input.session);
  return post("/api/approve", {
    draftGeneration,
    feedback: hasDocFeedback(input) ? docFeedback(input) : "",
    annotations: input.annotations,
    codeAnnotations: [],
  }, input.session);
}

// packages/editor/App.tsx:4788 handleAnnotateExit
export function annotateExit(input: DocInput): Decision {
  return {
    method: "POST",
    path: withServerSessionQuery(`/api/exit?draftGeneration=${nextGeneration(input)}`, input.session),
  };
}

// packages/review-editor/App.tsx:1724 activeWorktreePath / activeDiffBase
const WORKTREE_SUB_TYPES = ["since-base", "local-vs-remote", "uncommitted", "staged", "unstaged", "last-commit", "branch", "merge-base", "all"];
function splitDiffType(diffType: string): { worktreePath: string | null; base: string } {
  if (!diffType.startsWith("worktree:")) return { worktreePath: null, base: diffType };
  const rest = diffType.slice("worktree:".length);
  const commitIdx = rest.lastIndexOf(":commit:");
  if (commitIdx !== -1 && /^commit:[0-9a-f]{4,64}$/i.test(rest.slice(commitIdx + 1))) {
    return { worktreePath: rest.slice(0, commitIdx), base: rest.slice(commitIdx + 1) };
  }
  const lastColon = rest.lastIndexOf(":");
  if (lastColon !== -1 && WORKTREE_SUB_TYPES.includes(rest.slice(lastColon + 1))) {
    return { worktreePath: rest.slice(0, lastColon), base: rest.slice(lastColon + 1) };
  }
  return { worktreePath: rest, base: "uncommitted" };
}

// packages/review-editor/App.tsx:3989 feedbackDiffContext
function feedbackDiffContext(session: DiffSession) {
  if (session.prMetadata) return undefined;
  const { worktreePath, base } = splitDiffType(session.diffType || "uncommitted");
  const committedBase = session.gitContext
    ? session.base || session.gitContext.defaultBranch || session.gitContext.compareTarget?.fallback || undefined
    : undefined;
  const commitSha = commitShaFromMode(base);
  const commitInfo = commitSha && session.commitInfo?.sha === commitSha ? session.commitInfo : null;
  return {
    mode: base,
    base: committedBase,
    worktreePath,
    commitSubject: commitInfo?.subject,
    commitShortId: commitInfo?.shortSha,
    snapshotId: session.snapshotId,
  };
}

// packages/review-editor/App.tsx:4004 prReviewScopeLabel
function prReviewScopeLabel(session: DiffSession): string | undefined {
  const pr = session.prMetadata;
  if (!pr || !session.prStackInfo) return undefined;
  return session.prDiffScope === "full-stack"
    ? `Diff vs \`${pr.defaultBranch ?? "default branch"}\``
    : `Diff vs \`${pr.baseBranch}\``;
}

/** The `feedback` markdown the agent receives for a review session. */
// packages/review-editor/App.tsx:4225 feedbackMarkdown
export function reviewFeedback(input: ReviewInput): string {
  const { session } = input;
  return exportReviewFeedback(input.annotations, session.prMetadata, feedbackDiffContext(session), prReviewScopeLabel(session));
}

// packages/review-editor/App.tsx:4272 handleSendFeedback, :4343 handleApprove
export function reviewSend(input: ReviewInput & { approved: boolean }): Decision {
  const { session } = input;
  const draftGeneration = nextGeneration(input);
  if (input.approved) {
    const withAnnotations = session.approvalNotesSupported === true && input.annotations.length > 0;
    return post("/api/feedback", buildReviewApprovalBody({
      draftGeneration,
      withAnnotations,
      feedbackMarkdown: reviewFeedback(input),
      annotations: input.annotations,
    }), session);
  }
  const agentSwitch = effectiveAgent(session, "review");
  return post("/api/feedback", {
    draftGeneration,
    approved: false,
    feedback: reviewFeedback(input),
    annotations: input.annotations,
    ...(agentSwitch ? { agentSwitch } : {}),
  }, session);
}

const isReview = (input: DocInput | ReviewInput): input is ReviewInput => !("blocks" in input);

/** The `/api/draft` request the web app sends after an annotation change. */
// packages/ui/hooks/useAnnotationDraft.ts:421 persistNow, useCodeAnnotationDraft.ts:229 autosave
export function draftSave(input: DocInput | ReviewInput): Decision {
  const draftGeneration = nextGeneration(input);
  const globalAttachments = isReview(input) ? [] : input.globalAttachments ?? [];
  if (input.annotations.length === 0 && globalAttachments.length === 0) {
    return { method: "DELETE", path: `/api/draft?generation=${draftGeneration}`, draftGeneration };
  }
  const body = isReview(input)
    ? { codeAnnotations: input.annotations, descriptionAnnotations: [], commentAnnotations: [], draftGeneration, ts: Date.now() }
    : { annotations: input.annotations, codeAnnotations: [], globalAttachments, draftGeneration, ts: Date.now() };
  return { method: "POST", path: "/api/draft", body, draftGeneration };
}

// packages/ui/hooks/useAnnotationDraft.ts:555 dismissDraft
export function draftDismiss(input: { draftGeneration?: number }): Decision {
  const draftGeneration = nextGeneration(input);
  return { method: "DELETE", path: `/api/draft?generation=${draftGeneration}`, draftGeneration };
}

const readGeneration = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

/** Reads any `/api/draft` answer (200 draft, 404 or 409 refusal) and adopts the server's generation. */
// packages/ui/hooks/useAnnotationDraft.ts:336, useCodeAnnotationDraft.ts:182 load draft on mount
export function draftRestore(draft: unknown, draftGeneration = 0): RestoredDraft {
  const data = (draft && typeof draft === "object" ? draft : {}) as Record<string, unknown>;
  const generation = readGeneration(data.draftGeneration);
  const annotations = Array.isArray(data.annotations)
    ? (data.annotations as Annotation[])
    : Array.isArray(data.codeAnnotations)
      ? (data.codeAnnotations as CodeAnnotation[])
      : [];
  return {
    annotations,
    globalAttachments: Array.isArray(data.globalAttachments) ? (data.globalAttachments as ImageAttachment[]) : [],
    draftGeneration: Math.max(draftGeneration, generation ?? 0),
  };
}
