import { resolve as resolvePath, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentSource,
  Anchor,
  LifecycleState,
  PendingFeedback,
  ReviewEvent,
  ReworkResult,
  ServerEvent,
} from "@plan-review/shared";
import { Store } from "./store";
import { silentLogger, type Logger } from "./logger";

export interface SSEClient {
  send: (event: ServerEvent) => void;
}

interface Waiter {
  resolve: (events: ReviewEvent[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Session {
  sid: string;
  abspath: string;
  title: string;
  state: LifecycleState;
  docMarkdown: string;
  docVersion: string;
  agentSource: AgentSource | null;
  agentLastSeen: number | null;
  /** Control events (finalize/end) queued for the agent. Questions live in the store. */
  pendingControl: ReviewEvent[];
  waiters: Set<Waiter>;
  sseClients: Set<SSEClient>;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

export interface BrokerOptions {
  store?: Store;
  /** Long-poll hold duration; ~4 min in prod to stay under the 5-min prompt-cache TTL. */
  holdMs?: number;
  /** Grace period after the last viewer disconnects before the agent is sent `end`. */
  disconnectGraceMs?: number;
  version?: string;
  /** Spawn a headless agent for a session that has no agent attached (user-opened path). */
  spawnAgent?: (info: { sid: string; abspath: string; title: string }) => void;
  /** Start watching a plan file for live updates when its session first opens. */
  onSessionOpened?: (abspath: string) => void;
  /** Structured logger; defaults to silent so tests/embeddings don't write to disk. */
  log?: Logger;
}

const hash = (s: string): string => Bun.hash(s).toString(16);

export class Broker {
  readonly store: Store;
  private readonly holdMs: number;
  private readonly disconnectGraceMs: number;
  private readonly version: string;
  private readonly spawnAgent?: BrokerOptions["spawnAgent"];
  private readonly onSessionOpened?: BrokerOptions["onSessionOpened"];
  private readonly log: Logger;
  private readonly sessions = new Map<string, Session>();
  private readonly byPath = new Map<string, string>(); // abspath -> sid

  constructor(opts: BrokerOptions = {}) {
    this.store = opts.store ?? new Store();
    this.holdMs = opts.holdMs ?? 240_000;
    this.disconnectGraceMs = opts.disconnectGraceMs ?? 120_000;
    this.version = opts.version ?? "0.0.0";
    this.spawnAgent = opts.spawnAgent;
    this.onSessionOpened = opts.onSessionOpened;
    this.log = opts.log ?? silentLogger;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
  get health() {
    return { ok: true as const, sessions: this.sessions.size, version: this.version };
  }

  // ---- session lifecycle -------------------------------------------------

  /**
   * Open (or reuse) a session for a plan file. Spawns a headless agent unless
   * `expectAgent` is set (the caller is an agent that will attach itself, e.g.
   * the agent-initiated `open --json` flow), which would otherwise double up.
   */
  async openSession(planPath: string, opts: { expectAgent?: boolean } = {}): Promise<{ sid: string; state: LifecycleState }> {
    const abspath = resolvePath(planPath);
    const existingSid = this.byPath.get(abspath);
    if (existingSid) {
      const s = this.sessions.get(existingSid)!;
      return { sid: s.sid, state: s.state };
    }

    const markdown = await this.readFile(abspath);
    const title = basename(abspath);
    const now = Date.now();
    this.store.upsertPlan(abspath, title, now);

    const session: Session = {
      sid: randomUUID(),
      abspath,
      title,
      state: "no-agent",
      docMarkdown: markdown,
      docVersion: hash(markdown),
      agentSource: null,
      agentLastSeen: null,
      pendingControl: [],
      waiters: new Set(),
      sseClients: new Set(),
      disconnectTimer: null,
    };
    this.sessions.set(session.sid, session);
    this.byPath.set(abspath, session.sid);

    this.log.info({ event: "session.open", sid: session.sid, abspath, expectAgent: !!opts.expectAgent }, "session opened");
    this.onSessionOpened?.(abspath);
    // User-initiated path only: bring up a headless agent. When expectAgent is set,
    // the caller will attach as the agent, so spawning one would be a duplicate.
    if (!opts.expectAgent) this.spawnAgent?.({ sid: session.sid, abspath, title });

    return { sid: session.sid, state: session.state };
  }

  /** Agent attaches to a session and enters the wait-loop. */
  attach(sid: string, source: AgentSource): LifecycleState {
    const s = this.require(sid);
    s.agentSource = source;
    s.agentLastSeen = Date.now();
    // Orphan recovery: any question delivered to a now-dead agent goes back to queued.
    const requeued = this.store.requeueInProgress(s.abspath);
    for (const id of requeued) this.broadcast(s, { type: "qa-status", id, status: "queued" });
    if (s.state === "no-agent" || s.state === "agent-disconnected") this.setState(s, "waiting-for-review");
    this.refreshQuestionState(s);
    this.log.info({ event: "agent.attach", sid, source, requeued: requeued.length }, "agent attached");
    return s.state;
  }

  // ---- long-poll wait-loop ----------------------------------------------

  /** Agent long-poll. Resolves with an ordered batch (empty on timeout). */
  wait(sid: string, signal?: AbortSignal): Promise<ReviewEvent[]> {
    const s = this.require(sid);
    s.agentLastSeen = Date.now();
    const immediate = this.collectBatch(s);
    if (immediate.length) return Promise.resolve(immediate);

    return new Promise<ReviewEvent[]>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          s.waiters.delete(waiter);
          resolve([]);
        }, this.holdMs),
      };
      s.waiters.add(waiter);
      signal?.addEventListener("abort", () => {
        clearTimeout(waiter.timer);
        s.waiters.delete(waiter);
        resolve([]);
      });
    });
  }

