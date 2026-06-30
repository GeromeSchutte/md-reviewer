import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { checkForUpdate, applyUpdate } from "../src/updater";

// Set up a throwaway "upstream" (bare) + a clone the updater runs against. The updater
// resolves its repo from PLAN_REVIEW_REPO_ROOT, so we point it at the clone. `origin`
// is a local path, which httpsRemote() passes through verbatim — so the fetch is local
// and offline-safe, while still exercising the real fetch / rev-list / ff-guard paths.
function git(cwd: string, args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr?.toString()}`);
  return (res.stdout?.toString() ?? "").trim();
}

const IDENT = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];

describe("self-updater", () => {
  let root: string;
  let bare: string;
  let upstream: string;
  let clone: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    root = join(tmpdir(), `pr-update-${randomUUID()}`);
    bare = join(root, "origin.git");
    upstream = join(root, "upstream");
    clone = join(root, "clone");
    mkdirSync(root, { recursive: true });

    git(root, ["init", "--bare", "-b", "main", bare]);
    // Author one commit upstream and publish it.
    git(root, ["init", "-b", "main", upstream]);
    writeFileSync(join(upstream, "a.txt"), "v1\n");
    git(upstream, ["add", "."]);
    git(upstream, [...IDENT, "commit", "-m", "Initial commit"]);
    git(upstream, ["remote", "add", "origin", bare]);
    git(upstream, ["push", "-u", "origin", "main"]);
    // The clone under test starts level with upstream.
    git(root, ["clone", bare, clone]);

    prevEnv = process.env.PLAN_REVIEW_REPO_ROOT;
    process.env.PLAN_REVIEW_REPO_ROOT = clone;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PLAN_REVIEW_REPO_ROOT;
    else process.env.PLAN_REVIEW_REPO_ROOT = prevEnv;
    rmSync(root, { recursive: true, force: true });
  });

  // Push a new commit to the bare upstream via the upstream working repo.
  function pushUpstreamCommit(subject: string): void {
    writeFileSync(join(upstream, "a.txt"), `${subject}\n`);
    git(upstream, ["add", "."]);
    git(upstream, [...IDENT, "commit", "-m", subject]);
    git(upstream, ["push", "origin", "main"]);
  }

  it("reports up to date when level with upstream", async () => {
    const s = await checkForUpdate();
    expect(s.error).toBeNull();
    expect(s.branch).toBe("main");
    expect(s.behind).toBe(0);
    expect(s.ahead).toBe(0);
    expect(s.clean).toBe(true);
    expect(s.canApply).toBe(false);
  });

  it("detects commits behind and lists their subjects", async () => {
    pushUpstreamCommit("Add a feature");
    const s = await checkForUpdate();
    expect(s.error).toBeNull();
    expect(s.behind).toBe(1);
    expect(s.ahead).toBe(0);
    expect(s.canApply).toBe(true);
    expect(s.commits.map((c) => c.subject)).toContain("Add a feature");
    expect(s.remoteSha).not.toBeNull();
  });

  it("refuses to apply on a dirty working tree", async () => {
    pushUpstreamCommit("Newer");
    writeFileSync(join(clone, "a.txt"), "local edit\n"); // uncommitted change
    const s = await checkForUpdate();
    expect(s.behind).toBe(1);
    expect(s.clean).toBe(false);
    expect(s.canApply).toBe(false);
    const res = await applyUpdate();
    expect(res.started).toBe(false);
    expect(res.error).toMatch(/local changes/i);
  });

  it("refuses to apply a diverged branch", async () => {
    pushUpstreamCommit("Upstream change"); // clone is now behind by 1
    // ...and commit locally so the clone is also ahead by 1 (diverged).
    writeFileSync(join(clone, "b.txt"), "local\n");
    git(clone, ["add", "."]);
    git(clone, [...IDENT, "commit", "-m", "Local-only commit"]);
    const s = await checkForUpdate();
    expect(s.behind).toBe(1);
    expect(s.ahead).toBe(1);
    expect(s.canApply).toBe(false);
    const res = await applyUpdate();
    expect(res.started).toBe(false);
    expect(res.error).toMatch(/diverged/i);
  });

  it("does not start an apply when already up to date", async () => {
    const res = await applyUpdate();
    expect(res.started).toBe(false);
    expect(res.error).toMatch(/up to date/i);
  });
});
