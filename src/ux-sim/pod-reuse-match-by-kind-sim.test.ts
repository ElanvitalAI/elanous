import { expect, test } from 'bun:test';
import { runPodReuseMatchByKindSimulation } from './pod-reuse-match-by-kind-sim.js';
import { runWarmSiReuseSimulation } from './warm-si-reuse-sim.js';

test('implementation Pods reuse compatible runtime and lock contract despite image digest drift', () => {
  const result = runPodReuseMatchByKindSimulation().implementation.compatibleImageDrift;
  expect(result.selected).toBe('impl-digest-drift');
  expect(result.rows[0]).toMatchObject({ accepted: true, imageDigestDrift: true, reason: 'selected' });
});

test('implementation Pods reject lock hash and runtime contract mismatches', () => {
  const result = runPodReuseMatchByKindSimulation().implementation;
  expect(result.lockHashMismatch.rows[0]).toMatchObject({ accepted: false, reason: 'lock-hash-mismatch' });
  expect(result.runtimeContractMismatch.rows[0]).toMatchObject({ accepted: false, reason: 'contract-mismatch' });
});

test('gate Pods require source provenance and runtime tuple while recording full-image drift', () => {
  const result = runPodReuseMatchByKindSimulation().gate.exactTupleOnly;
  expect(result.selected).toBe('gate-digest-mismatch');
  expect(result.rows.find(row => row.candidate === 'gate-cut-mismatch'))
    .toMatchObject({ accepted: false, reason: 'cut-sha-mismatch' });
  expect(result.rows.find(row => row.candidate === 'gate-lock-mismatch'))
    .toMatchObject({ accepted: false, reason: 'lock-hash-mismatch' });
  expect(result.rows.find(row => row.candidate === 'gate-digest-mismatch'))
    .toMatchObject({ accepted: true, imageDigestDrift: true, reason: 'selected' });
  expect(result.rows.find(row => row.candidate === 'gate-exact'))
    .toMatchObject({ accepted: true, reason: 'lower-score', score: [0] });
});

test('gate Pods reject only contract mismatch or wrong Pod kind', () => {
  const result = runPodReuseMatchByKindSimulation().gate;
  expect(result.contractMismatchRejected.selected).toBe('gate-compatible');
  expect(result.contractMismatchRejected.rows.find(row => row.candidate === 'gate-wrong-runtime'))
    .toMatchObject({ accepted: false, reason: 'contract-mismatch' });
  expect(result.kindMismatchRejected.selected).toBe('gate-kind');
  expect(result.kindMismatchRejected.rows.find(row => row.candidate === 'implementation-only'))
    .toMatchObject({ accepted: false, reason: 'kind-mismatch' });
});

test('Pod reuse defaults to exact architecture and permits a configured arm64/amd64 pair only', () => {
  const result = runPodReuseMatchByKindSimulation().gate;
  expect(result.architectureMismatchRejected.rows[0]).toMatchObject({
    accepted: false, reason: 'runtime-identity-mismatch',
  });
  expect(result.architecturePairAllowlisted).toMatchObject({
    selected: 'gate-arm64-allowlisted',
    rows: [expect.objectContaining({ accepted: true, reason: 'selected' })],
  });
});

test('MATCH-BY-KIND is the ALLOC-RETURN selector used by the real cut-gate provider path', async () => {
  const result = await runWarmSiReuseSimulation({ runId: 'alloc-return-match-by-kind', exhaustColdJobSlots: true });
  expect(result.coldAdmission).toMatchObject({ recommended: 0, capacitySlots: 0, placeableSlots: 0, running: 1 });
  expect(result.candidateMatchScores).toHaveLength(2);
  for (const row of result.candidateMatchScores) expect(row).toMatchObject({
    kind: 'implementation', selectedWorkerId: 'warm-pool-host-a-si-1-generation-1',
    candidates: [expect.objectContaining({ kind: 'implementation', accepted: true, reason: 'selected' })],
  });
  expect(result.leaseGenerations).toEqual([1, 2]);
  expect(result.podUids).toEqual(['si-warm-pod-uid-1', 'si-warm-pod-uid-1']);
  expect(result.cleanupOutcomes).toEqual(['returned', 'returned']);
  expect(result.finalPodState).toBe('idle');
}, 30_000);
