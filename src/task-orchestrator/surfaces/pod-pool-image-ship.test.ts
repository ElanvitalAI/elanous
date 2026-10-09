// Flood 10-08: one image ship per host · re-check after the lock · same image ID never shipped twice ·
// the ship pipeline dies as a whole process group (timeout and parent death).
import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageShipLockPath, runProcessGroupPipeline, syncPoolImage, type PodPoolMember, type RemoteRun } from './pod-pool.js';

const member: PodPoolMember = { context: 'k3d-x', sshHost: 'hostx', k3dCluster: 'x', capacity: 4 } as PodPoolMember;
const ID = `sha256:${'a'.repeat(64)}`;

/** A fake remote whose label/id come from files, so another process can change them. */
function fakeRemote(dir: string): RemoteRun {
  return (_host, script) => {
    if (script.includes('elanous.commit')) {
      const f = join(dir, 'label');
      return { status: 0, stdout: existsSync(f) ? readFileSync(f, 'utf8') : '<no value>', stderr: '' };
    }
    if (script.includes('{{.Id}}')) {
      const f = join(dir, 'id');
      return existsSync(f) ? { status: 0, stdout: readFileSync(f, 'utf8'), stderr: '' } : { status: 1, stdout: '', stderr: 'no such image' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await Bun.sleep(50); }
  return cond();
}
const deadPid = () => { const p = spawnSync('true'); return p.pid; };

describe('syncPoolImage · same image ID', () => {
  test('label missing on both sides but the same image ID remote → fresh, no ship', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ship-id-'));
    writeFileSync(join(dir, 'id'), ID);
    let ships = 0;
    const r = syncPoolImage(member, 'img', null, { run: fakeRemote(dir), inspect: () => ({ status: 0, stdout: '<no value>' }), inspectId: () => ({ status: 0, stdout: ID }), transfer: () => { ships++; return { status: 0, stderr: '' }; }, lock: { dir } });
    expect(r).toMatchObject({ ok: true, action: 'fresh' });
    expect(r.detail).toContain('same image id');
    expect(ships).toBe(0);
  });

  test('different image ID → ships once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ship-id2-'));
    writeFileSync(join(dir, 'id'), `sha256:${'b'.repeat(64)}`);
    let ships = 0;
    const r = syncPoolImage(member, 'img', null, { run: fakeRemote(dir), inspect: () => ({ status: 0, stdout: '<no value>' }), inspectId: () => ({ status: 0, stdout: ID }), transfer: () => { ships++; writeFileSync(join(dir, 'label'), 'c1'); return { status: 0, stderr: '' }; }, lock: { dir } });
    expect(r).toMatchObject({ ok: true, action: 'shipped' });
    expect(ships).toBe(1);
  });
});

