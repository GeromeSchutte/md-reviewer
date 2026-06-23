import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store";
import { Broker, type SSEClient } from "../src/broker";
import type { ReviewEvent, ServerEvent } from "@plan-review/shared";

async function tmpPlan(content = "# Plan\n\nline two\n"): Promise<string> {
  const p = join(tmpdir(), `pr-${randomUUID()}.md`);
  await Bun.write(p, content);
  return p;
}

function makeBroker(holdMs = 50): Broker {
  return new Broker({ store: new Store(":memory:"), holdMs, disconnectGraceMs: 10_000 });
}

function capture(): { client: SSEClient; events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  return { client: { send: (e) => events.push(e) }, events };
}

const types = (events: ServerEvent[]) => events.map((e) => e.type);

describe("session lifecycle + SSE snapshot", () => {
  it("emits doc, annotations, and state on subscribe", async () => {
    const broker = makeBroker();
    const { sid } = await broker.openSession(await tmpPlan("# Hello\n"));
    const { client, events } = capture();
    broker.subscribe(sid, client);
    expect(types(events)).toEqual(["doc", "annotations", "state"]);
    const doc = events[0];
    if (doc.type !== "doc") throw new Error("expected doc");
    expect(doc.markdown).toContain("# Hello");
  });
});

describe("question queue + batch-drain", () => {
  it("delivers a queued question immediately and marks it in-progress", async () => {
    const broker = makeBroker();
    const { sid } = await broker.openSession(await tmpPlan());
    broker.attach(sid, "agent");
    const qid = broker.createQuestion(sid, { lineRange: { startLine: 1, endLine: 1 } }, "why?");

    const batch = await broker.wait(sid);
    expect(batch.length).toBe(1);
    const ev = batch[0] as ReviewEvent;
    expect(ev.type).toBe("question");
    if (ev.type !== "question") return;
    expect(ev.id).toBe(qid);
    expect(broker.store.getQuestion(qid)?.status).toBe("in-progress");
  });

  it("batch-drains a burst arriving while the agent is busy, carrying pendingFeedback", async () => {
    const broker = makeBroker();
    const { sid } = await broker.openSession(await tmpPlan());
    broker.attach(sid, "agent");

    const q1 = broker.createQuestion(sid, null, "q1");
    const first = await broker.wait(sid); // drains q1
    expect(first.length).toBe(1);

    // Agent is "busy" (not polling). User fires more work concurrently.
    const q2 = broker.createQuestion(sid, null, "q2");
    const q3 = broker.createQuestion(sid, null, "q3");
    broker.createFeedback(sid, null, "use json not sqlite");
    broker.createFeedback(sid, null, "rename the broker");

    broker.answer(sid, q1, { markdown: "answer 1" });

    const second = await broker.wait(sid); // batch-drains q2 + q3
    expect(second.map((e) => (e.type === "question" ? e.id : e.type))).toEqual([q2, q3]);
    for (const ev of second) {
      if (ev.type !== "question") throw new Error("expected question");
      expect(ev.pendingFeedback.map((f) => f.text)).toEqual(["use json not sqlite", "rename the broker"]);
    }
  });

  it("wakes a parked waiter when a question arrives", async () => {
    const broker = makeBroker(5_000); // long hold so the timer won't fire
    const { sid } = await broker.openSession(await tmpPlan());
    broker.attach(sid, "agent");
    const waiting = broker.wait(sid);
    const qid = broker.createQuestion(sid, null, "async question");
    const batch = await waiting;
    expect(batch.length).toBe(1);
    expect(batch[0]?.type === "question" && batch[0].id).toBe(qid);
  });

  it("returns an empty batch (noop) on hold timeout", async () => {
    const broker = makeBroker(30);
    const { sid } = await broker.openSession(await tmpPlan());
    broker.attach(sid, "agent");
    const batch = await broker.wait(sid);
    expect(batch).toEqual([]);
  });
});

