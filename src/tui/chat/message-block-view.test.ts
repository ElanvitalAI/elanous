import { expect, test } from 'bun:test';
import type { MessageBlock } from '../../conv-substrate/message-block.js';
import { messageBlockDetailLines, nextMessageBlockDetailLevel } from './message-block-view.js';

const thought: MessageBlock = {
  id: 'thought-1', ts: 1, source: 'agent', body: { kind: 'thought', text: '파일을 읽고 호출 경로를 대조합니다.\n중복 진입도 확인합니다.' },
  detail: { level: 3, summary: '호출 경로와 중복 진입을 확인합니다.', steps: ['파일 읽기', '호출 경로 대조'], rawRef: { runId: 'run-1', blockId: 'thought-1' } },
};

test('non-answer MessageBlocks default to one folded line while answers remain exposed', () => {
  const folded = messageBlockDetailLines(thought, 0, 80).join('\n');
  expect(folded).toContain('▸ 생각');
  expect(folded).not.toContain('(접힘)');
  expect(folded).toContain('\x1b[2m');
  expect(folded).not.toContain('파일을 읽고 호출 경로를 대조합니다');

  const answer: MessageBlock = { id: 'answer-1', ts: 2, source: 'agent', body: { kind: 'assistant', text: '최종 답변' } };
  expect(messageBlockDetailLines(answer, 0)).toEqual([]);
});

test('Enter reveals summary, then steps, then only the raw reference target', () => {
  expect(messageBlockDetailLines(thought, 1, 80)).toEqual(['▾ 생각 · 호출 경로와 중복 진입을 확인합니다.']);
  expect(messageBlockDetailLines(thought, 2, 80)).toEqual([
    '▾ 생각 · 호출 경로와 중복 진입을 확인합니다.',
    '  · 파일 읽기',
    '  · 호출 경로 대조',
  ]);
  const raw = messageBlockDetailLines(thought, 3, 80).join('\n');
  expect(raw).toContain('thought-1');
  expect(raw).not.toContain('파일을 읽고 호출 경로를 대조합니다.');
  expect(nextMessageBlockDetailLevel(thought, 0)).toBe(1);
  expect(nextMessageBlockDetailLevel(thought, 1)).toBe(2);
  expect(nextMessageBlockDetailLevel(thought, 2)).toBe(3);
  expect(nextMessageBlockDetailLevel(thought, 3)).toBe(0);
});

test('folded summary always fits even when the label is wider than the terminal', () => {
  for (const columns of [1, 2, 4, 5, 8]) {
    const line = messageBlockDetailLines(thought, 0, columns)[0]!;
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
  }
});

test('tool, progress, status, and error events share the L0 summary policy', () => {
  const blocks: MessageBlock[] = [
    { id: 'tool', ts: 1, source: 'tool', body: { kind: 'tool-call', toolCallId: 't1', title: 'Bash', status: '실행 중' } },
    { id: 'plan', ts: 2, source: 'agent', body: { kind: 'plan', ref: '검증 단계 2' } },
    { id: 'status', ts: 3, source: 'system', body: { kind: 'status', text: 'ctx 410,000 chars / 400,000' } },
    { id: 'error', ts: 4, source: 'system', body: { kind: 'error', text: '원격 도구가 실패했습니다' } },
  ];
  for (const block of blocks) {
    const lines = messageBlockDetailLines(block, 0, 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('(접힘)');
    expect(lines[0]).not.toContain('410,000 chars');
  }
});

test('collapsed status stays compact and a long thought summary ends in an ellipsis', () => {
  const status: MessageBlock = { id: 'status-compact', ts: 1, source: 'system',
    body: { kind: 'status', text: 'ctx 410,000 chars / 400,000' } };
  const foldedStatus = messageBlockDetailLines(status, 0, 80)[0]!;
  expect(foldedStatus).toContain('▸ 상태');
  expect(foldedStatus).not.toContain('410,000');

  const longThought: MessageBlock = { ...thought, detail: { level: 1, summary: '긴 요약 '.repeat(20) } };
  const foldedThought = messageBlockDetailLines(longThought, 0, 24)[0]!;
  expect(foldedThought).toContain('…');
  expect(Bun.stringWidth(foldedThought.replace(/\x1b\[[0-9;]*m/g, ''))).toBeLessThanOrEqual(24); // Source: #36731 narrow-width rendering contract
});

test('L3 reference fetching is caller supplied and raw detail is never stored on the block', () => {
  const tool: MessageBlock = {
    id: 'tool-1', ts: 1, source: 'tool', body: { kind: 'tool-call', toolCallId: 'call-1', title: 'Read' },
    detail: { level: 3, summary: '파일을 읽음', steps: ['요청', '결과 수신'], rawRef: { runId: 'run-1', blockId: 'tool-1' } },
  };
  const lines = messageBlockDetailLines(tool, 3, 80, 'line one\nline two');
  expect(lines.join('\n')).toContain('line one');
  expect(lines.join('\n')).toContain('line two');
  expect(JSON.stringify(tool)).not.toContain('line one');
});

test('L3 wraps long raw lines without dropping their tail', () => {
  const tool: MessageBlock = {
    id: 'tool-wrap', ts: 1, source: 'tool', body: { kind: 'tool-call', toolCallId: 'call-wrap', title: 'Bash' },
    detail: { level: 3, summary: '원문', rawRef: { runId: 'run-wrap', blockId: 'tool-wrap' } },
  };
  const text = '0123456789'.repeat(12);
  const lines = messageBlockDetailLines(tool, 3, 20, text);
  expect(lines.slice(1).every((line) => Bun.stringWidth(line) <= 20)).toBe(true);
  expect(lines.slice(1).map((line) => line.slice(2)).join('')).toContain(text);
});

test('L1 summary and L2 thought steps wrap without dropping their tails', () => {
  const summary = 'summary-'.repeat(18);
  const step = 'thought-step-'.repeat(18);
  const block: MessageBlock = {
    id: 'thought-long', ts: 1, source: 'agent', body: { kind: 'thought', text: `${summary}\n${step}` },
    detail: { level: 2, summary, steps: [step] },
  };
  const summaryLines = messageBlockDetailLines(block, 1, 24);
  const detailLines = messageBlockDetailLines(block, 2, 24);
  const visibleText = (lines: string[]) => lines.join('').replace(/\s/g, '');
  expect(visibleText(summaryLines)).toContain(summary);
  expect(visibleText(detailLines)).toContain(summary);
  expect(visibleText(detailLines)).toContain(step);
  expect([...summaryLines, ...detailLines].every((line) => Bun.stringWidth(line) <= 24)).toBe(true);
});

test('L2 keeps wide graphemes when the terminal is narrower than the indent', () => {
  const step = '한글 단계';
  const block: MessageBlock = {
    id: 'thought-narrow', ts: 1, source: 'agent', body: { kind: 'thought', text: step },
    detail: { level: 2, summary: '요약', steps: [step] },
  };
  expect(messageBlockDetailLines(block, 2, 3).join('').replace(/\s/g, '')).toContain(step.replace(/\s/g, ''));
});
