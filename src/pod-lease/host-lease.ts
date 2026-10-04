// L7b — cross-process Pod admission on one host. Each admitted launch holds a lease file (pid ⊕ process start time)
// in a per-user directory; a launch is admitted only while live leases stay under the pool's measured total.
// Without this, independent CLI processes each measured an empty pool and all launched (review round 2 of #23212).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';

export interface HostLeaseRecord { pid: number; startedAt: string; at: string; stage?: 'authoring' | 'job'; claimed?: boolean; job?: string; context?: string; namespace?: string }

export interface PendingJobIdentity { context: string; namespace: string; job: string }

/** Only the same cluster, namespace and Job can account for an existing host lease. */
export function leaseHasPendingPod(lease: HostLeaseRecord, pending: readonly PendingJobIdentity[]): boolean {
  return lease.stage === 'job' && !!lease.context && !!lease.namespace && !!lease.job &&
    pending.some((pod) => pod.context === lease.context && pod.namespace === lease.namespace && pod.job === lease.job);
}

export interface HostLeaseHandle {
  (): void;
  readonly id: string;
  /** Job creation is not release: retain the lease until its Pod is observed Running or terminal. */
  applied: (job: string, context: string, namespace: string) => void;
}

/** A Job without a Running/terminal Pod still occupies a host reservation. */
export function hostLeaseCounts(records: readonly HostLeaseRecord[]): { reserved: number; waitingJobs: number } {
  return { reserved: records.filter((r) => r.stage !== 'job').length, waitingJobs: records.filter((r) => r.stage === 'job').length };
}

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

  reservationIsOther(id: string): boolean {
    if (!/^[A-Za-z0-9._-]+\.json$/.test(id)) return false;
    try {
      const record = JSON.parse(readFileSync(join(this.dir, id), 'utf8')) as HostLeaseRecord;
      return record.stage === 'authoring' && Number.isSafeInteger(record.pid) && record.pid > 0 &&
        typeof record.startedAt === 'string' && this.processStart(record.pid) === record.startedAt &&
        (record.pid !== this.pid || record.startedAt !== this.selfStart());
    } catch { return false; }
  }

  /** Transfer a reservation across the authoring → orchestrator process boundary. */
  claim(id: string): HostLeaseHandle | null {
    if (!/^[A-Za-z0-9._-]+\.json$/.test(id)) return null;
    const file = join(this.dir, id);
    const deadline = Date.now() + this.staleLockMs;
    while (!this.lock()) {
      if (Date.now() >= deadline) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    try {
      if (this.ownStart === undefined) this.ownStart = this.processStart(this.pid);
      if (!this.ownStart) return null;
      const original = JSON.parse(readFileSync(file, 'utf8')) as HostLeaseRecord;
      if (original.stage !== 'authoring' || original.claimed || !Number.isSafeInteger(original.pid) || original.pid <= 0 ||
        typeof original.startedAt !== 'string' || this.processStart(original.pid) !== original.startedAt) return null;
      const record: HostLeaseRecord = { ...original, pid: this.pid, startedAt: this.ownStart, claimed: true };
      this.replaceRecord(file, record);
      return this.handle(file, record, id);
    } catch { return null; }
    finally { this.unlock(); }
  }

  /** Live leases after removing stale ones (dead pid or a recycled pid whose start time differs). */
  live(): HostLeaseRecord[] { return this.readLive(false); }

  private readLive(lockHeld: boolean): HostLeaseRecord[] {
    const out: HostLeaseRecord[] = [];
    let names: string[] = [];
    try { names = readdirSync(this.dir).filter((name) => name.endsWith('.json')); } catch { return out; }
    for (const name of names) {
      const file = join(this.dir, name);
      let record: HostLeaseRecord | null = null;
      try { record = JSON.parse(readFileSync(file, 'utf8')) as HostLeaseRecord; } catch { record = null; }
      const alive = record && Number.isSafeInteger(record.pid) && record.pid > 0 && typeof record.startedAt === 'string'
        && this.processStart(record.pid) === record.startedAt;
      if (record && alive) { out.push(record); continue; }
      // A concurrent claim can replace the record while we check the original PID.
      if (!lockHeld && !this.lock()) { if (record) out.push(record); continue; }
      try {
        let current: HostLeaseRecord | null;
        try { current = JSON.parse(readFileSync(file, 'utf8')) as HostLeaseRecord; } catch { current = null; }
        if (current && Number.isSafeInteger(current.pid) && current.pid > 0 && typeof current.startedAt === 'string' &&
          this.processStart(current.pid) === current.startedAt) { out.push(current); continue; }
        try { unlinkSync(file); } catch { /* already cleaned */ }
        debug.log('pod.lease', 'host-lease-stale-cleared', { file: name, pid: current?.pid ?? null });
      } finally { if (!lockHeld) this.unlock(); }
    }
    return out;
  }

  selfStart(): string | null {
    if (this.ownStart === undefined) this.ownStart = this.processStart(this.pid);
    return this.ownStart;
  }

  /** Reservations held by other processes while the cluster cannot yet observe them. */
  othersPending(): number {
    return this.live().filter((r) => !(r.pid === this.pid && r.startedAt === this.selfStart())).length;
  }

  /**
   * Under the host lock, take a lease only if `allowed(pending)` holds — the check and the write are one step.
   * By default pending excludes this process's permits (the local admission gate owns them); includeOwn
   * counts every reservation for independent authoring launches from the same process.
   * Null = refused or lock busy (retry later).
   */
  tryReserve(allowed: (othersPending: number) => boolean, includeOwn = false): HostLeaseHandle | null {
    try { mkdirSync(this.dir, { recursive: true, mode: 0o700 }); } catch { return null; }
    if (!this.lock()) return null;
    try {
      if (this.ownStart === undefined) this.ownStart = this.processStart(this.pid);
      if (!this.ownStart) return null;
      const others = this.readLive(true).filter((r) => includeOwn || !(r.pid === this.pid && r.startedAt === this.ownStart)).length;
      if (!allowed(others)) {
        debug.log('pod.lease', 'host-lease-refused', { othersPending: others });
        return null;
      }
      const file = join(this.dir, `${this.pid}-${this.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
      const record: HostLeaseRecord = { pid: this.pid, startedAt: this.ownStart, at: new Date(this.now()).toISOString(), stage: 'authoring' };
      writeFileSync(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      debug.log('pod.lease', 'host-lease-acquired', { othersPending: others });
      return this.handle(file, record, file.slice(this.dir.length + 1));
    } finally {
      this.unlock();
    }
  }

  private replaceRecord(file: string, record: HostLeaseRecord): void {
    const temp = `${file}.${this.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      renameSync(temp, file);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* already gone */ }
      throw error;
    }
  }

  private handle(file: string, record: HostLeaseRecord, id: string): HostLeaseHandle {
    let released = false;
    const release = (() => {
      if (released) return;
      // Claim replaces the same file under this lock. An old owner must not unlink a
      // newly transferred reservation between reading and removing its record.
      const deadline = Date.now() + this.staleLockMs;
      while (!this.lock()) {
        if (Date.now() >= deadline) return;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      try {
        const current = JSON.parse(readFileSync(file, 'utf8')) as HostLeaseRecord;
        if (current.pid === record.pid && current.startedAt === record.startedAt && current.claimed === record.claimed) unlinkSync(file);
      } catch { /* transferred or already cleaned */ }
      finally { released = true; this.unlock(); }
    }) as HostLeaseHandle;
    Object.defineProperty(release, 'id', { value: id });
    release.applied = (job, context, namespace) => {
      if (released) return;
      const deadline = Date.now() + this.staleLockMs;
      while (!this.lock()) {
        if (Date.now() >= deadline) throw new Error('pod lease: cannot update Job reservation');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      try {
        const current = JSON.parse(readFileSync(file, 'utf8')) as HostLeaseRecord;
        if (current.pid !== record.pid || current.startedAt !== record.startedAt || current.claimed !== record.claimed) throw new Error('pod lease: reservation owner changed');
        if (!job || !context || !namespace) throw new Error('pod lease: Job identity requires context, namespace and name');
        this.replaceRecord(file, { ...record, stage: 'job', job, context, namespace });
      } finally { this.unlock(); }
    };
    return release;
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
