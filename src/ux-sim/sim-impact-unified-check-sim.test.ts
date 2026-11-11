import { expect, test } from 'bun:test';
import type { ClosureTree } from '../../scripts/release-loop/gate-closure.js';
import {
  runSimImpactCheckCli,
  type SimImpactCheckResult,
  type SimImpactCheckDependencies,
} from '../../scripts/sim-impact-check.js';
import type { GraphPathEvidence } from '../../scripts/sim-impact.js';
import { formatSimImpactGaps, runSimImpactAudit } from '../loops/orchestrator/sim-impact-audit.js';
import type { WorkItem } from '../loops/orchestrator/overlap.js';
import type { PullRequestSnapshot, SimImpactDependencies } from '../../scripts/sim-impact.js';

const gatePath = 'scripts/release-loop/gate-node.ts';
const scenarioId = 'sim-impact-gate-entry-guard';
const pullRequest: PullRequestSnapshot = {
  number: 35482,
  title: 'fix(release): fail closed on unpinned Pod gates',
  baseSha: '1'.repeat(40),
  headSha: '2'.repeat(40),
  files: [{
    filename: gatePath,
    status: 'modified',
    patch: [
      '+if (!graphRunId || !imagePin) {',
      '+  debug.log("gate.guard", "image-pin-unscoped", { decision: "fail-closed" });',
      '+  throw new Error("gate refused: required scope unavailable");',
      '+}',
    ].join('\n'),
  }],
};

function fixtureTree(): ClosureTree {
  const files = new Map<string, string>([
    [gatePath, '#!/usr/bin/env bun\nexport function judgeGate() { return true; }\n'],
    ['scripts/release-loop/gate-wrapper.ts', `import { judgeGate } from './gate-node.js';\nexport const run = judgeGate;\n`],
    ['graphs/release/release-loop.yaml', `gate-check:\n  command: bun ${gatePath}\n`],
    [`scenarios/ux-sim/${scenarioId}.yaml`, `id: ${scenarioId}\nsource: ${gatePath}\ncases:\n  - id: scoped-refusal\n`],
    ['src/feature.ts', 'export const feature = true;\n'],
  ]);
  return { files: [...files.keys()], read: (path) => files.get(path), preload: [] };
}

function dependencies(evidence: GraphPathEvidence[] = []): SimImpactCheckDependencies {
  const tree = fixtureTree();
  const pr: SimImpactDependencies = {
    repositoryRoot: '/repo',
    loadPullRequest: async (number) => ({ ...pullRequest, number }),
    loadTree: () => tree,
    readFileAtCommit: (_commit, path) => tree.read(path),
    loadPathEvidence: () => evidence,
  };
  return {
    pullRequest: pr,
    goal: {
      repositoryRoot: '/repo',
      readGoal: () => '대상 경로: src/feature.ts\n기능을 추가한다.',
      loadTree: () => tree,
    },
  };
}

function expectGoalResult(result: SimImpactCheckResult): asserts result is Extract<SimImpactCheckResult, { mode: 'goal' }> {
  expect(result.mode).toBe('goal');
  if (result.mode !== 'goal') throw new Error(`expected goal result, got ${result.mode}`);
}

function expectPrResult(result: SimImpactCheckResult): asserts result is Extract<SimImpactCheckResult, { mode: 'pr' }> {
  expect(result.mode).toBe('pr');
  if (result.mode !== 'pr') throw new Error(`expected PR result, got ${result.mode}`);
}

