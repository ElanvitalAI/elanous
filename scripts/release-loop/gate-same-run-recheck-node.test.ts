import { expect, test } from 'bun:test';
import { prepareSameRunGateRecheck } from './gate-same-run-recheck-node.js';
import type { GraphContext } from './node-verdict.js';
import type { StalledGateEvidence } from './gate-stalled-evidence.js';

const commit = 'a'.repeat(40);
const context = (gate: Record<string, unknown>): GraphContext => ({ graphId: 'release-loop', nodeId: 'gate-same-run-recheck',
  runId: 'run-e11', input: { version: '0.3.8', previousVersion: '0.3.7' },
  outputs: { gate, cutoff: { baseline: { sha: 'b'.repeat(40) } } } });

test('approved incomplete-batch retry plans only the stalled shard and pins completed evidence to this run', () => {
  let wrote: unknown;
  let inspectedRun = '';
  let inspectedIdentity: { image?: string; lock?: string } = {};
  const evidence: StalledGateEvidence = { stalledShards: [{ shard: 17, files: ['scripts/release-loop/pod-17.test.ts'], reason: 'incomplete' }],
    partialSummary: { pass: 79, fail: 0, errors: 0, ran: 79, files: 79 }, partialFailures: { failures: [], errors: [] }, preservedShardCount: 79 };
  const result = prepareSameRunGateRecheck(context({ outcome: 'error', commit, error: 'remote gate refused: HQ shard result batch is incomplete (pod-17)' }), {
    repo: '/repo', roots: ['/ledger'], ledgerRoot: '/ledger', existsAtCommit: () => true,
    pinnedImageDigest: () => `sha256:${'c'.repeat(64)}`, lockfileHash: () => '9'.repeat(64),
    inspect: ((input) => { inspectedRun = input.expectedRunId ?? ''; inspectedIdentity = {
      image: input.expectedImageDigest, lock: input.expectedLockfileHash,
    }; return { ok: true, evidence }; }) as typeof import('./gate-stalled-evidence.js').stalledGateEvidence,
    write: ((root, plan) => { wrote = { root, plan }; return '/ledger/release/0.3.8/gate-partial.json'; }) as typeof import('./gate-partial.js').writeRecheckPlan,
  });
  expect(inspectedRun).toBe('run-e11');
  expect(inspectedIdentity).toEqual({ image: `sha256:${'c'.repeat(64)}`, lock: '9'.repeat(64) });
  expect(result).toMatchObject({ outcome: 'ok', reusedShardCount: 79, remeasureFiles: ['scripts/release-loop/pod-17.test.ts'] });
  expect(wrote).toMatchObject({ root: '/ledger', plan: { kind: 'recheck', forCommit: commit, files: ['scripts/release-loop/pod-17.test.ts'], stalledFiles: ['scripts/release-loop/pod-17.test.ts'], preservedShardCount: 79 } });
});

test('unrelated gate failures bypass the same-run stalled receipt planner', () => {
  let inspected = false;
  const result = prepareSameRunGateRecheck(context({ outcome: 'error', commit, error: 'gate host unavailable' }), {
    inspect: (() => { inspected = true; return { ok: false, reason: 'must not run' }; }) as typeof import('./gate-stalled-evidence.js').stalledGateEvidence,
  });
  expect(result).toMatchObject({ outcome: 'ok', skipped: true });
  expect(inspected).toBe(false);
});

test('fail-closed when same-run completed receipt evidence is rejected', () => {
  const result = prepareSameRunGateRecheck(context({ outcome: 'error', commit, error: 'shard result batch write failed' }), {
    pinnedImageDigest: () => `sha256:${'c'.repeat(64)}`, lockfileHash: () => '9'.repeat(64),
    inspect: (() => ({ ok: false, reason: 'completed shard receipt belongs to another graph run: pod-0' })) as typeof import('./gate-stalled-evidence.js').stalledGateEvidence,
  });
  expect(result).toMatchObject({ outcome: 'error', verdict: 'fail' });
  expect(result.summary).toContain('another graph run');
});
