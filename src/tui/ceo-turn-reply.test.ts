import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMsgStore } from '../msg/msg-store.js';
import { postCeoTurnReply } from './ceo-turn-reply.js';
import { verifyCeoReplyProof } from '../els/ceo-reply-proof.js';

test('authenticated CEO turn metadata posts one OP reply to the exact chat-bound parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'ceo-reply-'));
  const path = join(root, 'mail.db');
  const secret = 'a'.repeat(64);
  const binding = { source: 'telegram', threadId: '5', messageId: '9', ingressId: 'b'.repeat(64), sessionId: 'session-1', turnRunId: 'run-1' };
  try {
    const store = openMsgStore(path);
    const other = store.post({ from: 'CEO', to: 'OP', body: 'other', refs: ['telegram-chat:6', 'telegram-message:9'] });
    const target = store.post({ from: 'CEO', to: 'OP', body: 'target', refs: ['telegram-chat:5', 'telegram-message:9'] });
    store.close();
    expect(postCeoTurnReply(binding, 'OP answer', secret, path)).toBe(true);
    expect(postCeoTurnReply(binding, 'OP answer', secret, path)).toBe(true);
    const after = openMsgStore(path);
    const rows = after.db.query("SELECT reply_to AS replyTo, body, refs_json AS refsJson FROM msg_messages WHERE sender = 'OP'").all() as Array<{ replyTo: number; body: string; refsJson: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ replyTo: target.id, body: 'OP answer' });
    expect(verifyCeoReplyProof(rows[0]!.refsJson, binding, target.id, 'OP answer', secret)).toEqual(binding);
    expect(verifyCeoReplyProof(rows[0]!.refsJson, binding, target.id, 'forged body', secret)).toBeNull();
    expect(rows[0]!.replyTo).not.toBe(other.id);
    expect(postCeoTurnReply({ ...binding, threadId: '7' }, 'wrong chat', secret, path)).toBe(false);
    expect(postCeoTurnReply({ ...binding, source: 'foreign' }, 'wrong source', secret, path)).toBe(false);
    after.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
