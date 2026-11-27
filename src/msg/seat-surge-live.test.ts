import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openMsgStore } from './msg-store.js';
import { appendDiverted } from './diverted-mail.js';
import { readSeatSurge, createSeatSurgeWatcher } from './seat-surge-live.js';
import { gatePost, storeGateDeps } from './post-gate.js';
import { SEAT_SURGE_WINDOW_MS } from './seat-surge-monitor.js';

describe('live seat surge', () => {
  test('reads actual isolated ledger and wake requests without consuming them', () => {
    const root = mkdtempSync(join(tmpdir(), 'surge-'));
    const store = openMsgStore(join(root, 'msg.db'));
    try {
      store.post({ from: 'A', to: 'B', kind: 'info', body: 'hello' });
      store.post({ from: 'B', to: 'A', kind: 'info', body: 'world' });
      const now = Date.now();
      appendDiverted('self-wake', { seat: 'A', from: 'A', kind: 'info', body: 'wake', at: new Date(now).toISOString() }, root);
      const a = readSeatSurge(store, 'A', now + 100, root);
      expect(a).toMatchObject({ sent: 1, received: 1, selfWakes: 1, pingPong: [{ peer: 'B', alternations: 2 }] });
      expect(readSeatSurge(store, 'A', now + 100, root).selfWakes).toBe(1);
    } finally { store.close(); }
  });
  test('real ledger detects a same-pair loop but not unrelated pairs', () => {
    const root = mkdtempSync(join(tmpdir(), 'surge-pair-'));
    const store = openMsgStore(join(root, 'msg.db'));
    try {
      for (let i = 0; i < 6; i++) store.post({ from: i % 2 ? 'TC-H-B' : 'TC-H-A', to: i % 2 ? 'TC-H-A' : 'TC-H-B', kind: 'info', body: `${i}` });
      const pairLoop = storeGateDeps(store).pairLoop!;
      expect(pairLoop('TC-H-A', 'TC-H-B', Date.now() + 100)).toBe(true);
      expect(pairLoop('TC-H-A', 'TC-H-C', Date.now() + 100)).toBe(false);
    } finally { store.close(); }
  });
  test('retries a busy self-check, sends one notice per window, and allows another after cooldown', () => {
    let now = 10000000, checks = 0, notices = 0;
    const watcher = createSeatSurgeWatcher({ seat: 'A', now: () => now, coordinator: () => 'TC',
      read: () => ({ seat: 'A', selfWakes: 10, sent: 0, received: 0, pingPong: [], triggers: ['self-wakes'] }),
      selfCheck: () => ++checks > 1, notify: () => { notices++; return true; } });
    watcher.tick(); watcher.tick(); watcher.tick();
    expect([checks, notices]).toEqual([2, 1]);
    now += SEAT_SURGE_WINDOW_MS; watcher.tick();
    expect([checks, notices]).toEqual([3, 2]);
  });
  test('reports the rolling status even below threshold', () => {
    const lines: string[] = [];
    createSeatSurgeWatcher({ seat: 'A', coordinator: () => 'TC', read: () => ({ seat: 'A', selfWakes: 1, sent: 2, received: 3, pingPong: [], triggers: [] }), selfCheck: () => false, notify: () => false, status: line => lines.push(line) }).tick();
    expect(lines[0]).toContain('자가깨움 1 · 발신 2 · 수신 3');
  });
  test('isolated ledger surge drives status, self-check, notice and pair folding together', () => {
    const root = mkdtempSync(join(tmpdir(), 'surge-integrated-'));
    const store = openMsgStore(join(root, 'msg.db'));
    try {
      const seat = 'TC-H-A', peer = 'TC-H-B';
      for (let i = 0; i < 6; i++) store.post({ from: i % 2 ? peer : seat, to: i % 2 ? seat : peer, kind: 'info', body: `${i}` });
      const now = Date.now() + 100;
      const checks: string[] = [], notices: string[] = [], lines: string[] = [], folded: string[] = [];
      const watcher = createSeatSurgeWatcher({ seat, now: () => now, coordinator: () => 'TC',
        read: time => readSeatSurge(store, seat, time, root),
        selfCheck: prompt => { checks.push(prompt); return true; },
        notify: (to, body) => { notices.push(`${to}:${body}`); return true; },
        status: line => lines.push(line) });
      watcher.tick(); watcher.tick();
      expect(lines[0]).toContain('발신 3 · 수신 3 · 왕복 TC-H-B:6');
      expect(checks).toHaveLength(1);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('TC:[seat-surge] TC-H-A');
      const deps = { ...storeGateDeps(store), now: () => new Date(now), append: (ledger: string) => { folded.push(ledger); } };
      const result = gatePost({ envelope: { from: seat, to: peer, kind: 'info', body: 'again' }, entrance: 'tool' }, deps);
      expect(result.action).toBe('divert');
      expect(folded).toEqual(['folded']);
    } finally { store.close(); }
  });
  test('folds looping passive mail, but does not block urgent mail', () => {
    const folded: string[] = [];
    const deps = { pendingPassive: () => 0, turnsLastHour: () => 0, pairLoop: () => true, append: (ledger: string) => { folded.push(ledger); } };
    expect(gatePost({ envelope: { from: 'TC-H-A', to: 'TC-H-B', kind: 'info', body: 'status' }, entrance: 'tool' }, deps).action).toBe('divert');
    expect(folded).toEqual(['folded']);
    expect(gatePost({ envelope: { from: 'TC-H-A', to: 'TC-H-B', kind: 'alert', body: 'urgent' }, entrance: 'tool' }, deps).action).toBe('post');
  });
});
