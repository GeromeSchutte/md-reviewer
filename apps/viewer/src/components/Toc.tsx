import { List } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TocItem } from "../toc";

// Tick lengths read like a drafting scale — depth encoded as rule length.
const TICK_W = ["w-5", "w-3.5", "w-2"];

/**
 * Slim contents rail. Collapsed it shows a stack of ticks (one per heading,
 * length by depth) with the active section marked in amber; on hover/focus it
 * expands over the document to reveal labels. Width is reserved by the spacer
 * so expansion overlays rather than reflows the reading column.
 */
export function Toc({
  items,
  activeId,
  onJump,
}: {
  items: TocItem[];
  activeId: string | null;
  onJump: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="relative z-30 w-12 shrink-0">
      <nav
        aria-label="Table of contents"
        className="group absolute inset-y-0 left-0 flex w-12 flex-col overflow-hidden border-r border-border bg-background transition-[width,box-shadow] duration-200 hover:w-60 hover:shadow-[8px_0_24px_-12px_rgba(0,0,0,0.5)] focus-within:w-60"
      >
        <div className="flex items-center gap-2 px-3.5 pt-5 pb-3 text-muted-foreground">
          <List className="size-4 shrink-0" />
          <span className="font-mono text-[0.65rem] font-medium tracking-[0.18em] whitespace-nowrap uppercase opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
            Contents
          </span>
        </div>
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto py-1 pr-2">
          {items.map((it) => {
            const active = it.id === activeId;
            return (
              <li key={it.id}>
                <button
                  type="button"
                  onClick={() => onJump(it.id)}
                  title={it.text}
                  className={cn(
                    "group/i flex w-full items-center gap-3 rounded-r-md py-1.5 pl-3.5 text-left transition-colors hover:bg-accent/60",
                    active && "bg-accent/40",
                  )}
                >
                  <span
                    className={cn(
                      "h-0.5 shrink-0 rounded-full transition-colors",
                      TICK_W[it.level - 1] ?? "w-2",
                      active
                        ? "bg-marker"
                        : "bg-border group-hover/i:bg-muted-foreground",
                    )}
                  />
                  <span
                    style={{ paddingLeft: `${(it.level - 1) * 0.6}rem` }}
                    className={cn(
                      "truncate text-[0.8rem] whitespace-nowrap opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100",
                      active ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {it.text}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