test('SIM-IMPACT-UNIFIED-CHECK: goal warning/refusal and PR T2/pass follow the real graph path', async () => {
  const deps = dependencies();
  let goalOutput = '';
  const goal = await runSimImpactCheckCli(['--goal', 'goal.md', '--json'], deps, (text) => { goalOutput += text; });
  expect(goal.decision).toBe('warning');
  expect(goal.exitCode).toBe(0);
  expect(JSON.parse(goalOutput)).toEqual(goal);

  let guardOutput = '';
  const guardGoal = await runSimImpactCheckCli(['--goal', 'guard-goal.md', '--json'], {
    ...deps,
    goal: { ...deps.goal!, readGoal: () => `대상 경로: ${gatePath}\n가드 경로를 바꾼다.` },
  }, (text) => { guardOutput += text; });
  expectGoalResult(guardGoal);
  expect(guardGoal.decision).toBe('refuse');
  expect(guardGoal.exitCode).toBe(2);
  expect(JSON.parse(guardOutput).impact.entryPoints).toContain(gatePath);

  const unresolvedGuardGoal = await runSimImpactCheckCli(['--goal', 'missing-guard-goal.md', '--json'], {
    ...deps,
    goal: { ...deps.goal!, readGoal: () => '대상 경로: scripts/release-loop/new-gate.ts\n게이트 가드를 추가한다.' },
  }, () => {});
  expectGoalResult(unresolvedGuardGoal);
  expect(unresolvedGuardGoal.decision).toBe('refuse');
  expect(unresolvedGuardGoal.impact.unresolvedTargets).toEqual(['scripts/release-loop/new-gate.ts']);

  const uncovered = await runSimImpactCheckCli(['--pr', '35482', '--json'], deps, () => {});
  expect(uncovered.decision).toBe('t2-hold');
  expect(uncovered.exitCode).toBe(2);
  expect(uncovered.impact.gaps).toContain('공백: 게이트 진입 가드 · 밟는 시나리오 없음');

  const coveredDeps = dependencies([{
    scenarioId,
    runId: 'sim-impact-run-1',
    entryPoint: 'graph',
    events: [{ event: 'graph.path', from: 'start', taken: 'gate-check', path: ['start', 'gate-check'], guardId: 'release-loop.gate.image-pin-unscoped' }],
  }]);
  const covered = await runSimImpactCheckCli(['--pr', '35482', '--json'], coveredDeps, () => {});
  expectPrResult(covered);
  expect(covered.decision).toBe('pass');
  expect(covered.exitCode).toBe(0);
  expect(covered.impact.verifiedScenarios).toEqual([{
    id: scenarioId, runId: 'sim-impact-run-1', entryPoint: 'graph', guardId: 'release-loop.gate.image-pin-unscoped',
  }]);
  expect(covered.impact.reverseImportClosure).toContain('scripts/release-loop/gate-wrapper.ts');
  expect(covered.impact.graphCallers).toEqual(['graphs/release/release-loop.yaml']);

  const invalidEvidence = dependencies([
    {
      scenarioId: 'not-a-defined-scenario', runId: 'sim-impact-run-2', entryPoint: 'graph',
      events: [{ event: 'graph.path', taken: 'gate-check', guardId: 'release-loop.gate.image-pin-unscoped' }],
    },
    {
      scenarioId, runId: '', entryPoint: 'graph',
      events: [{ event: 'graph.path', taken: 'gate-check', guardId: 'release-loop.gate.image-pin-unscoped' }],
    },
    {
      scenarioId, runId: 'sim-impact-run-3', entryPoint: 'graph',
      events: [{ event: 'graph.path', taken: 'gate-check', guardId: 'wrong.guard.id' }],
    },
    {
      scenarioId, runId: 'sim-impact-run-4', entryPoint: 'graph',
      events: [{ event: 'node.completed', taken: 'gate-check', guardId: 'release-loop.gate.image-pin-unscoped' }],
    },
  ]);
  const rejectedEvidence = await runSimImpactCheckCli(['--pr', '35482', '--json'], invalidEvidence, () => {});
  expectPrResult(rejectedEvidence);
  expect(rejectedEvidence.decision).toBe('t2-hold');
  expect(rejectedEvidence.impact.verifiedScenarios).toEqual([]);
  expect(rejectedEvidence.impact.gaps).toContain('공백: 게이트 진입 가드 · 밟는 시나리오 없음');
});

test('SIM-IMPACT-UNIFIED-CHECK: twice-daily audit sends unproven changed paths to OP', () => {
  const work: WorkItem = {
    kind: 'pr', ref: '#35482', seat: 'UX', files: [gatePath], cells: ['SIM-IMPACT-UNIFIED-CHECK'],
  };
  const reports: string[] = [];
  expect(runSimImpactAudit('08', '/repo', { work: () => [work], post: (body) => reports.push(body) })).toHaveLength(1);
  expect(runSimImpactAudit('12', '/repo', { work: () => [work], post: (body) => reports.push(body) })).toEqual([]);
  expect(runSimImpactAudit('18', '/repo', { work: () => [work], post: (body) => reports.push(body) })).toHaveLength(1);
  expect(reports).toHaveLength(2);
  expect(reports.every((body) => body === formatSimImpactGaps([{
    kind: 'pr', ref: '#35482', seat: 'UX', files: [gatePath], cells: ['SIM-IMPACT-UNIFIED-CHECK'], reason: 'missing-proof-scenario',
  }]))).toBe(true);
});
