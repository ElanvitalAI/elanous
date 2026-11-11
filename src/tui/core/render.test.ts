import { expect, test } from 'bun:test';
import type { SerializedMessage } from '../../session/index.js';
import type { MessageBlock } from '../../conv-substrate/message-block.js';
import { messageBlockDetailLines } from '../chat/message-block-view.js';
import { createNextTuiHistoryCache, foldTargetAtScreenRow, isNextTuiContextCountStatus, logViewLines, nextTuiCompactActionStatus, nextTuiCompactHeight, nextTuiStatusAfterWelcome, renderNextTuiLogFrame, toggleVisibleMessageBlockDetail, toggleVisibleToolFold, wheelScroll } from './render.js';

test('next TUI chrome helpers validate height and remove repeated hints and context counts', () => {
  expect(nextTuiCompactHeight(undefined, 20)).toBe(20);
  expect(nextTuiCompactHeight('18', 20)).toBe(18);
  expect(nextTuiCompactHeight('7', 20)).toBe(20);
  expect(nextTuiStatusAfterWelcome('응답 완료 · Enter 전송 · Esc 취소 · Ctrl+Q 종료')).toBe('응답 완료');
  expect(isNextTuiContextCountStatus('ctx 410,000 chars / 500,000')).toBe(true);
  expect(nextTuiCompactActionStatus('응답 중')).toBe('');
  expect(nextTuiCompactActionStatus('응답 완료')).toBe('');
  expect(nextTuiCompactActionStatus('응답 실패 · ↑ 이전 입력 후 Enter 재시도')).toContain('재시도');
  expect(nextTuiCompactActionStatus('압축 실패: provider unavailable')).toContain('압축 실패');
});

const tool: SerializedMessage = {
  role: 'tool', content: '⚙️ Read', toolName: 'Read',
  toolResult: Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n'), ts: '2026-11-09T00:00:00Z',
};

test('history cache keeps scroll cheap and refreshes for turns, width, and fold state', () => {
  const messages: SerializedMessage[] = [tool];
  const expanded = new Set<number>();
  const input = { messages, columns: 30, rows: 8, header: ['header'], footer: ['footer'],
    promptLine: '❯ ', notices: [], activity: [], scroll: 0, expandedToolIndexes: expanded };
  const cache = createNextTuiHistoryCache();
  const first = cache(input);
  expect(cache({ ...input, scroll: 10 })).toBe(first);
  messages.push({ role: 'user', content: 'new turn', ts: '2026-11-10T00:00:00Z' });
  const appended = cache(input);
  expect(appended).not.toBe(first);
  expect(appended.lines.join('\n')).toContain('new turn');
  expect(cache({ ...input, columns: 20 })).not.toBe(appended);
  expanded.add(0);
  expect(cache({ ...input, columns: 20 }).lines.join('\n')).toContain('line-19');
});

test('history cache refreshes when a MessageBlock detail level changes', () => {
  const block: MessageBlock = { id: 'cache-thought', ts: 1, source: 'agent',
    body: { kind: 'thought', text: 'detail' }, detail: { level: 1, summary: 'summary' } };
  const input = { messages: [{ role: 'assistant' as const, content: 'answer', ts: '2026-11-10T00:00:00Z' }],
    messageBlocks: [{ block, level: 0 as 0 | 1 }], columns: 80, rows: 10, header: [], footer: [],
    promptLine: '❯ ', notices: [], activity: [], scroll: 0, expandedToolIndexes: new Set<number>() };
  const cache = createNextTuiHistoryCache();
  const folded = cache(input);
  const open = cache({ ...input, messageBlocks: [{ block, level: 1 as const }] });
  expect(open).not.toBe(folded);
  expect(open.lines.join('\n')).toContain('summary');
});

