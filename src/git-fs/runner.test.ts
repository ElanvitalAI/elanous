import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { restoreSnapshot } from '../undo-turn/restore.js';
import { captureSnapshot } from '../undo-turn/snapshot.js';
import type { Snapshot } from '../undo-turn/types.js';
import { _callerFromStackForTesting, _setGitIoObserverForTesting, runGitCommand, setGitCommandRunnerForTesting, type GitCommandOptions, type GitCommandRunner } from './runner.js';
import type { GitRunResult, GitRunner } from './retry.js';

const PARENT_OID = 'a'.repeat(40);
const TREE_OID = 'b'.repeat(40);
const COMMIT_OID = 'c'.repeat(40);

type Fixture = { repo: string; dispose: () => void };
type ObservedCall = { cwd: string; args: string[]; options: GitCommandOptions };

function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', input });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function gitResult(cwd: string, args: string[], options: GitCommandOptions): GitRunResult {
  const result = spawnSync('git', args, { ...options, cwd });
  return {
    status: result.status,
    stdout: result.stdout == null ? '' : result.stdout.toString(),
    stderr: result.stderr == null ? '' : result.stderr.toString(),
  };
}

function makeRepository(): Fixture {
  const repo = mkdtempSync(join(tmpdir(), 'elanous-git-runner-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Elanous Test']);
  git(repo, ['config', 'user.email', 'test@elanous.local']);
  writeFileSync(join(repo, 'tracked.txt'), 'initial\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'initial']);
  return { repo, dispose: () => rmSync(repo, { recursive: true, force: true }) };
}

function snapshotResult(args: string[]): GitRunResult {
  switch (args[0]) {
    case 'rev-parse': return { status: 0, stdout: `${PARENT_OID}\n`, stderr: 'rev-parse diagnostic' };
    case 'ls-files': return { status: 0, stdout: 'kept-untracked.txt\0', stderr: 'ls-files diagnostic' };
    case 'read-tree': return { status: 0, stdout: 'read-tree output', stderr: 'read-tree diagnostic' };
    case 'add': return { status: 0, stdout: 'add output', stderr: 'add diagnostic' };
    case 'write-tree': return { status: 0, stdout: `${TREE_OID}\n`, stderr: 'write-tree diagnostic' };
    case 'commit-tree': return { status: 0, stdout: `${COMMIT_OID}\n`, stderr: 'commit-tree diagnostic' };
    default: throw new Error(`unexpected git command: ${args.join(' ')}`);
  }
}

function snapshot(repo: string, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 'snapshot',
    sha: COMMIT_OID,
    parentSha: PARENT_OID,
    repoRoot: repo,
    gitDir: join(repo, '.git'),
    untrackedFiles: [],
    capturedAt: 0,
    ...overrides,
  };
}

function observe(runner: GitCommandRunner): { calls: ObservedCall[]; runner: GitCommandRunner } {
  const calls: ObservedCall[] = [];
  return {
    calls,
    runner: (cwd, args, options) => {
      calls.push({ cwd, args: [...args], options });
      return runner(cwd, args, options);
    },
  };
}

function withRunner<T>(runner: GitCommandRunner, run: () => T): T {
  setGitCommandRunnerForTesting(runner);
  try {
    return run();
  } finally {
    setGitCommandRunnerForTesting(undefined);
  }
}

