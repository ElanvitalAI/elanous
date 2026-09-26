import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { PORT_BANDS } from '../control-plane/ports.js';
import { debug } from '../debug/log.js';
import { isPidAlive } from '../process/pid-liveness.js';

export const RESERVED = PORT_BANDS.reserved;
export const TEST_BAND = PORT_BANDS.test;

export interface TestPortLease {
  port: number;
  pid: number;
  owner: string;
  startedAt: string;
}

export interface LeaseTestPortOpts {
  owner: string;
  dir?: string;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  inUse?: (port: number) => Promise<boolean> | boolean;
}

const leaseDir = () => join(tmpdir(), 'elanous-port-leases');
const leasePath = (dir: string, port: number) => join(dir, `${port}.json`);

async function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(true);
      else reject(err);
    });
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(false)));
  });
}

function readLease(path: string): TestPortLease | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (value && typeof value === 'object' && 'pid' in value && typeof value.pid === 'number'
      && 'port' in value && typeof value.port === 'number'
      && 'owner' in value && typeof value.owner === 'string'
      && 'startedAt' in value && typeof value.startedAt === 'string') return value as TestPortLease;
  } catch { /* A partial or unreadable lease is not evidence of a dead owner. */ }
  return null;
}

export async function leaseTestPort({ owner, dir = leaseDir(), now = Date.now, isAlive = isPidAlive, inUse = portInUse }: LeaseTestPortOpts): Promise<TestPortLease | { error: 'no-port' }> {
  mkdirSync(dir, { recursive: true });
  for (let port = TEST_BAND.start; port <= TEST_BAND.end; port++) {
    if ((RESERVED as readonly number[]).includes(port)) continue;
    const path = leasePath(dir, port);
    if (await inUse(port)) continue;
    const lease: TestPortLease = { port, pid: process.pid, owner, startedAt: new Date(now()).toISOString() };
    for (let attempt = 0; attempt < 2; attempt++) {
      let fd: number;
      try {
        fd = openSync(path, 'wx', 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const old = readLease(path);
        // pid 1 이하가 적힌 임대는 주인이 없다(transfer 결함의 잔재) — 낡은 임대로 회수한다.
        if (!old || (old.pid > 1 && isAlive(old.pid))) break;
        // Re-read before removal so a changed owner is never intentionally reaped.
        const current = readLease(path);
        if (current?.startedAt !== old.startedAt || current.pid !== old.pid || current.owner !== old.owner) break;
        try { unlinkSync(path); } catch (unlinkErr) {
          if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
        }
        debug.log('nexus.port-lease', 'skipped-stale', { port, owner, reason: 'dead-pid' });
        continue;
      }
      try {
        writeFileSync(fd, JSON.stringify(lease));
      } catch (err) {
        unlinkSync(path);
        throw err;
      } finally {
        closeSync(fd);
      }
      // A competing service may bind between the first probe and the claim.
      if (await inUse(port)) {
        releaseTestPort(port, process.pid, dir);
        break;
      }
      debug.log('nexus.port-lease', 'leased', { port, owner, reason: 'available' });
      return lease;
    }
  }
  debug.log('nexus.port-lease', 'no-port', { port: null, owner, reason: 'test-band-exhausted' });
  return { error: 'no-port' };
}

/** Only the PID recorded in this lease can release it. */
export function releaseTestPort(port: number, pid: number, dir = leaseDir()): void {
  if (port < TEST_BAND.start || port > TEST_BAND.end || (RESERVED as readonly number[]).includes(port)) return;
  const path = leasePath(dir, port);
  if (readLease(path)?.pid !== pid) return;
  try { unlinkSync(path); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Retain a detached daemon's claim beyond the short-lived launcher process. */
export function transferTestPort(port: number, fromPid: number, toPid: number, dir = leaseDir()): void {
  if (port < TEST_BAND.start || port > TEST_BAND.end || (RESERVED as readonly number[]).includes(port)) return;
  const path = leasePath(dir, port);
  const lease = readLease(path);
  // pid 1 이하는 «주인»이 될 수 없다 — launchd(pid 1)는 늘 살아 있어 그 임대가 영영 안 풀린다(🩸 2026-09-27: 시험이 pid 1 을 흉내 내 실제 임대 폴더에 네 칸을 샜다).
  if (!lease || lease.pid !== fromPid || !Number.isInteger(toPid) || toPid <= 1) return;
  const next = `${path}.${fromPid}.transfer`;
  try {
    writeFileSync(next, JSON.stringify({ ...lease, pid: toPid }), { flag: 'wx', mode: 0o600 });
    if (readLease(path)?.pid === fromPid) renameSync(next, path);
  } finally {
    try { unlinkSync(next); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
