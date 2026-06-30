import type {
  Anchor,
  FeedbackRecord,
  QuestionRecord,
  ServerEvent,
} from "@plan-review/shared";

/**
 * Dev-only mock fixture. When the viewer is opened in a browser with `?mock`
 * (and only in a Vite dev build), the broker layer short-circuits to this
 * module instead of hitting the network — so the whole UI can be iterated on
 * with HMR and no broker, no agent, no Tauri rebuild.
 *
 * Integrated at the broker.ts / launch.ts boundary; App.tsx is unaware of it.
 */
export function isMock(): boolean {
  return import.meta.env.DEV && new URLSearchParams(location.search).has("mock");
}

const SAMPLE_MARKDOWN = `# Plan: Ship the widget pipeline

A worked example so the viewer's markdown rendering and selection can be
exercised end-to-end without a live agent.

## Goals

- Stream widgets from the broker to the viewer
- Anchor **feedback** to specific lines
- Keep the agent's context warm between questions

## Approach

The pipeline has three stages. Each stage is independently retryable, and the
\`status\` column doubles as a crash-safe cursor.

1. **Ingest** — read the raw widgets off the queue
2. **Transform** — normalize and validate against the schema
3. **Emit** — push to subscribers over SSE

\`\`\`ts
function transform(widget: RawWidget): Widget {
  return { ...widget, normalized: true };
}
\`\`\`

> Note: the transform stage must stay pure — no I/O, so it can be replayed
> deterministically during a rework.

## Open questions

| Stage     | Owner   | Risk   |
| --------- | ------- | ------ |
| Ingest    | broker  | low    |
| Transform | shared  | medium |
| Emit      | viewer  | low    |

See the [protocol notes](https://example.com) for the wire format.`;

function anchor(startLine: number, endLine = startLine): Anchor {
  return { lineRange: { startLine, endLine }, quote: null };
}

const now = Date.now();

const seedQuestions: QuestionRecord[] = [
  {
    id: "mock-q-answered",
    abspath: "/mock/plan.md",
    anchor: anchor(13, 15),
    docVersion: "mock",
    text: "Why does the transform stage need to stay pure?",
    createdAt: now - 60_000,
    status: "answered",
    answerMarkdown:
      "So a **rework** can replay it deterministically. If `transform` did I/O, " +
      "re-running the finalize batch could produce different output for the same input.",
    answeredAt: now - 55_000,
    errorMessage: null,
    agentSource: "agent",
    threadId: "mock-q-answered",
    parentId: null,
  },
  {
    // Follow-up on the answered question above — same thread, inherits its anchor.
    id: "mock-q-followup",
    abspath: "/mock/plan.md",
    anchor: anchor(13, 15),
    docVersion: "mock",
    text: "Got it. So could we memoize it to avoid recomputing on every replay?",
    createdAt: now - 50_000,
    status: "answered",
    answerMarkdown:
      "Yes — purity is exactly what makes memoization safe here. Key the cache on the " +
      "raw widget id and you can skip re-running `transform` for unchanged inputs.",
    answeredAt: now - 48_000,
    errorMessage: null,
    agentSource: "agent",
    threadId: "mock-q-answered",
    parentId: "mock-q-answered",
  },
  {
    id: "mock-q-progress",
    abspath: "/mock/plan.md",
    anchor: anchor(7),
    docVersion: "mock",
    text: "How are widgets de-duplicated across the queue?",
    createdAt: now - 20_000,
    status: "in-progress",
    answerMarkdown: null,
    answeredAt: null,
    errorMessage: null,
    agentSource: "agent",
  },
  {
    id: "mock-q-queued",
    abspath: "/mock/plan.md",
    anchor: null,
    docVersion: "mock",
    text: "What's the backpressure strategy if subscribers fall behind?",
    createdAt: now - 5_000,
    status: "queued",
    answerMarkdown: null,
    answeredAt: null,
    errorMessage: null,
    agentSource: "agent",
  },
  {
    id: "mock-q-error",
    abspath: "/mock/plan.md",
    anchor: anchor(28),
    docVersion: "mock",
    text: "Is the SSE stream resumable after a disconnect?",
    createdAt: now - 40_000,
    status: "error",
    answerMarkdown: null,
    answeredAt: null,
    errorMessage: "agent context lost before this question could be answered",
    agentSource: "agent",
  },
];

