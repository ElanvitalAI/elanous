import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ActingBaton {
  readonly owner: string;
  readonly acting: string;
  readonly expiresAt: string;
  readonly reason: string;
}

/** Read a snapshot, not a credential. Callers must separately authenticate its provenance. */
export function readActiveBaton(stateRoot: string, now: number): ActingBaton | null {
  if (!Number.isFinite(now)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(join(stateRoot, 'baton.json'), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const seat = /^[A-Z][A-Z0-9_-]{0,63}$/;
    if (typeof row.owner !== 'string' || !seat.test(row.owner)
      || typeof row.acting !== 'string' || !seat.test(row.acting) || row.acting === row.owner
      || typeof row.reason !== 'string' || !row.reason.trim() || /[\r\n]/.test(row.reason)
      || typeof row.expiresAt !== 'string') return null;
    const expires = Date.parse(row.expiresAt);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.expiresAt)
      || !Number.isFinite(expires) || expires <= now) return null;
    return { owner: row.owner, acting: row.acting, expiresAt: row.expiresAt, reason: row.reason };
  } catch { return null; }
}

/** Server-process lease only. Never hydrate this from the display snapshot. */
export type BatonActor = { readonly kind: 'op' } | { readonly kind: 'seat'; readonly seat: string } | { readonly kind: 'other' };
export type BatonEvent = { readonly action: 'hand' | 'take' | 'return' | 'expire'; readonly at: string; readonly baton: ActingBaton; readonly actor: string; readonly handoff?: string };
export class BatonLease {
  private current: ActingBaton | null = null;
  constructor(private readonly audit: (event: BatonEvent) => void, private readonly clock: () => number = Date.now) {}

  private expire(now: number): void {
    if (!this.current || Date.parse(this.current.expiresAt) > now) return;
    const baton = this.current;
    // Expiry must revoke authority even when the audit sink is unavailable.
    this.current = null;
    this.audit({ action: 'expire', at: new Date(now).toISOString(), baton, actor: 'server' });
  }
  active(): ActingBaton | null {
    const now = this.clock();
    if (!Number.isFinite(now)) return null;
    this.expire(now);
    return this.current ? { ...this.current } : null;
  }
  hand(actor: BatonActor, owner: string, acting: string, reason: string, ttlMs: number): ActingBaton {
    const now = this.clock();
    if (!Number.isFinite(now)) throw new Error('invalid clock');
    this.expire(now);
    if (actor.kind !== 'op') throw new Error('authenticated OP required');
    if (this.current) throw new Error('baton already active');
    if (owner !== 'OP' || acting !== 'TC') throw new Error('only OP to TC is supported');
    if (typeof reason !== 'string' || !reason.trim() || /[\r\n]/.test(reason) || reason.length > 512) throw new Error('one-line reason required');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1000) throw new Error('invalid TTL');
    const baton: ActingBaton = { owner, acting, reason: reason.trim(), expiresAt: new Date(now + ttlMs).toISOString() };
    this.audit({ action: 'hand', at: new Date(now).toISOString(), baton: { ...baton }, actor: 'OP' });
    this.current = baton;
    return { ...baton };
  }
  end(action: 'take' | 'return', actor: BatonActor, owner: string, handoff: string): void {
    const now = this.clock();
    if (!Number.isFinite(now)) throw new Error('invalid clock');
    this.expire(now);
    const baton = this.current;
    if (!baton || owner !== baton.owner) throw new Error('no active baton');
    if (action === 'take' ? actor.kind !== 'op' : actor.kind !== 'seat' || actor.seat !== baton.acting)
      throw new Error('unauthorized baton return');
    if (typeof handoff !== 'string' || !handoff.trim() || handoff.length > 4096) throw new Error('handoff required');
    this.audit({ action, at: new Date(now).toISOString(), baton: { ...baton }, actor: action === 'take' ? 'OP' : baton.acting, handoff: handoff.trim() });
    this.current = null;
  }
}
