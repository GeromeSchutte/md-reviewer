import { useRef } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { captureSelection, type CapturedSelection } from "../selection";

interface HastNode {
  position?: { start: { line: number }; end: { line: number } };
}
const startLine = (node: unknown): number | undefined => (node as HastNode | undefined)?.position?.start.line;
const endLine = (node: unknown): number | undefined => (node as HastNode | undefined)?.position?.end.line;

// Stamp each block element with its source line range so DOM selections map back to source.
const components: Components = {
  p: ({ node, ...props }) => <p data-source-line={startLine(node)} data-source-end={endLine(node)} {...props} />,
  li: ({ node, ...props }) => <li data-source-line={startLine(node)} {...props} />,
  h1: ({ node, ...props }) => <h1 data-source-line={startLine(node)} {...props} />,
  h2: ({ node, ...props }) => <h2 data-source-line={startLine(node)} {...props} />,
  h3: ({ node, ...props }) => <h3 data-source-line={startLine(node)} {...props} />,
  h4: ({ node, ...props }) => <h4 data-source-line={startLine(node)} {...props} />,
  h5: ({ node, ...props }) => <h5 data-source-line={startLine(node)} {...props} />,
  h6: ({ node, ...props }) => <h6 data-source-line={startLine(node)} {...props} />,
  blockquote: ({ node, ...props }) => <blockquote data-source-line={startLine(node)} {...props} />,
  pre: ({ node, ...props }) => <pre data-source-line={startLine(node)} {...props} />,
  tr: ({ node, ...props }) => <tr data-source-line={startLine(node)} {...props} />,
};

export function MarkdownView({
  markdown,
  onSelect,
}: {
  markdown: string;
  onSelect: (sel: CapturedSelection | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className="md-body mx-auto max-w-3xl px-8 py-6"
      onMouseUp={() => ref.current && onSelect(captureSelection(ref.current))}
    >
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown || "_(empty document)_"}
      </Markdown>
    </div>
  );
}
