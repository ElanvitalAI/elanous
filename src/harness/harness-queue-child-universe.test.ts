// CHILD-UNIV-COUNT — 도는 수·자리 몫·동결이 «파생 자식 우주»를 포함한다(10-05 23:00 TC/MK «도는 수 0» 오판).
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { addHarnessQueue, harnessQueueChildUniverseRoots, readHarnessQueueInventory, tickHarnessQueue,
  type HarnessQueueDeps, type QueueInventory, type QueueProcess } from './harness-queue.js';
import { saveSelfDevRun, selfDevRunsDir } from '../self-dev/run-store.js';
import { enableLandingFreeze } from '../release-loop/landing-freeze.js';
import { debug } from '../debug/log.js';
import { spyOn } from 'bun:test';

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'hq-child-univ-')); roots.push(path); return path; };
afterEach(() => {
  for (const path of roots.splice(0)) {
    try { chmodSync(join(path, 'self-dev-runs'), 0o755); } catch { /* not every root has one */ }
    rmSync(path, { recursive: true, force: true });
  }
});

function deps(dir: string, launches: string[][], inventory: (trees: readonly string[]) => QueueInventory): HarnessQueueDeps {
  let nextPid = 101;
  return { root: dir, pool: () => ({ running: 0, pending: 0, reserved: 0, limit: 8 }), cap: () => 2, alive: () => true,
    inventory, burstMax: 1, launchStaggerMs: 0, authorShadow: () => {}, idleRequest: () => {},
    launch: async (_item, args) => { launches.push(args); return nextPid++; }, log: () => {} };
}

const ps = (rows: string) => ((_command: string) => ({ status: 0, stdout: rows })) as unknown as typeof import('node:child_process').spawnSync;

test('inventory reads the parent ledger and a derived child universe ledger and marks the child run', () => {
  const parent = root(), child = root(), now = Date.now();
  saveSelfDevRun({ runId: 'parent-run', createdAt: now, updatedAt: now, results: [], pid: 951, pidStart: 'b:951', seat: 'TC' }, selfDevRunsDir(parent));
  saveSelfDevRun({ runId: 'child-run', createdAt: now, updatedAt: now, results: [], pid: 952, pidStart: 'b:952', seat: 'TC' }, selfDevRunsDir(child));
  const inventory = readHarnessQueueInventory({ platform: 'darwin', seatTrees: {}, runsDir: selfDevRunsDir(parent),
    run: ps('951 1 bun /repo/bin/elanous.mjs harness say a\n952 1 bun /repo/bin/elanous.mjs self implement b'),
    birthId: (pid) => `b:${pid}`, childUniverseRoots: () => [child] });
  expect(inventory.childUniverses).toEqual({ roots: [child], unreadable: [] });
  expect(inventory.processes).toEqual([
    { pid: 951, seat: 'TC', progressAt: now, ledgerRunIds: ['parent-run'] },
    { pid: 952, seat: 'TC', progressAt: now, ledgerRunIds: ['child-run'], universe: 'child' },
  ]);
  // 반증: 자식 우주를 안 읽으면 자식 런은 자리도 진행도 없다(«도는 수 0» 의 뿌리).
  expect(readHarnessQueueInventory({ platform: 'darwin', seatTrees: {}, runsDir: selfDevRunsDir(parent),
    run: ps('952 1 bun /repo/bin/elanous.mjs self implement b'), birthId: (pid) => `b:${pid}`, childUniverseRoots: () => [] }).processes)
    .toEqual([{ pid: 952 }]);
});

test('an unreadable child universe store is reported «unreadable», never as zero runs', () => {
  if (process.getuid?.() === 0) return; // root can list mode-000 directories
  const parent = root(), child = root(), missing = root();
  mkdirSync(selfDevRunsDir(child), { recursive: true });
  chmodSync(selfDevRunsDir(child), 0o000);
  const inventory = readHarnessQueueInventory({ platform: 'darwin', seatTrees: {}, runsDir: selfDevRunsDir(parent),
    run: ps(''), childUniverseRoots: () => [child, missing] });
  // A universe without a self-dev store yet is read (none); only the store that exists but cannot be listed is unreadable.
  expect(inventory.childUniverses).toEqual({ roots: [child, missing], unreadable: [child] });
});

