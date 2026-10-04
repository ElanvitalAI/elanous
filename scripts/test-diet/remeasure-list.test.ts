import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { execute, FILE_TIMEOUT_MS, measureList, type Execution, type Executor } from './remeasure-list.js';

test('counts pass, fail, timeout and skip independently without running real tests', async () => {
  const fixtures: Execution[] = [
    { rc: 0, stdout: '', stderr: ' 2 pass\nRan 2 tests', secs: 1, timedOut: false },
    { rc: 1, stdout: '', stderr: ' 1 pass\n 1 fail\nRan 2 tests', secs: 2, timedOut: false },
    { rc: null, stdout: '', stderr: ' 1 fail\n', secs: 300, timedOut: true },
    { rc: 0, stdout: '', stderr: ' 1 pass\n 1 skip\nRan 2 tests', secs: 3, timedOut: false },
  ];
  const invoked: string[] = [];
  const runner: Executor = async (file, timeoutMs) => {
    expect(timeoutMs).toBe(FILE_TIMEOUT_MS);
    invoked.push(file);
    return fixtures[invoked.length - 1]!;
  };
  const rows = await measureList(['pass.test.ts', 'fail.test.ts', 'timeout.test.ts', 'skip.test.ts'], runner);
  expect(invoked).toEqual(['pass.test.ts', 'fail.test.ts', 'timeout.test.ts', 'skip.test.ts']);
  expect(rows.map(({ verdict }) => verdict)).toEqual(['pass', 'fail', '못 잼', 'skip']);
  expect(rows.map(({ rc, pass, fail, skip, secs }) => ({ rc, pass, fail, skip, secs }))).toEqual([
    { rc: 0, pass: 2, fail: null, skip: null, secs: 1 },
    { rc: 1, pass: 1, fail: 1, skip: null, secs: 2 },
    { rc: null, pass: null, fail: null, skip: null, secs: 300 },
    { rc: 0, pass: 1, fail: null, skip: 1, secs: 3 },
  ]);
  expect(rows.every(({ platform, release }) => platform === process.platform && release.length > 0)).toBe(true);
});

test('absence of a test summary or nonzero exit without a failing test is unmeasured', async () => {
  const rows = await measureList(['missing.test.ts'], async () => ({ rc: 1, stdout: '', stderr: 'module not found', secs: 1, timedOut: false }));
  expect(rows[0]).toMatchObject({ verdict: '못 잼', pass: null, fail: null, skip: null });
});

test('timeout waits for KILL and close before spawning the next file', async () => {
  const events: string[] = [];
  const children: Array<EventEmitter & { pid: number }> = [];
  const spawnChild = ((_command: string, args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; kill: (sig: string) => boolean };
    child.pid = children.length + 1000;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (sig) => { events.push(`direct:${sig}`); return true; };
    events.push(`spawn:${args[2]}`);
    children.push(child);
    return child;
  }) as typeof spawn;
  const rows = await measureList(['hung.test.ts', 'next.test.ts'], (file) => execute(file, 10, {
    spawnChild,
    signalGroup: (pid, sig) => {
      events.push(`${pid}:${sig}`);
      if (sig === 'SIGKILL') queueMicrotask(() => {
        events.push(`close:${pid}`);
        children[pid - 1000]!.emit('close', null);
      });
    },
    graceMs: 20,
  }));
  expect(rows.map(({ verdict, rc, fail }) => ({ verdict, rc, fail }))).toEqual([
    { verdict: '못 잼', rc: null, fail: null },
    { verdict: '못 잼', rc: null, fail: null },
  ]);
  expect(events.indexOf('1000:SIGTERM')).toBeLessThan(events.indexOf('1000:SIGKILL'));
  expect(events.indexOf('1000:SIGKILL')).toBeLessThan(events.indexOf('spawn:next.test.ts'));
  expect(events.indexOf('close:1000')).toBeLessThan(events.indexOf('spawn:next.test.ts'));
  expect(events.indexOf('1001:SIGTERM')).toBeLessThan(events.indexOf('1001:SIGKILL'));
  expect(children).toHaveLength(2);
});

test('unconfirmed termination stops subsequent measurements rather than waiting forever', async () => {
  const events: string[] = [];
  const spawnChild = ((_command: string, args: readonly string[]) => {
    events.push(`spawn:${args[2]}`);
    const child = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
    child.pid = 1000;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    return child;
  }) as typeof spawn;
  await expect(measureList(['hung.test.ts', 'next.test.ts'], (file) => execute(file, 10, {
    spawnChild,
    signalGroup: (_pid, sig) => { events.push(sig); },
    graceMs: 20,
  }))).rejects.toThrow('Cannot confirm termination');
  expect(events).toEqual(['spawn:hung.test.ts', 'SIGTERM', 'SIGKILL']);
});
