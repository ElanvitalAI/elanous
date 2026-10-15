import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { debug } from '../debug/log.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execHarnessClean, listDirectoryEntries, planHarnessClean, type GitRunner, type GhRunner } from './harness-clean.js';
import { discoverHarnessGcRepos, formatHarnessGcOutput, runHarnessGcTick } from './harness-gc.js';
import { listLoops, setLoopEnabled } from '../loops/registry.js';
import { getUserConfig } from '../user-config.js';

function fixture(count: number, onDelete?: () => void, commonDir = '/x/repo.git') {
  const branches = new Set(Array.from({ length: count }, (_, i) => `self-impl/${String(i).padStart(3, '0')}`));
  const deletes: string[] = [];
  let gitCalls = 0;
  let active = true;
  const run: GitRunner = (args) => {
    gitCalls++;
    const cmd = args[0] === '-C' ? args.slice(2) : args;
    const text = cmd.join(' ');
    let stdout = '';
    if (text.includes('rev-parse')) stdout = `${commonDir}\n`;
    else if (text.includes('remote.origin.url')) stdout = 'https://github.com/example/repo.git\n';
    else if (text.includes('worktree list')) stdout = '';
    else if (text.includes('branch --list')) stdout = [...branches].join('\n');
    else if (text.includes('for-each-ref') && text.includes('ahead-behind')) stdout = [...branches].map((b) => `${b} 0 0`).join('\n');
    else if (text.includes('for-each-ref')) stdout = [...branches].join('\n');
    else if (cmd[0] === 'branch' && cmd[1] === '-D') {
      deletes.push(cmd[2]!);
      branches.delete(cmd[2]!);
      onDelete?.();
    }
    return { status: 0, stdout, stderr: '' };
  };
  const runGh: GhRunner = (args) => {
    const names = [...args.join(' ').matchAll(/headRefName: "([^"]+)"/g)].map((m) => m[1]!);
    return { status: 0, stdout: JSON.stringify({ data: { repository: Object.fromEntries(names.map((_, i) =>
      [`b${i}`, { nodes: [{ state: 'MERGED', mergedAt: '2026-10-09T00:00:00Z' }] }])) } }) };
  };
  return { run, runGh, deletes, branches, calls: () => gitCalls,
    active: () => active ? { ok: true, value: [] } : { ok: false, value: [] },
    disableActive: () => { active = false; } };
}

function temp() { return mkdtempSync(join(tmpdir(), 'harness-gc-')); }

it('human GC report shows orphan scan and HQ recovery counts while JSON remains unchanged', () => {
  const result = {
    outcome: 'ok' as const, repos: 3, removed: 2, preserved: 3, deferred: 4, failed: 5,
    unseenOutsideWindow: 6, unseenOutsidePrefix: 7, undiscoverable: 0, orphanScanUnavailable: 1,
    budgetMs: 240_000, elapsedMs: 12, budgetExhausted: true,
    repositories: [
      { gitDir: '/repo.git', offset: 0, window: 10, total: 20, removed: 2, preserved: 3,
        deferred: 4, failed: 5, preservedByReason: {}, orphanScan: 'unavailable' as const },
      { gitDir: '/scanned.git', offset: 0, window: 10, total: 0, removed: 0, preserved: 0,
        deferred: 0, failed: 0, preservedByReason: {}, orphanScan: 'scanned' as const },
      { gitDir: '/not-requested.git', offset: 0, window: 10, total: 0, removed: 0, preserved: 0,
        deferred: 0, failed: 0, preservedByReason: {}, orphanScan: 'not-requested' as const },
    ],
  };
  const human = formatHarnessGcOutput(result, { human: true, json: false });
  expect(human).toContain('orphanScan=unavailable');
  expect(human).toContain('orphanScan=scanned');
  expect(human).toContain('orphanScan=not-requested');
  expect(human).toContain('removed=2 preserved=3 deferred=4 failed=5');
  expect(human).toContain('unseenOutsideWindow=6 unseenOutsidePrefix=7');
  expect(human).toContain('budgetMs=240000 elapsedMs=12 budgetExhausted=true');
  expect(formatHarnessGcOutput(result, { human: false, json: false })).toBe(JSON.stringify(result));
  expect(formatHarnessGcOutput(result, { human: true, json: true })).toBe(JSON.stringify(result));
});

