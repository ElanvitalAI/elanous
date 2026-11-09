import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { createFakeAppHost } from './fake-app-host.js';
import { runReleaseSimRigIfFile, runReleaseSimRigScenario } from './release-sim-rig.js';

test('KAIST stage injects a lecture-scrap route bug, heals it in the same run, and records one receipt', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kaist-selfheal-stage-'));
  const previous = getTestStateRoot();
  setTestStateRoot(root);
  try {
    const result = await runReleaseSimRigIfFile('scenarios/ux-sim/kaist-selfheal-stage.yaml');
    expect(result?.pass, JSON.stringify(result?.cases[0]?.injectedEvidence)).toBe(true);
    expect(result?.cases).toHaveLength(1);
    const item = result!.cases[0]!;
    expect(item.pass).toBe(true);
    expect(item.checks).toMatchObject({ appBugDetected: true, appRepairRoutesGreen: true, oneSameRunReceipt: true });
    expect(item.injectedEvidence.incidentPlan).toEqual([{ label: 'fix', step: 'R2-split-files', files: [
      'templates/next-app-lecture-scrap/app/page.jsx', 'templates/next-app-lecture-scrap/app/search/page.jsx',
    ] }]);
    expect(item.injectedEvidence.app).toMatchObject({ slug: 'lecture-scrap', manifestValid: true,
      simulatedUrl: 'https://lecture-scrap.app.sim.invalid', externalNetworkAttempts: 0, injectedSearchResponse: 404,
      repairedRouteStatuses: { '/': 200, '/notes/new': 200, '/search': 200 }, oneSameRunReceipt: true });
    expect(['app.yaml draft fixture', 'template app.yaml'].includes((item.injectedEvidence.app as { source?: string }).source ?? '')).toBe(true);
    expect(item.injectedEvidence.graphRepairInputFiles).toEqual([
      'templates/next-app-lecture-scrap/app/page.jsx', 'templates/next-app-lecture-scrap/app/search/page.jsx',
    ]);
    expect(item.injectedEvidence.graphPath).toContain('gate-triage');
    expect((item.injectedEvidence.graphPath as string[]).some((node) => /^gate-repair-[a-f0-9]{12}$/.test(node))).toBe(true);
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
});

test('KAIST failed repair keeps the cloned search route at 404 and cannot satisfy the route gate', () => {
  const host = createFakeAppHost([{ slug: 'lecture-scrap', current: 'bug-injected', versions: [
    { id: 'bug-injected', files: { 'index.html': '<main>스크랩 목록</main>', 'notes/new': '<main>노트 작성</main>' } },
  ] }]);
  const routeStatuses = ['/', '/notes/new', '/search'].map((route) => host.fetch('lecture-scrap.app.sim.invalid', route).status);
  expect(routeStatuses).toEqual([200, 200, 404]);
  expect(routeStatuses.every((status) => status === 200)).toBe(false);
});

for (const repairFault of ['bad-artifact', 'unlanded'] as const) {
  test(`KAIST scenario fails and keeps /search at 404 for ${repairFault} repair`, async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'kaist-selfheal-failed-repair-'));
    const previous = getTestStateRoot();
    setTestStateRoot(root);
    try {
      const source = readFileSync('scenarios/ux-sim/kaist-selfheal-stage.yaml', 'utf8').replace(
        'mode: kaist-selfheal-stage',
        `mode: kaist-selfheal-stage\n    repairFault: ${repairFault}`,
      );
      const result = await runReleaseSimRigScenario(source);
      const item = result.cases[0]!;
      expect(result.pass).toBe(false);
      expect(item.checks.appRepairRoutesGreen).toBe(false);
      expect(item.injectedEvidence.app).toMatchObject({ repairedRouteStatuses: { '/search': 404 } });
    } finally {
      setTestStateRoot(previous ?? null);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
