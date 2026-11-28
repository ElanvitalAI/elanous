import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { countMermaidFences, renderArchitectureDocument } from './architecture-render.js';

const markdown = [
  '## context — 시스템 맥락',
  '```mermaid',
  'flowchart LR',
  '  user --> app',
  '```',
  '## sequences — 핵심 흐름',
  '```mermaid',
  'sequenceDiagram',
  '  user->>app: open',
  '```',
].join('\n');

describe('renderArchitectureDocument', () => {
  test('keeps the markdown and both mermaid fences in the HTML', () => {
    const rendered = renderArchitectureDocument({ markdown, title: '티켓 <앱>' });
    expect(rendered.htmlPath).toBe('ARCHITECTURE.html');
    expect(rendered.mermaidFences).toBe(2);
    expect(countMermaidFences(markdown)).toBe(2);
    expect(rendered.html).toContain('flowchart LR');
    expect(rendered.html).toContain('sequenceDiagram');
    expect(rendered.html).toContain('티켓 &lt;앱&gt;');
    expect(rendered.html).not.toContain('티켓 <앱>');
    expect(rendered.htmlSha256).toBe(createHash('sha256').update(rendered.html).digest('hex'));
    expect(rendered.pdf).toEqual({
      contract: 'bookforge.app-docs-pdf@1',
      designPath: 'ARCHITECTURE.md',
      title: '티켓 <앱>',
      sourceSha256: createHash('sha256').update(markdown).digest('hex'),
    });
  });

  test('refuses an empty manuscript', () => {
    expect(() => renderArchitectureDocument({ markdown: '  \n' })).toThrow('ARCHITECTURE_MARKDOWN_EMPTY');
  });
});
