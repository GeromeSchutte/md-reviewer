import { describe, it, expect, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store";
import { Broker } from "../src/broker";
import { createServer } from "../src/server";

const broker = new Broker({ store: new Store(":memory:"), holdMs: 50, disconnectGraceMs: 10_000 });
const server = Bun.serve({ port: 0, fetch: createServer(broker).fetch });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

async function tmpPlan(): Promise<string> {
  const p = join(tmpdir(), `pr-http-${randomUUID()}.md`);
  await Bun.write(p, "# HTTP Plan\n\nsecond line\n");
  return p;
}
const post = (path: string, body?: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

describe("HTTP protocol round-trip (no agent)", () => {
  it("serves /health", async () => {
    const res = await fetch(base + "/health");
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("runs the full create -> attach -> question -> wait -> answer flow", async () => {
    const planPath = await tmpPlan();
    const { sid } = await (await post("/sessions", { planPath })).json();
    expect(sid).toBeTruthy();

    const attach = await (await post(`/sessions/${sid}/attach`, { planPath, source: "agent" })).json();
    expect(attach.ok).toBe(true);

    const { id: qid } = await (await post(`/sessions/${sid}/questions`, { text: "general question" })).json();
    expect(qid).toBeTruthy();

    const wait = await (await fetch(`${base}/sessions/${sid}/wait`)).json();
    expect(wait.events.length).toBe(1);
    expect(wait.events[0].type).toBe("question");
    expect(wait.events[0].id).toBe(qid);

    const answer = await (await post(`/sessions/${sid}/answers`, { questionId: qid, markdown: "an answer" })).json();
    expect(answer.ok).toBe(true);
    expect(broker.store.getQuestion(qid)?.status).toBe("answered");

    // nothing left queued -> hold times out with an empty batch
    const idle = await (await fetch(`${base}/sessions/${sid}/wait`)).json();
    expect(idle.events).toEqual([]);
  });

  it("streams the initial doc snapshot over SSE", async () => {
    const planPath = await tmpPlan();
    const { sid } = await (await post("/sessions", { planPath })).json();
    const res = await fetch(`${base}/sessions/${sid}/stream`);
    const reader = res.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain("event: doc");
    expect(chunk).toContain("HTTP Plan");
    await reader.cancel();
  });

  it("returns 404 for an unknown session", async () => {
    const res = await post(`/sessions/does-not-exist/attach`, { planPath: "/x", source: "agent" });
    expect(res.status).toBe(404);
  });
});
