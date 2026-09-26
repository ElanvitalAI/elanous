// ── Self-Evolution SE4 · 무결성 게이트 (2026-07-09) ───────────────────────
//
// 대표: "테스트 버전으로 어떻게 무결하게 기능 구현을 마칠 수 있는지 확인하라." 격리
// worktree에서 구현한 뒤 bun test·build·nexus build 를 돌려 전부 green 이어야 "무결
// 완성". 하나라도 fail 이면 merge 없음(PR 초안 차단). 자기검증 순환 방지 = 독립 신호.
//
// 주입 runCmd(테스트) — 실행은 격리 worktree cwd 에서(정식 트리 무영향).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseTestOutput } from '../../agent-mission/parse.js';
import { androidFilesIn } from '../../../scripts/ci-android-unit-tests.js';
import { iosFilesIn } from '../../../scripts/ci-ios-unit-tests.js';
import { tscEnv } from '../../typecheck-ratchet.js';
import { debug } from '../../debug/log.js';

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: { code: string };
}
export type RunCmd = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<CmdResult>;

const MAX_BUFFER = 16 * 1024 * 1024;
const TERMINATION_GRACE_MS = 2_000;
/** ⭐ SIGKILL 뒤 그룹 소멸을 기다리는 **상한**(리뷰 must-fix · 2026-07-27).
 *  reap 폴링에 데드라인이 없으면 좀비가 즉시 회수되지 않는 환경에서 `processGroupExists` 가
 *  계속 true 라 `defaultRunCmd` 가 **영원히 resolve 되지 않는다** — 이 파일이 없애려는
 *  "행(hang)" 을 종료 경로가 재도입하는 형태다. TERM→유예→KILL 을 다 한 뒤에도 그룹이
 *  남으면 더 할 수 있는 일이 없으므로 **기다리지 말고 결과를 낸다**(게이트는 멈추지 않는다). */
const REAP_DEADLINE_MS = 2_000;

type TerminationReason = 'timeout' | 'buffer-overflow';

function appendCapped(chunks: Buffer[], bytes: number, chunk: Buffer): { bytes: number; overflow: boolean } {
  const chunkBytes = Buffer.byteLength(chunk);
  const remaining = MAX_BUFFER - bytes;
  if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
  return { bytes: Math.min(MAX_BUFFER, bytes + chunkBytes), overflow: chunkBytes > remaining };
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;
    if (code !== 'EPERM') throw error;
    debug.log('integrity-gate', 'signal-eperm', { pid, signal }, { level: 'warn' });
    try { process.kill(pid, signal); } catch { /* best-effort leader fallback */ }
  }
}

