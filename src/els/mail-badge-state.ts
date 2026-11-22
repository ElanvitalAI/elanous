// OP P0 2단계 ELS-SERVER-EVENT-HUB-NO-DB-POLL — badge state on the event hub.
// 자리 배지 상태는 메모리가 정본이다: 목록(주기 폴 포함)은 메모리만 즉답하고, 재계산은 원장 옆 이벤트 파일의
// 완전한 새 줄이 올 때만 — 주기 DB 조회 0(OP #127482 ①).
// JUD-B #132880 mustFix ① — 이벤트 구동 갱신도 오프스레드: compute 는 base #39546 의 MailBadgeCompute
// (Worker 기본 — readUnreadMailBadges 를 서버 스레드 밖에서)이고, badges()/이벤트 구독은 스케줄만 잡는다.
// 첫 정착 전 좌석의 배지는 null(=«모름», 결코 «0» 아님) — base 캐시와 같은 계약.
// judb-39675-864417dcf533 ① — 유실 회복은 주기 타이머가 아니다: 허브의 유실 마커(<ledger>.events.lost) 사건이
// 재동기를 일으킨다(주기 원장 조회 0 유지). ② 계산 중에 온 이벤트는 dirty 로 보존돼 완료 직후 후속 계산으로 반영된다.
import type { UnreadMailBadge } from '../msg/msg-store.js';
import type { MailEventHub } from './mail-event-hub.js';
import { workerCompute, type MailBadgeCompute } from './mail-badge-cache.js';

/** At most one recompute start per this window (base cache contract; 0 in tests for immediate scheduling). */
const MIN_INTERVAL_MS = 2_000;

export interface MailBadgeState {
  /** Memory-first and at once: unknown seats read as null (never «0»); the compute is only *scheduled*. */
  badges(seats: readonly string[]): ReadonlyMap<string, UnreadMailBadge | null>;
  /** Subscribe to a hub: every sidecar event schedules one off-thread recompute of every known seat. */
  attach(hub: MailEventHub): () => void;
  /** Resolves once no recompute is scheduled or in flight (tests). */
  settled(): Promise<void>;
  /** Test observability: how many recomputes ran (the expensive path — always off the request stack). */
  readonly computes: () => number;
  /** Frees the pending timer and the injected/default compute worker. */
  dispose(): void;
}

export function createMailBadgeState(deps: {
  dbPath: string;
  /** Off-thread by default (base #39546 worker). Tests inject a MailBadgeCompute double. */
  compute?: MailBadgeCompute;
  /** Recompute start cadence; default MIN_INTERVAL_MS (0 in tests). */
  minIntervalMs?: number;
  log?: (line: string) => void;
}): MailBadgeState {
  const dbPath = deps.dbPath;
  const compute: MailBadgeCompute = deps.compute ?? workerCompute();
  {
    const minIntervalMs = Math.max(0, deps.minIntervalMs ?? MIN_INTERVAL_MS);
    const log = deps.log ?? (() => {});
    const memory = new Map<string, UnreadMailBadge | null>();
    let computes = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight: Promise<void> | null = null;
    let dirty = false;          // judb-39675 ② — an event arriving mid-compute is kept, not dropped
    let lastStart = Number.NEGATIVE_INFINITY;
    let disposed = false;

    const run = (): void => {
      timer = null;
      if (disposed || memory.size === 0) return;
      const elapsed = Date.now() - lastStart;
      if (elapsed < minIntervalMs) { timer = setTimeout(run, minIntervalMs - elapsed); timer.unref?.(); return; }
      lastStart = Date.now();
      computes += 1;
      inflight = (async (): Promise<void> => {
        try {
          const answer = await compute({ path: dbPath, seats: [...memory.keys()], force: true });
          if (!disposed && answer.ok && answer.changed) for (const [seat, badge] of answer.badges) memory.set(seat, badge);
        } catch (error) { log(`mail-badge-state: recompute failed: ${error instanceof Error ? error.message : String(error)}`); }
        finally {
          inflight = null;
          if (dirty) { dirty = false; schedule(); }   // judb-39675 ② — the kept event gets its follow-up compute at once
        }
      })();
    };

    const schedule = (): void => {
      if (disposed) return;
      if (inflight !== null) { dirty = true; return; }   // judb-39675 ② — mid-compute events are kept for the follow-up
      if (timer !== null) return;
      timer = setTimeout(run, 0);   // next macrotask — never the request stack
      timer.unref?.();
    };

    const state: MailBadgeState = {
      badges(seats: readonly string[]): ReadonlyMap<string, UnreadMailBadge | null> {
        const missing = [...new Set(seats.filter((seat) => !memory.has(seat)))];
        if (missing.length > 0) { for (const seat of missing) memory.set(seat, null); schedule(); }  // first-seen: baseline, off-thread
        const out = new Map<string, UnreadMailBadge | null>();
        for (const seat of seats) out.set(seat, memory.get(seat) ?? null);
        return out;
      },
      attach(hub: MailEventHub): () => void {
        return hub.subscribe(() => { schedule(); });   // sidecar event ⇒ one off-thread recompute of every known seat
      },
      settled(): Promise<void> {
        const wait = (): Promise<void> => inflight === null && timer === null
          ? Promise.resolve()
          : new Promise((resolve) => setTimeout((): void => { wait().then(resolve); }, 1));
        return wait();
      },
      computes: () => computes,
      dispose(): void {
        disposed = true;
        if (timer !== null) clearTimeout(timer);
        try { compute.dispose?.(); } catch { /* best-effort */ }
      },
    };
    return state;
  }
}
