import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { simulateTrainManagerDecision } from './train-manager-decision-sim.js';
import type { TrainDecisionInput } from '../loops/train/decisions.js';
import type { TrainVerdictInput } from '../../scripts/release-loop/train-verdict.js';

type DecisionFixture = {
  schema: string;
  provenance: { source: string; sha256: string; method: string };
  input: Parameters<typeof simulateTrainManagerDecision>[0];
  expected: ReturnType<typeof simulateTrainManagerDecision>;
  retryFileMapIncident: {
    id: string;
    source: string;
    failure: string;
    members: string[];
    excludedPrs: string[];
    primaryPrFiles: Record<string, string[]>;
    expected: { retryMembers: string[]; retryPrFiles: Record<string, string[]>; gateRetry: 'retry' | 'skip' };
    decisionInput: TrainDecisionInput;
    decisionExpected: ReturnType<typeof simulateTrainManagerDecision>;
  };
};

const fixture = JSON.parse(readFileSync(new URL('./fixtures/train-manager-decision-v1.json', import.meta.url), 'utf8')) as DecisionFixture;

test('train manager decisions preserve the captured assignment, park, and express behavior', () => {
  expect(fixture.schema).toBe('train-manager-decision-sim/v1');
  expect(fixture.provenance).toMatchObject({
    source: 'seat-state/OP/tools/train-manager.py',
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(simulateTrainManagerDecision(fixture.input)).toEqual(fixture.expected);
});

test('train retry preserves primary PR file attribution when no PR was isolated', () => {
  const scenario = fixture.retryFileMapIncident;
  expect(scenario.id).toBe('unattributed-intact-retry-keeps-primary-file-map');
  expect(scenario.source).toBe('seat-state/OPT/train-batch-live.py');
  expect(scenario.failure).toContain('retry_pr_files');
  expect(scenario.excludedPrs).toEqual([]);
  expect(scenario.expected.retryPrFiles).toEqual(scenario.primaryPrFiles);
  expect(scenario.expected.gateRetry).toBe('retry');
  expect(simulateTrainManagerDecision(scenario.decisionInput)).toEqual(scenario.decisionExpected);
  expect(scenario.decisionExpected.assignments).toEqual([
    { stage: 'group', host: 'gcp2', slot: 1, prs: ['35964'] },
  ]);
});

const verdictBase = 'a'.repeat(40);
const verdictHead = 'b'.repeat(40);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const simChangedPaths = (paths: string[]) => {
  const diffOutput = paths.join('\0') + (paths.length ? '\0' : '');
  return { source: 'git-diff' as const, complete: true, base: verdictBase, head: verdictHead, paths, diffOutput, artifactSha256: sha256(diffOutput) };
};
const simTimeoutEvidence = (failures: Array<{ id: string; file: string }>) => {
  const artifactJson = JSON.stringify({ schema: 'train-timeout-attribution/v1', base: verdictBase, head: verdictHead, failures });
  return { source: 'gate-artifact' as const, complete: true, base: verdictBase, head: verdictHead, artifactSha256: sha256(artifactJson), artifactJson, failures };
};
const simRemeasure = (fields: { exit: number; failures: Array<{ id: string; file: string }> }) => {
  const artifactJson = JSON.stringify({ schema: 'train-timeout-attribution/v1', base: verdictBase, head: verdictHead, failures: fields.failures });
  return { complete: true, host: 'aws2', primaryHost: 'minim5', base: verdictBase, head: verdictHead, exit: fields.exit,
    failuresComplete: true, artifactSha256: sha256(artifactJson), artifactJson, failures: fields.failures };
};
const verdictEvidence = (overrides: Partial<TrainVerdictInput> = {}): TrainVerdictInput => ({
  base: verdictBase,
  head: verdictHead,
  changedPaths: simChangedPaths(['src/changed.ts']),
  batch: { base: verdictBase, head: verdictHead, complete: true, exit: 0, introduced: 0, unknown: 0,
    preconditionUnmet: 0, unrunImporters: 0, typecheck: 'pass', alwaysRatchets: 'pass', preexisting: 0, timeouts: 0,
    timeoutEvidence: simTimeoutEvidence([]) },
  ...overrides,
});

function simWithTrainVerdict(evidence: TrainVerdictInput) {
  return simulateTrainManagerDecision({ base: verdictBase,
    queue: [{ pr: '90001', head: verdictHead, state: 'open', gate: 'evidence' }], activePrs: [], refusals: [], lastParks: [],
    slots: [{ host: 'aws2', slot: 1, expressOnly: false }], groupLimit: 1, gateVerdicts: { '90001': evidence } });
}

test('train-decision simulation #35709: bound baseline-only failure remains assignable', () => {
  const batch = verdictEvidence().batch;
  const result = simWithTrainVerdict(verdictEvidence({ batch: { ...batch, exit: 1, preexisting: 1,
    preexistingEvidence: { complete: true, base: verdictBase, head: verdictHead, sha: verdictHead, ids: ['baseline-known'] },
    preexistingBuildEvidence: { base: verdictBase, head: verdictHead, sha: verdictHead, valid: true } } }));
  expect(result.assignments.map((row) => row.prs)).toEqual([['90001']]);
});

test('train-decision simulation #35252: timeout passing on alternate host remains assignable', () => {
  const batch = verdictEvidence().batch;
  const result = simWithTrainVerdict(verdictEvidence({ batch: { ...batch, exit: 1, timeouts: 1,
    timeoutEvidence: simTimeoutEvidence([{ id: 'test/old.test.ts#slow', file: 'test/old.test.ts' }]) },
    remeasure: simRemeasure({ exit: 0, failures: [] }) }));
  expect(result.assignments.map((row) => row.prs)).toEqual([['90001']]);
});

test('train-decision simulation passes measured alternate-host timeout failure on an unchanged path', () => {
  const batch = verdictEvidence().batch;
  const timeoutFailure = { id: 'test/old.test.ts#slow', file: 'test/old.test.ts' };
  const result = simWithTrainVerdict(verdictEvidence({ batch: { ...batch, exit: 1, timeouts: 1, timeoutEvidence: simTimeoutEvidence([timeoutFailure]) },
    remeasure: simRemeasure({ exit: 1, failures: [timeoutFailure] }) }));
  expect(result.assignments.map((row) => row.prs)).toEqual([['90001']]);
});

test('train-decision simulation rejects alternate-host timeout intersecting a changed file', () => {
  const batch = verdictEvidence().batch;
  const timeoutFailure = { id: 'src/changed.ts#slow', file: 'src/changed.ts' };
  const result = simWithTrainVerdict(verdictEvidence({ batch: { ...batch, exit: 1, timeouts: 1, timeoutEvidence: simTimeoutEvidence([timeoutFailure]) },
    remeasure: simRemeasure({ exit: 1, failures: [timeoutFailure] }) }));
  expect(result.assignments).toEqual([]);
  expect(result.waiting).toEqual([{ pr: '90001', reason: 'gate-not-ready' }]);
});

test('train-decision simulation keeps introduced and unknown failure counts blocked', () => {
  const result = simWithTrainVerdict(verdictEvidence({ batch: { ...verdictEvidence().batch, introduced: 1, unknown: 1 } }));
  expect(result.assignments).toEqual([]);
  expect(result.waiting).toEqual([{ pr: '90001', reason: 'gate-not-ready' }]);
});

test('train-decision simulation fails closed on unmeasured timeout and mandatory ratchet failure', () => {
  const batch = verdictEvidence().batch;
  const unmeasured = simWithTrainVerdict(verdictEvidence({ batch: { ...batch, exit: 1, timeouts: 1,
    timeoutEvidence: simTimeoutEvidence([{ id: 'test/old.test.ts#slow', file: 'test/old.test.ts' }]) } }));
  const ratchet = simWithTrainVerdict(verdictEvidence({ batch: { ...batch, alwaysRatchets: 'fail' } }));
  expect(unmeasured.assignments).toEqual([]);
  expect(ratchet.assignments).toEqual([]);
});

test('same current head refusals count across bases, while an active PR cannot be parked', () => {
  const input: TrainDecisionInput = {
    ...structuredClone(fixture.input),
    refusals: [...fixture.input.refusals, {
      pr: '10002',
      head: 'cccccccccccccccccccccccccccccccccccccccc',
      base: '0000000000000000000000000000000000000000',
      runId: 'other-base',
      at: '2026-11-03T10:00:00+09:00',
      kind: 'batch-refusal',
    }, {
      pr: '10002',
      head: 'cccccccccccccccccccccccccccccccccccccccc',
      base: fixture.input.base,
      runId: 'current-base',
      at: '2026-11-03T10:05:00+09:00',
      kind: 'batch-refusal',
    }, {
      pr: '10004',
      head: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      base: fixture.input.base,
      runId: 'active-refusal-1',
      at: '2026-11-03T10:00:00+09:00',
      kind: 'batch-refusal',
    }, {
      pr: '10004',
      head: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      base: fixture.input.base,
      runId: 'active-refusal-2',
      at: '2026-11-03T10:05:00+09:00',
      kind: 'batch-refusal',
    }],
  };

  const result = simulateTrainManagerDecision(input);

  expect(result.parked).toEqual(['10002', '10003']);
  expect(result.skipped).toContainEqual({ pr: '10004', reason: 'active' });
});

test('parking requires two distinct batch refusals for the same open current head', () => {
  const input: TrainDecisionInput = {
    ...structuredClone(fixture.input),
    queue: [
      { pr: '20001', head: '1111111111111111111111111111111111111111', state: 'open', gate: 'unmeasured' },
      { pr: '20002', head: '2222222222222222222222222222222222222222', state: 'open', gate: 'unmeasured' },
      { pr: '20003', head: '3333333333333333333333333333333333333333', state: 'closed', gate: 'unmeasured' },
    ],
    activePrs: [],
    refusals: [
      { pr: '20001', head: '1111111111111111111111111111111111111111', base: fixture.input.base, runId: 'same-run', at: '2026-11-03T10:00:00+09:00', kind: 'batch-refusal' },
      { pr: '20001', head: '1111111111111111111111111111111111111111', base: fixture.input.base, runId: 'same-run', at: '2026-11-03T10:01:00+09:00', kind: 'batch-refusal' },
      { pr: '20002', head: '2222222222222222222222222222222222222222', base: fixture.input.base, runId: 'infra-1', at: '2026-11-03T10:00:00+09:00', kind: 'infrastructure' },
      { pr: '20002', head: '2222222222222222222222222222222222222222', base: fixture.input.base, runId: 'infra-2', at: '2026-11-03T10:01:00+09:00', kind: 'infrastructure' },
      { pr: '20003', head: '3333333333333333333333333333333333333333', base: fixture.input.base, runId: 'closed-1', at: '2026-11-03T10:00:00+09:00', kind: 'batch-refusal' },
      { pr: '20003', head: '3333333333333333333333333333333333333333', base: fixture.input.base, runId: 'closed-2', at: '2026-11-03T10:01:00+09:00', kind: 'batch-refusal' },
    ],
    lastParks: [],
    slots: [],
  };

  const result = simulateTrainManagerDecision(input);

  expect(result.parked).toEqual([]);
  expect(result.waiting).toEqual([
    { pr: '20001', reason: 'gate-not-ready' },
    { pr: '20002', reason: 'gate-not-ready' },
  ]);
  expect(result.skipped).toEqual([{ pr: '20003', reason: 'not-open' }]);
});

test('express order consumes eligible slots before regular groups without double assignment', () => {
  const input: TrainDecisionInput = {
    ...structuredClone(fixture.input),
    queue: [
      { pr: '30001', head: '1111111111111111111111111111111111111111', state: 'open', gate: 'passed' },
      { pr: '30002', head: '2222222222222222222222222222222222222222', state: 'open', gate: 'passed', expressRank: 1 },
      { pr: '30003', head: '3333333333333333333333333333333333333333', state: 'open', gate: 'passed', expressRank: 0 },
    ],
    activePrs: [],
    refusals: [],
    slots: [
      { host: 'aws1', slot: 1, expressOnly: true },
      { host: 'gcp2', slot: 1, expressOnly: false },
      { host: 'gcp2', slot: 2, expressOnly: false },
    ],
  };

  const result = simulateTrainManagerDecision(input);

  expect(result.assignments).toEqual([
    { stage: 'express', host: 'aws1', slot: 1, prs: ['30003'] },
    { stage: 'express', host: 'gcp2', slot: 1, prs: ['30002'] },
    { stage: 'group', host: 'gcp2', slot: 2, prs: ['30001'] },
  ]);
  const assigned = result.assignments.flatMap((assignment) => assignment.prs);
  expect(new Set(assigned).size).toBe(assigned.length);
});

test('passed regular PRs remain visible when worker slots or group capacity run out', () => {
  const input: TrainDecisionInput = {
    ...structuredClone(fixture.input),
    queue: [
      { pr: '40001', head: '1111111111111111111111111111111111111111', state: 'open', gate: 'passed' },
      { pr: '40002', head: '2222222222222222222222222222222222222222', state: 'open', gate: 'passed' },
      { pr: '40003', head: '3333333333333333333333333333333333333333', state: 'open', gate: 'passed' },
    ],
    activePrs: [],
    refusals: [],
    groupLimit: 2,
    slots: [{ host: 'gcp2', slot: 1, expressOnly: false }],
  };

  const result = simulateTrainManagerDecision(input);

  expect(result.assignments).toEqual([
    { stage: 'group', host: 'gcp2', slot: 1, prs: ['40001', '40002'] },
  ]);
  expect(result.waiting).toEqual([{ pr: '40003', reason: 'no-free-slot' }]);

  const noSlots = simulateTrainManagerDecision({ ...input, slots: [] });
  expect(noSlots.assignments).toEqual([]);
  expect(noSlots.waiting).toEqual([
    { pr: '40001', reason: 'no-free-slot' },
    { pr: '40002', reason: 'no-free-slot' },
    { pr: '40003', reason: 'no-free-slot' },
  ]);
});

test('a re-queued same head needs two refusals newer than its latest park row', () => {
  const head = '4444444444444444444444444444444444444444';
  const input: TrainDecisionInput = {
    ...structuredClone(fixture.input),
    queue: [{ pr: '50001', head, state: 'open', gate: 'unmeasured' }],
    activePrs: [],
    refusals: [
      { pr: '50001', head, base: fixture.input.base, runId: 'old-1', at: '2026-11-03T09:00:00+09:00', kind: 'batch-refusal' },
      { pr: '50001', head, base: fixture.input.base, runId: 'old-2', at: '2026-11-03T09:05:00+09:00', kind: 'batch-refusal' },
      { pr: '50001', head, base: fixture.input.base, runId: 'new-1', at: '2026-11-03T10:00:30+09:00', kind: 'batch-refusal' },
    ],
    lastParks: [{ pr: '50001', head, at: '2026-11-03T10:00:00+09:00' }],
    slots: [],
  };

  const requeued = simulateTrainManagerDecision(input);
  expect(requeued.parked).toEqual([]);

  const newlyRefused = simulateTrainManagerDecision({
    ...input,
    refusals: [...input.refusals, {
      // 01:00:31Z is 10:00:31+09, after the park despite its earlier local hour.
      pr: '50001', head, base: fixture.input.base, runId: 'new-2', at: '2026-11-03T01:00:31+00:00', kind: 'batch-refusal',
    }],
  });
  expect(newlyRefused.parked).toEqual(['50001']);
});
