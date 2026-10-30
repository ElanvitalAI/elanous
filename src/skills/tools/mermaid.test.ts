import { expect, test } from 'bun:test';

import { dispatchMermaidRender } from './mermaid.js';

test('renders a Mermaid flowchart through the bundled JavaScript renderer', async () => {
  const result = await dispatchMermaidRender({
    source: 'flowchart LR\n  A[Start] --> B[End]',
    format: 'ascii',
  });

  expect(result.output).toContain('Start');
  expect(result.output).toContain('End');
  expect(result.display).toContain('|Start|');
  expect(result.metadata).toMatchObject({ renderer: 'mermaidtui', format: 'ascii' });
});
