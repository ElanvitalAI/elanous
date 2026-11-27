// WORLD-REGISTRY view — the world's actors folded from the lease ledger (`world-actor` ⊕ `world-sweep` events).
// No store of its own: `foldWorld(readResourceLedger())` is the registry. Writers are the guardian and its sub-agents
// (맥박 · 임대관 · 연료관 · 열쇠지기 · 대식세포 · 순찰대 · 우체국) plus owners for their own rows; coordinators read.
// Faces: observe = the ledger lines themselves are the audit trail (`eln world show <id>` lists them) ·
//        judge = `judgeActor` (pure, against now) · heal = nothing is deleted (retire=never); a lapsed actor turns
//        zombie/off and an owner revives it with one `world-actor` line.
import type { ResourceLedgerEvent } from './resource-ledger.js';
import type { WorldActorFields, WorldLedgerEvent, WorldSweepEvent } from './world-ledger-events.js';
import type { DeclaredState, WorldActor, WorldAnomaly, WorldKind, WorldState } from './world-types.js';

/** Kinds a host probe enumerates directly — absent from a successful probe means «not running there». */
export const HOST_SWEPT_KINDS: readonly WorldKind[] = ['launchd', 'cron', 'process', 'test-universe'];
/** Kinds whose absence from a successful enumeration is judged (host probe ⊕ els pane list). */
export const SWEPT_KINDS: readonly WorldKind[] = [...HOST_SWEPT_KINDS, 'pane'];
/** The sweep scope for registry-level sources (loops · beats · els panes · host-registry). */
export const REGISTRIES_SCOPE = 'registries';

type Judged = Pick<WorldActor, 'kind' | 'registered' | 'declaredState' | 'present' | 'heartbeatAt' | 'heartbeatSource' | 'slaMin' | 'seenAt'>;

/** Pure: the state an actor is in now. */
export function judgeActor(a: Judged, now: Date): { state: WorldState; reason: string } {
  if (!a.registered) {
    return a.present ? { state: 'unregistered', reason: 'running/present but no owner registered it' } : { state: 'off', reason: 'unregistered and not seen in the last sweep' };
  }
  if (a.declaredState === 'off') return { state: 'off', reason: 'declared off by owner' };
  if (a.kind === 'pane' && !a.present && a.seenAt) return { state: 'off', reason: `pane closed (not listed by els since ${a.seenAt})` };
  if (SWEPT_KINDS.includes(a.kind) && !a.present && a.seenAt) return { state: 'zombie', reason: `registered but not found on its host since ${a.seenAt}` };
  if (a.slaMin !== null && a.slaMin > 0) {
    const ms = a.heartbeatAt ? Date.parse(a.heartbeatAt) : NaN;
    if (!Number.isFinite(ms)) return { state: 'zombie', reason: `no heartbeat ever (source ${a.heartbeatSource ?? 'none'} · SLA ${a.slaMin}m)` };
    const ageMin = (now.getTime() - ms) / 60_000;
    if (ageMin > a.slaMin) return { state: 'zombie', reason: `heartbeat ${Math.round(ageMin)}m old > SLA ${a.slaMin}m (source ${a.heartbeatSource ?? 'none'})` };
  }
  return { state: a.declaredState, reason: a.declaredState === 'shadow' ? 'declared shadow' : 'registered and beating' };
}

const OWNER_FIELDS = ['purpose', 'owner', 'subject', 'wake', 'kpi', 'heartbeatSource', 'slaMin'] as const;
const FIELDS = [...OWNER_FIELDS, 'host'] as const;

type Mutable = { -readonly [K in keyof WorldActor]: WorldActor[K] } & { scope: string | null; registeredBy: string | null };

function blank(id: string, kind: WorldKind, at: string): Mutable {
  return { id, kind, purpose: null, owner: null, subject: null, wake: null, kpi: null, heartbeatSource: null, heartbeatAt: null, slaMin: null,
    host: null, registered: false, declaredState: 'live', state: 'off', reason: null, present: false, seenAt: null, createdAt: at, updatedAt: at,
    retire: 'never', meta: {}, scope: null, registeredBy: null };
}

/** Pure: merge one declaration. Owner writes win; a discovery never sets `registered`, never overwrites a registered row's
 *  owner fields, and never moves a registered row's owner-chosen heartbeat source. */
export function applyActor(prev: Mutable | undefined, a: WorldActorFields, at: string, by: string): Mutable {
  const n: Mutable = prev ? { ...prev, meta: { ...prev.meta } } : blank(a.id, a.kind, at);
  if (a.mode === 'owner') {
    n.kind = a.kind;
    if (a.registered !== undefined) { n.registered = a.registered; if (a.registered) n.registeredBy = by; }
    if (a.declaredState !== undefined) n.declaredState = a.declaredState as DeclaredState;
  }
  for (const k of FIELDS) {
    const v = a[k];
    if (v === undefined) continue;
    if (a.mode === 'discover' && n.registered && (OWNER_FIELDS as readonly string[]).includes(k) && n[k] !== null) continue;
    (n as Record<string, unknown>)[k] = v;
  }
  if (a.meta) n.meta = { ...n.meta, ...a.meta };
  n.updatedAt = at;
  return n;
}

export interface SweepRecord { scope: string; at: string; ok: boolean; error: string | null; counts: Record<string, number> }

export interface WorldView { actors: WorldActor[]; sweeps: SweepRecord[] }

const isWorld = (e: ResourceLedgerEvent | WorldLedgerEvent): e is WorldLedgerEvent => e.event === 'world-actor' || e.event === 'world-sweep' || e.event === 'world-control';

