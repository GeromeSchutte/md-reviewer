import {
  DEFAULT_PORT,
  brokerBaseUrl,
  routes,
  type Anchor,
  type ServerEvent,
} from "@plan-review/shared";

const base = brokerBaseUrl(DEFAULT_PORT);

async function post(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

export async function createSession(planPath: string): Promise<{ sid: string }> {
  return (await post(routes.sessions, { planPath })) as { sid: string };
}

export async function askQuestion(sid: string, anchor: Anchor | null, text: string): Promise<string> {
  return ((await post(routes.questions(sid), { anchor, text })) as { id: string }).id;
}
export async function leaveFeedback(sid: string, anchor: Anchor | null, text: string): Promise<string> {
  return ((await post(routes.feedback(sid), { anchor, text })) as { id: string }).id;
}
export async function retryQuestion(sid: string, id: string): Promise<void> {
  await post(routes.questionRetry(sid, id));
}
export async function removeFeedback(sid: string, id: string): Promise<void> {
  await fetch(base + routes.feedbackItem(sid, id), { method: "DELETE" });
}
export async function submitReview(sid: string, reviewNote: string | null): Promise<void> {
  await post(routes.finalize(sid), { reviewNote });
}
export async function endSession(sid: string): Promise<void> {
  await post(routes.end(sid));
}

/** Subscribe to the broker's SSE stream. Returns a disposer. */
export function subscribe(sid: string, onEvent: (e: ServerEvent) => void, onError?: () => void): () => void {
  const es = new EventSource(base + routes.stream(sid));
  const types: ServerEvent["type"][] = [
    "doc",
    "annotations",
    "answer",
    "qa-status",
    "state",
    "feedback-ack",
    "feedback-removed",
    "agent-disconnected",
  ];
  const handler = (ev: MessageEvent) => {
    try {
      onEvent(JSON.parse(ev.data) as ServerEvent);
    } catch {
      /* ignore malformed frames */
    }
  };
  for (const t of types) es.addEventListener(t, handler as EventListener);
  es.onerror = () => onError?.();
  return () => es.close();
}
