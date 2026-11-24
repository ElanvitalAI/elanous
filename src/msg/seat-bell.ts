// SEAT-MESSAGE-BUS 1단계 — 자리 초인종(doorbell). 설계: seat-state/OP/orders/SEAT-MESSAGE-BUS-1124.md «개정»(안 C).
// 우편 원장 쓰기가 받는 자리의 안 읽은 집합을 바꾸면, 커밋 직후 `<원장 폴더>/inbox/<SEAT>.bell` 을 원자적으로 덮어쓴다
// (한 줄 `{at, lastMsgId}`). 받는 프로세스는 이 폴더를 OS 파일 감시(kqueue · inotify)로 듣고 원장을 다시 읽는다.
// 초인종은 알림일 뿐 — 본문·라우팅·영수는 원장이 정본이다. 데몬 없음 · 절대 쓰기 경로를 깨지 않는다(fail-soft 전면).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';

/** Broadcast mail rings this one bell; every seat watcher also listens to it. */
export const ALL_SEAT_BELL = 'ALL';

const BELL_NAME = /^[A-Z][A-Z0-9_-]{0,63}$/;

/** The bell folder for one ledger path — beside the ledger, so every universe (test · ops · --config-dir) has its own. */
export function seatBellDir(dbPath: string): string { return join(dirname(dbPath), 'inbox'); }

export function seatBellFile(seat: string): string { return `${seat}.bell`; }

export function seatBellPath(dbPath: string, seat: string): string { return join(seatBellDir(dbPath), seatBellFile(seat)); }

export interface SeatBellStamp { readonly at: string; readonly lastMsgId: number }

/** Atomic ring: tmp write + rename, one JSON line. Never throws — the ledger write is the fact, the bell a courtesy. */
export function ringSeatBell(dbPath: string, seat: string, lastMsgId: number): boolean {
  if (dbPath === ':memory:' || !BELL_NAME.test(seat)) return false;
  const path = seatBellPath(dbPath, seat);
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ at: new Date().toISOString(), lastMsgId })}\n`);
    renameSync(tmp, path);
    try { debug.log('msg.bell', 'rung', { seat, lastMsgId }, { level: 'debug' }); } catch { /* observability is fail-open */ }
    return true;
  } catch (error) {
    try { debug.log('msg.bell', 'ring-failed', { seat, lastMsgId, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
    catch { /* observability is fail-open */ }
    return false;
  }
}

/** The last ring, or null (never rung · unreadable · torn). */
export function readSeatBell(path: string): SeatBellStamp | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    if (typeof row.at !== 'string' || typeof row.lastMsgId !== 'number' || !Number.isSafeInteger(row.lastMsgId)) return null;
    return { at: row.at, lastMsgId: row.lastMsgId };
  } catch { return null; }
}
