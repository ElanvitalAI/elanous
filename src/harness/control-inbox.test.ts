import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { harnessScreenPath, writeHarnessScreen } from './harness-screen.js';
import { SELF_SEND_RECENT_FRAME_WINDOW_MS, formatSelfSendCandidateDisplay } from '../index.js';
import { CONTROL_MEMO_FRAME_PREFIX, cleanupStaleControlInbox, controlInboxPath, decodeControlMemoFrame, drainControlInbox, drainSoftStopControlInbox, encodeControlMemoFrame, enqueueControlMemo, enqueueSoftStop, inspectControlInbox, readSoftStopRequest, resolveControlInboxDir } from './control-inbox.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repoRoot = join(import.meta.dir, '../..');

type CliProbeResult = Pick<ReturnType<typeof spawnSync>, 'status' | 'stderr' | 'error'>;

function cliDependenciesAvailable(result: CliProbeResult): boolean {
  const status = result.status === null ? 'null' : String(result.status);
  const error = result.error ? ` error=${result.error.message}` : '';
  const failure = () => new Error(`elanous self send --help probe failed (status=${status}${error}): ${String(result.stderr).trim()}`);

  // A spawn error, timeout, or missing exit status is not evidence that dependencies
  // are absent, even if stderr happens to contain a module-resolution failure.
  if (result.error || result.status === null) throw failure();
  if (result.status === 0) return true;

  // A nonzero help probe skips only for a dependency-resolution failure inside
  // node_modules, not for CLI registration or option parsing failures.
  if (/Cannot find module ['"].+['"] from .+node_modules[\\/]/i.test(String(result.stderr))) return false;

  throw failure();
}

// ⭐ 전제 검사는 **실제로 부를 그 명령**으로 한다(2026-07-30 실측 정정).
//    ⛔ 종전엔 `bun --eval "await import('zod/v4')"` 로 쟀는데 **전제를 대표하지 못했다** —
//    zod 는 전역 설치 캐시에서 해석되므로 의존성이 없는 워크트리에서도 `rc=0` 이 나오고,
//    정작 `bin/elanous.mjs` 는 `rc=1` 로 죽는다(같은 트리에서 둘을 나란히 재서 확인).
//    ⇒ 검사와 대상이 다르면 그 검사는 **자가 틀린 것**이다. 같은 엔트리를 가볍게(`--help`) 부른다.
const liveCliDependenciesAvailable = cliDependenciesAvailable(spawnSync(process.execPath, ['bin/elanous.mjs', 'self', 'send', '--help'], {
  cwd: repoRoot,
  env: process.env,
  timeout: 20_000,
  encoding: 'utf8',
}));
const dirs: string[] = [];
const liveWorkers: Array<ReturnType<typeof spawn>> = [];
const extraPids = new Set<number>();
const clkTck = (() => {
  const result = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' });
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) && value > 0 ? value : 100;
})();

function env(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'control-inbox-'));
  dirs.push(dir);
  return { ELANOUS_STATE_DIR: dir } as NodeJS.ProcessEnv;
}

function killPid(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!pid) return;
  try { process.kill(pid, signal); } catch {}
}

function killTrackedWorkers(): void {
  for (const child of liveWorkers.splice(0)) killPid(child.pid);
  for (const pid of extraPids) killPid(pid);
  extraPids.clear();
}

afterEach(() => {
  killTrackedWorkers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function trackWorker(child: ReturnType<typeof spawn>): ReturnType<typeof spawn> {
  liveWorkers.push(child);
  return child;
}

function runWorker(script: string, isolated: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = trackWorker(spawn(process.execPath, ['-e', script], {
      cwd: import.meta.dir,
      env: { ...process.env, ...isolated },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`worker failed (${code}): ${stderr}`)));
  });
}