  /** Pull the next deliverable batch: all queued questions, else one control event. */
  private collectBatch(s: Session): ReviewEvent[] {
    const queued = this.store.listQuestionsByStatus(s.abspath, "queued");
    if (queued.length) {
      const pendingFeedback = this.pendingFeedback(s);
      return queued.map((q): ReviewEvent => {
        this.store.setQuestionStatus(q.id, "in-progress");
        this.broadcast(s, { type: "qa-status", id: q.id, status: "in-progress" });
        return { type: "question", id: q.id, anchor: q.anchor, text: q.text, pendingFeedback };
      });
    }
    if (s.pendingControl.length) return [s.pendingControl.shift()!];
    return [];
  }

  /** If an agent is parked in `wait`, hand it the freshly available batch. */
  private wake(s: Session): void {
    if (s.waiters.size === 0) return;
    const batch = this.collectBatch(s);
    if (!batch.length) return;
    const waiter = s.waiters.values().next().value as Waiter;
    clearTimeout(waiter.timer);
    s.waiters.delete(waiter);
    waiter.resolve(batch);
  }

  private pendingFeedback(s: Session): PendingFeedback[] {
    return this.store
      .listFeedbackByStatus(s.abspath, "queued")
      .map((f) => ({ id: f.id, anchor: f.anchor, text: f.text }));
  }

  // ---- questions ---------------------------------------------------------

  createQuestion(sid: string, anchor: Anchor | null, text: string): string {
    const s = this.require(sid);
    const id = randomUUID();
    this.store.insertQuestion({
      id,
      abspath: s.abspath,
      anchor,
      docVersion: s.docVersion,
      text,
      createdAt: Date.now(),
      status: "queued",
      answerMarkdown: null,
      answeredAt: null,
      errorMessage: null,
      agentSource: null,
    });
    this.broadcast(s, { type: "qa-status", id, status: "queued" });
    this.refreshQuestionState(s);
    this.wake(s);
    this.log.info({ event: "question.created", sid, qid: id, anchored: !!anchor }, "question queued");
    return id;
  }

