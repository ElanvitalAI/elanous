import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectMergeIntent, defaultIntentGit } from './merge-intent.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(withGoal: boolean, multipleGoals = false, deleteFirstGoal = false): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'merge-intent-')));
  roots.push(root);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };
  git('init', '-q');
  git('checkout', '-qb', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.ts'), 'base\n');
  git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  if (withGoal) {
    mkdirSync(join(root, 'docs/goals'), { recursive: true });
    writeFileSync(join(root, 'docs/goals/goal.txt'), '# Preserve both behaviors\nSituation: original branch\nComplication: main changed\n');
    git('add', '.'); git('commit', '-qm', 'add goal');
    if (multipleGoals) {
      writeFileSync(join(root, 'docs/goals/aaa-goal.txt'), '# Later alphabetical goal\nSituation: unrelated\n');
      git('add', '.'); git('commit', '-qm', 'add later goal');
      if (deleteFirstGoal) {
        git('rm', 'docs/goals/goal.txt');
        git('commit', '-qm', 'remove first goal');
      }
    }
  } else {
    writeFileSync(join(root, 'feature.txt'), 'branch\n');
    git('add', '.'); git('commit', '-qm', 'feat: branch intent');
  }
  git('checkout', '-q', 'main');
  writeFileSync(join(root, 'src/a.ts'), 'first\n');
  git('commit', '-qam', 'fix: A (#1)');
  writeFileSync(join(root, 'src/a.ts'), 'second\n');
  git('commit', '-qam', 'feat: B (#2)');
  git('checkout', '-q', 'feature');
  return root;
}

describe('collectMergeIntent', () => {
  test('branch-added goal title and both main commits on the conflicting path', () => {
    const worktreePath = fixture(true);
    const result = collectMergeIntent({ worktreePath, filePath: 'src/a.ts', mergeTarget: 'main', git: defaultIntentGit });
    expect(result.theirs).toEqual(['feat: B (#2)', 'fix: A (#1)']);
    expect(result.ours).toContain('Preserve both behaviors');
    expect(result.ours).toContain('Situation: original branch');
    expect(result.ours).toContain('Complication: main changed');
  });

  test('chooses the first-added goal, not the alphabetically first path', () => {
    const worktreePath = fixture(true, true);
    const result = collectMergeIntent({ worktreePath, filePath: 'src/a.ts', mergeTarget: 'main', git: defaultIntentGit });
    expect(result.ours).toContain('Preserve both behaviors');
    expect(result.ours).not.toContain('Later alphabetical goal');
    expect(result.theirs).toEqual(['feat: B (#2)', 'fix: A (#1)']);
  });

  test('skips a deleted first-added goal and uses the next existing goal', () => {
    const worktreePath = fixture(true, true, true);
    const result = collectMergeIntent({ worktreePath, filePath: 'src/a.ts', mergeTarget: 'main', git: defaultIntentGit });
    expect(result.ours).toContain('Later alphabetical goal');
    expect(result.ours).toContain('Situation: unrelated');
    expect(result.ours).not.toContain('remove first goal');
    expect(result.theirs).toEqual(['feat: B (#2)', 'fix: A (#1)']);
  });

  test('without a goal uses branch commit subjects; git failures do not block resolution', () => {
    const worktreePath = fixture(false);
    expect(collectMergeIntent({ worktreePath, filePath: 'src/a.ts', mergeTarget: 'main', git: defaultIntentGit })).toEqual({
      ours: 'feat: branch intent', theirs: ['feat: B (#2)', 'fix: A (#1)'],
    });
    expect(collectMergeIntent({ worktreePath, filePath: 'src/a.ts', mergeTarget: 'main', git: () => { throw new Error('unavailable'); } })).toEqual({ ours: null, theirs: [] });
  });
});
