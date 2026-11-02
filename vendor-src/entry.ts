// The vendor bundle's surface. Upstream code is re-exported untouched; the
// builders below reproduce what Plannotator's React app sends, so the server
// and the agent cannot tell this client from the browser. Line citations are
// to the tag in PINNED_VERSION.

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
export { buildDecisionSpec } from "@plannotator/ui/utils/decisionSpec";
export type {
  DecisionActionId,
  DecisionComposer,
  DecisionConfirm,
  DecisionMenuItem,
  DecisionPlanInput,
  DecisionPrimary,
  DecisionSpec,
  DecisionSpecInput,
  DecisionTone,
} from "@plannotator/ui/utils/decisionSpec";
export { generateIdentity } from "@plannotator/ui/utils/generateIdentity";

import { exportAnnotations } from "@plannotator/ui/utils/parser";
import { commitShaFromMode, exportReviewFeedback } from "@plannotator/review-editor/utils/exportFeedback";
import {
  buildReviewApprovalBody,
  createGeneralReviewComment,
  resolveReviewDecisionAction,
} from "@plannotator/review-editor/reviewDecision";
import { resolvePlanDecisionAction } from "@plannotator/editor/planDecision";
import { resolveAnnotateDecisionAction } from "@plannotator/editor/annotateDecision";
import { countQuestionAnswers, isAnswersOnlyFeedback, planDenyFeedbackFields } from "@plannotator/editor/questionDecision";
import { getAgentName } from "@plannotator/core/agents";
import { parseAgentSwitchConfig } from "@plannotator/core/agent-switch";
import { SERVER_SESSION_FIELD } from "@plannotator/core/server-session";
import { generateId } from "@plannotator/ui/utils/generateId";
import { generateIdentity } from "@plannotator/ui/utils/generateIdentity";
import type { DecisionActionId, DecisionSpecInput } from "@plannotator/ui/utils/decisionSpec";
import type { Annotation, Block, CodeAnnotation, ImageAttachment } from "@plannotator/ui/types";

/** `/api/plan` JSON for plan and annotate sessions. */
export type PlanSession = Record<string, any>;
/** `/api/diff` JSON for review sessions. */
export type DiffSession = Record<string, any>;

/**
 * What a browser keeps in cookies that changes a request. Each field is
 * optional; a missing one is what a first-time browser sends. `agentSwitch`
 * and `displayName` also live in config.json (`session.serverConfig`), which
 * wins over these, as the web app's configStore does.
 */
export interface BrowserSettings {
  /** `plannotator-permission-mode`: what Claude Code switches to after a plan approval. Default `acceptEdits`. */
  permissionMode?: "acceptEdits" | "auto" | "bypassPermissions" | "default";
  /** `plannotator-save-enabled` / `plannotator-save-path`. Default `{ enabled: true }`. */
  planSave?: { enabled: boolean; customPath?: string | null };
  /** `plannotator-agent-switch` / `plannotator-agent-custom`. Default: `build` on plan approval, none on review feedback. */
  agentSwitch?: { switchTo: string; customName?: string } | null;
  /** `plannotator-identity`: the `author` of a note the decision control adds. Default: a fresh tater name. */
  displayName?: string;
}

/**
 * Shared by every input. `draftGeneration` is the client's draft counter: the
 * highest generation it has sent or adopted (0 at start). A decision sends
 * counter + 1; `draftSave` and `draftDismiss` advance it and return the new
 * value. `clientId` names this page load on decision and review draft URLs
 * (`newClientId()`); keep one per pane.
 */
interface CommonInput {
  draftGeneration?: number;
  clientId?: string;
  settings?: BrowserSettings;
}

export interface DocInput extends CommonInput {
  session: PlanSession;
  blocks: Block[];
  annotations: Annotation[];
  globalAttachments?: ImageAttachment[];
  /** OpenCode only: the agent an approval hands off to, as the web shows it ("Approve → build"). */
  approveTarget?: string;
}