test('core render composes folded history, bounded scroll, and prompt rows', () => {
  const expanded = new Set<number>();
  const input = { messages: [tool], columns: 30, rows: 8, header: ['header'], footer: ['footer'],
    promptLine: '❯ ', notices: ['notice'], activity: ['activity'], expandedToolIndexes: expanded };
  const folded = renderNextTuiLogFrame({ ...input, scroll: 0 });
  expect(folded.lines).toEqual(['header', '', '▸ 도구 Read · 20줄 (접힘)', '', 'notice', 'activity', 'footer', '❯ ']);
  expect(folded.promptRow).toBe(folded.lines.length);
  expect(folded.maxScroll).toBe(0);
  expect(toggleVisibleToolFold(expanded, input.messages, input.columns, folded.logWindow)).toBe(true);

  const open = renderNextTuiLogFrame({ ...input, scroll: 0 });
  expect(open.maxScroll).toBe(open.logWindow.start);
  expect(open.body.join('\n')).toContain('line-19');
  const scrolled = renderNextTuiLogFrame({ ...input, scroll: wheelScroll(0, 'up', open.maxScroll, open.maxScroll) });
  expect(scrolled.body.join('\n')).toContain('line-0');
  expect(scrolled.logWindow.start).toBe(0);
});

test("empty transcript hides the shared history placeholder in the Next TUI frame", () => {
  const frame = renderNextTuiLogFrame({ messages: [], columns: 40, rows: 8,
    header: ["title"], footer: ["status"], promptLine: "❯ ", notices: [], activity: [], scroll: 0,
    expandedToolIndexes: new Set() });
  expect(frame.lines.join("|")).not.toContain("대화 기록 없음");
  expect(frame.lines.at(-1)).toBe("❯ ");
});

test('core render keeps prompt when headers grow and clamps a stale scroll offset', () => {
  const frame = renderNextTuiLogFrame({ messages: [], columns: 20, rows: 6,
    header: ['a', 'b', 'c', 'd', 'e', 'f'], footer: ['status'], promptLine: '❯ ',
    notices: [], activity: [], scroll: 100, expandedToolIndexes: new Set() });
  expect(frame.lines.at(-1)).toBe('❯ ');
  expect(frame.lines).toEqual(['a', 'b', 'c', 'd', 'status', '❯ ']);
  expect(frame.scroll).toBe(0);
  expect(frame.logWindow.rows).toBe(0);
});

test('multiline prompt stays bottom pinned and reduces log space within a small screen', () => {
  const frame = renderNextTuiLogFrame({ messages: [], columns: 20, rows: 8,
    header: ['title', 'rule'], footer: ['status'], promptLine: '  tail',
    promptLines: ['❯ first', '  middle', '  tail'], notices: [], activity: [], scroll: 0, expandedToolIndexes: new Set() });
  expect(frame.lines).toHaveLength(8);
  expect(frame.lines.slice(-4)).toEqual(['status', '❯ first', '  middle', '  tail']);
  expect(frame.promptRow).toBe(6);
  expect(frame.logWindow.rows).toBe(2);
});

test('short transcript is bottom anchored so new conversation grows upward', () => {
  const frame = renderNextTuiLogFrame({
    messages: [
      { role: 'user', content: '질문', ts: '2026-11-10T00:00:00Z' },
      { role: 'assistant', content: '답변', ts: '2026-11-10T00:00:01Z' },
    ],
    columns: 40, rows: 10, header: ['title', 'rule'], footer: ['status'], promptLine: '❯ ',
    notices: [], activity: [], scroll: 0, expandedToolIndexes: new Set(),
  });
  expect(frame.body).toEqual(['', '', '나: 질문', '', '엘라누스: 답변', '']);
  expect(frame.lines.at(-2)).toBe('status');
  expect(frame.lines.at(-1)).toBe('❯ ');
});

