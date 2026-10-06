import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { psProcessStartMs } from '../harness/harness-stop.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { readFailureInbox, recordFailureEvent, startHealLoop, type FailureEvent } from './heal-intake.js';

const dirs: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'heal-intake-'));
  dirs.push(path);
  return path;
}
afterEach(() => {
  resetElanousConfigDir();
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

const base = { source: 'release-run' as const, kind: 'graph-run', ref: 'release/run-1', summary: 'failed node', at: '2026-10-04T13:00:00.000Z' };

function loopSpy() {
  const starts: Array<{ file: string; options: { runId: string; input: { failureEvent: FailureEvent }; deps: { root: string } } }> = [];
  const start = async (file: string, options: { runId: string; input: { failureEvent: FailureEvent }; deps: { root: string } }) => {
    starts.push({ file, options });
  };
  return { starts, start };
}

const settleLoopStart = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('record writes one JSON line under the selected state root and logs the folded verdict', () => {
  const dir = root();
  expect(recordFailureEvent(base, dir, loopSpy().start)).toEqual({ folded: false });
  expect(readFileSync(join(dir, 'heal', 'inbox.jsonl'), 'utf8')).toBe(`${JSON.stringify(base)}\n`);
  expect(readFailureInbox({}, dir)).toEqual([base]);
  expect(debug.events(100).filter(entry => entry.category === 'heal.intake' && entry.event === 'recorded').at(-1))
    .toMatchObject({ data: { source: base.source, kind: base.kind, ref: base.ref, folded: false } });
});

test('default inbox follows the selected instance state root', () => {
  const dir = root();
  setElanousConfigDir(dir);
  expect(recordFailureEvent(base, undefined, loopSpy().start)).toEqual({ folded: false });
  expect(readFailureInbox()).toEqual([base]);
  expect(readFileSync(join(dir, 'heal', 'inbox.jsonl'), 'utf8')).toBe(`${JSON.stringify(base)}\n`);
});

test('same source+ref folds inside one hour; other source and exactly one hour apart remain separate', () => {
  const dir = root();
  const { start } = loopSpy();
  recordFailureEvent(base, dir, start);
  expect(recordFailureEvent({ ...base, kind: 'different', summary: 'repeated', at: '2026-10-04T13:59:59.999Z' }, dir, start)).toEqual({ folded: true });
  expect(recordFailureEvent({ ...base, source: 'cron' }, dir, start)).toEqual({ folded: false });
  expect(recordFailureEvent({ ...base, at: '2026-10-04T14:00:00.000Z' }, dir, start)).toEqual({ folded: false });
  expect(readFailureInbox({}, dir)).toHaveLength(3);
  expect(debug.events(100).filter(entry => entry.category === 'heal.intake' && entry.event === 'recorded').some(entry =>
    (entry.data as { folded?: boolean }).folded === true)).toBe(true);
});

test('since reads inclusive timestamps without changing the stored lines', () => {
  const dir = root();
  const { start } = loopSpy();
  expect(readFailureInbox({}, dir)).toEqual([]);
  recordFailureEvent(base, dir, start);
  recordFailureEvent({ ...base, ref: 'release/run-2', at: '2026-10-04T14:00:00.000Z' }, dir, start);
  const before = readFileSync(join(dir, 'heal', 'inbox.jsonl'), 'utf8');
  expect(readFailureInbox({ since: '2026-10-04T14:00:00.000Z' }, dir).map(row => row.ref)).toEqual(['release/run-2']);
  expect(readFailureInbox({ since: '2026-10-05T00:00:00.000Z' }, dir)).toEqual([]);
  expect(readFileSync(join(dir, 'heal', 'inbox.jsonl'), 'utf8')).toBe(before);
});

test('a recorded event starts one heal-loop run; its folded key starts none', async () => {
  const dir = root();
  const { starts, start } = loopSpy();
  expect(recordFailureEvent(base, dir, start)).toEqual({ folded: false });
  await settleLoopStart();
  expect(starts).toHaveLength(1);
  expect(starts[0]!.file).toBe(join(import.meta.dir, '../../graphs/heal/heal-loop.yaml'));
  expect(starts[0]!.options).toMatchObject({ runId: expect.stringMatching(/^heal-[a-f0-9]{64}$/), input: { failureEvent: base }, deps: { root: dir } });
  expect(recordFailureEvent({ ...base, kind: 'different', at: '2026-10-04T13:30:00.000Z' }, dir, start)).toEqual({ folded: true });
  await settleLoopStart();
  expect(starts).toHaveLength(1);
  expect(recordFailureEvent({ ...base, at: '2026-10-04T14:00:00.000Z' }, dir, start)).toEqual({ folded: false });
  await settleLoopStart();
  expect(starts).toHaveLength(2);
  expect(starts[1]!.options.runId).not.toBe(starts[0]!.options.runId);
  expect(readFailureInbox({}, dir)).toEqual([base, { ...base, at: '2026-10-04T14:00:00.000Z' }]);
});

test('a loop start failure is logged without failing the already recorded inbox event', async () => {
  const dir = root();
  const start = async () => { throw new Error('start denied'); };
  expect(recordFailureEvent(base, dir, start)).toEqual({ folded: false });
  await settleLoopStart();
  expect(readFailureInbox({}, dir)).toEqual([base]);
  expect(debug.events(100).filter(entry => entry.category === 'heal.intake' && entry.event === 'loop-start-failed'
    && (entry.data as { ref?: string }).ref === base.ref)).toHaveLength(1);
  expect(debug.events(100).filter(entry => entry.category === 'heal.intake' && entry.event === 'loop-start-failed'
    && (entry.data as { ref?: string }).ref === base.ref).at(-1)).toMatchObject({ data: { error: 'Error: start denied' } });
  expect(recordFailureEvent(base, dir, start)).toEqual({ folded: true });
  await settleLoopStart();
  expect(debug.events(100).filter(entry => entry.category === 'heal.intake' && entry.event === 'loop-start-failed'
    && (entry.data as { ref?: string }).ref === base.ref)).toHaveLength(1);
});

test('inside a test process the default loop starter records the event but starts no real heal loop', async () => {
  const dir = root();
  setElanousConfigDir(dir);
  const event = { ...base, source: 'cron' as const, ref: 'default-starter', kind: 'unknown', summary: ' ' };
  expect(recordFailureEvent(event)).toEqual({ folded: false });
  let skipped: unknown[] = [];
  for (let i = 0; i < 200 && skipped.length === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    skipped = debug.events(200).filter(entry => entry.category === 'heal.intake' && entry.event === (process.env.ELANOUS_POD_NAME ? 'skipped-in-pod' : 'loop-start-skipped-test'));
  }
  expect(skipped.length).toBeGreaterThan(0);
  expect(existsSync(join(dir, 'graph-runs', 'heal-loop'))).toBe(false);
  expect(readFailureInbox({}, dir)).toHaveLength(1);
});

function savedHealRun(dir: string, name: string, pid = process.pid): void {
  const path = join(dir, 'graph-runs', 'heal-loop');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, `${name}.json`), JSON.stringify({ graphId: 'heal-loop', runId: name, status: 'running',
    pid, pidStartedAt: new Date(psProcessStartMs(process.pid)!).toISOString() }));
}

