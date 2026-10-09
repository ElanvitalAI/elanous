import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { installHarnessCliCommand } from './harness-cli-command.js';
import { getUserConfig } from '../user-config.js';
import { addHarnessQueue, harnessQueueCountingLimits, queueLaunchTime, HarnessQueueDuplicateError, queueCellId, harnessQueueIdForKey, harnessQueueOutcome, harnessQueuePath, harnessQueueReceiptPath, listHarnessQueue, queueLaunchArgs, queueSeatForCwd, queuePodRunsFromJobs, queueRunLabelValue, readHarnessQueuePodRuns, readHarnessQueueProcesses, queueCellRubricPriority, QUEUE_CEO_PRIORITY_BONUS, reconcileHarnessQueue, removeHarnessQueue, requestIdleSeats, setHarnessQueuePriority, tickHarnessQueue, type HarnessQueueDeps, type QueueItem } from './harness-queue.js';
import { checkpointDependenciesForRun, loadSelfDevRun, processBirthId, saveSelfDevRun, selfDevRunsDir } from '../self-dev/run-store.js';
import { bindOrchestrateRunLedger } from '../self-dev/self-orchestrate-runtime.js';
import { debug } from '../debug/log.js';
import { k8sLabelValue } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { runHarnessQueueChild } from './harness-queue-child.js';
import { collectAuthorDepth, runAuthorDepthShadow } from '../loops/orchestrator/author-depth.js';
import { AuthorLedger } from '../loops/orchestrator/author-ledger.js';
import { setSchedule } from '../release-loop/release-schedule.js';
import { disableLandingFreeze, enableLandingFreeze, landingFreezePath } from '../release-loop/landing-freeze.js';

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'harness-queue-')); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(dir: string, launches: string[][], pool = { running: 0, pending: 0, reserved: 0, limit: 2 }): HarnessQueueDeps {
  let nextPid = 101;
  // One launch per tick and no stagger keep the single-launch contracts below; QUEUE-BURST tests opt in.
  return { root: dir, pool: () => pool, cap: () => 2, alive: () => true, processes: () => [], burstMax: 1, launchStaggerMs: 0,
    authorShadow: () => {}, idleRequest: () => {}, launch: async (_item, args) => { launches.push(args); return nextPid++; }, log: () => {} };
}

test('queue freeze holds launches only when requested, then releases queued rows when off or expired', async () => {
  const dir = root(), launches: string[][] = [], events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const clock = new Date('2026-10-05T00:00:00Z');
  const deps: HarnessQueueDeps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 8 }), now: () => clock,
    log: (event, data) => { events.push({ event, data }); } };
  const tc = await addHarnessQueue({ seat: 'TC', say: 'TC launch' }, deps);
  const ux = await addHarnessQueue({ seat: 'UX', say: 'UX launch' }, deps);
  enableLandingFreeze({ reason: 'landings only' }, dir, clock);
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: tc.id } });
  enableLandingFreeze({ reason: 'operator hold', holdLaunches: true }, dir, clock);
  const reason = '동결 — operator hold';
  expect(await tickHarnessQueue(deps, ux.id)).toMatchObject({ outcome: 'waiting', item: { id: ux.id, waitingReason: reason }, reason });
  expect(listHarnessQueue(deps).find(row => row.id === ux.id)).toMatchObject({ status: 'queued', waitingReason: reason });
  expect(launches).toHaveLength(1);
  expect(events.some(row => row.event === 'waiting' && row.data.id === ux.id && row.data.reason === reason)).toBe(true);
  disableLandingFreeze(dir);
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: ux.id } });
  const mk = await addHarnessQueue({ seat: 'MK', say: 'MK after expiry' }, deps);
  enableLandingFreeze({ reason: 'brief hold', until: '2026-10-05T00:01:00Z', holdLaunches: true }, dir, clock);
  expect(await tickHarnessQueue(deps, mk.id)).toMatchObject({ outcome: 'waiting', reason: '동결 — brief hold · ~2026-10-05T00:01:00.000Z' });
  clock.setTime(Date.parse('2026-10-05T00:01:00Z'));
  expect(await tickHarnessQueue(deps, mk.id)).toMatchObject({ outcome: 'launched', item: { id: mk.id } });
  expect(launches).toHaveLength(3);
});

test('queue freeze held tick never invokes launch or lease, and unreadable freeze data fails closed', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = fixture(dir, launches);
  await addHarnessQueue({ seat: 'TC', say: 'first' }, deps);
  enableLandingFreeze({ reason: 'emergency', holdLaunches: true }, dir);
  const original = debug.log, held: unknown[] = [];
  (debug as { log: typeof debug.log }).log = ((category, event, data) => {
    if (category === 'loop.orchestrator' && event === 'freeze-held-launch') held.push(data);
  }) as typeof debug.log;
  try {
    const result = await tickHarnessQueue({ ...deps, pool: () => { throw Error('lease should not run'); },
      launch: async () => { throw Error('launcher should not run'); } });
    expect(result).toMatchObject({ outcome: 'waiting', reason: expect.stringContaining('emergency') });
    expect(held).toEqual([{ reason: 'emergency', until: null, queued: 1, phase: 'tick-start' }]);
    expect(launches).toHaveLength(0);
    const data = JSON.parse(readFileSync(landingFreezePath(dir), 'utf8'));
    writeFileSync(landingFreezePath(dir), JSON.stringify({ ...data, holdLaunches: 'true' }));
    expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'waiting', reason: '동결 상태 읽기 실패' });
    expect(launches).toHaveLength(0);
    expect(held.at(-1)).toEqual({ reason: '동결 상태 읽기 실패', until: null, queued: 1, phase: 'tick-start' });
  } finally { (debug as { log: typeof debug.log }).log = original; }
});

test('queue freeze turned on while the tick awaits (idle request) still holds the launch right before spawning', async () => {
  const dir = root(), launches: string[][] = [];
  const deps: HarnessQueueDeps = { ...fixture(dir, launches),
    idleRequest: async () => { enableLandingFreeze({ reason: 'late hold', holdLaunches: true }, dir); } };
  const item = await addHarnessQueue({ seat: 'MK', say: 'late' }, deps);
  const result = await tickHarnessQueue(deps);
  expect(result).toMatchObject({ outcome: 'waiting', item: { id: item.id }, reason: '동결 — late hold' });
  expect(launches).toHaveLength(0);
  expect(listHarnessQueue(deps).find((row) => row.id === item.id)).toMatchObject({ status: 'queued', waitingReason: '동결 — late hold' });
});

/** QUEUE-BURST fixture: a fake clock the injected sleep advances, so the 30 s stagger is real in logic and zero in wall time. */
function burstFixture(dir: string, launches: string[][], pool: { running: number; pending: number; reserved: number; limit: number }) {
  const clock = new Date('2026-10-07T00:00:00Z');
  const sleeps: number[] = [], launchedAt: number[] = [];
  const base = fixture(dir, launches, pool);
  const deps: HarnessQueueDeps = { ...base, burstMax: undefined, launchStaggerMs: undefined, cap: () => 5, now: () => new Date(clock),
    configPath: join(dir, 'config.json'),
    sleep: async (ms) => { sleeps.push(ms); clock.setTime(clock.getTime() + ms); },
    launch: async (item, args, path) => { launchedAt.push(clock.getTime()); return base.launch!(item, args, path); } };
  writeFileSync(deps.configPath!, '{}');
  return { deps, clock, sleeps, launchedAt };
}

test('QUEUE-BURST counter-proof: pool headroom 5 · queue 5 → 5 launches in one tick, 30 s apart', async () => {
  const dir = root(), launches: string[][] = [];
  const { deps, sleeps, launchedAt } = burstFixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 5 });
  const queued: QueueItem[] = [];
  for (const seat of ['TC', 'MK', 'UX', 'OP', 'TC'] as const) queued.push(await addHarnessQueue({ seat, say: `${seat} ${queued.length}` }, deps));
  const tick = await tickHarnessQueue(deps);
  expect(tick).toMatchObject({ outcome: 'launched', item: { id: queued[0]!.id }, reason: 'spawned' });
  expect(tick.launched?.map((row) => row.id).sort()).toEqual(queued.map((row) => row.id).sort());
  expect(launches).toHaveLength(5);
  expect(sleeps).toEqual([30_000, 30_000, 30_000, 30_000]);
  expect(launchedAt.slice(1).map((at, index) => at - launchedAt[index]!)).toEqual([30_000, 30_000, 30_000, 30_000]);
  expect(listHarnessQueue(deps).map((row) => row.status)).toEqual(Array(5).fill('launched'));
});

test('QUEUE-BURST stops at the pool headroom and leaves the rest queued with the pool reason', async () => {
  const dir = root(), launches: string[][] = [];
  const { deps, sleeps } = burstFixture(dir, launches, { running: 1, pending: 1, reserved: 0, limit: 4 });
  for (let i = 0; i < 5; i++) await addHarnessQueue({ seat: (['TC', 'MK', 'UX', 'OP', 'TC'] as const)[i]!, say: `item ${i}` }, deps);
  const tick = await tickHarnessQueue(deps);
  expect(tick.launched).toHaveLength(2);
  expect(launches).toHaveLength(2);
  // One wait between the two launches, one before the pass that found the pool full.
  expect(sleeps).toEqual([30_000, 30_000]);
  const rows = listHarnessQueue(deps);
  expect(rows.filter((row) => row.status === 'launched')).toHaveLength(2);
  expect(rows.filter((row) => row.status === 'queued').every((row) => row.waitingReason?.startsWith('pool: 1+1+0+2/4'))).toBe(true);
});

test('QUEUE-BURST keeps each seat within its cap inside one burst', async () => {
  const dir = root(), launches: string[][] = [];
  const { deps } = burstFixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 8 });
  deps.cap = (seat) => seat === 'TC' ? 1 : 5;
  for (let i = 0; i < 3; i++) await addHarnessQueue({ seat: 'TC', say: `tc ${i}` }, deps);
  await addHarnessQueue({ seat: 'MK', say: 'mk 0' }, deps);
  const tick = await tickHarnessQueue(deps);
  expect(tick.launched?.map((row) => row.input)).toEqual(['tc 0', 'mk 0']);
  expect(listHarnessQueue(deps).filter((row) => row.status === 'queued').map((row) => row.input)).toEqual(['tc 1', 'tc 2']);
});

test('QUEUE-BURST honours harness.queue.burstMax and an empty queue ends the burst without a wait', async () => {
  const dir = root(), launches: string[][] = [];
  const { deps, sleeps, clock } = burstFixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 8 });
  writeFileSync(deps.configPath!, JSON.stringify({ harness: { queue: { burstMax: 2 } } }));
  expect(getUserConfig(deps.configPath!).harness?.queue?.burstMax).toBe(2);
  for (let i = 0; i < 4; i++) await addHarnessQueue({ seat: (['TC', 'MK', 'UX', 'OP'] as const)[i]!, say: `item ${i}` }, deps);
  expect((await tickHarnessQueue(deps)).launched).toHaveLength(2);
  expect(sleeps).toEqual([30_000]);
  writeFileSync(deps.configPath!, JSON.stringify({ harness: { queue: { burstMax: 0 } } }));
  expect(getUserConfig(deps.configPath!).harness?.queue?.burstMax).toBeUndefined();
  sleeps.length = 0;
  clock.setTime(clock.getTime() + 120_000);
  // Two left: both launch (invalid burstMax falls back to 5), and the drained queue ends the burst with no trailing wait.
  expect((await tickHarnessQueue(deps)).launched).toHaveLength(2);
  expect(sleeps).toEqual([30_000]);
  expect(launches).toHaveLength(4);
});

test('QUEUE-BURST stagger holds across ticks: a tick inside 30 s of the last launch waits, and a requested tick launches one', async () => {
  const dir = root(), launches: string[][] = [];
  const { deps, clock } = burstFixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 8 });
  deps.burstMax = 1;
  await addHarnessQueue({ seat: 'TC', say: 'first' }, deps);
  const second = await addHarnessQueue({ seat: 'MK', say: 'second' }, deps);
  const third = await addHarnessQueue({ seat: 'UX', say: 'third' }, deps);
  expect((await tickHarnessQueue(deps)).launched).toHaveLength(1);
  clock.setTime(clock.getTime() + 10_000);
  const held = await tickHarnessQueue(deps);
  expect(held).toMatchObject({ outcome: 'waiting', item: { id: second.id } });
  expect(held.reason).toBe('발사 간격 — 마지막 발사 10s 전 · 30s 간격');
  expect(launches).toHaveLength(1);
  clock.setTime(clock.getTime() + 20_000);
  deps.burstMax = 5;
  const requested = await tickHarnessQueue(deps, second.id);
  expect(requested).toMatchObject({ outcome: 'launched', item: { id: second.id } });
  expect(requested.launched).toBeUndefined();
  expect(listHarnessQueue(deps).find((row) => row.id === third.id)?.status).toBe('queued');
});

test('QUEUE-BURST: a failing follow-up launch ends the burst and keeps the launches already made', async () => {
  const dir = root(), launches: string[][] = [];
  const { deps } = burstFixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 8 });
  const base = deps.launch!;
  deps.launch = async (item, args, path) => { if (launches.length) throw new Error('spawn failed'); return base(item, args, path); };
  const first = await addHarnessQueue({ seat: 'TC', say: 'first' }, deps);
  await addHarnessQueue({ seat: 'MK', say: 'second' }, deps);
  const tick = await tickHarnessQueue(deps);
  expect(tick).toMatchObject({ outcome: 'launched', item: { id: first.id } });
  expect(tick.launched?.map((row) => row.id)).toEqual([first.id]);
  expect(listHarnessQueue(deps).map((row) => row.status)).toEqual(['launched', 'launching']);
});

test('QUEUE-BURST CLI tick prints the first launch as before and one line per further launch', async () => {
  const dir = root(), launches: string[][] = [];
  const { deps } = burstFixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 8 });
  const first = await addHarnessQueue({ seat: 'TC', say: 'first' }, deps);
  const second = await addHarnessQueue({ seat: 'MK', say: 'second' }, deps);
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'cli', queue: deps });
  const original = console.log, lines: string[] = [];
  console.log = (line: string) => { lines.push(line); };
  try { await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'tick']); }
  finally { console.log = original; }
  expect(lines).toEqual([`launched ${first.id}: spawned`, `launched ${second.id}: spawned`]);
});

test('launch advice observes pool wait and non-pool wait without changing queue decisions', async () => {
  const dir = root(), launches: string[][] = [], events: Record<string, unknown>[] = [];
  const deps = fixture(dir, launches, { running: 8, pending: 0, reserved: 0, limit: 8 });
  const item = await addHarnessQueue({ seat: 'MK', say: 'advice shadow' }, deps);
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category, event, data) => {
    if (category === 'resource.advice' && event === 'launch-advice') events.push(data as Record<string, unknown>);
  }) as typeof debug.log;
  try {
    const poolWait = await tickHarnessQueue(deps);
    expect(poolWait).toMatchObject({ outcome: 'waiting', item: { id: item.id }, reason: 'pool: 8+0+0+0/8' });
    expect(events).toEqual([{ caller: 'harness-queue-tick', verdict: 'wait', why: 'pool 8/8 occupied',
      actual: 'waiting', kind: 'agree', itemId: item.id }]);
    const seatWait = await tickHarnessQueue({ ...deps, cap: () => 0 });
    expect(seatWait).toMatchObject({ outcome: 'waiting', item: { id: item.id } });
    expect(events[1]).toMatchObject({ verdict: 'unknown', actual: 'waiting', kind: 'advice-unknown', itemId: item.id });
    const unreadable = await tickHarnessQueue({ ...deps, pool: () => { throw Error('pool down'); } });
    expect(unreadable).toMatchObject({ outcome: 'waiting', item: { id: item.id } });
    expect(events[2]).toMatchObject({ verdict: 'unknown', actual: 'waiting', kind: 'advice-unknown', itemId: item.id });
    const other = await addHarnessQueue({ seat: 'TC', say: 'another seat' }, deps);
    const turnWait = await tickHarnessQueue({ ...deps, pool: () => ({ running: 2, pending: 0, reserved: 0, limit: 8 }) }, other.id);
    expect(turnWait).toMatchObject({ outcome: 'waiting', item: { id: other.id }, reason: '다른 자리 차례 — MK' });
    expect(events[3]).toMatchObject({ verdict: 'launch-now', actual: 'waiting', kind: 'advice-launch-actual-wait', itemId: other.id });
    expect(launches).toEqual([]);
  } finally { (debug as { log: typeof debug.log }).log = original; }
});

test('an empty queue tick leaves no launch-advice line', async () => {
  const dir = root(), launches: string[][] = [], events: unknown[] = [];
  const deps = fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 8 });
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category, event, data) => {
    if (category === 'resource.advice' && event === 'launch-advice') events.push(data);
  }) as typeof debug.log;
  try {
    expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'skipped', reason: 'empty' });
    expect(events).toEqual([]);
  } finally { (debug as { log: typeof debug.log }).log = original; }
});

test('throwing advice and throwing advice log preserve launched, waiting and skipped tick results', async () => {
  const run = async (broken: boolean) => {
    const dir = root(), launches: string[][] = [];
    const deps = fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 1 });
    const first = await addHarnessQueue({ seat: 'TC', say: 'launch' }, deps);
    const second = await addHarnessQueue({ seat: 'MK', say: 'wait' }, deps);
    const original = debug.log;
    if (broken) (debug as { log: typeof debug.log }).log = ((category) => {
      if (category === 'resource.advice') throw Error('advice log down');
    }) as typeof debug.log;
    try {
      const injected = broken ? { ...deps, advice: (() => { throw Error('advice down'); }) as NonNullable<HarnessQueueDeps['advice']> } : deps;
      const launched = await tickHarnessQueue(injected, first.id);
      const waiting = await tickHarnessQueue(injected, second.id);
      const skipped = await tickHarnessQueue(injected, first.id);
      return { launched, waiting, skipped, launches };
    } finally { (debug as { log: typeof debug.log }).log = original; }
  };
  const baseline = await run(false), broken = await run(true);
  const shape = (result: Awaited<ReturnType<typeof run>>) => ({ outcomes: [result.launched, result.waiting, result.skipped]
    .map(tick => ({ outcome: tick.outcome, reason: tick.reason, item: tick.item && {
      input: tick.item.input, status: tick.item.status, waitingReason: tick.item.waitingReason }, launched: tick.launched?.length })), launches: result.launches });
  expect(shape(broken)).toEqual(shape(baseline));
  expect(shape(broken).outcomes.map(row => row.outcome)).toEqual(['launched', 'waiting', 'skipped']);
});

