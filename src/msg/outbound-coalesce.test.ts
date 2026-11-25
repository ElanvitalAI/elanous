import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendedBody, coalesceEligible, outboundBudgetLine } from './outbound-coalesce.js';
import { openMsgStore } from './msg-store.js';

describe('OUTBOUND-COALESCE', () => {
  test('only ordinary orders from above fold', () => {
    expect(coalesceEligible({ senderAbove: true, kind: 'info' })).toBe(true);
    expect(coalesceEligible({ senderAbove: false, kind: 'info' })).toBe(false);
    expect(coalesceEligible({ senderAbove: true, kind: 'info', crownDirective: '5' })).toBe(false);
    expect(coalesceEligible({ senderAbove: true, kind: 'alert' })).toBe(false);
    expect(coalesceEligible({ senderAbove: true, kind: 'coord', priority: 1 })).toBe(false);
    expect(coalesceEligible({ senderAbove: true, kind: 'request' })).toBe(false);
    expect(coalesceEligible({ senderAbove: true })).toBe(false);
    expect(coalesceEligible({ senderAbove: true, kind: 'info', replyTo: 4 })).toBe(false);
    expect(coalesceEligible({ senderAbove: true, kind: 'info', to: 'TA' })).toBe(false);
    expect(coalesceEligible({ senderAbove: true, kind: 'info', supersedes: 9 })).toBe(false);
    expect(coalesceEligible({ senderAbove: true, kind: 'coord', needsReply: true })).toBe(false);
    expect(appendedBody('a', 'b', new Date(2026, 10, 25, 9, 5))).toBe('a\n— +09:05\nb');
    expect(outboundBudgetLine(30)).toBeNull();
    expect(outboundBudgetLine(31)).toBe('you sent 31 mails in 30 min — bundle (one mail per receiver per step)');
  });
  test('store: appends to the unread undelivered mail; a delivered one starts a new row', () => {
    const store = openMsgStore(join(mkdtempSync(join(tmpdir(), 'coal-')), 'm.db'));
    const first = store.post({ from: 'OP', to: 'TC', body: 'take cell A1', kind: 'info' });
    const joined = store.coalesceInto('OP', 'TC', 'and cell A2', 10 * 60_000, new Date(Date.now() + 60_000));
    expect(joined?.id).toBe(first.id);
    expect(joined?.body).toMatch(/^take cell A1\n— \+\d\d:\d\d\nand cell A2$/);
    store.recordReceipt({ messageId: first.id, recipient: 'TC', state: 'delivered', source: 'turn-snapshot' });
    expect(store.coalesceInto('OP', 'TC', 'and cell A3', 10 * 60_000)).toBeNull();
    const crown = store.post({ from: 'OP', to: 'UX', body: 'demo first', kind: 'info', crownDirective: '8' });
    expect(store.coalesceInto('OP', 'UX', 'x', 10 * 60_000)).toBeNull();
    expect(crown.id).toBeGreaterThan(first.id);
    expect(store.countSentSince('OP', new Date(Date.now() - 60_000))).toBe(2);
    store.close();
  });
});

describe('MSG-NOISE', () => {
  test('top sender × kind by count', () => {
    const store = openMsgStore(join(mkdtempSync(join(tmpdir(), 'noise-')), 'm.db'));
    for (let i = 0; i < 3; i += 1) store.post({ from: 'OP', to: `T${i}`, body: `a${i}`, kind: 'info' }, { dedupe: false });
    for (let i = 0; i < 2; i += 1) store.post({ from: 'TC', to: 'OP', body: `b${i}`, kind: 'status' }, { dedupe: false });
    store.post({ from: 'UX', to: 'OP', body: 'c', kind: 'request' });
    expect(store.noiseTop(new Date(Date.now() - 60_000), 2)).toEqual([{ sender: 'OP', kind: 'info', count: 3 }, { sender: 'TC', kind: 'status', count: 2 }]);
    store.close();
  });
});
