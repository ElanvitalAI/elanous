import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { attributeReleaseFailures } from '../release-loop/release-failure-attribution.js';
import { type MacrophageIncidentSignal } from '../release-loop/macrophage-incident-recovery.js';
import { runReleaseMacrophageIncidentSim } from './release-sim-rig.js';

interface CoverageIncident {
  id: string;
  source: MacrophageIncidentSignal['source'];
  signature: string;
  evidence: MacrophageIncidentSignal['evidence'];
  failureIds?: string[];
  radiusReplay?: {
    priorHead: string;
    cutHead: string;
    changedFiles: string[];
    nonTypeScriptImpactReason: string;
    receiptRosterFixture: string;
    shardCount: number;
    testCount: number;
    receiptsReused: number;
    radiusInvalidated: number;
    productionReplayTest: string;
  };
  independentFiles?: boolean;
  revertSafe?: boolean;
  priorRepairStepsFailed?: number;
  expected: 'noise' | 'fix' | 'hitl';
  landed?: boolean;
}

interface CoverageScenario {
  id: string;
  runId: string;
  previousReleaseTag: string;
  incidents: CoverageIncident[];
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file',
    GIT_AUTHOR_NAME: 'Macro attribution sim', GIT_AUTHOR_EMAIL: 'macro-sim@example.invalid',
    GIT_COMMITTER_NAME: 'Macro attribution sim', GIT_COMMITTER_EMAIL: 'macro-sim@example.invalid',
  } }).trim();
}

function put(repo: string, path: string, text: string): void {
  const target = join(repo, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, text);
}

function commit(repo: string, subject: string): string {
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', subject);
  return git(repo, 'rev-parse', 'HEAD');
}

function makeAttributionFixture(root: string, scenario: CoverageScenario): { repo: string; cut: string } {
  const repo = join(root, 'attribution-fixture');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '--initial-branch=main');
  const tests = new Map<string, string>([
    ['tests/export-context.test.ts', 'export context failure\n'],
    ['tests/pwa-typecheck.test.ts', 'PWA type failure\n'],
    ['tests/shard-ledger.test.ts', 'ledger config failure\n'],
    ['tests/pod-image-preflight.test.ts', 'runner metadata failure\n'],
    ['tests/gate-metadata.test.ts', "import { metadata } from '../apps/pwa/src/meta.ts';\nexport const injectedFailure = metadata;\n"],
    ['tests/gate-pod-stall.test.ts', "import { stall } from '../scripts/release-loop/gate-pod-stall.ts';\nexport const injectedFailure = stall;\n"],
    ['tests/receipt-radius.test.ts', "import { radius } from '../scripts/release-loop/gate-shard-receipts.ts';\nexport const injectedFailure = radius;\n"],
    ['tests/main-tsc.test.ts', [
      "import { check } from '../scripts/ci-typecheck-main-delta.ts';",
      "import { rules } from '../test/rules-contract.ts';",
      'export const injectedFailure = [check, rules];',
    ].join('\n') + '\n'],
  ]);
  for (const [path, text] of tests) put(repo, path, text);
  put(repo, 'apps/pwa/src/meta.ts', 'export const metadata = "before";\n');
  put(repo, 'scripts/release-loop/gate-pod-stall.ts', 'export const stall = "before";\n');
  put(repo, 'scripts/release-loop/gate-shard-receipts.ts', 'export const radius = "before";\n');
  put(repo, 'scripts/ci-typecheck-main-delta.ts', 'export const check = "before";\n');
  put(repo, 'test/rules-contract.ts', 'export const rules = "before";\n');
  const base = commit(repo, '0.3.5 simulated release baseline');
  git(repo, 'tag', scenario.previousReleaseTag, base);

  put(repo, 'apps/pwa/src/meta.ts', 'export const metadata = "repaired";\n');
  commit(repo, 'fix: pwa metadata gate regression (#35259)');
  put(repo, 'scripts/release-loop/gate-pod-stall.ts', 'export const stall = "repaired";\n');
  commit(repo, 'fix: gate pod stall regression (#35582)');
  put(repo, 'scripts/release-loop/gate-shard-receipts.ts', 'export const radius = "repaired";\n');
  commit(repo, 'fix: receipt reuse radius (#35626)');
  put(repo, 'scripts/ci-typecheck-main-delta.ts', 'export const check = "repaired";\n');
  put(repo, 'test/rules-contract.ts', 'export const rules = "repaired";\n');
  commit(repo, 'fix: main tsc rules ratchet (#35649)');
  return { repo, cut: git(repo, 'rev-parse', 'HEAD') };
}

