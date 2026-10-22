// ── TUI 자기인지 ambient 캐시 — 턴 시작이 이벤트 루프를 막지 않게 (TUI-TYPING-LAG · 2026-10-14) ──
//
// 실측(격리 TUI · bun --cpu-prof): 턴마다 `elanousSelfAmbientBaseParts()`(ops 스캔·crontab·`ps`)가
// 메인 스레드에서 동기로 돌았고, 한 턴에 «두 번»(대시보드 preamble ⊕ ACP buildTurnMessages) 돌아
// 그 동안 키 입력이 0.4~9s 멈췄다. 이 캐시는 «요청과 무관한» 부분만 담는다:
//   · 신선(< FRESH_MS) → 그대로 쓴다.
//   · 오래됨(< STALE_MAX_MS) → 그대로 쓰고 워커에서 다시 잰다(다음 턴용).
//   · 없음/너무 오래됨 → 종전대로 동기 계산(첫 턴 내용 보존). TUI 는 부팅 때 데우고 5s 주기
//     틱(`refreshSelfAmbientCache({}, { ifOlderThanMs })` · src/dashboard/index.ts)으로 계속 데워
//     두므로, 워커가 실패(백오프)하지 않는 한 오래 쉰 뒤 첫 턴도 이 길로 안 온다.
// 관측 = `self-ambient.cache` (hit · stale-hit · sync · worker-refreshed · worker-failed).

import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { setElanousConfigDir } from '../elanous-config-dir.js';
import { elanousSelfAmbientBaseParts } from './self-ambient.js';

export const SELF_AMBIENT_FRESH_MS = 30_000;
export const SELF_AMBIENT_STALE_MAX_MS = 10 * 60_000;
export const SELF_AMBIENT_KEEP_WARM_ACTIVE_MS = 25_000;
export const SELF_AMBIENT_KEEP_WARM_IDLE_MS = 8 * 60_000;
const SELF_AMBIENT_IDLE_AFTER_MS = 2 * 60_000;
const WORKER_TIMEOUT_MS = 60_000;

/** Keep turn context warm while active; avoid periodic ambient scans during a long idle. */
export function selfAmbientKeepWarmIntervalMs(idleMs: number): number {
  return idleMs >= SELF_AMBIENT_IDLE_AFTER_MS ? SELF_AMBIENT_KEEP_WARM_IDLE_MS : SELF_AMBIENT_KEEP_WARM_ACTIVE_MS;
}

interface CacheEntry { at: number; version: number; parts: string[] }

export interface SelfAmbientCacheDeps {
  now?: () => number;
  computeSync?: () => string[];
  computeInWorker?: (stateRoot: string | undefined, selectedRoot: string) => Promise<string[]>;
  universeKey?: () => { stateRoot: string | undefined; selectedRoot: string };
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
}

const entries = new Map<string, CacheEntry>();
/** Monotonic store sequence — orders async worker stores against synchronous ones.
 *  A millisecond `at` clock ties within the same millisecond and let a worker's older
 *  result overwrite a newer synchronous computation; the version never ties. */
let storeSeq = 0;
const inFlight = new Map<string, Promise<void>>();
/** A failed worker is not retried (by ticks or stale turn reads) for this long; the turn path keeps
 *  serving the stale entry, or falls back to sync once it is too old. */
const WORKER_FAILURE_BACKOFF_MS = 60_000;
const lastFailureAt = new Map<string, number>();

function resolveDeps(deps: SelfAmbientCacheDeps): Required<SelfAmbientCacheDeps> {
  return {
    now: deps.now ?? Date.now,
    computeSync: deps.computeSync ?? elanousSelfAmbientBaseParts,
    computeInWorker: deps.computeInWorker ?? computeBasePartsInWorker,
    universeKey: deps.universeKey ?? (() => ({ stateRoot: process.env.ELANOUS_STATE_DIR, selectedRoot: effectiveInstanceRoot() })),
    log: deps.log ?? ((category, event, data) => debug.log(category, event, data)),
  };
}

/** Start (or join) a background refresh. Resolves when the cache has been updated or the refresh failed.
 *  `ifOlderThanMs` turns it into a keep-warm tick: a younger entry is left alone. */