export interface ReviewInput extends CommonInput {
  session: DiffSession;
  annotations: CodeAnnotation[];
}

/** One HTTP request the web app would send. */
export interface Decision {
  method: "GET" | "POST" | "DELETE";
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

/**
 * What one decision-control action sends. Run `requests` in order and stop
 * at the first failure. `note` is the comment the web adds to the list before
 * sending (it is already in the body); keep it in the view if the send fails.
 */
export interface DecisionRequest {
  requests: Decision[];
  note?: Annotation | CodeAnnotation;
}

export type DecisionApp = "plan" | "annotate" | "review";

// packages/editor/App.tsx:2822 draftClientId (review-editor/App.tsx:726 uses a 7-char base36 suffix instead of a UUID)
/** A page id for `clientId`: what the plan / annotate editor mints per page load. */
export const newClientId = (): string => `${Date.now()}-${generateId()}`;

// Ported from packages/editor/annotateSubmission.ts and directEdits.ts, which
// import the `diff` npm package for direct edits this client never makes.
const ANNOTATE_NO_FEEDBACK_SENTENCE = "User reviewed the document and has no feedback.";
const EMPTY_FEEDBACK_SENTINELS = new Set([
  "",
  ANNOTATE_NO_FEEDBACK_SENTENCE,
  "User reviewed the messages and has no feedback.",
]);

const nextGeneration = (input: { draftGeneration?: number }) => (input.draftGeneration ?? 0) + 1;

// packages/ui/utils/serverSession.ts:34 withServerSession, :39 withServerSessionQuery
const withServerSession = <T extends object>(body: T, session: Record<string, any>) =>
  typeof session.serverSession === "string" && session.serverSession
    ? { ...body, [SERVER_SESSION_FIELD]: session.serverSession }
    : body;
const withServerSessionQuery = (url: string, session: Record<string, any>) =>
  typeof session.serverSession === "string" && session.serverSession
    ? `${url}${url.includes("?") ? "&" : "?"}${SERVER_SESSION_FIELD}=${encodeURIComponent(session.serverSession)}`
    : url;

// packages/editor/App.tsx:2823 withDraftClient
const withDraftClient = (path: string, clientId: string | undefined) =>
  clientId ? `${path}${path.includes("?") ? "&" : "?"}client=${encodeURIComponent(clientId)}` : path;

const post = (path: string, body: object, input: { session: Record<string, any> }): Decision => ({
  method: "POST",
  path,
  body: withServerSession(body, input.session),
});

// packages/ui/utils/agentSwitch.ts:68 getAgentSwitchSettings + :95 getEffectiveAgentName,
// with config.json over the cookie (packages/ui/config/settings.ts:790 agentSwitch, configStore.init).
function effectiveAgent(input: CommonInput & { session: Record<string, any> }, surface: "plan" | "review"): string | undefined {
  const stored = parseAgentSwitchConfig(input.session.serverConfig?.agentSwitch) ?? input.settings?.agentSwitch ?? null;
  const settings = stored ?? { switchTo: surface === "plan" ? "build" : "disabled" };
  if (settings.switchTo === "disabled") return undefined;
  if (settings.switchTo === "custom") return settings.customName || undefined;
  return settings.switchTo;
}

// packages/ui/config/settings.ts:156 displayName (config.json > cookie > generated)
function identity(input: CommonInput & { session: Record<string, any> }): string {
  const fromServer = input.session.serverConfig?.displayName;
  return typeof fromServer === "string" && fromServer ? fromServer : input.settings?.displayName || generateIdentity();
}

// packages/ui/utils/permissionMode.ts:55 getPermissionModeSettings (cookie only, no serverKey)
const permissionMode = (input: CommonInput) => input.settings?.permissionMode || "acceptEdits";

// packages/editor/App.tsx:4569 body.planSave from packages/ui/utils/planSave.ts:28 getPlanSaveSettings (cookie only)
function planSave(input: CommonInput) {
  const saved = input.settings?.planSave;
  const enabled = saved ? saved.enabled !== false : true;
  return { enabled, ...(saved?.customPath ? { customPath: saved.customPath } : {}) };
}

const ANNOTATE_MODES = new Set(["annotate", "annotate-last", "annotate-folder", "annotate-bundle", "annotate-app"]);

/** Which decision control a session gets. */
export function decisionApp(input: DocInput | ReviewInput): DecisionApp {
  if (isReview(input)) return "review";
  if (ANNOTATE_MODES.has(input.session.mode)) return "annotate";
  if (input.session.mode === undefined) return "plan";
  throw new Error(`no decision control for a ${input.session.mode} session`);
}

/** Who the export is about, from the session mode (packages/editor/App.tsx:3628 getCurrentFeedbackPayload). */
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

// packages/editor/App.tsx:2467 feedbackAnnotationCount, :4462 hasFeedbackToSend
const docFeedbackCount = (input: DocInput) => input.annotations.length + (input.globalAttachments?.length ?? 0);
const hasDocFeedback = (input: DocInput) => docFeedbackCount(input) > 0;

/** The `feedback` markdown the agent receives for a document session. */
// packages/editor/App.tsx:3607 getCurrentFeedbackPayload (buildCompleteAnnotateFeedback)
export function docFeedback(input: DocInput): string {
  if (!hasDocFeedback(input)) return ANNOTATE_NO_FEEDBACK_SENTENCE;
  const { title, subject } = feedbackHeading(input.session);
  return exportAnnotations(input.blocks, input.annotations, input.globalAttachments ?? [], title, subject, {
    sourceConverted: !!input.session.sourceConverted,
  }).replace(/^\n+/, "");
}

const planRevisionField = (session: PlanSession) =>
  session.mode === undefined && typeof session.planRevision === "number" ? { planRevision: session.planRevision } : {};

// packages/editor/App.tsx:3508 questionAnswerCount, :3509 answersOnlyFeedback
const answersOnly = (input: DocInput) =>
  isAnswersOnlyFeedback({
    answerCount: countQuestionAnswers([input.annotations]),
    feedbackCount: docFeedbackCount(input),
    hasDirectEdits: false,
    hasSavedFileChanges: false,
  });

/** `discardFeedback`: the confirmed "Approve, discard …" row, a bare approval. */
// packages/editor/App.tsx:4523 handleApprove
export function planApprove(input: DocInput, options?: { discardFeedback?: boolean }): Decision {
  const agentSwitch = effectiveAgent(input, "plan");
  return post(withDraftClient("/api/approve", input.clientId), {
    draftGeneration: nextGeneration(input),
    ...planRevisionField(input.session),
    ...(input.session.origin === "claude-code" ? { permissionMode: permissionMode(input) } : {}),
    ...(agentSwitch ? { agentSwitch } : {}),
    planSave: planSave(input),
    ...(!options?.discardFeedback && hasDocFeedback(input) ? { feedback: docFeedback(input) } : {}),
  }, input);
}

// packages/editor/App.tsx:4648 handleDeny
export function planDeny(input: DocInput): Decision {
  return post(withDraftClient("/api/deny", input.clientId), {
    draftGeneration: nextGeneration(input),
    ...planRevisionField(input.session),
    ...planDenyFeedbackFields(docFeedback(input), answersOnly(input)),
    planSave: planSave(input),
  }, input);
}

/** `discard`: the confirmed "Done, discard …" row; the agent reads the no-feedback sentence. */
// packages/editor/App.tsx:4725 handleAnnotateFeedback
export function annotateSend(input: DocInput, options?: { discard?: boolean }): Decision {
  const discard = options?.discard === true;
  const feedback = discard ? ANNOTATE_NO_FEEDBACK_SENTENCE : docFeedback(input);
  return post(withDraftClient("/api/feedback", input.clientId), {
    draftGeneration: nextGeneration(input),
    feedback,
    annotations: discard ? [] : input.annotations,
    codeAnnotations: [],
    ...(EMPTY_FEEDBACK_SENTINELS.has(feedback) ? { nothingToSend: true } : {}),
  }, input);
}

/** `discard`: the confirmed "Approve, discard …" row of a gate session. */
// packages/editor/App.tsx:4823 handleAnnotateApprove, annotateSubmission.ts:43 buildAnnotateApprovalBody
export function annotateApprove(input: DocInput, options?: { discard?: boolean }): Decision {
  const path = withDraftClient("/api/approve", input.clientId);
  const draftGeneration = nextGeneration(input);
  if (input.session.approvalNotesSupported !== true) return post(path, { draftGeneration }, input);
  const discard = options?.discard === true;
  return post(path, {
    draftGeneration,
    feedback: !discard && hasDocFeedback(input) ? docFeedback(input) : "",
    annotations: discard ? [] : input.annotations,
    codeAnnotations: [],
  }, input);
}

// packages/editor/App.tsx:4883 handleAnnotateExit
export function annotateExit(input: DocInput): Decision {
  const path = withServerSessionQuery(`/api/exit?draftGeneration=${nextGeneration(input)}`, input.session);
  return { method: "POST", path: withDraftClient(path, input.clientId) };
}

// packages/review-editor/App.tsx:1926 activeWorktreePath / activeDiffBase
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

// packages/review-editor/App.tsx:4539 feedbackDiffContext, :1953 activeCommitContext, :2931 committedBase
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

// packages/review-editor/App.tsx:4554 prReviewScopeLabel
function prReviewScopeLabel(session: DiffSession): string | undefined {
  const pr = session.prMetadata;
  if (!pr || !session.prStackInfo) return undefined;
  return session.prDiffScope === "full-stack"
    ? `Diff vs \`${pr.defaultBranch ?? "default branch"}\``
    : `Diff vs \`${pr.baseBranch}\``;
}

/** The `feedback` markdown the agent receives for a review session. */
// packages/review-editor/App.tsx:4789 feedbackMarkdown
export function reviewFeedback(input: ReviewInput): string {
  const { session } = input;
  return exportReviewFeedback(input.annotations, session.prMetadata, feedbackDiffContext(session), prReviewScopeLabel(session));
}

// packages/review-editor/App.tsx:730 feedbackUrl, :731 exitUrl (the id is not URL-encoded there)
const reviewDecisionPath = (path: string, clientId: string | undefined) => (clientId ? `${path}?client=${clientId}` : path);

/**
 * `approved: false` sends the feedback. `approved: true` is the bare Approve
 * unless `note` ("Approve with a note…") or `withAnnotations` ("Approve with
 * notes") says what rides along.
 */
// packages/review-editor/App.tsx:4836 handleSendFeedback, :4907 handleApprove
export function reviewSend(input: ReviewInput & { approved: boolean; note?: string; withAnnotations?: boolean }): Decision {
  const path = reviewDecisionPath("/api/feedback", input.clientId);
  const draftGeneration = nextGeneration(input);
  if (input.approved) {
    return post(path, buildReviewApprovalBody({
      draftGeneration,
      note: input.note,
      withAnnotations: input.withAnnotations === true,
      feedbackMarkdown: reviewFeedback(input),
      annotations: input.annotations,
    }), input);
  }
  const agentSwitch = effectiveAgent(input, "review");
  return post(path, {
    draftGeneration,
    approved: false,
    feedback: reviewFeedback(input),
    annotations: input.annotations,
    ...(agentSwitch ? { agentSwitch } : {}),
  }, input);
}

/** The review header's Close. */
// packages/review-editor/App.tsx:4880 handleExit
export function reviewExit(input: ReviewInput): Decision {
  const exitUrl = input.clientId ? `/api/exit?client=${input.clientId}&` : "/api/exit?";
  return { method: "POST", path: withServerSessionQuery(`${exitUrl}draftGeneration=${nextGeneration(input)}`, input.session) };
}

/** The decision control's input, derived as the web app derives it. */
// packages/editor/App.tsx:6553 annotateDecisionSpec, :6618 planDecisionSpec; review-editor/App.tsx:5089 reviewDecisionSpec
export function decisionSpecInput(kind: DecisionApp, input: DocInput | ReviewInput): DecisionSpecInput {
  const approvalNotesSupported = input.session.approvalNotesSupported === true;
  if (kind === "review") {
    const count = input.annotations.length;
    return { app: "review", gate: true, count, hasFeedback: count > 0, approvalNotesSupported };
  }
  const doc = input as DocInput;
  const count = docFeedbackCount(doc);
  if (kind === "annotate") {
    return { app: "annotate", gate: doc.session.gate === true, count, hasFeedback: count > 0, approvalNotesSupported, feedbackDelivered: false };
  }
  return {
    app: "plan",
    gate: true,
    count,
    hasFeedback: count > 0,
    approvalNotesSupported,
    plan: {
      answers: countQuestionAnswers([doc.annotations]),
      directEdits: false,
      answersOnly: answersOnly(doc),
      agentName: getAgentName(doc.session.origin),
      approveTarget: doc.session.origin === "opencode" ? doc.approveTarget : undefined,
    },
  };
}

// packages/editor/App.tsx:6466 commitSubmitNote
function documentNote(input: DocInput, text: string): Annotation | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return {
    id: generateId("global-note"),
    blockId: "",
    startOffset: 0,
    endOffset: 0,
    type: "GLOBAL_COMMENT",
    text: trimmed,
    originalText: "",
    createdA: Date.now(),
    author: identity(input),
  } as Annotation;
}

