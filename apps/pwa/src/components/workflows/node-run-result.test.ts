import { expect, test } from 'bun:test';
import { formatOutput, latestNodeResult } from './node-run-result';
import type { WorkflowRunEvent } from '@/nexus/client';

test('last node_done for the selected node wins; missing node is null', () => {
  const events: WorkflowRunEvent[] = [
    { type: 'node_done', nodeId: 'a', result: { ok: true, output: 'old', durationMs: 12 } },
    { type: 'node_done', nodeId: 'b', result: { ok: true, output: 'other', durationMs: 9 } },
    { type: 'node_done', nodeId: 'a', result: { ok: false, output: 0, error: 'bad', durationMs: 250 } },
  ];
  expect(latestNodeResult(events, 'a')).toEqual({ ok: false, output: 0, error: 'bad', durationMs: 250 });
  expect(latestNodeResult(events, 'missing')).toBeNull();
  expect(latestNodeResult([...events, { type: 'node_done', nodeId: 'a' }], 'a'))
    .toEqual({ ok: false, output: 0, error: 'bad', durationMs: 250 });
});

test('JSON output is pretty printed and output exceeding 4,000 characters is truncated', () => {
  expect(formatOutput({ a: 1 })).toEqual({ text: '{\n  "a": 1\n}', isJson: true, truncated: false });
  expect(formatOutput('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', isJson: true, truncated: false });
  expect(formatOutput('hello')).toEqual({ text: 'hello', isJson: false, truncated: false });
  expect(formatOutput('x'.repeat(4_000))).toEqual({ text: 'x'.repeat(4_000), isJson: false, truncated: false });
  expect(formatOutput('x'.repeat(4_001))).toEqual({ text: 'x'.repeat(4_000), isJson: false, truncated: true });
});
