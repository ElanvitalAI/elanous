import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildConflictRepairGoal, checkTheirsLinesKept, classifyConflictHunks,
  collectConflictAnalysis, mergeAppendOnly, parseMergeTreeConflictPaths, planConflictRepair,
} from './pr-land-conflict-merge.js';

test('CONDUCTOR-style table additions merge main first and deduplicate identical lines', () => {
  const base = '| area | owner |\n|---|---|\n| docs | team |';
  const ours = `${base}\n| land | OP |`;
  const theirs = `${base}\n| drift | TC |`;
  expect(classifyConflictHunks(base, ours, theirs, 'docs/conductor/CONDUCTOR.md').verdict).toBe('append-only');
  expect(mergeAppendOnly(base, ours, theirs, 'docs/conductor/CONDUCTOR.md')).toEqual({
    verdict: 'append-only', content: `${base}\n| drift | TC |\n| land | OP |`,
  });
  expect(mergeAppendOnly(base, ours, `${base}\n| land | OP |`, 'docs/conductor/CONDUCTOR.md')).toEqual({
    verdict: 'append-only', content: `${base}\n| land | OP |`,
  });
  expect(mergeAppendOnly('before\nafter', 'before\nours\nafter', 'before\ntheirs\nafter', 'notes.md')).toEqual({
    verdict: 'append-only', content: 'before\ntheirs\nours\nafter',
  });
  expect(mergeAppendOnly('base', 'base\nrepeat\nrepeat', 'base\nmain\nrepeat', 'notes.md')).toEqual({
    verdict: 'append-only', content: 'base\nmain\nrepeat\nrepeat',
  });
  expect(mergeAppendOnly('base', 'base\nrepeat\nrepeat', 'base\nmain', 'notes.md')).toEqual({
    verdict: 'append-only', content: 'base\nmain\nrepeat\nrepeat',
  });
  expect(mergeAppendOnly('base', 'base\nfirst\nsecond', 'base\nsecond\nfirst', 'notes.md')).toEqual({ verdict: 'needs-repair' });
});

test('changed or removed base lines and unsupported extensions need repair', () => {
  expect(classifyConflictHunks('one\ntwo', 'changed\ntwo', 'one\ntwo\nadded', 'notes.md').verdict).toBe('needs-repair');
  expect(classifyConflictHunks('one', 'one\na', 'one\nb', 'src/code.ts').verdict).toBe('needs-repair');
  expect(classifyConflictHunks(null, 'one', 'one', 'notes.md').verdict).toBe('unmeasured');
});

test('table column mismatch is rejected', () => {
  const base = '|a|b|\n|---|---|';
  expect(mergeAppendOnly(base, `${base}\n|x|y|`, `${base}\n|z|`, 'table.md')).toEqual({ verdict: 'needs-repair' });
});

test('main lines must remain in repair output', () => {
  expect(checkTheirsLinesKept(['main line', 'same'], 'main line\nother\nsame')).toBe(true);
  expect(checkTheirsLinesKept(['main line'], 'other')).toBe(false);
  expect(checkTheirsLinesKept(['same', 'same'], 'same')).toBe(false);
});

test('repair goal contains actual hunks, diffs, titles and only conflict paths', () => {
  const goal = buildConflictRepairGoal({
    files: ['a.md'], oursDiff: '+ours', theirsDiff: '+theirs', oursTitle: 'PR intent', theirsTitle: 'main intent',
    oursBody: 'PR body intent', theirsBody: 'main commit body intent',
    hunks: ['BASE\nbase text\nOURS\nours text\nTHEIRS\ntheirs text'],
  });
  expect(goal.startsWith('대상 경로: a.md\n경계: a.md')).toBe(true);
  expect(goal).toContain('base text');
  expect(goal).toContain('+ours');
  expect(goal).toContain('PR intent');
  expect(goal).toContain('PR body intent');
  expect(goal).toContain('main commit body intent');
  expect(goal).not.toContain('[object Object]');
  const plan = planConflictRepair({ analyses: [{ path: 'a.md', base: 'base', ours: 'base\nours', theirs: 'base\ntheirs' }] });
  expect(plan.decision).toBe('automerge');
  expect(plan.mergedFiles).toEqual({ 'a.md': 'base\ntheirs\nours' });
  const repair = planConflictRepair({ analyses: [{ path: 'a.md', base: 'base', ours: 'ours', theirs: 'theirs' }] });
  expect(repair.goal).toContain('FILE a.md');
  expect(repair.goal).toContain('theirs');
});

