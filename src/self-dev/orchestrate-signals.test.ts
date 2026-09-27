import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { dispatchHarnessOnPod } from '../harness/harness-pod-dispatch.js';
import { mkdtempSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orchestrateSelfDev } from './orchestrate.js';
import type { SelfImplementJobSpawn } from '../task-orchestrator/surfaces/self-implement.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'orchestrate-signal-')); dirs.push(dir); return dir; };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

test('SIGTERM during first job cancels queued siblings and deletes only labelled jobs', async () => {
  const runsDir = temp();
  const signals = new EventEmitter();
  const launched: string[] = [];
  const deleted: string[] = [];
  let complete!: (value: { exitCode: number; output: string }) => void;
  const spawn: SelfImplementJobSpawn = (input) => {
    launched.push(input.feature);
    return { address: 'fake', done: new Promise((resolve) => { complete = resolve; }) };
  };
  const run = orchestrateSelfDev({
    goals: ['one', 'two', 'three'].map((feature) => ({ feature })), concurrency: 1, spawn,
    runId: 'signal-test', runsDir, signalSource: signals as never,
    podTargets: [{ context: 'test-cluster', namespace: 'elanous-test' }],
    spawnKubectl: ((command: string, args: string[]) => {
      deleted.push([command, ...args].join(' '));
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => { child.stdout.write('job.batch/one deleted\n'); child.emit('close', 0); });
      return child;
    }) as never,
    readScreenTail: () => null, readScreenTranscript: () => null,
  });
  await flush();
  expect(launched).toHaveLength(1);
  const pidPath = join(runsDir, 'signal-test', 'pid.json');
  expect(JSON.parse(readFileSync(pidPath, 'utf8')).pid).toBe(process.pid);
  expect(statSync(pidPath).mode & 0o777).toBe(0o600);
  signals.emit('SIGTERM');
  const results = await run;
  complete({ exitCode: 0, output: '' });
  await flush();
  expect(launched).toHaveLength(1);
  expect(deleted).toEqual(['kubectl --context test-cluster -n elanous-test delete job -l elanous.run=signal-test --wait=false']);
  expect(results.map((result) => [result.status, result.stopReason])).toEqual([
    ['cancelled', 'signal'], ['cancelled', 'signal'], ['cancelled', 'signal'],
  ]);
  expect(existsSync(pidPath)).toBe(false);
  expect(signals.listenerCount('SIGTERM')).toBe(0);
});

test('SIGINT cancels without adding Pod cleanup for local runs', async () => {
  const signals = new EventEmitter();
  const runsDir = temp();
  let finishSpawn: ((value: { exitCode: number; output: string }) => void) | undefined;
  const spawn: SelfImplementJobSpawn = () => ({ address: 'fake', done: new Promise((resolve) => { finishSpawn = resolve; }) });
  const run = orchestrateSelfDev({ goals: [{ feature: 'one' }], runId: 'local-signal', runsDir,
    spawn, signalSource: signals as never,
    spawnKubectl: (() => { throw new Error('local run must not delete Pod jobs'); }) as never,
    readScreenTail: () => null, readScreenTranscript: () => null });
  await flush();
  signals.emit('SIGINT');
  expect((await run)[0]?.stopReason).toBe('signal');
  if (finishSpawn) finishSpawn({ exitCode: 0, output: '' });
  await flush();
});

test('second signal exits promptly even while Pod deletion is pending', async () => {
  const runsDir = temp();
  const signals = new EventEmitter();
  const second: NodeJS.Signals[] = [];
  let finishDelete!: (count: number) => void;
  const deletePending = new Promise<number>((resolve) => { finishDelete = resolve; });
  let finishSpawn: ((value: { exitCode: number; output: string }) => void) | undefined;
  const spawn: SelfImplementJobSpawn = () => ({ address: 'fake', done: new Promise((resolve) => { finishSpawn = resolve; }) });
  const run = orchestrateSelfDev({ goals: [{ feature: 'one' }, { feature: 'two' }], concurrency: 1,
    runId: 'twice-test', runsDir, signalSource: signals as never, spawn,
    onSecondSignal: (signal) => { second.push(signal); }, deleteJobs: () => deletePending,
    readScreenTail: () => null, readScreenTranscript: () => null });
  const pidPath = join(runsDir, 'twice-test', 'pid.json');
  await flush();
  signals.emit('SIGTERM');
  signals.emit('SIGINT');
  expect(second).toEqual(['SIGINT']);
  expect(existsSync(pidPath)).toBe(false);
  finishDelete(1);
  expect((await run).map((result) => result.status)).toEqual(['cancelled', 'cancelled']);
  if (finishSpawn) finishSpawn({ exitCode: 0, output: '' });
  await flush();
});

test('normal completion removes the private PID file and signal listeners', async () => {
  const runsDir = temp();
  const signals = new EventEmitter();
  const spawn: SelfImplementJobSpawn = () => ({
    address: 'fake', done: new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0, output: '' }), 25)),
  });
  const run = orchestrateSelfDev({ goals: [{ feature: 'one' }], spawn, runId: 'normal-test', runsDir,
    signalSource: signals as never, readScreenTail: () => null, readScreenTranscript: () => null });
  const pidPath = join(runsDir, 'normal-test', 'pid.json');
  expect(JSON.parse(readFileSync(pidPath, 'utf8'))).toEqual({
    pid: process.pid, startedAt: expect.any(Number), argv0: process.argv0,
  });
  expect(statSync(pidPath).mode & 0o777).toBe(0o600);
  await run;
  expect(existsSync(pidPath)).toBe(false);
  expect(signals.listenerCount('SIGTERM')).toBe(0);
});

test('harness Pod parent relays SIGTERM and uses the child exit code', async () => {
  const child = new EventEmitter() as EventEmitter & { exitCode: number | null; signalCode: NodeJS.Signals | null; kill: (signal: NodeJS.Signals) => boolean };
  child.exitCode = null;
  child.signalCode = null;
  const delivered: NodeJS.Signals[] = [];
  child.kill = (signal) => { delivered.push(signal); queueMicrotask(() => { child.exitCode = 37; child.emit('close', 37, null); }); return true; };
  const existing = process.listeners('SIGTERM');
  const run = dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'short goal' }, {
    spawnChild: (() => child) as never,
  });
  try {
    expect(process.listeners('SIGTERM').some((listener) => !existing.includes(listener))).toBe(true);
    for (const listener of process.listeners('SIGTERM').filter((entry) => !existing.includes(entry))) (listener as () => void)();
    expect(await run).toBe(37);
    expect(delivered).toEqual(['SIGTERM']);
    expect(process.listeners('SIGTERM').filter((listener) => !existing.includes(listener))).toHaveLength(0);
  } finally { for (const listener of process.listeners('SIGTERM')) if (!existing.includes(listener)) process.off('SIGTERM', listener as () => void); }
});


