import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { MsgStore, canonicalSeatId, defaultMsgStorePath, openMsgStore, readUnreadSummary, validateMessageEnvelope } from './msg-store.js';

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
        { from: 'S', to: 'T', body: 'hi', id: 9 },
        { from: 'S', to: 'T', body: 'hi', replyTo: 0 },
        { from: 'S', to: 'T', body: 'hi', replyTo: 1.5 },
        { from: 'S', to: 'T', body: 'hi', replyTo: 'one' }]) {
        expect(() => store.append(invalid as never)).toThrow();
      }
      expect(store.unreadRecipients()).toEqual([]);
      expect(validateMessageEnvelope({ from: 'coo', to: 'cmo', body: '  hi  ', kind: 'memo' }))
        .toEqual({ from: 'OP', to: 'MK', body: '  hi  ', kind: 'memo' });
    } finally { store.close(); }
  });

  test('message addresses normalize seats and groups, including the group:all broadcast alias', () => {
    expect(validateMessageEnvelope({ from: 'seat:op', to: 'seat:cmo', body: 'hi' }))
      .toEqual({ from: 'OP', to: 'MK', body: 'hi' });
    expect(validateMessageEnvelope({ from: 'MK', to: 'group:Release-Window', body: 'hi' }).to)
      .toBe('group:release-window');
    expect(validateMessageEnvelope({ from: 'MK', to: 'group:all', body: 'hi' }).to).toBe('ALL');
    expect(() => validateMessageEnvelope({ from: 'MK', to: 'group:../private', body: 'hi' })).toThrow();
  });
});

