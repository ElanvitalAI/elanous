import { expect, test } from 'bun:test';
import { classifyReplyTail, createGoalContinue, DEFAULT_SEAT_CAP_CONTINUE_LIMIT } from './goal-continue.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from './internal-turn.js';

const harness = (extra: { seatCapContinueLimit?: number } = {}) => {
  const opened: { text: string; origin?: string }[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const notices: string[] = [];
  const gc = createGoalContinue({
    startTurnIfIdle: (text: string, opts: StartTurnIfIdleOptions): StartTurnIfIdleResult => {
      opened.push({ text, origin: opts.origin });
      return { opened: true, turnId: `t${opened.length}` } as StartTurnIfIdleResult;
    },
    isEnabled: () => true,
    notify: (line) => notices.push(line),
    log: (_c, event, data) => events.push({ event, data }),
    ...extra,
  });
  return { gc, opened, events, notices };
};

const capped = { lines: ['  진행: 3단계까지 끝냈습니다 · 남은 것: 4~5단계'], stopReason: 'max_turns' } as const;

test('seat-cap exhaustion opens the next turn by itself, up to the limit, then asks for a person', () => {
  const h = harness();
  for (let n = 1; n <= DEFAULT_SEAT_CAP_CONTINUE_LIMIT; n++) {
    h.gc.noteTurnEnded(capped);
    expect(h.gc.check()).toEqual({ opened: true, reason: 'seat-cap' });
    expect(h.events.at(-1)).toMatchObject({ event: 'turn.auto-continue', data: { opened: true, reason: 'seat-cap', n, limit: DEFAULT_SEAT_CAP_CONTINUE_LIMIT } });
  }
  expect(h.opened.length).toBe(DEFAULT_SEAT_CAP_CONTINUE_LIMIT);
  h.gc.noteTurnEnded(capped);
  expect(h.gc.check()).toEqual({ opened: false, reason: 'seat-cap-limit' });
  expect(h.opened.length).toBe(DEFAULT_SEAT_CAP_CONTINUE_LIMIT); // nothing more opened
  expect(h.notices.at(-1)).toContain('a person is needed');
  // A person's turn resets the budget.
  h.gc.noteHumanTurn();
  h.gc.noteTurnEnded(capped);
  expect(h.gc.check().opened).toBe(true);
});

test('a blocked reply (needs a person) or a failed/cancelled turn never auto-continues after the cap', () => {
  const blocked = harness();
  blocked.gc.noteTurnEnded({ lines: ['로그인이 필요합니다. 사람이 로그인해 주세요.'], stopReason: 'max_turns' });
  expect(blocked.gc.check()).toEqual({ opened: false, reason: 'not-armed' });
  expect(blocked.events.at(-1)).toMatchObject({ event: 'turn.auto-continue', data: { rejected: true, reason: 'blocked-needs-person' } });
  const asks = harness();
  asks.gc.noteTurnEnded({ lines: ['상한에 닿았습니다. 어느 쪽으로 이어갈까요?'], stopReason: 'max_turns' });
  expect(asks.gc.check().opened).toBe(false);
  const failed = harness();
  failed.gc.noteTurnEnded({ lines: ['x'], stopReason: 'max_turns', failed: true });
  expect(failed.gc.check().opened).toBe(false);
});

test('the same capped reply may repeat — progress is counted by the budget, not by the answer text', () => {
  const h = harness();
  h.gc.noteTurnEnded(capped); expect(h.gc.check().opened).toBe(true);
  h.gc.noteTurnEnded(capped); expect(h.gc.check().opened).toBe(true);
});

test('a seat-cap continue waits for the loop to take the turn, then stops and does not re-arm (ELN-TURN-CAP ③)', async () => {
  const notices: string[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  let taken = true;
  const gc = createGoalContinue({
    startTurnIfIdle: (text) => { opened.push(text); return { opened: true, turnId: `cap-${opened.length}` }; },
    isEnabled: () => true,
    notify: (line) => notices.push(line),
    log: (_c, event, data) => events.push({ event, data }),
    confirmSeatCapTurnStarted: async () => taken,
  });
  gc.noteTurnEnded(capped);
  expect(gc.check()).toEqual({ opened: true, reason: 'seat-cap-pending' });
  await Bun.sleep(0);
  expect(events.at(-1)).toMatchObject({ event: 'turn.auto-continue', data: { opened: true, reason: 'seat-cap', turnId: 'cap-1' } });
  taken = false;
  gc.noteTurnEnded(capped);
  expect(gc.check()).toEqual({ opened: true, reason: 'seat-cap-pending' });
  await Bun.sleep(0);
  expect(events.at(-1)).toMatchObject({ event: 'turn.auto-continue', data: { rejected: true, reason: 'seat-cap-not-started', turnId: 'cap-2' } });
  expect(notices.at(-1)).toBe('⏸ 멈춤 · Enter 로 계속');
  // Stopped means not re-armed: another check does not open a third turn.
  expect(gc.check()).toEqual({ opened: false, reason: 'not-armed' });
  expect(opened).toHaveLength(2);
});

test('a declared next step as a noun phrase is a pledge (S1), a result report is not', () => {
  for (const tail of ['배선 재료 확인 완료. 다음 자리 턴: 이 두 곳에 producers 배선 + 시험 → head 갱신', '진행 한 줄 끝. 다음 스텝: README 갱신과 시험 실행', 'Done with step 2. Next step: run the full test suite and report']) {
    const verdict = classifyReplyTail(tail);
    expect(verdict.pledge).toBe(true);
  }
  expect(classifyReplyTail('모두 완료했습니다. 다음 스텝은 필요 없습니다.').pledge).toBe(false);
  expect(classifyReplyTail('다음 스텝: 어느 방향으로 갈까요?').pledge).toBe(false);
  expect(classifyReplyTail('결과: 24/24 통과.').pledge).toBe(false);
});

test('the declared-next-step path also emits turn.auto-continue', () => {
  const h = harness();
  h.gc.noteTurnEnded({ lines: ['진행 한 줄 끝. 다음 스텝: README 갱신과 시험 실행'] });
  expect(h.gc.check().opened).toBe(true);
  expect(h.events.some((e) => e.event === 'turn.auto-continue' && e.data.reason === 'declared-next-step')).toBe(true);
});