test('merge-tree structured conflict paths expose mixed files independent of message wording', () => {
  const tree = 'a'.repeat(40);
  const parsed = parseMergeTreeConflictPaths(`${tree}\0docs/append.md\0src/changed.ts\0\0informational text without CONFLICT tokens`, 1);
  expect(parsed).toEqual({ measured: true, paths: ['docs/append.md', 'src/changed.ts'] });
  const structured = parseMergeTreeConflictPaths(`${tree}\0${'100644 ' + 'b'.repeat(40) + ' 1\tdocs/append.md'}\0${'100644 ' + 'c'.repeat(40) + ' 2\tdocs/append.md'}\0${'100644 ' + 'd'.repeat(40) + ' 3\tdocs/append.md'}\0\0CONFLICT output`, 1);
  expect(structured).toEqual({ measured: true, paths: ['docs/append.md'] });
  expect(parseMergeTreeConflictPaths(`${tree}\\0docs/append.md\\0`, 1).measured).toBe(false);
  if (!parsed.measured) throw new Error('fixture paths not measured');
  const analysis = collectConflictAnalysis(parsed.paths, [
    { path: 'docs/append.md', base: 'base', ours: 'base\\nours', theirs: 'base\\ntheirs' },
    { path: 'src/changed.ts', base: 'x', ours: 'y', theirs: 'z' },
  ]);
  expect(analysis.verdict).toBe('needs-repair');
  expect(parseMergeTreeConflictPaths(`${tree}\\0docs/append.md\\0`, 1).measured).toBe(false);
  expect(parseMergeTreeConflictPaths('informational CONFLICT text only', 1).measured).toBe(false);
});

test('parser measures the real NUL-delimited output from git merge-tree -z', () => {
  const repo = mkdtempSync(join(tmpdir(), 'conflict-merge-tree-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  };
  try {
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Conflict fixture']);
    git(['config', 'user.email', 'conflict-fixture@example.invalid']);
    writeFileSync(join(repo, 'mixed.md'), 'base\\n');
    git(['add', 'mixed.md']);
    git(['commit', '-m', 'base']);
    git(['checkout', '-b', 'pr']);
    writeFileSync(join(repo, 'mixed.md'), 'pr change\\n');
    git(['commit', '-am', 'pr change']);
    git(['checkout', 'main']);
    writeFileSync(join(repo, 'mixed.md'), 'main change\\n');
    git(['commit', '-am', 'main change']);
    const result = spawnSync('git', ['merge-tree', '--write-tree', '-z', 'main', 'pr'], { cwd: repo, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('\0');
    expect(parseMergeTreeConflictPaths(result.stdout, result.status)).toEqual({ measured: true, paths: ['mixed.md'] });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('mixed conflicts with a missing path are unmeasured, never partially append-only', () => {
  const result = collectConflictAnalysis(['a.md', 'b.ts'], [
    { path: 'a.md', base: 'base', ours: 'base\nours', theirs: 'base\ntheirs' },
  ]);
  expect(result.verdict).toBe('unmeasured');
  expect(result.missingPaths).toEqual(['b.ts']);
  expect(result.analyses.map(({ verdict }) => verdict)).toEqual(['unmeasured', 'unmeasured']);
});

test('unreadable and extra snapshots fail closed', () => {
  expect(collectConflictAnalysis(['a.md'], []).verdict).toBe('unmeasured');
  expect(collectConflictAnalysis(['a.md'], [
    { path: 'a.md', base: 'base', ours: 'base\na', theirs: 'base\nb' },
    { path: 'b.md', base: 'base', ours: 'base\na', theirs: 'base\nb' },
  ]).verdict).toBe('unmeasured');
});

test('repair planning refuses a partial conflict snapshot set instead of automerging a subset', () => {
  const plan = planConflictRepair({
    files: ['a.md', 'b.md'],
    analyses: [{ path: 'a.md', base: 'base', ours: 'base\nours', theirs: 'base\ntheirs' }],
  });
  expect(plan).toEqual({ decision: 'escalate', reason: 'conflict-analysis-incomplete' });
});