function processGroupExists(pid: number): boolean {
  try {
    if (process.platform === 'win32') process.kill(pid, 0);
    else process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

/** ⚠️ 테스트 seam(리뷰 must-fix 회귀 가드용) — 그룹 존재 프로브를 주입한다.
 *  "그룹이 끝내 안 사라지는" 상황은 SIGKILL 을 견디는 프로세스가 없어 실물로 만들 수 없다.
 *  그래서 프로브만 주입해 **데드라인이 실제로 promise 를 풀어주는지**를 결정론으로 잰다
 *  (레포 관행: `RunCmd`·`changedFileTypecheck(run)`·`jsonDevicesFleetSource(read)` 와 동형). */
export function createRunCmd(groupExists: (pid: number) => boolean = processGroupExists): RunCmd {
  return (cmd, args, cwd, timeoutMs) => runCmdImpl(cmd, args, cwd, timeoutMs, groupExists);
}

export const defaultRunCmd: RunCmd = (cmd, args, cwd, timeoutMs) => runCmdImpl(cmd, args, cwd, timeoutMs, processGroupExists);

const runCmdImpl = (
  cmd: string, args: string[], cwd: string, timeoutMs: number,
  groupExists: (pid: number) => boolean,
): Promise<CmdResult> => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, {
    cwd,
    detached: process.platform !== 'win32',
    // ⛔ tsc 스텝이 V8 기본 힙(≈4GB)을 넘는다(📏 2026-09-23 RSS 5.0GB) — 명시 힙을 싣는다(bun 스텝엔 무해).
    env: { ...tscEnv(), ELANOUS_NO_WATCHDOG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const processGroupId = child.pid;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let closed = false;
  let status: number | null = null;
  let closeSignal: NodeJS.Signals | null = null;
  let terminationReason: TerminationReason | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let reapTimer: ReturnType<typeof setInterval> | undefined;
  let reapDeadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    if (reapTimer) clearInterval(reapTimer);
    if (reapDeadlineTimer) clearTimeout(reapDeadlineTimer);
    child.off('error', onSpawnError);
    child.off('close', onClose);
    child.stdout?.off('data', onStdout);
    child.stderr?.off('data', onStderr);
  };
  const settle = () => {
    if (settled) return;
    settled = true;
    cleanup();
    const code = terminationReason === 'timeout'
      ? 124
      : terminationReason === 'buffer-overflow'
        ? 1
        : typeof status === 'number' ? status : (closeSignal ? 124 : 1);
    resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut: terminationReason === 'timeout',
      ...(terminationReason === 'buffer-overflow' ? { error: { code: 'ENOBUFS' } } : {}),
    });
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };
  const groupStillExists = (pid: number): boolean => {
    try {
      return groupExists(pid);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
      throw error;
    }
  };
  const settleAfterReap = () => {
    if (!closed || terminationReason === undefined) return;
    try {
      if (processGroupId !== undefined && groupStillExists(processGroupId)) return;
      settle();
    } catch (error: unknown) {
      fail(error);
    }
  };
  const startTermination = (reason: TerminationReason) => {
    if (terminationReason !== undefined) return;
    terminationReason = reason;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    try {
      if (processGroupId !== undefined) signalProcessGroup(processGroupId, 'SIGTERM');
    } catch (error: unknown) {
      fail(error);
      return;
    }
    reapTimer = setInterval(settleAfterReap, 25);
    // ⭐ 종료 경로 전체의 상한(리뷰 must-fix) — TERM 유예 + KILL 후 reap 대기까지 다 지나면
    //   그룹이 남아 있어도 **무조건 결과를 낸다**. 데드라인이 없으면 좀비 하나가 게이트를
    //   영구히 멈춘다(이 파일이 고치려는 바로 그 실패 형태).
    reapDeadlineTimer = setTimeout(() => {
      try {
        if (processGroupId !== undefined && groupStillExists(processGroupId)) {
          debug.log('integrity-gate', 'group-unkillable', { pid: processGroupId }, { level: 'warn' });
        }
        settle();
      } catch (error: unknown) {
        fail(error);
      }
    }, TERMINATION_GRACE_MS + REAP_DEADLINE_MS);
    killTimer = setTimeout(() => {
      try {
        if (processGroupId !== undefined) signalProcessGroup(processGroupId, 'SIGKILL');
        settleAfterReap();
      } catch (error: unknown) {
        fail(error);
      }
    }, TERMINATION_GRACE_MS);
  };
  function onStdout(chunk: Buffer): void {
    const appended = appendCapped(stdout, stdoutBytes, chunk);
    stdoutBytes = appended.bytes;
    if (appended.overflow) startTermination('buffer-overflow');
  }
  function onStderr(chunk: Buffer): void {
    const appended = appendCapped(stderr, stderrBytes, chunk);
    stderrBytes = appended.bytes;
    if (appended.overflow) startTermination('buffer-overflow');
  }
  function onSpawnError(): void {
    settle();
  }
  function onClose(nextStatus: number | null, signal: NodeJS.Signals | null): void {
    closed = true;
    status = nextStatus;
    closeSignal = signal;
    if (terminationReason === undefined) settle();
    else settleAfterReap();
  }

  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);
  child.once('error', onSpawnError);
  child.once('close', onClose);
  timeoutTimer = setTimeout(() => startTermination('timeout'), timeoutMs);
});

