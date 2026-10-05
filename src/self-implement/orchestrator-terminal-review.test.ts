import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { runSelfImplement } from './orchestrator.js';
import { seams } from './test-seams.js';
import { parseSelfImplementJson } from '../task-orchestrator/surfaces/self-implement.js';

const mustFix = ['Preserve the exact final reviewer finding.'];
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

test.each([true, false])('final review fail returns a recoverable terminal result (changes=%s)', async (changes) => {
  const root = mkdtempSync(join(tmpdir(), 'terminal-review-'));
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const off = debug.registerSink({ name: `terminal-review-${changes}`, emit: ({ category, event, data }) => {
    if (category === 'self-implement.terminal') events.push({ category, event, data: data as Record<string, unknown> });
  } });
  let opened: Record<string, unknown> | undefined;
  try {
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(join(root, 'README.md'), 'base\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-m', 'base');
    git(root, 'checkout', '-b', 'test/review-blocked');
    const previousSubstrate = process.env.ELANOUS_SUBSTRATE;
    process.env.ELANOUS_SUBSTRATE = 'pod';
    let result: Awaited<ReturnType<typeof runSelfImplement>>;
    try { result = await runSelfImplement({
      feature: 'target paths: change.ts\nFix the target', maxReworkRounds: 0, memory: false,
      seams: seams({
        createWorktree: async () => ({ path: root, branch: 'test/review-blocked', resolvedBase: git(root, 'rev-parse', 'main') }),
        implement: async () => {
          if (changes) writeFileSync(join(root, 'change.ts'), 'export const fixed = true;\n');
          return { ok: true, summary: 'implemented' };
        },
        changedFilesForGateRoute: () => changes ? ['change.ts'] : [],
        reviewDiff: async () => ({ verdict: 'fail', mustFix: [...mustFix], shouldFix: [], reviewed: true, summary: 'blocked' }),
        openPr: async (opts) => { opened = opts; return { url: 'https://example.test/pr/7', number: 7 }; },
      }),
    }); } finally {
      if (previousSubstrate === undefined) delete process.env.ELANOUS_SUBSTRATE;
      else process.env.ELANOUS_SUBSTRATE = previousSubstrate;
    }
    const line = JSON.stringify(result);
    const parsed = parseSelfImplementJson(line);
    expect(parsed?.stage).toBe(changes ? 'review-blocked' : 'no-changes');
    expect(parsed?.mustFix).toEqual(mustFix);
    expect(result.mustFix).toEqual(mustFix);
    if (changes) {
      expect(parsed?.prNumber).toBe(7);
      expect(opened).toMatchObject({ draft: true, labels: ['review-blocked'] });
      expect(String(opened?.body)).toContain(`## 마지막 리뷰 must-fix\n- ${mustFix[0]}`);
      expect(git(root, 'show', 'HEAD:change.ts')).toContain('fixed = true');
      expect(events).toContainEqual(expect.objectContaining({ event: 'review-blocked-pr', data: expect.objectContaining({ runId: result.runId, prNumber: 7, round: 0 }) }));
    } else {
      expect(opened).toBeUndefined();
      expect(parsed?.prNumber).toBeUndefined();
      expect(events).toHaveLength(0);
    }
  } finally { off(); rmSync(root, { recursive: true, force: true }); }
});

