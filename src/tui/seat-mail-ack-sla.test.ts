import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { MsgStore } from '../msg/msg-store.js';
import { ensureReceiptClocksTable, getReceipt } from '../hq/msg-receipt-clocks.js';
import { recordReceiptClock } from '../hq/msg-receipt-clock-sink.js';
import { registerMsgListCommand } from '../cli/msg-list-cli.js';
import { createSeatMailInbox, seatTaskQueueFromPromptQueue, wireSeatMailToPlan } from './seat-mail-boot.js';
import { createNextTuiQueue } from './core/queue.js';

test('literal posted mail → recipient list → seen without acknowledgement, first timestamp preserved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-clock-')); const path = join(dir, 'msg.db');
  const store = new MsgStore(path);
  try {
    const mail = store.post({ from: 'OP', to: 'TC', body: 'literal body' });
    const lines: string[] = [];
    const list = async () => {
      const cli = new Command();
      registerMsgListCommand(cli.command('msg'), { openStore: () => new MsgStore(path), cacheReads: false,
        out: { log: line => lines.push(line), error: line => { throw new Error(line); } } });
      await cli.parseAsync(['node', 'eln', 'msg', 'list', '--to', 'TC']);
    };
    await list();
    expect(lines.join('\n')).toContain('literal body');
    const first = getReceipt(store.db, mail.id, 'TC')!;
    expect(first.seenAt).toBeDefined(); expect(first.startedAt).toBeUndefined();
    expect(store.getCursor('TC')).toBe(0);
    await list(); expect(getReceipt(store.db, mail.id, 'TC')!.seenAt).toBe(first.seenAt);
    expect(getReceipt(store.db, mail.id, 'OP')).toBeNull();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('literal wake injection writes started only on successful turn and preserves first value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-start-')); const path = join(dir, 'msg.db');
  const store = new MsgStore(path);
  try {
    ensureReceiptClocksTable(store.db);
    const mail = store.post({ from: 'OP', to: 'TC', body: 'wake literal' });
    let opened = false;
    const inbox = createSeatMailInbox({ seat: 'TC', msgPath: path, defer: () => {},
      startTurnIfIdle: () => opened ? { opened: true, turnId: 'turn-1' } : { opened: false, reason: 'NotIdle' } });
    inbox.noteTurnEnded(); expect(inbox.check().delivered).toBe(false);
    expect(getReceipt(store.db, mail.id, 'TC')?.startedAt).toBeUndefined();
    opened = true; inbox.noteTurnEnded(); expect(inbox.check().delivered).toBe(true);
    const first = getReceipt(store.db, mail.id, 'TC')!;
    expect(first.startedAt).toBeDefined(); expect(first.startedEventId).toBe('turn-1');
    recordReceiptClock(store.db, { messageId: mail.id, recipient: 'TC', event: 'started', eventId: 'turn-2' });
    expect(getReceipt(store.db, mail.id, 'TC')!.startedAt).toBe(first.startedAt);
    expect(getReceipt(store.db, mail.id, 'TC')!.startedEventId).toBe('turn-1'); inbox.stop();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('plan mail is started on dequeue, never on absorb', () => {
  const store = new MsgStore(':memory:');
  try {
    ensureReceiptClocksTable(store.db);
    const queue = createNextTuiQueue({ log: () => {} });
    const port = seatTaskQueueFromPromptQueue(queue, (messageId, eventId) => {
      recordReceiptClock(store.db, { messageId, recipient: 'TC', event: 'started', eventId });
    });
    const plan = wireSeatMailToPlan(port, { seat: 'TC', ledger: { list: (r, after) => store.list(r, after) } });
    const mail = store.post({ from: 'OP', to: 'TC', body: '구현 후 시험하고 보고' });
    plan.absorb();
    expect(getReceipt(store.db, mail.id, 'TC')?.startedAt).toBeUndefined();
    const taken = queue.dequeue(); expect(taken.kind).toBe('submit');
    expect(getReceipt(store.db, mail.id, 'TC')!.startedAt).toBeDefined();
  } finally { store.close(); }
});
