/**
 * RES-CAPACITY-LEASE (대표 11-25 22:4x «I asked for a resource SIZE (e.g. a 128 GB machine), not a host — choose a machine
 * freely and get it ready»).
 *
 * A capacity request ({ramGiB, cpu?, ttl, count, budget}) → a host pick by policy → the existing lease graph
 * (graphs/triggers/res-burst-lease.yaml: start → ready checks → register → TTL stop).
 *
 * Policy, in order:
 *   1. local/LAN hosts that fit, are leasable, not reserved for the release and not overloaded → zero cost
 *   2. cloud hosts that fit, have a fresh ready row (ready pool) and no live lease
 *   3. the cheapest cloud host that fits but is stopped / not verified (the lease graph runs ready checks first)
 *   tie-break inside a tier: ready → cost/hour → load per cpu → name.
 * Cloud spend (rate × ttl × count) must fit `--budget` or policy.cloudBudgetUsd, else the decision is `needs-ceo`
 * (a 대표 card, nothing started). Nothing fits → `refused` with the options that would make it fit.
 *
 * The host catalog = defaults below ⊕ `{root}/host-catalog.json` (discovered: ssh sysctl/proc, cloud type → specs
 * via cloud-vm.sh map) ⊕ `{root}/host-catalog.config.json` (hand overrides + policy). Planning is pure; discovery
 * and the lease write are separate so the sim world drives the planner on fixtures.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isReady, liveLease, loadLeases, loadReservation, READY_MAX_AGE_DAYS, receipt, saveLeases, type Lease } from './burst.js';

export type HostKind = 'local' | 'lan' | 'cloud';
export interface HostSpec {
  host: string; kind: HostKind; ramGiB: number; cpu: number; diskGiB?: number | null;
  /** Cloud instance type (rates come from cloud-rates.tsv by type). */
  type?: string | null; ratePerHourUsd: number;
  /** false = never picked (with why). */
  leasable?: boolean; notLeasableWhy?: string;
  /** 1-minute load average (discovered). */
  load1?: number | null;
  source: 'default' | 'discovered' | 'config'; discoveredAt?: string | null;
}
export interface CapacityPolicy {
  /** USD a single request may spend on cloud without a 대표 card. null = every cloud start is a card. */
  cloudBudgetUsd: number | null;
  /** Local/LAN host counts as busy above this load per cpu. */
  maxLoadPerCpu: number;
  /** Hosts that become release-only while the release reservation is active. */
  releaseReservedHosts: string[];
}
export const DEFAULT_POLICY: CapacityPolicy = { cloudBudgetUsd: null, maxLoadPerCpu: 0.8, releaseReservedHosts: ['node-b'] };

/** Cloud instance type → specs (vendor sheets). Unknown types are skipped, never guessed. */
export const INSTANCE_SPECS: Record<string, { ramGiB: number; cpu: number }> = {
  'r8g.4xlarge': { ramGiB: 128, cpu: 16 }, 'r6i.4xlarge': { ramGiB: 128, cpu: 16 }, 'r8g.8xlarge': { ramGiB: 256, cpu: 32 },
  't4g.medium': { ramGiB: 4, cpu: 2 }, 'n2-highmem-16': { ramGiB: 128, cpu: 16 }, 'n2-highmem-8': { ramGiB: 64, cpu: 8 },
  'n2-highmem-32': { ramGiB: 256, cpu: 32 }, 'n2-standard-8': { ramGiB: 32, cpu: 8 }, 'n2-standard-4': { ramGiB: 16, cpu: 4 },
  'e2-medium': { ramGiB: 4, cpu: 2 }, 'e2-small': { ramGiB: 2, cpu: 2 },
};

