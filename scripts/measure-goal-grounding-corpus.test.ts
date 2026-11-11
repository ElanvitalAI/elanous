import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GROUNDING_HEADER } from '../src/self-implement/ground-goal.js';
import { assertCorpusHasNoAnswerPathSearchTermLeaks, assertCorpusSearchTermsComeFromAsk, CORPUS_MAX_WORKERS, corpusLiveWorkerCount, corpusRepeats, measureGoalGroundingCorpus, runCorpusRunner } from './measure-goal-grounding-corpus.js';

/** ⭐ 프로덕션 러너에 테스트 스위치를 두지 않는다 — 가짜 worker 를 스폰해서 검증한다. */
const FAKE_WORKER = new URL('./__fixtures__/corpus-fake-worker.ts', import.meta.url).pathname;

const script = join(import.meta.dir, 'measure-goal-grounding-corpus.ts');
const codeOnlyBlock = `${GROUNDING_HEADER}\n- src/code-only.ts: codeOnly`;

// ⛔ 실측(2026-07-30): 실제 측정이 도는 동안 **이 스위트 전체가 실패**했다 — CLI 테스트들이
//    `CORPUS_RUNNER_LOCK_PATH` 를 안 넘겨 **운영 락**(tmpdir 공유)에 걸렸고, 선점 검사가
//    두 번째 프로세스를 정당하게 거부했기 때문이다. ⇒ 테스트가 **자기 락**을 쓰게 기본값을 준다.
//    ⚠️ 선점 검사 자체를 검증하는 테스트만 **같은 경로를 명시적으로 공유**한다(그게 그 테스트의 요점).
let lockSeq = 0;
// ⚠️ ⭐ 아이러니: **자원 누수를 고치는 PR 에서 내가 temp 디렉터리를 누수했다**(리뷰 should-fix).
//    ⇒ 만든 것을 추적해 스위트 끝에 지운다.
const lockDirectories: string[] = [];
afterAll(() => { for (const directory of lockDirectories) rmSync(directory, { recursive: true, force: true }); });

function startCli(env: Record<string, string>): ChildProcess {
  const lockDirectory = mkdtempSync(join(tmpdir(), 'corpus-lock-'));
  lockDirectories.push(lockDirectory);
  const isolatedLock = join(lockDirectory, `runner-${lockSeq += 1}.lock`);
  return spawn(process.execPath, [script], {
    detached: true,
    env: { ...process.env, CORPUS_REPEATS: '1', CORPUS_RUNNER_LOCK_PATH: isolatedLock, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForLine(child: ChildProcess): Promise<{ line: string; stdout: string }> {
  let stdout = '';
  return await new Promise((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline >= 0) resolve({ line: stdout.slice(0, newline), stdout });
    });
    child.once('error', reject);
    child.once('close', (code) => reject(new Error(`process ended before a JSONL line (${code}): ${stdout}`)));
  });
}

async function collect(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = ''; let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk; });
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk; });
  const [code] = await once(child, 'close') as [number | null];
  return { code, stdout, stderr };
}

function lifecyclePeak(path: string): number {
  let active = 0;
  let peak = 0;
  for (const event of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
    active += event === 'start' ? 1 : -1;
    peak = Math.max(peak, active);
  }
  return peak;
}

function isLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return Number(readFileSync(path, 'utf8'));
    await Bun.sleep(25);
  }
  throw new Error(`worker did not write PID: ${path}`);
}

/** 프로세스 표에서 마커를 가진 잔존 프로세스를 센다.
 *  ⭐ **스냅샷을 파일 없이 한 번에 받고 그 안에서 센다** — `ps | grep <패턴>` 은 **관측자 자신**과
 *     그 패턴을 argv 에 가진 다른 검색 프로세스를 함께 세므로 값이 오염된다(같은 창 실측 2회).
 *  ⇒ 마커는 이 테스트가 만든 고유 문자열이고, 자기 `ps` 프로세스는 argv 에 마커가 없다. */
async function countProcessesMatching(marker: string): Promise<number> {
  const snapshot = await new Promise<string>((resolve, reject) => {
    const ps = spawn('ps', ['-eo', 'pid,ppid,command'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout!.on('data', (chunk: Buffer) => { out += chunk; });
    ps.once('error', reject);
    ps.once('close', () => resolve(out));
  });
  return snapshot.split('\n').filter((line) => line.includes(marker)).length;
}

async function expectDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLive(pid)) return;
    await Bun.sleep(25);
  }
  throw new Error(`process survived cleanup: ${pid}`);
}

