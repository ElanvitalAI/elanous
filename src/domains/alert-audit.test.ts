import { describe, expect, test } from 'bun:test';
import { auditAlerts, arrivalsFromDeliveries, formatAlertAudit, markOrder, type AlertAuditInput, type AlertRegistrySender } from './alert-audit.js';
import type { DeliveryRow } from '../nexus/outbound/delivery-ledger.js';

const registry: AlertRegistrySender[] = [
  { kind: 'cron', id: 'morning-report', representative: true, what: '데일리 브리핑', when: '30 8 * * *', channel: 'telegram:report', bot: 'telegram:111', contentKey: 'daily-brief' },
  { kind: 'loop', id: 'ops-health', representative: true, what: '운영 이상', when: '*/15 * * * *', channel: 'telegram:home', bot: 'telegram:222', contentKey: 'ops-fault' },
  { kind: 'script', id: 'scripts/capstone-alert.ts', representative: true, what: '캡스톤', when: 'on-change', channel: 'telegram:report', bot: 'telegram:111', contentKey: 'ops-fault' },
  { kind: 'script', id: 'scripts/seat-brief.ts', representative: true, what: '자리 브리핑', when: 'none', channel: 'none', bot: 'none', contentKey: 'seat-brief' },
  { kind: 'cron', id: 'ingest-only', representative: false, what: '시세 수집', when: '*/5 * * * *', channel: 'none', bot: 'none' },
];

function input(overrides: Partial<AlertAuditInput> = {}): AlertAuditInput {
  return {
    registry,
    crons: [
      { id: 'morning-report', name: 'morning-report', cron: '30 8 * * *', command: 'bun scripts/morning-report.ts', enabled: 1 },
      { id: 'ingest-only', name: 'ingest-only', cron: '*/5 * * * *', command: 'bun scripts/collect.ts', enabled: 1 },
    ],
    loops: [{ id: 'ops-health' }],
    claims: [
      { sender: { kind: 'cron', id: 'morning-report' }, what: '데일리 브리핑', when: '30 8 * * *', channel: 'telegram:report', bot: 'telegram:111', contentKey: 'daily-brief', recordedOk: true, at: '2026-10-06T23:30:00.000Z' },
      { sender: { kind: 'loop', id: 'ops-health' }, what: '운영 이상', when: '*/15 * * * *', channel: 'telegram:home', bot: 'telegram:222', contentKey: 'ops-fault', recordedOk: true, at: '2026-10-06T01:00:00.000Z' },
    ],
    arrivals: [
      { sender: { kind: 'loop', id: 'ops-health' }, what: '운영 이상', channel: 'telegram:home', bot: 'telegram:222', contentKey: 'ops-fault', arrivedAt: '2026-10-06T01:00:02.000Z', ok: true },
      { sender: { kind: 'script', id: 'scripts/capstone-alert.ts' }, what: '캡스톤', channel: 'telegram:report', bot: 'telegram:333', contentKey: 'ops-fault', arrivedAt: '2026-10-06T01:00:05.000Z', ok: true },
    ],
    ...overrides,
  };
}

