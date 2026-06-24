import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Plus } from "lucide-react";
import type { Anchor } from "@plan-review/shared";
import { anchorLabel, buildAnchor } from "../selection";
import { nodeText, slugify } from "../toc";
import { ComposerBody, type ComposerMode } from "./Composer";

interface HastNode {
  position?: { start: { line: number }; end: { line: number } };
}
const startLine = (node: unknown): number | undefined => (node as HastNode | undefined)?.position?.start.line;
const endLine = (node: unknown): number | undefined => (node as HastNode | undefined)?.position?.end.line;

// Stamp each block element with its full source line range so DOM geometry maps
// back to source lines for gutter selection.
const stamp = (node: unknown) => ({ "data-source-line": startLine(node), "data-source-end": endLine(node) });
// id derived via the same slug the TOC uses, so contents/scroll-spy line up.
const hid = (children: React.ReactNode) => slugify(nodeText(children));
const components: Components = {
  p: ({ node, ...props }) => <p {...stamp(node)} {...props} />,
  li: ({ node, ...props }) => <li {...stamp(node)} {...props} />,
  h1: ({ node, children, ...props }) => <h1 id={hid(children)} {...stamp(node)} {...props}>{children}</h1>,
  h2: ({ node, children, ...props }) => <h2 id={hid(children)} {...stamp(node)} {...props}>{children}</h2>,
  h3: ({ node, children, ...props }) => <h3 id={hid(children)} {...stamp(node)} {...props}>{children}</h3>,
  h4: ({ node, ...props }) => <h4 {...stamp(node)} {...props} />,
  h5: ({ node, ...props }) => <h5 {...stamp(node)} {...props} />,
  h6: ({ node, ...props }) => <h6 {...stamp(node)} {...props} />,
  blockquote: ({ node, ...props }) => <blockquote {...stamp(node)} {...props} />,
  pre: ({ node, ...props }) => <pre {...stamp(node)} {...props} />,
  tr: ({ node, ...props }) => <tr {...stamp(node)} {...props} />,
};

interface Block {
  start: number;
  end: number;
  top: number;
  bottom: number;
}
/** Container-relative band geometry for the selection highlight / popover anchor. */
interface Band {
  start: number;
  end: number;
  top: number;
  height: number;
}

function measureBlocks(container: HTMLElement): Block[] {
  const out: Block[] = [];
  container.querySelectorAll<HTMLElement>("[data-source-line]").forEach((el) => {
    const start = Number(el.getAttribute("data-source-line"));
    if (!start) return;
    const endAttr = el.getAttribute("data-source-end");
    const r = el.getBoundingClientRect();
    out.push({ start, end: endAttr ? Number(endAttr) : start, top: r.top, bottom: r.bottom });
  });
  return out;
}

/** Innermost block containing viewport-y; falls back to the vertically nearest. */
function blockAtY(blocks: Block[], y: number): Block | null {
  let inside: Block | null = null;
  let nearest: Block | null = null;
  let nearestDist = Infinity;
  for (const b of blocks) {
    if (y >= b.top && y <= b.bottom) {
      if (!inside || b.top > inside.top || (b.top === inside.top && b.bottom < inside.bottom)) inside = b;
    }
    const dist = y < b.top ? b.top - y : y - b.bottom;
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = b;
    }
  }
  return inside ?? nearest;
}

/** Union band for every block intersecting [start, end], in container coords. */
function bandForRange(blocks: Block[], start: number, end: number, containerTop: number): Band | null {
  let top = Infinity;
  let bottom = -Infinity;
  for (const b of blocks) {
    if (b.end >= start && b.start <= end) {
      top = Math.min(top, b.top);
      bottom = Math.max(bottom, b.bottom);
    }
  }
  if (top === Infinity) return null;
  return { start, end, top: top - containerTop, height: bottom - top };
}

