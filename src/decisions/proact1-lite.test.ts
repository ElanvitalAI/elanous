import { describe, expect, test } from 'bun:test';
import { selectProact1Lite, type ProactSignals } from './proact1-lite.js';

const now = new Date('2026-10-05T09:00:00.000Z');
const five: ProactSignals = {
  decisions: [
    { id: 'D-1', title: '오래 막힌 결정', status: 'open', blocked: true, raisedAt: '2026-10-03T00:00:00Z' },
    { id: 'D-2', title: '두번째 결정', status: 'open', resume: { questionId: 'auq:one:abcde' }, raisedAt: '2026-10-04T00:00:00Z' },
  ],
  yellow: [{ version: 'v1', item: { id: 'Y-1', title: '착지 대기', status: 'yellow' } }],
  schedules: [{ version: 'v1', landBy: '2026-10-05T12:00:00Z' }],
  loops: [{ name: 'daily', state: 'late' }],
  draftAssessment: {
    drafts: [{ number: 51, title: '남은 초안' }],
    sweep: { complete: true, entries: [{ number: 51, action: 'close', reason: 'stale-unobserved', applied: false }] },
  },
};

describe('PROACT1-LITE rules-only selector', () => {
  test('five eligible signals yield the deterministic top three, without mutating observations', () => {
    const snapshot = JSON.stringify(five);
    expect(selectProact1Lite(five, { now }).map(s => s.key)).toEqual(['yellow:v1:Y-1', 'decision:D-1', 'decision:D-2']);
    expect(JSON.stringify(five)).toBe(snapshot);
  });

  test('prior suggestions are not repeated, next eligible signals fill the available slots', () => {
    const selected = selectProact1Lite(five, { now, previouslySuggested: new Set(['yellow:v1:Y-1', 'decision:D-1']) });
    expect(selected.map(s => s.key)).toEqual(['decision:D-2', 'loop::daily', 'draft:51']);
    expect(selectProact1Lite(five, { now, previouslySuggested: new Set(['yellow:v1:Y-1', 'decision:D-1', 'decision:D-2', 'loop::daily', 'draft:51']) })).toEqual([]);
  });

  test('unknown clocks and state, incomplete draft assessment, and unresolved dates cannot imply urgency', () => {
    expect(selectProact1Lite({
      decisions: [
        { id: 'unknown', title: '원시 시각 없음', status: 'open' },
        { id: 'closed', title: '결정 완료', status: 'decided', raisedAt: '2026-09-01T00:00:00Z' },
        { id: 'fresh', title: '방금 열림', status: 'open', blocked: true, raisedAt: '2026-10-05T08:00:00Z' },
        { id: 'unblocked', title: '낡았지만 안 막힘', status: 'open', raisedAt: '2026-09-01T00:00:00Z' },
      ],
      yellow: [{ version: 'v1', item: { id: 'yellow', title: '마감 미상', status: 'yellow' } }],
      schedules: [{ version: 'v1', landBy: null }],
      loops: [{ name: 'unknown', state: 'unknown' }, { name: 'off', state: 'off' }, { name: 'failed', state: 'failing' }],
      draftAssessment: { drafts: [{ number: 1, title: '초안' }], sweep: { complete: false, entries: [{ number: 1, action: 'close', reason: 'stale-unobserved', applied: false }] } },
    }, { now })).toEqual([]);
  });

  test('imported cards explicitly use import time; future dates and unverified drafts stay out', () => {
    const selected = selectProact1Lite({
      decisions: [{ id: 'import', title: '기록 가져옴', status: 'open', blocked: true, importedAt: '2026-10-03T00:00:00Z' }],
      yellow: [{ version: 'v1', item: { id: 'future', title: '미래 판', status: 'yellow' } }],
      schedules: [{ version: 'v1', landBy: '2026-10-10T00:00:00Z' }],
      draftAssessment: { drafts: [{ number: 1, title: '진행 초안' }], sweep: { complete: true, entries: [{ number: 1, action: 'keep', reason: 'claim-expired-but-live', applied: false }] } },
    }, { now });
    expect(selected).toMatchObject([{ key: 'decision:import', reason: expect.stringContaining('가져온 시각 기준') }]);
  });

  test('an already applied draft closure is never proposed as a stale open draft', () => {
    const selected = selectProact1Lite({
      draftAssessment: {
        drafts: [{ number: 51, title: '이미 닫힌 초안' }, { number: 52, title: '아직 열린 초안' }],
        sweep: { complete: true, entries: [
          { number: 51, action: 'close', reason: 'stale-unobserved', applied: true },
          { number: 52, action: 'close', reason: 'stale-unobserved', applied: false },
        ] },
      },
    }, { now });
    expect(selected.map(s => s.key)).toEqual(['draft:52']);
  });

  test('age and landing windows include their exact boundary, but never future decisions or later deadlines', () => {
    const selected = selectProact1Lite({
      decisions: [
        { id: 'boundary', title: '하루 된 차단', status: 'open', blocked: true, raisedAt: '2026-10-04T09:00:00Z' },
        { id: 'future', title: '미래 차단', status: 'open', blocked: true, raisedAt: '2026-10-06T09:00:00Z' },
      ],
      yellow: [
        { version: 'boundary', item: { id: 'due', title: '하루 뒤', status: 'yellow' } },
        { version: 'later', item: { id: 'later', title: '하루 넘게 남음', status: 'yellow' } },
      ],
      schedules: [
        { version: 'boundary', landBy: '2026-10-06T09:00:00Z' },
        { version: 'later', landBy: '2026-10-06T09:00:01Z' },
      ],
    }, { now });
    expect(selected.map(s => s.key)).toEqual(['yellow:boundary:due', 'decision:boundary']);
  });

  test('duplicate source rows collapse to one suggestion, with stable lexical tie order', () => {
    expect(selectProact1Lite({ loops: [{ name: 'z', state: 'late' }, { name: 'a', state: 'late' }, { name: 'a', state: 'late' }] }, { now }).map(s => s.key)).toEqual(['loop::a', 'loop::z']);
  });
});
