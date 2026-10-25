import { expect, test } from 'bun:test';
import { formatGoalContinuePrompt } from '../../dashboard/input/goal-continue.js';
import { logViewLines } from './log-view.js';
import { classifyInterimReply, planInterimDisplay } from './goal-interim.js';

test('one goal with two marked interim iterations and a final result uses the next production renderer', () => {
  const ts = '2026-10-22T00:00:00.000Z';
  const messages = [
    { role: 'user' as const, content: 'n8n 영상 만들기', ts },
    { role: 'tool' as const, content: '', toolName: 'ScheduleWakeup', toolResult: '예약됨', ts },
    { role: 'assistant' as const, content: '1단계 렌더했습니다.\n아직 못 했습니다.', goalInterim: true, ts },
    { role: 'assistant' as const, content: '2단계 렌더했습니다.\n아직 못 했습니다.', goalInterim: true, ts },
    { role: 'assistant' as const, content: '최종 영상: /tmp/final.mp4', ts },
  ];
  const plan = planInterimDisplay(messages);
  expect([plan.get(2)?.kind, plan.get(3)?.kind, plan.get(4)]).toEqual(['folded', 'folded', undefined]);
  const lines = logViewLines(messages, 100).filter(Boolean);
  expect(lines).toEqual([
    '나: n8n 영상 만들기', '도구: ScheduleWakeup 예약됨',
    '엘라누스: · 진행 — 1단계 렌더했습니다. (접힘)',
    '엘라누스: · 진행 — 2단계 렌더했습니다. (접힘)',
    '엘라누스: 최종 영상: /tmp/final.mp4',
  ]);
  const continued = [...messages.slice(0, 3), { role: 'user' as const, content: formatGoalContinuePrompt('다음 단계'), ts }];
  expect(planInterimDisplay(continued).get(2)?.kind).toBe('folded');
  expect(classifyInterimReply(['최종 영상: /tmp/final.mp4']).interim).toBe(false);
});
