import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "./store";

export interface SpawnInfo {
  sid: string;
  abspath: string;
  title: string;
}
export type Spawner = (info: SpawnInfo) => void;

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

/** Build the session-specific seed message for a spawned review agent (pure; testable). */
export function buildSeed(deps: { store: Store; baseUrl: string }, info: SpawnInfo): string {
  const cli = `bun ${cliEntry()}`;
  return [
    `You are the review agent for the plan at: ${info.abspath}`,
    `Review session id: ${info.sid}`,
    `Broker base URL: ${deps.baseUrl}`,
    `The review CLI is: \`${cli}\` (e.g. \`${cli} wait ${info.sid}\`).`,
    ``,
    `You were spawned by the broker for a file the user opened, so a session already exists.`,
    `Skip "open"; attach with --source spawned, then run the wait-loop per your instructions.`,
    ``,
    historyText(deps.store, info.abspath),
    ``,
    `Begin now: attach to the session and enter the wait-loop. Do not stop until you receive an "end" event.`,
  ].join("\n");
}

export function makeSpawner(deps: { store: Store; baseUrl: string }): Spawner {
  const skill = skillBody();

  return (info: SpawnInfo) => {
    const seed = buildSeed(deps, info);

    void (async () => {
      try {
        const q = query({
          prompt: seed,
          options: {
            cwd: dirname(info.abspath),
            additionalDirectories: [repoRoot()],
            allowedTools: ["Bash", "Read", "Edit", "Write"],
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            // No maxTurns: the wait-loop must run until an `end` event.
            systemPrompt: { type: "preset", preset: "claude_code", append: skill },
          },
        });
        for await (const message of q) {
          if (message.type === "result") {
            console.log(`[spawner] session ${info.sid} agent ended (${message.subtype})`);
          }
        }
      } catch (err) {
        console.error(`[spawner] session ${info.sid} agent error:`, err instanceof Error ? err.message : err);
      }
    })();
  };
}
