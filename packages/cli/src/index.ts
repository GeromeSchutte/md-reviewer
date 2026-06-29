#!/usr/bin/env bun
import { resolve as resolvePath, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  existsSync,
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
  rmSync,
  symlinkSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import type { AgentSource } from "@plan-review/shared";
import {
  installDaemon,
  uninstallDaemon,
  restartDaemon,
  daemonInstalled,
  brokerEntryPath,
  bunPath,
} from "@plan-review/broker/daemon";
import { dataDir } from "@plan-review/broker/paths";
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

/** Source inputs that, if newer than the built binary, mean it embeds a stale
 *  frontend. Deliberately excludes node_modules / dist / src-tauri/target. */
function viewerSourcePaths(root: string): string[] {
  return [
    join(root, "apps/viewer/src"),
    join(root, "apps/viewer/src-tauri/src"),
    join(root, "apps/viewer/src-tauri/Cargo.toml"),
    join(root, "apps/viewer/src-tauri/tauri.conf.json"),
    join(root, "apps/viewer/index.html"),
    join(root, "apps/viewer/vite.config.ts"),
    join(root, "apps/viewer/package.json"),
    join(root, "packages/shared/src"),
  ].filter((p) => existsSync(p));
}

/** Newest mtime (ms) under a file or directory tree. Trees here are small and
 *  contain no node_modules/target, so a plain recursive walk is fine. */
function newestMtimeMs(path: string): number {
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let max = st.mtimeMs;
  for (const entry of readdirSync(path)) max = Math.max(max, newestMtimeMs(join(path, entry)));
  return max;
}

/** True if any viewer source file is newer than the built binary. Deterministic
 *  numeric mtime comparison — no dependency on `find -newer` semantics/portability. */
function viewerStale(srcPaths: string[], bin: string): boolean {
  const binMs = statSync(bin).mtimeMs;
  return srcPaths.some((p) => newestMtimeMs(p) > binMs);
}

/**
 * The release binary embeds the frontend at build time, so a viewer source change
 * doesn't show up until it's rebuilt — silently serving stale UI (the exact trap
 * that hid a styling rework during testing). Rebuild on `open` when the source is
 * newer than the binary. A failed rebuild is non-fatal: we warn and launch the
 * existing build rather than leave the user with no viewer.
 */
function ensureViewerFresh(): void {
  if (process.env.PLAN_REVIEW_VIEWER_BIN) return; // explicit override — don't second-guess it
  const root = repoRoot();
  const srcPaths = viewerSourcePaths(root);
  if (srcPaths.length === 0) return; // no source tree (installed standalone) — nothing to build from
  const bin = findViewerBinary();
  if (bin && !viewerStale(srcPaths, bin)) return;
  console.log(bin ? "viewer source changed since last build — rebuilding…" : "no viewer build found — building…");
  const res = Bun.spawnSync(["bun", "run", "tauri", "build", "--no-bundle"], {
    cwd: join(root, "apps/viewer"),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (res.exitCode === 0) console.log("viewer rebuilt.");
  else console.error("⚠️  viewer rebuild failed — launching the existing build (it may be stale). Rebuild manually: cd apps/viewer && bun run tauri build --no-bundle");
}

// ---- setup / teardown (run by the bun postinstall hook and `bun run uninstall`) ----

/** Claude Code's config dir — where skills/scripts are discovered. Honours CLAUDE_CONFIG_DIR. */
function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** The symlinks setup creates: each <link> in Claude's config dir -> a path in this repo. */
function managedLinks(): { link: string; target: string }[] {
  const root = repoRoot();
  const cdir = claudeDir();
  return [
    { link: join(cdir, "skills", "plan-review"), target: join(root, "skills", "plan-review") },
    { link: join(cdir, "scripts", "plan-review"), target: join(root, "scripts", "plan-review") },
  ];
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function cargoAvailable(): boolean {
  return !!Bun.which("cargo");
}

function warnStep(name: string, err: unknown): void {
  console.warn(`  ⚠️  ${name} step failed (continuing): ${err instanceof Error ? err.message : err}`);
}

/** Create/refresh a symlink, refusing to clobber a real (non-symlink) file. */
function linkInto(linkPath: string, target: string): void {
  mkdirSync(dirname(linkPath), { recursive: true });
  // existsSync follows the link, so a dangling symlink reads as absent here — fall
  // through and replace it. A *real* file (not a symlink) is left untouched.
  if (existsSync(linkPath) && !isSymlink(linkPath)) {
    console.warn(`  ⚠️  ${linkPath} exists and is not a symlink — leaving it untouched`);
    return;
  }
  rmSync(linkPath, { force: true });
  symlinkSync(target, linkPath);
  console.log(`  ✓ ${linkPath} -> ${target}`);
}

/**
 * Post-deps setup, run by the bun `postinstall` hook (and re-runnable via `bun run setup`).
 * MUST be resilient: postinstall fires on every `bun install`/`bun add`, and a throw here
 * would fail the whole install. Every step is best-effort; the caller swallows errors.
 *
 * - symlinks: cross-platform, cheap, idempotent.
 * - daemon: macOS-only; a healthy running daemon is left alone (no restart on every `bun add`).
 * - viewer: macOS-only; built once on a fresh clone (or when stale), but only if Rust is present.
 *   When Rust is absent it's skipped and built lazily on first `open`.
 */
async function runSetup(linksOnly: boolean): Promise<void> {
  if (process.env.PLAN_REVIEW_SKIP_SETUP === "1") {
    console.log("PLAN_REVIEW_SKIP_SETUP=1 — skipping plan-review setup.");
    return;
  }
  console.log("▶ plan-review setup");

  try {
    const links = managedLinks();
    // The CLI wrapper must be executable (the skill invokes it directly).
    for (const { target } of links) {
      if (target.endsWith(join("scripts", "plan-review"))) {
        try {
          chmodSync(target, 0o755);
        } catch {
          /* not fatal */
        }
      }
    }
    for (const { link, target } of links) linkInto(link, target);
  } catch (e) {
    warnStep("symlinks", e);
  }

  if (linksOnly) {
    console.log("(--links-only: skipped daemon + viewer build.)");
    return;
  }

  if (process.platform !== "darwin") {
    console.log("  • non-macOS host — skipping broker daemon + viewer build (macOS-only).");
    return;
  }

  // Daemon: leave a healthy daemon running; only (re)bootstrap if absent or down.
  try {
    if (daemonInstalled() && (await health())) {
      console.log("  ✓ broker daemon already running");
    } else {
      const { plistPath } = installDaemon();
      console.log(`  ✓ broker daemon installed: ${plistPath}`);
    }
  } catch (e) {
    warnStep("daemon", e);
  }

  // Viewer: build once now so the agent's first `open` doesn't stall on a Rust compile.
  try {
    const root = repoRoot();
    const srcPaths = viewerSourcePaths(root);
    if (srcPaths.length === 0) {
      // no source tree — nothing to build (shouldn't happen from a clone)
    } else if (!cargoAvailable()) {
      console.log("  • Rust (cargo) not found — skipping viewer build; it'll build on first `open`.");
    } else {
      const bin = findViewerBinary();
      if (bin && !viewerStale(srcPaths, bin)) {
        console.log("  ✓ viewer build up to date");
      } else {
        console.log(
          bin
            ? "  • viewer source changed — rebuilding…"
            : "  • building viewer (first run compiles Rust — this can take a few minutes)…",
        );
        const res = Bun.spawnSync(["bun", "run", "tauri", "build", "--no-bundle"], {
          cwd: join(root, "apps/viewer"),
          stdout: "inherit",
          stderr: "inherit",
        });
        console.log(res.exitCode === 0 ? "  ✓ viewer built" : "  ⚠️  viewer build failed — it'll retry on first `open`.");
      }
    }
  } catch (e) {
    warnStep("viewer", e);
  }

  console.log("plan-review setup complete.");
}

/**
 * Reverse what setup added: remove our symlinks and the broker daemon. Run before
 * deleting the clone — no hook fires on `rm -rf`. Preserves ~/.plan-review (review
 * history + logs) unless `purge` is set.
 */
async function runTeardown(purge: boolean): Promise<void> {
  console.log("▶ plan-review teardown");
  let canonRoot = repoRoot();
  try {
    canonRoot = realpathSync(canonRoot);
  } catch {
    /* keep non-canonical */
  }

  // Remove each symlink only if it's a symlink resolving into THIS repo (don't clobber
  // a link a different clone owns). A dangling link in our managed path is ours to remove.
  for (const { link } of managedLinks()) {
    try {
      if (!isSymlink(link)) {
        if (existsSync(link)) console.log(`  • ${link} is not our symlink — leaving it`);
        continue;
      }
      let dest = "";
      try {
        dest = realpathSync(link);
      } catch {
        /* dangling — almost certainly ours; fall through and remove */
      }
      if (dest && dest !== canonRoot && !dest.startsWith(canonRoot + "/")) {
        console.log(`  • ${link} -> ${dest} (not this repo) — leaving it`);
        continue;
      }
      rmSync(link, { force: true });
      console.log(`  ✓ removed ${link}`);
    } catch (e) {
      warnStep(`remove ${link}`, e);
    }
  }

  if (process.platform === "darwin") {
    try {
      uninstallDaemon();
      console.log("  ✓ removed broker daemon (LaunchAgent)");
    } catch (e) {
      warnStep("daemon", e);
    }
  }

  if (purge) {
    try {
      rmSync(dataDir(), { recursive: true, force: true });
      console.log(`  ✓ purged ${dataDir()} (review history + logs)`);
    } catch (e) {
      warnStep("purge", e);
    }
  } else {
    console.log(`  • kept ${dataDir()} (review history). Pass --purge to remove it.`);
  }

  console.log("plan-review teardown complete.");
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
    // ---- install lifecycle (bun postinstall hook + `bun run uninstall`) ----
    case "setup": {
      // Must never fail the install: swallow anything that escapes per-step handling.
      try {
        await runSetup(!!flags["links-only"]);
      } catch (err) {
        console.warn(`  ⚠️  setup error (continuing): ${err instanceof Error ? err.message : err}`);
      }
      return; // never set exitCode — a non-zero postinstall aborts `bun install`
    }
    case "teardown": {
      await runTeardown(!!flags.purge);
      return;
    }

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
      ensureViewerFresh();
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
          "Setup:   setup [--links-only] | teardown [--purge]   (run by `bun install` / `bun run uninstall`)",
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