test('seat count sums parent and child universe runs and the limit line shows both', async () => {
  const dir = root(), launches: string[][] = [], now = Date.now();
  const processes: QueueProcess[] = [
    { pid: 951, seat: 'TC', progressAt: now },
    { pid: 952, seat: 'TC', progressAt: now, universe: 'child' },
  ];
  const seen: (readonly string[])[] = [];
  const d = deps(dir, launches, (trees) => { seen.push(trees); return { processes, childUniverses: { roots: ['/tree/.elanous-test'], unreadable: [] } }; });
  const row = await addHarnessQueue({ seat: 'TC', say: 'third', launchCwd: '/tree' }, d);
  const tick = await tickHarnessQueue(d, row.id);
  expect(tick.outcome).toBe('waiting');
  expect(tick.reason).toMatch(/^seat TC: 2\/2 \(.*\) · 부모 1 ⊕ 자식 우주 1$/);
  expect(seen).toEqual([['/tree']]);
  expect(launches).toHaveLength(0);
  // 반증: 자식 우주 런을 빼면 1/2 라 발사한다.
  const d2 = deps(root(), launches, () => ({ processes: [processes[0]!], childUniverses: { roots: ['/tree/.elanous-test'], unreadable: [] } }));
  await addHarnessQueue({ seat: 'TC', say: 'second' }, d2);
  expect((await tickHarnessQueue(d2)).outcome).toBe('launched');
});

test('an unreadable child universe holds the launch and the line says «못 읽음»', async () => {
  const dir = root(), launches: string[][] = [];
  const d = deps(dir, launches, () => ({ processes: [], childUniverses: { roots: ['/a/.elanous-test'], unreadable: ['/b/.elanous-test'] } }));
  const row = await addHarnessQueue({ seat: 'MK', say: 'room but unknown' }, d);
  const tick = await tickHarnessQueue(d, row.id);
  expect(tick.outcome).toBe('waiting');
  expect(tick.reason).toContain('seat MK: 0/2');
  expect(tick.reason).toContain('부모 0 ⊕ 자식 우주 0 ⊕ 못 읽음 1곳');
  expect(tick.reason).toContain('자식 우주 못 읽음: /b/.elanous-test');
  expect(launches).toHaveLength(0);
});

test('a tick in a child universe honors the production launch freeze', async () => {
  const dir = root(), prod = root(), launches: string[][] = [];
  enableLandingFreeze({ reason: 'prod hold', holdLaunches: true }, prod);
  const d = { ...deps(dir, launches, () => ({ processes: [], childUniverses: { roots: [], unreadable: [] } })), prodFreezeRoot: prod };
  const row = await addHarnessQueue({ seat: 'UX', say: 'frozen' }, d);
  expect(await tickHarnessQueue(d, row.id)).toMatchObject({ outcome: 'waiting', reason: '동결 — prod hold' });
  expect(launches).toHaveLength(0);
});

test('child universe roots come from the registry and derived trees, never the parent, a dead or remote entry, or a missing root', () => {
  const tree = root(), other = root(), parent = root();
  mkdirSync(join(tree, '.git')); mkdirSync(join(tree, '.elanous-test'));
  mkdirSync(join(other, '.git')); // derived universe never created
  const live = root(), dead = root(), remote = root();
  const roots = harnessQueueChildUniverseRoots({
    parentRoot: parent, seatTrees: { TC: [join(tree, 'sub')] }, launchTrees: [other], ownTree: null,
    registry: () => [
      { stateDir: live, kind: 'test', liveness: 'alive' },
      { stateDir: dead, kind: 'test', liveness: 'dead' },
      { stateDir: remote, kind: 'test', liveness: 'remote' },
      { stateDir: parent, kind: 'test', liveness: 'alive' },
    ],
  });
  expect(roots).toEqual([resolve(join(tree, '.elanous-test')), resolve(live)].sort());
});

