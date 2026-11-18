import { expect, test } from 'bun:test';
import { outcomeOfPlanWire, parsePlanWire, planWireFromState } from './plan-wire.js';
import type { PlanState } from './plan-tool.js';

const state = (steps: PlanState['steps'], version: number): PlanState => ({ steps, updatedAt: 0, version });

test('a plan survives the child → host round trip through JSON, and an empty plan sends nothing', () => {
  const wire = planWireFromState(state([
    { step: 'Follow the chain', status: 'in_progress' },
    { step: 'Wait for the gate', status: 'waiting', wake: { kind: 'pr', target: 'x' } },
    { step: 'Need a key', status: 'blocked', reason: 'operator must approve' },
  ], 3), 1)!;
  expect(parsePlanWire(JSON.parse(JSON.stringify(wire)))).toEqual(wire);
  expect(planWireFromState(state([], 0), 0)).toBeUndefined();
});

test('malformed snapshots are dropped, not guessed at', () => {
  for (const bad of [null, 'x', {}, { version: 1, versionAtTurnStart: 0, steps: [] },
    { version: 1, versionAtTurnStart: 0, steps: [{ step: 'a', status: 'done' }] },
    { version: 1, versionAtTurnStart: 0, steps: [{ step: 3, status: 'pending' }] }]) {
    expect(parsePlanWire(bad)).toBeUndefined();
  }
});

test('verdicts come from the snapshot: no snapshot is a gap, an untouched plan is a gap, open work continues', () => {
  expect(outcomeOfPlanWire(undefined)).toEqual({ kind: 'gap', why: 'no-plan' });
  const open = planWireFromState(state([{ step: 'a', status: 'pending' }], 2), 1)!;
  expect(outcomeOfPlanWire(open)).toEqual({ kind: 'continue', step: 'a' });
  const untouched = planWireFromState(state([{ step: 'a', status: 'pending' }], 2), 2)!;
  expect(outcomeOfPlanWire(untouched)).toEqual({ kind: 'gap', why: 'plan-not-updated' });
});
