import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { Store } from "../src/store";
import { Broker } from "../src/broker";
import type { ReviewEvent } from "@plan-review/shared";

async function tmpPlan(content = "# Plan\n\nline two\nline three\n"): Promise<string> {
  const p = join(tmpdir(), `pr-thread-${randomUUID()}.md`);
  await Bun.write(p, content);
  return p;
}
function makeBroker(): Broker {
  return new Broker({ store: new Store(":memory:"), holdMs: 50, disconnectGraceMs: 10_000 });
}
function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

describe("Q&A threads (follow-ups)", () => {
  it("a follow-up inherits its parent's thread + anchor, and its event carries the transcript", async () => {
    const broker = makeBroker();
    const { sid } = await broker.openSession(await tmpPlan());
    broker.attach(sid, "agent");

    const anchor = { lineRange: { startLine: 2, endLine: 3 } };
    const q1 = broker.createQuestion(sid, anchor, "why two and three?");

    // Root question: delivered with an empty thread.
    const first = (await broker.wait(sid))[0] as ReviewEvent;
    if (first.type !== "question") throw new Error("expected question");
    expect(first.id).toBe(q1);
    expect(first.thread).toEqual([]);
    broker.answer(sid, q1, { markdown: "Because the example spans them." });

    // Follow-up: parentId set, no anchor supplied.
    const q2 = broker.createQuestion(sid, null, "could we trim it to one line?", q1);
    const rec2 = broker.store.getQuestion(q2)!;
    expect(rec2.parentId).toBe(q1);
    expect(rec2.threadId).toBe(q1); // root's threadId is its own id
    expect(rec2.anchor).toEqual(anchor); // inherited from the parent

    const second = (await broker.wait(sid))[0] as ReviewEvent;
    if (second.type !== "question") throw new Error("expected question");
    expect(second.id).toBe(q2);
    expect(second.thread).toEqual([{ text: "why two and three?", answerMarkdown: "Because the example spans them." }]);
  });
});

describe("review item from a Q&A (sourceQuestion)", () => {
  it("inherits the source anchor and resolves the source Q&A into the finalize batch", async () => {
    const broker = makeBroker();
    const { sid } = await broker.openSession(await tmpPlan());
    broker.attach(sid, "agent");

    const q1 = broker.createQuestion(sid, { lineRange: { startLine: 1, endLine: 1 } }, "what is X?");
    await broker.wait(sid); // drain
    broker.answer(sid, q1, { markdown: "X is Y." });

    const fid = broker.createFeedback(sid, null, "capture X→Y as a task", q1);
    const frec = broker.store.getFeedback(fid)!;
    expect(frec.sourceQuestionId).toBe(q1);
    expect(frec.anchor).toEqual({ lineRange: { startLine: 1, endLine: 1 } }); // inherited from the source question

    broker.finalize(sid, null);
    const fin = (await broker.wait(sid)).find((e) => e.type === "finalize");
    if (fin?.type !== "finalize") throw new Error("expected finalize");
    const item = fin.batch.find((b) => b.id === fid);
    expect(item?.sourceQuestion).toEqual({ id: q1, text: "what is X?", answerMarkdown: "X is Y." });
  });
});

describe("store migration from the pre-threading schema", () => {
  it("adds the new columns and backfills thread_id without touching existing data", () => {
    const path = join(tmpdir(), `pr-migrate-${randomUUID()}.sqlite`);

    // Build the OLD schema (no thread_id / parent_id / source_question_id) and seed a row.
    {
      const db = new Database(path, { create: true });
      db.exec(`CREATE TABLE plans (abspath TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, review_note TEXT);`);
      db.exec(`CREATE TABLE questions (id TEXT PRIMARY KEY, abspath TEXT NOT NULL REFERENCES plans(abspath) ON DELETE CASCADE, anchor_json TEXT, doc_version TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, answer_markdown TEXT, answered_at INTEGER, error_message TEXT, agent_source TEXT);`);
      db.exec(`CREATE TABLE feedback (id TEXT PRIMARY KEY, abspath TEXT NOT NULL REFERENCES plans(abspath) ON DELETE CASCADE, anchor_json TEXT, doc_version TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL);`);
      db.exec(`INSERT INTO plans VALUES ('/old/plan.md', 'old', 1, 1, NULL);`);
      db.exec(`INSERT INTO questions VALUES ('old-q1', '/old/plan.md', NULL, 'v', 'old question', 100, 'answered', 'old answer', 101, NULL, 'agent');`);
      db.exec(`INSERT INTO feedback VALUES ('old-f1', '/old/plan.md', NULL, 'v', 'old feedback', 100, 'comment', 'queued');`);
      db.close();
    }

    // Opening via Store runs the additive migration on the existing file.
    const store = new Store(path);
    const q = store.getQuestion("old-q1")!;
    expect(q.threadId).toBe("old-q1"); // backfilled to its own id
    expect(q.parentId).toBeNull();
    expect(q.answerMarkdown).toBe("old answer"); // data intact
    expect(store.getFeedback("old-f1")!.sourceQuestionId).toBeNull();
    store.close();

    // The columns now exist on the upgraded tables.
    const db = new Database(path);
    const cols = (table: string) =>
      (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const qcols = cols("questions");
    const fcols = cols("feedback");
    db.close();
    expect(qcols).toContain("thread_id");
    expect(qcols).toContain("parent_id");
    expect(fcols).toContain("source_question_id");

    cleanup(path);
  });
});
