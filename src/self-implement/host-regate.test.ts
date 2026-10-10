import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSlot, defaultInterference, needsPwaBuild, runHostRegate, type HostRegateDeps } from './host-regate.js';
import { MAX_INSPECTED_TEST_FILES } from '../../scripts/ci-test-interference-gate.js';
import { releasePathHoldComment } from '../self-dev/release-path-guard.js';
import { enableLandingFreeze, disableLandingFreeze } from '../release-loop/landing-freeze.js';
import { sweepFrozenMerges } from './frozen-merges.js';
import { syncMergedPrChecklist } from '../release-loop/merged-pr-checklist.js';
import { addItem, listChecklist } from '../release-loop/checklist.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';

const testFreezeRoot = mkdtempSync(join(tmpdir(), 'host-regate-freeze-'));
afterAll(() => rmSync(testFreezeRoot, { recursive: true, force: true }));

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
    command: (bin, args, cwd) => {
      const call = `${bin} ${args.join(' ')}`;
      calls.push(call);
      if (call === 'gh pr view 42 --json headRefOid,baseRefName,baseRefOid,state,isDraft') return { status: 0, stdout: view, stderr: '' };
      if (call === 'git rev-parse --show-toplevel') return { status: 0, stdout: cwd, stderr: '' };
      if (call === 'git rev-parse HEAD') return { status: 0, stdout: BASE, stderr: '' };
      if (call === 'git rev-parse HEAD^1') return { status: 0, stdout: BASE, stderr: '' };
      if (call === 'git rev-parse HEAD^2') return { status: 0, stdout: HEAD, stderr: '' };
      if (call === 'git rev-parse FETCH_HEAD') return { status: 0, stdout: calls.at(-2) === `git fetch origin refs/heads/main` ? BASE : HEAD, stderr: '' };
      if (call === `git merge-base ${BASE} ${HEAD}`) return { status: 0, stdout: MERGE_BASE, stderr: '' };
      if (call === `git diff --name-only ${MERGE_BASE} ${HEAD}`) return { status: 0, stdout: 'src/feature.test.ts\n', stderr: '' };
      if (call === `git diff --find-renames --name-status -z ${MERGE_BASE} ${HEAD}`) return { status: 0, stdout: 'M\0src/feature.test.ts\0', stderr: '' };
      if (call === 'gh pr view 42 --json state,mergeCommit') return { status: 0, stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: SQUASH } }), stderr: '' };
      if (call === `git rev-parse ${SQUASH}^1`) return { status: 0, stdout: BASE, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    acquire: async () => Object.assign(() => { events.push('release'); }, { worktree: '/temp/regate' }),
    interference: async () => ({ passed: true }),
    log: (event) => events.push(event),
    ...overrides,
    prodFreezeRoot: overrides.prodFreezeRoot ?? overrides.freezeRoot ?? testFreezeRoot,
  };
  return { deps, calls, events };
}

