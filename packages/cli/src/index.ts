#!/usr/bin/env bun
import { resolve as resolvePath, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { AgentSource } from "@plan-review/shared";
import {
  installDaemon,
  uninstallDaemon,
  restartDaemon,
  daemonInstalled,
  brokerEntryPath,
  bunPath,
} from "@plan-review/broker/daemon";
import { attach, baseUrl, createSession, health, postAnswer, reworkDone, waitForEvents } from "./client";

interface Args {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spawnTransientBroker(): void {
  const proc = Bun.spawn([bunPath(), brokerEntryPath()], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  proc.unref();
}

/** Make sure a broker is reachable: use the daemon if installed, else spawn a transient one. */
async function ensureBroker(): Promise<void> {
  if (await health()) return;
  if (daemonInstalled()) restartDaemon();
  else spawnTransientBroker();
  for (let i = 0; i < 30; i++) {
    await sleep(150);
    if (await health()) return;
  }
  throw new Error("broker did not come up; try `plan-review install`");
}

function repoRoot(): string {
  // packages/cli/src/index.ts -> repo root is three levels up.
  return join(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/**
 * Find the built Tauri viewer binary. Only release builds embed the frontend and
 * run standalone — the debug build loads the Vite dev URL and would show a blank
 * window when launched without `tauri dev`, so it's deliberately excluded here.
 */
function findViewerBinary(): string | undefined {
  const root = repoRoot();
  const candidates = [
    process.env.PLAN_REVIEW_VIEWER_BIN,
    join(root, "apps/viewer/src-tauri/target/release/bundle/macos/plan-review.app/Contents/MacOS/plan-review"),
    join(root, "apps/viewer/src-tauri/target/release/app"),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p));
}

function launchViewer(sid: string, abspath: string): void {
  const bin = findViewerBinary();
  if (bin) {
    const proc = Bun.spawn([bin], {
      env: { ...process.env, PLAN_REVIEW_SESSION: sid, PLAN_REVIEW_PATH: abspath },
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.unref();
    console.log(`opened viewer for session ${sid}`);
  } else {
    console.log(`session ${sid} ready for ${abspath} (broker at ${baseUrl()})`);
    console.log("no release viewer found — build it once with:");
    console.log("  cd apps/viewer && bun run tauri build --no-bundle");
    console.log(`(for development: cd apps/viewer && bun run tauri dev, then open ?session=${sid})`);
  }
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0];

  switch (cmd) {
    // ---- daemon management ----
    case "install": {
      const { plistPath } = installDaemon();
      console.log(`installed LaunchAgent: ${plistPath}`);
      await sleep(400);
      console.log((await health()) ? "daemon is up" : "daemon installed; starting…");
      return;
    }
    case "uninstall": {
      uninstallDaemon();
      console.log("uninstalled LaunchAgent");
      return;
    }
    case "restart": {
      console.log(restartDaemon().ok ? "restart requested" : "restart failed (is it installed?)");
      return;
    }
    case "status": {
      const h = await health();
      console.log(JSON.stringify({ installed: daemonInstalled(), running: !!h, health: h }, null, 2));
      return;
    }

    // ---- user ----
    case "open": {
      const path = positionals[1];
      if (!path) throw new Error("usage: plan-review open <plan.md>");
      await ensureBroker();
      const abspath = resolvePath(process.cwd(), path);
      // --json => the calling agent will attach itself (agent-initiated): suppress auto-spawn.
      const agentInitiated = !!flags.json;
      const { sid } = await createSession(abspath, agentInitiated);
      launchViewer(sid, abspath);
      if (agentInitiated) console.log(JSON.stringify({ sid, abspath }));
      return;
    }

    // ---- agent ----
    case "attach": {
      const sid = positionals[1];
      const path = flags.path;
      const source = (flags.source as AgentSource) ?? "agent";
      if (!sid || typeof path !== "string") throw new Error("usage: plan-review attach <sid> --path <plan.md> --source <agent|spawned>");
      const res = await attach(sid, resolvePath(path), source);
      console.log(JSON.stringify(res));
      return;
    }
    case "wait": {
      const sid = positionals[1];
      if (!sid) throw new Error("usage: plan-review wait <sid>");
      const res = await waitForEvents(sid);
      console.log(JSON.stringify(res));
      return;
    }
    case "answer": {
      const sid = positionals[1];
      const questionId = positionals[2];
      if (!sid || !questionId) throw new Error("usage: plan-review answer <sid> <questionId> [--error <msg>]  (markdown read from stdin)");
      if (typeof flags.error === "string") {
        await postAnswer(sid, questionId, { error: flags.error });
      } else {
        const markdown = await Bun.stdin.text();
        await postAnswer(sid, questionId, { markdown });
      }
      console.log("ok");
      return;
    }
    case "rework-done": {
      const sid = positionals[1];
      if (!sid) throw new Error("usage: plan-review rework-done <sid> [--error <msg>]");
      await reworkDone(sid, typeof flags.error !== "string", typeof flags.error === "string" ? flags.error : undefined);
      console.log("ok");
      return;
    }

    default:
      console.log(
        [
          "plan-review — markdown plan review tool",
          "",
          "Daemon:  install | uninstall | restart | status",
          "User:    open <plan.md>",
          "Agent:   attach <sid> --path <plan.md> --source <agent|spawned>",
          "         wait <sid>",
          "         answer <sid> <questionId> [--error <msg>]   (markdown via stdin)",
          "         rework-done <sid> [--error <msg>]",
        ].join("\n"),
      );
      if (cmd) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
