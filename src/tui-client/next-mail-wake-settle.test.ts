// #38284 REVIEW ③ — a mail turn that ends without onSettled (thrown before it started) must not leave its batch «started»:
// entry's settle() reports «no answer» first (noteTurnFinished(false)), so the NEXT person's answered turn never marks the
// earlier mail seen. Real ledger · fake clock · no timers.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNextMailWake, IDLE_MAIL_WATCH_MS, ledgerRecordSeen } from './next-mail-wake.js';
import { MsgStore, readUnreadSource } from '../msg/msg-store.js';

test('a mail turn ended by settle() alone (no onSettled) is «no answer»: the next answered turn marks nothing seen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-wake-settle-'));
  const path = join(dir, 'messages.db');
  const store = new MsgStore(path);
  try {
    const posted = store.post({ from: 'OP', to: 'TC', body: 'do X' });
    const now = 1_000_000;
    const wake = createNextMailWake({ seat: 'TC', enabled: true, intervalMs: IDLE_MAIL_WATCH_MS, log: () => {}, now: () => now,
      readUnread: () => ({ count: store.unreadCount('TC'), maxId: posted.id }), readSource: (seat) => readUnreadSource(seat, path),
      recordSeen: ledgerRecordSeen(path), startTurnIfIdle: () => ({ opened: true, turnId: 'auto-1' }) });
    wake.poll();
    wake.confirmDelivery(); // the input loop took the mail turn …
    wake.noteTurnFinished(false); // … it threw before starting: entry's settle() reports «no answer» first
    wake.noteTurnFinished(true); // the person's next turn answers — it must not mark the earlier mail seen
    expect(store.listReceipts({ messageId: posted.id }).map(r => r.state)).toEqual(['posted']);
    expect(store.unreadCount('TC')).toBe(1);
    wake.dispose();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('entry settle() reports «no answer» before anything else (the path that ends without onSettled)', () => {
  const entry = readFileSync(join(import.meta.dir, '..', 'tui', 'entry.ts'), 'utf8');
  const settle = entry.slice(entry.indexOf('const settle = (turn?: NextTuiSettledTurn): void => {'));
  const body = settle.slice(0, settle.indexOf('\n  };'));
  expect(body).toContain('wakeup?.noteTurnFinished(false);');
  const [first] = body.split('queue.settle(');
  expect(first).toContain('wakeup?.noteTurnFinished(false);');
});