test('release-sim-rig integrates all ten incident classifications with first-parent attribution and one-run recovery receipts', async () => {
  const scenario = parseYaml(await Bun.file(join(import.meta.dir, '../../scenarios/ux-sim/macrophage-attribution-integration-1107.yaml')).text()) as CoverageScenario;
  const receiptIncident = scenario.incidents.find(({ id }) => id === 'd-receipt-reuse-zero-of-81');
  expect(receiptIncident?.radiusReplay).toMatchObject({
    priorHead: '63ff4cc9ea8cf1c0c5ad451c8b35a34224a89507',
    cutHead: 'd4df149e3ae9e8862033ebbb1a1d52c0ff65ffd0',
    changedFiles: ['docs/TECH-harness-map-2026-10-06.md', 'scenarios/ux-sim/rla-arg-adaptive-heal.yaml',
      'scripts/release-loop/gate-node.ts', 'src/graph-runner/runner.ts'],
    nonTypeScriptImpactReason: 'changed-non-ts-input',
    receiptRosterFixture: 'scenarios/ux-sim/fixtures/release-cut-0306-shards.json',
    shardCount: 81, testCount: 6611, receiptsReused: 0, radiusInvalidated: 81,
    productionReplayTest: 'scripts/release-loop/gate-cut-preflight-sim.test.ts',
  });
  const root = mkdtempSync(join(tmpdir(), 'release-macrophage-attribution-integration-'));
  const previousStateRoot = getTestStateRoot();
  setTestStateRoot(root);
  try {
    const fixture = makeAttributionFixture(root, scenario);
    const failureIds = scenario.incidents.flatMap(({ failureIds: ids = [] }) => ids);
    const attributions = attributeReleaseFailures({ repo: fixture.repo, previousTag: scenario.previousReleaseTag,
      cutCommit: fixture.cut, failureIds });
    expect(attributions).toHaveLength(failureIds.length);
    expect(new Set(attributions.map(({ failureId }) => failureId)).size).toBe(failureIds.length);
    const attributionByFailure = new Map(attributions.map((row) => [row.failureId, row]));
    const signals: MacrophageIncidentSignal[] = scenario.incidents.map((incident) => {
      const rows = (incident.failureIds ?? []).map((id) => attributionByFailure.get(id)).filter((row) => row !== undefined);
      const sourceFiles = [...new Set(rows.flatMap((row) => row.sourceFiles))].sort();
      const causePrs = [...new Set(rows.flatMap((row) => row.causePrs))].sort((a, b) => a - b);
      return { id: incident.id, source: incident.source, signature: incident.signature, evidence: incident.evidence,
        sourceFiles, ...(incident.failureIds ? { failureIds: incident.failureIds } : {}),
        ...(incident.independentFiles === undefined ? {} : { independentFiles: incident.independentFiles }),
        ...(causePrs.length === 1 ? { causePr: causePrs[0] } : {}),
        ...(incident.revertSafe === undefined ? {} : { revertSafe: incident.revertSafe }),
        ...(incident.priorRepairStepsFailed === undefined ? {} : { priorRepairStepsFailed: incident.priorRepairStepsFailed }) };
    });
    const repairLandedIds = scenario.incidents.filter((incident) => incident.landed).map((incident) => incident.id);
    const hitlApprovedIds = scenario.incidents.filter((incident) => incident.expected === 'hitl').map((incident) => incident.id);
    const simulation = await runReleaseMacrophageIncidentSim({ runId: scenario.runId, incidents: signals,
      repairLandedIds, hitlApprovedIds, attributionContext: { repo: fixture.repo,
        previousTag: scenario.previousReleaseTag, cutCommit: fixture.cut },
      graphDrivenIncidentIds: ['c-three-file-regression', 'd-receipt-reuse-zero-of-81'] });

    const cAttribution = attributions.filter((row) => scenario.incidents[2]?.failureIds?.includes(row.failureId));
    const dAttribution = attributions.find((row) => scenario.incidents[3]?.failureIds?.includes(row.failureId));
    const hAttribution = attributions.find((row) => scenario.incidents[7]?.failureIds?.includes(row.failureId));
    expect(cAttribution.map((row) => row.sourceFiles).flat()).toEqual(['apps/pwa/src/meta.ts', 'scripts/release-loop/gate-pod-stall.ts']);
    expect(cAttribution.flatMap((row) => row.causePrs)).toEqual([35259, 35582]);
    expect(cAttribution.every((row) => row.confidence === 'high' && row.method === 'first-parent-source-overlap')).toBe(true);
    const originalCFailureId = scenario.incidents[2]!.failureIds![0]!;
    const originalCFailureIds = scenario.incidents[2]!.failureIds!;
    const originalDFailureId = scenario.incidents[3]!.failureIds![0]!;
    expect(originalCFailureId).toBe(originalCFailureIds[0]);
    expect(simulation.graphRepairFailureIds).toEqual(expect.arrayContaining(originalCFailureIds));
    expect(simulation.graphRepairFailureIds).toContain(originalDFailureId);
    expect(simulation.graphRepairAttributions.filter((row) => scenario.incidents[2]?.failureIds?.includes(row.failureId)))
      .toEqual(cAttribution);
    expect(simulation.graphRepairAttributions.filter((row) => scenario.incidents[3]?.failureIds?.includes(row.failureId)))
      .toEqual([dAttribution!]);
    const cRepairInput = simulation.eventTrace.find((event) => event.type === 'release.macrophage.repair-pr-landed'
      && event.data?.incidentId === 'c-three-file-regression');
    expect(cRepairInput?.data?.failureIds).toEqual(expect.arrayContaining(originalCFailureIds));
    expect(cRepairInput?.data?.attribution).toEqual(cAttribution);
    expect(cRepairInput?.data?.adaptiveRepairInputFiles).toContain('apps/pwa/src/meta.ts');
    expect(cRepairInput?.data?.adaptiveRepairInputFiles).toContain('scripts/release-loop/gate-pod-stall.ts');
    expect(simulation.graphRepairInputFiles).toEqual([
      'apps/pwa/src/meta.ts', 'scripts/release-loop/gate-pod-stall.ts', 'scripts/release-loop/gate-shard-receipts.ts',
    ]);
    expect(dAttribution).toMatchObject({ sourceFiles: ['scripts/release-loop/gate-shard-receipts.ts'], causePrs: [35626], confidence: 'high' });
    expect(hAttribution).toMatchObject({ sourceFiles: ['scripts/ci-typecheck-main-delta.ts', 'test/rules-contract.ts'], causePrs: [35649], confidence: 'high' });
    expect(simulation.pass).toBe(true);
    expect(simulation.graphState.runId).toBe(scenario.runId);
    expect(simulation.graphState.path.filter((nodeId) => nodeId === 'gate')).toHaveLength(2);
    const measuredGateOutputs = simulation.graphState.nodes.filter(({ nodeId, output }) => nodeId === 'gate' && output !== undefined);
    const finalGateOutput = measuredGateOutputs.at(-1)?.output;
    expect(JSON.parse(String(finalGateOutput ?? 'null'))).toMatchObject({ outcome: 'ok' });
    const repairNode = simulation.graphState.nodes.find(({ nodeId }) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId));
    const repairNodeOutput = JSON.parse(String(repairNode?.output ?? 'null')) as { outcome?: string; repairedFiles?: string[] };
    expect(repairNodeOutput).toMatchObject({ outcome: 'ok', repairedFiles: simulation.graphRepairInputFiles });
    expect(simulation.cases.map(({ signal, plan }) => [signal.id, plan.label, plan.step])).toEqual([
      ['a-export-check-failures', 'hitl', 'R4-hitl'],
      ['b-shard-ledger-config', 'hitl', 'R4-hitl'],
      ['c-three-file-regression', 'fix', 'R2-split-files'],
      ['d-receipt-reuse-zero-of-81', 'fix', 'R1-single-file'],
      ['e-cli-image-scope-owner', 'hitl', 'R4-hitl'],
      ['f-train-solo-starvation', 'noise', 'none'],
      ['g-worker-run-id-collision', 'hitl', 'R4-hitl'],
      ['h-main-tsc-rules-ratchet', 'hitl', 'R3-revert-proposal'],
      ['i-review-cap-loop', 'hitl', 'R4-hitl'],
      ['j-mbp-overload', 'noise', 'none'],
    ]);
    expect(simulation.cases).toHaveLength(10);
    expect(simulation.cases.every(({ pass }) => pass)).toBe(true);
    expect(simulation.cases.filter(({ receipt }) => receipt?.disposition === 'resumed-after-land')
      .map(({ signal }) => signal.id).sort()).toEqual(['c-three-file-regression', 'd-receipt-reuse-zero-of-81']);
    expect(simulation.cases.every((item) => item.resumed && item.receipt?.runId === scenario.runId)).toBe(true);
    const graphDrivenReceipt = simulation.cases.find(({ signal }) => signal.id === 'c-three-file-regression')?.receipt;
    expect(graphDrivenReceipt).toMatchObject({ disposition: 'resumed-after-land', gateVisit: 2,
      rerunFiles: ['apps/pwa/src/meta.ts', 'scripts/release-loop/gate-pod-stall.ts'] });
    expect(simulation.cases.find(({ signal }) => signal.id === 'd-receipt-reuse-zero-of-81')?.receipt)
      .toMatchObject({ disposition: 'resumed-after-land', gateVisit: 2,
        rerunFiles: ['scripts/release-loop/gate-shard-receipts.ts'] });
    expect(graphDrivenReceipt?.receiptIds).toContain('shard-0');
    expect(simulation.jsonl.trim().split('\n')).toHaveLength(10);
  } finally {
    setTestStateRoot(previousStateRoot ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
