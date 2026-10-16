import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildTrainReachDecision, type TrainReachInput, type TrainReachObservation } from './train-reach-grouping.js';
import { buildTrainScenarioDecision, readTrainTestPopulation, type TrainRiskEvidence } from './train-scenario-layers.js';

const input: TrainReachInput = {
  version: 1, baseSha: 'a'.repeat(40), queueSig: 'b'.repeat(64), prs: [
    { pr: '27901', headSha: '1'.repeat(40), tree: '/work/27901', changedFiles: ['src/changed-a.ts'] },
    { pr: '27902', headSha: '2'.repeat(40), tree: '/work/27902', changedFiles: ['src/changed-b.ts'] },
    { pr: '27903', headSha: '3'.repeat(40), tree: '/work/27903', changedFiles: ['src/changed-c.ts'] },
  ],
};
const population = [
  'test/shared.test.ts', 'test/other.test.ts', 'test/b-only.test.ts', 'test/pair.test.ts',
  'test/canary a.test.ts', 'test/canary b.test.ts', 'test/canary c.test.ts',
  'src/git-fs/spawn-discipline.test.ts',
];
const emptyEvidence = (): TrainRiskEvidence => ({ verifiedHotFiles: [], verifiedInterferencePairs: [], suspectedPairs: [] });
const observation = (changedFiles: string[], testFiles: string[], unrunImporterTotal = 0): TrainReachObservation =>
  ({ changedFiles, testFiles, unverified: [], unrunImporterTotal,
    routeLookupFailures: [], callerTestsOverflow: [], alwaysIncludeMissing: [] });
const reach = (unrunImporterTotal = 0) => buildTrainReachDecision(input, (candidate) => {
  if (candidate.pr === '27901') return observation(candidate.changedFiles, ['test/shared.test.ts', 'src/git-fs/spawn-discipline.test.ts']);
  if (candidate.pr === '27902') return observation(candidate.changedFiles, ['test/shared.test.ts', 'test/b-only.test.ts'], unrunImporterTotal);
  return observation(candidate.changedFiles, ['test/other.test.ts']);
});