test('MessageBlock events default folded and Enter reveals one tier without hiding the answer', () => {
  const thought: MessageBlock = {
    id: 'thought-1', ts: 1, source: 'agent', body: { kind: 'thought', text: '긴 사고 원문은 기본 화면에서 숨긴다.' },
    detail: { level: 2, summary: '계약 경계를 확인합니다.', steps: ['입력 조사', '출력 판정'] },
  };
  const levels = new Map<string, 0 | 1 | 2 | 3>();
  const input = { messages: [{ role: 'assistant' as const, content: '최종 답변', ts: '2026-11-10T00:00:00Z' }],
    messageBlocks: [{ block: thought, level: 0 as const }], columns: 80, rows: 10, header: [], footer: [],
    promptLine: '❯ ', notices: [], activity: [], scroll: 0, expandedToolIndexes: new Set<number>() };
  const folded = renderNextTuiLogFrame(input);
  expect(folded.body.join('\n')).toContain('▸ 생각');
  expect(folded.body.join('\n')).not.toContain('(접힘)');
  expect(folded.body.join('\n')).toContain('최종 답변');
  expect(folded.body.join('\n')).not.toContain('긴 사고 원문');

  expect(toggleVisibleMessageBlockDetail(levels, [{ block: thought, afterMessageIndex: 0 }], 80, folded.logWindow,
    input.messages, input.expandedToolIndexes)).toBe(true);
  const summary = renderNextTuiLogFrame({ ...input, messageBlocks: [{ block: thought, level: levels.get(thought.id)! }] });
  expect(summary.body.join('\n')).toContain('계약 경계를 확인합니다.');
  expect(summary.body.join('\n')).not.toContain('입력 조사');

  expect(toggleVisibleMessageBlockDetail(levels, [{ block: thought, afterMessageIndex: 0 }], 80, summary.logWindow,
    input.messages, input.expandedToolIndexes)).toBe(true);
  const steps = renderNextTuiLogFrame({ ...input, messageBlocks: [{ block: thought, level: levels.get(thought.id)! }] });
  expect(steps.body.join('\n')).toContain('입력 조사');
  expect(steps.body.join('\n')).toContain('출력 판정');
});

test('screen-row projection maps mouse clicks to the visible MessageBlock fold target', () => {
  const block: MessageBlock = { id: 'click-thought', ts: 1, source: 'agent',
    body: { kind: 'thought', text: 'detail' }, detail: { level: 1, summary: 'summary' } };
  const frame = renderNextTuiLogFrame({
    messages: [{ role: 'user', content: 'prompt', ts: '2026-11-10T00:00:00Z' },
      { role: 'assistant', content: 'answer', ts: '2026-11-10T00:00:01Z' }],
    messageBlocks: [{ block, level: 0, afterMessageIndex: 1 }], columns: 80, rows: 10,
    header: ['title'], footer: [], promptLine: '❯ ', notices: [], activity: [], scroll: 0,
    expandedToolIndexes: new Set<number>(),
  });
  const target = frame.logWindow.foldTargets.find((candidate) => candidate.kind === 'message');
  expect(target).toBeDefined();
  const row = frame.logWindow.bodyTop + frame.logWindow.leadingBlankRows + target!.start - frame.logWindow.start;
  expect(foldTargetAtScreenRow(frame.logWindow.foldTargets, frame.logWindow, row)).toEqual(target);
  expect(foldTargetAtScreenRow(frame.logWindow.foldTargets, frame.logWindow, frame.logWindow.bodyTop - 1)).toBeUndefined();
});

