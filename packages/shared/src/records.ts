import { z } from "zod";

/**
 * Stored record shapes (the durable model). Everything is keyed by the plan's
 * absolute path. SQLite columns are snake_case; the store maps to/from these
 * camelCase shapes.
 */

/** A contiguous range of 1-based source lines in the plan markdown. */
export const LineRange = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});
export type LineRange = z.infer<typeof LineRange>;

/**
 * A text-quote selector (Hypothesis-style). Captured in v1 alongside the line
 * range so v2 can re-locate an anchor across reworks/sessions; v1 renders by
 * line range only.
 */
export const QuoteSelector = z.object({
  exact: z.string(),
  prefix: z.string(),
  suffix: z.string(),
});
export type QuoteSelector = z.infer<typeof QuoteSelector>;

/** Ties an annotation to a region of the plan. `null` annotations are unanchored (general). */
export const Anchor = z.object({
  lineRange: LineRange,
  quote: QuoteSelector.nullish(),
});
export type Anchor = z.infer<typeof Anchor>;

export const QuestionStatus = z.enum(["queued", "in-progress", "answered", "error"]);
export type QuestionStatus = z.infer<typeof QuestionStatus>;

export const FeedbackStatus = z.enum(["queued", "submitted", "reworked", "orphaned"]);
export type FeedbackStatus = z.infer<typeof FeedbackStatus>;

/** `comment` = an ordinary review comment; `summary` = the overall review note from Submit review. */
export const FeedbackKind = z.enum(["comment", "summary"]);
export type FeedbackKind = z.infer<typeof FeedbackKind>;

export const AgentSource = z.enum(["agent", "spawned"]);
export type AgentSource = z.infer<typeof AgentSource>;

export const PlanRecord = z.object({
  abspath: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  reviewNote: z.string().nullable(),
});
export type PlanRecord = z.infer<typeof PlanRecord>;

/**
 * Questions double as the durable work queue: ordered by createdAt, with
 * `status` acting as the cursor (queued -> in-progress -> answered|error).
 */
export const QuestionRecord = z.object({
  id: z.string(),
  abspath: z.string(),
  anchor: Anchor.nullable(),
  docVersion: z.string(),
  text: z.string(),
  createdAt: z.number(),
  status: QuestionStatus,
  answerMarkdown: z.string().nullable(),
  answeredAt: z.number().nullable(),
  errorMessage: z.string().nullable(),
  agentSource: AgentSource.nullable(),
});
export type QuestionRecord = z.infer<typeof QuestionRecord>;

export const FeedbackRecord = z.object({
  id: z.string(),
  abspath: z.string(),
  anchor: Anchor.nullable(),
  docVersion: z.string(),
  text: z.string(),
  createdAt: z.number(),
  kind: FeedbackKind,
  status: FeedbackStatus,
});
export type FeedbackRecord = z.infer<typeof FeedbackRecord>;
