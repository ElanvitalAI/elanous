/**
 * BACKLOG #7 — collapsible code-block preview policy.
 *
 * ChatMessage renders agent markdown as a ReactMarkdown tree. Long fenced
 * code blocks (tool output, multi-file diffs, JSON dumps) push text off-screen on
 * iPad 11" portrait — users keep scrolling instead of reading.
 *
 * This helper owns the threshold + raw-text extraction policy so the
 * `<CollapsibleCodeBlock>` component stays presentational. We extract
 * the text by walking ReactMarkdown's children prop (it nests `<code>`
 * inside `<pre>` and may pile inline arrays of strings + spans for
 * syntax highlighting).
 */

import type { ReactNode } from 'react';

export const COLLAPSE_LINE_THRESHOLD = 12;
export const COLLAPSE_CHAR_THRESHOLD = 800;
export const PREVIEW_LINE_COUNT = 8;

export function shouldCollapseDefault(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (text.length > COLLAPSE_CHAR_THRESHOLD) return true;
  const lines = text.split('\n').length;
  return lines > COLLAPSE_LINE_THRESHOLD;
}

export function makePreview(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= PREVIEW_LINE_COUNT) return text;
  return lines.slice(0, PREVIEW_LINE_COUNT).join('\n') + '\n…';
}

/** Recursively concat string children. ReactMarkdown's `pre` receives
 *  a tree like `<code className="language-bash">…</code>` — sometimes a
 *  literal string, sometimes nested arrays. */
export function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return extractText(props?.children);
  }
  return '';
}

/** Pull the `language-xxx` token off a code element's className. Used
 *  for the header label and a future syntax-highlighter hook. */
export function extractLanguage(node: ReactNode): string | null {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const lang = extractLanguage(child);
      if (lang) return lang;
    }
    return null;
  }
  const props = (node as { props?: { className?: string; children?: ReactNode } }).props;
  if (props?.className && typeof props.className === 'string') {
    const m = /language-([\w+-]+)/.exec(props.className);
    if (m) return m[1] ?? null;
  }
  if (props?.children) return extractLanguage(props.children);
  return null;
}
