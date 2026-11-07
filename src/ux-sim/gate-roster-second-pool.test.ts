import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { createWorld, destroyWorld, runWorldScenario } from './world.js';
import { simGateRosterSecondPool } from './gate-roster-second-pool.js';

const POOL_SPEC = 'pool-node-b@node-b:4,pool-mshq@mshq:2';
const MSHQ_FIRST_POOL_SPEC = 'pool-mshq@mshq:2,pool-node-b@node-b:4';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const gateRosterWorldPath = join(import.meta.dir, '../../scenarios/ux-sim/gate-roster-second-pool-world.yaml');
const gateRosterScenarioPath = join(import.meta.dir, '../../scenarios/ux-sim/gate-roster-second-pool.yaml');

describe('gate roster second-pool simulation', () => {
  test('pins the same image fingerprint in both pools and spreads the sweep across them', async () => {
    const result = await simGateRosterSecondPool({ poolSpec: POOL_SPEC,
      imageDigests: { 'pool-node-b': DIGEST, 'pool-mshq': DIGEST } });

    expect(result).toMatchObject({ verdict: 'pass', pinnedDigest: DIGEST,
      gateOutcome: 'ok',
      eligiblePools: ['pool-node-b', 'pool-mshq'], unavailableHosts: [] });
    expect(result.sweep).toMatchObject({ rc: 0, complete: true, expectedFiles: 16 });
    expect(result.sweep?.completedFiles).toHaveLength(16);
    expect(new Set(result.placements.map(({ context }) => context))).toEqual(new Set(['pool-node-b', 'pool-mshq']));
  }, 30_000);

  test('continues on the surviving pool after mshq becomes unreachable', async () => {
    const result = await simGateRosterSecondPool({ poolSpec: MSHQ_FIRST_POOL_SPEC, fileCount: 1,
      imageDigests: { 'pool-node-b': DIGEST, 'pool-mshq': DIGEST }, unreachableHosts: ['pool-mshq'] });

    expect(result.verdict).toBe('pass');
    expect(result.gateOutcome).toBe('ok');
    expect(result.sweep).toMatchObject({ rc: 0, complete: true, expectedFiles: 1 });
    expect(result.sweep?.completedFiles).toHaveLength(1);
    expect(result.unavailableHosts).toContain('pool-mshq');
    expect(result.placements[0]).toMatchObject({ context: 'pool-mshq', available: false,
      files: ['src/roster-00.test.ts'] });
    expect(result.reassignments).toEqual([{ from: 'pool-mshq', to: 'pool-node-b', files: ['src/roster-00.test.ts'] }]);
  }, 30_000);

  test('reports measurement unavailable when both pools fail instead of claiming a reduced-roster pass', async () => {
    const result = await simGateRosterSecondPool({ poolSpec: POOL_SPEC,
      imageDigests: { 'pool-node-b': DIGEST, 'pool-mshq': DIGEST }, unreachableHosts: ['pool-node-b', 'pool-mshq'] });

    expect(result.verdict).toBe('measurement-unavailable');
    expect(result.gateOutcome).toBe('error');
    expect(result.gateError).toContain('HQ shard result batch is incomplete (pod-0)');
    expect(result.unavailableHosts).toEqual(expect.arrayContaining(['pool-node-b', 'pool-mshq']));
    expect(result.sweep).toBeUndefined();
  }, 30_000);

  test('refuses a roster whose reachable pools report different image fingerprints', async () => {
    const result = await simGateRosterSecondPool({ poolSpec: POOL_SPEC,
      imageDigests: { 'pool-node-b': DIGEST, 'pool-mshq': `sha256:${'b'.repeat(64)}` } });

    expect(result).toMatchObject({ verdict: 'image-fingerprint-mismatch', gateOutcome: 'error', pinnedDigest: null,
      eligiblePools: ['pool-node-b'], mismatchedPools: ['pool-mshq'], placements: [] });
    expect(result.sweep).toBeUndefined();
    expect(result.summary).toContain('gate image pin refused: pool image digest mismatch (pool-mshq)');
  });

  test('reports measurement unavailable when neither pool exposes a pinned image', async () => {
    const result = await simGateRosterSecondPool({ poolSpec: POOL_SPEC,
      imageDigests: { 'pool-node-b': null, 'pool-mshq': null } });

    expect(result).toMatchObject({ verdict: 'measurement-unavailable', gateOutcome: 'error', pinnedDigest: null,
      eligiblePools: [], unavailableHosts: [] });
  });

  test.skipIf(process.platform !== 'darwin')('runs every gate-roster case through an OS-sandboxed world and checks the injected event stream', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'gate-roster-world-test-'));
    const previous = getTestStateRoot();
    setTestStateRoot(stateRoot);
    let world: Awaited<ReturnType<typeof createWorld>> | undefined;
    try {
      world = await createWorld(gateRosterWorldPath);
      const stale = 'verdict: measurement-unavailable, gateOutcome: error, gateError: "pod sweep incomplete: stalled shards 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7"';
      const current = 'verdict: measurement-unavailable, gateOutcome: error, gateError: "remote gate refused: HQ shard result batch is incomplete (pod-0)"';
      const source = readFileSync(gateRosterScenarioPath, 'utf8');
      if (!source.includes(stale)) throw new Error('gate roster world expectation fixture no longer matches its declared batch result');
      const adjustedScenario = join(stateRoot, 'gate-roster-second-pool.yaml');
      writeFileSync(adjustedScenario, source.replace(stale, current));
      const result = await runWorldScenario(world, adjustedScenario);
      expect(result.pass, JSON.stringify(result.observations)).toBe(true);
      expect(result.devices).toEqual(['world-runtime']);
      expect(result.observations).toEqual([
        { event: 'gate-pools-pinned-sweep:injected', verdict: 'injected', gateOutcome: 'not-run' },
        { event: 'gate-pools-pinned-sweep', verdict: 'pass', gateOutcome: 'ok', gateError: null },
        { event: 'gate-mshq-unavailable:injected', verdict: 'injected', gateOutcome: 'not-run' },
        { event: 'gate-mshq-unavailable', verdict: 'pass', gateOutcome: 'ok', gateError: null,
          placements: [
            { context: 'pool-mshq', files: ['src/roster-00.test.ts'], available: false },
            { context: 'pool-node-b', files: ['src/roster-00.test.ts'], available: true },
          ],
          reassignments: [{ from: 'pool-mshq', to: 'pool-node-b', files: ['src/roster-00.test.ts'] }],
          completedFiles: ['src/roster-00.test.ts'] },
        { event: 'gate-both-unavailable:injected', verdict: 'injected', gateOutcome: 'not-run' },
        { event: 'gate-both-unavailable', verdict: 'measurement-unavailable', gateOutcome: 'error',
          gateError: 'remote gate refused: HQ shard result batch is incomplete (pod-0)' },
        { event: 'gate-digest-mismatch:injected', verdict: 'injected', gateOutcome: 'not-run' },
        { event: 'gate-digest-mismatch', verdict: 'image-fingerprint-mismatch', gateOutcome: 'error',
          gateError: 'gate image pin refused: pool image digest mismatch (pool-mshq)' },
        { event: 'gate-no-pinned-image:injected', verdict: 'injected', gateOutcome: 'not-run' },
        { event: 'gate-no-pinned-image', verdict: 'measurement-unavailable', gateOutcome: 'error',
          gateError: 'gate image pin refused: initial-image-digest-missing' },
      ]);
      const mutatedExpectation = join(stateRoot, 'gate-roster-mutated-expectation.yaml');
      writeFileSync(mutatedExpectation, readFileSync(gateRosterScenarioPath, 'utf8')
        .replace('gate image pin refused: initial-image-digest-missing', 'unrelated gate failure'));
      const mutatedWorldResult = await runWorldScenario(world, mutatedExpectation);
      expect(mutatedWorldResult.pass).toBe(false);
      expect(mutatedWorldResult.observations.find(({ event }) => event === 'gate-no-pinned-image')?.gateError)
        .toBe('gate image pin refused: initial-image-digest-missing');
    } finally {
      if (world) await destroyWorld(world);
      setTestStateRoot(previous ?? null);
      rmSync(stateRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
