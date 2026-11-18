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

test('L3 input shows a safe target while hiding full paths and arbitrary arguments', () => {
  const trace = { role: 'tool' as const, toolName: 'Read', toolCallId: 'call', surfaceRunId: 'run',
    toolArgs: JSON.stringify({ file_path: '/Users/synthetic/private-key.pem', content: 'raw-private-body' }),
    toolResult: JSON.stringify({ output: 'visible result' }), content: '', ts: '' };
  const shown = formatMessageBlockRawTrace(trace);
  expect(shown).toContain('입력\n(private file)');
  expect(shown).toContain('visible result');
  expect(shown).not.toContain('/Users/synthetic');
  expect(shown).not.toContain('private-key.pem');
  expect(shown).not.toContain('raw-private-body');
});

test('Read transport metadata does not add a JSON row beneath readable output', () => {
  const trace = { role: 'tool' as const, toolName: 'Read', toolArgs: { file_path: '/tmp/notes.txt' },
    // 출처: #67371 — 단일 Read 결과의 수송 봉투를 합성한다.
    toolResult: JSON.stringify({ output: 'note body', linesRead: 1, totalLines: 1, totalBytes: 9, truncated: false, kind: 'text' }),
    content: '', ts: '' };
  const shown = formatMessageBlockRawTrace(trace);
  expect(shown).toContain('output\nnote body');
  expect(shown).not.toContain('기타 결과 메타데이터');
  expect(shown).not.toContain('linesRead');
});

test('a truncated Read envelope keeps one visible warning without a JSON metadata row', () => {
  const trace = { role: 'tool' as const, toolName: 'Read', toolArgs: { file_path: '/tmp/notes.txt' },
    // 출처: #37867 잘린 Read 결과의 합성 메타데이터 표본.
    toolResult: JSON.stringify({ output: 'partial note', linesRead: 1, totalLines: 8, totalBytes: 100,
      truncated: true, kind: 'text' }), content: '', ts: '' };
  const shown = formatMessageBlockRawTrace(trace);
  expect(shown).toContain('output\npartial note');
  expect(shown).toContain('⚠ 일부 출력만 표시됨 (잘림)');
  expect(shown).not.toContain('기타 결과 메타데이터');
  expect(shown).not.toContain('linesRead');
});

test('non-Read semantic kind and truncation fields remain visible', () => {
  const trace = { role: 'tool' as const, toolName: 'Search', toolArgs: { query: 'normal' },
    toolResult: JSON.stringify({ output: 'match', kind: 'partial-match', truncated: true, totalBytes: 200 }),
    content: '', ts: '' };
  const shown = formatMessageBlockRawTrace(trace);
  expect(shown).toContain('output\nmatch');
  expect(shown).toContain('"kind":"partial-match"');
  expect(shown).toContain('"truncated":true');
  expect(shown).toContain('"totalBytes":200');
});

test('an atypical Read result does not lose fields that only look like transport metadata', () => {
  const trace = { role: 'tool' as const, toolName: 'Read', toolArgs: { file_path: '/tmp/notes.txt' },
    toolResult: JSON.stringify({ output: 'partial', kind: 'domain-result', truncated: true }),
    content: '', ts: '' };
  const shown = formatMessageBlockRawTrace(trace);
  expect(shown).toContain('"kind":"domain-result"');
  expect(shown).toContain('"truncated":true');
});