/** Defaults = measured 11-25 22:5x (ssh sysctl) and cloud-vm.sh map; discovery refreshes them. */
export const DEFAULT_HOSTS: HostSpec[] = [
  { host: 'node-b', kind: 'lan', ramGiB: 512, cpu: 32, ratePerHourUsd: 0, source: 'default' },
  { host: 'minim5', kind: 'lan', ramGiB: 64, cpu: 18, ratePerHourUsd: 0, source: 'default' },
  { host: 'mbp', kind: 'lan', ramGiB: 128, cpu: 18, ratePerHourUsd: 0, leasable: false, notLeasableWhy: 'review/hand host only (CEO 11-23)', source: 'default' },
  { host: 'aws1', kind: 'cloud', type: 'r8g.4xlarge', ramGiB: 128, cpu: 16, ratePerHourUsd: 1.13696, source: 'default' },
  { host: 'aws2', kind: 'cloud', type: 'r8g.4xlarge', ramGiB: 128, cpu: 16, ratePerHourUsd: 1.13696, source: 'default' },
  { host: 'gcp1', kind: 'cloud', type: 'n2-highmem-16', ramGiB: 128, cpu: 16, ratePerHourUsd: 1.345968, source: 'default' },
  { host: 'gcp2', kind: 'cloud', type: 'n2-highmem-8', ramGiB: 64, cpu: 8, ratePerHourUsd: 0.672984, source: 'default' },
  { host: 'gcp3', kind: 'cloud', type: 'n2-highmem-16', ramGiB: 128, cpu: 16, ratePerHourUsd: 1.345968, source: 'default' },
];

export interface CapacityRequest {
  ramGiB: number; cpu?: number | null; ttlMin: number; count: number; reason: string; requester: string;
  budgetUsd?: number | null; urgency?: 'normal' | 'urgent';
}
export interface Candidate { host: string; tier: 1 | 2 | 3; ready: boolean; rate: number; loadPerCpu: number | null; spec: HostSpec }
export interface Rejection { host: string; why: string }
export type CapacityDecision =
  | { outcome: 'picked'; picks: Candidate[]; estUsd: number; budgetUsd: number | null; reasons: string[]; rejected: Rejection[] }
  | { outcome: 'needs-ceo'; picks: Candidate[]; estUsd: number; budgetUsd: number | null; reasons: string[]; rejected: Rejection[]; card: string }
  | { outcome: 'refused'; reasons: string[]; rejected: Rejection[]; options: string[] };