function configuredCap(dir: string, cap: number): void {
  setElanousConfigDir(dir);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ heal: { maxConcurrentLoops: cap } }));
}

test('default starter defers at two live runs, records inbox and retries on the next record', async () => {
  const dir = root();
  savedHealRun(dir, 'first');
  savedHealRun(dir, 'second');
  const started: string[] = [];
  const run = async (_file: string, options: { runId: string }) => { started.push(options.runId); };
  const start = (file: string, options: Parameters<typeof startHealLoop>[1]) => startHealLoop(file, options, {}, run);
  recordFailureEvent(base, dir, start);
  await settleLoopStart();
  expect(started).toHaveLength(0);
  expect(readFailureInbox({}, dir)).toEqual([base]);
  expect(debug.events(200).filter(entry => entry.category === 'heal.intake' && entry.event === 'loop-start-deferred').at(-1))
    .toMatchObject({ data: { running: 2, cap: 2, runId: expect.stringMatching(/^heal-/) } });
  rmSync(join(dir, 'graph-runs', 'heal-loop', 'second.json'));
  recordFailureEvent({ ...base, ref: 'release/run-2' }, dir, start);
  await settleLoopStart();
  expect(started).toHaveLength(2);
  expect(readFailureInbox({}, dir)).toHaveLength(2);
  expect(new Set(started).size).toBe(2);
  recordFailureEvent({ ...base, ref: 'release/run-3' }, dir, start);
  await settleLoopStart();
  expect(started).toHaveLength(3);
  expect(new Set(started).size).toBe(3);
});