test('queue admits only the FIFO head when seat cap and running+pending+reservations allow it', async () => {
  const dir = root(), launches: string[][] = [];
  const pool = { running: 1, pending: 1, reserved: 0, limit: 2 };
  const deps = fixture(dir, launches, pool);
  const first = await addHarnessQueue({ seat: 'TC', say: 'first verbatim request' }, deps);
  await addHarnessQueue({ seat: 'UX', say: 'second' }, deps);
  expect((await tickHarnessQueue(deps)).outcome).toBe('waiting');
  expect(launches).toHaveLength(0);
  pool.pending = 0;
  pool.reserved = 1;
  expect((await tickHarnessQueue(deps)).outcome).toBe('waiting');
  pool.reserved = 0;
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: first.id, status: 'launched' } });
  expect(launches).toEqual([['harness', 'say', 'first verbatim request', '--substrate', 'pod']]);
  // A live child still consumes a queue-side provisional slot before its Pod lease appears.
  expect((await tickHarnessQueue(deps)).outcome).toBe('waiting');
  expect((await tickHarnessQueue({ ...deps, alive: () => false })).outcome).toBe('waiting');
  expect((await tickHarnessQueue({ ...deps, alive: () => false, receipt: () => 'finished' })).item?.seat).toBe('UX');
  expect(listHarnessQueue(deps).map((row) => row.status)).toEqual(['finished', 'launched']);
  expect(readFileSync(harnessQueuePath(dir), 'utf8')).toContain('first verbatim request');
});

test('a capped UX head does not block a later MK goal', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 8 }), cap: () => 1,
    processes: () => [{ pid: 900, seat: 'UX' as const }] };
  const ux = await addHarnessQueue({ seat: 'UX', say: 'blocked' }, deps);
  const mk = await addHarnessQueue({ seat: 'MK', say: 'free' }, deps);
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: mk.id } });
  expect(listHarnessQueue(deps).find(row => row.id === ux.id)?.status).toBe('queued');
  expect(launches).toEqual([['harness', 'say', 'free', '--substrate', 'pod']]);
});

test('a requested immediate tick judges only its own FIFO head without launching another seat', async () => {
  const dir = root(), launches: string[][] = [], deps = fixture(dir, launches);
  const earlier = await addHarnessQueue({ seat: 'TC', say: 'earlier' }, deps);
  const later = await addHarnessQueue({ seat: 'TC', say: 'later' }, deps);
  const other = await addHarnessQueue({ seat: 'UX', say: 'other' }, deps);
  expect(await tickHarnessQueue(deps, later.id)).toMatchObject({ outcome: 'waiting', item: { id: later.id }, reason: '앞선 대기열 항목 차례' });
  expect(launches).toEqual([]);
  expect(await tickHarnessQueue(deps, earlier.id)).toMatchObject({ outcome: 'launched', item: { id: earlier.id } });
  expect(await tickHarnessQueue(deps, other.id)).toMatchObject({ outcome: 'launched', item: { id: other.id } });
  expect(launches).toHaveLength(2);
});

test('round robin persists across ticks and preserves FIFO within each seat', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 12 }), cap: () => 3 };
  const queued = [];
  for (const seat of ['TC', 'MK', 'UX'] as const) {
    queued.push(await addHarnessQueue({ seat, say: `${seat} first` }, deps));
    queued.push(await addHarnessQueue({ seat, say: `${seat} second` }, deps));
  }
  const fired = [];
  for (let i = 0; i < 6; i++) fired.push((await tickHarnessQueue({ ...deps })).item?.id);
  expect(fired).toEqual([queued[0]!.id, queued[2]!.id, queued[4]!.id, queued[1]!.id, queued[3]!.id, queued[5]!.id]);
  expect(JSON.parse(readFileSync(`${harnessQueuePath(dir)}.round-robin.json`, 'utf8'))).toMatchObject({ lastSeat: 'UX' });
  expect(launches).toHaveLength(6);
});

test('round-robin marker write failure cannot reverse a launched result or mark it uncertain', async () => {
  const dir = root(), launches: string[][] = [], events: Array<{ category: string; event: string; data: unknown }> = [];
  const deps = fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 8 });
  const first = await addHarnessQueue({ seat: 'TC', say: 'first' }, deps);
  await addHarnessQueue({ seat: 'MK', say: 'second' }, deps);
  const marker = `${harnessQueuePath(dir)}.round-robin.json`;
  const start = deps.launch!;
  deps.launch = async (item, args, stateRoot) => {
    const pid = await start(item, args, stateRoot);
    mkdirSync(marker);
    return pid;
  };
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category, event, data) => {
    if (category === 'harness.queue') events.push({ category, event, data });
  }) as typeof debug.log;
  try {
    expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: first.id, status: 'launched' } });
    expect(listHarnessQueue(deps)[0]).toMatchObject({ id: first.id, status: 'launched' });
    expect(launches).toHaveLength(1);
    expect(events.some(row => row.event === 'round-robin-save-failed' &&
      (row.data as { seat?: string }).seat === 'TC')).toBe(true);
    expect(events.some(row => row.event === 'skipped')).toBe(false);
  } finally { (debug as { log: typeof debug.log }).log = original; }
});

test('all capped seats report one QUEUEWHY1 reason per seat without advancing round robin', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches), cap: () => 1,
    processes: () => ['TC', 'MK', 'UX'].map((seat, index) => ({ pid: 900 + index, seat: seat as 'TC' | 'MK' | 'UX' })) };
  for (const seat of ['TC', 'MK', 'UX'] as const) await addHarnessQueue({ seat, say: `${seat} goal` }, deps);
  const result = await tickHarnessQueue(deps);
  expect(result.outcome).toBe('waiting');
  expect(result.reason.split('\n')).toEqual(['TC', 'MK', 'UX'].map(seat =>
    `seat ${seat}: 1/1 (injectedCap.${seat}=1 · releaseGate.${seat}=4 · seatCaps.${seat}=${seat === 'TC' ? 8 : 6})`));
  expect(listHarnessQueue(deps).map(row => row.waitingReason)).toEqual(result.reason.split('\n'));
  expect(existsSync(`${harnessQueuePath(dir)}.round-robin.json`)).toBe(false);
  expect(launches).toHaveLength(0);
});

test('queued launching rows alone fill a seat cap and the next seat launches instead', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches), cap: (seat: string) => seat === 'TC' ? 1 : 2 };
  const first = await addHarnessQueue({ seat: 'TC', say: 'tc one' }, deps);
  const second = await addHarnessQueue({ seat: 'TC', say: 'tc two' }, deps);
  const mk = await addHarnessQueue({ seat: 'MK', say: 'mk one' }, deps);
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: first.id } });
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: mk.id } });
  const third = await tickHarnessQueue(deps);
  expect(third.outcome).toBe('waiting');
  expect(third.reason).toStartWith('seat TC: 1/1');
  expect(listHarnessQueue(deps).find(row => row.id === second.id)?.status).toBe('queued');
});

test('an invalid injected cap throws before the process inventory is read', async () => {
  const dir = root(), launches: string[][] = [];
  let read = 0;
  const deps = { ...fixture(dir, launches), cap: () => -1, processes: () => { read++; throw new Error('inventory down'); } };
  await addHarnessQueue({ seat: 'MK', say: 'bad cap' }, deps);
  await expect(tickHarnessQueue(deps)).rejects.toThrow('harness queue: invalid seat cap for MK');
  expect(read).toBe(0);
});

test('seat allowance is read from harness.queue.seatCap and ignores invalid entries', () => {
  const dir = root(), file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ harness: { queue: { seatCap: { TC: 3, UX: 0, bogus: 100 } } } }));
  const caps = getUserConfig(file).harness?.queue?.seatCap;
  expect(caps?.TC).toBe(3);
  expect(caps?.UX).toBeUndefined();
  expect((caps as Record<string, number>)?.bogus).toBeUndefined();
});

test('queue tick honors loops.orchestrator.seatCaps when it is the only cap configured', async () => {
  const dir = root(), launches: string[][] = [], configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ loops: { orchestrator: { seatCaps: { TC: 2 } } } }));
  const deps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 32 }),
    cap: undefined, configPath };
  for (let i = 0; i < 3; i++) await addHarnessQueue({ seat: 'TC', say: `configured ${i}` }, deps);
  expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
  expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'waiting', reason: 'seat TC: 2/2 (seatCaps.TC=2 · releaseGate.TC=4)' });
  expect(launches).toHaveLength(2);
});

test('waiting seat reason, observation and CLI list name the winning cap and both candidates', async () => {
  for (const [seatCaps, releaseGate, expected, winners] of [
    [10, 4, 'seat TC: 4/4 (releaseGate.TC=4 · seatCaps.TC=10)', ['releaseGate']],
    [2, 7, 'seat TC: 2/2 (seatCaps.TC=2 · releaseGate.TC=7)', ['seatCaps']],
    [3, 3, 'seat TC: 3/3 (releaseGate.TC=3 · seatCaps.TC=3)', ['releaseGate', 'seatCaps']],
  ] as const) {
    const dir = root(), configPath = join(dir, 'config.json'), events: Record<string, unknown>[] = [];
    writeFileSync(configPath, JSON.stringify({ loops: { orchestrator: { seatCaps: { TC: seatCaps }, releaseGate: { TC: releaseGate } } } }));
    const deps: HarnessQueueDeps = { ...fixture(dir, []), cap: undefined, configPath,
      processes: () => Array.from({ length: Math.min(seatCaps, releaseGate) }, (_, index) => ({ pid: index + 100, seat: 'TC' as const })),
      log: (event, data) => { if (event === 'waiting') events.push(data); } };
    const item = await addHarnessQueue({ seat: 'TC', say: 'inspect the cap' }, deps);
    expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'waiting', reason: expected });
    expect(events).toMatchObject([{ reason: expected, cap: Math.min(seatCaps, releaseGate),
      seatCaps, releaseGate, capKeys: [...winners] }]);
    expect(listHarnessQueue(deps)[0]).toMatchObject({ id: item.id, waitingReason: expected });
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'cli', queue: deps });
    const original = console.log, lines: string[] = [];
    console.log = (line: string) => { lines.push(line); };
    try { await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'list']); }
    finally { console.log = original; }
    expect(lines.at(-1)).toBe(`${item.id} TC queued say inspect the cap · ${expected}`);
  }
});

test('injected cap above configured seat cap cannot launch or masquerade as seatCaps', async () => {
  const dir = root(), configPath = join(dir, 'config.json'), launches: string[][] = [], events: Record<string, unknown>[] = [];
  writeFileSync(configPath, JSON.stringify({ loops: { orchestrator: { seatCaps: { TC: 2 }, releaseGate: { TC: 7 } } } }));
  const deps: HarnessQueueDeps = { ...fixture(dir, launches), cap: () => 10, configPath,
    processes: () => [{ pid: 201, seat: 'TC' }, { pid: 202, seat: 'TC' }],
    log: (event, data) => { if (event === 'waiting') events.push(data); } };
  const item = await addHarnessQueue({ seat: 'TC', say: 'stay queued at configured cap' }, deps);
  const reason = 'seat TC: 2/2 (seatCaps.TC=2 · releaseGate.TC=7 · injectedCap.TC=10)';
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'waiting', reason });
  expect(events).toMatchObject([{ reason, cap: 2, seatCaps: 2, releaseGate: 7, injectedCap: 10, capKeys: ['seatCaps'] }]);
  expect(listHarnessQueue(deps)).toMatchObject([{ id: item.id, waitingReason: reason }]);
  expect(launches).toHaveLength(0);
});

test('queue tick ignores legacy harness.queue.seatCap and warns once when the key is present', async () => {
  const dir = root(), launches: string[][] = [], configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ harness: { queue: { seatCap: { TC: 1 } } },
    loops: { orchestrator: { seatCaps: { TC: 2 } } } }));
  const deps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 32 }),
    cap: undefined, configPath };
  for (let i = 0; i < 3; i++) await addHarnessQueue({ seat: 'TC', say: `legacy ${i}` }, deps);
  const previous = debug.log;
  const warnings: { event: string; data: unknown; level: unknown }[] = [];
  (debug as { log: typeof debug.log }).log = ((category, event, data, options) => {
    if (category === 'harness.queue' && options?.level === 'warn') warnings.push({ event, data, level: options.level });
  }) as typeof debug.log;
  try {
    expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
    expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
    expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'waiting', reason: 'seat TC: 2/2 (seatCaps.TC=2 · releaseGate.TC=4)' });
    expect(launches).toHaveLength(2);
    expect(warnings).toEqual([{ event: 'legacy-seat-cap-ignored', level: 'warn', data: {
      key: 'harness.queue.seatCap', replacement: 'loops.orchestrator.seatCaps', path: configPath,
    } }]);
  } finally { (debug as { log: typeof debug.log }).log = previous; }
});

test('default queue allowance is lowered by the default four-per-seat gate', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 32 }), cap: undefined };
  for (let i = 0; i < 9; i++) await addHarnessQueue({ seat: 'TC', say: `goal ${i}` }, deps);
  for (let i = 0; i < 4; i++) expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
  expect((await tickHarnessQueue(deps)).reason).toBe('seat TC: 4/4 (releaseGate.TC=4 · seatCaps.TC=8)');
  expect(launches).toHaveLength(4);
});

test('queue tick counts a parent and child as one active run by runId or launch-root PID', async () => {
  for (const identity of ['runId', 'rootPid'] as const) {
    const dir = root(), launches: string[][] = [], events: Record<string, unknown>[] = [];
    const parent = { pid: 501, seat: 'TC' as const, ...(identity === 'runId' ? { runId: 'run-parent' } : {}) };
    const child = { pid: 502, seat: 'TC' as const, ...(identity === 'runId' ? { runId: 'run-parent' } : { rootPid: 501 }) };
    const deps: HarnessQueueDeps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 8 }),
      processes: () => [parent, child], log: (event, data) => { if (event === 'waiting') events.push(data); } };
    await addHarnessQueue({ seat: 'TC', say: `after ${identity} parent and child` }, deps);
    await addHarnessQueue({ seat: 'TC', say: 'blocked by two runs' }, deps);
    expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
    expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'waiting', reason: 'seat TC: 2/2 (injectedCap.TC=2 · releaseGate.TC=4 · seatCaps.TC=8)' });
    expect(events).toMatchObject([{ active: 2, attributed: { TC: 1 }, unattributed: 0 }]);
    expect(launches).toHaveLength(1);
  }
});

test('release gate charges running processes from the seat inventory before queue launch', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 32 }), cap: () => 8,
    processes: () => [101, 102, 103, 104].map((pid) => ({ pid, seat: 'TC' as const })) };
  await addHarnessQueue({ seat: 'TC', say: 'blocked by other launches' }, deps);
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'waiting', reason: 'seat TC: 4/4 (releaseGate.TC=4 · seatCaps.TC=8 · injectedCap.TC=8)' });
  expect(launches).toHaveLength(0);
});

test('release gate from user config lowers the queue launch cap without blocking other seats', async () => {
  const dir = root(), launches: string[][] = [], configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ loops: { orchestrator: {
    seatCaps: { TC: 6, UX: 5 }, releaseGate: { TC: 2, UX: 3, MK: -1, unknown: 0 },
  } } }));
  expect(getUserConfig(configPath).loops?.orchestrator?.releaseGate).toEqual({ TC: 2, UX: 3 });
  const deps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 32 }),
    cap: () => 8, configPath };
  const tc: QueueItem[] = [];
  for (let i = 0; i < 3; i++) tc.push(await addHarnessQueue({ seat: 'TC', say: `TC ${i}` }, deps));
  const ux = await addHarnessQueue({ seat: 'UX', say: 'UX after TC' }, deps);
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: tc[0]!.id } });
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: ux.id, seat: 'UX' } });
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: tc[1]!.id } });
  const nextUx = await addHarnessQueue({ seat: 'UX', say: 'UX despite full TC' }, deps);
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: nextUx.id, seat: 'UX' } });
  expect(listHarnessQueue(deps).find(row => row.id === tc[2]!.id)).toMatchObject({ status: 'queued' });
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'waiting',
    reason: 'seat TC: 2/2 (releaseGate.TC=2 · seatCaps.TC=6 · injectedCap.TC=8)' });
  expect(launches).toHaveLength(4);
});

test('missing lease observation fails closed and the same seat can launch after its prior process has a terminal receipt', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches), cap: () => 1 };
  await addHarnessQueue({ seat: 'TC', say: 'first' }, deps);
  const next = await addHarnessQueue({ seat: 'TC', say: 'second' }, deps);
  expect((await tickHarnessQueue({ ...deps, pool: () => { throw new Error('kubectl unavailable'); } })).outcome).toBe('waiting');
  expect(launches).toHaveLength(0);
  await tickHarnessQueue(deps);
  expect((await tickHarnessQueue(deps)).outcome).toBe('waiting');
  expect((await tickHarnessQueue({ ...deps, alive: () => false })).reason).toBe('seat TC: 1/1 (injectedCap.TC=1 · releaseGate.TC=4 · seatCaps.TC=8)');
  expect((await tickHarnessQueue({ ...deps, alive: () => false, receipt: () => 'started' })).outcome).toBe('waiting');
  expect(launches).toHaveLength(1);
  expect((await tickHarnessQueue({ ...deps, alive: () => false, receipt: () => 'finished' })).item?.id).toBe(next.id);
  expect(launches).toHaveLength(2);
});

