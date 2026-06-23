import { useCallback, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Anchor, FeedbackRecord, LifecycleState, QuestionRecord, ReworkResult } from "@plan-review/shared";
import { MarkdownView } from "./components/MarkdownView";
import type { CapturedSelection } from "./selection";
import { resolveSession } from "./launch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
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

// Token-based status chips. `cls` overrides the outline Badge's color via tailwind-merge.
const STATE_META: Record<LifecycleState, { label: string; cls: string; busy?: boolean }> = {
  "no-agent": { label: "No agent", cls: "border-transparent bg-muted text-muted-foreground" },
  "waiting-for-review": { label: "Ready", cls: "border-success/30 bg-success/15 text-success" },
  "agent-thinking": { label: "Answering…", cls: "border-info/30 bg-info/15 text-info", busy: true },
  reworking: { label: "Reworking…", cls: "border-warning/30 bg-warning/15 text-warning", busy: true },
  finalized: { label: "Finalized", cls: "border-transparent bg-muted text-muted-foreground" },
  "agent-disconnected": { label: "Agent offline", cls: "border-destructive/40 bg-destructive/15 text-destructive" },
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
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* header */}
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        <span className="font-semibold">Plan Review</span>
        <Badge variant="outline" className={cn("gap-1 font-medium", meta.cls)}>
          {meta.busy && <Spinner />} {meta.label}
        </Badge>
        {!connected && <span className="text-xs text-destructive">disconnected</span>}
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => openComposer("ask", null)}>
            Ask (general)
          </Button>
          <Button variant="outline" size="sm" onClick={() => openComposer("feedback", null)}>
            Comment (general)
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* document */}
        <main className="min-w-0 flex-1 overflow-auto">
          <MarkdownView markdown={markdown} onSelect={onSelect} />
        </main>

        {/* sidebar */}
        <aside className="flex w-[380px] flex-col border-l border-border">
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as Tab)}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <div className="border-b border-border p-2">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="review">Review {queuedFeedback.length > 0 && `(${queuedFeedback.length})`}</TabsTrigger>
                <TabsTrigger value="qa">Q&A {questions.length > 0 && `(${questions.length})`}</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="review" className="flex min-h-0 flex-col">
              <div className="min-h-0 flex-1 overflow-auto p-3">
                <ReviewList sid={sid} feedback={feedback} />
              </div>
              <ReviewBar
                sid={sid}
                state={state}
                reworkResult={reworkResult}
                reviewNote={reviewNote}
                setReviewNote={setReviewNote}
                count={queuedFeedback.length}
              />
            </TabsContent>
            <TabsContent value="qa" className="min-h-0">
              <div className="h-full overflow-auto p-3">
                <QAList sid={sid} questions={questions} />
              </div>
            </TabsContent>
          </Tabs>
        </aside>
      </div>

      {/* floating selection toolbar */}
      {selection && !composer && (
        <div
          className="fixed z-20 flex items-center gap-1 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
          style={{ top: selection.rect.bottom + 6, left: selection.rect.left }}
        >
          <span className="px-1 py-0.5 text-xs text-muted-foreground">{anchorLabel(selection.anchor)}</span>
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => openComposer("ask", selection.anchor)}>
            Ask
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => openComposer("feedback", selection.anchor)}
          >
            Comment
          </Button>
        </div>
      )}

      <Dialog open={!!composer} onOpenChange={(open) => !open && setComposer(null)}>
        <DialogContent className="sm:max-w-lg">
          {composer && <ComposerForm mode={composer.mode} anchor={composer.anchor} onSubmit={submitComposer} />}
        </DialogContent>
      </Dialog>
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
    <div className="border-t border-border p-3">
      <Textarea
        className="mb-2 resize-none"
        rows={2}
        placeholder="Overall review note (optional)…"
        value={reviewNote}
        onChange={(e) => setReviewNote(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={reworking}
          onClick={() => submitReview(sid, reviewNote.trim() || null).then(() => setReviewNote(""))}
        >
          Submit review {count > 0 ? `(${count})` : ""}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => endSession(sid)}>
          End
        </Button>
        {reworking && (
          <span className="flex items-center gap-1 text-xs text-warning">
            <Spinner /> reworking…
          </span>
        )}
        {reworkResult === "success" && !reworking && <span className="text-xs text-success">reworked ✓</span>}
        {reworkResult === "error" && !reworking && <span className="text-xs text-destructive">rework failed</span>}
      </div>
    </div>
  );
}