describe('host regate: never merge without a measured host pass', () => {
  test('public doc changed: host calls exposure gate before merging; blocking verdict fails landing', async () => {
    const original = mock();
    const calls: string[] = [];
    const deps: HostRegateDeps = {
      ...original.deps,
      command: (bin, args, cwd, env) => {
        if (bin === 'git' && args[0] === 'diff' && args[1] === '--name-only') return { status: 0, stdout: 'release/public/docs/intro.md\n', stderr: '' };
        calls.push(`${bin} ${args.join(' ')}`);
        return original.deps.command!(bin, args, cwd, env);
      },
      runExposeGate: (_cwd, files, mode) => {
        expect(files).toEqual(['release/public/docs/intro.md']);
        expect(mode).toBe('warn');
        calls.push('expose');
        return { passed: false, log: '[expose] 1개 · 미판정 1 · fail 0' };
      },
    };
    const result = await runHostRegate(input, deps);
    expect(calls).toContain('expose');
    expect(result.failures).toEqual([{ step: 'expose', detail: '[expose] 1개 · 미판정 1 · fail 0' }]);
    expect(result.passed).toBe(false);
    expect(calls.some((call) => call.startsWith('gh pr merge'))).toBe(false);
  });

  test('non-public PR: host never invokes exposure gate', async () => {
    const { deps } = mock({ runExposeGate: () => { throw new Error('unexpected exposure check'); } });
    expect((await runHostRegate(input, deps)).passed).toBe(true);
  });
  test('host merge in a child universe reads the operational freeze even with an explicit config override', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-child-freeze-'));
    const child = join(root, 'child');
    const prod = join(root, 'operational');
    setElanousConfigDir(child);
    try {
      enableLandingFreeze({ reason: 'host cut', by: 'OP' }, prod);
      const { deps, calls } = mock({ freezeRoot: child, prodFreezeRoot: prod });
      const result = await runHostRegate(input, deps);
      expect(result).toMatchObject({ passed: true, status: 'frozen' });
      expect(calls.filter((call) => call.startsWith('gh pr merge'))).toHaveLength(0);
      expect(JSON.parse(readFileSync(join(child, 'landing-freeze-pending.json'), 'utf8'))).toMatchObject([{ prNumber: 42, headCommit: HEAD }]);
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  });

  test('freeze keeps the PR ready and defers merge; next pass after off resumes merge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'landing-freeze-regate-'));
    const path = process.env.PATH;
    try {
      // The sweep's own GitHub check (no injection): a fake gh on PATH answers from a state file —
      // OPEN until the head-pinned merge runs, then MERGED at the held head.
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(root, 'gh-state'), 'OPEN');
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '{"state":"%s","headRefOid":"${HEAD}"}\\n' "$(cat '${join(root, 'gh-state')}')"\n`);
      execFileSync('chmod', ['+x', join(bin, 'gh')]);
      process.env.PATH = `${bin}:${path ?? ''}`;
      const held = { ...input, repoRoot: root, goalFile: join(root, 'goal.md') };
      enableLandingFreeze({ reason: 'drill', by: 'MK' }, root);
      const { deps, calls } = mock({ freezeRoot: root });
      // CL-AUTO: the resumed merge must still see the goal document to apply «이 칸 완료».
      const synced: Array<string | undefined> = [];
      deps.syncMergedChecklist = (_pr, _root, goalFile) => { synced.push(goalFile); };
      const command = deps.command!;
      deps.command = (bin, args, cwd, env) => {
        if (bin === 'gh' && args[0] === 'pr' && args[1] === 'merge') writeFileSync(join(root, 'gh-state'), 'MERGED');
        return command(bin, args, cwd, env);
      };
      const frozen = await runHostRegate(held, deps);
      expect(frozen).toMatchObject({ passed: true, status: 'frozen', failures: [] });
      expect(calls.filter((call) => call.startsWith('gh pr merge'))).toHaveLength(0);
      expect(calls.filter((call) => call.startsWith('gh pr view 42 --json headRefOid'))).toHaveLength(2);
      const pending = () => JSON.parse(readFileSync(join(root, 'landing-freeze-pending.json'), 'utf8')) as unknown[];
      expect(pending()).toHaveLength(1);
      expect(pending()[0]).toMatchObject({ goalFile: join(root, 'goal.md') });
      disableLandingFreeze(root);
      // A merge that reports success but GitHub still shows OPEN stays queued.
      const notYet = await sweepFrozenMerges(async () => ({ passed: true }), root, undefined, root);
      expect(notYet).toEqual({ pending: 1, merged: 0 });
      expect(pending()).toHaveLength(1);
      const sweep = await sweepFrozenMerges((item) => runHostRegate(item, deps), root, undefined, root);
      expect(sweep).toEqual({ pending: 0, merged: 1 });
      expect(synced).toEqual([join(root, 'goal.md')]);
      expect(pending()).toEqual([]);
      expect(calls.filter((call) => call.startsWith('gh pr merge'))).toEqual([`gh pr merge 42 --squash --match-head-commit ${HEAD}`]);
    } finally {
      if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the in-flight marker is held until the merge has been confirmed, not just sent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'landing-regate-marker-'));
    try {
      const { inFlightLandingMerges } = await import('../release-loop/landing-freeze.js');
      const { deps } = mock({ freezeRoot: root });
      const command = deps.command!;
      let markersAtConfirm = -1;
      deps.command = (bin, args, cwd, env) => {
        if (bin === 'gh' && args.join(' ') === 'pr view 42 --json state,mergeCommit') markersAtConfirm = inFlightLandingMerges(root);
        return command(bin, args, cwd, env);
      };
      expect((await runHostRegate(input, deps)).passed).toBe(true);
      expect(markersAtConfirm).toBe(1);
      expect(inFlightLandingMerges(root)).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('confirmed main merge invokes checklist sync after confirmation; verifyOnly never does', async () => {
    const synced: string[] = [];
    const { deps, calls } = mock({ syncMergedChecklist: (number, cwd, goalFile) => { synced.push(`${number} ${cwd} ${goalFile}`); } });
    const measured = await runHostRegate({ ...input, goalFile: '/repo/goal.txt', verifyOnly: true }, deps);
    expect(measured.passed).toBe(true);
    expect(synced).toEqual([]);
    expect(calls).not.toContain(`gh pr merge 42 --squash --match-head-commit ${HEAD}`);
    const landed = await runHostRegate({ ...input, goalFile: '/repo/goal.txt' }, deps);
    expect(landed.passed).toBe(true);
    expect(synced).toEqual(['42 /repo /repo/goal.txt']);
    expect(calls.indexOf('gh pr view 42 --json state,mergeCommit')).toBeLessThan(calls.indexOf(`git fetch origin ${SQUASH}`));
  });

  test('confirmed main merge with a line-head 칸: X label writes one #42 history row and preserves yellow without declaration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-regate-checklist-'));
    setElanousConfigDir(root);
    try {
      addItem('0.2.12', { id: 'X', title: 'X' });
      const events: string[] = [];
      const { deps } = mock({ syncMergedChecklist: (number, cwd, goalFile) => syncMergedPrChecklist(number, cwd, goalFile, {
        readPr: () => ({ state: 'MERGED', baseRefName: 'main', title: 'misc', body: 'Implements release automation\n칸: X — release automation', mergedAt: '2026-10-02T00:00:00Z' }),
        versions: () => ['0.2.12'], log: (_category, event) => { events.push(event); },
      }) });
      expect((await runHostRegate(input, deps)).passed).toBe(true);
      const snapshot = listChecklist('0.2.12');
      expect(snapshot.items.find(({ id }) => id === 'X')).toMatchObject({ id: 'X', evidence: '#42', status: 'yellow' });
      expect(snapshot.history.filter(({ field }) => field === 'evidence.add')).toHaveLength(1);
      expect(snapshot.history.filter(({ field }) => field === 'status')).toHaveLength(0);
      expect(events).toEqual(['merged-pr-evidence-added']);
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  });

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
    expect(calls.indexOf('bun scripts/ci-isolation-hardcode-gate.ts --changed-files src/feature.test.ts')).toBeLessThan(calls.indexOf(`gh pr merge 42 --squash --match-head-commit ${HEAD}`));
    expect(calls).toContain('bun bin/elanous.mjs --test nexus build'); // #25399: mock worktree has no PWA graph — reachability fails closed.
    expect(calls).toContain('git reset --hard');
    expect(calls).toContain('git clean -fdx -e node_modules -e .next -e *.tsbuildinfo');
    expect(calls.some((call) => call.startsWith('git worktree remove'))).toBe(false);
    expect(events).toContain('release');
  });

  test('legacy acquire without a slot removes its real Git worktree and registration even without removeTemp', async () => {
    const d = mkdtempSync(join(tmpdir(), 'host-regate-legacy-'));
    const tree = join(d, 'candidate');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      git('config', 'user.name', 'Regate Test');
      git('config', 'user.email', 'regate@test.local');
      writeFileSync(join(d, 'feature.test.ts'), 'base\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(d, 'feature.test.ts'), 'head\n');
      git('commit', '-qam', 'head');
      const head = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/heads/main', base);
      git('update-ref', 'refs/pull/42/head', head);
      git('remote', 'add', 'origin', d);
      const calls: string[] = [];
      const view = JSON.stringify({ headRefOid: head, baseRefName: 'main', baseRefOid: base, state: 'OPEN', isDraft: false });
      const deps: HostRegateDeps = {
        acquire: async () => () => {}, makeTemp: () => tree,
        command: (bin, args, cwd) => {
          calls.push(`${bin} ${args.join(' ')}`);
          if (bin === 'gh') return { status: 0, stdout: view, stderr: '' };
          if (bin === 'bun') return { status: 0, stdout: '', stderr: '' };
          const r = spawnSync(bin, [...args], { cwd, encoding: 'utf8' });
          return { status: r.status, stdout: r.stdout, stderr: r.stderr };
        },
        interference: async () => ({ passed: false, detail: 'gate failed' }), log: () => {},
      };
      expect((await runHostRegate({ prNumber: 42, headCommit: head, repoRoot: d }, deps)).failures[0]?.step).toBe('test-interference');
      expect(calls).toContain(`git worktree add --detach ${tree} ${base}`);
      expect(calls).toContain(`git worktree remove --force ${tree}`);
      expect(existsSync(tree)).toBe(false);
      expect(git('worktree', 'list', '--porcelain')).not.toContain(tree);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('a warm locked slot checks out base without worktree add and cleans after a failed gate while preserving caches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-regate-warm-'));
    const slot = join(root, 'slot');
    mkdirSync(join(slot, 'apps/pwa/.next'), { recursive: true });
    mkdirSync(join(slot, 'node_modules'), { recursive: true });
    writeFileSync(join(slot, 'node_modules/cached'), 'keep');
    writeFileSync(join(slot, 'apps/pwa/.next/cached'), 'keep');
    writeFileSync(join(slot, 'build.tsbuildinfo'), 'keep');
    const { deps, calls } = mock({
      acquire: async () => Object.assign(() => {}, { worktree: slot }),
      interference: async () => ({ passed: false, detail: 'gate failed' }),
    });
    const command = deps.command!;
    deps.command = (bin, args, cwd, env) => {
      if (bin === 'git' && args[0] === 'clean') {
        rmSync(join(slot, 'transient'), { force: true });
      }
      if (bin === 'git' && args[0] === 'merge') writeFileSync(join(slot, 'transient'), 'candidate');
      return command(bin, args, cwd, env);
    };
    try {
      for (let i = 0; i < 2; i++) {
        const result = await runHostRegate(input, deps);
        expect(result.failures[0]?.step).toBe('test-interference');
        expect(existsSync(join(slot, 'transient'))).toBe(false);
        expect(readFileSync(join(slot, 'node_modules/cached'), 'utf8')).toBe('keep');
        expect(readFileSync(join(slot, 'apps/pwa/.next/cached'), 'utf8')).toBe('keep');
        expect(readFileSync(join(slot, 'build.tsbuildinfo'), 'utf8')).toBe('keep');
      }
      expect(calls.filter((call) => call.startsWith('git worktree add'))).toHaveLength(0);
      expect(calls.filter((call) => call === `git checkout --detach ${BASE}`)).toHaveLength(2);
      expect(calls.filter((call) => call === 'git clean -fdx -e node_modules -e .next -e *.tsbuildinfo')).toHaveLength(4);
      expect(calls.some((call) => call.startsWith('gh pr merge'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test.each(['scripts/release-loop/publish.ts', 'graphs/release/check.yaml', 'src/release-loop/manifest.ts'])(
    'host handoff holds %s before any merge and annotates the PR', async (path) => {
      const original = mock();
      const command = original.deps.command!;
      const { deps, calls } = mock({ command: (bin, args, cwd, env) => {
        const call = `${bin} ${args.join(' ')}`;
        calls.push(call);
        if (call === `git diff --name-only ${MERGE_BASE} ${HEAD}`) return { status: 0, stdout: `${path}\n`, stderr: '' };
        if (call === `git diff --find-renames --name-status -z ${MERGE_BASE} ${HEAD}`) return { status: 0, stdout: `M\0${path}\0`, stderr: '' };
        if (call === 'gh label list --search elanous:release-path --json name') return { status: 0, stdout: '[]', stderr: '' };
        return command(bin, args, cwd, env);
      } });
      const result = await runHostRegate(input, deps);
      expect(result).toMatchObject({ passed: false, failures: [{ step: 'release-path-hold', detail: `OP approval required: ${path}` }] });
      expect(calls).not.toContain(`gh pr merge 42 --squash --match-head-commit ${HEAD}`);
      expect(calls).toContain('gh label create elanous:release-path --color D93F0B --description Release path requires OP approval');
      expect(calls).toContain('gh pr edit 42 --add-label elanous:release-path');
      expect(calls).toContain(`gh pr comment 42 --body ${releasePathHoldComment(path)}`);
    },
  );

  test.each(['scripts/release-loop/publish.ts', 'graphs/release/check.yaml', 'src/release-loop/manifest.ts'])(
    'rename from %s into an unprotected path cannot bypass host hold', async (path) => {
      const original = mock().deps.command!;
      const { deps, calls } = mock({ command: (bin, args, cwd, env) => {
        const call = `${bin} ${args.join(' ')}`;
        calls.push(call);
        if (call === `git diff --name-only ${MERGE_BASE} ${HEAD}`) return { status: 0, stdout: 'src/ordinary.ts\n', stderr: '' };
        if (call === `git diff --find-renames --name-status -z ${MERGE_BASE} ${HEAD}`) return { status: 0, stdout: `R100\0${path}\0src/ordinary.ts\0`, stderr: '' };
        if (call === 'gh label list --search elanous:release-path --json name') return { status: 0, stdout: '[]', stderr: '' };
        return original(bin, args, cwd, env);
      } });
      const result = await runHostRegate(input, deps);
      expect(result).toMatchObject({ passed: false, failures: [{ step: 'release-path-hold', detail: `OP approval required: ${path}` }] });
      expect(calls).not.toContain(`gh pr merge 42 --squash --match-head-commit ${HEAD}`);
      expect(calls).toContain('gh pr edit 42 --add-label elanous:release-path');
      expect(calls).toContain(`gh pr comment 42 --body ${releasePathHoldComment(path)}`);
    },
  );

  test('verifyOnly measures a release-path PR without auto-merging or applying the hold', async () => {
    const original = mock();
    const command = original.deps.command!;
    const { deps, calls } = mock({ command: (bin, args, cwd, env) => {
      const call = `${bin} ${args.join(' ')}`;
      calls.push(call);
      if (call === `git diff --name-only ${MERGE_BASE} ${HEAD}`) return { status: 0, stdout: 'src/release-loop/release-schedule.ts\n', stderr: '' };
      return command(bin, args, cwd, env);
    } });
    const result = await runHostRegate({ ...input, verifyOnly: true }, deps);
    expect(result).toMatchObject({ passed: true, status: 'passed' });
    expect(calls.some((call) => call.startsWith('gh pr merge') || call.startsWith('gh pr edit'))).toBe(false);
  });

  test('verifyOnly runs host gates without merging; landing path still merges', async () => {
    const { deps, calls } = mock();
    const result = await runHostRegate({ ...input, verifyOnly: true }, deps);
    expect(result).toMatchObject({ passed: true, status: 'passed' });
    expect(calls).toContain('bun scripts/ci-isolation-hardcode-gate.ts --changed-files src/feature.test.ts');
    expect(calls.some((call) => call.startsWith('gh pr merge'))).toBe(false);
    expect(calls.filter((call) => call === 'gh pr view 42 --json headRefOid,baseRefName,baseRefOid,state,isDraft')).toHaveLength(2);
  });

  test('verifyOnly measures on the current base tip even when the PR records an older base, and reports that tip', async () => {
    const OLD = 'e'.repeat(40);
    const staleView = JSON.stringify({ headRefOid: HEAD, baseRefName: 'main', baseRefOid: OLD, state: 'OPEN', isDraft: false });
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    const base = mock().deps.command!;
    const calls: string[] = [];
    const { deps } = mock({ command: (bin, args, cwd, env) => {
      calls.push(`${bin} ${args.join(' ')}`);
      if (`${bin} ${args.join(' ')}` === 'gh pr view 42 --json headRefOid,baseRefName,baseRefOid,state,isDraft') return { status: 0, stdout: staleView, stderr: '' };
      if (bin === 'bun' && args[0] === 'scripts/ci-typecheck-changed.ts') envs.push(env);
      return base(bin, args, cwd, env);
    } });
    const verified = await runHostRegate({ ...input, verifyOnly: true }, deps);
    expect(verified).toMatchObject({ passed: true, status: 'passed', baseCommit: BASE });
    expect(calls).toContain(`git worktree add --detach /temp/regate ${BASE}`);
    expect(envs.at(-1)?.TSC_BASE_REF).toBe(BASE);
    expect(calls.filter((call) => call.startsWith('gh pr merge'))).toHaveLength(0);

    // REGATE-STALE-BASE: the landing path no longer fails on a stale recorded PR base — it measures on the fetched tip too.
    const landingCalls: string[] = [];
    const landing = await runHostRegate(input, mock({ command: (bin, args, cwd, env) => {
      landingCalls.push(`${bin} ${args.join(' ')}`);
      return `${bin} ${args.join(' ')}` === 'gh pr view 42 --json headRefOid,baseRefName,baseRefOid,state,isDraft'
        ? { status: 0, stdout: staleView, stderr: '' } : base(bin, args, cwd, env);
    } }).deps);
    expect(landing.failures.some((failure) => failure.detail.includes('fetched PR base differs from checked SHA'))).toBe(false);
    expect(landingCalls).toContain(`git worktree add --detach /temp/regate ${BASE}`);
    expect(landingCalls.some((call) => call.startsWith(`git worktree add --detach /temp/regate ${OLD}`))).toBe(false);
  });

  test('verifyOnly keeps unmeasured distinct from a failed gate and cannot merge', async () => {
    const { deps, calls } = mock();
    const command = deps.command!;
    deps.command = (bin, args, cwd, env) => bin === 'git' && args[0] === 'worktree' && args[1] === 'add'
      ? { status: 1, stdout: '', stderr: 'worktree unavailable' } : command(bin, args, cwd, env);
    const result = await runHostRegate({ ...input, verifyOnly: true }, deps);
    expect(result).toMatchObject({ passed: false, status: 'unmeasured', failures: [{ step: 'worktree' }] });
    expect(calls.some((call) => call.startsWith('gh pr merge'))).toBe(false);
  });

  test('a new ~/.elanous hardcoding fails the host regate before merge (isolation gate on the changed files)', async () => {
    const base = mock();
    const { deps, calls } = mock({ command: (bin, args, cwd, env) => {
      if (bin === 'bun' && args[0] === 'scripts/ci-isolation-hardcode-gate.ts') {
        calls.push(`${bin} ${args.join(' ')}`);
        return { status: 1, stdout: '', stderr: '[isolation-gate] FAIL — src/feature.test.ts: 0 → 1' };
      }
      return base.deps.command!(bin, args, cwd, env);
    } });
    const result = await runHostRegate(input, deps);
    expect(result.passed).toBe(false);
    expect(JSON.stringify(result.failures)).toContain('isolation-gate');
    expect(calls).toContain('bun scripts/ci-isolation-hardcode-gate.ts --changed-files src/feature.test.ts');
    expect([...calls, ...base.calls].some((call) => call.startsWith('gh pr merge'))).toBe(false);
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
    mkdirSync(join(workspace, 'apps/pwa/node_modules/next'), { recursive: true });
    writeFileSync(join(workspace, 'apps/pwa/node_modules/next/package.json'), '{}');
    mkdirSync(join(workspace, 'node_modules/typescript'), { recursive: true });
    writeFileSync(join(workspace, 'node_modules/typescript/package.json'), '{}');
    mkdirSync(join(tree, 'apps/pwa'), { recursive: true });
    const { deps, calls } = mock();
    const command = deps.command!;
    deps.acquire = async () => Object.assign(() => {}, { worktree: tree });
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

  test('an install source without installed dependencies gets a fresh install in the candidate, not an empty link', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-regate-empty-'));
    const workspace = join(root, 'repo');
    const tree = join(root, 'candidate');
    mkdirSync(join(workspace, 'node_modules'), { recursive: true });
    mkdirSync(join(workspace, 'apps/pwa/node_modules'), { recursive: true });
    mkdirSync(join(tree, 'apps/pwa'), { recursive: true });
    const { deps, calls } = mock();
    const command = deps.command!;
    deps.acquire = async () => Object.assign(() => {}, { worktree: tree });
    const installs: string[] = [];
    deps.command = (bin, args, cwd, env) => {
      if (bin === 'git' && args[0] === 'diff' && args[1] === '--name-only') {
        calls.push(`${bin} ${args.join(' ')}`);
        return { status: 0, stdout: 'apps/pwa/src/page.test.ts\n', stderr: '' };
      }
      if (bin === 'bun' && args.join(' ') === 'install --frozen-lockfile') installs.push(cwd);
      return command(bin, args, cwd, env);
    };
    try {
      expect(await runHostRegate({ ...input, repoRoot: workspace }, deps)).toMatchObject({ passed: true });
      expect(installs).toEqual([tree, join(tree, 'apps/pwa')]);
      expect(existsSync(join(tree, 'node_modules'))).toBe(false);
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

  test('worktree creation failure: unmeasured, never merged, comment and lock release', async () => {
    const { deps, calls, events } = mock();
    const command = deps.command!;
    deps.command = (bin, args, cwd, env) => bin === 'git' && args[0] === 'worktree' && args[1] === 'add'
      ? { status: 1, stdout: '', stderr: 'worktree unavailable' } : command(bin, args, cwd, env);
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
  // macOS tmpdir() 는 /var → /private/var 심볼릭 링크다 — git 이 돌려주는 실경로와 맞추려고 실경로로 만든다.
  const repo = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'host-regate-slot-'))); execFileSync('git', ['init', '-q', d]); return d; };
  const slotDir = (d: string, i: number) => join(d, '.git', 'elanous-host-regate', `slot-${i}`);

  test('both slots held by a live process: gives up at the deadline instead of waiting forever', async () => {
    const d = repo();
    try {
      for (const i of [0, 1]) { mkdirSync(slotDir(d, i), { recursive: true }); writeFileSync(join(slotDir(d, i), 'pid'), String(process.pid)); }
      let t = 0;
      await expect(acquireSlot(d, { waitMs: 1_000, pollMs: 1, now: () => (t += 400) })).rejects.toThrow('host regate slots busy');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('each of the two slots owns a stable worktree independent of its ephemeral lock', async () => {
    const d = repo();
    try {
      const first = await acquireSlot(d);
      const second = await acquireSlot(d);
      expect(first.worktree).toBe(join(d, '.git/elanous-host-regate/worktree-0'));
      expect(second.worktree).toBe(join(d, '.git/elanous-host-regate/worktree-1'));
      first();
      second();
      expect(existsSync(slotDir(d, 0))).toBe(false);
      const again = await acquireSlot(d);
      expect(again.worktree).toBe(first.worktree);
      again();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('real Git reuses the same slot worktree after a failed gate and retains ignored caches', async () => {
    const d = repo();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' }).trim();
    try {
      git('config', 'user.name', 'Regate Test');
      git('config', 'user.email', 'regate@test.local');
      writeFileSync(join(d, 'feature.test.ts'), 'base\n');
      writeFileSync(join(d, 'unchanged.txt'), 'stable\n');
      mkdirSync(join(d, 'unchanged'));
      for (let i = 0; i < 128; i++) writeFileSync(join(d, 'unchanged', `${i}.txt`), `${i}\n${'stable'.repeat(680)}`);
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(d, 'feature.test.ts'), 'head\n');
      git('commit', '-qam', 'head');
      const head = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/heads/main', base);
      git('update-ref', 'refs/pull/42/head', head);
      git('remote', 'add', 'origin', d);
      const calls: string[] = [];
      let writeBlocks = 0;
      const view = JSON.stringify({ headRefOid: head, baseRefName: 'main', baseRefOid: base, state: 'OPEN', isDraft: false });
      const deps: HostRegateDeps = {
        command: (bin, args, cwd) => {
          calls.push(`${bin} ${args.join(' ')}`);
          if (bin === 'gh') return { status: 0, stdout: view, stderr: '' };
          if (bin === 'bun') return { status: 0, stdout: '', stderr: '' };
          // POSIX wait4 child rusage via Python: count all Git output blocks, including checkout and clean.
          const measure = `import resource, subprocess, sys\nbefore = resource.getrusage(resource.RUSAGE_CHILDREN).ru_oublock\nr = subprocess.run(sys.argv[1:], capture_output=True, text=True)\nafter = resource.getrusage(resource.RUSAGE_CHILDREN).ru_oublock\nsys.stdout.write(r.stdout)\nsys.stderr.write(r.stderr + '\\nREGATE_WRITE_BLOCKS=' + str(after - before) + '\\n')\nsys.exit(r.returncode)`;
          const measured = spawnSync('python3', ['-c', measure, bin, ...args], { cwd, encoding: 'utf8' });
          const match = measured.stderr?.match(/REGATE_WRITE_BLOCKS=(\d+)/);
          if (!match) throw new Error(`Git block-I/O measurement unavailable: ${measured.error ?? measured.stderr}`);
          writeBlocks += Number(match[1]);
          return { status: measured.status, stdout: measured.stdout, stderr: measured.stderr };
        },
        interference: async () => ({ passed: false, detail: 'gate failed' }),
        log: () => {},
      };
      const pr = { prNumber: 42, headCommit: head, repoRoot: d };
      const tree = join(d, '.git/elanous-host-regate/worktree-0');
      expect(existsSync(join(tree, 'unchanged.txt'))).toBe(false);
      const coldStart = performance.now();
      const coldResult = await runHostRegate(pr, deps);
      expect(coldResult.failures[0]).toMatchObject({ step: 'test-interference' });
      const coldMs = performance.now() - coldStart;
      const coldBytes = writeBlocks * 512; // POSIX ru_oublock units are 512 bytes.
      expect(existsSync(tree)).toBe(true);
      mkdirSync(join(tree, 'node_modules'), { recursive: true });
      mkdirSync(join(tree, 'apps/pwa/.next'), { recursive: true });
      for (const path of ['node_modules/cached', 'apps/pwa/.next/cached', 'build.tsbuildinfo']) writeFileSync(join(tree, path), 'warm');
      writeFileSync(join(tree, 'transient'), 'remove');
      const before = calls.length;
      writeBlocks = 0;
      const unchanged = statSync(join(tree, 'unchanged.txt'), { bigint: true });
      const warmStart = performance.now();
      expect((await runHostRegate(pr, deps)).failures[0]?.step).toBe('test-interference');
      const warmMs = performance.now() - warmStart;
      const unchangedAfter = statSync(join(tree, 'unchanged.txt'), { bigint: true });
      const warmBytes = writeBlocks * 512;
      console.log(`[regate-io] runHostRegate Git child writes (wait4 ru_oublock, 512-byte blocks): cold=${coldBytes} bytes warm=${warmBytes} bytes; elapsed cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(1)}ms; worktree-add=${calls.slice(0, before).filter((call) => call.startsWith('git worktree add')).length}→${calls.slice(before).filter((call) => call.startsWith('git worktree add')).length}`);
      // ru_oublock 는 Linux(게이트 Pod)에서만 블록 쓰기를 센다 — macOS APFS 는 0 을 돌려준다. 쓰기량 비교는 Linux 에서만, 재사용 행동은 어디서나 본다.
      if (process.platform === 'linux') {
        expect(coldBytes).toBeGreaterThan(0);
        expect(warmBytes).toBeLessThan(coldBytes);
      }
      expect(unchangedAfter.ino).toBe(unchanged.ino);
      expect(unchangedAfter.mtimeNs).toBe(unchanged.mtimeNs);
      expect(calls.slice(before).filter((call) => call.startsWith('git worktree add'))).toHaveLength(0);
      expect(calls.slice(before)).toContain(`git checkout --detach ${base}`);
      expect(git('-C', tree, 'rev-parse', 'HEAD^1')).toBe(base);
      expect(git('-C', tree, 'diff', '--name-only')).toBe('');
      expect(git('-C', tree, 'diff', '--cached', '--name-only')).toBe('');
      expect(existsSync(join(tree, 'transient'))).toBe(false);
      for (const path of ['node_modules/cached', 'apps/pwa/.next/cached', 'build.tsbuildinfo']) expect(readFileSync(join(tree, path), 'utf8')).toBe('warm');
      expect(calls.some((call) => call.startsWith('git worktree remove'))).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 120_000); // 실물 git ⊕ python 측정 — 기본 5초를 넘는다

  test('a killed worktree add leaves an unowned partial directory; next run refuses to erase it', async () => {
    const d = repo();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' }).trim();
    try {
      git('config', 'user.name', 'Regate Test');
      git('config', 'user.email', 'regate@test.local');
      writeFileSync(join(d, 'feature.test.ts'), 'base\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(d, 'feature.test.ts'), 'head\n');
      git('commit', '-qam', 'head');
      const head = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/heads/main', base);
      git('update-ref', 'refs/pull/42/head', head);
      git('remote', 'add', 'origin', d);
      const pr = { prNumber: 42, headCommit: head, repoRoot: d };
      const tree = join(d, '.git/elanous-host-regate/worktree-0');
      const view = JSON.stringify({ headRefOid: head, baseRefName: 'main', baseRefOid: base, state: 'OPEN', isDraft: false });
      let interrupt = true;
      const calls: string[] = [];
      const deps: HostRegateDeps = {
        command: (bin, args, cwd) => {
          calls.push(`${bin} ${args.join(' ')}`);
          if (bin === 'gh') return { status: 0, stdout: view, stderr: '' };
          if (bin === 'bun') return { status: 0, stdout: '', stderr: '' };
          if (interrupt && bin === 'git' && args[0] === 'worktree' && args[1] === 'add') {
            mkdirSync(tree, { recursive: true });
            writeFileSync(join(tree, 'partial'), 'interrupted checkout');
            return { status: 1, stdout: '', stderr: 'interrupted' };
          }
          const r = spawnSync(bin, [...args], { cwd, encoding: 'utf8' });
          return { status: r.status, stdout: r.stdout, stderr: r.stderr };
        },
        interference: async () => ({ passed: false, detail: 'gate failed' }),
        log: () => {},
      };
      expect((await runHostRegate(pr, deps)).failures[0]?.step).toBe('worktree');
      expect(existsSync(join(tree, 'partial'))).toBe(true);
      writeFileSync(join(tree, '.git'), 'gitdir: /invalid/interrupted-worktree\n');
      interrupt = false;
      expect((await runHostRegate(pr, deps)).failures[0]?.step).toBe('worktree');
      expect(readFileSync(join(tree, 'partial'), 'utf8')).toBe('interrupted checkout');
      expect(calls.filter((call) => call.startsWith('git worktree add'))).toHaveLength(1);
      expect(calls).not.toContain('git reset --hard');
      expect(calls).not.toContain('git clean -fdx -e node_modules -e .next -e *.tsbuildinfo');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('a missing slot directory repairs only its stale registration before adding the worktree', async () => {
    const d = repo();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' }).trim();
    try {
      git('config', 'user.name', 'Regate Test');
      git('config', 'user.email', 'regate@test.local');
      writeFileSync(join(d, 'feature.test.ts'), 'base\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(d, 'feature.test.ts'), 'head\n');
      git('commit', '-qam', 'head');
      const head = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/heads/main', base);
      git('update-ref', 'refs/pull/42/head', head);
      git('remote', 'add', 'origin', d);
      const tree = join(d, '.git/elanous-host-regate/worktree-0');
      const other = join(d, '.git/elanous-host-regate/worktree-1');
      mkdirSync(join(d, '.git/elanous-host-regate'), { recursive: true });
      git('worktree', 'add', '--detach', tree, base);
      git('worktree', 'add', '--detach', other, base);
      const otherRegistration = readFileSync(join(other, '.git'), 'utf8').trim().slice('gitdir: '.length);
      rmSync(tree, { recursive: true });
      rmSync(other, { recursive: true });
      const calls: string[] = [];
      const view = JSON.stringify({ headRefOid: head, baseRefName: 'main', baseRefOid: base, state: 'OPEN', isDraft: false });
      const deps: HostRegateDeps = {
        command: (bin, args, cwd) => {
          calls.push(`${bin} ${args.join(' ')}`);
          if (bin === 'gh') return { status: 0, stdout: view, stderr: '' };
          if (bin === 'bun') return { status: 0, stdout: '', stderr: '' };
          const r = spawnSync(bin, [...args], { cwd, encoding: 'utf8' });
          return { status: r.status, stdout: r.stdout, stderr: r.stderr };
        },
        interference: async () => ({ passed: false, detail: 'gate failed' }),
        log: () => {},
      };
      expect((await runHostRegate({ prNumber: 42, headCommit: head, repoRoot: d }, deps)).failures[0]?.step).toBe('test-interference');
      expect(calls).toContain(`git worktree add --detach ${tree} ${base}`);
      expect(calls.some((call) => call.startsWith('git worktree prune'))).toBe(false);
      expect(existsSync(otherRegistration)).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('a mismatched registration refuses cleanup without touching another slot', async () => {
    const d = repo();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' }).trim();
    try {
      git('config', 'user.name', 'Regate Test');
      git('config', 'user.email', 'regate@test.local');
      writeFileSync(join(d, 'feature.test.ts'), 'base\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(d, 'feature.test.ts'), 'head\n');
      git('commit', '-qam', 'head');
      const head = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/heads/main', base);
      git('update-ref', 'refs/pull/42/head', head);
      git('remote', 'add', 'origin', d);
      const tree = join(d, '.git/elanous-host-regate/worktree-0');
      const other = join(d, '.git/elanous-host-regate/worktree-1');
      mkdirSync(join(d, '.git/elanous-host-regate'), { recursive: true });
      git('worktree', 'add', '--detach', tree, base);
      git('worktree', 'add', '--detach', other, base);
      const otherRegistration = readFileSync(join(other, '.git'), 'utf8').trim().slice('gitdir: '.length);
      rmSync(other, { recursive: true }); // A stale registration belonging to another slot must not be pruned.
      writeFileSync(join(tree, '.git'), 'gitdir: /invalid/interrupted-worktree\n');
      const calls: string[] = [];
      const view = JSON.stringify({ headRefOid: head, baseRefName: 'main', baseRefOid: base, state: 'OPEN', isDraft: false });
      const deps: HostRegateDeps = {
        command: (bin, args, cwd) => {
          calls.push(`${bin} ${args.join(' ')}`);
          if (bin === 'gh') return { status: 0, stdout: view, stderr: '' };
          if (bin === 'bun') return { status: 0, stdout: '', stderr: '' };
          const r = spawnSync(bin, [...args], { cwd, encoding: 'utf8' });
          return { status: r.status, stdout: r.stdout, stderr: r.stderr };
        },
        interference: async () => ({ passed: false, detail: 'gate failed' }),
        log: () => {},
      };
      const repaired = await runHostRegate({ prNumber: 42, headCommit: head, repoRoot: d }, deps);
      expect(repaired.failures[0]).toMatchObject({ step: 'worktree' });
      expect(calls.some((call) => call.startsWith('git worktree prune'))).toBe(false);
      expect(calls).not.toContain(`git worktree add --detach ${tree} ${base}`);
      expect(calls).not.toContain('git reset --hard');
      expect(readFileSync(join(tree, '.git'), 'utf8')).toBe('gitdir: /invalid/interrupted-worktree\n');
      expect(existsSync(otherRegistration)).toBe(true);
      expect(readFileSync(join(otherRegistration, 'gitdir'), 'utf8').trim()).toBe(join(other, '.git'));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('foreign Git repository at a locked slot is never reset, cleaned, or deleted', async () => {
    const d = repo();
    const foreign = join(d, '.git/elanous-host-regate/worktree-0');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' }).trim();
    try {
      git('config', 'user.name', 'Regate Test');
      git('config', 'user.email', 'regate@test.local');
      writeFileSync(join(d, 'feature.test.ts'), 'base\n');
      git('add', '.'); git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(d, 'feature.test.ts'), 'head\n');
      git('commit', '-qam', 'head');
      const head = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/heads/main', base);
      git('update-ref', 'refs/pull/42/head', head);
      git('remote', 'add', 'origin', d);
      const foreignRepo = join(d, 'foreign-repo');
      execFileSync('git', ['init', '-q', foreignRepo]);
      execFileSync('git', ['-C', foreignRepo, 'config', 'user.name', 'Other Repo']);
      execFileSync('git', ['-C', foreignRepo, 'config', 'user.email', 'other@test.local']);
      writeFileSync(join(foreignRepo, 'tracked'), 'foreign base');
      execFileSync('git', ['-C', foreignRepo, 'add', '.']);
      execFileSync('git', ['-C', foreignRepo, 'commit', '-qm', 'other base']);
      mkdirSync(join(d, '.git/elanous-host-regate'), { recursive: true });
      execFileSync('git', ['-C', foreignRepo, 'worktree', 'add', '--detach', foreign]);
      writeFileSync(join(foreign, 'untouched'), 'foreign data');
      const calls: string[] = [];
      const view = JSON.stringify({ headRefOid: head, baseRefName: 'main', baseRefOid: base, state: 'OPEN', isDraft: false });
      const result = await runHostRegate({ prNumber: 42, headCommit: head, repoRoot: d }, {
        command: (bin, args, cwd) => {
          calls.push(`${bin} ${args.join(' ')}`);
          if (bin === 'gh') return { status: 0, stdout: view, stderr: '' };
          const r = spawnSync(bin, [...args], { cwd, encoding: 'utf8' });
          return { status: r.status, stdout: r.stdout, stderr: r.stderr };
        },
        interference: async () => { throw new Error('foreign worktree passed ownership check'); }, log: () => {},
      });
      expect(result.failures[0]).toMatchObject({ step: 'worktree' });
      expect(readFileSync(join(foreign, 'untouched'), 'utf8')).toBe('foreign data');
      expect(calls).not.toContain('git reset --hard');
      expect(calls).not.toContain('git clean -fdx -e node_modules -e .next -e *.tsbuildinfo');
      expect(calls.filter((call) => call.startsWith('git worktree add'))).toHaveLength(0);
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

describe('needsPwaBuild — pr-land PWA reachability', () => {
  test('unreachable src skips; reachable src, app and uncertainty build; docs skip', () => {
    const graph = () => ({ files: new Set(['src/shared/reachable.ts']), uncertain: null });
    expect(needsPwaBuild(['src/steward/triage.ts'], '/repo', graph)).toBe(false);
    expect(needsPwaBuild(['src/steward/triage.ts', 'src/shared/reachable.ts'], '/repo', graph)).toBe(true);
    expect(needsPwaBuild(['src/shared/reachable.ts'], '/repo', graph)).toBe(true);
    expect(needsPwaBuild(['apps/pwa/src/page.tsx'], '/repo', graph)).toBe(true);
    expect(needsPwaBuild(['src/feature.test.ts', 'src/ui/x.test.tsx'], '/repo', graph)).toBe(false);
    expect(needsPwaBuild(['scripts/x.ts'], '/repo', graph)).toBe(false);
    expect(needsPwaBuild(['docs/a.md'], '/repo', graph)).toBe(false);
    expect(needsPwaBuild(['src/steward/triage.ts'], '/repo', () => ({ files: new Set(), uncertain: 'unreadable' }))).toBe(true);
  });

  test.each([
    ['src/steward/triage.ts', 0],
    ['src/shared/reachable.ts', 1],
  ])('runHostRegate builds %s exactly %i time(s) from the candidate graph', async (changed, builds) => {
    const tree = mkdtempSync(join(tmpdir(), 'host-regate-reach-'));
    const write = (file: string, body: string) => {
      mkdirSync(join(tree, file, '..'), { recursive: true });
      writeFileSync(join(tree, file), body);
    };
    write('apps/pwa/tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', noEmit: true }, include: ['src/**/*.ts'] }));
    write('apps/pwa/src/page.ts', "import { value } from '../../../src/shared/reachable'; export const page = value;\n");
    write('src/shared/reachable.ts', 'export const value = 1;\n');
    write('src/steward/triage.ts', 'export const triage = 1;\n');
    const { deps, calls } = mock();
    const command = deps.command!;
    deps.makeTemp = () => tree;
    deps.removeTemp = () => {};
    deps.command = (bin, args, cwd, env) => {
      const call = `${bin} ${args.join(' ')}`;
      if (call === `git diff --name-only ${MERGE_BASE} ${HEAD}`) return { status: 0, stdout: `${changed}\n`, stderr: '' };
      return command(bin, args, cwd, env);
    };
    try {
      expect(await runHostRegate({ ...input, verifyOnly: true }, deps)).toMatchObject({ passed: true, status: 'passed' });
      expect(calls.filter((call) => call === 'bun bin/elanous.mjs --test nexus build')).toHaveLength(builds);
      expect(calls.filter((call) => call === 'bun install --frozen-lockfile')).toHaveLength(1 + builds);
      expect(calls.some((call) => call.startsWith('gh pr merge'))).toBe(false);
    } finally { rmSync(tree, { recursive: true, force: true }); }
  });
});

describe('host regate interference: neighbour tests never push the selection over the inspection cap', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-regate-neighbors-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src/big'), { recursive: true });
  for (let i = 0; i < 20; i++) writeFileSync(join(root, 'src/big', `n${String(i).padStart(2, '0')}.test.ts`), '');
  const clean = (paths: readonly string[]) => ({ order: [...paths], isolated: [], combined: { status: 'measured', fail: 0 }, status: 'no-interference', isolatedFailures: 0, combinedFailures: 0, difference: 0 }) as never;

  test('changed test in a directory with 20 siblings is measured, changed test kept, selection ≤ cap', async () => {
    const seen: string[][] = [];
    const verdict = await defaultInterference(['src/big/n17.test.ts', 'src/big/impl.ts'], root, { detect: async (paths) => { seen.push([...paths]); return clean(paths); } });
    expect(verdict.unmeasured).toBeUndefined();
    expect(verdict.passed).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.length).toBeLessThanOrEqual(MAX_INSPECTED_TEST_FILES);
    expect(seen[0]!.length).toBe(MAX_INSPECTED_TEST_FILES);
    expect(seen[0]).toContain('src/big/n17.test.ts');
    expect(verdict.neighborsTrimmed).toBe(19 - (MAX_INSPECTED_TEST_FILES - 1));
    expect(verdict.detail).toContain('neighbours trimmed');
  });

  test('changed tests alone over the cap stay honestly unmeasured', async () => {
    const changed = Array.from({ length: MAX_INSPECTED_TEST_FILES + 1 }, (_, i) => `src/big/n${String(i).padStart(2, '0')}.test.ts`);
    const verdict = await defaultInterference(changed, root, { detect: async (paths) => clean(paths) });
    expect(verdict.passed).toBe(false);
    expect(verdict.unmeasured).toBe(true);
  });

  test('host regate log carries failedStep detail and neighborsTrimmed', async () => {
    const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
    const { deps } = mock({
      interference: async () => ({ passed: false, unmeasured: true, neighborsTrimmed: 12, detail: `x${'y'.repeat(400)}` }),
      log: (event, data) => { logged.push({ event, data }); },
    });
    await runHostRegate(input, deps);
    const entry = logged.find((l) => l.event === 'unmeasured');
    expect(entry?.data.failedStep).toBe('test-interference');
    expect(entry?.data.detail).toBe(`x${'y'.repeat(299)}`);
    expect(entry?.data.neighborsTrimmed).toBe(12);
  });
});
