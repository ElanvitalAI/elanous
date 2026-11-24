// SEAT-MESSAGE-BUS stage 1 — the seat doorbell. Real ledger file (tmp) · real readSeatMailMessages · real fs.watch;
// the poll timer is injected and never fires on its own, so «read without a poll tick» is literal.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import { createNextTuiQueue } from './core/queue.js';
import { createSeatMailArrivalWatcher, resolveDefaultSeatBell, type SeatBellOptions } from './seat-mail-arrival.js';
import { readSeatMailMessages } from './seat-message-receipts.js';

const roots: string[] = [];
const stores: MsgStore[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** true when `check` held within `limitMs` (polled every 10 ms). */
async function until(check: () => boolean, limitMs: number): Promise<boolean> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > limitMs) return false;
    await sleep(10);
  }
  return true;
}

function universe() {
  const root = mkdtempSync(join(tmpdir(), 'seat-bell-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OP'), { recursive: true });
  const cwd = join(root, 'ws', 'seats', 'OP');
  mkdirSync(cwd, { recursive: true });
  const msgPath = join(root, 'state', 'msg', 'messages.db');
  mkdirSync(join(root, 'state', 'msg'), { recursive: true });
  const store = new MsgStore(msgPath);
  stores.push(store);
  return { root, home, cwd, msgPath, store, bellDir: join(root, 'state', 'msg', 'inbox') };
}

function watcherFor(u: ReturnType<typeof universe>, bell: Partial<SeatBellOptions> | false = {}) {
  const queue = createNextTuiQueue({ log: () => {} });
  const intervals: number[] = [];
  let tick: (() => void) | null = null;
  let tickCount = 0;
  let reads = 0;
  const nonEmptyReads: number[][] = [];
  const logs: Array<{ event: string; data: Record<string, unknown>; level: string }> = [];
  const watcher = createSeatMailArrivalWatcher(u.cwd, queue, {
    messages: { read: (cwd, after) => {
      reads += 1;
      const read = readSeatMailMessages(cwd, after, { home: u.home, msgPath: u.msgPath, env: {} });
      if (read && read.messages.length > 0) nonEmptyReads.push(read.messages.map((m) => m.id));
      return read;
    } },
    timer: { set: (fn, ms) => { tick = fn; intervals.push(ms); return intervals.length; }, clear: () => {} },
    log: () => {},
    onReadError: () => {},
    ...(bell === false ? { bell: false as const } : { bell: { dir: u.bellDir, seat: 'OP', log: (event: string, data: Record<string, unknown>, level: string) => { logs.push({ event, data, level }); }, ...bell } }),
  });
  stops.push(() => watcher.stop());
  const mailIds = () => queue.items.filter((item) => item.source === 'seat-mail').map((item) => item.msgId);
  return { queue, watcher, intervals, logs, mailIds, reads: () => reads, nonEmptyReads,
    fireTick: () => { tickCount += 1; tick!(); }, tickCount: () => tickCount };
}

