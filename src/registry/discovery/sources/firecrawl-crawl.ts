// RFC #2161 Phase 6 FU A6-real · P3 (2026-05-11) — Firecrawl CLI crawler.
//
// Optional discovery source that shells out to the `firecrawl` CLI's
// `agent` subcommand for AI-driven web extraction. Where grok-crawl
// uses xAI Grok's live-search inline (mandatory · LLM-maintained),
// this source is intentionally opt-in: a user who wants higher
// catalog freshness can install the Firecrawl CLI + key, and the
// catalog merger weights its results against grok-crawl's per
// per-source agreement.
//
// Install (user-side · NEXUS advanced wizard ships in P5):
//   npm install -g firecrawl-cli
//   firecrawl auth login           # or set FIRECRAWL_API_KEY
//
// CLI invocation:
//   firecrawl agent "<prompt>" --wait --timeout 60
// Output is free-form JSON when the prompt asks for it; we reuse
// grok-crawl's `extractCrawlJson` parser for defensive unwrapping.
//
// Availability gates (both must pass — otherwise ok:false):
//   1. CLI binary present (async probe via `firecrawl --version`)
//   2. API key configured (user-config > FIRECRAWL_API_KEY env)
//
// Fresh installs without Firecrawl pay zero CPU/network — the source
// reports missing-config and the runner surfaces a hint rather than
// failing the whole discovery run.
//
// Cross-ref:
//   src/registry/discovery/sources/grok-crawl.ts (mandatory peer · P2)
//   src/registry/discovery/config.ts (getFirecrawlConfig · API key resolver)
//   src/storage/s3.ts (availability-probe precedent)

import { spawn, type ChildProcess } from 'node:child_process';
import { getFirecrawlConfigAsync } from '../config.js';
import {
  extractCrawlJson,
  GROK_CRAWL_PROVIDERS,
} from './grok-crawl.js';
import type {
  DiscoveredModel,
  DiscoverySource,
  DiscoverySourceOpts,
  DiscoverySourceResult,
} from '../types.js';

// CLI itself is slow (live web crawl + LLM extraction). 120s headroom.
const DEFAULT_TIMEOUT_MS = 120_000;
const CLI_VERSION_TIMEOUT_MS = 3_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const KILL_GRACE_MS = 250;
const POST_KILL_WAIT_MS = 250;
const TREE_POLL_MS = 20;

/** Probe `firecrawl --version`. Returns false when the binary is
 *  missing or any spawn error occurs (PATH wrong, permission denied).
 *  Cached — fresh installs that later add the CLI need a daemon
 *  restart or `__resetFirecrawlCliCache()` (tests). */
let cliAvailableCache: boolean | null = null;
export async function isFirecrawlCliAvailable(signal?: AbortSignal): Promise<boolean> {
  if (cliAvailableCache !== null) return cliAvailableCache;
  const available = await probeFirecrawlCli(signal);
  if (signal?.aborted) return false;
  cliAvailableCache = available;
  return available;
}

/** Test-only — reset the cached probe result. */
export function __resetFirecrawlCliCache(): void {
  cliAvailableCache = null;
}

export type FirecrawlKillReason = 'timeout' | 'abort' | 'maxBuffer';

/** 프로세스 «그룹»의 상태. ⛔ 셋이고, 셋째를 둘 중 하나로 접으면 거짓말이 된다.
 *  - `exited`       그룹이 사라진 것을 «확인했다»
 *  - `alive`        SIGKILL 뒤에도 «살아 있는 것을 확인했다»
 *  - `unobservable` 그룹 상태를 «못 봤다» (음수 PGID 미지원 플랫폼 · 예기치 못한 오류)
 *                   ⛔ 원인을 단정하지 않는다 — 참인 것은 「못 봤다」뿐이다. */
export type ProcessGroupState = 'exited' | 'alive' | 'unobservable';

/** Thrown when the child was killed for exceeding the output cap.
 *  Carries the same two values the resolve path carries so callers
 *  never have to parse a message string to learn why. */