// ⛔ 리뷰 must-fix(#6056): 종전에는 `kill(-pid)` 의 `ESRCH` 를 **프로세스 사망으로 오인해 return** 했다.
//    그런데 `ESRCH` 는 *"그 pid 를 리더로 하는 프로세스 그룹이 없다"* 는 뜻이기도 하다 —
//    **비-group-leader 손자는 살아 있는데도** 그 에러가 난다. ⇒ 실패·뮤테이션 경로에서 고아가 남았다.
//    ⭐ 실증: 이 PR 의 뮤테이션 4발을 돌린 뒤 `ppid=1` 고아 2개(`77526`·`77900`)가 실제로 남았다.
//    ⇒ `ESRCH` 면 **반드시 `kill(pid)` 로 폴백**한다(그때만 정말 없는 것으로 본다).
// ⚠️ POSIX 전제: 이 helper 는 **음수 pid 로 프로세스 그룹을 지정**하는 POSIX 규약과 `ps -eo` 를
//    쓴다. Windows 에는 프로세스 그룹 시그널이 없으므로 이 테스트는 POSIX 에서만 유효하다
//    (리뷰 should-fix · 프로덕션 러너의 `kill(-pid)` 도 같은 전제이며 그쪽 주석에 적혀 있다).
function killProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  // ⛔ 리뷰 should-fix(#6056): 이미 죽은 pid 에 다시 SIGKILL 을 보내면 **pid 재사용** 시
  //    무관한 프로세스를 죽인다. ⇒ 살아 있는 것만 건드린다(경합은 남지만 창을 좁힌다).
  if (!isLive(pid)) return;
  try { process.kill(-pid, 'SIGKILL'); return; }
  catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
  }
  try { process.kill(pid, 'SIGKILL'); }
  catch (fallback: unknown) { if (!(fallback instanceof Error) || !('code' in fallback) || fallback.code !== 'ESRCH') throw fallback; }
}

async function cleanupProcess(child: ChildProcess, pids: readonly (number | undefined)[]): Promise<void> {
  // 이미 닫힌 자식에는 시그널을 보내지 않는다(pid 재사용 방지 · 리뷰 should-fix).
  if (child.exitCode === null && child.signalCode === null) killProcessGroup(child.pid);
  for (const pid of pids) killProcessGroup(pid);
  if (child.exitCode === null && child.signalCode === null) await waitForClose(child);
  await Promise.all(pids.filter((pid): pid is number => pid !== undefined).map((pid) => expectDead(pid)));
}

async function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'close');
}

