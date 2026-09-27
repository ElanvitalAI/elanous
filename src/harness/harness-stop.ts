// `elanous harness stop <runId>` — 런 하나를 한 줄로 멈춘다: 오케스트레이터 프로세스 ⊕ 그 런의 Pod Job.
//
// 🩸 2026-09-27: 멈추려면 사람이 PID 둘(harness ask 부모 · self orchestrate 자식)과 Job 이름을 손으로 찾아야 했고,
//   그 사이 떠 있던 조각이 main 에 병합됐다(#21048). 부모를 죽이면 자식이 PPID 1 고아로 2h36m 더 돌았다(🅞 보고).
// B 조각(#21171)이 오케스트레이터에 `self-dev-runs/<runId>/pid.json` ⊕ SIGTERM 정리(새 잡 멈춤 · 자기 Job 삭제 · cancelled)를 넣었다.
// 이 파일(A 조각)은 그 기록을 «읽고», 소유가 확인될 때만 신호를 보내고, `elanous.run=<runId>` 라벨 Job 을 지운다.
//
// ⛔ 불변식: 기록된 시작 시각과 실제 프로세스 시작 시각이 다르면 신호를 보내지 않는다(PID 재사용 방지).
// ⛔ 불변식: `elanous.run=<runId>` 라벨이 붙은 Job 만 지운다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import { selfDevRunsDir } from '../self-dev/run-store.js';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** `pid.json` 의 `startedAt` 은 `Date.now() − uptime` 근삿값이다 — 이만큼의 차이는 같은 프로세스로 본다. */
export const START_TOLERANCE_MS = 5_000;

export interface PidRecord { pid: number; startedAt: number; argv0?: string }

export interface HarnessStopDeps {
  readPidRecord: (runId: string) => PidRecord | null;
  /** 살아 있는 프로세스의 시작 시각(ms) · 없으면 null. */
  processStartMs: (pid: number) => number | null;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  kubeContexts: () => string[];
  kubectl: (args: readonly string[]) => { status: number | null; stdout: string; stderr: string };
  namespace: string;
  graceMs: number;
}

export interface HarnessStopResult {
  runId: string;
  process: 'stopped' | 'killed' | 'absent' | 'owner-mismatch';
  pid?: number;
  jobsDeleted: number;
  contexts: string[];
}

export function readPidRecordFrom(runsDir: string, runId: string): PidRecord | null {
  try {
    const value = JSON.parse(readFileSync(join(runsDir, runId, 'pid.json'), 'utf8')) as Partial<PidRecord>;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 1 || !Number.isFinite(value.startedAt)) return null;
    return { pid: value.pid as number, startedAt: value.startedAt as number, ...(typeof value.argv0 === 'string' ? { argv0: value.argv0 } : {}) };
  } catch {
    return null;
  }
}

/** macOS·Linux 공통 — `ps -o lstart=` 는 로컬 시각 문자열(초 단위)이다. */
export function psProcessStartMs(pid: number): number | null {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
  if (r.status !== 0) return null;
  const text = r.stdout.trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export function defaultHarnessStopDeps(overrides: Partial<HarnessStopDeps> = {}): HarnessStopDeps {
  const env = { ...process.env };
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key];
  const kubectl = (args: readonly string[]) => {
    const r = spawnSync('kubectl', [...args], { encoding: 'utf8', timeout: 15_000, env });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') };
  };
  return {
    readPidRecord: (runId) => readPidRecordFrom(selfDevRunsDir(), runId),
    processStartMs: psProcessStartMs,
    kill: (pid, signal) => { process.kill(pid, signal); },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    kubeContexts: () => {
      const r = kubectl(['config', 'get-contexts', '-o', 'name']);
      return r.status === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    },
    kubectl,
    namespace: 'elanous-test',
    graceMs: 10_000,
    ...overrides,
  };
}

export async function stopHarnessRun(runId: string, deps: HarnessStopDeps, contexts?: readonly string[]): Promise<HarnessStopResult> {
  if (!RUN_ID.test(runId)) throw new Error(`invalid run id: ${runId}`);
  // ── ⓐ 프로세스 ────────────────────────────────────────────
  let processState: HarnessStopResult['process'] = 'absent';
  const record = deps.readPidRecord(runId);
  if (record) {
    const actual = deps.processStartMs(record.pid);
    if (actual === null) processState = 'absent';
    else if (Math.abs(actual - record.startedAt) > START_TOLERANCE_MS) processState = 'owner-mismatch';
    else {
      try { deps.kill(record.pid, 'SIGTERM'); } catch { /* 방금 끝났다 */ }
      processState = 'stopped';
      const step = 250;
      for (let waited = 0; waited < deps.graceMs; waited += step) {
        await deps.sleep(step);
        if (deps.processStartMs(record.pid) === null) break;
      }
      const still = deps.processStartMs(record.pid);
      if (still !== null && Math.abs(still - record.startedAt) <= START_TOLERANCE_MS) {
        try { deps.kill(record.pid, 'SIGKILL'); processState = 'killed'; } catch { /* 끝났다 */ }
      }
    }
  }
  // ── ⓑ Pod Job (라벨로만) ───────────────────────────────────
  const targets = contexts && contexts.length > 0 ? [...contexts] : deps.kubeContexts();
  let jobsDeleted = 0;
  for (const context of targets) {
    const r = deps.kubectl(['--context', context, '-n', deps.namespace, 'delete', 'job', '-l', `elanous.run=${runId}`, '--wait=false']);
    if (r.status === 0) jobsDeleted += r.stdout.split('\n').filter((line) => line.startsWith('job.batch/')).length;
    else debug.log('harness.stop', 'job-delete-failed', { runId, context, error: r.stderr.slice(0, 200) }, { level: 'warn' });
  }
  const result: HarnessStopResult = { runId, process: processState, ...(record ? { pid: record.pid } : {}), jobsDeleted, contexts: targets };
  debug.log('harness.stop', 'stopped', { runId, process: processState, jobsDeleted, contexts: targets.length });
  return result;
}

export function formatHarnessStop(r: HarnessStopResult): string {
  const label: Record<HarnessStopResult['process'], string> = {
    stopped: '멈춤(SIGTERM)', killed: '멈춤(SIGKILL — 제한 시간 안에 안 끝났다)', absent: '없음', 'owner-mismatch': '소유 불일치(건드리지 않음 — PID 가 다른 프로세스로 재사용됐다)',
  };
  return [
    `harness stop ${r.runId}`,
    `  프로세스: ${label[r.process]}${r.pid ? ` · pid ${r.pid}` : ''}`,
    `  Pod Job: ${r.jobsDeleted}개 지움 (문맥 ${r.contexts.length}개 · 라벨 elanous.run=${r.runId})`,
  ].join('\n');
}
