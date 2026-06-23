import { useCallback, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Popover } from "radix-ui";
import type { Anchor, FeedbackRecord, LifecycleState, QuestionRecord, ReworkResult } from "@plan-review/shared";
import { MarkdownView } from "./components/MarkdownView";
import { ComposerBody, type ComposerMode } from "./components/Composer";
import { anchorLabel } from "./selection";
import { resolveSession } from "./launch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

// Token-based status chips. `cls` overrides the outline Badge's color via tailwind-merge.
const STATE_META: Record<LifecycleState, { label: string; cls: string; busy?: boolean }> = {
  "no-agent": { label: "No agent", cls: "border-transparent bg-muted text-muted-foreground" },
  "waiting-for-review": { label: "Ready", cls: "border-success/30 bg-success/15 text-success" },
  "agent-thinking": { label: "Answering…", cls: "border-info/30 bg-info/15 text-info", busy: true },
  reworking: { label: "Reworking…", cls: "border-warning/30 bg-warning/15 text-warning", busy: true },
  finalized: { label: "Finalized", cls: "border-transparent bg-muted text-muted-foreground" },
  "agent-disconnected": { label: "Agent offline", cls: "border-destructive/40 bg-destructive/15 text-destructive" },
};

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
  const [generalOpen, setGeneralOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mainEl, setMainEl] = useState<HTMLElement | null>(null);

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

  const submitAnnotation = useCallback(
    async (anchor: Anchor | null, text: string, mode: ComposerMode) => {
      if (!sid) return;
      if (mode === "ask") {
        const id = await askQuestion(sid, anchor, text);
        setQuestions((qs) => [
          ...qs,
          {
            id,
            abspath: "",
            anchor,
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
        await leaveFeedback(sid, anchor, text);
        setTab("review");
      }
    },
    [sid],
  );

  const meta = STATE_META[state];
  const queuedFeedback = useMemo(() => feedback.filter((f) => f.status === "queued"), [feedback]);
  const toc = useMemo(() => parseToc(markdown), [markdown]);
  const activeId = useScrollSpy(mainEl, useMemo(() => toc.map((t) => t.id), [toc]));

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
        <div className="ml-auto">
          <Popover.Root open={generalOpen} onOpenChange={setGeneralOpen}>
            <Popover.Trigger asChild>
              <Button variant="outline" size="sm">
                New note
              </Button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                align="end"
                sideOffset={8}
                onOpenAutoFocus={(e) => e.preventDefault()}
                className="z-50 w-80 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none"
              >
                <ComposerBody
                  label="general — not tied to any line"
                  onSubmit={(text, mode) => {
                    void submitAnnotation(null, text, mode);
                    setGeneralOpen(false);
                  }}
                  onCancel={() => setGeneralOpen(false)}
                />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* document */}
        <main className="min-w-0 flex-1 overflow-auto">
          <MarkdownView markdown={markdown} onSubmit={submitAnnotation} />
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
    <div className="border-t border-border bg-card/50 p-3">
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
          Submit review{count > 0 ? ` · ${count}` : ""}
        </Button>
        <span className="ml-auto">
          {reworking && (
            <span className="flex items-center gap-1.5 font-mono text-[0.65rem] tracking-wide text-warning uppercase">
              <Spinner /> reworking
            </span>
          )}
          {reworkResult === "success" && !reworking && (
            <span className="font-mono text-[0.65rem] tracking-wide text-success uppercase">reworked ✓</span>
          )}
          {reworkResult === "error" && !reworking && (
            <span className="font-mono text-[0.65rem] tracking-wide text-destructive uppercase">rework failed</span>
          )}
        </span>
      </div>
    </div>
  );
}

function QAList({ sid, questions }: { sid: string; questions: QuestionRecord[] }) {
  if (questions.length === 0)
    return (
      <Empty icon={MessageSquareText} title="No questions yet">
        Select lines in the document, or use “New note”, to ask the agent.
      </Empty>
    );
  return (
    <ul className="space-y-2.5">
      {[...questions].reverse().map((q) => (
        <li key={q.id} className="rounded-lg border border-border bg-card p-3 text-sm shadow-xs">
          <div className="mb-2 flex items-center gap-2">
            <QStatus status={q.status} />
            <div className="ml-auto flex items-center gap-1.5">
              {q.status === "error" && (
                <Button variant="ghost" size="xs" onClick={() => retryQuestion(sid, q.id)}>
                  Retry
                </Button>
              )}
              <AnchorTag anchor={q.anchor} />
            </div>
          </div>
          <p className="font-medium text-foreground">{q.text}</p>
          {q.answerMarkdown && (
            <div className="md-body md-body--compact mt-2.5 border-t border-border pt-2.5 text-foreground/80">
              <Markdown remarkPlugins={[remarkGfm]}>{q.answerMarkdown}</Markdown>
            </div>
          )}
          {q.status === "error" && q.errorMessage && (
            <div className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{q.errorMessage}</div>
          )}
        </li>
      ))}
    </ul>
  );
}

function ReviewList({ sid, feedback }: { sid: string; feedback: FeedbackRecord[] }) {
  const active = feedback.filter((f) => f.status === "queued" || f.status === "submitted");
  if (active.length === 0)
    return (
      <Empty icon={PenLine} title="No feedback yet">
        Mark up lines in the document, then submit the batch to the agent for a rework.
      </Empty>
    );
  return (
    <ul className="space-y-2.5">
      {[...active].reverse().map((f) => {
        const queued = f.status === "queued";
        return (
          <li
            key={f.id}
            className={cn(
              "rounded-lg border border-border bg-card p-3 text-sm shadow-xs",
              queued && "border-l-2 border-l-marker",
            )}
          >
            <div className="mb-2 flex items-center gap-2">
              <AnchorTag anchor={f.anchor} tone={queued ? "marker" : "muted"} />
              <span
                className={cn(
                  "font-mono text-[0.6rem] font-medium tracking-[0.1em] uppercase",
                  queued ? "text-marker" : "text-success",
                )}
              >
                {f.status}
              </span>
              {queued && (
                <Button variant="ghost" size="xs" className="ml-auto" onClick={() => removeFeedback(sid, f.id)}>
                  Remove
                </Button>
              )}
            </div>
            <p className="text-foreground/90">{f.text}</p>
          </li>
        );
      })}
    </ul>
  );
}

const Q_STATUS: Record<QuestionRecord["status"], { label: string; cls: string; busy?: boolean; icon?: string }> = {
  queued: { label: "queued", cls: "text-muted-foreground", busy: true },
  "in-progress": { label: "answering", cls: "text-info", busy: true },
  answered: { label: "answered", cls: "text-success", icon: "✓" },
  error: { label: "error", cls: "text-destructive", icon: "!" },
};
function QStatus({ status }: { status: QuestionRecord["status"] }) {
  const s = Q_STATUS[status];
  return (
    <span className={cn("flex items-center gap-1.5 font-mono text-[0.62rem] font-medium tracking-[0.1em] uppercase", s.cls)}>
      {s.busy ? <Spinner /> : s.icon} {s.label}
    </span>
  );
}

const Spinner = () => (
  <span className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
);
const Empty = ({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof PenLine;
  title: string;
  children: React.ReactNode;
}) => (
  <div className="mt-10 flex flex-col items-center gap-2 px-8 text-center">
    <Icon className="size-6 text-muted-foreground/40" strokeWidth={1.5} />
    <p className="text-sm font-medium text-foreground/80">{title}</p>
    <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
  </div>
);
const Centered = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full items-center justify-center bg-background p-6 text-center font-mono text-sm tracking-wide text-muted-foreground">
    {children}
  </div>
);
