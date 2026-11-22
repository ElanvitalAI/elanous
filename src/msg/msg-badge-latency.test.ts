import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore, readUnreadMailBadgesOn } from './msg-store.js';

const dirs: string[] = [];
function diskPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-msg-badge-'));
  dirs.push(dir);
  return join(dir, 'nested', 'messages.db');
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/**
 * MSG-LEDGER-RETENTION-INDEX ② (r6 split — OP #128727): 이 PR 은 색인+조회 분리(UNION 팔)만 남는다.
 * 완료선 «미읽음 17자리 1회 <5ms» (OP #128692) 를 정확 head 에서 원문 측정한다 —
 * 17개 자리가 미읽음 1건씩을 갖는 운영 원장에서 readUnreadMailBadgesOn 1회 호출의 wall-clock.
 */
describe('badge latency (MSG-LEDGER-RETENTION-INDEX ② · OP #128692 completion line)', () => {
  test('one readUnreadMailBadgesOn call over 17 unread seats stays under 5ms', () => {
    const store = new MsgStore(diskPath());
    try {
      const SEATS = ['OP','TC','MK','UX','JUD','JUD-B','JUD-C','MOB-1','MVP-B','RES','RES-INFRA','N04','CX-13','TA-ELS','HAND-TUI-D','HAND-ELN-ELS-API','mbp'] as const; // 17자리 (출처: #128692)
      for (const seat of SEATS) {
        const message = store.post({ from: 'OP', to: seat, body: `unread-${seat}` });
        store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', message.id); // 미읽음 유지(만료 없음)
      }
      const before = performance.now();
      const { badges, error } = readUnreadMailBadgesOn(store.db, SEATS);
      const elapsedMs = performance.now() - before;
      expect(error).toBeNull();
      expect(badges.size).toBe(17); // 출처: #128692 — 17자리 전부 배지를 받는다
      for (const seat of SEATS) expect(badges.get(seat)?.count).toBe(1); // 출처: #128692 — 각 자리 미읽음 1건
      console.log(`BADGE-LATENCY-17 one call = ${elapsedMs.toFixed(3)}ms (must be < 5ms)`); // 원문 측정 출력
      expect(elapsedMs).toBeLessThan(5); // 출처: #128692 — 완료선 5ms
    } finally { store.close(); }
  });
});
