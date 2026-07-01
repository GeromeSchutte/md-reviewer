import {
  AttachResponse,
  CreateSessionResponse,
  DEFAULT_PORT,
  HealthResponse,
  WaitResponse,
  brokerBaseUrl,
  routes,
  type AgentSource,
} from "@plan-review/shared";

export function baseUrl(): string {
  const port = process.env.PLAN_REVIEW_PORT ? Number(process.env.PLAN_REVIEW_PORT) : DEFAULT_PORT;
  return brokerBaseUrl(port);
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(baseUrl() + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Returns the health payload, or null if the daemon is not reachable. */
export async function health(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(baseUrl() + routes.health, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return HealthResponse.parse(await res.json());
  } catch {
    return null;
  }
}

export async function createSession(planPath: string, expectAgent = false): Promise<CreateSessionResponse> {
  return CreateSessionResponse.parse(await postJson(routes.sessions, { planPath, expectAgent }));
}

export async function attach(sid: string, planPath: string, source: AgentSource): Promise<AttachResponse> {
  return AttachResponse.parse(await postJson(routes.attach(sid), { planPath, source }));
}

export async function waitForEvents(sid: string): Promise<WaitResponse> {
  // Long-poll: no client-side timeout (the broker holds ~4 min then returns []).
  const res = await fetch(baseUrl() + routes.wait(sid));
  if (!res.ok) throw new Error(`wait -> ${res.status}: ${await res.text()}`);
  return WaitResponse.parse(await res.json());
}

/**
 * Loop `wait` until a *non-empty* batch arrives, then return it. The re-poll loop
 * lives here — a plain process, no LLM, no tokens. Because the broker's `wake()`
 * resolves a parked `wait` the instant real work arrives, this returns within
 * milliseconds of a question/finalize; the ~4-min hold cycle only spins during
 * genuine idle. Backgrounding this command (so the agent's turn ends and the
 * harness re-invokes it on exit) is what frees the interactive session from the
 * poll loop — see SKILL.md §3.
 */
export async function waitUntilEvents(sid: string): Promise<WaitResponse> {
  for (;;) {
    const res = await waitForEvents(sid);
    if (res.events.length > 0) return res;
  }
}

export async function postAnswer(
  sid: string,
  questionId: string,
  payload: { markdown?: string; error?: string },
): Promise<void> {
  await postJson(routes.answers(sid), { questionId, ...payload });
}

export async function reworkDone(sid: string, ok: boolean, error?: string): Promise<void> {
  await postJson(routes.reworkDone(sid), { ok, error });
}
