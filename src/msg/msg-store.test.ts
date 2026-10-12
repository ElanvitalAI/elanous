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
    expect(canonicalSeatId('all')).toBe('ALL');
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
  test('ALL is one topic row, delivered through each recipient cursor except the sender', () => {
    const store = new MsgStore(':memory:');
    try {
      const broadcast = store.post({ from: 'OP', to: 'ALL', body: 'notice', kind: 'memo' });
      expect(store.db.query('SELECT COUNT(*) AS count FROM msg_messages').get()).toEqual({ count: 1 });
      expect(store.list('OP')).toEqual([]);
      for (const recipient of ['MK', 'TC', 'UX']) expect(store.list(recipient)).toEqual([broadcast]);
      expect(store.unread()).toEqual([
        { recipient: 'MK', count: 1 }, { recipient: 'TC', count: 1 }, { recipient: 'UX', count: 1 },
      ]);
      expect(store.unreadCount('COORDINATOR')).toBe(1);
      expect(store.ack('MK', broadcast.id)).toBe(broadcast.id);
      expect(store.list('MK', store.getCursor('MK'))).toEqual([]);
      expect(store.unreadCount('MK')).toBe(0);
      expect(store.unreadCount('TC')).toBe(1);
      expect(store.unread().find(row => row.recipient === 'MK')).toBeUndefined();
      expect(() => store.post({ from: 'ALL', to: 'MK', body: 'invalid' })).toThrow('ALL cannot send');
      expect(() => store.list('ALL')).toThrow('ALL is a topic');
    } finally { store.close(); }
  });

  test('DM and ALL share insertion order and one acknowledgement cursor without changing DM rows', () => {
    const store = new MsgStore(':memory:');
    try {
      const dm = store.post({ from: 'TC', to: 'MK', body: 'direct' });
      const all = store.post({ from: 'OP', to: 'ALL', body: 'everyone' });
      store.post({ from: 'MK', to: 'ALL', body: 'everyone except MK' });
      expect(store.list('MK').map(message => [message.id, message.to, message.body])).toEqual([
        [dm.id, 'MK', 'direct'], [all.id, 'ALL', 'everyone'],
      ]);
      expect(store.list('MK', dm.id).map(message => message.id)).toEqual([all.id]);
      expect(store.unreadCount('MK')).toBe(2);
      store.ack('MK', all.id);
      expect(store.unreadCount('MK')).toBe(0);
      expect(store.unreadCount('TC')).toBe(2);
    } finally { store.close(); }
  });

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

  test('inserts provenance-backed messages once per comment and recipient', () => {
    const store = new MsgStore(':memory:');
    try {
      const input = { from: 'OP', to: 'MK', body: 'comment 65001', kind: 'coord' };
      const first = store.appendWithProvenance(input, 'coord:65001:MK');
      const duplicate = store.appendWithProvenance(input, 'coord:65001:MK');
      const otherRecipient = store.appendWithProvenance({ ...input, to: 'UX' }, 'coord:65001:UX');

      expect(duplicate).toEqual(first);
      expect(otherRecipient.id).not.toBe(first.id);
      expect(store.listByRecipient('MK')).toEqual([first]);
      expect(store.listByRecipient('UX')).toEqual([otherRecipient]);
      expect(store.db.query('SELECT provenance_key FROM msg_provenance ORDER BY provenance_key').all())
        .toEqual([{ provenance_key: 'coord:65001:MK' }, { provenance_key: 'coord:65001:UX' }]);
      expect(() => store.appendWithProvenance(input, 'coord:65001:UX')).toThrow('provenance recipient does not match message recipient');
      expect(() => store.appendWithProvenance(input, 'coord:65001')).toThrow('invalid message provenance key');
    } finally { store.close(); }
  });

  test('provenance deduplication survives reopening the ledger', () => {
    const path = diskPath();
    const firstStore = new MsgStore(path);
    let firstId: number;
    try {
      firstId = firstStore.appendWithProvenance(
        { from: 'OP', to: 'MK', body: 'comment 65002', kind: 'coord' }, 'coord:65002:MK',
      ).id;
    } finally { firstStore.close(); }

    const reopened = new MsgStore(path);
    try {
      const duplicate = reopened.appendWithProvenance(
        { from: 'OP', to: 'MK', body: 'comment 65002', kind: 'coord' }, 'coord:65002:MK',
      );
      expect(duplicate.id).toBe(firstId!);
      expect(reopened.listByRecipient('MK')).toEqual([duplicate]);
      expect(reopened.db.query('SELECT COUNT(*) AS count FROM msg_provenance').get())
        .toEqual({ count: 1 });
    } finally { reopened.close(); }
  });

  test('two concurrent connections return the same message for one provenance key', async () => {
    const path = diskPath();
    const marker = `${path}.race`;
    const moduleUrl = new URL('./msg-store.ts', import.meta.url).href;
    const childScript = `
      import { existsSync, writeFileSync } from 'node:fs';
      const [moduleUrl, dbPath, marker, index] = process.argv.slice(1);
      const { MsgStore } = await import(moduleUrl);
      const store = new MsgStore(dbPath);
      try {
        writeFileSync(marker + index, 'ready');
        const deadline = Date.now() + 10000;
        while (!existsSync(marker + (index === '0' ? '1' : '0'))) {
          if (Date.now() > deadline) throw new Error('peer did not become ready');
          await Bun.sleep(5);
        }
        const message = store.appendWithProvenance(
          { from: 'OP', to: 'MK', body: 'same comment', kind: 'coord' }, 'coord:65003:MK',
        );
        console.log(message.id);
      } finally { store.close(); }
    `;
    const children = [0, 1].map(index => Bun.spawn(
      [process.execPath, '-e', childScript, moduleUrl, path, marker, String(index)],
      { stdout: 'pipe', stderr: 'pipe' },
    ));
    const results = await Promise.all(children.map(async child => ({
      code: await child.exited,
      id: (await new Response(child.stdout).text()).trim(),
      error: (await new Response(child.stderr).text()).trim(),
    })));
    expect(results.map(result => result.error)).toEqual(['', '']);
    expect(results.map(result => result.code)).toEqual([0, 0]);
    expect(results[0]!.id).toBe(results[1]!.id);
    const store = new MsgStore(path);
    try {
      expect(store.listByRecipient('MK')).toHaveLength(1);
    } finally { store.close(); }
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