export type GateStepName = 'test' | 'typecheck' | 'nexus-build' | 'cli-smoke';
export type GateStepStatus = 'passed' | 'failed' | 'skipped';

export interface GateStep {
  name: GateStepName;
  /** runIntegrityGate가 기록하는 세 상태. 이전 GateStep 테스트 더블과 호환되도록 선택값이다. */
  status?: GateStepStatus;
  ok: boolean;
  skipped: boolean;
  summary: string;
  /** 실패 귀속처럼 전체 출력이 필요한 후속 판정용 원문. PR 증거에는 summary만 렌더한다. */
  output?: string;
}
export interface GateResult {
  passed: boolean;
  steps: GateStep[];
  /** 실제 통과한 스텝 수. skipped는 전체 게이트를 실패시키지 않지만 이 수에 포함되지 않는다. */
  passedStepCount?: number;
  log: string;
  /** `test` 스텝 출력에서 parseTestOutput으로 읽은 이번 라운드 통과 수. */
  testPassCount?: number;
  /**
   * ⛔⭐ 통과 수 «감소»로 실패했나. baseline 흡수 경로가 이 실패를 삼키면 안 되므로
   *   판정을 문면이 아니라 «값»으로 싣는다(무인 리뷰 must-fix · 2026-08-04 3라운드).
   *   ⇒ base 가 이미 깨져 있어도 「통과 수가 줄었다」는 회귀는 흡수 대상이 아니다.
   */
  testPassCountRegressed?: boolean;
}

/** 스텝 정의 — cmd + 성공 판정(code 0). nexus build 는 무겁게 별 timeout. */
const STEP_CMDS: Record<GateStepName, { cmd: string; args: string[]; timeoutMs: number }> = {
  test: { cmd: 'bun', args: ['test'], timeoutMs: 300_000 },
  typecheck: { cmd: 'bunx', args: ['tsc', '--noEmit'], timeoutMs: 300_000 },
  'nexus-build': { cmd: 'bun', args: ['bin/elanous.mjs', 'nexus', 'build'], timeoutMs: 420_000 },
  // ⭐실행 맥락 검증(2026-07-25) — CLI 를 실제로 기동(--help)해 index.ts 전체 로드가 크래시하지 않는지
  //   본다. test/tsc 는 로드타임 결함(커맨드 중복 등록·import 순환·부팅 throw)을 못 잡는다: 실사례로
  //   global 에 `cannot add command 'agent' as already have command 'agent|codex'` 크래시가 있었다.
  //   commander --help 는 정상 로드 시 exit 0, 로드 중 throw 면 non-zero → 정적 게이트의 실행-맥락 맹점 보강.
  'cli-smoke': { cmd: 'bun', args: ['bin/elanous.mjs', '--help'], timeoutMs: 60_000 },
};

const MAX_LOGGED_TEST_FILTERS = 6;

/** Platform runners own Kotlin/Swift execution; Bun must never receive their paths as test filters. */
function bunTestFilters(testArgs: readonly string[]): string[] {
  const platformFiles = new Set([...androidFilesIn(testArgs), ...iosFilesIn(testArgs)]);
  return testArgs.filter((file) => !platformFiles.has(file));
}

function formatExecutedCommand(cmd: string, args: readonly string[]): string {
  if (cmd !== 'bun' || args[0] !== 'test' || args.length <= MAX_LOGGED_TEST_FILTERS + 1) {
    return [cmd, ...args].join(' ');
  }
  const filters = args.slice(1, MAX_LOGGED_TEST_FILTERS + 1);
  return `${[cmd, 'test', ...filters].join(' ')} …(+${args.length - MAX_LOGGED_TEST_FILTERS - 1} more)`;
}

