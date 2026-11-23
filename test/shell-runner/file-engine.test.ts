import { describe, test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { createFileCaptureEngine } from '../../src/shell-runner/file-engine.js';
import { TERMINATE_TREE_GRACE_MS, TERMINATE_TREE_KILL_WAIT_MS } from '../../src/shell-primitive/terminate-tree.js';
import type { RunCtx } from '../../src/shell-runner/types.js';

// ── fake child_process.spawn ────────────────────────────────────
//
// The engine only uses: { stdout, stderr, stdin, kill, on('error'),
// once('exit') }. We emulate just that.

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  killed: boolean;
  lastSignal?: NodeJS.Signals | number;
}

function fakeSpawn(): {
  spawn: any;
  // handles returned in spawn order
  children: FakeChild[];
} {
  const children: FakeChild[] = [];
  const spawn = (_cmd: string, _args: readonly string[]) => {
    const ee = new EventEmitter() as FakeChild;
    ee.stdout = new PassThrough();
    ee.stderr = new PassThrough();
    ee.stdin = new PassThrough();
    ee.killed = false;
    ee.kill = (signal) => {
      ee.killed = true;
      ee.lastSignal = signal;
      return true;
    };
    children.push(ee);
    return ee;
  };
  return { spawn: spawn as any, children };
}

const ctx: RunCtx = { getCwd: () => '/tmp' };

async function drain(ms = 20) {
  await new Promise(r => setTimeout(r, ms));
}

// 출처: 내부 문서 `FILE-ENGINE-TIMEOUT-SETTLE-AFTER-KILL`
const workerTimeoutMs = 800;
const postWorkerProbeMs = 3000;
// 출처: src/shell-primitive/terminate-tree.ts and the worker probe above.
const regressionBudgetMs = workerTimeoutMs + TERMINATE_TREE_GRACE_MS
  + TERMINATE_TREE_KILL_WAIT_MS + 2 * postWorkerProbeMs;

