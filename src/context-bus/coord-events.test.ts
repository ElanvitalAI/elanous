import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { openSurfaceEventsDb } from '../domains/surface-events.js';
import { listCoordEvents, mirrorCoordDecision, parseCoordHeader, recordCoordEvent } from './coord-events.js';

const at = '2026-10-02T02:00:00.000Z';

test('decision header mirrors one posthoc seat report on retry; report and unregistered seat do not mirror', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'coord-seat-decision-'));
  try {
    const ledger = new DecisionLedger({ stateDir, now: () => new Date(at), resolveVersion: () => ({ released: null, dev: null, codename: null }) });
    const url = 'https://github.com/o/r/issues/1#issuecomment-42';
    const input = { ...parseCoordHeader('OP', '**[OP]** 2026-10-02 11:00 KST → TC · 결정 · DEC-RECORD · 기한 12:40'), url, at };
    mirrorCoordDecision(input, { ledger });
    mirrorCoordDecision(input, { ledger });
    mirrorCoordDecision({ ...parseCoordHeader('OP', '**[OP]** 2026-10-02 11:00 KST → TC · 보고 · DEC-RECORD'), url, at }, { ledger });
    mirrorCoordDecision({ ...input, seat: 'E' }, { ledger });
    const [row] = ledger.seatReport();
    expect(row?.seat).toBe('OP');
    expect(row?.title).toBe('DEC-RECORD');
    expect(row?.decision).toBe('→ TC · 결정 · DEC-RECORD · 기한 12:40');
    expect(row?.delegation).toBe('조율 채널 — 자리 위임 범위');
    expect(row?.reporting).toBe('posthoc');
    expect(row?.decidedAt).toBe(at);
    expect(row?.refs).toEqual([url]);
    expect(ledger.seatReport()).toHaveLength(1);
    mirrorCoordDecision({ ...input, slot: null, url: null }, { ledger });
    expect(ledger.seatReport()).toHaveLength(2);
    expect(ledger.seatReport().some(row => row.title === row.decision && !row.refs)).toBe(true);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('decision mirror redacts the slot before writing the seat title', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'coord-secret-title-'));
  try {
    const ledger = new DecisionLedger({ stateDir, now: () => new Date(at), resolveVersion: () => ({ released: null, dev: null, codename: null }) });
    const secret = 'token=very-sensitive-value';
    const input = { ...parseCoordHeader('OP', `**[OP]** 2026-10-02 11:00 KST → TC · 결정 · ${secret} · 기한 12:40`),
      url: 'https://github.com/o/r/issues/1#issuecomment-72', at };
    let passedTitle: string | undefined;
    mirrorCoordDecision(input, { ledger: { recordSeatDecision: (decision) => {
      passedTitle = decision.title;
      return ledger.recordSeatDecision(decision);
    } } });
    const [row] = ledger.seatReport();
    expect(passedTitle).toBe('token=***');
    expect(row?.title).toBe('[REDACTED]');
    expect(JSON.stringify(row)).not.toContain(secret);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('decision mirror failure is swallowed without changing the context event', () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    const input = { ...parseCoordHeader('OP', '**[OP]** 2026-10-02 11:00 KST → TC · 결정 · D1'), url: 'https://example.org/decision', at };
    recordCoordEvent(input, { db });
    const before = listCoordEvents({ since: at }, { db });
    let attempts = 0;
    expect(() => mirrorCoordDecision(input, { ledger: { recordSeatDecision: () => {
      attempts++;
      throw new Error('write failed');
    } } })).not.toThrow();
    expect(attempts).toBe(1);
    expect(listCoordEvents({ since: at }, { db })).toEqual(before);
    expect(before).toHaveLength(1);
  } finally { db.close(); }
});

