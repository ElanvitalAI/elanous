// 수호자 (guardian) — host probe ⊕ PREGATE-HOST-BALANCE (LLM 0).
//
// S: 11-27 07:3x — node-b (32 cpu) load 135 while minim5 1.9/18, node-c 3.8/14, mbp 4.7/18 sat idle; the pregate launcher
//    allowed node-b/minim5/gcp2 only and `eln self gate --remote` always took gateRemote.host (node-b).
// C: placement never looked at load per core, and node-c/mbp were not candidates.
// A: `probeHost` reads 1-min load and ncpu (local or one ssh, 10 s bound); `pickHost` takes the reachable, unreserved
//    candidate with the lowest load/ncpu, local hosts before paid VMs (a paid VM is chosen only when no local host has
//    headroom and the caller allows it — the guardian escalates paid starts to OP instead).
import { spawnSync } from 'node:child_process';
import { cpus, hostname, loadavg } from 'node:os';
import { debug } from '../debug/log.js';
import { activeResourceLeases, readResourceLedger, recordWorldEvents, resourceLedgerPath, slotLeaseRecords, type ResourceLedgerEvent } from '../resource-ledger/resource-ledger.js';
import type { WorldActorEvent } from '../resource-ledger/world-ledger-events.js';
import { foldWorld } from '../resource-ledger/world-registry.js';
import type { WorldActor } from '../resource-ledger/world-types.js';

/** Local hosts first (free); paid VMs only as a last resort and never auto-started here. */
export const LOCAL_HOSTS = ['minim5', 'node-c', 'mbp', 'node-b'] as const;
export const PAID_HOSTS = ['aws1', 'aws2', 'gcp1', 'gcp2', 'gcp3'] as const;
/** The HQ canonical host never runs heavy work (HQ_HEAVY_FORBIDDEN). */
export const NEVER_ROUTE = new Set(['mshq']);
/** Headroom = load per core strictly under this. */
export const HEADROOM_RATIO = 1.0;

export interface HostProbe { readonly host: string; readonly reachable: boolean; readonly load1: number | null; readonly ncpu: number | null; readonly reserved?: boolean; readonly paid?: boolean; readonly why?: string }
export const ratio = (p: HostProbe): number => (p.load1 !== null && p.ncpu ? p.load1 / p.ncpu : Number.POSITIVE_INFINITY);
export const isPaid = (host: string): boolean => (PAID_HOSTS as readonly string[]).includes(host);

/** Pure: the least-loaded usable host — local before paid, then lowest load/ncpu, then candidate order. */
export function pickHost(probes: readonly HostProbe[], opts: { allowPaid?: boolean } = {}): { host: string | null; why: string; ranked: Array<{ host: string; ratio: number }> } {
  const usable = probes.filter(p => p.reachable && !p.reserved && !NEVER_ROUTE.has(p.host) && p.load1 !== null && p.ncpu && (opts.allowPaid || !(p.paid ?? isPaid(p.host))));
  const ranked = usable.map((p, i) => ({ p, i, r: ratio(p), paid: p.paid ?? isPaid(p.host) }))
    .sort((a, b) => Number(a.paid) - Number(b.paid) || a.r - b.r || a.i - b.i);
  const best = ranked[0];
  const skipped = probes.filter(p => !usable.includes(p)).map(p => `${p.host}:${!p.reachable ? 'unreachable' : p.reserved ? 'reserved' : NEVER_ROUTE.has(p.host) ? 'hq' : (p.paid ?? isPaid(p.host)) ? 'paid' : 'unmeasured'}`);
  return {
    host: best?.p.host ?? null,
    why: best ? `${best.p.host} load ${best.p.load1!.toFixed(1)}/${best.p.ncpu} = ${best.r.toFixed(2)}${skipped.length ? ` · skipped ${skipped.join(' ')}` : ''}` : `no usable host (${skipped.join(' ') || 'none probed'})`,
    ranked: ranked.map(x => ({ host: x.p.host, ratio: Math.round(x.r * 100) / 100 })),
  };
}

const short = (h: string) => h.split('.')[0]!.toLowerCase();
/** Live probe: this machine directly, others over one ssh (BatchMode · 10 s). Never throws. */
export function probeHost(host: string): HostProbe {
  if (short(hostname()) === host) return { host, reachable: true, load1: loadavg()[0]!, ncpu: cpus().length };
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'sysctl -n hw.ncpu 2>/dev/null || nproc; cat /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg'], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) return { host, reachable: false, load1: null, ncpu: null, why: (r.stderr || r.error?.message || `rc ${r.status}`).trim().slice(0, 80) };
  const lines = (r.stdout ?? '').trim().split('\n');
  const ncpu = Number(lines[0]); const load = Number((lines[1] ?? '').replace(/[{}]/gu, '').trim().split(/\s+/u)[0]);
  return Number.isFinite(ncpu) && ncpu > 0 && Number.isFinite(load) ? { host, reachable: true, load1: load, ncpu } : { host, reachable: false, load1: null, ncpu: null, why: 'unparsable probe' };
}

/** `eln res host pick` / self gate --remote: probe the candidates and pick (reserved hosts come from the caller). */
export function pickLiveHost(candidates: readonly string[] = LOCAL_HOSTS, opts: { reserved?: ReadonlySet<string>; allowPaid?: boolean; probe?: (h: string) => HostProbe } = {}): ReturnType<typeof pickHost> & { probes: HostProbe[] } {
  const probes = candidates.map(h => ({ ...(opts.probe ?? probeHost)(h), reserved: opts.reserved?.has(h) ?? false }));
  return { ...pickHost(probes, opts.allowPaid ? { allowPaid: true } : {}), probes };
}

