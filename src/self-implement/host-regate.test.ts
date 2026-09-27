import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSlot, runHostRegate, type HostRegateDeps } from './host-regate.js';

const HEAD = 'a'.repeat(40);
const BASE = 'c'.repeat(40);
const MERGE_BASE = 'b'.repeat(40);
const SQUASH = 'd'.repeat(40);
const input = { prNumber: 42, headCommit: HEAD, repoRoot: '/repo' };
const view = JSON.stringify({ headRefOid: HEAD, baseRefName: 'main', baseRefOid: BASE, state: 'OPEN', isDraft: false });

function mock(overrides: Partial<HostRegateDeps> = {}) {
  const calls: string[] = [];
  const events: string[] = [];
  const deps: HostRegateDeps = {
    command: (bin, args) => {
      const call = `${bin} ${args.join(' ')}`;
      calls.push(call);
      if (call === 'gh pr view 42 --json headRefOid,baseRefName,baseRefOid,state,isDraft') return { status: 0, stdout: view, stderr: '' };
      if (call === 'git rev-parse HEAD') return { status: 0, stdout: BASE, stderr: '' };
      if (call === 'git rev-parse HEAD^1') return { status: 0, stdout: BASE, stderr: '' };
      if (call === 'git rev-parse HEAD^2') return { status: 0, stdout: HEAD, stderr: '' };
      if (call === 'git rev-parse FETCH_HEAD') return { status: 0, stdout: calls.at(-2) === `git fetch origin refs/heads/main` ? BASE : HEAD, stderr: '' };
      if (call === `git merge-base ${BASE} ${HEAD}`) return { status: 0, stdout: MERGE_BASE, stderr: '' };
      if (call === `git diff --name-only ${MERGE_BASE} ${HEAD}`) return { status: 0, stdout: 'src/feature.test.ts\n', stderr: '' };
      if (call === 'gh pr view 42 --json state,mergeCommit') return { status: 0, stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: SQUASH } }), stderr: '' };
      if (call === `git rev-parse ${SQUASH}^1`) return { status: 0, stdout: BASE, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    makeTemp: () => '/temp/regate',
    removeTemp: () => { events.push('cleanup'); },
    acquire: async () => () => { events.push('release'); },
    interference: async () => ({ passed: true }),
    log: (event) => events.push(event),
    ...overrides,
  };
  return { deps, calls, events };
}

