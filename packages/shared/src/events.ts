import { z } from "zod";
import { Anchor, FeedbackRecord, FeedbackStatus, QuestionRecord, QuestionStatus } from "./records";

/** Session lifecycle, surfaced in the viewer. */
export const LifecycleState = z.enum([
  "no-agent", // session exists, no agent attached yet
  "waiting-for-review", // agent attached and idle in the wait-loop
  "agent-thinking", // agent is answering one or more questions
  "reworking", // agent is applying the finalize batch to the file
  "finalized", // review complete, agent ended
  "agent-disconnected", // heartbeat lost
]);
export type LifecycleState = z.infer<typeof LifecycleState>;

export const ReworkResult = z.enum(["success", "error"]);
export type ReworkResult = z.infer<typeof ReworkResult>;

// ---------------------------------------------------------------------------
// Agent-facing events — returned by `wait` as an ordered batch.
// Feedback is NOT an agent event; it rides along on questions (`pendingFeedback`)
// and the finalize batch so it never wakes the agent on its own.
// ---------------------------------------------------------------------------

/** A trimmed feedback shape attached to question/finalize events for context.
 *  `sourceQuestion` is the broker-resolved Q&A exchange a review item came from
 *  (Tier 2) — so the rework agent has the substance, not just an id. */
export const PendingFeedback = z.object({
  id: z.string(),
  anchor: Anchor.nullable(),
  text: z.string(),
  sourceQuestion: z
    .object({ id: z.string(), text: z.string(), answerMarkdown: z.string().nullable() })
    .nullish(),
});
export type PendingFeedback = z.infer<typeof PendingFeedback>;

/** One prior answered turn in a Q&A thread, oldest→newest. */
export const ThreadTurn = z.object({ text: z.string(), answerMarkdown: z.string() });
export type ThreadTurn = z.infer<typeof ThreadTurn>;

export const QuestionEvent = z.object({
  type: z.literal("question"),
  id: z.string(),
  anchor: Anchor.nullable(),
  text: z.string(),
  pendingFeedback: z.array(PendingFeedback),
  /** Prior answered turns in this question's thread (empty for a root question), so a
   *  spawned/compacted agent can answer a follow-up in context. */
  thread: z.array(ThreadTurn),
});
export type QuestionEvent = z.infer<typeof QuestionEvent>;

export const FinalizeEvent = z.object({
  type: z.literal("finalize"),
  batch: z.array(PendingFeedback),
  reviewNote: z.string().nullable(),
});
export type FinalizeEvent = z.infer<typeof FinalizeEvent>;

export const EndEvent = z.object({ type: z.literal("end") });
export type EndEvent = z.infer<typeof EndEvent>;

export const ReviewEvent = z.discriminatedUnion("type", [
  QuestionEvent,
  FinalizeEvent,
  EndEvent,
]);
export type ReviewEvent = z.infer<typeof ReviewEvent>;

// ---------------------------------------------------------------------------
// Viewer-facing events — pushed over the SSE `/stream`.
// ---------------------------------------------------------------------------

export const DocEvent = z.object({
  type: z.literal("doc"),
  markdown: z.string(),
  version: z.string(), // content hash
});

export const AnnotationsEvent = z.object({
  type: z.literal("annotations"),
  questions: z.array(QuestionRecord),
  feedback: z.array(FeedbackRecord),
});

export const AnswerEvent = z.object({
  type: z.literal("answer"),
  questionId: z.string(),
  markdown: z.string(),
});

export const QaStatusEvent = z.object({
  type: z.literal("qa-status"),
  id: z.string(),
  status: QuestionStatus,
  error: z.string().nullish(),
});

export const StateEvent = z.object({
  type: z.literal("state"),
  state: LifecycleState,
  reworkResult: ReworkResult.nullish(),
  message: z.string().nullish(),
});

export const FeedbackAckEvent = z.object({
  type: z.literal("feedback-ack"),
  feedback: FeedbackRecord,
});

export const FeedbackRemovedEvent = z.object({
  type: z.literal("feedback-removed"),
  id: z.string(),
});

/** A bulk feedback status transition (mirrors the store's setFeedbackStatus),
 *  so the viewer can retire items it already showed instead of leaving them
 *  frozen at the status they had when first acked (e.g. queued → submitted on
 *  finalize, submitted → reworked once the agent's rework lands). */
export const FeedbackStatusEvent = z.object({
  type: z.literal("feedback-status"),
  from: FeedbackStatus,
  to: FeedbackStatus,
});

export const AgentDisconnectedEvent = z.object({ type: z.literal("agent-disconnected") });

export const ServerEvent = z.discriminatedUnion("type", [
  DocEvent,
  AnnotationsEvent,
  AnswerEvent,
  QaStatusEvent,
  StateEvent,
  FeedbackAckEvent,
  FeedbackRemovedEvent,
  FeedbackStatusEvent,
  AgentDisconnectedEvent,
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
