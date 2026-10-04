import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HostPoolLease, hostLeaseCounts, leaseHasPendingPod } from './host-lease.js';

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
    const second = b.tryReserve((others) => others < 1);
    expect(second).toBeFunction();
    second?.();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('authoring reservation transfers to a Job and remains until the Pod is observed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-lease-'));
  try {
    const starts: Record<number, string> = { 10: 'A', 11: 'B', 12: 'C', 13: 'D' };
    const lease = (pid: number) => new HostPoolLease('p', { dir, pid, processStart: (p) => starts[p] ?? null });
    const first = lease(10).tryReserve((n) => n < 2)!;
    const second = lease(11).tryReserve((n) => n < 2)!;
    expect(lease(12).tryReserve((n) => n < 2)).toBeNull();
    expect(lease(10).tryReserve((n) => n < 2, true)).toBeNull();
    const transferred = lease(12).claim(first.id)!;
    first();
    expect(lease(12).live()).toHaveLength(2);
    expect(hostLeaseCounts(lease(12).live())).toEqual({ reserved: 2, waitingJobs: 0 });
    transferred.applied('job-one', 'p', 'elanous-test');
    expect(hostLeaseCounts(lease(12).live())).toEqual({ reserved: 1, waitingJobs: 1 });
    expect(lease(12).live()).toContainEqual(expect.objectContaining({ job: 'job-one', stage: 'job' }));
    expect(lease(13).tryReserve((n) => n < 2)).toBeNull();
    transferred();
    const reopened = lease(13).tryReserve((n) => n < 2);
    expect(reopened).toBeFunction();
    reopened?.();
    second();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a claimed authoring reservation cannot be claimed a second time before Job application', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-lease-claim-once-'));
  try {
    const starts: Record<number, string> = { 10: 'A', 11: 'B', 12: 'C' };
    const lease = (pid: number) => new HostPoolLease('p', { dir, pid, processStart: (p) => starts[p] ?? null });
    const original = lease(10).tryReserve(() => true)!;
    const claimed = lease(11).claim(original.id)!;
    expect(claimed).toBeFunction();
    expect(lease(12).claim(original.id)).toBeNull();
    original();
    claimed.applied('job-one', 'p', 'elanous-test');
    expect(lease(11).live()).toEqual([expect.objectContaining({ pid: 11, stage: 'job', job: 'job-one' })]);
    claimed();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a Pending Pod accounts for a lease only within the same context and namespace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-lease-identity-'));
  try {
    const host = new HostPoolLease('p', { dir, pid: 10, processStart: () => 'A' });
    const release = host.tryReserve(() => true)!;
    release.applied('shared', 'cluster-b', 'elanous-test');
    const record = host.live()[0]!;
    expect(record).toMatchObject({ context: 'cluster-b', namespace: 'elanous-test', job: 'shared' });
    expect(leaseHasPendingPod(record, [{ context: 'cluster-a', namespace: 'elanous-test', job: 'shared' }])).toBe(false);
    expect(leaseHasPendingPod(record, [{ context: 'cluster-b', namespace: 'other', job: 'shared' }])).toBe(false);
    expect(leaseHasPendingPod(record, [{ context: 'cluster-b', namespace: 'elanous-test', job: 'shared' }])).toBe(true);
    release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('same-process authoring launches still count as separate reservations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-lease-'));
  try {
    const lease = new HostPoolLease('p', { dir, pid: 10, processStart: () => 'A' });
    const first = lease.tryReserve((n) => n < 2, true)!;
    const second = lease.tryReserve((n) => n < 2, true)!;
    expect(lease.tryReserve((n) => n < 2, true)).toBeNull();
    first(); second();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a claimed reservation stays live when the parent launcher dies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-lease-'));
  try {
    const starts: Record<number, string> = { 10: 'parent', 11: 'child' };
    const lease = (pid: number) => new HostPoolLease('p', { dir, pid, processStart: (p) => starts[p] ?? null });
    const original = lease(10).tryReserve(() => true)!;
    const claimed = lease(11).claim(original.id)!;
    delete starts[10];
    expect(lease(11).live()).toHaveLength(1);
    claimed.applied('pending-job', 'p', 'elanous-test');
    expect(hostLeaseCounts(lease(11).live())).toEqual({ reserved: 0, waitingJobs: 1 });
    claimed();
    expect(lease(11).live()).toHaveLength(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('transferring to a recycled or dead launcher fails without deleting a live lease', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-lease-'));
  try {
    const starts: Record<number, string> = { 10: 'A', 11: 'B' };
    const lease = (pid: number) => new HostPoolLease('p', { dir, pid, processStart: (p) => starts[p] ?? null });
    const reservation = lease(10).tryReserve(() => true)!;
    starts[10] = 'A-recycled';
    expect(lease(11).claim(reservation.id)).toBeNull();
    expect(lease(11).live()).toHaveLength(0);
    reservation();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dead authoring launcher reservation is cleared before admission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-lease-'));
  try {
    const starts: Record<number, string> = { 10: 'A', 11: 'B' };
    const lease = (pid: number) => new HostPoolLease('p', { dir, pid, processStart: (p) => starts[p] ?? null });
    lease(10).tryReserve((n) => n < 1);
    expect(lease(11).tryReserve((n) => n < 1)).toBeNull();
    delete starts[10];
    const admitted = lease(11).tryReserve((n) => n < 1);
    expect(admitted).toBeFunction();
    expect(lease(11).live()).toHaveLength(1);
    admitted?.();
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

test('two processes authoring without Jobs occupy a pool of two and a third waits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-lease-authoring-procs-'));
  const child = join(dir, 'author.ts');
  const leaseModule = resolve(import.meta.dir, 'host-lease.ts');
  writeFileSync(child, `
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HostPoolLease } from ${JSON.stringify(leaseModule)};
const [dir, name] = process.argv.slice(2);
const host = new HostPoolLease('pool');
let reserved;
while (!reserved) { reserved = host.tryReserve((n) => n < 2, true); if (!reserved) await Bun.sleep(25); }
writeFileSync(join(dir, 'authoring-' + name), reserved.id);
while (!existsSync(join(dir, 'release-' + name))) await Bun.sleep(25);
reserved();
`);
  const { NODE_ENV: _testEnv, ...parentEnv } = process.env;
  const env = { ...parentEnv, ELANOUS_POD_LEASE_DIR: join(dir, 'leases') };
  const children = ['a', 'b', 'c'].map((name) => Bun.spawn(['bun', child, dir, name], { env, stdout: 'ignore', stderr: 'pipe' }));
  const authoring = () => ['a', 'b', 'c'].filter((name) => existsSync(join(dir, `authoring-${name}`)));
  try {
    for (let i = 0; i < 200 && authoring().length < 2; i++) await Bun.sleep(25);
    expect(authoring()).toHaveLength(2);
    expect(new HostPoolLease('pool', { dir: join(dir, 'leases') }).live()).toHaveLength(2);
    await Bun.sleep(150);
    expect(authoring()).toHaveLength(2);
    writeFileSync(join(dir, `release-${authoring()[0]}`), '');
    for (let i = 0; i < 200 && authoring().length < 3; i++) await Bun.sleep(25);
    expect(authoring()).toHaveLength(3);
    for (const name of ['a', 'b', 'c']) writeFileSync(join(dir, `release-${name}`), '');
    expect(await Promise.all(children.map((c) => c.exited))).toEqual([0, 0, 0]);
  } finally {
    for (const childProcess of children) childProcess.kill();
    rmSync(dir, { recursive: true, force: true });
  }
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
