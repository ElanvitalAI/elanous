// ELS-TEST-PTY-LEAK-FU regression: a fixture that deliberately leaks a real holder (and a server child) makes the guard fail,
// listing the PIDs; reaping then brings them down. Expected strings are literals, not built from the guard's own code.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holderMetaPath, spawnHolderDetached } from '../holder.js';
import { assertNoElsLeaks, guardElsProcesses, liveElsProcesses, reapElsProcesses, trackElsServer } from './els-process-guard.js';

guardElsProcesses();   // earlier files' leftovers (same bun test process) are the exit hook's, not this test's

const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-pg-'));
afterAll(async () => { await reapElsProcesses(); rmSync(root, { recursive: true, force: true }); });

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a leaked holder and a leaked server child fail the guard by PID; reaping brings both down', async () => {
  expect(liveElsProcesses()).toEqual([]);
  expect(() => assertNoElsLeaks()).not.toThrow();
  const paneId = 'p-leak';
  const { pid: holderPid } = spawnHolderDetached({ stateRoot: root, paneId, cwd: root, title: 'leak', command: ['/bin/cat'], env: {} });
  const server = Bun.spawn(['/bin/sleep', '60'], { stdio: ['ignore', 'ignore', 'ignore'] });
  trackElsServer(server);
  const stop = Date.now() + 20_000;
  while (!existsSync(holderMetaPath(root, paneId)) && Date.now() < stop) await Bun.sleep(50);   // holder fully up (PTY child spawned)
  expect(existsSync(holderMetaPath(root, paneId))).toBe(true);

  expect(liveElsProcesses()).toEqual([{ pid: holderPid, kind: 'holder' }, { pid: server.pid, kind: 'server' }]);
  expect(() => assertNoElsLeaks()).toThrow(`els test leak: 2 process(es) still alive — holder pid ${holderPid}, server pid ${server.pid}`);

  const reaped = await reapElsProcesses();
  expect(reaped.map((row) => row.pid)).toEqual([holderPid, server.pid]);
  await server.exited;
  expect(alive(holderPid)).toBe(false);
  expect(existsSync(holderMetaPath(root, paneId))).toBe(false);   // SIGTERM path: the holder removed its own meta (and killed its pane)
  expect(liveElsProcesses()).toEqual([]);
  expect(() => assertNoElsLeaks()).not.toThrow();
}, 60_000);