test('dead pid does not occupy a slot; configured cap changes the admission threshold', async () => {
  const dir = root();
  configuredCap(dir, 1);
  savedHealRun(dir, 'live');
  savedHealRun(dir, 'dead', 2147483647);
  const started: string[] = [];
  const run = async (_file: string, options: { runId: string }) => { started.push(options.runId); };
  const start = (file: string, options: Parameters<typeof startHealLoop>[1]) => startHealLoop(file, options, {}, run);
  recordFailureEvent(base, dir, start);
  await settleLoopStart();
  expect(started).toHaveLength(0);
  expect(debug.events(200).filter(entry => entry.category === 'heal.intake' && entry.event === 'loop-start-deferred').at(-1))
    .toMatchObject({ data: { running: 1, cap: 1 } });
  configuredCap(dir, 2);
  recordFailureEvent({ ...base, ref: 'release/run-2' }, dir, start);
  await settleLoopStart();
  expect(started).toHaveLength(2);
});

test('parallel new failures reserve two slots before the graph writes its first run ledger', async () => {
  const dir = root();
  const started: string[] = [];
  const finish: Array<() => void> = [];
  const run = async (_file: string, options: { runId: string }) => {
    started.push(options.runId);
    await new Promise<void>(resolve => finish.push(resolve));
  };
  const start = (file: string, options: Parameters<typeof startHealLoop>[1]) => startHealLoop(file, options, {}, run);
  for (let i = 0; i < 3; i++) recordFailureEvent({ ...base, ref: `release/run-${i}` }, dir, start);
  await settleLoopStart();
  expect(started).toHaveLength(2);
  expect(debug.events(200).filter(entry => entry.category === 'heal.intake' && entry.event === 'loop-start-deferred').at(-1))
    .toMatchObject({ data: { running: 2, cap: 2 } });
  finish[0]!();
  await settleLoopStart();
  expect(started).toHaveLength(3);
  expect(new Set(started).size).toBe(3);
  finish[1]!();
  finish[2]!();
  await settleLoopStart();
  expect(readFailureInbox({}, dir)).toHaveLength(3);
});

test('pre-ledger start failure releases its claim for a later inbox intake without duplicating a started key', async () => {
  const dir = root();
  const attempts: string[] = [];
  let fail = true;
  const run = async (_file: string, options: { runId: string }) => {
    attempts.push(options.runId);
    if (fail) throw new Error('before ledger');
    savedHealRun(dir, options.runId);
  };
  const start = (file: string, options: Parameters<typeof startHealLoop>[1]) => startHealLoop(file, options, {}, run);
  recordFailureEvent(base, dir, start);
  await settleLoopStart();
  expect(attempts).toHaveLength(1);
  expect(readdirSync(join(dir, 'heal', 'starts'))).toEqual([]);
  expect(readFailureInbox({}, dir)).toEqual([base]);
  fail = false;
  recordFailureEvent({ ...base, ref: 'release/run-2' }, dir, start);
  await settleLoopStart();
  expect(attempts.slice(0, 2)).toEqual([attempts[0], attempts[0]]);
  expect(attempts).toHaveLength(3);
  expect(new Set(attempts).size).toBe(2);
  recordFailureEvent({ ...base, ref: 'release/run-3' }, dir, start);
  await settleLoopStart();
  expect(attempts.filter(id => id === attempts[0])).toHaveLength(2);
  expect(readFailureInbox({}, dir)).toHaveLength(3);
});

