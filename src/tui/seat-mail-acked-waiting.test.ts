// FIELD4 candidate: a mail queued while another turn runs can be acked by that turn.
// The queued notice must not open a redundant turn after the acknowledgement.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import { createNextTuiQueue } from './core/queue.js';
import { createSeatMailArrivalWatcher } from './seat-mail-arrival.js';
import { readSeatMailMessages } from './seat-message-receipts.js';

test('an ack during an earlier turn removes its queued notice before the next turn', () => {
  const root = mkdtempSync(join(tmpdir(), 'field4-mail-'));
  const seat = 'SIMSEAT';
  const cwd = join(root, 'elanous-hq', 'seats', seat);
  const db = join(root, 'messages.db');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, 'elanous-hq', 'seat-state', seat), { recursive: true });
  const store = new MsgStore(db);
  const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  const watcher = createSeatMailArrivalWatcher(cwd, queue, {
    messages: { read: (dir, after) => readSeatMailMessages(dir, after, { home: root, msgPath: db, env: {} }) },
    log: () => {}, turnLifeLog: (name, data) => { events.push({ name, data }); },
  });
  try {
    watcher.poll();
    queue.enqueueNotice('boot notice', 'seat-mail');
    expect(queue.dequeue().kind).toBe('submit'); // q1 is now running
    const message = store.post({ from: 'OP', to: seat, body: 'ack this mail', intent: 'request' });
    watcher.poll(); // q2 waits while q1 runs
    expect(queue.items.map(item => item.msgId)).toEqual([message.id]);
    store.ackThroughSeen(seat, message.id, 'tool-ack');
    watcher.noteTurnFinished(true);
    expect(queue.dequeue()).toEqual({ kind: 'none' });
    expect(events).toContainEqual({ name: 'turn-life:event-while-busy', data: { source: 'seat-mail', action: 'drop', reason: 'already-acknowledged', eventId: message.id, itemId: 'q2' } });
  } finally {
    watcher.stop(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('unacknowledged sibling survives; an unreadable cursor never drops the notice', () => {
  const root = mkdtempSync(join(tmpdir(), 'field4-mail-boundary-'));
  const seat = 'SIMSEAT';
  const cwd = join(root, 'elanous-hq', 'seats', seat);
  const db = join(root, 'messages.db');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, 'elanous-hq', 'seat-state', seat), { recursive: true });
  const store = new MsgStore(db);
  const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  let failRead = false;
  let errors = 0;
  const watcher = createSeatMailArrivalWatcher(cwd, queue, {
    messages: { read: (dir, after) => {
      if (failRead) throw new Error('read unavailable');
      return readSeatMailMessages(dir, after, { home: root, msgPath: db, env: {} });
    } },
    onReadError: () => { errors++; }, log: () => {}, turnLifeLog: () => {},
  });
  try {
    watcher.poll();
    queue.enqueueNotice('boot notice', 'seat-mail');
    queue.dequeue();
    const first = store.post({ from: 'OP', to: seat, body: 'already handled' });
    const second = store.post({ from: 'OP', to: seat, body: 'still needs attention' });
    watcher.poll();
    store.ackThroughSeen(seat, first.id, 'cli-ack');
    failRead = true;
    watcher.noteTurnFinished(true);
    expect(queue.items.map(item => item.msgId)).toEqual([first.id, second.id]);
    expect(errors).toBe(1);
    failRead = false;
    watcher.noteTurnFinished(true);
    expect(queue.items.map(item => item.msgId)).toEqual([second.id]);
    const next = queue.dequeue();
    expect(next.kind).toBe('submit');
    if (next.kind === 'submit') expect(next.text).toContain('still needs attention');
  } finally {
    watcher.stop(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});
