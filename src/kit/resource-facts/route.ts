// RESOURCE-FACTS machine routing — «머신들도 원장에 의해서 라우팅되게» (CEO 11-27 10:5x).
// Candidates come from the facts (role ⊕ health ⊕ paid approval ⊕ never-HQ-for-heavy); the choice reuses the guardian's
// pure `pickHost` (least load/ncpu, local before paid). Lease availability: a host whose active host slot leases reached
// its RES capacity row is treated as reserved. A host marked unhealthy / reserved / declared off / paid-not-approved in the
// registry or the policy file disappears from every caller without a code change.
import { pickHost as guardianPick, probeHost, type HostProbe } from '../../guardian-agent/hosts.js';
import { resourceFacts } from './facts.js';
import type { HostFact, HostRole, ResourceFacts } from './types.js';

export const ROUTE_PURPOSES = ['pregate', 'full-gate', 'tsc', 'test-run', 'ta-launch', 'hand-placement', 'review', 'burst'] as const;
export type RoutePurpose = typeof ROUTE_PURPOSES[number];
export const isRoutePurpose = (v: unknown): v is RoutePurpose => typeof v === 'string' && (ROUTE_PURPOSES as readonly string[]).includes(v);

export const PURPOSE_ROLE: Readonly<Record<RoutePurpose, HostRole>> = {
  pregate: 'gate', 'full-gate': 'gate', tsc: 'gate', 'test-run': 'test', 'ta-launch': 'hand', 'hand-placement': 'hand', review: 'review', burst: 'burst',
};
/** Purposes that are heavy (never on the HQ host whatever its roles say). */
const HEAVY: ReadonlySet<RoutePurpose> = new Set(['pregate', 'full-gate', 'tsc', 'test-run', 'review', 'burst']);

export interface Eligibility { readonly host: string; readonly ok: boolean; readonly why: string; readonly fact: HostFact }

/** Pure: is this host routable for the purpose, and why not. */
export function eligibility(f: HostFact, purpose: RoutePurpose): Eligibility {
  const role = PURPOSE_ROLE[purpose];
  const no = (why: string): Eligibility => ({ host: f.host, ok: false, why, fact: f });
  if (!f.roles.includes(role)) return no(`no role ${role}`);
  if (f.health === 'unhealthy') return no(`unhealthy${f.note ? ` (${f.note})` : ''}`);
  if (f.health === 'reserved') return no(`reserved${f.note ? ` (${f.note})` : ''}`);
  if (f.hq && HEAVY.has(purpose)) return no('HQ host never runs heavy work');
  // A paid VM is routed only once OP/RES approved it in the registry or policy — no caller flag bypasses that.
  if (f.paid && !f.paidApproved) return no('paid VM not approved');
  return { host: f.host, ok: true, why: `role ${role} · ${f.health} · ${f.source}`, fact: f };
}

/** Pure over facts: the routable hosts for a purpose, in priority order. Sync — for callers that only need the list. */
export function hostsFor(purpose: RoutePurpose, opts: { exclude?: readonly string[]; facts?: ResourceFacts } = {}): string[] {
  const facts = opts.facts ?? resourceFacts();
  const ex = new Set((opts.exclude ?? []).map(h => h.toLowerCase()));
  return facts.hosts.filter(f => !ex.has(f.host.toLowerCase()) && eligibility(f, purpose).ok).map(f => f.host);
}

/** Pure: may this host be used for the purpose (e.g. a `--host` the caller was given)? */
export function hostAllowed(host: string, purpose: RoutePurpose, facts: ResourceFacts = resourceFacts()): Eligibility | null {
  const f = facts.hosts.find(h => h.host.toLowerCase() === host.toLowerCase());
  return f ? eligibility(f, purpose) : null;
}

/** Hosts whose active host slot leases reached their RES capacity (live read · never throws). */
export function leaseFullHosts(ledgerPath?: string): Set<string> {
  try {
    const r = require('../../resource-ledger/resource-ledger.js') as typeof import('../../resource-ledger/resource-ledger.js');
    const events = r.readResourceLedger(ledgerPath ?? r.resourceLedgerPath());
    const active = new Map<string, number>();
    for (const l of r.slotLeaseRecords(events)) if (l.kind === 'host' && l.state === 'active') active.set(l.host, (active.get(l.host) ?? 0) + 1);
    const full = new Set<string>();
    for (const [host, n] of active) { const cap = r.latestSlotCapacityPolicy(events, 'host', host)?.capacity; if (cap !== undefined && n >= cap) full.add(host); }
    return full;
  } catch { return new Set(); }
}

