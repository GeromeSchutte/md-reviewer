import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { query, type SDKUserMessage, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "./store";
import { silentLogger, type Logger } from "./logger";

export interface SpawnInfo {
  sid: string;
  abspath: string;
  title: string;
}

/**
 * The broker's handle on the headless review workers it hosts. Because `query()`
 * runs in-process, the broker keeps each worker's streaming-input handle and
 * **pushes** work to it — no polling, and the worker sits idle (zero tokens)
 * between events. One worker per session; calls for an unknown session no-op.
 */
export interface AgentController {
  /** Start a streaming-input worker for a user-opened session (de-duped per sid). */
  spawn(info: SpawnInfo): void;
  /** Nudge the worker that new review work is available; it fetches it via wait-until. */
  notify(sid: string): void;
  /** Interrupt the worker's current turn (available for preemption; not used by default). */
  interrupt(sid: string): void;
  /** Tear the worker down (session ended): let the in-flight turn finish, then stop. */
  stop(sid: string): void;
}

function repoRoot(): string {
  // packages/broker/src/spawner.ts -> repo root is three levels up.
  return resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
}
function cliEntry(): string {
  return join(repoRoot(), "packages", "cli", "src", "index.ts");
}
function skillBody(): string {
  const path = join(repoRoot(), "skills", "plan-review", "SKILL.md");
  if (!existsSync(path)) return "";
  const raw = readFileSync(path, "utf8");
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim(); // strip YAML frontmatter
}

/** Compact prior review history so a freshly-spawned agent starts warm. */
function historyText(store: Store, abspath: string): string {
  const questions = store.listQuestions(abspath);
  const feedback = store.listFeedback(abspath).filter((f) => f.status === "queued" || f.status === "submitted");
  if (questions.length === 0 && feedback.length === 0) return "No prior review history.";
  const lines: string[] = [];
  if (questions.length) {
    lines.push("Prior questions & answers:");
    for (const q of questions) {
      const ans = q.answerMarkdown ? q.answerMarkdown.replace(/\n+/g, " ") : `(${q.status})`;
      lines.push(`- Q: ${q.text}\n  A: ${ans}`);
    }
  }
  if (feedback.length) {
    lines.push("Open feedback (not yet reworked):");
    for (const f of feedback) lines.push(`- ${f.text}`);
  }
  return lines.join("\n");
}

/** Build the session-specific seed message for a spawned review worker (pure; testable). */
export function buildSeed(deps: { store: Store; baseUrl: string }, info: SpawnInfo): string {
  const cli = `bun ${cliEntry()}`;
  return [
    `You are the review agent for the plan at: ${info.abspath}`,
    `Review session id: ${info.sid}`,
    `Broker base URL: ${deps.baseUrl}`,
    `The review CLI is: \`${cli}\` (e.g. \`${cli} wait-until ${info.sid}\`).`,
    ``,
    `You were spawned by the broker for a file the user opened, so a session already exists.`,
    `Skip "open"; attach with --source spawned.`,
    ``,
    `The broker PUSHES work to you as messages — do NOT run a poll loop. On start, run`,
    `\`${cli} wait-until ${info.sid}\` once to drain anything already pending and handle it`,
    `(answer questions / rework the file + rework-done), then STOP and wait. When the broker`,
    `sends you another message, run \`${cli} wait-until ${info.sid}\` again and handle that batch.`,
    `Stop for good once you receive an "end" event.`,
    ``,
    historyText(deps.store, info.abspath),
  ].join("\n");
}

function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

/**
 * A push-driven input stream for a streaming-input `query()`. Yields the seed first,
 * then any pushed messages; awaits (session idle) when the queue drains. `close()`
 * ends the stream *after* the queue is drained, so a final pushed message (e.g. the
 * one that surfaces an `end` event) is still delivered before the worker shuts down.
 */
interface InputStream {
  iterable: AsyncIterable<SDKUserMessage>;
  push(text: string): void;
  close(): void;
}

function makeInputStream(seed: string): InputStream {
  const queue: SDKUserMessage[] = [userMessage(seed)];
  let closed = false;
  let wake: (() => void) | null = null;
  const nudge = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const iterable: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  return {
    iterable,
    push(text) {
      queue.push(userMessage(text));
      nudge();
    },
    close() {
      closed = true;
      nudge();
    },
  };
}

export function makeSpawner(deps: { store: Store; baseUrl: string; log?: Logger }): AgentController {
  const skill = skillBody();
  const log = deps.log ?? silentLogger;
  const workers = new Map<string, { input: InputStream; q: Query }>();

  return {
    spawn(info: SpawnInfo): void {
      if (workers.has(info.sid)) return; // one worker per session
      const seed = buildSeed(deps, info);
      const input = makeInputStream(seed);
      log.info({ event: "spawn.start", sid: info.sid, abspath: info.abspath }, "spawning headless agent");

      const q = query({
        prompt: input.iterable,
        options: {
          cwd: dirname(info.abspath),
          additionalDirectories: [repoRoot()],
          allowedTools: ["Bash", "Read", "Edit", "Write"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          // No maxTurns: the worker handles many pushed turns over the review's life.
          systemPrompt: { type: "preset", preset: "claude_code", append: skill },
        },
      });
      workers.set(info.sid, { input, q });

      void (async () => {
        try {
          for await (const message of q) {
            if (message.type === "result") {
              log.info({ event: "spawn.turn_end", sid: info.sid, subtype: message.subtype }, "worker turn ended");
            }
          }
        } catch (err) {
          log.error(
            { event: "spawn.error", sid: info.sid, err: err instanceof Error ? err.message : String(err) },
            "agent error",
          );
        } finally {
          workers.delete(info.sid);
          log.info({ event: "spawn.end", sid: info.sid }, "worker session closed");
        }
      })();
    },

    notify(sid: string): void {
      const w = workers.get(sid);
      if (!w) return;
      w.input.push(
        `New review activity for session ${sid}. Run \`bun ${cliEntry()} wait-until ${sid}\` now to fetch and handle the batch, then stop and wait for the next message.`,
      );
    },

    interrupt(sid: string): void {
      void workers.get(sid)?.q.interrupt?.().catch(() => {});
    },

    stop(sid: string): void {
      workers.get(sid)?.input.close();
    },
  };
}
