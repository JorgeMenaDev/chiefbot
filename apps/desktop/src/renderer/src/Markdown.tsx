// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/components/ChatMarkdown.tsx
// (the component map, MarkdownCodeBlock and its frame) and the .chat-markdown rules in apps/web/src/index.css.
import { CheckIcon, CopyIcon } from "lucide-react";
import { Children, isValidElement, memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "./components/ui/button.tsx";
import { copyText } from "./lib/clipboard.ts";

const remarkPlugins = [remarkGfm];

// The href a link may open, or null. Only web and mail links open: a click on a
// target="_blank" link reaches Electron main's window-open handler, which opens it
// in the system browser. Anything else (relative, #anchors) shows as plain text,
// so a link in a reply never navigates the app.
function externalHref(href: string | undefined) {
  if (!href || !URL.canParse(href)) return null;
  return ["http:", "https:", "mailto:"].includes(new URL(href).protocol) ? href : null;
}

function plainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plainText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return plainText(node.props.children);
  return "";
}

// A fenced block's language (from its `language-…` class) and code, or null for any other <pre>.
function fencedCode(children: ReactNode) {
  const [only, ...rest] = Children.toArray(children);
  if (rest.length > 0 || !isValidElement<{ className?: string; children?: ReactNode }>(only) || only.type !== "code") return null;
  return { language: /language-(\S+)/.exec(only.props.className ?? "")?.[1] ?? "", code: plainText(only.props.children) };
}

// A fenced code block: its language and a copy button on a header over the code.
// The frame is the same while the block streams and after, so it never swaps.
function CodeBlock({ language, code, children }: { language: string; code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  const label = copied ? "Copied" : "Copy code";
  return (
    <div className="chat-markdown-codeblock">
      <div className="flex items-center justify-between gap-2 ps-3 pe-1.5 pt-1.5 select-none">
        <span className="truncate font-mono text-[11px] text-muted-foreground">{language}</span>
        <Button size="icon-xs" variant="ghost" aria-label={label} title={label} onClick={() => void copyText(code, navigator.clipboard).then(setCopied)}>
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </Button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

// One constant map, so the component types stay the same while a reply streams.
const components: Components = {
  a: ({ href, children }) => {
    const url = externalHref(href);
    if (!url) return <span>{children}</span>;
    return (
      <a href={url} title={url} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
  pre: ({ node: _node, children, ...props }) => {
    const fenced = fencedCode(children);
    if (!fenced) return <pre {...props}>{children}</pre>;
    return (
      <CodeBlock language={fenced.language} code={fenced.code}>
        {children}
      </CodeBlock>
    );
  },
  // Wide tables scroll sideways inside the lane instead of widening it.
  table: ({ node: _node, ...props }) => (
    <div className="chat-markdown-table">
      <table {...props} />
    </div>
  ),
};

// A bot's reply as GitHub-flavoured markdown. Raw HTML in the text is dropped
// (react-markdown's default). Memoised on its props: while a reply streams, only
// that message re-renders. `streaming` fades in each new block (styles.css).
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="chat-markdown" data-streaming={streaming ? "" : undefined}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
