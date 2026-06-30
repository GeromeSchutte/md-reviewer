import { z } from "zod";
import { Anchor } from "./records";
import { LifecycleState, ReviewEvent } from "./events";

/** The daemon's fixed port. */
export const DEFAULT_PORT = 8787;
export const brokerBaseUrl = (port: number = DEFAULT_PORT): string => `http://localhost:${port}`;

export const AgentSourceInput = z.enum(["agent", "spawned"]);

// ---------------------------------------------------------------------------
// Agent-side endpoints (driven by the CLI / SKILL via Bash)
// ---------------------------------------------------------------------------

/** POST /sessions/:sid/attach */
export const AttachRequest = z.object({
  planPath: z.string(),
  source: AgentSourceInput,
});
export type AttachRequest = z.infer<typeof AttachRequest>;

export const AttachResponse = z.object({
  ok: z.literal(true),
  state: LifecycleState,
});
export type AttachResponse = z.infer<typeof AttachResponse>;

/** GET /sessions/:sid/wait?since=<cursor> -> ordered batch (empty when idle) */
export const WaitResponse = z.object({
  events: z.array(ReviewEvent),
  cursor: z.string(),
});
export type WaitResponse = z.infer<typeof WaitResponse>;

/** POST /sessions/:sid/answers — exactly one of markdown | error. Idempotent by questionId. */
export const AnswerRequest = z.object({
  questionId: z.string(),
  markdown: z.string().optional(),
  error: z.string().optional(),
});
export type AnswerRequest = z.infer<typeof AnswerRequest>;

/** POST /sessions/:sid/rework-done */
export const ReworkDoneRequest = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export type ReworkDoneRequest = z.infer<typeof ReworkDoneRequest>;

// ---------------------------------------------------------------------------
// Viewer-side endpoints
// ---------------------------------------------------------------------------

/** POST /sessions. `expectAgent` = the caller (an agent) will attach itself, so the broker must NOT auto-spawn one. */
export const CreateSessionRequest = z.object({
  planPath: z.string(),
  expectAgent: z.boolean().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const CreateSessionResponse = z.object({
  sid: z.string(),
  state: LifecycleState,
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

/** POST /sessions/:sid/questions. `parentId` (when set) makes this a follow-up: the
 *  broker inherits the parent's thread + anchor, so the client need not resend them. */
export const CreateQuestionRequest = z.object({
  anchor: Anchor.nullish(),
  text: z.string().min(1),
  parentId: z.string().nullish(),
});
export type CreateQuestionRequest = z.infer<typeof CreateQuestionRequest>;

/** POST /sessions/:sid/feedback. `sourceQuestionId` (when set) records that this review
 *  item came from a Q&A exchange; the broker resolves it into the finalize batch. */
export const CreateFeedbackRequest = z.object({
  anchor: Anchor.nullish(),
  text: z.string().min(1),
  sourceQuestionId: z.string().nullish(),
});
export type CreateFeedbackRequest = z.infer<typeof CreateFeedbackRequest>;

/** POST /sessions/:sid/finalize */
export const FinalizeRequest = z.object({
  reviewNote: z.string().nullish(),
});
export type FinalizeRequest = z.infer<typeof FinalizeRequest>;

export const IdResponse = z.object({ id: z.string() });
export type IdResponse = z.infer<typeof IdResponse>;

export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;

/** GET /health */
export const HealthResponse = z.object({
  ok: z.literal(true),
  sessions: z.number(),
  version: z.string(),
  /** The checked-out commit the broker is running from. Lets the viewer detect when
   *  an applied update has landed (the restarted broker reports the new sha). */
  sha: z.string().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// ---------------------------------------------------------------------------
// Self-update endpoints (global — an update affects the whole install)
// ---------------------------------------------------------------------------

export const UpdateCommit = z.object({
  sha: z.string(),
  subject: z.string(),
});
export type UpdateCommit = z.infer<typeof UpdateCommit>;

/** GET /update/check — read-only status of this clone vs. its upstream branch. */
export const UpdateStatus = z.object({
  /** Human-readable version from the root package.json. */
  version: z.string(),
  branch: z.string(),
  /** Currently checked-out commit. */
  sha: z.string(),
  /** Latest upstream commit (after fetching over HTTPS). Null if the check failed. */
  remoteSha: z.string().nullable(),
  /** Commits on the upstream branch not yet checked out (how far behind we are). */
  behind: z.number(),
  /** Local commits not on the upstream branch (diverged when > 0). */
  ahead: z.number(),
  /** Working tree has no uncommitted changes — required to apply. */
  clean: z.boolean(),
  /** behind > 0 && ahead === 0 && clean — an update can be applied. */
  canApply: z.boolean(),
  /** Newest-first subjects of the commits we're behind by (capped). */
  commits: z.array(UpdateCommit),
  /** Set when the check itself failed (offline, git error); other fields best-effort. */
  error: z.string().nullable(),
});
export type UpdateStatus = z.infer<typeof UpdateStatus>;

/** POST /update/apply — kicks off `scripts/update` detached and returns immediately.
 *  `started: false` means a pre-flight guard refused (dirty/diverged/up-to-date). */
export const UpdateApplyResponse = z.object({
  started: z.boolean(),
  /** When started, the commit the viewer should poll /health for. */
  targetSha: z.string().nullable(),
  error: z.string().nullable(),
});
export type UpdateApplyResponse = z.infer<typeof UpdateApplyResponse>;

/** Canonical endpoint paths (relative to the broker base URL). */
export const routes = {
  health: "/health",
  sessions: "/sessions",
  attach: (sid: string) => `/sessions/${sid}/attach`,
  wait: (sid: string) => `/sessions/${sid}/wait`,
  answers: (sid: string) => `/sessions/${sid}/answers`,
  reworkDone: (sid: string) => `/sessions/${sid}/rework-done`,
  stream: (sid: string) => `/sessions/${sid}/stream`,
  doc: (sid: string) => `/sessions/${sid}/doc`,
  questions: (sid: string) => `/sessions/${sid}/questions`,
  questionRetry: (sid: string, id: string) => `/sessions/${sid}/questions/${id}/retry`,
  feedback: (sid: string) => `/sessions/${sid}/feedback`,
  feedbackItem: (sid: string, id: string) => `/sessions/${sid}/feedback/${id}`,
  finalize: (sid: string) => `/sessions/${sid}/finalize`,
  end: (sid: string) => `/sessions/${sid}/end`,
  updateCheck: "/update/check",
  updateApply: "/update/apply",
} as const;