test('dead PID without a terminal receipt still reserves the seat and pool with an empty process inventory', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 1 }), cap: () => 1,
    alive: () => false, processes: () => [] };
  const first = await addHarnessQueue({ seat: 'TC', say: 'unconfirmed exit' }, deps);
  await addHarnessQueue({ seat: 'TC', say: 'same seat' }, deps);
  expect((await tickHarnessQueue(deps)).item?.id).toBe(first.id);
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'waiting', reason: 'seat TC: 1/1 (injectedCap.TC=1 · releaseGate.TC=4 · seatCaps.TC=8)' });
  expect(listHarnessQueue(deps)[0]).toMatchObject({ id: first.id, status: 'launched' });
  expect(launches).toHaveLength(1);
  expect(await removeHarnessQueue(first.id, deps)).toBe(false);
  expect((await tickHarnessQueue({ ...deps, receipt: () => 'started' })).outcome).toBe('waiting');
  const other = await addHarnessQueue({ seat: 'UX', say: 'different seat' }, deps);
  expect(await removeHarnessQueue(listHarnessQueue(deps)[1]!.id, deps)).toBe(true);
  expect((await tickHarnessQueue(deps)).reason).toBe('pool: 0+0+0+1/1');
  expect(listHarnessQueue(deps).find((row) => row.id === other.id)?.status).toBe('queued');
  expect(launches).toHaveLength(1);
});

test('hold and heavy map to existing ask/say flags, and queue removal refuses live launches', async () => {
  const dir = root(), launches: string[][] = [];
  const goal = join(dir, 'goal.md'); writeFileSync(goal, 'Verbatim goal');
  const deps = fixture(dir, launches);
  const ask = await addHarnessQueue({ seat: 'MK', ask: goal, hold: true, heavy: true }, deps);
  expect(queueLaunchArgs(ask)).toEqual(['harness', 'ask', goal, '--substrate', 'pod', '--no-auto-merge', '--pod-memory', 'high']);
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: ask.id } });
  expect(launches[0]).toEqual(queueLaunchArgs(ask));
  expect(await removeHarnessQueue(ask.id, deps)).toBe(false);
  const say = await addHarnessQueue({ seat: 'MK', say: 'keep the exact text', hold: true, heavy: true }, deps);
  expect(queueLaunchArgs(say)).toEqual(['harness', 'say', 'keep the exact text', '--substrate', 'pod', '--no-auto-merge', '--pod-memory', 'high']);
  expect(await removeHarnessQueue(say.id, deps)).toBe(true);
  expect(listHarnessQueue(deps)).toHaveLength(1);
  await expect(addHarnessQueue({ seat: 'MK', say: 'a', ask: goal }, deps)).rejects.toThrow('중 하나만');
  await expect(addHarnessQueue({ seat: 'other', say: 'a' }, deps)).rejects.toThrow('unknown seat');
});

test('direct CLI launch args and cwd persist for later ticks while ordinary queue args stay unchanged', async () => {
  const dir = root(), launches: string[][] = [], deps = fixture(dir, launches);
  const args = ['harness', 'say', 'exact words', '--seat', 'TC', '--substrate', 'local', '--no-auto-merge'];
  const item = await addHarnessQueue({ seat: 'TC', say: 'exact words', launchArgs: args, launchCwd: '/tmp/owner' }, deps);
  expect(listHarnessQueue(deps)[0]).toMatchObject({ id: item.id, launchArgs: args, launchCwd: '/tmp/owner' });
  expect(await tickHarnessQueue(deps, item.id)).toMatchObject({ outcome: 'launched', item: { id: item.id } });
  expect(launches).toEqual([args]);
  expect(queueLaunchArgs(await addHarnessQueue({ seat: 'UX', say: 'ordinary' }, deps)))
    .toEqual(['harness', 'say', 'ordinary', '--substrate', 'pod']);
});

test('refuseDuplicate refuses the same goal or the same cell while one is queued or running, and allows it after a retryable finish', async () => {
  const dir = root(), launches: string[][] = [], deps = fixture(dir, launches);
  expect(queueCellId('하니스로 구현 … 칸: ONEDOOR-2 · P0')).toBe('ONEDOOR-2');
  expect(queueCellId('[TC 자리 · 체크리스트 칸 FREEZE-HOSTMERGE · P0]')).toBe('FREEZE-HOSTMERGE');
  expect(queueCellId('칸: P0 없음')).toBeUndefined();
  const first = await addHarnessQueue({ seat: 'TC', say: 'fix it · 칸: ONEDOOR-2', refuseDuplicate: true }, deps);
  await expect(addHarnessQueue({ seat: 'TC', say: 'fix it · 칸: ONEDOOR-2', refuseDuplicate: true }, deps))
    .rejects.toBeInstanceOf(HarnessQueueDuplicateError);
  await expect(addHarnessQueue({ seat: 'OP', say: 'other words · 칸: ONEDOOR-2', refuseDuplicate: true }, deps))
    .rejects.toThrow(`같은 칸 ONEDOOR-2 이 이미 대기열에 있거나 도는 중이다 — ${first.id} (queued)`);
  // Falsifier: without the flag the same text still enqueues (other callers keep their own idempotency keys).
  expect((await addHarnessQueue({ seat: 'TC', say: 'fix it · 칸: ONEDOOR-2' }, deps)).id).not.toBe(first.id);
  await addHarnessQueue({ seat: 'TC', say: 'different cell · 칸: HQ-FENCE-RAIL', refuseDuplicate: true }, deps);
  // A launched row whose wrapper finished non-zero is retryable — the same goal may be sent again.
  const launched = await tickHarnessQueue(deps, first.id);
  expect(launched.outcome).toBe('launched');
  mkdirSync(join(dir, 'harness'), { recursive: true });
  const row = listHarnessQueue(deps).find((item) => item.id === first.id)!;
  writeFileSync(harnessQueueReceiptPath(dir, row.launchId!), JSON.stringify({ state: 'finished', exitCode: 1 }));
  await expect(addHarnessQueue({ seat: 'TC', say: 'retry · 칸: ONEDOOR-2', refuseDuplicate: true }, deps)).rejects.toBeInstanceOf(HarnessQueueDuplicateError);
  await removeHarnessQueue(listHarnessQueue(deps).find((item) => item.input === 'fix it · 칸: ONEDOOR-2' && item.id !== first.id)!.id, deps);
  expect((await addHarnessQueue({ seat: 'TC', say: 'retry · 칸: ONEDOOR-2', refuseDuplicate: true }, deps)).status).toBe('queued');
});

test('refuseDuplicate reads the cell inside ask goal documents: ask–ask and ask–say on the same cell are refused', async () => {
  const dir = root(), launches: string[][] = [], deps = fixture(dir, launches);
  const goalA = join(dir, 'goal-a.md'), goalB = join(dir, 'goal-b.md'), goalC = join(dir, 'goal-c.md');
  writeFileSync(goalA, '대상 경로: src/x.ts\n칸: ONEDOOR-2\n');
  writeFileSync(goalB, '다른 문서 · 칸: ONEDOOR-2 · P0\n');
  writeFileSync(goalC, '칸: HQ-FENCE-RAIL\n');
  await addHarnessQueue({ seat: 'TC', ask: goalA, refuseDuplicate: true }, deps);
  await expect(addHarnessQueue({ seat: 'TC', ask: goalB, refuseDuplicate: true }, deps)).rejects.toThrow('같은 칸 ONEDOOR-2');
  await expect(addHarnessQueue({ seat: 'OP', say: 'fix it · 칸: ONEDOOR-2', refuseDuplicate: true }, deps)).rejects.toThrow('같은 칸 ONEDOOR-2');
  // Falsifier: a document on another cell enqueues.
  expect((await addHarnessQueue({ seat: 'TC', ask: goalC, refuseDuplicate: true }, deps)).status).toBe('queued');
  // The cell is recorded at enqueue: editing or deleting the queued document does not reopen it.
  expect(listHarnessQueue(deps).map((row) => row.cellId)).toEqual(['ONEDOOR-2', 'HQ-FENCE-RAIL']);
  writeFileSync(goalA, 'rewritten without a cell\n');
  await expect(addHarnessQueue({ seat: 'OP', say: 'again · 칸: ONEDOOR-2', refuseDuplicate: true }, deps)).rejects.toThrow('같은 칸 ONEDOOR-2');
  rmSync(goalC);
  await expect(addHarnessQueue({ seat: 'MK', say: 'again · 칸: HQ-FENCE-RAIL', refuseDuplicate: true }, deps)).rejects.toThrow('같은 칸 HQ-FENCE-RAIL');
});

test('a requested row blocked by its own seat cap reports that cap, not another seat\'s turn', async () => {
  const dir = root(), launches: string[][] = [];
  const deps: HarnessQueueDeps = { ...fixture(dir, launches), cap: (seat) => (seat === 'TC' ? 0 : 2) };
  const tc = await addHarnessQueue({ seat: 'TC', say: 'tc capped' }, deps);
  await addHarnessQueue({ seat: 'MK', say: 'mk has room' }, deps);
  const tick = await tickHarnessQueue(deps, tc.id);
  expect(tick.outcome).toBe('waiting');
  expect(tick.reason).toContain('seat TC: 0/0');
  expect(launches).toEqual([]);
  // Same check when the other seat comes first in the rotation (MK enqueued first, TC requested later).
  const dir2 = root(), launches2: string[][] = [];
  const deps2: HarnessQueueDeps = { ...fixture(dir2, launches2), cap: (seat) => (seat === 'TC' ? 0 : 2) };
  await addHarnessQueue({ seat: 'MK', say: 'mk first with room' }, deps2);
  const tc2 = await addHarnessQueue({ seat: 'TC', say: 'tc capped later' }, deps2);
  const tick2 = await tickHarnessQueue(deps2, tc2.id);
  expect(tick2).toMatchObject({ outcome: 'waiting', item: { id: tc2.id } });
  expect(tick2.reason).toContain('seat TC: 0/0');
  expect(launches2).toEqual([]);
});

test('a requested tick keeps the seat round-robin: an earlier seat head with room makes the requested row wait without launching', async () => {
  const dir = root(), launches: string[][] = [], deps = fixture(dir, launches);
  const mk = await addHarnessQueue({ seat: 'MK', say: 'mk first' }, deps);
  const tc = await addHarnessQueue({ seat: 'TC', say: 'tc direct' }, deps);
  expect(await tickHarnessQueue(deps, tc.id)).toMatchObject({ outcome: 'waiting', item: { id: tc.id }, reason: '다른 자리 차례 — MK' });
  expect(launches).toEqual([]);
  expect(listHarnessQueue(deps).find((row) => row.id === tc.id)?.waitingReason).toBe('다른 자리 차례 — MK');
  // Falsifier: once MK has launched, the requested TC row is the first head with room and launches.
  expect(await tickHarnessQueue(deps, mk.id)).toMatchObject({ outcome: 'launched', item: { id: mk.id } });
  expect(await tickHarnessQueue(deps, tc.id)).toMatchObject({ outcome: 'launched', item: { id: tc.id } });
});

test('default queue launcher runs the stored launch args in the stored cwd under the receipt wrapper', async () => {
  const dir = root(), owner = mkdtempSync(join(tmpdir(), 'hq-owner-'));
  const stub = join(dir, 'stub.ts');
  writeFileSync(stub, "console.log('STUB ' + JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) })); process.exitCode = 7;\n");
  const deps: HarnessQueueDeps = { root: dir, pool: () => ({ running: 0, pending: 0, reserved: 0, limit: 2 }), cap: () => 2,
    alive: () => true, processes: () => [], authorShadow: () => {}, idleRequest: () => {}, log: () => {}, launchCommand: stub };
  mkdirSync(join(dir, 'harness'), { recursive: true });
  const args = ['harness', 'say', 'exact words', '--seat', 'TC', '--substrate', 'local'];
  const item = await addHarnessQueue({ seat: 'TC', say: 'exact words', launchArgs: args, launchCwd: owner }, deps);
  expect((await tickHarnessQueue(deps, item.id)).outcome).toBe('launched');
  const launched = listHarnessQueue(deps).find((row) => row.id === item.id)!;
  const receipt = harnessQueueReceiptPath(dir, launched.launchId!);
  for (let i = 0; i < 200; i += 1) {
    if (existsSync(receipt) && JSON.parse(readFileSync(receipt, 'utf8')).state === 'finished') break;
    await Bun.sleep(50);
  }
  expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({ state: 'finished', exitCode: 7 });
  const line = readFileSync(join(dir, 'harness', `${item.id}.log`), 'utf8').split('\n').find((l) => l.startsWith('STUB '))!;
  const seen = JSON.parse(line.slice(5)) as { cwd: string; args: string[] };
  expect(realpathSync(seen.cwd)).toBe(realpathSync(owner));
  expect(seen.args.filter((arg) => !arg.startsWith('--test='))).toEqual(args);
  rmSync(owner, { recursive: true, force: true });
});

test('concurrent ticks cannot launch the same item twice; a failed/ambiguous launch stays indeterminate', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = fixture(dir, launches);
  const item = await addHarnessQueue({ seat: 'OP', say: 'run once' }, deps);
  expect((await Promise.all([tickHarnessQueue(deps), tickHarnessQueue(deps)])).map((result) => result.outcome).sort())
    .toEqual(['launched', 'skipped']);
  expect(launches).toHaveLength(1);
  const next = await addHarnessQueue({ seat: 'OP', say: 'ambiguous' }, deps);
  await expect(tickHarnessQueue({ ...deps, launch: async () => { throw new Error('spawn uncertain'); } })).rejects.toThrow('spawn uncertain');
  expect(listHarnessQueue(deps).find((row) => row.id === next.id)?.status).toBe('launching');
  expect((await tickHarnessQueue(deps)).outcome).toBe('skipped');
  expect(await removeHarnessQueue(next.id, deps)).toBe(false);
  expect(item.id).not.toBe(next.id);
});

test('outside-queue authoring consumes the seat cap and queue PID is not counted twice', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches), cap: () => 1, processes: () => [{ pid: 909, seat: 'TC' as const }] };
  await addHarnessQueue({ seat: 'TC', say: 'next goal' }, deps);
  expect((await tickHarnessQueue(deps)).reason).toBe('seat TC: 1/1 (injectedCap.TC=1 · releaseGate.TC=4 · seatCaps.TC=8)');
  expect(launches).toHaveLength(0);
  // SEAT-CAP-STALE: a seat-less process lives in the unknown-seat bucket and no longer charges TC.
  const unknownOnly = { ...fixture(root(), []), cap: () => 1, processes: () => [{ pid: 909 }] };
  await addHarnessQueue({ seat: 'TC', say: 'unknown does not charge' }, unknownOnly);
  expect((await tickHarnessQueue(unknownOnly)).outcome).toBe('launched');
  expect(await tickHarnessQueue({ ...deps, processes: () => { throw new Error('ps unavailable'); } }))
    .toMatchObject({ outcome: 'waiting', reason: 'unknown-running: harness process inventory unavailable: Error: ps unavailable' });
  const other = { ...deps, processes: () => [{ pid: 909, seat: 'UX' as const }] };
  expect((await tickHarnessQueue(other)).outcome).toBe('launched');
  await addHarnessQueue({ seat: 'TC', say: 'after first' }, other);
  const first = listHarnessQueue(other)[0]!;
  expect((await tickHarnessQueue({ ...other, processes: () => [{ pid: first.pid!, seat: 'TC', launchId: first.launchId },
    { pid: first.pid! + 1, seat: 'TC', launchId: first.launchId }] })).reason).toBe('seat TC: 1/1 (injectedCap.TC=1 · releaseGate.TC=4 · seatCaps.TC=8)');
  expect((await tickHarnessQueue({ ...other, processes: () => [{ pid: first.pid!, seat: 'UX' }] })).reason).toBe('seat TC: 1/1 (injectedCap.TC=1 · releaseGate.TC=4 · seatCaps.TC=8)');
});