test('a start that writes its ledger before throwing retains its claim and does not replay', async () => {
  const dir = root();
  const attempts: string[] = [];
  const run = async (_file: string, options: { runId: string }) => {
    attempts.push(options.runId);
    if (attempts.length === 1) {
      savedHealRun(dir, options.runId);
      throw new Error('after ledger');
    }
  };
  const start = (file: string, options: Parameters<typeof startHealLoop>[1]) => startHealLoop(file, options, {}, run);
  recordFailureEvent(base, dir, start);
  await settleLoopStart();
  expect(attempts).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(dir, 'heal', 'starts', `${attempts[0]}.json`), 'utf8'))).toEqual({ active: false, started: true });
  recordFailureEvent({ ...base, ref: 'release/run-2' }, dir, start);
  await settleLoopStart();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).not.toBe(attempts[0]);
});

test('parallel processes acquire the file lock before deciding to append or fold', async () => {
  const dir = root();
  const modulePath = join(import.meta.dir, 'heal-intake.ts');
  const jobs = Array.from({ length: 12 }, (_, i) => {
    const child = Bun.spawn([process.execPath, '-e', `import { recordFailureEvent } from ${JSON.stringify(modulePath)}; recordFailureEvent(JSON.parse(process.argv[1]), process.argv[2], async () => {});`,
      JSON.stringify({ ...base, ref: i < 6 ? base.ref : `release/run-${i}` }), dir], { stdout: 'pipe', stderr: 'pipe' });
    return child;
  });
  const results = await Promise.all(jobs.map(async child => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })));
  expect(results).toEqual(Array.from({ length: 12 }, () => ({ code: 0, stderr: '' })));
  const lines = readFileSync(join(dir, 'heal', 'inbox.jsonl'), 'utf8').trimEnd().split('\n');
  expect(lines).toHaveLength(7);
  expect(lines.map(line => JSON.parse(line) as typeof base).filter(row => row.ref === base.ref)).toHaveLength(1);
  expect(readFailureInbox({}, dir)).toHaveLength(7);
});

test('Pod intake retains the failure in the inbox but does not start a heal graph; host still starts it', async () => {
  const dir = root();
  const started: string[] = [];
  const run = async (_file: string, args: Parameters<typeof startHealLoop>[1]) => { started.push(args.runId); };
  const start = (env: NodeJS.ProcessEnv) => (file: string, args: Parameters<typeof startHealLoop>[1]) => startHealLoop(file, args, env, run);
  expect(recordFailureEvent(base, dir, start({ ELANOUS_POD_NAME: 'pod-1' }))).toEqual({ folded: false });
  await settleLoopStart();
  expect(readFailureInbox({}, dir)).toEqual([base]);
  expect(started).toHaveLength(0);
  expect(debug.events(200).filter(entry => entry.category === 'heal.intake' && entry.event === 'skipped-in-pod').at(-1))
    .toMatchObject({ data: { ref: base.ref } });
  const hostDir = root();
  const hostEvent = { ...base, ref: 'release/host-2' };
  expect(recordFailureEvent(hostEvent, hostDir, start({}))).toEqual({ folded: false });
  await settleLoopStart();
  expect(started).toHaveLength(1);
  expect(readFailureInbox({}, hostDir)).toEqual([hostEvent]);
});

test('the default heal loop starter never starts a real graph inside a test process', async () => {
  const options = { runId: 'heal-test-guard', input: { failureEvent: { source: 'cron', kind: 'k', ref: 'r', summary: 's', at: '2026-10-05T00:00:00Z' } as FailureEvent }, deps: { root: root() } };
  const missing = join(root(), 'missing-graph.yaml');
  expect(await startHealLoop(missing, options, { NODE_ENV: 'test' })).toBeUndefined();
  expect(await startHealLoop(missing, options, { ELANOUS_TEST_HOME: '/tmp/x' })).toBeUndefined();
  recordFailureEvent(options.input.failureEvent, options.deps.root, async () => {});
  await expect(startHealLoop(missing, options, {})).rejects.toBeDefined();
});
