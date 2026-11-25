import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { dispatchSeatMemoryTool } from '../seat-memory/seat-memory-tools.js';
import { dispatchMsgAck, dispatchMsgPost } from '../skills/tools/ops-ledger.js';
import { announceIdOf, announceRefs, newAnnounceId, parseApplyField, recordAnnounceApply, recordAnnounceMemory } from './announce.js';
import { headerFieldsOf, seatMessageContextBlock } from './msg-context-header.js';
import { MsgStore } from './msg-store.js';

const stores: MsgStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const memoryStore = (): MsgStore => { const store = new MsgStore(':memory:'); stores.push(store); return store; };
const announceTo = (store: MsgStore, to: string) => store.post({ from: 'OP', to, body: 'grep 전에 DocsSearch 먼저', kind: 'announce', refs: ['announce:ann-test-1', 'announce-scope:federation'] }, { dedupe: false });
const eventsOf = (store: MsgStore) => store.db.query('SELECT seat, event, detail FROM msg_announce_events ORDER BY id').all() as Array<{ seat: string; event: string; detail: string }>;

test('apply field parsing: label dropped, one line, bounded', () => {
  expect(parseApplyField(undefined)).toBeNull();
  expect(parseApplyField(null)).toBeNull();
  expect(parseApplyField('적용: 검색 전에 DocsSearch 를 먼저 쓴다')).toBe('검색 전에 DocsSearch 를 먼저 쓴다');
  expect(parseApplyField('  apply：read before shell ')).toBe('read before shell');
  expect(parseApplyField('plain line')).toBe('plain line');
  expect(() => parseApplyField('적용:   ')).toThrow('apply must be one nonempty line');
  expect(() => parseApplyField('one\ntwo')).toThrow('apply must be a single line');
  expect(() => parseApplyField('x'.repeat(301))).toThrow('apply must be at most 300 characters');
  expect(() => parseApplyField(7)).toThrow('apply must be a string');
});

test('announce id and refs', () => {
  expect(newAnnounceId('body', new Date('2026-11-25T09:07:00.000Z'))).toMatch(/^ann-202611250907-[0-9a-f]{6}$/);
  expect(newAnnounceId('body', new Date('2026-11-25T09:07:30.000Z'))).toBe(newAnnounceId('body', new Date('2026-11-25T09:07:00.000Z')));
  expect(announceRefs('ann-x', 'coordinators')).toEqual(['announce:ann-x', 'announce-scope:coordinators']);
  expect(announceIdOf(['intent:x', 'announce:ann-x'])).toBe('ann-x');
  expect(announceIdOf(['intent:x'])).toBeNull();
});

test('announce notice text: rule only for kind announce, body stays at the tail', () => {
  const block = seatMessageContextBlock({ id: 41, sender: 'OP', body: 'BODY', kind: 'announce', announceId: 'ann-test-1' });
  expect(block).toBe('[from OP · info]\n'
    + '[연방 공지 규칙 · announce_id=ann-test-1] 단순 ack 는 적용이 아니다. 답장(replyTo 41) 또는 ack 에 apply 칸으로 «적용:» 한 줄 — 앞으로 무엇을 다르게 할지 — 을 남긴다'
    + ' (MsgPost replyTo+apply · MsgAck ids+apply · eln msg post --reply-to 41 --apply "<한 줄>"). 이 공지로 행동이 바뀌면 같은 턴에 memory_save 로 기억을 남긴다(announce_id=ann-test-1).\n'
    + 'msg:41 · BODY');
  expect(block.endsWith('BODY')).toBe(true);
  expect(seatMessageContextBlock({ id: 42, sender: 'OP', body: 'BODY', kind: 'coord' })).toBe('[from OP · info]\nmsg:42 · BODY');
  expect(headerFieldsOf({ kind: 'announce', refs: ['announce:ann-test-1'] })).toEqual({ announceId: 'ann-test-1' });
  expect(headerFieldsOf({ kind: 'coord', refs: ['announce:ann-test-1'] })).toEqual({});
});

test('receipt funnel emits announce.delivered then announce.turn for the receiving seat', () => {
  const store = memoryStore();
  const logged: Array<{ event: string; data: unknown }> = [];
  const spy = spyOn(debug, 'log').mockImplementation((_category, event, data) => { logged.push({ event, data }); });
  try {
    const mail = announceTo(store, 'TC');
    store.recordReceipt({ messageId: mail.id, recipient: 'TC', state: 'delivered', source: 'plan' });
    store.recordReceipt({ messageId: mail.id, recipient: 'TC', state: 'seen', source: 'plan' });
  } finally { spy.mockRestore(); }
  expect(eventsOf(store)).toEqual([
    { seat: 'TC', event: 'delivered', detail: '' },
    { seat: 'TC', event: 'turn', detail: 'seen' },
  ]);
  const announceEvents = logged.filter(row => row.event.startsWith('announce.'));
  expect(announceEvents.map(row => row.event)).toEqual(['announce.delivered', 'announce.turn']);
  expect(announceEvents[1]!.data).toMatchObject({ announceId: 'ann-test-1', seat: 'TC', outcome: 'seen' });
});