/** Pure: fold the lease ledger into the world (state judged against `now`). */
export function foldWorld(events: readonly (ResourceLedgerEvent | WorldLedgerEvent)[], now: Date): WorldView {
  const m = new Map<string, Mutable>();
  const lastOk = new Map<string, string>();
  const sweeps = new Map<string, SweepRecord>();
  for (const e of events) {
    if (!isWorld(e)) continue;
    if (e.event === 'world-actor') { m.set(e.actor.id, applyActor(m.get(e.actor.id), e.actor, e.at, e.by)); continue; }
    if (e.event === 'world-control') continue; // audit only — an applied control also writes the declaredState it caused
    applySweep(m, lastOk, e);
    sweeps.set(e.scope, { scope: e.scope, at: e.at, ok: e.ok, error: e.error ?? null, counts: e.counts });
  }
  const actors: WorldActor[] = [];
  for (const a of m.values()) {
    if (a.present && a.scope) {
      const seen = lastOk.get(a.scope) ?? a.seenAt;
      a.seenAt = seen;
      if (a.heartbeatSource === 'seen' && seen && (!a.heartbeatAt || Date.parse(seen) > Date.parse(a.heartbeatAt))) a.heartbeatAt = seen;
    }
    const j = judgeActor(a, now);
    const { scope: _s, registeredBy: _r, ...rest } = a;
    actors.push({ ...rest, state: j.state, reason: j.reason });
  }
  actors.sort((x, y) => x.kind.localeCompare(y.kind) || x.id.localeCompare(y.id));
  return { actors, sweeps: [...sweeps.values()].sort((x, y) => x.scope.localeCompare(y.scope)) };
}

function applySweep(m: Map<string, Mutable>, lastOk: Map<string, string>, e: WorldSweepEvent): void {
  if (!e.ok) return; // an unreachable scope keeps its rows' last presence — no false zombies from a network blip
  lastOk.set(e.scope, e.at);
  for (const id of e.appeared) { const a = m.get(id); if (a) { a.present = true; a.seenAt = e.at; a.scope = e.scope; } }
  for (const id of e.gone) { const a = m.get(id); if (a) { a.present = false; a.scope = e.scope; } }
  for (const [id, at] of Object.entries(e.beats)) {
    const a = m.get(id);
    if (a && (!a.heartbeatAt || Date.parse(at) > Date.parse(a.heartbeatAt))) a.heartbeatAt = at;
  }
}

/** Ledger lines that touch one actor — its audit trail. */
export function eventsFor(events: readonly (ResourceLedgerEvent | WorldLedgerEvent)[], id: string): WorldLedgerEvent[] {
  return events.filter(isWorld).filter(e => e.event === 'world-actor' ? e.actor.id === id : e.event === 'world-control' ? e.actorId === id
    : (e.appeared.includes(id) || e.gone.includes(id) || id in e.beats));
}

/** Pure over the view: what OP must look at. */
export function anomaliesOf(view: WorldView): WorldAnomaly[] {
  const out: WorldAnomaly[] = [];
  for (const a of view.actors) {
    if (a.state === 'unregistered') out.push({ id: a.id, kind: 'unregistered', actorKind: a.kind, host: a.host, reason: a.reason ?? 'unregistered' });
    else if (a.state === 'zombie') out.push({ id: a.id, kind: 'zombie', actorKind: a.kind, host: a.host, reason: a.reason ?? 'zombie' });
    if (a.registered && a.declaredState !== 'off' && !a.owner) out.push({ id: a.id, kind: 'no-owner', actorKind: a.kind, host: a.host, reason: 'registered without an owner' });
  }
  for (const s of view.sweeps) if (!s.ok) out.push({ id: `host:${s.scope}`, kind: 'unreachable', actorKind: 'host', host: s.scope, reason: `sweep failed at ${s.at}: ${s.error ?? 'unknown'}` });
  return out;
}

export interface WorldSummary { live: number; shadow: number; off: number; zombie: number; unregistered: number; noOwner: number; total: number }

export function summarize(actors: readonly WorldActor[]): WorldSummary {
  const s: WorldSummary = { live: 0, shadow: 0, off: 0, zombie: 0, unregistered: 0, noOwner: 0, total: actors.length };
  for (const a of actors) {
    s[a.state]++;
    if (a.registered && a.declaredState !== 'off' && !a.owner) s.noOwner++;
  }
  return s;
}

/** The one-line world summary for OP surfaces (fed snapshot · pulse). */
export function summaryLine(s: WorldSummary): string {
  return `세계: live ${s.live} · zombie ${s.zombie} · unregistered ${s.unregistered} · no-owner ${s.noOwner} (shadow ${s.shadow} · off ${s.off} · total ${s.total})`;
}

/** Pure: does a declaration change anything the fold would show? (keeps the ledger free of no-op lines) */
export function declarationChanges(prev: WorldActor | undefined, a: WorldActorFields): boolean {
  if (!prev) return true;
  if (a.mode === 'owner' && a.kind !== prev.kind) return true;
  if (a.mode === 'owner' && a.registered !== undefined && a.registered !== prev.registered) return true;
  if (a.mode === 'owner' && a.declaredState !== undefined && a.declaredState !== prev.declaredState) return true;
  for (const k of FIELDS) {
    const v = a[k];
    if (v === undefined) continue;
    if (a.mode === 'discover' && prev.registered && (OWNER_FIELDS as readonly string[]).includes(k) && prev[k] !== null) continue;
    if (v !== prev[k]) return true;
  }
  if (a.meta) for (const [k, v] of Object.entries(a.meta)) if (JSON.stringify(prev.meta[k]) !== JSON.stringify(v)) return true;
  return false;
}
