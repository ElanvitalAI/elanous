import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLockAsync } from '../storage/file-lock.js';

export type SupervisorLoopRef = `loop:${string}@${number}`;

export interface IncidentClaim {
  readonly schema: 1;
  readonly incidentId: string;
  readonly claimToken: string;
  readonly ownerLoopRef: SupervisorLoopRef;
  readonly ownerOrder: readonly SupervisorLoopRef[];
  readonly claimedAtMs: number;
  readonly expiresAtMs: number;
  readonly completedAtMs?: number;
  readonly history: readonly {
    readonly ownerLoopRef: SupervisorLoopRef;
    readonly claimedAtMs: number;
    readonly expiresAtMs: number;
  }[];
}

export interface IncidentClaimStore {
  transact<T>(incidentId: string, update: (current: IncidentClaim | null) => {
    readonly next: IncidentClaim | null;
    readonly result: T;
  }): Promise<T>;
  withCurrent<T>(input: { readonly incidentId: string; readonly claimToken: string; readonly now: () => number },
    action: () => T | Promise<T>, completeWhen?: (value: T) => boolean):
    Promise<{ readonly current: false } | { readonly current: true; readonly value: T }>;
}

export type IncidentClaimResult =
  | { readonly disposition: 'claimed' | 'escalated'; readonly claim: IncidentClaim }
  | { readonly disposition: 'denied'; readonly claim: IncidentClaim | null; readonly reason: string };

export interface ClaimIncidentInput {
  readonly incidentId: string;
  readonly ownerLoopRef: SupervisorLoopRef;
  /** First owner is the only initial claimant; later refs receive the claim after each lease expires. */
  readonly ownerOrder: readonly SupervisorLoopRef[];
  /** Read only after the store's per-incident lock has been acquired. */
  readonly now: () => number;
  readonly leaseMs: number;
}

type ClaimIncidentAtInput = Omit<ClaimIncidentInput, 'now'> & { readonly nowMs: number };

const validLoopRef = (value: string): value is SupervisorLoopRef => /^loop:[a-z][a-z0-9-]*@[1-9]\d*$/u.test(value);

function isStoredClaim(value: unknown, incidentId: string): value is IncidentClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claim = value as Partial<IncidentClaim>;
  if (claim.schema !== 1 || claim.incidentId !== incidentId || typeof claim.claimToken !== 'string' || !claim.claimToken ||
      typeof claim.ownerLoopRef !== 'string' ||
      !validLoopRef(claim.ownerLoopRef) || !Array.isArray(claim.ownerOrder) || !Array.isArray(claim.history) ||
      !Number.isSafeInteger(claim.claimedAtMs) || !Number.isSafeInteger(claim.expiresAtMs) ||
      claim.expiresAtMs! <= claim.claimedAtMs! || claim.ownerOrder.length === 0 ||
      (claim.completedAtMs !== undefined && (!Number.isSafeInteger(claim.completedAtMs) || claim.completedAtMs < claim.claimedAtMs!)) ||
      claim.ownerOrder.some((owner) => typeof owner !== 'string' || !validLoopRef(owner)) ||
      new Set(claim.ownerOrder).size !== claim.ownerOrder.length || !claim.ownerOrder.includes(claim.ownerLoopRef)) return false;
  if (claim.history.length === 0 || claim.history.length > claim.ownerOrder.length) return false;
  return claim.history.every((step, index) => Boolean(step && typeof step === 'object' &&
    typeof step.ownerLoopRef === 'string' && validLoopRef(step.ownerLoopRef) &&
    Number.isSafeInteger(step.claimedAtMs) && Number.isSafeInteger(step.expiresAtMs) &&
    step.expiresAtMs > step.claimedAtMs && step.ownerLoopRef === claim.ownerOrder?.[index])) &&
    claim.history.at(-1)?.ownerLoopRef === claim.ownerLoopRef &&
    claim.history.at(-1)?.claimedAtMs === claim.claimedAtMs &&
    claim.history.at(-1)?.expiresAtMs === claim.expiresAtMs;
}

function validateInput(input: ClaimIncidentInput): void {
  if (!input.incidentId.trim()) throw new Error('incident claim requires incidentId');
  if (!validLoopRef(input.ownerLoopRef)) throw new Error('incident claim requires a valid owner loop ref');
  if (input.ownerOrder.length === 0 || input.ownerOrder.some((ref) => !validLoopRef(ref)) ||
      new Set(input.ownerOrder).size !== input.ownerOrder.length || !input.ownerOrder.includes(input.ownerLoopRef))
    throw new Error('incident claim requires a unique owner order containing the requested owner');
  if (typeof input.now !== 'function' || !Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0)
    throw new Error('incident claim requires a positive safe lease and clock');
}