// ★ dogfood 발견(2026-07-10): 기본 스텝에서 typecheck 제외. repo 가 tsc-clean 아님
// (bunx tsc --noEmit = 181 pre-existing 에러) → 절대 게이트로 쓰면 모든 SE 빌드가 무조건
// fail. 설계 게이트(SE4.2)도 "bun test·build·nexus build·smoke"로 typecheck 미포함.
// typecheck 는 opt-in(steps 명시 시). 무결 신호 = bun test(격리 cwd·정식 데몬 lock 무관).
// ⭐cli-smoke 는 기본 포함(2026-07-25) — 수초로 저렴하고, test/tsc 가 못 잡는 로드타임 크래시(부팅 throw)를
//   근본 차단한다. worktree 는 bin/elanous.mjs 를 복사·node_modules 는 심링크 공유하므로 격리 cwd 에서 기동 가능.
export const DEFAULT_GATE_STEPS: GateStepName[] = ['test', 'cli-smoke'];

/** 무결성 게이트 — 지정 스텝을 격리 cwd 에서 순차 실행. 하나라도 fail → passed=false.
 *  전부 통과해야 "무결 완성". 실패 스텝에서 멈추지 않고 전부 돌려 증거 수집(fail-fast=false 기본). */
export async function runIntegrityGate(
  cwd: string,
  opts: { steps?: GateStepName[]; runCmd?: RunCmd; failFast?: boolean; testArgs?: string[]; previousPassCount?: number } = {},
): Promise<GateResult> {
  const steps = opts.steps ?? DEFAULT_GATE_STEPS;
  const runCmd = opts.runCmd ?? createRunCmd();
  const results: GateStep[] = [];
  const logs: string[] = [];
  let passed = true;
  let testPassCount: number | undefined;
  let sawPassCountRegression = false;

  for (const name of steps) {
    const def = STEP_CMDS[name];
    // cli-smoke 는 monad-agent 의 bin/elanous.mjs 를 전제로 한다. 남의 저장소에는 그 파일이
    // 없어 실행하면 항상 Module not found 로 게이트가 죽는다. 돌리기 전에 가리고, 가림을
    // 통과로 세지 않는다(ok 이되 skipped — 전체 passed 는 유지, 통과 집계에서는 제외).
    if (name === 'cli-smoke' && !existsSync(join(cwd, 'bin', 'elanous.mjs'))) {
      const reason = 'bin/elanous.mjs is absent — cli-smoke cannot run outside monad-agent';
      results.push({ name, status: 'skipped', ok: true, skipped: true, summary: `skipped: ${reason}` });
      logs.push(`[cli-smoke] SKIP ${reason}`);
      continue;
    }
    // test 스텝 스코프 override(testArgs) — SE6 는 curated 서브셋으로 격리 게이트 고속화.
    // 전체 `bun test` 는 통합/네트워크 테스트 포함이라 격리서 불안정 가능(dogfood).
    const filters = name === 'test' && opts.testArgs ? bunTestFilters(opts.testArgs) : undefined;
    if (name === 'test' && opts.testArgs && opts.testArgs.length > 0 && filters!.length === 0) {
      results.push({ name, status: 'skipped', ok: true, skipped: true, summary: 'skipped: platform test filters are delegated to platform gates' });
      logs.push('[test] SKIP platform test filters are delegated to platform gates');
      continue;
    }
    const hasFilters = !!filters && filters.length > 0;
    const args = hasFilters ? ['test', ...filters] : def.args;
    const startedAt = Date.now();
    const r = await runCmd(def.cmd, args, cwd, def.timeoutMs);
    const elapsedMs = Date.now() - startedAt;
    // `test` 출력은 필터 유무와 관계없이 파싱한다. 필터 없는 전체 실행도 직전 라운드보다
    // 통과 수가 줄면 테스트 삭제를 감춰서는 안 된다. 필터 no-match 판정은 기존처럼 필터 실행에만 적용한다.
    const parsed = name === 'test' ? parseTestOutput(`${r.stdout}${r.stderr}`) : undefined;
    if (parsed !== undefined) testPassCount = parsed.pass;
    const missingRunSummary = hasFilters && parsed !== undefined && !parsed.hasRunSummary;
    const zeroMatchedFiles = hasFilters && parsed?.hasRunSummary === true && parsed.ranFiles === 0;
    const ranNothing = missingRunSummary || zeroMatchedFiles;
    const passCountRegressed = parsed !== undefined
      && opts.previousPassCount !== undefined
      && parsed.pass < opts.previousPassCount;
    const ok = r.code === 0 && !r.timedOut && !ranNothing && !passCountRegressed;
    if (passCountRegressed) sawPassCountRegression = true;
    const tail = (r.stderr || r.stdout).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 200);
    // ⛔⭐ 감소했을 때«만» 싣지 않는다 — 그러면 「비교했는데 통과」와 「비교 자체를 안 함」이
    //   산출에서 구별되지 않는다. 무인 리뷰 must-fix(2026-08-04)가 이 자리를 짚었다.
    //   #6925 와 같은 형태: ***도구가 「무엇을 봤는지」를 말해야 「아무것도 안 봤다」가 통과로 안 읽힌다.***
    //   ⇒ 직전 값이 있으면 감소 여부와 무관하게 두 수를 싣는다. 없으면 그 사실을 싣는다.
    const passFacts = parsed === undefined
      ? ''
      : opts.previousPassCount === undefined
        ? ` current-pass=${parsed.pass} previous-pass=none`
        : ` previous-pass=${opts.previousPassCount} current-pass=${parsed.pass}`;
    const facts = `elapsed=${elapsedMs}ms code=${r.code}${parsed?.hasRunSummary ? ` matched-files=${parsed.ranFiles}` : ''}${passFacts}`;
    const summary = r.timedOut
      ? `timeout (${facts})`
      : missingRunSummary
        ? `fail: test run summary was absent; matched file count is unknown — exit0/pass absorption blocked. ${facts} filters=[${(opts.testArgs ?? []).join(', ')}]`
        : zeroMatchedFiles
          ? `fail: 0 files ran (필터 전체 no-match/오타?) — exit0/pass 흡수 거짓통과 차단. ${facts} filters=[${(opts.testArgs ?? []).join(', ')}]`
          : passCountRegressed
            ? `fail: test pass count regressed (previous-pass=${opts.previousPassCount} current-pass=${parsed!.pass}). ${facts}`
            : ok ? `pass (${facts})` : `fail(code ${r.code}; ${facts}): ${tail}`;
    results.push({ name, status: ok ? 'passed' : 'failed', ok, skipped: false, summary, ...(ok ? {} : { output: `${r.stdout}${r.stderr}` }) });
    logs.push(`[${name}] ${ok ? 'PASS' : 'FAIL'} ${formatExecutedCommand(def.cmd, args)} — ${ranNothing ? summary : tail}`);
    if (!ok) { passed = false; if (opts.failFast) break; }
  }
  const passedStepCount = results.filter((step) => step.status === 'passed').length;
  return { passed, steps: results, passedStepCount, log: logs.join('\n'), ...(testPassCount === undefined ? {} : { testPassCount }), ...(sawPassCountRegression ? { testPassCountRegressed: true } : {}) };
}

/** 게이트 결과 → PR 증거 markdown. */
export function renderGateEvidence(result: GateResult): string {
  const statusOf = (step: GateStep): GateStepStatus => step.status ?? (step.skipped ? 'skipped' : step.ok ? 'passed' : 'failed');
  const passedStepCount = result.passedStepCount ?? result.steps.filter((step) => statusOf(step) === 'passed').length;
  const skippedStepCount = result.steps.filter((step) => statusOf(step) === 'skipped').length;
  const L = [
    `## 무결성 게이트: ${result.passed ? '✅ PASS' : '❌ FAIL'} — ${passedStepCount} passed step${passedStepCount === 1 ? '' : 's'}`,
    ...(skippedStepCount === 0 ? [] : [`⚠️ ${skippedStepCount} skipped step${skippedStepCount === 1 ? '' : 's'} — not counted as passed`]),
    '',
  ];
  for (const s of result.steps) {
    const mark = s.skipped ? '⚠️ SKIP' : s.ok ? '✅' : '❌';
    L.push(`- ${mark} ${s.name}: ${s.summary}`);
  }
  return L.join('\n');
}