export interface PickOptions {
  readonly exclude?: readonly string[];
  /** Minimum free cores (ncpu − load1) the host must have. */
  readonly needCpu?: number;
  readonly facts?: ResourceFacts;
  /** Probe override (tests / sims); default = guardian probeHost (local or one ssh, 10 s). */
  readonly probe?: (host: string) => HostProbe;
  /** Lease-full hosts override; default = live ledger read. */
  readonly leaseFull?: ReadonlySet<string>;
}

export interface PickResult {
  readonly purpose: RoutePurpose;
  readonly host: string | null;
  readonly why: string;
  readonly candidates: readonly string[];
  readonly skipped: ReadonlyArray<{ host: string; why: string }>;
  readonly ranked: ReadonlyArray<{ host: string; ratio: number }>;
  readonly warnings: readonly string[];
}

/** Pick one host for a purpose: facts → candidates → live probe → guardian pick. Never throws. */
export function pickHost(purpose: RoutePurpose, opts: PickOptions = {}): PickResult {
  const facts = opts.facts ?? resourceFacts();
  const ex = new Set((opts.exclude ?? []).map(h => h.toLowerCase()));
  const skipped: Array<{ host: string; why: string }> = [];
  const cands: HostFact[] = [];
  for (const f of facts.hosts) {
    if (ex.has(f.host.toLowerCase())) { skipped.push({ host: f.host, why: 'excluded by caller' }); continue; }
    const e = eligibility(f, purpose);
    if (e.ok) cands.push(f); else skipped.push({ host: f.host, why: e.why });
  }
  const leaseFull = opts.leaseFull ?? leaseFullHosts();
  const probe = opts.probe ?? probeHost;
  const probes: HostProbe[] = cands.map(f => {
    let p: HostProbe;
    try { p = probe(f.host); } catch (e) { p = { host: f.host, reachable: false, load1: null, ncpu: null, why: (e as Error).message }; }
    const ncpu = p.ncpu ?? f.ncpu;
    const tooSmall = opts.needCpu !== undefined && p.load1 !== null && ncpu !== null && ncpu - p.load1 < opts.needCpu;
    if (tooSmall) skipped.push({ host: f.host, why: `free cpu ${(ncpu! - p.load1!).toFixed(1)} < need ${opts.needCpu}` });
    if (leaseFull.has(f.host)) skipped.push({ host: f.host, why: 'host leases at capacity' });
    if (!p.reachable) skipped.push({ host: f.host, why: `unreachable${p.why ? ` (${p.why})` : ''}` });
    return { ...p, ncpu, paid: f.paid, reserved: tooSmall || leaseFull.has(f.host) };
  });
  // Priority breaks ties: guardianPick keeps candidate order among equal ratios, and cands are already priority-sorted.
  // Paid approval was decided by `eligibility` above (an approved VM is a candidate); guardianPick still ranks local first.
  const g = guardianPick(probes, { allowPaid: true });
  return {
    purpose, host: g.host, why: g.host ? g.why : `no host for ${purpose}: ${skipped.map(s => `${s.host}:${s.why}`).join(' · ') || 'no candidates'}`,
    candidates: cands.map(f => f.host), skipped, ranked: g.ranked, warnings: facts.warnings,
  };
}

/** Pure over facts: keep the hosts of a caller-supplied list (config · flag) that the registry does not rule out for the
 *  purpose. A host the facts do not know is kept (the caller named it on purpose); a known host that is unhealthy /
 *  reserved / off / paid-not-approved / HQ-for-heavy is dropped. Order is preserved. */
export function filterRoutable(hosts: readonly string[], purpose: RoutePurpose, facts: ResourceFacts = resourceFacts()): string[] {
  return hosts.filter(h => { const e = hostAllowed(h, purpose, facts); return e === null || e.ok; });
}

/** Paid VMs the facts know (approved or not) with the role the purpose needs — for callers that *propose* a cloud start. */
export function paidHostsFor(purpose: RoutePurpose, facts: ResourceFacts = resourceFacts()): string[] {
  const role = PURPOSE_ROLE[purpose];
  return facts.hosts.filter(f => f.paid && f.health !== 'unhealthy' && f.health !== 'reserved' && (f.roles.includes(role) || f.roles.includes('burst'))).map(f => f.host);
}

/** Every non-paid host the facts know (any role) — inventories / dashboards. */
export function localHosts(facts: ResourceFacts = resourceFacts()): string[] {
  return facts.hosts.filter(f => !f.paid).map(f => f.host);
}

/** The HQ host(s) — heavy work never runs there. */
export function hqHosts(facts: ResourceFacts = resourceFacts()): string[] {
  return facts.hosts.filter(f => f.hq).map(f => f.host);
}
