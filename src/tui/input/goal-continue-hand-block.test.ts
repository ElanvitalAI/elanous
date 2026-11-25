// GOAL-BLOCK-NOT-HUMAN (rail 31 · 11-25 19:05) — a hand's blocked plan is its cell waiting: no ✋, the host gets the stop.
import { expect, test } from 'bun:test';
import { createGoalContinue } from './goal-continue.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from './internal-turn.js';
import type { PlanWire, PlanWireStep } from '../../code-edit/plan-wire.js';

const harness = (hand: boolean) => {
  const notices: string[] = [];
  const blocked: string[] = [];
  const handWaits: { kind: string; progressed: boolean }[] = [];
  const gc = createGoalContinue({
    startTurnIfIdle: (_t: string, _o: StartTurnIfIdleOptions): StartTurnIfIdleResult => ({ opened: true, turnId: 't1' }) as StartTurnIfIdleResult,
    isEnabled: () => true,
    notify: (line) => notices.push(line),
    log: () => {},
    onBlocked: (reason) => blocked.push(reason),
    seat: 'TC-H-CX-2',
    ...(hand ? { handSeat: true, onHandCellWait: (stop: { kind: string }, progressed: boolean) => { handWaits.push({ kind: stop.kind, progressed }); } } : {}),
  });
  return { gc, notices, blocked, handWaits };
};
const plan = (steps: PlanWireStep[]): PlanWire => ({ version: 2, versionAtTurnStart: 1, steps });
const RES_APPROVAL: PlanWireStep = { status: 'blocked', step: 'run isolation probe', reason: 'needs RES isolation approval', code: 'APPROVAL_PENDING' };

test('hand: a block on another seat raises no ✋ and no «a person is needed» — the host gets the stop', () => {
  const h = harness(true);
  h.gc.noteTurnEnded({ lines: ['…'], plan: plan([{ status: 'completed', step: 'read cell' }, RES_APPROVAL]) });
  expect(h.blocked).toEqual([]);
  expect(h.notices.join('\n')).not.toContain('a person is needed');
  expect(h.notices.at(-1)).toContain('parking it and pulling the next cell');
  expect(h.handWaits).toEqual([{ kind: 'blocked', progressed: false }]);
});

test('hand: waiting for a new decision is the same cell wait', () => {
  const h = harness(true);
  h.gc.noteTurnEnded({ lines: ['…'], plan: plan([{ status: 'waiting', step: 'new decision', wake: { kind: 'message', target: 'TC' } }]) });
  expect(h.handWaits).toEqual([{ kind: 'waiting', progressed: false }]);
});

test('hand: its own tool refusal still stops for a person', () => {
  const h = harness(true);
  h.gc.noteTurnEnded({ lines: ['…'], plan: plan([{ status: 'blocked', step: 'write', reason: 'tool denied', code: 'TOOL_DENIED' }]) });
  expect(h.blocked).toEqual(['TOOL_DENIED']);
  expect(h.handWaits).toEqual([]);
});

test('coordinator (not a hand): the block still raises ✋ as before', () => {
  const h = harness(false);
  h.gc.noteTurnEnded({ lines: ['…'], plan: plan([RES_APPROVAL]) });
  expect(h.blocked).toEqual(['APPROVAL_PENDING']);
  expect(h.notices.at(-1)).toContain('a person is needed');
});
