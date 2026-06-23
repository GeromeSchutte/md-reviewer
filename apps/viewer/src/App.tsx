import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Anchor, FeedbackRecord, LifecycleState, QuestionRecord, ReworkResult } from "@plan-review/shared";
import { MarkdownView } from "./components/MarkdownView";
import type { CapturedSelection } from "./selection";
import { resolveSession } from "./launch";
import {
  askQuestion,
  endSession,
  leaveFeedback,
  removeFeedback,
  retryQuestion,
  submitReview,
  subscribe,
} from "./broker";

type Tab = "qa" | "review";
interface ComposerState {
  mode: "ask" | "feedback";
  anchor: Anchor | null;
}

const STATE_META: Record<LifecycleState, { label: string; cls: string; busy?: boolean }> = {
  "no-agent": { label: "No agent", cls: "bg-gray-200 text-gray-700" },
  "waiting-for-review": { label: "Ready", cls: "bg-green-100 text-green-800" },
  "agent-thinking": { label: "Answering…", cls: "bg-blue-100 text-blue-800", busy: true },
  reworking: { label: "Reworking…", cls: "bg-amber-100 text-amber-800", busy: true },
  finalized: { label: "Finalized", cls: "bg-gray-200 text-gray-700" },
  "agent-disconnected": { label: "Agent offline", cls: "bg-red-100 text-red-800" },
};

function anchorLabel(a: Anchor | null): string {
  if (!a) return "general";
  const { startLine, endLine } = a.lineRange;
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
}

