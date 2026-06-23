import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** "ask" → a question for the agent; "feedback" → a review comment. */
export type ComposerMode = "ask" | "feedback";

const MODES: { value: ComposerMode; label: string }[] = [
  { value: "ask", label: "Question" },
  { value: "feedback", label: "Review" },
];

/**
 * Self-contained annotation composer: a Question/Review toggle, a textarea, and
 * submit/cancel. Rendered inside a popover (anchored to a line range) or for a
 * general, unanchored note. Owns its own draft + mode state.
 */
export function ComposerBody({
  label,
  initialMode = "feedback",
  onSubmit,
  onCancel,
}: {
  label: string;
  initialMode?: ComposerMode;
  onSubmit: (text: string, mode: ComposerMode) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<ComposerMode>(initialMode);
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (t) onSubmit(t, mode);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex rounded-md border border-border p-0.5">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMode(m.value)}
              className={cn(
                "rounded px-2 py-0.5 text-xs font-medium transition-colors",
                mode === m.value
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="truncate text-xs text-muted-foreground">{label}</span>
      </div>
      <Textarea
        autoFocus
        className="h-24 resize-none text-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
        }}
        placeholder={mode === "ask" ? "Ask the agent about these lines…" : "Leave a review comment…"}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!text.trim()} onClick={submit}>
          {mode === "ask" ? "Ask" : "Add comment"}
        </Button>
      </div>
    </div>
  );
}