it('bare common git dir isolates unavailable orphan scan without blocking a merged branch', () => {
  const f = fixture(1);
  const plan = execHarnessClean({ mode: 'merged', dryRun: true, run: f.run, runGh: f.runGh,
    activeDirectoryProvider: f.active }).plan;
  expect(plan.unavailable).toBe(false);
  expect(plan.remove.map((item) => item.branch)).toEqual(['self-impl/000']);
  expect(plan.orphanScan).toBe('unavailable');
  expect(plan.orphanScanFailure).toBe('bare-common-dir');
  expect(plan.queryStatus?.directoriesFailure).toBe('bare-common-dir');
  expect(plan.preserve.some((item) => item.reason.startsWith('query-failed'))).toBe(false);
  f.disableActive();
  const blocked = execHarnessClean({ mode: 'merged', dryRun: true, run: f.run, runGh: f.runGh,
    activeDirectoryProvider: f.active }).plan;
  expect(blocked.remove).toEqual([]);
  expect(blocked.preserve[0]?.reason).toBe('query-failed:activeDirectories');
});

it('planner distinguishes not-requested, scanned, and unavailable orphan scans', () => {
  const base = { worktrees: [], branches: [], openPr: new Set<string>(), mergedPr: new Set<string>(), mode: 'merged' as const,
    activeDirectories: [], unmergedCommitCounts: new Map(), uncommittedChanges: new Map() };
  expect(planHarnessClean(base).orphanScan).toBe('not-requested');
  expect(planHarnessClean({ ...base, worktreeDirectories: [], registeredWorktreePaths: [] }).orphanScan).toBe('scanned');
  const unavailable = planHarnessClean({ ...base, worktreeDirectories: [], registeredWorktreePaths: [],
    queryStatus: { worktrees: true, branches: true, pullRequests: true, registeredWorktrees: false } });
  expect(unavailable.orphanScan).toBe('unavailable');
  expect(unavailable.orphanScanFailure).toBe('registeredWorktrees');
  expect(unavailable.unavailable).toBe(false);
});

it('registered worktree enumeration failure does not block a known branch, and open PR truncation does', () => {
  const f = fixture(1, undefined, '/x/repo/.git');
  const run: GitRunner = (args) => args.includes('-z')
    ? { status: 1, stdout: '', stderr: 'offline' } : f.run(args);
  const plan = execHarnessClean({ mode: 'merged', dryRun: true, run, runGh: f.runGh,
    activeDirectoryProvider: f.active }).plan;
  expect(plan.remove.map((item) => item.branch)).toEqual(['self-impl/000']);
  expect(plan.unavailable).toBe(false);
  expect(plan.queryStatus?.directories).toBe(true);
  expect(plan.queryStatus?.registeredWorktrees).toBe(false);
  expect(plan.orphanScan).toBe('unavailable');
  expect(plan.orphanScanFailure).toBe('registeredWorktrees');
  const blocked = planHarnessClean({ worktrees: [], branches: ['self-impl/000'], openPr: new Set(),
    mergedPr: new Set(['self-impl/000']), mode: 'merged', activeDirectories: [],
    queryStatus: { worktrees: true, branches: true, pullRequests: true,
      pullRequestsTruncated: { open: true, merged: false } },
    unmergedCommitCounts: new Map(), uncommittedChanges: new Map() });
  expect(blocked.remove).toEqual([]);
  expect(blocked.preserve[0]?.reason).toContain('pullRequests-truncated-open');
});

it('failed second PR batch preserves only its 10 unread branches', () => {
  const f = fixture(60);
  let calls = 0;
  const gh: GhRunner = (args) => ++calls === 2 ? { status: 1, stdout: '', stderr: 'offline' } : f.runGh(args);
  const plan = execHarnessClean({ mode: 'merged', dryRun: true, run: f.run, runGh: gh,
    activeDirectoryProvider: f.active }).plan;
  expect(plan.unavailable).toBe(false);
  expect(plan.remove).toHaveLength(50);
  expect(plan.preserve).toHaveLength(10);
  expect(plan.preserve.every((item) => item.reason === 'query-failed:pullRequests')).toBe(true);
  expect(plan.queryStatus?.pullRequestsUnreadBranches).toBe(10);
});