function sameOrder(left: readonly SupervisorLoopRef[], right: readonly SupervisorLoopRef[]): boolean {
  return left.length === right.length && left.every((owner, index) => owner === right[index]);
}

function transitionClaim(current: IncidentClaim | null, input: ClaimIncidentAtInput, claimToken: string): {
  readonly next: IncidentClaim | null;
  readonly result: IncidentClaimResult;
} {
  const expiresAtMs = input.nowMs + input.leaseMs;
  if (!current) {
    if (input.ownerOrder[0] !== input.ownerLoopRef)
      return { next: null, result: { disposition: 'denied', claim: null, reason: 'requested owner is not first in the incident order' } };
    const claim: IncidentClaim = { schema: 1, incidentId: input.incidentId, claimToken, ownerLoopRef: input.ownerLoopRef,
      ownerOrder: [...input.ownerOrder], claimedAtMs: input.nowMs, expiresAtMs,
      history: [{ ownerLoopRef: input.ownerLoopRef, claimedAtMs: input.nowMs, expiresAtMs }] };
    return { next: claim, result: { disposition: 'claimed', claim } };
  }
  if (current.incidentId !== input.incidentId || !sameOrder(current.ownerOrder, input.ownerOrder))
    return { next: current, result: { disposition: 'denied', claim: current, reason: 'incident identity or owner order changed' } };
  if (current.completedAtMs !== undefined)
    return { next: current, result: { disposition: 'denied', claim: current, reason: 'incident already completed' } };
  if (current.expiresAtMs > input.nowMs) {
    return { next: current, result: { disposition: 'denied', claim: current,
      reason: current.ownerLoopRef === input.ownerLoopRef
        ? 'another execution holds the active incident claim'
        : 'another owner holds the active incident lease' } };
  }
  const nextOwner = current.ownerOrder[current.ownerOrder.indexOf(current.ownerLoopRef) + 1];
  if (nextOwner !== input.ownerLoopRef)
    return { next: current, result: { disposition: 'denied', claim: current,
      reason: nextOwner ? 'requested owner is not the configured escalation successor' : 'incident escalation order is exhausted' } };
  const claim: IncidentClaim = { ...current, claimToken, ownerLoopRef: input.ownerLoopRef,
    claimedAtMs: input.nowMs, expiresAtMs,
    history: [...current.history, { ownerLoopRef: input.ownerLoopRef, claimedAtMs: input.nowMs, expiresAtMs }] };
  return { next: claim, result: { disposition: 'escalated', claim } };
}

/** Atomically claims one incident for its configured owner; an expired lease advances only to its next owner. */
export async function claimIncident(store: IncidentClaimStore, input: ClaimIncidentInput): Promise<IncidentClaimResult> {
  validateInput(input);
  return store.transact(input.incidentId, (current) => {
    const nowMs = input.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(nowMs + input.leaseMs))
      throw new Error('incident claim requires a positive safe lease and clock value');
    return transitionClaim(current, { ...input, nowMs }, randomUUID());
  });
}

/** Fences a running action after expiry or when an escalation replaced its claim token. */
export async function isIncidentClaimCurrent(store: IncidentClaimStore, input: {
  readonly incidentId: string;
  readonly claimToken: string;
  readonly now: () => number;
}): Promise<boolean> {
  if (!input.incidentId.trim() || !input.claimToken) return false;
  return (await store.withCurrent(input, () => true)).current;
}

/** Run a short durable action under the incident lock so expiry cannot hand off mid-commit. */
export function withIncidentClaim<T>(store: IncidentClaimStore, input: {
  readonly incidentId: string;
  readonly claimToken: string;
  readonly now: () => number;
}, action: () => T | Promise<T>, completeWhen?: (value: T) => boolean):
  Promise<{ readonly current: false } | { readonly current: true; readonly value: T }> {
  return store.withCurrent(input, action, completeWhen);
}

