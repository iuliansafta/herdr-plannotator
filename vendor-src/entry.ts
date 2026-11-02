// The vendor bundle's surface. Upstream code is re-exported untouched; the
// builders below reproduce what Plannotator's React app POSTs, so the server
// and the agent cannot tell this client from the browser.
export {
  parseMarkdownToBlocks,
  exportAnnotations,
  wrapFeedbackForAgent,
} from "@plannotator/ui/utils/parser";
export { exportReviewFeedback } from "@plannotator/review-editor/utils/exportFeedback";
export { planDenyFeedback } from "@plannotator/core/feedback-templates";

import type { Annotation, Block, CodeAnnotation, ImageAttachment } from "@plannotator/ui/types";

/** `/api/plan` JSON for plan and annotate sessions. */
export type PlanSession = Record<string, any>;
/** `/api/diff` JSON for review sessions. */
export type DiffSession = Record<string, any>;

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

/** One HTTP request the web app would send for a decision. */
export interface Decision {
  method: "POST";
  /** Path plus query, relative to the session origin. */
  path: string;
  body?: unknown;
}

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
}

const todo = (name: string): never => {
  throw new Error(`${name}: not implemented yet`);
};

/** The `feedback` markdown the agent receives for a document session. */
export function docFeedback(_input: DocInput): string {
  return todo("docFeedback");
}
export function planApprove(_input: DocInput): Decision {
  return todo("planApprove");
}
export function planDeny(_input: DocInput): Decision {
  return todo("planDeny");
}
export function annotateSend(_input: DocInput): Decision {
  return todo("annotateSend");
}
export function annotateApprove(_input: DocInput): Decision {
  return todo("annotateApprove");
}
export function annotateExit(_input: DocInput): Decision {
  return todo("annotateExit");
}
/** The `feedback` markdown the agent receives for a review session. */
export function reviewFeedback(_input: ReviewInput): string {
  return todo("reviewFeedback");
}
export function reviewSend(_input: ReviewInput & { approved: boolean }): Decision {
  return todo("reviewSend");
}
/** The `/api/draft` POST the web app sends after an annotation change. */
export function draftSave(_input: DocInput | ReviewInput): Decision {
  return todo("draftSave");
}
/** Annotations a `GET /api/draft` answer restores, or null when it has none. */
export function draftRestore(
  _draft: unknown,
): { annotations: Annotation[] | CodeAnnotation[]; globalAttachments: ImageAttachment[] } | null {
  return todo("draftRestore");
}
export function parsePatch(_rawPatch: string): DiffFile[] {
  return todo("parsePatch");
}
