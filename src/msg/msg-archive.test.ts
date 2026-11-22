import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore, readUnreadMailBadgesOn } from './msg-store.js';
import { archiveDeliveredRows, MSG_ARCHIVE_DEFAULT_DAYS, type ArchiveDeliveredOutcome } from './msg-archive.js';

const dirs: string[] = [];
function paths(): { source: string; archive: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-msg-archive-'));
  dirs.push(dir);
  return { source: join(dir, 'messages.db'), archive: join(dir, 'messages-archive.db'), dir };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** MSG-LEDGER-RETENTION-INDEX ① — 7일 지난 배달·ack 끝난 직통 행만 보관 원장으로 옮겨 간다(원장 보존·검색 가능). */
describe('archiveDeliveredRows (MSG-LEDGER-RETENTION-INDEX ①③)', () => {
  test('moves only 7-day-old delivered-or-acked direct rows; unread, expired, ALL and group rows stay', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source);
    new MsgStore(archive).close(); // r3-Terra-② — 보관 원장은 명시적으로 먼저 만든다(부재 시 이행 전 안전 중단 계약)
    const now = new Date('2026-11-22T03:00:00.000Z');
    const oldIso = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    try {
      const group = store.createGroup('arch', 'OP');
      store.joinGroup(group, 'TC');
      const aged = (body: string, to: string, from = 'OP') => {
        const message = store.post({ from, to, body });
        store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(oldIso, message.id);
        return message;
      };
      const delivered = aged('delivered-old', 'TC');
      const acked = aged('acked-old', 'TC');
      const unread = aged('unread-old', 'TC');
      const expired = aged('expired-old', 'TC');
      store.db.query('UPDATE msg_messages SET expires_at = ? WHERE id = ?')
        .run(new Date(now.getTime() - 9 * 86_400_000).toISOString(), expired.id);
      const broadcast = aged('broadcast-old', 'ALL');
      const groupMail = aged('group-old', group);
      const judAcked = aged('jud-acked-old', 'JUD');
      store.ack('TC', delivered.id);
      store.ackMessage('TC', acked.id);
      store.ackMessage('JUD', judAcked.id);
      const recent = store.post({ from: 'OP', to: 'TC', body: 'recent-unread' });
      const unreadBefore = {
        TC: store.unreadCount('TC'), JUD: store.unreadCount('JUD'), OP: store.unreadCount('OP'),
      };

      let outcome: ArchiveDeliveredOutcome;
      try {
        outcome = archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now });
      } finally { expect(store.db.inTransaction).toBe(false); }

      expect(outcome.archived).toBe(3);
      expect(outcome.cutoffIso).toBe(new Date(now.getTime() - MSG_ARCHIVE_DEFAULT_DAYS * 86_400_000).toISOString());
      // 이동 행은 보관 원장에서 온전히 검색되고 원본은 사라졌다.
      for (const moved of [delivered, acked, judAcked]) {
        expect(store.getMessage(moved.id)).toBeNull();
        const archived = new MsgStore(archive, { readOnly: true, now: () => now });
        try { expect(archived.getMessage(moved.id)?.body).toBe(moved.body); } finally { archived.close(); }
      }
      // 남는 행: 미읽음 · 만료 · ALL · 그룹 · 최근 — 전부 원본에 그대로.
      for (const kept of [unread, expired, broadcast, groupMail, recent]) {
        expect(store.getMessage(kept.id)?.id).toBe(kept.id);
      }
      // 미읽음 수는 아카이브 전후로 동일(1 회 이동이 읽음 상태를 바꾸지 않는다).
      expect(store.unreadCount('TC')).toBe(unreadBefore.TC);
      expect(store.unreadCount('JUD')).toBe(unreadBefore.JUD);
      expect(store.unreadCount('OP')).toBe(unreadBefore.OP);
      // 영수(posted 이상)도 보관 원장에 복사됐다.
      const archivedStore = new MsgStore(archive, { readOnly: true, now: () => now });
      try {
        const receiptIds = archivedStore.db.query('SELECT message_id FROM msg_receipts').all() as Array<{ message_id: number }>;
        expect(receiptIds.map(row => row.message_id).sort((a, b) => a - b)).toEqual([delivered.id, acked.id, judAcked.id].sort((a, b) => a - b));
      } finally { archivedStore.close(); }
    } finally { store.close(); }
  });

  test('① is idempotent — a rerun moves zero rows and keeps every live row', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source);
    new MsgStore(archive).close(); // r3-Terra-② — 보관 원장은 명시적으로 먼저 만든다(부재 시 이행 전 안전 중단 계약)
    const now = new Date('2026-11-22T03:00:00.000Z');
    const oldIso = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    try {
      const delivered = store.post({ from: 'OP', to: 'TC', body: 'once' });
      store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(oldIso, delivered.id);
      store.ack('TC', delivered.id);
      const first = archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now });
      expect(first.archived).toBe(1);
      const second = archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now });
      expect(second.archived).toBe(0);
      const archivedStore = new MsgStore(archive, { readOnly: true, now: () => now });
      try {
        const ids = (archivedStore.db.query('SELECT id FROM msg_messages').all() as Array<{ id: number }>).map(row => row.id);
        expect(ids).toEqual([delivered.id]);
      } finally { archivedStore.close(); }
    } finally { store.close(); }
  });

  test('③ tidy advances a stale cursor only up to the first unread row minus one — never past unread mail, and a seat with no unread keeps its cursor', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source);
    new MsgStore(archive).close(); // r3-Terra-② — 보관 원장은 명시적으로 먼저 만든다(부재 시 이행 전 안전 중단 계약)
    const now = new Date('2026-11-22T03:00:00.000Z');
    const oldIso = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    try {
      const group = store.createGroup('tidy', 'OP');
      store.joinGroup(group, 'TC');
      const aged = (body: string, to: string) => {
        const message = store.post({ from: 'OP', to, body });
        store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(oldIso, message.id);
        return message;
      };
      const a1 = aged('a1', 'TC');
      const a2 = aged('a2', 'TC');
      const a3 = aged('a3', 'TC');
      const a4 = aged('a4', 'TC');
      const x1 = aged('x1', 'X');
      store.ack('TC', a2.id); // cursor TC = a2; a3·a4 는 미읽음(원장에 남는다)
      store.ackMessage('TC', a3.id); // a3 개별 ack — 커서는 stale 하게 a2 에 머문다
      store.ack('X', x1.id); // X: 커서 = x1, 미읽음 없음
      const unreadBefore = store.unreadCount('TC');
      const outcome = archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now });
      expect(outcome.archived).toBe(4); // a1·a2(커서 지남) · a3(개별 ack) · x1 — 전부 배달+ack 끝난 직통 행
      expect(outcome.cursors.TC).toBe(a4.id - 1); // ③ 정리: stale a2 → 첫 미읽음 a4 직전(= a3)까지 전진
      expect(store.getCursor('TC')).toBe(a4.id - 1);
      expect(store.getCursor('TC')).toBeLessThan(a4.id); // 출처: #39557 — 커서는 미읽음을 절대 넘지 않는다
      expect(store.unreadCount('TC')).toBe(unreadBefore); // a4 는 여전히 미읽음
      expect(outcome.cursors.X).toBe(x1.id); // 미읽음 없는 자리 — 커서 그대로
      // cursor 는 살아 있는 행 위로는 절대 넘지 않는다.
      const maxLive = (store.db.query('SELECT MAX(id) AS id FROM msg_messages').get() as { id: number }).id;
      expect(store.getCursor('TC')).toBeLessThanOrEqual(maxLive);
    } finally { store.close(); }
  });

  test('① refuses an archive path that is the message ledger itself — direct path or symlink', () => {
    const { source, dir } = paths();
    const store = new MsgStore(source);
    try {
      const stay = store.post({ from: 'OP', to: 'TC', body: 'stay' });
      expect(() => archiveDeliveredRows(store, source, { days: MSG_ARCHIVE_DEFAULT_DAYS })).toThrow(/separate file/);
      const link = join(dir, 'messages-alias.db');
      symlinkSync(source, link); // 같은 파일의 다른 이름(심볼릭 링크)
      expect(() => archiveDeliveredRows(store, link, { days: MSG_ARCHIVE_DEFAULT_DAYS })).toThrow(/separate file/);
      expect(store.getMessage(stay.id)?.body).toBe('stay'); // 출처: #39557 — 원장은 손대지 않았다
    } finally { store.close(); }
  });

  test('② r5 isolates a conflicting message losslessly — the conflict row stays untouched in both ledgers while other rows still move', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source);
    const now = new Date('2026-11-22T03:00:00.000Z');
    const oldIso = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    try {
      const ours = store.post({ from: 'OP', to: 'TC', body: 'ours' });
      const steady = store.post({ from: 'OP', to: 'TC', body: 'steady' });
      for (const m of [ours, steady]) {
        store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(oldIso, m.id);
        store.ack('TC', m.id);
      }
      // 남의 원장: 같은 id, 다른 내용.
      const foreign = new MsgStore(archive);
      try {
        const theirs = foreign.post({ from: 'MK', to: 'UX', body: 'theirs' });
        expect(theirs.id).toBe(ours.id); // 출처: #39557 — 신규 원장 둘 다 첫 행은 1번, 같은 id 가 배정된다
      } finally { foreign.close(); }
      const outcome = archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now }); // 출처: #128692 — 충돌해도 중단하지 않는다
      expect(outcome.skippedConflicts.messages).toBe(1); // 출처: #128692 — 충돌 1건 격리
      expect(outcome.archived).toBe(1); // 출처: #128692 — 정상 행은 이행이 막히지 않는다
      expect(store.getMessage(ours.id)?.body).toBe('ours'); // 운영 원장 무손상
      expect(store.getMessage(steady.id)).toBeNull(); // steady 는 이동
      const check = new MsgStore(archive, { readOnly: true, now: () => now });
      try {
        expect(check.getMessage(ours.id)?.body).toBe('theirs'); // 보관 원장도 덮어쓰지 않았다
        expect(check.getMessage(steady.id)?.body).toBe('steady'); // 출처: #128692
      } finally { check.close(); }
    } finally { store.close(); }
  });

  test('④ recovers an interrupted migration — an identical archive leftover is re-synced once, not duplicated', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source);
    const now = new Date('2026-11-22T03:00:00.000Z');
    const oldIso = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    try {
      const once = store.post({ from: 'OP', to: 'TC', body: 'once' });
      store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(oldIso, once.id);
      store.ack('TC', once.id);
      // 복사 트랜잭션만 커밋되고 삭제 전에 프로세스가 죽은 흉내 — 보관 원장에 운영과 동일한 복사본이 남는다.
      const leftover = new MsgStore(archive);
      try {
        leftover.db.exec(`ATTACH DATABASE '${source.replace(/'/g, "''")}' AS live_src`);
        // 잔여 흉내도 이행과 같은 INSERT-only-missing 형태로 남긴다(새 보관 원장이라 충돌이 없다).
        leftover.db.query('INSERT INTO msg_messages SELECT * FROM live_src.msg_messages WHERE id = ?').run(once.id);
        leftover.db.query('INSERT INTO msg_receipts SELECT * FROM live_src.msg_receipts WHERE message_id = ?').run(once.id);
        leftover.db.exec('DETACH DATABASE live_src');
      } finally { leftover.close(); }
      const outcome = archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now });
      expect(outcome.archived).toBe(1); // 출처: #39557 — 잔여 정리 뒤 이행은 다시 완결된다
      expect(store.getMessage(once.id)).toBeNull(); // 삭제 단계까지 끝났다
      const check = new MsgStore(archive, { readOnly: true, now: () => now });
      try {
        expect(check.getMessage(once.id)?.body).toBe('once');
        expect((check.db.query('SELECT COUNT(*) AS count FROM msg_messages WHERE id = ?').get(once.id) as { count: number }).count).toBe(1); // 출처: #39557 — 중복 아님(잔여는 정리되고 한 번만 들어간다)
        expect((check.db.query('SELECT COUNT(*) AS count FROM msg_receipts WHERE message_id = ?').get(once.id) as { count: number }).count).toBe(1); // 출처: #39557 — 자식 영수도 정확히 한 벌
      } finally { check.close(); }
    } finally { store.close(); }
  });

  test('① moves TA delivery·claim rows with their request message — request_id is a msg_messages(id) foreign key', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source);
    new MsgStore(archive).close(); // r3-Terra-② — 보관 원장은 명시적으로 먼저 만든다(부재 시 이행 전 안전 중단 계약)
    const now = new Date('2026-11-22T03:00:00.000Z');
    const oldIso = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    try {
      const request = store.post({ from: 'OP', to: 'TC', body: 'tool-approval-request' });
      store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(oldIso, request.id);
      store.ack('TC', request.id);
      store.db.query('INSERT INTO msg_ta_delivery(request_id, status) VALUES (?, ?)').run(request.id, 'delivered');
      store.db.query('INSERT INTO msg_ta_claim(request_id, token) VALUES (?, ?)').run(request.id, 'token-1');
      const unreadOld = store.post({ from: 'OP', to: 'TC', body: 'unread-old' });
      store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(oldIso, unreadOld.id);
      store.db.query('INSERT INTO msg_ta_delivery(request_id, status) VALUES (?, ?)').run(unreadOld.id, 'pending');
      const outcome = archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now });
      expect(outcome.archived).toBe(1); // 출처: #39557 — request 만 이동, unreadOld 는 미읽음이라 운영에 남는다
      expect(store.getMessage(request.id)).toBeNull();
      expect(store.getMessage(unreadOld.id)?.id).toBe(unreadOld.id);
      expect((store.db.query('SELECT COUNT(*) AS count FROM msg_ta_delivery WHERE request_id = ?').get(request.id) as { count: number }).count).toBe(0); // 출처: #39557 — 이동한 메시지의 TA 자식은 운영에서 간다
      expect((store.db.query('SELECT COUNT(*) AS count FROM msg_ta_claim WHERE request_id = ?').get(request.id) as { count: number }).count).toBe(0);
      expect((store.db.query('SELECT COUNT(*) AS count FROM msg_ta_delivery WHERE request_id = ?').get(unreadOld.id) as { count: number }).count).toBe(1); // 남은 메시지의 TA 행은 그대로
      const check = new MsgStore(archive, { readOnly: true, now: () => now });
      try {
        expect((check.db.query('SELECT status FROM msg_ta_delivery WHERE request_id = ?').get(request.id) as { status: string } | null)?.status).toBe('delivered');
        expect((check.db.query('SELECT token FROM msg_ta_claim WHERE request_id = ?').get(request.id) as { token: string } | null)?.token).toBe('token-1');
        expect((check.db.query('SELECT COUNT(*) AS count FROM msg_ta_delivery WHERE request_id = ?').get(unreadOld.id) as { count: number }).count).toBe(0); // 출처: #39557 — 남은 메시지는 보관에 없다
      } finally { check.close(); }
    } finally { store.close(); }
  });

  test('② enforces the rollback journal on the attached archive — a WAL archive is converted before any copy', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source);
    const now = new Date('2026-11-22T03:00:00.000Z');
    const oldIso = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    try {
      // 최신 잔여 행 하나를 먼저 넣는다 — 보관 seed 와 id 가 겹치지 않게.
      store.post({ from: 'OP', to: 'TC', body: 'stay-live' });
      const aged = store.post({ from: 'OP', to: 'TC', body: 'wal-archive' });
      store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(oldIso, aged.id);
      store.ack('TC', aged.id);
      // 운영자가 보관 원장을 WAL 로 남긴 상황 — WAL 은 실제 쓰기가 있어야 헤더에 남는다.
      let seedId = 0;
      const wal = new MsgStore(archive);
      try {
        wal.db.exec('PRAGMA journal_mode = WAL');
        seedId = wal.post({ from: 'OP', to: 'UX', body: 'wal-seed' }).id;
      } finally { wal.close(); }
      const outcome = archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now });
      expect(outcome.archived).toBe(1); // 출처: #39557 — seed 행은 이행 대상이 아니다
      expect(store.getMessage(aged.id)).toBeNull();
      const check = new MsgStore(archive, { readOnly: true, now: () => now });
      try {
        const mode = (check.db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
        expect(mode).toBe('delete'); // 출처: #39557 — 이행은 rollback journal 로만 커밋한다
        expect(check.getMessage(aged.id)?.body).toBe('wal-archive');
        expect(check.getMessage(seedId)?.body).toBe('wal-seed'); // 출처: #39557 — 보관 잔여(seed)는 보존된다
      } finally { check.close(); }
    } finally { store.close(); }
  });

  test('③ re-verifies before delete — rows changed or added between the copy and delete commits stay in the operating ledger', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source);
    new MsgStore(archive).close(); // r3-Terra-② — 보관 원장은 명시적으로 먼저 만든다(부재 시 이행 전 안전 중단 계약)
    const now = new Date('2026-11-22T03:00:00.000Z');
    const oldIso = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    try {
      const aged = (body: string) => {
        const message = store.post({ from: 'OP', to: 'TC', body });
        store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(oldIso, message.id);
        store.ack('TC', message.id);
        return message;
      };
      const steady = aged('steady');
      const raced = aged('raced'); // 복사 뒤 새 영수가 붙는다
      const edited = aged('edited'); // 복사 뒤 내용이 바뀐다
      let hookCalls = 0;
      const first = archiveDeliveredRows(store, archive, {
        days: MSG_ARCHIVE_DEFAULT_DAYS, now,
        betweenTransactions: () => {
          hookCalls += 1;
          expect(store.db.inTransaction).toBe(false); // 후크는 두 커밋 사이(트랜잭션 밖)에서만 실행된다
          store.db.query('INSERT INTO msg_receipts (message_id, recipient, state, at, source) VALUES (?, ?, ?, ?, ?)')
            .run(raced.id, 'TC', 'delivered', now.toISOString(), 'archive-test');
          store.db.query('UPDATE msg_messages SET body = ? WHERE id = ?').run('edited-after-copy', edited.id);
        },
      });
      expect(hookCalls).toBe(1); // 출처: #39557
      expect(first.archived).toBe(1); // 출처: #39557 — steady 만 이동
      expect(store.getMessage(steady.id)).toBeNull();
      expect(store.getMessage(raced.id)?.body).toBe('raced'); // 새 영수가 붙은 행은 운영에 남는다
      expect(store.getMessage(edited.id)?.body).toBe('edited-after-copy'); // 바뀐 행도 운영에 남는다
      expect(((store.db.query('SELECT COUNT(*) AS count FROM msg_receipts WHERE message_id = ?').get(raced.id)) as { count: number }).count).toBe(2); // 출처: #39557 — 원영수+새영수 전부 보존
      const mid = new MsgStore(archive, { readOnly: true, now: () => now });
      try {
        expect(((mid.db.query('SELECT COUNT(*) AS count FROM msg_receipts WHERE message_id = ?').get(raced.id)) as { count: number }).count).toBe(1); // 출처: #39557 — 복사 시점 원영수만
        expect(mid.getMessage(edited.id)?.body).toBe('edited'); // 복사 시점 내용
      } finally { mid.close(); }
      // 재실행(후크 없음) — r5 무손실 격리: edited 는 보관본과 달라 그 행만 건너뛰고, raced 는 재이행되어 이동한다.
      const rerun = archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now }); // 출처: #128692
      expect(rerun.skippedConflicts.messages).toBe(1); // 출처: #128692 — edited 격리
      expect(rerun.archived).toBe(1); // 출처: #128692 — raced 는 이행이 막히지 않는다
      expect(store.getMessage(edited.id)?.body).toBe('edited-after-copy'); // 격리된 행은 운영에 남는다
      expect(store.getMessage(raced.id)).toBeNull(); // raced 는 이동
      const after = new MsgStore(archive, { readOnly: true, now: () => now });
      try {
        expect(after.getMessage(edited.id)?.body).toBe('edited'); // 보관본은 그대로
        expect(((after.db.query('SELECT COUNT(*) AS count FROM msg_receipts WHERE message_id = ?').get(raced.id)) as { count: number }).count).toBe(2); // 출처: #128692 — raced 영수 2건 전부 보관
      } finally { after.close(); }
    } finally { store.close(); }
  });

  test('①③ preserves archive-only children — a leftover receipt gone from the operating ledger keeps its archived copy, and the message still moves', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source);
    const now = new Date('2026-11-22T03:00:00.000Z');
    const oldIso = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    try {
      const once = store.post({ from: 'OP', to: 'TC', body: 'once' });
      store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(oldIso, once.id);
      store.ack('TC', once.id);
      // 중단된 이행의 잔여: 메시지+영수가 보관에 복사돼 있고, 그 뒤 운영에서 영수가 정리됐다.
      const leftover = new MsgStore(archive);
      try {
        leftover.db.exec(`ATTACH DATABASE '${source.replace(/'/g, "''")}' AS live_src`);
        leftover.db.query('INSERT INTO msg_messages SELECT * FROM live_src.msg_messages WHERE id = ?').run(once.id);
        leftover.db.query('INSERT INTO msg_receipts SELECT * FROM live_src.msg_receipts WHERE message_id = ?').run(once.id);
        leftover.db.exec('DETACH DATABASE live_src');
      } finally { leftover.close(); }
      store.db.query('DELETE FROM msg_receipts WHERE message_id = ?').run(once.id); // 운영본에 없는 보관 자식
      const outcome = archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now });
      expect(outcome.archived).toBe(1); // 출처: #39557 — 메시지는 이동한다
      expect(store.getMessage(once.id)).toBeNull();
      expect(((store.db.query('SELECT COUNT(*) AS count FROM msg_receipts WHERE message_id = ?').get(once.id)) as { count: number }).count).toBe(0); // 출처: #39557 — 운영엔 원래 없다
      const check = new MsgStore(archive, { readOnly: true, now: () => now });
      try {
        expect(check.getMessage(once.id)?.body).toBe('once');
        expect(((check.db.query('SELECT COUNT(*) AS count FROM msg_receipts WHERE message_id = ?').get(once.id)) as { count: number }).count).toBe(1); // 출처: #39557 — 보관 자식은 유실되지 않는다(보존)
      } finally { check.close(); }
    } finally { store.close(); }
  });

  test('① skips archive-only child tables — a table the operating ledger no longer has is not queried, its archived rows stay, and the message still moves', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source);
    const now = new Date('2026-11-22T03:00:00.000Z');
    const oldIso = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    try {
      const once = store.post({ from: 'OP', to: 'TC', body: 'once' });
      store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(oldIso, once.id);
      store.ack('TC', once.id);
      // 역방향 스키마 차이: 운영에서 사라진 자식 표는 보관에만 남는다 — 이행은 그 표를 조회하지 않는다.
      store.db.exec('DROP TABLE msg_ta_claim');
      const keeper = new MsgStore(archive);
      try { keeper.db.query('INSERT INTO msg_ta_claim (request_id, token) VALUES (?, ?)').run(once.id, 'kept-token'); }
      finally { keeper.close(); }
      const outcome = archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now });
      expect(outcome.archived).toBe(1); // 출처: #39557 — 보관 전용 표는 이행을 깨지 않는다
      expect(store.getMessage(once.id)).toBeNull(); // 출처: #39557 — 메시지는 이동한다
      const check = new MsgStore(archive, { readOnly: true, now: () => now });
      try {
        expect(check.getMessage(once.id)?.body).toBe('once');
        expect(((check.db.query('SELECT token FROM msg_ta_claim WHERE request_id = ?').get(once.id)) as { token: string }).token).toBe('kept-token'); // 출처: #39557 — 보관 전용 표의 행은 그대로 보존된다
      } finally { check.close(); }
    } finally { store.close(); }
  });

  test('① r5 isolates conflicting child rows losslessly — a same-key different-content receipt skips that row only, keeps both ledgers intact, and other rows still move', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source);
    const now = new Date('2026-11-22T03:00:00.000Z');
    const oldIso = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    try {
      const once = store.post({ from: 'OP', to: 'TC', body: 'once' });
      const steady = store.post({ from: 'OP', to: 'TC', body: 'steady' });
      for (const m of [once, steady]) {
        store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(oldIso, m.id);
        store.ack('TC', m.id);
      }
      // 잔여 복사(메시지+영수) 뒤 보관 영수의 state 를 바꾼다 — 같은 키, 다른 내용.
      const leftover = new MsgStore(archive);
      try {
        leftover.db.exec(`ATTACH DATABASE '${source.replace(/'/g, "''")}' AS live_src`);
        leftover.db.query('INSERT INTO msg_messages SELECT * FROM live_src.msg_messages WHERE id = ?').run(once.id);
        leftover.db.query('INSERT INTO msg_receipts SELECT * FROM live_src.msg_receipts WHERE message_id = ?').run(once.id);
        leftover.db.exec('DETACH DATABASE live_src');
        leftover.db.query('UPDATE msg_receipts SET state = ? WHERE message_id = ?').run('seen', once.id);
      } finally { leftover.close(); }
      const outcome = archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now }); // 출처: #128692 — 충돌해도 중단하지 않는다
      expect(outcome.skippedConflicts.childRows).toBe(1); // 출처: #128692 — 충돌 영수 1건 격리
      expect(outcome.archived).toBe(1); // 출처: #128692 — steady 는 이행이 막히지 않는다
      expect(store.getMessage(once.id)?.body).toBe('once'); // 운영 원장 무손실 — 충돌 메시지는 남는다
      expect(((store.db.query('SELECT COUNT(*) AS count FROM msg_receipts WHERE message_id = ?').get(once.id)) as { count: number }).count).toBe(1); // 출처: #39557 — 운영 영수 그대로
      const check = new MsgStore(archive, { readOnly: true, now: () => now });
      try {
        expect(((check.db.query('SELECT state FROM msg_receipts WHERE message_id = ?').get(once.id)) as { state: string }).state).toBe('seen'); // 출처: #39557 — 보관 행은 덮어쓰이지 않았다
        expect(check.getMessage(steady.id)?.body).toBe('steady'); // 출처: #128692 — 정상 행은 이동
      } finally { check.close(); }
    } finally { store.close(); }
  });
});
// r5 — OP #128692 ②: 완료선 «미읽음 17자리 1회 <5ms» 를 정확 head 에서 원문 측정한다(운영 원장에
// 17개 자리가 미읽음을 갖는 상태에서 readUnreadMailBadgesOn 1회 호출의 wall-clock 원문).
  test('② badge latency — one readUnreadMailBadgesOn call over 17 unread seats stays under 5ms (OP #128692 completion line)', () => {
    const { source } = paths();
    const store = new MsgStore(source);
    try {
      const SEATS = ['OP','TC','MK','UX','JUD','JUD-B','JUD-C','MOB-1','MVP-B','RES','RES-INFRA','N04','CX-13','TA-ELS','HAND-TUI-D','HAND-ELN-ELS-API','mbp'] as const; // 17자리
      for (const seat of SEATS) {
        const message = store.post({ from: 'OP', to: seat, body: `unread-${seat}` });
        store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?', ).run('2020-01-01T00:00:00.000Z', message.id); // 미읽음 유지
      }
      const before = performance.now();
      const { badges, error } = readUnreadMailBadgesOn(store.db, SEATS);
      const elapsedMs = performance.now() - before;
      expect(error).toBeNull();
      expect(badges.size).toBe(17);
      for (const seat of SEATS) expect(badges.get(seat)?.count).toBe(1); // UnreadMailBadge.count (msg-store.ts:1300 · main #39557 시험과 동일 계약)
      console.log(`BADGE-LATENCY-17 one call = ${elapsedMs.toFixed(3)}ms (must be < 5ms)`); // 원문 측정 출력
      expect(elapsedMs).toBeLessThan(5); // 완료선 — 정확 head 원문 측정
    } finally { store.close(); }
  });

  // r3-Terra-② — 보관 원장 부재 시 이행 전에 안전 중단한다: MsgStore 생성자가 새 DB 를 만들지 않게,
  // 그리고 운영 원장은 한 행도 변하지 않는다(«부재 시 이동 중단·원장 무변경» 실패 경로).
  test('② aborts before the move when the archive ledger is missing — no file created, ledger unchanged', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source);
    const now = new Date('2026-11-22T03:00:00.000Z');
    const oldIso = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    try {
      const delivered = store.post({ from: 'OP', to: 'TC', body: 'missing-archive-stays' });
      store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(oldIso, delivered.id);
      store.ack('TC', delivered.id);
      const cursorBefore = store.getCursor('TC');
      expect(() => archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now }))
        .toThrow(/archive ledger not found/);
      expect(existsSync(archive)).toBe(false); // 새 DB 를 만들지 않았다
      expect(store.getMessage(delivered.id)?.body).toBe('missing-archive-stays'); // 원장 무변경
      expect(store.getCursor('TC')).toBe(cursorBefore); // 커서 무변경
    } finally { store.close(); }
  });

  // r3-Terra-③ — 이동 행이 없는 실행은 무관한 좌석의 커서를 절대 바꾸지 않는다: stale 커서를 가진
  // 방관자 좌석은 이행이 아무것도 옮기지 않으면(전부 최근 행) 그 커서 그대로 남는다.
  test('③ tidy touches only seats whose rows actually moved — an unrelated stale cursor is left alone', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source);
    new MsgStore(archive).close(); // 보관 원장을 미리 만들어 둔다(② 부재 중단과 독립)
    const now = new Date('2026-11-22T03:00:00.000Z');
    try {
      // 방관자 TC: 오래된 미읽음 1행 — 이행 대상이 아니지만 stale 커서(0)를 가진다.
      const byStander = store.post({ from: 'OP', to: 'TC', body: 'bystander-recent-unread' });
      store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', byStander.id);
      const outcome = archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now });
      expect(outcome.archived).toBe(0); // 이동 행 0
      expect(outcome.cursors).toEqual({}); // 정리 대상 없음
      expect(store.getCursor('TC')).toBe(0); // 무관 좌석 커서 무변경
      expect(store.getMessage(byStander.id)?.id).toBe(byStander.id); // 행도 그대로
    } finally { store.close(); }
  });