/** Durable per-instance claims; the lock protects read-transition-write across concurrent supervisor processes. */
export function createFileIncidentClaimStore(root: string): IncidentClaimStore {
  const directory = join(root, 'supervision', 'incident-claims');
  const pathFor = (incidentId: string) => join(directory, `${createHash('sha256').update(incidentId).digest('hex')}.json`);
  const readClaim = (path: string, incidentId: string): IncidentClaim | null => {
    if (!existsSync(path)) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new Error(`incident claim ledger is unreadable: ${incidentId}`); }
    if (!isStoredClaim(parsed, incidentId)) throw new Error(`incident claim ledger is invalid: ${incidentId}`);
    return parsed;
  };
  return {
    async transact<T>(incidentId: string, update: (current: IncidentClaim | null) => {
      readonly next: IncidentClaim | null;
      readonly result: T;
    }): Promise<T> {
      mkdirSync(directory, { recursive: true });
      const path = pathFor(incidentId);
      // Source: claim handoff must wait for an in-flight owner action to finish rather than time out and overlap it.
      const lock = await acquireLockAsync(`${path}.lock`, { breakDeadHolder: true, maxTries: Number.MAX_SAFE_INTEGER });
      try {
        const current = readClaim(path, incidentId);
        const { next, result } = update(current);
        if (next !== current) {
          if (!lock.stillHeld()) throw new Error(`incident claim lock was lost before writing: ${incidentId}`);
          const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
          writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
          renameSync(temporary, path);
        }
        return result;
      } finally { lock.release(); }
    },
    async withCurrent<T>(input: { readonly incidentId: string; readonly claimToken: string; readonly now: () => number },
      action: () => T | Promise<T>, completeWhen?: (value: T) => boolean) {
      mkdirSync(directory, { recursive: true });
      const path = pathFor(input.incidentId);
      // Source: claim handoff must wait for an in-flight owner action to finish rather than time out and overlap it.
      const lock = await acquireLockAsync(`${path}.lock`, { breakDeadHolder: true, maxTries: Number.MAX_SAFE_INTEGER });
      try {
        const current = readClaim(path, input.incidentId);
        if (!current || current.claimToken !== input.claimToken || current.expiresAtMs <= input.now())
          return { current: false };
        const value = await action();
        if (!lock.stillHeld()) throw new Error(`incident claim lock was lost during action: ${input.incidentId}`);
        if (completeWhen?.(value)) {
          const completedAtMs = input.now();
          if (!Number.isSafeInteger(completedAtMs) || completedAtMs < 0)
            throw new Error(`incident claim completion clock is invalid: ${input.incidentId}`);
          const completed = { ...current, completedAtMs };
          if (!lock.stillHeld()) throw new Error(`incident claim lock was lost before completion: ${input.incidentId}`);
          const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
          writeFileSync(temporary, `${JSON.stringify(completed, null, 2)}\n`, { mode: 0o600 });
          renameSync(temporary, path);
        }
        return { current: true, value };
      } finally { lock.release(); }
    },
  };
}

/** Deterministic in-memory store for injected-time simulations and unit tests. */
export function createMemoryIncidentClaimStore(): IncidentClaimStore {
  const claims = new Map<string, IncidentClaim>();
  let tail = Promise.resolve();
  const serialized = async <T>(action: () => T | Promise<T>): Promise<T> => {
    const previous = tail;
    let unlock!: () => void;
    tail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try { return await action(); }
    finally { unlock(); }
  };
  return {
    transact<T>(incidentId: string, update: (current: IncidentClaim | null) => {
      readonly next: IncidentClaim | null;
      readonly result: T;
    }): Promise<T> {
      return serialized(() => {
        const { next, result } = update(claims.get(incidentId) ?? null);
        if (next) claims.set(incidentId, next);
        else claims.delete(incidentId);
        return result;
      });
    },
    withCurrent<T>(input: { readonly incidentId: string; readonly claimToken: string; readonly now: () => number },
      action: () => T | Promise<T>, completeWhen?: (value: T) => boolean) {
      return serialized(async () => {
        const current = claims.get(input.incidentId);
        if (!current || current.claimToken !== input.claimToken || current.expiresAtMs <= input.now())
          return { current: false };
        const value = await action();
        if (completeWhen?.(value)) {
          const completedAtMs = input.now();
          if (!Number.isSafeInteger(completedAtMs) || completedAtMs < 0)
            throw new Error(`incident claim completion clock is invalid: ${input.incidentId}`);
          claims.set(input.incidentId, { ...current, completedAtMs });
        }
        return { current: true, value };
      });
    },
  };
}