describe('host regate: never merge without a measured host pass', () => {
  test('all gates pass: one head-pinned squash merge after the base re-read, confirmed MERGED, cleanup', async () => {
    const { deps, calls, events } = mock();
    const result = await runHostRegate(input, deps);
    expect(result).toEqual({ passed: true, failures: [], os: process.platform });
    expect(calls.filter((call) => call.startsWith('gh pr merge'))).toEqual([`gh pr merge 42 --squash --match-head-commit ${HEAD}`]);
    const views = calls.map((call, i) => (call === 'gh pr view 42 --json headRefOid,baseRefName,baseRefOid,state,isDraft' ? i : -1)).filter((i) => i >= 0);
    expect(views.at(-1)!).toBeLessThan(calls.indexOf(`gh pr merge 42 --squash --match-head-commit ${HEAD}`));
    expect(calls.indexOf('bun scripts/ci-typecheck-changed.ts')).toBeLessThan(calls.indexOf(`gh pr merge 42 --squash --match-head-commit ${HEAD}`));
    expect(calls).toContain('gh pr view 42 --json state,mergeCommit');
    expect(calls.filter((call) => call.startsWith('gh pr comment'))).toHaveLength(0);
    expect(events).toContain('passed');
    expect(events).not.toContain('base-raced');
    expect(calls.filter((call) => call === 'gh pr view 42 --json headRefOid,baseRefName,baseRefOid,state,isDraft')).toHaveLength(2);
    expect(calls).toContain(`git merge-base ${BASE} ${HEAD}`);
    expect(calls).toContain(`git worktree add --detach /temp/regate ${BASE}`);
    expect(calls).toContain(`git merge --no-ff --no-commit ${HEAD}`);
    expect(calls.indexOf(`git merge --no-ff --no-commit ${HEAD}`)).toBeLessThan(calls.indexOf('bun scripts/ci-typecheck-changed.ts'));
    expect(calls).toContain('bun scripts/ci-typecheck-changed.ts');
    expect(calls).not.toContain('bun bin/elanous.mjs --test nexus build');
    expect(calls).toContain('git worktree remove --force /temp/regate');
    expect(events).toContain('cleanup');
  });

  test('base moved between the re-read and the merge: merged, but the race is recorded', async () => {
    const { deps, events } = mock();
    const command = deps.command!;
    const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
    deps.log = (event, data) => { logged.push({ event, data }); events.push(event); };
    deps.command = (bin, args, cwd, env) => (bin === 'git' && args.join(' ') === `rev-parse ${SQUASH}^1` ? { status: 0, stdout: 'e'.repeat(40), stderr: '' } : command(bin, args, cwd, env));
    expect(await runHostRegate(input, deps)).toMatchObject({ passed: true });
    expect(logged.find((l) => l.event === 'base-raced')?.data).toMatchObject({ checkedBase: BASE, mergedOnto: 'e'.repeat(40), mergeCommit: SQUASH });
  });

  test('merge rejected (head moved on GitHub): not passed, one failure comment', async () => {
    const { deps, calls } = mock();
    const command = deps.command!;
    deps.command = (bin, args, cwd, env) => (bin === 'gh' && args[1] === 'merge' ? { status: 1, stdout: '', stderr: 'Head branch was modified' } : command(bin, args, cwd, env));
    const result = await runHostRegate(input, deps);
    expect(result).toMatchObject({ passed: false, failures: [{ step: 'merge' }] });
    expect(calls.filter((call) => call.startsWith('gh pr comment')).length).toBe(1);
  });

  test('merge call returns 0 but PR is not MERGED: unmeasured, not passed', async () => {
    const { deps } = mock();
    const command = deps.command!;
    deps.command = (bin, args, cwd, env) => (bin === 'gh' && args.join(' ') === 'pr view 42 --json state,mergeCommit' ? { status: 0, stdout: JSON.stringify({ state: 'OPEN', mergeCommit: null }), stderr: '' } : command(bin, args, cwd, env));
    expect(await runHostRegate(input, deps)).toMatchObject({ passed: false, failures: [{ step: 'merge-confirm' }] });
  });

  test('PWA candidate reuses both root and app dependencies before its build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-regate-pwa-'));
    const workspace = join(root, 'repo');
    const tree = join(root, 'candidate');
    mkdirSync(join(workspace, 'apps/pwa/node_modules'), { recursive: true });
    mkdirSync(join(workspace, 'node_modules'), { recursive: true });
    mkdirSync(join(tree, 'apps/pwa'), { recursive: true });
    const { deps, calls } = mock();
    const command = deps.command!;
    deps.makeTemp = () => tree;
    deps.removeTemp = () => {};
    deps.command = (bin, args, cwd, env) => {
      if (bin === 'git' && args[0] === 'diff' && args[1] === '--name-only') {
        calls.push(`${bin} ${args.join(' ')}`);
        return { status: 0, stdout: 'apps/pwa/src/page.test.ts\n', stderr: '' };
      }
      if (bin === 'bun' && args.join(' ') === 'bin/elanous.mjs --test nexus build') {
        expect(existsSync(join(tree, 'node_modules'))).toBe(true);
        expect(lstatSync(join(tree, 'apps/pwa/node_modules')).isSymbolicLink()).toBe(true);
      }
      return command(bin, args, cwd, env);
    };
    try {
      expect(await runHostRegate({ ...input, repoRoot: workspace }, deps)).toMatchObject({ passed: true });
      expect(calls).toContain('bun bin/elanous.mjs --test nexus build');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('integration conflict: no gates run and no PR merge', async () => {
    const { deps, calls } = mock();
    const command = deps.command!;
    deps.command = (bin, args, cwd, env) => {
      if (bin === 'git' && args.join(' ') === `merge --no-ff --no-commit ${HEAD}`) {
        calls.push(`${bin} ${args.join(' ')}`);
        return { status: 1, stdout: '', stderr: 'CONFLICT (content): base and head disagree' };
      }
      return command(bin, args, cwd, env);
    };
    const result = await runHostRegate(input, deps);
    expect(result).toMatchObject({ passed: false, failures: [{ step: 'merge-conflict' }] });
    expect(calls.some((call) => call.startsWith('bun scripts/ci-typecheck-changed.ts'))).toBe(false);
    expect(calls.some((call) => call.startsWith('gh pr merge'))).toBe(false);
  });

  test('interference failure: no merge, a single-line failure comment', async () => {
    const { deps, calls, events } = mock({ interference: async (files, cwd) => {
      expect(files).toEqual(['src/feature.test.ts']);
      expect(cwd).toBe('/temp/regate');
      expect(calls).toContain(`git merge --no-ff --no-commit ${HEAD}`);
      expect(calls).toContain('git rev-parse HEAD^2');
      return { passed: false, detail: 'combined 2 fail' };
    } });
    const result = await runHostRegate(input, deps);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([{ step: 'test-interference', detail: 'combined 2 fail' }]);
    expect(calls.filter((call) => call.startsWith('gh pr merge'))).toHaveLength(0);
    const comments = calls.filter((call) => call.startsWith('gh pr comment'));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(`호스트 재게이트 실패(${process.platform}): test-interference — combined 2 fail`);
    expect(events).toContain('failed');
  });

  test('worktree creation failure: unmeasured, never merged, comment and cleanup', async () => {
    const { deps, calls, events } = mock({ makeTemp: () => { throw new Error('no temporary worktree'); } });
    const result = await runHostRegate(input, deps);
    expect(result.passed).toBe(false);
    expect(result.failures[0]?.step).toBe('worktree');
    expect(calls.filter((call) => call.startsWith('gh pr merge'))).toHaveLength(0);
    expect(calls.filter((call) => call.startsWith('gh pr comment'))).toHaveLength(1);
    expect(events).toContain('unmeasured');
    expect(events).toContain('release');
  });

  test('combined test failure is never a passing regate', async () => {
    const { deps, calls } = mock({ interference: async () => ({ passed: false, detail: 'combined 2 fail' }) });
    const result = await runHostRegate(input, deps);
    expect(result.passed).toBe(false);
    expect(calls.filter((call) => call.startsWith('gh pr merge'))).toHaveLength(0);
  });

  test('base changes after host gates: no merge, record unmeasured and request a new regate', async () => {
    const { deps, calls, events } = mock();
    const command = deps.command!;
    let reads = 0;
    deps.command = (bin, args, cwd, env) => {
      if (bin === 'gh' && args[0] === 'pr' && args[1] === 'view' && ++reads === 2) {
        calls.push(`${bin} ${args.join(' ')}`);
        return { status: 0, stdout: JSON.stringify({ headRefOid: HEAD, baseRefName: 'main', baseRefOid: 'd'.repeat(40), state: 'OPEN', isDraft: false }), stderr: '' };
      }
      return command(bin, args, cwd, env);
    };
    const result = await runHostRegate(input, deps);
    expect(result.passed).toBe(false);
    expect(result.failures[0]?.step).toBe('pr-base-changed');
    expect(calls).toContain('bun scripts/ci-typecheck-changed.ts');
    expect(calls.some((call) => call.startsWith('gh pr merge'))).toBe(false);
    expect(calls.filter((call) => call.startsWith('gh pr comment'))).toHaveLength(1);
    expect(events).toContain('unmeasured');
  });

  test('base branch changes after host gates: no merge', async () => {
    const { deps, calls } = mock();
    const command = deps.command!;
    let reads = 0;
    deps.command = (bin, args, cwd, env) => {
      if (bin === 'gh' && args[0] === 'pr' && args[1] === 'view' && ++reads === 2) {
        calls.push(`${bin} ${args.join(' ')}`);
        return { status: 0, stdout: JSON.stringify({ headRefOid: HEAD, baseRefName: 'release', baseRefOid: BASE, state: 'OPEN', isDraft: false }), stderr: '' };
      }
      return command(bin, args, cwd, env);
    };
    const result = await runHostRegate(input, deps);
    expect(result.failures[0]?.step).toBe('pr-base-changed');
    expect(calls.some((call) => call.startsWith('gh pr merge'))).toBe(false);
  });

  test('fetched base differs from PR base: fail closed before checkout', async () => {
    const { deps, calls, events } = mock();
    const command = deps.command!;
    deps.command = (bin, args, cwd, env) => {
      if (bin === 'git' && args.join(' ') === 'rev-parse FETCH_HEAD') {
        calls.push(`${bin} ${args.join(' ')}`);
        return { status: 0, stdout: 'd'.repeat(40), stderr: '' };
      }
      return command(bin, args, cwd, env);
    };
    const result = await runHostRegate(input, deps);
    expect(result.failures[0]?.step).toBe('worktree');
    expect(calls.some((call) => call.startsWith('git worktree add'))).toBe(false);
    expect(calls.some((call) => call.startsWith('gh pr merge'))).toBe(false);
    expect(events).toContain('unmeasured');
  });

  test('checked head changes: fail closed before checkout', async () => {
    const { deps, calls } = mock({ command: (bin, args) => {
      calls.push(`${bin} ${args.join(' ')}`);
      return { status: 0, stdout: JSON.stringify({ headRefOid: 'd'.repeat(40), baseRefName: 'main', baseRefOid: BASE, state: 'OPEN', isDraft: false }), stderr: '' };
    } });
    const result = await runHostRegate(input, deps);
    expect(result.failures[0]?.step).toBe('pr-head');
    expect(calls.some((call) => call.startsWith('git worktree add'))).toBe(false);
    expect(calls.some((call) => call.startsWith('gh pr merge'))).toBe(false);
  });
});

