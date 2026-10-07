import type { DaemonClient } from '@/lib/daemon-client';
import { subscribeSharedEventSource } from '@/lib/shared-event-source';

/**
 * LOOP-INTERACT D — 루프 지도 «실시간».
 *
 * 새 스트림을 만들지 않는다. 기존 `GET /v1/logs/stream`(SSE)을 «다시 읽기 신호»로만 쓴다 —
 * 간선 원천을 쓰는 쪽(조율 넘김 · TASK-AGENT · 하니스 대기열 · Pod 발사)의 로그 범주가 한 줄이라도 오면
 * 간선 조회를 디바운스해 한 번 다시 읽는다. 프레임 «내용»은 읽지 않는다(간선의 진실은 `/v1/loops/edges`).
 *
 * SSE 를 못 열었거나 끊기면(`onerror`) 5초 폴링으로 떨어진다. 그 뒤 로그 프레임이 다시 오면(브라우저 재연결)
 * 폴링을 멈추고 신호 모드로 돌아간다. 스트림 모드에서도 30초마다 한 번은 다시 읽는다(안전망).
 */

/** 간선 원천을 쓰는 로그 범주(접두 일치 · `category=` 는 서버가 `LIKE '<값>%'` 로 본다). */
export const LOOP_EDGE_TRIGGER_CATEGORIES = ['loop.', 'task-agent', 'harness.queue', 'self-implement.pod'] as const;
export const LOOP_REFRESH_DEBOUNCE_MS = 800;
export const LOOP_REFRESH_POLL_MS = 5_000;
/** 스트림이 살아 있어도 이 주기로 한 번 — 로그를 안 남기는 원천(런 원장 등)과 루프 판정 칸이 늙지 않게. */
export const LOOP_REFRESH_SAFETY_MS = 30_000;

export type LoopRefreshMode = 'stream' | 'poll';

export interface LoopRefreshTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

const DEFAULT_TIMERS: LoopRefreshTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

export function loopEdgeTriggerUrl(client: Pick<DaemonClient, 'logsStreamUrl'>): string | null {
  return client.logsStreamUrl({ category: LOOP_EDGE_TRIGGER_CATEGORIES.join(',') });
}

/**
 * 간선 다시 읽기 구독. `refresh` 는 디바운스된 뒤 불린다(폴링 모드에선 5초마다).
 * @returns 해제 함수 — 타이머·SSE 구독을 모두 걷는다(두 번 불려도 안전).
 */
export function subscribeLoopEdgeRefresh(
  client: Pick<DaemonClient, 'logsStreamUrl'>,
  refresh: () => void,
  opts: { debounceMs?: number; pollMs?: number; safetyMs?: number; timers?: LoopRefreshTimers; onMode?: (mode: LoopRefreshMode) => void } = {},
): () => void {
  const timers = opts.timers ?? DEFAULT_TIMERS;
  const debounceMs = opts.debounceMs ?? LOOP_REFRESH_DEBOUNCE_MS;
  const pollMs = opts.pollMs ?? LOOP_REFRESH_POLL_MS;
  let disposed = false;
  let debounce: unknown = null;
  let poll: unknown = null;
  const safety = timers.setInterval(() => { if (!disposed && poll === null) refresh(); }, opts.safetyMs ?? LOOP_REFRESH_SAFETY_MS);

  const startPolling = () => {
    if (disposed || poll !== null) return;
    poll = timers.setInterval(() => { if (!disposed) refresh(); }, pollMs);
    opts.onMode?.('poll');
  };
  const stopPolling = () => {
    if (poll === null) return;
    timers.clearInterval(poll);
    poll = null;
    opts.onMode?.('stream');
  };
  const trigger = () => {
    if (disposed) return;
    // 프레임이 왔다 = 스트림이 산다 — 폴링 중이었다면 신호 모드로 돌아간다.
    stopPolling();
    if (debounce !== null) timers.clearTimeout(debounce);
    debounce = timers.setTimeout(() => { debounce = null; if (!disposed) refresh(); }, debounceMs);
  };

  const url = loopEdgeTriggerUrl(client);
  let unsubscribe: () => void = () => {};
  if (url === null) startPolling();
  else {
    let constructFailed = false;
    unsubscribe = subscribeSharedEventSource(url, {
      events: { log: trigger },
      onError: startPolling,
      onConstructError: () => { constructFailed = true; },
    });
    if (constructFailed) startPolling();
    else opts.onMode?.('stream');
  }

  return () => {
    if (disposed) return;
    disposed = true;
    if (debounce !== null) timers.clearTimeout(debounce);
    if (poll !== null) timers.clearInterval(poll);
    timers.clearInterval(safety);
    debounce = null;
    poll = null;
    unsubscribe();
  };
}