describe('measureGoalGroundingCorpus', () => {
  test('keeps the default repeat count and accepts the seven-run baseline', () => {
    expect(corpusRepeats(undefined)).toBe(5);
    expect(corpusRepeats('7')).toBe(7);
  });

  test('keeps the unbenchmarked shared-host worker cap at two', () => {
    expect(CORPUS_MAX_WORKERS).toBe(2);
  });

  test('keeps corpus terms grounded without answer-path leaks', () => {
    expect(() => assertCorpusHasNoAnswerPathSearchTermLeaks([{ id: 'B-leak', kind: 'B', ask: '로그가 비었을 때 뜻을 알려줘', answers: ['src/cli/logs-cli.ts'], pr: null, searchTerms: ['logs-cli'] }])).toThrow('Answer-path search-term leak: B-leak: logs-cli');
    expect(() => assertCorpusSearchTermsComeFromAsk([{ id: 'term-leak', kind: 'B', ask: '로그를 알려줘', answers: ['src/cli/logs-cli.ts'], pr: null, searchTerms: ['logs-cli'] }])).toThrow('Search term absent from ask: term-leak: logs-cli');
  });

  test('parallel aggregate equals sequential aggregate for the same input', async () => {
    const deps = {
      cwd: () => '/isolated-corpus-fixture',
      groundGoal: async (ask: string) => `${GROUNDING_HEADER}\n- src/${ask.includes('로그') ? 'logs.ts' : 'other.ts'}: result`,
    };
    await expect(measureGoalGroundingCorpus(2, { ...deps, maxWorkers: 1 })).resolves.toEqual(
      await measureGoalGroundingCorpus(2, { ...deps, maxWorkers: 2 }),
    );
  });

  test('runner lock is acquired once at runner entry regardless of worker count', async () => {
    let acquired = 0;
    let released = 0;
    await runCorpusRunner(2, {
      cwd: () => '/isolated-corpus-fixture', maxWorkers: 2,
      groundGoal: async () => codeOnlyBlock,
    }, () => { acquired += 1; return () => { released += 1; }; });
    expect({ acquired, released }).toEqual({ acquired: 1, released: 1 });
    const source = readFileSync(script, 'utf8');
    const cliBlock = source.slice(source.indexOf('else if (import.meta.main)'));
    expect(cliBlock).toContain('runCorpusRunner(');
    expect(cliBlock).not.toContain('const release = acquireCorpusRunnerLock');
  });

  test('fake workers overlap in parallel and never exceed the configured worker cap', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corpus-concurrency-'));
    const lifecyclePath = join(directory, 'lifecycle.log');
    try {
      await measureGoalGroundingCorpus(1, {
        cwd: () => '/isolated-corpus-fixture', workerEntry: () => FAKE_WORKER, maxWorkers: 2,
        workerEnv: { FAKE_WORKER_LIFECYCLE_PATH: lifecyclePath, FAKE_WORKER_DELAY_MS: '75' },
      });
      const peak = lifecyclePeak(lifecyclePath);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(CORPUS_MAX_WORKERS);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('worker-entry seam cannot raise the unbenchmarked shared-host concurrency cap', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corpus-concurrency-ceiling-'));
    const lifecyclePath = join(directory, 'lifecycle.log');
    try {
      await measureGoalGroundingCorpus(1, {
        cwd: () => '/isolated-corpus-fixture', workerEntry: () => FAKE_WORKER, maxWorkers: CORPUS_MAX_WORKERS + 2,
        workerEnv: { FAKE_WORKER_LIFECYCLE_PATH: lifecyclePath, FAKE_WORKER_DELAY_MS: '75' },
      });
      expect(lifecyclePeak(lifecyclePath)).toBe(CORPUS_MAX_WORKERS);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('a timed-out worker counts as a requested trial but not a completed trial', async () => {
    const result = await measureGoalGroundingCorpus(1, {
      cwd: () => '/isolated-corpus-fixture', workerEntry: () => FAKE_WORKER,
      workerEnv: { FAKE_WORKER_MODE: 'hang' }, timeoutMs: 30,
    });
    const row = result.find((value) => value.id === 'B1' && value.측정역할 === 'authoring-selected');
    expect(row).toMatchObject({ 요청시행: 1, 시행: 0, 타임아웃수: 1, 원소별: [{ 포함률: null }] });
  });

  test('zero completed trials report a null inclusion rate', async () => {
    const result = await measureGoalGroundingCorpus(1, {
      cwd: () => '/isolated-corpus-fixture', workerEntry: () => FAKE_WORKER,
      workerEnv: { FAKE_WORKER_MODE: 'hang' }, timeoutMs: 30,
    });
    const row = result.find((value) => value.id === 'B1' && value.측정역할 === 'code-only baseline') as { 원소별: Array<{ 포함률: number | null }> };
    expect(row.원소별[0]!.포함률).toBeNull();
  });

  test('injecting the fake worker through the worker-entry seam verifies the parallel path without production changes', async () => {
    const result = await measureGoalGroundingCorpus(1, {
      cwd: () => '/isolated-corpus-fixture', workerEntry: () => FAKE_WORKER, maxWorkers: 2,
    });
    expect(result).toHaveLength(27);
    expect(result[0]).toMatchObject({ 시행: 1, 요청시행: 1, 타임아웃수: 0 });
  });

  test('emits completed items exactly once in input order even when a later item worker finishes first', async () => {
    const emissions: Array<Array<Record<string, unknown>>> = [];
    await measureGoalGroundingCorpus(1, {
      cwd: () => '/isolated-corpus-fixture', workerEntry: () => FAKE_WORKER, maxWorkers: 2,
      workerEnv: { FAKE_WORKER_DELAYS_BY_ITEM: JSON.stringify({ B1: 80, B2: 0 }) },
      onTrial: (rows) => emissions.push(rows),
    });
    expect(emissions).toHaveLength(9);
    expect(emissions.every((rows) => rows.length === 3)).toBe(true);
    expect(emissions.map((rows) => rows[0]!.id)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'A1', 'A2', 'A3', 'A4']);
  });

  test('emits each repeat in input order with cumulative results when a later repeat finishes first', async () => {
    const emissions: Array<Array<Record<string, unknown>>> = [];
    await measureGoalGroundingCorpus(2, {
      cwd: () => '/isolated-corpus-fixture', workerEntry: () => FAKE_WORKER, maxWorkers: 2,
      workerEnv: { FAKE_WORKER_DELAYS_BY_TRIAL: JSON.stringify({ 'B1:0': 80, 'B1:1': 0 }) },
      onTrial: (rows) => emissions.push(rows),
    });
    expect(emissions).toHaveLength(18);
    expect(emissions.every((rows) => rows.length === 3)).toBe(true);
    expect(emissions.slice(0, 2).map((rows) => rows[0]!.id)).toEqual(['B1', 'B1']);
    expect(emissions.slice(0, 2).map((rows) => rows[0]!.요청시행)).toEqual([1, 2]);
    expect(emissions.map((rows) => rows[0]!.id)).toEqual([
      'B1', 'B1', 'B2', 'B2', 'B3', 'B3', 'B4', 'B4', 'B5', 'B5',
      'A1', 'A1', 'A2', 'A2', 'A3', 'A3', 'A4', 'A4',
    ]);
  });

  test('runner lock remains held until started workers settle after a worker failure', async () => {
    let released = false;
    let started = 0;
    let workerObservedLockHeld = false;
    await expect(runCorpusRunner(1, {
      cwd: () => '/isolated-corpus-fixture', maxWorkers: 2,
      groundGoal: async () => {
        started += 1;
        if (started === 1) throw new Error('worker failure');
        await Bun.sleep(50);
        workerObservedLockHeld = !released;
        return codeOnlyBlock;
      },
    }, () => () => { released = true; })).rejects.toThrow('worker failure');
    expect({ started, workerObservedLockHeld, released }).toEqual({ started: 2, workerObservedLockHeld: true, released: true });
  });

  test('non-current cwd records both baseline and authoring-selected measurement logs', async () => {
    const events: Array<{ role: string }> = [];
    await measureGoalGroundingCorpus(1, {
      cwd: () => '/isolated-corpus-fixture',
      groundGoal: async () => codeOnlyBlock,
      log: (_category, event, data) => { if (event === 'measured') events.push({ role: String(data.role) }); },
    });
    expect(events.filter(({ role }) => role === 'authoring-selected')).toHaveLength(9);
    expect(events.filter(({ role }) => role === 'code-only baseline')).toHaveLength(9);
    expect(events.filter(({ role }) => role === 'authoring-free')).toHaveLength(9);
  });

  test('preserves existing rows and adds one unselected authoring row per corpus item', async () => {
    const injectedSearchTerms: Array<unknown> = [];
    const result = await measureGoalGroundingCorpus(1, {
      cwd: process.cwd,
      groundMission: async (_ask, options) => {
        injectedSearchTerms.push(options.searchTerms);
        return { grounded: true, context: '', files: ['src/aggregated.ts'], skillFacts: [], codeFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [] };
      },
      groundGoal: async () => codeOnlyBlock,
    });
    expect(result).toHaveLength(27);
    expect(result[0]).toMatchObject({ id: 'B1', 측정역할: 'authoring-selected', 경로: 'groundMissionInCodebase', 시행: 1, 타임아웃수: 0, 후보수분포: [1], 원소별: [{ 포함: 0 }] });
    expect(result[1]).toMatchObject({ id: 'B1', 측정역할: 'code-only baseline', 경로: 'groundGoalInCodebase', 시행: 1, 타임아웃수: 0, 후보수분포: [1], 원소별: [{ 포함: 0 }] });
    expect(result[2]).toMatchObject({ id: 'B1', 측정역할: 'authoring-free', 경로: 'groundMissionInCodebase', 시행: 1, 타임아웃수: 0, 후보수분포: [1], 원소별: [{ 포함: 0 }] });
    expect(result.filter((row) => row.측정역할 === 'authoring-free')).toHaveLength(9);
    expect(injectedSearchTerms).toHaveLength(18);
    expect(injectedSearchTerms.filter((searchTerms) => searchTerms === undefined)).toHaveLength(9);
    expect(injectedSearchTerms.filter((searchTerms) => typeof searchTerms === 'function')).toHaveLength(9);
    expect(corpusLiveWorkerCount()).toBe(0);
  });

  test('writes a complete trial JSONL record to stdout while the CLI remains alive', async () => {
    const child = startCli({ CORPUS_WORKER_ENTRY: FAKE_WORKER, FAKE_WORKER_MODE: 'stream-hold', CORPUS_CALL_TIMEOUT_MS: '120000' });
    try {
      const { line } = await waitForLine(child);
      expect(child.exitCode).toBeNull();
      expect(JSON.parse(line)).toMatchObject({ id: 'B1', 시행: 1, 측정역할: 'authoring-selected' });
    } finally {
      await cleanupProcess(child, []);
    }
  }, 10_000);

  test('CORPUS_REPEATS=1 CLI JSONL emits one authoring-free row for every corpus item', async () => {
    const { code, stdout, stderr } = await collect(startCli({ CORPUS_WORKER_ENTRY: FAKE_WORKER }));
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const rows = stdout.trim().split('\n').map((line) => JSON.parse(line));
    const trialRows = rows.slice(0, -1);
    const authoringFree = trialRows.filter((row) => row.측정역할 === 'authoring-free');
    expect(authoringFree).toHaveLength(9);
    expect(authoringFree.map((row) => row.id)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'A1', 'A2', 'A3', 'A4']);
    expect(authoringFree.every((row) => row.경로 === 'groundMissionInCodebase')).toBe(true);
  }, 20_000);

  test('SIGTERM exit hook immediately removes the worker group before its 2s orphan poll', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corpus-parent-term-'));
    const pidPath = join(directory, 'worker.pid');
    const grandchildPidPath = join(directory, 'grandchild.pid');
    const child = startCli({ CORPUS_WORKER_ENTRY: FAKE_WORKER, FAKE_WORKER_MODE: 'hang-grandchild', FAKE_WORKER_PID_PATH: pidPath, FAKE_GRANDCHILD_PID_PATH: grandchildPidPath, CORPUS_CALL_TIMEOUT_MS: '120000', CORPUS_WORKER_ORPHAN_CHECK_MS: '2000' });
    let workerPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      workerPid = await waitForPid(pidPath);
      grandchildPid = await waitForPid(grandchildPidPath);
      child.kill('SIGTERM');
      await waitForClose(child);
      expect(child.exitCode).toBe(143);
      expect(child.signalCode).toBeNull();
      await expectDead(workerPid, 500);
      await expectDead(grandchildPid, 500);
    } finally {
      await cleanupProcess(child, [workerPid, grandchildPid]);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  // ⛔ 리뷰 must-fix(#6056)를 **실제로 고정한다**. `kill(-pid)` 의 `ESRCH` 를 사망으로 오인하면
  //    비-group-leader 손자가 살아남는데, 기존 테스트는 **PID 를 아는 프로세스만** 확인해서
  //    그것을 못 잡았다(실증: 뮤테이션 후 `ppid=1` 고아가 남았는데 11개 테스트가 전부 통과).
  //    ⇒ 이 테스트는 **PID 를 모르는 잔존 프로세스까지** 프로세스 표에서 센다.
  test('leaves no worker process behind after cleanup — even ones whose PID we never learned', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corpus-no-orphan-'));
    const pidPath = join(directory, 'worker.pid');
    const marker = `corpus-orphan-probe-${process.pid}`;
    const child = startCli({
      CORPUS_WORKER_ENTRY: FAKE_WORKER, FAKE_WORKER_MODE: 'hang-grandchild',
      FAKE_WORKER_PID_PATH: pidPath, CORPUS_CALL_TIMEOUT_MS: '120000',
      CORPUS_WORKER_ORPHAN_CHECK_MS: '2000', CORPUS_WORKER_MARKER: marker,
    });
    let workerPid: number | undefined;
    try {
      workerPid = await waitForPid(pidPath);
      child.kill('SIGKILL');
      await waitForClose(child);
      await cleanupProcess(child, [workerPid]);
      await Bun.sleep(2_100); // fixture's configured orphan poll is 2s; inspect after its contractual cleanup deadline.
      expect(await countProcessesMatching(marker)).toBe(0);
    } finally {
      await cleanupProcess(child, [workerPid]);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  test('removes a worker and grandchild when its parent is SIGKILLed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corpus-parent-kill-group-'));
    const pidPath = join(directory, 'worker.pid');
    const grandchildPidPath = join(directory, 'grandchild.pid');
    const child = startCli({ CORPUS_WORKER_ENTRY: FAKE_WORKER, FAKE_WORKER_MODE: 'hang-grandchild', FAKE_WORKER_PID_PATH: pidPath, FAKE_GRANDCHILD_PID_PATH: grandchildPidPath, CORPUS_CALL_TIMEOUT_MS: '120000' });
    let workerPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      workerPid = await waitForPid(pidPath);
      grandchildPid = await waitForPid(grandchildPidPath);
      expect(isLive(workerPid)).toBe(true);
      expect(isLive(grandchildPid)).toBe(true);
      child.kill('SIGKILL');
      await waitForClose(child);
      await expectDead(workerPid);
      await expectDead(grandchildPid);
    } finally {
      await cleanupProcess(child, [workerPid, grandchildPid]);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  test('worker self-terminates when its own lifetime cap expires', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corpus-worker-cap-'));
    const pidPath = join(directory, 'worker.pid');
    const worker = spawn(process.execPath, [FAKE_WORKER, '--worker'], {
      detached: true,
      env: { ...process.env, FAKE_WORKER_MODE: 'hang', FAKE_WORKER_PID_PATH: pidPath, CORPUS_WORKER_PARENT_PID: String(process.pid), CORPUS_WORKER_MAX_LIFETIME_MS: '250' },
      stdio: 'ignore',
    });
    let workerPid: number | undefined;
    try {
      workerPid = await waitForPid(pidPath);
      expect(isLive(workerPid)).toBe(true);
      await expectDead(workerPid);
    } finally {
      await cleanupProcess(worker, [workerPid]);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  test('kills a worker process group including its grandchild on timeout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corpus-group-'));
    const pidPath = join(directory, 'worker.pid');
    const grandchildPidPath = join(directory, 'grandchild.pid');
    const child = startCli({ CORPUS_WORKER_ENTRY: FAKE_WORKER, FAKE_WORKER_MODE: 'hang-grandchild', FAKE_WORKER_PID_PATH: pidPath, FAKE_GRANDCHILD_PID_PATH: grandchildPidPath, CORPUS_CALL_TIMEOUT_MS: '300' });
    let workerPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      await collect(child);
      workerPid = await waitForPid(pidPath);
      grandchildPid = await waitForPid(grandchildPidPath);
      await expectDead(workerPid);
      await expectDead(grandchildPid);
    } finally {
      await cleanupProcess(child, [workerPid, grandchildPid]);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  test('records a killed timeout separately from a completed zero-hit result in partial and final aggregates', async () => {
    const child = startCli({ CORPUS_WORKER_ENTRY: FAKE_WORKER, FAKE_WORKER_MODE: 'hang-authoring-item:B1', CORPUS_CALL_TIMEOUT_MS: '3000' });
    const { code, stdout, stderr } = await collect(child);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const rows = stdout.trim().split('\n').map((line) => JSON.parse(line));
    const b1Operational = rows.find((row) => row.id === 'B1' && row.측정역할 === 'authoring-selected' && row.타임아웃수 === 1);
    const b1Fallback = rows.find((row) => row.id === 'B1' && row.측정역할 === 'code-only baseline' && row.시행 === 1);
    const final = rows.at(-1);
    // ⭐⭐ **새 계약**(리뷰 must-fix ③) — 종전 이 테스트는 타임아웃 시행을 `후보수분포:[0]`·`포함:0`
    //    으로 기대해 **"안 돌았다" 와 "못 찾았다" 를 같은 점수로 뭉개는 결함을 고착화**하고 있었다.
    //    이제 타임아웃은 품질 집계에서 **빠지고**(분모=완주 시행) 그 사실이 값으로 남는다.
    expect(b1Operational).toMatchObject({
      타임아웃수: 1, 시행상태: ['timeout'], 요청시행: 1,
      시행: 0,            // 완주 시행 0
      후보수분포: [],      // ⛔ [0] 이 아니다 — 0건을 찾은 게 아니라 안 돌았다
      원소별: [{ 포함: 0, 시행: 0, 포함률: null }],   // 포함률은 **모름**(0.0 이 아니다)
    });
    expect(b1Fallback).toMatchObject({
      타임아웃수: 0, 시행상태: ['ok'], 시행: 1, 요청시행: 1,
      후보수분포: [0], 원소별: [{ 포함: 0, 포함률: 0 }],   // 이쪽은 **완주했고 못 찾았다**
    });
    expect(Array.isArray(final)).toBe(true);
    expect(final.find((row: Record<string, unknown>) => row.id === 'B1' && row.측정역할 === 'authoring-selected')).toMatchObject({ 타임아웃수: 1, 시행상태: ['timeout'] });
    expect(final.find((row: Record<string, unknown>) => row.id === 'B1' && row.측정역할 === 'code-only baseline')).toMatchObject({ 타임아웃수: 0, 시행상태: ['ok'] });
  }, 20_000);

  // ⛔ 골 결함 수리(2026-07-30): 수용 기준이 `debug.log(...)` 만 요구해서 **조회에 뜨는지**는
  //    안 봤다. 자식은 문자 그대로 충족했고 `elanous logs --category goal-grounding.corpus` 는 **0건**이었다.
  //    ⇒ ***검사할 수 없는 것을 계약에 넣으면 충족과 무용이 같은 값이 된다.***
  //    ⇒ 러너·worker 두 진입점이 **싱크를 등록한다**는 것을 소스로 고정한다.
  //    ⚠️ logs.db 왕복은 이 스위트의 범위가 아니다(격리 state-dir 가 필요하다) — 배선만 본다.
  //    ⚠️ 첫 판(2026-07-30)은 **Goodhart 테스트였다**: worker 분기 슬라이스를 **파일 끝까지** 잡아서
  //      `import.meta.main` 쪽 문자열을 보고 통과했다(뮤테이션으로 worker 쪽을 지워도 12개 전부 통과).
  //      ⇒ **두 진입점을 각각 그 줄 안에서만** 확인한다.
  test('both CLI entry points wire a standalone log sink (source-level wiring only — no logs.db round-trip)', () => {
    const source = readFileSync(script, 'utf8');
    expect(source).toContain('registerStandaloneLogSink');
    const lines = source.split('\n');
    const workerLine = lines.find((line) => line.includes("process.argv.includes('--worker')"));
    const mainLineIndex = lines.findIndex((line) => line.includes('import.meta.main'));
    expect(workerLine).toBeDefined();
    expect(mainLineIndex).toBeGreaterThan(-1);
    // worker 진입점: 같은 줄에서 싱크를 설치해야 한다.
    expect(workerLine).toContain('installCorpusLogSink');
    // 러너 진입점: `import.meta.main` 블록이 **락 획득보다 먼저** 싱크를 설치해야 한다
    // (락 획득이 실패하면 그 거부 자체가 관측돼야 하므로 순서가 계약이다).
    const runnerBlock = lines.slice(mainLineIndex, mainLineIndex + 4).join('\n');
    expect(runnerBlock).toContain('installCorpusLogSink');
    expect(runnerBlock).toContain('runCorpusRunner(');
  });

  test('rejects a second CLI process while the first owns the runner lock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corpus-lock-'));
    const lockPath = join(directory, 'runner.lock');
    const first = startCli({ CORPUS_WORKER_ENTRY: FAKE_WORKER, FAKE_WORKER_MODE: 'stream-hold', CORPUS_RUNNER_LOCK_PATH: lockPath });
    try {
      await waitForLine(first);
      const second = startCli({ CORPUS_WORKER_ENTRY: FAKE_WORKER, FAKE_WORKER_MODE: 'stream-hold', CORPUS_RUNNER_LOCK_PATH: lockPath });
      const result = await collect(second);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Corpus runner already running');
    } finally {
      await cleanupProcess(first, []);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