test('macOS ps/lsof attributes only the matching working tree, keeps unknown runs out of seat charges, and counts parent-child once', async () => {
  const dir = root(), launches: string[][] = [], events: Record<string, unknown>[] = [];
  const ps = [
    '100 1 bun /repo/bin/elanous.mjs harness say goal',
    '101 100 bun /repo/bin/elanous.mjs self orchestrate goal',
    '200 1 bun /repo/bin/elanous.mjs harness ask goal',
    '300 1 bun /repo/bin/elanous.mjs harness say goal',
    '400 1 bun /repo/bin/elanous.mjs harness say goal',
    '500 1 bun /repo/bin/elanous.mjs harness say goal',
    '600 1 bun /repo/bin/elanous.mjs harness say goal',
  ].join('\n');
  const cwd: Record<string, string> = { '100': '/work/mk/subdir', '101': '/work/tc', '200': '/work/tc', '300': '/work/tcx', '400': '', '500': '/work/mk', '600': '/work/ux' };
  const calls: string[] = [];
  const run = ((command: string, args: string[]) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'ps') return { status: 0, stdout: ps };
    // One batched lsof: like the real one it exits 1 when some pid prints no cwd, yet prints the others.
    const pids = args[args.indexOf('-p') + 1]!.split(',');
    const found = pids.filter((pid) => cwd[pid]);
    return { status: found.length === pids.length ? 0 : 1, stdout: found.map((pid) => `p${pid}\nfcwd\nn${cwd[pid]}\n`).join('') };
  }) as typeof import('node:child_process').spawnSync;
  const trees = { MK: ['/work/mk'], TC: ['/work/tc'], UX: ['/work/ux'] };
  const configPath = join(dir, 'seat-trees.json');
  writeFileSync(configPath, JSON.stringify({ loops: { orchestrator: { seatTrees: trees } } }));
  const configuredTrees = getUserConfig(configPath).loops?.orchestrator?.seatTrees;
  expect(configuredTrees).toEqual(trees);
  const processes = readHarnessQueueProcesses({ platform: 'darwin', run, seatTrees: configuredTrees });
  expect(() => readHarnessQueueProcesses({ platform: 'darwin', seatTrees: trees,
    run: ((_command: string, _args: string[]) => ({ status: 0, stdout: '123 bun /repo/bin/elanous.mjs harness say goal' })) as typeof import('node:child_process').spawnSync }))
    .toThrow('invalid harness process inventory row');
  expect(calls[0]).toBe('ps -eo pid=,ppid=,args=');
  // 10-08 tick hang: a per-pid lsof (~0.1–0.3 s each) on a host with dozens of runs made the tick take 10 s+ — one lsof only.
  expect(calls).toEqual(['ps -eo pid=,ppid=,args=', 'lsof -a -d cwd -Fpn -p 100,101,200,300,400,500,600']);
  expect(processes).toEqual([{ pid: 100, seat: 'TC' }, { pid: 200, seat: 'TC' }, { pid: 300 }, { pid: 400 }, { pid: 500, seat: 'MK' }, { pid: 600, seat: 'UX' }]);
  const deps = { ...fixture(dir, launches), cap: () => 2, processes: () => processes,
    log: (event: string, data: Record<string, unknown>) => { if (event === 'waiting') events.push(data); } };
  await addHarnessQueue({ seat: 'TC', say: 'next' }, deps);
  // Two TC runs fill TC; the two seat-less runs (300, 400) are in the unknown-seat bucket, not TC.
  expect((await tickHarnessQueue(deps)).reason).toBe('seat TC: 2/2 (injectedCap.TC=2 · releaseGate.TC=4 · seatCaps.TC=8)');
  expect(events[0]).toMatchObject({ attributed: { OP: 0, TC: 2, MK: 1, UX: 1 }, unattributed: 2 });
  expect(launches).toHaveLength(0);
  const withoutTrees = readHarnessQueueProcesses({ platform: 'darwin', run, seatTrees: {} });
  expect(withoutTrees).toEqual([{ pid: 100 }, { pid: 200 }, { pid: 300 }, { pid: 400 }, { pid: 500 }, { pid: 600 }]);
  const allUnknown = { ...fixture(root(), []), cap: () => 2, processes: () => withoutTrees };
  await addHarnessQueue({ seat: 'TC', say: 'six unknown do not fill TC' }, allUnknown);
  expect((await tickHarnessQueue(allUnknown)).outcome).toBe('launched');
  const otherSeats = { ...fixture(root(), launches), cap: () => 1,
    processes: () => processes.filter((row) => row.seat === 'MK' || row.seat === 'UX') };
  await addHarnessQueue({ seat: 'TC', say: 'not blocked by MK or UX' }, otherSeats);
  expect((await tickHarnessQueue(otherSeats)).outcome).toBe('launched');
  expect(launches).toHaveLength(1);
  expect(readHarnessQueueProcesses({ platform: 'linux', run, seatTrees: trees, cwd: (pid) => cwd[String(pid)]!, environ: () => '' }))
    .toEqual(processes);
  expect(readHarnessQueueProcesses({ platform: 'darwin', run, seatTrees: trees, cwd: () => { throw Error('unreadable'); } })
    .every((row) => row.seat === undefined)).toBe(true);
  const explicit = ((command: string) => ({ status: 0, stdout: command === 'ps'
    ? '500 1 bun /repo/bin/elanous.mjs harness say goal --seat TC' : '' })) as typeof import('node:child_process').spawnSync;
  expect(readHarnessQueueProcesses({ platform: 'darwin', run: explicit, seatTrees: trees, cwd: () => '/work/mk' }))
    .toEqual([{ pid: 500, seat: 'TC' }]);
  expect(readHarnessQueueProcesses({ platform: 'darwin', run, seatTrees: { MK: ['/work'], TC: ['/work/tc'] } })[1])
    .toEqual({ pid: 200 });
  cwd['100'] = '/headquarters';
  expect(readHarnessQueueProcesses({ platform: 'darwin', run, seatTrees: trees })[0]).toEqual({ pid: 100, seat: 'TC' });
  cwd['100'] = '/work/mk/subdir';
  cwd['101'] = '/outside';
  expect(readHarnessQueueProcesses({ platform: 'darwin', run, seatTrees: trees })[0]).toEqual({ pid: 100 });
  cwd['101'] = '/work/tc';
  const peers = ((command: string, args: string[]) => command === 'ps'
    ? { status: 0, stdout: '600 1 bun /repo/bin/elanous.mjs harness say goal\n601 600 bun /repo/bin/elanous.mjs self orchestrate goal\n602 600 bun /repo/bin/elanous.mjs self orchestrate goal' }
    : { status: 0, stdout: `p${args[2]}\nfcwd\nn${args[2] === '601' ? '/work/tc' : '/work/mk'}\n` }) as typeof import('node:child_process').spawnSync;
  expect(readHarnessQueueProcesses({ platform: 'darwin', run: peers, seatTrees: trees })).toEqual([{ pid: 600 }]);
  const unreadablePeer = ((command: string, args: string[]) => command === 'ps'
    ? { status: 0, stdout: '600 1 bun /repo/bin/elanous.mjs harness say goal\n601 600 bun /repo/bin/elanous.mjs self orchestrate goal\n602 600 bun /repo/bin/elanous.mjs self orchestrate goal' }
    : args[2] === '602' ? { status: 1, stdout: '' } : { status: 0, stdout: `p${args[2]}\nfcwd\nn${args[2] === '601' ? '/work/tc' : '/work/mk'}\n` }) as typeof import('node:child_process').spawnSync;
  expect(readHarnessQueueProcesses({ platform: 'darwin', run: unreadablePeer, seatTrees: trees })).toEqual([{ pid: 600 }]);
  const unreadableChild = ((command: string, args: string[]) => command === 'ps'
    ? { status: 0, stdout: '700 1 bun /repo/bin/elanous.mjs harness say goal\n701 700 bun /repo/bin/elanous.mjs self orchestrate goal' }
    : args[2] === '701' ? { status: 1, stdout: '' } : { status: 0, stdout: 'p700\nfcwd\nn/work/mk\n' }) as typeof import('node:child_process').spawnSync;
  expect(readHarnessQueueProcesses({ platform: 'darwin', run: unreadableChild, seatTrees: trees })).toEqual([{ pid: 700 }]);
  const explicitChild = ((command: string) => ({ status: 0, stdout: command === 'ps'
    ? '800 1 bun /repo/bin/elanous.mjs harness say goal --seat MK\n801 800 bun /repo/bin/elanous.mjs self orchestrate goal --seat TC' : '' })) as typeof import('node:child_process').spawnSync;
  expect(readHarnessQueueProcesses({ platform: 'darwin', run: explicitChild, seatTrees: {} }))
    .toEqual([{ pid: 800, seat: 'TC' }]);
});

test('pid → runId → checkpoint seat attributes on macOS without env or a working tree; precedence is env > flag > ledger > cwd > all', () => {
  const dir = root(), runsDir = selfDevRunsDir(dir);
  saveSelfDevRun({ runId: 'run-attributed', createdAt: 1, updatedAt: 1, results: [], pid: 951, pidStart: 'darwin:123456', seat: 'TC' }, runsDir);
  const trees = { MK: ['/work/mk'] };
  const command = (suffix = '') => ((name: string) => ({ status: 0,
    stdout: name === 'ps' ? `951 1 bun /repo/bin/elanous.mjs harness say objective${suffix}` : '' })) as typeof import('node:child_process').spawnSync;
  const check = (platform: NodeJS.Platform, suffix = '', environ = '') => readHarnessQueueProcesses({ platform, run: command(suffix),
    seatTrees: trees, runsDir, cwd: () => '/work/mk', environ: () => environ, birthId: () => 'darwin:123456' });
  const original = debug.log;
  const events: Record<string, unknown>[] = [];
  (debug as { log: typeof debug.log }).log = ((category, event, data) => {
    if (category === 'harness.queue' && event === 'attributed') events.push(data as Record<string, unknown>);
  }) as typeof debug.log;
  try {
    expect(check('darwin')).toEqual([{ pid: 951, seat: 'TC', progressAt: 1, ledgerRunIds: ['run-attributed'] }]);
    expect(events.at(-1)).toEqual({ pid: 951, seat: 'TC', source: 'ledger' });
    expect(readHarnessQueueProcesses({ platform: 'darwin', run: command(), seatTrees: {}, runsDir,
      cwd: () => { throw Error('clone removed'); }, birthId: () => 'darwin:123456' })).toEqual([{ pid: 951, seat: 'TC', progressAt: 1, ledgerRunIds: ['run-attributed'] }]);
    expect(check('darwin', ' --seat UX')).toEqual([{ pid: 951, seat: 'UX', progressAt: 1, ledgerRunIds: ['run-attributed'] }]);
    expect(events.at(-1)).toEqual({ pid: 951, seat: 'UX', source: 'flag' });
    expect(check('linux', ' --seat UX', 'ELANOUS_HARNESS_SEAT=OP\0')).toEqual([{ pid: 951, seat: 'OP', progressAt: 1, ledgerRunIds: ['run-attributed'] }]);
    expect(events.at(-1)).toEqual({ pid: 951, seat: 'OP', source: 'env' });
    expect(readHarnessQueueProcesses({ platform: 'darwin', run: command(), seatTrees: trees, runsDir,
      cwd: () => '/work/mk', birthId: () => 'darwin:reused' })).toEqual([{ pid: 951, seat: 'MK' }]);
    expect(events.at(-1)).toEqual({ pid: 951, seat: 'MK', source: 'cwd' });
    expect(readHarnessQueueProcesses({ platform: 'darwin', run: command(), seatTrees: {}, runsDir,
      cwd: () => '/outside', birthId: () => 'darwin:reused' })).toEqual([{ pid: 951 }]);
    expect(readHarnessQueueProcesses({ platform: 'darwin', run: command(), seatTrees: trees, runsDir,
      cwd: () => '/work/mk', birthId: () => undefined })).toEqual([{ pid: 951, seat: 'MK' }]);
    expect(queueSeatForCwd('/work/mk/sub', trees)).toBe('MK');
    expect(queueSeatForCwd('/work/mkx', trees)).toBeUndefined();
    expect(readHarnessQueueProcesses({ platform: 'darwin', run: command(), seatTrees: trees,
      runsDir: selfDevRunsDir(root()), cwd: () => '/work/mk' })).toEqual([{ pid: 951, seat: 'MK' }]);
    expect(readHarnessQueueProcesses({ platform: 'darwin', run: command(), seatTrees: {},
      runsDir: selfDevRunsDir(root()), cwd: () => '/outside' })).toEqual([{ pid: 951 }]);
    expect(events.at(-1)).toEqual({ pid: 951, seat: null, source: 'all' });
  } finally { (debug as { log: typeof debug.log }).log = original; }
});

test('orchestrate checkpoint birth identity is accepted by the queue reader after its working tree disappears', () => {
  const dir = root(), runsDir = selfDevRunsDir(dir);
  const birth = processBirthId(process.pid);
  expect(birth).toBeDefined();
  const { checkpoint } = bindOrchestrateRunLedger({
    saveRun: (state) => saveSelfDevRun(state, runsDir),
    addParticipant: () => {}, checkpointDependencies: checkpointDependenciesForRun,
  }, {
    runId: 'orchestrate-seat-identity', createdAt: 1, prior: null,
    goals: [{ feature: 'seat run' }], pid: process.pid, seat: 'UX',
    runIdSource: 'minted', now: () => 2,
  });
  checkpoint([]);
  expect(loadSelfDevRun('orchestrate-seat-identity', runsDir)).toMatchObject({
    pid: process.pid, pidStart: birth, seat: 'UX',
  });
  const run = ((_command: string) => ({ status: 0,
    stdout: `${process.pid} 1 bun /repo/bin/elanous.mjs harness say seat-run` })) as typeof import('node:child_process').spawnSync;
  const probe = { platform: 'darwin' as const, run, runsDir, seatTrees: { MK: ['/former/tree'] },
    cwd: () => { throw Error('working tree removed'); }, birthId: () => processBirthId(process.pid) };
  expect(readHarnessQueueProcesses(probe)).toEqual([{ pid: process.pid, seat: 'UX', progressAt: 2, ledgerRunIds: ['orchestrate-seat-identity'] }]);
  expect(readHarnessQueueProcesses({ ...probe, birthId: () => `${birth}:reused` })).toEqual([{ pid: process.pid }]);
});

test('recycled PID from a past checkpoint cannot charge its seat ahead of the current cwd', () => {
  const dir = root(), runsDir = selfDevRunsDir(dir);
  saveSelfDevRun({ runId: 'past-run', createdAt: 1, updatedAt: 1, results: [],
    pid: 951, pidStart: 'darwin:past', seat: 'TC' }, runsDir);
  const run = ((_command: string, _args: string[]) => ({ status: 0,
    stdout: '951 1 bun /repo/bin/elanous.mjs harness say current' })) as typeof import('node:child_process').spawnSync;
  const probe = { platform: 'darwin' as const, run, runsDir, seatTrees: { MK: ['/work/mk'] },
    cwd: () => '/work/mk', birthId: () => 'darwin:current' };
  expect(readHarnessQueueProcesses(probe)).toEqual([{ pid: 951, seat: 'MK' }]);
  expect(readHarnessQueueProcesses({ ...probe, cwd: () => '/elsewhere' })).toEqual([{ pid: 951 }]);
  saveSelfDevRun({ runId: 'current-run', createdAt: 2, updatedAt: 2, results: [],
    pid: 951, pidStart: 'darwin:current', seat: 'UX' }, runsDir);
  expect(readHarnessQueueProcesses(probe)).toEqual([{ pid: 951, seat: 'UX', progressAt: 2, ledgerRunIds: ['current-run'] }]);
});

// The child is frozen with SIGSTOP so it cannot exit before the inventory reads it; macOS has no
// such freeze here, so the CLI child (missing goal file) can exit first and the read races (10-05).
test.skipIf(process.platform !== 'linux')('a live dev --file authoring process is inventoried and blocks a cap-one queue tick', async () => {
  const dir = root(), launches: string[][] = [];
  const child = spawn(process.execPath, [resolve(import.meta.dir, '../../bin/elanous.mjs'), '--test', 'dev', '--file', join(dir, 'goal.md')],
    { stdio: 'ignore', env: { ...process.env, ELANOUS_HARNESS_SEAT: 'TC' } });
  try {
    await new Promise<void>((done, reject) => { child.once('spawn', done); child.once('error', reject); });
    if (process.platform === 'linux') process.kill(child.pid!, 'SIGSTOP');
    const pid = child.pid!;
    expect(readHarnessQueueProcesses().some((row) => row.pid === pid && row.seat === 'TC')).toBe(true);
    const deps = { ...fixture(dir, launches), cap: () => 1, processes: readHarnessQueueProcesses };
    await addHarnessQueue({ seat: 'TC', say: 'wait for authoring' }, deps);
    const result = await tickHarnessQueue(deps);
    expect(result.outcome).toBe('waiting');
    expect(result.reason).toMatch(/^seat TC: [1-9]\d*\/1 \(injectedCap.TC=1 · releaseGate.TC=4 · seatCaps.TC=8\)$/);
    expect(launches).toHaveLength(0);
  } finally { if (child.pid && process.platform === 'linux') process.kill(child.pid, 'SIGCONT'); child.kill(); await new Promise<void>((done) => child.once('close', done)); }
});

test('finished receipt clears a reused PID without clearing a live launch identity', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches), cap: () => 1 };
  const first = await addHarnessQueue({ seat: 'TC', say: 'finished' }, deps);
  const second = await addHarnessQueue({ seat: 'TC', say: 'next' }, deps);
  await tickHarnessQueue(deps);
  const launched = listHarnessQueue(deps)[0]!;
  const finished = { ...deps, receipt: () => 'finished' as const, processes: () => [] };
  expect((await tickHarnessQueue({ ...finished, processes: () => [{ pid: launched.pid!, seat: 'TC' as const, launchId: launched.launchId }] })).reason).toBe('seat TC: 1/1 (injectedCap.TC=1 · releaseGate.TC=4 · seatCaps.TC=8)');
  expect(await reconcileHarnessQueue(first.id, { ...finished, processes: () => [{ pid: launched.pid!, launchId: launched.launchId }] })).toBe('running');
  expect(await reconcileHarnessQueue(first.id, finished)).toBe('released');
  expect(listHarnessQueue(deps)[0]!.status).toBe('finished');
  expect((await tickHarnessQueue(finished)).item?.id).toBe(second.id);
  expect(await removeHarnessQueue(first.id, finished)).toBe(true);
  expect(launches).toHaveLength(2);
});

test('tick and remove independently clear finished receipts with reused PIDs', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches), cap: () => 1 };
  const first = await addHarnessQueue({ seat: 'TC', say: 'first' }, deps);
  const second = await addHarnessQueue({ seat: 'TC', say: 'second' }, deps);
  await tickHarnessQueue(deps);
  const finished = { ...deps, receipt: () => 'finished' as const, processes: () => [] };
  expect((await tickHarnessQueue(finished)).item?.id).toBe(second.id);
  expect(listHarnessQueue(deps)[0]!.status).toBe('finished');
  expect(await removeHarnessQueue(first.id, finished)).toBe(true);
  expect(launches).toHaveLength(2);
});

test('remove releases a completed launch even if its PID is alive under a different identity', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches), cap: () => 1 };
  const first = await addHarnessQueue({ seat: 'TC', say: 'first' }, deps);
  const second = await addHarnessQueue({ seat: 'TC', say: 'second' }, deps);
  await tickHarnessQueue(deps);
  const launched = listHarnessQueue(deps)[0]!;
  const finished = { ...deps, receipt: () => 'finished' as const,
    processes: () => [{ pid: launched.pid!, seat: 'UX' as const }] };
  expect(launched.pid).toBeDefined();
  expect(await removeHarnessQueue(first.id, finished)).toBe(true);
  expect((await tickHarnessQueue(finished)).item?.id).toBe(second.id);
  expect(launches).toHaveLength(2);
});