export default function App() {
  const [sid, setSid] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const [questions, setQuestions] = useState<QuestionRecord[]>([]);
  const [feedback, setFeedback] = useState<FeedbackRecord[]>([]);
  const [state, setState] = useState<LifecycleState>("no-agent");
  const [reworkResult, setReworkResult] = useState<ReworkResult | null>(null);
  const [tab, setTab] = useState<Tab>("review");
  const [selection, setSelection] = useState<CapturedSelection | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [reviewNote, setReviewNote] = useState("");

  // --- bootstrap session ---
  useEffect(() => {
    resolveSession()
      .then((s) => (s ? setSid(s) : setBootError("No session. Launch via `plan-review open <file.md>`.")))
      .catch((e) => setBootError(String(e)));
  }, []);

  // --- subscribe to the broker stream ---
  useEffect(() => {
    if (!sid) return;
    const upsertQuestion = (id: string, patch: Partial<QuestionRecord>) =>
      setQuestions((qs) => {
        const i = qs.findIndex((q) => q.id === id);
        if (i === -1) return [...qs, { id, ...patch } as QuestionRecord];
        const next = [...qs];
        next[i] = { ...next[i]!, ...patch };
        return next;
      });

    const dispose = subscribe(
      sid,
      (e) => {
        setConnected(true);
        switch (e.type) {
          case "doc":
            setMarkdown(e.markdown);
            break;
          case "annotations":
            setQuestions(e.questions);
            setFeedback(e.feedback);
            break;
          case "answer":
            upsertQuestion(e.questionId, { answerMarkdown: e.markdown, status: "answered" });
            break;
          case "qa-status":
            upsertQuestion(e.id, { status: e.status, errorMessage: e.error ?? null });
            break;
          case "state":
            setState(e.state);
            if (e.reworkResult) setReworkResult(e.reworkResult);
            break;
          case "feedback-ack":
            setFeedback((fs) => (fs.some((f) => f.id === e.feedback.id) ? fs : [...fs, e.feedback]));
            break;
          case "feedback-removed":
            setFeedback((fs) => fs.filter((f) => f.id !== e.id));
            break;
          case "agent-disconnected":
            setState("agent-disconnected");
            break;
        }
      },
      () => setConnected(false),
    );
    return dispose;
  }, [sid]);

  const onSelect = useCallback((sel: CapturedSelection | null) => setSelection(sel), []);

  const submitComposer = useCallback(
    async (text: string) => {
      if (!sid || !composer) return;
      if (composer.mode === "ask") {
        const id = await askQuestion(sid, composer.anchor, text);
        setQuestions((qs) => [
          ...qs,
          {
            id,
            abspath: "",
            anchor: composer.anchor,
            docVersion: "",
            text,
            createdAt: Date.now(),
            status: "queued",
            answerMarkdown: null,
            answeredAt: null,
            errorMessage: null,
            agentSource: null,
          },
        ]);
        setTab("qa");
      } else {
        await leaveFeedback(sid, composer.anchor, text);
        setTab("review");
      }
      setComposer(null);
      setSelection(null);
      window.getSelection()?.removeAllRanges();
    },
    [sid, composer],
  );

  const openComposer = (mode: "ask" | "feedback", anchor: Anchor | null) => {
    setComposer({ mode, anchor });
    setSelection(null);
  };

  const meta = STATE_META[state];
  const queuedFeedback = useMemo(() => feedback.filter((f) => f.status === "queued"), [feedback]);

  if (bootError) return <Centered>{bootError}</Centered>;
  if (!sid) return <Centered>Connecting…</Centered>;

  return (
    <div className="flex h-full flex-col bg-white text-gray-900">
      {/* header */}
      <header className="flex items-center gap-3 border-b border-gray-200 px-4 py-2">
        <span className="font-semibold">Plan Review</span>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
          {meta.busy && <Spinner />} {meta.label}
        </span>
        {!connected && <span className="text-xs text-red-600">disconnected</span>}
        <div className="ml-auto flex gap-2">
          <button className="btn" onClick={() => openComposer("ask", null)}>
            Ask (general)
          </button>
          <button className="btn" onClick={() => openComposer("feedback", null)}>
            Comment (general)
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* document */}
        <main className="min-w-0 flex-1 overflow-auto">
          <MarkdownView markdown={markdown} onSelect={onSelect} />
        </main>

        {/* sidebar */}
        <aside className="flex w-[380px] flex-col border-l border-gray-200">
          <div className="flex border-b border-gray-200 text-sm">
            <TabButton active={tab === "review"} onClick={() => setTab("review")}>
              Review ({queuedFeedback.length})
            </TabButton>
            <TabButton active={tab === "qa"} onClick={() => setTab("qa")}>
              Q&A ({questions.length})
            </TabButton>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {tab === "qa" ? (
              <QAList sid={sid} questions={questions} />
            ) : (
              <ReviewList sid={sid} feedback={feedback} />
            )}
          </div>
          {tab === "review" && (
            <ReviewBar
              sid={sid}
              state={state}
              reworkResult={reworkResult}
              reviewNote={reviewNote}
              setReviewNote={setReviewNote}
              count={queuedFeedback.length}
            />
          )}
        </aside>
      </div>

      {/* floating selection toolbar */}
      {selection && !composer && (
        <div
          className="fixed z-20 flex gap-1 rounded-md border border-gray-300 bg-white p-1 shadow-lg"
          style={{ top: selection.rect.bottom + 6, left: selection.rect.left }}
        >
          <span className="px-1 py-0.5 text-xs text-gray-500">{anchorLabel(selection.anchor)}</span>
          <button className="btn" onClick={() => openComposer("ask", selection.anchor)}>
            Ask
          </button>
          <button className="btn" onClick={() => openComposer("feedback", selection.anchor)}>
            Comment
          </button>
        </div>
      )}

      {composer && (
        <Composer
          mode={composer.mode}
          anchor={composer.anchor}
          onSubmit={submitComposer}
          onCancel={() => setComposer(null)}
        />
      )}
    </div>
  );
}

