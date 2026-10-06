import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { censusGoals, gitListUntracked, gitLogAdditions } from './goal-census.js';

const roots: string[] = [];

function git(root: string, args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
}

/** 판정 신호의 임시 저장소: ① squash 착지 ② PR 번호 없는 추가 ③ 미추적. */
function fixtureRepo(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'goal-census-'));
  roots.push(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'census@example.com']);
  git(root, ['config', 'user.name', 'census']);
  mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
  git(root, ['commit', '--allow-empty', '-m', 'chore: seed']);

  writeFileSync(join(root, 'docs', 'goals', 'GOAL-landed.md'), 'landed\n');
  git(root, ['add', 'docs/goals/GOAL-landed.md']);
  git(root, ['commit', '-m', 'feat: x (#12)']);

  writeFileSync(join(root, 'docs', 'goals', 'ASK-tracked.md'), 'tracked\n');
  git(root, ['add', 'docs/goals/ASK-tracked.md']);
  git(root, ['commit', '-m', 'docs: add ask (#9) without pr']);

  writeFileSync(join(root, 'docs', 'goals', 'GOAL-draft.md'), 'draft\n');
  return { root };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('censusGoals', () => {
  test('classifies landed, tracked-no-pr, and untracked without calling gh', () => {
    const { root } = fixtureRepo();
    const run = () => censusGoals({
      repoRoot: root,
      gitLog: (r) => gitLogAdditions(r),
      listUntracked: (r) => gitListUntracked(r),
    });

    const first = run();
    const byPath = new Map(first.entries.map((e) => [e.path, e]));
    const landed = byPath.get('docs/goals/GOAL-landed.md');
    const tracked = byPath.get('docs/goals/ASK-tracked.md');
    const draft = byPath.get('docs/goals/GOAL-draft.md');
    expect(landed?.classification).toBe('landed');
    expect(landed?.prNumber).toBe(12);
    expect(landed?.kind).toBe('GOAL');
    expect(tracked?.classification).toBe('tracked-no-pr');
    expect(tracked?.prNumber).toBeUndefined();
    expect(tracked?.kind).toBe('ASK');
    expect(draft?.classification).toBe('untracked');
    expect(draft?.kind).toBe('GOAL');
    expect(first.summary.total).toBe(3);
    expect(first.summary.byClass.landed).toBe(1);
    expect(first.summary.byClass['tracked-no-pr']).toBe(1);
    expect(first.summary.byClass.untracked).toBe(1);

    const savedPath = process.env.PATH ?? '';
    const ghBin = spawnSync('bash', ['-lc', 'command -v gh || true'], { encoding: 'utf8' }).stdout.trim();
    const ghDir = ghBin.includes('/') ? ghBin.slice(0, ghBin.lastIndexOf('/')) : '';
    const stripped = savedPath.split(':').filter((p) => p && p !== ghDir).join(':');
    const prev = process.env.PATH;
    process.env.PATH = stripped;
    try {
      const probe = spawnSync('gh', ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: stripped } });
      expect(probe.status === 0).toBe(false);
      const second = censusGoals({
        repoRoot: root,
        gitLog: (r) => gitLogAdditions(r),
        listUntracked: (r) => gitListUntracked(r),
      });
      expect(second.summary.total).toBe(first.summary.total);
      expect(second.entries.map((e) => [e.path, e.classification, e.prNumber])).toEqual(
        first.entries.map((e) => [e.path, e.classification, e.prNumber]),
      );
    } finally {
      process.env.PATH = prev;
    }
  });

  test('real repo total matches ls docs/goals file count when docs/goals exists', () => {
    const repoRoot = join(import.meta.dir, '../..');
    const ls = spawnSync('bash', ['-lc', 'ls -1 docs/goals | wc -l'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (ls.status !== 0) return;
    const listed = Number(ls.stdout.trim());
    if (!Number.isFinite(listed)) return;
    const census = censusGoals({
      repoRoot,
      gitLog: (r) => gitLogAdditions(r),
      listUntracked: (r) => gitListUntracked(r),
    });
    expect(census.summary.total).toBe(listed);
  });
});