// ── 임대관 host facts → WORLD-REGISTRY (CEO 10:5x «machines must be routed by the ledger») ──────────────────────
// kit/resource-facts (#40405) routes from the host rows; the 임대관 keeps them live each pulse: `health` (healthy · unhealthy ·
// reserved during a maintenance window) · `healthNote` · `ncpu` · `load1` · active `leases` · `factsAt`. Roles stay owner /
// policy-declared (resource-facts policy file) — the pulse never writes them, so a policy edit is never shadowed by a ledger row.

/** The facts the 임대관 writes into a host's world row (`meta`), in the resource-facts schema. */
export interface HostFacts { readonly health: 'healthy' | 'unhealthy' | 'reserved'; readonly healthNote?: string; readonly load1: number | null; readonly ncpu: number | null; readonly leases: number; readonly factsAt: string }

/** A rewrite is due at least this often even when nothing changed (the row's heartbeat). */
export const FACTS_REFRESH_MS = 5 * 60_000;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const prevFacts = (m: Record<string, unknown> | undefined): HostFacts | null => {
  if (!m || (m.health !== 'healthy' && m.health !== 'unhealthy' && m.health !== 'reserved') || typeof m.factsAt !== 'string') return null;
  return { health: m.health, ...(typeof m.healthNote === 'string' ? { healthNote: m.healthNote } : {}), load1: num(m.load1), ncpu: num(m.ncpu), leases: num(m.leases) ?? 0, factsAt: m.factsAt };
};
/** A host whose row says it is in a maintenance window (draining · maintenance) — set by the 임대관's maintenance planner. */
const inWindow = (m: Record<string, unknown> | undefined): boolean => {
  const w = m?.maintenance;
  return !!w && typeof w === 'object' && ((w as { phase?: unknown }).phase === 'draining' || (w as { phase?: unknown }).phase === 'maintenance');
};

/** Pure: one probe (+ the row's maintenance state) → the facts written to its world row. */
export function hostFacts(p: HostProbe, leases: number, at: string, maintenance = false): HostFacts {
  const measured = p.reachable && p.load1 !== null && !!p.ncpu;
  const health = maintenance ? 'reserved' as const : measured ? 'healthy' as const : 'unhealthy' as const;
  const note = maintenance ? 'maintenance window' : measured ? undefined : (p.why ?? (p.reachable ? 'unmeasured probe' : 'unreachable')).slice(0, 120);
  return { health, ...(note ? { healthNote: note } : {}), load1: p.load1, ncpu: p.ncpu, leases, factsAt: at };
}

/** Pure: rewrite only on a material change (health · leases · load/ncpu moved ≥ 0.25) or when the last write is ≥ FACTS_REFRESH_MS old. */
export function factsChanged(prev: HostFacts | null, next: HostFacts): boolean {
  if (!prev) return true;
  const r = (f: HostFacts) => (f.load1 !== null && f.ncpu ? f.load1 / f.ncpu : null);
  const pr = r(prev); const nr = r(next);
  return prev.health !== next.health || prev.leases !== next.leases
    || (pr === null) !== (nr === null) || (pr !== null && nr !== null && Math.abs(pr - nr) >= 0.25)
    || Date.parse(next.factsAt) - Date.parse(prev.factsAt) >= FACTS_REFRESH_MS;
}

/** Pure: active slot + resource leases per host from the lease ledger. */
export function leasesByHost(events: readonly ResourceLedgerEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of slotLeaseRecords(events)) if (l.state === 'active') out[short(l.host)] = (out[short(l.host)] ?? 0) + 1;
  for (const l of activeResourceLeases(events)) out[short(l.host)] = (out[short(l.host)] ?? 0) + 1;
  return out;
}

/** Pure: the world-actor events the 임대관 appends for this pulse's probes (changed rows only). */
export function hostFactsEvents(probes: readonly HostProbe[], actors: readonly Pick<WorldActor, 'id' | 'meta'>[], leases: Readonly<Record<string, number>>, now: Date, by = 'loop:guardian/lease'): WorldActorEvent[] {
  const at = now.toISOString();
  return probes.flatMap(p => {
    const id = `${isPaid(p.host) ? 'vm' : 'host'}:${p.host}`;
    const meta = actors.find(a => a.id === id)?.meta;
    const next = hostFacts(p, leases[p.host] ?? 0, at, inWindow(meta));
    if (!factsChanged(prevFacts(meta), next)) return [];
    return [{ event: 'world-actor' as const, at, by, actor: { id, kind: isPaid(p.host) ? 'vm' as const : 'host' as const, mode: 'owner' as const, registered: true, host: p.host, meta: { ...next, ...(next.healthNote ? {} : { healthNote: null }) } } }];
  });
}

/** Live (임대관 · each pulse): write the probes' facts into the world registry. Returns rows written; never throws. */
export function writeHostFacts(probes: readonly HostProbe[], now = new Date(), path = resourceLedgerPath()): number {
  try {
    const events = readResourceLedger(path);
    const rows = hostFactsEvents(probes, foldWorld(events, now).actors, leasesByHost(events), now);
    recordWorldEvents(rows, path);
    if (rows.length) { try { debug.log('guardian.lease', 'host-facts-written', { rows: rows.length, unhealthy: rows.filter(r => r.actor.meta?.health === 'unhealthy').map(r => r.actor.host).join(',') }); } catch { /* observe only */ } }
    return rows.length;
  } catch (e) {
    try { debug.log('guardian.lease', 'host-facts-write-failed', { error: (e as Error).message.slice(0, 200) }, { level: 'warn' }); } catch { /* observe only */ }
    return 0;
  }
}