test('one outbound event contains structured refs and first-line-only redacted text; URL and minute retries dedup', () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    const parsed = parseCoordHeader('TC', '**[TC]** 2026-10-02 11:00 KST → OP · UX · 요청 · K6 · 기한 06:30\n비밀-문자열-예시');
    const input = { ...parsed, url: 'https://github.com/o/r/issues/1#issuecomment-10', at };
    const id = recordCoordEvent(input, { db });
    expect(recordCoordEvent(input, { db })).toBe(id);
    const rows = listCoordEvents({ since: '2026-10-01T15:00:00Z', seat: 'TC' }, { db });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: '→ OP · UX · 요청 · K6 · 기한 06:30', summary: '→ OP · UX · 요청 · K6 · 기한 06:30', kind: '요청',
      refs: { seat: 'TC', recipients: ['OP', 'UX'], all: false, kind: '요청', slot: 'K6', deadline: '기한 06:30', url: input.url } });
    expect(JSON.stringify(rows)).not.toContain('비밀-문자열-예시');
    expect(JSON.stringify(db.prepare('SELECT text, summary, refs FROM events WHERE id=?').get(id))).not.toContain('비밀-문자열-예시');
    expect(db.prepare('SELECT text, summary FROM events WHERE id=?').get(id)).toEqual({
      text: '→ OP · UX · 요청 · K6 · 기한 06:30', summary: '→ OP · UX · 요청 · K6 · 기한 06:30',
    });
    expect(db.prepare("SELECT surface,direction,domain,category FROM events WHERE id=?").get(id)).toEqual({
      surface: 'coord:channel', direction: 'outbound', domain: 'elanous', category: 'coordination',
    });
    const noUrl = { ...input, url: null };
    expect(recordCoordEvent(noUrl, { db })).toBe(recordCoordEvent({ ...noUrl, at: '2026-10-02T02:00:55.000Z' }, { db }));
    expect(listCoordEvents({ since: at }, { db })).toHaveLength(2);
  } finally { db.close(); }
});

test('legacy first line is recorded with unknown kind and no slot/deadline', () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    const parsed = parseCoordHeader('TC', '**[TC]** 2026-10-02 11:00 KST → OP — 무엇');
    expect(parsed).toMatchObject({ recipients: ['OP'], kind: null, slot: null, deadline: null });
    recordCoordEvent({ ...parsed, url: null, at }, { db });
    expect(listCoordEvents({ since: at }, { db })[0]).toMatchObject({ kind: 'unknown', refs: { slot: null, deadline: null } });
  } finally { db.close(); }
});

test('summary is redacted and capped without leaking the second line or source prefix', () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    const header = `**[TC]** 2026-10-02 11:00 KST ${'A'.repeat(140)}\n비밀-문자열-예시`;
    recordCoordEvent({ ...parseCoordHeader('TC', header), url: null, at }, { db });
    const [row] = listCoordEvents({ since: at }, { db });
    expect(row?.text).toBe('A'.repeat(120));
    expect(row?.summary).toBe('A'.repeat(120));
    expect(JSON.stringify(row)).not.toContain('비밀-문자열-예시');
  } finally { db.close(); }
});

test('structured slot and deadline redact secrets in both stored refs and JSON output', () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    const secret = 'token=very-sensitive-value';
    const parsed = parseCoordHeader('TC', `**[TC]** 2026-10-02 11:00 KST → UX · 요청 · ${secret} · 기한 ${secret}`);
    const id = recordCoordEvent({ ...parsed, url: null, at }, { db });
    const [row] = listCoordEvents({ since: at }, { db });
    expect(row?.refs.slot).toBe('token=***');
    expect(row?.refs.deadline).toBe('기한 token=***');
    expect(row?.text).not.toContain(secret);
    expect(row?.summary).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(db.prepare('SELECT text, summary, refs FROM events WHERE id=?').get(id))).not.toContain(secret);
  } finally { db.close(); }
});

test('ordered envelope parses only recipient fields before kind, never later keywords', () => {
  expect(parseCoordHeader('MK', '**[MK]** {{TS}} → TC · UX · 요청 · K6 · 기한 06:30')).toMatchObject({
    recipients: ['TC', 'UX'], kind: '요청', slot: 'K6', deadline: '기한 06:30',
  });
  expect(parseCoordHeader('MK', '**[MK]** {{TS}} → TC · 보고 · 결정 D1')).toMatchObject({ kind: '보고', slot: '결정 D1' });
  expect(parseCoordHeader('MK', '**[MK]** {{TS}} → TC · K6 · 보고 · -')).toMatchObject({ kind: null, slot: '보고' });
  expect(parseCoordHeader('MK', '**[MK]** {{TS}} · 보고 · K6 → TC')).toMatchObject({ recipients: [], kind: null });
  expect(parseCoordHeader('MK', '**[MK]** {{TS}} → 전원 · 사고 · -')).toMatchObject({ all: true, recipients: [], kind: '사고', slot: '-' });
});