test('uncertain launch needs positive finished or not-started receipt and no live process before releasing seat cap one', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches), cap: () => 1 };
  const first = await addHarnessQueue({ seat: 'TC', say: 'uncertain' }, deps);
  const second = await addHarnessQueue({ seat: 'TC', say: 'next' }, deps);
  await expect(tickHarnessQueue({ ...deps, launch: async () => { throw new Error('uncertain'); } })).rejects.toThrow('uncertain');
  const launchId = listHarnessQueue(deps)[0]!.launchId!;
  expect(launchId).toStartWith('hq-');
  expect((await tickHarnessQueue(deps)).reason).toBe('seat TC: 1/1 (injectedCap.TC=1 · releaseGate.TC=4 · seatCaps.TC=8)');
  expect(await reconcileHarnessQueue(first.id, { ...deps, receipt: () => null })).toBe('unknown');
  expect(await reconcileHarnessQueue(first.id, { ...deps, receipt: () => 'started' })).toBe('unknown');
  expect(await reconcileHarnessQueue(first.id, { ...deps, receipt: () => 'finished', processes: () => [{ pid: 300, seat: 'TC', launchId }] })).toBe('running');
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'cli',
    queue: { ...deps, receipt: () => 'not-started' } });
  const oldLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => { lines.push(line); };
  try { await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'reconcile', first.id]); }
  finally { console.log = oldLog; }
  expect(lines.at(-1)).toBe(`${first.id} released`);
  expect((await tickHarnessQueue(deps)).item?.id).toBe(second.id);
});

test('reconcile distinguishes successful and failed finished launching receipts before removal', async () => {
  for (const exitCode of [0, 1]) {
    const dir = root(), deps = fixture(dir, []);
    const first = await addHarnessQueue({ seat: 'TC', say: 'once', idempotencyKey: `seat:reconcile:${exitCode}` }, deps);
    await expect(tickHarnessQueue({ ...deps, launch: async () => { throw Error('uncertain spawn'); } })).rejects.toThrow('uncertain spawn');
    const launchId = listHarnessQueue(deps)[0]!.launchId!;
    const childFile = join(dir, `exit-${exitCode}.ts`);
    writeFileSync(childFile, `process.exitCode = ${exitCode};`);
    expect(await runHarnessQueueChild(harnessQueueReceiptPath(dir, launchId), childFile, [])).toBe(exitCode);
    expect(await reconcileHarnessQueue(first.id, deps)).toBe('released');
    expect(listHarnessQueue(deps)).toEqual([]);
    expect(readFileSync(join(dir, 'harness', `${first.id}.outcome`), 'utf8')).toBe(exitCode === 0 ? 'succeeded' : 'retryable');
    expect(harnessQueueOutcome(first.id, deps)).toBe(exitCode === 0 ? 'succeeded' : 'retryable');
    const again = await addHarnessQueue({ seat: 'TC', say: 'once', idempotencyKey: `seat:reconcile:${exitCode}` }, deps);
    expect(again.id === first.id).toBe(false);
  }
});

// SEAT-REQUEUE-HANDLED: a person's `queue remove` is its own outcome, never folded into a failure's
// «retryable» — the seat loop must not re-enter what a person took out of the queue.
test('queue remove records «removed» for a waiting or failed item, but keeps a succeeded launch succeeded', async () => {
  const dir = root(), deps = fixture(dir, []);
  const waiting = await addHarnessQueue({ seat: 'TC', say: 'waiting', idempotencyKey: 'seat:remove:waiting' }, deps);
  expect(harnessQueueOutcome(waiting.id, deps)).toBe('pending');
  expect(await removeHarnessQueue(waiting.id, deps)).toBe(true);
  expect(readFileSync(join(dir, 'harness', `${waiting.id}.outcome`), 'utf8')).toBe('removed');
  expect(harnessQueueOutcome(waiting.id, deps)).toBe('removed');
  expect(harnessQueueIdForKey('seat:remove:waiting', deps)).toBe(waiting.id);

  for (const exitCode of [1, 0]) {
    const item = await addHarnessQueue({ seat: 'TC', say: `ran ${exitCode}`, idempotencyKey: `seat:remove:exit-${exitCode}` }, deps);
    await expect(tickHarnessQueue({ ...deps, launch: async () => { throw Error('uncertain spawn'); } })).rejects.toThrow('uncertain spawn');
    const launchId = listHarnessQueue(deps).find((row) => row.id === item.id)!.launchId!;
    const childFile = join(dir, `remove-exit-${exitCode}.ts`);
    writeFileSync(childFile, `process.exitCode = ${exitCode};`);
    expect(await runHarnessQueueChild(harnessQueueReceiptPath(dir, launchId), childFile, [])).toBe(exitCode);
    // Contrast: without the person's removal this failed row reads «retryable» (see the reconcile test above).
    expect(harnessQueueOutcome(item.id, deps)).toBe(exitCode === 0 ? 'succeeded' : 'retryable');
    expect(await removeHarnessQueue(item.id, { ...deps, processes: () => [], receipt: () => 'finished' })).toBe(true);
    expect(harnessQueueOutcome(item.id, deps)).toBe(exitCode === 0 ? 'succeeded' : 'removed');
  }
});

test('not-started reconciliation remains retryable when the injected state has no receipt file', async () => {
  for (const cleanup of ['reconcile', 'tick'] as const) {
    const dir = root(), deps = fixture(dir, []);
    const first = await addHarnessQueue({ seat: 'TC', say: 'once', idempotencyKey: `seat:not-started:${cleanup}` }, deps);
    await expect(tickHarnessQueue({ ...deps, launch: async () => { throw Error('uncertain spawn'); } })).rejects.toThrow('uncertain spawn');
    if (cleanup === 'reconcile') expect(await reconcileHarnessQueue(first.id, { ...deps, receipt: () => 'not-started' })).toBe('released');
    else {
      await addHarnessQueue({ seat: 'UX', say: 'next' }, deps);
      expect((await tickHarnessQueue({ ...deps, receipt: () => 'not-started' })).outcome).toBe('launched');
    }
    expect(readFileSync(join(dir, 'harness', `${first.id}.outcome`), 'utf8')).toBe('retryable');
  }
});

test('tick preserves a successful launching receipt while clearing a failed one', async () => {
  for (const exitCode of [0, 1]) {
    const dir = root(), deps = fixture(dir, []);
    const first = await addHarnessQueue({ seat: 'TC', say: 'once', idempotencyKey: `seat:tick:${exitCode}` }, deps);
    await expect(tickHarnessQueue({ ...deps, launch: async () => { throw Error('uncertain spawn'); } })).rejects.toThrow('uncertain spawn');
    const launchId = listHarnessQueue(deps)[0]!.launchId!;
    const childFile = join(dir, `tick-exit-${exitCode}.ts`);
    writeFileSync(childFile, `process.exitCode = ${exitCode};`);
    expect(await runHarnessQueueChild(harnessQueueReceiptPath(dir, launchId), childFile, [])).toBe(exitCode);
    await addHarnessQueue({ seat: 'UX', say: 'next' }, deps);
    expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
    expect(listHarnessQueue(deps).some((row) => row.id === first.id)).toBe(false);
    expect(readFileSync(join(dir, 'harness', `${first.id}.outcome`), 'utf8')).toBe(exitCode === 0 ? 'succeeded' : 'retryable');
    expect(harnessQueueOutcome(first.id, deps)).toBe(exitCode === 0 ? 'succeeded' : 'retryable');
  }
});

test('spawned wrapper that never starts harness releases a cap-one seat after not-started receipt', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches), cap: () => 1 };
  const first = await addHarnessQueue({ seat: 'TC', say: 'wrapper before exec' }, deps);
  const second = await addHarnessQueue({ seat: 'TC', say: 'next after failed exec' }, deps);
  expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
  expect((await tickHarnessQueue(deps)).reason).toBe('seat TC: 1/1 (injectedCap.TC=1 · releaseGate.TC=4 · seatCaps.TC=8)');
  expect(await reconcileHarnessQueue(first.id, { ...deps, receipt: () => 'started', alive: () => false })).toBe('unknown');
  expect(await reconcileHarnessQueue(first.id, { ...deps, receipt: () => 'not-started', alive: () => false })).toBe('released');
  expect((await tickHarnessQueue(deps)).item?.id).toBe(second.id);
});

test('not-started receipt clears a launched wrapper and an uncertain launching reservation on tick', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches), cap: () => 1 };
  const first = await addHarnessQueue({ seat: 'TC', say: 'first' }, deps);
  const second = await addHarnessQueue({ seat: 'TC', say: 'second' }, deps);
  await tickHarnessQueue(deps);
  const neverStarted = { ...deps, receipt: () => 'not-started' as const };
  expect((await tickHarnessQueue(neverStarted)).item?.id).toBe(second.id);
  expect(listHarnessQueue(deps).some((row) => row.id === first.id)).toBe(false);
  const third = await addHarnessQueue({ seat: 'TC', say: 'third' }, deps);
  await expect(tickHarnessQueue({ ...deps, cap: () => 2, launch: async () => { throw new Error('uncertain'); } })).rejects.toThrow('uncertain');
  expect(listHarnessQueue(deps).find((row) => row.id === third.id)?.status).toBe('launching');
  expect(await removeHarnessQueue(third.id, neverStarted)).toBe(true);
});

test('child wrapper writes terminal receipt after a real child exit for recovery', async () => {
  const dir = root(), id = 'hq-00000000-0000-4000-8000-000000000000';
  const path = harnessQueueReceiptPath(dir, id);
  await addHarnessQueue({ seat: 'TC', say: 'prepare receipt dir' }, { root: dir, log: () => {} });
  const childFile = join(dir, 'exit-one.ts');
  writeFileSync(childFile, 'process.exitCode = 1;');
  expect(await runHarnessQueueChild(path, childFile, [])).toBe(1);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ state: 'finished', exitCode: 1 });
});

test('queue observations distinguish enqueued, waiting, launched and skipped without masking lease failure', async () => {
  const dir = root(), events: string[] = [], launches: string[][] = [];
  const pool = { running: 0, pending: 0, reserved: 0, limit: 1 };
  const deps: HarnessQueueDeps = { ...fixture(dir, launches, pool), log: (event) => { events.push(event); } };
  await addHarnessQueue({ seat: 'TC', say: 'observe this' }, deps);
  expect((await tickHarnessQueue({ ...deps, pool: () => { throw new Error('lease unavailable'); } })).outcome).toBe('waiting');
  expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
  expect((await tickHarnessQueue(deps)).outcome).toBe('skipped');
  expect(events).toEqual(['enqueued', 'waiting', 'launched', 'skipped']);
});

test('two independent tick processes serialize against the same queue file', async () => {
  const dir = root();
  const item = await addHarnessQueue({ seat: 'TC', say: 'one cross-process launch' }, { root: dir, log: () => {} });
  const modulePath = resolve(import.meta.dir, 'harness-queue.ts');
  const script = `import { tickHarnessQueue } from ${JSON.stringify(modulePath)};\n`
    + `const result = await tickHarnessQueue({root: ${JSON.stringify(dir)}, cap: () => 2, pool: () => ({running:0,pending:0,reserved:0,limit:2}), alive: () => true, processes: () => [], authorShadow: () => {}, launch: async () => { await Bun.sleep(100); return process.pid; }, log: () => {}});\n`
    + `console.log(result.outcome);`;
  const run = () => new Promise<{ code: number | null; output: string }>((done, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { errors += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => { if (errors) reject(new Error(errors)); else done({ code, output: output.trim() }); });
  });
  const results = await Promise.all([run(), run()]);
  expect(results.every((result) => result.code === 0)).toBe(true);
  expect(results.map((result) => result.output).sort()).toEqual(['launched', 'skipped']);
  expect(listHarnessQueue({ root: dir })).toMatchObject([{ id: item.id, status: 'launched' }]);
});

test('CLI queue tick requests first evidence-free yellow cell after 31 idle minutes once per KST day; shadow and off do not write', async () => {
  for (const mode of ['live', 'shadow', 'off'] as const) {
    const dir = root(), configPath = join(dir, 'config.json'), events: Array<{ event: string; data: Record<string, unknown> }> = [];
    writeFileSync(configPath, JSON.stringify({ loops: { orchestrator: { idleRequest: mode } } }));
    const cells = { current: [
      { id: 'UX-RUN', title: 'already running', owner: 'UX', status: 'yellow' as const, evidence: 'run: run-abc' },
      { id: 'UX-NEXT', title: 'Search history', owner: 'UX', status: 'yellow' as const, evidence: '' },
      { id: 'UX-LATER', title: 'later', owner: 'UX', status: 'yellow' as const, evidence: '' },
    ], next: [{ id: 'MK-NEXT', title: 'next round', owner: 'MK', status: 'yellow' as const, evidence: '' }] };
    let clock = new Date('2026-10-05T00:00:00Z');
    const deps: HarnessQueueDeps = { ...fixture(dir, []), idleRequest: requestIdleSeats, configPath, now: () => clock,
      idleCells: () => cells, idleLog: (_category, event, data) => { events.push({ event, data }); },
      processes: () => [{ pid: 123, seat: 'OP' }, { pid: 124, seat: 'TC' }] };
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'cli', queue: deps });
    const original = console.log;
    console.log = () => {};
    try {
      for (const minutes of [0, 16, 31, 47]) {
        clock = new Date(Date.parse('2026-10-05T00:00:00Z') + minutes * 60_000);
        await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'tick']);
      }
    } finally { console.log = original; }
    const journal = join(dir, 'seat-requests', 'requests.jsonl');
    if (mode === 'live') {
      const rows = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows).toHaveLength(2);
      expect(rows).toMatchObject([
        { seat: 'MK', text: '다음 칸: MK-NEXT next round — 30분 놀았다', source: 'orchestrator-idle' },
        { seat: 'UX', text: '다음 칸: UX-NEXT Search history — 30분 놀았다', source: 'orchestrator-idle' },
      ]);
      expect(events.filter(row => row.event === 'idle-requested' && row.data.seat === 'UX')).toEqual([
        { event: 'idle-requested', data: { seat: 'UX', idleMinutes: 30, cell: 'UX-NEXT Search history', mode: 'live', outcome: 'queued' } },
      ]);
      expect(rows[1].key).toBe('orch-idle:UX:2026-10-05:UX-NEXT');
    } else {
      expect(existsSync(journal)).toBe(false);
      expect(events.filter(row => row.event === 'idle-requested' && row.data.seat === 'UX')).toHaveLength(mode === 'shadow' ? 1 : 0);
    }
    expect(listHarnessQueue({ root: dir })).toEqual([]);
  }
});

test('idle requests remain idempotent across queue tick processes for one KST day', async () => {
  const dir = root(), configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ loops: { orchestrator: { idleRequest: 'live' } } }));
  const first = new Date('2026-10-05T00:00:00Z');
  const deps: HarnessQueueDeps = { root: dir, configPath, processes: () => [], idleLog: () => {},
    idleCells: () => ({ current: [{ id: 'UX-1', title: 'one', owner: 'UX', status: 'yellow', evidence: '' }], next: [] }) };
  requestIdleSeats(dir, first, [], deps);
  const clock = new Date('2026-10-05T00:31:00Z');
  const script = `import {tickHarnessQueue} from ${JSON.stringify(resolve(import.meta.dir, 'harness-queue.ts'))};`
    + `await tickHarnessQueue({root:${JSON.stringify(dir)},configPath:${JSON.stringify(configPath)},now:()=>new Date(${JSON.stringify(clock.toISOString())}),authorShadow:()=>{},processes:()=>[],idleCells:()=>({current:[{id:'UX-1',title:'one',owner:'UX',status:'yellow',evidence:''}],next:[]}),idleLog:()=>{}});`;
  const results = await Promise.all(Array.from({ length: 2 }, () => new Promise<number | null>((done, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', done);
  })));
  expect(results).toEqual([0, 0]);
  expect(readFileSync(join(dir, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});

test('idle requests fail closed on unknown inventory, count queue reservations, reset on activity, and record no-cell once', () => {
  const dir = root(), configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ loops: { orchestrator: { idleRequest: 'live' } } }));
  let clock = new Date('2026-10-05T00:00:00Z');
  let busy = true;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const deps: HarnessQueueDeps = { root: dir, configPath, processes: () => [],
    idleCells: () => ({ current: [], next: [] }), idleLog: (_category, event, data) => events.push({ event, data }) };
  const item = { id: 'hq-reserved', seat: 'UX' as const, kind: 'say' as const, input: 'work', hold: false, heavy: false,
    at: clock.toISOString(), status: 'launching' as const };
  requestIdleSeats(dir, clock, busy ? [item] : [], deps);
  clock = new Date('2026-10-05T00:31:00Z');
  requestIdleSeats(dir, clock, [item], deps);
  expect(events.some(row => row.data.seat === 'UX')).toBe(false);
  busy = false;
  requestIdleSeats(dir, clock, [], deps);
  clock = new Date('2026-10-05T01:02:00Z');
  requestIdleSeats(dir, clock, [], deps);
  expect(events.filter(row => row.data.seat === 'UX')).toMatchObject([{ event: 'idle-requested', data: { cell: '칸 없음', idleMinutes: 30 } }]);
  expect(existsSync(join(dir, 'seat-requests', 'requests.jsonl'))).toBe(false);
  const before = readFileSync(join(dir, 'orchestrator', 'idle-request.json'), 'utf8');
  expect(() => requestIdleSeats(dir, new Date('2026-10-05T02:00:00Z'), [], {
    ...deps, processes: () => { throw Error('inventory unavailable'); },
  })).toThrow('inventory unavailable');
  expect(readFileSync(join(dir, 'orchestrator', 'idle-request.json'), 'utf8')).toBe(before);
});

test('bin CLI --test harness queue tick reaches tickHarnessQueue and writes its shadow marker', () => {
  const dir = root();
  const cli = resolve(import.meta.dir, '../../bin/elanous.mjs');
  // The wiring test opts in to the real shadow; plain test processes skip it.
  const result = spawnSync(process.execPath, [cli, `--test=${dir}`, 'harness', 'queue', 'tick'],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ELANOUS_AUTHOR_SHADOW_LIVE: '1' } });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('skipped: empty');
  expect(Number.isFinite(Date.parse(readFileSync(join(dir, 'orchestrator', 'author-depth-shadow-at'), 'utf8')))).toBe(true);
  expect(listHarnessQueue({ root: dir })).toEqual([]);
  expect(Number.isFinite(Date.parse((JSON.parse(readFileSync(join(dir, 'orchestrator', 'idle-request.json'), 'utf8')) as { checkedAt: string }).checkedAt))).toBe(true);
}, 35_000);

