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
// `operator` = the same-UID local operator (#39875 door: e.g. Claude OP's terminal) — may hand, take and return.
export type BatonActor = { readonly kind: 'op' } | { readonly kind: 'operator' } | { readonly kind: 'seat'; readonly seat: string } | { readonly kind: 'other' };
export type BatonEvent = { readonly action: 'hand' | 'take' | 'return' | 'expire' | 'auto-hand' | 'auto-return' | 'auto-extend'; readonly at: string; readonly baton: ActingBaton; readonly actor: string; readonly handoff?: string };

/** ELS-BATON-AUTO-ON-RESTART (대표 11-24 04:4x · cell): the designated acting seat and the timings, in code (no flags). */
export const AUTO_ACTING_SEAT = 'TC';
/** ELS-BATON-ACTING-FALLBACK (OP 11-26): when TC is still restarting (or down) the update-all baton may go to one of
 * these instead, so OP is not skipped every rail because TC's turn boundary came after the deadline. */
export const AUTO_ACTING_FALLBACKS: readonly string[] = ['UX', 'JUD'];
/** Every seat an automatic hand may name. */
export const AUTO_ACTING_SEATS: readonly string[] = [AUTO_ACTING_SEAT, ...AUTO_ACTING_FALLBACKS];
/** Lease TTL at an automatic hand (cell: --ttl 15m). */
export const AUTO_TTL_MS = 15 * 60_000;
/** The new OP must register within this window, else the acting seat keeps the lease and one 🚨 goes out. */
export const AUTO_RETURN_DEADLINE_MS = 15 * 60_000;
/** How far the lease is pushed out each time the new OP is still missing (kept while the restart is unresolved). */
export const AUTO_EXTEND_MS = 30 * 60_000;
/** What the runtime remembers about an automatic hand; never exposed as a credential. */
export interface AutoBaton { readonly reason: string; readonly since: number; deadline: number; alerted: boolean }
export type BatonAlert = { readonly acting: string; readonly reason: string; readonly since: string; readonly expiresAt: string };
export class BatonLease {
  private current: ActingBaton | null = null;
  private auto: AutoBaton | null = null;
  constructor(private readonly audit: (event: BatonEvent) => void, private readonly clock: () => number = Date.now) {}

  /** The automatic hand in flight (null when the lease was handed by hand or is absent). */
  autoState(): Readonly<AutoBaton> | null { this.active(); return this.auto ? { ...this.auto } : null; }

  /**
   * Runtime hand right before the OP pane is stopped (update-all migration, seat relaunch, pane exit).
   * Idempotent: an active lease to the acting seat is kept (returns it, `handed: false`).
   */
  autoHand(reason: string, acting: string = AUTO_ACTING_SEAT): { baton: ActingBaton; handed: boolean } {
    const now = this.clock();
    if (!Number.isFinite(now)) throw new Error('invalid clock');
    if (!AUTO_ACTING_SEATS.includes(acting)) throw new Error(`acting seat must be one of ${AUTO_ACTING_SEATS.join(', ')}`);
    this.expire(now);
    const line = typeof reason === 'string' ? reason.replace(/[\r\n]+/g, ' ').trim().slice(0, 480) : '';
    if (!line) throw new Error('one-line reason required');
    if (this.current) {
      if (!AUTO_ACTING_SEATS.includes(this.current.acting)) throw new Error('baton already active');
      return { baton: { ...this.current }, handed: false };
    }
    const baton: ActingBaton = { owner: 'OP', acting, reason: `OP restart ${line}`, expiresAt: new Date(now + AUTO_TTL_MS).toISOString() };
    this.audit({ action: 'auto-hand', at: new Date(now).toISOString(), baton: { ...baton }, actor: 'runtime' });
    this.current = baton;
    this.auto = { reason: baton.reason, since: now, deadline: now + AUTO_RETURN_DEADLINE_MS, alerted: false };
    return { baton: { ...baton }, handed: true };
  }

  /** The new OP registered: give the automatic lease back with a handoff memo. A manual lease is left alone. */
  autoReturn(handoff: string): boolean {
    const now = this.clock();
    if (!Number.isFinite(now)) return false;
    this.expire(now);
    const baton = this.current;
    if (!baton || !this.auto) return false;
    const memo = (typeof handoff === 'string' ? handoff.replace(/[\r\n]+/g, ' ').trim() : '').slice(0, 4096) || 'auto-return';
    this.audit({ action: 'auto-return', at: new Date(now).toISOString(), baton: { ...baton }, actor: 'runtime', handoff: memo });
    this.current = null;
    this.auto = null;
    return true;
  }

  /** Once a second: a missed registration deadline keeps the lease with the acting seat; the first miss returns one alert. */
  tick(): BatonAlert | null {
    const now = this.clock();
    if (!Number.isFinite(now)) return null;
    const auto = this.auto;
    const baton = this.current;
    if (!auto || !baton) { this.expire(now); return null; }
    // Extend before expiry so the acting seat never drops authority while the new OP is missing.
    const missed = now >= auto.deadline;
    if (!missed && Date.parse(baton.expiresAt) - now > 60_000) return null;
    const extended: ActingBaton = { ...baton, expiresAt: new Date(now + AUTO_EXTEND_MS).toISOString() };
    this.current = extended;
    if (missed) auto.deadline = Number.POSITIVE_INFINITY;
    this.audit({ action: 'auto-extend', at: new Date(now).toISOString(), baton: { ...extended }, actor: 'runtime' });
    if (!missed || auto.alerted) return null;
    auto.alerted = true;
    return { acting: extended.acting, reason: auto.reason, since: new Date(auto.since).toISOString(), expiresAt: extended.expiresAt };
  }

  private expire(now: number): void {
    if (!this.current || Date.parse(this.current.expiresAt) > now) return;
    const baton = this.current;
    // Expiry must revoke authority even when the audit sink is unavailable.
    this.current = null;
    this.auto = null;
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
    if (actor.kind !== 'op' && actor.kind !== 'operator') throw new Error('authenticated OP required');
    if (this.current) throw new Error('baton already active');
    if (owner !== 'OP' || acting !== 'TC') throw new Error('only OP to TC is supported');
    if (typeof reason !== 'string' || !reason.trim() || /[\r\n]/.test(reason) || reason.length > 512) throw new Error('one-line reason required');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1000) throw new Error('invalid TTL');
    const baton: ActingBaton = { owner, acting, reason: reason.trim(), expiresAt: new Date(now + ttlMs).toISOString() };
    this.audit({ action: 'hand', at: new Date(now).toISOString(), baton: { ...baton }, actor: actor.kind === 'operator' ? 'operator' : 'OP' });
    this.current = baton;
    return { ...baton };
  }
  end(action: 'take' | 'return', actor: BatonActor, owner: string, handoff: string): void {
    const now = this.clock();
    if (!Number.isFinite(now)) throw new Error('invalid clock');
    this.expire(now);
    const baton = this.current;
    if (!baton || owner !== baton.owner) throw new Error('no active baton');
    if (actor.kind !== 'operator' && (action === 'take' ? actor.kind !== 'op' : actor.kind !== 'seat' || actor.seat !== baton.acting))
      throw new Error('unauthorized baton return');
    if (typeof handoff !== 'string' || !handoff.trim() || handoff.length > 4096) throw new Error('handoff required');
    this.audit({ action, at: new Date(now).toISOString(), baton: { ...baton }, actor: actor.kind === 'operator' ? 'operator' : action === 'take' ? 'OP' : baton.acting, handoff: handoff.trim() });
    this.current = null;
    this.auto = null;
  }
}