export class FirecrawlSpawnKilledError extends Error {
  readonly killReason: FirecrawlKillReason;
  readonly treeState: ProcessGroupState;
  /** 정산 시점에 «실제로» 담고 있던 바이트. 상한을 얼마나 넘었는지가 곧
   *  「닿은 뒤 읽기를 멈췄나」의 답이라, 값으로 내지 않으면 잴 방법이 없다. */
  readonly bufferedBytes: number;
  constructor(killReason: FirecrawlKillReason, treeState: ProcessGroupState, bufferedBytes: number) {
    super(`firecrawl child killed (${killReason}); processGroup=${treeState}; bufferedBytes=${bufferedBytes}`);
    this.name = 'FirecrawlSpawnKilledError';
    this.killReason = killReason;
    this.treeState = treeState;
    this.bufferedBytes = bufferedBytes;
  }
}

interface FirecrawlSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Why we killed the child, or `null` when it exited on its own.
   *  ⛔ `status: null` alone cannot answer this — a spawn failure and a
   *  timeout both produce a null exit code. */
  killReason?: FirecrawlKillReason | null;
  /** 죽인 뒤 프로세스 «그룹»이 어떻게 됐나. ⛔ 불리언이 아니다 — 세 상태다.
   *  ⛔ 「죽였다」와 「죽은 것을 «확인»했다」와 「확인할 «수» 없다」는 다른 값이고,
   *  셋째를 첫째로 접으면 후손이 남았는데 「끝났다」고 보고하게 된다.
   *  무한 대기는 답이 아니다 — 그것이 이 모듈이 없애려는 그 막힘이다. */
  treeState?: ProcessGroupState;
}

interface FirecrawlSpawnOpts {
  timeoutMs: number;
  apiKey: string;
  signal?: AbortSignal;
  /** Test seam — see `FirecrawlCrawlOpts.maxBufferBytes`. */
  maxBufferBytes?: number;
}

/** Spawn the firecrawl CLI with the given args. Returns the captured
 *  stdout/stderr and exit code so callers can decide how to handle
 *  partial output / errors. Production awaits a non-blocking `spawn`;
 *  tests inject a stub via `opts.spawnFn` (sync or async). */
export type FirecrawlSpawnFn = (
  args: readonly string[],
  opts: FirecrawlSpawnOpts,
) => FirecrawlSpawnResult | Promise<FirecrawlSpawnResult>;

