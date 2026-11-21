import { expect, test } from 'bun:test';
import { goalInterimScreenCounts, queueWakeInterrupted, queueWakeResponseShown } from './next-tui-seat-scenarios.js';
import { logViewLines } from '../tui/chat/log-view.js';
import { GOAL_INTERIM_RENDER_TRACE, goalInterimRenderMessages } from './goal-interim-trace.js';

test('queue wake requires a new response after the queued turn and the actual composer draft', () => {
  const reply = '[fake-llm] 답했습니다';
  const wake = `old ${reply}\n› 다섯째\n${reply}\n❯ 미전송 초안`;
  expect(queueWakeResponseShown(wake, reply)).toBe(true); // banner has already disappeared
  expect(queueWakeResponseShown(`old ${reply}\n› 다섯째\n❯ 미전송 초안`, reply)).toBe(false);
  expect(queueWakeResponseShown(`미전송 초안\n› 다섯째\n${reply}\n❯ 다른 초안`, reply)).toBe(false);
  expect(queueWakeResponseShown(`› 다른 질문\n${reply}\n❯ 미전송 초안`, reply)).toBe(false);
  expect(queueWakeResponseShown(`› 다섯째\n${reply}\n❯ 미전송 초안\nConfirm stopping turn`, reply)).toBe(false);
});

test('queue wake requires cancellation before dispatch and an interruption marker between turns', () => {
  const cancel = { category: 'tui.next', event: 'turn-latency', data: JSON.stringify({ outcome: 'cancelled' }) };
  const dispatch = { category: 'tui.next', event: 'queue-dispatched', data: JSON.stringify({ remaining: 0 }) };
  const users = ['쓰던 초안 천천히', '[사용자가 이 턴을 중단했습니다]', 'interrupted\n\n다섯째'];
  expect(queueWakeInterrupted([cancel, dispatch], users)).toBe(true);
  expect(queueWakeInterrupted([dispatch, cancel], users)).toBe(false);
  expect(queueWakeInterrupted([cancel, dispatch], [users[0]!, users[2]!])).toBe(false);
  expect(queueWakeInterrupted([{ ...cancel, data: '{"outcome":"completed"}' }, dispatch], users)).toBe(false);
});

test('next TUI production log renders two n8n iterations in one line each and retains final and tool', () => {
  const ts = '2026-10-22T00:00:00.000Z';
  const messages = goalInterimRenderMessages(ts);
  const screen = logViewLines(messages, 100).join('\n');
  const counts = goalInterimScreenCounts(screen);
  expect(counts).toEqual({ steps: GOAL_INTERIM_RENDER_TRACE.interimReplies.length, notDone: 0, folded: GOAL_INTERIM_RENDER_TRACE.interimReplies.length, userHeader: false });
  const interimLines = screen.split('\n').filter((line) => line.includes('단계 렌더를 진행했습니다'));
  expect(interimLines).toHaveLength(2);
  expect(interimLines.every((line) => (line.includes('(접힘)') || line.includes('(folded)')) && !line.includes('아직 못 했습니다'))).toBe(true);
  expect(screen).toContain(GOAL_INTERIM_RENDER_TRACE.finalReply);
  expect(['도구: ScheduleWakeup', 'Tool: ScheduleWakeup'].some((label) => screen.includes(label))).toBe(true); // #38144 English chrome
  expect(screen).toContain('Tool: ScheduleWakeup');
});
