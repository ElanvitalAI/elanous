import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWarmWorkerFile, warmPodNamespaceResidue } from './pod-warm-worker-runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function procFixture(...pids: number[]): string {
  const root = mkdtempSync(join(tmpdir(), 'warm-pid-ns-'));
  roots.push(root);
  for (const pid of pids) mkdirSync(join(root, String(pid)));
  return root;
}

test('a dedicated namespace containing only init and this bridge is clean', () => {
  expect(warmPodNamespaceResidue(procFixture(1, 42), 42)).toEqual([]);
});

test('a direct test process prevents reuse after file exit', () => {
  expect(warmPodNamespaceResidue(procFixture(1, 42, 73), 42)).toEqual([73]);
});

test('a detached grandchild remains visible after its parent disappears', () => {
  const proc = procFixture(1, 42, 74);
  expect(warmPodNamespaceResidue(proc, 42)).toEqual([74]);
});

test('a child that cleared inherited environment still prevents reuse', () => {
  const proc = procFixture(1, 42, 91);
  writeFileSync(join(proc, '91/environ'), '');
  expect(warmPodNamespaceResidue(proc, 42)).toEqual([91]);
});

test('nonprocess files and numeric symlinks do not invent residue', () => {
  const proc = procFixture(1, 42);
  writeFileSync(join(proc, '100'), 'not a process directory');
  mkdirSync(join(proc, 'abc'));
  symlinkSync(join(proc, '1'), join(proc, '101'));
  expect(warmPodNamespaceResidue(proc, 42)).toEqual([]);
});

test('unreadable PID inventory cannot be interpreted as a clean worker', () => {
  expect(() => warmPodNamespaceResidue('/nonexistent-warm-pod-proc', 42)).toThrow();
});

test('host execution is refused before spawning a file or writing artifacts', async () => {
  const root = procFixture();
  const logPath = join(root, 'run.log');
  await expect(runWarmWorkerFile({ file: 'src/example/worker.test.ts', cutSha: 'a'.repeat(40),
    attemptId: 'host-refused', cwd: root, env: { ...process.env, WARM_WORKER_ID: 'fake-worker', WARM_BRIDGE_UID: '0' },
    logPath, junitPath: join(root, 'run.junit.xml'), deadlineAt: Date.now() + 60_000 }))
    .rejects.toThrow(/unsupported|unmeasured/);
  expect(existsSync(logPath)).toBe(false);
});
