import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from './msg-store.js';
import { archiveDeliveredRows, MSG_ARCHIVE_DEFAULT_DAYS } from './msg-archive.js';

const dirs: string[] = [];
function paths(): { source: string; archive: string } {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-msg-thread-read-'));
  dirs.push(dir);
  return { source: join(dir, 'messages.db'), archive: join(dir, 'messages-archive.db') };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/**
 * MSG-LEDGER-ARCHIVE-THREAD-READ-FU ③ — 보관 이행 뒤에도 원문에 답장하고 스레드를 온전히 읽는다.
 * 읽기 폴백(운영 miss 시 보관 원장)은 archivePath 옵션을 준 store 에만 든다 — 옵션 없는 store 의
 * getMessage 는 이행 계약(#39606 «이동 행은 운영에서 null»)을 그대로 지킨다.
 */
describe('archived thread read (MSG-LEDGER-ARCHIVE-THREAD-READ-FU ③)', () => {
  test('a reply to an archived original posts, auto-acks, and the thread reads whole (live+archived merged)', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source, { archivePath: archive });
    new MsgStore(archive).close(); // 보관 원장은 명시적으로 먼저 만든다(#39606 r3-Terra-② 계약)
    const now = new Date('2026-11-22T13:00:00.000Z');
    try {
      const original = store.post({ from: 'OP', to: 'MVP-B', body: '원문', kind: 'question', intent: 'request', needsAck: true });
      store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?')
        .run(new Date(now.getTime() - 10 * 86_400_000).toISOString(), original.id);
      store.ack('MVP-B', original.id);
      const outcome = archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now });
      expect(outcome.archived).toBe(1);
      // 이행 계약 — 옵션 없는 store 의 getMessage 는 여전히 null(엄격), 폴백은 읽기 경로에만.
      const strict = new MsgStore(source);
      try { expect(strict.getMessage(original.id)).toBeNull(); } finally { strict.close(); }

      // ① 이행된 원문에 답장 post 성공(운영 miss → 보관 원장에서 원문 확인).
      const reply = store.post({ from: 'MVP-B', to: 'OP', body: '답장', replyTo: original.id }, { dedupe: true });
      expect(reply.id).toBeGreaterThan(original.id);
      // ④ auto-ack — 원문이 보관돼도 원문 to === 답장 from 이면 답장 좌석의 ack 행이 남는다.
      expect(reply.autoAcked).toBe(original.id);
      // 답장에 답장(루트가 아닌 답장 행에도) — 운영에 있는 행에 대한 답장은 그대로.
      const nested = store.post({ from: 'OP', to: 'MVP-B', body: '재답장', replyTo: reply.id });
      expect(nested.replyTo).toBe(reply.id);

      // ② listThread(보관 원문 id) — 루트(보관) + 직계 답장(운영)이 id 오름차순 한 배열로.
      // 깊이 1은 main 계약 그대로다(id = root OR reply_to = root) — 재답장은 listReplies(reply.id)로 접근.
      const thread = store.listThread(original.id);
      expect(thread.map(message => message.id)).toEqual([original.id, reply.id]);
      expect(thread[0]!.body).toBe('원문');
      // 보관된 답장 행 끝점에서도 같은 스레드가 예외 없이 읽힌다(root 로 환원 · main 계약 동일 모양).
      expect(store.listThread(reply.id).map(message => message.id)).toEqual([original.id, reply.id]);

      // ③ listReplies — 운영 행만 있는 시점: 원문(보관)에 대한 답장은 운영에서 나온다.
      expect(store.listReplies(original.id).map(message => message.id)).toEqual([reply.id]);
      expect(store.listReplies(reply.id).map(message => message.id)).toEqual([nested.id]);

      // ③′ 답장까지 전부 이행된 뒤 — 양쪽이 합쳐진다(운영·보관 분리 없이 한 스레드).
      // 답장들은 created_at 이 now 이후라 이행 술어(created_at ≤ cutoff)를 만족하지 않는다 —
      // 이행 자격을 만들려면 created_at 을 과거로 되돌리고 커서를 지나게 한다.
      store.db.query('UPDATE msg_messages SET created_at = ? WHERE id IN (?, ?)')
        .run(new Date(now.getTime() - 10 * 86_400_000).toISOString(), reply.id, nested.id);
      store.ack('OP', reply.id);
      store.ack('MVP-B', nested.id);
      const second = archiveDeliveredRows(store, archive, { days: MSG_ARCHIVE_DEFAULT_DAYS, now });
      const reloaded = new MsgStore(source, { archivePath: archive });
      try {
        expect(reloaded.listReplies(original.id).map(message => message.id)).toEqual([reply.id]);
        // main 계약(깊이 1): 루트 + 직계 답장. 재답장은 listReplies(reply.id)로.
        expect(reloaded.listThread(original.id).map(message => message.id)).toEqual([original.id, reply.id]);
        // 옵션 없는 store 는 종전 동작 그대로 — 이행된 답장 조회는 비어 있다(호환 계약).
        const strictAfter = new MsgStore(source);
        try { expect(strictAfter.listReplies(original.id)).toEqual([]); } finally { strictAfter.close(); }
      } finally { reloaded.close(); }
    } finally { store.close(); }
  });

  test('an absent or unreadable archive ledger never breaks the live store — reply target miss still rejects', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source, { archivePath: archive }); // 보관 원장 파일 없음
    try {
      const live = store.post({ from: 'OP', to: 'MVP-B', body: 'live' });
      expect(store.listReplies(live.id)).toEqual([]);
      expect(store.getMessage(live.id)?.body).toBe('live'); // 보관 부재 = 운영 동작 무변경
      let notFound = false;
      try { store.listThread(999); } catch (error) { notFound = error instanceof Error && error.message === 'message not found: #999'; }
      expect(notFound).toBe(true);
      let replyThrew = false;
      try { store.post({ from: 'MVP-B', to: 'OP', body: 'x', replyTo: 999 }); }
      catch (error) { replyThrew = error instanceof Error && error.message.includes('reply target not found'); }
      expect(replyThrew).toBe(true);
    } finally { store.close(); }
  });

  // JUD-B #39635 mustFix 회귀 — 실제로 읽기 불가(훼손 파일)·스키마 이상 보관 원장이
  // 운영 listReplies/listThread 를 깨지 않는다(연 파일은 try 밖 열기·PRAGMA·스키마 조회 전부 fail-soft).
  test('a corrupt (unreadable) archive ledger keeps live reads working', () => {
    const { source, archive } = paths();
    writeFileSync(archive, 'this is definitely not a sqlite database — 훼손된 보관 원장');
    const store = new MsgStore(source, { archivePath: archive });
    try {
      const live = store.post({ from: 'OP', to: 'MVP-B', body: 'live-corrupt' });
      // 보관 열기 실패는 폴백 없음(null) — 운영 조회·게시는 그대로.
      expect(store.getMessage(live.id)?.body).toBe('live-corrupt');
      expect(store.listReplies(live.id)).toEqual([]);
      expect(store.listThread(live.id).map(message => message.id)).toEqual([live.id]);
    } finally { store.close(); }
  });

  test('a live-opened archive ledger that later becomes unreadable keeps thread reads fail-soft', () => {
    const { source, archive } = paths();
    const store = new MsgStore(source, { archivePath: archive }); // 보관 파일 없음으로 시작
    try {
      const live = store.post({ from: 'OP', to: 'MVP-B', body: 'live-schema' });
      // 보관 파일을 나중에 훼손 상태로 만든 뒤(첫 열기 시도에서 fail-soft), 스키마 조회 경로도 빈 결과로 내린다.
      writeFileSync(archive, 'garbage schema — not sqlite');
      expect(store.listReplies(live.id)).toEqual([]);
      expect(store.listThread(live.id).map(message => message.id)).toEqual([live.id]);
      expect(store.getMessage(live.id)?.body).toBe('live-schema');
    } finally { store.close(); }
  });
});