it('window bounds PR and assessment inputs before any measurement', () => {
  const f = fixture(250);
  const prBatchSizes: number[] = [];
  let measurements = 0;
  const run: GitRunner = (args) => {
    if (args.some((arg) => arg.includes('ahead-behind:origin/main'))) measurements++;
    return f.run(args);
  };
  const gh: GhRunner = (args) => {
    const size = [...args.join(' ').matchAll(/headRefName:/g)].length;
    prBatchSizes.push(size);
    return f.runGh(args);
  };
  const result = execHarnessClean({ mode: 'merged', dryRun: true, window: { offset: 100, size: 20 },
    run, runGh: gh, activeDirectoryProvider: f.active });
  expect(result.window).toMatchObject({ offset: 100, size: 20, total: 250, unseenOutsideWindow: 230 });
  expect(result.plan.remove).toHaveLength(20);
  expect(result.plan.remove[0]?.branch).toBe('self-impl/100');
  expect(prBatchSizes).toEqual([20]);
  expect(measurements).toBe(1);
});

it('cursor advances after an exhausted window and wraps at the end', () => {
  const f = fixture(5);
  const root = temp();
  const deps = { stateRoot: root, run: f.run, runGh: f.runGh, activeDirectoryProvider: f.active };
  const opts = { repos: ['/x/repo.git'], window: 2, maxRemove: 30 };
  const first = runHarnessGcTick(opts, deps);
  expect(first.repositories[0]?.offset).toBe(0);
  expect(first.removed).toBe(2);
  const second = runHarnessGcTick(opts, deps);
  expect(second.repositories[0]?.offset).toBe(0);
  expect(second.removed).toBe(2);
  const third = runHarnessGcTick(opts, deps);
  expect(third.removed).toBe(1);
  expect(new Set(f.deletes).size).toBe(5);
});

it('two bounded ticks remove different branches; deferred holds cursor and observed counts', () => {
  const f = fixture(250);
  const root = temp();
  const logs: unknown[] = [];
  const original = debug.log;
  debug.log = ((category: string, event: string, value: unknown) => {
    if (category === 'harness.gc' && event === 'tick') logs.push(value);
  }) as typeof original;
  try {
    const deps = { stateRoot: root, run: f.run, runGh: f.runGh, activeDirectoryProvider: f.active };
    const opts = { repos: ['/x/repo.git'], window: 100, maxRemove: 30, budgetMs: 240_000 };
    const first = runHarnessGcTick(opts, deps);
    expect(first.outcome).toBe('ok');
    expect(first.removed).toBe(30);
    expect(first.deferred).toBe(70);
    expect(first.unseenOutsideWindow).toBe(150);
    expect(logs[0]).toMatchObject({ removed: 30, deferred: 70, unseenOutsideWindow: 150 });
    const second = runHarnessGcTick(opts, deps);
    expect(second.removed).toBe(30);
    expect(f.deletes).toHaveLength(60);
    expect(new Set(f.deletes).size).toBe(60);
  } finally { debug.log = original; }
});

it('GC uses non-force worktree removal, preserving its branch on failure', () => {
  const f = fixture(1);
  let branchDeleted = false;
  const run: GitRunner = (args) => {
    if (args.includes('worktree') && args.includes('remove')) {
      expect(args).not.toContain('--force');
      return { status: 1, stdout: '', stderr: 'locked worktree' };
    }
    if (args.includes('rev-list')) return { status: 0, stdout: '0\n', stderr: '' };
    if (args.includes('status')) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('diff')) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('-D')) branchDeleted = true;
    if (args.includes('worktree') && args.includes('list')) {
      return { status: 0, stdout: 'worktree /wt/a\nbranch refs/heads/self-impl/000\n', stderr: '' };
    }
    return f.run(args);
  };
  const result = runHarnessGcTick({ repos: ['/x/repo.git'] }, { stateRoot: temp(), run, runGh: f.runGh,
    activeDirectoryProvider: f.active,
    readWorktreeProvenance: () => ({ owner: 'dev:run', command: 'elanous dev', createdAt: '2026-10-09T00:00:00.000Z' }) });
  expect(result.outcome).toBe('fail');
  expect(result.failed).toBe(1);
  expect(branchDeleted).toBe(false);
});

