import { test, expect, describe } from 'bun:test';
import { openDeliveryDb, recordDelivery, recentDeliveryCount, recentlyDelivered, successfulDeliveryId } from './delivery-ledger.js';

function seed() {
  const db = openDeliveryDb(':memory:');
  const now = Date.parse('2026-07-15T08:00:00.000Z');
  // 최근 창(2분) 안 3건 + 밖 2건.
  for (let i = 0; i < 3; i += 1) {
    recordDelivery(db, { messageId: `r${i}`, kind: 'alert', dedupKey: `d${i}`, text: 't', channels: [{ type: 'telegram', ok: true }], ts: new Date(now - i * 10_000).toISOString() });
  }
  for (let i = 0; i < 2; i += 1) {
    recordDelivery(db, { messageId: `o${i}`, kind: 'alert', dedupKey: `e${i}`, text: 't', channels: [], ts: new Date(now - 600_000 - i * 1000).toISOString() });
  }
  return { db, now };
}

describe('recentDeliveryCount (ISO 임계 비교)', () => {
  test('창 안 발송만 카운트 — 밀림(burst) 판정', () => {
    const { db, now } = seed();
    try {
      expect(recentDeliveryCount(db, 120, now)).toBe(3);      // 최근 2분 3건
      expect(recentDeliveryCount(db, 86400, now)).toBe(5);    // 24h 전체 5건
    } finally { db.close(); }
  });

  test('ISO ts 를 datetime(now) 로 오비교하지 않는다(전량 카운트 버그 방지)', () => {
    const { db, now } = seed();
    try {
      // 5초 창 → now 의 r0 만(r1=now-10s 는 밖). 오비교면 전량 5 가 나옴.
      expect(recentDeliveryCount(db, 5, now)).toBe(1);
    } finally { db.close(); }
  });

  test('recentlyDelivered dedup — 시각을 주입해 시한폭탄을 없앤다', () => {
    // ⚠️ seed 는 **고정 날짜**다. 종전 구현은 SQL 안의 `datetime('now')` 와 비교해서, 시간이
    //    흐르면 seed 가 창 밖으로 밀려 **어느 날 갑자기 빨개졌다**(실제로 그 상태였다).
    //    이제 `nowMs` 를 주입하므로 언제 돌려도 같은 결과가 나온다.
    const { db, now } = seed();
    try {
      expect(recentlyDelivered(db, 'd0', 86400, now)).toBe(true);
      expect(successfulDeliveryId(db, 'd0', 5, now)).toBe('r0');     // now 시점 발송 → 5초 창에도 잡힘
      expect(recentlyDelivered(db, 'e0', 60, now)).toBe(false);   // 10분 전 발송 → 1분 창 밖
    } finally { db.close(); }
  });

  test('실패한 채널만 있는 최근 기록은 억제 근거가 아니며 성공 기록의 id 를 돌려준다', () => {
    const db = openDeliveryDb(':memory:');
    const now = Date.parse('2026-07-15T08:00:00.000Z');
    const ts = (ago: number) => new Date(now - ago * 1000).toISOString();
    try {
      recordDelivery(db, { messageId: 'failed', kind: 'alert', dedupKey: 'same', text: 't', channels: [{ type: 'telegram', ok: false }], ts: ts(10) });
      recordDelivery(db, { messageId: 'empty', kind: 'alert', dedupKey: 'same', text: 't', channels: [], ts: ts(5) });
      expect(recentlyDelivered(db, 'same', 120, now)).toBe(false);
      expect(recentDeliveryCount(db, 120, now)).toBe(2);
      recordDelivery(db, { messageId: 'ok', kind: 'alert', dedupKey: 'same', text: 't', channels: [{ type: 'telegram', ok: false }, { type: 'discord', ok: true }], ts: ts(4) });
      recordDelivery(db, { messageId: 'failed-again', kind: 'alert', dedupKey: 'same', text: 't', channels: [{ type: 'telegram', ok: false }], ts: ts(3) });
      expect(successfulDeliveryId(db, 'same', 120, now)).toBe('ok');
      expect(recentlyDelivered(db, 'same', 120, now)).toBe(true);
      expect(successfulDeliveryId(db, 'same', 2, now)).toBeNull();
    } finally { db.close(); }
  });
});
