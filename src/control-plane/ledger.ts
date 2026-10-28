import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { acquireLockAsync, withFileLockSync } from '../storage/file-lock.js';

export const RESOURCE_KINDS = ['machine', 'instance', 'port-lease', 'exposure', 'universe', 'setup-status', 'image', 'slot-lease', 'pod-worker-lease'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export interface ResourceRecord {
  id: string;
  kind: ResourceKind;
  machine: string;
  name: string;
  owner: string;
  endpoint?: string;
  attrs: Record<string, unknown>;
  observedAt: number;
  ttlMs: number;
}
export type ResourceView = ResourceRecord & { ageMs: number; expired: boolean };

export interface PodWorkerKey { context: string; imageDigest: string; lockHash: string; architecture: string }
type PodWorkerState = 'idle' | 'leased' | 'sanitizing' | 'quarantined';
interface PodWorkerLeaseAttrs {
  key: PodWorkerKey;
  podUid: string;
  state: PodWorkerState;
  generation: number;
  idleTtlMs: number;
  leaseId?: string;
  leaseOwner?: string;
  /** The just-sanitized generation remains fenceable until the next acquisition. */
  lastLeaseId?: string;
  lastLeaseOwner?: string;
  runId?: string;
  attemptId?: string;
  reason?: string;
}

function workerAttrs(row: ResourceRecord): PodWorkerLeaseAttrs {
  if (row.kind !== 'pod-worker-lease') throw new ResourceLedgerError(400, 'not-pod-worker');
  return row.attrs as unknown as PodWorkerLeaseAttrs;
}

function sameWorkerKey(a: PodWorkerKey, b: PodWorkerKey): boolean {
  return a.context === b.context && a.imageDigest === b.imageDigest && a.lockHash === b.lockHash && a.architecture === b.architecture;
}

export class ResourceLedgerError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export class ResourceLedger {
  readonly path: string;
  private guardedLockHeld = false;
  private guardedAction = false;

  constructor(root: string = effectiveInstanceRoot()) {
    this.path = join(root, 'control', 'ledger.json');
  }

  private read(): ResourceRecord[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('invalid resource ledger');
      return parsed as ResourceRecord[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private write(rows: ResourceRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, this.path);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* no temporary file */ }
      throw err;
    }
  }

  /** All read-modify-write operations share one cross-process lock, including older resource kinds. */
  private mutate<T>(fn: () => T): T {
    if (this.guardedLockHeld) {
      if (!this.guardedAction) throw new ResourceLedgerError(503, 'ledger-busy');
      return fn();
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    return withFileLockSync(`${this.path}.lock`, fn, { staleMs: 300_000, breakDeadHolder: true });
  }

  /** Recheck the current primary only after acquiring the same lock that protects the worker write. */
  async withGuardedWorkerMutation<T>(primaryCurrent: () => Promise<boolean>, action: () => T): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = await acquireLockAsync(`${this.path}.lock`, { staleMs: 300_000, maxTries: 240 });
    this.guardedLockHeld = true;
    try {
      if (!(await primaryCurrent()) || !lock.stillHeld()) throw new ResourceLedgerError(409, 'not-primary');
      this.guardedAction = true;
      try { return action(); }
      finally { this.guardedAction = false; }
    } finally {
      this.guardedLockHeld = false;
      lock.release();
    }
  }

  /** Server writes join the async queue so a slow primary read cannot turn unrelated writes into 503s. */
  async withSerializedMutation<T>(action: () => T): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = await acquireLockAsync(`${this.path}.lock`, { staleMs: 300_000, maxTries: 240 });
    this.guardedLockHeld = true;
    this.guardedAction = true;
    try {
      if (!lock.stillHeld()) throw new ResourceLedgerError(503, 'ledger-lock-lost');
      return action();
    } finally {
      this.guardedAction = false;
      this.guardedLockHeld = false;
      lock.release();
    }
  }

  list(filter: { kind?: string; machine?: string; name?: string } = {}, now = Date.now()): ResourceView[] {
    return this.read().filter(row =>
      (!filter.kind || row.kind === filter.kind) &&
      (!filter.machine || row.machine === filter.machine) &&
      (!filter.name || row.name === filter.name),
    ).map(row => {
      const ageMs = Math.max(0, now - row.observedAt);
      return { ...row, ageMs, expired: ageMs >= row.ttlMs };
    });
  }

  register(record: ResourceRecord, owner: string): ResourceRecord {
    return this.mutate(() => {
    if (record.kind === 'pod-worker-lease' || record.id.startsWith('pod-worker-lease:')) throw new ResourceLedgerError(403, 'pod-worker-requires-allocator');
    const rows = this.read();
    const index = rows.findIndex(row => row.id === record.id);
    if (index >= 0 && rows[index]!.owner !== owner) throw new ResourceLedgerError(403, 'not-owner');
    const next = { ...record, owner };
    if (index < 0) rows.push(next);
    else rows[index] = next;
    this.write(rows);
    return next;
    });
  }

  /** Select and persist the lowest available lease in a single ledger operation. */
  leaseTestPort(
    request: { machine: string; purpose: string; ttlMs: number; owner: string },
    band: { start: number; end: number },
    now?: number,
    excluded: readonly number[] = [],
  ): ResourceRecord {
    return this.mutate(() => {
    now ??= Date.now();
    const rows = this.read();
    for (let port = band.start; port <= band.end; port++) {
      if (excluded.includes(port)) continue;
      const id = `port-lease:${port}`;
      const index = rows.findIndex(row => row.id === id);
      const previous = index >= 0 ? rows[index]! : undefined;
      if (previous && (previous.kind !== 'port-lease' || Math.max(0, now - previous.observedAt) < previous.ttlMs)) continue;
      const next: ResourceRecord = {
        id, kind: 'port-lease', machine: request.machine, name: request.purpose, owner: request.owner,
        attrs: { port, purpose: request.purpose, leaseId: randomUUID() }, observedAt: now, ttlMs: request.ttlMs,
      };
      if (index >= 0) rows[index] = next;
      else rows.push(next);
      this.write(rows);
      return next;
    }
    throw new ResourceLedgerError(409, 'no-port');
    });
  }

  renewTestPort(port: number, owner: string, leaseId: string, now?: number): ResourceRecord {
    return this.mutate(() => {
    now ??= Date.now();
    const id = `port-lease:${port}`;
    const rows = this.read();
    const index = rows.findIndex(row => row.id === id && row.kind === 'port-lease');
    if (index < 0) throw new ResourceLedgerError(404, 'not-found');
    const row = rows[index]!;
    if (row.owner !== owner || !leaseId || row.attrs.leaseId !== leaseId) throw new ResourceLedgerError(403, 'not-owner');
    if (Math.max(0, now - row.observedAt) >= row.ttlMs) throw new ResourceLedgerError(409, 'lease-expired');
    const next = { ...row, observedAt: now };
    rows[index] = next;
    this.write(rows);
    return next;
    });
  }

  deleteTestPort(port: number, owner: string, leaseId: string): void {
    return this.mutate(() => {
    const rows = this.read();
    const index = rows.findIndex(row => row.id === `port-lease:${port}` && row.kind === 'port-lease');
    if (index < 0) throw new ResourceLedgerError(404, 'not-found');
    if (rows[index]!.owner !== owner || !leaseId || rows[index]!.attrs.leaseId !== leaseId) throw new ResourceLedgerError(403, 'not-owner');
    rows.splice(index, 1);
    this.write(rows);
    });
  }

  /** A trusted host registers a clean instance; canary verification is a separate, still unwired step. */
  registerPodWorker(request: { workerId: string; machine: string; podUid: string; key: PodWorkerKey; owner: string; ttlMs: number }, now?: number): ResourceRecord {
    return this.mutate(() => {
    if (typeof request.podUid !== 'string' || !request.podUid.trim()) throw new ResourceLedgerError(400, 'invalid-pod-worker-uid');
    now ??= Date.now();
    const rows = this.read();
    const id = `pod-worker-lease:${request.workerId}`;
    const index = rows.findIndex(row => row.id === id);
    const previous = index < 0 ? undefined : rows[index]!;
    if (previous && previous.kind !== 'pod-worker-lease') throw new ResourceLedgerError(409, 'worker-id-conflict');
    // A workerId identifies one Pod instance. Expiry never proves that a leased or quarantined Pod was cleaned.
    if (previous) throw new ResourceLedgerError(409, 'worker-id-used');
    const generation = 0;
    const row: ResourceRecord = { id, kind: 'pod-worker-lease', machine: request.machine, name: request.workerId,
      owner: request.owner, attrs: { key: request.key, podUid: request.podUid, state: 'idle', generation, idleTtlMs: request.ttlMs }, observedAt: now, ttlMs: request.ttlMs };
    if (index < 0) rows.push(row); else rows[index] = row;
    this.write(rows);
    return row;
    });
  }

  acquirePodWorker(request: { machine?: string; key: PodWorkerKey; owner: string; runId: string; attemptId: string; ttlMs: number }, now?: number): ResourceRecord {
    return this.mutate(() => {
    const at = now ?? Date.now();
    const rows = this.read();
    const index = rows.findIndex(row => row.kind === 'pod-worker-lease' && (!request.machine || row.machine === request.machine)
      && Math.max(0, at - row.observedAt) < row.ttlMs && workerAttrs(row).state === 'idle'
      && typeof workerAttrs(row).podUid === 'string' && workerAttrs(row).podUid.trim().length > 0
      && sameWorkerKey(workerAttrs(row).key, request.key));
    if (index < 0) throw new ResourceLedgerError(409, 'no-warm-worker');
    const row = rows[index]!;
    const attrs = workerAttrs(row);
    const nextAttrs: PodWorkerLeaseAttrs = { ...attrs, state: 'leased', generation: attrs.generation + 1,
      leaseId: randomUUID(), leaseOwner: request.owner, runId: request.runId, attemptId: request.attemptId };
    delete nextAttrs.lastLeaseId;
    delete nextAttrs.lastLeaseOwner;
    const next: ResourceRecord = { ...row, attrs: nextAttrs as unknown as Record<string, unknown>,
      observedAt: at, ttlMs: request.ttlMs };
    rows[index] = next;
    this.write(rows);
    return next;
    });
  }

  transitionPodWorker(id: string, request: { owner: string; leaseId: string; generation: number; action: 'renew' | 'release' | 'sanitize' | 'quarantine'; ttlMs?: number; reason?: string }, now?: number): ResourceRecord {
    return this.mutate(() => {
    now ??= Date.now();
    const rows = this.read();
    const index = rows.findIndex(row => row.id === id && row.kind === 'pod-worker-lease');
    if (index < 0) throw new ResourceLedgerError(404, 'not-found');
    const row = rows[index]!;
    const attrs = workerAttrs(row);
    const lateIdleQuarantine = request.action === 'quarantine' && attrs.state === 'idle'
      && attrs.lastLeaseId === request.leaseId && attrs.generation === request.generation;
    if (!request.leaseId || (attrs.leaseId !== request.leaseId && !lateIdleQuarantine)
      || attrs.generation !== request.generation) throw new ResourceLedgerError(409, 'stale-worker-lease');
    const permitted = request.action === 'sanitize' ? row.owner === request.owner
      : request.action === 'quarantine' ? row.owner === request.owner || attrs.leaseOwner === request.owner
        || (lateIdleQuarantine && attrs.lastLeaseOwner === request.owner)
      : attrs.leaseOwner === request.owner;
    if (!permitted) {
      throw new ResourceLedgerError(403, 'not-owner');
    }
    if (request.action === 'renew' && (attrs.state !== 'leased' || Math.max(0, now - row.observedAt) >= row.ttlMs)) throw new ResourceLedgerError(409, 'lease-expired');
    if (request.action === 'release' && attrs.state !== 'leased') throw new ResourceLedgerError(409, 'not-leased');
    if (request.action === 'sanitize' && attrs.state !== 'sanitizing') throw new ResourceLedgerError(409, 'not-sanitizing');
    if (request.action === 'quarantine' && attrs.state === 'quarantined') throw new ResourceLedgerError(409, 'already-quarantined');
    const state: PodWorkerState = request.action === 'renew' ? 'leased' : request.action === 'release' ? 'sanitizing'
      : request.action === 'sanitize' ? 'idle' : 'quarantined';
    const nextAttrs: PodWorkerLeaseAttrs = { ...attrs, state, ...(request.reason ? { reason: request.reason } : {}) };
    if (state === 'idle') {
      nextAttrs.lastLeaseId = attrs.leaseId;
      nextAttrs.lastLeaseOwner = attrs.leaseOwner;
      delete nextAttrs.leaseId; delete nextAttrs.leaseOwner; delete nextAttrs.runId; delete nextAttrs.attemptId; delete nextAttrs.reason;
    } else if (state === 'quarantined') {
      delete nextAttrs.lastLeaseId;
      delete nextAttrs.lastLeaseOwner;
    }
    const ttlMs = state === 'idle' ? attrs.idleTtlMs : request.ttlMs ?? row.ttlMs;
    const next: ResourceRecord = { ...row, attrs: nextAttrs as unknown as Record<string, unknown>, observedAt: now, ttlMs };
    rows[index] = next;
    this.write(rows);
    return next;
    });
  }

  heartbeat(id: string, owner: string, attrs?: Record<string, unknown>, now?: number): ResourceRecord {
    return this.mutate(() => {
    if (id.startsWith('pod-worker-lease:')) throw new ResourceLedgerError(403, 'pod-worker-requires-allocator');
    now ??= Date.now();
    const rows = this.read();
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) throw new ResourceLedgerError(404, 'not-found');
    const row = rows[index]!;
    if (row.kind === 'pod-worker-lease') throw new ResourceLedgerError(403, 'pod-worker-requires-allocator');
    if (row.owner !== owner) throw new ResourceLedgerError(403, 'not-owner');
    const next = { ...row, observedAt: now, ...(attrs ? { attrs: { ...row.attrs, ...attrs } } : {}) };
    rows[index] = next;
    this.write(rows);
    return next;
    });
  }

  delete(id: string, owner: string): void {
    return this.mutate(() => {
    if (id.startsWith('pod-worker-lease:')) throw new ResourceLedgerError(403, 'pod-worker-requires-allocator');
    const rows = this.read();
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) throw new ResourceLedgerError(404, 'not-found');
    if (rows[index]!.kind === 'pod-worker-lease') throw new ResourceLedgerError(403, 'pod-worker-requires-allocator');
    if (rows[index]!.owner !== owner) throw new ResourceLedgerError(403, 'not-owner');
    rows.splice(index, 1);
    this.write(rows);
    });
  }
}