describe('train scenario layers', () => {
  test('train C #27901 interaction shares a group; spawn and verified pair are risk, canary is stable', () => {
    const evidence: TrainRiskEvidence = {
      verifiedHotFiles: [{ path: 'src/changed-a.ts', evidence: 'reproduced broad fanout case 42' }],
      verifiedInterferencePairs: [{ a: 'test/shared.test.ts', b: 'test/pair.test.ts', evidence: 'pair rerun 2/2' }],
      suspectedPairs: [],
    };
    const decision = buildTrainScenarioDecision(input, reach(), population, evidence);
    const group = decision.groups.find((item) => item.prs.includes('27901'))!;
    expect(group.prs).toEqual(['27901', '27902']);
    expect(group.interactionTests).toEqual(['test/shared.test.ts']);
    expect(group.riskTests).toContain('src/git-fs/spawn-discipline.test.ts');
    expect(group.riskTests).toContain('test/pair.test.ts');
    expect(group.groupRiskReasons).toEqual([{ reason: 'hot-file:src/changed-a.ts', evidence: 'reproduced broad fanout case 42' }]);
    expect(group.riskReasons.some((item) => item.test === 'test/b-only.test.ts')).toBe(false);
    expect(group.scenarioTests).toContain('test/pair.test.ts');
    expect(group.canaryTarget).toBe(1);
    expect(group.canaryTests).toHaveLength(1);
    expect(buildTrainScenarioDecision(input, reach(), [...population].reverse(), evidence).groups[0].canaryTests)
      .toEqual(decision.groups[0].canaryTests);
  });

  test('train G importer 144 unrun remains fail closed through scenario composition', () => {
    const decision = buildTrainScenarioDecision(input, reach(144), population, emptyEvidence());
    expect(decision.parallelSafe).toBe(false);
    expect(reach(144).deferred).toEqual([{ pr: '27902', reason: 'test selection has unmeasured reach' }]);
  });

  test('suspected pair and verified pair across separate reach groups prohibit parallel apply', () => {
    const suspected = emptyEvidence();
    suspected.suspectedPairs.push({ a: 'test/shared.test.ts', b: 'test/pair.test.ts', reason: 'co-run only, cause not reproduced' });
    const first = buildTrainScenarioDecision(input, reach(), population, suspected);
    expect(first.parallelSafe).toBe(false);
    expect(first.unmeasured).toContain('suspected interference test/shared.test.ts ↔ test/pair.test.ts: co-run only, cause not reproduced');
    const verified = emptyEvidence();
    verified.verifiedInterferencePairs.push({ a: 'test/shared.test.ts', b: 'test/other.test.ts', evidence: '2-file repro' });
    const second = buildTrainScenarioDecision(input, reach(), population, verified);
    expect(second.parallelSafe).toBe(false);
    expect(second.unmeasured[0]).toContain('crosses groups');
  });

  test('verified pair selected as another group canary also blocks parallel apply', () => {
    const two: TrainReachInput = { ...input, prs: [input.prs[0], input.prs[2]] };
    const measured = buildTrainReachDecision(two, (candidate) => observation(candidate.changedFiles,
      candidate.pr === '27901' ? ['test/shared.test.ts'] : ['test/other.test.ts']));
    const evidence = emptyEvidence();
    evidence.verifiedInterferencePairs.push({ a: 'test/shared.test.ts', b: 'test/pair.test.ts', evidence: '2-file repro' });
    const decision = buildTrainScenarioDecision(two, measured,
      ['test/shared.test.ts', 'test/pair.test.ts', 'test/other.test.ts'], evidence);
    expect(decision.groups).toHaveLength(2);
    expect(decision.groups[1].canaryTests).toHaveLength(1);
    expect(['test/shared.test.ts', 'test/pair.test.ts']).toContain(decision.groups[1].canaryTests[0]);
    expect(decision.parallelSafe).toBe(false);
    expect(decision.unmeasured[0]).toContain('crosses groups');
  });

  test('new pair endpoints absent from the other PR head are not inserted as runnable tests', () => {
    const two: TrainReachInput = { ...input, prs: [input.prs[0], input.prs[2]] };
    const measured = buildTrainReachDecision(two, (candidate) => observation(candidate.changedFiles,
      candidate.pr === '27901' ? ['test/new-a.test.ts'] : ['test/new-b.test.ts']));
    const evidence = emptyEvidence();
    evidence.verifiedInterferencePairs.push({ a: 'test/new-a.test.ts', b: 'test/new-b.test.ts', evidence: 'pair repro' });
    const decision = buildTrainScenarioDecision(two, measured, ['test/common.test.ts'], evidence);
    expect(decision.parallelSafe).toBe(false);
    expect(decision.groups[0].riskTests).toEqual(['test/new-a.test.ts']);
    expect(decision.groups[1].riskTests).toEqual(['test/new-b.test.ts']);
    expect(decision.unmeasured).toContain('verified interference endpoint unavailable in every PR head: test/new-b.test.ts');
  });

  test('two groups canarying only the same pair endpoint do not claim a cross-pair interaction', () => {
    const evidence = emptyEvidence();
    evidence.verifiedInterferencePairs.push({ a: 'test/a.test.ts', b: 'test/b.test.ts', evidence: 'pair repro' });
    let selected: ReturnType<typeof buildTrainScenarioDecision> | undefined;
    for (let seed = 0; seed < 256 && !selected; seed++) {
      const two: TrainReachInput = { ...input, queueSig: seed.toString(16).padStart(64, '0'),
        prs: [input.prs[0], input.prs[2]] };
      const measured = buildTrainReachDecision(two, (candidate) => observation(candidate.changedFiles,
        candidate.pr === '27901' ? ['test/c.test.ts'] : ['test/d.test.ts']));
      const decision = buildTrainScenarioDecision(two, measured,
        ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/d.test.ts'], evidence);
      if (decision.groups.every((group) => group.canaryTests[0] === 'test/a.test.ts')) selected = decision;
    }
    expect(selected).toBeDefined();
    expect(selected!.parallelSafe).toBe(true);
    expect(selected!.unmeasured).toEqual([]);
  });

  test('canary samples two percent of tests left after reach and risk exclusion', () => {
    const allTests = Array.from({ length: 1000 }, (_, index) => `test/case-${String(index).padStart(4, '0')}.test.ts`);
    const one: TrainReachInput = { ...input, prs: [input.prs[0]] };
    const measured = buildTrainReachDecision(one, (candidate) =>
      observation(candidate.changedFiles, allTests.slice(0, 900)));
    const scenario = buildTrainScenarioDecision(one, measured, allTests, emptyEvidence()).groups[0];
    expect(scenario.populationSize).toBe(1000);
    expect(scenario.eligiblePopulationSize).toBe(100);
    expect(scenario.canaryTarget).toBe(2);
    expect(scenario.canaryTests).toHaveLength(2);
    expect(scenario.canaryHashMethod).toBe('sha256(canarySelectionKey\\0path)');
    const selected = allTests.slice(900).sort((a, b) =>
      createHash('sha256').update(`${scenario.canarySelectionKey}\0${a}`).digest('hex')
        .localeCompare(createHash('sha256').update(`${scenario.canarySelectionKey}\0${b}`).digest('hex')) || a.localeCompare(b));
    expect(scenario.canaryTests).toEqual(selected.slice(0, 2).sort());
  });

  test('verified claims require evidence and tracked test endpoints', () => {
    const bad = emptyEvidence();
    bad.verifiedInterferencePairs.push({ a: 'test/shared.test.ts', b: 'test/missing.test.ts', evidence: 'x' });
    expect(() => buildTrainScenarioDecision(input, reach(), population, bad)).toThrow('interference-pair evidence unmeasured');
    bad.verifiedInterferencePairs[0].b = 'test/pair.test.ts';
    bad.verifiedInterferencePairs[0].evidence = '';
    expect(() => buildTrainScenarioDecision(input, reach(), population, bad)).toThrow('interference-pair evidence unmeasured');
  });

  test('base inventory uses NUL paths, retaining test files with spaces', () => {
    const tree = mkdtempSync(join(tmpdir(), 'elanous-train-pop-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: tree, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      git('init', '--quiet');
      git('config', 'user.name', 'Train Test');
      git('config', 'user.email', 'train@example.test');
      mkdirSync(join(tree, 'test'));
      writeFileSync(join(tree, 'test', 'with space.test.ts'), 'test("x", () => {});\n');
      writeFileSync(join(tree, 'test', 'plain.spec.ts'), 'test("x", () => {});\n');
      writeFileSync(join(tree, 'test', 'not-test.ts'), 'export {};\n');
      git('add', '.'); git('commit', '--quiet', '-m', 'base');
      expect(readTrainTestPopulation(tree, git('rev-parse', 'HEAD')))
        .toEqual(['test/plain.spec.ts', 'test/with space.test.ts']);
    } finally { rmSync(tree, { recursive: true, force: true }); }
  });

  test('CLI attaches a scenario and fails closed when a PR deletes a test', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-train-scenario-cli-'));
    const tree = join(root, 'repo');
    mkdirSync(tree);
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: tree, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      git('init', '--quiet');
      git('config', 'user.name', 'Train Test');
      git('config', 'user.email', 'train@example.test');
      mkdirSync(join(tree, 'test')); mkdirSync(join(tree, 'scripts'));
      writeFileSync(join(tree, 'scripts', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(tree, 'test', 'reached.test.ts'), "import '../scripts/a.js';\n");
      writeFileSync(join(tree, 'test', 'deleted.test.ts'), 'test("gone", () => {});\n');
      writeFileSync(join(tree, 'test', 'kept.test.ts'), 'test("kept", () => {});\n');
      git('add', '.'); git('commit', '--quiet', '-m', 'base');
      const baseSha = git('rev-parse', 'HEAD');
      writeFileSync(join(tree, 'scripts', 'a.ts'), 'export const a = 2;\n');
      git('add', '.'); git('commit', '--quiet', '-m', 'head');
      const one: TrainReachInput & { riskEvidence: TrainRiskEvidence } = {
        version: 1, baseSha, queueSig: 'f'.repeat(64),
        prs: [{ pr: '101', headSha: git('rev-parse', 'HEAD'), tree,
          changedFiles: ['scripts/a.ts'] }],
        riskEvidence: emptyEvidence(),
      };
      const inputPath = join(root, 'input.json');
      const outputPath = join(root, 'output.json');
      writeFileSync(inputPath, JSON.stringify(one));
      const script = resolve(import.meta.dir, '../../scripts/train-reach-grouping.ts');
      const result = spawnSync('bun', [script, '--input', inputPath, '--output', outputPath], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`CLI rc=${result.status}: ${result.stderr}; ${result.stdout}; ${readFileSync(outputPath, 'utf8')}`);
      expect(result.status).toBe(0);
      const output = JSON.parse(readFileSync(outputPath, 'utf8'));
      expect(output.scenario.parallelSafe).toBe(true);
      expect(output.scenario.groups[0].populationSize).toBe(3);
      expect(output.scenario.groups[0].canaryTests).toHaveLength(1);
      expect(output.scenario.groups[0].scenarioTests).toContain('test/reached.test.ts');
      const deletedTree = join(root, 'deleted');
      git('worktree', 'add', '--quiet', '-b', 'deleted', deletedTree, baseSha);
      const deletedGit = (...args: string[]) => {
        const result = spawnSync('git', args, { cwd: deletedTree, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(result.stderr);
        return result.stdout.trim();
      };
      deletedGit('rm', '--quiet', 'test/deleted.test.ts');
      deletedGit('commit', '--quiet', '-m', 'delete test');
      one.prs.push({ pr: '102', headSha: deletedGit('rev-parse', 'HEAD'), tree: deletedTree,
        changedFiles: ['test/deleted.test.ts'] });
      writeFileSync(inputPath, JSON.stringify(one));
      const deleted = spawnSync('bun', [script, '--input', inputPath, '--output', outputPath], { encoding: 'utf8' });
      expect(deleted.status).toBe(2);
      const partial = JSON.parse(readFileSync(outputPath, 'utf8'));
      expect(partial.parallelSafe).toBe(false);
      expect(partial.deferred.map((item: { pr: string }) => item.pr)).toEqual(['102']);
      expect(partial.scenario.groups[0].canaryTests).toEqual(['test/kept.test.ts']);
      expect(partial.scenario.groups[0].canaryTests).not.toContain('test/deleted.test.ts');
      expect(readTrainTestPopulation(deletedTree, one.prs[1].headSha)).not.toContain('test/deleted.test.ts');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
