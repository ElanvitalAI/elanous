// Shared wake ledger — any waker, one 20-min window per seat. Expected values are literals.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimSeatWake, recentSeatWakes } from './wake-ledger.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const db = (): string => { const d = mkdtempSync(join(tmpdir(), 'wake-ledger-')); dirs.push(d); return join(d, 'wake.sqlite'); };
const T0 = new Date(2026, 10, 25, 14, 21, 0).getTime();

test('two wakers within 20 min: the first wins, the second is told who and when; after 20 min a new wake is allowed', () => {
  const path = db();
  expect(claimSeatWake(path, { seat: 'tc-h-cx-6', by: 'steward:TC', cell: 'CELL-X', atMs: T0 })).toEqual({ ok: true });
  const second = claimSeatWake(path, { seat: 'TC-H-CX-6', by: 'idle-nudge', atMs: T0 + 5 * 60_000 });
  expect(second).toEqual({ ok: false, prior: { seat: 'TC-H-CX-6', by: 'steward:TC', cell: 'CELL-X', atMs: T0 }, line: 'already woken by steward:TC at 14:21 (CELL-X)' });
  // Another seat is independent.
  expect(claimSeatWake(path, { seat: 'TC-H-CX-3', by: 'coach', atMs: T0 + 5 * 60_000 }).ok).toBe(true);
  expect(claimSeatWake(path, { seat: 'TC-H-CX-6', by: 'OP', atMs: T0 + 20 * 60_000 }).ok).toBe(true);
  expect(Object.keys(recentSeatWakes(path, T0 + 21 * 60_000)).sort()).toEqual(['TC-H-CX-3', 'TC-H-CX-6']);
  expect(recentSeatWakes(path, T0 + 21 * 60_000)['TC-H-CX-6']?.by).toBe('OP');
});

test('RAIL30 ⑤ two unanswered wakes for one cell → refused with one raise, then quiet · activity resets the count · another cell is a new cause', () => {
  const path = db();
  const W = 20 * 60_000;
  const idleSince = T0 - 60 * 60_000;
  expect(claimSeatWake(path, { seat: 'TC-H-CX-6', by: 'steward:TC', cell: 'CELL-9', atMs: T0, lastActivityMs: idleSince })).toEqual({ ok: true });
  expect(claimSeatWake(path, { seat: 'TC-H-CX-6', by: 'OP', cell: 'CELL-9', atMs: T0 + W, lastActivityMs: idleSince })).toEqual({ ok: true });
  const third = claimSeatWake(path, { seat: 'TC-H-CX-6', by: 'steward:TC', cell: 'CELL-9', atMs: T0 + 2 * W, lastActivityMs: idleSince });
  expect(third).toEqual({ ok: false, prior: { seat: 'TC-H-CX-6', by: 'OP', cell: 'CELL-9', atMs: T0 + W },
    line: 'TC-H-CX-6 did not answer 2 wakes for CELL-9 (last by OP at 14:41) — not waking again; raise one ✋/exception card instead', unanswered: { count: 2, raise: true } });
  const fourth = claimSeatWake(path, { seat: 'TC-H-CX-6', by: 'steward:TC', cell: 'CELL-9', atMs: T0 + 3 * W, lastActivityMs: idleSince });
  expect(fourth.ok === false && fourth.unanswered).toEqual({ count: 2, raise: false });
  // The hand ran a turn: the next wake is allowed and counts from 1 again.
  expect(claimSeatWake(path, { seat: 'TC-H-CX-6', by: 'steward:TC', cell: 'CELL-9', atMs: T0 + 4 * W, lastActivityMs: T0 + 3 * W + 60_000 })).toEqual({ ok: true });
  expect(claimSeatWake(path, { seat: 'TC-H-CX-6', by: 'steward:TC', cell: 'CELL-9', atMs: T0 + 5 * W, lastActivityMs: T0 + 3 * W + 60_000 })).toEqual({ ok: true });
  // A different cause is a fresh count; unknown activity never counts as unanswered.
  expect(claimSeatWake(path, { seat: 'TC-H-CX-6', by: 'steward:TC', cell: 'CELL-10', atMs: T0 + 6 * W, lastActivityMs: idleSince })).toEqual({ ok: true });
  expect(claimSeatWake(path, { seat: 'TC-H-CX-3', by: 'coach', atMs: T0 })).toEqual({ ok: true });
  expect(claimSeatWake(path, { seat: 'TC-H-CX-3', by: 'coach', atMs: T0 + W })).toEqual({ ok: true });
  expect(claimSeatWake(path, { seat: 'TC-H-CX-3', by: 'coach', atMs: T0 + 2 * W })).toEqual({ ok: true });
});
