# Threads in Q&A — investigation

What it would take to (1) ask **follow-up questions** off an answer and (2) **rework the plan from a Q&A exchange**.

> **Status — design only, approved for build.** Nothing in this doc is implemented yet: clicking a question card in the viewer does nothing today because the follow-up/threads UX below is a *plan*, not shipped behavior. The only shipped change so far is an unrelated fix to the **End-session** confirmation (it now offers to submit un-submitted review before ending). Both tiers below are **approved** — Tier 1 is the next thing to build.

## Where we are today

Q&A is **flat**. Each `QuestionRecord` is independent — `{id, abspath, anchor, docVersion, text, status, answerMarkdown, …}` — with no parent/thread linkage (`records.ts`). The `questions` table doubles as the agent work-queue: `status` is the cursor (`queued → in-progress → answered|error`), and `collectBatch()` flips all queued questions to in-progress and hands them to the agent (`broker.ts`). The viewer renders each question as an isolated card with its answer below (`App.tsx · QAList`).

A hard architectural invariant runs through the README + `SKILL.md`:

> **Questions are read-only.** They never mutate the plan and never trigger a rework. Reworks happen **only** via the feedback batch on `finalize`; feedback is trigger-decoupled and never wakes the agent on its own.

So the two asks split cleanly:

- **Follow-ups** extend the Q&A model — and can ride entirely on existing rails.
- **Rework-from-an-answer** crosses the read-only line — it's the one real design decision.

## The key realisation

A `QuestionRecord` is *already* a (question + answer) pair with its own status. A **thread is just an ordered set of these pairs sharing a thread identity.** So a follow-up is a **new `QuestionRecord` that points at the one it follows** — and it reuses the entire existing pipeline: work-queue, status machine, `answer()`, retry, `qa-status` SSE, the `annotations` snapshot. No new status, no new event type, no new lifecycle state.

## Tier 1 — Follow-up questions (self-contained, no invariant change)

### Data
- `QuestionRecord` += `threadId: string` (the root question's id; a root's `threadId` is its own id) and `parentId: string | null`. `threadId` does the grouping work; `parentId` records the exact turn replied to.

