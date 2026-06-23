import type { Anchor } from "@plan-review/shared";

/** Human label for an anchor's line range (or "general" when unanchored). */
export function anchorLabel(a: Anchor | null): string {
  if (!a) return "general";
  const { startLine, endLine } = a.lineRange;
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
}

/**
 * Build an anchor for a contiguous range of source lines. The line range is
 * authoritative (v1 renders by it); the text-quote selector is captured
 * best-effort from the rendered blocks so v2 can re-locate the anchor across
 * reworks/sessions.
 */
export function buildAnchor(container: HTMLElement, startLine: number, endLine: number): Anchor {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>("[data-source-line]")).filter((el) => {
    const s = Number(el.getAttribute("data-source-line"));
    const e = Number(el.getAttribute("data-source-end") ?? el.getAttribute("data-source-line"));
    return s >= startLine && e <= endLine;
  });

  const exact = blocks
    .map((el) => el.textContent ?? "")
    .join("\n")
    .trim();
  if (!exact) return { lineRange: { startLine, endLine }, quote: null };

  const full = container.textContent ?? "";
  const idx = full.indexOf(blocks[0]?.textContent?.trim() ?? exact);
  const prefix = idx >= 0 ? full.slice(Math.max(0, idx - 32), idx) : "";
  const suffix = idx >= 0 ? full.slice(idx + exact.length, idx + exact.length + 32) : "";

  return { lineRange: { startLine, endLine }, quote: { exact, prefix, suffix } };
}
