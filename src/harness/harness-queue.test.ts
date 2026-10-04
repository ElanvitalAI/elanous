import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { installHarnessCliCommand } from './harness-cli-command.js';
import { getUserConfig } from '../user-config.js';
import { addHarnessQueue, harnessQueuePath, harnessQueueReceiptPath, listHarnessQueue, queueLaunchArgs, readHarnessQueueProcesses, reconcileHarnessQueue, removeHarnessQueue, tickHarnessQueue, type HarnessQueueDeps } from './harness-queue.js';
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

test('default seat allowance is eight including live authoring children', async () => {
  const dir = root(), launches: string[][] = [];
  const deps = { ...fixture(dir, launches, { running: 0, pending: 0, reserved: 0, limit: 32 }), cap: undefined };
  for (let i = 0; i < 9; i++) await addHarnessQueue({ seat: 'TC', say: `goal ${i}` }, deps);
  for (let i = 0; i < 8; i++) expect((await tickHarnessQueue(deps)).outcome).toBe('launched');
  expect((await tickHarnessQueue(deps)).reason).toBe('seat TC: 8/8');
  expect(launches).toHaveLength(8);
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
  expect((await tickHarnessQueue({ ...deps, processes: () => { throw new Error('ps unavailable'); } })).outcome).toBe('waiting');
  const other = { ...deps, processes: () => [{ pid: 909, seat: 'UX' as const }] };
  expect((await tickHarnessQueue(other)).outcome).toBe('launched');
  await addHarnessQueue({ seat: 'TC', say: 'after first' }, other);
  const first = listHarnessQueue(other)[0]!;
  expect((await tickHarnessQueue({ ...other, processes: () => [{ pid: first.pid!, seat: 'TC', launchId: first.launchId },
    { pid: first.pid! + 1, seat: 'TC', launchId: first.launchId }] })).reason).toBe('seat TC: 1/1');
  expect((await tickHarnessQueue({ ...other, processes: () => [{ pid: first.pid!, seat: 'UX' }] })).reason).toBe('seat TC: 1/1');
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
  expect(JSON.parse(readFileSync(path, 'utf8')).state).toBe('finished');
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
