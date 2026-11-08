import { expect, test } from 'bun:test';
import type { ClosureTree } from './release-loop/gate-closure.js';
import { runSimImpactCli, runSimImpactGoalCli, type PullRequestSnapshot, type SimImpactDependencies } from './sim-impact.js';

const gatePath = 'scripts/release-loop/gate-node.ts';
const pr: PullRequestSnapshot = {
  number: 35482,
  title: 'fix(release): fail closed on unpinned Pod gates',
  baseSha: '1'.repeat(40),
  headSha: '2'.repeat(40),
  files: [
    {
      filename: gatePath,
      status: 'modified',
      patch: [
        '@@ -1,0 +1,7 @@',
        '+if (opts.pod && (!(opts.graphRunId || opts.rehearsalBaseline) || opts.imagePin !== \'cut-commit\')) {',
        '+  debug.log(\'release-loop.gate\', \'image-pin-unscoped\', { decision: \'fail-closed\' });',
        '+  throw new Error(\'gate pod refused to start without a scoped cut image pin\');',
        '+}',
      ].join('\n'),
    },
    { filename: 'scripts/release-loop/gate-node.test.ts', status: 'modified', patch: '@@ -1,0 +1 @@\n+test(\'production direct Pod guard refuses an unscoped gate\', () => {});' },
    { filename: 'docs/TECH-harness-map-2026-10-06.md', status: 'modified' },
  ],
};

function fixtureTree(): ClosureTree {
  const contents = new Map<string, string>([
    [gatePath, '#!/usr/bin/env bun\nexport function judgeGate() {}\nif (import.meta.main) {}\n'],
    ['scripts/release-loop/gate-node.test.ts', "import { judgeGate } from './gate-node.js';\ntest('gate', () => judgeGate());\n"],
    ['scripts/release-loop/gate-caller.ts', "import { judgeGate } from './gate-node.js';\nexport const gate = judgeGate;\n"],
    ['graphs/release/release-loop.yaml', `gate:\n  command: bun ${gatePath}\n`],
    ['scenarios/ux-sim/gate-receipt-carry-any-run.yaml', `id: gate-receipt-carry-any-run-0306\nsource: ${gatePath}\ncases:\n  - id: image-change\n`],
    ['scenarios/ux-sim/gate-deps-root-bake.yaml', `kind: gate-deps-root-bake\nproduction:\n  shardInstall: ${gatePath}\n`],
    ['src/ux-sim/unrelated.test.ts', "test('unrelated', () => {});\n"],
  ]);
  const files = [...contents.keys()];
  return {
    files,
    read: (file) => contents.get(file),
    preload: [],
  };
}

test('PR #35482 reports the changed Pod entry guard and the missing simulated graph path', async () => {
  const dependencies: SimImpactDependencies = {
    repositoryRoot: '/repo',
    loadPullRequest: async (number) => {
      expect(number).toBe(35482);
      return pr;
    },
    loadTree: (commit) => {
      expect(commit).toBe(pr.headSha);
      return fixtureTree();
    },
    readFileAtCommit: (_commit, path) => fixtureTree().read(path),
    loadPathEvidence: () => [],
  };
  let output = '';
  const report = await runSimImpactCli(['--pr', '35482', '--json'], dependencies, (text) => { output += text; });
  expect(JSON.parse(output)).toEqual(report);
  expect(report).toMatchObject({
    entryPoints: [gatePath],
    graphCallers: ['graphs/release/release-loop.yaml'],
    guards: [{ id: 'release-loop.gate.image-pin-unscoped', file: gatePath }],
    scenarioDefinitions: [
      { id: 'gate-deps-root-bake', file: 'scenarios/ux-sim/gate-deps-root-bake.yaml' },
      { id: 'gate-receipt-carry-any-run-0306', file: 'scenarios/ux-sim/gate-receipt-carry-any-run.yaml' },
    ],
    verifiedScenarios: [],
    gaps: ['공백: 게이트 진입 가드 · 밟는 시나리오 없음'],
  });
  expect(report.reverseImportClosure).toContain('scripts/release-loop/gate-node.test.ts');
  expect(report.reverseImportClosure).toContain('scripts/release-loop/gate-caller.ts');
  expect(report.reverseImportClosure).not.toContain('src/ux-sim/unrelated.test.ts');
});