describe('runGitCommand', () => {
  test('resolves the caller frame independently of source or bundle filenames', () => {
    const sourceStack = [
      'Error',
      '    at callsite (/repo/src/git-fs/runner.ts:42:12)',
      '    at runGitCommand (/repo/src/git-fs/runner.ts:88:20)',
      '    at sourceConsumer (/repo/src/undo-turn/snapshot.ts:17:4)',
    ].join('\n');
    const bundleStack = [
      'Error',
      '    at callsite (/tmp/bundle-123.js:42:12)',
      '    at runGitCommand (/tmp/bundle-123.js:88:20)',
      '    at bundledConsumer (/tmp/application.min.js:17:4)',
    ].join('\n');
    expect(_callerFromStackForTesting(sourceStack)).toContain('sourceConsumer');
    expect(_callerFromStackForTesting(bundleStack)).toContain('bundledConsumer');
  });

  test('simulation aggregates injected Git calls by caller and subcommand for a completed hour', () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    let current = new Date('2026-11-09T10:05:00.000Z');
    let currentCaller = '';
    let monotonic = 0;
    const timerApi = {
      schedule(callback: () => void, delayMs: number) {
        scheduled.push({ callback, delayMs });
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      },
      cancel() {},
    };
    _setGitIoObserverForTesting((event, data) => events.push({ event, data }), () => current, timerApi, {
      caller: () => currentCaller,
      monotonicNow: () => monotonic,
    });
    try {
      const calls = [
        { caller: 'cli:release-status', subcommand: 'status', durationMs: 4 },
        { caller: 'cli:release-status', subcommand: 'fetch', durationMs: 9 },
        { caller: 'cli:release-status', subcommand: 'status', durationMs: 7 },
        { caller: 'scripts/release-audit.ts', subcommand: 'fetch', durationMs: 6 },
        { caller: 'scripts/release-audit.ts', subcommand: 'push', durationMs: 12 },
        { caller: 'scripts/release-audit.ts', subcommand: 'fetch', durationMs: 8 },
      ];
      for (const call of calls) {
        currentCaller = call.caller;
        runGitCommand('/sim/repo', [call.subcommand], {}, () => {
          monotonic += call.durationMs;
          return { status: 0, stdout: '', stderr: '' };
        });
      }

      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]?.delayMs).toBe(55 * 60 * 1000);
      current = new Date('2026-11-09T11:00:00.000Z');
      scheduled[0]?.callback();
      const summary = events.filter(({ event }) => event === 'hourly-summary').at(-1)?.data;
      expect(summary).toMatchObject({ hour: '2026-11-09T10', complete: true, totalCalls: 6 });
      const groups = summary?.groups as Record<string, { calls: number; totalDurationMs: number }>;
      expect(groups).toMatchObject({
        'cli:release-status :: status': { calls: 2, totalDurationMs: 11 },
        'cli:release-status :: fetch': { calls: 1, totalDurationMs: 9 },
        'scripts/release-audit.ts :: fetch': { calls: 2, totalDurationMs: 14 },
        'scripts/release-audit.ts :: push': { calls: 1, totalDurationMs: 12 },
      });
      expect(Object.values(groups).reduce((sum, group) => sum + group.calls, 0)).toBe(6);
    } finally {
      _setGitIoObserverForTesting(undefined);
    }
  });

  test('a stale hourly timer cannot flush the new hour after a synchronous boundary crossing', () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const timers: Array<{ callback: () => void; handle: ReturnType<typeof setTimeout> }> = [];
    const cancelled: ReturnType<typeof setTimeout>[] = [];
    let current = new Date('2026-11-05T10:59:59.000Z');
    const timerApi = {
      schedule(callback: () => void) {
        const handle = { unref() {} } as unknown as ReturnType<typeof setTimeout>;
        timers.push({ callback, handle });
        return handle;
      },
      cancel(handle: ReturnType<typeof setTimeout>) { cancelled.push(handle); },
    };
    _setGitIoObserverForTesting((event, data) => events.push({ event, data }), () => current, timerApi);
    try {
      const runner: GitRunner = () => ({ status: 0, stdout: '', stderr: '' });
      runGitCommand('/repo', ['-C', '/repo', 'status', '--short'], {}, runner);
      runGitCommand('/repo', ['rev-parse', 'HEAD'], {}, () => {
        current = new Date('2026-11-05T11:00:00.000Z');
        return runner([]);
      });

      expect(cancelled).toContain(timers[0].handle);
      expect(timers).toHaveLength(2);
      expect(events.map(({ event }) => event)).toEqual(['run', 'hourly-summary', 'hourly-summary', 'run', 'hourly-summary']);
      expect(events[0].data).toMatchObject({ subcommand: 'status', hour: '2026-11-05T10' });
      expect(events[0].data.caller).toContain('runner.test.ts');
      expect(events[0].data.durationMs).toBeNumber();
      expect(events[0].data.host).toBeString();
      expect(events[1].data).toMatchObject({ hour: '2026-11-05T10', totalCalls: 1, complete: false });
      expect(events[2].data).toMatchObject({ hour: '2026-11-05T10', totalCalls: 1, complete: true });
      expect(events[3].data).toMatchObject({ subcommand: 'rev-parse', hour: '2026-11-05T11' });
      expect(events[4].data).toMatchObject({ hour: '2026-11-05T11', totalCalls: 1, complete: false });
      expect(Object.values(events[2].data.groups as Record<string, { calls: number }>)[0].calls).toBe(1);

      timers[0].callback();
      expect(events).toHaveLength(5);
      current = new Date('2026-11-05T12:00:00.000Z');
      timers[1].callback();
      expect(events[5].data).toMatchObject({ hour: '2026-11-05T11', totalCalls: 1, complete: true });
    } finally {
      _setGitIoObserverForTesting(undefined);
    }
  });

  test('schedules the active hour close even when the wall clock advances during recording', () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const times = [
      new Date('2026-11-05T10:59:59.999Z'),
      new Date('2026-11-05T11:00:00.001Z'),
      new Date('2026-11-05T11:00:00.002Z'),
    ];
    let scheduledDelay = 0;
    let timerCallback: (() => void) | undefined;
    const timerApi = {
      schedule(callback: () => void, delayMs: number) {
        timerCallback = callback;
        scheduledDelay = delayMs;
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      },
      cancel() {},
    };
    _setGitIoObserverForTesting(
      (event, data) => events.push({ event, data }),
      () => times.shift() ?? new Date('2026-11-05T11:00:00.003Z'),
      timerApi,
    );
    try {
      runGitCommand('/repo', ['status'], {}, () => ({ status: 0, stdout: '', stderr: '' }));
      expect(scheduledDelay).toBe(1);
      timerCallback?.();
      expect(events.at(-1)?.data).toMatchObject({ hour: '2026-11-05T10', complete: true });
    } finally {
      _setGitIoObserverForTesting(undefined);
    }
  });

  test('rechecks UTC time and reschedules the timer if the wall clock moved backward', () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const callbacks: Array<() => void> = [];
    let current = new Date('2026-11-05T10:30:00.000Z');
    const timerApi = {
      schedule(callback: () => void) {
        callbacks.push(callback);
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      },
      cancel() {},
    };
    _setGitIoObserverForTesting((event, data) => events.push({ event, data }), () => current, timerApi);
    try {
      runGitCommand('/repo', ['status'], {}, () => ({ status: 0, stdout: '', stderr: '' }));
      current = new Date('2026-11-05T10:40:00.000Z');
      callbacks[0]();
      expect(callbacks).toHaveLength(2);
      expect(events.filter(({ event }) => event === 'hourly-summary')).toHaveLength(1);

      current = new Date('2026-11-05T11:00:00.000Z');
      callbacks[1]();
      expect(events.at(-1)?.data).toMatchObject({ hour: '2026-11-05T10', complete: true });
    } finally {
      _setGitIoObserverForTesting(undefined);
    }
  });

  test('a clock regression resumes the original hour bucket and preserves both hours', () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let current = new Date('2026-11-05T10:59:59.000Z');
    _setGitIoObserverForTesting((event, data) => events.push({ event, data }), () => current, {
      schedule: () => ({ unref() {} } as unknown as ReturnType<typeof setTimeout>),
      cancel() {},
    });
    try {
      const runner: GitRunner = () => ({ status: 0, stdout: '', stderr: '' });
      runGitCommand('/repo', ['status'], {}, runner);
      current = new Date('2026-11-05T11:00:00.000Z');
      runGitCommand('/repo', ['status'], {}, runner);
      current = new Date('2026-11-05T10:59:58.000Z');
      runGitCommand('/repo', ['status'], {}, runner);

      const lastRun = events.filter(({ event }) => event === 'run').at(-1)?.data;
      const summaries = events.filter(({ event }) => event === 'hourly-summary').map(({ data }) => data);
      const revisitedHour = summaries.filter(({ hour }) => hour === '2026-11-05T10').at(-1);
      const laterHour = summaries.filter(({ hour }) => hour === '2026-11-05T11').at(-1);
      expect(lastRun).toMatchObject({ hour: '2026-11-05T10', observedHour: '2026-11-05T10', clockSkew: true });
      expect(revisitedHour).toMatchObject({ hour: '2026-11-05T10', totalCalls: 2, clockSkew: true, revision: 3 });
      expect(laterHour).toMatchObject({ hour: '2026-11-05T11', totalCalls: 1, revision: 2 });
    } finally {
      _setGitIoObserverForTesting(undefined);
    }
  });

  test('restores an older bucket after it leaves the bounded in-memory history', () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let current = new Date('2026-11-05T00:30:00.000Z');
    _setGitIoObserverForTesting((event, data) => events.push({ event, data }), () => current, {
      schedule: () => ({ unref() {} } as unknown as ReturnType<typeof setTimeout>),
      cancel() {},
    });
    try {
      const runner: GitRunner = () => ({ status: 0, stdout: '', stderr: '' });
      runGitCommand('/repo', ['status'], {}, runner);
      for (let hour = 1; hour <= 25; hour += 1) {
        current = new Date(`2026-11-${hour < 24 ? '05' : '06'}T${String(hour % 24).padStart(2, '0')}:30:00.000Z`);
        runGitCommand('/repo', ['status'], {}, runner);
      }
      current = new Date('2026-11-05T00:45:00.000Z');
      runGitCommand('/repo', ['status'], {}, runner);
      expect(events.filter(({ event }) => event === 'run').at(-1)?.data).toMatchObject({ historyTruncated: false });
      expect(events.filter(({ event }) => event === 'hourly-summary').at(-1)?.data).toMatchObject({
        hour: '2026-11-05T00', totalCalls: 2, revision: 3, historyTruncated: false,
      });
    } finally {
      _setGitIoObserverForTesting(undefined);
    }
  });

  test('the bundled runner reports its external caller through the real Git entry point', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'elanous-git-runner-bundle-'));
    try {
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, 'runner.ts')],
        outdir: outDir,
        target: 'bun',
        format: 'esm',
      });
      expect(build.success).toBe(true);
      const artifact = build.outputs.find(output => output.path.endsWith('.js'));
      expect(artifact).toBeDefined();
      const driver = join(outDir, 'bundle-caller-driver.ts');
      writeFileSync(driver, `
import { _setGitIoObserverForTesting, runGitCommand } from ${JSON.stringify(pathToFileURL(artifact!.path).href)};
const events: Array<{ event: string; data: Record<string, unknown> }> = [];
_setGitIoObserverForTesting((event, data) => events.push({ event, data }));
const result = runGitCommand('/repo', ['status'], {}, () => ({ status: 0, stdout: '', stderr: '' }));
if (result.status !== 0) throw new Error('bundled Git command did not succeed');
if (!String(events[0]?.data.caller).includes('bundle-caller-driver.ts')) throw new Error('caller frame did not survive bundle: ' + String(events[0]?.data.caller));
if (String(events[0]?.data.caller).includes('runGitCommand')) throw new Error('runner frame was reported as the caller');
`);
      const child = spawnSync('bun', ['run', driver], { cwd: outDir, encoding: 'utf8', timeout: 30_000 });
      expect(child.error).toBeUndefined();
      expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('records every retry attempt and includes short-lived hourly snapshots', () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    _setGitIoObserverForTesting((event, data) => events.push({ event, data }));
    try {
      let calls = 0;
      const result = runGitCommand(process.cwd(), ['--config-env', 'user.name=GIT_NAME', 'status'], {}, () => {
        calls += 1;
        return calls === 1
          ? { status: 1, stdout: '', stderr: 'index.lock exists' }
          : { status: 0, stdout: '', stderr: '' };
      });
      expect(result.status).toBe(0);
      expect(events.filter(({ event }) => event === 'run')).toHaveLength(2);
      const summaries = events.filter(({ event }) => event === 'hourly-summary');
      expect(summaries.at(-1)?.data).toMatchObject({ totalCalls: 2, complete: false });
      expect(events[0].data.subcommand).toBe('status');
      expect(Object.values(summaries[0].data.groups as Record<string, { calls: number }>)[0].calls).toBe(1);
      expect(Object.values(summaries[1].data.groups as Record<string, { calls: number }>)[0].calls).toBe(2);
      expect(summaries[0].data.revision).toBe(1);
      expect(summaries[1].data.revision).toBe(2);
      expect(summaries[1].data.processId).toBeNumber();
      expect(summaries[1].data.processInstanceId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      _setGitIoObserverForTesting(undefined);
    }
  });

  test('logging failures do not replace a Git result or the original runner exception', () => {
    _setGitIoObserverForTesting(() => { throw new Error('logger failed'); });
    try {
      expect(runGitCommand('/repo', ['status'], {}, () => ({ status: 0, stdout: 'ok', stderr: '' }))).toMatchObject({ status: 0, stdout: 'ok' });
      const gitError = new Error('git runner failed');
      expect(() => runGitCommand('/repo', ['status'], {}, () => { throw gitError; })).toThrow(gitError);
    } finally {
      _setGitIoObserverForTesting(undefined);
    }
  });

  test('timer scheduling failures do not replace a Git result or the original runner exception', () => {
    const timerApi = {
      schedule() { throw new Error('timer unavailable'); },
      cancel() {},
    };
    _setGitIoObserverForTesting(() => {}, undefined, timerApi);
    try {
      expect(runGitCommand('/repo', ['status'], {}, () => ({ status: 0, stdout: 'ok', stderr: '' }))).toMatchObject({ status: 0, stdout: 'ok' });
      const gitError = new Error('git runner failed');
      expect(() => runGitCommand('/repo', ['status'], {}, () => { throw gitError; })).toThrow(gitError);
    } finally {
      _setGitIoObserverForTesting(undefined);
    }
  });

  test('caller and clock measurement failures cannot stop Git or replace its error', () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    _setGitIoObserverForTesting(
      (event, data) => events.push({ event, data }),
      undefined,
      undefined,
      { caller: () => { throw new Error('stack unavailable'); }, monotonicNow: () => { throw new Error('clock unavailable'); } },
    );
    try {
      expect(runGitCommand('/repo', ['status'], {}, () => ({ status: 0, stdout: 'ok', stderr: '' }))).toMatchObject({ status: 0, stdout: 'ok' });
      expect(events[0].data).toMatchObject({ caller: 'unknown', durationMs: 0 });
      const gitError = new Error('git runner failed');
      expect(() => runGitCommand('/repo', ['status'], {}, () => { throw gitError; })).toThrow(gitError);
    } finally {
      _setGitIoObserverForTesting(undefined);
    }
  });

  test('preserves a real Git failure status and stderr instead of turning it into empty output', () => {
    const result = runGitCommand(process.cwd(), ['definitely-not-a-git-subcommand']);
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).not.toBe('');
  }, 10_000);

  test('preserves non-empty stdout from the default spawnSync runner byte-for-byte', () => {
    const fixture = makeRepository();
    try {
      const expectedStdout = git(fixture.repo, ['rev-parse', '--show-toplevel']);
      const result = runGitCommand(fixture.repo, ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
      expect(result).toEqual({ status: 0, stdout: expectedStdout, stderr: '' });
      expect(result).not.toHaveProperty('signal');
    } finally {
      fixture.dispose();
    }
  }, 10_000);

  test('preserves the timeout error code and signal of a real Git subprocess', () => {
    const fixture = makeRepository();
    try {
      const result = runGitCommand(fixture.repo, ['-c', 'alias.slow=!sleep 2', 'slow'], { timeout: 100, killSignal: 'SIGKILL' });
      expect(result.status).toBeNull();
      expect(result.signal).toBe('SIGKILL');
      expect(result.errorCode).toBe('ETIMEDOUT');
    } finally { fixture.dispose(); }
  }, 10_000);

  test('does not retry a timed-out Git process even when partial output mentions a lock', () => {
    let calls = 0;
    const result = runGitCommand(process.cwd(), ['worktree', 'add'], {}, () => {
      calls += 1;
      return { status: null, signal: 'SIGKILL', errorCode: 'ETIMEDOUT', stdout: 'Updating files', stderr: 'index.lock' };
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: null, signal: 'SIGKILL', errorCode: 'ETIMEDOUT' });
  });

  test('retries an injected index.lock failure through the shared retry loop', () => {
    let calls = 0;
    const lockedRunner: GitRunner = () => {
      calls += 1;
      return { status: 1, stdout: 'partial output', stderr: 'fatal: Unable to create .git/index.lock: File exists.' };
    };
    const result = runGitCommand(process.cwd(), ['status'], {}, lockedRunner);
    expect(calls).toBeGreaterThan(1);
    expect(result).toEqual({ status: 1, stdout: 'partial output', stderr: 'fatal: Unable to create .git/index.lock: File exists.' });
  }, 10_000);

  test('retries a real temporary-index lock during snapshot staging and then captures', () => {
    const fixture = makeRepository();
    let addAttempts = 0;
    try {
      setGitCommandRunnerForTesting((cwd, args, options) => {
        if (args[0] === 'add' && addAttempts++ === 0) {
          const indexPath = options.env?.GIT_INDEX_FILE;
          expect(indexPath).toBeString();
          writeFileSync(`${indexPath}.lock`, 'real lock');
          const locked = gitResult(cwd, args, options);
          rmSync(`${indexPath}.lock`, { force: true });
          expect(locked.status).not.toBe(0);
          expect(locked.stderr).toContain('index.lock');
          return locked;
        }
        return gitResult(cwd, args, options);
      });

      const captured = captureSnapshot(fixture.repo, { description: 'real lock retry' });

      expect(addAttempts).toBe(2);
      expect(captured).toMatchObject({ repoRoot: fixture.repo });
      expect(captured?.sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      setGitCommandRunnerForTesting(undefined);
      fixture.dispose();
    }
  }, 20_000);

  test('snapshot consumes distinct command outputs and preserves all six argv, cwd, env, timeout, and stdio option objects exactly', () => {
    const fixture = makeRepository();
    const observed = observe((_cwd, args) => snapshotResult(args));
    try {
      writeFileSync(join(fixture.repo, 'kept-untracked.txt'), 'kept\n');
      const captured = withRunner(observed.runner, () => captureSnapshot(fixture.repo, { description: 'runner behavior' }));

      expect(captured).toMatchObject({
        sha: COMMIT_OID,
        parentSha: PARENT_OID,
        repoRoot: fixture.repo,
        untrackedFiles: ['kept-untracked.txt'],
        description: 'runner behavior',
      });
      expect(observed.calls.map(({ args }) => args)).toEqual([
        ['rev-parse', '--verify', 'HEAD'],
        ['ls-files', '-o', '--exclude-standard', '-z'],
        ['read-tree', PARENT_OID],
        ['add', '--all', '--', '.'],
        ['write-tree'],
        ['commit-tree', TREE_OID, '-p', PARENT_OID, '-m', 'elanous snapshot — runner behavior'],
      ]);
      expect(observed.calls.map(({ cwd }) => cwd)).toEqual(Array(6).fill(fixture.repo));

      const temporaryIndex = observed.calls[2].options.env?.GIT_INDEX_FILE;
      expect(temporaryIndex).toBeString();
      const indexEnv = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
      expect(observed.calls.map(({ options }) => options)).toEqual([
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 },
        { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
        { env: indexEnv, stdio: 'pipe' },
        { env: indexEnv, encoding: 'utf8', timeout: 60_000 },
        { env: indexEnv, encoding: 'utf8', timeout: 30_000 },
        {
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Elanous Snapshot',
            GIT_AUTHOR_EMAIL: 'snapshot@elanous.local',
            GIT_COMMITTER_NAME: 'Elanous Snapshot',
            GIT_COMMITTER_EMAIL: 'snapshot@elanous.local',
          },
        },
      ]);
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  test('snapshot treats a failed rev-parse as no parent, consumes ls-files/write-tree/commit-tree stdout, and skips read-tree', () => {
    const fixture = makeRepository();
    const observed = observe((_cwd, args) => {
      if (args[0] === 'rev-parse') return { status: 12, stdout: PARENT_OID, stderr: 'HEAD unavailable' };
      return snapshotResult(args);
    });
    try {
      writeFileSync(join(fixture.repo, 'kept-untracked.txt'), 'kept\n');
      const captured = withRunner(observed.runner, () => captureSnapshot(fixture.repo));
      expect(captured).toMatchObject({
        sha: COMMIT_OID,
        parentSha: null,
        untrackedFiles: ['kept-untracked.txt'],
      });
      expect(observed.calls.map(({ args }) => args)).toEqual([
        ['rev-parse', '--verify', 'HEAD'],
        ['ls-files', '-o', '--exclude-standard', '-z'],
        ['add', '--all', '--', '.'],
        ['write-tree'],
        ['commit-tree', TREE_OID, '-m', 'elanous snapshot'],
      ]);
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  test('snapshot treats failed ls-files as an empty untracked set and continues the remaining commands', () => {
    const fixture = makeRepository();
    const observed = observe((_cwd, args) => args[0] === 'ls-files'
      ? { status: 13, stdout: 'must-not-be-consumed.txt\0', stderr: 'enumeration failed' }
      : snapshotResult(args));
    try {
      const captured = withRunner(observed.runner, () => captureSnapshot(fixture.repo));
      expect(captured).toMatchObject({ sha: COMMIT_OID, parentSha: PARENT_OID, untrackedFiles: [] });
      expect(observed.calls.map(({ args }) => args)).toEqual([
        ['rev-parse', '--verify', 'HEAD'],
        ['ls-files', '-o', '--exclude-standard', '-z'],
        ['read-tree', PARENT_OID],
        ['add', '--all', '--', '.'],
        ['write-tree'],
        ['commit-tree', TREE_OID, '-p', PARENT_OID, '-m', 'elanous snapshot'],
      ]);
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  for (const [failedCommand, expectedCommands] of [
    ['read-tree', ['rev-parse', 'ls-files', 'read-tree']],
    ['add', ['rev-parse', 'ls-files', 'read-tree', 'add']],
    ['write-tree', ['rev-parse', 'ls-files', 'read-tree', 'add', 'write-tree']],
    ['commit-tree', ['rev-parse', 'ls-files', 'read-tree', 'add', 'write-tree', 'commit-tree']],
  ] as const) {
    test(`snapshot returns null and stops after a nonzero ${failedCommand} result`, () => {
      const fixture = makeRepository();
      const observed = observe((_cwd, args) => args[0] === failedCommand
        ? { status: 23, stdout: `${failedCommand} partial stdout`, stderr: `${failedCommand} failed detail` }
        : snapshotResult(args));
      try {
        expect(withRunner(observed.runner, () => captureSnapshot(fixture.repo))).toBeNull();
        expect(observed.calls.map(({ args }) => args[0])).toEqual([...expectedCommands]);
      } finally {
        fixture.dispose();
      }
    }, 20_000);
  }

  test('restore consumes ls-files stdout and preserves all three argv, cwd, timeout, stdio, and output option objects exactly', () => {
    const fixture = makeRepository();
    const observed = observe((_cwd, args) => {
      if (args[0] === 'cat-file') return { status: 0, stdout: 'object exists output', stderr: 'cat-file diagnostic' };
      if (args[0] === 'restore') return { status: 0, stdout: 'restore output', stderr: 'restore diagnostic' };
      if (args[0] === 'ls-files') return { status: 0, stdout: 'preserved.txt\0remove-me.txt\0', stderr: 'ls-files diagnostic' };
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    });
    try {
      writeFileSync(join(fixture.repo, 'preserved.txt'), 'preserved\n');
      writeFileSync(join(fixture.repo, 'remove-me.txt'), 'remove\n');
      const result = withRunner(observed.runner, () => restoreSnapshot(snapshot(fixture.repo, { untrackedFiles: ['preserved.txt'] })));

      expect(result).toEqual({
        ok: true,
        untrackedRemoved: 1,
        summary: `restored ${COMMIT_OID.slice(0, 7)} (cleared 1 new untracked file)`,
      });
      expect(existsSync(join(fixture.repo, 'preserved.txt'))).toBe(true);
      expect(existsSync(join(fixture.repo, 'remove-me.txt'))).toBe(false);
      expect(observed.calls).toEqual([
        {
          cwd: fixture.repo,
          args: ['cat-file', '-e', COMMIT_OID],
          options: { stdio: 'pipe', timeout: 5_000 },
        },
        {
          cwd: fixture.repo,
          args: ['restore', '--source', COMMIT_OID, '--worktree', '--', '.'],
          options: { encoding: 'utf8', timeout: 60_000 },
        },
        {
          cwd: fixture.repo,
          args: ['ls-files', '-o', '--exclude-standard', '-z'],
          options: { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
        },
      ]);
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  test('restore returns snapshot-missing and stops after a failed cat-file status', () => {
    const fixture = makeRepository();
    const observed = observe((_cwd, args) => args[0] === 'cat-file'
      ? { status: 31, stdout: 'cat-file partial stdout', stderr: 'cat-file failed detail' }
      : { status: 0, stdout: '', stderr: '' });
    try {
      expect(withRunner(observed.runner, () => restoreSnapshot(snapshot(fixture.repo)))).toEqual({
        ok: false,
        untrackedRemoved: 0,
        summary: 'snapshot missing',
        error: `snapshot commit ${COMMIT_OID.slice(0, 7)} no longer exists — it may have been gc'd. Run /undo list to see what's still available.`,
      });
      expect(observed.calls.map(({ args }) => args[0])).toEqual(['cat-file']);
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  test('restore preserves a failed restore status and stderr as its observable error and stops before ls-files', () => {
    const fixture = makeRepository();
    const observed = observe((_cwd, args) => args[0] === 'restore'
      ? { status: 17, stdout: 'partial restore output', stderr: 'restore failed detail' }
      : { status: 0, stdout: '', stderr: '' });
    try {
      expect(withRunner(observed.runner, () => restoreSnapshot(snapshot(fixture.repo)))).toEqual({
        ok: false,
        untrackedRemoved: 0,
        summary: 'git restore failed',
        error: 'restore failed detail',
      });
      expect(observed.calls.map(({ args }) => args[0])).toEqual(['cat-file', 'restore']);
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  test('restore treats failed ls-files as an empty set and leaves untracked files untouched', () => {
    const fixture = makeRepository();
    const observed = observe((_cwd, args) => args[0] === 'ls-files'
      ? { status: 41, stdout: 'remove-me.txt\0', stderr: 'ls-files failed detail' }
      : { status: 0, stdout: `${args[0]} output`, stderr: `${args[0]} diagnostic` });
    try {
      writeFileSync(join(fixture.repo, 'remove-me.txt'), 'keep after enumeration failure\n');
      expect(withRunner(observed.runner, () => restoreSnapshot(snapshot(fixture.repo)))).toEqual({
        ok: true,
        untrackedRemoved: 0,
        summary: `restored ${COMMIT_OID.slice(0, 7)}`,
      });
      expect(existsSync(join(fixture.repo, 'remove-me.txt'))).toBe(true);
      expect(observed.calls.map(({ args }) => args[0])).toEqual(['cat-file', 'restore', 'ls-files']);
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  test('captures and restores a temporary Git repository without changing its real index', () => {
    const fixture = makeRepository();
    try {
      const beforeIndex = readFileSync(join(fixture.repo, '.git', 'index'));
      writeFileSync(join(fixture.repo, 'tracked.txt'), 'snapshot state\n');
      writeFileSync(join(fixture.repo, 'untracked-before.txt'), 'preserved\n');
      const captured = captureSnapshot(fixture.repo, { description: 'runner behavior' });
      expect(captured).not.toBeNull();
      expect(readFileSync(join(fixture.repo, '.git', 'index'))).toEqual(beforeIndex);
      writeFileSync(join(fixture.repo, 'tracked.txt'), 'later state\n');
      writeFileSync(join(fixture.repo, 'untracked-after.txt'), 'removed\n');
      expect(restoreSnapshot(captured!)).toMatchObject({ ok: true, untrackedRemoved: 1 });
      expect(readFileSync(join(fixture.repo, 'tracked.txt'), 'utf8')).toBe('snapshot state\n');
      expect(readFileSync(join(fixture.repo, 'untracked-before.txt'), 'utf8')).toBe('preserved\n');
    } finally {
      fixture.dispose();
    }
  }, 20_000);
});
