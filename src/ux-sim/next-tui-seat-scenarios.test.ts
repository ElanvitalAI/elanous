import { expect, test } from 'bun:test';
import { goalInterimScreenCounts } from './next-tui-seat-scenarios.js';
import { logViewLines } from '../tui/chat/log-view.js';
import { GOAL_INTERIM_RENDER_TRACE, goalInterimRenderMessages } from './goal-interim-trace.js';

test('next TUI production log renders two n8n iterations in one line each and retains final and tool', () => {
  const ts = '2026-10-22T00:00:00.000Z';
  const messages = goalInterimRenderMessages(ts);
  const screen = logViewLines(messages, 100).join('\n');
  const counts = goalInterimScreenCounts(screen);
  expect(counts).toEqual({ steps: GOAL_INTERIM_RENDER_TRACE.interimReplies.length, notDone: 0, folded: GOAL_INTERIM_RENDER_TRACE.interimReplies.length, userHeader: false });
  const interimLines = screen.split('\n').filter((line) => line.includes('단계 렌더를 진행했습니다'));
  expect(interimLines).toHaveLength(2);
  expect(interimLines.every((line) => line.includes('(접힘)') && !line.includes('아직 못 했습니다'))).toBe(true);
  expect(screen).toContain(GOAL_INTERIM_RENDER_TRACE.finalReply);
  expect(screen).toContain('도구: ScheduleWakeup');
});
