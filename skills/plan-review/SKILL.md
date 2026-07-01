---
name: plan-review
description: Open a generated markdown plan/document in the live Plan Review viewer for interactive review. Use this right after you write or substantially revise a markdown plan, design doc, spec, or report file that the user should review — it lets them read it formatted, select lines to ask questions (answered from your live context), and leave anchored feedback that you then rework in a single batch. Triggers whenever you have just produced a reviewable .md artifact and want the user to review it before you continue. This is also the review surface for plan mode: when you call ExitPlanMode, a hook opens your plan file in the viewer and redirects you here — attach to the already-open session (its message gives you the session id and plan-file path) and run the review loop instead of presenting the plan inline, then call ExitPlanMode again once the review ends to begin implementing.
---

# Plan Review

This skill runs an interactive review loop over a markdown file using the Plan Review tool (an always-on broker daemon + a desktop viewer). You answer the user's questions from your live context and apply their batched feedback when they submit the review.

The CLI is invoked as `~/.claude/scripts/plan-review <command>` (referred to below as `plan-review`). When you are spawned by the broker for a user-opened file, the seed message gives you the exact command path, the session id, and the absolute plan path — skip step 1 and use those.

## Plan mode: review your plan here, don't present it inline

In plan mode you write your implementation plan to the plan file named in the plan-mode system message (`~/.claude/plans/<slug>.md`). When you then call `ExitPlanMode`, a hook intercepts it, opens that plan file in the viewer, and redirects you here with a session id — so the plan gets reviewed interactively instead of dumped into the terminal. When you arrive from that redirect:

- **Don't present the plan inline.** The viewer is already open on your plan file; the hook's message gives you the `sid` and the exact plan-file path. Skip step 1 (opening) — the hook already did it.
- **Attach and run the loop.** Attach with `--source agent`, then follow steps 2–3 below. On `finalize`, reworking means editing the plan file directly — that's permitted in plan mode, and the viewer live-updates from it.
- **Exit once the review ends.** After the `end` event, call `ExitPlanMode` again to leave plan mode and start implementing. The hook allows this second call — it's the go/no-go gate on an already-reviewed plan, not another inline review.

## 1. Open the file for review (agent-initiated only)

```
plan-review open <absolute-plan-path> --json
```

This ensures the broker is running, creates a session, launches the viewer, and prints `{"sid": "...", "abspath": "..."}`. Capture the `sid`.

## 2. Attach as the review agent

```
plan-review attach <sid> --path <absolute-plan-path> --source agent
```

(Use `--source spawned` if you were spawned by the broker.)

## 3. Wait for review activity

Reviews take a long time. **Do not sit in a foreground poll loop** — that pins your turn and, once the empty holds pile up, you eventually give up mid-review. Instead, wait on `wait-until`, which blocks until there is *actually* work and only then returns a batch:

```
plan-review wait-until <sid>
```

`wait-until` internally re-polls the broker (no tokens, no LLM) and returns `{"events": [ ... ]}` the instant a question or finalize arrives; it never returns an empty batch. How you run it depends on who you are:

- **Interactive agent (`--source agent`, you wrote this plan):** run `wait-until` **as a background task** and then **end your turn** — this hands the terminal back to the user. When work arrives, `wait-until` exits and you are re-invoked *in this same session*, so you answer from your live context. Handle the batch, background another `wait-until`, and end your turn again. Loop this way until an `end` event.
  - If your harness does not re-invoke you when a background command finishes, fall back to running `wait-until` in the **foreground with the maximum Bash timeout** (`timeout: 600000`). It blocks cleanly until real work (no churn, no giving up); re-issue it after each batch. This pins your turn but is still far better than the old empty-hold loop.
- **Spawned worker (`--source spawned`, the broker started you for a user-opened file):** the broker **pushes** work to you as messages. On start, run `wait-until <sid>` **once** to drain anything already pending and handle it, then **stop and wait** — the broker will send you a message when there is new work; run `wait-until <sid>` again then. Do not poll on your own. Stop permanently on an `end` event.

Whichever mode you're in: handle each batch **in order**, and never run a plain `wait`/`wait-until` on a short Bash timeout in the foreground (the default ~2-min timeout is shorter than the broker's hold and gets your command killed mid-wait).

- **`{"type":"question", "id", "anchor", "text", "pendingFeedback":[...], "thread":[...]}`** — Answer it from your context and the plan. The `anchor` (if present) is the `{startLine,endLine}` the user selected; `pendingFeedback` is the feedback they have left so far (so you don't contradict it). `thread` is the prior answered turns in this question's conversation (`[{text, answerMarkdown}, …]`, oldest→newest, empty for a first question) — when it's non-empty you're answering a **follow-up**, so answer in light of those turns. Post your answer as markdown via stdin:

  ```
  plan-review answer <sid> <question-id> <<'ANSWER'
  ...your markdown answer...
  ANSWER
  ```

  If you genuinely cannot answer, report an error instead: `plan-review answer <sid> <question-id> --error "why"`.

- **`{"type":"finalize", "batch":[...], "reviewNote": "..."}`** — The user submitted their review. `batch` is every feedback comment (each with optional `anchor` and `text`, and an optional `sourceQuestion` — `{id, text, answerMarkdown}` — when the comment was raised from a Q&A exchange, so you have that context for the rework); `reviewNote` is their overall note (may be null). **Rework the plan file** at the absolute plan path to address all of it, editing the file directly. When done:

  ```
  plan-review rework-done <sid>
  ```

  (On failure: `plan-review rework-done <sid> --error "why"`.) The viewer updates live from the file. Then continue the loop — the user may keep reviewing the reworked plan.

- **`{"type":"end"}`** — The review is over. Stop for good — do not wait again.

## Rules

- After handling a batch, wait again per your mode above (background `wait-until` + end turn if you're the interactive agent; wait for the broker's next message if you're a spawned worker). Do not stop until an `end` event.
- Never busy-loop plain `wait` in the foreground on a short timeout — use `wait-until` (it only returns when there's work) and background it (or give it the max `600000` Bash timeout) so your command isn't killed mid-wait and you don't give up during a long review.
- Feedback never arrives as its own event — you only act on it inside `finalize`. Questions are answered immediately and never trigger a rework.
- Answer questions from your own context; you do not need to re-derive everything from the file.
