import { expect, test } from 'bun:test';

import {
  buildMermaidSyntaxTool,
  dispatchMermaidSyntax,
  MERMAID_DOMAINS,
} from './mermaid-syntax.js';

test('returns the flowchart syntax template consumed before MermaidRender', async () => {
  const result = await dispatchMermaidSyntax({ domain: 'flowchart' });

  expect(result.domain).toBe('flowchart');
  expect(result.template).toContain('flowchart LR');
  expect(result.output).toContain('MermaidSyntax domain=flowchart');
  expect(result.notes).toContain('Edge label: A -->|label text| B.');
});

// ── DIAG-LITE (조각 2/2 · 계측 전용) — mermaid-syntax.ts 기본 계약 읽기 전용 고정 ──
test('DIAG-LITE: MERMAID_DOMAINS keeps the nine-domain contract', () => {
  expect(MERMAID_DOMAINS).toEqual([
    'flowchart', 'sequence', 'class', 'state', 'er', 'gantt', 'mindmap', 'timeline', 'pie',
  ]);
});

test('DIAG-LITE: buildMermaidSyntaxTool keeps the MermaidSyntax spec, domain enum, and MermaidRender hand-off', () => {
  const spec = buildMermaidSyntaxTool();
  expect(spec.name).toBe('MermaidSyntax');
  expect(spec.description).toContain('MermaidRender');
  const domain = (spec.parameters as { properties: Record<string, { enum?: string[] }> })
    .properties['domain']!;
  expect(domain.enum).toEqual(MERMAID_DOMAINS);
});

test('DIAG-LITE: dispatchMermaidSyntax rejects domains outside the nine-domain contract', async () => {
  await expect(dispatchMermaidSyntax({ domain: 'sankey' })).rejects.toThrow('must be one of');
});