describe('syncPoolImage · one ship per host', () => {
  test('a waiter re-checks after the lock and skips when another process shipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ship-lock-'));
    const lockPath = imageShipLockPath('hostx', dir);
    const lockMod = join(import.meta.dir, '..', '..', 'storage', 'file-lock.ts');
    // Another process holds the lock, «ships» (writes the label) and releases.
    const holder = spawn('bun', ['-e', `
      const { acquireLockSync } = await import(${JSON.stringify(lockMod)});
      const release = acquireLockSync(${JSON.stringify(lockPath)});
      await Bun.sleep(600);
      await Bun.write(${JSON.stringify(join(dir, 'label'))}, 'target');
      release();
    `], { stdio: 'ignore' });
    expect(await waitFor(() => existsSync(lockPath), 10_000)).toBe(true);
    let ships = 0;
    const r = syncPoolImage(member, 'img', 'target', { run: fakeRemote(dir), inspect: () => ({ status: 0, stdout: 'target' }), transfer: () => { ships++; return { status: 0, stderr: '' }; }, lock: { dir, retryMs: 50 } });
    await new Promise((d) => holder.on('close', d));
    expect(r).toMatchObject({ ok: true, action: 'fresh' });
    expect(r.detail).toContain('another process');
    expect(ships).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  }, 20_000);

  test('a lock whose holder pid is dead is broken at once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ship-dead-'));
    writeFileSync(imageShipLockPath('hostx', dir), `${deadPid()}\n`);
    let ships = 0;
    const t0 = Date.now();
    const r = syncPoolImage(member, 'img', 'target', { run: fakeRemote(dir), inspect: () => ({ status: 0, stdout: 'target' }), transfer: () => { ships++; writeFileSync(join(dir, 'label'), 'target'); return { status: 0, stderr: '' }; }, lock: { dir, retryMs: 50, maxTries: 5 } });
    expect(r).toMatchObject({ ok: true, action: 'shipped' });
    expect(ships).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test('a lock older than the stale window is broken even when its pid looks alive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ship-stale-'));
    const lockPath = imageShipLockPath('hostx', dir);
    writeFileSync(lockPath, '1\n'); // pid 1 is alive (kill 0 → EPERM, not ESRCH)
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    let ships = 0;
    const r = syncPoolImage(member, 'img', 'target', { run: fakeRemote(dir), inspect: () => ({ status: 0, stdout: 'target' }), transfer: () => { ships++; writeFileSync(join(dir, 'label'), 'target'); return { status: 0, stderr: '' }; }, lock: { dir, retryMs: 50, staleMs: 30_000, maxTries: 5 } });
    expect(r).toMatchObject({ ok: true, action: 'shipped' });
    expect(ships).toBe(1);
  });

  test('a live, young lock that never frees → failed (no ship), not a hang', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ship-held-'));
    writeFileSync(imageShipLockPath('hostx', dir), '1\n');
    let ships = 0;
    const r = syncPoolImage(member, 'img', 'target', { run: fakeRemote(dir), inspect: () => ({ status: 0, stdout: 'target' }), transfer: () => { ships++; return { status: 0, stderr: '' }; }, lock: { dir, retryMs: 20, maxTries: 5 } });
    expect(r).toMatchObject({ ok: false, action: 'failed' });
    expect(r.detail).toContain('image ship lock');
    expect(ships).toBe(0);
  });
});

describe('runProcessGroupPipeline', () => {
  const pipeline = (dir: string) => `bash -c 'echo $$ > ${dir}/a; exec sleep 30' | bash -c 'echo $$ > ${dir}/b; exec cat'`;

  test('keeps the pipeline exit code (pipefail)', () => {
    expect(runProcessGroupPipeline('echo ok', { timeoutMs: 10_000 }).status).toBe(0);
    expect(runProcessGroupPipeline('exit 3', { timeoutMs: 10_000 }).status).toBe(3);
    expect(runProcessGroupPipeline('false | cat', { timeoutMs: 10_000 }).status).toBe(1);
  });

  test('a timeout kills every member of the pipeline, not just bash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgrp-timeout-'));
    const t0 = Date.now();
    const r = runProcessGroupPipeline(pipeline(dir), { timeoutMs: 1_000 });
    expect(r.timedOut).toBe(true);
    expect(r.status).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const pids = ['a', 'b'].map((f) => Number(readFileSync(join(dir, f), 'utf8').trim()));
    expect(pids.every((p) => p > 0)).toBe(true);
    expect(await waitFor(() => pids.every((p) => !alive(p)), 3_000)).toBe(true);
  }, 20_000);

  test('the pipeline dies when its parent process is killed -9', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgrp-parent-'));
    const mod = join(import.meta.dir, 'pod-pool.ts');
    const parent = spawn('bun', ['-e', `
      const { runProcessGroupPipeline } = await import(${JSON.stringify(mod)});
      runProcessGroupPipeline(${JSON.stringify(pipeline(dir))}, { timeoutMs: 60_000, watchIntervalSec: 1 });
    `], { stdio: 'ignore' });
    expect(await waitFor(() => existsSync(join(dir, 'a')) && existsSync(join(dir, 'b')), 10_000)).toBe(true);
    await Bun.sleep(100);
    const pids = ['a', 'b'].map((f) => Number(readFileSync(join(dir, f), 'utf8').trim()));
    expect(pids.every((p) => alive(p))).toBe(true);
    parent.kill('SIGKILL');
    expect(await waitFor(() => pids.every((p) => !alive(p)), 6_000)).toBe(true);
  }, 30_000);
});
