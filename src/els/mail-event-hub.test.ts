// OP P0 2단계 ELS-SERVER-EVENT-HUB-NO-DB-POLL — RED-first tests.
// 계약: 우편 원장 쓰기(post/ack/receipt)는 부수 이벤트 줄을 남기고, els 서버는 그 이벤트 파일만 지켜본다.
// 배지 상태는 부팅 기준선 1회 + 이벤트 때만 재계산 — 목록(주기 폴 포함)은 메모리만 읽고 DB 조회 0.
import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createMailEventHub, type MailEventHubWatch } from './mail-event-hub.js';
import { createMailBadgeState } from './mail-badge-state.js';
import type { MailBadgeCompute } from './mail-badge-cache.js';
import { appendLedgerEvent, ledgerEventsPath } from '../msg/ledger-events.js';

/** Deterministic watch seam: captures the hub's onChange; the test fires it by hand. */
function fakeWatch(): { watch: MailEventHubWatch; fire: () => void } {
  let onChange: (() => void) | undefined;
  return {
    watch: (eventsPath, handler) => { expect(eventsPath.endsWith('.events')).toBe(true); onChange = handler; return () => { onChange = undefined; }; },
    fire: () => { onChange?.(); },
  };
}

const tmp = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), `els-event-hub-${prefix}-`)); return dir; };

