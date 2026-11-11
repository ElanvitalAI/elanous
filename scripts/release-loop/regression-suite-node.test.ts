import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorldRegressionSuite, type SuiteReceipt } from '../../src/ux-sim/world-regression-suite.js';
import { runReleaseRegressionSuites } from './regression-suite-node.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('release graph gate runs every configured sim bundle before the hard gate and fails on any difference', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-regression-suites-'));
  roots.push(root);
  for (const suite of ['payments', 'hosts']) {
    const folder = join(root, suite);
    const incident = join(folder, 'incident');
    mkdirSync(incident, { recursive: true });
    writeFileSync(join(folder, 'suite.json'), JSON.stringify({ durationTolerancePercent: 5 })); // Source: fixture uses explicit five-percent tolerance.
    writeFileSync(join(incident, 'world.yaml'), 'world: incident\n');
    writeFileSync(join(incident, 'scenario.yaml'), 'world: incident\nsteps: []\n');
    const baseline: SuiteReceipt = { pass: true, steps: [{ id: 'step', outcome: 'ok', invariant: 'pass', durationMs: 100 }], eventKinds: ['event'] };
    await runWorldRegressionSuite({ folder, target: 'sim', updateBaseline: true, run: async () => baseline });
  }
  const all = await runReleaseRegressionSuites(root, async () => ({ pass: true, steps: [{ id: 'step', outcome: 'ok', invariant: 'pass', durationMs: 100 }], eventKinds: ['event'] }));
  expect(all).toMatchObject({ outcome: 'ok', suites: 2, scenarios: 2, differences: [] });
  const failed = await runReleaseRegressionSuites(root, async (item) => ({ pass: true,
    steps: [{ id: 'step', outcome: item.worldFile.includes('/hosts/') ? 'changed' : 'ok', invariant: 'pass', durationMs: 100 }], eventKinds: ['event'] }));
  expect(failed).toMatchObject({ outcome: 'fail', suites: 2, scenarios: 2,
    differences: [{ suite: 'hosts', scenario: 'incident', field: 'step.outcome' }] });
});