test('CLI queue tick runs the durable author-depth shadow at 0 and 31 minutes, not 10, without enqueueing', async () => {
  const dir = root(), launches: string[][] = [], seen: string[] = [];
  const stamps = [0, 10, 31].map(minutes => new Date(Date.UTC(2026, 9, 5, 0, minutes)));
  let clock = stamps[0]!;
  const ledger = new AuthorLedger({ path: join(dir, 'orchestrator', 'author-ledger.sqlite'), now: () => clock });
  const baseline = fixture(dir, launches);
  const deps: HarnessQueueDeps = { ...baseline, now: () => clock, authorShadow: (stateRoot, now) =>
    runAuthorDepthShadow(stateRoot, now, options => {
      seen.push(options!.now!.toISOString());
      return collectAuthorDepth({ ...options, seats: ['MK'], caps: () => ({ MK: 2 }), running: () => ({ MK: 2 }),
        queued: () => listHarnessQueue({ root: dir }), versions: () => ['0.2.16', '0.2.17'],
        cells: version => version === '0.2.16' ? [{ id: 'CELL', title: 'Search history', owner: 'MK', status: 'yellow',
          evidence: 'Users can search their history', version }] : [], overlaps: () => [], ledger, log: () => {} });
    }) };
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'cli', queue: deps });
  const lines: string[] = [], oldLog = console.log;
  console.log = (line: string) => { lines.push(line); };
  try {
    for (const at of stamps) {
      clock = at;
      await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'tick']);
    }
  } finally { console.log = oldLog; }
  expect(lines).toEqual(['skipped: empty', 'skipped: empty', 'skipped: empty']);
  expect(seen).toEqual([stamps[0]!.toISOString(), stamps[2]!.toISOString()]);
  expect(readFileSync(join(dir, 'orchestrator', 'author-depth-shadow-at'), 'utf8')).toBe(stamps[2]!.toISOString());
  const db = new Database(ledger.path, { readonly: true });
  try {
    expect(db.query('SELECT status, count(*) AS n FROM requests GROUP BY status').all())
      .toEqual([{ status: 'queued-for-author', n: 1 }]);
    expect(db.query('SELECT count(*) AS n FROM history').get()).toEqual({ n: 1 });
  } finally { db.close(); }
  expect(launches).toEqual([]);
  expect(listHarnessQueue({ root: dir })).toEqual([]);
});

test('shadow throw and logging throw leave 0/10/31-minute launch, wait and skip decisions unchanged', async () => {
  const stamps = [0, 10, 31].map(minutes => new Date(Date.UTC(2026, 9, 5, 0, minutes)));
  const statuses = async (fail: boolean) => {
    const dir = root(), launches: string[][] = [], attempted: string[] = [];
    let clock = stamps[0]!;
    const deps = { ...fixture(dir, launches), now: () => clock,
      authorShadow: (stateRoot: string, now: Date) => runAuthorDepthShadow(stateRoot, now, options => {
        attempted.push(options!.now!.toISOString());
        if (fail) throw Error('shadow offline');
        return { seats: [], unreadable: [], receiptCounts: { held: 0, queuedForAuthor: 0 }, receiptFailures: 0 };
      }) };
    await addHarnessQueue({ seat: 'TC', say: 'launch me' }, deps);
    await addHarnessQueue({ seat: 'TC', say: 'wait behind me' }, deps);
    clock = stamps[0]!;
    const launched = await tickHarnessQueue(deps);
    clock = stamps[1]!;
    const waiting = await tickHarnessQueue(deps);
    await removeHarnessQueue(listHarnessQueue(deps)[1]!.id, deps);
    clock = stamps[2]!;
    const skipped = await tickHarnessQueue(deps);
    return { attempted, results: [launched, waiting, skipped].map(result => ({ outcome: result.outcome, reason: result.reason,
      item: result.item && { seat: result.item.seat, input: result.item.input, status: result.item.status } })) };
  };
  const original = debug.log, failures: string[] = [];
  (debug as { log: typeof debug.log }).log = ((category, event, data) => {
    if (category === 'loops.author-depth' && event === 'shadow-failed') {
      failures.push((data as { reason: string }).reason);
      throw Error('log offline');
    }
  }) as typeof debug.log;
  try {
    const broken = await statuses(true), baseline = await statuses(false);
    expect(broken.results).toEqual(baseline.results);
    expect(broken.attempted).toEqual([stamps[0]!.toISOString(), stamps[2]!.toISOString()]);
    expect(failures).toEqual(['Error: shadow offline', 'Error: shadow offline']);
  } finally { (debug as { log: typeof debug.log }).log = original; }
});

test('CLI add/list/remove/tick routes through the persisted queue and injected lease/launcher', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = fixture(dir, launches);
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'cli', queue: deps });
  const old = console.log, lines: string[] = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'add', '--seat', 'TC', '--say', 'the exact words', '--hold', '--heavy']);
    const id = listHarnessQueue(deps)[0]!.id;
    await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'list']);
    expect(lines.at(-1)).toContain(`${id} TC queued say the exact words`);
    await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'tick']);
    expect(lines.at(-1)).toBe(`launched ${id}: spawned`);
    expect(launches[0]).toEqual(queueLaunchArgs(listHarnessQueue(deps)[0]!));
    await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'add', '--seat', 'UX', '--say', 'remove me']);
    const second = listHarnessQueue(deps)[1]!.id;
    await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'remove', second]);
    expect(listHarnessQueue(deps)).toHaveLength(1);
  } finally { console.log = old; }
});

test('a test process never runs the real author shadow when none is injected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-shadow-guard-'));
  const before = debug.events(500).filter(entry => entry.category === 'loops.author-depth' && entry.event === 'shadow-skipped-test').length;
  await tickHarnessQueue({ root: dir, processes: () => [], idleRequest: () => {}, log: () => {} });
  const after = debug.events(500).filter(entry => entry.category === 'loops.author-depth' && entry.event === 'shadow-skipped-test').length;
  expect(after).toBe(before + 1);
});

const backlogged = { launched: 10, landed: 3, landingRate: 0.3, staleDrafts: 40, conflictRatio: 0.1, unknownMergeable: 0, reasons: {} };
const healthy = { launched: 10, landed: 8, landingRate: 0.8, staleDrafts: 2, conflictRatio: 0.1, unknownMergeable: 0, reasons: {} };
function finishFixture(mode: 'off' | 'shadow' | 'on', metrics: typeof healthy, running: number) {
  const dir = root(), launches: string[][] = [], calls: Date[] = [];
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ loops: { orchestrator: { finishGate: mode } } }));
  let clock = new Date('2026-10-05T09:00:00Z');
  const deps: HarnessQueueDeps = { ...fixture(dir, launches, { running, pending: 0, reserved: 0, limit: 10 }), configPath,
    now: () => clock, finishMetrics: (now) => { calls.push(now); return metrics; } };
  return { dir, deps, launches, calls, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}
const rebalanced = () => debug.events(1000).filter(entry => entry.category === 'loop.orchestrator' && entry.event === 'finish-rebalanced');

test('FINISH-RATE on: a backlogged board with running = launchSlots holds the launch with a finish-first reason and one log', async () => {
  const { deps, launches } = finishFixture('on', backlogged, 4);
  await addHarnessQueue({ seat: 'MK', say: 'held' }, deps);
  const before = rebalanced().length;
  const tick = await tickHarnessQueue(deps);
  expect(tick.outcome).toBe('waiting');
  expect(tick.reason).toStartWith('마무리 우선 — finish=6/10 · 사유 ');
  expect(tick.reason).toContain('landingRate below threshold');
  expect(launches).toHaveLength(0);
  const logs = rebalanced().slice(before);
  expect(logs).toHaveLength(1);
  expect(logs[0]!.data).toMatchObject({ finishSlots: 6, launchSlots: 4, running: 4, mode: 'on' });
});

test('QUEUE-HOL ⊕ FINISH-RATE: candidates pass seat caps first, then one finish-gate measurement holds every seat', async () => {
  const { deps, launches, calls } = finishFixture('on', backlogged, 4);
  await addHarnessQueue({ seat: 'UX', say: 'ux head' }, deps);
  await addHarnessQueue({ seat: 'MK', say: 'mk next' }, deps);
  const before = rebalanced().length;
  const tick = await tickHarnessQueue(deps);
  expect(tick.outcome).toBe('waiting');
  expect(tick.reason.split('\n')).toHaveLength(2);
  expect(tick.reason.split('\n').every((line) => line.startsWith('마무리 우선 — finish=6/10'))).toBe(true);
  expect(launches).toHaveLength(0);
  expect(calls).toHaveLength(1);
  expect(rebalanced().slice(before)).toHaveLength(1);
});

test('FINISH-RATE: healthy metrics, a backlogged board below launchSlots, and off all launch as before', async () => {
  for (const [mode, metrics, running] of [['on', healthy, 4], ['on', backlogged, 3], ['off', backlogged, 4]] as const) {
    const { deps, launches, calls } = finishFixture(mode, metrics, running);
    await addHarnessQueue({ seat: 'MK', say: 'go' }, deps);
    expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
    expect(launches).toHaveLength(1);
    expect(calls).toHaveLength(mode === 'off' ? 0 : 1);
  }
});

test('FINISH-RATE shadow logs the would-be hold but still launches', async () => {
  const { deps, launches } = finishFixture('shadow', backlogged, 4);
  await addHarnessQueue({ seat: 'MK', say: 'shadow' }, deps);
  const before = rebalanced().length;
  expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
  expect(launches).toHaveLength(1);
  expect(rebalanced().slice(before).map(entry => (entry.data as { mode: string }).mode)).toEqual(['shadow']);
});

test('FINISH-RATE re-measures at most once per 10 minutes', async () => {
  const { deps, calls, advance } = finishFixture('on', backlogged, 4);
  await addHarnessQueue({ seat: 'MK', say: 'cached' }, deps);
  await tickHarnessQueue(deps);
  advance(9 * 60_000);
  await tickHarnessQueue(deps);
  expect(calls).toHaveLength(1);
  advance(2 * 60_000);
  await tickHarnessQueue(deps);
  expect(calls).toHaveLength(2);
  // A fresh but malformed cache row is re-measured, not trusted (ACP should-fix).
  writeFileSync(join(deps.root!, 'harness', 'finish-metrics.json'), JSON.stringify({ at: new Date(deps.now!().getTime() - 60_000).toISOString(), metrics: { landingRate: 0.1 } }));
  await tickHarnessQueue(deps);
  expect(calls).toHaveLength(3);
});

test('FINISH-RATE history: only a fresh measurement writes an hourly row; off writes nothing', async () => {
  const worse = { ...backlogged, landingRate: 0.2, staleDrafts: 45 };
  let metrics: typeof healthy = backlogged;
  const { dir, deps, advance } = finishFixture('on', backlogged, 0);
  deps.finishMetrics = () => metrics;
  const history = join(dir, 'harness', 'finish-history.jsonl');
  const rows = () => existsSync(history) ? readFileSync(history, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line)) : [];
  await addHarnessQueue({ seat: 'MK', say: 'one' }, deps);
  await tickHarnessQueue(deps);
  expect(rows()).toHaveLength(1);
  advance(5 * 60_000);
  await addHarnessQueue({ seat: 'MK', say: 'two' }, deps);
  await tickHarnessQueue(deps);
  expect(rows()).toHaveLength(1);
  advance(60 * 60_000);
  metrics = worse;
  await addHarnessQueue({ seat: 'UX', say: 'three' }, deps);
  await tickHarnessQueue(deps);
  expect(rows()).toHaveLength(2);
  expect(rows()[1]).toMatchObject({ hour: '2026-10-05T10', trend: 'worsening' });
  const off = finishFixture('off', backlogged, 0);
  await addHarnessQueue({ seat: 'MK', say: 'off' }, off.deps);
  await tickHarnessQueue(off.deps);
  expect(existsSync(join(off.dir, 'harness', 'finish-history.jsonl'))).toBe(false);
});

test('FINISH-RATE history: a failed history append (and a throwing failure log) leaves the finish-first hold unchanged', async () => {
  const { dir, deps, launches } = finishFixture('on', backlogged, 4);
  // The history path is a symlink into a missing directory — the append itself fails (ENOENT), even as root.
  mkdirSync(join(dir, 'harness'), { recursive: true });
  const history = join(dir, 'harness', 'finish-history.jsonl');
  symlinkSync(join(dir, 'no-such-dir', 'history.jsonl'), history);
  const original = debug.log.bind(debug);
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    if (event === 'finish-history-write-failed') throw new Error('log sink down');
    return original(category, event, data);
  }) as typeof debug.log);
  try {
    await addHarnessQueue({ seat: 'MK', say: 'held' }, deps);
    const tick = await tickHarnessQueue(deps);
    expect(tick.outcome).toBe('waiting');
    expect(tick.reason).toStartWith('마무리 우선 — finish=6/10');
    expect(launches).toHaveLength(0);
    expect(spy.mock.calls.some(([, event]) => event === 'finish-history-write-failed')).toBe(true);
    expect(existsSync(join(dir, 'no-such-dir'))).toBe(false);
  } finally { spy.mockRestore(); }
});

test('FINISH-RATE: a test process without injected metrics skips the real measurement', async () => {
  const { dir, deps, launches } = finishFixture('on', backlogged, 4);
  delete deps.finishMetrics;
  // A fresh cached backlogged measurement must not bypass the test-process skip (ACP review must-fix).
  mkdirSync(join(dir, 'harness'), { recursive: true });
  writeFileSync(join(dir, 'harness', 'finish-metrics.json'), JSON.stringify({ at: '2026-10-05T08:58:00Z', metrics: backlogged }));
  await addHarnessQueue({ seat: 'MK', say: 'skip' }, deps);
  // Count via a pass-through spy: a fixed-size ring window shifts when other lines (e.g. launch advice) are logged.
  let skipped = 0;
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category, event, ...rest) => {
    if (category === 'loop.orchestrator' && event === 'finish-skipped-test') skipped++;
    return original.call(debug, category, event, ...rest);
  }) as typeof debug.log;
  try {
    expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
  } finally { (debug as { log: typeof debug.log }).log = original; }
  expect(launches).toHaveLength(1);
  expect(skipped).toBe(1);
});

test('FINISH-RATE: the CLI harness queue tick path reaches the finish gate', async () => {
  const { deps, launches } = finishFixture('on', backlogged, 4);
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'cli', queue: deps });
  const old = console.log, lines: string[] = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'add', '--seat', 'MK', '--say', 'cli held']);
    await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'tick']);
  } finally { console.log = old; }
  expect(lines.at(-1)).toContain('마무리 우선 — finish=6/10');
  expect(launches).toHaveLength(0);
});

