import { describe, expect, test } from 'bun:test';
import { MsgStore } from './msg-store.js';

// SEAT-MAIL-EXCHANGE-FIX-1119 #24 — a sender-entrance reply (`options.dedupe === true`: `msg post`, MsgPost tool)
// auto-acks its replyTo original for the replying seat: one per-message ack row, cursors untouched, and the same
// #16 boundary everywhere else (`--no-dedupe` and programmatic posts, and originals not addressed to the replying
// seat — ALL, groups, another seat — never ack).
describe('SEAT-MAIL #24 — reply auto-acks the original for the replying seat', () => {
  test('① a sender-entrance reply auto-acks the original per-message and the cursor never moves', () => {
    const store = new MsgStore(':memory:');
    try {
      const original = store.post({ from: 'OP', to: 'MK', body: 'the original request' });
      expect(store.list('MK').map(message => message.id)).toEqual([original.id]);
      const cursorBefore = store.getCursor('MK');
      const reply = store.post({ from: 'MK', to: 'OP', body: 'the answer', replyTo: original.id }, { dedupe: true });
      expect(reply.autoAcked).toBe(original.id);
      expect(store.messageStatus('MK', original.id)).toBe('acked');
      expect(store.list('MK')).toEqual([]);
      expect(store.unreadCount('MK')).toBe(0);
      expect(store.getCursor('MK')).toBe(cursorBefore);
      expect(store.getCursor('OP')).toBe(0);
    } finally { store.close(); }
  });

  test('② sibling unread mail around the original stays unread — nothing is swallowed', () => {
    const store = new MsgStore(':memory:');
    try {
      const older = store.post({ from: 'OP', to: 'MK', body: 'older sibling' });
      const original = store.post({ from: 'OP', to: 'MK', body: 'the original request' });
      const newer = store.post({ from: 'OP', to: 'MK', body: 'newer sibling' });
      const reply = store.post({ from: 'MK', to: 'OP', body: 'the answer', replyTo: original.id }, { dedupe: true });
      expect(reply.autoAcked).toBe(original.id);
      expect(older.id).toBeLessThan(original.id);
      expect(newer.id).toBeGreaterThan(original.id);
      expect(store.list('MK').map(message => message.id)).toEqual([older.id, newer.id]);
      expect(store.unreadCount('MK')).toBe(2);
      expect(store.messageStatus('MK', older.id)).toBe('delivered');
      expect(store.messageStatus('MK', newer.id)).toBe('delivered');
    } finally { store.close(); }
  });

  test('③ a repeat inside the dedupe window stays suppressed while the original keeps its auto-ack', () => {
    const store = new MsgStore(':memory:');
    try {
      const original = store.post({ from: 'OP', to: 'MK', body: 'the original request' });
      const envelope = { from: 'MK', to: 'OP', body: 'the answer', replyTo: original.id };
      const first = store.post(envelope, { dedupe: true });
      expect(first.autoAcked).toBe(original.id);
      const repeat = store.post(envelope, { dedupe: true });
      expect(repeat.deduped).toBe(true);
      expect(repeat.id).toBe(first.id);
      expect(repeat.repeatCount).toBe(2);
      expect(repeat.autoAcked).toBe(original.id);
      expect(store.messageStatus('MK', original.id)).toBe('acked');
      expect(store.list('MK')).toEqual([]);
    } finally { store.close(); }
  });

  test('④ without replyTo, and for originals addressed to another seat or ALL, no ack row is written', () => {
    const store = new MsgStore(':memory:');
    try {
      const plain = store.post({ from: 'MK', to: 'OP', body: 'no reply target' }, { dedupe: true });
      expect(plain.autoAcked).toBeUndefined();
      const toOther = store.post({ from: 'OP', to: 'TC', body: 'addressed to TC' });
      const otherReply = store.post({ from: 'MK', to: 'OP', body: "reply to TC's mail", replyTo: toOther.id }, { dedupe: true });
      expect(otherReply.autoAcked).toBeUndefined();
      const broadcast = store.post({ from: 'OP', to: 'ALL', body: 'broadcast notice' });
      const broadcastReply = store.post({ from: 'MK', to: 'OP', body: 'reply to the broadcast', replyTo: broadcast.id }, { dedupe: true });
      expect(broadcastReply.autoAcked).toBeUndefined();
      expect(store.db.query('SELECT COUNT(*) AS count FROM msg_message_acks').get()).toEqual({ count: 0 });
      expect(store.messageStatus('TC', toOther.id)).toBe('delivered');
      expect(store.messageStatus('MK', broadcast.id)).toBe('delivered');
      expect(store.list('MK').map(message => message.id)).toEqual([broadcast.id]);
    } finally { store.close(); }
  });

  test('⑤ programmatic posts (no options, and dedupe: false) never auto-ack', () => {
    const store = new MsgStore(':memory:');
    try {
      const original = store.post({ from: 'OP', to: 'MK', body: 'the original request' });
      const bare = store.post({ from: 'MK', to: 'OP', body: 'programmatic reply', replyTo: original.id });
      expect(bare.autoAcked).toBeUndefined();
      const noDedupe = store.post({ from: 'MK', to: 'OP', body: 'sender entrance with --no-dedupe', replyTo: original.id }, { dedupe: false });
      expect(noDedupe.autoAcked).toBeUndefined();
      expect(store.db.query('SELECT COUNT(*) AS count FROM msg_message_acks').get()).toEqual({ count: 0 });
      expect(store.messageStatus('MK', original.id)).toBe('delivered');
      expect(store.list('MK').map(message => message.id)).toEqual([original.id]);
    } finally { store.close(); }
  });
});
