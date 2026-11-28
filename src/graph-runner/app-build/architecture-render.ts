import { createHash } from 'node:crypto';

/** APP-BUILD-ARCH-DOC-DIAGRAMS-PDF: the architecture node keeps the markdown
 * and also emits a rendered HTML document. PDF bytes stay with the existing
 * bookforge.app-docs-pdf@1 contract; this module only names that handoff. */

export interface ArchitectureRenderInput {
  markdown: string;
  title?: string;
}

export interface ArchitecturePdfHandoff {
  contract: 'bookforge.app-docs-pdf@1';
  designPath: 'ARCHITECTURE.md';
  title: string;
  sourceSha256: string;
}

export interface ArchitectureRender {
  htmlPath: 'ARCHITECTURE.html';
  html: string;
  htmlSha256: string;
  mermaidFences: number;
  pdf: ArchitecturePdfHandoff;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

/** Count fenced mermaid blocks. A count is not a rendered-diagram review. */
export function countMermaidFences(markdown: string): number {
  return [...markdown.matchAll(/```mermaid\s*\n[\s\S]*?```/giu)].length;
}

/** Wrap the unchanged markdown. Mermaid fences stay in the page so a browser
 * or the bookforge PDF step can render them. No filesystem or network access. */
export function renderArchitectureDocument(input: ArchitectureRenderInput): ArchitectureRender {
  const markdown = typeof input.markdown === 'string' ? input.markdown.replace(/\r\n?/gu, '\n') : '';
  if (!markdown.trim()) throw new Error('ARCHITECTURE_MARKDOWN_EMPTY');
  const title = (input.title?.trim() || 'Architecture').slice(0, 120);
  const mermaidFences = countMermaidFences(markdown);
  const html = [
    '<!DOCTYPE html>',
    '<html lang="ko">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>body{font-family:sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem} pre{overflow:auto;background:#f4f4f4;padding:1rem}</style>',
    '</head>',
    '<body>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<pre class="architecture-markdown">${escapeHtml(markdown)}</pre>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
  const sourceSha256 = createHash('sha256').update(markdown).digest('hex');
  return {
    htmlPath: 'ARCHITECTURE.html',
    html,
    htmlSha256: createHash('sha256').update(html).digest('hex'),
    mermaidFences,
    pdf: { contract: 'bookforge.app-docs-pdf@1', designPath: 'ARCHITECTURE.md', title, sourceSha256 },
  };
}