test('msg post rings <SEAT>.bell with {at, lastMsgId}; ALL rings ALL.bell; a group rings each member; ack rings', () => {
  const u = universe();
  const toOp = u.store.post({ from: 'TC', to: 'OP', body: 'ring one' });
  const opBell = JSON.parse(readFileSync(join(u.bellDir, 'OP.bell'), 'utf8')) as { at: string; lastMsgId: number };
  expect(opBell.lastMsgId).toBe(toOp.id);
  expect(Number.isFinite(Date.parse(opBell.at))).toBe(true);
  expect(readFileSync(join(u.bellDir, 'OP.bell'), 'utf8').trim().split('\n')).toHaveLength(1);
  const broadcast = u.store.post({ from: 'TC', to: 'ALL', body: 'to everyone' });
  expect((JSON.parse(readFileSync(join(u.bellDir, 'ALL.bell'), 'utf8')) as { lastMsgId: number }).lastMsgId).toBe(broadcast.id);
  u.store.createGroup('crew', 'UX');
  u.store.joinGroup('group:crew', 'MK');
  const grouped = u.store.post({ from: 'TC', to: 'group:crew', body: 'crew only' });
  expect((JSON.parse(readFileSync(join(u.bellDir, 'UX.bell'), 'utf8')) as { lastMsgId: number }).lastMsgId).toBe(grouped.id);
  expect((JSON.parse(readFileSync(join(u.bellDir, 'MK.bell'), 'utf8')) as { lastMsgId: number }).lastMsgId).toBe(grouped.id);
  const toRes = u.store.post({ from: 'TC', to: 'RES', body: 'res mail' });
  rmSync(join(u.bellDir, 'RES.bell'));
  u.store.ackMessage('RES', toRes.id);
  expect((JSON.parse(readFileSync(join(u.bellDir, 'RES.bell'), 'utf8')) as { lastMsgId: number }).lastMsgId).toBe(toRes.id);
});

test('post → the TUI watcher reads within 1 s with the poll timer never firing', async () => {
  const u = universe();
  const w = watcherFor(u);
  w.watcher.start();
  expect(w.intervals).toEqual([120_000]);
  // The start read (nothing yet) settles first.
  expect(await until(() => w.reads() >= 1, 1000)).toBe(true);
  const posted = u.store.post({ from: 'TC', to: 'OP', body: 'bell please' });
  // Within 1 s of the post, and no poll tick ever fired.
  expect(await until(() => w.mailIds().includes(posted.id), 1000)).toBe(true);
  expect(w.tickCount()).toBe(0);
  expect(w.logs.some((l) => l.event === 'bell-wake' && l.level === 'debug' && typeof l.data.latencyMs === 'number')).toBe(true);
  expect(w.logs.filter((l) => l.event === 'bell-missed')).toEqual([]);
});

test('3 posts within 100 ms → one debounced read containing all 3', async () => {
  const u = universe();
  const w = watcherFor(u);
  w.watcher.start();
  expect(await until(() => w.reads() >= 1, 1000)).toBe(true);
  await sleep(300);
  const a = u.store.post({ from: 'TC', to: 'OP', body: 'one' });
  await sleep(30);
  const b = u.store.post({ from: 'UX', to: 'OP', body: 'two' });
  await sleep(30);
  const c = u.store.post({ from: 'MK', to: 'OP', body: 'three' });
  expect(await until(() => w.mailIds().length === 3, 1000)).toBe(true);
  await sleep(400);
  // One debounced read carried all three (a late duplicate OS event may wake one more read — it finds nothing new).
  expect(w.nonEmptyReads).toEqual([[a.id, b.id, c.id]]);
  expect(w.mailIds()).toEqual([a.id, b.id, c.id]);
  expect(w.tickCount()).toBe(0);
});

test('watcher started after the posts → the start read still sees them (no poll tick)', async () => {
  const u = universe();
  const a = u.store.post({ from: 'TC', to: 'OP', body: 'early one' });
  const b = u.store.post({ from: 'TC', to: 'OP', body: 'early two' });
  const w = watcherFor(u);
  w.watcher.start();
  expect(await until(() => w.mailIds().length === 2, 1000)).toBe(true);
  expect(w.mailIds()).toEqual([a.id, b.id]);
  expect(w.tickCount()).toBe(0);
});

test('fs.watch fails at start → 15 s poll fallback · the poll catches the mail and logs bell-missed', () => {
  const u = universe();
  const w = watcherFor(u, { watch: () => { throw new Error('EMFILE injected'); } });
  w.watcher.start();
  expect(w.intervals).toEqual([15_000]);
  expect(w.logs.some((l) => l.event === 'bell-watch-failed' && l.level === 'warn')).toBe(true);
  const posted = u.store.post({ from: 'TC', to: 'OP', body: 'nobody heard the bell' });
  expect(w.mailIds()).toEqual([]);
  w.fireTick();
  expect(w.mailIds()).toEqual([posted.id]);
  expect(w.logs.filter((l) => l.event === 'bell-missed').map((l) => ({ data: l.data, level: l.level })))
    .toEqual([{ data: { count: 1, seat: 'OP', watching: false }, level: 'info' }]);
});

