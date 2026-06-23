import type { Anchor } from "@plan-review/shared";

/** Walk up from a DOM node to the nearest element carrying data-source-line. */
function sourceLineOf(node: Node | null): number | null {
  let el: HTMLElement | null =
    node && node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null);
  while (el) {
    const v = el.getAttribute?.("data-source-line");
    if (v) return Number(v);
    el = el.parentElement;
  }
  return null;
}

export interface CapturedSelection {
  anchor: Anchor;
  rect: DOMRect;
}

/**
 * Capture the current text selection as a source line-range anchor (v1).
 * Also records a text-quote selector (exact + 32-char prefix/suffix) for v2
 * cross-rework re-anchoring; v1 renders by line range only.
 */
export function captureSelection(container: HTMLElement): CapturedSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;

  const a = sourceLineOf(range.startContainer);
  const b = sourceLineOf(range.endContainer);
  if (a == null || b == null) return null;

  const exact = sel.toString();
  if (!exact.trim()) return null;

  const full = container.textContent ?? "";
  const idx = full.indexOf(exact);
  const prefix = idx >= 0 ? full.slice(Math.max(0, idx - 32), idx) : "";
  const suffix = idx >= 0 ? full.slice(idx + exact.length, idx + exact.length + 32) : "";

  return {
    anchor: {
      lineRange: { startLine: Math.min(a, b), endLine: Math.max(a, b) },
      quote: { exact, prefix, suffix },
    },
    rect: range.getBoundingClientRect(),
  };
}
