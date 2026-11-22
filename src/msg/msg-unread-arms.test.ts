import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore, readUnreadCount, readUnreadSummary, readUnreadSource, unreadArmsOn } from './msg-store.js';

const dirs: string[] = [];
function diskPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-msg-arms-'));
  dirs.push(dir);
  return join(dir, 'nested', 'messages.db');
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/**
 * MSG-LEDGER-RETENTION-INDEX ② — 미읽음 조회는 OR 절 하나로 전체 행을 훑지 않는다:
 * 팔(direct · ALL · group)마다 (recipient, id) 커버 색인을 타고, 만료·ack 필터는 후보 행에만 붙는다.
 */
describe('unread UNION arms (MSG-LEDGER-RETENTION-INDEX ②)', () => {
  test('the arm union equals the legacy OR predicate on a mixed fixture (cursor · ack · expiry · ALL · group)', () => {
    const path = diskPath();
    const store = new MsgStore(path);
    try {
      const group = store.createGroup('arms', 'OP');
      store.joinGroup(group, 'TC');
      const delivered = store.post({ from: 'OP', to: 'TC', body: 'delivered-below-cursor' });
      const unread = store.post({ from: 'OP', to: 'TC', body: 'unread' });
      const acked = store.post({ from: 'OP', to: 'TC', body: 'acked' });
      const expired = store.post({ from: 'OP', to: 'TC', body: 'expired', expiresAt: '2000-01-01T00:00:00.000Z' });
      const broadcast = store.post({ from: 'OP', to: 'ALL', body: 'broadcast-from-op' });
      const ownBroadcast = store.post({ from: 'TC', to: 'ALL', body: 'broadcast-from-tc' });
      const groupMail = store.post({ from: 'OP', to: group, body: 'group-mail' });
      store.ack('TC', delivered.id);
      store.ackMessage('TC', acked.id);
      const recent = store.post({ from: 'OP', to: 'TC', body: 'recent-unread' });
      const expected = [unread, broadcast, groupMail, recent].map(message => message.id).sort((a, b) => a - b);

      expect(store.unreadCount('TC')).toBe(expected.length); // 4 — B·ALL·group·recent; 만료·ack·cursor 지나간 행 제외
      const summary = readUnreadSummary('TC', path);
      expect(summary).toEqual({ count: expected.length, maxId: recent.id });
      expect(readUnreadCount('TC', path)).toBe(expected.length);
      const source = readUnreadSource('TC', path);
      expect(source?.seat).toBe('OP');
      expect(source?.messages.map(message => message.id)).toEqual(expected);
      const afterFirst = store.unreadCountAfter('TC', unread.id);
      expect(afterFirst).toBe(expected.length - 1);
      const arms = unreadArmsOn(store.db, 'TC');
      const armIds = (store.db.query(`SELECT id FROM (${arms.sql}) ORDER BY id`).all(...arms.params) as Array<{ id: number }>)
        .map(row => row.id).sort((a, b) => a - b);
      expect(armIds).toEqual(expected);
      expect(store.db.inTransaction).toBe(false);
    } finally { store.close(); }
  });

  test('every arm searches the (recipient, id) covering index — no full table scan and no row pread', () => {
    const path = diskPath();
    const store = new MsgStore(path);
    try {
      const group = store.createGroup('plan', 'OP');
      store.joinGroup(group, 'TC');
      store.post({ from: 'OP', to: 'TC', body: 'seed' });
      store.post({ from: 'OP', to: 'ALL', body: 'seed-broadcast' });
      store.post({ from: 'OP', to: group, body: 'seed-group' });
      const arms = unreadArmsOn(store.db, 'TC');
      const plans = store.db.query(`EXPLAIN QUERY PLAN ${arms.sql}`).all(...arms.params) as Array<{ detail: string }>;
      const messageLines = plans.map(row => row.detail).filter(detail => /msg_messages/.test(detail));
      expect(messageLines.length).toBeGreaterThan(0); // 출처: #39557 — msg_messages 탐색 줄이 팔마다 최소 1
      // 색인을 탄다: 커버 색인이 최소 하나, 원장 전수 스캔(SCAN msg_messages)은 없다.
      expect(plans.some(row => row.detail.includes('idx_msg_messages_unread_cover'))).toBe(true);
      expect(messageLines.every(detail => detail.includes('INDEX'))).toBe(true);
      expect(messageLines.filter(detail => /SCAN msg_messages/.test(detail))).toEqual([]);
      // ③ 폴러 경로(unreadCountAfter)의 COUNT 래퍼도 같은 팔을 탄다 — 전수 훑기로 물러나지 않는다(출처: #39557).
      const afterArms = unreadArmsOn(store.db, 'TC', 0);
      const countPlans = store.db.query(`EXPLAIN QUERY PLAN SELECT COUNT(*) AS count FROM (${afterArms.sql})`).all(...afterArms.params) as Array<{ detail: string }>;
      expect(countPlans.some(row => row.detail.includes('idx_msg_messages_unread_cover'))).toBe(true);
      expect(countPlans.filter(row => /SCAN msg_messages/.test(row.detail))).toEqual([]);
    } finally { store.close(); }
  });
});