export function MarkdownView({
  markdown,
  activeAnchor,
  onSubmit,
}: {
  markdown: string;
  activeAnchor: Anchor | null;
  onSubmit: (anchor: Anchor, text: string, mode: ComposerMode) => void | Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Band | null>(null);
  const [sel, setSel] = useState<Band | null>(null);
  const [anchorBand, setAnchorBand] = useState<Band | null>(null);
  const [open, setOpen] = useState(false);
  const dragging = useRef(false);

  // Externally-driven highlight (a hovered sidebar card) → the same band as a
  // live selection, so the two read identically instead of inner-vs-outer.
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container || !activeAnchor) return setAnchorBand(null);
    const { startLine, endLine } = activeAnchor.lineRange;
    const compute = () => {
      const blocks = measureBlocks(container);
      const top = container.getBoundingClientRect().top;
      setAnchorBand(bandForRange(blocks, startLine, endLine, top));
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [activeAnchor, markdown]);

  const close = useCallback(() => {
    setOpen(false);
    setSel(null);
  }, []);

  // The composer is a plain in-flow panel (not a Radix popover), so wire up the
  // click-outside-to-close it used to give us for free. Escape is handled inside
  // ComposerBody. The opening gesture ends on mouseup, so a mousedown listener
  // never races the open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, close]);

  // Hover: reveal the gutter "+" beside the block under the cursor.
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragging.current || !ref.current) return;
    const container = ref.current;
    const blocks = measureBlocks(container);
    const b = blockAtY(blocks, e.clientY);
    if (!b) return setHover(null);
    const top = b.top - container.getBoundingClientRect().top;
    setHover((h) => (h && h.start === b.start && h.end === b.end ? h : { start: b.start, end: b.end, top, height: b.bottom - b.top }));
  }, []);

  // Gutter mousedown → begin a line selection; drag extends it; mouseup opens the composer.
  const onGutterDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); // suppress native text selection during the drag
    const container = ref.current;
    if (!container) return;
    const blocks = measureBlocks(container);
    const containerTop = container.getBoundingClientRect().top;
    const start = blockAtY(blocks, e.clientY);
    if (!start) return;

    dragging.current = true;
    setOpen(false);
    setHover(null);
    document.body.style.userSelect = "none";
    setSel(bandForRange(blocks, start.start, start.end, containerTop));

    const rangeFor = (clientY: number): Band | null => {
      const focus = blockAtY(blocks, clientY) ?? start;
      return bandForRange(blocks, Math.min(start.start, focus.start), Math.max(start.end, focus.end), containerTop);
    };
    const onMove = (ev: MouseEvent) => {
      const band = rangeFor(ev.clientY);
      if (band) setSel(band);
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      dragging.current = false;
      const band = rangeFor(ev.clientY);
      if (band) {
        setSel(band);
        setOpen(true);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const submit = (text: string, mode: ComposerMode) => {
    if (!ref.current || !sel) return;
    const anchor = buildAnchor(ref.current, sel.start, sel.end);
    void onSubmit(anchor, text, mode);
    close();
  };

  const plus = hover && !open;

  return (
    <div
      ref={ref}
      className="md-body relative mx-auto max-w-3xl py-14 pr-10 pl-14"
      onMouseMove={onMouseMove}
      onMouseLeave={() => !dragging.current && setHover(null)}
    >
      {/* highlight band (behind the text) — the amber pencil. Same band for a
          live selection and for a hovered sidebar card's anchor. */}
      {(sel ?? anchorBand) && (
        <div
          className="pointer-events-none absolute inset-x-0 rounded-sm bg-[color-mix(in_oklch,var(--marker)_18%,transparent)] shadow-[inset_2px_0_0_var(--marker)]"
          style={{ top: (sel ?? anchorBand)!.top, height: (sel ?? anchorBand)!.height }}
        />
      )}

      {/* gutter: hover reveals "+", mousedown/drag selects line(s) */}
      <div className="absolute inset-y-0 left-0 z-20 w-12 cursor-pointer" onMouseDown={onGutterDown}>
        {plus && (
          <span
            className="absolute left-3 flex size-6 -translate-y-1/2 items-center justify-center rounded-md border border-border bg-popover text-muted-foreground shadow-sm transition-colors hover:border-marker hover:text-marker"
            style={{ top: hover.top + hover.height / 2 }}
          >
            <Plus className="size-4" />
          </span>
        )}
      </div>

      {/* rendered document (above the highlight band) */}
      <div className="relative z-10">
        <Markdown remarkPlugins={[remarkGfm]} components={components}>
          {markdown || "_(empty document)_"}
        </Markdown>
      </div>

      {/* composer: rendered inline directly beneath the selected lines and bounded
          to the document column, so it stays fully on-screen at any window width
          (the old right-side popover could spill off-screen when narrow). */}
      {open && sel && (
        <div
          ref={panelRef}
          className="absolute right-10 left-14 z-30 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl"
          style={{ top: sel.top + sel.height + 8 }}
        >
          <ComposerBody
            label={anchorLabel(buildAnchor(ref.current!, sel.start, sel.end))}
            onSubmit={submit}
            onCancel={close}
          />
        </div>
      )}
    </div>
  );
}
