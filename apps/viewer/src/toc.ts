import { useEffect, useState } from "react";
import type { ReactNode } from "react";

export interface TocItem {
  level: number; // 1–3
  text: string;
  id: string;
}

/** Slug shared by TOC parsing and rendered-heading id assignment so the two
 *  always agree. Lowercase, spaces→dashes, strip non-word punctuation. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Flatten react-markdown heading children to plain text for id derivation. */
export function nodeText(children: ReactNode): string {
  if (children == null || children === false) return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(nodeText).join("");
  if (typeof children === "object" && "props" in (children as object)) {
    return nodeText((children as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

/** Extract an h1–h3 outline from raw markdown, ignoring fenced code blocks. */
export function parseToc(markdown: string): TocItem[] {
  const items: TocItem[] = [];
  let inFence = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,3})\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const text = m[2]!.replace(/[`*_~]/g, "").replace(/\s*#+\s*$/, "");
    items.push({ level: m[1]!.length, text, id: slugify(text) });
  }
  return items;
}

/** Active-heading tracking against the scrollable document container. Observes
 *  heading elements and reports the one nearest the top of the viewport. */
export function useScrollSpy(
  container: HTMLElement | null,
  ids: string[],
): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join("|");

  useEffect(() => {
    if (!container || ids.length === 0) return;
    const els = ids
      .map((id) => container.querySelector<HTMLElement>(`#${CSS.escape(id)}`))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;

    const visible = new Map<string, number>();
    const recompute = () => {
      let best: string | null = null;
      let bestTop = Infinity;
      for (const [id, top] of visible) {
        if (top < bestTop) {
          bestTop = top;
          best = id;
        }
      }
      if (best) setActive(best);
    };

    const io = new IntersectionObserver(
      (entries) => {
        const top = container.getBoundingClientRect().top;
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top - top);
          else visible.delete(e.target.id);
        }
        recompute();
      },
      // Activate a heading once it reaches the top third of the reading area.
      { root: container, rootMargin: "0px 0px -66% 0px", threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    // Seed: nearest heading at or above the current scroll position.
    const top = container.getBoundingClientRect().top;
    let seeded: string | null = null;
    for (const el of els) {
      if (el.getBoundingClientRect().top - top <= 8) seeded = el.id;
    }
    setActive(seeded ?? els[0]!.id);

    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, key]);

  return active;
}

/** Scroll a heading into view inside the document container. */
export function jumpTo(container: HTMLElement | null, id: string): void {
  const el = container?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (!el) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}
