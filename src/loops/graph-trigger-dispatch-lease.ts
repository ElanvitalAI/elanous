import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { effectiveInstanceRoot } from '../instance/resolve.js';

export interface GraphTriggerDispatchLeaseInput {
  triggerId: string;
  dedupeKey: string;
  graphId: string;
  runId: string;
}

export interface GraphTriggerDispatchBindingInput {
  triggerId: string;
  dedupeKey: string;
  graphId: string;
}

export interface RegisteredGraphTriggerDispatchBinding extends GraphTriggerDispatchBindingInput {
  runId: string;
  stateRoot: string;
  created: boolean;
}

export interface GraphTriggerDispatchLease extends GraphTriggerDispatchLeaseInput {
  registryRoot: string;
  stateRoot: string;
  owner: string;
  expiresAt: number;
}

export type GraphTriggerDispatchLeaseClaim =
  | { lease: GraphTriggerDispatchLease; claimed: true; reclaimedOwner?: string }
  | { lease: Omit<GraphTriggerDispatchLease, 'owner'>; claimed: false };

export const GRAPH_TRIGGER_DISPATCH_LEASE_MS = 30_000; // Source: lease recovery window for a single graph dispatch owner.
export const GRAPH_TRIGGER_DISPATCH_RENEWAL_DIVISOR = 3; // Source: renew before one full lease window can elapse.

/** Persist a trigger identity without claiming execution ownership; the lease and binding share one SSOT row. */
export function registerGraphTriggerDispatchBinding(input: GraphTriggerDispatchBindingInput, options: {
  registryRoot?: string;
  stateRoot?: string;
  createRunId?: () => string;
} = {}): RegisteredGraphTriggerDispatchBinding {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`graph trigger ${name} must be a non-empty string`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.graphId)) throw new Error('graph trigger graphId must be a safe identifier');
  const registryRoot = resolve(options.registryRoot ?? effectiveInstanceRoot());
  const stateRoot = resolve(options.stateRoot ?? registryRoot);
  const db = openGraphTriggerDispatchLeaseDb(registryRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    const existing = db.query(`SELECT graph_id AS graphId, run_id AS runId, state_root AS stateRoot
      FROM graph_trigger_dispatch_leases WHERE trigger_id = ? AND dedupe_key = ?`)
      .get(input.triggerId, input.dedupeKey) as { graphId: string; runId: string; stateRoot: string } | null;
    if (existing) {
      if (existing.graphId !== input.graphId || resolve(existing.stateRoot) !== stateRoot)
        throw new Error(`graph trigger binding conflict: ${input.triggerId}/${input.dedupeKey}`);
      db.exec('COMMIT');
      return { ...input, runId: existing.runId, stateRoot, created: false };
    }
    const runId = (options.createRunId ?? randomUUID)();
    if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId))
      throw new Error('graph trigger runId must be a safe non-empty identifier');
    db.query(`INSERT INTO graph_trigger_dispatch_leases
      (trigger_id, dedupe_key, graph_id, run_id, state_root, dispatch_owner, dispatch_lease_expires_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL)`)
      .run(input.triggerId, input.dedupeKey, input.graphId, runId, stateRoot);
    db.exec('COMMIT');
    return { ...input, runId, stateRoot, created: true };
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

export function getGraphTriggerDispatchBinding(input: Pick<GraphTriggerDispatchLeaseInput, 'triggerId' | 'dedupeKey' | 'graphId'>, options: {
  registryRoot?: string;
} = {}): Pick<GraphTriggerDispatchLeaseInput, 'triggerId' | 'dedupeKey' | 'graphId' | 'runId'> & { stateRoot: string } | null {
  const registryRoot = resolve(options.registryRoot ?? effectiveInstanceRoot());
  const db = openGraphTriggerDispatchLeaseDb(registryRoot);
  try {
    const row = db.query(`SELECT graph_id AS graphId, run_id AS runId, state_root AS stateRoot
      FROM graph_trigger_dispatch_leases WHERE trigger_id = ? AND dedupe_key = ?`)
      .get(input.triggerId, input.dedupeKey) as { graphId: string; runId: string; stateRoot: string } | null;
    if (!row) return null;
    if (row.graphId !== input.graphId) throw new Error(`graph trigger dispatch binding conflict: ${input.triggerId}/${input.dedupeKey}`);
    return { ...input, runId: row.runId, stateRoot: resolve(row.stateRoot) };
  } finally { db.close(); }
}

