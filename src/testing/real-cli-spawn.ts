/**
 * ⏱️ GATE-SPEED ③ — 실물 엔트리 spawn 을 «비동기 ⊕ 상한 있는 동시성»으로 돌리는 테스트 전용 도구.
 *
 * Situation: 배선 시험(`bin/elanous.mjs` 실물 spawn)은 1회 ~3–4초(전 모듈 그래프 콜드 스타트)이고,
 *   `spawnSync` 로 줄 세우면 파일 하나가 게이트 임계 경로(수백 초)를 잡는다.
 * Answer: 시험이 문는 값(실물 프로세스의 stdout·stderr·종료 코드·시그널)은 그대로 두고,
 *   «기다리는 방식»만 바꾼다 — `describe.concurrent` 안에서 이 함수를 `await` 하면 서로 독립인
 *   spawn 들이 `REAL_CLI_SPAWN_CONCURRENCY` 개까지 겹쳐 돈다.
 *
 * ⛔ 반환 모양은 `spawnSync(..., { encoding: 'utf8' })` 와 같다 — 시그널로 죽으면 `status` 는 null 이고
 *   `signal` 이 찬다. spawn 자체가 실패하면 `error` 가 찬다(타임아웃 = 0바이트 산출과 구분하려고).
 * ⛔ spawn 의 `timeoutMs` 는 «슬롯을 얻은 뒤»부터 잰다 — 대기열에서 기다린 시간은 실패로 세지 않는다.
 *   그래서 이 도구를 쓰는 시험의 «테스트» 타임아웃은 대기열 몫까지 넉넉히 둔다.
 */
import { availableParallelism } from 'node:os';

export interface RealCliSpawnResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: string | null;
  error?: Error;
}

export interface RealCliSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
}

function resolveConcurrency(): number {
  const fromEnv = Number(process.env.ELANOUS_TEST_REAL_CLI_CONCURRENCY);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return Math.max(2, Math.min(6, Math.floor(availableParallelism() / 3)));
}

export const REAL_CLI_SPAWN_CONCURRENCY = resolveConcurrency();

let active = 0;
const waiters: Array<() => void> = [];

async function withSlot<T>(run: () => Promise<T>): Promise<T> {
  while (active >= REAL_CLI_SPAWN_CONCURRENCY) await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
  try {
    return await run();
  } finally {
    active -= 1;
    waiters.shift()?.();
  }
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

/** `spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' })` 의 비동기 대응 — 동시성 상한 안에서 돈다. */
export async function spawnRealCli(cmd: string[], options: RealCliSpawnOptions): Promise<RealCliSpawnResult> {
  const r = await spawnRealCliBytes(cmd, options);
  const decoder = new TextDecoder();
  return {
    stdout: decoder.decode(r.stdout),
    stderr: decoder.decode(r.stderr),
    status: r.exitCode,
    signal: r.signal,
    ...(r.error ? { error: r.error } : {}),
  };
}

export interface RealCliSpawnBytesResult {
  /** `Bun.spawnSync` 와 같은 이름 — 시그널로 죽으면 null. */
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  signal: string | null;
  error?: Error;
}

/** `Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' })` 의 비동기 대응 — 바이트 그대로 돌려준다. */
export function spawnRealCliBytes(cmd: string[], options: RealCliSpawnOptions): Promise<RealCliSpawnBytesResult> {
  return withSlot(async () => {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(cmd, {
        cwd: options.cwd,
        env: definedEnv(options.env ?? { ...process.env }),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
      });
    } catch (error) {
      return { stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: null, signal: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream).arrayBuffer(),
      new Response(proc.stderr as ReadableStream).arrayBuffer(),
    ]);
    await proc.exited;
    const signal = proc.signalCode ?? null;
    return { stdout: new Uint8Array(stdout), stderr: new Uint8Array(stderr), exitCode: signal ? null : proc.exitCode, signal };
  });
}