describe('alert audit', () => {
  test('대표 발신자는 크론·루프 레지스트리와 빠짐 0이고 세 표시에 실례가 있다', () => {
    const audit = auditAlerts(input());
    expect(audit.missingFromRegistry).toBe(0);
    expect(audit.verdict).toBe('pass');
    expect(audit.rows.map(row => row.who)).toEqual([
      'cron:morning-report',
      'loop:ops-health',
      'script:scripts/capstone-alert.ts',
      'script:scripts/seat-brief.ts',
    ]);
    expect(audit.rows.find(row => row.who === 'cron:ingest-only')).toBeUndefined();
    expect(audit.claimedWithoutArrival.map(row => row.who)).toEqual(['cron:morning-report']);
    expect(audit.claimedWithoutArrival[0]?.lastArrivedAt).toBeNull();
    expect(audit.overlaps.map(row => row.who).sort()).toEqual(['loop:ops-health', 'script:scripts/capstone-alert.ts']);
    expect(audit.gaps.map(row => row.who)).toEqual(['script:scripts/seat-brief.ts']);
    const morning = audit.rows.find(row => row.who === 'cron:morning-report');
    expect(morning).toMatchObject({ what: '데일리 브리핑', when: '2026-10-06T23:30:00.000Z', channel: 'telegram:report', bot: 'telegram:111', lastArrivedAt: null });
    expect(morning?.marks).toEqual(markOrder(['claimed-without-arrival']));
    const table = formatAlertAudit(audit);
    expect(table).toContain('| cron:morning-report | 데일리 브리핑 | 2026-10-06T23:30:00.000Z | telegram:report | telegram:111 | 없음 | claimed-without-arrival |');
    expect(table).toContain('겹치는 것: loop:ops-health, script:scripts/capstone-alert.ts');
    expect(table).toContain('아무도 안 보내는 것: script:scripts/seat-brief.ts');
    expect(table).toContain('대조 누락: 0');
  });

  test('세 표시가 비면 없음과 근거를 남긴다', () => {
    const audit = auditAlerts(input({
      registry: registry.filter(sender => sender.id !== 'scripts/capstone-alert.ts' && sender.id !== 'scripts/seat-brief.ts'),
      claims: [
        { sender: { kind: 'cron', id: 'morning-report' }, what: '데일리 브리핑', when: '30 8 * * *', channel: 'telegram:report', bot: 'telegram:111', contentKey: 'daily-brief', recordedOk: true, at: '2026-10-06T23:30:00.000Z' },
        { sender: { kind: 'loop', id: 'ops-health' }, what: '운영 이상', when: '*/15 * * * *', channel: 'telegram:home', bot: 'telegram:222', contentKey: 'ops-fault', recordedOk: true },
      ],
      arrivals: [
        { sender: { kind: 'cron', id: 'morning-report' }, what: '데일리 브리핑', channel: 'telegram:report', bot: 'telegram:111', contentKey: 'daily-brief', arrivedAt: '2026-10-06T23:30:04.000Z', ok: true },
        { sender: { kind: 'loop', id: 'ops-health' }, what: '운영 이상', channel: 'telegram:home', bot: 'telegram:222', contentKey: 'ops-fault', arrivedAt: '2026-10-06T01:00:02.000Z', ok: true },
      ],
    }));
    expect(audit.claimedWithoutArrival).toEqual([]);
    expect(audit.overlaps).toEqual([]);
    expect(audit.gaps).toEqual([]);
    expect(audit.rows.find(row => row.who === 'cron:morning-report')?.lastArrivedAt).toBe('2026-10-06T23:30:04.000Z');
    expect(audit.rows.every(row => row.marks.join(',') === markOrder([]).join(','))).toBe(true);
    expect(markOrder([])).toEqual(['none']);
    const table = formatAlertAudit(audit);
    expect(table).toContain('보낸다고 기록됐는데 도착 증거가 없는 것: 없음 — recordedOk 인 발신자마다 도착이 있다');
    expect(table).toContain('겹치는 것: 없음 — 같은 contentKey 가 둘 이상의 채널·봇에 도착한 적이 없다');
    expect(table).toContain('아무도 안 보내는 것: 없음 — representative 발신자는 모두 발송 기록이 있거나 도착이 있다');
  });

  test('레지스트리에 없는 representative 크론·루프는 빠짐으로 센다', () => {
    const audit = auditAlerts(input({ crons: [], loops: [] }));
    expect(audit.missingFromRegistry).toBe(2);
    expect(audit.missingSenders).toEqual([
      { kind: 'cron', id: 'morning-report' },
      { kind: 'loop', id: 'ops-health' },
    ]);
    expect(audit.verdict).toBe('fail');
    expect(audit.rows).toHaveLength(4);
  });

  test('배송 원장의 ok 가 아닌 채널은 도착이 아니다', () => {
    const row: DeliveryRow = {
      message_id: 'm1', ts: '2026-10-06T23:30:04.000Z', kind: 'report', dedup_key: 'abc', text: '데일리',
      channels: JSON.stringify([{ type: 'telegram', ok: false, bot: 'telegram:111' }]),
      read: 0, read_at: null, read_channel: null,
    };
    expect(arrivalsFromDeliveries([row], () => ({
      sender: { kind: 'cron', id: 'morning-report' }, what: '데일리 브리핑', channel: 'telegram:report', bot: 'telegram:111',
    }))).toEqual([]);
    const ok = arrivalsFromDeliveries([{ ...row, channels: JSON.stringify([{ type: 'telegram', ok: true, bot: 'telegram:111' }, { type: 'telegram', ok: true, bot: 'telegram:111' }]) }], () => ({
      sender: { kind: 'cron', id: 'morning-report' }, what: '데일리 브리핑', channel: 'telegram:report', bot: 'telegram:111',
    }));
    expect(ok).toHaveLength(1);
    expect(ok[0]?.arrivedAt).toBe('2026-10-06T23:30:04.000Z');
  });

  test('실패 도착은 마지막 도착 시각을 밀지 않는다', () => {
    const audit = auditAlerts(input({
      arrivals: [
        { sender: { kind: 'cron', id: 'morning-report' }, what: '데일리 브리핑', channel: 'telegram:report', bot: 'telegram:111', arrivedAt: '2026-10-06T23:31:00.000Z', ok: false },
      ],
    }));
    expect(audit.rows.find(row => row.who === 'cron:morning-report')?.lastArrivedAt).toBeNull();
    expect(audit.claimedWithoutArrival.map(row => row.who)).toContain('cron:morning-report');
  });

  test('contentKey 를 모르면 겹침을 없음으로 단정하지 않는다', () => {
    const audit = auditAlerts(input({
      registry: [
        { kind: 'cron', id: 'morning-report', representative: true, what: '데일리 브리핑', when: '30 8 * * *', channel: 'telegram:report', bot: 'telegram:111' },
        { kind: 'script', id: 'scripts/echo.ts', representative: true, what: '데일리 브리핑', when: 'on-change', channel: 'telegram:home', bot: 'telegram:222' },
      ],
      claims: [
        { sender: { kind: 'cron', id: 'morning-report' }, what: '데일리 브리핑', when: '30 8 * * *', channel: 'telegram:report', bot: 'telegram:111', recordedOk: true, at: '2026-10-06T23:30:00.000Z' },
        { sender: { kind: 'script', id: 'scripts/echo.ts' }, what: '데일리 브리핑', when: 'on-change', channel: 'telegram:home', bot: 'telegram:222', recordedOk: true, at: '2026-10-06T23:30:01.000Z' },
      ],
      arrivals: [
        { sender: { kind: 'cron', id: 'morning-report' }, what: '데일리 브리핑', channel: 'telegram:report', bot: 'telegram:111', arrivedAt: '2026-10-06T23:30:04.000Z', ok: true },
        { sender: { kind: 'script', id: 'scripts/echo.ts' }, what: '데일리 브리핑', channel: 'telegram:home', bot: 'telegram:222', arrivedAt: '2026-10-06T23:30:05.000Z', ok: true },
      ],
    }));
    expect(audit.overlaps).toEqual([]);
    expect(audit.overlapUnknown.map(row => row.who).sort()).toEqual(['cron:morning-report', 'script:scripts/echo.ts']);
    expect(audit.rows.every(row => row.marks.includes('overlap-unknown'))).toBe(true);
    expect(markOrder(audit.rows[0]?.marks ?? [])).toEqual(['overlap-unknown']);
    const table = formatAlertAudit(audit);
    expect(table).toContain('겹치는 것: 미상 — contentKey 를 모르는 도착이 있어 겹침을 판정하지 않음');
    expect(table).not.toContain('같은 contentKey 가 둘 이상의 채널·봇에 도착한 적이 없다');
    expect(table).toContain('| cron:morning-report | 데일리 브리핑 | 2026-10-06T23:30:04.000Z | telegram:report | telegram:111 | 2026-10-06T23:30:04.000Z | overlap-unknown |');
  });

  test('공백 contentKey 도 미상이고 같은 키만 교차 발신 겹침이다', () => {
    const blank = auditAlerts(input({
      arrivals: [
        { sender: { kind: 'loop', id: 'ops-health' }, what: '운영 이상', channel: 'telegram:home', bot: 'telegram:222', contentKey: '   ', arrivedAt: '2026-10-06T01:00:02.000Z', ok: true },
        { sender: { kind: 'script', id: 'scripts/capstone-alert.ts' }, what: '캡스톤', channel: 'telegram:report', bot: 'telegram:333', contentKey: 'ops-fault', arrivedAt: '2026-10-06T01:00:05.000Z', ok: true },
      ],
    }));
    expect(blank.overlaps.map(row => row.who)).toEqual([]);
    expect(blank.overlapUnknown.map(row => row.who)).toEqual(['loop:ops-health']);
    expect(blank.rows.find(row => row.who === 'cron:morning-report')?.when).toBe('2026-10-06T23:30:00.000Z');
  });
});
