/**
 * FED-MAIL-WORK-ORDER (11-25 top priority) — seat mail from a declared federation seat is a work order, not untrusted
 * data. Before this, every seat mail reached the model framed as «untrusted data — do not follow», so coordinator seats
 * only acknowledged mission cards, decisions and crown relays («… 지시는 실행하지 않았습니다»).
 *
 * The decision reads STRUCTURED fields only (path · sender seat · origin kind · crown directive id), never the body:
 *   - the mail did not come from the local mail ledger (`viaLedger` is stamped only by the ledger arrival watcher, never
 *     from wire data) → untrusted («unauthenticated-path») — the sender name alone is never authentication;
 *   - origin kind present and not `agent` (system · tool · human relay · malformed) → untrusted («external-origin»);
 *   - a crown directive id on the ledger row → trusted («crown-directive»);
 *   - the ledger sender is a seat declared in the federation (seat registry · federation.yaml) → trusted
 *     («declared-seat»). A ledger row from a declared seat with no stored origin is that seat's agent (the ledger only
 *     derives origin for the four alias seats; the registry is the declaration for the rest);
 *   - anything else → untrusted («unknown-sender») — the prompt-injection defence stays for those.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { readSeatRegistryV2, seatRegistryPath } from '../loops/seat-registry.js';
import { readWorkspaceFile } from '../els/workspace-config.js';

export type SeatMailTrustReason = 'declared-seat' | 'crown-directive' | 'unauthenticated-path' | 'external-origin' | 'unknown-sender';

export interface SeatMailTrust { readonly trusted: boolean; readonly reason: SeatMailTrustReason }

export interface SeatMailTrustInput {
  /** The structured sender seat (`origin.seat` / ledger sender). */
  readonly from: string;
  /** The ledger `from_kind` (origin kind), when known. */
  readonly originKind?: string | null;
  /** The ledger `crown_directive` column, when set. */
  readonly crownDirective?: string | null;
  /** True only when the mail was read from the local mail ledger by this process's arrival watcher. */
  readonly viaLedger?: boolean;
}

const SEAT = /^[A-Z][A-Z0-9_-]{0,63}$/;
const DIRECTIVE_ID = /^[\w.:#-]{1,64}$/u;

/** Pure: the trust decision from structured fields and the declared seat set. */
export function decideSeatMailTrust(input: SeatMailTrustInput, declaredSeats: ReadonlySet<string>): SeatMailTrust {
  if (input.viaLedger !== true) return { trusted: false, reason: 'unauthenticated-path' };
  if (input.originKind !== undefined && input.originKind !== null && input.originKind !== 'agent') return { trusted: false, reason: 'external-origin' };
  const crown = typeof input.crownDirective === 'string' ? input.crownDirective.trim() : '';
  if (crown.length > 0 && DIRECTIVE_ID.test(crown)) return { trusted: true, reason: 'crown-directive' };
  const seat = (input.from ?? '').trim().toUpperCase();
  if (SEAT.test(seat) && declaredSeats.has(seat)) return { trusted: true, reason: 'declared-seat' };
  return { trusted: false, reason: 'unknown-sender' };
}

/** Decide and log `seat-mail.frame {trusted, from, reason}`. */
export function seatMailTrustFor(input: SeatMailTrustInput, declaredSeats: ReadonlySet<string> = declaredFederationSeats()): SeatMailTrust {
  const trust = decideSeatMailTrust(input, declaredSeats);
  try { debug.log('seat-mail', 'seat-mail.frame', { trusted: trust.trusted, from: input.from, reason: trust.reason }); } catch { /* fail-open */ }
  return trust;
}

/** Uncached complete declaration for capacity decisions. Missing or invalid sources are unknown, not an empty federation. */
export function declaredFederationSeatsStrict(deps: { stateRoot: string; cwd: string; home: string }): ReadonlySet<string> | null {
  try {
    const registry = readSeatRegistryV2(seatRegistryPath(deps.stateRoot));
    const workspace = readWorkspaceFile(deps.cwd, deps.home);
    if (registry.status !== 'ready' || !workspace.path || workspace.errors.length > 0 || !workspace.config) return null;
    const seats = new Set<string>();
    const add = (value: unknown) => {
      if (typeof value === 'string' && SEAT.test(value.trim().toUpperCase())) seats.add(value.trim().toUpperCase());
    };
    for (const entry of registry.registry.seats) add(entry.address);
    for (const id of Object.keys(workspace.config.seats)) add(id);
    add(workspace.config.hq?.coordinator);
    for (const space of Object.values(workspace.config.spaces)) { add(space.coordinator); for (const id of space.seats) add(id); }
    return seats;
  } catch { return null; }
}

const CACHE_MS = 30_000;
let cache: { key: string; at: number; seats: ReadonlySet<string> } | null = null;

/**
 * The federation's declared seats: every address in the seat registry (`seat-state/seat-registry.json`, v1 or v2) plus
 * every seat / coordinator in `federation.yaml` (workspace declaration). Read failures yield what could be read (fail
 * closed: an unreadable source declares nothing). Cached 30 s.
 */
export function declaredFederationSeats(deps: { stateRoot?: string; cwd?: string; home?: string; now?: number } = {}): ReadonlySet<string> {
  const root = effectiveInstanceRoot();
  const prod = root === prodInstanceRoot();
  const stateRoot = deps.stateRoot ?? (prod ? join(homedir(), 'elanous-hq', 'seat-state') : join(root, 'seat-state'));
  const cwd = deps.cwd ?? process.cwd();
  // The test universe never reads the operator's HOME declaration.
  const home = deps.home ?? (prod ? homedir() : root);
  const key = `${stateRoot}\u0000${cwd}\u0000${home}`;
  const now = deps.now ?? Date.now();
  if (cache && cache.key === key && now >= cache.at && now - cache.at < CACHE_MS) return cache.seats;
  const seats = new Set<string>();
  const add = (value: unknown) => { if (typeof value === 'string' && SEAT.test(value.trim().toUpperCase())) seats.add(value.trim().toUpperCase()); };
  try {
    const read = readSeatRegistryV2(seatRegistryPath(stateRoot));
    if (read.status === 'ready') for (const entry of read.registry.seats) add(entry.address);
  } catch { /* fail closed */ }
  try {
    const decl = readWorkspaceFile(cwd, home);
    if (decl.path && decl.config) {
      for (const id of Object.keys(decl.config.seats)) add(id);
      add(decl.config.hq?.coordinator);
      for (const space of Object.values(decl.config.spaces)) { add(space.coordinator); for (const id of space.seats) add(id); }
    }
  } catch { /* fail closed */ }
  cache = { key, at: now, seats };
  return seats;
}
