import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAIL_COVERAGE_GAP_THRESHOLD,
  DEFAULT_MAIL_COVERAGE_WINDOW_MINUTES,
  createMailCoverageClaimStore,
  findUnjudgedMail,
  isMailJudged,
  mailNoJudgmentIncidentId,
  parseLedgerCreatedAtMs,
  parseMailCoverageGraphContext,
  runOpMailCoverageWatch,
  type SeatMailCoverageSeat,
  type SeatMailScan,
} from './op-mail-coverage-watch.js';

// Source: sample received mail #95521 (CARD-A 대표 승인 사건) landed 2026-11-19 09:52 KST = 00:52 UTC.
const MAIL_95521_MS = Date.UTC(2026, 10, 19, 0, 52);  // 출처: #38979
// Source: sample received mail #96073 (the matched #38904 pair) landed 2026-11-19 10:26 KST = 01:26 UTC.
const MAIL_96073_MS = Date.UTC(2026, 10, 19, 1, 26);  // 출처: #38979
// Source: the tick observes at 2026-11-19 11:00 KST = 02:00 UTC.
const NOW_MS = Date.UTC(2026, 10, 19, 2, 0);  // 출처: #38979
// Source: the default window is 360 minutes, so 360 minutes before the tick is the oldest in-window mail.
const WINDOW_EDGE_MS = NOW_MS - DEFAULT_MAIL_COVERAGE_WINDOW_MINUTES * 60_000;  // 출처: #38979

const mailOf = (id: number, createdAtMs: number) => ({ id, createdAtMs });
const scanOf = (messages: ReadonlyArray<{ id: number; createdAtMs: number }>, truncated = false): SeatMailScan =>
  ({ messages, truncated });

describe('isMailJudged', () => {
  test('matches a `#<id>` reference in a judgment row', () => {
    const text = '- 2026-11-19 09:26 KST #95052 — 판단 행';  // 출처: #38979
    expect(isMailJudged(text, 95052)).toBe(true);  // 출처: #38979
    // Source: the OP row form `OP#94818` carries the same `#<id>` reference.
    expect(isMailJudged('- 09:08 OP#94818 — 결정', 94818)).toBe(true);  // 출처: #38979
  });

  test('a longer judgment reference must not match a shorter mail id', () => {
    // Source: #95052 in the ledger is a different mail than #9505, so the digit lookahead must reject it.
    expect(isMailJudged('- 09:26 #95052 — 판단 행', 9505)).toBe(false);  // 출처: #38979
    expect(isMailJudged('- 09:26 #95052 — 판단 행', 950522)).toBe(false);  // 출처: #38979
  });

  test('no reference means unjudged (fail-closed)', () => {
    expect(isMailJudged('- 09:26 KST 판단 행 (우편 언급 없음)', 95052)).toBe(false);  // 출처: #38979
    expect(isMailJudged('', 95052)).toBe(false);  // 출처: #38979
  });
});

describe('parseLedgerCreatedAtMs', () => {
  test('parses a Z-suffixed ledger timestamp', () => {
    expect(parseLedgerCreatedAtMs('2026-11-19T00:52:00Z')).toBe(MAIL_95521_MS);  // 출처: #38979
  });

  test('forces a zoneless ledger timestamp to UTC, never the host zone', () => {
    // Source: the ledger stores UTC, so a zoneless string must parse identically to its Z form.
    expect(parseLedgerCreatedAtMs('2026-11-19T00:52:00')).toBe(MAIL_95521_MS);  // 출처: #38979
  });

  test('returns undefined for unparseable values (fail-closed)', () => {
    expect(parseLedgerCreatedAtMs('not-a-timestamp')).toBeUndefined();
    expect(parseLedgerCreatedAtMs('')).toBeUndefined();
  });
});

describe('findUnjudgedMail', () => {
  test('reports an in-window unjudged mail as 주제 불일치 and keeps the window edge', () => {
    const gaps = findUnjudgedMail(scanOf([mailOf(95521, MAIL_95521_MS), mailOf(96073, MAIL_96073_MS)]),  // 출처: #38979
      '- 10:26 #96073 — 판단 행', NOW_MS);  // 출처: #38979
    expect(gaps).toEqual([{ mailId: 95521, reason: '주제 불일치' }]);  // 출처: #38979
    // Source: a mail created exactly 360 minutes before the tick is the oldest in-window row and must count.
    expect(findUnjudgedMail(scanOf([mailOf(95521, WINDOW_EDGE_MS)]), '', NOW_MS))  // 출처: #38979
      .toEqual([{ mailId: 95521, reason: '주제 불일치' }]);  // 출처: #38979
    // Source: one minute older than the 360-minute window is out of the window and must not count.
    expect(findUnjudgedMail(scanOf([mailOf(95521, WINDOW_EDGE_MS - 60_000)]), '', NOW_MS)).toEqual([]);  // 출처: #38979
  });

  test('appends one 미스캔 gap at the last scanned id when the scan truncated', () => {
    const gaps = findUnjudgedMail(scanOf([mailOf(95521, MAIL_95521_MS), mailOf(96073, MAIL_96073_MS)], true),  // 출처: #38979
      '', NOW_MS);
    expect(gaps).toEqual([
      { mailId: 95521, reason: '주제 불일치' },  // 출처: #38979
      { mailId: 96073, reason: '주제 불일치' },  // 출처: #38979
      // Source: the truncation point is the last scanned id, so the same bound dedupes to one record.
      { mailId: 96073, reason: '미스캔' },  // 출처: #38979
    ]);
  });

  test('fail-closed on invalid clock or window', () => {
    expect(findUnjudgedMail(scanOf([mailOf(95521, MAIL_95521_MS)]), '', Number.NaN)).toEqual([]);  // 출처: #38979
    // Source: a non-positive window cannot bound a coverage claim.
    expect(findUnjudgedMail(scanOf([mailOf(95521, MAIL_95521_MS)]), '', NOW_MS, 0)).toEqual([]);  // 출처: #38979
  });
});