describe('writer side — ledger event lines', () => {
  test('appendLedgerEvent writes one JSON line beside the ledger (best-effort, creates dir)', () => {
    const dir = tmp('writer');
    try {
      const dbPath = join(dir, 'messages.db');
      appendLedgerEvent(dbPath, 'posted');
      appendLedgerEvent(dbPath, 'acked');
      const lines = readFileSync(ledgerEventsPath(dbPath), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]!) as { v?: unknown; kind?: unknown };
      const second = JSON.parse(lines[1]!) as { kind?: unknown };
      expect(first.v).toBe(1);
      expect(first.kind).toBe('posted');
      expect(second.kind).toBe('acked');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('appendLedgerEvent never throws on an unwritable path', () => {
    expect(() => appendLedgerEvent('/definitely/not/a/real/dir/messages.db', 'posted')).not.toThrow();
  });
});

describe('reader side — the event hub', () => {
  test('a new event line bumps the revision and wakes subscribers', () => {
    const dir = tmp('hub-wake');
    try {
      const dbPath = join(dir, 'messages.db');
      const watch = fakeWatch();
      const hub = createMailEventHub({ eventsPath: ledgerEventsPath(dbPath), watch: watch.watch });
      const revisions: number[] = [];
      hub.subscribe((rev) => revisions.push(rev));
      expect(hub.revision()).toBe(0);
      hub.start();
      appendLedgerEvent(dbPath, 'posted');
      watch.fire();
      expect(hub.revision()).toBe(1);
      expect(revisions).toEqual([1]);
      appendLedgerEvent(dbPath, 'acked');
      watch.fire();
      expect(hub.revision()).toBe(2);
      expect(revisions).toEqual([1, 2]);
      hub.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a watch callback with no new line is noise — no revision bump, no wake', () => {
    const dir = tmp('hub-noise');
    try {
      const dbPath = join(dir, 'messages.db');
      const watch = fakeWatch();
      const hub = createMailEventHub({ eventsPath: ledgerEventsPath(dbPath), watch: watch.watch });
      const woken: number[] = [];
      hub.subscribe((rev) => woken.push(rev));
      hub.start();
      watch.fire();                 // nothing appended — pure watcher noise
      expect(hub.revision()).toBe(0);
      expect(woken).toEqual([]);
      hub.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('start is idempotent and stop unwakes; unsubscribe stops delivery', () => {
    const dir = tmp('hub-life');
    try {
      const dbPath = join(dir, 'messages.db');
      const watch = fakeWatch();
      const hub = createMailEventHub({ eventsPath: ledgerEventsPath(dbPath), watch: watch.watch });
      const a: number[] = [];
      const b: number[] = [];
      const offA = hub.subscribe((rev) => a.push(rev));
      hub.subscribe((rev) => b.push(rev));
      hub.start();
      hub.start();                   // idempotent
      appendLedgerEvent(dbPath, 'posted');
      watch.fire();
      expect(a).toEqual([1]);
      expect(b).toEqual([1]);
      offA();
      appendLedgerEvent(dbPath, 'posted');
      watch.fire();
      expect(a).toEqual([1]);
      expect(b).toEqual([1, 2]);
      hub.stop();
      watch.fire();                  // stopped: the seam's handler is detached; nothing more can fire
      expect(b).toEqual([1, 2]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('real watch (default adapter — stat watch) wakes the hub on an appended line', async () => {
    const dir = tmp('hub-real');
    try {
      const dbPath = join(dir, 'messages.db');
      mkdirSync(dirname(dbPath), { recursive: true });
      appendLedgerEvent(dbPath, 'posted');      // the file exists before the watch starts
      const hub = createMailEventHub({ eventsPath: ledgerEventsPath(dbPath) });
      const woke: number[] = [];
      hub.subscribe((rev) => woke.push(rev));
      hub.start();
      appendLedgerEvent(dbPath, 'posted');
      for (let i = 0; i < 20 && woke.length === 0; i++) await Bun.sleep(50);
      hub.stop();
      expect(woke.length).toBeGreaterThanOrEqual(1);
      expect(hub.revision()).toBeGreaterThanOrEqual(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a sidecar-loss marker is an event — it wakes subscribers (event-driven resync, no timer)', () => {
    const dir = tmp('hub-loss');
    try {
      const dbPath = join(dir, 'messages.db');
      const watch = fakeWatch();
      let onMarker: (() => void) | undefined;
      const lossWatch: MailEventHubWatch = (_path, handler) => { onMarker = handler; return () => { onMarker = undefined; }; };
      const hub = createMailEventHub({ eventsPath: ledgerEventsPath(dbPath), watch: watch.watch, lossWatch });
      const woken: number[] = [];
      hub.subscribe((rev) => woken.push(rev));
      hub.start();
      onMarker?.();                                                  // the marker file does not exist — watcher noise, no bump
      expect(hub.revision()).toBe(0);
      expect(woken).toEqual([]);
      appendFileSync(`${ledgerEventsPath(dbPath)}.lost`, '{"v":1,"kind":"posted","lost":true,"at":"2026-11-23T00:00:00.000Z"}\n');  // the writer's best-effort loss marker
      onMarker?.();
      expect(hub.revision()).toBe(1);                                // a visible loss is an event: subscribers resync — no timer, no ledger poll
      expect(woken).toEqual([1]);
      hub.stop();
      onMarker?.();
      expect(woken).toEqual([1]);                                    // stopped — detached
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('badge state — memory first, events recompute, listings never touch the ledger', () => {
  test('baseline once; repeat listings are memory-only; an event recomputes known seats', async () => {
    const dir = tmp('badge-state');
    try {
      const dbPath = join(dir, 'messages.db');
      let computed = 0;
      const compute: MailBadgeCompute = (request) => {
        computed += 1;
        return Promise.resolve({ ok: true, changed: true, badges: request.seats.map((seat) => [seat, { count: computed, oldestCreatedAt: null }] as const) });
      };
      const state = createMailBadgeState({ dbPath, compute, minIntervalMs: 0 });
      const watch = fakeWatch();
      const hub = createMailEventHub({ eventsPath: ledgerEventsPath(dbPath), watch: watch.watch });
      state.attach(hub);
      hub.start();
      // baseline: the first listing only *schedules* — unknown reads as null, then the off-thread compute lands (JUD-B #132880 ①)
      expect(state.badges(['OP']).get('OP')).toBe(null);
      await state.settled();
      expect(computed).toBe(1);
      expect(state.badges(['OP']).get('OP')).toEqual({ count: 1, oldestCreatedAt: null });
      // memory-only: the same listing again does not recompute
      expect(state.badges(['OP']).get('OP')).toEqual({ count: 1, oldestCreatedAt: null });
      expect(computed).toBe(1);
      // a new event recomputes the whole known seat set in one pass
      appendLedgerEvent(dbPath, 'posted');
      watch.fire();
      await state.settled();
      expect(computed).toBe(2);
      expect(state.badges(['OP']).get('OP')).toEqual({ count: 2, oldestCreatedAt: null });
      expect(computed).toBe(2);            // the post-event listing is still memory-only
      // a second seat appears: the listing stays instant; the baseline compute lands off-thread
      expect(state.badges(['OP', 'MK']).get('MK')).toBe(null);
      await state.settled();
      expect(computed).toBe(3);
      expect(state.badges(['OP', 'MK']).get('MK')).toEqual({ count: 3, oldestCreatedAt: null });
      hub.stop();
      state.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a first-seen seat computes once on demand and then serves from memory', async () => {
    const dir = tmp('badge-newseat');
    try {
      let computed = 0;
      const compute: MailBadgeCompute = (request) => {
        computed += 1;
        return Promise.resolve({ ok: true, changed: true, badges: request.seats.map((seat) => [seat, { count: 100 + computed, oldestCreatedAt: null }] as const) });
      };
      const state = createMailBadgeState({ dbPath: join(dir, 'messages.db'), compute, minIntervalMs: 0 });
      expect(state.badges(['TC']).get('TC')).toBe(null);            // scheduled, not answered on this stack
      await state.settled();
      expect(state.badges(['TC']).get('TC')).toEqual({ count: 101, oldestCreatedAt: null });
      expect(state.badges(['TC', 'UX']).get('TC')).toEqual({ count: 101, oldestCreatedAt: null });
      expect(state.badges(['UX']).get('UX')).toBe(null);
      await state.settled();
      expect(state.badges(['UX']).get('UX')).toEqual({ count: 102, oldestCreatedAt: null });
      expect(computed).toBe(2);
      state.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