export function isGraphTriggerDispatchLeaseOwnerActive(registryRoot: string, owner: string, now = Date.now()): boolean {
  if (!Number.isSafeInteger(now)) return false;
  const db = openGraphTriggerDispatchLeaseDb(resolve(registryRoot));
  try {
    return (db.query(`SELECT 1 FROM graph_trigger_dispatch_leases
      WHERE dispatch_owner = ? AND dispatch_lease_expires_at > ? LIMIT 1`).get(owner, now) as { 1: number } | null) !== null;
  } finally { db.close(); }
}

function openGraphTriggerDispatchLeaseDb(registryRoot: string): Database {
  mkdirSync(registryRoot, { recursive: true });
  const db = new Database(join(registryRoot, 'graph-trigger-registry.db'));
  db.exec('PRAGMA busy_timeout = 5000'); // Source: app-db bounded SQLite lock wait used by shared application state.
  db.exec(`CREATE TABLE IF NOT EXISTS graph_trigger_dispatch_leases (
    trigger_id TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    graph_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    state_root TEXT NOT NULL,
    dispatch_owner TEXT,
    dispatch_lease_expires_at INTEGER,
    PRIMARY KEY (trigger_id, dedupe_key)
  )`);
  return db;
}

function validateGraphTriggerDispatchLeaseInput(input: GraphTriggerDispatchLeaseInput): void {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`graph trigger ${name} must be a non-empty string`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.runId)) throw new Error('graph trigger runId must be a safe non-empty identifier');
}