it('budget expiry after one deletion defers the rest without failing the tick', () => {
  let clock = 0;
  const f = fixture(5, () => { clock = 101; });
  const result = runHarnessGcTick({ repos: ['/x/repo.git'], window: 5, maxRemove: 30, budgetMs: 100 },
    { stateRoot: temp(), now: () => clock, run: f.run, runGh: f.runGh, activeDirectoryProvider: f.active });
  expect(result.outcome).toBe('ok');
  expect(f.deletes).toHaveLength(1);
  expect(result.deferred).toBe(4);
});

it('an entire PR batch failure stays global and an open PR is never removed', () => {
  const f = fixture(1);
  const failed = execHarnessClean({ mode: 'merged', dryRun: true, run: f.run,
    runGh: () => ({ status: 1, stdout: '', stderr: 'offline' }), activeDirectoryProvider: f.active });
  expect(failed.plan.unavailable).toBe(true);
  expect(failed.plan.remove).toEqual([]);
  expect(failed.plan.preserve[0]?.reason).toBe('query-failed:pullRequests');
  const open = execHarnessClean({ mode: 'merged', dryRun: true, run: f.run,
    runGh: (args) => ({ status: 0, stdout: JSON.stringify({ data: { repository: {
      b0: { nodes: [{ state: 'OPEN', mergedAt: null }] },
    } } }) }), activeDirectoryProvider: f.active });
  expect(open.plan.remove).toEqual([]);
  expect(open.plan.preserve[0]?.reason).toContain('open-pr');
});

it('live lock skips before git, dead holder recovers and releases', () => {
  const root = temp();
  const dir = join(root, 'harness-gc');
  mkdirSync(dir);
  const lock = join(dir, 'tick.lock');
  const f = fixture(0);
  writeFileSync(lock, `${process.pid}\n`);
  const deps = { stateRoot: root, run: f.run, runGh: f.runGh, activeDirectoryProvider: f.active };
  const observed: unknown[] = [];
  const original = debug.log;
  debug.log = ((category: string, event: string, value: unknown) => {
    if (category === 'harness.gc' && event === 'tick-skipped') observed.push(value);
  }) as typeof original;
  let skipped;
  try { skipped = runHarnessGcTick({ repos: ['/x/repo.git'] }, deps); }
  finally { debug.log = original; }
  expect(skipped).toMatchObject({ outcome: 'skipped', reason: 'overlap' });
  expect(observed).toEqual([expect.objectContaining({ reason: 'overlap', holder: String(process.pid) })]);
  expect(f.calls()).toBe(0);
  writeFileSync(lock, '99999999\n');
  const recovered = runHarnessGcTick({ repos: ['/x/repo.git'] }, deps);
  expect(recovered.outcome).toBe('ok');
  expect(existsSync(lock)).toBe(false);
});

it('unknown repository measurement omits prefix and window totals instead of reporting zero', () => {
  const f = fixture(1);
  const run: GitRunner = (args) => args.includes('branch') && args.includes('--list')
    ? { status: 1, stdout: '', stderr: 'offline' } : f.run(args);
  const result = runHarnessGcTick({ repos: ['/x/repo.git'] },
    { stateRoot: temp(), run, runGh: f.runGh, activeDirectoryProvider: f.active });
  expect(result.outcome).toBe('fail');
  expect(result.unseenOutsidePrefix).toBeUndefined();
  expect(result.repositories[0]?.unseenOutsideWindow).toBeUndefined();
  expect(f.deletes).toEqual([]);
});

it('no discovered target fails without falling back to cwd', () => {
  const f = fixture(0);
  const result = runHarnessGcTick({}, { stateRoot: temp(), worktreeRoot: temp(), run: f.run });
  expect(result).toMatchObject({ outcome: 'fail', reason: 'no-target-repo', repos: 0 });
  expect(f.calls()).toBe(0);
});

