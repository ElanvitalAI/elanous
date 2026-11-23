// MSG-RECEIPT-IMPLIES-ACK — a terminal receipt (accepted · rejected · done) is also the per-id ack, the seat counter
// counts only mail that still needs the seat, and `eln msg ack --to <seat> --receipted` backfills decided mail.
// Expectations are literals (rule 11): counts and ack rows are written out, never derived from product helpers.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { MsgStore } from './msg-store.js';
import { registerMsgCommands } from '../cli/msg-cli.js';

const FIXED = new Date('2026-11-23T14:40:00.000Z');
const stores: MsgStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const open = () => { const store = new MsgStore(':memory:', { now: () => FIXED }); stores.push(store); return store; };
const ackRows = (store: MsgStore) => store.db.query('SELECT message_id, recipient, status FROM msg_message_acks ORDER BY message_id').all();
const APPROVAL = '[승인 요청 · TC] Bash · 이유 network\n명령(비밀 가림): curl example.test';

test('rejected receipt on an approval request → ack row exists and the counter drops 1 → 0', () => {
  const store = open();
  const request = store.post({ from: 'TC', to: 'OP', body: APPROVAL, intent: 'request' });
  expect(store.actionableUnreadCount('OP')).toBe(1);
  expect(store.unreadCount('OP')).toBe(1);
  expect(store.recordReceipt({ messageId: request.id, recipient: 'OP', state: 'rejected', source: 'cli', reason: 'no network' }).recorded).toBe(true);
  expect(ackRows(store)).toEqual([{ message_id: 1, recipient: 'OP', status: 'acked' }]);
  expect(store.actionableUnreadCount('OP')).toBe(0);
  expect(store.unreadCount('OP')).toBe(0);
});

test('accepted straight after delivered (no seen) also acks · done raises the ack to done', () => {
  const store = open();
  const a = store.post({ from: 'TC', to: 'OP', body: APPROVAL, intent: 'request' });
  const b = store.post({ from: 'UX', to: 'OP', body: 'ship the footer fix?', intent: 'request' });
  store.recordReceipt({ messageId: a.id, recipient: 'OP', state: 'delivered', source: 'tui-queue' });
  expect(ackRows(store)).toEqual([]);
  store.recordReceipt({ messageId: a.id, recipient: 'OP', state: 'accepted', source: 'cli' });
  store.recordReceipt({ messageId: b.id, recipient: 'OP', state: 'done', source: 'cli', evidence: 'PR #1' });
  expect(ackRows(store)).toEqual([
    { message_id: 1, recipient: 'OP', status: 'acked' },
    { message_id: 2, recipient: 'OP', status: 'done' },
  ]);
  expect(store.actionableUnreadCount('OP')).toBe(0);
});

test('info-only backlog → actionable counter 0 while the raw unread total stays 3', () => {
  const store = open();
  store.post({ from: 'JUD', to: 'OP', body: 'PASS #1' });
  store.post({ from: 'JUD', to: 'OP', body: 'PASS #2', intent: 'info' });
  store.post({ from: 'REL', to: 'OP', body: 'cut ok', kind: 'memo' });
  expect(store.unreadCount('OP')).toBe(3);
  expect(store.actionableUnreadCount('OP')).toBe(0);
});

test('actionable mail without a terminal receipt is counted: request · decision · alert · info with needsAck', () => {
  const store = open();
  store.post({ from: 'TC', to: 'OP', body: APPROVAL, intent: 'request' });
  store.post({ from: 'UX', to: 'OP', body: 'pick A or B', intent: 'decision' });
  store.post({ from: 'RES', to: 'OP', body: 'node-b down', intent: 'alert' });
  store.post({ from: 'REL', to: 'OP', body: 'read and confirm', intent: 'info', needsAck: true });
  store.post({ from: 'JUD', to: 'OP', body: 'FYI', intent: 'info' });
  const seen = store.post({ from: 'MK', to: 'OP', body: 'review deck?', intent: 'request' });
  // A non-terminal receipt (delivered) leaves it actionable and unacked.
  store.recordReceipt({ messageId: seen.id, recipient: 'OP', state: 'delivered', source: 'tui-queue' });
  expect(store.actionableUnreadCount('OP')).toBe(5);
  expect(store.unreadCount('OP')).toBe(6);
});

test('backfill: pre-fix terminal receipts without an ack are acked once (idempotent) · done keeps done', () => {
  const store = open();
  for (const from of ['TC', 'UX', 'MK']) store.post({ from, to: 'OP', body: `${APPROVAL} ${from}`, intent: 'request' });
  // Rows exactly as the pre-fix writer left them: receipt present, no ack.
  const insert = store.db.query("INSERT INTO msg_receipts (message_id, recipient, state, at, source, reason, evidence) VALUES (?, 'OP', ?, '2026-11-23T10:00:00.000Z', 'cli', ?, ?)");
  insert.run(1, 'accepted', null, null);
  insert.run(2, 'rejected', 'no', null);
  expect(store.actionableUnreadCount('OP')).toBe(1);
  expect(store.unreadCount('OP')).toBe(3);
  expect(store.ackReceipted('OP')).toEqual([1, 2]);
  expect(ackRows(store)).toEqual([
    { message_id: 1, recipient: 'OP', status: 'acked' },
    { message_id: 2, recipient: 'OP', status: 'acked' },
  ]);
  expect(store.unreadCount('OP')).toBe(1);
  expect(store.ackReceipted('OP')).toEqual([]);
  insert.run(3, 'done', null, 'PR #2');
  expect(store.ackReceipted('OP')).toEqual([3]);
  expect(ackRows(store)).toEqual([
    { message_id: 1, recipient: 'OP', status: 'acked' },
    { message_id: 2, recipient: 'OP', status: 'acked' },
    { message_id: 3, recipient: 'OP', status: 'done' },
  ]);
  expect(store.unreadCount('OP')).toBe(0);
});

test('eln msg ack --to OP --receipted acks the decided mail and reports the ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-receipted-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const seed = new MsgStore(path);
  try {
    seed.post({ from: 'TC', to: 'OP', body: APPROVAL, intent: 'request' });
    seed.post({ from: 'UX', to: 'OP', body: 'still open', intent: 'request' });
    seed.db.query("INSERT INTO msg_receipts (message_id, recipient, state, at, source, reason) VALUES (1, 'OP', 'rejected', '2026-11-23T10:00:00.000Z', 'cli', 'no')").run();
  } finally { seed.close(); }
  const stdout: string[] = [];
  const stderr: string[] = [];
  // A fresh program per run — commander keeps parsed option values on the command between parses.
  const run = async (...args: string[]) => {
    const program = new Command();
    registerMsgCommands(program, {
      openStore: () => new MsgStore(path),
      out: { log: line => stdout.push(line), error: line => stderr.push(line) },
      setExitCode: () => {},
      registerLogSink: async () => undefined,
      wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
    });
    await program.parseAsync(['msg', ...args], { from: 'user' });
  };
  await run('ack', '--to', 'OP', '--receipted', '--json');
  expect(stderr).toEqual([]);
  expect(JSON.parse(stdout[0]!)).toEqual({ recipient: 'OP', receipted: 1, ids: [1] });
  await run('ack', '--to', 'OP', '--receipted');
  expect(stdout[1]).toBe('OP acknowledged 0 receipted messages');
  const after = new MsgStore(path);
  try {
    expect(after.unreadCount('OP')).toBe(1);
    expect(after.actionableUnreadCount('OP')).toBe(1);
  } finally { after.close(); }
});
