import type { ProcessIdentity } from './peer-seat.js';

export type PrimaryBinding = { readonly pid: number; readonly start: string; readonly generation: string };
type Actor = { readonly pane: string; readonly seat: string };
type Entry = { readonly actor: Actor; readonly primary: PrimaryBinding; readonly identity: ProcessIdentity; child?: { readonly pid: number; readonly start: string } };

const validPrimary = (p: PrimaryBinding | undefined): p is PrimaryBinding => !!p
  && Number.isSafeInteger(p.pid) && p.pid > 1 && typeof p.start === 'string' && p.start.length > 0
  && typeof p.generation === 'string' && p.generation.length > 0;
const validIdentity = (p: ProcessIdentity | undefined): p is ProcessIdentity => !!p
  && Number.isSafeInteger(p.pid) && p.pid > 1 && Number.isSafeInteger(p.ppid) && p.ppid > 0
  && Number.isSafeInteger(p.session) && p.session > 0 && Number.isSafeInteger(p.tty) && p.tty >= 0
  && typeof p.start === 'string' && p.start.length > 0 && Number.isSafeInteger(p.startedMs) && p.startedMs > 0;
const samePrimary = (a: PrimaryBinding, b: PrimaryBinding): boolean =>
  a.pid === b.pid && a.start === b.start && a.generation === b.generation;
const sameIdentity = (a: ProcessIdentity, b: ProcessIdentity): boolean =>
  a.pid === b.pid && a.ppid === b.ppid && a.start === b.start && a.startedMs === b.startedMs
  && a.session === b.session && a.tty === b.tty;

/** In-memory owner-issued actor associations. No pane owner or request field implies a binding.
 * Only an already-authorized owner may call bind/unbind. binding and identity must be trusted,
 * server-observed live lookups, and resolve's baseline must come from the socket peer.
 * Owners must call unbind on pane release/replacement, even if its old generation is restored
 * before a resolve; no polling API can detect an unobserved ABA transition.
 * JUD #128532: issue binds the owner-approved direct child — exact pid and live-observed birth —
 * and resolve admits exactly that child; no first-arriving sibling of the same shell. */
export class ActorBindings {
  private readonly entries = new Map<string, Entry>();
  private readonly captures = new WeakMap<Actor, { entry: Entry; baseline: ProcessIdentity }>();
  constructor(
    private readonly binding: (pane: string) => PrimaryBinding | undefined,
    private readonly identity: (pid: number) => ProcessIdentity | undefined,
    private readonly shells?: () => readonly { readonly pane: string; readonly pid: number }[],
  ) {}

  issue(seat: string, pane: string, primaryPid: number, generation: string,
    approvedChild?: number | { readonly pid: number; readonly start: string }): boolean {
    return this.bind(pane, seat, primaryPid, generation, approvedChild);
  }

  revoke(pane: string): void { this.unbind(pane); }

  private bind(pane: string, seat: string, primaryPid: number, generation: string,
    approvedChild?: number | { readonly pid: number; readonly start: string }): boolean {
    // A failed replacement must not leave an older authority behind.
    this.entries.delete(pane);
    try {
      if (typeof pane !== 'string' || !pane.trim() || typeof seat !== 'string' || !seat.trim()) return false;
      const first = this.binding(pane);
      if (!validPrimary(first) || first.pid !== primaryPid || first.generation !== generation) return false;
      const primary = { ...first };
      const found = this.identity(primary.pid);
      if (!validIdentity(found) || found.pid !== primary.pid || found.start !== primary.start) return false;
      const identity = { ...found };
      const live = this.binding(pane), after = this.identity(primary.pid);
      if (!validPrimary(live) || !samePrimary(primary, live) || !validIdentity(after) || !sameIdentity(identity, after)) return false;
      // JUD #128532: the owner-approved direct child is pinned at issuance — its pid and
      // live-observed birth — never the first process to act on the pane.
      let child: { pid: number; start: string } | undefined;
      if (approvedChild !== undefined) {
        const childPid = typeof approvedChild === 'number' ? approvedChild : approvedChild.pid;
        const givenStart = typeof approvedChild === 'number' ? undefined : approvedChild.start;
        if (!Number.isSafeInteger(childPid) || childPid <= 1 || childPid === primary.pid) return false;
        if (givenStart !== undefined && (typeof givenStart !== 'string' || givenStart !== this.identity(childPid)?.start)) return false;
        const childFirst = this.identity(childPid);
        if (!validIdentity(childFirst) || childFirst.ppid !== primary.pid) return false;
        const childAgain = this.identity(childPid);
        if (!validIdentity(childAgain) || !sameIdentity(childFirst, childAgain)) return false;
        child = { pid: childFirst.pid, start: childFirst.start };
      }
      this.entries.set(pane, { actor: { pane, seat }, primary, identity, child });
      return true;
    } catch { return false; }
  }