const catalogPath = (root: string) => join(root, 'host-catalog.json');
const configPath = (root: string) => join(root, 'host-catalog.config.json');
function readJson<T>(p: string, fb: T): T { if (!existsSync(p)) return fb; try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fb; } }
function writeJson(p: string, v: unknown): void {
  mkdirSync(join(p, '..'), { recursive: true }); const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(v, null, 1)}\n`); renameSync(tmp, p);
}

/** "128G" · "128GB" · "128 GiB" · "1T" · 128 → GiB. */
export function parseSize(text: string | number): number {
  if (typeof text === 'number') { if (text > 0) return text; throw new Error('size must be > 0'); }
  const m = /^\s*(\d+(?:\.\d+)?)\s*(t|tb|tib|g|gb|gib)?\s*$/i.exec(text);
  if (!m) throw new Error(`--ram must look like 128G (got ${text})`);
  const n = Number(m[1]) * (/^t/i.test(m[2] ?? 'g') ? 1024 : 1);
  if (!(n > 0)) throw new Error('size must be > 0');
  return n;
}

export function loadPolicy(root: string): CapacityPolicy {
  const cfg = readJson<{ policy?: Partial<CapacityPolicy> }>(configPath(root), {});
  return { ...DEFAULT_POLICY, ...(cfg.policy ?? {}) };
}

/** defaults ⊕ discovered cache ⊕ config overrides (config wins). */
export function loadCatalog(root: string): HostSpec[] {
  const cache = readJson<HostSpec[]>(catalogPath(root), []);
  const cfg = readJson<{ hosts?: Array<Partial<HostSpec> & { host: string }> }>(configPath(root), {});
  const byHost = new Map<string, HostSpec>(DEFAULT_HOSTS.map(h => [h.host, { ...h }]));
  for (const h of cache) byHost.set(h.host, { ...(byHost.get(h.host) ?? {}), ...h });
  for (const h of cfg.hosts ?? []) {
    const base = byHost.get(h.host);
    const merged = { ...(base ?? { kind: 'cloud', ramGiB: 0, cpu: 0, ratePerHourUsd: 0 }), ...h, source: 'config' } as HostSpec;
    byHost.set(h.host, merged);
  }
  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host));
}

export interface DiscoverDeps {
  sh?: (cmd: string, args: string[], timeoutMs: number) => { status: number | null; stdout: string };
  seatState?: string;
}
const defaultSh = (cmd: string, args: string[], timeoutMs: number) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status, stdout: String(r.stdout ?? '') };
};

/**
 * Refresh the cache: local/LAN by ssh (mac sysctl, else linux /proc + nproc), cloud by `cloud-vm.sh map` type → specs
 * and cloud-rates.tsv. A host that does not answer keeps its previous value (stale is better than invented).
 */
export function discoverCatalog(root: string, now: Date, deps: DiscoverDeps = {}): { hosts: HostSpec[]; failed: Rejection[] } {
  const sh = deps.sh ?? defaultSh; const seat = deps.seatState ?? join(process.env.HOME ?? '', 'elanous-hq', 'seat-state');
  const current = loadCatalog(root); const failed: Rejection[] = []; const out: HostSpec[] = [];
  let mapRows: string[][] = []; let rateRows: string[][] = [];
  const map = sh(join(seat, 'OP', 'tools', 'cloud-vm.sh'), ['map'], 15_000);
  if (map.status === 0) mapRows = map.stdout.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split('\t'));
  try { rateRows = readFileSync(join(seat, 'OP', 'cloud-rates.tsv'), 'utf8').split('\n').map(l => l.split('\t')); } catch { /* keep defaults */ }
  for (const h of current) {
    if (h.source === 'config') { out.push(h); continue; }
    if (h.kind === 'cloud') {
      const type = mapRows.find(c => c[0] === h.host)?.[4];
      const spec = type ? INSTANCE_SPECS[type] : undefined;
      if (!type || !spec) { failed.push({ host: h.host, why: type ? `unknown instance type ${type}` : 'not in cloud-vm.sh map' }); out.push(h); continue; }
      const rate = Number(rateRows.find(c => c[0] === 'vm' && c[1] === type)?.[4]);
      out.push({ ...h, type, ...spec, ratePerHourUsd: Number.isFinite(rate) && rate > 0 ? rate : h.ratePerHourUsd, source: 'discovered', discoveredAt: now.toISOString() });
      continue;
    }
    const probe = 'if [ "$(uname)" = Darwin ]; then echo "$(sysctl -n hw.memsize) $(sysctl -n hw.ncpu) $(sysctl -n vm.loadavg | tr -d "{}" | cut -d" " -f2) $(df -k ~ | awk "NR==2{print \\$2}")"; '
      + 'else echo "$(awk "/MemTotal/{print \\$2*1024}" /proc/meminfo) $(nproc) $(cut -d" " -f1 /proc/loadavg) $(df -k ~ | awk "NR==2{print \\$2}")"; fi';
    const r = sh('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', h.host, probe], 15_000);
    const [mem, cpu, load, disk] = (r.stdout.trim().split('\n').at(-1) ?? '').split(/\s+/).map(Number);
    if (r.status !== 0 || !(mem! > 0) || !(cpu! > 0)) { failed.push({ host: h.host, why: `ssh probe failed (exit ${r.status})` }); out.push(h); continue; }
    out.push({ ...h, ramGiB: Math.round(mem! / 2 ** 30), cpu: cpu!, load1: Number.isFinite(load) ? load! : null,
      diskGiB: Number.isFinite(disk) ? Math.round(disk! / 2 ** 20) : null, source: 'discovered', discoveredAt: now.toISOString() });
  }
  writeJson(catalogPath(root), out);
  return { hosts: out, failed };
}

/** The planner: pure over catalog ⊕ lease/ready/reservation state. */
export function planCapacity(root: string, req: CapacityRequest, now: Date, catalog = loadCatalog(root), policy = loadPolicy(root)): CapacityDecision {
  if (!(req.ramGiB > 0)) throw new Error('ram must be > 0');
  if (!(req.count >= 1 && req.count <= 8)) throw new Error('count must be within 1..8');
  if (!req.reason.trim()) throw new Error('a capacity lease needs a reason');
  const leases = loadLeases(root); const rv = loadReservation(root);
  const reserved = new Set(rv?.active ? policy.releaseReservedHosts : []);
  const ok: Candidate[] = []; const rejected: Rejection[] = [];
  for (const h of catalog) {
    if (h.leasable === false) { rejected.push({ host: h.host, why: h.notLeasableWhy ?? 'not leasable' }); continue; }
    if (h.ramGiB < req.ramGiB) { rejected.push({ host: h.host, why: `${h.ramGiB} GB too small` }); continue; }
    if (req.cpu && h.cpu < req.cpu) { rejected.push({ host: h.host, why: `${h.cpu} cpu < ${req.cpu}` }); continue; }
    const open = liveLease(leases, h.host);
    if (open) { rejected.push({ host: h.host, why: `leased (${open.id} ${open.state})` }); continue; }
    if (reserved.has(h.host)) { rejected.push({ host: h.host, why: `reserved for release ${rv?.version ?? ''}`.trim() }); continue; }
    const loadPerCpu = h.load1 != null && h.cpu > 0 ? h.load1 / h.cpu : null;
    if (h.kind !== 'cloud') {
      if (loadPerCpu != null && loadPerCpu > policy.maxLoadPerCpu) { rejected.push({ host: h.host, why: `busy (load/cpu ${loadPerCpu.toFixed(2)} > ${policy.maxLoadPerCpu})` }); continue; }
      ok.push({ host: h.host, tier: 1, ready: true, rate: 0, loadPerCpu, spec: h });
      continue;
    }
    const ready = isReady(root, h.host, READY_MAX_AGE_DAYS, now);
    ok.push({ host: h.host, tier: ready ? 2 : 3, ready, rate: h.ratePerHourUsd, loadPerCpu, spec: h });
  }
  ok.sort((a, b) => a.tier - b.tier || Number(b.ready) - Number(a.ready) || a.rate - b.rate || (a.loadPerCpu ?? 0) - (b.loadPerCpu ?? 0) || a.host.localeCompare(b.host));
  const want = `${req.count}× ${req.ramGiB} GB${req.cpu ? `/${req.cpu} cpu` : ''} for ${fmtTtl(req.ttlMin)}`;
  if (ok.length < req.count) {
    const bigger = catalog.filter(h => h.ramGiB >= req.ramGiB && h.leasable !== false).map(h => h.host);
    const options = [
      ...(bigger.length ? [`wait for ${bigger.join('/')} (leased/reserved/busy now) — eln res lease list`] : []),
      `lower the size: largest free host is ${largestFree(catalog, rejected)}`,
      ...(req.count > 1 && ok.length ? [`take ${ok.length} now (--count ${ok.length})`] : []),
      `add a cloud type ≥ ${req.ramGiB} GB (e.g. ${suggestType(req.ramGiB)}) to cloud-vm.sh map — CEO card (new spend)`,
    ];
    return { outcome: 'refused', reasons: [`nothing fits ${want}: ${ok.length}/${req.count} hosts available`], rejected, options };
  }
  const picks = ok.slice(0, req.count);
  const estUsd = round2(picks.reduce((s, p) => s + p.rate * req.ttlMin / 60, 0));
  const budgetUsd = req.budgetUsd ?? policy.cloudBudgetUsd;
  const reasons = picks.map(p => `${p.host} ${p.spec.type ? `${p.spec.type} ` : ''}${p.spec.ramGiB} GB ${tierWhy(p)}${p.rate ? `, $${p.rate.toFixed(2)}/h` : ', $0'}`);
  if (estUsd > 0 && (budgetUsd == null || estUsd > budgetUsd)) {
    const card = `[RES · CEO cost] ${want} → ${picks.map(p => p.host).join('+')} est $${estUsd.toFixed(2)} `
      + `(budget ${budgetUsd == null ? 'none' : `$${budgetUsd}`}) · reason: ${req.reason} · approve: eln res lease request --ram ${req.ramGiB}G --ttl ${fmtTtl(req.ttlMin)} --count ${req.count} --budget ${Math.ceil(estUsd)} --reason "${req.reason}"`;
    return { outcome: 'needs-ceo', picks, estUsd, budgetUsd, reasons, rejected, card };
  }
  return { outcome: 'picked', picks, estUsd, budgetUsd, reasons, rejected };
}

/** Write the leases for a picked decision; the res-burst-lease graph runs start → ready checks → register → TTL stop. */
export function commitCapacity(root: string, req: CapacityRequest, d: Extract<CapacityDecision, { outcome: 'picked' }>, now: Date): Lease[] {
  const leases = loadLeases(root); const made: Lease[] = [];
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 13);
  for (const p of d.picks) {
    const share = req.budgetUsd != null && d.estUsd > 0 ? round2(req.budgetUsd * (p.rate * req.ttlMin / 60) / d.estUsd) : null;
    const lease: Lease = { id: `L-${p.host}-${stamp}`, host: p.host, ttlMin: req.ttlMin, budgetUsd: share, reason: req.reason, requester: req.requester,
      state: 'requested', requestedAt: now.toISOString(), ratePerHourUsd: p.rate, ...(p.spec.kind !== 'cloud' ? { local: true } : {}),
      note: `capacity ${req.ramGiB}G${req.cpu ? `/${req.cpu}cpu` : ''} · tier ${p.tier}` };
    leases.push(lease); made.push(lease);
  }
  saveLeases(root, leases);
  receipt(root, { kind: 'capacity-picked', ramGiB: req.ramGiB, cpu: req.cpu ?? null, count: req.count, ttlMin: req.ttlMin,
    hosts: d.picks.map(p => p.host), estUsd: d.estUsd, reasons: d.reasons, requester: req.requester }, now);
  return made;
}

export function formatDecision(d: CapacityDecision): string {
  const lines: string[] = [];
  if (d.outcome === 'refused') {
    lines.push(`REFUSED — ${d.reasons.join('; ')}`);
    for (const r of d.rejected) lines.push(`  ✗ ${r.host}: ${r.why}`);
    lines.push('options:'); for (const o of d.options) lines.push(`  · ${o}`);
    return lines.join('\n');
  }
  lines.push(`${d.outcome === 'picked' ? 'PICKED' : 'NEEDS CEO'} — ${d.reasons.join('; ')}`);
  for (const r of d.rejected) lines.push(`  ✗ ${r.host}: ${r.why}`);
  lines.push(`  est $${d.estUsd.toFixed(2)} (budget ${d.budgetUsd == null ? 'none' : `$${d.budgetUsd}`})`);
  if (d.outcome === 'needs-ceo') lines.push(`  card: ${d.card}`);
  return lines.join('\n');
}

function tierWhy(p: Candidate): string {
  if (p.tier === 1) return `${p.spec.kind} free${p.loadPerCpu != null ? ` (load/cpu ${p.loadPerCpu.toFixed(2)})` : ''}`;
  return p.ready ? 'ready (pool)' : 'stopped → ready checks first';
}
function largestFree(catalog: HostSpec[], rejected: Rejection[]): string {
  const bad = new Set(rejected.filter(r => !/too small|cpu </.test(r.why)).map(r => r.host));
  const free = catalog.filter(h => h.leasable !== false && !bad.has(h.host)).sort((a, b) => b.ramGiB - a.ramGiB)[0];
  return free ? `${free.host} ${free.ramGiB} GB` : 'none';
}
function suggestType(gib: number): string {
  return Object.entries(INSTANCE_SPECS).filter(([, s]) => s.ramGiB >= gib).sort((a, b) => a[1].ramGiB - b[1].ramGiB)[0]?.[0] ?? 'a larger instance';
}
export function fmtTtl(min: number): string { return min % 60 === 0 ? `${min / 60}h` : `${min}m`; }
const round2 = (n: number) => Math.round(n * 100) / 100;
