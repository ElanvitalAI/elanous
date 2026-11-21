import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { claimMailFallback, MSG_MAIL_FALLBACKS_SCHEMA, runMailFallback } from './msg-mail-fallback.js';
import { MsgStore } from './msg-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('equivalent recipient spellings claim once, while other recipients and messages remain independent', () => {
  const db = new Database(':memory:');
  try {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(claimMailFallback(db, 1, ' seat:coo ', now)).toBe(true);
    expect(claimMailFallback(db, 1, 'op', now)).toBe(false);
    expect(claimMailFallback(db, 1, 'MK', now)).toBe(true);
    expect(claimMailFallback(db, 2, 'OP', now)).toBe(true);
    expect(db.query('SELECT recipient FROM msg_mail_fallbacks WHERE message_id = 1 ORDER BY recipient').all()).toEqual([{ recipient: 'MK' }, { recipient: 'OP' }]);
  } finally { db.close(); }
});

test('legacy raw claims suppress canonical equivalents without blocking unrelated recipients', () => {
  const db = new Database(':memory:');
  try {
    db.exec(MSG_MAIL_FALLBACKS_SCHEMA);
    db.query('INSERT INTO msg_mail_fallbacks VALUES (?, ?, ?)').run(1, ' seat:coo ', 'old');
    db.query('INSERT INTO msg_mail_fallbacks VALUES (?, ?, ?)').run(1, 'invalid address!', 'old');
    expect(claimMailFallback(db, 1, 'OP', new Date())).toBe(false);
    expect(claimMailFallback(db, 1, 'MK', new Date())).toBe(true);
  } finally { db.close(); }
});

test('fallback checkers using aliases wake only once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fallback-canonical-'));
  const path = join(dir, 'messages.db');
  try {
    const writer = new MsgStore(path);
    const message = writer.post({ from: 'MK', to: 'OP', body: 'test' });
    writer.close();
    const knocks: string[] = [];
    const deps = { openStore: () => new MsgStore(path), sleep: async () => {}, wake: async (address: string) => { knocks.push(address); return { result: 'injected' }; } };
    expect(await runMailFallback({ messageId: message.id, recipient: 'seat:coo', from: 'MK' }, deps)).toBe('knocked');
    expect(await runMailFallback({ messageId: message.id, recipient: 'op', from: 'MK' }, deps)).toBe('already-knocked');
    expect(knocks).toEqual(['seat:coo']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
