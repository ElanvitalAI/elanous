import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore, openMsgStoreReadOnly } from '../../msg/msg-store.js';
import { dispatchMsgInbox } from './msg-inbox.js';

test('MsgInbox reads only the bound seat and leaves the ledger unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-inbox-'));
  const path = join(dir, 'messages.db');
  try {
    const writer = new MsgStore(path);
    const read = writer.post({ from: 'OP', to: 'TC', body: 'first' });
    writer.ack('TC', read.id);
    const unread = writer.post({ from: 'OP', to: 'TC', body: 'second' });
    writer.post({ from: 'OP', to: 'MK', body: 'private for MK' });
    writer.close();
    const before = readFileSync(path);
    const deps = { seat: 'TC', openStore: () => openMsgStoreReadOnly(path) };
    const result = await dispatchMsgInbox({}, deps);
    expect(result.messages.map((row) => row.id)).toEqual([unread.id]);
    expect(result.messages.some((row) => row.body === 'private for MK')).toBe(false);
    expect(result.after).toBe(read.id);
    // 출처: #36775 unread-only 계약 — TC의 첫 메시지는 ack됐고 둘째 한 건만 남는다.
    expect((await dispatchMsgInbox({ after: read.id, limit: 1 }, deps)).count).toBe(1);
    const cannotReopenAcknowledged = await dispatchMsgInbox({ after: 0 }, deps);
    expect(cannotReopenAcknowledged.after).toBe(read.id);
    expect(cannotReopenAcknowledged.messages.map((row) => row.id)).toEqual([unread.id]);
    expect(readFileSync(path).equals(before)).toBe(true);
    const check = openMsgStoreReadOnly(path);
    expect(check.getCursor('TC')).toBe(read.id);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MsgInbox never accepts a model-selected recipient or opens a store for invalid args', async () => {
  let opens = 0;
  const deps = { seat: 'TC', openStore: () => { opens++; return new MsgStore(':memory:'); } };
  await expect(dispatchMsgInbox({ to: 'OP' }, deps)).rejects.toThrow('recipient is bound');
  await expect(dispatchMsgInbox({ limit: null }, deps)).rejects.toThrow('limit');
  // 출처: #36775 MsgInbox 계약 — 허용 상한 100 바로 다음 값은 저장소를 열기 전에 거부한다.
  await expect(dispatchMsgInbox({ limit: 101 }, deps)).rejects.toThrow('limit');
  await expect(dispatchMsgInbox({}, { ...deps, seat: 'ALL' })).rejects.toThrow('ALL is a topic');
  expect(opens).toBe(0);
});