function killProcessTree(
  child: ChildProcess,
  pgid: number | undefined,
  signal: 'SIGTERM' | 'SIGKILL',
): void {
  if (typeof pgid === 'number') {
    try {
      process.kill(-pgid, signal);
    } catch {
      /* process group may already be gone, or unsupported on this platform */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already dead */
  }
}

/** ⛔ 「그룹이 없다」와 「이 플랫폼에선 물어볼 수 없다」를 한 값으로 접지 않는다.
 *  음수 PGID 시그널은 POSIX 규약이고, 지원하지 않는 플랫폼(Windows 등)에서는
 *  `process.kill(-pgid, 0)` 이 EINVAL/ENOSYS/EPERM 으로 실패한다. 그것을 `false`
 *  로 접으면 ***후손이 살아 있는데 `treeExited: true` 를 허위 보고***하게 된다. */
export function classifyProcessGroupError(code: string | undefined): ProcessGroupState {
  if (code === 'ESRCH') return 'exited';   // 그룹이 «정말» 없다
  if (code === 'EPERM') return 'alive';    // 있는데 우리가 못 건드린다
  // EINVAL · ENOSYS(플랫폼 미지원) · undefined · 그 밖(예기치 못한 런타임 오류) —
  // ⛔ 갈래가 여럿이므로 «원인»을 단정하지 않는다. 참인 것은 하나뿐이다:
  //    ***우리가 그룹 상태를 «못 봤다»***. 여기를 'exited' 로 접으면
  //    후손이 살아 있는데 「끝났다」고 보고하게 된다.
  return 'unobservable';
}

/** `limit` 바이트 이하이면서 ***UTF-8 경계에서 끝나는*** 최대 접두를 돌려준다.
 *  ⛔ 임의 바이트에서 자르면 `toString('utf-8')` 이 부분 시퀀스를 `U+FFFD`(3바이트)로
 *  «치환»해 ***저장 바이트가 상한을 넘는다*** — 상한을 지키려던 코드가 상한을 깬다.
 *  연속 바이트는 `0b10xxxxxx` 이므로 코드포인트 시작까지 되감는다.
 *
 *  ⚠️ **계약: 입력이 «유효한 UTF-8» 일 때만 경계를 보장한다.** 손상된 바이트열을 주면
 *  불완전한 선행 시퀀스가 남을 수 있다. 이 모듈의 유일한 호출자는
 *  `Buffer.from(<string>, 'utf-8')` 의 산출이라 언제나 유효하다. */
export function sliceUtf8AtBoundary(buf: Buffer, limit: number): Buffer {
  if (limit <= 0) return buf.subarray(0, 0);
  if (buf.length <= limit) return buf;
  let end = limit;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

function probeProcessGroup(pgid: number | undefined): ProcessGroupState {
  if (typeof pgid !== 'number') return 'unobservable';
  try {
    process.kill(-pgid, 0);
    return 'alive';
  } catch (err) {
    return classifyProcessGroupError((err as NodeJS.ErrnoException).code);
  }
}

function spawnCommand(
  command: string,
  args: readonly string[],
  opts: {
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    maxBufferBytes?: number;
  },
): Promise<FirecrawlSpawnResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      // Already aborted before spawn — no child existed, so the tree is
      // trivially gone. `killReason: 'abort'` still distinguishes this from
      // a spawn failure, which also yields `status: null`.
      resolve({ status: null, stdout: '', stderr: '', killReason: 'abort', treeState: 'exited' });
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    // ⛔ 청크마다 누적 전체를 다시 재면 출력량에 대해 제곱이 된다.
    //    상한이 10MiB 라 그 비용이 실재한다 — 청크 «바이트»를 누적한다.
    let bufferedBytes = 0;
    let killReason: FirecrawlKillReason | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(command, args as string[], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: opts.env ?? process.env,
    });
    const pgid = typeof child.pid === 'number' ? child.pid : undefined;

    const cleanup = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    const settleResolve = (result: FirecrawlSpawnResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const finishForcedKill = (reason: FirecrawlKillReason, treeState: ProcessGroupState): void => {
      if (reason === 'maxBuffer') {
        settleReject(new FirecrawlSpawnKilledError(reason, treeState, bufferedBytes));
      } else {
        settleResolve({ status: null, stdout, stderr, killReason: reason, treeState });
      }
    };

    const waitForTreeExit = (reason: FirecrawlKillReason): void => {
      const deadline = Date.now() + POST_KILL_WAIT_MS;
      const poll = (): void => {
        if (settled) return;
        const state = probeProcessGroup(pgid);
        if (state === 'exited') {
          finishForcedKill(reason, 'exited');
          return;
        }
        if (state === 'unobservable') {
          // 이 플랫폼에선 그룹을 물어볼 수 없다. 기다려 봐야 답이 안 나오므로
          // ⛔ 「끝났다」로 접지 말고 «모른다»를 그대로 낸다.
          finishForcedKill(reason, 'unobservable');
          return;
        }
        if (Date.now() >= deadline) {
          // 기다리기를 그만뒀다 — 그룹은 «살아 있는 것을 확인»한 상태다.
          finishForcedKill(reason, 'alive');
          return;
        }
        forceTimer = setTimeout(poll, TREE_POLL_MS);
      };
      poll();
    };

    const beginKill = (reason: FirecrawlKillReason): void => {
      if (settled || killReason) return;
      killReason = reason;
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      killProcessTree(child, pgid, 'SIGTERM');
      // Shell `close` must not cancel this: SIGTERM-ignoring grandchildren
      // stay in the process group and need the SIGKILL escalation.
      graceTimer = setTimeout(() => {
        killProcessTree(child, pgid, 'SIGKILL');
        waitForTreeExit(reason);
      }, KILL_GRACE_MS);
    };

    /** 상한에 닿으면 파이프를 «끊는다». destroy 가 실패해도 위의 조기 반환이
     *  두 번째 방어선으로 남아 문자열은 더 안 자란다. */
    const stopReadingOutput = (): void => {
      try { child.stdout?.destroy(); } catch { /* already gone */ }
      try { child.stderr?.destroy(); } catch { /* already gone */ }
    };

    const onAbort = (): void => {
      beginKill('abort');
    };

    const onChunk = (kind: 'stdout' | 'stderr', chunk: string): void => {
      // ⛔ 상한에 «닿은 뒤»에도 계속 쌓으면 상한이 다시 장식이 된다 — SIGTERM 유예
      //    250ms ⊕ SIGKILL ⊕ 정산까지 출력 폭주 프로세스가 메모리를 더 먹는다.
      //    닿는 «즉시» 읽기를 끊고, 그 뒤 청크는 버린다.
      const max = opts.maxBufferBytes ?? MAX_BUFFER_BYTES;
      // ⛔ `>=` 다 — 「상한에 «도달»하면」이 계약이다. `>` 면 정확히 상한인 출력이
      //    다음 청크까지 «한 번 더» 읽힌다. 아래 발동 조건과 «같은 부등호»여야 한다.
      // ⛔ 그리고 여기서 «그냥 return 하면 안 된다» — cap 이 0(또는 음수)이면 첫 청크부터
      //    이 줄에 걸려 kill 이 «영영» 안 돌고 상한이 다시 장식이 된다. 예산을 다 썼으면
      //    ***읽기를 끊고 죽인다***. beginKill 은 killReason 가드로 멱등이다.
      if (bufferedBytes >= max) {
        stopReadingOutput();
        beginKill('maxBuffer');
        return;
      }
      // ⛔ `.length` 는 UTF-16 코드 유닛이라 «바이트 상한»이 아니다 — 멀티바이트
      //    출력에서 실제 캡을 넘긴다. 이름이 Bytes 면 바이트로 재야 한다.
      // ⛔ 청크 «크기»를 가정하지 않는다. 런타임이 1MiB 보다 큰 data 청크를 줄 수
      //    있으므로 「overshoot 은 청크 하나」는 «가정»이다 — 가정을 문서화하는 대신
      //    ***남은 예산까지만 담아*** 없앤다.
      const chunkBuf = Buffer.from(chunk, 'utf-8');
      const remaining = max - bufferedBytes;
      const keep = sliceUtf8AtBoundary(chunkBuf, remaining);
      if (kind === 'stdout') stdout += keep.toString('utf-8');
      else stderr += keep.toString('utf-8');
      // ⭐ 「담으려던 양」이 아니라 ***「실제로 담은 바이트」***를 센다. 경계 되감기로
      //    keep 이 remaining 보다 «작을» 수 있고, 그때 bufferedBytes 를 remaining 으로
      //    적으면 그 값이 거짓이 된다.
      bufferedBytes += keep.length;
      // 발동선은 「예산을 다 썼나」다 — 되감기로 몇 바이트 남았어도 다음 청크를 담을
      // 자리는 없으므로 여기서 끊는다.
      if (chunkBuf.length >= remaining || bufferedBytes >= max) {
        stopReadingOutput();
        beginKill('maxBuffer');
      }
    };

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => onChunk('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => onChunk('stderr', chunk));
    child.on('error', (err) => {
      // ⛔ 죽이는 «중»에는 error 로 정산하면 안 된다 — settle 이 cleanup() 을 부르고
      //    그것이 SIGKILL 승급 타이머를 «취소»해 후손이 남는다. close 와 같은 규율이다.
      //    (이 방어는 #14926 판본에 있었고 내 판본에 «없었다» — 병합에서 얻었다.)
      if (killReason) return;
      settleReject(err instanceof Error ? err : new Error(String(err)));
    });
    child.on('close', (code) => {
      // A kill is in flight: the shell exiting is not the tree exiting.
      // Keep the grace/SIGKILL timers so descendants that ignored SIGTERM
      // are still escalated, then settle from waitForTreeExit.
      if (killReason) return;
      settleResolve({
        status: code ?? null,
        stdout,
        stderr,
        killReason: null,
        treeState: 'exited',
      });
    });

    timeoutTimer = setTimeout(() => {
      beginKill('timeout');
    }, opts.timeoutMs);

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort);
    }
  });
}

