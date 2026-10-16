import { expect, test } from 'bun:test';
import { GATE_PREWARM_WINDOW_MS, GATE_PREWARM_OBSERVATION_MAX_AGE_MS, planGatePrewarm, type GatePrewarmInput } from './gate-prewarm-plan.js';

const base: GatePrewarmInput = {
  nowMs: 1_000_000, cutAtMs: 1_000_000 + GATE_PREWARM_WINDOW_MS,
  cutSha: 'a'.repeat(40), lockHash: 'b'.repeat(64), sourceSha: 'a'.repeat(40), sourceLockHash: 'b'.repeat(64),
  mirrorCommitSha: 'a'.repeat(40), observedAtMs: 1_000_000,
  occupiedPods: 2, capacity: 4, gateDemand: 0, taskDemand: 0,
};

test('prewarm starts only inside the window with a measured free slot', () => {
  expect(planGatePrewarm(base)).toEqual({ action: 'start-worker', cutSha: base.cutSha, lockHash: base.lockHash, slotAfter: 1 });
  expect(planGatePrewarm({ ...base, cutAtMs: base.cutAtMs + 1 })).toEqual({ action: 'defer', reason: 'outside-window' });
  expect(planGatePrewarm({ ...base, cutAtMs: base.nowMs })).toEqual({ action: 'defer', reason: 'outside-window' });
  expect(planGatePrewarm({ ...base, occupiedPods: 4 })).toEqual({ action: 'defer', reason: 'no-slot' });
});

test('higher-priority gate and task demand withhold prewarm, including mirror preparation', () => {
  for (const demand of [{ gateDemand: 1 }, { taskDemand: 1 }]) {
    expect(planGatePrewarm({ ...base, ...demand })).toEqual({ action: 'defer', reason: 'higher-priority' });
    expect(planGatePrewarm({ ...base, mirrorCommitSha: null, ...demand })).toEqual({ action: 'defer', reason: 'higher-priority' });
  }
});

test('missing observation fails closed; missing mirror requests preparation without claiming a Pod', () => {
  expect(planGatePrewarm({ ...base, mirrorCommitSha: undefined })).toEqual({ action: 'defer', reason: 'unmeasured' });
  expect(planGatePrewarm({ ...base, occupiedPods: null })).toEqual({ action: 'defer', reason: 'unmeasured' });
  expect(planGatePrewarm({ ...base, gateDemand: null })).toEqual({ action: 'defer', reason: 'unmeasured' });
  expect(planGatePrewarm({ ...base, mirrorCommitSha: '' })).toEqual({ action: 'defer', reason: 'invalid-input' });
  expect(planGatePrewarm({ ...base, mirrorCommitSha: null, occupiedPods: 4 })).toEqual({ action: 'prepare-mirror', cutSha: base.cutSha, lockHash: base.lockHash });
  expect(planGatePrewarm({ ...base, mirrorCommitSha: 'c'.repeat(40) })).toEqual({ action: 'prepare-mirror', cutSha: base.cutSha, lockHash: base.lockHash });
  expect(planGatePrewarm({ ...base, cutSha: 'bad' })).toEqual({ action: 'defer', reason: 'invalid-input' });
});

test('stale or mismatched source and lock observations never authorize prewarm', () => {
  expect(planGatePrewarm({ ...base, observedAtMs: base.nowMs - GATE_PREWARM_OBSERVATION_MAX_AGE_MS - 1 }))
    .toEqual({ action: 'defer', reason: 'stale-observation' });
  expect(planGatePrewarm({ ...base, observedAtMs: base.nowMs + 1 }))
    .toEqual({ action: 'defer', reason: 'stale-observation' });
  expect(planGatePrewarm({ ...base, sourceSha: 'c'.repeat(40) })).toEqual({ action: 'defer', reason: 'identity' });
  expect(planGatePrewarm({ ...base, sourceLockHash: 'c'.repeat(64) })).toEqual({ action: 'defer', reason: 'identity' });
  expect(planGatePrewarm({ ...base, sourceSha: null })).toEqual({ action: 'defer', reason: 'unmeasured' });
});