### Broker
- `createQuestion(sid, anchor, text, parentId?)`: if `parentId` is set, look up the parent and **inherit its anchor + `threadId`** (don't trust the viewer to resend — a thread keeps one stable anchor); else mint a new `threadId`.
- `collectBatch()`: when emitting a question whose thread has prior turns, attach the **thread transcript** to the event (assembled from the store).

### Why the transcript must travel in the event
The agent's own Claude context *might* still hold the earlier exchange — but not for a **spawned** (headless) agent, a **reattached** agent after disconnect, or a **context-compacted** session. The broker is the source of truth, so `QuestionEvent` += `thread: {text, answerMarkdown}[]` (prior answered turns, oldest→newest; empty for a root). `SKILL.md` gets one line: *"if `thread` is non-empty, answer the follow-up in light of those turns."*

### Protocol / events
- `CreateQuestionRequest` += `parentId?`.
- `QuestionEvent` += `thread`.
- `AnnotationsEvent` already ships full `QuestionRecord[]`, so `threadId`/`parentId` reach the viewer **for free**.

### Store
- **Migration is the highest-risk piece** — see [Migration](#migration-the-one-thing-with-no-precedent).
- `insert`/`rowToQuestion` map the new columns; add a `listThread(threadId)` helper for transcript assembly.

### CLI
- **No change** for follow-ups — the agent reads a richer event and answers exactly as before.

### Viewer
- `QAList`: group questions by `threadId`, render each thread as a stacked conversation.
- Engaging with an answered turn opens the **same composer you already have on a line** (`ComposerBody`, with its Question/Review toggle). In **Question** mode it posts a follow-up with `parentId`.
- `askQuestion(sid, anchor, text, parentId?)` in `broker.ts`; a threaded fixture in `mock.ts`.
- **Build this mock-first.** The interaction (click a card → focused composer with a source indicator) is the part most likely to need design iteration, so prototype it against the `?mock` fixture until the look *and* feel are nailed, *then* wire the broker. The fixture must seed a question thread + a follow-up so the conversation rendering and the click-to-attach gesture are both exercised.
- **Group defensively:** `upsertQuestion` builds skeleton records from `qa-status`/`answer` frames with only the patched fields, so `threadId` is briefly absent until the `annotations` snapshot lands. Treat a missing `threadId` as its own root, or an optimistic follow-up flickers ungrouped.

## Tier 2 — Review item from a Q&A exchange (confirmed: batched, not immediate)

**Decision (resolved).** Acting on an answer **never reworks the plan immediately.** Engaging with an answered question opens the *same composer you already have on a line* — the **Question / Review toggle** — and you pick before posting:

- **Question** → a follow-up (Tier 1), threaded under the source.
- **Review** → a feedback item that flows through the normal **Submit-review batch**.

In **both** cases the new item carries an **identifier of the source question** — it is **not** pre-filled with the answer body. The source renders as a **removable indicator while drafting** (scroll-into-view / detach) and as a **read-only indicator on the posted card** (scroll-into-view). (Immediate one-click "rework now" is explicitly **out of scope**.)

### How the review item reaches the rework agent
- `FeedbackRecord` += `sourceQuestionId: string | null`. The review item **inherits the source question's anchor** (so it still anchors to plan lines) and records the back-reference.
- The user's input is **only what they type** — no answer-body pre-fill.
- But the rework agent must not work blind: a spawned/compacted agent never saw the thread. So at `finalize` the broker **resolves the `sourceQuestionId` into the batch item** — `PendingFeedback` += `sourceQuestion?: {id, text, answerMarkdown}`. The identifier is what's stored and shown; the broker does the lookup and hands the agent the resolved Q&A, so the input stays clean *and* the agent has the context.
- *Alternative considered:* a `plan-review question <sid> <id>` CLI verb for on-demand lookup. More surface, and it risks blind rework if the agent skips it — so resolving server-side into the event is preferred.
- `SKILL.md`: one line — *"a feedback item may carry `sourceQuestion`; treat it as the context the change came from."*

### Viewer — composer interaction
The **source question is a composer attachment, exactly like the line anchor is today.**

- **Clicking a question card attaches its reference to the input** ("populates its link").
- While drafting, the composer shows a **removable source indicator**: click it to **scroll the source question into view**, or **×** to **detach** (the item reverts to a plain note).
- The composer keeps its **Question / Review toggle** (`ComposerBody`): with a source attached, **Question** posts a follow-up (`parentId`), **Review** posts feedback (`sourceQuestionId`); either way the item **inherits the source's anchor**.
- The **posted card** carries a read-only **"from Q&A" indicator**; clicking switches to the Q&A tab and scrolls/highlights the source question.
- *To pin down:* "click a question → populate the input" implies a **standing composer** (a chat-style input in the Q&A panel), not today's ephemeral per-line / "New note" popovers. Recommend a persistent composer at the foot of the Q&A tab so the click-to-attach gesture has somewhere to land.

## Migration — the one thing with no precedent

`migrate()` today only runs `CREATE TABLE IF NOT EXISTS`, which reaches **fresh** DBs only. The live `~/.plan-review/store.sqlite` needs `ALTER TABLE … ADD COLUMN` on **both** tables — `questions` (`thread_id`, `parent_id`) and `feedback` (`source_question_id`). SQLite has **no** `ADD COLUMN IF NOT EXISTS`, so guard it: read `PRAGMA table_info(<table>)`, add each missing column. `ADD COLUMN` is online and safe. This is the only piece with no pattern to copy in the repo — write it carefully and test it against a pre-existing DB.

## Other risks / notes

- **Stale anchors across reworks.** A thread anchored at `docVersion` X may not map cleanly after a rework shifts line numbers. The `QuoteSelector` field exists for exactly this ("v2 re-locate across reworks") but is **unused** today. Threading raises the priority of that v2 work; not a blocker for Tier 1.
- **Work-queue batching.** `collectBatch()` flips *all* queued questions to in-progress at once; a follow-up and an unrelated new question can batch together. Fine — just assemble the transcript **per question**.
- **No deadlocks.** Follow-ups are only created post-answer (the viewer exposes "reply" on answered turns only), so a queued follow-up always has an answered parent. Transcript assembly should still tolerate an unanswered parent (include only answered turns).

## Touch-point summary

| Layer | File | Tier 1 (follow-ups) | Tier 2 (review item from Q&A) |
| --- | --- | --- | --- |
| Data | `shared/records.ts` | `threadId`, `parentId` on `QuestionRecord` | `sourceQuestionId` on `FeedbackRecord` |
| Protocol | `shared/protocol.ts` | `parentId?` on `CreateQuestionRequest` | `sourceQuestionId?` on `CreateFeedbackRequest` |
| Events | `shared/events.ts` | `thread[]` on `QuestionEvent` | `sourceQuestion?` (resolved) on `PendingFeedback` |
| Store | `broker/store.ts` | **guarded ALTER migration**, map new cols, `listThread()` | guarded ALTER + map `source_question_id` |
| Broker | `broker/broker.ts` | anchor/thread inheritance, transcript assembly | inherit source anchor; resolve `sourceQuestion` into finalize batch |
| CLI | `cli/*` | none | none |
| Skill | `skills/plan-review/SKILL.md` | one line re: `thread` | one line re: `sourceQuestion` |
| Viewer | `viewer/App.tsx`, `Composer.tsx`, `broker.ts`, `mock.ts` | thread grouping + Question/Review composer on a question + defensive grouping | "from Q&A" indicator + scroll-to-source |
| Tests | `broker/test/*` | inherit anchor+thread, transcript, **migration on pre-existing DB** | feedback carries `sourceQuestionId`; finalize resolves `sourceQuestion` |

## Recommended path

*Both tiers approved for build (see Status, top). Sequence:*

1. **Tier 1** end-to-end (follow-ups) — self-contained, no invariant change, satisfies "ask a follow-up." Start here, mock-first.
2. **Tier 2** (review item from Q&A) — engaging with an answer can post a follow-up **or** a `sourceQuestionId`-tagged review item into the normal batch. Invariant preserved; the broker resolves the source Q&A for the rework agent so nothing reworks blind.

Both tiers share one composer (the existing Question/Review toggle) and one rework engine (`finalize`). The bulk of the new logic is the **guarded SQLite migration** and the **viewer's thread grouping + source-question cross-linking** — everything else rides existing rails.