async function probeFirecrawlCli(signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await spawnCommand('firecrawl', ['--version'], {
      timeoutMs: CLI_VERSION_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
      maxBufferBytes: 64 * 1024,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

const defaultSpawnFn: FirecrawlSpawnFn = (args, opts) => {
  return spawnCommand('firecrawl', args, {
    timeoutMs: opts.timeoutMs,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    env: {
      ...process.env,
      FIRECRAWL_API_KEY: opts.apiKey,
    },
    maxBufferBytes: opts.maxBufferBytes ?? MAX_BUFFER_BYTES,
  });
};

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function userPromptForProviders(providers: readonly string[]): string {
  return `Visit each provider's official model documentation page and list every currently available production LLM model from: ${providers.join(', ')}.

Return ONLY a JSON object (no markdown fences, no prose) with this shape:

{"models": [{"id": "<api-id>", "provider": "<provider>", "displayName": "<label>", "releaseDate": "<YYYY-MM-DD or omit>", "description": "<short or omit>", "contextSize": <integer or omit>, "outputMaxTokens": <integer or omit>}]}

Rules:
- Skip deprecated / preview / coming-soon models.
- "id" matches the provider's canonical API model id.
- "provider" must be one of the providers in this query.
- Output the JSON object only. No prose, no markdown.`;
}

export interface FirecrawlCrawlOpts extends DiscoverySourceOpts {
  providers?: readonly string[];
  /** Test seam — replace the spawn invocation. Production uses
   *  `defaultSpawnFn` which awaits `spawn('firecrawl', ...)`. */
  spawnFn?: FirecrawlSpawnFn;
  /** Test seam — shrink the output cap so the truncation path is reachable
   *  without flooding 10MiB. Production leaves this unset. */
  maxBufferBytes?: number;
  /** Test seam — bypass the CLI availability probe. Production gates
   *  on the cached `isFirecrawlCliAvailable()` result. */
  cliAvailable?: boolean;
}

interface FirecrawlCrawlModelWire {
  id?: unknown;
  provider?: unknown;
  displayName?: unknown;
  releaseDate?: unknown;
  description?: unknown;
  contextSize?: unknown;
  outputMaxTokens?: unknown;
}

function cancelledResult(
  now: () => number,
  startedAt: number,
  spawnResult?: FirecrawlSpawnResult,
): DiscoverySourceResult {
  // 취소도 「어떻게 끝났나」를 싣는다. spawnResult 가 없으면(= spawn 전에 취소됨)
  // 붙일 값이 «없는» 것이고, 그것과 「값이 있었는데 버렸다」는 다른 상태다.
  const parts: string[] = [];
  if (spawnResult?.killReason) parts.push(spawnResult.killReason);
  if (spawnResult?.treeState === 'alive') parts.push('process group still alive');
  else if (spawnResult?.treeState === 'unobservable') parts.push('could not observe the process group');
  const detail = parts.length > 0 ? ` (${parts.join('; ')})` : '';
  return {
    source: 'firecrawl-crawl',
    ok: false,
    models: [],
    durationMs: now() - startedAt,
    error: `cancelled: abort signal${detail}`,
  };
}

export const firecrawlCrawlSource = {
  id: 'firecrawl-crawl' as const,
  async run(opts: FirecrawlCrawlOpts = {}): Promise<DiscoverySourceResult> {
    const now = opts.now ?? Date.now;
    const startedAt = now();
    if (opts.signal?.aborted) {
      return cancelledResult(now, startedAt);
    }
    let apiKey: string;
    try { ({ apiKey } = await getFirecrawlConfigAsync()); }
    catch {
      return { source: 'firecrawl-crawl', ok: false, models: [], durationMs: now() - startedAt, error: 'Firecrawl secret store unavailable' };
    }
    if (!apiKey) {
      return {
        source: 'firecrawl-crawl',
        ok: false,
        models: [],
        durationMs: now() - startedAt,
        error: 'missing-api-key: run elanous setup firecrawl',
      };
    }
    if (opts.signal?.aborted) {
      return cancelledResult(now, startedAt);
    }
    const cliAvailable = opts.cliAvailable ?? await isFirecrawlCliAvailable(opts.signal);
    if (opts.signal?.aborted) {
      return cancelledResult(now, startedAt);
    }
    if (!cliAvailable) {
      return {
        source: 'firecrawl-crawl',
        ok: false,
        models: [],
        durationMs: now() - startedAt,
        error: 'missing-cli: install firecrawl CLI (npm i -g firecrawl-cli)',
      };
    }
    const providers = (opts.providers && opts.providers.length > 0)
      ? opts.providers
      : GROK_CRAWL_PROVIDERS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const spawnFn = opts.spawnFn ?? defaultSpawnFn;
    const args = [
      'agent',
      userPromptForProviders(providers),
      '--wait',
      '--timeout', String(Math.max(10, Math.floor(timeoutMs / 1000))),
    ];

    let spawnResult: FirecrawlSpawnResult;
    try {
      spawnResult = await spawnFn(args, {
        timeoutMs,
        apiKey,
        ...(opts.maxBufferBytes !== undefined ? { maxBufferBytes: opts.maxBufferBytes } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      if (opts.signal?.aborted) return cancelledResult(now, startedAt);
      if (e instanceof FirecrawlSpawnKilledError) {
        // Killed for exceeding the output cap — a distinct outcome from a
        // network fault, and the surviving-tree bit must not be swallowed.
        return {
          source: 'firecrawl-crawl',
          ok: false,
          models: [],
          durationMs: now() - startedAt,
          error: `upstream-killed: ${e.killReason} (processGroup=${e.treeState}; bufferedBytes=${e.bufferedBytes})`,
        };
      }
      return {
        source: 'firecrawl-crawl',
        ok: false,
        models: [],
        durationMs: now() - startedAt,
        error: `upstream-network: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    if (opts.signal?.aborted) {
      // ⛔ 「취소됐다」만 말하고 killReason·treeState 를 버리면, 「우리가 죽였고
      //    그룹이 «살아남았다»」가 조용히 사라진다. 취소도 그 둘을 싣는다.
      return cancelledResult(now, startedAt, spawnResult);
    }

    if (spawnResult.status === null) {
      // ⛔ `status: null` alone folds three different outcomes into one:
      // a spawn failure, an abort, and a real timeout. `killReason` is the
      // value that splits them — so say which one it was instead of
      // reporting every null exit as a timeout.
      const reason = spawnResult.killReason ?? null;
      const treeNote = spawnResult.treeState === 'alive'
        ? ' (⚠ process group still alive when we returned)'
        : spawnResult.treeState === 'unobservable'
          ? ' (⚠ could not observe the process group — descendants may survive)'
          : '';
      return {
        source: 'firecrawl-crawl',
        ok: false,
        models: [],
        durationMs: now() - startedAt,
        error: reason === null
          ? 'upstream-failed: firecrawl CLI produced no exit code and was not killed by us'
          : `upstream-${reason}: firecrawl CLI did not return${treeNote}`,
      };
    }
    if (spawnResult.status !== 0) {
      const stderr = spawnResult.stderr.trim().slice(0, 200);
      return {
        source: 'firecrawl-crawl',
        ok: false,
        models: [],
        durationMs: now() - startedAt,
        error: `upstream-http-${spawnResult.status}${stderr ? `: ${stderr}` : ''}`,
      };
    }

    const parsed = extractCrawlJson(spawnResult.stdout) as
      | { models?: FirecrawlCrawlModelWire[] } | null;
    const wireModels = Array.isArray(parsed?.models) ? parsed!.models! : [];
    const lastSeen = new Date(now()).toISOString();
    const models: DiscoveredModel[] = [];
    for (const m of wireModels) {
      if (!isString(m.id) || !isString(m.provider)) continue;
      if (!providers.includes(m.provider)) continue;
      models.push({
        id: m.id,
        provider: m.provider,
        partial: {
          id: m.id,
          provider: m.provider,
          displayName: isString(m.displayName) ? m.displayName : m.id,
          ...(isString(m.releaseDate) ? { releaseDate: m.releaseDate } : {}),
          ...(isString(m.description) ? { description: m.description } : {}),
          ...(isNumber(m.contextSize) ? { contextSize: m.contextSize } : {}),
          ...(isNumber(m.outputMaxTokens) ? { outputMaxTokens: m.outputMaxTokens } : {}),
        },
        discoveryMeta: {
          source: 'auto-firecrawl-crawl' as const,
          lastSeen,
          autoFilled: true,
          confidence: 'medium' as const,
        },
      });
    }
    return {
      source: 'firecrawl-crawl',
      ok: true,
      models,
      durationMs: now() - startedAt,
    };
  },
} satisfies DiscoverySource;