test.each([true, false])('Pod draft PR failure preserves branch or reports preservation failure (push=%s)', async (push) => {
  const previousSubstrate = process.env.ELANOUS_SUBSTRATE;
  process.env.ELANOUS_SUBSTRATE = 'pod';
  const root = mkdtempSync(join(tmpdir(), 'terminal-review-pr-fail-'));
  let preservationCalls = 0;
  try {
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(join(root, 'README.md'), 'base\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-m', 'base');
    git(root, 'checkout', '-b', 'test/review-blocked');
    const run = runSelfImplement({
      feature: 'Fix the target', maxReworkRounds: 0, memory: false,
      seams: seams({
        createWorktree: async () => ({ path: root, branch: 'test/review-blocked', resolvedBase: git(root, 'rev-parse', 'main') }),
        implement: async () => { writeFileSync(join(root, 'change.ts'), 'export const fixed = true;\n'); return { ok: true, summary: 'implemented' }; },
        changedFilesForGateRoute: () => ['change.ts'],
        reviewDiff: async () => ({ verdict: 'fail', mustFix: [...mustFix], shouldFix: [], reviewed: true, summary: 'blocked' }),
        openPr: async () => { throw new Error('PR service unavailable'); },
        preserveBlockedBranch: async () => { preservationCalls++; if (!push) throw new Error('push denied'); return true; },
      }),
    });
    if (push) {
      const result = await run;
      expect(result.stage).toBe('aborted');
      expect(result.salvage).toBe('parked');
      expect(result.detail).toContain('PR service unavailable');
      expect(result.detail).toContain('원격 브랜치 보존: test/review-blocked');
      expect(result.mustFix).toEqual(mustFix);
    } else {
      const result = await run;
      expect(result.stage).toBe('aborted');
      expect(result.salvage).toBe('parked');
      expect(result.detail).toContain('PR service unavailable');
      expect(result.detail).toContain('원격 브랜치 보존 실패: push denied');
      expect(result.mustFix).toEqual(mustFix);
    }
    expect(preservationCalls).toBe(1);
    expect(git(root, 'show', 'HEAD:change.ts')).toContain('fixed = true');
  } finally {
    if (previousSubstrate === undefined) delete process.env.ELANOUS_SUBSTRATE;
    else process.env.ELANOUS_SUBSTRATE = previousSubstrate;
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pod PR failure pushes committed work to origin without an injected branch seam', async () => {
  const previousSubstrate = process.env.ELANOUS_SUBSTRATE;
  process.env.ELANOUS_SUBSTRATE = 'pod';
  const root = mkdtempSync(join(tmpdir(), 'terminal-review-origin-'));
  const repo = join(root, 'repo');
  const remote = join(root, 'origin.git');
  try {
    git(root, 'init', '-b', 'main', repo);
    git(root, 'init', '--bare', remote);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'base');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'checkout', '-b', 'test/review-blocked');
    const result = await runSelfImplement({
      feature: 'Fix the target', maxReworkRounds: 0, memory: false,
      seams: seams({
        createWorktree: async () => ({ path: repo, branch: 'test/review-blocked', resolvedBase: git(repo, 'rev-parse', 'main') }),
        implement: async () => { writeFileSync(join(repo, 'change.ts'), 'export const fixed = true;\n'); return { ok: true, summary: 'implemented' }; },
        changedFilesForGateRoute: () => ['change.ts'],
        reviewDiff: async () => ({ verdict: 'fail', mustFix: [...mustFix], shouldFix: [], reviewed: true, summary: 'blocked' }),
        openPr: async () => { throw new Error('PR service unavailable'); },
      }),
    });
    expect(result.stage).toBe('aborted');
    expect(result.detail).toContain('PR service unavailable');
    expect(git(repo, 'ls-remote', '--heads', 'origin', 'test/review-blocked').split('\t')[0]).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(git(repo, 'show', 'HEAD:change.ts')).toContain('fixed = true');
  } finally {
    if (previousSubstrate === undefined) delete process.env.ELANOUS_SUBSTRATE;
    else process.env.ELANOUS_SUBSTRATE = previousSubstrate;
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pod commit failure still pushes the branch and names the failure in the result', async () => {
  const previousSubstrate = process.env.ELANOUS_SUBSTRATE;
  process.env.ELANOUS_SUBSTRATE = 'pod';
  const root = mkdtempSync(join(tmpdir(), 'terminal-review-commit-fail-'));
  const repo = join(root, 'repo');
  const remote = join(root, 'origin.git');
  let opened = 0;
  try {
    git(root, 'init', '-b', 'main', repo);
    git(root, 'init', '--bare', remote);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'base');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'checkout', '-b', 'test/review-blocked');
    const result = await runSelfImplement({
      feature: 'Fix the target', maxReworkRounds: 0, memory: false,
      seams: seams({
        createWorktree: async () => ({ path: repo, branch: 'test/review-blocked', resolvedBase: git(repo, 'rev-parse', 'main') }),
        implement: async () => {
          writeFileSync(join(repo, 'change.ts'), 'export const fixed = true;\n');
          const hook = join(repo, '.git', 'hooks', 'pre-commit');
          writeFileSync(hook, '#!/bin/sh\necho hook refused >&2\nexit 1\n');
          chmodSync(hook, 0o755);
          return { ok: true, summary: 'implemented' };
        },
        changedFilesForGateRoute: () => ['change.ts'],
        reviewDiff: async () => ({ verdict: 'fail', mustFix: [...mustFix], shouldFix: [], reviewed: true, summary: 'blocked' }),
        openPr: async () => { opened++; return { url: 'https://example.test/pr/9', number: 9 }; },
      }),
    });
    expect(result.stage).toBe('aborted');
    expect(result.salvage).toBe('parked');
    expect(result.mustFix).toEqual(mustFix);
    expect(result.detail).toContain('review-blocked 작업 커밋 실패');
    expect(result.detail).toContain('hook refused');
    expect(result.detail).toContain('원격 브랜치 보존: test/review-blocked');
    expect(result.detail).toContain(`미커밋 작업은 worktree 에 남음: ${repo}`);
    expect(opened).toBe(0);
    expect(git(repo, 'ls-remote', '--heads', 'origin', 'test/review-blocked').split('\t')[0]).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(existsSync(join(repo, 'change.ts'))).toBe(true);
  } finally {
    if (previousSubstrate === undefined) delete process.env.ELANOUS_SUBSTRATE;
    else process.env.ELANOUS_SUBSTRATE = previousSubstrate;
    rmSync(root, { recursive: true, force: true });
  }
});