describe('SEAT-CAP-STALE: seat caps count only live, progressing runs of that seat', () => {
  const now = new Date('2026-10-06T22:00:00Z');
  const ago = (minutes: number) => now.getTime() - minutes * 60_000;
  const capture = () => {
    const excluded: Record<string, unknown>[] = [], overCap: Record<string, unknown>[] = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      if (category === 'harness.queue' && event === 'seat-cap-excluded') excluded.push(data as Record<string, unknown>);
      if (category === 'harness.queue' && event === 'unknown-seat-over-cap') overCap.push(data as Record<string, unknown>);
    }) as typeof debug.log;
    return { excluded, overCap, restore: () => { (debug as { log: typeof debug.log }).log = original; } };
  };
  const tcDeps = (processes: QueueProcessRow[]) => ({ ...fixture(root(), []), now: () => now, processes: () => processes });
  type QueueProcessRow = { pid: number; seat?: 'OP' | 'TC' | 'MK' | 'UX'; runId?: string; progressAt?: number; stopReason?: string };

  test('TC cap 2 with one run idle 40 min launches; the same runs both progressing stay blocked (counter-proof)', async () => {
    const log = capture();
    try {
      const stale = tcDeps([{ pid: 11, seat: 'TC', runId: 'r-live', progressAt: ago(2) }, { pid: 12, seat: 'TC', runId: 'r-stale', progressAt: ago(40) }]);
      await addHarnessQueue({ seat: 'TC', say: 'stale run frees a seat' }, stale);
      expect((await tickHarnessQueue(stale)).outcome).toBe('launched');
      expect(log.excluded).toEqual([{ runId: 'r-stale', launchId: null, pid: 12, seat: 'TC', reason: 'stale', idleMin: 40 }]);
      const busy = tcDeps([{ pid: 11, seat: 'TC', progressAt: ago(2) }, { pid: 12, seat: 'TC', progressAt: ago(20) }]);
      await addHarnessQueue({ seat: 'TC', say: 'two in progress' }, busy);
      expect((await tickHarnessQueue(busy)).reason).toBe('seat TC: 2/2 (injectedCap.TC=2 · releaseGate.TC=4 · seatCaps.TC=8)');
      const noSignal = tcDeps([{ pid: 11, seat: 'TC' }, { pid: 12, seat: 'TC' }]);
      await addHarnessQueue({ seat: 'TC', say: 'no ledger yet' }, noSignal);
      expect((await tickHarnessQueue(noSignal)).outcome).toBe('waiting');
    } finally { log.restore(); }
  });

  test('a soft-stopped run awaiting harvest does not hold its seat; staleRunMinutes comes from config', async () => {
    const log = capture();
    try {
      const soft = tcDeps([{ pid: 11, seat: 'TC', progressAt: ago(1) }, { pid: 12, seat: 'TC', runId: 'r-soft', progressAt: ago(3), stopReason: 'harvestable-awaiting-human' }]);
      await addHarnessQueue({ seat: 'TC', say: 'soft-stopped frees a seat' }, soft);
      expect((await tickHarnessQueue(soft)).outcome).toBe('launched');
      expect(log.excluded).toEqual([{ runId: 'r-soft', launchId: null, pid: 12, seat: 'TC', reason: 'soft-stopped', idleMin: 3 }]);
      const configPath = join(root(), 'config.json');
      writeFileSync(configPath, JSON.stringify({ harness: { queue: { staleRunMinutes: 60, unknownSeatCap: 5 } } }));
      expect(getUserConfig(configPath).harness?.queue).toMatchObject({ staleRunMinutes: 60, unknownSeatCap: 5 });
      const patient = { ...tcDeps([{ pid: 11, seat: 'TC', progressAt: ago(2) }, { pid: 12, seat: 'TC', progressAt: ago(40) }]), configPath };
      await addHarnessQueue({ seat: 'TC', say: 'longer stale window' }, patient);
      expect((await tickHarnessQueue(patient)).outcome).toBe('waiting');
    } finally { log.restore(); }
  });

  test('three seat-less runs do not reduce TC, MK or UX caps and are logged once per tick as unknown-seat', async () => {
    const log = capture();
    try {
      const unknown = [{ pid: 21, progressAt: ago(1) }, { pid: 22 }, { pid: 23 }];
      for (const seat of ['TC', 'MK', 'UX'] as const) {
        // Configured seat caps and release gate only (no injected cap); the unknown-seat cap stays at its default 2.
        const deps = { ...tcDeps(unknown), cap: undefined };
        await addHarnessQueue({ seat, say: `${seat} unaffected` }, deps);
        expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
      }
      expect(log.excluded.filter((row) => row.reason === 'unknown-seat')).toHaveLength(9);
      expect(log.overCap).toEqual([{ count: 3, cap: 2 }, { count: 3, cap: 2 }, { count: 3, cap: 2 }]);
      expect(log.excluded[0]).toEqual({ runId: null, launchId: null, pid: 21, seat: null, reason: 'unknown-seat', idleMin: 1 });
    } finally { log.restore(); }
  });

  test('a launched row with no live process past the grace is not counted; a just-launched row still is', async () => {
    const log = capture();
    try {
      const dir = root();
      const deps = { ...fixture(dir, []), now: () => now, cap: () => 1, alive: () => false, receipt: () => 'started' as const };
      await addHarnessQueue({ seat: 'MK', say: 'next MK' }, deps);
      const rows = JSON.parse(readFileSync(harnessQueuePath(dir), 'utf8')) as QueueItem[];
      const dead: QueueItem = { ...rows[0]!, id: 'hq-dead', status: 'launched', pid: 999_991,
        launchId: 'hq-00000000-0000-4000-8000-000000000001', at: new Date(ago(90)).toISOString() };
      writeFileSync(harnessQueuePath(dir), JSON.stringify([dead, ...rows]));
      expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
      expect(log.excluded).toEqual([{ runId: null, launchId: dead.launchId, queueId: 'hq-dead', seat: 'MK', reason: 'dead-row', idleMin: 90 }]);
      const fresh = root();
      const freshDeps = { ...deps, root: fresh };
      await addHarnessQueue({ seat: 'MK', say: 'behind a fresh launch' }, freshDeps);
      const freshRows = JSON.parse(readFileSync(harnessQueuePath(fresh), 'utf8')) as QueueItem[];
      const just: QueueItem = { ...freshRows[0]!, id: 'hq-just', status: 'launched', pid: 999_992,
        launchId: 'hq-00000000-0000-4000-8000-000000000002', at: new Date(ago(0)).toISOString() };
      writeFileSync(harnessQueuePath(fresh), JSON.stringify([just, ...freshRows]));
      expect((await tickHarnessQueue(freshDeps)).reason).toBe('seat MK: 1/1 (injectedCap.MK=1 · releaseGate.MK=4 · seatCaps.MK=6)');
      // A wrapper still in the inventory (its argv launch id) keeps an old row counted.
      const alive = root();
      const aliveDeps = { ...deps, root: alive, processes: () => [{ pid: 999_991, launchId: dead.launchId }] };
      await addHarnessQueue({ seat: 'MK', say: 'behind a live old launch' }, aliveDeps);
      const aliveRows = JSON.parse(readFileSync(harnessQueuePath(alive), 'utf8')) as QueueItem[];
      writeFileSync(harnessQueuePath(alive), JSON.stringify([{ ...dead }, ...aliveRows]));
      expect((await tickHarnessQueue(aliveDeps)).outcome).toBe('waiting');
    } finally { log.restore(); }
  });

  test('an item queued long ago and launched just now keeps its seat: the grace runs from the receipt time', async () => {
    const log = capture();
    try {
      const dir = root();
      const deps = { ...fixture(dir, []), now: () => now, cap: () => 1, alive: () => false, receipt: () => 'started' as const };
      await addHarnessQueue({ seat: 'TC', say: 'next TC' }, deps);
      const rows = JSON.parse(readFileSync(harnessQueuePath(dir), 'utf8')) as QueueItem[];
      const launchId = 'hq-00000000-0000-4000-8000-000000000006';
      const recent: QueueItem = { ...rows[0]!, id: 'hq-old-queued', status: 'launched', pid: 999_994, launchId,
        at: new Date(ago(180)).toISOString() };
      writeFileSync(harnessQueuePath(dir), JSON.stringify([recent, ...rows]));
      mkdirSync(join(dir, 'harness'), { recursive: true });
      writeFileSync(harnessQueueReceiptPath(dir, launchId), JSON.stringify({ state: 'started', at: new Date(ago(1)).toISOString() }));
      expect((await tickHarnessQueue(deps)).reason).toBe('seat TC: 1/1 (injectedCap.TC=1 · releaseGate.TC=4 · seatCaps.TC=8)');
      expect(log.excluded).toEqual([]);
      writeFileSync(harnessQueueReceiptPath(dir, launchId), JSON.stringify({ state: 'started', at: new Date(ago(20)).toISOString() }));
      expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
      expect(log.excluded).toEqual([{ runId: null, launchId, queueId: 'hq-old-queued', seat: 'TC', reason: 'dead-row', idleMin: 20 }]);
    } finally { log.restore(); }
  });

  test('an item that waited past the grace and was launched by the tick is still counted on the next tick before any receipt', async () => {
    const log = capture();
    try {
      const dir = root();
      // Real clock: the launch id (UUIDv7) is minted from the wall clock at launch.
      const deps = { ...fixture(dir, []), cap: () => 1 };
      await addHarnessQueue({ seat: 'MK', say: 'waited long' }, deps);
      await addHarnessQueue({ seat: 'MK', say: 'behind it' }, deps);
      const rows = JSON.parse(readFileSync(harnessQueuePath(dir), 'utf8')) as QueueItem[];
      writeFileSync(harnessQueuePath(dir), JSON.stringify(rows.map((row) => ({ ...row, at: new Date(Date.now() - 60 * 60_000).toISOString() }))));
      expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
      expect(existsSync(harnessQueueReceiptPath(dir, listHarnessQueue(deps)[0]!.launchId!))).toBe(false);
      expect((await tickHarnessQueue(deps)).reason).toBe('seat MK: 1/1 (injectedCap.MK=1 · releaseGate.MK=4 · seatCaps.MK=6)');
      expect(log.excluded).toEqual([]);
    } finally { log.restore(); }
  });

  test('a launching row with no recorded pid is charged while its launch id is in the inventory or within the grace, dead after', async () => {
    const log = capture();
    try {
      const make = (minutes: number) => {
        const dir = root();
        const uncertain = { id: 'hq-uncertain', status: 'launching' as const,
          launchId: 'hq-00000000-0000-4000-8000-000000000007', at: new Date(ago(minutes)).toISOString() };
        return { dir, uncertain };
      };
      for (const [minutes, processes, outcome] of [[120, [], 'launched'], [120, [{ pid: 81, launchId: 'hq-00000000-0000-4000-8000-000000000007' }], 'waiting'],
        [1, [], 'waiting']] as const) {
        const { dir, uncertain } = make(minutes);
        const deps = { ...fixture(dir, []), now: () => now, cap: () => 1, alive: () => true, processes: () => processes };
        await addHarnessQueue({ seat: 'UX', say: 'next UX' }, deps);
        const rows = JSON.parse(readFileSync(harnessQueuePath(dir), 'utf8')) as QueueItem[];
        writeFileSync(harnessQueuePath(dir), JSON.stringify([{ ...rows[0]!, ...uncertain }, ...rows]));
        expect((await tickHarnessQueue(deps)).outcome).toBe(outcome);
      }
      expect(log.excluded.filter((row) => row.reason === 'dead-row')).toEqual([{ runId: null,
        launchId: 'hq-00000000-0000-4000-8000-000000000007', queueId: 'hq-uncertain', seat: 'UX', reason: 'dead-row', idleMin: 120 }]);
    } finally { log.restore(); }
  });

  test('a launch id carries its launch time, so an item queued long ago and launched just now keeps its seat with no pid or receipt', async () => {
    const v7 = (at: number) => { const hex = at.toString(16).padStart(12, '0');
      return `hq-${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`; };
    expect(queueLaunchTime(v7(ago(1)))).toBe(ago(1));
    expect(queueLaunchTime('hq-00000000-0000-4000-8000-000000000007')).toBeUndefined();
    expect(queueLaunchTime(`hq-${Bun.randomUUIDv7()}`)).toBeGreaterThan(0);
    const log = capture();
    try {
      for (const [launchedMinutesAgo, outcome] of [[1, 'waiting'], [10, 'launched']] as const) {
        const dir = root();
        const deps = { ...fixture(dir, []), now: () => now, cap: () => 1, alive: () => true };
        await addHarnessQueue({ seat: 'OP', say: 'next OP' }, deps);
        const rows = JSON.parse(readFileSync(harnessQueuePath(dir), 'utf8')) as QueueItem[];
        const row: QueueItem = { ...rows[0]!, id: 'hq-v7', status: 'launching', launchId: v7(ago(launchedMinutesAgo)),
          at: new Date(ago(120)).toISOString() };
        writeFileSync(harnessQueuePath(dir), JSON.stringify([row, ...rows]));
        expect((await tickHarnessQueue(deps)).outcome).toBe(outcome);
      }
      expect(log.excluded.map((row) => [row.reason, row.idleMin])).toEqual([['dead-row', 10]]);
    } finally { log.restore(); }
  });

  test('a legacy row without a launch id follows the same liveness and grace rule', async () => {
    const log = capture();
    try {
      const dir = root();
      const deps = { ...fixture(dir, []), now: () => now, cap: () => 1, alive: () => false };
      await addHarnessQueue({ seat: 'UX', say: 'next UX' }, deps);
      const rows = JSON.parse(readFileSync(harnessQueuePath(dir), 'utf8')) as QueueItem[];
      const legacy: QueueItem = { ...rows[0]!, id: 'hq-legacy', status: 'launched', pid: 999_993, at: new Date(ago(60)).toISOString() };
      writeFileSync(harnessQueuePath(dir), JSON.stringify([legacy, ...rows]));
      expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
      expect(log.excluded).toEqual([{ runId: null, launchId: null, queueId: 'hq-legacy', seat: 'UX', reason: 'dead-row', idleMin: 60 }]);
    } finally { log.restore(); }
  });

  test('a seat-less process that is a queue row\'s launch charges the row\'s seat and is not logged as unknown-seat', async () => {
    const log = capture();
    try {
      const dir = root();
      const base = { ...fixture(dir, []), now: () => now, cap: () => 1, alive: () => true };
      await addHarnessQueue({ seat: 'OP', say: 'next OP' }, base);
      const rows = JSON.parse(readFileSync(harnessQueuePath(dir), 'utf8')) as QueueItem[];
      const running: QueueItem = { ...rows[0]!, id: 'hq-running', status: 'launched', pid: 31,
        launchId: 'hq-00000000-0000-4000-8000-000000000003', at: new Date(ago(120)).toISOString() };
      writeFileSync(harnessQueuePath(dir), JSON.stringify([running, ...rows]));
      const live = { ...base, processes: () => [{ pid: 31, runId: 'r-op', launchId: running.launchId, progressAt: ago(1) }] };
      expect((await tickHarnessQueue(live)).reason).toBe('seat OP: 1/1 (injectedCap.OP=1 · releaseGate.OP=4 · seatCaps.OP=4)');
      expect(log.excluded).toEqual([]);
      const stale = { ...base, processes: () => [{ pid: 31, runId: 'r-op', launchId: running.launchId, progressAt: ago(45) }] };
      expect((await tickHarnessQueue(stale)).outcome).toBe('launched');
      expect(log.excluded).toEqual([{ runId: 'r-op', launchId: running.launchId, pid: 31, seat: 'OP', reason: 'stale', idleMin: 45 }]);
    } finally { log.restore(); }
  });

  test('a recycled wrapper pid never adopts an unrelated seat-less run; the dead row is judged on its own', async () => {
    const log = capture();
    try {
      const dir = root();
      // The recycled pid is alive (it belongs to the other run); identity is the launch id, so the old row is still dead.
      const deps = { ...fixture(dir, []), now: () => now, cap: () => 1, alive: () => true, receipt: () => 'started' as const,
        processes: () => [{ pid: 41, runId: 'r-other', progressAt: ago(1) }] };
      await addHarnessQueue({ seat: 'MK', say: 'next MK' }, deps);
      const rows = JSON.parse(readFileSync(harnessQueuePath(dir), 'utf8')) as QueueItem[];
      const dead: QueueItem = { ...rows[0]!, id: 'hq-dead-reused', status: 'launched', pid: 41,
        launchId: 'hq-00000000-0000-4000-8000-000000000004', at: new Date(ago(30)).toISOString() };
      writeFileSync(harnessQueuePath(dir), JSON.stringify([dead, ...rows]));
      // The wrapper ran (it wrote its receipt 30 min ago) and died; its pid now belongs to another process.
      mkdirSync(join(dir, 'harness'), { recursive: true });
      writeFileSync(harnessQueueReceiptPath(dir, dead.launchId!), JSON.stringify({ state: 'started', at: new Date(ago(30)).toISOString() }));
      expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
      expect(log.excluded).toEqual([{ runId: 'r-other', launchId: null, pid: 41, seat: null, reason: 'unknown-seat', idleMin: 1 },
        { runId: null, launchId: dead.launchId, queueId: 'hq-dead-reused', seat: 'MK', reason: 'dead-row', idleMin: 30 }]);
    } finally { log.restore(); }
  });

  test('a launched row with no receipt whose wrapper pid was recycled is dead after the grace', async () => {
    const log = capture();
    try {
      const dir = root();
      const deps = { ...fixture(dir, []), now: () => now, cap: () => 1, alive: () => true,
        processes: () => [{ pid: 43, seat: 'UX' as const, runId: 'r-ux', progressAt: ago(1) }] };
      await addHarnessQueue({ seat: 'MK', say: 'next MK' }, deps);
      const rows = JSON.parse(readFileSync(harnessQueuePath(dir), 'utf8')) as QueueItem[];
      const dead: QueueItem = { ...rows[0]!, id: 'hq-no-receipt', status: 'launched', pid: 43,
        launchId: 'hq-00000000-0000-4000-8000-000000000009', at: new Date(ago(40)).toISOString() };
      writeFileSync(harnessQueuePath(dir), JSON.stringify([dead, ...rows]));
      expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
      expect(log.excluded).toEqual([{ runId: null, launchId: dead.launchId, queueId: 'hq-no-receipt', seat: 'MK', reason: 'dead-row', idleMin: 40 }]);
    } finally { log.restore(); }
  });

  test('a started receipt without a readable time still switches liveness to the inventory', async () => {
    const log = capture();
    try {
      const dir = root();
      const deps = { ...fixture(dir, []), now: () => now, cap: () => 1, alive: () => true };
      await addHarnessQueue({ seat: 'MK', say: 'next MK' }, deps);
      const rows = JSON.parse(readFileSync(harnessQueuePath(dir), 'utf8')) as QueueItem[];
      const dead: QueueItem = { ...rows[0]!, id: 'hq-no-time', status: 'launched', pid: 42,
        launchId: 'hq-00000000-0000-4000-8000-000000000008', at: new Date(ago(25)).toISOString() };
      writeFileSync(harnessQueuePath(dir), JSON.stringify([dead, ...rows]));
      mkdirSync(join(dir, 'harness'), { recursive: true });
      writeFileSync(harnessQueueReceiptPath(dir, dead.launchId!), JSON.stringify({ state: 'started' }));
      expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
      expect(log.excluded).toEqual([{ runId: null, launchId: dead.launchId, queueId: 'hq-no-time', seat: 'MK', reason: 'dead-row', idleMin: 25 }]);
    } finally { log.restore(); }
  });

  test('the queue wrapper argv gives its launch id on macOS without env', () => {
    const launchId = 'hq-00000000-0000-4000-8000-000000000005';
    const run = ((command: string) => ({ status: 0, stdout: command === 'ps'
      ? `51 1 /opt/bun/bin/bun /repo/src/harness/harness-queue-child.ts /state/harness/${launchId}.receipt.json /repo/bin/elanous.mjs harness say goal\n`
        + '52 51 /opt/bun/bin/bun /repo/bin/elanous.mjs harness say goal' : '' })) as typeof import('node:child_process').spawnSync;
    expect(readHarnessQueueProcesses({ platform: 'darwin', run, seatTrees: {}, runsDir: selfDevRunsDir(root()) }))
      .toEqual([{ pid: 51, launchId }]);
  });

  test('a stale run of a seat with no queued head is still observed once in the tick', async () => {
    const log = capture();
    try {
      const deps = tcDeps([{ pid: 61, seat: 'MK', runId: 'r-mk-stale', progressAt: ago(50) }]);
      await addHarnessQueue({ seat: 'TC', say: 'only TC is queued' }, deps);
      expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
      expect(log.excluded).toEqual([{ runId: 'r-mk-stale', launchId: null, pid: 61, seat: 'MK', reason: 'stale', idleMin: 50 }]);
    } finally { log.restore(); }
  });

  describe('SEAT-CAP-STALE2: a run working in a Pod is progressing even when its host ledger is quiet', () => {
    const watch = () => {
      const events: { event: string; data: Record<string, unknown> }[] = [];
      const original = debug.log;
      (debug as { log: typeof debug.log }).log = ((category, event, data) => {
        if (category === 'harness.queue' && ['seat-cap-excluded', 'seat-cap-progress', 'progress-source-unavailable'].includes(event))
          events.push({ event, data: data as Record<string, unknown> });
      }) as typeof debug.log;
      return { events, restore: () => { (debug as { log: typeof debug.log }).log = original; } };
    };
    // TC cap 2: one fresh run plus one run idle 60 min in its ledger. Counted ⇒ 2/2 waiting; excluded ⇒ launched.
    const podDeps = (podRuns: () => ReadonlySet<string>, idle = 60) => ({
      ...tcDeps([]),
      processes: () => [{ pid: 11, seat: 'TC' as const, runId: 'r-fresh', progressAt: ago(2) },
        { pid: 12, seat: 'TC' as const, progressAt: ago(idle), ledgerRunIds: ['run-pod-a'] }],
      podRuns,
    });
    // Real Job list shapes fed through the real parser: Running (active+ready), Pending Pod (active, not ready), not yet created.
    const jobsOf = (status: Record<string, unknown>, labels: Record<string, string> = { 'elanous.run': 'run-pod-a' }) =>
      JSON.stringify({ items: [{ metadata: { name: 'si-a', labels: { 'elanous.substrate': 'pod', ...labels } }, status }] });
    const kubectlFor = (byContext: Record<string, string>, calls: string[]) => ((args: readonly string[]) => {
      const context = args[args.indexOf('--context') + 1]!;
      calls.push(context);
      return { status: 0, stdout: byContext[context] ?? JSON.stringify({ items: [] }), stderr: '' };
    }) as Parameters<typeof readHarnessQueuePodRuns>[0];

    for (const [phase, status] of [['running', { active: 1, ready: 1 }], ['pending', { active: 1, ready: 0 }],
      ['created-without-pod-yet', {}]] as const) {
      test(`ledger idle 60 min with its Pod Job ${phase} is counted (real Job parser)`, async () => {
        const log = watch();
        const calls: string[] = [];
        try {
          const deps = podDeps(() => readHarnessQueuePodRuns(kubectlFor({ 'ctx-b': jobsOf(status) }, calls), [{ context: 'ctx-a' }, { context: 'ctx-b' }]));
          await addHarnessQueue({ seat: 'TC', say: `pod ${phase}` }, deps);
          expect((await tickHarnessQueue(deps)).outcome).toBe('waiting');
          expect(calls).toEqual(['ctx-a', 'ctx-b']);
          expect(log.events).toEqual([{ event: 'seat-cap-progress', data: { runId: 'run-pod-a', launchId: null, pid: 12, seat: 'TC',
            source: 'pod-job', podRunId: 'run-pod-a', ledgerIdleMin: 60 } }]);
        } finally { log.restore(); }
      });
    }

    test('a finished Job does not keep the run; several stale runs across seats still read each member once per tick', async () => {
      const log = watch();
      const calls: string[] = [];
      try {
        const done = jobsOf({ succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] });
        const deps = { ...podDeps(() => readHarnessQueuePodRuns(kubectlFor({ 'ctx-a': done }, calls), [{ context: 'ctx-a' }, { context: 'ctx-b' }])),
          processes: () => [{ pid: 11, seat: 'TC' as const, runId: 'r-fresh', progressAt: ago(2) },
            { pid: 12, seat: 'TC' as const, progressAt: ago(60), ledgerRunIds: ['run-pod-a'] },
            { pid: 13, seat: 'MK' as const, progressAt: ago(70), ledgerRunIds: ['run-mk'] },
            { pid: 14, seat: 'UX' as const, progressAt: ago(80), ledgerRunIds: ['run-ux'] }] };
        await addHarnessQueue({ seat: 'TC', say: 'finished job' }, deps);
        expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
        expect(calls).toEqual(['ctx-a', 'ctx-b']);
        expect(log.events.map((row) => `${row.event}:${row.data.runId}:${row.data.reason}`).sort()).toEqual([
          'seat-cap-excluded:run-mk:stale', 'seat-cap-excluded:run-pod-a:stale', 'seat-cap-excluded:run-ux:stale']);
      } finally { log.restore(); }
    });

    test('ledger idle 60 min and no Pod Job is excluded as stale (counter-proof, real Job parser)', async () => {
      const log = watch();
      const calls: string[] = [];
      try {
        // ctx-a lists no Jobs at all; ctx-b lists only another run's unfinished Job.
        const deps = podDeps(() => readHarnessQueuePodRuns(kubectlFor({ 'ctx-a': JSON.stringify({ items: [] }),
          'ctx-b': jobsOf({ active: 1, ready: 1 }, { 'elanous.run': 'run-other' }) }, calls), [{ context: 'ctx-a' }, { context: 'ctx-b' }]));
        await addHarnessQueue({ seat: 'TC', say: 'no pod' }, deps);
        expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
        expect(calls).toEqual(['ctx-a', 'ctx-b']);
        expect(log.events).toEqual([{ event: 'seat-cap-excluded', data: { runId: 'run-pod-a', launchId: null, pid: 12, seat: 'TC', reason: 'stale', idleMin: 60 } }]);
      } finally { log.restore(); }
    });

    test('an unreadable Job list keeps the stale-looking run counted and is observed once', async () => {
      const log = watch();
      let reads = 0;
      try {
        const deps = podDeps(() => { reads++; throw new Error('kubectl down'); });
        await addHarnessQueue({ seat: 'TC', say: 'lease unreadable' }, deps);
        expect((await tickHarnessQueue(deps)).outcome).toBe('waiting');
        expect(reads).toBe(1);
        expect(log.events).toEqual([
          { event: 'progress-source-unavailable', data: { source: 'pod-jobs', error: 'Error: kubectl down' } },
          { event: 'seat-cap-progress', data: { runId: 'run-pod-a', launchId: null, pid: 12, seat: 'TC', source: 'pod-unavailable', ledgerIdleMin: 60 } },
        ]);
      } finally { log.restore(); }
    });

    test('a fresh ledger is counted without reading Pod Jobs (unchanged)', async () => {
      const log = watch();
      let reads = 0;
      try {
        const deps = podDeps(() => { reads++; return new Set(); }, 5);
        await addHarnessQueue({ seat: 'TC', say: 'fresh' }, deps);
        expect((await tickHarnessQueue(deps)).outcome).toBe('waiting');
        expect(reads).toBe(0);
        expect(log.events).toEqual([]);
      } finally { log.restore(); }
    });

    test('Job labels: unfinished Jobs give their run and child-run; Complete/Failed Jobs do not; label values are sanitized', () => {
      const job = (labels: Record<string, string>, conditions: { type: string; status: string }[] = []) => ({ metadata: { labels }, status: { conditions } });
      const stdout = JSON.stringify({ items: [
        job({ 'elanous.run': 'run-a', 'elanous.child-run': 'run-a-child' }),
        job({ 'elanous.run': 'run-done' }, [{ type: 'Complete', status: 'True' }]),
        job({ 'elanous.run': 'run-failed' }, [{ type: 'Failed', status: 'True' }]),
        job({ 'elanous.run': 'run-retrying' }, [{ type: 'Failed', status: 'False' }]),
      ] });
      expect([...queuePodRunsFromJobs(stdout)].sort()).toEqual(['run-a', 'run-a-child', 'run-retrying']);
      expect(() => queuePodRunsFromJobs('{}')).toThrow('invalid response');
      for (const id of ['run-16da3121-3640-4d72-bcf4-c00051f9c8a8', 'odd id/with:chars', `x${'y'.repeat(80)}`])
        expect(queueRunLabelValue(id)).toBe(k8sLabelValue(id)!);
    });

    test('the process inventory carries ledger run ids for Pod matching', () => {
      const runsDir = selfDevRunsDir(root());
      saveSelfDevRun({ runId: 'run-pod-b', createdAt: 1, updatedAt: 9, results: [], pid: 81, pidStart: 'darwin:81', seat: 'TC' }, runsDir);
      const run = ((command: string) => ({ status: 0, stdout: command === 'ps' ? '81 1 bun /repo/bin/elanous.mjs harness say goal' : '' })) as typeof import('node:child_process').spawnSync;
      expect(readHarnessQueueProcesses({ platform: 'darwin', run, seatTrees: {}, runsDir, birthId: () => 'darwin:81' }))
        .toEqual([{ pid: 81, seat: 'TC', progressAt: 9, ledgerRunIds: ['run-pod-b'] }]);
    });
  });

  test('one stopped supervisor record does not mark a process whose other record is still progressing as soft-stopped', () => {
    const runsDir = selfDevRunsDir(root());
    saveSelfDevRun({ runId: 'r-stopped', createdAt: 1, updatedAt: 9, results: [], pid: 71, pidStart: 'darwin:71',
      seat: 'TC', supervisorStopReason: 'harvestable-awaiting-human' }, runsDir);
    saveSelfDevRun({ runId: 'r-going', createdAt: 1, updatedAt: 5, results: [], pid: 71, pidStart: 'darwin:71', seat: 'TC' }, runsDir);
    const run = ((command: string) => ({ status: 0, stdout: command === 'ps' ? '71 1 bun /repo/bin/elanous.mjs harness say goal' : '' })) as typeof import('node:child_process').spawnSync;
    expect(readHarnessQueueProcesses({ platform: 'darwin', run, seatTrees: {}, runsDir, birthId: () => 'darwin:71' }))
      .toEqual([{ pid: 71, seat: 'TC', progressAt: 9, ledgerRunIds: ['r-stopped', 'r-going'] }]);
  });

  test('counting limits resolve config > env > default', () => {
    expect(harnessQueueCountingLimits(undefined, {})).toEqual({ staleRunMinutes: 30, unknownSeatCap: 2 });
    const env = { ELANOUS_HARNESS_QUEUE_STALE_RUN_MINUTES: '45', ELANOUS_HARNESS_QUEUE_UNKNOWN_SEAT_CAP: '0' };
    expect(harnessQueueCountingLimits(undefined, env)).toEqual({ staleRunMinutes: 45, unknownSeatCap: 0 });
    expect(harnessQueueCountingLimits({ staleRunMinutes: 10, unknownSeatCap: 3 }, env)).toEqual({ staleRunMinutes: 10, unknownSeatCap: 3 });
    expect(harnessQueueCountingLimits({ staleRunMinutes: 0 }, { ELANOUS_HARNESS_QUEUE_STALE_RUN_MINUTES: 'x' })).toEqual({ staleRunMinutes: 30, unknownSeatCap: 2 });
  });
});

