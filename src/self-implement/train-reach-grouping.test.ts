import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildTrainReachDecision, type TrainReachInput, type TrainReachObservation } from './train-reach-grouping.js';

const input: TrainReachInput = {
  version: 1,
  baseSha: 'a'.repeat(40),
  queueSig: 'b'.repeat(64),
  prs: [
    { pr: '101', headSha: '1'.repeat(40), tree: '/work/101', changedFiles: ['src/a.ts'] },
    { pr: '102', headSha: '2'.repeat(40), tree: '/work/102', changedFiles: ['src/b.ts'] },
    { pr: '103', headSha: '3'.repeat(40), tree: '/work/103', changedFiles: ['src/c.ts'] },
  ],
};

function observation(changedFiles: string[], testFiles: string[]): TrainReachObservation {
  return { changedFiles, testFiles, unverified: [], unrunImporterTotal: 0,
    routeLookupFailures: [], callerTestsOverflow: [], alwaysIncludeMissing: [] };
}

describe('train reach grouping', () => {
  test('two PRs reaching one test form an interaction group; a disjoint PR can run separately', () => {
    const byPr: Record<string, TrainReachObservation> = {
      '101': observation(['src/a.ts'], ['test/shared.test.ts', 'test/a.test.ts']),
      '102': observation(['src/b.ts'], ['test/shared.test.ts', 'test/b.test.ts']),
      '103': observation(['src/c.ts'], ['test/c.test.ts']),
    };
    const result = buildTrainReachDecision(input, (candidate) => byPr[candidate.pr]);
    expect(result.parallelSafe).toBe(true);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].prs).toEqual(['101', '102']);
    expect(result.groups[0].interactionTests).toEqual(['test/shared.test.ts']);
    expect(result.groups[0].overlapEdges).toEqual([{
      a: '101', b: '102', tests: ['test/shared.test.ts'], paths: [],
    }]);
    expect(result.groups[1].prs).toEqual(['103']);
    expect(result.groups[1].interactionTests).toEqual([]);
  });

  test('changed-file mismatch or importer lookup failure blocks every parallel train', () => {
    const result = buildTrainReachDecision(input, (candidate) => {
      if (candidate.pr === '101') return observation(['src/other.ts'], ['test/a.test.ts']);
      if (candidate.pr === '102') return { ...observation(['src/b.ts'], []), lookupFailed: 'git grep failed', unrunImporterTotal: null };
      return observation(['src/c.ts'], ['test/c.test.ts']);
    });
    expect(result.parallelSafe).toBe(false);
    expect(result.deferred).toEqual([
      { pr: '101', reason: 'changedFiles differ from selector observation' },
      { pr: '102', reason: 'test selection has unmeasured reach' },
    ]);
    expect(result.groups.map((group) => group.prs)).toEqual([['103']]);
  });

  test('same changed path connects PRs even when their test lists differ', () => {
    const sameFile = structuredClone(input);
    sameFile.prs[1].changedFiles = ['src/a.ts'];
    const result = buildTrainReachDecision(sameFile, (candidate) =>
      observation(candidate.changedFiles, [`test/${candidate.pr}.test.ts`]));
    expect(result.groups[0].prs).toEqual(['101', '102']);
    expect(result.groups[0].overlapEdges[0].paths).toEqual(['src/a.ts']);
    expect(result.groups[0].interactionTests).toEqual([]);
  });

  test('rejects embedded NUL paths instead of equating one element with two', () => {
    const malformed = structuredClone(input);
    malformed.prs[0].changedFiles = ['src/a.ts\0src/b.ts'];
    expect(() => buildTrainReachDecision(malformed, () => observation(['src/a.ts', 'src/b.ts'], [])))
      .toThrow('train reach candidate invalid');
  });

  test('a measured six-PR component is capacity blocked without calling it unmeasured', () => {
    const six: TrainReachInput = { ...input, prs: Array.from({ length: 6 }, (_, index) => ({
      pr: String(101 + index), headSha: String(index + 1).repeat(40), tree: `/work/${101 + index}`,
      changedFiles: [`src/${index}.ts`],
    })) };
    const result = buildTrainReachDecision(six, (candidate) => observation(candidate.changedFiles, ['test/shared.test.ts']));
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].status).toBe('measured');
    expect(result.groups[0].capacityBlocked).toBe(true);
    expect(result.parallelSafe).toBe(false);
  });

  test('two real PR worktrees importing one shared test produce an interaction scenario', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-train-pair-'));
    const repo = join(root, 'repo');
    const left = join(root, 'left');
    const right = join(root, 'right');
    mkdirSync(repo);
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      git(repo, 'init', '--quiet');
      git(repo, 'config', 'user.name', 'Train Test');
      git(repo, 'config', 'user.email', 'train@example.test');
      mkdirSync(join(repo, 'scripts'));
      mkdirSync(join(repo, 'test'));
      writeFileSync(join(repo, 'scripts', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(repo, 'scripts', 'b.ts'), 'export const b = 1;\n');
      writeFileSync(join(repo, 'test', 'shared.test.ts'), "import '../scripts/a.js';\nimport '../scripts/b.js';\n");
      git(repo, 'add', '.');
      git(repo, 'commit', '--quiet', '-m', 'base');
      const baseSha = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'worktree', 'add', '--quiet', '-b', 'left', left);
      git(repo, 'worktree', 'add', '--quiet', '-b', 'right', right);
      writeFileSync(join(left, 'scripts', 'a.ts'), 'export const a = 2;\n');
      git(left, 'add', '.');
      git(left, 'commit', '--quiet', '-m', 'left');
      writeFileSync(join(right, 'scripts', 'b.ts'), 'export const b = 2;\n');
      git(right, 'add', '.');
      git(right, 'commit', '--quiet', '-m', 'right');
      const result = buildTrainReachDecision({ version: 1, baseSha, queueSig: 'd'.repeat(64), prs: [
        { pr: '101', headSha: git(left, 'rev-parse', 'HEAD'), tree: left, changedFiles: ['scripts/a.ts'] },
        { pr: '102', headSha: git(right, 'rev-parse', 'HEAD'), tree: right, changedFiles: ['scripts/b.ts'] },
      ] });
      expect(result.parallelSafe).toBe(true);
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].interactionTests).toEqual(['test/shared.test.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);

  test('CLI measures an actual PR tree and replaces a stale decision with fail-closed output', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-train-reach-'));
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
      mkdirSync(join(tree, 'scripts'));
      mkdirSync(join(tree, 'test'));
      writeFileSync(join(tree, 'scripts', 'sample.ts'), 'export const sample = 1;\n');
      writeFileSync(join(tree, 'test', 'sample.test.ts'), "import '../scripts/sample.js';\n");
      git('add', '.');
      git('commit', '--quiet', '-m', 'base');
      const baseSha = git('rev-parse', 'HEAD');
      writeFileSync(join(tree, 'scripts', 'sample.ts'), 'export const sample = 2;\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'head');
      const one: TrainReachInput = { version: 1, baseSha, queueSig: 'c'.repeat(64), prs: [
        { pr: '101', headSha: git('rev-parse', 'HEAD'), tree, changedFiles: ['scripts/sample.ts'] },
      ] };
      const inputPath = join(root, 'input.json');
      const outputPath = join(root, 'decision.json');
      const script = resolve(import.meta.dir, '../../scripts/train-reach-grouping.ts');
      writeFileSync(inputPath, JSON.stringify(one));
      const measured = spawnSync('bun', [script, '--input', inputPath, '--output', outputPath], { encoding: 'utf8' });
      expect(measured.status).toBe(0);
      const decision = JSON.parse(readFileSync(outputPath, 'utf8'));
      expect(decision.parallelSafe).toBe(true);
      expect(decision.groups[0].reachTests).toEqual(['test/sample.test.ts']);

      writeFileSync(join(tree, 'scripts', 'sample.ts'), 'export const sample = 3;\n');
      const dirty = buildTrainReachDecision(one);
      expect(dirty.parallelSafe).toBe(false);
      expect(dirty.deferred[0].reason).toBe('tree is dirty');
      git('restore', 'scripts/sample.ts');
      one.prs[0].headSha = 'e'.repeat(40);
      const stale = buildTrainReachDecision(one);
      expect(stale.parallelSafe).toBe(false);
      expect(stale.deferred[0].reason).toBe('tree HEAD differs from queued headSha');
      one.prs[0].headSha = git('rev-parse', 'HEAD');

      one.prs[0].changedFiles = ['scripts/other.ts'];
      writeFileSync(inputPath, JSON.stringify(one));
      const mismatched = spawnSync('bun', [script, '--input', inputPath, '--output', outputPath], { encoding: 'utf8' });
      expect(mismatched.status).toBe(2);
      const failed = JSON.parse(readFileSync(outputPath, 'utf8'));
      expect(failed.parallelSafe).toBe(false);
      expect(failed.deferred[0].reason).toContain('changedFiles differ');

      writeFileSync(inputPath, '{');
      const invalid = spawnSync('bun', [script, '--input', inputPath, '--output', outputPath], { encoding: 'utf8' });
      expect(invalid.status).toBe(2);
      expect(existsSync(outputPath)).toBe(false);
      const samePath = spawnSync('bun', [script, '--input', inputPath, '--output', inputPath], { encoding: 'utf8' });
      expect(samePath.status).toBe(2);
      expect(readFileSync(inputPath, 'utf8')).toBe('{');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