function spawnObservedWorker(script: string, isolated: NodeJS.ProcessEnv): ReturnType<typeof spawn> {
  const child = trackWorker(spawn(process.execPath, ['-e', script], {
    cwd: import.meta.dir,
    env: { ...process.env, ...isolated },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

function releaseBarrier(path: string): void {
  writeFileSync(path, 'go', 'utf8');
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function countPidViaPs(pid: number): number {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf8' });
  return result.stdout.split('\n').map((line) => Number(line.trim())).some((value) => value === pid) ? 1 : 0;
}

function readProcCpuTimeMs(pid: number): number | null {
  const statPath = `/proc/${pid}/stat`;
  if (!existsSync(statPath)) return null;
  const text = readFileSync(statPath, 'utf8');
  const rest = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return ((utime + stime) * 1000) / clkTck;
}

const readDarwinTaskCpuTimeMs = (() => {
  if (process.platform !== 'darwin') return (_pid: number): number | null => null;
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as {
      dlopen: (path: string, symbols: Record<string, { args: unknown[]; returns: unknown }>) => {
        symbols: { proc_pidinfo?: (...args: unknown[]) => number; mach_timebase_info?: (...args: unknown[]) => number };
      };
      FFIType: { i32: unknown; u64: unknown; ptr: unknown };
      ptr: (value: ArrayBufferView) => unknown;
    };
    const lib = dlopen('/usr/lib/libproc.dylib', {
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    const sys = dlopen('/usr/lib/libSystem.B.dylib', {
      mach_timebase_info: {
        args: [FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    const timebase = new Uint32Array(2);
    if (sys.symbols.mach_timebase_info?.(ptr(timebase)) !== 0 || timebase[1] === 0) {
      return (_pid: number): number | null => null;
    }
    const numer = timebase[0]!;
    const denom = timebase[1]!;
    const PROC_PIDTASKINFO = 4;
    const PROC_TASKINFO_SIZE = 96;
    return (pid: number): number | null => {
      const buf = new BigUint64Array(12);
      const n = lib.symbols.proc_pidinfo?.(pid, PROC_PIDTASKINFO, 0, ptr(buf), PROC_TASKINFO_SIZE);
      if (typeof n !== 'number' || n <= 0) return null;
      return (Number(buf[2]! + buf[3]!) * numer) / denom / 1e6;
    };
  } catch {
    return (_pid: number): number | null => null;
  }
})();

function readCpuTimeMs(pid: number): number | null {
  const procCpu = readProcCpuTimeMs(pid);
  if (procCpu !== null) return procCpu;
  return readDarwinTaskCpuTimeMs(pid);
}

function externalCpuSource(pid: number): string {
  if (existsSync(`/proc/${pid}/stat`)) return `/proc/${pid}/stat`;
  if (process.platform === 'darwin') return 'proc_pidinfo PROC_PIDTASKINFO';
  return 'unavailable';
}

function requireExternalCpuTimeMs(pid: number): number {
  const value = readCpuTimeMs(pid);
  if (value === null) {
    throw new Error(`worker ${pid} has no parent-measured CPU time (${externalCpuSource(pid)})`);
  }
  return value;
}

async function waitForReadyFile(barrier: string, pid: number, withinMs = 2_000): Promise<void> {
  const ready = `${barrier}.ready-${pid}`;
  const startedAt = Date.now();
  while (!existsSync(ready)) {
    if (Date.now() - startedAt > withinMs) throw new Error(`worker ${pid} did not become ready`);
    if (!processExists(pid)) throw new Error(`worker ${pid} exited before ready`);
    await Bun.sleep(10);
  }
}

function waitForChildClose(child: ReturnType<typeof spawn>, withinMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killPid(child.pid);
      reject(new Error(`worker ${child.pid} did not exit within ${withinMs}ms`));
    }, withinMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitForPidExitViaPs(pid: number, withinMs: number): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < withinMs) {
    const count = countPidViaPs(pid);
    if (count === 0) return count;
    await Bun.sleep(20);
  }
  return countPidViaPs(pid);
}

const workerPrelude = `
  const fs = require('node:fs');
  const { setTimeout } = require('node:timers/promises');
  const { enqueueControlMemo, drainControlInbox } = require('./control-inbox.ts');
  const barrier = process.env.CONTROL_INBOX_BARRIER;
  const parentPid = process.ppid;
  const parsedTimeout = Number(process.env.CONTROL_INBOX_BARRIER_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 10_000;
  const startedAt = Date.now();
  fs.writeFileSync(\`${'${barrier}'}.ready-\${process.pid}\`, 'ready');
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  const parentGone = () => {
    if (process.ppid !== parentPid) return true;
    try { process.kill(parentPid, 0); return false; } catch { return true; }
  };
  const wait = async () => {
    while (!fs.existsSync(barrier)) {
      if (Date.now() - startedAt >= timeoutMs) process.exit(0);
      if (parentGone()) process.exit(0);
      await setTimeout(20);
    }
  };
`;

const waitingWorkerScript = `${workerPrelude}
  await wait();
`;

const emptyDrain = { stop: false, count: 0, memos: [], structuredMemos: [], memoEntries: [], receivedCount: 0, structuredCount: 0, urgentCount: 0, malformedFallbackCount: 0 };
const stopDrain = { ...emptyDrain, stop: true, count: 1 };
const peekedMemoDrain = {
  ...emptyDrain,
  peekedMemos: ['deliver next turn'],
  peekedMemoEntries: [{ body: 'deliver next turn' }],
  peekedReceivedCount: 1,
  peekedUrgentCount: 0,
  peekedMalformedFallbackCount: 0,
};

describe('control inbox', () => {
  test('reads a valid persistent soft-stop request and preserves it', () => {
    const isolated = env();
    const spaceId = 'persistent-stop';
    const inboxDir = controlInboxPath(spaceId, isolated);
    const request = { version: 1 as const, requestedAt: '2026-09-14T00:00:00.000Z' };
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, 'stop-requested.json'), JSON.stringify(request), 'utf8');

    expect(readSoftStopRequest(spaceId, { env: isolated })).toEqual(request);
    expect(readFileSync(join(inboxDir, 'stop-requested.json'), 'utf8')).toBe(JSON.stringify(request));
  });

  test('returns null without throwing and observes an absent persistent soft-stop request', () => {
    const isolated = env();
    const spaceId = 'missing-persistent-stop';
    const path = join(controlInboxPath(spaceId, isolated), 'stop-requested.json');
    const observed: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];

    expect(() => expect(readSoftStopRequest(spaceId, {
      env: isolated,
      log: (category, event, data) => observed.push({ category, event, data }),
    })).toBeNull()).not.toThrow();
    expect(observed).toEqual([{
      category: 'control-inbox',
      event: 'soft-stop-request-absent',
      data: { spaceId, path },
    }]);
  });

  test('controlInboxPath consumes normalizeSpaceId for a post-slice-trimmed space id', () => {
    const isolated = env();
    const basename = 'self-impl-goalid-d960c670e39b709b-scripts-shell-rc-through-pipe-test-ts-go-c496a575';

    expect(controlInboxPath(basename, isolated)).toBe(join(
      isolated.ELANOUS_STATE_DIR!,
      'harness-screens',
      'self-impl-goalid-d960c670e39b709b-scripts-shell-rc-through-pipe.inbox',
    ));
  });

  test('returns null and logs non-missing persistent soft-stop read and validation failures', () => {
    const isolated = env();
    const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = (_category: string, event: string, data: Record<string, unknown>) => observed.push({ event, data });
    const invalidSpace = 'invalid-persistent-stop';
    const invalidInbox = controlInboxPath(invalidSpace, isolated);
    mkdirSync(invalidInbox, { recursive: true });
    writeFileSync(join(invalidInbox, 'stop-requested.json'), '{not-json', 'utf8');

    expect(readSoftStopRequest(invalidSpace, { env: isolated, log })).toBeNull();
    expect(observed).toEqual([{ event: 'soft-stop-request-validation-failed', data: { spaceId: invalidSpace, path: join(invalidInbox, 'stop-requested.json') } }]);

    observed.length = 0;
    const unreadableSpace = 'unreadable-persistent-stop';
    const unreadableInbox = controlInboxPath(unreadableSpace, isolated);
    mkdirSync(join(unreadableInbox, 'stop-requested.json'), { recursive: true });
    expect(readSoftStopRequest(unreadableSpace, { env: isolated, log })).toBeNull();
    expect(observed).toEqual([{ event: 'soft-stop-request-read-failed', data: {
      spaceId: unreadableSpace,
      path: join(unreadableInbox, 'stop-requested.json'),
      code: 'EISDIR',
    } }]);
  });

  test('stop is state-dir scoped, drained once, and both actions are observable', () => {
    const isolated = env();
    const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = (_category: string, event: string, data: Record<string, unknown>) => observed.push({ event, data });

    enqueueSoftStop('tui/run-1', { env: isolated, log });
    const path = controlInboxPath('tui/run-1', isolated);
    expect(path).toStartWith(isolated.ELANOUS_STATE_DIR!);
    expect(readFileSync(`${path}.ready/stop`, 'utf8')).toBe('stop\n');

    expect(drainControlInbox('tui/run-1', { env: isolated, log })).toEqual(stopDrain);
    expect(drainControlInbox('tui/run-1', { env: isolated, log })).toEqual(emptyDrain);
    expect(observed.map(({ event }) => event)).toEqual(['stop-enqueue', 'soft-stop-request-written', 'drain', 'drain']);
    expect(observed[2]!.data.stop).toBe(true);
  });

  test('an explicit parent inbox crosses state roots, drains once, and unset resolution remains legacy-compatible', () => {
    const parent = env();
    const child = env();
    const spaceId = 'shared-space';
    const explicitInboxDir = controlInboxPath(spaceId, parent);

    expect(resolveControlInboxDir(spaceId, { env: parent })).toBe(controlInboxPath(spaceId, parent));
    expect(resolveControlInboxDir(spaceId, { env: child, explicitInboxDir })).toBe(explicitInboxDir);
    expect(explicitInboxDir).not.toBe(controlInboxPath(spaceId, child));

    enqueueControlMemo(spaceId, 'read across roots', { env: parent, explicitInboxDir });
    expect(drainControlInbox(spaceId, { env: child, explicitInboxDir })).toEqual({
      ...emptyDrain,
      count: 1,
      memos: ['read across roots'],
      memoEntries: [{ body: 'read across roots' }],
      receivedCount: 1,
    });
    expect(drainControlInbox(spaceId, { env: child, explicitInboxDir })).toEqual(emptyDrain);
  });

  test('structured memos round-trip through detached framing while legacy bytes remain unchanged', () => {
    const isolated = env();
    const payload = { version: 1 as const, kind: 'review', urgency: 'urgent' as const, body: 'run focused test' };
    const frame = encodeControlMemoFrame(payload);

    expect(frame).toStartWith(CONTROL_MEMO_FRAME_PREFIX);
    expect(decodeControlMemoFrame(frame)).toEqual(payload);
    enqueueControlMemo('structured', payload, { env: isolated });
    enqueueControlMemo('structured', 'legacy line', { env: isolated });
    const records = readdirSync(`${controlInboxPath('structured', isolated)}.ready`).filter((name) => name.startsWith('record-')).sort();
    expect(readFileSync(join(`${controlInboxPath('structured', isolated)}.ready`, records[1]!), 'utf8')).toBe('memo:legacy line\n');
    expect(drainControlInbox('structured', { env: isolated })).toEqual({
      stop: false,
      count: 2,
      memos: ['run focused test', 'legacy line'],
      structuredMemos: [payload],
      memoEntries: [{ body: 'run focused test', structured: payload }, { body: 'legacy line' }],
      receivedCount: 2,
      structuredCount: 1,
      urgentCount: 1,
      malformedFallbackCount: 0,
    });
  });

  test('malformed structured frames are retained as legacy memo text', () => {
    const isolated = env();
    const spaceId = 'malformed';
    const ready = `${controlInboxPath(spaceId, isolated)}.ready`;
    mkdirSync(ready, { recursive: true });
    writeFileSync(join(ready, 'record-0000000000000001-00000000-0000-0000-0000-000000000001'), `memo:${CONTROL_MEMO_FRAME_PREFIX}not-base64\n`, 'utf8');

    expect(decodeControlMemoFrame(`${CONTROL_MEMO_FRAME_PREFIX}not-base64`)).toBeNull();
    expect(drainControlInbox(spaceId, { env: isolated })).toEqual({
      stop: false,
      count: 1,
      memos: [`${CONTROL_MEMO_FRAME_PREFIX}not-base64`],
      structuredMemos: [],
      memoEntries: [{ body: `${CONTROL_MEMO_FRAME_PREFIX}not-base64` }],
      receivedCount: 1,
      structuredCount: 0,
      urgentCount: 0,
      malformedFallbackCount: 1,
    });
  });

  test('CLI dependency probe skips only module-resolution failures', () => {
    expect(cliDependenciesAvailable({ status: 0, stderr: '', error: undefined })).toBe(true);
    expect(cliDependenciesAvailable({
      status: 1,
      stderr: "error: Cannot find module 'zod/v4' from '/tmp/node_modules/@agentclientprotocol/sdk/guards.gen.js'",
      error: undefined,
    })).toBe(false);
    expect(() => cliDependenciesAvailable({
      status: 1,
      stderr: 'error: unknown command self send',
      error: undefined,
    })).toThrow('elanous self send --help probe failed (status=1): error: unknown command self send');
    expect(() => cliDependenciesAvailable({
      status: null,
      stderr: "error: Cannot find module 'zod/v4' from '/tmp/node_modules/@agentclientprotocol/sdk/guards.gen.js'",
      error: undefined,
    })).toThrow('elanous self send --help probe failed (status=null): error: Cannot find module');
    expect(() => cliDependenciesAvailable({
      status: 1,
      stderr: "error: Cannot find module 'zod/v4' from '/tmp/node_modules/@agentclientprotocol/sdk/guards.gen.js'",
      error: new Error('spawn failed'),
    })).toThrow('elanous self send --help probe failed (status=1 error=spawn failed): error: Cannot find module');
  });

  test.skipIf(!liveCliDependenciesAvailable)('[CLI dependencies not installed — skipping live CLI tests] elanous self send --stop writes the exact target inbox', () => {
    const isolated = env();
    writeHarnessScreen('running-tui', 'working', isolated);
    const result = spawnSync(process.execPath, ['bin/elanous.mjs', 'self', 'send', 'running-tui', '--stop', '--read-wait', '0'], {
      cwd: repoRoot,
      env: { ...process.env, ...isolated },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(readFileSync(`${controlInboxPath('running-tui', isolated)}.ready/stop`, 'utf8')).toBe('stop\n');
    // 🅕 2026-09-25 — 「기록했다」≠「읽혔다」: 쓴 자리를 절대 경로로 보이고, 안 읽혔으면 그렇게 말한다.
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain(`래치: ${controlInboxPath('running-tui', isolated)}.ready/stop`);
    expect(output).toContain(`${controlInboxPath('running-tui', isolated)}/stop-requested.json`);
    expect(output).toContain('아직 안 읽힘');
  });

  test.skipIf(!liveCliDependenciesAvailable)('[CLI dependencies not installed — skipping live CLI tests] elanous self send --stop waits for the child to claim the latch', async () => {
    const isolated = env();
    writeHarnessScreen('running-tui', 'working', isolated);
    const child = Bun.spawn([process.execPath, 'bin/elanous.mjs', 'self', 'send', 'running-tui', '--stop', '--read-wait', '15'], {
      cwd: repoRoot, env: { ...process.env, ...isolated }, stdout: 'pipe', stderr: 'pipe',
    });
    const latch = `${controlInboxPath('running-tui', isolated)}.ready/stop`;
    const deadline = Date.now() + 10_000;
    while (!existsSync(latch) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(latch)).toBe(true);
    rmSync(latch); // 자식 골루프가 래치를 «집은» 것과 같다
    const code = await child.exited;
    const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
    expect(code).toBe(0);
    expect(output).toContain('자식이 읽음');
  }, 30_000);

  test.skipIf(!liveCliDependenciesAvailable)('[CLI dependencies not installed — skipping live CLI tests] elanous self send rejects an unknown explicit target without writing any inbox', () => {
    const isolated = env();
    writeHarnessScreen('running-tui', 'working', isolated);
    const result = spawnSync(process.execPath, ['bin/elanous.mjs', 'self', 'send', 'missing-tui', '--stop'], {
      cwd: repoRoot,
      env: { ...process.env, ...isolated },
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('알 수 없는 self send 대상 space: missing-tui.');
    expect(result.stderr).toContain('후보 중 하나를 지정하세요:');
    expect(result.stderr).toContain('running-tui');
    expect(() => readdirSync(`${controlInboxPath('missing-tui', isolated)}.ready`)).toThrow();
    expect(() => readdirSync(`${controlInboxPath('running-tui', isolated)}.ready`)).toThrow();
  });

  test.skipIf(!liveCliDependenciesAvailable)('[CLI dependencies not installed — skipping live CLI tests] elanous self send warns when an alive heartbeat is older than five minutes but records the memo', () => {
    const isolated = env();
    const target = 'stale-heartbeat-tui';
    writeHarnessScreen(target, 'working', isolated);
    writeFileSync(harnessScreenPath(target, isolated).replace(/\.screen$/, '.hb'), JSON.stringify({ alive: true, at: Date.now() - 5 * 60 * 1000 - 1 }));
    const result = spawnSync(process.execPath, ['bin/elanous.mjs', 'self', 'send', target, '--memo', 'warn but record', '--read-wait', '0'], {
      cwd: repoRoot,
      env: { ...process.env, ...isolated },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('space가 죽어 보입니다');
    expect(result.stderr).toContain('메모가 전달되지 않을 수 있습니다');
    expect(readdirSync(`${controlInboxPath(target, isolated)}.ready`).filter((name) => name.startsWith('record-'))).toHaveLength(1);
  });

  test.skipIf(!liveCliDependenciesAvailable)('[CLI dependencies not installed — skipping live CLI tests] elanous self send --memo records exactly one pending sentence and reports its location and count', () => {
    const isolated = env();
    writeHarnessScreen('running-tui', 'working', isolated);
    const sentence = 'run the focused test before typecheck';
    const path = controlInboxPath('running-tui', isolated);
    const result = spawnSync(process.execPath, ['bin/elanous.mjs', 'self', 'send', 'running-tui', '--memo', sentence, '--read-wait', '0'], {
      cwd: repoRoot,
      env: { ...process.env, ...isolated },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const records = readdirSync(`${path}.ready`).filter((name) => name.startsWith('record-'));
    expect(records).toHaveLength(1);
    const record = readFileSync(join(`${path}.ready`, records[0]!), 'utf8');
    expect(record).toStartWith(`memo:${CONTROL_MEMO_FRAME_PREFIX}`);
    expect(decodeControlMemoFrame(record.slice('memo:'.length).trim())).toEqual({
      version: 1,
      kind: 'supervisor',
      urgency: 'normal',
      body: sentence,
    });
    // 산출은 «기록 파일» 경로를 댄다(디렉토리 + 개수가 아니다 — 읽힌 뒤 빈 디렉토리를 «안 닿았다»로 오판한 2026-09-24 사례).
    expect(result.stdout).toContain(join(`${path}.ready`, records[0]!));
    expect(result.stdout).toContain('아직 안 읽힘');
  });

  test.skipIf(!liveCliDependenciesAvailable)('[CLI dependencies not installed — skipping live CLI tests] elanous self send maps an urgent memo marker into a structured urgent payload', () => {
    const isolated = env();
    writeHarnessScreen('running-tui', 'working', isolated);
    const path = controlInboxPath('running-tui', isolated);
    const result = spawnSync(process.execPath, ['bin/elanous.mjs', 'self', 'send', 'running-tui', '--memo', '[urgent] stop the current experiment', '--read-wait', '0'], {
      cwd: repoRoot,
      env: { ...process.env, ...isolated },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const records = readdirSync(`${path}.ready`).filter((name) => name.startsWith('record-'));
    expect(records).toHaveLength(1);
    const record = readFileSync(join(`${path}.ready`, records[0]!), 'utf8');
    expect(decodeControlMemoFrame(record.slice('memo:'.length).trim())).toEqual({
      version: 1,
      kind: 'supervisor',
      urgency: 'urgent',
      body: 'stop the current experiment',
    });
  });

  test.skipIf(!liveCliDependenciesAvailable)('[CLI dependencies not installed — skipping live CLI tests] elanous self send rejects stop and memo together without publishing a record', () => {
    const isolated = env();
    const path = controlInboxPath('running-tui', isolated);
    const result = spawnSync(process.execPath, ['bin/elanous.mjs', 'self', 'send', 'running-tui', '--stop', '--memo', 'do not send'], {
      cwd: repoRoot,
      env: { ...process.env, ...isolated },
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--stop 과 --memo를 함께 사용할 수 없습니다.');
    expect(() => readdirSync(`${path}.ready`)).toThrow();
  });

  test.skipIf(!liveCliDependenciesAvailable)('[CLI dependencies not installed — skipping live CLI tests] elanous self send reports rejected memo validation without publishing a record', () => {
    const isolated = env();
    writeHarnessScreen('running-tui', 'working', isolated);
    const path = controlInboxPath('running-tui', isolated);
    const result = spawnSync(process.execPath, ['bin/elanous.mjs', 'self', 'send', 'running-tui', '--memo', 'two\nlines'], {
      cwd: repoRoot,
      env: { ...process.env, ...isolated },
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('감독 메모를 기록할 수 없습니다: control inbox memo must be a non-empty single line');
    expect(() => readdirSync(`${path}.ready`)).toThrow();
  });

  test('inspect counts a stop and two memos without consuming the ready records', () => {
    const isolated = env();
    const spaceId = 'inspect-pending';
    const opts = { env: isolated };
    enqueueSoftStop(spaceId, opts);
    enqueueControlMemo(spaceId, 'first memo', opts);
    enqueueControlMemo(spaceId, 'second memo', opts);

    const snapshot = inspectControlInbox(spaceId, opts);
    expect(snapshot.directory).toBe('present');
    expect(snapshot.stop).toBe(true);
    expect(snapshot.memoCount).toBe(2);
    expect(snapshot.oldestMtimeMs).toBeNumber();
    expect(snapshot.unreadableCount).toBe(0);
    expect(drainControlInbox(spaceId, opts)).toEqual({
      ...stopDrain,
      count: 3,
      memos: ['first memo', 'second memo'],
      memoEntries: [{ body: 'first memo' }, { body: 'second memo' }],
      receivedCount: 2,
    });
  });

  test('inspect distinguishes an absent inbox from an empty ready directory', () => {
    const isolated = env();
    const absent = inspectControlInbox('inspect-absent', { env: isolated });
    expect(absent).toEqual({ directory: 'absent', stop: false, memoCount: 0, oldestMtimeMs: null, unreadableCount: 0 });

    const spaceId = 'inspect-empty';
    mkdirSync(`${controlInboxPath(spaceId, isolated)}.ready`, { recursive: true });
    expect(inspectControlInbox(spaceId, { env: isolated })).toEqual({ directory: 'empty', stop: false, memoCount: 0, oldestMtimeMs: null, unreadableCount: 0 });
  });

  test('inspect separately counts undecodable ready records while retaining valid counts', () => {
    const isolated = env();
    const spaceId = 'inspect-undecodable';
    const opts = { env: isolated };
    enqueueControlMemo(spaceId, 'valid memo', opts);
    const ready = `${controlInboxPath(spaceId, isolated)}.ready`;
    writeFileSync(join(ready, 'record-0000000000000001-00000000-0000-0000-0000-000000000001'), 'not-a-valid-message', 'utf8');

    expect(inspectControlInbox(spaceId, opts)).toMatchObject({ directory: 'present', stop: false, memoCount: 1, unreadableCount: 1 });
  });

  test('inspect reports an unreadable stop latch as present without consuming it', () => {
    const isolated = env();
    const spaceId = 'inspect-unreadable-stop';
    const opts = { env: isolated };
    enqueueSoftStop(spaceId, opts);
    const stopPath = join(`${controlInboxPath(spaceId, isolated)}.ready`, 'stop');
    writeFileSync(stopPath, 'not-a-valid-message', 'utf8');

    expect(inspectControlInbox(spaceId, opts)).toMatchObject({ directory: 'present', stop: true, memoCount: 0, unreadableCount: 1 });
    expect(readFileSync(stopPath, 'utf8')).toBe('not-a-valid-message');
  });

  test('repeated enqueue coalesces the idempotent stop latch and one drain consumes its generation', () => {
    const isolated = env();
    enqueueSoftStop('harness', { env: isolated });
    enqueueSoftStop('harness', { env: isolated });

    expect(drainControlInbox('harness', { env: isolated })).toEqual(stopDrain);
    expect(drainControlInbox('harness', { env: isolated })).toEqual(emptyDrain);
  });

  test('stop-only drain is absent-stop no-op and preserves memo records for a later full drain', () => {
    const isolated = env();
    const spaceId = 'stop-only';
    const opts = { env: isolated };
    enqueueControlMemo(spaceId, 'deliver next turn', opts);
    const ready = `${controlInboxPath(spaceId, isolated)}.ready`;
    const [memo] = readdirSync(ready).filter((name) => name.startsWith('record-'));

    expect(drainSoftStopControlInbox(spaceId, opts)).toEqual(peekedMemoDrain);
    expect(readFileSync(join(ready, memo!), 'utf8')).toBe('memo:deliver next turn\n');

    enqueueSoftStop(spaceId, opts);
    expect(drainSoftStopControlInbox(spaceId, opts)).toEqual({ ...peekedMemoDrain, stop: true, count: 1 });
    expect(readFileSync(join(ready, memo!), 'utf8')).toBe('memo:deliver next turn\n');
    expect(drainControlInbox(spaceId, opts)).toEqual({
      ...emptyDrain,
      count: 1,
      memos: ['deliver next turn'],
      memoEntries: [{ body: 'deliver next turn' }],
      receivedCount: 1,
    });
  });

  test('drains stop and each one-line memo exactly once from the ready snapshot', () => {
    const isolated = env();
    enqueueSoftStop('mixed', { env: isolated });
    enqueueControlMemo('mixed', 'keep the test focused', { env: isolated });
    enqueueControlMemo('mixed', 'run the typecheck next', { env: isolated });

    expect(drainControlInbox('mixed', { env: isolated })).toEqual({
      ...stopDrain,
      count: 3,
      memos: ['keep the test focused', 'run the typecheck next'],
      memoEntries: [{ body: 'keep the test focused' }, { body: 'run the typecheck next' }],
      receivedCount: 2,
    });
    expect(drainControlInbox('mixed', { env: isolated })).toEqual(emptyDrain);
  });

  test('preserves a legacy stop file and rejects invalid memo lines without publishing them', () => {
    const isolated = env();
    const path = controlInboxPath('legacy', isolated);
    mkdirSync(join(isolated.ELANOUS_STATE_DIR!, 'harness-screens'), { recursive: true });
    writeFileSync(path, 'stop\n', 'utf8');

    expect(drainControlInbox('legacy', { env: isolated })).toEqual(stopDrain);
    expect(() => enqueueControlMemo('legacy', '', { env: isolated })).toThrow('non-empty single line');
    expect(() => enqueueControlMemo('legacy', 'two\nlines', { env: isolated })).toThrow('non-empty single line');
    expect(drainControlInbox('legacy', { env: isolated })).toEqual(emptyDrain);
  });

  test('multiple memo producers retain every record while pre-existing temporary files are ignored', () => {
    const isolated = env();
    const path = controlInboxPath('many', isolated);
    const ready = `${path}.ready`;
    for (let index = 0; index < 12; index += 1) enqueueControlMemo('many', `memo-${index}`, { env: isolated });
    writeFileSync(join(ready, '.write-in-progress'), 'memo:not-ready\n', 'utf8');

    const drained = drainControlInbox('many', { env: isolated });
    expect(drained.stop).toBe(false);
    expect(drained.count).toBe(12);
    expect(drained.memos).toEqual(expect.arrayContaining(Array.from({ length: 12 }, (_, index) => `memo-${index}`)));
    expect(drainControlInbox('many', { env: isolated })).toEqual(emptyDrain);
  });

  test('cleanup removes only ready records at least maxAgeMs old and preserves fresh content', () => {
    const isolated = env();
    const spaceId = 'cleanup-age';
    const ready = `${controlInboxPath(spaceId, isolated)}.ready`;
    enqueueControlMemo(spaceId, 'stale memo', { env: isolated });
    enqueueControlMemo(spaceId, 'fresh memo', { env: isolated });
    const records = readdirSync(ready).filter((name) => name.startsWith('record-')).sort();
    const stalePath = join(ready, records[0]!);
    const freshPath = join(ready, records[1]!);
    const staleAt = new Date(Date.now() - 10_000);
    utimesSync(stalePath, staleAt, staleAt);

    expect(cleanupStaleControlInbox(spaceId, 1_000, { env: isolated })).toBe(1);
    expect(existsSync(stalePath)).toBe(false);
    expect(readFileSync(freshPath, 'utf8')).toBe('memo:fresh memo\n');
  });

  test('cleanup rejects invalid ages before mutating ready records', () => {
    const isolated = env();
    const spaceId = 'cleanup-invalid-age';
    const ready = `${controlInboxPath(spaceId, isolated)}.ready`;
    enqueueControlMemo(spaceId, 'must remain', { env: isolated });
    const record = readdirSync(ready).find((name) => name.startsWith('record-'))!;
    const recordPath = join(ready, record);
    const oldAt = new Date(Date.now() - 10_000);
    utimesSync(recordPath, oldAt, oldAt);

    for (const age of ['1000', Number.NaN, Infinity, -Infinity, -1]) {
      expect(() => cleanupStaleControlInbox(spaceId, age as number, { env: isolated })).toThrow('finite non-negative number');
      expect(readFileSync(recordPath, 'utf8')).toBe('memo:must remain\n');
    }
  });

  test('cleanup silently skips an old record claimed by a consumer after its ready snapshot', () => {
    const isolated = env();
    const spaceId = 'cleanup-claim-race';
    const ready = `${controlInboxPath(spaceId, isolated)}.ready`;
    enqueueControlMemo(spaceId, 'consumer owns this', { env: isolated });
    const record = readdirSync(ready).find((name) => name.startsWith('record-'))!;
    const recordPath = join(ready, record);
    const claimPath = `${recordPath}.claim-consumer`;
    const oldAt = new Date(Date.now() - 10_000);
    utimesSync(recordPath, oldAt, oldAt);
    let claimedByConsumer = false;

    expect(cleanupStaleControlInbox(spaceId, 1_000, {
      env: isolated,
      log: (_category, event, data) => {
        if (event === 'cleanup-claim-attempt' && !claimedByConsumer) {
          claimedByConsumer = true;
          renameSync(data.path as string, claimPath);
        }
      },
    })).toBe(0);
    expect(claimedByConsumer).toBe(true);
    expect(readFileSync(claimPath, 'utf8')).toBe('memo:consumer owns this\n');
  });

  test('parallel producers and drains consume every memo exactly once without claim theft or resurrection', async () => {
    const isolated = env();
    const waitForBarrier = async (barrier: string, count: number): Promise<void> => {
      for (let attempt = 0; readdirSync(isolated.ELANOUS_STATE_DIR!).filter((name) => name.startsWith(`${barrier.split('/').pop()}.ready-`)).length < count; attempt += 1) {
        if (attempt === 200) throw new Error('parallel control-inbox workers did not reach the barrier');
        await Bun.sleep(10);
      }
    };
    const barrier = join(isolated.ELANOUS_STATE_DIR!, 'control-inbox-parallel');
    const workerEnv = { ...isolated, CONTROL_INBOX_BARRIER: barrier, CONTROL_INBOX_BARRIER_TIMEOUT_MS: '15000' } as NodeJS.ProcessEnv;
    const producerScripts = Array.from({ length: 24 }, (_, index) => `${workerPrelude}
      await wait();
      enqueueControlMemo('parallel', 'memo-${index}', { env: process.env });
    `);
    const producers = producerScripts.map((script) => runWorker(script, workerEnv));
    const drainScript = `${workerPrelude}
      await wait();
      const memos = [];
      for (let attempt = 0; attempt < 50; attempt += 1) {
        memos.push(...drainControlInbox('parallel', { env: process.env }).memos);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      console.log(JSON.stringify(memos));
    `;
    const drains = [runWorker(drainScript, workerEnv), runWorker(drainScript, workerEnv)];
    await waitForBarrier(barrier, producers.length + drains.length);
    releaseBarrier(barrier);
    const [drainedByWorkers] = await Promise.all([
      Promise.all(drains).then((results) => results.flatMap((line) => JSON.parse(line) as string[])),
      Promise.all(producers),
    ]);
    const finalDrain = drainControlInbox('parallel', { env: isolated });
    const all = [...drainedByWorkers, ...(finalDrain.memos ?? [])];

    expect(all).toHaveLength(24);
    expect(new Set(all).size).toBe(24);
    expect(all).toEqual(expect.arrayContaining(Array.from({ length: 24 }, (_, index) => `memo-${index}`)));
    expect(drainControlInbox('parallel', { env: isolated })).toEqual(emptyDrain);
  }, 20_000);

  const WORKER_SELF_TIMEOUT_MS = 400;
  const LOW_CPU_BUDGET_MS = 80;
  const CPU_SAMPLE_MS = 400;
  const ORPHAN_EXIT_WITHIN_MS = 2_000;

  function waitingScriptWith(waitBody: string): string {
    return `
      const fs = require('node:fs');
      const { setTimeout } = require('node:timers/promises');
      const barrier = process.env.CONTROL_INBOX_BARRIER;
      const parentPid = process.ppid;
      const parsedTimeout = Number(process.env.CONTROL_INBOX_BARRIER_TIMEOUT_MS);
      const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 10_000;
      const startedAt = Date.now();
      fs.writeFileSync(\`\${barrier}.ready-\${process.pid}\`, 'ready');
      process.on('SIGTERM', () => process.exit(0));
      process.on('SIGINT', () => process.exit(0));
      const parentGone = () => {
        if (process.ppid !== parentPid) return true;
        try { process.kill(parentPid, 0); return false; } catch { return true; }
      };
      const wait = async () => {
        while (!fs.existsSync(barrier)) {
          ${waitBody}
        }
      };
      await wait();
    `;
  }

  test('a waiting worker exits by itself when the barrier never arrives', async () => {
    const isolated = env();
    const barrier = join(isolated.ELANOUS_STATE_DIR!, 'control-inbox-timeout');
    const startedAt = Date.now();
    const child = spawnObservedWorker(waitingWorkerScript, {
      ...isolated,
      CONTROL_INBOX_BARRIER: barrier,
      CONTROL_INBOX_BARRIER_TIMEOUT_MS: String(WORKER_SELF_TIMEOUT_MS),
    });
    const pid = child.pid!;
    await waitForReadyFile(barrier, pid);
    const closed = await waitForChildClose(child, WORKER_SELF_TIMEOUT_MS + 1_000);
    const elapsedMs = Date.now() - startedAt;
    expect(closed.code).toBe(0);
    expect(processExists(pid)).toBe(false);
    expect(elapsedMs, `timeout elapsedMs=${elapsedMs}`).toBeGreaterThanOrEqual(WORKER_SELF_TIMEOUT_MS);
    expect(elapsedMs, `timeout elapsedMs=${elapsedMs}`).toBeLessThan(WORKER_SELF_TIMEOUT_MS + 1_000);
    console.log(`timeout elapsedMs=${elapsedMs}`);
  });

  test('a waiting worker exits when it receives SIGTERM', async () => {
    const isolated = env();
    const barrier = join(isolated.ELANOUS_STATE_DIR!, 'control-inbox-signal');
    const child = spawnObservedWorker(waitingWorkerScript, {
      ...isolated,
      CONTROL_INBOX_BARRIER: barrier,
      CONTROL_INBOX_BARRIER_TIMEOUT_MS: '30000',
    });
    const pid = child.pid!;
    await waitForReadyFile(barrier, pid);
    process.kill(pid, 'SIGTERM');
    const closed = await waitForChildClose(child, 1_000);
    expect(closed.code === 0 || closed.signal === 'SIGTERM').toBe(true);
    expect(processExists(pid)).toBe(false);
    console.log(`signal closed code=${closed.code} signal=${closed.signal}`);
  });

  test('a waiting worker is gone from ps after its parent disappears', async () => {
    const isolated = env();
    const barrier = join(isolated.ELANOUS_STATE_DIR!, 'control-inbox-orphan');
    const pidFile = join(isolated.ELANOUS_STATE_DIR!, 'worker.pid');
    const parentScript = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(waitingWorkerScript)}], {
        cwd: ${JSON.stringify(import.meta.dir)},
        env: Object.assign({}, process.env, {
          ELANOUS_STATE_DIR: ${JSON.stringify(isolated.ELANOUS_STATE_DIR)},
          CONTROL_INBOX_BARRIER: ${JSON.stringify(barrier)},
          CONTROL_INBOX_BARRIER_TIMEOUT_MS: '30000',
        }),
        stdio: 'ignore',
      });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `;
    const parent = spawnObservedWorker(parentScript, isolated);
    extraPids.add(parent.pid!);
    const parentStartedAt = Date.now();
    while (!existsSync(pidFile)) {
      if (Date.now() - parentStartedAt > 2_000) throw new Error('orphan parent did not publish worker pid');
      await Bun.sleep(10);
    }
    const workerPid = Number(readFileSync(pidFile, 'utf8'));
    extraPids.add(workerPid);
    await waitForReadyFile(barrier, workerPid);
    killPid(parent.pid, 'SIGKILL');
    const remaining = await waitForPidExitViaPs(workerPid, ORPHAN_EXIT_WITHIN_MS);
    expect(remaining, `orphan ps count=${remaining}`).toBe(0);
    console.log(`orphan ps count=${remaining}`);
  });

  test('a waiting worker spends almost no CPU', async () => {
    const isolated = env();
    const barrier = join(isolated.ELANOUS_STATE_DIR!, 'control-inbox-cpu');
    const child = spawnObservedWorker(waitingWorkerScript, {
      ...isolated,
      CONTROL_INBOX_BARRIER: barrier,
      CONTROL_INBOX_BARRIER_TIMEOUT_MS: '30000',
    });
    const pid = child.pid!;
    await waitForReadyFile(barrier, pid);
    const source = externalCpuSource(pid);
    expect(source === `/proc/${pid}/stat` || source === 'proc_pidinfo PROC_PIDTASKINFO').toBe(true);
    const before = requireExternalCpuTimeMs(pid);
    await Bun.sleep(CPU_SAMPLE_MS);
    const after = requireExternalCpuTimeMs(pid);
    expect(after - before, `cpu deltaMs=${after - before} source=${source}`).toBeLessThan(LOW_CPU_BUDGET_MS);
    console.log(`cpu deltaMs=${after - before} source=${source}`);
    killPid(pid, 'SIGTERM');
    await waitForChildClose(child, 1_000);
  });

  test('a worker without a barrier deadline stays alive past the hardened timeout', async () => {
    const isolated = env();
    const barrier = join(isolated.ELANOUS_STATE_DIR!, 'control-inbox-no-timeout');
    const child = spawnObservedWorker(waitingScriptWith(`
      if (parentGone()) process.exit(0);
      await setTimeout(20);
    `), {
      ...isolated,
      CONTROL_INBOX_BARRIER: barrier,
      CONTROL_INBOX_BARRIER_TIMEOUT_MS: String(WORKER_SELF_TIMEOUT_MS),
    });
    const pid = child.pid!;
    await waitForReadyFile(barrier, pid);
    await Bun.sleep(WORKER_SELF_TIMEOUT_MS + 300);
    expect(processExists(pid)).toBe(true);
    killPid(pid, 'SIGKILL');
    await waitForChildClose(child, 1_000);
  });

  test('a SIGTERM-capable CPU-burning wait exceeds the low-CPU budget', async () => {
    const isolated = env();
    const barrier = join(isolated.ELANOUS_STATE_DIR!, 'control-inbox-cpu-burn');
    const child = spawnObservedWorker(waitingScriptWith(`
      if (Date.now() - startedAt >= timeoutMs) process.exit(0);
      if (parentGone()) process.exit(0);
      const spinUntil = Date.now() + 20;
      while (Date.now() < spinUntil) {}
      await setTimeout(0);
    `), {
      ...isolated,
      CONTROL_INBOX_BARRIER: barrier,
      CONTROL_INBOX_BARRIER_TIMEOUT_MS: '30000',
    });
    const pid = child.pid!;
    await waitForReadyFile(barrier, pid);
    const before = requireExternalCpuTimeMs(pid);
    await Bun.sleep(CPU_SAMPLE_MS);
    const after = requireExternalCpuTimeMs(pid);
    expect(after - before).toBeGreaterThanOrEqual(LOW_CPU_BUDGET_MS);
    killPid(pid, 'SIGTERM');
    await waitForChildClose(child, 1_000);
  });

  test('self send candidate display puts recent valid frames first and hides stale or invalid frames by default', () => {
    const now = Date.parse('2026-08-22T12:00:00.000Z');
    const display = formatSelfSendCandidateDisplay([
      { spaceId: 'three-days-old-zombie', mtimeMs: now - 3 * 24 * 60 * 60 * 1000 },
      { spaceId: 'active-tui', mtimeMs: now - 1_000 },
      { spaceId: 'invalid-frame', mtimeMs: Number.NaN },
    ], { now });

    expect(display.lines).toEqual(['  active-tui  마지막 프레임: 2026-08-22T11:59:59.000Z']);
    expect(display.hiddenStaleCount).toBe(2);
    expect(SELF_SEND_RECENT_FRAME_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  test('self send candidate display includes stale and invalid frame timestamps on request', () => {
    const now = Date.parse('2026-08-22T12:00:00.000Z');
    const display = formatSelfSendCandidateDisplay([
      { spaceId: 'active-tui', mtimeMs: now - 1_000 },
      { spaceId: 'three-days-old-zombie', mtimeMs: now - 3 * 24 * 60 * 60 * 1000 },
      { spaceId: 'invalid-frame', mtimeMs: Number.NaN },
    ], { now, includeStale: true });

    expect(display.lines).toEqual([
      '  active-tui  마지막 프레임: 2026-08-22T11:59:59.000Z',
      '  three-days-old-zombie  마지막 프레임: 2026-08-19T12:00:00.000Z',
      '  invalid-frame  마지막 프레임: 알 수 없음',
    ]);
    expect(display.hiddenStaleCount).toBe(0);
  });

  test('self send candidate display marks a three-attempt group and its newest without labeling an unrelated prefix', () => {
    const now = Date.parse('2026-08-31T12:00:00.000Z');
    const display = formatSelfSendCandidateDisplay([
      { spaceId: 'self-impl-implementation-target-not-narrowed-goali-91e045ce', mtimeMs: Date.parse('2026-08-31T11:46:00.000Z') },
      { spaceId: 'self-impl-implementation-target-not-narrowed-goali-f87e0fef', mtimeMs: Date.parse('2026-08-31T11:45:06.000Z') },
      { spaceId: 'self-impl-implementation-target-not-narrowed-goali-48b95b8e', mtimeMs: Date.parse('2026-08-31T11:27:48.000Z') },
      { spaceId: 'self-impl-unrelated-goal-00aabbcc', mtimeMs: Date.parse('2026-08-31T11:50:00.000Z') },
    ], { now });

    expect(display.lines).toEqual([
      '  self-impl-implementation-target-not-narrowed-goali-91e045ce  마지막 프레임: 2026-08-31T11:46:00.000Z  · 같은 골의 다른 시도 · 가장 최근',
      '  self-impl-implementation-target-not-narrowed-goali-f87e0fef  마지막 프레임: 2026-08-31T11:45:06.000Z  · 같은 골의 다른 시도',
      '  self-impl-implementation-target-not-narrowed-goali-48b95b8e  마지막 프레임: 2026-08-31T11:27:48.000Z  · 같은 골의 다른 시도',
      '  self-impl-unrelated-goal-00aabbcc  마지막 프레임: 2026-08-31T11:50:00.000Z',
    ]);
    expect(display.hiddenStaleCount).toBe(0);
  });

  test('self send candidate display does not call distinct prefixes the same goal', () => {
    const now = Date.parse('2026-08-31T12:00:00.000Z');
    const display = formatSelfSendCandidateDisplay([
      { spaceId: 'self-impl-alpha-goal-11111111', mtimeMs: now - 1_000 },
      { spaceId: 'self-impl-beta-goal-22222222', mtimeMs: now - 2_000 },
      { spaceId: 'self-impl-gamma-goal-33333333', mtimeMs: now - 3_000 },
    ], { now });

    expect(display.lines).toEqual([
      '  self-impl-alpha-goal-11111111  마지막 프레임: 2026-08-31T11:59:59.000Z',
      '  self-impl-beta-goal-22222222  마지막 프레임: 2026-08-31T11:59:58.000Z',
      '  self-impl-gamma-goal-33333333  마지막 프레임: 2026-08-31T11:59:57.000Z',
    ]);
    expect(display.lines.every((line) => !line.includes('같은 골의 다른 시도'))).toBe(true);
  });

  test('self send candidate display keeps hiddenStaleCount and include-stale for same-goal attempts', () => {
    const now = Date.parse('2026-08-31T12:00:00.000Z');
    const candidates = [
      { spaceId: 'self-impl-shared-goal-aaaaaaa1', mtimeMs: now - 1_000 },
      { spaceId: 'self-impl-shared-goal-aaaaaaa2', mtimeMs: now - 3 * 24 * 60 * 60 * 1000 },
      { spaceId: 'self-impl-shared-goal-aaaaaaa3', mtimeMs: now - 2_000 },
    ];

    const hidden = formatSelfSendCandidateDisplay(candidates, { now });
    expect(hidden.lines).toEqual([
      '  self-impl-shared-goal-aaaaaaa1  마지막 프레임: 2026-08-31T11:59:59.000Z  · 같은 골의 다른 시도 · 가장 최근',
      '  self-impl-shared-goal-aaaaaaa3  마지막 프레임: 2026-08-31T11:59:58.000Z  · 같은 골의 다른 시도',
    ]);
    expect(hidden.hiddenStaleCount).toBe(1);

    const shown = formatSelfSendCandidateDisplay(candidates, { now, includeStale: true });
    expect(shown.lines).toEqual([
      '  self-impl-shared-goal-aaaaaaa1  마지막 프레임: 2026-08-31T11:59:59.000Z  · 같은 골의 다른 시도 · 가장 최근',
      '  self-impl-shared-goal-aaaaaaa3  마지막 프레임: 2026-08-31T11:59:58.000Z  · 같은 골의 다른 시도',
      '  self-impl-shared-goal-aaaaaaa2  마지막 프레임: 2026-08-28T12:00:00.000Z  · 같은 골의 다른 시도',
    ]);
    expect(shown.hiddenStaleCount).toBe(0);
  });

  test('self send candidate display does not name a newest attempt when a duplicate id has unknown mtime', () => {
    const now = Date.parse('2026-08-31T12:00:00.000Z');
    const candidates = [
      { spaceId: 'self-impl-shared-goal-abcd0001', mtimeMs: now - 1_000 },
      { spaceId: 'self-impl-shared-goal-abcd0001', mtimeMs: Number.NaN },
      { spaceId: 'self-impl-shared-goal-abcd0002', mtimeMs: now - 2_000 },
    ];

    const hidden = formatSelfSendCandidateDisplay(candidates, { now });
    expect(hidden.lines).toEqual([
      '  self-impl-shared-goal-abcd0001  마지막 프레임: 2026-08-31T11:59:59.000Z  · 같은 골의 다른 시도',
      '  self-impl-shared-goal-abcd0002  마지막 프레임: 2026-08-31T11:59:58.000Z  · 같은 골의 다른 시도',
    ]);
    expect(hidden.hiddenStaleCount).toBe(1);
    expect(hidden.lines.every((line) => !line.includes('가장 최근'))).toBe(true);

    const shown = formatSelfSendCandidateDisplay(candidates, { now, includeStale: true });
    expect(shown.lines).toEqual([
      '  self-impl-shared-goal-abcd0001  마지막 프레임: 2026-08-31T11:59:59.000Z  · 같은 골의 다른 시도',
      '  self-impl-shared-goal-abcd0002  마지막 프레임: 2026-08-31T11:59:58.000Z  · 같은 골의 다른 시도',
      '  self-impl-shared-goal-abcd0001  마지막 프레임: 알 수 없음  · 같은 골의 다른 시도',
    ]);
    expect(shown.hiddenStaleCount).toBe(0);
    expect(shown.lines.every((line) => !line.includes('가장 최근'))).toBe(true);
  });

  test.skipIf(!liveCliDependenciesAvailable)('[CLI dependencies not installed — skipping live CLI tests] elanous self send --stop without a space selects the sole screen', () => {
    const isolated = env();
    writeHarnessScreen('active-tui', 'working', isolated);
    const result = spawnSync(process.execPath, ['bin/elanous.mjs', 'self', 'send', '--stop', '--read-wait', '0'], {
      cwd: repoRoot,
      env: { ...process.env, ...isolated },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(readFileSync(`${controlInboxPath('active-tui', isolated)}.ready/stop`, 'utf8')).toBe('stop\n');
  });

  test.skipIf(!liveCliDependenciesAvailable)('[CLI dependencies not installed — skipping live CLI tests] elanous self send --stop hides stale ambiguous screens by default and does not write any inbox', () => {
    const isolated = env();
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    writeHarnessScreen('three-days-old-zombie', 'old frame', isolated);
    utimesSync(join(isolated.ELANOUS_STATE_DIR!, 'harness-screens', 'three-days-old-zombie.screen'), threeDaysAgo, threeDaysAgo);
    writeHarnessScreen('active-tui', 'new frame', isolated);
    const result = spawnSync(process.execPath, ['bin/elanous.mjs', 'self', 'send', '--stop', '--read-wait', '0'], {
      cwd: repoRoot,
      env: { ...process.env, ...isolated },
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('soft stop 대상이 모호합니다. space를 지정하세요.');
    expect(result.stderr).toContain('active-tui  마지막 프레임:');
    expect(result.stderr).not.toContain('three-days-old-zombie  마지막 프레임:');
    expect(result.stderr).toContain('오래된 후보 1개 숨김 (--include-stale로 표시)');
    expect(() => readFileSync(controlInboxPath('three-days-old-zombie', isolated), 'utf8')).toThrow();
    expect(() => readFileSync(controlInboxPath('active-tui', isolated), 'utf8')).toThrow();
  });

  test.skipIf(!liveCliDependenciesAvailable)('[CLI dependencies not installed — skipping live CLI tests] elanous self send --include-stale shows stale ambiguous screens and still writes no inbox', () => {
    const isolated = env();
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    writeHarnessScreen('three-days-old-zombie', 'old frame', isolated);
    utimesSync(join(isolated.ELANOUS_STATE_DIR!, 'harness-screens', 'three-days-old-zombie.screen'), threeDaysAgo, threeDaysAgo);
    writeHarnessScreen('active-tui', 'new frame', isolated);
    const result = spawnSync(process.execPath, ['bin/elanous.mjs', 'self', 'send', '--stop', '--include-stale', '--read-wait', '0'], {
      cwd: repoRoot,
      env: { ...process.env, ...isolated },
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('soft stop 대상이 모호합니다. space를 지정하세요.');
    expect(result.stderr).toContain(`three-days-old-zombie  마지막 프레임: ${threeDaysAgo.toISOString()}`);
    expect(result.stderr).toContain('active-tui  마지막 프레임:');
    expect(result.stderr).not.toContain('오래된 후보 1개 숨김');
    expect(() => readFileSync(controlInboxPath('three-days-old-zombie', isolated), 'utf8')).toThrow();
    expect(() => readFileSync(controlInboxPath('active-tui', isolated), 'utf8')).toThrow();
  });

  test('preserves an undecodable record with cumulative restoreCount in the ready name and leaves the body unchanged', () => {
    const isolated = env();
    const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = (_category: string, event: string, data: Record<string, unknown>) => observed.push({ event, data });
    const spaceId = 'restore-count';
    const ready = `${controlInboxPath(spaceId, isolated)}.ready`;
    mkdirSync(ready, { recursive: true });
    const name = 'record-0000000000000001-00000000-0000-0000-0000-000000000001';
    const body = 'not-a-valid-message';
    writeFileSync(join(ready, name), body, 'utf8');

    expect(drainControlInbox(spaceId, { env: isolated, log })).toEqual(emptyDrain);
    expect(observed.filter(({ event }) => event === 'drain-record-preserved').map(({ data }) => data.restoreCount)).toEqual([1]);
    expect(observed.some(({ event }) => event === 'drain')).toBe(true);
    expect(existsSync(join(ready, name))).toBe(false);
    expect(readFileSync(join(ready, `${name}.r1`), 'utf8')).toBe(body);

    observed.length = 0;
    expect(drainControlInbox(spaceId, { env: isolated, log })).toEqual(emptyDrain);
    expect(observed.filter(({ event }) => event === 'drain-record-preserved').map(({ data }) => data.restoreCount)).toEqual([2]);
    expect(existsSync(join(ready, `${name}.r1`))).toBe(false);
    expect(readFileSync(join(ready, `${name}.r2`), 'utf8')).toBe(body);
    expect(readdirSync(ready).some((entry) => entry.endsWith('.attempts'))).toBe(false);
  });

  test('a successful drain logs drain without drain-record-preserved', () => {
    const isolated = env();
    const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = (_category: string, event: string, data: Record<string, unknown>) => observed.push({ event, data });
    enqueueControlMemo('known-negative', 'deliver this', { env: isolated, log });

    expect(drainControlInbox('known-negative', { env: isolated, log })).toEqual({
      ...emptyDrain,
      count: 1,
      memos: ['deliver this'],
      memoEntries: [{ body: 'deliver this' }],
      receivedCount: 1,
    });
    expect(observed.filter(({ event }) => event === 'drain')).toHaveLength(1);
    expect(observed.filter(({ event }) => event === 'drain-record-preserved')).toHaveLength(0);
  });

  test('legacy inbox restoreCount accumulates beside the original path without rewriting the body', () => {
    const isolated = env();
    const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = (_category: string, event: string, data: Record<string, unknown>) => observed.push({ event, data });
    const path = controlInboxPath('legacy-restore', isolated);
    mkdirSync(join(isolated.ELANOUS_STATE_DIR!, 'harness-screens'), { recursive: true });
    const body = 'not-stop-or-memo';
    writeFileSync(path, body, 'utf8');

    expect(drainControlInbox('legacy-restore', { env: isolated, log })).toEqual(emptyDrain);
    expect(observed.filter(({ event }) => event === 'drain-record-preserved').map(({ data }) => data.restoreCount)).toEqual([1]);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(`${path}.r1`, 'utf8')).toBe(body);

    observed.length = 0;
    expect(drainControlInbox('legacy-restore', { env: isolated, log })).toEqual(emptyDrain);
    expect(observed.filter(({ event }) => event === 'drain-record-preserved').map(({ data }) => data.restoreCount)).toEqual([2]);
    expect(existsSync(`${path}.r1`)).toBe(false);
    expect(readFileSync(`${path}.r2`, 'utf8')).toBe(body);
  });

  test('repeated restores keep counting without rejecting or deleting the record', () => {
    const isolated = env();
    const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = (_category: string, event: string, data: Record<string, unknown>) => observed.push({ event, data });
    const spaceId = 'restore-unbounded';
    const ready = `${controlInboxPath(spaceId, isolated)}.ready`;
    mkdirSync(ready, { recursive: true });
    const name = 'record-0000000000000002-00000000-0000-0000-0000-000000000002';
    const body = 'still-undecodable';
    writeFileSync(join(ready, name), body, 'utf8');

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      observed.length = 0;
      expect(drainControlInbox(spaceId, { env: isolated, log })).toEqual(emptyDrain);
      expect(observed.filter(({ event }) => event === 'drain-record-preserved').map(({ data }) => data.restoreCount)).toEqual([attempt]);
      expect(readFileSync(join(ready, `${name}.r${attempt}`), 'utf8')).toBe(body);
    }
  });

  test('an existing .rN sibling is not overwritten and restoreCount follows the free suffix', () => {
    const isolated = env();
    const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
    const spaceId = 'restore-collision';
    const ready = `${controlInboxPath(spaceId, isolated)}.ready`;
    mkdirSync(ready, { recursive: true });
    const name = 'record-0000000000000003-00000000-0000-0000-0000-000000000003';
    const body = 'undecodable-original';
    const siblingBody = 'must-not-be-clobbered';
    writeFileSync(join(ready, name), body, 'utf8');
    const log = (_category: string, event: string, data: Record<string, unknown>) => {
      observed.push({ event, data });
      if (event === 'drain-restore-attempt' && data.restoreCount === 1) {
        writeFileSync(data.path as string, siblingBody, 'utf8');
      }
    };

    expect(drainControlInbox(spaceId, { env: isolated, log })).toEqual(emptyDrain);
    expect(observed.filter(({ event }) => event === 'drain-record-preserved').map(({ data }) => data.restoreCount)).toEqual([2]);
    expect(readFileSync(join(ready, `${name}.r1`), 'utf8')).toBe(siblingBody);
    expect(readFileSync(join(ready, `${name}.r2`), 'utf8')).toBe(body);
    expect(existsSync(join(ready, name))).toBe(false);
  });

  test('a failed restore does not log drain-record-preserved or delete the claim', () => {
    const isolated = env();
    const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
    const spaceId = 'restore-failed';
    const ready = `${controlInboxPath(spaceId, isolated)}.ready`;
    mkdirSync(ready, { recursive: true });
    const name = 'record-0000000000000004-00000000-0000-0000-0000-000000000004';
    const body = 'undecodable-keep-claim';
    writeFileSync(join(ready, name), body, 'utf8');
    let sabotaged = false;
    const log = (_category: string, event: string, data: Record<string, unknown>) => {
      observed.push({ event, data });
      if (event === 'drain-restore-attempt' && !sabotaged) {
        sabotaged = true;
        chmodSync(ready, 0o555);
      }
    };

    try {
      expect(drainControlInbox(spaceId, { env: isolated, log })).toEqual(emptyDrain);
    } finally {
      chmodSync(ready, 0o755);
    }

    expect(sabotaged).toBe(true);
    expect(observed.filter(({ event }) => event === 'drain-record-preserved')).toHaveLength(0);
    expect(observed.filter(({ event }) => event === 'drain-restore-failed')).toHaveLength(1);
    expect(existsSync(join(ready, `${name}.r1`))).toBe(false);
    expect(readdirSync(ready).some((entry) => readFileSync(join(ready, entry), 'utf8') === body)).toBe(true);
  });

  test('enqueueSoftStop leaves a durable marker that drainSoftStopControlInbox does not consume', () => {
    const isolated = env();
    const spaceId = 'durable-after-drain';
    const inbox = controlInboxPath(spaceId, isolated);
    const ready = `${inbox}.ready`;
    enqueueSoftStop(spaceId, { env: isolated });
    const beforeDrain = readSoftStopRequest(spaceId, { env: isolated });
    expect(beforeDrain?.version).toBe(1);
    expect(typeof beforeDrain?.requestedAt).toBe('string');
    expect(Number.isNaN(Date.parse(beforeDrain!.requestedAt))).toBe(false);
    expect(existsSync(join(ready, 'stop'))).toBe(true);

    expect(drainSoftStopControlInbox(spaceId, { env: isolated }).stop).toBe(true);
    expect(existsSync(join(ready, 'stop'))).toBe(false);
    expect(readSoftStopRequest(spaceId, { env: isolated })).toEqual(beforeDrain);
    expect(existsSync(join(inbox, 'stop-requested.json'))).toBe(true);
  });

  test('a stop enqueued after the child has finished still survives a later drain', () => {
    const isolated = env();
    const spaceId = 'durable-after-child-finished';
    const inbox = controlInboxPath(spaceId, isolated);
    const ready = `${inbox}.ready`;
    expect(drainSoftStopControlInbox(spaceId, { env: isolated })).toMatchObject({ stop: false, count: 0 });

    enqueueSoftStop(spaceId, { env: isolated });
    const afterEnqueue = readSoftStopRequest(spaceId, { env: isolated });
    expect(afterEnqueue?.version).toBe(1);
    expect(existsSync(join(ready, 'stop'))).toBe(true);

    expect(drainSoftStopControlInbox(spaceId, { env: isolated }).stop).toBe(true);
    expect(existsSync(join(ready, 'stop'))).toBe(false);
    expect(readSoftStopRequest(spaceId, { env: isolated })).toEqual(afterEnqueue);
    expect(existsSync(join(inbox, 'stop-requested.json'))).toBe(true);
  });

  test('a second enqueueSoftStop keeps the first requestedAt', () => {
    const isolated = env();
    const spaceId = 'durable-first-requested-at';
    enqueueSoftStop(spaceId, { env: isolated });
    const first = readSoftStopRequest(spaceId, { env: isolated });
    enqueueSoftStop(spaceId, { env: isolated });
    expect(readSoftStopRequest(spaceId, { env: isolated })).toEqual(first);
  });
});

describe('enqueueControlMemo return value', () => {
  test('returns the published record path, which disappears once a drain claims it', () => {
    const root = mkdtempSync(join(tmpdir(), 'control-inbox-return-'));
    try {
      const env = { ELANOUS_STATE_DIR: root } as NodeJS.ProcessEnv;
      const recordPath = enqueueControlMemo('returns-path', 'find me', { env });
      expect(recordPath.startsWith(join(controlInboxPath('returns-path', env) + '.ready', 'record-'))).toBe(true);
      expect(existsSync(recordPath)).toBe(true);
      expect(drainControlInbox('returns-path', { env }).memos).toEqual(['find me']);
      expect(existsSync(recordPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
