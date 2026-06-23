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
bun install
```

Prerequisites: Bun, and (for the viewer) the Rust toolchain + Xcode Command Line Tools.

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

### Install the skill (for agent-initiated reviews)

Symlink the skill into Claude Code's skills directory:

```sh
ln -s "$PWD/skills/plan-review" ~/.claude/skills/plan-review
```

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
`apps/viewer`. The `?mock` fixture is dev-only (gated on `import.meta.env.DEV`) and is
never bundled into the release/Tauri build.

## Develop

```sh
bun test                                  # broker unit + HTTP + watcher + spawner tests
bunx tsc --noEmit -p packages/broker/tsconfig.json
cd apps/viewer && bun run build           # typecheck + vite build
```