  retryQuestion(sid: string, id: string): void {
    const s = this.require(sid);
    const q = this.store.getQuestion(id);
    if (!q || q.status !== "error") return;
    this.store.setQuestionStatus(id, "queued");
    this.broadcast(s, { type: "qa-status", id, status: "queued" });
    this.refreshQuestionState(s);
    this.wake(s);
  }

  /** Agent posts an answer (or an error). Idempotent by questionId. */
  answer(sid: string, questionId: string, payload: { markdown?: string; error?: string }): void {
    const s = this.require(sid);
    s.agentLastSeen = Date.now();
    const q = this.store.getQuestion(questionId);
    if (!q || q.status === "answered") return; // idempotent: already done
    if (payload.error !== undefined) {
      this.store.recordError(questionId, payload.error, s.agentSource);
      this.broadcast(s, { type: "qa-status", id: questionId, status: "error", error: payload.error });
      this.log.warn({ event: "question.error", sid, qid: questionId, error: payload.error }, "question errored");
    } else {
      const md = payload.markdown ?? "";
      this.store.recordAnswer(questionId, md, Date.now(), s.agentSource);
      this.broadcast(s, { type: "answer", questionId, markdown: md });
      this.broadcast(s, { type: "qa-status", id: questionId, status: "answered" });
      this.log.info({ event: "question.answered", sid, qid: questionId, chars: md.length }, "question answered");
    }
    this.refreshQuestionState(s);
  }

  // ---- feedback (trigger-decoupled: never wakes the agent) ---------------

  createFeedback(sid: string, anchor: Anchor | null, text: string): string {
    const s = this.require(sid);
    const id = randomUUID();
    const record = {
      id,
      abspath: s.abspath,
      anchor,
      docVersion: s.docVersion,
      text,
      createdAt: Date.now(),
      kind: "comment" as const,
      status: "queued" as const,
    };
    this.store.insertFeedback(record);
    this.broadcast(s, { type: "feedback-ack", feedback: record });
    this.log.info({ event: "feedback.created", sid, fid: id, anchored: !!anchor }, "feedback added");
    return id;
  }

  deleteFeedback(sid: string, id: string): void {
    const s = this.require(sid);
    this.store.deleteFeedback(id);
    this.broadcast(s, { type: "feedback-removed", id });
  }

  // ---- finalize / rework / end ------------------------------------------

  finalize(sid: string, reviewNote: string | null): void {
    const s = this.require(sid);
    const now = Date.now();
    const batch: PendingFeedback[] = this.store
      .listFeedbackByStatus(s.abspath, "queued")
      .map((f) => ({ id: f.id, anchor: f.anchor, text: f.text }));
    if (reviewNote && reviewNote.trim()) {
      this.store.setReviewNote(s.abspath, reviewNote, now);
      this.store.insertFeedback({
        id: randomUUID(),
        abspath: s.abspath,
        anchor: null,
        docVersion: s.docVersion,
        text: reviewNote,
        createdAt: now,
        kind: "summary",
        status: "submitted",
      });
    }
    this.store.setFeedbackStatus(s.abspath, "queued", "submitted");
    s.pendingControl.push({ type: "finalize", batch, reviewNote: reviewNote ?? null });
    this.setState(s, "reworking");
    this.wake(s);
    this.log.info({ event: "review.finalized", sid, items: batch.length, hasNote: !!reviewNote }, "review submitted");
  }

  reworkDone(sid: string, ok: boolean, error?: string): void {
    const s = this.require(sid);
    if (ok) {
      this.store.setFeedbackStatus(s.abspath, "submitted", "reworked");
      this.setState(s, "waiting-for-review", { reworkResult: "success" });
    } else {
      this.setState(s, "waiting-for-review", { reworkResult: "error", message: error });
    }
    this.log.info({ event: "rework.done", sid, ok, error }, "rework finished");
  }

