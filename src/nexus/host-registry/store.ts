import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { nexusRootDir } from '../paths.js';
import { classifyHost } from './classify.js';
import type { HostChannel, HostLedger, HostRecord } from './types.js';

export function hostLedgerPath(): string {
  return join(nexusRootDir(), 'host-registry.json');
}

const CHANNELS = new Set(['dev', 'release', 'unknown']);

/** Null-prototype map so host names like __proto__ / constructor are ordinary own keys. */
export function toHostMap(entries: Iterable<[string, HostRecord]>): Record<string, HostRecord> {
  const m: Record<string, HostRecord> = Object.create(null);
  for (const [k, v] of entries) Object.defineProperty(m, k, { value: v, enumerable: true, writable: true, configurable: true });
  return m;
}

export function isHostRecord(v: unknown): v is HostRecord {
  const r = v as Partial<HostRecord> | null;
  return !!r && typeof r === 'object' && typeof r.host === 'string' && typeof r.installedSha === 'string'
    && typeof r.lastHeartbeatMs === 'number' && typeof r.channel === 'string' && CHANNELS.has(r.channel)
    && (r.seat === undefined || typeof r.seat === 'string')
    && (r.aliases === undefined || (Array.isArray(r.aliases) && r.aliases.every((alias) => typeof alias === 'string')));
}

/** Thrown when the ledger exists but cannot be trusted (permission, corrupt, wrong version, bad entry). */
export class HostLedgerReadError extends Error {}

/**
 * Strict read: undefined = the file genuinely does not exist (ENOENT).
 * Anything else that is not a valid ledger throws, so writers never overwrite it.
 */
export function readHostLedgerStrict(path: string = hostLedgerPath()): HostLedger | undefined {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new HostLedgerReadError(`host ledger unreadable (${path}): ${(e as Error).message}`);
  }
  let parsed: Partial<HostLedger> | null;
  try { parsed = JSON.parse(text) as Partial<HostLedger>; } catch (e) {
    throw new HostLedgerReadError(`host ledger corrupt (${path}): ${(e as Error).message}`);
  }
  if (parsed?.version !== 1 || typeof parsed.hosts !== 'object' || parsed.hosts === null || Array.isArray(parsed.hosts)) {
    throw new HostLedgerReadError(`host ledger has unsupported version/shape (${path})`);
  }
  for (const [k, v] of Object.entries(parsed.hosts)) {
    if (!isHostRecord(v)) throw new HostLedgerReadError(`host ledger entry "${k}" is malformed (${path})`);
  }
  return { version: 1, hosts: toHostMap(Object.entries(parsed.hosts)) };
}

/** Display read: undefined = no usable ledger -> callers report «unmeasured». Malformed entries are skipped. */
export function readHostLedger(path: string = hostLedgerPath()): HostLedger | undefined {
  try { return readHostLedgerStrict(path); } catch {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HostLedger>;
      if (parsed?.version !== 1 || typeof parsed.hosts !== 'object' || parsed.hosts === null || Array.isArray(parsed.hosts)) return undefined;
      return { version: 1, hosts: toHostMap(Object.entries(parsed.hosts).filter(([, v]) => isHostRecord(v))) };
    } catch { return undefined; }
  }
}

export function writeHostLedgerAtomic(ledger: HostLedger, path: string = hostLedgerPath(), renameImpl: (from: string, to: string) => void = renameSync): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8');
    renameImpl(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

export function readLockToken(lock: string): string | undefined {
  try { return readFileSync(join(lock, 'owner'), 'utf8'); } catch { return undefined; }
}

function lockAgeMs(lock: string): number {
  try { return Date.now() - statSync(lock).mtimeMs; } catch { return 0; }
}

/** Release only if the lock still carries our token (a reclaimed lock now belongs to someone else). */
export function releaseLedgerLock(lock: string, token: string): void {
  if (readLockToken(lock) === token) rmSync(lock, { recursive: true, force: true });
}

function ownerAlive(token: string | undefined): boolean {
  const pid = Number(token?.split('.')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Remove a stale lock only if it is still the one the caller observed (same owner token, still old).
 * Reclaimers are serialised by a guard dir, so two waiters cannot both delete, and a fresh lock taken
 * after the observation is never removed.
 */
export function reclaimStaleLock(lock: string, observedToken: string | undefined): boolean {
  const guard = `${lock}.reclaim`;
  try { mkdirSync(guard); } catch {
    if (lockAgeMs(guard) > LOCK_STALE_MS) rmSync(guard, { recursive: true, force: true });
    return false;
  }
  try {
    if (readLockToken(lock) !== observedToken || lockAgeMs(lock) <= LOCK_STALE_MS || ownerAlive(observedToken)) return false;
    rmSync(lock, { recursive: true, force: true });
    return true;
  } finally { rmSync(guard, { recursive: true, force: true }); }
}

/** Serialises read-modify-write across processes with an owner-tokened mkdir lock. */
function withLedgerLock<T>(path: string, fn: () => T): T {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lock = `${path}.lock`;
  const token = `${process.pid}.${randomUUID()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { mkdirSync(lock); writeFileSync(join(lock, 'owner'), token); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (lockAgeMs(lock) > LOCK_STALE_MS && reclaimStaleLock(lock, readLockToken(lock))) continue;
      if (Date.now() > deadline) throw new Error(`host ledger lock busy (${lock})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.floor(Math.random() * 15));
    }
  }
  try { return fn(); } finally { releaseLedgerLock(lock, token); }
}

export interface HeartbeatOptions {
  seat?: string;
  /** Omitted + no previous record -> stored as 'unknown' (never guessed). */
  channel?: HostChannel;
  desiredSha?: string;
  staleMs?: number;
  path?: string;
  /** Test seam: inject a write-stage failure without relying on file permissions. */
  renameImpl?: (from: string, to: string) => void;
}

export function recordHeartbeat(host: string, installedSha: string, now: number, opts: HeartbeatOptions = {}): HostRecord {
  const path = opts.path ?? hostLedgerPath();
  return withLedgerLock(path, () => {
    const ledger = readHostLedgerStrict(path) ?? { version: 1 as const, hosts: toHostMap([]) };
    const prev = ledger.hosts[host];
    const base = { installedSha, lastHeartbeatMs: now };
    const record: HostRecord = {
      host,
      ...(prev?.aliases ? { aliases: prev.aliases } : {}),
      seat: opts.seat ?? prev?.seat,
      channel: opts.channel ?? prev?.channel ?? 'unknown',
      ...base,
      state: classifyHost(base, opts.desiredSha, now, opts.staleMs),
    };
    Object.defineProperty(ledger.hosts, host, { value: record, enumerable: true, writable: true, configurable: true });
    writeHostLedgerAtomic(ledger, path, opts.renameImpl);
    return record;
  });
}
