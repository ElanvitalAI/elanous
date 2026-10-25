import { expect, test } from 'bun:test';
import { goalInterimScreenCounts, GOAL_INTERIM_NOT_DONE_REPLY } from './next-tui-seat-scenarios.js';
import { logViewLines } from '../tui/chat/log-view.js';

test('next TUI production log renders two n8n iterations in one line each and retains final and tool', () => {
  const ts = '2026-10-22T00:00:00.000Z';
  const messages = [
    { role: 'user' as const, content: '영상 만들어줘', ts },
    { role: 'tool' as const, content: '', toolName: 'ScheduleWakeup', toolResult: '예약됨', ts },
    ...[1, 2].map((step) => ({ role: 'assistant' as const, goalInterim: true, ts, content: GOAL_INTERIM_NOT_DONE_REPLY.replaceAll('{step}', String(step)) })),
    { role: 'assistant' as const, content: '최종 영상: /tmp/final.mp4', ts },
  ];
  const screen = logViewLines(messages, 100).join('\n');
  const counts = goalInterimScreenCounts(screen);
  expect(counts).toEqual({ steps: 2, notDone: 0, folded: 2, userHeader: false });
  expect(screen.split('\n').filter((line) => line.includes('단계 렌더를 진행했습니다'))).toHaveLength(2);
  expect(screen).toContain('최종 영상: /tmp/final.mp4');
  expect(screen).toContain('도구: ScheduleWakeup');
});
