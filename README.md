# Plan Review

A lean tool for reviewing agent-generated markdown plans interactively: read them formatted in a desktop viewer, select lines to **ask questions** (answered from the agent's live context) or **leave feedback** (anchored, queued, never triggering an immediate regeneration), and **submit a review** as one batch that the agent reworks.

## Architecture

Three cooperating processes:

1. **Broker** (`packages/broker`) — an always-on Bun daemon (macOS LaunchAgent). A message broker + file watcher + durable SQLite store. The `questions` table doubles as a crash-safe work-queue; feedback is persisted and surfaced to the agent but never wakes it on its own.
2. **CLI** (`packages/cli`, `plan-review`) — the surface for the agent (`attach`/`wait`/`answer`/`rework-done`), the user (`open`), and daemon management (`install`/`uninstall`/`status`/`restart`).
3. **Viewer** (`apps/viewer`) — a Tauri v2 + React 19 desktop app. Live markdown render, line/range selection, anchored & general Ask/Comment, a Q&A panel with in-progress/success/error indicators, and a Review tab with an overall note + Submit.

The **agent** is a Claude Code agent driven by the `plan-review` skill (`skills/plan-review/SKILL.md`). It answers questions from its own live context and reworks the file only on `finalize`.

### Two entry paths

- **Agent-initiated**: Claude writes a markdown plan, auto-invokes the skill, runs `plan-review open --json`, attaches as `--source agent`, and enters the wait-loop with its rich context.
- **User-initiated**: you open a `.md` yourself with no agent; the broker spawns a fresh headless Claude agent (Agent SDK, auth inherited from `~/.claude`) seeded with the file + prior review history, which attaches as `--source spawned` and runs the same loop.

State is keyed by the plan's absolute path, so reviews (Q&A + feedback) survive across sessions and seed freshly-spawned agents.

## Setup

```sh
git clone … && cd planning-tool
bun install
```

That's it. `bun install` is the whole setup — its lifecycle hooks do everything:

- **`preinstall`** (`scripts/preinstall`) checks the prerequisites Bun can't install and
  **warns without failing** (the install always proceeds): Bun version floor, the Rust
  toolchain (`brew install rust`), and Xcode Command Line Tools (`xcode-select --install`).
- **`postinstall`** (`plan-review setup`) symlinks the skill + CLI wrapper into Claude
  Code's config dir, installs the always-on broker daemon, and builds the viewer.

Idempotent and safe to re-run — re-running `bun install` is also how you re-do setup
after moving the repo. It never restarts a healthy daemon, and skips the viewer build
when the build is current (or when Rust isn't installed yet — it then builds lazily on
first `open`). Honours `CLAUDE_CONFIG_DIR`.

**Prerequisites.** **Bun is required and must be installed first** — it's the runtime for
the daemon and CLI (not just the package manager), so it can't be bootstrapped from within
(`brew install bun`). The Rust toolchain + Xcode Command Line Tools are needed only for the
desktop viewer; the `preinstall` check prints the exact commands. macOS only (LaunchAgent +
Tauri app); on other platforms the daemon/viewer steps no-op cleanly.

**Escape hatch.** `bun install --ignore-scripts` (or `PLAN_REVIEW_SKIP_SETUP=1 bun install`)
installs dependencies without running setup — useful in CI.

```sh
./scripts/install                # convenience alias for `bun install`
./scripts/install --links-only   # only (re)create the Claude Code symlinks
```

### Uninstall

```sh
bun run uninstall            # or ./scripts/uninstall — remove symlinks + daemon
bun run uninstall --purge    # also delete ~/.plan-review (review history + logs)
```

Reverses what setup added: removes the broker daemon and the Claude Code symlinks (only
those resolving into *this* repo — it won't touch a link another clone owns). **Run it
before deleting the clone** — nothing fires on `rm -rf`, so a deleted repo would otherwise
orphan the LaunchAgent plist and leave dangling symlinks. Review history in `~/.plan-review`
is preserved unless you pass `--purge`.

The individual steps are documented below for reference (reloading the daemon after code
changes, UI dev with hot reload, etc.).

### Install the daemon (always-on)

```sh
bun run packages/cli/src/index.ts install     # writes ~/Library/LaunchAgents/ai.plan-review.broker.plist
bun run packages/cli/src/index.ts status
```

After changing broker code, reload the running daemon: `bun run packages/cli/src/index.ts restart`.

### Watching the daemon

The broker logs every event (session open, attach, question queued→answered/error, feedback, finalize→rework, spawn lifecycle, disconnects) as structured JSON via pino:

```sh
tail -f ~/.plan-review/broker.log | bunx pino-pretty   # structured events, pretty
tail -f ~/.plan-review/broker.out.log                  # raw stdout (startup, crashes)
```

Set `PLAN_REVIEW_LOG_LEVEL=debug` (or `silent`) to adjust verbosity.

### Claude Code symlinks (skill + CLI wrapper)

`./scripts/install` (or `./scripts/install --links-only`) symlinks the skill into
`~/.claude/skills/plan-review` (so Claude Code discovers it) and the CLI wrapper into
`~/.claude/scripts/plan-review` (the stable path the skill invokes — see
`skills/plan-review/SKILL.md`). It refuses to clobber a real file at either path.

### Run the viewer

```sh
# Build the standalone viewer once (embeds the frontend; this is what `open` launches):
cd apps/viewer && bun run tauri build --no-bundle
# …or for development with hot reload:
cd apps/viewer && bun run tauri dev
```

> The **debug** build (`cargo build` / `tauri dev`) loads the Vite dev server at
> `localhost:5173`, so it shows a blank window unless that server is running.
> `plan-review open` only launches a **release** build, which serves the embedded
> frontend standalone — build it with `tauri build --no-bundle` (produces
> `apps/viewer/src-tauri/target/release/app`).

To open a specific plan, the CLI sets `PLAN_REVIEW_SESSION`/`PLAN_REVIEW_PATH` for the viewer binary:

```sh
bun run packages/cli/src/index.ts open path/to/plan.md
```

(In dev/browser you can also pass `?path=/abs/plan.md` or `?session=<sid>` on the Vite URL.)

### Iterate on the UI in a browser (no Tauri rebuild)

The viewer is a plain Vite + React app, so you can develop the UI in a browser with
hot reload instead of rebuilding the Tauri binary. The broker speaks plain HTTP/SSE
(CORS enabled), and `resolveSession` falls back to query params outside Tauri.

```sh
bun run broker                              # daemon (or `... status` if already installed)
cd apps/viewer && bun run dev               # Vite dev server on :5173
# open http://localhost:5173/?path=/abs/plan.md   ← live broker + a real plan
```

For **pure-UI work with no backend at all**, append `?mock`: this swaps the broker for
an in-memory fixture (sample plan + Q&A in every status + feedback), so the whole UI —
dark theme, shadcn components, dialogs — renders instantly with full HMR and no broker,
agent, or session.

```sh
cd apps/viewer && bun run dev
# open http://localhost:5173/?mock
```

The viewer is **dark-mode only** (`<html class="dark">`) and built on
[shadcn/ui](https://ui.shadcn.com) over Tailwind v4. Design tokens live in
`src/index.css`; add more components with `bunx shadcn@latest add <name>` from
`apps/viewer`. The `?mock` fixture is gated on `import.meta.env.DEV`, so it never
activates in the release/Tauri build (where `DEV` is `false`), regardless of the query
string — the fixture code is inert there, not stripped from the bundle.

## Develop

```sh
bun test                                  # broker unit + HTTP + watcher + spawner tests
bunx tsc --noEmit -p packages/broker/tsconfig.json
cd apps/viewer && bun run build           # typecheck + vite build
```
