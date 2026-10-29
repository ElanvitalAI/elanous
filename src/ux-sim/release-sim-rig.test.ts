import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { runReleaseSimRigIfFile } from './release-sim-rig.js';
import { resolveScenarioFilePath } from './scenario.js';

test('release simulation runs the real release graph with injected node outcomes in isolated test state', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'release-sim-rig-test-'));
  const previous = getTestStateRoot();
  setTestStateRoot(root);
  try {
    expect(await runReleaseSimRigIfFile('scenarios/ux-sim/provider-4xx-no-provider.yaml')).toBeNull();
    const scenarioPath = resolveScenarioFilePath('scenarios/ux-sim/release-sim-rig.yaml');
    const result = await runReleaseSimRigIfFile(scenarioPath);
    expect(result).not.toBeNull();
    if (!result) throw new Error('release graph scenario was not classified');
    expect(result.pass).toBe(true);
    expect(result.universe).toBe(root);
    expect(result.artifactPath).toBe(join(root, 'ux-sim', 'evidence', 'release-sim-rig-0241.json'));
    expect(existsSync(result.artifactPath)).toBe(true);
    expect(result.cases).toHaveLength(10);
    expect(result.cases.every((item) => item.pass && item.unexpectedEdges.length === 0)).toBe(true);
    expect(result.cases.every((item) => item.dispatchedNodes.every((node) => item.path.includes(node)))).toBe(true);
    expect(result.table.every((row) => row.unexpectedEdges === 'none')).toBe(true);
    expect(result.cases.find((item) => item.id === 'cut-tip-moved-after-resume')).toMatchObject({
      status: 'resume-refused', dispatchedNodes: ['version-release'], checks: { mustVisit: true, mustNotVisit: true },
    });
    expect(result.cases.find((item) => item.id === 'gate-attribution-incomplete')?.path)
      .toContain('traffic-failed-restore');
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