it('discover only linked gitdir files, deduplicating common dirs and counting unreadable folders', () => {
  const root = temp();
  for (const [scope, parent, name, gitdir] of [
    ['a', 'a.worktrees', 'one', '/r1.git/worktrees/a'],
    ['a', 'a.worktrees', 'two', '/r1.git/worktrees/b'],
    ['b', 'b.worktrees', 'three', '/r2/.git/worktrees/c'],
    ['b', 'b.worktrees', 'missing', ''],
  ]) {
    const path = join(root, scope!, parent!, name!);
    mkdirSync(path, { recursive: true });
    if (gitdir) writeFileSync(join(path, '.git'), `gitdir: ${gitdir}\n`);
  }
  expect(discoverHarnessGcRepos(root)).toEqual({ repos: ['/r1.git', '/r2/.git'], undiscoverable: 1 });
});

it('verified target persists after its last linked worktree disappears', () => {
  const root = temp();
  const worktreeRoot = temp();
  const linked = join(worktreeRoot, 'scope', 'repo.worktrees', 'linked');
  mkdirSync(linked, { recursive: true });
  writeFileSync(join(linked, '.git'), 'gitdir: /x/repo.git/worktrees/linked\n');
  const f = fixture(2);
  const deps = { stateRoot: root, worktreeRoot, run: f.run, runGh: f.runGh, activeDirectoryProvider: f.active };
  const first = runHarnessGcTick({ window: 1 }, deps);
  expect(first.removed).toBe(1);
  expect(first.outcome).toBe('ok');
  expect(existsSync(join(root, 'harness-gc', 'targets.json'))).toBe(true);
  const second = runHarnessGcTick({ window: 1 }, { ...deps, worktreeRoot: temp() });
  expect(second.outcome).toBe('ok');
  expect(second.repos).toBe(1);
  expect(second.removed).toBe(1);
  expect(new Set(f.deletes).size).toBe(2);
});

it('an explicit repo does not enroll itself for later automatic ticks', () => {
  const root = temp();
  const f = fixture(1);
  const deps = { stateRoot: root, worktreeRoot: temp(), run: f.run, runGh: f.runGh,
    activeDirectoryProvider: f.active };
  expect(runHarnessGcTick({ repos: ['/x/repo.git'] }, deps).outcome).toBe('ok');
  expect(existsSync(join(root, 'harness-gc', 'targets.json'))).toBe(false);
  const automatic = runHarnessGcTick({}, deps);
  expect(automatic).toMatchObject({ outcome: 'fail', reason: 'no-target-repo', repos: 0 });
});

it('budget exhaustion stops before querying another repository', () => {
  let clock = 0;
  const calls: string[] = [];
  const f = fixture(1);
  const run: GitRunner = (args) => {
    calls.push(args.join(' '));
    if (args[1] === '/x/second.git' && args.includes('rev-parse')) {
      return { status: 0, stdout: '/x/second.git\n', stderr: '' };
    }
    if (args.includes('branch') && args.includes('-D')) clock = 101;
    return f.run(args);
  };
  const result = runHarnessGcTick({ repos: ['/x/repo.git', '/x/second.git'], budgetMs: 100 },
    { stateRoot: temp(), now: () => clock, run, runGh: f.runGh, activeDirectoryProvider: f.active });
  expect(result.outcome).toBe('ok');
  expect(result.removed).toBe(1);
  expect(result.repos).toBe(1);
  expect(result.unseenOutsideWindow).toBeUndefined();
  expect(result.unseenOutsidePrefix).toBeUndefined();
  expect(calls.some((call) => call.includes('-C /x/second.git config --get'))).toBe(false);
});

it('a tick whose budget runs out before any repository is verified is skipped, not ok', () => {
  let clock = 0;
  const f = fixture(1);
  const run: GitRunner = (args) => { clock = 101; return f.run(args); };
  const result = runHarnessGcTick({ repos: ['/x/repo.git', '/x/second.git'], budgetMs: 100 },
    { stateRoot: temp(), now: () => clock, run, runGh: f.runGh, activeDirectoryProvider: f.active });
  expect(result).toMatchObject({ outcome: 'skipped', reason: 'budget-exhausted', repos: 0, removed: 0 });
});

