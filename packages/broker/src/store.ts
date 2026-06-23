import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Anchor,
  AgentSource,
  FeedbackKind,
  FeedbackRecord,
  FeedbackStatus,
  PlanRecord,
  QuestionRecord,
  QuestionStatus,
} from "@plan-review/shared";
import { storePath } from "./paths";

/**
 * Durable store backed by bun:sqlite, keyed by the plan's absolute path.
 * The questions table doubles as the agent work-queue (ordered by created_at,
 * `status` is the cursor). Anchors are JSON-encoded; NULL = unanchored.
 */
export class Store {
  private db: Database;

  constructor(path: string = storePath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        abspath     TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        review_note TEXT
      );
      CREATE TABLE IF NOT EXISTS questions (
        id             TEXT PRIMARY KEY,
        abspath        TEXT NOT NULL REFERENCES plans(abspath) ON DELETE CASCADE,
        anchor_json    TEXT,
        doc_version    TEXT NOT NULL,
        text           TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        status         TEXT NOT NULL,
        answer_markdown TEXT,
        answered_at    INTEGER,
        error_message  TEXT,
        agent_source   TEXT
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id          TEXT PRIMARY KEY,
        abspath     TEXT NOT NULL REFERENCES plans(abspath) ON DELETE CASCADE,
        anchor_json TEXT,
        doc_version TEXT NOT NULL,
        text        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        status      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_questions_abspath ON questions(abspath, created_at);
      CREATE INDEX IF NOT EXISTS idx_feedback_abspath ON feedback(abspath, created_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---- plans -------------------------------------------------------------

  upsertPlan(abspath: string, title: string, now: number): void {
    this.db
      .query(
        `INSERT INTO plans (abspath, title, created_at, updated_at, review_note)
         VALUES ($abspath, $title, $now, $now, NULL)
         ON CONFLICT(abspath) DO UPDATE SET updated_at = $now`,
      )
      .run({ $abspath: abspath, $title: title, $now: now });
  }

  getPlan(abspath: string): PlanRecord | null {
    const row = this.db.query(`SELECT * FROM plans WHERE abspath = $abspath`).get({ $abspath: abspath }) as
      | PlanRow
      | null;
    return row ? rowToPlan(row) : null;
  }

  setReviewNote(abspath: string, note: string | null, now: number): void {
    this.db
      .query(`UPDATE plans SET review_note = $note, updated_at = $now WHERE abspath = $abspath`)
      .run({ $note: note, $now: now, $abspath: abspath });
  }

  // ---- questions ---------------------------------------------------------

  insertQuestion(q: QuestionRecord): void {
    this.db
      .query(
        `INSERT INTO questions
           (id, abspath, anchor_json, doc_version, text, created_at, status, answer_markdown, answered_at, error_message, agent_source)
         VALUES ($id, $abspath, $anchor, $docVersion, $text, $createdAt, $status, $answer, $answeredAt, $error, $agentSource)`,
      )
      .run({
        $id: q.id,
        $abspath: q.abspath,
        $anchor: encodeAnchor(q.anchor),
        $docVersion: q.docVersion,
        $text: q.text,
        $createdAt: q.createdAt,
        $status: q.status,
        $answer: q.answerMarkdown,
        $answeredAt: q.answeredAt,
        $error: q.errorMessage,
        $agentSource: q.agentSource,
      });
  }

  getQuestion(id: string): QuestionRecord | null {
    const row = this.db.query(`SELECT * FROM questions WHERE id = $id`).get({ $id: id }) as QuestionRow | null;
    return row ? rowToQuestion(row) : null;
  }

  listQuestions(abspath: string): QuestionRecord[] {
    return (
      this.db.query(`SELECT * FROM questions WHERE abspath = $abspath ORDER BY created_at ASC`).all({
        $abspath: abspath,
      }) as QuestionRow[]
    ).map(rowToQuestion);
  }

  listQuestionsByStatus(abspath: string, status: QuestionStatus): QuestionRecord[] {
    return (
      this.db
        .query(`SELECT * FROM questions WHERE abspath = $abspath AND status = $status ORDER BY created_at ASC`)
        .all({ $abspath: abspath, $status: status }) as QuestionRow[]
    ).map(rowToQuestion);
  }

  setQuestionStatus(id: string, status: QuestionStatus): void {
    this.db.query(`UPDATE questions SET status = $status WHERE id = $id`).run({ $status: status, $id: id });
  }

  /** Set all in-progress questions for a plan back to queued (orphan recovery on reattach). */
  requeueInProgress(abspath: string): string[] {
    const rows = this.db
      .query(`SELECT id FROM questions WHERE abspath = $abspath AND status = 'in-progress'`)
      .all({ $abspath: abspath }) as { id: string }[];
    this.db
      .query(`UPDATE questions SET status = 'queued' WHERE abspath = $abspath AND status = 'in-progress'`)
      .run({ $abspath: abspath });
    return rows.map((r) => r.id);
  }

  recordAnswer(id: string, markdown: string, answeredAt: number, source: AgentSource | null): void {
    this.db
      .query(
        `UPDATE questions SET status = 'answered', answer_markdown = $md, answered_at = $at, error_message = NULL, agent_source = $src WHERE id = $id`,
      )
      .run({ $md: markdown, $at: answeredAt, $src: source, $id: id });
  }

  recordError(id: string, message: string, source: AgentSource | null): void {
    this.db
      .query(`UPDATE questions SET status = 'error', error_message = $msg, agent_source = $src WHERE id = $id`)
      .run({ $msg: message, $src: source, $id: id });
  }

  // ---- feedback ----------------------------------------------------------

  insertFeedback(f: FeedbackRecord): void {
    this.db
      .query(
        `INSERT INTO feedback (id, abspath, anchor_json, doc_version, text, created_at, kind, status)
         VALUES ($id, $abspath, $anchor, $docVersion, $text, $createdAt, $kind, $status)`,
      )
      .run({
        $id: f.id,
        $abspath: f.abspath,
        $anchor: encodeAnchor(f.anchor),
        $docVersion: f.docVersion,
        $text: f.text,
        $createdAt: f.createdAt,
        $kind: f.kind,
        $status: f.status,
      });
  }

  getFeedback(id: string): FeedbackRecord | null {
    const row = this.db.query(`SELECT * FROM feedback WHERE id = $id`).get({ $id: id }) as FeedbackRow | null;
    return row ? rowToFeedback(row) : null;
  }

  listFeedback(abspath: string): FeedbackRecord[] {
    return (
      this.db.query(`SELECT * FROM feedback WHERE abspath = $abspath ORDER BY created_at ASC`).all({
        $abspath: abspath,
      }) as FeedbackRow[]
    ).map(rowToFeedback);
  }

  listFeedbackByStatus(abspath: string, status: FeedbackStatus): FeedbackRecord[] {
    return (
      this.db
        .query(`SELECT * FROM feedback WHERE abspath = $abspath AND status = $status ORDER BY created_at ASC`)
        .all({ $abspath: abspath, $status: status }) as FeedbackRow[]
    ).map(rowToFeedback);
  }

  deleteFeedback(id: string): void {
    this.db.query(`DELETE FROM feedback WHERE id = $id`).run({ $id: id });
  }

  setFeedbackStatus(abspath: string, from: FeedbackStatus, to: FeedbackStatus): void {
    this.db
      .query(`UPDATE feedback SET status = $to WHERE abspath = $abspath AND status = $from`)
      .run({ $to: to, $abspath: abspath, $from: from });
  }
}

// ---- row types + mappers -------------------------------------------------

interface PlanRow {
  abspath: string;
  title: string;
  created_at: number;
  updated_at: number;
  review_note: string | null;
}
interface QuestionRow {
  id: string;
  abspath: string;
  anchor_json: string | null;
  doc_version: string;
  text: string;
  created_at: number;
  status: string;
  answer_markdown: string | null;
  answered_at: number | null;
  error_message: string | null;
  agent_source: string | null;
}
interface FeedbackRow {
  id: string;
  abspath: string;
  anchor_json: string | null;
  doc_version: string;
  text: string;
  created_at: number;
  kind: string;
  status: string;
}

function encodeAnchor(anchor: Anchor | null): string | null {
  return anchor ? JSON.stringify(anchor) : null;
}
function decodeAnchor(json: string | null): Anchor | null {
  return json ? (JSON.parse(json) as Anchor) : null;
}

function rowToPlan(r: PlanRow): PlanRecord {
  return {
    abspath: r.abspath,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    reviewNote: r.review_note,
  };
}
function rowToQuestion(r: QuestionRow): QuestionRecord {
  return {
    id: r.id,
    abspath: r.abspath,
    anchor: decodeAnchor(r.anchor_json),
    docVersion: r.doc_version,
    text: r.text,
    createdAt: r.created_at,
    status: r.status as QuestionStatus,
    answerMarkdown: r.answer_markdown,
    answeredAt: r.answered_at,
    errorMessage: r.error_message,
    agentSource: r.agent_source as AgentSource | null,
  };
}
function rowToFeedback(r: FeedbackRow): FeedbackRecord {
  return {
    id: r.id,
    abspath: r.abspath,
    anchor: decodeAnchor(r.anchor_json),
    docVersion: r.doc_version,
    text: r.text,
    createdAt: r.created_at,
    kind: r.kind as FeedbackKind,
    status: r.status as FeedbackStatus,
  };
}
