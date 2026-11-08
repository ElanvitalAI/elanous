import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { partialFailuresOf } from '../../scripts/release-loop/gate-node.js';
import { planGateBisect } from '../../scripts/release-loop/gate-bisect.js';
import { runGateBisectSidecar } from '../../scripts/release-loop/gate-bisect-sidecar.js';
import { testFileOfId } from '../../scripts/release-loop/gate-partial.js';
import { runGateRepairNode } from '../../scripts/release-loop/gate-repair-node.js';
import { runReleaseMacrophageIncidentSim } from './release-sim-rig.js';

test('MACRO-CHAIN-E2E: production shard failure collection feeds bisect findings into same-run multi-file repair', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'macro-chain-e2e-'));
  const previous = getTestStateRoot();
  setTestStateRoot(root);
  try {
    const runId = 'macro-chain-e2e-bisect-collect-all';
    const failures = [
      'src/alpha.ts.test.ts > alpha regression',
      'src/beta.ts.test.ts > beta regression',
      'src/gamma.ts.test.ts > gamma regression',
    ];
    const completeShardRuns = failures.map((id) => ({ rc: 1, files: 1,
      output: `${id.split(' > ')[0]}:\n(fail) ${id.split(' > ')[1]} [1.00ms]\n1 fail\nRan 1 test across 1 files.\n` }));
    const collected = partialFailuresOf(completeShardRuns);
    expect(collected).toEqual({ failures, errors: [] });

    const baseCommit = 'a'.repeat(40);
    const firstBadCommit = 'b'.repeat(40);
    const cutCommit = 'c'.repeat(40);
    const planned = planGateBisect({ version: '0.3.8', baseCommit, cutCommit,
      firstParentCommits: [firstBadCommit, cutCommit], introducedIds: collected.failures,
      basePass: true, cutFail: true, host: 'gcp2' });
    if (!planned.ok) throw new Error(`production bisect planner refused collected failures: ${planned.reason}`);
    expect(planned.plan.files).toEqual(failures.map(testFileOfId).sort());

    const ledger = join(root, 'ledger');
    const resultPath = join(root, 'bisect.json');
    mkdirSync(ledger, { recursive: true });
    await runGateBisectSidecar({ plan: planned.plan, repo: process.cwd(), ledger, path: resultPath, runId,
      pod: { pool: 'pool-sim@gcp2:1' }, alternatePool: 'pool-sim@gcp2:1' },
    async (_file, commit) => commit === baseCommit ? 'pass' : commit === firstBadCommit || commit === cutCommit ? 'fail' : 'unmeasured', {
      resolveOwner: () => ({ pullRequest: 77, owner: 'sim-owner', ownerSeat: 'OPT' }),
      ownerMail: { post: async () => ({ id: 'sim-owner-mail' }) },
    });
    const bisect = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      status: string; findings: Array<{ file: string; firstFailingCommit: string }>; unmeasured: unknown[];
    };
    expect(bisect.status).toBe('complete');
    expect(bisect.unmeasured).toEqual([]);
    expect(bisect.findings.map(({ file, firstFailingCommit: commit }) => ({ file, firstFailingCommit: commit })))
      .toEqual(planned.plan.files.map((file) => ({ file, firstFailingCommit: firstBadCommit }))
        .sort((a, b) => a.file.localeCompare(b.file)));

    const bisectedCommits = [...new Set(bisect.findings.map(({ firstFailingCommit }) => firstFailingCommit))];
    expect(bisectedCommits).toEqual([firstBadCommit]);
    const bisectedCommit = bisectedCommits[0]!;
    const sourceFiles = [...new Set(bisect.findings.map(({ file }) => file.replace(/\.test\.ts$/, '')))].sort();
    const repairBisectFindings = bisect.findings.map(({ file, firstFailingCommit }) => ({
      file: file.replace(/\.test\.ts$/, ''), firstFailingCommit,
    }));

    const attributedFailureIds = collected.failures.map((failureId) => {
      const testFile = testFileOfId(failureId);
      return `${testFile.replace(/\.test\.ts$/, '')} > ${failureId}`;
    });
    const repairPrompts = new Map<string, string>();
    const repairPrs = new Map<number, { file: string; head: string }>();
    let nextRepairPr = 70000;
    const repair = await runGateRepairNode({ runId, input: { version: '0.3.8', previousVersion: '0.3.7' },
      nodeInput: { version: '0.3.8', runId, commit: cutCommit, failureIds: attributedFailureIds,
        bisectFindings: repairBisectFindings,
        independenceEvidence: collected.failures.map((failureId) => ({ failureId,
          sourceFiles: [testFileOfId(failureId).replace(/\.test\.ts$/, '')], unresolvedImports: [] })) } } as never, {
      root: join(root, 'repair-state'), repo: process.cwd(),
      attributeFailures: (() => collected.failures.map((failureId) => ({ failureId, testFile: testFileOfId(failureId),
        sourceFiles: [testFileOfId(failureId).replace(/\.test\.ts$/, '')], causePrs: [77], confidence: 'high',
        method: 'first-parent-source-overlap', evidence: [], unresolvedImports: [] }))) as never,
      startRepairChild: async (featureFile) => {
        const body = readFileSync(featureFile, 'utf8');
        const file = /^Attributed source file: (.+)$/m.exec(body)?.[1];
        if (!file) throw new Error('production repair feature omitted its source file');
        repairPrompts.set(file, body);
        const prNumber = nextRepairPr++;
        const head = 'd'.repeat(40 - String(prNumber).length) + prNumber;
        repairPrs.set(prNumber, { file, head });
        return { ok: true, prNumber, prUrl: `https://github.com/ElanvitalAI/elanous/pull/${prNumber}` };
      },
      inspectRepairPr: async (prNumber) => {
        const pr = repairPrs.get(prNumber);
        if (!pr) throw new Error(`unknown simulated repair PR ${prNumber}`);
        return { isDraft: false, files: [pr.file], headRefOid: pr.head };
      },
      waitForLanded: async (prNumber) => {
        const pr = repairPrs.get(prNumber);
        if (!pr) throw new Error(`unknown simulated landing PR ${prNumber}`);
        return { schema: 1, prNumber, repairRunId: runId, head: pr.head, mergeSha: 'f'.repeat(40), base: 'main',
          mergedAt: '2026-11-08T00:00:00.000Z' };
      },
      isAncestor: () => true, refreshMainlineHead: () => 'e'.repeat(40),
    });
    expect(repair.outcome).toBe('ok');
    const repaired = repair.repairs.filter((entry) => entry.status === 'repaired');
    expect(repaired.map(({ file, firstFailingCommit }) => ({ file, firstFailingCommit })))
      .toEqual(repairBisectFindings.sort((a, b) => a.file.localeCompare(b.file)));
    expect(repairPrompts.size).toBe(sourceFiles.length);
    for (const file of sourceFiles) expect(repairPrompts.get(file)).toContain(`Bisected first-failing commit: ${bisectedCommit}`);

    const incident = { id: 'c-three-file-regression', source: 'release-graph' as const,
      signature: `bisect ${bisectedCommit}; production collect-all returned ${collected.failures.length} failures`,
      evidence: 'introduced' as const, failureIds: collected.failures, sourceFiles, independentFiles: true, causePr: 77 };
    const macro = await runReleaseMacrophageIncidentSim({ runId, incidents: [incident],
      repairLandedIds: [incident.id], hitlApprovedIds: [], graphDrivenIncidentIds: [incident.id] });
    expect(macro.pass, JSON.stringify({ graphState: macro.graphState.status, path: macro.graphState.path,
      repairFailureIds: macro.graphRepairFailureIds, repairFiles: macro.graphRepairInputFiles })).toBe(true);
    expect(macro.runId).toBe(runId);
    expect(macro.graphRepairFailureIds).toEqual(collected.failures);
    expect(macro.graphRepairInputFiles).toEqual(sourceFiles);
    const injectedIncident = macro.eventTrace.find((event) => event.type === 'release.macrophage.incident.injected'
      && (event.data?.signal as { id?: string } | undefined)?.id === incident.id);
    expect(injectedIncident?.data?.signal).toMatchObject({ signature: expect.stringContaining(bisectedCommit) });
    expect(macro.cases[0]).toMatchObject({ plan: { label: 'fix', step: 'R2-split-files', files: sourceFiles },
      resumed: true, receipt: { runId, disposition: 'resumed-after-land', gateVisit: 2, rerunFiles: sourceFiles } });
    expect(macro.jsonl.trim().split('\n').map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ runId, incidentId: incident.id, disposition: 'resumed-after-land', rerunFiles: sourceFiles }));
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
