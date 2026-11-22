import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { copyFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcCwdReader } from './proc-cwd.js';

class FakeWorker extends EventEmitter {
  requests: Array<{ id: number; pid: number }> = [];
  terminated = false;
  unref() { return this; }
  postMessage(request: { id: number; pid: number }) { this.requests.push(request); }
  terminate() { this.terminated = true; return Promise.resolve(0); }
}

describe('demand-driven process cwd', () => {
  test('invalid pid and disposal fail closed', async () => {
    const reader = createProcCwdReader();
    expect(await reader.read(-1)).toBeUndefined();
    expect(await reader.read(2 ** 32)).toBeUndefined();
    reader.dispose();
    expect(await reader.read(process.pid)).toBeUndefined();
  });
  test('overlapping reads of one PID remain separate observations', async () => {
    const worker = new FakeWorker();
    const reader = createProcCwdReader({ platform: 'darwin', createWorker: () => worker as unknown as Worker });
    try {
      const first = reader.read(123);
      const second = reader.read(123);
      expect(worker.requests).toHaveLength(2);
      worker.emit('message', { id: worker.requests[0]!.id, cwd: '/' });
      worker.emit('message', { id: worker.requests[1]!.id, cwd: tmpdir() });
      expect(await first).toBe('/');
      expect(await second).toBe(tmpdir());
    } finally { reader.dispose(); }
  });
  test('a stuck worker releases all pending requests and a later read starts a fresh worker', async () => {
    const workers: FakeWorker[] = [];
    const reader = createProcCwdReader({ platform: 'darwin', timeoutMs: 20, createWorker: () => { // 출처: #39597 가짜 워커 타임아웃 시험 20ms
      const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker;
    } });
    try {
      const a = reader.read(123);
      const b = reader.read(456);
      // Keep the test process alive while the production deadline is unref'd.
      const keepAlive = setTimeout(() => {}, 1000);
      try { expect(await Promise.all([a, b])).toEqual([undefined, undefined]); }
      finally { clearTimeout(keepAlive); }
      expect(workers[0]!.terminated).toBe(true);
      const next = reader.read(123);
      expect(workers).toHaveLength(2);
      workers[0]!.emit('message', { id: workers[1]!.requests[0]!.id, cwd: '/' });
      workers[1]!.emit('message', { id: workers[1]!.requests[0]!.id, cwd: tmpdir() });
      expect(await next).toBe(tmpdir());
    } finally { reader.dispose(); }
  });
  test.skipIf(process.platform !== 'darwin')('bundled entry loads the separately built worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'els-cwd-bundle-'));
    try {
      await Promise.all(['proc-cwd.ts', 'proc-cwd-worker.ts'].map(file => copyFile(join(import.meta.dir, file), join(dir, file))));
      await writeFile(join(dir, 'index.ts'), `
        import { createProcCwdReader } from './proc-cwd';
        const reader = createProcCwdReader();
        const cwd = await reader.read(process.pid);
        reader.dispose();
        if (cwd !== process.cwd()) throw new Error('worker cwd mismatch: ' + cwd);
      `);
      const outdir = join(dir, 'dist');
      expect((await Bun.build({ entrypoints: [join(dir, 'index.ts')], outdir, target: 'bun' })).success).toBe(true);
      expect((await Bun.build({ entrypoints: [join(dir, 'proc-cwd-worker.ts')], outdir, target: 'bun' })).success).toBe(true);
      const child = Bun.spawn([process.execPath, join(outdir, 'index.js')], { cwd: outdir, stdout: 'pipe', stderr: 'pipe' });
      const stderr = await new Response(child.stderr).text();
      expect({ exit: await child.exited, stderr }).toEqual({ exit: 0, stderr: '' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test.skipIf(process.platform !== 'darwin')('reads a live shell cwd after cd, then refuses an exited process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'els-cwd-'));
    const shell = spawn('/bin/sh', [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const reader = createProcCwdReader();
    try {
      const ready = new Promise<void>(resolve => shell.stdout.once('data', () => resolve()));
      shell.stdin.write(`cd '${dir}' && printf ready\n`);
      await ready;
      const [a, b] = await Promise.all([reader.read(shell.pid!), reader.read(shell.pid!)]);
      expect(await realpath(a!)).toBe(await realpath(dir));
      expect(b).toBe(a);
      const exit = new Promise<void>(resolve => shell.once('exit', () => resolve()));
      shell.stdin.end('exit\n');
      await exit;
      expect(await reader.read(shell.pid!)).toBeUndefined();
    } finally {
      reader.dispose();
      shell.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