function QAList({ sid, questions }: { sid: string; questions: QuestionRecord[] }) {
  if (questions.length === 0) return <Empty>No questions yet. Select text or use “Ask”.</Empty>;
  return (
    <ul className="space-y-3">
      {[...questions].reverse().map((q) => (
        <li key={q.id} className="rounded-md border border-border bg-card p-2 text-sm">
          <div className="mb-1 flex items-center gap-2">
            <QStatus status={q.status} />
            <span className="text-xs text-muted-foreground">{anchorLabel(q.anchor)}</span>
            {q.status === "error" && (
              <Button variant="ghost" size="sm" className="ml-auto h-6 px-2" onClick={() => retryQuestion(sid, q.id)}>
                Retry
              </Button>
            )}
          </div>
          <div className="font-medium">{q.text}</div>
          {q.answerMarkdown && (
            <div className="md-body mt-2 border-t border-border pt-2 text-foreground/80">
              <Markdown remarkPlugins={[remarkGfm]}>{q.answerMarkdown}</Markdown>
            </div>
          )}
          {q.status === "error" && q.errorMessage && (
            <div className="mt-1 text-xs text-destructive">{q.errorMessage}</div>
          )}
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
        <li key={f.id} className="rounded-md border border-border bg-card p-2 text-sm">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{anchorLabel(f.anchor)}</span>
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] uppercase">
              {f.status}
            </Badge>
            {f.status === "queued" && (
              <Button variant="ghost" size="sm" className="ml-auto h-6 px-2" onClick={() => removeFeedback(sid, f.id)}>
                Remove
              </Button>
            )}
          </div>
          <div>{f.text}</div>
        </li>
      ))}
    </ul>
  );
}

function ComposerForm({
  mode,
  anchor,
  onSubmit,
}: {
  mode: "ask" | "feedback";
  anchor: Anchor | null;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <>
      <DialogHeader>
        <DialogTitle>{mode === "ask" ? "Ask a question" : "Leave feedback"}</DialogTitle>
        <DialogDescription>{anchorLabel(anchor)}</DialogDescription>
      </DialogHeader>
      <Textarea
        autoFocus
        className="h-28 resize-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && text.trim()) onSubmit(text.trim());
        }}
        placeholder={mode === "ask" ? "What would you like to ask?" : "Your feedback…"}
      />
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">Cancel</Button>
        </DialogClose>
        <Button disabled={!text.trim()} onClick={() => onSubmit(text.trim())}>
          {mode === "ask" ? "Ask" : "Add feedback"}
        </Button>
      </DialogFooter>
    </>
  );
}

const Q_STATUS: Record<QuestionRecord["status"], { label: string; cls: string; busy?: boolean }> = {
  queued: { label: "queued", cls: "text-muted-foreground", busy: true },
  "in-progress": { label: "answering", cls: "text-info", busy: true },
  answered: { label: "answered", cls: "text-success" },
  error: { label: "error", cls: "text-destructive" },
};
function QStatus({ status }: { status: QuestionRecord["status"] }) {
  const s = Q_STATUS[status];
  return (
    <span className={cn("flex items-center gap-1 text-xs font-medium", s.cls)}>
      {s.busy ? <Spinner /> : status === "answered" ? "✓" : "!"} {s.label}
    </span>
  );
}

const Spinner = () => (
  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
);
const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="mt-6 text-center text-sm text-muted-foreground">{children}</div>
);
const Centered = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full items-center justify-center bg-background p-6 text-center text-muted-foreground">
    {children}
  </div>
);
