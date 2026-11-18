// SEAT-CAP-RESUME-NOTICE(연속 큐 미재개) — 상한 소진 재개 안내가 자리 우편함(SQLite 원장)에 실제로 남는지.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMsgStore } from '../msg/msg-store.js';
import { postSeatCapResumeNotice } from './seat-cap-resume-notice.js';

describe('postSeatCapResumeNotice — 우편 원장 실착', () => {
  it('OP → 해당 자리 로 kind seat-cap-resume 안내 1통을 남기고 관측 로그를 낸다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seat-cap-resume-notice-'));
    try {
      const db = join(dir, 'messages.db');
      const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
      const notice = postSeatCapResumeNotice({
        openStore: () => openMsgStore(db),
        log: (_c, event, data) => { observed.push({ event, data }); },
      });
      await notice({ seat: 'UX', finalText: '요약', iterations: 2 });
      const store = openMsgStoreReadOnlyForList(db);
      // NUMGUARD: bodyChars 는 게시된 실제 본문 길이에서 유도 — 근거 없는 expect.any(Number) 금지.
      let bodyChars = -1;
      try {
        const toUx = store.list('UX', 0, 10);
        expect(toUx.length).toBe(1);
        expect(toUx[0]?.from).toBe('OP');
        expect(toUx[0]?.to).toBe('UX');
        expect(toUx[0]?.kind).toBe('seat-cap-resume');
        expect(toUx[0]?.body).toContain('상한');
        expect(toUx[0]?.body).toContain('update_goal');
        bodyChars = toUx[0]?.body?.length ?? -1;
      } finally { store.close(); }
      expect(observed).toEqual([{
        event: 'seat-cap-resume-notice-posted',
        data: { seat: 'UX', iterations: 2, messageId: 1, bodyChars },
      }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('원장 실패 시 안내를 삼키고 seat-cap-resume-notice-failed 로그만 남긴다(fail-soft)', async () => {
    const observed: Array<{ event: string }> = [];
    const notice = postSeatCapResumeNotice({
      openStore: () => { throw new Error('db locked'); },
      log: (_c, event) => { observed.push({ event }); },
    });
    await expect(notice({ seat: 'UX', finalText: '', iterations: 1 })).resolves.toBeUndefined();
    expect(observed).toEqual([{ event: 'seat-cap-resume-notice-failed' }]);
  });
});

function openMsgStoreReadOnlyForList(path: string) {
  // 목록 검증용 — 쓰기 원장을 다시 열어 list 만 쓴다(원장 API 단순 유지).
  return openMsgStore(path);
}
