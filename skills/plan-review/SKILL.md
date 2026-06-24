---
name: plan-review
description: Open a generated markdown plan/document in the live Plan Review viewer for interactive review. Use this right after you write or substantially revise a markdown plan, design doc, spec, or report file that the user should review — it lets them read it formatted, select lines to ask questions (answered from your live context), and leave anchored feedback that you then rework in a single batch. Triggers whenever you have just produced a reviewable .md artifact and want the user to review it before you continue. Also triggers when finishing plan mode (before or instead of ExitPlanMode): write the plan to a .md file and open it here for interactive review rather than presenting it inline.
---

# Plan Review

This skill runs an interactive review loop over a markdown file using the Plan Review tool (an always-on broker daemon + a desktop viewer). You answer the user's questions from your live context and apply their batched feedback when they submit the review.

The CLI is invoked as `~/.claude/scripts/plan-review <command>` (referred to below as `plan-review`). When you are spawned by the broker for a user-opened file, the seed message gives you the exact command path, the session id, and the absolute plan path — skip step 1 and use those.

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

## 3. Run the wait-loop

Repeatedly call:

```
plan-review wait <sid>
```

This long-polls (up to ~4 minutes) and prints `{"events": [ ... ]}`. Handle the batch **in order**, then **immediately call `wait` again**. Only stop when you receive an `end` event.

- **`{"type":"question", "id", "anchor", "text", "pendingFeedback":[...]}`** — Answer it from your context and the plan. The `anchor` (if present) is the `{startLine,endLine}` the user selected; `pendingFeedback` is the feedback they have left so far (so you don't contradict it). Post your answer as markdown via stdin:

  ```
  plan-review answer <sid> <question-id> <<'ANSWER'
  ...your markdown answer...
  ANSWER
  ```

  If you genuinely cannot answer, report an error instead: `plan-review answer <sid> <question-id> --error "why"`.

- **`{"type":"finalize", "batch":[...], "reviewNote": "..."}`** — The user submitted their review. `batch` is every feedback comment (each with optional `anchor` and `text`); `reviewNote` is their overall note (may be null). **Rework the plan file** at the absolute plan path to address all of it, editing the file directly. When done:

  ```
  plan-review rework-done <sid>
  ```

  (On failure: `plan-review rework-done <sid> --error "why"`.) The viewer updates live from the file. Then continue the loop — the user may keep reviewing the reworked plan.

- **`{"type":"end"}`** — The review is over. Stop the loop.

- **Empty `events`** — The hold timed out with nothing pending. Immediately call `wait` again.

## Rules

- Always re-poll with `wait` after handling a batch. Do not stop until an `end` event.
- Feedback never arrives as its own event — you only act on it inside `finalize`. Questions are answered immediately and never trigger a rework.
- Answer questions from your own context; you do not need to re-derive everything from the file.
