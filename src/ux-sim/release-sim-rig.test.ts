import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { runReleaseSimRigIfFile, runReleaseSimRigScenario } from './release-sim-rig.js';
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
    expect(result.cases).toHaveLength(12);
    expect(result.cases.every((item) => item.pass && item.unexpectedEdges.length === 0)).toBe(true);
    expect(result.cases.every((item) => item.dispatchedNodes.every((node) => item.path.includes(node) ||
      Object.values(item.fanOuts ?? {}).some((fanout) => Object.hasOwn(fanout.branches, node))))).toBe(true);
    expect(result.table.every((row) => row.unexpectedEdges === 'none')).toBe(true);
    expect(result.cases.find((item) => item.id === 'cut-tip-moved-after-resume')).toMatchObject({
      status: 'resume-refused', dispatchedNodes: ['version-release'], checks: { mustVisit: true, mustNotVisit: true },
    });
    const negativeOverlapSource = readFileSync(scenarioPath, 'utf8')
      .replace('id: release-sim-rig-0241', 'id: release-sim-negative-overlap-0245').replace(
      '      mustNotVisit: [cutoff, gate, publish]\n',
      '      mustNotVisit: [cutoff, gate, publish]\n      overlap: [checklist-gate, prefetch]\n',
    );
    const negativeOverlap = await runReleaseSimRigScenario(negativeOverlapSource);
    expect(negativeOverlap.pass).toBe(false);
    expect(negativeOverlap.cases.find((item) => item.id === 'cut-tip-moved-after-resume')).toMatchObject({
      pass: false, checks: { status: true, overlap: false },
    });
    const wrongRefusalExpectation = readFileSync(scenarioPath, 'utf8')
      .replace('id: release-sim-rig-0241', 'id: release-sim-negative-status-0245')
      .replace('      mustNotVisit: [cutoff, gate, publish]\n',
        '      mustNotVisit: [cutoff, gate, publish]\n      refusalIncludes: expected-but-different\n');
    const statusRegression = await runReleaseSimRigScenario(wrongRefusalExpectation);
    expect(statusRegression.pass).toBe(false);
    expect(statusRegression.cases.find((item) => item.id === 'cut-tip-moved-after-resume')?.checks.status).toBe(false);
    expect(result.cases.find((item) => item.id === 'gate-attribution-incomplete')?.path)
      .toContain('traffic-failed-restore');
    const prefetchWarning = result.cases.find((item) => item.id === 'prefetch-warning-failure-overlaps-checklist')!;
    expect(prefetchWarning.path.indexOf('pre-gate-join')).toBeLessThan(prefetchWarning.path.indexOf('gate'));
    expect(prefetchWarning.fanOuts?.['export-check:ok']?.branches).toMatchObject({
      'checklist-gate': { status: 'done' }, prefetch: { status: 'failed' },
    });
    const prefetchWarningTimings = prefetchWarning.nodeTimings!;
    expect(prefetchWarningTimings['checklist-gate']!.startedAtMs).toBeLessThan(prefetchWarningTimings.prefetch!.endedAtMs);
    expect(prefetchWarningTimings.prefetch!.startedAtMs).toBeLessThan(prefetchWarningTimings['checklist-gate']!.endedAtMs);
    const macWarning = result.cases.find((item) => item.id === 'mac-smoke-warning-failure-overlaps-pwa')!;
    expect(macWarning.path.indexOf('pre-prepare-join')).toBeLessThan(macWarning.path.indexOf('prepare'));
    expect(macWarning.fanOuts?.['traffic-gate-passed:ok']?.branches).toMatchObject({
      'mac-smoke': { status: 'failed' }, pwa: { status: 'done' },
    });
    const macWarningTimings = macWarning.nodeTimings!;
    expect(macWarningTimings['mac-smoke']!.startedAtMs).toBeLessThan(macWarningTimings.pwa!.endedAtMs);
    expect(macWarningTimings.pwa!.startedAtMs).toBeLessThan(macWarningTimings['mac-smoke']!.endedAtMs);
    const exportFailure = result.cases.find((item) => item.id === 'public-export-leak')!;
    expect(exportFailure.path).not.toContain('prefetch');
    expect(exportFailure.path).toContain('traffic-failed-restore');
    const pwaFailure = result.cases.find((item) => item.id === 'pwa-node-times-out')!;
    expect(pwaFailure.fanOuts?.['traffic-gate-passed:ok']?.branches.pwa).toMatchObject({ status: 'failed' });
    expect(pwaFailure.path).toContain('traffic-failed-restore');
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