export function refreshSelfAmbientCache(deps: SelfAmbientCacheDeps = {}, opts: { ifOlderThanMs?: number } = {}): Promise<void> {
  const d = resolveDeps(deps);
  const { stateRoot, selectedRoot } = d.universeKey();
  const key = JSON.stringify([selectedRoot, stateRoot ?? null]);
  const cached = entries.get(key);
  if (cached && opts.ifOlderThanMs !== undefined && d.now() - cached.at < opts.ifOlderThanMs) return Promise.resolve();
  if (d.now() - (lastFailureAt.get(key) ?? -Infinity) < WORKER_FAILURE_BACKOFF_MS) return Promise.resolve();
  const running = inFlight.get(key);
  if (running) return running;
  const startedAt = d.now();
  const startedVersion = storeSeq;
  // A worker that fails to even start (sync throw) is the same fail-soft failure as one that rejects.
  let started: Promise<string[]>;
  try { started = d.computeInWorker(stateRoot, selectedRoot); }
  catch (error) { started = Promise.reject(error); }
  const refresh = started
    .then((parts) => {
      // A newer entry (e.g. a synchronous first-turn computation that overlapped this worker) is kept.
      // Judged by the monotonic store version, not the millisecond clock: a store that landed in the
      // same millisecond as this worker's start is still newer.
      const current = entries.get(key);
      if (current && current.version > startedVersion) return;
      entries.set(key, { at: startedAt, version: ++storeSeq, parts });
      d.log('self-ambient.cache', 'worker-refreshed', { ms: d.now() - startedAt, parts: parts.length });
    }, (error: unknown) => {
      lastFailureAt.set(key, d.now());
      d.log('self-ambient.cache', 'worker-failed', { ms: d.now() - startedAt, reason: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => { inFlight.delete(key); });
  inFlight.set(key, refresh);
  return refresh;
}

/** Request-independent ambient parts for the TUI turn preamble, served from the cache when possible. */
export function cachedSelfAmbientBaseParts(deps: SelfAmbientCacheDeps = {}): string[] {
  const d = resolveDeps(deps);
  const { stateRoot, selectedRoot } = d.universeKey();
  const key = JSON.stringify([selectedRoot, stateRoot ?? null]);
  const at = d.now();
  const cached = entries.get(key);
  const ageMs = cached ? at - cached.at : null;
  if (cached && ageMs! < SELF_AMBIENT_FRESH_MS) {
    d.log('self-ambient.cache', 'hit', { ageMs });
    return [...cached.parts];
  }
  if (cached && ageMs! < SELF_AMBIENT_STALE_MAX_MS) {
    d.log('self-ambient.cache', 'stale-hit', { ageMs });
    void refreshSelfAmbientCache(deps);
    return [...cached.parts];
  }
  const parts = d.computeSync();
  entries.set(key, { at, version: ++storeSeq, parts });
  d.log('self-ambient.cache', 'sync', { ms: d.now() - at, ageMs, parts: parts.length });
  return [...parts];
}

export function _resetSelfAmbientCacheForTest(): void {
  storeSeq = 0;
  entries.clear();
  inFlight.clear();
  lastFailureAt.clear();
}

function computeBasePartsInWorker(stateRoot: string | undefined, selectedRoot: string): Promise<string[]> {
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'self-ambient' } });
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`self-ambient worker timed out after ${WORKER_TIMEOUT_MS}ms`)), WORKER_TIMEOUT_MS);
    // A background warm-up must never keep a finished CLI or test process alive.
    timeout.unref?.();
    worker.unref?.();
    const finish = (error?: Error, parts?: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      if (error) reject(error);
      else resolve(parts!);
    };
    worker.on('message', (message: { parts?: string[]; error?: string }) => {
      if (message.error) finish(new Error(message.error));
      else if (message.parts) finish(undefined, message.parts);
    });
    worker.on('error', error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.on('exit', code => { if (!settled) finish(new Error(`self-ambient worker exited before answering: ${code}`)); });
    // Pin the caller's universe: a programmatic config override is not inherited by workers.
    worker.postMessage({ stateRoot, selectedRoot });
  });
}

const selfAmbientWorkerPort = parentPort;
if (!isMainThread && selfAmbientWorkerPort && workerData?.kind === 'self-ambient') {
  selfAmbientWorkerPort.on('message', ({ stateRoot, selectedRoot }: { stateRoot?: string; selectedRoot: string }) => {
    try {
      if (stateRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = stateRoot;
      setElanousConfigDir(selectedRoot);
      selfAmbientWorkerPort.postMessage({ parts: elanousSelfAmbientBaseParts() });
    } catch (error) { selfAmbientWorkerPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