test('TASK-QUEUE: a seat launches its highest rubric priority first and prio re-ranks the next tick', async () => {
  const dir = root(), launches: string[][] = [];
  const scores: Record<string, number> = { 'TQ-FIVE': 5, 'TQ-TWELVE': 12 };
  const deps: HarnessQueueDeps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 12 }), cap: () => 3,
    cellPriority: (cell) => scores[cell] };
  const five = await addHarnessQueue({ seat: 'TC', say: '칸: TQ-FIVE five' }, deps);
  const twelve = await addHarnessQueue({ seat: 'TC', say: '칸: TQ-TWELVE twelve' }, deps);
  const none = await addHarnessQueue({ seat: 'TC', say: 'no cell' }, deps);
  expect(listHarnessQueue(deps).map((row) => row.priority)).toEqual([5, 12, undefined]);
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: twelve.id } });
  const audit: Array<unknown> = [];
  const original = debug.log;
  (debug as { log: unknown }).log = (category: string, event: string, data?: unknown) => {
    if (category === 'harness.queue' && event === 'prio') audit.push(data);
  };
  try {
    expect(await setHarnessQueuePriority(none.id, 20, 'OP', deps)).toMatchObject({ id: none.id, priority: 20 });
  } finally { (debug as { log: unknown }).log = original; }
  expect(audit).toEqual([{ id: none.id, from: null, to: 20, by: 'OP' }]);
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: none.id } });
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: five.id } });
  expect(launches.map((args) => args[2])).toEqual(['칸: TQ-TWELVE twelve', 'no cell', '칸: TQ-FIVE five']);
  // A launched row's slot is taken — re-ranking it is refused.
  await expect(setHarnessQueuePriority(twelve.id, 99, 'OP', deps)).rejects.toThrow('queued');
  await expect(setHarnessQueuePriority('hq-missing', 1, 'OP', deps)).rejects.toThrow('항목 없음');
  await expect(setHarnessQueuePriority(five.id, Number.NaN, 'OP', deps)).rejects.toThrow('유한한 수');
  await expect(setHarnessQueuePriority(five.id, 1, ' ', deps)).rejects.toThrow('요청 주체');
});

test('TASK-QUEUE: prio 5→20 moves that row to the front of its seat on the next tick', async () => {
  const dir = root(), launches: string[][] = [];
  const scores: Record<string, number> = { 'TQ-FIVE': 5, 'TQ-TWELVE': 12 };
  const deps: HarnessQueueDeps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 12 }), cap: () => 3,
    cellPriority: (cell) => scores[cell] };
  const five = await addHarnessQueue({ seat: 'UX', say: '칸: TQ-FIVE five' }, deps);
  await addHarnessQueue({ seat: 'UX', say: '칸: TQ-TWELVE twelve' }, deps);
  // A failed audit write rolls the change back.
  const failing = debug.log;
  (debug as { log: unknown }).log = (category: string, event: string) => {
    if (category === 'harness.queue' && event === 'prio') throw new Error('log store down');
  };
  try { await expect(setHarnessQueuePriority(five.id, 50, 'OP', deps)).rejects.toThrow('감사 기록 실패'); }
  finally { (debug as { log: unknown }).log = failing; }
  expect(listHarnessQueue(deps).find((row) => row.id === five.id)?.priority).toBe(5);
  await setHarnessQueuePriority(five.id, 20, 'OP', deps);
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: five.id, priority: 20 } });
});

test('TASK-QUEUE: a queue without priority keeps seat round robin and FIFO, and old rows still read', async () => {
  const dir = root(), launches: string[][] = [];
  const deps: HarnessQueueDeps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 12 }), cap: () => 3,
    cellPriority: () => undefined };
  mkdirSync(join(dir, 'harness'), { recursive: true });
  // Pre-TASK-QUEUE rows carry no priority field (one carries a cellId).
  const row = (n: number, seat: string, input: string, extra: Record<string, unknown> = {}) => ({
    id: `hq-00000000-0000-4000-8000-00000000000${n}`, seat, kind: 'say', input, hold: false, heavy: false,
    at: `2026-10-06T00:00:0${n}.000Z`, status: 'queued', ...extra });
  writeFileSync(harnessQueuePath(dir), JSON.stringify([row(1, 'TC', 'TC first', { cellId: 'OLD-ONE' }), row(2, 'TC', 'TC second'), row(3, 'MK', 'MK first')]));
  for (let i = 0; i < 3; i++) expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
  expect(launches.map((args) => args[2])).toEqual(['TC first', 'MK first', 'TC second']);
});

test('TASK-QUEUE: the default enqueue priority is the cell rubric score plus the CEO bonus', async () => {
  const dir = root();
  setSchedule('9.9.1', { cutAt: '2099-10-06T18:00+09:00' }, 'fixture', dir);
  mkdirSync(join(dir, 'release', '9.9.1'), { recursive: true });
  writeFileSync(join(dir, 'release', '9.9.1', 'checklist.json'), JSON.stringify({ version: '9.9.1', items: [
    { id: 'TQ-R', title: '루브릭 칸', status: 'yellow', evidence: '루브릭: A3 E2 R1 D2 M1 B0 S1 X0' },
    { id: 'TQ-CEO', title: '\u{1F451} 대표 칸', status: 'yellow', evidence: '루브릭: A1 E1 R1 D0 M0 B0 S0 X0' },
    { id: 'TQ-NONE', title: '루브릭 없음', status: 'yellow' },
  ] }));
  const now = new Date('2026-10-06T00:00:00Z');
  expect(queueCellRubricPriority('TQ-R', dir, now)).toBe(15.5);
  expect(queueCellRubricPriority('TQ-CEO', dir, now)).toBe(6 + QUEUE_CEO_PRIORITY_BONUS);
  expect(queueCellRubricPriority('TQ-NONE', dir, now)).toBeUndefined();
  expect(queueCellRubricPriority('TQ-ABSENT', dir, now)).toBeUndefined();
  const deps: HarnessQueueDeps = { ...fixture(dir, []), now: () => now };
  expect(await addHarnessQueue({ seat: 'OP', say: '칸: TQ-R 루브릭 칸 구현' }, deps)).toMatchObject({ cellId: 'TQ-R', priority: 15.5 });
  // A broken lookup leaves the row unprioritized instead of refusing the enqueue.
  const plain = await addHarnessQueue({ seat: 'OP', say: '칸: TQ-X other' }, { ...deps, cellPriority: () => { throw new Error('ledger down'); } });
  expect(plain.priority).toBeUndefined();
});

test('TASK-QUEUE: harness queue prio CLI re-ranks a queued row and refuses a non-number', async () => {
  const dir = root(), deps = fixture(dir, []);
  const item = await addHarnessQueue({ seat: 'TC', say: 'cli prio' }, deps);
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'cli', queue: deps });
  const original = console.log, lines: string[] = [];
  console.log = (line: string) => { lines.push(line); };
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'prio', item.id, '7']);
    await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'list']);
  } finally { console.log = original; }
  expect(lines).toEqual([`${item.id} prio 7`, `${item.id} TC queued say cli prio · prio 7`]);
  expect(listHarnessQueue(deps)[0]!.priority).toBe(7);
  // The CLI refuses a launched row and a non-number, leaving the file as it was.
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'launched', item: { id: item.id } });
  const errors: string[] = [];
  const originalError = console.error, exitCode = process.exitCode;
  console.error = (line: string) => { errors.push(String(line)); };
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'prio', item.id, '9']).catch((error: unknown) => errors.push(String(error)));
    await program.parseAsync(['node', 'elanous', 'harness', 'queue', 'prio', item.id, 'abc']).catch((error: unknown) => errors.push(String(error)));
  } finally { console.error = originalError; process.exitCode = exitCode ?? 0; }
  expect(errors.join('\n')).toContain('대기(queued) 행만');
  expect(errors.join('\n')).toContain('수가 아니다');
  expect(listHarnessQueue(deps)[0]).toMatchObject({ status: 'launched', priority: 7 });
});