  end(sid: string): void {
    const s = this.require(sid);
    s.pendingControl.push({ type: "end" });
    this.setState(s, "finalized");
    this.wake(s);
    this.log.info({ event: "session.end", sid }, "session ended");
  }

  // ---- doc updates (called by the file watcher) --------------------------

  updateDoc(abspath: string, markdown: string): void {
    const sid = this.byPath.get(resolvePath(abspath));
    if (!sid) return;
    const s = this.sessions.get(sid)!;
    const version = hash(markdown);
    if (version === s.docVersion) return; // content-hash gate: no real change
    s.docMarkdown = markdown;
    s.docVersion = version;
    this.broadcast(s, { type: "doc", markdown, version });
    this.log.info({ event: "doc.updated", sid: s.sid, version }, "plan file changed");
  }

  // ---- SSE subscription --------------------------------------------------

  subscribe(sid: string, client: SSEClient): () => void {
    const s = this.require(sid);
    s.sseClients.add(client);
    if (s.disconnectTimer) {
      clearTimeout(s.disconnectTimer);
      s.disconnectTimer = null;
    }
    // Initial snapshot.
    client.send({ type: "doc", markdown: s.docMarkdown, version: s.docVersion });
    client.send({
      type: "annotations",
      questions: this.store.listQuestions(s.abspath),
      feedback: this.store.listFeedback(s.abspath),
    });
    client.send({ type: "state", state: s.state });

    return () => {
      s.sseClients.delete(client);
      if (s.sseClients.size === 0) this.armDisconnectGuard(s);
    };
  }

  /** Runaway-agent guard: viewer gone past grace with no pending work -> end the agent. */
  private armDisconnectGuard(s: Session): void {
    if (s.disconnectTimer) clearTimeout(s.disconnectTimer);
    s.disconnectTimer = setTimeout(() => {
      if (s.sseClients.size > 0) return;
      if (s.state === "finalized") return;
      const pending =
        this.store.listQuestionsByStatus(s.abspath, "queued").length +
        this.store.listQuestionsByStatus(s.abspath, "in-progress").length;
      if (pending > 0) return; // still has work; let it finish
      this.log.info({ event: "guard.end", sid: s.sid }, "viewer gone past grace; ending agent");
      this.end(s.sid);
    }, this.disconnectGraceMs);
  }

  // ---- helpers -----------------------------------------------------------

  private require(sid: string): Session {
    const s = this.sessions.get(sid);
    if (!s) throw new SessionNotFound(sid);
    return s;
  }

  private setState(s: Session, state: LifecycleState, extra?: { reworkResult?: ReworkResult; message?: string }): void {
    s.state = state;
    this.broadcast(s, { type: "state", state, reworkResult: extra?.reworkResult, message: extra?.message });
  }

  /** Reflect pending question work in the lifecycle state without clobbering terminal states. */
  private refreshQuestionState(s: Session): void {
    if (s.state === "reworking" || s.state === "finalized" || s.state === "no-agent" || s.state === "agent-disconnected")
      return;
    const pending =
      this.store.listQuestionsByStatus(s.abspath, "queued").length +
      this.store.listQuestionsByStatus(s.abspath, "in-progress").length;
    this.setState(s, pending > 0 ? "agent-thinking" : "waiting-for-review");
  }

  private broadcast(s: Session, event: ServerEvent): void {
    for (const client of s.sseClients) {
      try {
        client.send(event);
      } catch {
        // a dead client; it will be cleaned up on its own abort
      }
    }
  }

  private async readFile(abspath: string): Promise<string> {
    const file = Bun.file(abspath);
    if (await file.exists()) return file.text();
    return "";
  }
}

export class SessionNotFound extends Error {
  constructor(sid: string) {
    super(`session not found: ${sid}`);
    this.name = "SessionNotFound";
  }
}
