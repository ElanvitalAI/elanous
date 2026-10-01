import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyCleanCheckout, type CheckoutDeps } from './clean-checkout.js';
import { runMission } from './run-mission.js';

function fake(fail?: string, throwOnAdd = false) {
  const calls: Array<{ bin: string; args: string[]; cwd: string; timeout: number; env?: NodeJS.ProcessEnv }> = [];
  let clock = 0;
  const deps: CheckoutDeps = {
    now: () => { clock += 1000; return clock; },
    git: (args, options) => {
      calls.push({ bin: 'git', args, ...options });
      if (throwOnAdd && args[1] === 'add') throw new Error('add exception');
      return '';
    },
    run: (args, options) => {
      calls.push({ bin: 'bun', args, ...options });
      if (args[0] === fail) throw { stderr: Array.from({ length: 25 }, (_, i) => `error line ${i + 1}`).join('\n') };
      return args[0] === 'test' ? `${args.length - 1} pass\n0 fail\nRan ${args.length - 1} tests across ${args.length - 1} files.` : 'passed';
    },
  };
  return { deps, calls };
}

test('passing changed tests use a detached merge checkout, frozen install, and leave no worktree', () => {
  const { deps, calls } = fake();
  const result = verifyCleanCheckout({ pr: 10, mergeSha: 'abcdef012345abcdef012345abcdef012345abcd', files: ['src/a.test.ts', 'src/a.ts'], deps });
  expect(result.ok).toBe(true);
  expect(result.steps.map(({ name, ok }) => [name, ok])).toEqual([
    ['worktree add', true], ['bun install --frozen-lockfile', true], ['bun test', true], ['worktree remove', true],
  ]);
  expect(calls.map(({ bin, args }) => [bin, ...args.slice(0, 3)])).toEqual([
    ['git', 'cat-file', '-e', 'abcdef012345abcdef012345abcdef012345abcd^{commit}'],
    ['git', 'worktree', 'add', '--detach'], ['bun', 'install', '--frozen-lockfile'],
    ['bun', 'test', 'src/a.test.ts'], ['git', 'worktree', 'remove', '--force'],
  ]);
  expect(calls[1]?.args[4]).toBe('abcdef012345abcdef012345abcdef012345abcd');
  expect(calls.every(({ timeout }) => timeout <= 600_000 && timeout > 0)).toBe(true);
  expect(existsSync(calls[1]!.args[3]!)).toBe(false);
});

