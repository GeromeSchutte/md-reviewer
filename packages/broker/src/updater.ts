import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import type { UpdateApplyResponse, UpdateStatus } from "@plan-review/shared";
import { dataDir, updateLogPath } from "./paths";

/** Repo root, resolved from this file: packages/broker/src/updater.ts -> ../../..
 *  Overridable via PLAN_REVIEW_REPO_ROOT (tests point it at a throwaway clone). */
export function repoRoot(): string {
  return process.env.PLAN_REVIEW_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/** Path to the bash update engine the in-app updater drives. */
function updateScriptPath(): string {
  return join(repoRoot(), "scripts", "update");
}

/** Newest-first commit-subject cap for the "what's new" list. */
const MAX_COMMITS = 50;
/** A stalled fetch must not pin a request: cap it well under any human's patience. */
const FETCH_TIMEOUT_MS = 20_000;

interface GitResult {
  ok: boolean;
  out: string;
}

/**
 * Run git asynchronously. The broker is single-threaded, so a *synchronous* git
 * call here would freeze every SSE stream and agent long-poll for its duration —
 * and `git fetch` (run on every viewer load) can hang for tens of seconds when the
 * network is slow. `Bun.spawn` + `await exited` keeps the event loop free; the
 * optional timeout kills a wedged fetch. Never throws — callers branch on `ok`.
 */
async function git(args: string[], timeoutMs?: number): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", "-C", repoRoot(), ...args], {
      stdout: "pipe",
      stderr: "pipe",
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    const trimmed = out.trim();
    return { ok: code === 0, out: trimmed || err.trim() };
  } catch (err) {
    return { ok: false, out: String(err instanceof Error ? err.message : err) };
  }
}

/** Synchronous git — for one-shot startup use ONLY (before the server is listening),
 *  never on the request path. */
function gitSync(args: string[]): GitResult {
  try {
    const res = Bun.spawnSync(["git", "-C", repoRoot(), ...args], { stdout: "pipe", stderr: "pipe" });
    const out = `${res.stdout?.toString() ?? ""}`.trim();
    return { ok: res.exitCode === 0, out: out || `${res.stderr?.toString() ?? ""}`.trim() };
  } catch (err) {
    return { ok: false, out: String(err instanceof Error ? err.message : err) };
  }
}

/** Human-readable version from the root package.json (the canonical version source). */
export function currentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Currently checked-out commit (full sha). Synchronous: only called once at broker
 *  startup to seed /health, where blocking is harmless. */
export function currentSha(): string {
  const r = gitSync(["rev-parse", "HEAD"]);
  return r.ok ? r.out : "";
}

/** origin URL rewritten to HTTPS so a fetch works without an ssh-agent (the daemon). */
async function httpsRemote(): Promise<string | null> {
  const r = await git(["remote", "get-url", "origin"]);
  if (!r.ok || !r.out) return null;
  const url = r.out;
  if (url.startsWith("git@")) return "https://" + url.replace(/^git@([^:]+):/, "$1/");
  if (url.startsWith("ssh://")) return "https://" + url.replace(/^ssh:\/\/(git@)?([^/]+)\//, "$2/");
  return url; // already http(s) or some other transport — use verbatim
}

/**
 * Read-only update status: fetches the upstream branch over HTTPS (public repo, no
 * auth) and compares it to the checkout. The fetch updates FETCH_HEAD + objects but
 * never touches a branch or the working tree, so it's safe to call on viewer load.
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const version = currentVersion();
  const [branchR, shaR, statusR] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["rev-parse", "HEAD"]),
    git(["status", "--porcelain"]),
  ]);
  const branch = branchR.ok ? branchR.out : "";
  const sha = shaR.ok ? shaR.out : "";
  const clean = statusR.ok && statusR.out.length === 0;
  const base: UpdateStatus = {
    version,
    branch,
    sha,
    remoteSha: null,
    behind: 0,
    ahead: 0,
    clean,
    canApply: false,
    commits: [],
    error: null,
  };

  if (!sha || !branch) return { ...base, error: "not a git checkout" };
  const remote = await httpsRemote();
  if (!remote) return { ...base, error: "no origin remote configured" };

  const fetched = await git(["fetch", "--quiet", remote, branch], FETCH_TIMEOUT_MS);
  if (!fetched.ok) return { ...base, error: `fetch failed: ${fetched.out}` };

  const remoteSha = await git(["rev-parse", "FETCH_HEAD"]);
  if (!remoteSha.ok) return { ...base, error: "could not resolve fetched ref" };

  const [behindR, aheadR, log] = await Promise.all([
    git(["rev-list", "--count", "HEAD..FETCH_HEAD"]),
    git(["rev-list", "--count", "FETCH_HEAD..HEAD"]),
    // %h<US>%s per line — the unit separator (\x1f) can't appear in a subject, so it's
    // a safe field delimiter even if a subject contains spaces or other punctuation.
    git(["log", `--max-count=${MAX_COMMITS}`, "--format=%h%x1f%s", "HEAD..FETCH_HEAD"]),
  ]);
  const behind = Number(behindR.out) || 0;
  const ahead = Number(aheadR.out) || 0;
  const commits = log.ok
    ? log.out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [csha, ...rest] = line.split("\x1f");
          return { sha: csha ?? "", subject: rest.join("\x1f") };
        })
    : [];

  return {
    ...base,
    remoteSha: remoteSha.out,
    behind,
    ahead,
    canApply: behind > 0 && ahead === 0 && clean,
    commits,
  };
}

/**
 * Kick off an update: pre-flight the same guards `scripts/update` enforces, then
 * spawn it fully detached (it long-outlives this request — a Rust rebuild takes
 * minutes — and restarts the daemon at the end, killing us). Output streams to
 * ~/.plan-review/update.log. Returns immediately; the viewer polls /health for the
 * target sha to detect completion.
 */
export async function applyUpdate(): Promise<UpdateApplyResponse> {
  const status = await checkForUpdate();
  if (status.error) return { started: false, targetSha: null, error: status.error };
  if (!status.clean) return { started: false, targetSha: null, error: "working tree has local changes" };
  if (status.behind === 0) return { started: false, targetSha: null, error: "already up to date" };
  if (status.ahead > 0)
    return { started: false, targetSha: null, error: "branch has diverged from upstream — resolve manually" };

  const script = updateScriptPath();
  if (!existsSync(script)) return { started: false, targetSha: null, error: "update script not found" };

  try {
    mkdirSync(dataDir(), { recursive: true });
    const logFd = openSync(updateLogPath(), "a");
    const proc = Bun.spawn(["bash", script], {
      cwd: repoRoot(),
      env: { ...process.env },
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
    });
    proc.unref();
  } catch (err) {
    return { started: false, targetSha: null, error: String(err instanceof Error ? err.message : err) };
  }
  return { started: true, targetSha: status.remoteSha, error: null };
}