// packages/review-editor/App.tsx:5010 commitReviewNote
function reviewNote(input: ReviewInput, text: string): CodeAnnotation | null {
  const note = createGeneralReviewComment(text, identity(input));
  if (note && input.session.localDraftTarget) note.localReviewTarget = input.session.localDraftTarget;
  return note;
}

/** A sent document decision clears the session draft (useAnnotationDraft dismissDraft). */
const thenDismiss = (input: DocInput, decision: Decision): Decision[] => [decision, draftDismiss(input)];

/**
 * The requests one DecisionActionId sends, with `note` the composer's text
 * for the ids whose spec item has a composer. Null when a composer note is
 * blank: the web sends nothing then.
 */
// packages/editor/App.tsx:6596 runPlanDecisionAction, :6516 runAnnotateDecisionAction, :6421 submitPrimaryDecision,
// :6380 dispatchPendingDecision; review-editor/App.tsx:5056 runReviewDecisionAction, :4983 submitPrimaryDecision
export function decisionRequest(id: DecisionActionId, input: DocInput | ReviewInput, note?: string): DecisionRequest | null {
  if (isReview(input)) {
    const action = resolveReviewDecisionAction(id);
    switch (action.kind) {
      case "primary":
        return { requests: [reviewSend({ ...input, approved: input.annotations.length === 0 })] };
      case "note": {
        const added = reviewNote(input, note ?? "");
        if (!added) return null;
        return { requests: [reviewSend({ ...input, annotations: [...input.annotations, added], approved: false })], note: added };
      }
      case "discard":
        return { requests: [reviewSend({ ...input, approved: true })] };
      case "approve-with-notes":
        if (!action.withAnnotations && !note?.trim()) return null;
        return { requests: [reviewSend({ ...input, approved: true, note, withAnnotations: action.withAnnotations })] };
    }
  }

  const withNote = (): { doc: DocInput; added: Annotation } | null => {
    const added = documentNote(input, note ?? "");
    return added ? { doc: { ...input, annotations: [...input.annotations, added] }, added } : null;
  };

  if (decisionApp(input) === "plan") {
    const action = resolvePlanDecisionAction(id);
    switch (action.kind) {
      case "primary":
        return { requests: [hasDocFeedback(input) ? planDeny(input) : planApprove(input)] };
      case "note": {
        const n = withNote();
        if (!n) return null;
        return { requests: [action.route === "approve" ? planApprove(n.doc) : planDeny(n.doc)], note: n.added };
      }
      case "approve":
        return { requests: [planApprove(input, { discardFeedback: action.discardFeedback })] };
    }
  }

  const gate = input.session.gate === true;
  const action = resolveAnnotateDecisionAction(id, { gate });
  switch (action.kind) {
    case "primary":
      return { requests: thenDismiss(input, gate && !hasDocFeedback(input) ? annotateApprove(input) : annotateSend(input)) };
    case "note": {
      const n = withNote();
      if (!n) return null;
      return { requests: thenDismiss(n.doc, action.route === "approve" ? annotateApprove(n.doc) : annotateSend(n.doc)), note: n.added };
    }
    case "approve-with-notes":
      return { requests: thenDismiss(input, annotateApprove(input)) };
    case "discard":
      return { requests: thenDismiss(input, action.route === "approve" ? annotateApprove(input, { discard: true }) : annotateSend(input, { discard: true })) };
  }
}

