import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { installHarnessCliCommand } from './harness-cli-command.js';
import { getUserConfig } from '../user-config.js';
import { addHarnessQueue, harnessQueueOutcome, harnessQueuePath, harnessQueueReceiptPath, listHarnessQueue, queueLaunchArgs, queueSeatForCwd, readHarnessQueueProcesses, reconcileHarnessQueue, removeHarnessQueue, requestIdleSeats, tickHarnessQueue, type HarnessQueueDeps, type QueueItem } from './harness-queue.js';
import { checkpointDependenciesForRun, loadSelfDevRun, processBirthId, saveSelfDevRun, selfDevRunsDir } from '../self-dev/run-store.js';
import { bindOrchestrateRunLedger } from '../self-dev/self-orchestrate-runtime.js';
import { debug } from '../debug/log.js';
import { runHarnessQueueChild } from './harness-queue-child.js';
import { collectAuthorDepth, runAuthorDepthShadow } from '../loops/orchestrator/author-depth.js';
import { AuthorLedger } from '../loops/orchestrator/author-ledger.js';

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'harness-queue-')); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(dir: string, launches: string[][], pool = { running: 0, pending: 0, reserved: 0, limit: 2 }): HarnessQueueDeps {
  let nextPid = 101;
  return { root: dir, pool: () => pool, cap: () => 2, alive: () => true, processes: () => [],
    authorShadow: () => {}, idleRequest: () => {}, launch: async (_item, args) => { launches.push(args); return nextPid++; }, log: () => {} };
}

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
  expect(JSON.parse(readFileSync(`${harnessQueuePath(dir)}.round-robin.json`, 'utf8'))).toEqual({ lastSeat: 'UX' });
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
  expect((await tickHarnessQueue({ ...deps, processes: () => [{ pid: 909 }] })).reason).toBe('seat TC: 1/1 (injectedCap.TC=1 · releaseGate.TC=4 · seatCaps.TC=8)');
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

test('macOS ps/lsof attributes only the matching working tree, preserves unknown charges, and counts parent-child once', async () => {
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
    const path = cwd[args[2]!];
    return path ? { status: 0, stdout: `p${args[2]}\nfcwd\nn${path}\n` } : { status: 1, stdout: '' };
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
  expect(calls).toEqual(['ps -eo pid=,ppid=,args=', ...['100', '101', '200', '300', '400', '500', '600'].map((pid) => `lsof -a -p ${pid} -d cwd -Fn`)]);
  expect(processes).toEqual([{ pid: 100, seat: 'TC' }, { pid: 200, seat: 'TC' }, { pid: 300 }, { pid: 400 }, { pid: 500, seat: 'MK' }, { pid: 600, seat: 'UX' }]);
  const deps = { ...fixture(dir, launches), cap: () => 4, processes: () => processes,
    log: (event: string, data: Record<string, unknown>) => { if (event === 'waiting') events.push(data); } };
  await addHarnessQueue({ seat: 'TC', say: 'next' }, deps);
  expect((await tickHarnessQueue(deps)).reason).toBe('seat TC: 4/4 (releaseGate.TC=4 · injectedCap.TC=4 · seatCaps.TC=8)');
  expect(events[0]).toMatchObject({ attributed: { OP: 0, TC: 2, MK: 1, UX: 1 }, unattributed: 2 });
  expect(launches).toHaveLength(0);
  const withoutTrees = readHarnessQueueProcesses({ platform: 'darwin', run, seatTrees: {} });
  expect(withoutTrees).toEqual([{ pid: 100 }, { pid: 200 }, { pid: 300 }, { pid: 400 }, { pid: 500 }, { pid: 600 }]);
  expect((await tickHarnessQueue({ ...deps, processes: () => withoutTrees })).reason).toBe('seat TC: 6/4 (releaseGate.TC=4 · injectedCap.TC=4 · seatCaps.TC=8)');
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
    expect(check('darwin')).toEqual([{ pid: 951, seat: 'TC' }]);
    expect(events.at(-1)).toEqual({ pid: 951, seat: 'TC', source: 'ledger' });
    expect(readHarnessQueueProcesses({ platform: 'darwin', run: command(), seatTrees: {}, runsDir,
      cwd: () => { throw Error('clone removed'); }, birthId: () => 'darwin:123456' })).toEqual([{ pid: 951, seat: 'TC' }]);
    expect(check('darwin', ' --seat UX')).toEqual([{ pid: 951, seat: 'UX' }]);
    expect(events.at(-1)).toEqual({ pid: 951, seat: 'UX', source: 'flag' });
    expect(check('linux', ' --seat UX', 'ELANOUS_HARNESS_SEAT=OP\0')).toEqual([{ pid: 951, seat: 'OP' }]);
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
  expect(readHarnessQueueProcesses(probe)).toEqual([{ pid: process.pid, seat: 'UX' }]);
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
  expect(readHarnessQueueProcesses(probe)).toEqual([{ pid: 951, seat: 'UX' }]);
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

test('FINISH-RATE: a test process without injected metrics skips the real measurement', async () => {
  const { dir, deps, launches } = finishFixture('on', backlogged, 4);
  delete deps.finishMetrics;
  // A fresh cached backlogged measurement must not bypass the test-process skip (ACP review must-fix).
  mkdirSync(join(dir, 'harness'), { recursive: true });
  writeFileSync(join(dir, 'harness', 'finish-metrics.json'), JSON.stringify({ at: '2026-10-05T08:58:00Z', metrics: backlogged }));
  await addHarnessQueue({ seat: 'MK', say: 'skip' }, deps);
  const count = () => debug.events(1000).filter(entry => entry.category === 'loop.orchestrator' && entry.event === 'finish-skipped-test').length;
  const before = count();
  expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
  expect(launches).toHaveLength(1);
  expect(count()).toBe(before + 1);
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