test('Next history hides internal child-agent polling while classic history remains unchanged', () => {
  const internal = (toolName: string, toolResult: unknown): SerializedMessage => ({
    role: 'tool', content: `⚙️ ${toolName}`, toolName, toolResult, ts: '2026-11-10T00:00:02Z',
  });
  const messages: SerializedMessage[] = [
    { role: 'user', content: 'run three children', ts: '2026-11-10T00:00:00Z' },
    internal('Agent', '{"output":"Agent tool substantive answer"}'),
    internal('Agent', '{"output":{"answer":"structured Agent answer"}}'),
    internal('Agent', '{"error":"Agent child failed with detail"}'),
    internal('Agent', { output: { answer: 'direct structured Agent answer' } }),
    internal('Agent', { output: 'Agent started', error: 'Agent child error despite lifecycle output' }),
    internal('Agent', '{"output":"substantive answer survives empty error","error":""}'),
    internal('Agent', 'Agent started'),
    internal('Agent', 'Agent started: child-2'),
    internal('Agent', 'Agent completed: 42'),
    internal('Agent', 'Agent completed: analysis follows\nsubstantive result tail'),
    internal('Agent', '{"output":"(running in background — taskId=child-3)","background":true}'),
    internal('Agent', '(running in background — taskId=child-4)'),
    internal('Agent', JSON.stringify({ output: '(running in background — taskId=child-5)\nsubstantive result tail after dispatch' })),
    internal('Agent', ''),
    internal('AgentOutput', '{"taskId":"child-1","state":"done","output":"child result secret"}'),
    internal('AgentList', '{"tasks":["child-1"]}'),
    internal('TaskGet', '{"taskId":"child-1","state":"done"}'),
    internal('TaskList', '{"tasks":["child-1"]}'),
    internal('update_goal', '{"goal":"private goal data"}'),
    internal('UpdateGoal', '{"goal":"private alias goal"}'),
    ...['AgentOutput', 'AgentList', 'TaskGet', 'TaskList', 'update_goal', 'UpdateGoal']
      .flatMap((toolName) => [
        internal(toolName, JSON.stringify({ error: `${toolName} failure visible` })),
        internal(toolName, `Error: ${toolName} polling failed`),
        internal(toolName, JSON.stringify({ error: { message: `structured ${toolName} failure visible` } })),
        internal(toolName, { error: { message: `direct object ${toolName} failure visible` } }),
      ]),
    { role: 'assistant', content: 'completed', ts: '2026-11-10T00:00:03Z' },
  ];
  const classicScreen = logViewLines(messages, 80).join('\n');
  const updateGoalBlock: MessageBlock = {
    id: 'goal-update-alias', ts: 5, source: 'tool',
    body: { kind: 'tool-call', toolCallId: 'd', title: 'UpdateGoal' },
    detail: { level: 1, summary: 'UPDATE_GOAL_CALL_BLOCK_MUST_STAY_HIDDEN' },
  };
  expect(messageBlockDetailLines(updateGoalBlock, 0, 80).join('\n'))
    .toContain('UPDATE_GOAL_CALL_BLOCK_MUST_STAY_HIDDEN');
  const frame = renderNextTuiLogFrame({
    messages,
    messageBlocks: [
      { block: { id: 'agent-call', ts: 2, source: 'tool', body: { kind: 'tool-call', toolCallId: 'a', title: 'Agent' } }, level: 0 },
      { block: { id: 'agent-output', ts: 3, source: 'tool', body: { kind: 'tool-call', toolCallId: 'b', title: 'AgentOutput' } }, level: 0 },
      { block: { id: 'goal-update', ts: 4, source: 'tool', body: { kind: 'tool-call', toolCallId: 'c', title: 'update_goal' } }, level: 0 },
      { block: updateGoalBlock, level: 0 },
    ],
    columns: 80, rows: messages.length * 4, header: [], footer: [], promptLine: '❯ ', notices: [], activity: [], scroll: 0,
    expandedToolIndexes: new Set<number>(),
  });
  const screen = frame.body.join('\n');
  expect(classicScreen).toContain('AgentOutput');
  expect(classicScreen).toContain('private goal data');
  expect(screen).toContain('Agent tool substantive answer');
  expect(screen).toContain('structured Agent answer');
  expect(screen).toContain('Agent child failed with detail');
  expect(screen).toContain('direct structured Agent answer');
  expect(screen).toContain('Agent child error despite lifecycle output');
  expect(screen).toContain('substantive answer survives empty error');
  expect(screen).toContain('substantive result tail');
  expect(screen).toContain('substantive result tail after dispatch');
  expect(screen.match(/running in background/g)?.length).toBe(1); // Source: the one fixture with a substantive result tail remains visible.
  expect(screen).not.toContain('child-3');
  expect(screen).not.toContain('child-4');
  expect(screen).not.toContain('child result secret');
  expect(screen).toContain('AgentOutput failure visible');
  expect(screen).toContain('AgentList failure visible');
  expect(screen).toContain('TaskGet failure visible');
  expect(screen).toContain('TaskList failure visible');
  expect(screen).toContain('update_goal failure visible');
  expect(screen).toContain('UpdateGoal failure visible');
  expect(screen).toContain('Error: AgentOutput polling failed');
  expect(screen).toContain('Error: AgentList polling failed');
  expect(screen).toContain('Error: TaskGet polling failed');
  expect(screen).toContain('Error: TaskList polling failed');
  expect(screen).toContain('Error: update_goal polling failed');
  expect(screen).toContain('Error: UpdateGoal polling failed');
  expect(screen).toContain('structured AgentOutput failure visible');
  expect(screen).toContain('structured AgentList failure visible');
  expect(screen).toContain('structured TaskGet failure visible');
  expect(screen).toContain('structured TaskList failure visible');
  expect(screen).toContain('structured update_goal failure visible');
  expect(screen).toContain('structured UpdateGoal failure visible');
  expect(screen).toContain('direct object AgentOutput failure visible');
  expect(screen).toContain('direct object AgentList failure visible');
  expect(screen).toContain('direct object TaskGet failure visible');
  expect(screen).toContain('direct object TaskList failure visible');
  expect(screen).toContain('direct object update_goal failure visible');
  expect(screen).toContain('direct object UpdateGoal failure visible');
  expect(screen).not.toContain('UPDATE_GOAL_CALL_BLOCK_MUST_STAY_HIDDEN');
  expect(screen).not.toContain('Agent started');
  expect(screen).not.toContain('child-2');
  expect(screen).toContain('Agent completed: 42');
  expect(screen).not.toContain('엘라누스: \n');
  expect(screen).not.toContain('private goal data');
  expect(screen).not.toContain('private alias goal');
  expect(screen).toContain('나: run three children');
  expect(screen).toContain('엘라누스: completed');
});