test.skipIf(process.platform === 'win32')(
  'FILE-ENGINE-TIMEOUT-SETTLE-AFTER-KILL: the caller can exit as soon as timeout resolves',
  async () => {
    const engineUrl = new URL('../../src/shell-runner/file-engine.ts', import.meta.url).href;
    const command = [
      '/bin/sh', '-c',
      `(trap '' TERM; exec sleep 30) & descendant=$!; printf '%s %s\n' "$$" "$descendant"; wait`,
    ];
    const worker = spawn(process.execPath, ['-e', `
      import { createFileCaptureEngine } from ${JSON.stringify(engineUrl)};
      const handle = createFileCaptureEngine().run({
        command: ${JSON.stringify(command)},
        timeoutMs: ${workerTimeoutMs},
      }, { getCwd: () => process.cwd() });
      handle.onChunk(({ bytes }) => process.stdout.write(bytes));
      const result = await handle.result;
      const pids = result.stdout.text.trim().split(' ').map(Number);
      let alive = false;
      try { process.kill(pids[1], 0); alive = true; }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      console.log(JSON.stringify({ alive, outcome: result.outcome, timedOut: result.timedOut,
        interrupted: result.interrupted, failureReason: result.failureReason }));
      process.exit(0);
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    worker.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    const watchdog = setTimeout(() => worker.kill('SIGKILL'), regressionBudgetMs);
    try {
      const [code] = await once(worker, 'close');
      expect(code).toBe(0);
      const [pidLine, resultLine] = output.trim().split('\n');
      const descendant = Number(pidLine?.split(' ')[1]);
      expect(descendant).toBeGreaterThan(1);
      await drain(postWorkerProbeMs);
      let probe = 'alive';
      try { process.kill(descendant, 0); }
      catch (error) { probe = (error as NodeJS.ErrnoException).code ?? String(error); }
      expect(probe).toBe('ESRCH');
      expect(JSON.parse(resultLine!)).toEqual({
        alive: false, outcome: 'timeout', timedOut: true, interrupted: true,
      });
    } finally {
      clearTimeout(watchdog);
      const group = Number(output.split(' ')[0]);
      if (Number.isSafeInteger(group) && group > 1) {
        try { process.kill(-group, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
  },
  regressionBudgetMs,
);

describe('FileCaptureEngine', () => {
  test('captures stdout on normal exit 0', async () => {
    const { spawn, children } = fakeSpawn();
    const engine = createFileCaptureEngine({ spawnFn: spawn });
    const h = engine.run({ command: 'echo hi', timeoutMs: 5000 }, ctx);
    const child = children[0]!;
    child.stdout.write('hello\n');
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0, null);
    const r = await h.result;
    expect(r.exitCode).toBe(0);
    expect(r.outcome).toBe('exit');
    expect(r.stdout.text).toContain('hello');
    expect(r.stderr.text).toBe('');
    expect(r.interrupted).toBe(false);
  });

  test('stderr is captured separately from stdout', async () => {
    const { spawn, children } = fakeSpawn();
    const engine = createFileCaptureEngine({ spawnFn: spawn });
    const h = engine.run({ command: 'x', timeoutMs: 5000 }, ctx);
    const child = children[0]!;
    child.stdout.write('OUT\n');
    child.stderr.write('ERR\n');
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0, null);
    const r = await h.result;
    expect(r.stdout.text).toContain('OUT');
    expect(r.stderr.text).toContain('ERR');
    expect(r.aggregated.text).toContain('OUT');
    expect(r.aggregated.text).toContain('ERR');
  });

  test('non-zero exit preserves code', async () => {
    const { spawn, children } = fakeSpawn();
    const engine = createFileCaptureEngine({ spawnFn: spawn });
    const h = engine.run({ command: 'false', timeoutMs: 5000 }, ctx);
    const child = children[0]!;
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 1, null);
    const r = await h.result;
    expect(r.exitCode).toBe(1);
  });

  test('signal-terminated child reports 128+signo', async () => {
    const { spawn, children } = fakeSpawn();
    const engine = createFileCaptureEngine({ spawnFn: spawn });
    const h = engine.run({ command: 'x', timeoutMs: 5000 }, ctx);
    const child = children[0]!;
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', null, 'SIGTERM');
    const r = await h.result;
    expect(r.exitCode).toBe(143);
  });

  test('kill() sends SIGTERM and marks interrupted', async () => {
    const { spawn, children } = fakeSpawn();
    const engine = createFileCaptureEngine({ spawnFn: spawn });
    const h = engine.run({ command: 'x', timeoutMs: 60_000 }, ctx);
    const child = children[0]!;
    h.kill();
    expect(child.lastSignal).toBe('SIGTERM');
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', null, 'SIGTERM');
    const r = await h.result;
    expect(r.interrupted).toBe(true);
    expect(r.outcome).toBe('aborted');
  });

  test('kill(SIGKILL) forwards the exact signal', async () => {
    const { spawn, children } = fakeSpawn();
    const engine = createFileCaptureEngine({ spawnFn: spawn });
    const h = engine.run({ command: 'x', timeoutMs: 60_000 }, ctx);
    const child = children[0]!;
    h.kill('SIGKILL');
    expect(child.lastSignal).toBe('SIGKILL');
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', null, 'SIGKILL');
    await h.result;
  });

  test('timeout → timedOut + SIGTERM sent', async () => {
    const { spawn, children } = fakeSpawn();
    const engine = createFileCaptureEngine({ spawnFn: spawn });
    const controller = new AbortController();
    const settled: unknown[] = [];
    const h = engine.run({ command: 'sleep 100', timeoutMs: 40, signal: controller.signal }, {
      ...ctx, onSettled: (value) => settled.push(value),
    });
    const child = children[0]!;
    await drain(80);
    expect(child.lastSignal).toBe('SIGTERM');
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', null, 'SIGTERM');
    controller.abort();
    h.kill('SIGKILL');
    await Promise.resolve();
    expect(settled).toEqual([]);
    const r = await h.result;
    expect(settled).toEqual([r]);
    expect(r.failureReason).toContain('Process tree termination unconfirmed');
    expect(r.exitCode).toBe(143);
    expect(r.timedOut).toBe(true);
    expect(r.outcome).toBe('timeout');
  });

  test('spawn-error path sets outcome=spawn-error', async () => {
    const { spawn, children } = fakeSpawn();
    const engine = createFileCaptureEngine({ spawnFn: spawn });
    const h = engine.run({ command: 'missing', timeoutMs: 5000 }, ctx);
    const child = children[0]!;
    child.emit('error', new Error('ENOENT'));
    const r = await h.result;
    expect(r.outcome).toBe('spawn-error');
  });

  test('onChunk distinguishes stdout vs stderr in real time', async () => {
    const { spawn, children } = fakeSpawn();
    const engine = createFileCaptureEngine({ spawnFn: spawn });
    const h = engine.run({ command: 'x', timeoutMs: 5000 }, ctx);
    const child = children[0]!;
    const seen: Array<[string, string]> = [];
    h.onChunk(c => seen.push([c.stream, c.bytes]));
    child.stdout.write('a');
    child.stderr.write('b');
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0, null);
    await h.result;
    expect(seen).toContainEqual(['stdout', 'a']);
    expect(seen).toContainEqual(['stderr', 'b']);
  });

  test('stdin is piped to the child and closed', async () => {
    const { spawn, children } = fakeSpawn();
    const engine = createFileCaptureEngine({ spawnFn: spawn });
    const h = engine.run({ command: 'cat', timeoutMs: 5000, stdin: 'hello\n' }, ctx);
    const child = children[0]!;
    const seen: string[] = [];
    child.stdin.on('data', (b: Buffer) => seen.push(b.toString('utf8')));
    await drain(5);
    expect(seen.join('')).toBe('hello\n');
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0, null);
    await h.result;
  });

  test('disk spill triggers when output > maxMemoryBytes', async () => {
    const { spawn, children } = fakeSpawn();
    const engine = createFileCaptureEngine({
      spawnFn: spawn,
      maxMemoryBytes: 100, // trivially small
    });
    const h = engine.run({ command: 'x', timeoutMs: 5000 }, ctx);
    const child = children[0]!;
    for (let i = 0; i < 20; i++) child.stdout.write('x'.repeat(20) + '\n');
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0, null);
    const r = await h.result;
    expect(r.outputFilePath).toBeTruthy();
  });

  test('output >maxOutputBytes is head+tail truncated', async () => {
    const { spawn, children } = fakeSpawn();
    const engine = createFileCaptureEngine({ spawnFn: spawn });
    const h = engine.run({ command: 'x', timeoutMs: 5000, maxOutputBytes: 40 }, ctx);
    const child = children[0]!;
    child.stdout.write('A'.repeat(30));
    child.stdout.write('B'.repeat(30));
    child.stdout.write('C'.repeat(30));
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0, null);
    const r = await h.result;
    expect(r.truncated).toBe(true);
    expect(r.stdout.truncatedAfterBytes).toBe(20);
    expect(r.stdout.tail).toBeTruthy();
  });

  test('AbortSignal kills the child', async () => {
    const { spawn, children } = fakeSpawn();
    const engine = createFileCaptureEngine({ spawnFn: spawn });
    const ac = new AbortController();
    const h = engine.run({ command: 'x', timeoutMs: 60_000, signal: ac.signal }, ctx);
    const child = children[0]!;
    ac.abort();
    expect(child.lastSignal).toBe('SIGTERM');
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', null, 'SIGTERM');
    const r = await h.result;
    expect(r.interrupted).toBe(true);
    expect(r.outcome).toBe('aborted');
  });

  test('background() flips status only', () => {
    const { spawn, children } = fakeSpawn();
    const engine = createFileCaptureEngine({ spawnFn: spawn });
    const h = engine.run({ command: 'x', timeoutMs: 60_000 }, ctx);
    const child = children[0]!;
    expect(h.background()).toBe(true);
    expect(h.status).toBe('backgrounded');
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0, null);
  });

  test('array command skips the shell and uses argv directly', async () => {
    const observed: Array<{ cmd: string; args: readonly string[] }> = [];
    const { children } = fakeSpawn();
    const spawnFn: any = (cmd: string, args: readonly string[]) => {
      observed.push({ cmd, args });
      const ee = new EventEmitter() as any;
      ee.stdout = new PassThrough();
      ee.stderr = new PassThrough();
      ee.stdin = new PassThrough();
      ee.kill = () => true;
      children.push(ee);
      return ee;
    };
    const engine = createFileCaptureEngine({ spawnFn });
    const h = engine.run({ command: ['node', '-v'], timeoutMs: 1000 }, ctx);
    expect(observed[0]?.cmd).toBe('node');
    expect(observed[0]?.args).toEqual(['-v']);
    const child = children.at(-1)!;
    child.stdout.write('v22\n');
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0, null);
    await h.result;
  });
});
