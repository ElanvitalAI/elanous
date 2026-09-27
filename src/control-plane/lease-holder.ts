import type { RoleLeaseRead } from '../roles/role-lease.js';

export interface LeaseHolderSnapshot {
  holder: string | null;
  generation: number | null;
  iAmHolder: boolean;
  known: boolean;
}

export interface LeaseHolderView {
  get(): Promise<LeaseHolderSnapshot>;
}

export function createLeaseHolderView({ machine, read, ttlMs = 10_000, now = Date.now }: {
  machine: string;
  read: () => RoleLeaseRead | Promise<RoleLeaseRead>;
  ttlMs?: number;
  now?: () => number;
}): LeaseHolderView {
  let cached: LeaseHolderSnapshot | undefined;
  let measuredAt = 0;
  let pending: Promise<LeaseHolderSnapshot> | undefined;
  return {
    get() {
      if (cached && now() - measuredAt < ttlMs) return Promise.resolve(cached);
      if (pending) return pending;
      pending = (async () => {
        let result: RoleLeaseRead;
        try { result = await read(); }
        catch { result = { kind: 'unmeasured', why: 'read failed' }; }
        const snapshot: LeaseHolderSnapshot = result.kind === 'present'
          ? { holder: result.doc.holder, generation: result.doc.generation, iAmHolder: result.doc.holder === machine, known: true }
          : { holder: null, generation: null, iAmHolder: false, known: false };
        cached = snapshot;
        measuredAt = now();
        return snapshot;
      })().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