function ReviewBar({
  sid,
  state,
  reworkResult,
  reviewNote,
  setReviewNote,
  count,
}: {
  sid: string;
  state: LifecycleState;
  reworkResult: ReworkResult | null;
  reviewNote: string;
  setReviewNote: (s: string) => void;
  count: number;
}) {
  const reworking = state === "reworking";
  return (
    <div className="border-t border-gray-200 p-3">
      <textarea
        className="mb-2 w-full resize-none rounded border border-gray-300 p-2 text-sm"
        rows={2}
        placeholder="Overall review note (optional)…"
        value={reviewNote}
        onChange={(e) => setReviewNote(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <button
          className="btn-primary"
          disabled={reworking}
          onClick={() => submitReview(sid, reviewNote.trim() || null).then(() => setReviewNote(""))}
        >
          Submit review {count > 0 ? `(${count})` : ""}
        </button>
        <button className="btn" onClick={() => endSession(sid)}>
          End
        </button>
        {reworking && (
          <span className="text-xs text-amber-700">
            <Spinner /> reworking…
          </span>
        )}
        {reworkResult === "success" && !reworking && <span className="text-xs text-green-700">reworked ✓</span>}
        {reworkResult === "error" && !reworking && <span className="text-xs text-red-700">rework failed</span>}
      </div>
    </div>
  );
}

function QAList({ sid, questions }: { sid: string; questions: QuestionRecord[] }) {
  if (questions.length === 0) return <Empty>No questions yet. Select text or use “Ask”.</Empty>;
  return (
    <ul className="space-y-3">
      {[...questions].reverse().map((q) => (
        <li key={q.id} className="rounded border border-gray-200 p-2 text-sm">
          <div className="mb-1 flex items-center gap-2">
            <QStatus status={q.status} />
            <span className="text-xs text-gray-500">{anchorLabel(q.anchor)}</span>
            {q.status === "error" && (
              <button className="btn ml-auto" onClick={() => retryQuestion(sid, q.id)}>
                Retry
              </button>
            )}
          </div>
          <div className="font-medium">{q.text}</div>
          {q.answerMarkdown && (
            <div className="md-body mt-2 border-t border-gray-100 pt-2 text-gray-700">
              <Markdown remarkPlugins={[remarkGfm]}>{q.answerMarkdown}</Markdown>
            </div>
          )}
          {q.status === "error" && q.errorMessage && <div className="mt-1 text-xs text-red-600">{q.errorMessage}</div>}
        </li>
      ))}
    </ul>
  );
}

function ReviewList({ sid, feedback }: { sid: string; feedback: FeedbackRecord[] }) {
  const active = feedback.filter((f) => f.status === "queued" || f.status === "submitted");
  if (active.length === 0) return <Empty>No feedback yet. Select text or use “Comment”.</Empty>;
  return (
    <ul className="space-y-2">
      {[...active].reverse().map((f) => (
        <li key={f.id} className="rounded border border-gray-200 p-2 text-sm">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs text-gray-500">{anchorLabel(f.anchor)}</span>
            <span className="rounded bg-gray-100 px-1 text-[10px] uppercase text-gray-500">{f.status}</span>
            {f.status === "queued" && (
              <button className="btn ml-auto" onClick={() => removeFeedback(sid, f.id)}>
                Remove
              </button>
            )}
          </div>
          <div>{f.text}</div>
        </li>
      ))}
    </ul>
  );
}

function Composer({
  mode,
  anchor,
  onSubmit,
  onCancel,
}: {
  mode: "ask" | "feedback";
  anchor: Anchor | null;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30" onClick={onCancel}>
      <div className="w-[480px] rounded-lg bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 font-medium">
          {mode === "ask" ? "Ask a question" : "Leave feedback"}{" "}
          <span className="text-sm font-normal text-gray-500">({anchorLabel(anchor)})</span>
        </div>
        <textarea
          ref={ref}
          className="h-28 w-full resize-none rounded border border-gray-300 p-2 text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && text.trim()) onSubmit(text.trim());
          }}
          placeholder={mode === "ask" ? "What would you like to ask?" : "Your feedback…"}
        />
        <div className="mt-2 flex justify-end gap-2">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!text.trim()} onClick={() => onSubmit(text.trim())}>
            {mode === "ask" ? "Ask" : "Add feedback"}
          </button>
        </div>
      </div>
    </div>
  );
}

const Q_STATUS: Record<QuestionRecord["status"], { label: string; cls: string; busy?: boolean }> = {
  queued: { label: "queued", cls: "text-gray-500", busy: true },
  "in-progress": { label: "answering", cls: "text-blue-600", busy: true },
  answered: { label: "answered", cls: "text-green-700" },
  error: { label: "error", cls: "text-red-600" },
};
function QStatus({ status }: { status: QuestionRecord["status"] }) {
  const s = Q_STATUS[status];
  return (
    <span className={`flex items-center gap-1 text-xs font-medium ${s.cls}`}>
      {s.busy ? <Spinner /> : status === "answered" ? "✓" : "!"} {s.label}
    </span>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={`flex-1 px-3 py-2 ${active ? "border-b-2 border-blue-600 font-medium text-blue-700" : "text-gray-500"}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const Spinner = () => (
  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
);
const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="mt-6 text-center text-sm text-gray-400">{children}</div>
);
const Centered = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full items-center justify-center p-6 text-center text-gray-600">{children}</div>
);