describe('runOpMailCoverageWatch', () => {
  const seat: SeatMailCoverageSeat = { seatId: 'OP', decisionsText: '' };

  test('records one «판단 없음» row per gap and raises one 🔴 OP mail', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'op-mail-coverage-watch-'));
    const first = await runOpMailCoverageWatch([seat], NOW_MS, {
      store: createMailCoverageClaimStore(storeRoot),
      scanMail: () => scanOf([mailOf(95521, MAIL_95521_MS)]),  // 출처: #38979
    });
    expect(first).toHaveLength(1);  // 출처: #38979
    expect(first[0]!.mail.to).toBe('OP');  // 출처: #38979
    expect(first[0]!.mail.subject).toContain('🔴');  // 출처: #38979
    // Source: the default threshold is 1, so a single gap mail already raises the alarm.
    expect(first[0]!.gapCount).toBe(DEFAULT_MAIL_COVERAGE_GAP_THRESHOLD);  // 출처: #38979
    expect(first[0]!.records[0]!.note).toBe('#95521 판단 없음: 주제 불일치');  // 출처: #38979
    expect(first[0]!.records[0]!.incidentId).toBe(mailNoJudgmentIncidentId('OP', 95521, '주제 불일치'));  // 출처: #38979
    // Source: the same gap on a later tick already holds its record and stays silent.
    const second = await runOpMailCoverageWatch([seat], NOW_MS + 10 * 60_000, {  // 출처: #38979
      store: createMailCoverageClaimStore(storeRoot),
      scanMail: () => scanOf([mailOf(95521, MAIL_95521_MS)]),  // 출처: #38979
    });
    expect(second).toEqual([]);
  });

  test('a newly judged mail leaves no gap and a new unjudged mail alarms again', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'op-mail-coverage-watch-'));
    const judged: SeatMailCoverageSeat = { seatId: 'OP', decisionsText: '- 10:26 #96073 — 판단 행' };  // 출처: #38979
    const alarms = await runOpMailCoverageWatch([judged], NOW_MS, {
      store: createMailCoverageClaimStore(storeRoot),
      scanMail: () => scanOf([mailOf(96073, MAIL_96073_MS)]),  // 출처: #38979
    });
    expect(alarms).toEqual([]);
    // Source: #95521 stays unjudged while #96073 gained a judgment row, so exactly the new gap alarms.
    const later: SeatMailCoverageSeat = { seatId: 'OP', decisionsText: '- 10:26 #96073 — 판단 행' };  // 출처: #38979
    const next = await runOpMailCoverageWatch([later], NOW_MS, {
      store: createMailCoverageClaimStore(storeRoot),
      scanMail: () => scanOf([mailOf(95521, MAIL_95521_MS), mailOf(96073, MAIL_96073_MS)]),  // 출처: #38979
    });
    expect(next).toHaveLength(1);  // 출처: #38979
    expect(next[0]!.records.map((record) => record.note)).toEqual(['#95521 판단 없음: 주제 불일치']);  // 출처: #38979
  });

  test('a truncated scan surfaces the 미스캔 gap in the alarm', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'op-mail-coverage-watch-'));
    const alarms = await runOpMailCoverageWatch([seat], NOW_MS, {
      store: createMailCoverageClaimStore(storeRoot),
      scanMail: () => scanOf([mailOf(95521, MAIL_95521_MS)], true),  // 출처: #38979
    });
    expect(alarms).toHaveLength(1);  // 출처: #38979
    expect(alarms[0]!.gapCount).toBe(2);  // 출처: #38979
    expect(alarms[0]!.records.map((record) => record.note))  // 출처: #38979
      .toEqual(['#95521 판단 없음: 주제 불일치', '#95521 판단 없음: 미스캔']);  // 출처: #38979
    expect(alarms[0]!.records[1]!.incidentId).toBe(mailNoJudgmentIncidentId('OP', 95521, '미스캔'));  // 출처: #38979
  });

  test('a higher threshold records the gap without the OP mail', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'op-mail-coverage-watch-'));
    // Source: threshold 2 demands two gaps, so one recorded gap stays under the alarm line.
    const alarms = await runOpMailCoverageWatch([seat], NOW_MS, {
      store: createMailCoverageClaimStore(storeRoot),
      scanMail: () => scanOf([mailOf(95521, MAIL_95521_MS)]),  // 출처: #38979
      gapThreshold: 2,  // 출처: #38979
    });
    expect(alarms).toEqual([]);
    // Source: the record was still written, so the same gap with threshold 1 never alarms later.
    const after = await runOpMailCoverageWatch([seat], NOW_MS, {
      store: createMailCoverageClaimStore(storeRoot),
      scanMail: () => scanOf([mailOf(95521, MAIL_95521_MS)]),  // 출처: #38979
    });
    expect(after).toEqual([]);
  });
});

describe('parseMailCoverageGraphContext', () => {
  test('reads seats from graph context input', () => {
    const seats = parseMailCoverageGraphContext('{"input":{"seats":[{"seatId":"OP","decisionsText":"- 판단"}]}}');
    expect(seats).toEqual([{ seatId: 'OP', decisionsText: '- 판단' }]);
  });

  test('rejects malformed context (fail-closed)', () => {
    expect(parseMailCoverageGraphContext('not json')).toEqual([]);
    expect(parseMailCoverageGraphContext('{"input":{"seats":[{"seatId":"OP"}]}}')).toEqual([]);
  });
});
