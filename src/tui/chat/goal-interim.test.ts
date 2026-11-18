import { afterEach, beforeEach, expect, test } from 'bun:test';
import { formatGoalContinuePrompt } from '../input/goal-continue.js';
import { logViewLines } from './log-view.js';
import { classifyInterimReply, planInterimDisplay } from './goal-interim.js';

// The band colour follows COLORFGBG (turn-band-theme.ts); pin it so the expectation never depends on the terminal
// the tests run in (#38379 REVIEW-1). '15;0' = light text on a dark background → the dark token.
const previousColorfgbg = process.env.COLORFGBG;
beforeEach(() => { process.env.COLORFGBG = '15;0'; });
afterEach(() => { if (previousColorfgbg === undefined) delete process.env.COLORFGBG; else process.env.COLORFGBG = previousColorfgbg; });

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
  // Dark token: grey 235 band, grey 252 text (literal — rule 11).
  const band = '\u001b[48;5;235;38;5;252m\u001b[1m>\u001b[22m n8n 영상 만들기' + ' '.repeat(83) + '\u001b[0m';
  expect(lines).toEqual([
    band, 'Tool: ScheduleWakeup 예약됨',
    '  · in progress — 1단계 렌더했습니다. (folded)',
    '  · in progress — 2단계 렌더했습니다. (folded)',
    '최종 영상: /tmp/final.mp4',
  ]);
  const continued = [...messages.slice(0, 3), { role: 'user' as const, content: formatGoalContinuePrompt('다음 단계'), ts }];
  expect(planInterimDisplay(continued).get(2)?.kind).toBe('folded');
  expect(classifyInterimReply(['최종 영상: /tmp/final.mp4']).interim).toBe(false);
});

// #38379 REVIEW-1: the same row on a light terminal carries the light token.
test('on a light terminal (COLORFGBG says light) the user row uses the light band token', () => {
  process.env.COLORFGBG = '0;15';
  const rows = logViewLines([{ role: 'user', content: 'n8n 영상 만들기', ts: '2026-11-17T00:00:00Z' }], 100);
  expect(rows[0]).toStartWith('\u001b[48;5;255;38;5;235m'); // light token: grey 255 band, grey 235 text
  expect(rows[0]).not.toStartWith('\u001b[48;5;235;38;5;252m');
});
