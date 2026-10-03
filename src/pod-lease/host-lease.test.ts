import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HostPoolLease } from './host-lease.js';

test('other processes\' live leases count; dead or recycled pids are cleaned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-lease-'));
  try {
    const starts: Record<number, string> = { 10: 'A', 11: 'B', 12: 'C' };
    const lease = (pid: number) => new HostPoolLease('pool', { dir, pid, processStart: (p) => starts[p] ?? null });
    const r10 = lease(10).tryReserve(() => true)!;
    const r11 = lease(11).tryReserve(() => true)!;
    expect(lease(12).othersPending()).toBe(2);
    expect(lease(10).othersPending()).toBe(1);
    starts[11] = 'B-recycled';
    expect(lease(12).othersPending()).toBe(1);
    delete starts[10];
    expect(lease(12).othersPending()).toBe(0);
    expect(readdirSync(join(dir, 'pool')).filter((n) => n.endsWith('.json'))).toHaveLength(0);
    r10(); r11();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reserve is refused when the check fails and released leases free the slot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-lease-'));
  try {
    const a = new HostPoolLease('p', { dir, pid: 1, processStart: () => 'S' });
    const b = new HostPoolLease('p', { dir, pid: 2, processStart: () => 'S' });
    const first = a.tryReserve((others) => others < 1)!;
    expect(first).toBeFunction();
    expect(b.tryReserve((others) => others < 1)).toBeNull();
    first();
    expect(b.tryReserve((others) => others < 1)).toBeFunction();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stale lock left by a crash is cleared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-lease-'));
  try {
    const now = { t: 1_000_000 };
    const lease = new HostPoolLease('p', { dir, pid: 1, processStart: () => 'S', now: () => now.t, staleLockMs: 10 });
    const first = lease.tryReserve(() => true);
    expect(first).toBeFunction();
    // A crashed holder leaves .lock behind; a later call clears it once it is older than staleLockMs.
    writeFileSync(join(dir, 'p', 'marker'), '');
    rmSync(join(dir, 'p', '.lock'), { recursive: true, force: true });
    require('node:fs').mkdirSync(join(dir, 'p', '.lock'));
    now.t = Date.now() + 60_000;
    expect(lease.tryReserve(() => true)).toBeFunction();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('three independent processes on a pool of N=2 → exactly two admitted, the third waits until one releases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-lease-procs-'));
  const child = join(dir, 'child.ts');
  const poolModule = resolve(import.meta.dir, '../task-orchestrator/surfaces/pod-pool.ts');
  // Each process measures the same stale «2 free, 0 running» — without the host lease all three would launch.
  writeFileSync(child, `
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parsePodPool, PodPoolScheduler } from ${JSON.stringify(poolModule)};
const [dir, name] = process.argv.slice(2);
const pool = new PodPoolScheduler(parsePodPool('fake:3'), { pollMs: 50, status: () => ({ recommended: 2, accountSlots: 0,
  limitedBy: 'capacity', reason: null, capacitySlots: 3, memorySlots: 3, placeableSlots: 3, running: 0, pending: 0 }) });
const release = await pool.acquireAdmission();
writeFileSync(join(dir, 'admitted-' + name), String(Date.now()));
while (!existsSync(join(dir, 'release-' + name))) await Bun.sleep(25);
release();
`);
  const { NODE_ENV: _testEnv, ...parentEnv } = process.env;
  const env = { ...parentEnv, ELANOUS_POD_LEASE_DIR: join(dir, 'leases') };
  const children = ['a', 'b', 'c'].map((name) => Bun.spawn(['bun', child, dir, name], { env, stdout: 'ignore', stderr: 'pipe' }));
  const admitted = () => ['a', 'b', 'c'].filter((name) => existsSync(join(dir, `admitted-${name}`)));
  try {
    for (let i = 0; i < 200 && admitted().length < 2; i++) await Bun.sleep(25);
    expect(admitted()).toHaveLength(2);
    await Bun.sleep(800);
    expect(admitted()).toHaveLength(2);
    const [first] = admitted();
    writeFileSync(join(dir, `release-${first}`), '');
    for (let i = 0; i < 200 && admitted().length < 3; i++) await Bun.sleep(25);
    expect(admitted()).toHaveLength(3);
    for (const name of ['a', 'b', 'c']) writeFileSync(join(dir, `release-${name}`), '');
    expect(await Promise.all(children.map((c) => c.exited))).toEqual([0, 0, 0]);
  } finally {
    for (const c of children) c.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
