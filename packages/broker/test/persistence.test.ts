import { describe, it, expect, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { Store } from "../src/store";
import { Broker, type SSEClient } from "../src/broker";
import type { ServerEvent } from "@plan-review/shared";

const dbPath = join(tmpdir(), `pr-persist-${randomUUID()}.sqlite`);
afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
});

async function tmpPlan(): Promise<string> {
  const p = join(tmpdir(), `pr-persist-${randomUUID()}.md`);
  await Bun.write(p, "# Persisted Plan\n");
  return p;
}

describe("persistence across broker restarts", () => {
  it("rehydrates Q&A + feedback from the store keyed by abspath", async () => {
    const planPath = await tmpPlan();

    // Session 1: record a question+answer and a feedback comment, then "crash".
    {
      const store = new Store(dbPath);
      const broker = new Broker({ store, holdMs: 50 });
      const { sid } = await broker.openSession(planPath);
      broker.attach(sid, "agent");
      const qid = broker.createQuestion(sid, { lineRange: { startLine: 1, endLine: 1 } }, "what is this?");
      broker.answer(sid, qid, { markdown: "a persisted plan" });
      broker.createFeedback(sid, null, "expand the intro");
      store.close();
    }

    // Session 2: a fresh broker over the same DB file rehydrates on subscribe.
    {
      const store = new Store(dbPath);
      const broker = new Broker({ store, holdMs: 50 });
      const { sid } = await broker.openSession(planPath);
      const events: ServerEvent[] = [];
      const client: SSEClient = { send: (e) => events.push(e) };
      broker.subscribe(sid, client);

      const ann = events.find((e) => e.type === "annotations");
      expect(ann).toBeDefined();
      if (ann?.type !== "annotations") throw new Error("no annotations");
      expect(ann.questions.length).toBe(1);
      expect(ann.questions[0]?.answerMarkdown).toBe("a persisted plan");
      expect(ann.questions[0]?.status).toBe("answered");
      expect(ann.feedback.length).toBe(1);
      expect(ann.feedback[0]?.text).toBe("expand the intro");
      store.close();
    }
  });
});