test('a scenario definition reference alone does not count as graph.path evidence', async () => {
  const dependencies: SimImpactDependencies = {
    repositoryRoot: '/repo',
    loadPullRequest: async () => pr,
    loadTree: () => fixtureTree(),
    readFileAtCommit: (_commit, path) => fixtureTree().read(path),
    loadPathEvidence: () => [],
  };
  const report = await runSimImpactCli(['--pr', '35482'], dependencies, () => {});
  expect(report.scenarioDefinitions.length).toBe(2);
  expect(report.verifiedScenarios).toEqual([]);
  expect(report.gaps).toContain('공백: 게이트 진입 가드 · 밟는 시나리오 없음');
});

test('an unrelated graph.path event cannot prove guard coverage', async () => {
  const dependencies: SimImpactDependencies = {
    repositoryRoot: '/repo',
    loadPullRequest: async () => pr,
    loadTree: () => fixtureTree(),
    readFileAtCommit: (_commit, path) => fixtureTree().read(path),
    loadPathEvidence: () => [{
      scenarioId: 'gate-receipt-carry-any-run-0306',
      runId: 'sim-run-1',
      entryPoint: 'graph',
      events: [{ event: 'graph.path', from: 'unrelated', taken: 'failed' }],
    }],
  };
  const report = await runSimImpactCli(['--pr', '35482', '--event-evidence', 'evidence.json'], dependencies, () => {});
  expect(report.verifiedScenarios).toEqual([]);
  expect(report.gaps).toContain('공백: 게이트 진입 가드 · 밟는 시나리오 없음');
});

test('a matching scenario path containing the changed guard is accepted', async () => {
  const dependencies: SimImpactDependencies = {
    repositoryRoot: '/repo',
    loadPullRequest: async () => pr,
    loadTree: () => fixtureTree(),
    readFileAtCommit: (_commit, path) => fixtureTree().read(path),
    loadPathEvidence: () => [{
      scenarioId: 'gate-receipt-carry-any-run-0306',
      runId: 'sim-run-2',
      entryPoint: 'graph',
      events: [{ event: 'graph.path', from: 'gate', taken: 'failed', guardId: 'release-loop.gate.image-pin-unscoped' }],
    }],
  };
  const report = await runSimImpactCli(['--pr', '35482', '--event-evidence', 'evidence.json'], dependencies, () => {});
  expect(report.verifiedScenarios).toEqual([{
    id: 'gate-receipt-carry-any-run-0306', runId: 'sim-run-2', entryPoint: 'graph', guardId: 'release-loop.gate.image-pin-unscoped',
  }]);
  expect(report.gaps).toEqual([]);
});

test('each uncovered changed guard remains identifiable when one has coverage', async () => {
  const multiGuardPr: PullRequestSnapshot = {
    ...pr,
    files: [...pr.files,
      { filename: 'scripts/release-loop/other-node.ts', status: 'modified', patch: "@@ -1 +1,2 @@\n+if (!authorized) throw new Error('bad token');" },
      { filename: 'scripts/release-loop/yet-another-node.ts', status: 'modified', patch: "@@ -1 +1,2 @@\n+if (!ready) throw new Error('not ready');" },
    ],
  };
  const dependencies: SimImpactDependencies = {
    repositoryRoot: '/repo',
    loadPullRequest: async () => multiGuardPr,
    loadTree: () => fixtureTree(),
    readFileAtCommit: (_commit, path) => fixtureTree().read(path),
    loadPathEvidence: () => [{
      scenarioId: 'gate-receipt-carry-any-run-0306',
      runId: 'sim-run-covered',
      entryPoint: 'graph',
      events: [{ event: 'graph.path', from: 'gate', guardId: 'release-loop.gate.image-pin-unscoped' }],
    }],
  };
  const report = await runSimImpactCli(['--pr', '35482'], dependencies, () => {});
  expect(report.guards.map((guard) => guard.id)).toContain('changed-guard:scripts/release-loop/other-node.ts');
  expect(report.gaps).toEqual([
    '공백: 게이트 진입 가드 · 밟는 시나리오 없음 [changed-guard:scripts/release-loop/other-node.ts]',
    '공백: 게이트 진입 가드 · 밟는 시나리오 없음 [changed-guard:scripts/release-loop/yet-another-node.ts]',
  ]);
});