test('outside Pod final review fail with no changes stays review-blocked and opens no PR', async () => {
  const previousSubstrate = process.env.ELANOUS_SUBSTRATE;
  delete process.env.ELANOUS_SUBSTRATE;
  let opened = 0;
  try {
    // The supervisor stops the rework as UNCONVERGEABLE, so the run takes the real final review-fail exit
    // (no review-budget acceptance PR) with nothing to preserve.
    const result = await runSelfImplement({
      feature: 'no changes', maxReworkRounds: 2, reworkBudgetShadowStop: false, memory: false,
      seams: seams({
        preservationHasChanges: () => false,
        reviewDiff: async () => ({ verdict: 'fail', mustFix: [...mustFix], shouldFix: [], reviewed: true, summary: 'blocked' }),
        diagnose: async () => 'BUDGET: UNCONVERGEABLE\nREASON: the same finding does not converge',
        judgmentCallLLM: async () => 'UNCONVERGEABLE',
        openPr: async () => { opened++; return { url: 'https://example.test/pr/8', number: 8 }; },
      }),
    });
    expect(result.stage).toBe('review-blocked');
    expect(result.detail).toContain('rework judged unconvergeable');
    expect(result.mustFix).toEqual(mustFix);
    expect(opened).toBe(0);
    expect(result.prNumber).toBeUndefined();
  } finally {
    if (previousSubstrate === undefined) delete process.env.ELANOUS_SUBSTRATE;
    else process.env.ELANOUS_SUBSTRATE = previousSubstrate;
  }
});

test('Pod unconvergeable review stop carries the draft PR failure and branch preservation in its detail', async () => {
  const previousSubstrate = process.env.ELANOUS_SUBSTRATE;
  process.env.ELANOUS_SUBSTRATE = 'pod';
  const root = mkdtempSync(join(tmpdir(), 'terminal-review-unconvergeable-'));
  try {
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(join(root, 'README.md'), 'base\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-m', 'base');
    git(root, 'checkout', '-b', 'test/review-blocked');
    const result = await runSelfImplement({
      feature: 'unconvergeable', maxReworkRounds: 2, reworkBudgetShadowStop: false, memory: false,
      seams: seams({
        createWorktree: async () => ({ path: root, branch: 'test/review-blocked', resolvedBase: git(root, 'rev-parse', 'main') }),
        implement: async () => { writeFileSync(join(root, 'change.ts'), 'export const fixed = true;\n'); return { ok: true, summary: 'implemented' }; },
        changedFilesForGateRoute: () => ['change.ts'],
        preservationHasChanges: () => true,
        reviewDiff: async () => ({ verdict: 'fail', mustFix: [...mustFix], shouldFix: [], reviewed: true, summary: 'blocked' }),
        diagnose: async () => 'BUDGET: UNCONVERGEABLE\nREASON: the same finding does not converge',
        judgmentCallLLM: async () => 'UNCONVERGEABLE',
        openPr: async () => { throw new Error('PR service unavailable'); },
        preserveBlockedBranch: async () => { throw new Error('push denied'); },
      }),
    });
    expect(result.stage).toBe('aborted');
    expect(result.detail).toContain('draft PR 생성 실패: PR service unavailable');
    expect(result.detail).toContain('원격 브랜치 보존 실패: push denied');
    expect(result.detail).toContain('rework judged unconvergeable');
    expect(result.mustFix).toEqual(mustFix);
    expect(git(root, 'show', 'HEAD:change.ts')).toContain('fixed = true');
  } finally {
    if (previousSubstrate === undefined) delete process.env.ELANOUS_SUBSTRATE;
    else process.env.ELANOUS_SUBSTRATE = previousSubstrate;
    rmSync(root, { recursive: true, force: true });
  }
});
