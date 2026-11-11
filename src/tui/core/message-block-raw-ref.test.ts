import { expect, test } from 'bun:test';
import { formatMessageBlockRawTrace, resolveMessageBlockRawTrace } from './message-block-raw-ref.js';

test('rawRef resolves by runId and blockId even when toolCallId repeats', () => {
  const block = { id: 'session:run-b:tool:call-1', ts: 1, source: 'tool' as const,
    body: { kind: 'tool-call' as const, toolCallId: 'call-1', title: 'Read' },
    detail: { level: 3 as const, summary: '파일 읽기', rawRef: { runId: 'run-b', blockId: 'session:run-b:tool:call-1' } } };
  const messages = [
    { role: 'tool' as const, toolCallId: 'call-1', surfaceRunId: 'run-a', toolArgs: 'wrong args', content: '', ts: '' },
    { role: 'tool' as const, toolCallId: 'call-1', surfaceRunId: 'run-b', toolArgs: 'right args', content: '', ts: '' },
  ];
  expect(resolveMessageBlockRawTrace(messages, block)?.toolArgs).toBe('right args');
  expect(resolveMessageBlockRawTrace(messages, { ...block, detail: { ...block.detail, rawRef: { ...block.detail.rawRef, runId: 'run-c' } } })).toBeUndefined();
});

test('L3 trace keeps stdout, stderr, and exit metadata visible', () => {
  const trace = { role: 'tool' as const, toolCallId: 'call', surfaceRunId: 'run', toolArgs: { command: 'false' },
    toolResult: JSON.stringify({ stdout: 'out line', stderr: 'err line', exitCode: 7, durationMs: 13 }), content: '', ts: '' };
  const raw = formatMessageBlockRawTrace(trace);
  expect(raw).toContain('out line');
  expect(raw).toContain('err line');
  expect(raw).toContain('종료 상태\n7');
  expect(raw).toContain('durationMs');
});

test('L3 trace preserves both output aliases and both exit-code aliases', () => {
  const trace = { role: 'tool' as const, toolCallId: 'call', surfaceRunId: 'run', toolArgs: {},
    toolResult: JSON.stringify({ stdout: 'stdout value', output: 'output value', exitCode: 0, code: 9 }), content: '', ts: '' };
  const raw = formatMessageBlockRawTrace(trace);
  expect(raw).toContain('stdout\nstdout value');
  expect(raw).toContain('output\noutput value');
  expect(raw).toContain('종료 상태\n0');
  expect(raw).toContain('code\n9');
});

test('L3 distinguishes an explicit empty object result from a missing result', () => {
  const trace = { role: 'tool' as const, toolCallId: 'call', surfaceRunId: 'run', toolArgs: {},
    toolResult: '{}', content: '', ts: '' };
  expect(formatMessageBlockRawTrace(trace)).toContain('결과\n{}');
});
