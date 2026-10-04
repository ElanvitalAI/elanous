import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { installHarnessCliCommand } from './harness-cli-command.js';
import { getUserConfig } from '../user-config.js';
import { addHarnessQueue, harnessQueueOutcome, harnessQueuePath, harnessQueueReceiptPath, listHarnessQueue, queueLaunchArgs, queueSeatForCwd, readHarnessQueueProcesses, reconcileHarnessQueue, removeHarnessQueue, tickHarnessQueue, type HarnessQueueDeps } from './harness-queue.js';
import { checkpointDependenciesForRun, loadSelfDevRun, processBirthId, saveSelfDevRun, selfDevRunsDir } from '../self-dev/run-store.js';
import { bindOrchestrateRunLedger } from '../self-dev/self-orchestrate-runtime.js';
import { debug } from '../debug/log.js';
import { runHarnessQueueChild } from './harness-queue-child.js';

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'harness-queue-')); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(dir: string, launches: string[][], pool = { running: 0, pending: 0, reserved: 0, limit: 2 }): HarnessQueueDeps {
  let nextPid = 101;
  return { root: dir, pool: () => pool, cap: () => 2, alive: () => true, processes: () => [],
    launch: async (_item, args) => { launches.push(args); return nextPid++; }, log: () => {} };
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

test('seat cap includes authoring/launching and unrelated seats do not bypass the FIFO head', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches), cap: () => 1 };
  await addHarnessQueue({ seat: 'TC', say: 'authoring' }, deps);
  await tickHarnessQueue(deps);
  await addHarnessQueue({ seat: 'TC', say: 'blocked' }, deps);
  await addHarnessQueue({ seat: 'UX', say: 'behind' }, deps);
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'waiting', reason: 'seat TC: 1/1' });
  expect(launches).toHaveLength(1);
});

test('seat allowance is read from harness.queue.seatCap and ignores invalid entries', () => {
  const dir = root(), file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ harness: { queue: { seatCap: { TC: 3, UX: 0, bogus: 100 } } } }));
  const caps = getUserConfig(file).harness?.queue?.seatCap;
  expect(caps?.TC).toBe(3);
  expect(caps?.UX).toBeUndefined();
  expect((caps as Record<string, number>)?.bogus).toBeUndefined();
});

test('default queue allowance of eight is lowered by the default four-per-seat gate', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 32 }), cap: undefined };
  for (let i = 0; i < 9; i++) await addHarnessQueue({ seat: 'TC', say: `goal ${i}` }, deps);
  for (let i = 0; i < 4; i++) expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
  expect((await tickHarnessQueue(deps)).reason).toBe('seat-cap: seat TC: 4/4');
  expect(launches).toHaveLength(4);
});

test('release gate charges running processes from the seat inventory before queue launch', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 32 }), cap: () => 8,
    processes: () => [101, 102, 103, 104].map((pid) => ({ pid, seat: 'TC' as const })) };
  await addHarnessQueue({ seat: 'TC', say: 'blocked by other launches' }, deps);
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'waiting', reason: 'seat-cap: seat TC: 4/4' });
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
  for (let i = 0; i < 3; i++) await addHarnessQueue({ seat: 'TC', say: `TC ${i}` }, deps);
  await addHarnessQueue({ seat: 'UX', say: 'UX after TC' }, deps);
  expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
  expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'waiting', reason: 'seat-cap: seat TC: 2/2' });
  expect(launches).toHaveLength(2);
  expect(await removeHarnessQueue(listHarnessQueue(deps)[2]!.id, deps)).toBe(true);
  expect((await tickHarnessQueue(deps)).item?.seat).toBe('UX');
  expect(launches).toHaveLength(3);
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
  expect((await tickHarnessQueue({ ...deps, alive: () => false })).reason).toBe('seat TC: 1/1');
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
  expect(await tickHarnessQueue(deps)).toMatchObject({ outcome: 'waiting', reason: 'seat TC: 1/1' });
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
  expect((await tickHarnessQueue(deps)).reason).toBe('seat TC: 1/1');
  expect(launches).toHaveLength(0);
  expect((await tickHarnessQueue({ ...deps, processes: () => [{ pid: 909 }] })).reason).toBe('seat TC: 1/1');
  expect(await tickHarnessQueue({ ...deps, processes: () => { throw new Error('ps unavailable'); } }))
    .toMatchObject({ outcome: 'waiting', reason: 'unknown-running: harness process inventory unavailable: Error: ps unavailable' });
  const other = { ...deps, processes: () => [{ pid: 909, seat: 'UX' as const }] };
  expect((await tickHarnessQueue(other)).outcome).toBe('launched');
  await addHarnessQueue({ seat: 'TC', say: 'after first' }, other);
  const first = listHarnessQueue(other)[0]!;
  expect((await tickHarnessQueue({ ...other, processes: () => [{ pid: first.pid!, seat: 'TC', launchId: first.launchId },
    { pid: first.pid! + 1, seat: 'TC', launchId: first.launchId }] })).reason).toBe('seat TC: 1/1');
  expect((await tickHarnessQueue({ ...other, processes: () => [{ pid: first.pid!, seat: 'UX' }] })).reason).toBe('seat TC: 1/1');
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
  expect((await tickHarnessQueue(deps)).reason).toBe('seat TC: 4/4');
  expect(events[0]).toMatchObject({ attributed: { OP: 0, TC: 2, MK: 1, UX: 1 }, unattributed: 2 });
  expect(launches).toHaveLength(0);
  const withoutTrees = readHarnessQueueProcesses({ platform: 'darwin', run, seatTrees: {} });
  expect(withoutTrees).toEqual([{ pid: 100 }, { pid: 200 }, { pid: 300 }, { pid: 400 }, { pid: 500 }, { pid: 600 }]);
  expect((await tickHarnessQueue({ ...deps, processes: () => withoutTrees })).reason).toBe('seat TC: 6/4');
  const otherSeats = { ...fixture(root(), launches), cap: () => 1,
    processes: () => processes.filter((row) => row.seat === 'MK' || row.seat === 'UX') };
  await addHarnessQueue({ seat: 'TC', say: 'not blocked by MK or UX' }, otherSeats);
  expect((await tickHarnessQueue(otherSeats)).outcome).toBe('launched');
  expect(launches).toHaveLength(1);
  expect(readHarnessQueueProcesses({ platform: 'linux', run, seatTrees: trees, cwd: (pid) => cwd[String(pid)]! }))
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

test('a live dev --file authoring process is inventoried and blocks a cap-one queue tick', async () => {
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
    expect(result.reason).toMatch(/^seat TC: [1-9]\d*\/1$/);
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
  expect((await tickHarnessQueue({ ...finished, processes: () => [{ pid: launched.pid!, seat: 'TC' as const, launchId: launched.launchId }] })).reason).toBe('seat TC: 1/1');
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
  expect((await tickHarnessQueue(deps)).reason).toBe('seat TC: 1/1');
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
  expect((await tickHarnessQueue(deps)).reason).toBe('seat TC: 1/1');
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
    + `const result = await tickHarnessQueue({root: ${JSON.stringify(dir)}, cap: () => 2, pool: () => ({running:0,pending:0,reserved:0,limit:2}), alive: () => true, processes: () => [], launch: async () => { await Bun.sleep(100); return process.pid; }, log: () => {}});\n`
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