it('budget expiry during the PR lookup stops further reads and leaves the repository unverified, not failed', () => {
  let clock = 0;
  const f = fixture(3);
  let ghCalls = 0;
  const reads: string[] = [];
  const run: GitRunner = (args) => { if (clock > 0) reads.push(args.join(' ')); return f.run(args); };
  const result = runHarnessGcTick({ repos: ['/x/repo.git'], window: 5, maxRemove: 30, budgetMs: 100 },
    { stateRoot: temp(), now: () => clock, run, activeDirectoryProvider: f.active,
      runGh: (args, options) => { ghCalls++; clock = 101; return f.runGh(args, options); } });
  expect(ghCalls).toBe(1);
  expect(reads).toEqual([]); // no git query reached the real runner after the deadline
  expect(f.deletes).toEqual([]);
  expect(result).toMatchObject({ outcome: 'skipped', reason: 'budget-exhausted', budgetExhausted: true, repos: 0, failed: 0 });
  expect(result.repoFailures).toBeUndefined();
});

it('maxRemove bounds deletion attempts, so items whose branch deletion fails cannot exceed it', () => {
  const f = fixture(6);
  const attempts: string[] = [];
  const run: GitRunner = (args) => {
    const cmd = args[0] === '-C' ? args.slice(2) : args;
    if (cmd[0] === 'branch' && cmd[1] === '-D') { attempts.push(cmd[2]!); return { status: 1, stdout: '', stderr: 'locked' }; }
    return f.run(args);
  };
  const result = runHarnessGcTick({ repos: ['/x/repo.git'], window: 6, maxRemove: 2 },
    { stateRoot: temp(), run, runGh: f.runGh, activeDirectoryProvider: f.active });
  expect(attempts).toHaveLength(2);
  expect(result.removed).toBe(0);
  expect(result.failed).toBe(2);
  expect(result.deferred).toBe(4);
});

it('after the tick deadline the clean starts no non-git read: no live-directory lookup, no directory listing', () => {
  let clock = 0;
  const f = fixture(3);
  let activeCalls = 0;
  const result = runHarnessGcTick({ repos: ['/x/repo.git'], window: 5, budgetMs: 100 },
    { stateRoot: temp(), now: () => clock, run: f.run,
      activeDirectoryProvider: () => { activeCalls++; return { ok: true, value: [] }; },
      runGh: (args, options) => { clock = 101; return f.runGh(args, options); } });
  expect(activeCalls).toBe(0);
  expect(f.deletes).toEqual([]);
  expect(result).toMatchObject({ outcome: 'skipped', reason: 'budget-exhausted', budgetExhausted: true, failed: 0 });
});

it('execHarnessClean honours an expired caller deadline for its non-git reads', () => {
  const f = fixture(2, undefined, '/nonexistent-harness-gc-repo/.git');
  let activeCalls = 0;
  const active = () => { activeCalls++; return { ok: true, value: [] as string[] }; };
  const live = execHarnessClean({ mode: 'merged', dryRun: true, run: f.run, runGh: f.runGh, activeDirectoryProvider: active });
  expect(live.plan.queryStatus?.directories).toBe(true); // ENOENT parent: an honest empty listing
  expect(live.expired).toBeUndefined();
  expect(activeCalls).toBe(1);
  const cut = execHarnessClean({ mode: 'merged', dryRun: true, run: f.run, runGh: f.runGh, activeDirectoryProvider: active,
    expired: () => true });
  expect(activeCalls).toBe(1);
  expect(cut.expired).toBe(true);
  expect(cut.plan.queryStatus?.directories).toBe(false);
  expect(cut.plan.queryStatus?.activeDirectories).toBe(false);
  expect(cut.plan.remove).toEqual([]);
});

function discoveryTree(): string {
  const root = temp();
  for (const name of ['a', 'b', 'c']) {
    const path = join(root, 'scope', 'repo.worktrees', name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, '.git'), `gitdir: /x/repo${name}.git/worktrees/${name}\n`);
  }
  return root;
}

