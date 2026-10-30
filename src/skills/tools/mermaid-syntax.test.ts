import { expect, test } from 'bun:test';

import { dispatchMermaidSyntax } from './mermaid-syntax.js';

test('returns the flowchart syntax template consumed before MermaidRender', async () => {
  const result = await dispatchMermaidSyntax({ domain: 'flowchart' });

  expect(result.domain).toBe('flowchart');
  expect(result.template).toContain('flowchart LR');
  expect(result.output).toContain('MermaidSyntax domain=flowchart');
  expect(result.notes).toContain('Edge label: A -->|label text| B.');
});
