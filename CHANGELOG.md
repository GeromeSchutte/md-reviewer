# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

To add an entry, write it under `[Unreleased]` in the section that fits
(`Added` / `Changed` / `Fixed` / `Removed` / `Docs`). When cutting a release,
rename `[Unreleased]` to the new version + date and start a fresh `[Unreleased]`.

## [Unreleased]

### Added

- **In-app self-update.** The viewer can now check for and apply updates without
  leaving the app: an "update available" indicator in the window header opens an
  update dialog, and a **Plan Review → Check for Updates…** item in the macOS menu
  bar opens the same dialog. Applying fast-forwards the checkout over HTTPS and
  re-runs setup (`bun install`), then the broker restarts and the dialog reports
  completion. Updates are refused on a dirty or diverged working tree.
- **`bun run update`** — a root script that updates a clone in place
  (`scripts/update`): refuses on local changes, fetches `origin` over HTTPS,
  fast-forwards, reinstalls, and restarts the daemon. This is the same engine the
  in-app updater drives.
- **`plan-review update`** — CLI command to check for updates (`--apply` to apply).
- `GET /update/check` and `POST /update/apply` broker endpoints; `GET /health` now
  also reports the checked-out commit `sha`.
- **`plan-review wait-until <sid>`** — a CLI command that blocks until there is
  actually review work and only then returns a batch (it never returns an empty
  hold). Run it in the background so the agent's turn ends and the harness
  re-invokes it when work arrives — no poll loop in the conversation.

### Changed

- **Push-based agent notification (no more poll loop).** Reviews take a long time,
  so the agent no longer sits in a foreground `wait` loop that eventually gives up.
  - *User-opened files:* the broker now runs the spawned worker as a persistent
    **streaming-input** session and **pushes** work into it when a question or the
    Submit arrives; the worker sits idle (zero tokens) between events instead of
    re-polling every ~4 minutes.
  - *Agent-written plans:* the agent runs `wait-until` in the background and ends
    its turn, so the interactive session is freed and its live context is preserved
    for answering questions (it is never replaced by a spawned worker).
  - Feedback comments still batch until Submit — they never wake the agent.
- The viewer now shows **"Agent offline"** when an attached interactive agent stops
  polling past a grace window; re-attaching (asking a question / submitting) clears it.

### Fixed

- **Self-update now actually lands the new viewer UI.** A release Tauri build embeds
  its frontend at build time and the running viewer holds the `single-instance` lock,
  so after applying an in-app update, reopening a plan forwarded argv back into the
  stale process — the window kept showing the old UI. The update dialog's "applied"
  state now offers a **Quit to finish** button (a `quit_app` command → `app.exit(0)`);
  once quit, the next `plan-review open` boots a clean instance on the freshly built
  binary. We deliberately don't auto-`restart()`: it races the single-instance socket
  teardown and can leave no window open. Dialog copy and the README now say
  quit-and-reopen instead of the misleading "reopen the plan."

## [0.1.0] - 2026-06-30

Initial release: a desktop tool for reviewing agent-generated markdown plans
interactively.

### Added

- **Broker daemon** (`packages/broker`) — an always-on Bun message broker, file
  watcher, and durable SQLite store, run as a macOS LaunchAgent. The questions
  table doubles as a crash-safe work queue; feedback is persisted and surfaced to
  the agent without waking it.
- **CLI** (`packages/cli`, `plan-review`) — the agent surface (`attach` / `wait` /
  `answer` / `rework-done`), the user surface (`open`), and daemon management
  (`install` / `uninstall` / `restart` / `status`), plus `setup` / `teardown`.
- **Viewer** (`apps/viewer`) — a Tauri v2 + React 19 desktop app with live markdown
  render, a collapsible contents rail with scroll-spy, line/range selection with a
  hover gutter and inline composer, anchored & general Ask/Comment, and an animated
  collapsible sidebar. Dark-mode only, built on shadcn/ui over Tailwind v4.
- **Threaded Q&A** — follow-up questions that inherit their parent's thread and
  anchor, and review items created from a Q&A exchange that cite their source
  question.
- **Review batching** — anchored and general feedback queued and submitted as one
  batch; the agent reworks the plan only on finalize. Resolved feedback is retired
  and tagged with the doc version it was written against.
- **One-command setup** via Bun lifecycle hooks (`preinstall` toolchain checks +
  `postinstall` symlinks + daemon + viewer build), with `teardown` to reverse it.
- **One app, many plans** — every plan opens as a window of a single named
  `Plan Review` macOS `.app` via `tauri-plugin-single-instance`; the viewer
  auto-rebuilds when its source is newer than the built binary.
- **Headless agent spawner** — user-opened plans (no attached agent) spawn a fresh
  headless Claude agent seeded with the file + prior review history.
- **Structured logging** (pino) across broker, spawner, and entry point.
- **Browser dev + mock mode** for UI iteration without a backend.

### Docs

- README with architecture diagram, setup/uninstall, development, and
  troubleshooting; PolyForm Internal Use license and contributing guide.

[Unreleased]: https://github.com/GeromeSchutte/md-reviewer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/GeromeSchutte/md-reviewer/releases/tag/v0.1.0