  unbind(pane: string): void { this.entries.delete(pane); }

  /** Capture the exact issuance, not just pane and seat, for deferred work. */
  capture(pid: number | undefined, baseline: ProcessIdentity | undefined): Actor | undefined {
    const actor = this.resolve(pid, baseline);
    const entry = actor && this.entries.get(actor.pane);
    if (!actor || !entry || !baseline) return undefined;
    const captured = Object.freeze({ ...actor });
    this.captures.set(captured, { entry, baseline: { ...baseline } });
    return captured;
  }

  /** A revoked or reissued association never revives a previous queued authority. */
  isCurrent(actor: Actor): boolean {
    const capture = this.captures.get(actor);
    if (!capture) return false;
    const { entry, baseline } = capture;
    if (this.entries.get(entry.actor.pane) !== entry) return false;
    const live = this.resolve(baseline.pid, baseline);
    return !!live && live.pane === entry.actor.pane && live.seat === entry.actor.seat
      && this.entries.get(entry.actor.pane) === entry;
  }

  resolve(pid: number | undefined, baseline: ProcessIdentity | undefined): Actor | undefined {
    if (!validIdentity(baseline) || baseline.pid !== pid) return undefined;
    // Ambiguous associations are never resolved by iteration order.
    let result: Actor | undefined;
    for (const [pane, entry] of this.entries) {
      try {
        const live = this.binding(pane), current = this.identity(entry.primary.pid);
        if (!validPrimary(live) || !samePrimary(entry.primary, live) || !validIdentity(current)
          || !sameIdentity(entry.identity, current)) {
          this.entries.delete(pane);
          continue;
        }
        const peer = this.identity(pid!);
        if (!validIdentity(peer) || !sameIdentity(peer, baseline)) continue;
        // JUD #39484 ①: only the owner-approved direct child may act. A grandchild or any
        // remoter descendant of the pane primary is rejected without ancestor walking.
        if (entry.primary.pid !== pid) {
          if (!this.shells || !this.shells().some(s => s.pane === pane && s.pid === entry.primary.pid)) continue;
          if (peer.ppid !== entry.primary.pid) continue;
          // JUD #128532: only the child the owner approved at issuance — exact pid and birth —
          // may act. resolve never elects a first-arriving sibling of the same shell; a reused
          // pid with a new birth is an impostor; no approved child means no child authority.
          if (!entry.child || entry.child.pid !== peer.pid || entry.child.start !== peer.start) continue;
        } else if (!sameIdentity(entry.identity, baseline)) continue;
        const again = this.binding(pane), finalIdentity = this.identity(entry.primary.pid);
        if (!validPrimary(again) || !samePrimary(entry.primary, again) || !validIdentity(finalIdentity)
          || !sameIdentity(entry.identity, finalIdentity)) {
          this.entries.delete(pane);
          continue;
        }
        if (result) return undefined;
        const acting = this.identity(pid!);
        if (entry.primary.pid !== pid && (!validIdentity(acting) || !entry.child
          || acting.pid !== entry.child.pid || acting.start !== entry.child.start || !sameIdentity(acting, baseline))) return undefined;
        result = { ...entry.actor };
      } catch { this.entries.delete(pane); return undefined; }
    }
    return result;
  }
}
