import { expect, test } from 'bun:test';
import { createGoalContinue, TURN_RUNNING_RETRY_BASE_MS } from './goal-continue.js';
import type { StartTurnIfIdleResult } from './internal-turn.js';

/**
 * TURN-FIELD-BUG-5 (OP #91474/#91487): the turn-end goal check runs inside settle while busy is still up, so the gate
 * answers NotIdle «turn-running». The continuation must come right after busy drops — not after the 10.5 s retry.
 */
/** Same fixture as goal-continue-seat-cap.test.ts — a seat-cap turn end always arms the controller. */
const pledge = { lines: ['  진행: 3단계까지 끝냈습니다 · 남은 것: 4~5단계'], stopReason: 'max_turns' } as const;

function rig(answers: StartTurnIfIdleResult[]) {
  const waits: number[] = [];
  const queue: Array<() => void> = [];
  let calls = 0;
  const gc = createGoalContinue({
    startTurnIfIdle: () => answers[Math.min(calls++, answers.length - 1)]!,
    isEnabled: () => true,
    defer: (fn, ms) => { waits.push(ms); queue.push(fn); },
    retryMs: 10_500, // 출처: goal-continue.ts default retryMs (ELANOUS_GOAL_CONTINUE_RETRY_MS unset)
    log: () => {},
  });
  return { gc, waits, runNext: () => queue.shift()?.(), calls: () => calls };
}

const turnRunning = { opened: false, reason: 'NotIdle', detail: 'turn-running' } as StartTurnIfIdleResult;
const opened = { opened: true, turnId: 'auto-1' } as StartTurnIfIdleResult;

test('a turn-running refusal at turn end retries after 50 ms, and the retry opens the continuation', () => {
  const r = rig([turnRunning, opened]);
  r.gc.noteTurnEnded(pledge);
  expect(r.gc.check()).toEqual({ opened: false, reason: 'NotIdle' });
  expect(r.waits).toEqual([TURN_RUNNING_RETRY_BASE_MS]);
  expect(TURN_RUNNING_RETRY_BASE_MS).toBe(50);
  r.runNext();
  expect(r.calls()).toBe(2);
});

test('a turn that keeps running backs off 50 → 100 → 200 … and never waits longer than retryMs', () => {
  const r = rig([turnRunning]);
  r.gc.noteTurnEnded(pledge);
  r.gc.check();
  for (let i = 0; i < 9; i++) r.runNext();
  expect(r.waits).toEqual([50, 100, 200, 400, 800, 1600, 3200, 6400, 10500, 10500]);
});

test('other refusals keep the old wait (a person typing → retryMs)', () => {
  const r = rig([{ opened: false, reason: 'HumanTyping', detail: 'buffer' } as StartTurnIfIdleResult]);
  r.gc.noteTurnEnded(pledge);
  r.gc.check();
  expect(r.waits).toEqual([10500]);
});

test('a new turn end resets the back-off', () => {
  const r = rig([turnRunning]);
  r.gc.noteTurnEnded(pledge);
  r.gc.check();
  r.runNext();
  r.runNext();
  r.gc.noteTurnEnded(pledge);
  r.runNext();
  expect(r.waits.slice(-1)).toEqual([50]);
});