describe('host regate slots: bounded wait and crashed-owner reclaim', () => {
  const repo = () => { const d = mkdtempSync(join(tmpdir(), 'host-regate-slot-')); execFileSync('git', ['init', '-q', d]); return d; };
  const slotDir = (d: string, i: number) => join(d, '.git', 'elanous-host-regate', `slot-${i}`);

  test('both slots held by a live process: gives up at the deadline instead of waiting forever', async () => {
    const d = repo();
    try {
      for (const i of [0, 1]) { mkdirSync(slotDir(d, i), { recursive: true }); writeFileSync(join(slotDir(d, i), 'pid'), String(process.pid)); }
      let t = 0;
      await expect(acquireSlot(d, { waitMs: 1_000, pollMs: 1, now: () => (t += 400) })).rejects.toThrow('host regate slots busy');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('slot left by a dead process is reclaimed', async () => {
    const d = repo();
    try {
      mkdirSync(slotDir(d, 0), { recursive: true }); writeFileSync(join(slotDir(d, 0), 'pid'), '999999');
      mkdirSync(slotDir(d, 1), { recursive: true }); writeFileSync(join(slotDir(d, 1), 'pid'), String(process.pid));
      const release = await acquireSlot(d, { waitMs: 1_000, pollMs: 1 });
      expect(existsSync(join(slotDir(d, 0), 'pid'))).toBe(true);
      release();
      expect(existsSync(slotDir(d, 0))).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('needsPwaBuild — src/** feeds the PWA build', () => {
  test('non-test src changes and app changes build; test-only and docs changes do not', async () => {
    const { needsPwaBuild } = await import('./host-regate.js');
    expect(needsPwaBuild(['src/nexus/api/harness-api.ts'])).toBe(true);
    expect(needsPwaBuild(['apps/pwa/src/page.tsx'])).toBe(true);
    expect(needsPwaBuild(['src/feature.test.ts', 'src/ui/x.test.tsx'])).toBe(false);
    expect(needsPwaBuild(['docs/a.md', 'scripts/x.ts'])).toBe(false);
  });
});
