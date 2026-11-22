// JUD-B hold 회귀 — #132880 ① 이벤트 구동 갱신도 오프스레드(요청 스택 위 계산 0) ② sidecar 유실 자가회복.
// judb-39675-864417dcf533 ① 유실 회복은 주기 타이머 아닌 마커 사건 ② 계산 중 커밋은 dirty 보존(완료 직후 후속).
// 시험 기대값은 리터럴(제품 상수 재사용 없음): 300ms 느린 compute · 50ms 목록 상한 · 250ms 지연 계산 · 40ms 대기.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unwatchFile, watchFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMailBadgeState } from './mail-badge-state.js';
import { ledgerEventsPath } from '../msg/ledger-events.js';
import { createMailEventHub, type MailEventHubWatch } from './mail-event-hub.js';
import { openMsgStore, readUnreadMailBadges } from '../msg/msg-store.js';
import { startElsServer } from './server.js';
import type { ElsPty } from './core.js';
import type { MailBadgeCompute } from './mail-badge-cache.js';

// A Unix socket path holds at most 103 bytes (macOS): a long TMPDIR would push <state>/els/ over it.
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();

function fakePty(): ElsPty {
  return { id: `pty-${Math.random().toString(16).slice(2)}`, isAlive: () => true, write: () => {},
    renderScreen: async () => '$', onExit: () => {}, kill: () => {} };
}

const eventually = async (predicate: () => boolean, ms = 3_000): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (predicate()) return true; await new Promise((resolve) => setTimeout(resolve, 25)); }
  return predicate();
};

