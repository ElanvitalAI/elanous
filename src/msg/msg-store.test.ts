import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { MsgStore, canonicalSeatId, defaultMsgStorePath, openMsgStore, validateMessageEnvelope } from './msg-store.js';

const dirs: string[] = [];
function diskPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-msg-'));
  dirs.push(dir);
  return join(dir, 'nested', 'messages.db');
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('message identity and envelope', () => {
  test('old seats and role aliases resolve to a single stable canonical seat', () => {
    for (const [alias, seat] of Object.entries({ S: 'OP', COO: 'OP', T: 'MK', CMO: 'MK', O: 'TC', CTO: 'TC', F: 'UX', CXO: 'UX' })) {
      expect(canonicalSeatId(` ${alias.toLowerCase()} `)).toBe(seat);
      expect(canonicalSeatId(seat)).toBe(seat);
    }
    expect(canonicalSeatId(' agent-7 ')).toBe('AGENT-7');
    expect(canonicalSeatId('constructor')).toBe('CONSTRUCTOR');
    expect(canonicalSeatId('toString')).toBe('TOSTRING');
    for (const invalid of ['', ' ', '../OP', 'a b', '⚠', 'x'.repeat(65)]) expect(() => canonicalSeatId(invalid)).toThrow();
    expect(() => canonicalSeatId(12 as unknown as string)).toThrow();
  });

  test('rejects invalid or extra envelope data without modifying an existing log', () => {
    const store = new MsgStore(':memory:');
    try {
      for (const invalid of [null, [], {}, { from: 'S', to: 'T', body: '' },
        { from: 'S', to: 'T', body: 4 }, { from: '../S', to: 'T', body: 'hi' },
        { from: 'S', to: 'T', body: 'hi', kind: 'BAD!' },
        { from: 'S', to: 'T', body: 'hi', id: 9 }]) {
        expect(() => store.append(invalid as never)).toThrow();
      }
      expect(store.unreadRecipients()).toEqual([]);
      expect(validateMessageEnvelope({ from: 'coo', to: 'cmo', body: '  hi  ', kind: 'memo' }))
        .toEqual({ from: 'OP', to: 'MK', body: '  hi  ', kind: 'memo' });
    } finally { store.close(); }
  });
});

describe('durable message log and cursor', () => {
  test('persist across reopen; recipient paging uses exclusive ID cursor and never acks on read', () => {
    const path = diskPath();
    const first = new MsgStore(path);
    let a: number;
    let b: number;
    try {
      a = first.append({ from: 'coo', to: 'T', body: 'first' }).id;
      first.append({ from: 'OP', to: 'UX', body: 'not yours' });
      b = first.append({ from: 'UX', to: 'MK', body: 'second', kind: 'memo' }).id;
      expect(first.listByRecipient('cmo', 0, 1).map(m => m.id)).toEqual([a]);
      expect(first.listByRecipient('T', a).map(m => m.id)).toEqual([b]);
      expect(first.listByRecipient('T', b)).toEqual([]);
      expect(first.getCursor('MK')).toBe(0);
    } finally { first.close(); }
    const second = new MsgStore(path);
    try {
      expect(second.listByRecipient('MK').map(m => [m.from, m.to, m.body, m.kind]))
        .toEqual([['OP', 'MK', 'first', undefined], ['UX', 'MK', 'second', 'memo']]);
      expect(second.unreadRecipients()).toEqual([{ recipient: 'MK', count: 2 }, { recipient: 'UX', count: 1 }]);
      expect(second.advanceCursor('cmo', a!)).toBe(a!);
      expect(second.advanceCursor('T', 0)).toBe(a!);
      expect(second.advanceCursor('MK', b!)).toBe(b!);
      expect(second.unreadRecipients()).toEqual([{ recipient: 'UX', count: 1 }]);
    } finally { second.close(); }
    const third = new MsgStore(path);
    try {
      expect(third.getCursor('T')).toBe(b!);
      expect(third.listByRecipient('T', third.getCursor('T'))).toEqual([]);
      expect(third.append({ from: 'OP', to: 'MK', body: 'third' }).id).toBeGreaterThan(b!);
      expect(third.unreadRecipients()).toEqual([{ recipient: 'MK', count: 1 }, { recipient: 'UX', count: 1 }]);
    } finally { third.close(); }
  });

  test('rejects future cursors and keeps acknowledgements monotonic across two connections', () => {
    const path = diskPath();
    const a = new MsgStore(path);
    const b = new MsgStore(path);
    try {
      a.append({ from: 'OP', to: 'MK', body: 'one' });
      expect(() => a.advanceCursor('MK', 5)).toThrow('cursor exceeds the latest message ID');
      expect(a.getCursor('MK')).toBe(0);
      expect(a.advanceCursor('MK', 1)).toBe(1);
      expect(b.advanceCursor('T', 0)).toBe(1);
      expect(a.getCursor('T')).toBe(1);
      for (const value of [-1, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => a.advanceCursor('MK', value)).toThrow();
        expect(() => a.listByRecipient('MK', value)).toThrow();
      }
      for (const value of [0, -1, 1001, 1.2]) expect(() => a.listByRecipient('MK', 0, value)).toThrow();
      expect(a.getCursor('MK')).toBe(1);
      for (let id = 2; id <= 5; id++) a.append({ from: 'OP', to: 'MK', body: `message ${id}` });
      expect(b.unreadRecipients()).toEqual([{ recipient: 'MK', count: 4 }]);
      expect(b.advanceCursor('CMO', 5)).toBe(5);
      expect(a.unreadRecipients()).toEqual([]);
    } finally { a.close(); b.close(); }
  });

  test('public store API uses the same durable log and explicit acknowledgement cursor', () => {
    const path = diskPath();
    const first = openMsgStore(path);
    let posted: number;
    try {
      posted = first.post({ from: 'S', to: 'T', body: 'memo' }).id;
      expect(first.list('cmo').map(message => message.id)).toEqual([posted]);
      expect(first.unread()).toEqual([{ recipient: 'MK', count: 1 }]);
      expect(first.ack('MK', posted)).toBe(posted);
      expect(first.ack('T', 0)).toBe(posted);
      expect(first.unread()).toEqual([]);
    } finally { first.close(); }
    const reopened = openMsgStore(path);
    try {
      expect(reopened.list('MK', posted!)).toEqual([]);
      expect(reopened.getCursor('T')).toBe(posted!);
      expect(reopened.unread()).toEqual([]);
    } finally { reopened.close(); }
  });

  test('default database belongs to the resolved instance state root', () => {
    expect(defaultMsgStorePath()).toBe(join(elanousStateRoot(), 'msg', 'messages.db'));
  });
});
