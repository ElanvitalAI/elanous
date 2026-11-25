import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInboxSnapshot, causeOf } from './inbox-snapshot.js';
import { resetInboxSnapshotMemory, seatInboxSnapshotText } from './inbox-snapshot-turn.js';
import { openMsgStore } from './msg-store.js';

describe('SIGNAL-INBOX-SNAPSHOT build', () => {
  test('groups by cell → PR → seat, newest first, one line each', () => {
    const r = buildInboxSnapshot([
      { id: 10, from: 'TC', kind: 'info', body: 'pregate green\nmore', refs: ['pr:40100'] },
      { id: 12, from: 'UX', kind: 'request', body: 'need review', refs: ['cell:A7'] },
      { id: 11, from: 'JUD', kind: 'decision', body: 'land?' },
      { id: 13, from: 'TC', kind: 'info', body: 'second on PR', refs: ['pr:#40100'] },
    ]);
    expect(r.text).toBe([
      '## Inbox (unhandled) — 4 unread · this block is the whole unhandled list at turn start; no MsgList needed to find it',
      'cell A7',
      '  #12 · UX · request · need review',
      'pr #40100',
      '  #13 · TC · info · second on PR',
      '  #10 · TC · info · pregate green',
      'seat JUD',
      '  #11 · JUD · decision · land?',
    ].join('\n'));
    expect(r.shownIds).toEqual([12, 13, 10, 11]);
  });
  test('cap 25 lines with «+N more»; empty inbox = no block', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, from: 'TC', kind: 'info', body: `m${i + 1}` }));
    const r = buildInboxSnapshot(many);
    const lines = r.text!.split('\n');
    expect(lines.length).toBe(1 + 25 + 1);
    expect(lines.at(-1)).toBe('+16 more');
    expect(lines[2]).toBe('  #40 · TC · info · m40');
    expect(buildInboxSnapshot([]).text).toBeNull();
    expect(causeOf({ id: 1, from: 'ux', body: '' })).toEqual({ kind: 'seat', key: 'UX' });
  });
  test('lapsed: directive named once, passive counted', () => {
    const lapsed = [{ id: 5, from: 'OP', kind: 'request', body: 'x', crownDirective: '3' }, { id: 6, from: 'TC', kind: 'info', body: 'y' }, { id: 7, from: 'TC', kind: 'status', body: 'z' }];
    const first = buildInboxSnapshot([], lapsed);
    expect(first.text!.split('\n').slice(1)).toEqual(['expired: #5 (OP) — do not act on it', 'expired 2']);
    const again = buildInboxSnapshot([], lapsed, new Set(first.expiredNamed));
    expect(again.text!.split('\n').slice(1)).toEqual(['expired 2']);
  });
});

describe('SIGNAL-INBOX-SNAPSHOT turn', () => {
  beforeEach(() => resetInboxSnapshotMemory());
  test('seat: lists unread, stamps delivered (not acked); no seat → null', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'snap-')), 'm.db');
    const store = openMsgStore(path);
    const m = store.post({ from: 'TC', to: 'OP', body: 'PR 5 ready', kind: 'info' });
    const text = seatInboxSnapshotText('OP', { openStore: () => store });
    expect(text).toContain(`#${m.id} · TC · info · PR 5 ready`);
    expect(store.messageStatus('OP', m.id)).toBe('delivered');
    expect(store.listReceipts({ messageId: m.id }).map((r) => `${r.state}:${r.source}`)).toContain('delivered:turn-snapshot');
    expect(store.list('OP', store.getCursor('OP'), 50).map((x) => x.id)).toContain(m.id);
    expect(seatInboxSnapshotText(null, { openStore: () => store })).toBeNull();
    store.close();
  });
});