/** The registry root is shared; each composite key stays bound to one graph, run ID, and execution state root. */
export function claimGraphTriggerDispatchLease(input: GraphTriggerDispatchLeaseInput, options: {
  registryRoot?: string;
  stateRoot?: string;
  now?: () => number;
  leaseMs?: number;
} = {}): GraphTriggerDispatchLeaseClaim {
  validateGraphTriggerDispatchLeaseInput(input);
  const registryRoot = resolve(options.registryRoot ?? effectiveInstanceRoot());
  const stateRoot = resolve(options.stateRoot ?? registryRoot);
  const leaseMs = options.leaseMs ?? GRAPH_TRIGGER_DISPATCH_LEASE_MS;
  // Source: expiration uses integer clock milliseconds and a positive recovery interval.
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('graph trigger dispatch leaseMs must be positive');
  const owner = `${process.pid}:${randomUUID()}`;
  const db = openGraphTriggerDispatchLeaseDb(registryRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    // Read the clock only after acquiring SQLite's write lock; lock waiting may cross the expiry boundary.
    const now = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(now + leaseMs)) throw new Error('graph trigger dispatch lease time must be a safe integer');
    const existing = db.query(`SELECT graph_id AS graphId, run_id AS runId, state_root AS stateRoot,
        dispatch_owner AS owner, dispatch_lease_expires_at AS expiresAt
      FROM graph_trigger_dispatch_leases WHERE trigger_id = ? AND dedupe_key = ?`)
      .get(input.triggerId, input.dedupeKey) as Pick<GraphTriggerDispatchLease, 'graphId' | 'runId' | 'stateRoot' | 'owner' | 'expiresAt'> | null;
    if (existing && (existing.graphId !== input.graphId || resolve(existing.stateRoot) !== stateRoot)) {
      throw new Error(`graph trigger dispatch binding conflict: ${input.triggerId}/${input.dedupeKey}`);
    }
    const runId = existing?.runId ?? input.runId;
    const stableBinding = { triggerId: input.triggerId, dedupeKey: input.dedupeKey, graphId: input.graphId, runId };
    if (existing?.owner && existing.expiresAt !== null && existing.expiresAt > now) {
      db.exec('ROLLBACK');
      return { lease: { ...stableBinding, registryRoot, stateRoot, expiresAt: existing.expiresAt }, claimed: false };
    }
    const expiresAt = now + leaseMs;
    const reclaimedOwner = existing?.owner && existing.expiresAt !== null && existing.expiresAt <= now ? existing.owner : undefined;
    if (existing) {
      db.query(`UPDATE graph_trigger_dispatch_leases SET dispatch_owner = ?, dispatch_lease_expires_at = ?
        WHERE trigger_id = ? AND dedupe_key = ?`).run(owner, expiresAt, input.triggerId, input.dedupeKey);
    } else {
      db.query(`INSERT INTO graph_trigger_dispatch_leases
        (trigger_id, dedupe_key, graph_id, run_id, state_root, dispatch_owner, dispatch_lease_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.triggerId, input.dedupeKey, input.graphId, input.runId, stateRoot, owner, expiresAt);
    }
    db.exec('COMMIT');
    return { lease: { ...stableBinding, registryRoot, stateRoot, owner, expiresAt }, claimed: true, ...(reclaimedOwner ? { reclaimedOwner } : {}) };
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

/** Hold the registry write lock across the run-state write so an expired owner cannot write after takeover. */
export function withGraphTriggerDispatchLeaseFence<T>(lease: GraphTriggerDispatchLease, write: () => T, options: { now?: () => number } = {}): T {
  const db = openGraphTriggerDispatchLeaseDb(lease.registryRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    const now = (options.now ?? Date.now)();
    const row = db.query(`SELECT dispatch_owner AS owner, dispatch_lease_expires_at AS expiresAt
      FROM graph_trigger_dispatch_leases WHERE trigger_id = ? AND dedupe_key = ? AND graph_id = ? AND run_id = ? AND state_root = ?`)
      .get(lease.triggerId, lease.dedupeKey, lease.graphId, lease.runId, lease.stateRoot) as { owner: string | null; expiresAt: number | null } | null;
    if (!Number.isSafeInteger(now) || row?.owner !== lease.owner || row.expiresAt === null || row.expiresAt <= now)
      throw new Error(`graph trigger dispatch lease lost: ${lease.triggerId}/${lease.dedupeKey}`);
    const result = write();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

/** Renew only while the caller still owns an unexpired lease. */
export function renewGraphTriggerDispatchLease(lease: GraphTriggerDispatchLease, options: { now?: () => number; leaseMs?: number } = {}): boolean {
  const leaseMs = options.leaseMs ?? GRAPH_TRIGGER_DISPATCH_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('graph trigger dispatch leaseMs must be positive');
  const db = openGraphTriggerDispatchLeaseDb(lease.registryRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    // Source: evaluate lease validity after SQLite lock wait, matching claim's expiry boundary.
    const now = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(now + leaseMs)) throw new Error('graph trigger dispatch lease time must be a safe integer');
    const renewed = db.query(`UPDATE graph_trigger_dispatch_leases SET dispatch_lease_expires_at = ?
      WHERE trigger_id = ? AND dedupe_key = ? AND graph_id = ? AND run_id = ? AND state_root = ? AND dispatch_owner = ? AND dispatch_lease_expires_at > ?`)
      .run(now + leaseMs, lease.triggerId, lease.dedupeKey, lease.graphId, lease.runId, lease.stateRoot, lease.owner, now).changes === 1;
    db.exec('COMMIT');
    return renewed;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

/** Release is owner-fenced so a stale worker cannot clear a lease recovered by another worker. */
export function releaseGraphTriggerDispatchLease(lease: GraphTriggerDispatchLease): void {
  const db = openGraphTriggerDispatchLeaseDb(lease.registryRoot);
  try {
    db.query(`UPDATE graph_trigger_dispatch_leases SET dispatch_owner = NULL, dispatch_lease_expires_at = NULL
      WHERE trigger_id = ? AND dedupe_key = ? AND graph_id = ? AND run_id = ? AND state_root = ? AND dispatch_owner = ?`)
      .run(lease.triggerId, lease.dedupeKey, lease.graphId, lease.runId, lease.stateRoot, lease.owner);
  } finally { db.close(); }
}
