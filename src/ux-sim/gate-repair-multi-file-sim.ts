import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGateRepairNode, type GateRepairNodeDeps } from '../../scripts/release-loop/gate-repair-node.js';
import { RepairLandingRecoveryExhaustedError } from '../../scripts/release-loop/repair-pr-landed.js';
import type { GraphContext } from '../../scripts/release-loop/node-verdict.js';
import type { ReleaseFailureAttribution } from '../release-loop/release-failure-attribution.js';

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

export interface GateRepairMultiFileSimulation {
  readonly verdict: 'green' | 'red';
  readonly sourceFiles: number;
  readonly startedChildren: number;
  readonly childStartsByFile: Readonly<Record<string, number>>;
  readonly featureWritesUnderTempRoot: boolean;
  readonly maxConcurrentChildren: number;
  readonly repairedFiles: readonly string[];
  readonly hitlFiles: readonly string[];
  readonly remainingFailureIds: readonly string[];
  readonly summary: string;
}

export async function simulateGateRepairMultiFile(): Promise<GateRepairMultiFileSimulation> {
  const root = mkdtempSync(join(tmpdir(), 'gate-repair-multi-file-sim-'));
  const commit = 'a'.repeat(40);
  const runId = 'sim-gate-repair-multi-file';
  const sourceFiles = Array.from({ length: 15 }, (_, index) => `src/repair-fixtures/source-${String(index).padStart(2, '0')}.ts`);
  const failureIds = sourceFiles.map((_, index) => `src/repair-fixtures/test-${String(index).padStart(2, '0')}.test.ts > failure-${String(index).padStart(2, '0')}`);
  const sourceAttribution = new Map<string, string[]>();
  for (let index = 0; index < sourceFiles.length; index++) sourceAttribution.set(failureIds[index]!, [sourceFiles[index]!]);
  // The last two source files share one failing test and must stay together for HITL.
  sourceAttribution.set(failureIds[13]!, sourceFiles.slice(13));
  sourceAttribution.set(failureIds[14]!, sourceFiles.slice(13));
  const attributions: ReleaseFailureAttribution[] = failureIds.map((failureId, index) => ({
    failureId,
    testFile: `src/repair-fixtures/test-${String(index).padStart(2, '0')}.test.ts`,
    sourceFiles: sourceAttribution.get(failureId)!,
    causePrs: [41000 + index],
    unresolvedImports: [],
    confidence: 'high',
    method: 'first-parent-source-overlap',
    evidence: [],
  }));
  const independenceEvidence = attributions.map((row) => ({ failureId: row.failureId,
    sourceFiles: [...row.sourceFiles], unresolvedImports: [] }));
  let activeChildren = 0;
  let maxConcurrentChildren = 0;
  let startedChildren = 0;
  const childStartsByFile: Record<string, number> = {};
  let featureWritesUnderTempRoot = true;
  const failingFile = sourceFiles[12]!;
  const deps: GateRepairNodeDeps = {
    root,
    repo: root,
    attributeFailures: () => attributions,
    startRepairChild: async (featureFile) => {
      featureWritesUnderTempRoot &&= featureFile.startsWith(join(root, 'release', 'gate-repairs', runId) + '/');
      const file = sourceFiles.find((candidate) => featureFile.includes(candidate.replaceAll('/', '__')))!;
      startedChildren++;
      childStartsByFile[file] = (childStartsByFile[file] ?? 0) + 1;
      activeChildren++;
      maxConcurrentChildren = Math.max(maxConcurrentChildren, activeChildren);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeChildren--;
      return file === failingFile ? { ok: false, stage: 'focused-test-failed' }
        : { ok: true, prNumber: 42000 + sourceFiles.indexOf(file), prUrl: `https://example.test/pull/${42000 + sourceFiles.indexOf(file)}` };
    },
    inspectRepairPr: async (prNumber) => ({ isDraft: false, files: [sourceFiles[prNumber - 42000]!], headRefOid: 'b'.repeat(40) }),
    waitForLanded: async (prNumber) => ({ schema: 1, prNumber, repairRunId: runId,
      head: 'b'.repeat(40), mergeSha: 'c'.repeat(40), base: 'main', mergedAt: '2026-11-09T00:00:00Z' }),
    refreshMainlineHead: () => 'd'.repeat(40),
    isAncestor: () => true,
  };
  const context: GraphContext = {
    runId,
    input: { version: '0.3.8', previousVersion: '0.3.7' },
    nodeInput: { version: '0.3.8', runId, commit, failureIds, independenceEvidence },
    outputs: {},
  };
  try {
    const result = await runGateRepairNode(context, deps);
    const repairedFiles = result.repairedFiles;
    const humanRequired = result.humanRequired ?? [];
    const remainingFailureIds = result.remainingFailureIds ?? [];
    const hitlFiles = humanRequired.map((row) => row.file);
    const expectedHitl = new Set([failingFile, ...sourceFiles.slice(13)]);
    const expectedRemainingFailureIds = [failureIds[13]!, failureIds[14]!, failureIds[12]!];
    const childStartsMatch = sourceFiles.every((file, index) => (childStartsByFile[file] ?? 0) === (index < 13 ? 1 : 0)) &&
      Object.keys(childStartsByFile).every((file) => sourceFiles.includes(file));
    const verdict = result.outcome === 'fail' && sameStringSet(repairedFiles, sourceFiles.slice(0, 12)) &&
      sameStringSet(hitlFiles, [...expectedHitl]) && sameStringSet(remainingFailureIds, expectedRemainingFailureIds) &&
      childStartsMatch &&
      featureWritesUnderTempRoot && startedChildren === 13 && maxConcurrentChildren === 2 ? 'green' : 'red';
    return { verdict, sourceFiles: sourceFiles.length, startedChildren, childStartsByFile, featureWritesUnderTempRoot, maxConcurrentChildren,
      repairedFiles, hitlFiles, remainingFailureIds, summary: result.summary };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function simulateGateRepairRecoveryIdDedupe(): Promise<{ outcome: string; remainingFailureIds: string[]; humanRequiredFailureIds: string[]; recoveryAttempted: boolean }> {
  const root = mkdtempSync(join(tmpdir(), 'gate-repair-recovery-dedupe-sim-'));
  const runId = 'sim-gate-repair-recovery-dedupe';
  const commit = 'e'.repeat(40);
  const file = 'src/repair-fixtures/recovery.ts';
  const failureId = 'src/repair-fixtures/recovery.test.ts > repeated recovery failure';
  const sourceAttribution: ReleaseFailureAttribution = { failureId, testFile: 'src/repair-fixtures/recovery.test.ts',
    sourceFiles: [file], causePrs: [43001], unresolvedImports: [], confidence: 'high',
    method: 'first-parent-source-overlap', evidence: [] };
  const uncertainAttribution: ReleaseFailureAttribution = { ...sourceAttribution,
    testFile: 'src/repair-fixtures/uncertain.test.ts', sourceFiles: ['src/repair-fixtures/uncertain.ts'],
    causePrs: [], confidence: 'ambiguous' };
  let recoveryAttempted = false;
  const deps: GateRepairNodeDeps = {
    root, repo: root,
    attributeFailures: () => [sourceAttribution, uncertainAttribution],
    startRepairChild: async () => ({ ok: true, prNumber: 43001, prUrl: 'https://example.test/pull/43001' }),
    inspectRepairPr: async () => ({ isDraft: false, files: [file], headRefOid: 'f'.repeat(40) }),
    waitForLanded: async () => { recoveryAttempted = true; throw new RepairLandingRecoveryExhaustedError('simulated landing recovery exhaustion'); },
  };
  const context: GraphContext = { runId, input: { version: '0.3.8', previousVersion: '0.3.7' },
    nodeInput: { version: '0.3.8', runId, commit, failureIds: [failureId] }, outputs: {} };
  try {
    const result = await runGateRepairNode(context, deps);
    return { outcome: result.outcome, remainingFailureIds: result.remainingFailureIds ?? [],
      humanRequiredFailureIds: (result.humanRequired ?? []).flatMap((row) => row.failureIds ?? []), recoveryAttempted };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