test.each(['pass', 'fail'] as const)('real Git registration is removed after a %s clean checkout', (outcome) => {
  const fixture = mkdtempSync(join(tmpdir(), 'landing-heal-git-fixture-'));
  const repo = join(fixture, 'repo');
  const git = (args: string[], cwd = repo): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
  let checkout = '';
  try {
    git(['init', '-q', repo], fixture);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'merge fixture']);
    const sha = git(['rev-parse', 'HEAD']).trim();
    const deps: CheckoutDeps = {
      now: Date.now,
      git: (args) => {
        if (args[0] === 'worktree' && args[1] === 'add') checkout = args[3]!;
        return git(args);
      },
      run: (args, options) => {
        expect(args[0] === 'install' || args[0] === 'test').toBe(true);
        expect(options.cwd).toBe(checkout);
        expect(existsSync(join(checkout, '.git'))).toBe(true);
        expect(git(['worktree', 'list', '--porcelain'])).toContain(`worktree ${checkout}\n`);
        if (args[0] === 'test' && outcome === 'fail') {
          throw { stderr: Array.from({ length: 25 }, (_, i) => `error line ${i + 1}`).join('\n') };
        }
        return args[0] === 'test' ? '1 pass\n0 fail\nRan 1 test across 1 file.' : 'installed';
      },
    };
    const result = verifyCleanCheckout({ pr: 23, mergeSha: sha, files: ['src/a.test.ts'], deps });
    expect(checkout).not.toBe('');
    expect(result.ok).toBe(outcome === 'pass');
    if (outcome === 'fail') {
      expect(result.steps.find((step) => step.name === 'bun test')).toMatchObject({ ok: false });
      expect(result.steps.find((step) => step.name === 'bun test')?.tail.split('\n')).toHaveLength(20);
    }
    expect(existsSync(checkout)).toBe(false);
    expect(git(['worktree', 'list', '--porcelain'])).not.toContain(`worktree ${checkout}\n`);
  } finally {
    if (checkout && existsSync(checkout)) git(['worktree', 'remove', '--force', checkout]);
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('missing merge commit is fetched before worktree add and then verified locally', () => {
  const { deps, calls } = fake();
  let present = false;
  const originalGit = deps.git;
  deps.git = (args, options) => {
    if (args[0] === 'cat-file' && !present) {
      calls.push({ bin: 'git', args, ...options });
      throw new Error('object not found');
    }
    if (args[0] === 'fetch') present = true;
    return originalGit(args, options);
  };
  const sha = 'abcdef012345abcdef012345abcdef012345abcd';
  const result = verifyCleanCheckout({ pr: 19, mergeSha: sha, files: ['src/a.test.ts'], deps });
  expect(result.ok).toBe(true);
  expect(calls.filter(({ bin }) => bin === 'git').map(({ args }) => args)).toEqual([
    ['cat-file', '-e', `${sha}^{commit}`], ['fetch', '--no-tags', 'origin', sha],
    ['cat-file', '-e', `${sha}^{commit}`], ['worktree', 'add', '--detach', expect.any(String), sha],
    ['worktree', 'remove', '--force', expect.any(String)],
  ]);
  expect(existsSync(calls[3]!.args[3]!)).toBe(false);
});

test('the clean-checkout mission fetches a missing GitHub merge commit through its verifier before checking it out', () => {
  const { deps, calls } = fake();
  let present = false;
  const originalGit = deps.git;
  deps.git = (args, options) => {
    if (args[0] === 'cat-file' && !present) {
      calls.push({ bin: 'git', args, ...options });
      throw new Error('not found locally');
    }
    if (args[0] === 'fetch') present = true;
    return originalGit(args, options);
  };
  const sha = 'abcdef012345abcdef012345abcdef012345abcd';
  const result = runMission('clean-checkout', { outputs: {
    collect: { prs: [{ number: 21, state: 'MERGED', mergedAt: '2026-09-29T01:00:00Z', files: [{ path: 'src/a.test.ts' }] }] },
    'verify-needed': { verifyNeeded: [21] },
  } }, (args) => {
    expect(args).toEqual(['pr', 'view', '21', '--json', 'mergeCommit']);
    return JSON.stringify({ mergeCommit: { oid: sha } });
  }, new Date(), (input) => verifyCleanCheckout({ ...input, deps }));
  expect(result.results).toMatchObject([{ pr: 21, mergeSha: sha, ok: true }]);
  expect(calls.filter(({ bin }) => bin === 'git').map(({ args }) => args[0])).toEqual([
    'cat-file', 'fetch', 'cat-file', 'worktree', 'worktree',
  ]);
  expect(existsSync(calls[3]!.args[3]!)).toBe(false);
});

test('fetch failure is reported without a checkout and still cleans the temporary folder', () => {
  const { deps, calls } = fake();
  const originalGit = deps.git;
  deps.git = (args, options) => {
    if (args[0] === 'cat-file' || args[0] === 'fetch') {
      calls.push({ bin: 'git', args, ...options });
      throw new Error(`${args[0]} failed`);
    }
    return originalGit(args, options);
  };
  const result = verifyCleanCheckout({ pr: 20, mergeSha: 'abcdef012345abcdef012345abcdef012345abcd', files: ['src/a.test.ts'], deps });
  expect(result.ok).toBe(false);
  expect(result.steps[0]).toMatchObject({ name: 'worktree add', ok: false });
  expect(result.steps[0]?.tail).toContain('fetch failed');
  expect(calls.some(({ args }) => args[1] === 'add')).toBe(false);
  expect(calls.at(-1)?.args.slice(0, 3)).toEqual(['worktree', 'remove', '--force']);
  expect(existsSync(calls.at(-1)!.args[3]!.replace(/\/checkout$/, ''))).toBe(false);
});

test('changed .test.tsx and .spec.ts execute alongside .test.ts', () => {
  const { deps, calls } = fake();
  const result = verifyCleanCheckout({ pr: 16, mergeSha: 'abcdef012345abcdef012345abcdef012345abcd',
    files: ['src/a.test.ts', 'apps/pwa/src/widget.test.tsx', 'src/logic.spec.ts'], deps });
  expect(result.ok).toBe(true);
  expect(calls[3]?.args).toEqual(['test', 'src/a.test.ts', 'apps/pwa/src/widget.test.tsx', 'src/logic.spec.ts']);
  expect(existsSync(calls.find(({ args }) => args[0] === 'worktree' && args[1] === 'add')!.args[3]!)).toBe(false);
});

test('a zero-file or partial bun result cannot mark changed tests verified', () => {
  for (const output of ['0 pass\n0 fail\nRan 0 tests across 0 files.', '1 pass\n0 fail\nRan 1 test across 1 file.']) {
    const { deps, calls } = fake();
    deps.run = (args) => args[0] === 'test' ? output : 'passed';
    const result = verifyCleanCheckout({ pr: 18, mergeSha: 'abcdef012345abcdef012345abcdef012345abcd',
      files: ['src/a.test.ts', 'src/b.spec.tsx'], deps });
    expect(result.ok).toBe(false);
    expect(result.steps[2]).toMatchObject({ name: 'bun test', ok: false });
    expect(existsSync(calls.find(({ args }) => args[0] === 'worktree' && args[1] === 'add')!.args[3]!)).toBe(false);
  }
});

test('unsupported changed test file fails closed rather than passing typecheck', () => {
  const { deps, calls } = fake();
  const result = verifyCleanCheckout({ pr: 17, mergeSha: 'abcdef012345abcdef012345abcdef012345abcd',
    files: ['src/a.ts', 'src/logic.spec.xyz'], deps });
  expect(result.ok).toBe(false);
  expect(result.steps[2]).toMatchObject({ name: 'select changed tests', ok: false });
  expect(result.steps[2]?.tail).toContain('src/logic.spec.xyz');
  expect(calls.some(({ args }) => args[0] === 'run' || args[0] === 'test')).toBe(false);
  expect(existsSync(calls.find(({ args }) => args[0] === 'worktree' && args[1] === 'add')!.args[3]!)).toBe(false);
});

test('failed test records only the last 20 lines and still removes its worktree', () => {
  const { deps, calls } = fake('test');
  const result = verifyCleanCheckout({ pr: 11, mergeSha: 'abcdef012345abcdef012345abcdef012345abcd', files: ['src/a.test.ts'], deps });
  expect(result.ok).toBe(false);
  expect(result.steps[2]).toMatchObject({ name: 'bun test', ok: false });
  expect(result.steps[2]?.tail.split('\n')).toHaveLength(20);
  expect(result.steps[2]?.tail).toStartWith('error line 6');
  expect(calls.at(-1)?.args.slice(0, 3)).toEqual(['worktree', 'remove', '--force']);
  expect(existsSync(calls.find(({ args }) => args[0] === 'worktree' && args[1] === 'add')!.args[3]!)).toBe(false);
});

test('zero executed tests cannot mark a PR verified', () => {
  const { deps } = fake();
  deps.run = (args) => args[0] === 'test' ? '0 pass\n0 fail\nRan 0 tests across 1 file.' : '';
  const result = verifyCleanCheckout({ pr: 15, mergeSha: 'abcdef012345abcdef012345abcdef012345abcd', files: ['src/a.test.ts'], deps });
  expect(result.ok).toBe(false);
  expect(result.steps[2]?.tail).toContain('did not run any tests');
});

test('exceptions on add and install both attempt worktree cleanup', () => {
  for (const [fail, onAdd] of [[undefined, true], ['install', false]] as const) {
    const { deps, calls } = fake(fail, onAdd);
    const result = verifyCleanCheckout({ pr: 12, mergeSha: 'abcdef012345abcdef012345abcdef012345abcd', files: ['src/a.test.ts'], deps });
    expect(result.ok).toBe(false);
    expect(calls.at(-1)?.args.slice(0, 3)).toEqual(['worktree', 'remove', '--force']);
    expect(existsSync(calls.find(({ args }) => args[0] === 'worktree' && args[1] === 'add')!.args[3]!)).toBe(false);
  }
});

test('deadline expiry still gives cleanup its own timeout', () => {
  const calls: string[][] = [];
  let clock = 0;
  const deps: CheckoutDeps = {
    now: () => { clock += 300_000; return clock; },
    git: (args) => { calls.push(args); return ''; },
    run: (args) => { calls.push(args); return ''; },
  };
  const result = verifyCleanCheckout({ pr: 14, mergeSha: 'abcdef012345abcdef012345abcdef012345abcd', files: ['src/a.ts'], deps });
  expect(result.ok).toBe(false);
  expect(result.steps.some((step) => step.tail.includes('600s timeout'))).toBe(true);
  expect(calls.at(-1)?.slice(0, 3)).toEqual(['worktree', 'remove', '--force']);
});

test('changed .ts without tests selects the gate supported TSC_BASE_REF, not rejected --base', () => {
  const { deps, calls } = fake();
  expect(verifyCleanCheckout({ pr: 13, mergeSha: 'abcdef012345abcdef012345abcdef012345abcd', files: ['src/a.ts'], deps }).ok).toBe(true);
  expect(calls[3]?.args).toEqual(['run', 'scripts/ci-typecheck-changed.ts']);
  expect(calls[3]?.env?.TSC_BASE_REF).toBe('abcdef012345abcdef012345abcdef012345abcd^');
});

test('five needed PRs check only the two oldest; no gh comment without explicit postVerified', () => {
  const prs = [5, 3, 4, 1, 2].map((number) => ({ number, state: 'MERGED', mergedAt: `2026-09-29T0${number}:00:00Z`, files: [{ path: 'src/a.ts' }] }));
  const calls: string[][] = [];
  const verified: number[] = [];
  const ctx = { outputs: { collect: { prs }, 'verify-needed': { verifyNeeded: [5, 3, 4, 1, 2] } } };
  const gh = (args: string[]) => { calls.push(args); return JSON.stringify({ mergeCommit: { oid: 'abcdef012345abcdef012345abcdef012345abcd' } }); };
  const verify = ({ pr, mergeSha }: { pr: number; mergeSha: string }) => {
    verified.push(pr);
    return { pr, mergeSha, ok: true, steps: [{ name: 'bun test', ok: true, seconds: 2, tail: '' }] };
  };
  const result = runMission('clean-checkout', ctx, gh, new Date(), verify);
  expect(result.outcome).toBe('ok');
  expect(verified).toEqual([1, 2]);
  expect(calls.filter((args) => args[1] === 'comment')).toHaveLength(0);
  expect((result.results as unknown[])).toHaveLength(2);
  runMission('clean-checkout', { ...ctx, input: { postVerified: true } }, gh, new Date(), verify);
  expect(calls.filter((args) => args[1] === 'comment').map((args) => args.at(-1))).toEqual([
    'landing-verified: abcdef01 · clean checkout · bun test',
    'landing-verified: abcdef01 · clean checkout · bun test',
  ]);
});

test('a failed check never posts landing-verified even when postVerified is true', () => {
  const calls: string[][] = [];
  const result = runMission('clean-checkout', {
    input: { postVerified: true }, outputs: {
      collect: { prs: [{ number: 9, state: 'MERGED', mergedAt: '2026-09-29T01:00:00Z', files: [{ path: 'src/a.test.ts' }] }] },
      'verify-needed': { verifyNeeded: [9] },
    },
  }, (args) => { calls.push(args); return JSON.stringify({ mergeCommit: { oid: 'abcdef012345abcdef012345abcdef012345abcd' } }); },
  new Date(), ({ pr, mergeSha }) => ({ pr, mergeSha, ok: false, steps: [{ name: 'bun test', ok: false, seconds: 2, tail: 'failed' }] }));
  expect((result.results as Array<{ ok: boolean }>)[0]?.ok).toBe(false);
  expect(calls.filter((args) => args[1] === 'comment')).toHaveLength(0);
});

test('graph recipe leaves time for two 600-second checks, two 30-second cleanups and reporting', () => {
  const recipe = readFileSync(join(import.meta.dir, '../../graphs/landing/recipes.yaml'), 'utf8');
  const timeout = /clean-checkout:\n  command: 'bun scripts\/landing-heal\/run-mission\.ts clean-checkout'\n  timeout_ms: (\d+)/.exec(recipe);
  expect(timeout).not.toBeNull();
  expect(Number(timeout![1])).toBeGreaterThan(2 * (600_000 + 30_000));
});

test('report decision names successful and failed clean checkouts with failing PR number', () => {
  const decisions: Array<{ reason: string }> = [];
  runMission('report', { outputs: {
    collect: { prs: [] }, 'must-fix-match': { matches: [] }, 'verify-needed': { verifyNeeded: [1, 2] },
    'clean-checkout': { results: [{ pr: 1, ok: true }, { pr: 2, ok: false }] },
  }, decision: (event) => { decisions.push(event); return true; } });
  expect(decisions[0]?.reason).toContain('검증 성공 1 · 실패 1(PR #2)');
});