it('discovery checks the deadline between reads and reports the walk as stopped, keeping what it read', () => {
  const root = discoveryTree();
  expect(discoverHarnessGcRepos(root)).toEqual({ repos: ['/x/repoa.git', '/x/repob.git', '/x/repoc.git'], undiscoverable: 0 });
  let checks = 0;
  // 4 checks admit: root listing, scope listing, .worktrees listing, first .git read — then the deadline passes.
  const cut = discoverHarnessGcRepos(root, () => ++checks > 4);
  expect(cut).toEqual({ repos: ['/x/repoa.git'], undiscoverable: 0, stopped: true });
  expect(discoverHarnessGcRepos(root, () => true)).toEqual({ repos: [], undiscoverable: 0, stopped: true });
});

it('a tick whose discovery walk is cut by the deadline is budget-exhausted, not a clean empty tick', () => {
  let clock = 0;
  const result = runHarnessGcTick({ budgetMs: 2 }, { stateRoot: temp(), worktreeRoot: discoveryTree(), now: () => clock++,
    run: () => ({ status: 1, stdout: '', stderr: 'unused' }), runGh: () => ({ status: 1, stdout: '' }),
    activeDirectoryProvider: () => ({ ok: true, value: [] }) });
  expect(result).toMatchObject({ outcome: 'skipped', reason: 'budget-exhausted', budgetExhausted: true, repos: 0 });
  expect(result.unseenOutsideWindow).toBeUndefined();
});

it('orphan directory listing stops between reads once the deadline passes', () => {
  const root = temp();
  mkdirSync(join(root, 'one')); mkdirSync(join(root, 'two'));
  let checks = 0;
  expect(listDirectoryEntries([join(root, 'one'), join(root, 'two')]).ok).toBe(true);
  expect(listDirectoryEntries([join(root, 'one'), join(root, 'two')], () => ++checks > 1)).toEqual({ ok: false, value: new Map() });
  expect(checks).toBe(2);
});

it('deletions deferred by the time budget are recorded as budget-exhausted', () => {
  let clock = 0;
  const f = fixture(5, () => { clock = 101; });
  const result = runHarnessGcTick({ repos: ['/x/repo.git'], window: 5, maxRemove: 30, budgetMs: 100 },
    { stateRoot: temp(), now: () => clock, run: f.run, runGh: f.runGh, activeDirectoryProvider: f.active });
  expect(f.deletes).toHaveLength(1);
  expect(result).toMatchObject({ outcome: 'ok', deferred: 4, budgetExhausted: true });
  // the count cap alone is not a budget event
  const capped = runHarnessGcTick({ repos: ['/x/repo.git'], window: 5, maxRemove: 1 },
    { stateRoot: temp(), run: fixture(3).run, runGh: f.runGh, activeDirectoryProvider: f.active });
  expect(capped.budgetExhausted).toBeUndefined();
});

it('repositories left unprocessed because the budget ran out between repositories are recorded as budget-exhausted', () => {
  let clock = 0;
  const f = fixture(1);
  const run: GitRunner = (args) => {
    if (args[1] === '/x/second.git' && args.includes('rev-parse')) return { status: 0, stdout: '/x/second.git\n', stderr: '' };
    if (args.includes('branch') && args.includes('-D')) clock = 101;
    return f.run(args);
  };
  const result = runHarnessGcTick({ repos: ['/x/repo.git', '/x/second.git'], budgetMs: 100 },
    { stateRoot: temp(), now: () => clock, run, runGh: f.runGh, activeDirectoryProvider: f.active });
  expect(result).toMatchObject({ outcome: 'ok', repos: 1, removed: 1, budgetExhausted: true });
});

it('registered OP loop produces one graph-run cron action in dry-run', async () => {
  const root = resolve(import.meta.dir, '../..');
  const opts = { root, stateRoot: temp(), schedules: [], config: getUserConfig(),
    scheduleAction: async () => { throw new Error('dry-run must not schedule'); } };
  const loop = listLoops(opts).find((entry) => entry.id === 'harness-gc');
  expect(loop).toMatchObject({ id: 'harness-gc', owner: 'OP', trigger: { cron: '*/10 * * * *' } });
  const result = await setLoopEnabled('harness-gc', true, false, opts) as { changes: Array<{ action: string; cron: string; command: string }> };
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]).toMatchObject({ action: 'create', cron: '*/10 * * * *' });
  expect(JSON.stringify(result.changes[0])).toContain('graph run graphs/ops/harness-gc.yaml');
});