describe('durable message log and cursor', () => {
  test('MSG-CHANNELS: create, join, leave and group membership gate delivery on each seat cursor', () => {
    const store = new MsgStore(':memory:');
    try {
      const owner = store.createGroup('Release-Window', 'OP');
      expect(owner).toBe('group:release-window');
      const beforeJoin = store.post({ from: 'OP', to: owner, body: 'before join' });
      expect(store.joinGroup(owner, 'TC')).toBe(true);
      const afterJoin = store.post({ from: 'OP', to: owner, body: 'subscribers only' });
      expect(store.list('OP').map(row => row.body)).toEqual(['before join', 'subscribers only']);
      expect(store.list('TC').map(row => row.body)).toEqual(['subscribers only']);
      expect(store.list('MK')).toEqual([]);
      expect(store.listGroups('tc')).toEqual([owner]);
      expect(store.leaveGroup(owner, 'TC')).toBe(true);
      store.post({ from: 'OP', to: owner, body: 'after leave' });
      expect(store.list('TC', afterJoin.id).map(row => row.body)).toEqual([]);
      expect(store.list('TC').map(row => row.body)).toEqual(['subscribers only']);
      store.ack('TC', afterJoin.id);
      expect(store.joinGroup(owner, 'TC')).toBe(true);
      store.post({ from: 'OP', to: owner, body: 'after rejoin' });
      expect(store.list('TC', store.getCursor('TC')).map(row => row.body)).toEqual(['after rejoin']);
      expect(beforeJoin.id).toBeLessThan(afterJoin.id);
    } finally { store.close(); }
  });

  test('MSG-CHANNELS: group:all enforces two posts per sender per UTC hour and folds overflow into one summary', () => {
    let now = new Date('2026-10-29T12:00:00.000Z');
    const store = new MsgStore(':memory:', { now: () => now });
    try {
      store.post({ from: 'OP', to: 'group:all', body: 'one' });
      store.append({ from: 'OP', to: 'ALL', body: 'two' });
      const event = store.appendWithProvenance({ from: 'OP', to: 'ALL', body: 'provenance event' }, 'coord:group-all-test:ALL');
      expect(store.appendWithProvenance({ from: 'OP', to: 'ALL', body: 'different retry text' }, 'coord:group-all-test:ALL').id)
        .toBe(event.id);
      const summary = store.post({ from: 'OP', to: 'group:all', body: 'three' });
      const folded = store.post({ from: 'OP', to: 'ALL', body: 'four' });
      expect(folded.id).toBe(summary.id);
      expect(store.list('MK').map(row => row.body)).toEqual(['one', 'two', 'provenance event', expect.stringContaining('시간당 상한')]);
      expect(store.list('OP')).toEqual([]);
      now = new Date('2026-10-29T13:00:00.000Z');
      store.post({ from: 'OP', to: 'group:all', body: 'new hour' });
      expect(store.list('MK').map(row => row.body).at(-1)).toBe('new hour');
    } finally { store.close(); }
  });

  test('TA delivery claim serializes two senders and rejects a stale failure after success', () => {
    const path = diskPath();
    const first = new MsgStore(path);
    const second = new MsgStore(path);
    try {
      const request = first.post({ from: 'OP', to: 'TA', body: 'memo ta-card one' });
      first.post({ from: 'TA', to: 'OP', body: 'pending', replyTo: request.id });
      first.setTaDeliveryStatus(request.id, 'pending');
      const owner = first.claimTaDelivery(request.id)!;
      expect(owner).toBeTruthy();
      expect(second.claimTaDelivery(request.id)).toBeNull();
      expect(first.settleTaDelivery(request.id, owner, 'delivered once', true)).toBe(true);
      expect(second.claimTaDelivery(request.id)).toBeNull();
      expect(first.settleTaDelivery(request.id, owner, 'stale failure', false)).toBe(false);
      expect(second.listReplies(request.id)[0]!.body).toBe('delivered once');
    } finally { first.close(); second.close(); }
  });

  test('TA delivery claim stays held without a process-liveness guess', () => {
    const store = new MsgStore(diskPath());
    try {
      const request = store.post({ from: 'OP', to: 'TA', body: 'memo ta-card retry' });
      store.post({ from: 'TA', to: 'OP', body: 'pending', replyTo: request.id });
      store.setTaDeliveryStatus(request.id, 'pending');
      store.claimTaDelivery(request.id);
      expect(store.taDeliveryClaimState(request.id)).toBe('held');
      expect(store.claimTaDelivery(request.id)).toBeNull();
      expect(store.settleTaDelivery(request.id, 'not-the-owner', 'stale failure', false)).toBe(false);
      expect(store.listReplies(request.id)[0]!.body).toBe('pending');
    } finally { store.close(); }
  });
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

  test('MSG-THREAD: mock request and reply are returned together without changing DM, ALL or ack order', () => {
    const path = diskPath();
    const writer = new MsgStore(path);
    let requestId: number;
    let replyId: number;
    try {
      const request = writer.post({ from: 'OP', to: 'TC', body: 'request' });
      requestId = request.id;
      const all = writer.post({ from: 'MK', to: 'ALL', body: 'notice' });
      const reply = writer.post({ from: 'TC', to: 'OP', body: 'reply', replyTo: request.id });
      replyId = reply.id;
      expect(writer.list('TC').map(message => message.id)).toEqual([request.id, all.id]);
      expect(writer.list('OP').map(message => message.id)).toEqual([all.id, reply.id]);
      expect(writer.getCursor('TC')).toBe(0);
      expect(writer.ack('TC', request.id)).toBe(request.id);
      expect(writer.list('TC', writer.getCursor('TC')).map(message => message.id)).toEqual([all.id]);
    } finally { writer.close(); }
    const reader = new MsgStore(path);
    try {
      expect(reader.listThread(requestId!).map(message => [message.id, message.replyTo, message.body])).toEqual([
        [requestId!, undefined, 'request'], [replyId!, requestId!, 'reply'],
      ]);
      expect(reader.getCursor('TC')).toBe(requestId!);
    } finally { reader.close(); }
  });

  test('MSG-THREAD: a reply ID resolves to the same request and reply across seats', () => {
    const store = new MsgStore(':memory:');
    try {
      const request = store.post({ from: 'OP', to: 'TC', body: 'mock request' });
      const reply = store.post({ from: 'TC', to: 'OP', body: 'mock reply', replyTo: request.id });
      expect(store.listThread(reply.id)).toEqual([request, reply]);
      expect(store.listThread(request.id)).toEqual([request, reply]);
    } finally { store.close(); }
  });

  test('replyTo threads replies to a question, listing them in insertion order and paging by exclusive reply ID', () => {
    const store = new MsgStore(':memory:');
    try {
      const question = store.post({ from: 'OP', to: 'TC', body: 'the question' });
      expect(question.replyTo).toBeUndefined();
      store.post({ from: 'OP', to: 'MK', body: 'unrelated' });
      const first = store.post({ from: 'TC', to: 'OP', body: 'first reply', replyTo: question.id });
      const second = store.post({ from: 'TC', to: 'OP', body: 'second reply', replyTo: question.id });
      expect(first).toMatchObject({ replyTo: question.id });
      expect(second.replyTo).toBe(question.id);
      expect(store.listReplies(question.id)).toEqual([first, second]);
      expect(store.listReplies(first.id)).toEqual([]);
      expect(store.listReplies(question.id, 1)).toEqual([first]);
      expect(store.listReplies(question.id, 100, first.id)).toEqual([second]);
      expect(store.listReplies(question.id, 100, second.id)).toEqual([]);
      expect(store.getMessage(question.id)).toEqual(question);
      expect(store.getMessage(999)).toBeNull();
      expect(validateMessageEnvelope({ from: 'coo', to: 'cmo', body: 'hi', replyTo: 7 }))
        .toEqual({ from: 'OP', to: 'MK', body: 'hi', replyTo: 7 });
      for (const invalid of [0, -1, 1.5, 'one', null]) {
        expect(() => store.append({ from: 'OP', to: 'MK', body: 'x', replyTo: invalid } as never))
          .toThrow('replyTo must be a positive integer message ID');
      }
      for (const invalid of [0, -1, 1.5]) {
        expect(() => store.listReplies(invalid as never)).toThrow('message ID must be a positive integer');
        expect(() => store.getMessage(invalid as never)).toThrow('message ID must be a positive integer');
      }
      for (const limit of [0, -1, 1001, 1.5]) expect(() => store.listReplies(1, limit)).toThrow('limit must be between 1 and 1000');
      for (const invalid of [-1, 1.5]) expect(() => store.listReplies(question.id, 100, invalid)).toThrow('cursor must be a nonnegative safe integer');
    } finally { store.close(); }
  });

  test('a pre-threading ledger migrates in place; old messages stay valid and replies persist across reopen', () => {
    const path = diskPath();
    mkdirSync(dirname(path), { recursive: true });
    const legacy = new Database(path);
    try {
      legacy.exec(`CREATE TABLE msg_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        body TEXT NOT NULL,
        kind TEXT,
        created_at TEXT NOT NULL
      );`);
      legacy.query('INSERT INTO msg_messages(sender, recipient, body, kind, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('OP', 'TC', 'old question', 'memo', '2026-10-01T00:00:00.000Z');
      legacy.query('INSERT INTO msg_messages(sender, recipient, body, created_at) VALUES (?, ?, ?, ?)')
        .run('TC', 'OP', 'old answer', '2026-10-01T00:01:00.000Z');
    } finally { legacy.close(); }

    const oldQuestion = { id: 1, from: 'OP', to: 'TC', body: 'old question', kind: 'memo', createdAt: '2026-10-01T00:00:00.000Z' };
    const oldAnswer = { id: 2, from: 'TC', to: 'OP', body: 'old answer', createdAt: '2026-10-01T00:01:00.000Z' };
    const readOnly = new MsgStore(path, { readOnly: true });
    try {
      expect(readOnly.getMessage(1)).toEqual(oldQuestion);
      expect(readOnly.listByRecipient('OP')).toEqual([oldAnswer]);
      expect(readOnly.listAfter(0)).toEqual([oldQuestion, oldAnswer]);
      expect(readOnly.listReplies(1)).toEqual([]);
      expect(readOnly.listThread(1)).toEqual([oldQuestion]);
    } finally { readOnly.close(); }
    const store = new MsgStore(path);
    try {
      expect(store.listByRecipient('TC')).toEqual([oldQuestion]);
      expect(store.getMessage(2)).toEqual(oldAnswer);
      expect(store.listReplies(1)).toEqual([]);
      const reply = store.post({ from: 'TC', to: 'OP', body: 'new reply', replyTo: 1 });
      expect(reply).toMatchObject({ id: 3, replyTo: 1 });
      expect(store.listReplies(1).map(message => [message.id, message.body, message.replyTo])).toEqual([[3, 'new reply', 1]]);
      expect(store.listThread(1)).toEqual([oldQuestion, reply]);
    } finally { store.close(); }

    const reopened = new MsgStore(path);
    try {
      expect(reopened.getMessage(1)).toEqual(oldQuestion);
      expect(reopened.getMessage(2)).toEqual(oldAnswer);
      expect(reopened.listReplies(1).map(message => [message.id, message.replyTo])).toEqual([[3, 1]]);
    } finally { reopened.close(); }
  });

  test('read-only pre-group ledger lists DM/unread without attempting group schema writes', () => {
    const path = diskPath();
    mkdirSync(dirname(path), { recursive: true });
    const legacy = new Database(path);
    try {
      legacy.exec(`CREATE TABLE msg_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT NOT NULL,
        body TEXT NOT NULL, kind TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE msg_cursors (recipient TEXT PRIMARY KEY, last_id INTEGER NOT NULL DEFAULT 0);`);
      legacy.query('INSERT INTO msg_messages(sender, recipient, body, created_at) VALUES (?, ?, ?, ?)')
        .run('OP', 'TC', 'legacy direct', '2026-10-01T00:00:00.000Z');
    } finally { legacy.close(); }
    const readOnly = new MsgStore(path, { readOnly: true });
    try {
      expect(readOnly.list('TC').map(row => row.body)).toEqual(['legacy direct']);
      expect(readOnly.unread()).toEqual([{ recipient: 'TC', count: 1 }]);
      expect(readOnly.db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'msg_groups'").get())
        .toEqual({ count: 0 });
    } finally { readOnly.close(); }
  });

  test('two processes can open the same pre-threading ledger during migration', async () => {
    const path = diskPath();
    mkdirSync(dirname(path), { recursive: true });
    const legacy = new Database(path);
    try {
      legacy.exec(`CREATE TABLE msg_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT NOT NULL,
        body TEXT NOT NULL, kind TEXT, created_at TEXT NOT NULL
      )`);
    } finally { legacy.close(); }
    const script = `import { MsgStore } from './src/msg/msg-store.ts'; const store = new MsgStore(process.env.MSG_DB_PATH!); store.close();`;
    const results = await Promise.all([0, 1].map(async () => {
      const child = Bun.spawn(['bun', '-e', script], {
        cwd: process.cwd(), env: { ...process.env, MSG_DB_PATH: path }, stdout: 'pipe', stderr: 'pipe',
      });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      return { code, stderr };
    }));
    for (const result of results) expect(result.code, result.stderr).toBe(0);
    const store = new MsgStore(path);
    try {
      const columns = store.db.query(`SELECT name FROM pragma_table_info('msg_messages') WHERE name = 'reply_to'`).all();
      expect(columns).toHaveLength(1);
    } finally { store.close(); }
  });

  test('default database belongs to the resolved instance state root', () => {
    expect(defaultMsgStorePath()).toBe(join(elanousStateRoot(), 'msg', 'messages.db'));
  });
});

describe('readUnreadSummary (TUI-H3 턴 끝 자동 재개의 «같은 오더» 지문)', () => {
  test('unread count ⊕ newest unread ID · ack moves both · ALL topic from others counts · absent ledger = null', () => {
    const path = diskPath();
    expect(readUnreadSummary('OPT', path)).toBeNull();
    const store = new MsgStore(path);
    try {
      expect(readUnreadSummary('OPT', path)).toEqual({ count: 0, maxId: null });
      const a = store.post({ from: 'OP', to: 'OPT', body: 'a' });
      store.post({ from: 'OP', to: 'MK', body: 'not mine' });
      const c = store.post({ from: 'MK', to: 'ALL', body: 'topic' });
      store.post({ from: 'OPT', to: 'ALL', body: 'own topic' });
      expect(readUnreadSummary('opt', path)).toEqual({ count: 2, maxId: c.id });
      store.ack('OPT', a.id);
      expect(readUnreadSummary('OPT', path)).toEqual({ count: 1, maxId: c.id });
      store.ack('OPT', store.latestId());
      expect(readUnreadSummary('OPT', path)).toEqual({ count: 0, maxId: null });
      expect(() => readUnreadSummary('ALL', path)).toThrow('ALL is a topic');
    } finally { store.close(); }
  });
});
