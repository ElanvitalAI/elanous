import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { censusGoals, gitListUntracked, gitLogAdditions } from './goal-census.js';

const roots: string[] = [];

const currentPath = process.env.PATH ?? '';
const ghPath = Bun.which('gh');
const gitPath = Bun.which('git');
const ghDirectory = ghPath ? ghPath.slice(0, ghPath.lastIndexOf('/')) : undefined;
const gitDirectory = gitPath ? gitPath.slice(0, gitPath.lastIndexOf('/')) : undefined;
const ghlessPath = currentPath
  .split(':')
  .filter((directory) => directory && directory !== ghDirectory)
  .join(':');
const canMeasureWithoutGh = Boolean(ghPath && gitPath && ghDirectory !== gitDirectory)
  && spawnSync('gh', ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: ghlessPath } }).status !== 0
  && spawnSync('git', ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: ghlessPath } }).status === 0;

const realRepoRoot = join(import.meta.dir, '../..');
const MAX_HISTORY_COMMITS = 50_000;
const QUICK_GIT_TIMEOUT_MS = 1_000;
const GOAL_LOG_TIMEOUT_MS = 3_000;
type ProbeResult = { status: number | null; stdout: string; stderr?: string; error?: { code?: string } };
type GitProbe = (args: string[], timeoutMs: number) => ProbeResult;
type GoalHistory = ReadonlyMap<string, { hash: string; subject: string; authoredAt: string }>;

/** Check cheap completeness signals before path-history traversal, then keep one bounded log result for the census. */
function probeGoalHistory(repoRoot: string, run: GitProbe = (args, timeoutMs) => {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: { code: (result.error as NodeJS.ErrnoException).code } } : {}) };
}): GoalHistory | null {
  const shallow = run(['rev-parse', '--is-shallow-repository'], QUICK_GIT_TIMEOUT_MS);
  if (shallow.status !== 0 || shallow.stdout.trim() !== 'false') return null;
  const partial = run(['config', '--get-regexp', '^remote\\..*\\.partialclonefilter$'], QUICK_GIT_TIMEOUT_MS);
  if (partial.status === 0 && partial.stdout.trim()) return null;
  if (partial.status !== 0 && partial.status !== 1) return null;
  const promisor = run(['config', '--get-regexp', '^remote\\..*\\.promisor$'], QUICK_GIT_TIMEOUT_MS);
  if (promisor.status === 0 && /\btrue\b/i.test(promisor.stdout)) return null;
  if (promisor.status !== 0 && promisor.status !== 1) return null;

  const count = run(['rev-list', '--count', `--max-count=${MAX_HISTORY_COMMITS + 1}`, 'HEAD'], QUICK_GIT_TIMEOUT_MS);
  const commitCount = Number(count.stdout.trim());
  if (count.status !== 0 || !Number.isSafeInteger(commitCount) || commitCount > MAX_HISTORY_COMMITS) return null;

  const history = run(['log', '--diff-filter=A', '--name-only', '--format=@@%H%x09%s%x09%aI', '--', 'docs/goals'], GOAL_LOG_TIMEOUT_MS);
  if (history.status !== 0 || history.error?.code === 'ETIMEDOUT') return null;
  const out = new Map<string, { hash: string; subject: string; authoredAt: string }>();
  let current: { hash: string; subject: string; authoredAt: string } | undefined;
  for (const line of history.stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('@@')) {
      const body = line.slice(2);
      const firstTab = body.indexOf('\t');
      const lastTab = body.lastIndexOf('\t');
      current = firstTab > 0 && lastTab > firstTab
        ? { hash: body.slice(0, firstTab), subject: body.slice(firstTab + 1, lastTab), authoredAt: body.slice(lastTab + 1) }
        : undefined;
    } else if (current) out.set(line, current);
  }
  return out;
}

const realRepoHistory = probeGoalHistory(realRepoRoot);
const hasCompleteGoalHistory = realRepoHistory !== null;

if (!canMeasureWithoutGh) {
  console.warn('UNMEASURED: gh-free census fixture cannot isolate gh while retaining git in PATH.');
}
if (!hasCompleteGoalHistory) {
  console.warn('UNMEASURED: shallow/partial history, over-limit history, or bounded goal-history lookup unavailable; skipping real-repository measurement.');
}

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
  test('history preflight skips shallow, partial, over-limit, and timed-out histories before measuring', () => {
    const calls: string[][] = [];
    const fakeRun: GitProbe = (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'true\n' };
      return { status: 0, stdout: '' };
    };
    expect(probeGoalHistory('/repo', fakeRun)).toBeNull();
    expect(calls.map((args) => args[0])).toEqual(['rev-parse']);

    calls.length = 0;
    expect(probeGoalHistory('/repo', (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'false\n' };
      if (args[0] === 'config') return { status: 0, stdout: 'remote.origin.partialclonefilter blob:none\n' };
      return { status: 0, stdout: '' };
    })).toBeNull();
    expect(calls.map((args) => args[0])).toEqual(['rev-parse', 'config']);

    calls.length = 0;
    expect(probeGoalHistory('/repo', (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'false\n' };
      if (args[0] === 'config' && args[1] === '--get-regexp' && args[2].includes('partialclonefilter')) return { status: 1, stdout: '' };
      if (args[0] === 'config') return { status: 0, stdout: 'remote.origin.promisor true\n' };
      return { status: 0, stdout: '' };
    })).toBeNull();
    expect(calls.map((args) => args[0])).toEqual(['rev-parse', 'config', 'config']);

    calls.length = 0;
    expect(probeGoalHistory('/repo', (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'false\n' };
      if (args[0] === 'config') return { status: 1, stdout: '' };
      return { status: 0, stdout: String(MAX_HISTORY_COMMITS + 1) + '\n' };
    })).toBeNull();
    expect(calls.map((args) => args[0])).toEqual(['rev-parse', 'config', 'config', 'rev-list']);

    calls.length = 0;
    expect(probeGoalHistory('/repo', (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'false\n' };
      if (args[0] === 'config') return { status: 1, stdout: '' };
      if (args[0] === 'rev-list') return { status: 0, stdout: '12\n' };
      return { status: null, stdout: '', error: { code: 'ETIMEDOUT' } };
    })).toBeNull();
    expect(calls.map((args) => args[0])).toEqual(['rev-parse', 'config', 'config', 'rev-list', 'log']);
  });

  test.skipIf(!canMeasureWithoutGh)('classifies landed, tracked-no-pr, and untracked without calling gh', () => {
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

    const prev = process.env.PATH;
    process.env.PATH = ghlessPath;
    try {
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

  test.skipIf(!hasCompleteGoalHistory)('real repo total matches ls docs/goals file count when docs/goals exists', () => {
    const repoRoot = realRepoRoot;
    const listed = readdirSync(join(repoRoot, 'docs/goals')).filter((name) => !name.startsWith('.')).length;
    const census = censusGoals({
      repoRoot,
      gitLog: () => realRepoHistory!,
      listUntracked: (r) => gitListUntracked(r),
    });
    expect(census.summary.total).toBe(listed);
  });
});
