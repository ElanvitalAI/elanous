import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDirective, isLive, mayRetract, parseExpiresDuration, postExpiry } from './directive-expiry.js';
import { openMsgStore } from './msg-store.js';

const NOW = new Date('2026-11-25T08:00:00.000Z');

describe('DIRECTIVE-EXPIRY postExpiry', () => {
  test('kind table: info 30m · request 2h · crown directive 2h · question none', () => {
    expect(postExpiry({ kind: 'info', now: NOW }).expiresAt).toBe('2026-11-25T08:30:00.000Z');
    expect(postExpiry({ kind: 'status', now: NOW }).expiresAt).toBe('2026-11-25T08:30:00.000Z');
    expect(postExpiry({ kind: 'coord', now: NOW }).expiresAt).toBe('2026-11-25T10:00:00.000Z');
    expect(postExpiry({ kind: 'info', crownDirective: '412', now: NOW })).toEqual({ expiresAt: '2026-11-25T10:00:00.000Z', rule: 'directive' });
    expect(postExpiry({ kind: 'question', now: NOW })).toEqual({ rule: 'kind-unlisted' });
  });
  test('flags: --expires 45m · --standing 24h · --no-expiry · two flags refused', () => {
    expect(postExpiry({ kind: 'info', expires: '45m', now: NOW }).expiresAt).toBe('2026-11-25T08:45:00.000Z');
    expect(postExpiry({ goal: 'land 10/h', standing: true, now: NOW }).expiresAt).toBe('2026-11-26T08:00:00.000Z');
    expect(postExpiry({ crownDirective: '9', expiry: false, now: NOW })).toEqual({ rule: 'none' });
    expect(() => postExpiry({ expires: '1h', expiry: false, now: NOW })).toThrow('use one of');
    expect(() => parseExpiresDuration('soon')).toThrow('--expires needs a duration');
  });
  test('request from above is a directive; from a peer it is not', () => {
    expect(isDirective({ kind: 'request', senderAbove: true })).toBe(true);
    expect(isDirective({ kind: 'request', senderAbove: false })).toBe(false);
    expect(isLive({ expiresAt: '2026-11-25T07:59:59.000Z' }, NOW.getTime())).toBe(false);
    expect(mayRetract('op', 'TC')).toBe(true);
    expect(mayRetract('UX', 'TC')).toBe(false);
  });
});

describe('DIRECTIVE-EXPIRY store', () => {
  test('retract closes the original: it leaves the unread list and lands in listLapsed', () => {
    const store = openMsgStore(join(mkdtempSync(join(tmpdir(), 'dexp-')), 'm.db'));
    const first = store.post({ from: 'OP', to: 'TC', body: 'assign PR 7 now', kind: 'request', crownDirective: '77', expiresAt: '2099-01-01T00:00:00.000Z' });
    store.post({ from: 'OP', to: 'TC', body: 'never mind', kind: 'info', supersedes: first.id });
    expect(store.list('TC', 0, 50).map((m) => m.id)).toContain(first.id);
    const closed = store.retract(first.id, 'OP', new Date(Date.now() - 1000));
    expect(closed?.retracted).toBe(first.id);
    expect(store.list('TC', 0, 50).map((m) => m.id)).not.toContain(first.id);
    expect(store.listLapsed('TC', new Date(Date.now() - 60_000)).map((m) => m.id)).toEqual([first.id]);
    expect(() => store.retract(first.id, 'UX')).toThrow('may not retract');
    store.close();
  });
});