describe("answers: status, error, idempotency", () => {
  it("records an answer and emits answer + qa-status", async () => {
    const broker = makeBroker();
    const { sid } = await broker.openSession(await tmpPlan());
    broker.attach(sid, "agent");
    const { client, events } = capture();
    broker.subscribe(sid, client);
    const qid = broker.createQuestion(sid, null, "q");
    await broker.wait(sid);
    broker.answer(sid, qid, { markdown: "the answer" });
    expect(types(events)).toContain("answer");
    const ans = events.find((e) => e.type === "answer");
    expect(ans && ans.type === "answer" && ans.markdown).toBe("the answer");
    expect(broker.store.getQuestion(qid)?.status).toBe("answered");
  });

  it("is idempotent: a second answer for an answered question is ignored", async () => {
    const broker = makeBroker();
    const { sid } = await broker.openSession(await tmpPlan());
    broker.attach(sid, "agent");
    const qid = broker.createQuestion(sid, null, "q");
    broker.answer(sid, qid, { markdown: "first" });
    broker.answer(sid, qid, { markdown: "second" }); // ignored
    expect(broker.store.getQuestion(qid)?.answerMarkdown).toBe("first");
  });

  it("records errors and allows retry to re-queue", async () => {
    const broker = makeBroker();
    const { sid } = await broker.openSession(await tmpPlan());
    broker.attach(sid, "agent");
    const qid = broker.createQuestion(sid, null, "q");
    await broker.wait(sid);
    broker.answer(sid, qid, { error: "could not answer" });
    expect(broker.store.getQuestion(qid)?.status).toBe("error");
    broker.retryQuestion(sid, qid);
    expect(broker.store.getQuestion(qid)?.status).toBe("queued");
  });
});

describe("crash recovery: requeue orphaned in-progress on attach", () => {
  it("re-queues in-progress questions when an agent re-attaches", async () => {
    const broker = makeBroker();
    const { sid } = await broker.openSession(await tmpPlan());
    broker.attach(sid, "agent");
    const qid = broker.createQuestion(sid, null, "q");
    await broker.wait(sid); // q -> in-progress (delivered to an agent that then "dies")
    expect(broker.store.getQuestion(qid)?.status).toBe("in-progress");
    broker.attach(sid, "spawned"); // a replacement agent attaches
    expect(broker.store.getQuestion(qid)?.status).toBe("queued");
  });
});

describe("feedback: trigger-decoupled", () => {
  it("does not produce an agent event but is acked to the viewer", async () => {
    const broker = makeBroker(30);
    const { sid } = await broker.openSession(await tmpPlan());
    broker.attach(sid, "agent");
    const { client, events } = capture();
    broker.subscribe(sid, client);
    broker.createFeedback(sid, { lineRange: { startLine: 2, endLine: 2 } }, "comment");
    expect(types(events)).toContain("feedback-ack");
    const batch = await broker.wait(sid); // feedback alone must NOT wake the agent
    expect(batch).toEqual([]);
  });
});

describe("finalize -> rework cycle", () => {
  it("bundles queued feedback + review note and transitions state", async () => {
    const broker = makeBroker(5_000);
    const { sid } = await broker.openSession(await tmpPlan());
    broker.attach(sid, "agent");
    broker.createFeedback(sid, null, "fix the schema");
    broker.createFeedback(sid, { lineRange: { startLine: 1, endLine: 1 } }, "tighten the title");

    const waiting = broker.wait(sid);
    broker.finalize(sid, "overall: close but needs work");
    const batch = await waiting;
    expect(batch.length).toBe(1);
    const ev = batch[0]!;
    expect(ev.type).toBe("finalize");
    if (ev.type !== "finalize") return;
    expect(ev.reviewNote).toBe("overall: close but needs work");
    expect(ev.batch.map((f) => f.text)).toEqual(["fix the schema", "tighten the title"]);
    broker.reworkDone(sid, true);
  });

  it("marks feedback submitted -> reworked on rework-done", async () => {
    const broker = makeBroker();
    const { sid } = await broker.openSession(await tmpPlan());
    broker.attach(sid, "agent");
    const fid = broker.createFeedback(sid, null, "do the thing");
    broker.finalize(sid, null);
    expect(broker.store.getFeedback(fid)?.status).toBe("submitted");
    broker.reworkDone(sid, true);
    expect(broker.store.getFeedback(fid)?.status).toBe("reworked");
  });
});

describe("doc updates: content-hash gate", () => {
  it("emits doc only when content actually changes", async () => {
    const broker = makeBroker();
    const path = await tmpPlan("# A\n");
    const { sid } = await broker.openSession(path);
    const { client, events } = capture();
    broker.subscribe(sid, client);
    events.length = 0; // drop the initial snapshot
    broker.updateDoc(path, "# A\n"); // same content -> gated
    expect(types(events)).toEqual([]);
    broker.updateDoc(path, "# B changed\n");
    expect(types(events)).toEqual(["doc"]);
  });
});
