import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from './msg-store.js';
import { MSG_RECEIPTS_SCHEMA, receiptReaches, receiptsCheckNeedsStart } from './msg-receipts.js';

// ELS-ORCH-TASK-ENVELOPE §1-2 (OP #134881 · PREAD-134319) — the reply-chain envelope:
// `correlationId` ties one chain's replies together (independent of the `reply_to` thread), the
// receipt ladder gains `started` between seen and accepted (CHECK migration included), and
// `collect` returns a chain's replies with per-sender receipts and resolution counts.

const FIXED = new Date('2026-11-24T00:00:00.000Z');
const ledger = (): MsgStore => new MsgStore(':memory:', { now: () => FIXED });

describe('ELS-ORCH-TASK-ENVELOPE — the reply-chain envelope', () => {
  test('① mail without a correlationId keeps the legacy shape — the optional field stays unused', () => {
    const store = ledger();
    try {
      const original = store.post({ from: 'OP', to: 'MK', body: 'a plain request' });
      const reply = store.post({ from: 'MK', to: 'OP', body: 'a plain answer', replyTo: original.id });
      expect(reply.correlationId).toBeUndefined();
      expect(reply.result).toBeUndefined();
      expect(store.list('MK').map(message => message.id)).toEqual([original.id]);
      expect(store.listThread(original.id).map(message => message.id)).toEqual([original.id, reply.id]);
    } finally { store.close(); }
  });

  test('② a reply inherits the original correlationId — an explicit one wins, none stays absent', () => {
    const store = ledger();
    try {
      const original = store.post({ from: 'OP', to: 'MK', body: 'the chain request', correlationId: 'chain-1' });
      const reply = store.post({ from: 'MK', to: 'OP', body: 'the answer', replyTo: original.id });
      expect(reply.correlationId).toBe('chain-1');
      expect(store.listThread(original.id).find(message => message.id === reply.id)?.correlationId).toBe('chain-1');
      const explicit = store.post({ from: 'TC', to: 'OP', body: 'an explicit correlation wins', replyTo: original.id, correlationId: 'chain-9' });
      expect(explicit.correlationId).toBe('chain-9');
      const uncorrelated = store.post({ from: 'OP', to: 'MK', body: 'no correlation anywhere' });
      expect(store.post({ from: 'MK', to: 'OP', body: 'still none', replyTo: uncorrelated.id }).correlationId).toBeUndefined();
    } finally { store.close(); }
  });

  test('③ a `started` receipt climbs between seen and accepted, and never downgrades', () => {
    const store = ledger();
    try {
      const original = store.post({ from: 'OP', to: 'MK', body: 'work request' });
      const record = (state: 'delivered' | 'seen' | 'started' | 'accepted') =>
        store.recordReceipt({ messageId: original.id, recipient: 'MK', state, source: 'cli', evidence: 'the claim' });
      expect(record('delivered')).toMatchObject({ recorded: true });
      expect(record('seen')).toMatchObject({ recorded: true });
      expect(record('started')).toMatchObject({ recorded: true });
      expect(record('accepted')).toMatchObject({ recorded: true });
      expect(record('started')).toMatchObject({ recorded: false, reason: 'not-forward' });
      expect(record('seen')).toMatchObject({ recorded: false, reason: 'not-forward' });
    } finally { store.close(); }
  });

  test('④ skipping `started` stays tolerant — delivered→done straight still ends a seen follow', () => {
    const store = ledger();
    try {
      const original = store.post({ from: 'OP', to: 'TC', body: 'work request' });
      expect(store.recordReceipt({ messageId: original.id, recipient: 'TC', state: 'delivered', source: 'cli' })).toMatchObject({ recorded: true });
      expect(store.recordReceipt({ messageId: original.id, recipient: 'TC', state: 'done', source: 'cli', evidence: 'the proof' })).toMatchObject({ recorded: true });
      expect(receiptReaches('done', 'seen')).toBe(true);
      expect(receiptReaches('started', 'seen')).toBe(false);
      expect(receiptReaches('started', 'started')).toBe(true);
    } finally { store.close(); }
  });

  test('⑤ collect `first` returns at the first done reply and counts the rest pending', async () => {
    const store = ledger();
    try {
      const original = store.post({ from: 'OP', to: 'MK', body: 'fan-out', correlationId: 'collect-1' });
      const doneReply = store.post({ from: 'MK', to: 'OP', body: 'the done answer', replyTo: original.id, result: { state: 'done', summary: 'finished' } });
      const pendingReply = store.post({ from: 'TC', to: 'OP', body: 'still working', replyTo: original.id });
      expect(store.recordReceipt({ messageId: original.id, recipient: 'MK', state: 'started', source: 'cli' })).toMatchObject({ recorded: true });
      const collected = await store.collect('collect-1', { join: 'first' });
      expect(collected.timedOut).toBe(false);
      expect(collected.done).toBe(1);
      expect(collected.failed).toBe(0);
      expect(collected.pending).toBe(1);
      expect(collected.replies.map(message => message.id)).toEqual([doneReply.id, pendingReply.id]);
      expect(collected.receipts).toEqual({ MK: 'started' });
    } finally { store.close(); }
  });

  test('⑥ collect `all` closes on every reply — an expired sender is the partial result, not pending', async () => {
    const store = ledger();
    try {
      // receipts only land on a message's own addressees (recordReceipt enforces it) — a fan-out
      // is one original per seat, all sharing the correlationId.
      const one = store.post({ from: 'OP', to: 'MK', body: 'fan-out one', correlationId: 'collect-2' });
      const two = store.post({ from: 'OP', to: 'TC', body: 'fan-out two', correlationId: 'collect-2' });
      const three = store.post({ from: 'OP', to: 'UX', body: 'fan-out three', correlationId: 'collect-2' });
      store.post({ from: 'MK', to: 'OP', body: 'done one', replyTo: one.id, result: { state: 'done', summary: 'one' } });
      store.post({ from: 'TC', to: 'OP', body: 'done two', replyTo: two.id, result: { state: 'done', summary: 'two' } });
      const expiredReply = store.post({ from: 'UX', to: 'OP', body: 'never resolved — my follow expired', replyTo: three.id });
      expect(store.recordReceipt({ messageId: three.id, recipient: 'UX', state: 'expired', source: 'cli', evidence: 'the follow expired' })).toMatchObject({ recorded: true });
      const collected = await store.collect('collect-2', { join: 'all' });
      expect(collected.timedOut).toBe(false);
      expect(collected.done).toBe(2);
      expect(collected.failed).toBe(0);
      expect(collected.pending).toBe(0);
      expect(collected.replies).toHaveLength(3);
      expect(collected.receipts).toEqual({ MK: 'posted', TC: 'posted', UX: 'expired' });
      expect(collected.replies.find(message => message.id === expiredReply.id)?.result).toBeUndefined();
    } finally { store.close(); }
  });

  test('⑦ collect `quorum` returns the moment N done replies arrive — the remainder stays pending', async () => {
    const store = ledger();
    try {
      const original = store.post({ from: 'OP', to: 'MK', body: 'fan-out three', correlationId: 'collect-3' });
      store.post({ from: 'MK', to: 'OP', body: 'done one', replyTo: original.id, result: { state: 'done', summary: 'one' } });
      store.post({ from: 'TC', to: 'OP', body: 'done two', replyTo: original.id, result: { state: 'done', summary: 'two' } });
      store.post({ from: 'UX', to: 'OP', body: 'still working', replyTo: original.id });
      const collected = await store.collect('collect-3', { join: 'quorum', quorum: 2 });
      expect(collected.timedOut).toBe(false);
      expect(collected.done).toBe(2);
      expect(collected.failed).toBe(0);
      expect(collected.pending).toBe(1);
      expect(collected.replies).toHaveLength(3);
    } finally { store.close(); }
  });

  test('⑧ a collect timeout returns the partial result — timedOut true, never a throw', async () => {
    const store = ledger();
    try {
      const original = store.post({ from: 'OP', to: 'MK', body: 'slow worker', correlationId: 'collect-4' });
      const reply = store.post({ from: 'MK', to: 'OP', body: 'no result yet', replyTo: original.id });
      const startedAt = Date.now();
      const collected = await store.collect('collect-4', { join: 'first', timeoutMs: 40 }); // 출처: #39920 — ⑧ 실제 만료 검증용 짧은 실측 상한(40ms). 근거 주석.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40); // 출처: #39920 — 같은 40ms 만료 하한을 실시계로 실측. 근거 주석.
      expect(collected.timedOut).toBe(true);
      expect(collected.done).toBe(0);
      expect(collected.failed).toBe(0);
      expect(collected.pending).toBe(1);
      expect(collected.replies.map(message => message.id)).toEqual([reply.id]);
    } finally { store.close(); }
  });

  test('⑨ a bare store (no options) keeps every existing read path — collect on an unknown chain is empty', async () => {
    const store = new MsgStore(':memory:');
    try {
      const original = store.post({ from: 'OP', to: 'MK', body: 'a plain request' });
      expect(store.unreadCount('MK')).toBe(1);
      expect(store.getCursor('MK')).toBe(0);
      expect(store.list('MK').map(message => message.id)).toEqual([original.id]);
      expect(store.listThread(original.id)).toHaveLength(1);
      const collected = await store.collect('no-such-chain');
      expect(collected).toEqual({ replies: [], receipts: {}, done: 0, failed: 0, pending: 0, timedOut: false });
    } finally { store.close(); }
  });

  test('⑩ the completion line — a migrated old-CHECK ledger stores `started` and round-trips correlationId and result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'msg-envelope-collect-'));
    const path = join(dir, 'messages.db');
    const pre = new Database(path);
    pre.exec(MSG_RECEIPTS_SCHEMA.replace(",'started'", '')); // the pre-upgrade 8-state CHECK lives on
    // 900001/900002 — fixture ids, far beyond any live id in this fresh ledger
    pre.exec(`INSERT INTO msg_receipts(message_id, recipient, state, at, source) VALUES
      (900001, 'MK', 'delivered', '2026-11-20T00:00:00.000Z', 'cli'),
      (900002, 'TC', 'seen', '2026-11-21T00:00:00.000Z', 'cli')`);
    pre.close();
    const store = new MsgStore(path, { now: () => FIXED });
    try {
      expect(receiptsCheckNeedsStart(store.db)).toBe(false); // the open rebuilt the 8-state CHECK away
      expect((store.db.query('SELECT id, message_id, recipient, state FROM msg_receipts ORDER BY id ASC').all() as Array<{ id: number; message_id: number; recipient: string; state: string }>)).toEqual([
        { id: 1, message_id: 900001, recipient: 'MK', state: 'delivered' },
        { id: 2, message_id: 900002, recipient: 'TC', state: 'seen' },
      ]);
      const original = store.post({ from: 'OP', to: 'MK', body: 'the chain request', correlationId: 'roundtrip-1' });
      expect(store.recordReceipt({ messageId: original.id, recipient: 'MK', state: 'started', source: 'cli' })).toMatchObject({ recorded: true });
      const reply = store.post({ from: 'MK', to: 'OP', body: 'the answer', replyTo: original.id, result: { state: 'done', artifacts: [{ path: 'out/run.json', sha: 'deadbeef' }], summary: 'the run finished' } });
      expect(reply.correlationId).toBe('roundtrip-1');
      expect(reply.result).toEqual({ state: 'done', artifacts: [{ path: 'out/run.json', sha: 'deadbeef' }], summary: 'the run finished' });
      const readBack = store.listThread(original.id).find(message => message.id === reply.id);
      expect(readBack?.correlationId).toBe('roundtrip-1');
      expect(readBack?.result).toEqual(reply.result);
    } finally { store.close(); }
  });

  test('⑪ an unanswered fan-out addressee holds `all` to the wall clock — a silent chain is the same wait, never an early empty return', async () => {
    const store = ledger();
    try {
      const one = store.post({ from: 'OP', to: 'MK', body: 'fan-out one', correlationId: 'collect-5' });
      store.post({ from: 'OP', to: 'TC', body: 'fan-out two', correlationId: 'collect-5' });
      const reply = store.post({ from: 'MK', to: 'OP', body: 'done one', replyTo: one.id, result: { state: 'done', summary: 'one' } });
      const startedAt = Date.now();
      const collected = await store.collect('collect-5', { join: 'all', timeoutMs: 40 }); // 출처: #140802 — 미회신 addressee(TC)가 all을 벽시계까지 붙잡는 실측 상한(40ms).
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40); // 출처: #140802 — 같은 40ms 만료 하한을 실시계로 실측.
      expect(collected.timedOut).toBe(true);
      expect(collected.done).toBe(1);
      expect(collected.failed).toBe(0);
      expect(collected.pending).toBe(1);
      expect(collected.replies.map(message => message.id)).toEqual([reply.id]);
      store.post({ from: 'OP', to: 'UX', body: 'fan-out three', correlationId: 'collect-6' });
      const zero = await store.collect('collect-6', { join: 'all', timeoutMs: 40 }); // 출처: #140802 — 회신 0건도 즉시 빈 반환 아님: 미회신 1이 벽시계까지 대기(40ms).
      expect(zero.timedOut).toBe(true);
      expect(zero.done).toBe(0);
      expect(zero.pending).toBe(1);
      expect(zero.replies).toEqual([]);
    } finally { store.close(); }
  });

  test('⑫ an expired addressee with no reply terminates the `all` wait — a still-live receipt holds it to the wall clock', async () => {
    const store = ledger();
    try {
      const one = store.post({ from: 'OP', to: 'MK', body: 'fan-out one', correlationId: 'collect-7' });
      const two = store.post({ from: 'OP', to: 'UX', body: 'fan-out two', correlationId: 'collect-7' });
      store.post({ from: 'MK', to: 'OP', body: 'done one', replyTo: one.id, result: { state: 'done', summary: 'one' } });
      expect(store.recordReceipt({ messageId: two.id, recipient: 'UX', state: 'expired', source: 'cli', evidence: 'the follow expired' })).toMatchObject({ recorded: true });
      const startedAt = Date.now();
      const collected = await store.collect('collect-7', { join: 'all', timeoutMs: 40 }); // 출처: #39920 — 재판정(judb-471e820a4007) mustFix: 만료(UX) 미회신 addressee가 all을 40ms 벽시계까지 붙잡는지 실측.
      expect(Date.now() - startedAt).toBeLessThan(40); // 출처: #39920 — 재판정(judb-471e820a4007) mustFix: 종결 반환은 만료 상한(40ms) 이전임을 실시계로 실측.
      expect(collected.timedOut).toBe(false);
      expect(collected.done).toBe(1);
      expect(collected.failed).toBe(0);
      expect(collected.pending).toBe(0);
      expect(collected.receipts).toEqual({ MK: 'posted', UX: 'expired' });
      const three = store.post({ from: 'OP', to: 'TC', body: 'fan-out three', correlationId: 'collect-8' });
      expect(store.recordReceipt({ messageId: three.id, recipient: 'TC', state: 'started', source: 'cli', evidence: 'work began' })).toMatchObject({ recorded: true });
      const heldAt = Date.now();
      const held = await store.collect('collect-8', { join: 'all', timeoutMs: 40 }); // 출처: #39920 — 재판정(judb-471e820a4007) mustFix: 비만료(started) 미회신 addressee는 벽시계까지 대기 보존 실측(40ms).
      expect(Date.now() - heldAt).toBeGreaterThanOrEqual(40); // 출처: #39920 — 재판정(judb-471e820a4007) mustFix: 같은 40ms 만료 하한을 실시계로 실측.
      expect(held.timedOut).toBe(true);
      expect(held.done).toBe(0);
      expect(held.failed).toBe(0);
      expect(held.pending).toBe(1);
      expect(held.receipts).toEqual({ TC: 'started' });
    } finally { store.close(); }
  });
});