test('fold targets include both the MessageBlock and saved tool row in transcript order', () => {
  const longTool: SerializedMessage = { ...tool, ts: '2026-11-10T00:00:01Z' };
  const user: SerializedMessage = { role: 'user', content: '질문', ts: '2026-11-10T00:00:00Z' };
  const block: MessageBlock = { id: 'turn:call', ts: 1, source: 'tool',
    body: { kind: 'tool-call', toolCallId: 'call', title: 'Read' }, detail: { level: 3, summary: '파일 읽기' } };
  const input = { messages: [user, longTool], messageBlocks: [{ block, level: 0 as const, afterMessageIndex: 0 }],
    columns: 30, rows: 8, header: [], footer: [], promptLine: '❯ ', notices: [], activity: [], scroll: 0,
    expandedToolIndexes: new Set<number>() };
  const folded = renderNextTuiLogFrame(input);
  expect(folded.logWindow.foldTargets.map((target) => target.kind)).toEqual(['message', 'tool']);
  expect(folded.logWindow.foldTargets.at(-1)?.kind).toBe('tool');
  input.expandedToolIndexes.add(1);
  const toolExpanded = renderNextTuiLogFrame(input);
  expect(toolExpanded.logWindow.foldTargets.some((target) => target.kind === 'message')).toBe(true);
});

test('MessageBlocks are inserted into their own turn instead of appended after later answers', () => {
  const first: MessageBlock = { id: 'run-1:status', ts: 1, source: 'system', body: { kind: 'status', text: '첫 턴 상태' },
    detail: { level: 1, summary: '첫 턴 상태 요약' } };
  const second: MessageBlock = { id: 'run-2:status', ts: 2, source: 'system', body: { kind: 'status', text: '둘째 턴 상태' },
    detail: { level: 1, summary: '둘째 턴 상태 요약' } };
  const frame = renderNextTuiLogFrame({ messages: [
    { role: 'user', content: '첫 질문', ts: '2026-11-10T00:00:00Z' },
    { role: 'assistant', content: '첫 답', ts: '2026-11-10T00:00:01Z' },
    { role: 'user', content: '둘째 질문', ts: '2026-11-10T00:00:02Z' },
    { role: 'assistant', content: '둘째 답', ts: '2026-11-10T00:00:03Z' },
  ], messageBlocks: [
    { block: first, level: 1, afterMessageIndex: 0 }, { block: second, level: 1, afterMessageIndex: 2 },
  ], columns: 80, rows: 20, header: [], footer: [], promptLine: '❯ ', notices: [], activity: [], scroll: 0,
  expandedToolIndexes: new Set() });
  const text = frame.body.join('\n');
  expect(text.indexOf('첫 질문')).toBeLessThan(text.indexOf('첫 턴 상태 요약'));
  expect(text.indexOf('첫 턴 상태 요약')).toBeLessThan(text.indexOf('첫 답'));
  expect(text.indexOf('첫 답')).toBeLessThan(text.indexOf('둘째 질문'));
  expect(text.indexOf('둘째 질문')).toBeLessThan(text.indexOf('둘째 턴 상태 요약'));
  expect(text.indexOf('둘째 턴 상태 요약')).toBeLessThan(text.indexOf('둘째 답'));
});