const seedFeedback: FeedbackRecord[] = [
  {
    id: "mock-f-queued",
    abspath: "/mock/plan.md",
    anchor: anchor(20),
    docVersion: "mock",
    text: "Validation should reject unknown fields, not silently drop them.",
    createdAt: now - 30_000,
    kind: "comment",
    status: "queued",
  },
  {
    id: "mock-f-submitted",
    abspath: "/mock/plan.md",
    anchor: anchor(24, 26),
    docVersion: "mock",
    text: "This table is missing the Emit-stage retry budget.",
    createdAt: now - 90_000,
    kind: "comment",
    status: "submitted",
  },
  {
    // A review item created from a Q&A exchange — carries the source question link
    // and inherits its anchor. Exercises the "re:" citation on the Review tab.
    id: "mock-f-fromqa",
    abspath: "/mock/plan.md",
    anchor: anchor(13, 15),
    docVersion: "mock",
    text: "Per the Q&A, let's add a memoization note to the transform step.",
    createdAt: now - 12_000,
    kind: "comment",
    status: "queued",
    sourceQuestionId: "mock-q-answered",
  },
];

const store = {
  markdown: SAMPLE_MARKDOWN,
  questions: seedQuestions,
  feedback: seedFeedback,
};

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
let seq = 0;

function emit(e: ServerEvent): void {
  for (const fn of listeners) fn(e);
}

function pushAnnotations(): void {
  emit({ type: "annotations", questions: [...store.questions], feedback: [...store.feedback] });
}

/** Replay the initial snapshot to a new subscriber; returns a disposer. */
export function mockSubscribe(onEvent: Listener): () => void {
  listeners.add(onEvent);
  queueMicrotask(() => {
    if (!listeners.has(onEvent)) return;
    onEvent({ type: "doc", markdown: store.markdown, version: "mock" });
    onEvent({ type: "annotations", questions: [...store.questions], feedback: [...store.feedback] });
    onEvent({ type: "state", state: "waiting-for-review" });
  });
  return () => listeners.delete(onEvent);
}

export function mockAsk(anchor: Anchor | null, text: string, parentId?: string | null): string {
  const id = `mock-q-live-${seq++}`;
  // A follow-up inherits its parent's thread + anchor (the broker does this for real);
  // a root question starts a new thread keyed on its own id.
  const parent = parentId ? store.questions.find((q) => q.id === parentId) : undefined;
  const threadId = parent ? parent.threadId ?? parent.id : id;
  store.questions = [
    ...store.questions,
    {
      id,
      abspath: "/mock/plan.md",
      anchor: parent ? parent.anchor : anchor,
      docVersion: "mock",
      text,
      createdAt: Date.now(),
      status: "queued",
      answerMarkdown: null,
      answeredAt: null,
      errorMessage: null,
      agentSource: "agent",
      threadId,
      parentId: parentId ?? null,
    },
  ];
  // Simulate the agent picking it up and answering.
  emit({ type: "state", state: "agent-thinking" });
  setTimeout(() => emit({ type: "qa-status", id, status: "in-progress" }), 500);
  setTimeout(() => {
    emit({
      type: "answer",
      questionId: id,
      markdown: `Mock answer to **"${text}"** — wire a real broker for live responses.`,
    });
    emit({ type: "qa-status", id, status: "answered" });
    emit({ type: "state", state: "waiting-for-review" });
  }, 1600);
  return id;
}

export function mockLeaveFeedback(anchor: Anchor | null, text: string, sourceQuestionId?: string | null): string {
  const id = `mock-f-live-${seq++}`;
  const record: FeedbackRecord = {
    id,
    abspath: "/mock/plan.md",
    anchor,
    docVersion: "mock",
    text,
    createdAt: Date.now(),
    kind: "comment",
    status: "queued",
    sourceQuestionId: sourceQuestionId ?? null,
  };
  store.feedback = [...store.feedback, record];
  emit({ type: "feedback-ack", feedback: record });
  return id;
}

export function mockRetry(id: string): void {
  const q = store.questions.find((x) => x.id === id);
  if (q) q.status = "in-progress";
  emit({ type: "qa-status", id, status: "in-progress" });
  setTimeout(() => {
    emit({ type: "answer", questionId: id, markdown: "Mock retry succeeded ✓" });
    emit({ type: "qa-status", id, status: "answered" });
  }, 1200);
}

export function mockRemoveFeedback(id: string): void {
  store.feedback = store.feedback.filter((f) => f.id !== id);
  emit({ type: "feedback-removed", id });
}

export function mockSubmitReview(): void {
  store.feedback = store.feedback.map((f) => (f.status === "queued" ? { ...f, status: "submitted" } : f));
  emit({ type: "state", state: "reworking" });
  setTimeout(() => {
    pushAnnotations();
    emit({ type: "state", state: "waiting-for-review", reworkResult: "success" });
  }, 1800);
}

export function mockEndSession(): void {
  emit({ type: "state", state: "finalized" });
}