const isReview = (input: { session: unknown; blocks?: unknown }): input is ReviewInput => !("blocks" in input);

// packages/review-editor/utils/localReviewDraft.ts:25 localReviewDraftTransport; a PR review
// (no localDraftTarget) keeps packages/ui/hooks/useAnnotationDraft.ts:69 default transport.
function draftPath(input: { session?: Record<string, any>; clientId?: string }): string {
  const target = input.session?.localDraftTarget;
  if (typeof target !== "string" || !target) return "/api/draft";
  const client = input.clientId ? `&client=${encodeURIComponent(input.clientId)}` : "";
  return `/api/draft?target=${encodeURIComponent(target)}${client}`;
}
const draftDeletePath = (input: { session?: Record<string, any>; clientId?: string }, generation: number) => {
  const path = draftPath(input);
  return `${path}${path.includes("?") ? "&" : "?"}generation=${generation}`;
};

/** The `/api/draft` read the web app makes on load; pass the answer to `draftRestore`. */
// packages/ui/hooks/useAnnotationDraft.ts:393, useCodeAnnotationDraft.ts:212 load draft on mount
export function draftLoad(input: { session?: Record<string, any>; clientId?: string }): Decision {
  return { method: "GET", path: draftPath(input) };
}

/** The `/api/draft` request the web app sends after an annotation change. */
// packages/ui/hooks/useAnnotationDraft.ts:484 persistNow, useCodeAnnotationDraft.ts:289 persist
export function draftSave(input: DocInput | ReviewInput): Decision {
  const draftGeneration = nextGeneration(input);
  const globalAttachments = isReview(input) ? [] : input.globalAttachments ?? [];
  if (input.annotations.length === 0 && globalAttachments.length === 0) {
    return { method: "DELETE", path: draftDeletePath(input, draftGeneration), draftGeneration };
  }
  const body = isReview(input)
    ? { codeAnnotations: input.annotations, descriptionAnnotations: [], commentAnnotations: [], draftGeneration, ts: Date.now() }
    : { annotations: input.annotations, codeAnnotations: [], globalAttachments, draftGeneration, ts: Date.now() };
  return { method: "POST", path: draftPath(input), body, draftGeneration };
}

// packages/ui/hooks/useAnnotationDraft.ts:618 dismissDraft, useCodeAnnotationDraft.ts:383 dismissDraft
export function draftDismiss(input: { draftGeneration?: number; session?: Record<string, any>; clientId?: string }): Decision {
  const draftGeneration = nextGeneration(input);
  return { method: "DELETE", path: draftDeletePath(input, draftGeneration), draftGeneration };
}

const readGeneration = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

/** Reads any `/api/draft` answer (200 draft, 404 or 409 refusal) and adopts the server's generation. */
// packages/ui/hooks/useAnnotationDraft.ts:393, useCodeAnnotationDraft.ts:212 load draft on mount
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
