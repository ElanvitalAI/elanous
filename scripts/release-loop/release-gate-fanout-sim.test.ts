import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listLoops } from '../../src/loops/registry.js';
import { getTestStateRoot, setTestStateRoot } from '../../src/nexus/paths.js';
import { runReleaseSimRigScenario } from '../../src/ux-sim/release-sim-rig.js';
import { resolveScenarioFilePath } from '../../src/ux-sim/scenario.js';

test('the opt-in fanout template does not register a duplicate scheduled release loop', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'release-loop-registry-'));
  try {
    const repo = resolve(import.meta.dir, '../..');
    const releaseLoops = listLoops({ root: repo, stateRoot: root, schedules: [], config: {} as import('../../src/user-config.js').UserConfig })
      .filter((loop) => loop.id === 'release-loop');
    expect(releaseLoops).toHaveLength(1);
    expect(releaseLoops[0]?.file).toBe('graphs/release/release-loop.yaml');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('release cutoff starts every independent gate and reports simultaneous failures in one joined run', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'release-gate-fanout-sim-'));
  const previous = getTestStateRoot();
  setTestStateRoot(root);
  try {
    const source = readFileSync(resolveScenarioFilePath('scenarios/ux-sim/release-gate-fanout.yaml'), 'utf8');
    const result = await runReleaseSimRigScenario(source);
    if (!result.pass) throw new Error(JSON.stringify(result.cases, null, 2));
    const failedPair = result.cases.find(({ id }) => id === 'two-gates-fail-together');
    expect(failedPair).toMatchObject({
      pass: true,
      status: 'failed',
      checks: { overlap: true },
      fanOuts: {
        'cutoff:ok': {
          branches: {
            'export-check': { status: 'failed', output: expect.stringContaining('simulated fail') },
            pwa: { status: 'failed', output: expect.stringContaining('simulated fail') },
            tsc: { status: 'done' },
            ratchet: { status: 'done' },
            gate: { status: 'done' },
            'checklist-gate': { status: 'done' },
            prefetch: { status: 'done' },
            'mac-smoke': { status: 'done' },
          },
        },
      },
    });
    expect(failedPair?.path).toContain('pre-gate-join');
    expect(failedPair?.path).toContain('traffic-failed-restore');
    expect(failedPair?.path).not.toContain('publish');
    const starts = ['export-check', 'pwa', 'tsc', 'ratchet', 'gate']
      .map((nodeId) => failedPair?.nodeTimings?.[nodeId]?.startedAtMs ?? Number.POSITIVE_INFINITY);
    const ends = ['export-check', 'pwa', 'tsc', 'ratchet', 'gate']
      .map((nodeId) => failedPair?.nodeTimings?.[nodeId]?.endedAtMs ?? Number.NEGATIVE_INFINITY);
    expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
