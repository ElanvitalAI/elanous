/** Seat inbox heartbeat classification; see SEAT-INBOX-PROTOCOL.md §2b. */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type InboxLiveness =
  | { state: 'live' | 'stale' | 'down'; ageMs: number }
  | { state: 'unknown'; reason: 'invalid-beat' | 'identity-mismatch' | 'future-beat' };

export function inboxLiveness(beat: unknown, identity: { host: string; sessionId?: string }, now: number): InboxLiveness {
  if (!beat || typeof beat !== 'object' || !Number.isFinite(now)) return { state: 'unknown', reason: 'invalid-beat' };
  const row = beat as Record<string, unknown>;
  if (!Number.isSafeInteger(row.pid) || (row.pid as number) <= 0 || typeof row.host !== 'string' || !row.host
    || typeof row.sessionId !== 'string' || !row.sessionId || typeof row.startedAt !== 'string' || typeof row.beatAt !== 'string') {
    return { state: 'unknown', reason: 'invalid-beat' };
  }
  const start = Date.parse(row.startedAt);
  const time = Date.parse(row.beatAt);
  if (!Number.isFinite(start) || !Number.isFinite(time) || start > time) return { state: 'unknown', reason: 'invalid-beat' };
  if (row.host !== identity.host || (identity.sessionId !== undefined && row.sessionId !== identity.sessionId)) {
    return { state: 'unknown', reason: 'identity-mismatch' };
  }
  const ageMs = now - time;
  if (ageMs < 0) return { state: 'unknown', reason: 'future-beat' };
  // 출처: SEAT-INBOX-PROTOCOL.md §2b — 90 seconds live, 10 minutes stale.
  return { state: ageMs <= 90_000 ? 'live' : ageMs <= 600_000 ? 'stale' : 'down', ageMs };
}

/** §2b: 판정은 beatAt 시각으로만 — 파일 없음 = down (unclean 종료 잔존 파일도 beatAt 기준). */
export function seatInboxAlivePath(seatStateRoot: string, seat: string): string {
  return join(seatStateRoot, seat.trim().toUpperCase().replace(/^SEAT:/, ''), 'inbox.alive');
}

export function classifySeatInbox(path: string, identity: { host: string; sessionId?: string }, now: number): InboxLiveness {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch { return { state: 'down', ageMs: Number.POSITIVE_INFINITY }; } // ENOENT 등 → §2b 파일 없음 = down
  try { return inboxLiveness(JSON.parse(raw), identity, now); }
  catch { return { state: 'unknown', reason: 'invalid-beat' }; }
}

/** 원자적 쓰기: 임시파일 + rename (독자가 부분 쓰기를 못 본다). */
export function writeInboxBeatAtomic(path: string, beat: Record<string, unknown>, writeFileSyncImpl: typeof writeFileSync = writeFileSync, renameImpl: typeof renameSync = renameSync): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSyncImpl(tmp, JSON.stringify(beat) + '\n', 'utf8');
  renameImpl(tmp, path);
}

export interface InboxHeartbeatHandle { stop(): void }

/** §2b 박동 발사기 — 30초 간격. 스케줄러 주입으로 가짜 클럭 시험 가능. */
export function startInboxHeartbeat(path: string, identity: { pid: number; host: string; sessionId: string }, opts: {
  intervalMs?: number; now?: () => number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  cancel?: (t: ReturnType<typeof setInterval>) => void;
  write?: typeof writeInboxBeatAtomic;
  /** OP #93799 — 세션 id 지연 공급원. 세션이 박동 시작 후에 확정되는 자리(TUI)를 위해 매 박동마다 재평가된다. */
  getSessionId?: () => (string | null);
  /** OP #93799 — 세션 id 부재로 박동을 건너뛸 때 이유 기록(빈 id 박동 = invalid-beat 판정의 원인이므로 쓰지 않는다). */
  log?: (event: string, data?: Record<string, unknown>) => void;
} = {}): InboxHeartbeatHandle {
  const intervalMs = opts.intervalMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const schedule = opts.schedule ?? ((fn, ms) => { const t = setInterval(fn, ms); (t as unknown as { unref(): void }).unref?.(); return t; });
  const cancel = opts.cancel ?? clearInterval;
  const startedAt = new Date(now()).toISOString();
  let skipLogged = false; // 상태 전이 시 1회만 기록 — 매 박동 로그 스팸 방지
  const beat = () => {
    const sessionId = (opts.getSessionId ? (opts.getSessionId() ?? '') : identity.sessionId).trim();
    if (!sessionId) {
      if (!skipLogged) {
        skipLogged = true;
        opts.log?.('heartbeat-skipped-no-session-id', { reason: 'no-session-id', path, host: identity.host });
      }
      return; // 빈 id 박동을 쓰면 판정자가 invalid-beat 로 분류한다 — 쓰지 않는다(OP #93799).
    }
    skipLogged = false;
    const payload = { pid: identity.pid, host: identity.host, sessionId, startedAt, beatAt: new Date(now()).toISOString() };
    if (opts.write) opts.write(path, payload);
    else writeInboxBeatAtomic(path, payload);
  };
  beat(); // 즉시 1회 — 최초 판정이 down이 되지 않게
  const timer = schedule(beat, intervalMs);
  return { stop: () => cancel(timer) };
}
