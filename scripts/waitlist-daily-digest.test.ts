import { expect, test } from 'bun:test';
import { formatDigest, runWaitlistDigest, type WaitlistContact } from './waitlist-daily-digest.js';

const c = (id: string, email: string, extra: Partial<WaitlistContact> = {}): WaitlistContact => ({ id, email, created_at: '2026-09-28 04:29:51.000000+00', ...extra });

test('첫 보고는 기준선만 — 새로 온 분 목록 없이 전체 수', async () => {
  const sent: string[] = []; let state: unknown = null;
  const r = await runWaitlistDigest({
    fetchContacts: async () => [c('1', 'a@x.com'), c('2', 'b@x.com')],
    readState: () => null, writeState: (s) => { state = s; }, send: (t) => { sent.push(t); return true; },
  });
  expect(r).toEqual({ sent: true, total: 2, fresh: 0 });
  expect(sent[0]).toContain('전체 **2**명');
  expect(sent[0]).toContain('첫 보고');
  expect((state as { seen: string[] }).seen).toEqual(['1', '2']);
});

test('다음 날은 새로 확인된 분만 목록으로 · 해지는 전체 수에서 빠진다', async () => {
  const sent: string[] = [];
  const r = await runWaitlistDigest({
    fetchContacts: async () => [c('1', 'a@x.com'), c('2', 'b@x.com', { unsubscribed: true }), c('3', 'new@x.com')],
    readState: () => ({ seen: ['1', '2'] }), writeState: () => {}, send: (t) => { sent.push(t); return true; },
  });
  expect(r.fresh).toBe(1);
  expect(sent[0]).toContain('전체 **2**명 · 해지 1');
  expect(sent[0]).toContain('new@x.com');
  expect(sent[0]).not.toContain('a@x.com');
  expect(sent[0]).toContain('13:29 KST');
});

test('새 사람이 없어도 하루 한 번 수는 보낸다', () => {
  expect(formatDigest([c('1', 'a@x.com')], new Set(['1']), false)).toContain('새로 확인된 분: 없음');
});

test('조회 실패도 알리고 키 모양 문자열은 가린다 · 발송 실패면 상태를 전진시키지 않는다', async () => {
  const sent: string[] = [];
  await runWaitlistDigest({
    fetchContacts: async () => { throw new Error('bad re_ABCdef123 token'); },
    readState: () => null, writeState: () => { throw new Error('should not write'); }, send: (t) => { sent.push(t); return true; },
  });
  expect(sent[0]).toContain('조회 실패');
  expect(sent[0]).not.toContain('re_ABCdef123');
  let wrote = false;
  const r = await runWaitlistDigest({
    fetchContacts: async () => [c('9', 'z@x.com')], readState: () => ({ seen: [] }),
    writeState: () => { wrote = true; }, send: () => false,
  });
  expect(r.sent).toBe(false);
  expect(wrote).toBe(false);
});
