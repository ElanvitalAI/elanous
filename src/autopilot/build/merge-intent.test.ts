import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectMergeIntent, collectSiblingPrIntents, defaultIntentGit, defaultSiblingPrLookup, resetSiblingPrLookupCache, SIBLING_BODY_MAX_CHARS } from './merge-intent.js';

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

describe('collectSiblingPrIntents (MERGE-INTENT-RESOLVE)', () => {
  function siblingFixture(subjects: string[], goal = false, body = ''): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'merge-sibling-')));
    roots.push(root);
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    };
    git('init', '-q'); git('checkout', '-qb', 'main');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'base\n');
    writeFileSync(join(root, 'src/other.ts'), 'base\n');
    git('add', '.'); git('commit', '-qm', 'base');
    git('checkout', '-qb', 'feature');
    writeFileSync(join(root, 'src/a.ts'), 'ours\n');
    git('commit', '-qam', 'feat: ours');
    git('checkout', '-q', 'main');
    if (goal) {
      mkdirSync(join(root, 'docs/goals'), { recursive: true });
      writeFileSync(join(root, 'docs/goals/GOAL-sibling.md'), '# Keep retry guard\nSituation: retries race\nComplication: guard missing\n');
      git('add', '.'); git('commit', '-qm', 'docs: goal');
    }
    writeFileSync(join(root, 'src/other.ts'), 'unrelated\n');
    git('commit', '-qam', 'feat: other file (#9)');
    subjects.forEach((subject, index) => {
      writeFileSync(join(root, 'src/a.ts'), `theirs ${index}\n`);
      git('commit', '-qam', subject, ...(body ? ['-m', body] : []));
    });
    git('checkout', '-q', 'feature');
    return root;
  }

  test('identifies merged sibling PRs on the conflicting path and carries PR title/body and linked goal', async () => {
    const worktreePath = siblingFixture(['fix: A (#41)', 'feat: B (#42)'], true);
    const looked: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await collectSiblingPrIntents({
      worktreePath, filePath: 'src/a.ts', mergeTarget: 'main', git: defaultIntentGit,
      lookupPr: async (_wt, number) => {
        looked.push(number);
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return { title: `PR title ${number}`, body: number === 42 ? 'Keep the retry guard.\nGoal: docs/goals/GOAL-sibling.md' : 'A body' };
      },
    });
    expect(looked).toEqual([42, 41]);
    expect(maxInFlight).toBe(2); // lookups run in parallel, not one after another
    expect(result.map((sibling) => sibling.number)).toEqual([42, 41]);
    expect(result[0]).toMatchObject({ title: 'PR title 42', source: 'gh', goalPath: 'docs/goals/GOAL-sibling.md' });
    expect(result[0]!.body).toContain('Keep the retry guard.');
    expect(result[0]!.goal).toBe('Keep retry guard\nSituation: retries race\nComplication: guard missing');
    expect(result[1]).toMatchObject({ number: 41, body: 'A body', goal: null, goalPath: null });
  });

  test('default gh lookup is async, never blocks the event loop, and caches per worktree + PR number', async () => {
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'merge-sibling-gh-')));
    roots.push(bin);
    const calls = join(bin, 'calls.log');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$PWD $3" >> "${calls}"\nsleep 0.3\necho '{"title":"T '"$3"'","body":"B"}'\n`, { mode: 0o755 });
    const repoA = realpathSync(mkdtempSync(join(tmpdir(), 'merge-sibling-a-')));
    const repoB = realpathSync(mkdtempSync(join(tmpdir(), 'merge-sibling-b-')));
    roots.push(repoA, repoB);
    const originalPath = process.env.PATH;
    resetSiblingPrLookupCache();
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    try {
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 10);
      const first = defaultSiblingPrLookup(repoA, 7);
      expect(first).toBeInstanceOf(Promise);
      const results = await Promise.all([first, defaultSiblingPrLookup(repoA, 7), defaultSiblingPrLookup(repoB, 7)]);
      clearInterval(timer);
      expect(ticks).toBeGreaterThan(5); // the event loop kept turning while gh (sleep 0.3) ran
      expect(results).toEqual([{ title: 'T 7', body: 'B' }, { title: 'T 7', body: 'B' }, { title: 'T 7', body: 'B' }]);
      expect(readFileSync(calls, 'utf8').trim().split('\n').sort()).toEqual([`${repoA} 7`, `${repoB} 7`].sort());
    } finally {
      process.env.PATH = originalPath;
      resetSiblingPrLookupCache();
    }
  });

  test('many direct commits on the path after a sibling PR do not hide it (no commit cap)', async () => {
    const direct = Array.from({ length: 25 }, (_, i) => `chore: direct ${i}`);
    const worktreePath = siblingFixture(['feat: B (#42)', ...direct]);
    const result = await collectSiblingPrIntents({ worktreePath, filePath: 'src/a.ts', mergeTarget: 'main', git: defaultIntentGit, lookupPr: async () => null });
    expect(result.map((sibling) => sibling.number)).toEqual([42]);
  });

  test('PR lookup failure (null or rejection) falls back to the squash commit message; body is clipped', async () => {
    const worktreePath = siblingFixture(['feat: B (#42)'], false, 'x'.repeat(SIBLING_BODY_MAX_CHARS + 50));
    const [sibling] = await collectSiblingPrIntents({ worktreePath, filePath: 'src/a.ts', mergeTarget: 'main', git: defaultIntentGit, lookupPr: async () => { throw new Error('gh down'); } });
    expect(sibling).toMatchObject({ number: 42, title: 'feat: B (#42)', source: 'commit' });
    expect(sibling!.body!.length).toBe(SIBLING_BODY_MAX_CHARS + 1);
  });

  test('no PR-suffixed commit on the path (or git failure) → no siblings, lookup never called', async () => {
    const worktreePath = siblingFixture(['chore: direct push']);
    let lookups = 0;
    const lookupPr = async () => { lookups++; return { title: 't', body: 'b' }; };
    expect(await collectSiblingPrIntents({ worktreePath, filePath: 'src/a.ts', mergeTarget: 'main', git: defaultIntentGit, lookupPr })).toEqual([]);
    expect(await collectSiblingPrIntents({ worktreePath, filePath: 'src/a.ts', mergeTarget: 'main', git: () => { throw new Error('x'); }, lookupPr })).toEqual([]);
    expect(lookups).toBe(0);
  });
});
