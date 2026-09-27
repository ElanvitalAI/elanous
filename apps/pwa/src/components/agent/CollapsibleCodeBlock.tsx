'use client';

// BACKLOG #7 — collapsible code block for ReactMarkdown.
//
// Wraps the default `<pre>` element so long fenced blocks (tool output,
// diffs, JSON dumps) collapse to a preview by default with explicit
// "Show all" / "Copy" affordances. Short blocks render as a normal
// `<pre>` with the same styling so the markdown stays readable.
//
// We don't replace `<code>` — it still renders with the prose styles
// the parent surface set up (ChatMessage).
// SSR-safe: clipboard interactions degrade to a no-op when the API is
// unavailable. The component is reusable across surfaces.

import { useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react';
import { debugLog } from '@/lib/debug';
import {
  extractLanguage,
  extractText,
  makePreview,
  shouldCollapseDefault,
} from '@/lib/code-block-preview';

interface Props {
  children?: ReactNode;
}

export function CollapsibleCodeBlock({ children }: Props) {
  const text = useMemo(() => extractText(children), [children]);
  const lang = useMemo(() => extractLanguage(children), [children]);
  const collapseDefault = useMemo(() => shouldCollapseDefault(text), [text]);
  const [expanded, setExpanded] = useState(!collapseDefault);
  const [copied, setCopied] = useState(false);

  // Short blocks: native <pre> straight through.
  if (!collapseDefault) {
    return <pre>{children}</pre>;
  }

  const preview = makePreview(text);
  const lineCount = text.split('\n').length;

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      debugLog('pwa.code-block.copy', { lang, lineCount });
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      debugLog('pwa.code-block.copy-error', { reason: String(e) });
    }
  };

  return (
    <div
      className="my-2 overflow-hidden rounded-md border border-border bg-muted/40"
      data-testid="collapsible-code-block"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground">
        <span className="font-mono">
          {lang ?? 'code'} · {lineCount} lines · {text.length} chars
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => { void onCopy(); }}
            aria-label="copy code"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? 'copied' : 'copy'}
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? 'collapse code' : 'expand code'}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {expanded ? 'collapse' : 'show all'}
          </button>
        </div>
      </div>
      <pre className="!my-0 overflow-x-auto !rounded-none !bg-transparent !p-2 !text-[13px]">
        {expanded ? children : preview}
      </pre>
    </div>
  );
}