test('a silent watch (rings never delivered) → the 2-minute safety net catches it and logs bell-missed', async () => {
  const u = universe();
  const w = watcherFor(u, { watch: () => ({ close: () => {} }) });
  w.watcher.start();
  expect(w.intervals).toEqual([120_000]);
  expect(await until(() => w.reads() >= 1, 1000)).toBe(true);
  const posted = u.store.post({ from: 'TC', to: 'OP', body: 'missed ring' });
  await sleep(400);
  expect(w.mailIds()).toEqual([]);
  w.fireTick();
  expect(w.mailIds()).toEqual([posted.id]);
  expect(w.logs.filter((l) => l.event === 'bell-missed').map((l) => l.data)).toEqual([{ count: 1, seat: 'OP', watching: true }]);
});

test('a watch error at runtime → falls back to the 15 s poll', () => {
  const u = universe();
  const hold: { fail?: (error: unknown) => void } = {};
  const w = watcherFor(u, { watch: (_dir, _onEvent, onError) => { hold.fail = onError; return { close: () => {} }; } });
  w.watcher.start();
  expect(w.intervals).toEqual([120_000]);
  hold.fail!(new Error('watch died'));
  expect(w.intervals).toEqual([120_000, 15_000]);
  expect(w.logs.some((l) => l.event === 'bell-watch-failed')).toBe(true);
});

test('final re-check at the idle boundary reads a ring that landed while the turn settled', async () => {
  const u = universe();
  const w = watcherFor(u, { watch: () => ({ close: () => {} }) });
  w.watcher.start();
  expect(await until(() => w.reads() >= 1, 1000)).toBe(true);
  const posted = u.store.post({ from: 'TC', to: 'OP', body: 'rang during settle' });
  expect(w.mailIds()).toEqual([]);
  w.watcher.noteTurnFinished(true);
  expect(w.mailIds()).toEqual([posted.id]);
  expect(w.tickCount()).toBe(0);
});

test('general user (no seat-state, plain git repo) → no bell, the watcher still starts, posting still works', () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-bell-plain-'));
  roots.push(root);
  const repo = join(root, 'project');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const emptyHome = join(root, 'home');
  mkdirSync(emptyHome, { recursive: true });
  expect(resolveDefaultSeatBell(repo, {}, emptyHome)).toBeNull();
  const msgPath = join(root, 'state', 'msg', 'messages.db');
  mkdirSync(join(root, 'state', 'msg'), { recursive: true });
  const store = new MsgStore(msgPath);
  stores.push(store);
  const queue = createNextTuiQueue({ log: () => {} });
  const intervals: number[] = [];
  const watcher = createSeatMailArrivalWatcher(repo, queue, {
    messages: { read: (cwd, after) => readSeatMailMessages(cwd, after, { home: emptyHome, msgPath, env: {} }) },
    timer: { set: (_fn, ms) => { intervals.push(ms); return 1; }, clear: () => {} },
    bell: resolveDefaultSeatBell(repo, {}, emptyHome) ?? false,
    log: () => {},
  });
  stops.push(() => watcher.stop());
  watcher.start();
  expect(intervals).toEqual([15_000]);
  expect(watcher.poll()).toEqual({ kind: 'no-seat' });
  store.post({ from: 'TC', to: 'OP', body: 'plain ledger' });
  expect(store.unreadCount('OP')).toBe(1);
  expect(existsSync(join(root, 'state', 'msg', 'inbox', 'OP.bell'))).toBe(true);
});
