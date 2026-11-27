import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_STALL_AFTER_MINUTES,
  createSeatStallClaimStore,
  findStalledSeats,
  lastSeatRecordMs,
  runSeatStallWatch,
  seatStallIncidentId,
  type SeatRecordSnapshot,
} from './seat-stall-watch.js';

// Source: house DECISIONS.md row format is `- YYYY-MM-DD HH:MM KST` (KST = UTC+09:00).
const KST_OFFSET_MS = 9 * 60 * 60_000;
// Source: sample row 08:41 KST on 2026-11-19 normalizes to this UTC instant (Date.UTC months are zero-based, so November is 10).
const LAST_ENTRY_MS = Date.UTC(2026, 10, 19, 8, 41) - KST_OFFSET_MS;
// Source: sample later row 09:05 KST on the same day proves the latest entry wins.
const LATER_ENTRY_MS = Date.UTC(2026, 10, 19, 9, 5) - KST_OFFSET_MS;

describe('lastSeatRecordMs', () => {
  test('parses a KST row into epoch milliseconds', () => {
    const text = '# OP-SHADOW\n- 2026-11-19 08:41 KST 세부 판단\n';
    expect(lastSeatRecordMs(text)).toBe(LAST_ENTRY_MS);
  });

  test('accepts the Z form of the same instant', () => {
    // Source: 08:41 KST is 2026-11-18T23:41Z (nine hours behind KST).
    const text = '- 2026-11-18T23:41:00Z fallback';
    expect(lastSeatRecordMs(text)).toBe(LAST_ENTRY_MS);
  });

  test('picks the latest of several entries', () => {
    const text = '- 2026-11-19 08:41 KST 첫 판단\n- 2026-11-19 09:05 KST 다음 판단\n';
    expect(lastSeatRecordMs(text)).toBe(LATER_ENTRY_MS);
  });

  test('returns undefined for text without a valid entry (fail-closed)', () => {
    expect(lastSeatRecordMs('# 빈 문서\n일반 문단만 있습니다')).toBeUndefined();
    // Source: a timestamp without the leading `- ` row marker is not a DECISIONS entry.
    expect(lastSeatRecordMs('2026-11-19 08:41 KST 행 아님')).toBeUndefined();
    // Source: a row without an explicit zone cannot be normalized, so it is rejected.
    expect(lastSeatRecordMs('- 2026-11-19 08:41 존 없음')).toBeUndefined();
  });
});

describe('findStalledSeats', () => {
  const snapshot: SeatRecordSnapshot = { seatId: 'OP-SHADOW', decisionsText: '- 2026-11-19 08:41 KST 세부' };

  test('stays silent under the default threshold', () => {
    // Source: 29 minutes stays under the 30-minute default threshold.
    const nowUnder = LAST_ENTRY_MS + 29 * 60_000;
    expect(findStalledSeats([snapshot], nowUnder)).toEqual([]);
  });

  test('flags a stall at and past the threshold with whole minutes', () => {
    // Source: exactly 30 minutes meets the default threshold.
    const nowAt = LAST_ENTRY_MS + 30 * 60_000;
    expect(findStalledSeats([snapshot], nowAt)).toEqual([
      { seatId: 'OP-SHADOW', lastEntryAtMs: LAST_ENTRY_MS, stalledMinutes: DEFAULT_STALL_AFTER_MINUTES },
    ]);
    // Source: 31 minutes past the last entry reports 31 whole stalled minutes.
    const nowPast = LAST_ENTRY_MS + 31 * 60_000;
    expect(findStalledSeats([snapshot], nowPast)).toEqual([
      { seatId: 'OP-SHADOW', lastEntryAtMs: LAST_ENTRY_MS, stalledMinutes: 31 },
    ]);
  });

  test('fail-closed on invalid now or threshold', () => {
    expect(findStalledSeats([snapshot], Number.NaN)).toEqual([]);
    // Source: a non-positive threshold cannot prove a stall.
    expect(findStalledSeats([snapshot], LAST_ENTRY_MS + 60 * 60_000, 0)).toEqual([]);
  });
});

describe('runSeatStallWatch', () => {
  test('raises one 🔴 OP mail per stall and the same stall alarms once', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'seat-stall-watch-'));
    const snapshot: SeatRecordSnapshot = { seatId: 'OP-SHADOW', decisionsText: '- 2026-11-19 08:41 KST 세부' };
    // Source: 31 minutes past the last entry proves a stall past the 30-minute default.
    const stalledNow = LAST_ENTRY_MS + 31 * 60_000;
    const first = await runSeatStallWatch([snapshot], stalledNow, createSeatStallClaimStore(storeRoot));
    expect(first).toHaveLength(1);
    expect(first[0]!.mail.to).toBe('OP');
    expect(first[0]!.mail.subject).toContain('🔴');
    expect(first[0]!.incidentId).toBe(seatStallIncidentId('OP-SHADOW', LAST_ENTRY_MS));
    // Source: the same stall — same last entry — must alarm exactly once.
    const stalledLater = LAST_ENTRY_MS + 45 * 60_000;
    const second = await runSeatStallWatch([snapshot], stalledLater, createSeatStallClaimStore(storeRoot));
    expect(second).toEqual([]);
  });

  test('a new entry opens a new stall window that alarms again', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'seat-stall-watch-'));
    // Source: after a fresh 09:05 KST entry, a later tick 31 minutes past it is a new stall window.
    const refreshed: SeatRecordSnapshot = {
      seatId: 'OP-SHADOW',
      decisionsText: '- 2026-11-19 08:41 KST 세부\n- 2026-11-19 09:05 KST 다음 판단\n',
    };
    const refreshedNow = LATER_ENTRY_MS + 31 * 60_000;
    const alarms = await runSeatStallWatch([refreshed], refreshedNow, createSeatStallClaimStore(storeRoot));
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.incidentId).toBe(seatStallIncidentId('OP-SHADOW', LATER_ENTRY_MS));
  });
});