test('a non-announce receipt leaves no announce event', () => {
  const store = memoryStore();
  const mail = store.post({ from: 'OP', to: 'TC', body: 'plain' });
  store.recordReceipt({ messageId: mail.id, recipient: 'TC', state: 'delivered', source: 'plan' });
  expect(store.db.query("SELECT name FROM sqlite_master WHERE name = 'msg_announce_events'").get()).toBeNull();
});

test('apply records announce.applied; a non-announce target returns null', () => {
  const store = memoryStore();
  const logged: Array<{ event: string; data: unknown }> = [];
  const mail = announceTo(store, 'UX');
  const plain = store.post({ from: 'OP', to: 'UX', body: 'plain' });
  const spy = spyOn(debug, 'log').mockImplementation((_category, event, data) => { logged.push({ event, data }); });
  try {
    expect(recordAnnounceApply(store.db, { seat: 'UX', messageId: mail.id, line: 'DocsSearch first' })).toBe('ann-test-1');
    expect(recordAnnounceApply(store.db, { seat: 'UX', messageId: plain.id, line: 'x' })).toBeNull();
  } finally { spy.mockRestore(); }
  expect(eventsOf(store)).toEqual([{ seat: 'UX', event: 'applied', detail: 'DocsSearch first' }]);
  expect(logged.find(row => row.event === 'announce.applied')!.data).toMatchObject({ announceId: 'ann-test-1', seat: 'UX', line: 'DocsSearch first' });
});

test('memory: same-turn window and explicit announce id', () => {
  const store = memoryStore();
  const mail = announceTo(store, 'MK');
  store.recordReceipt({ messageId: mail.id, recipient: 'MK', state: 'delivered', source: 'plan' });
  expect(recordAnnounceMemory(store.db, { seat: 'MK', file: 'docs-first.md' })).toEqual(['ann-test-1']);
  // Outside the 30-minute window only the explicit id counts.
  const later = () => new Date(Date.now() + 31 * 60_000);
  expect(recordAnnounceMemory(store.db, { seat: 'MK', file: 'other.md' }, later)).toEqual([]);
  expect(recordAnnounceMemory(store.db, { seat: 'MK', file: 'other.md', announceId: 'ann-test-1' }, later)).toEqual(['ann-test-1']);
  expect(eventsOf(store).filter(row => row.event === 'memory')).toEqual([
    { seat: 'MK', event: 'memory', detail: 'docs-first.md' },
    { seat: 'MK', event: 'memory', detail: 'other.md' },
  ]);
});

test('MsgPost apply (reply) and MsgAck apply (ack) record announce.applied through the agent tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'announce-tools-'));
  const path = join(dir, 'messages.db');
  try {
    const seed = new MsgStore(path);
    const a = announceTo(seed, 'S1');
    const b = announceTo(seed, 'S2');
    seed.close();
    const posted = await dispatchMsgPost({ from: 'S1', to: 'OP', body: 'ok', replyTo: a.id, apply: '적용: DocsSearch first' }, { openStore: () => new MsgStore(path) });
    expect(posted.output).toBe(`MsgPost #${posted.message!.id} S1 → OP`);
    const acked = await dispatchMsgAck({ to: 'S2', ids: [b.id], apply: 'read before shell' }, { openStore: () => new MsgStore(path), saveAckDigest: async () => ({ saved: false }) as never });
    expect(acked.output).toBe(`MsgAck S2 acknowledged 1 by id (#${b.id}) · applied #${b.id}`);
    await expect(dispatchMsgPost({ from: 'S1', to: 'OP', body: 'ok', apply: 'x' }, { openStore: () => new MsgStore(path) })).rejects.toThrow("'apply' needs 'replyTo' (the announce message ID)");
    const check = new MsgStore(path);
    try {
      expect(eventsOf(check).filter(row => row.event === 'applied')).toEqual([
        { seat: 'S1', event: 'applied', detail: 'DocsSearch first' },
        { seat: 'S2', event: 'applied', detail: 'read before shell' },
      ]);
    } finally { check.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('memory_save hands the saved file and announce_id to the announce-memory port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'announce-memory-'));
  const calls: Array<{ seat: string; file: string; announceId?: string }> = [];
  try {
    const result = await dispatchSeatMemoryTool('memory_save', {
      name: 'docs-first', description: 'search docs before shell', type: 'feedback', kind: 'correction', scope: 'seat',
      body: 'Use DocsSearch before RunShell grep.\nWhy: federation announce.\nHow to apply: every lookup.', announce_id: 'ann-test-1',
    }, { seat: 'S3', dir, recordAnnounceMemory: input => { calls.push(input); return [input.announceId ?? '']; } }) as { saved: boolean; file: string };
    expect(result.saved).toBe(true);
    expect(calls).toEqual([{ seat: 'S3', file: result.file, announceId: 'ann-test-1' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