test('goal input reports missing simulator proof wording and resolves a named scenario', () => {
  const dependencies = {
    repositoryRoot: '/repo',
    readGoal: (_path: string) => '대상 경로: scripts/release-loop/gate-node.ts\n이 골은 게이트 가드를 바꾼다.',
    loadTree: fixtureTree,
  };
  let output = '';
  const missing = runSimImpactGoalCli(['--goal', 'docs/goals/GOAL-gate.md'], dependencies, (value) => { output += value; });
  expect(missing.gaps).toEqual(['공백: 시뮬 월드 미고려 · 증명 시나리오 없음']);
  expect(missing.entryPoints).toEqual([gatePath]);
  expect(output).toContain('공백: 시뮬 월드 미고려');

  const resolved = runSimImpactGoalCli(['--goal', 'docs/goals/GOAL-gate.md', '--json'], {
    ...dependencies,
    readGoal: () => '대상 경로: scripts/release-loop/gate-node.ts\n증명 시나리오: gate-receipt-carry-any-run-0306',
  }, (value) => { output = value; });
  expect(resolved.gaps).toEqual([]);
  expect(JSON.parse(output)).toEqual(resolved);

  const unresolved = runSimImpactGoalCli(['--goal', 'docs/goals/GOAL-new-file.md'], {
    ...dependencies,
    readGoal: () => '대상 경로: src/new-gate.ts\n신설 장치: TODO',
  }, () => {});
  expect(unresolved.unresolvedTargets).toEqual(['src/new-gate.ts']);
  expect(unresolved.gaps).toEqual([
    '공백: 대상 경로를 저장소에서 찾을 수 없음 · src/new-gate.ts',
    '공백: 시뮬 월드 미고려 · 증명 시나리오 없음',
  ]);

  const mixed = runSimImpactGoalCli(['--goal', 'docs/goals/GOAL-mixed.md'], {
    ...dependencies,
    readGoal: () => '대상 경로: scripts/release-loop/gate-node.ts · src/new-gate.ts\n가드를 보강한다.',
  }, () => {});
  expect(mixed.gaps).toEqual([
    '공백: 대상 경로를 저장소에서 찾을 수 없음 · src/new-gate.ts',
    '공백: 시뮬 월드 미고려 · 증명 시나리오 없음',
  ]);
});

test('an unresolved code target independently emits both path and simulator-proof gaps', () => {
  const report = runSimImpactGoalCli(['--goal', 'docs/goals/GOAL-unresolved-only.md'], {
    repositoryRoot: '/repo',
    readGoal: () => '대상 경로: src/not-yet-created.ts\n가드 경로를 구현한다.',
    loadTree: fixtureTree,
  }, () => {});

  expect(report.targets).toEqual([]);
  expect(report.unresolvedTargets).toEqual(['src/not-yet-created.ts']);
  expect(report.gaps).toEqual([
    '공백: 대상 경로를 저장소에서 찾을 수 없음 · src/not-yet-created.ts',
    '공백: 시뮬 월드 미고려 · 증명 시나리오 없음',
  ]);
});
