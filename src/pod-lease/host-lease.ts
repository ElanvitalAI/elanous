// L7b — cross-process Pod admission on one host. Each admitted launch holds a lease file (pid ⊕ process start time)
// in a per-user directory; a launch is admitted only while live leases stay under the pool's measured total.
// Without this, independent CLI processes each measured an empty pool and all launched (review round 2 of #23212).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';

export interface HostLeaseRecord { pid: number; startedAt: string; at: string }

export interface HostPoolLeaseOptions {
  /** Base directory — default `$TMPDIR/elanous-pod-leases-<uid>` (0700). */
  dir?: string;
  pid?: number;
  /** `ps -o lstart=` text for a pid, or null when the process is gone. */
  processStart?: (pid: number) => string | null;
  now?: () => number;
  /** A lock older than this is a crash leftover and is cleared. */
  staleLockMs?: number;
}

export function hostLeaseBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ELANOUS_POD_LEASE_DIR?.trim()) return env.ELANOUS_POD_LEASE_DIR.trim();
  // Test runs get a per-process directory so parallel test files never share real host leases.
  if (env.NODE_ENV === 'test') return join(tmpdir(), `elanous-pod-leases-test-${process.pid}`);
  let uid: string;
  try { uid = String(userInfo().uid); } catch { uid = 'unknown'; }
  return join(tmpdir(), `elanous-pod-leases-${uid}`);
}

/** Process start time as `ps` prints it (C locale so the text is stable). Null = no such process. */
export function psProcessStart(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  const text = result.status === 0 ? result.stdout.trim() : '';
  return text || null;
}

export class HostPoolLease {
  readonly dir: string;
  private readonly pid: number;
  private readonly processStart: (pid: number) => string | null;
  private readonly now: () => number;
  private readonly staleLockMs: number;
  private ownStart: string | null | undefined;

  constructor(poolKey: string, options: HostPoolLeaseOptions = {}) {
    this.dir = join(options.dir ?? hostLeaseBaseDir(), poolKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'pool');
    this.pid = options.pid ?? process.pid;
    this.processStart = options.processStart ?? psProcessStart;
    this.now = options.now ?? Date.now;
    this.staleLockMs = options.staleLockMs ?? 10_000;
  }

  /** Live leases after removing stale ones (dead pid or a recycled pid whose start time differs). */
  live(): HostLeaseRecord[] {
    const out: HostLeaseRecord[] = [];
    let names: string[] = [];
    try { names = readdirSync(this.dir).filter((name) => name.endsWith('.json')); } catch { return out; }
    for (const name of names) {
      const file = join(this.dir, name);
      let record: HostLeaseRecord | null = null;
      try { record = JSON.parse(readFileSync(file, 'utf8')) as HostLeaseRecord; } catch { record = null; }
      const alive = record && this.processStart(record.pid) === record.startedAt;
      if (record && alive) { out.push(record); continue; }
      try { unlinkSync(file); } catch { /* another process cleaned it */ }
      debug.log('pod.lease', 'host-lease-stale-cleared', { file: name, pid: record?.pid ?? null });
    }
    return out;
  }

  /** Unapplied leases held by other processes — launches admitted elsewhere whose Job the cluster can't see yet. */
  othersPending(): number {
    if (this.ownStart === undefined) this.ownStart = this.processStart(this.pid);
    return this.live().filter((r) => !(r.pid === this.pid && r.startedAt === this.ownStart)).length;
  }

  /**
   * Under the host lock, take a lease only if `allowed(othersPending)` holds — the check and the write are one step,
   * so independent processes measuring the same empty pool cannot all pass. Null = refused or lock busy (retry later).
   */
  tryReserve(allowed: (othersPending: number) => boolean): (() => void) | null {
    try { mkdirSync(this.dir, { recursive: true, mode: 0o700 }); } catch { return null; }
    if (!this.lock()) return null;
    try {
      if (this.ownStart === undefined) this.ownStart = this.processStart(this.pid);
      if (!this.ownStart) return null;
      const others = this.live().filter((r) => !(r.pid === this.pid && r.startedAt === this.ownStart)).length;
      if (!allowed(others)) {
        debug.log('pod.lease', 'host-lease-refused', { othersPending: others });
        return null;
      }
      const file = join(this.dir, `${this.pid}-${this.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
      const record: HostLeaseRecord = { pid: this.pid, startedAt: this.ownStart, at: new Date(this.now()).toISOString() };
      writeFileSync(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      debug.log('pod.lease', 'host-lease-acquired', { othersPending: others });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { unlinkSync(file); } catch { /* already cleaned */ }
      };
    } finally {
      this.unlock();
    }
  }

  private lockDir(): string { return join(this.dir, '.lock'); }

  private lock(): boolean {
    const dir = this.lockDir();
    try { mkdirSync(dir); return true; } catch { /* held */ }
    try {
      if (this.now() - statSync(dir).mtimeMs > this.staleLockMs) {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir);
        return true;
      }
    } catch { /* raced */ }
    return false;
  }

  private unlock(): void {
    try { rmSync(this.lockDir(), { recursive: true, force: true }); } catch { /* gone */ }
  }
}
