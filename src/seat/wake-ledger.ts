// SHARED-WAKE-LEDGER (11-25 17:3x · H1 duplicate hand wakes 0.3 → 5.7/h, 11.3/h with the steward wake) — one ledger for
// every waker (행정관 · `eln seat assign` · idle-nudge · coach): a seat woken by ANY source in the last 20 min is not woken
// again; the caller prints «already woken by X at HH:MM». One SQLite upsert under the write lock decides it, so two
// wakers racing for the same seat cannot both win (the same shape as msg-wake claimWake).
//
// RAIL30 ⑤ (verify-3u H1 «dead-hand wakes remain») — the row also remembers how many wakes in a row went to the same cause
// with no turn/activity after them; at 2 the waker stops and raises ONE ✋/exception card instead of waking again.
//
// 세 얼굴: 관측 = the `seat_wakes` row (seat · by · cell · at · cause_count · raised) ⊕ the skip line · 판단 근거 = one window, any source ·
//          수복과 인계 = a skipped wake is the normal case; scripts use `eln seat wake-claim` (exit 5 = already woken).

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';

export const SHARED_WAKE_WINDOW_MS = 20 * 60_000;

export interface SeatWakeRow { readonly seat: string; readonly by: string; readonly cell: string; readonly atMs: number }
/**
 * `unanswered` (RAIL30 ⑤) — the seat did not answer {@link UNANSWERED_WAKE_LIMIT} wakes for this cause: the waker stops
 * and raises ONE ✋/exception card instead (`raise` true exactly once per unanswered run; later claims are refused quietly).
 */
export type SeatWakeClaim =
  | { readonly ok: true }
  | { readonly ok: false; readonly prior: SeatWakeRow; readonly line: string; readonly unanswered?: { readonly count: number; readonly raise: boolean } };

/** RAIL30 ⑤ — wakes for the same cause with no turn/activity after which the waker stops and raises one card. */
export const UNANSWERED_WAKE_LIMIT = 2;

export const defaultWakeLedgerPath = (): string => join(effectiveInstanceRoot(), 'steward', 'wake-ledger.sqlite');

function open(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec('CREATE TABLE IF NOT EXISTS seat_wakes (seat TEXT PRIMARY KEY, at INTEGER NOT NULL, by TEXT NOT NULL, cell TEXT NOT NULL)');
  const cols = new Set((db.query("SELECT name FROM pragma_table_info('seat_wakes')").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('cause_count')) db.exec('ALTER TABLE seat_wakes ADD COLUMN cause_count INTEGER NOT NULL DEFAULT 1');
  if (!cols.has('raised')) db.exec('ALTER TABLE seat_wakes ADD COLUMN raised INTEGER NOT NULL DEFAULT 0');
  return db;
}

const hhmm = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export const alreadyWokenLine = (row: SeatWakeRow): string => `already woken by ${row.by} at ${hhmm(row.atMs)}${row.cell && row.cell !== '-' ? ` (${row.cell})` : ''}`;
export const unansweredWakeLine = (row: SeatWakeRow, count: number): string =>
  `${row.seat} did not answer ${count} wakes${row.cell && row.cell !== '-' ? ` for ${row.cell}` : ''} (last by ${row.by} at ${hhmm(row.atMs)}) — not waking again; raise one ✋/exception card instead`;

/**
 * Claim the 20-min wake window for `seat`. Lost = someone (any source) woke it inside the window.
 * RAIL30 ⑤ — `lastActivityMs` (the seat's latest turn/model activity · null = none known · undefined = cannot tell): a
 * wake for the same cause as the stored one with no activity since it counts as unanswered; at
 * {@link UNANSWERED_WAKE_LIMIT} the claim is refused with `unanswered` (raise once) until the seat shows activity.
 */
export function claimSeatWake(path: string, input: { seat: string; by: string; cell?: string; atMs: number; windowMs?: number; lastActivityMs?: number | null }): SeatWakeClaim {
  const seat = input.seat.trim().toUpperCase();
  const cell = input.cell ?? '-';
  const windowMs = input.windowMs ?? SHARED_WAKE_WINDOW_MS;
  const db = open(path);
  try {
    return db.transaction((): SeatWakeClaim => {
      const row = db.query('SELECT seat, at, by, cell, cause_count, raised FROM seat_wakes WHERE seat = ?1').get(seat) as
        { seat: string; at: number; by: string; cell: string; cause_count: number; raised: number } | null;
      const prior: SeatWakeRow | null = row ? { seat: row.seat, atMs: row.at, by: row.by, cell: row.cell } : null;
      // The 20-min window is first (a wake inside it is the normal skip).
      if (prior && row!.at > input.atMs - windowMs) return { ok: false, prior, line: alreadyWokenLine(prior) };
      const known = input.lastActivityMs !== undefined;
      const silentSince = known && prior !== null && (input.lastActivityMs ?? 0) <= prior.atMs;
      const sameCause = prior !== null && prior.cell === cell;
      const unanswered = sameCause && silentSince ? row!.cause_count : 0;
      if (prior && unanswered >= UNANSWERED_WAKE_LIMIT) {
        const raise = row!.raised === 0;
        if (raise) db.query('UPDATE seat_wakes SET raised = 1 WHERE seat = ?1').run(seat);
        return { ok: false, prior, line: unansweredWakeLine(prior, unanswered), unanswered: { count: unanswered, raise } };
      }
      db.query(`INSERT INTO seat_wakes (seat, at, by, cell, cause_count, raised) VALUES (?1, ?2, ?3, ?4, ?5, 0)
        ON CONFLICT(seat) DO UPDATE SET at = excluded.at, by = excluded.by, cell = excluded.cell, cause_count = excluded.cause_count, raised = 0`)
        .run(seat, input.atMs, input.by, cell, unanswered + 1);
      return { ok: true };
    }).immediate();
  } finally { db.close(); }
}

/** Wakes inside the window (seat → row) — read-only view for the steward snapshot. */
export function recentSeatWakes(path: string, nowMs: number, windowMs = SHARED_WAKE_WINDOW_MS): Record<string, SeatWakeRow> {
  const db = open(path);
  try {
    const rows = db.query('SELECT seat, at, by, cell FROM seat_wakes WHERE at > ?1').all(nowMs - windowMs) as { seat: string; at: number; by: string; cell: string }[];
    return Object.fromEntries(rows.map((r) => [r.seat, { seat: r.seat, atMs: r.at, by: r.by, cell: r.cell }]));
  } finally { db.close(); }
}