test('CHILD-UNIV-HOLD: an unreadable universe holds two ticks, then launches with pool headroom minus n', async () => {
  const dir = root(), launches: string[][] = [], clock = new Date('2026-10-07T00:00:00Z');
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
    if (category === 'harness.queue') events.push({ event, data });
  }) as typeof debug.log);
  try {
    let pool = { running: 0, pending: 0, reserved: 0, limit: 3 };
    const d: HarnessQueueDeps = { ...deps(dir, launches, () => ({ processes: [],
      childUniverses: { roots: ['/a/.elanous-test'], unreadable: ['/b/.elanous-test', '/c/.elanous-test'] } })),
      now: () => clock, pool: () => pool };
    const row = await addHarnessQueue({ seat: 'MK', say: 'held twice' }, d);
    for (let tick = 0; tick < 2; tick++) {
      const held = await tickHarnessQueue(d, row.id);
      expect(held.outcome).toBe('waiting');
      expect(held.reason).toContain('못 읽음 2곳');
      expect(held.reason).not.toContain('보수 차감');
    }
    expect(events.filter((row) => row.event === 'unreadable-universe' && row.data.holding === true)).toHaveLength(2);
    // Third tick: no hold, but 2 unreadable universes eat 2 of 3 pool slots — 1 running fills it.
    pool = { running: 1, pending: 0, reserved: 0, limit: 3 };
    const charged = await tickHarnessQueue(d, row.id);
    expect(charged).toMatchObject({ outcome: 'waiting', reason: 'pool: 1+0+0+0+못 읽음 2곳(보수 차감)/3' });
    expect(events.at(-1)?.data).toMatchObject({ holding: false, penalty: 2 });
    // 반증: 같은 풀에서 차감이 없었다면 1+0 < 3 이라 떴다. 여유가 생기면 발사한다.
    pool = { running: 0, pending: 0, reserved: 0, limit: 3 };
    expect(await tickHarnessQueue(d, row.id)).toMatchObject({ outcome: 'launched', item: { id: row.id } });
    expect(launches).toHaveLength(1);
    // Seat line after the hold says «보수 차감».
    const capped = { ...d, cap: () => 1 };
    await addHarnessQueue({ seat: 'MK', say: 'seat full' }, capped);
    expect((await tickHarnessQueue(capped)).reason).toContain('못 읽음 2곳(보수 차감)');
  } finally { spy.mockRestore(); }
});

test('CHILD-UNIV-HOLD: a universe unreadable over an hour alerts once per day; readable again clears the state', async () => {
  const dir = root(), launches: string[][] = [], clock = new Date('2026-10-07T00:00:00Z'), alerts: string[] = [];
  let unreadable = ['/b/.elanous-test'];
  const d: HarnessQueueDeps = { ...deps(dir, launches, () => ({ processes: [], childUniverses: { roots: [], unreadable } })),
    now: () => clock, unreadableAlert: (text) => { alerts.push(text); } };
  const row = await addHarnessQueue({ seat: 'UX', say: 'alert' }, d);
  await tickHarnessQueue(d, row.id);
  expect(alerts).toHaveLength(0);
  clock.setTime(clock.getTime() + 61 * 60_000);
  await tickHarnessQueue(d, row.id);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain('/b/.elanous-test');
  clock.setTime(clock.getTime() + 10 * 60_000);
  // Third tick: hold over — it launches with the pool penalty and does not alert again the same day.
  expect(await tickHarnessQueue(d, row.id)).toMatchObject({ outcome: 'launched' });
  expect(alerts).toHaveLength(1);
  // Readable again: the row goes, and a later unreadable spell starts a fresh two-tick hold without an instant alert.
  unreadable = [];
  const readable = await addHarnessQueue({ seat: 'OP', say: 'readable' }, d);
  expect(await tickHarnessQueue(d, readable.id)).toMatchObject({ outcome: 'launched' });
  unreadable = ['/b/.elanous-test'];
  const again = await addHarnessQueue({ seat: 'UX', say: 'fresh hold' }, d);
  const held = await tickHarnessQueue(d, again.id);
  expect(held.outcome).toBe('waiting');
  expect(held.reason).not.toContain('보수 차감');
  expect(alerts).toHaveLength(1);
});
