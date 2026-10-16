import type { RoleLeaseRead } from '../roles/role-lease.js';

export interface LeaseHolderSnapshot {
  holder: string | null;
  generation: number | null;
  iAmHolder: boolean;
  known: boolean;
}

export interface LeaseHolderView {
  get(options?: { fresh?: boolean }): Promise<LeaseHolderSnapshot>;
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
  const readSnapshot = async (): Promise<LeaseHolderSnapshot> => {
    let result: RoleLeaseRead;
    try { result = await read(); }
    catch { result = { kind: 'unmeasured', why: 'read failed' }; }
    return result.kind === 'present'
      ? { holder: result.doc.holder, generation: result.doc.generation, iAmHolder: result.doc.holder === machine, known: true }
      : { holder: null, generation: null, iAmHolder: false, known: false };
  };
  return {
    get(options) {
      if (options?.fresh) return readSnapshot();
      if (cached && now() - measuredAt < ttlMs) return Promise.resolve(cached);
      if (pending) return pending;
      pending = (async () => {
        const snapshot = await readSnapshot();
        cached = snapshot;
        measuredAt = now();
        return snapshot;
      })().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
