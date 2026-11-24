// TUI-ANSWER-VANISH-ON-TOOLCALL ④ — residual vanish after #39868 (OP seat 11-24 06:2x, build 261124_0558).
// No reload and no answer-drop event: the answer disappeared in the basic chat projection. While busy, entry.ts
// hid the trailing saved answer as «the running turn's own» (nextTuiPublicHistory(…, busy)). A turn opened by a
// seat-mail notice auto-submit, a wake-up, a capsule-done notice or another event has no echoed user row, so the
// trailing answer was the PREVIOUS turn's finished answer — blanked the moment the event's turn started.
import { expect, test } from 'bun:test';
import type { SerializedMessage } from '../../session/index.js';
import { createNextTuiPublicHistoryView } from '../entry.js';

const ANSWER = '**0.3.34는 아직 발행되지 않았습니다.** REL에 재검과 컷 영수 보고를 요청했습니다.';
const answered: SerializedMessage[] = [
  { role: 'user', content: '네 버전 발행 상태 잘 챙겨주세요', ts: '2026-11-23T21:20:00.000Z' },
  { role: 'tool', content: '⚙️ MsgList', ts: '2026-11-23T21:20:05.000Z', toolName: 'MsgList' },
  { role: 'assistant', content: ANSWER, ts: '2026-11-23T21:20:30.000Z', replyFinal: true },
];
const shown = (view: readonly SerializedMessage[]) => view.filter((row) => row.role === 'assistant').map((row) => row.content);

for (const opener of ['seat-mail notice auto-submit', 'scheduled wake-up', 'capsule-done notice', 'event-while-busy dispatch']) {
  test(`${opener} opens a turn → the previous answer stays on screen while that turn runs`, () => {
    const view = createNextTuiPublicHistoryView();
    expect(shown(view(answered, false))).toEqual([ANSWER]);
    const nextTurnStartedAt = Date.parse('2026-11-23T21:21:00.000Z');
    expect(shown(view(answered, true, nextTurnStartedAt))).toEqual([ANSWER]);
  });
}

test('the running turn still hides its own saved answer while its live preview shows it (no double answer)', () => {
  const view = createNextTuiPublicHistoryView();
  const turnStartedAt = Date.parse('2026-11-23T21:21:00.000Z');
  const ownAnswer: SerializedMessage = { role: 'assistant', content: '이번 턴의 답', ts: '2026-11-23T21:21:40.000Z', replyFinal: true };
  const rows = [...answered, { role: 'user' as const, content: '[notice · seat-mail] digest', ts: '2026-11-23T21:21:00.500Z' }, ownAnswer];
  expect(shown(view(rows, true, turnStartedAt))).toEqual([ANSWER]);
  expect(shown(view(rows, false, turnStartedAt))).toEqual([ANSWER, '이번 턴의 답']);
});
