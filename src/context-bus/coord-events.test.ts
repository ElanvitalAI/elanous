import { expect, test } from 'bun:test';
import { openSurfaceEventsDb } from '../domains/surface-events.js';
import { listCoordEvents, parseCoordHeader, recordCoordEvent } from './coord-events.js';

const at = '2026-10-02T02:00:00.000Z';

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