describe('mustFix ① — 이벤트 구동 갱신도 오프스레드 (요청 스택 위 계산 0)', () => {
  test('(a) 300ms busy compute: badges()는 50ms 안에 답하고, 계산은 요청 스택 밖에서 나중에 온다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbs-off-'));
    try {
      let calls = 0;
      const compute: MailBadgeCompute = (request) => {
        calls += 1;
        const until = performance.now() + 300;
        while (performance.now() < until) { /* busy — if this ran on the request stack, badges() would take ≥300ms */ }
        return Promise.resolve({ ok: true, changed: true, badges: request.seats.map((seat) => [seat, { count: 9, oldestCreatedAt: '2026-11-23T00:00:00.000Z' }] as const) });
      };
      const state = createMailBadgeState({ dbPath: join(dir, 'none.db'), compute, minIntervalMs: 0 });
      const started = performance.now();
      const first = state.badges(['SEAT-A']);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(50);           // the listing never runs the compute
      expect(calls).toBe(0);                      // not even started on this stack
      expect(first.get('SEAT-A')).toBe(null);     // unknown ≠ 0 before the off-thread baseline lands
      expect(await eventually(() => state.badges(['SEAT-A']).get('SEAT-A')?.count === 9)).toBe(true);
      expect(calls).toBe(1);
      state.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('(b) 실제 서버 경로 회귀: startElsServer 배선에서도 목록은 즉답 — 느린 compute가 서버 스레드를 못 막는다', async () => {
    const dir = mkdtempSync(join(SOCKET_SAFE_TMP, 'mbs-server-'));
    try {
      const compute: MailBadgeCompute = (request) => {
        const until = performance.now() + 300;
        while (performance.now() < until) { /* busy */ }
        return Promise.resolve({ ok: true, changed: true, badges: request.seats.map((seat) => [seat, { count: 4, oldestCreatedAt: null }] as const) });
      };
      const ledger = join(dir, 'msg', 'messages.db');
      const boot = await startElsServer({ stateRoot: join(dir, 'state'), mailBadgeLedgerPath: ledger, mailBadgeCompute: compute, spawn: () => fakePty(), reapIntervalMs: 1_000_000 });
      if (!('server' in boot)) throw new Error(`boot refused: ${boot.message}`);
      const core = boot.core;
      const pane = (JSON.parse(core.newPane({ ws: 'w', cwd: join(dir, 'seats', 'SEAT-OT', 'w'), command: ['/bin/sh'] }).message) as { pane: string }).pane;
      const badge = (): number | null =>
        ((JSON.parse(core.list().message) as { panes: Array<{ pane: string; unreadMail: { count: number } | null }> })
          .panes.find((row) => row.pane === pane)?.unreadMail ?? null)?.count ?? null;
      const started = performance.now();
      const firstBadge = badge();
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(50);           // the real server path answers the listing at once
      expect(firstBadge).toBe(null);              // unknown until the off-thread baseline lands
      expect(await eventually(() => badge() === 4)).toBe(true);
      await boot.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('mustFix ② — sidecar 유실: 후속 우편 0통으로도 유실 마커 사건이 회복한다(judb-39675 ①)', () => {
  test('(c) sidecar 줄이 안 남는 쓰기 실패(디렉터리) — 마커 사건이 배지를 스스로 고치고 유실이 보인다', async () => {
    const dir = mkdtempSync(join(SOCKET_SAFE_TMP, 'mbs-lost-'));
    try {
      const ledger = join(dir, 'msg', 'messages.db');
      const store = openMsgStore(ledger);                        // another process' writer, the way `eln msg` opens it
      mkdirSync(ledgerEventsPath(ledger), { recursive: true });  // appendFileSync now fails (EISDIR) — the sidecar line is lost
      const compute: MailBadgeCompute = (request) =>
        Promise.resolve({ ok: true, changed: true, badges: [...readUnreadMailBadges(request.seats, request.path).entries()] });
      const boot = await startElsServer({ stateRoot: join(dir, 'state'), mailBadgeLedgerPath: ledger, mailBadgeCompute: compute, spawn: () => fakePty(), reapIntervalMs: 1_000_000 });
      if (!('server' in boot)) throw new Error(`boot refused: ${boot.message}`);
      const core = boot.core;
      const pane = (JSON.parse(core.newPane({ ws: 'w', cwd: join(dir, 'seats', 'SEAT-LS', 'w'), command: ['/bin/sh'] }).message) as { pane: string }).pane;
      const badge = (): number | null =>
        ((JSON.parse(core.list().message) as { panes: Array<{ pane: string; unreadMail: { count: number } | null }> })
          .panes.find((row) => row.pane === pane)?.unreadMail ?? null)?.count ?? null;
      expect(await eventually(() => badge() === 0)).toBe(true);   // the off-thread baseline lands (0 unread)
      store.post({ from: 'OP', to: 'SEAT-LS', body: 'lost line' });  // commits; its sidecar line is lost (EISDIR) — no event line can ever rescue
      expect(await eventually(() => badge() === 1)).toBe(true);   // the loss-marker event healed it — no follow-up mail, no timer
      expect(existsSync(`${ledgerEventsPath(ledger)}.lost`)).toBe(true);  // the loss is visible, not silent
      await boot.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('(d) 계산 중 커밋 — dirty 로 보존돼 완료 직후 후속 계산(지연 compute 순서 회귀, judb-39675 ②)', async () => {
    const dir = mkdtempSync(join(SOCKET_SAFE_TMP, 'mbs-dirty-'));
    try {
      const ledger = join(dir, 'msg', 'messages.db');
      const store = openMsgStore(ledger);                          // its post commits and leaves a sidecar line
      const order: string[] = [];
      let calls = 0;
      const compute: MailBadgeCompute = (request) => {
        const i = calls; calls += 1;
        order.push(`start#${i}`);
        if (i === 0) return new Promise((resolve) => setTimeout((): void => {   // the baseline compute is slow — 250ms
          order.push('resolve#0');
          resolve({ ok: true, changed: true, badges: request.seats.map((seat) => [seat, { count: 0, oldestCreatedAt: null }] as const) });
        }, 250));
        return Promise.resolve({ ok: true, changed: true, badges: request.seats.map((seat) => [seat, { count: 1, oldestCreatedAt: null }] as const) });
      };
      const state = createMailBadgeState({ dbPath: ledger, compute, minIntervalMs: 0 });
      const fastWatch: MailEventHubWatch = (p, cb) => { watchFile(p, { interval: 20, persistent: false }, cb); return () => { unwatchFile(p); }; };
      const hub = createMailEventHub({ eventsPath: ledgerEventsPath(ledger), watch: fastWatch });
      state.attach(hub);
      hub.start();
      expect(state.badges(['SEAT-D']).get('SEAT-D')).toBe(null);   // the baseline is scheduled, not answered here
      await new Promise((resolve) => setTimeout(resolve, 40));     // compute#0 is in flight (delayed) — the commit lands inside it
      expect(order).toEqual(['start#0']);
      store.post({ from: 'OP', to: 'SEAT-D', body: 'mid-flight' });  // a commit while the compute is in flight
      await state.settled();                                        // the baseline lands; the mid-flight commit must not be lost
      expect(state.badges(['SEAT-D']).get('SEAT-D')?.count).toBe(1);                // dirty follow-up — the badge reflects the mid-flight commit
      expect(calls).toBe(2);                                                         // exactly one follow-up compute
      expect(order.indexOf('start#1')).toBeGreaterThan(order.indexOf('resolve#0'));  // ordering: the follow-up began after the first resolved
      hub.stop();
      state.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
