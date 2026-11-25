/**
 * RES-READY-POOL-RESERVATION (대표 11-25 22:3x «resource-kingdom GRAPHS first — don't hand-maintain machines»).
 *
 * The state the three RES condition-trigger graphs (graphs/triggers/res-*.yaml) read and write. Pure file state under
 * one root (`{seatState}/RES/graph-state` by default) so the sim world, the test universe and live share the code:
 *   leases.json        — burst leases {host, ttl, budget, reason, requester} and their lifecycle
 *   ready.json         — per burst host: last verified ready state (age > maxAge or never = stale)
 *   reservation.json   — node-b release reservation (non-release pregate slots on node-b → 1)
 *   burst-hosts.json   — hosts a lease registered as pregate hosts (caps), read by pregate auto-select
 *   rail-permits/<h>.json — the rail window permit THIS graph issues (replaces the hand-written REL file)
 *   receipts.jsonl     — one line per lease/ready/reservation transition (start · stop · cost)
 * Every write is atomic (tmp + rename). Nothing here touches a machine: actuators live in res-nodes.ts.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BURST_HOSTS = ['aws1', 'aws2', 'gcp1', 'gcp2', 'gcp3'] as const;
export const READY_MAX_AGE_DAYS = 7;
/** A lease past ttl is stopped no later than ttl + this, even with an inflight pregate (fallback). */
export const DRAIN_GRACE_MIN = 15;
/** Release reservation stays at most publish + this after the release graph clock (max_wait fallback). */
export const RESERVATION_TAIL_MIN = 45;
/** Pre-cut phase opens this long before cutAt. */
export const PRE_CUT_LEAD_MIN = 120;

export type LeaseState = 'requested' | 'active' | 'draining' | 'stopped' | 'failed';
export interface Lease {
  id: string; host: string; ttlMin: number; budgetUsd: number | null; reason: string; requester: string;
  state: LeaseState; requestedAt: string; startedAt?: string; endsAt?: string; stoppedAt?: string;
  requesterDone?: boolean; adopted?: boolean; ratePerHourUsd?: number | null; note?: string;
  /** Local/LAN capacity lease: no cloud start/stop — the graph only registers and drains it. */
  local?: boolean;
}
export interface ReadyRow { host: string; state: 'ready' | 'failed'; verifiedAt: string; evidence: string; sha?: string | null }
export interface Reservation { active: boolean; host: 'node-b'; nonReleaseSlots: number; phase: ReleasePhase; version: string | null; since: string; until?: string | null }
export interface RailPermit { issuer: 'res-graph'; leaseId: string; host: string; start: string; end: string; graph: string }
export type ReleasePhase = 'pre-cut' | 'window' | 'idle';

export function resRoot(seatState: string): string { return join(seatState, 'RES', 'graph-state'); }

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; }
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export const leasesPath = (root: string) => join(root, 'leases.json');
export const readyPath = (root: string) => join(root, 'ready.json');
export const reservationPath = (root: string) => join(root, 'reservation.json');
export const burstHostsPath = (root: string) => join(root, 'burst-hosts.json');
export const permitPath = (root: string, host: string) => join(root, 'rail-permits', `${host}.json`);

export function loadLeases(root: string): Lease[] { return readJson<Lease[]>(leasesPath(root), []); }
export function saveLeases(root: string, leases: Lease[]): void { writeJson(leasesPath(root), leases); }
export function loadReady(root: string): Record<string, ReadyRow> { return readJson<Record<string, ReadyRow>>(readyPath(root), {}); }
export function loadReservation(root: string): Reservation | null { return readJson<Reservation | null>(reservationPath(root), null); }

export function receipt(root: string, row: Record<string, unknown>, now: Date): void {
  mkdirSync(root, { recursive: true });
  appendFileSync(join(root, 'receipts.jsonl'), `${JSON.stringify({ at: now.toISOString(), ...row })}\n`);
}

const LIVE: LeaseState[] = ['requested', 'active', 'draining'];
export function liveLease(leases: Lease[], host: string): Lease | undefined { return leases.find(l => l.host === host && LIVE.includes(l.state)); }

export function requestLease(root: string, input: { host: string; ttlMin: number; budgetUsd?: number | null; reason: string; requester: string; ratePerHourUsd?: number | null }, now: Date): Lease {
  if (!input.reason.trim()) throw new Error('lease needs --reason');
  if (!(input.ttlMin > 0 && input.ttlMin <= 24 * 60)) throw new Error('ttl must be within (0, 24h]');
  const leases = loadLeases(root);
  const open = liveLease(leases, input.host);
  if (open) throw new Error(`${input.host} already has lease ${open.id} (${open.state})`);
  const lease: Lease = { id: `L-${input.host}-${now.toISOString().replace(/[-:]/g, '').slice(0, 13)}`, host: input.host, ttlMin: input.ttlMin,
    budgetUsd: input.budgetUsd ?? null, reason: input.reason, requester: input.requester, state: 'requested', requestedAt: now.toISOString(),
    ratePerHourUsd: input.ratePerHourUsd ?? null };
  saveLeases(root, [...leases, lease]);
  receipt(root, { kind: 'lease-requested', lease: lease.id, host: lease.host, ttlMin: lease.ttlMin, reason: lease.reason, requester: lease.requester }, now);
  return lease;
}

/** Adopt a lease that was started by hand (tonight's aws1): it becomes an active lease the graph drains at endsAt. */
export function adoptLease(root: string, input: { host: string; startedAt: string; endsAt: string; reason: string; requester: string; budgetUsd?: number | null; ratePerHourUsd?: number | null }, now: Date): Lease {
  const start = Date.parse(input.startedAt); const end = Date.parse(input.endsAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) throw new Error('adopt needs --started-at < --ends-at (ISO)');
  const leases = loadLeases(root);
  const open = liveLease(leases, input.host);
  if (open) throw new Error(`${input.host} already has lease ${open.id} (${open.state})`);
  const lease: Lease = { id: `L-${input.host}-${new Date(start).toISOString().replace(/[-:]/g, '').slice(0, 13)}`, host: input.host,
    ttlMin: Math.round((end - start) / 60_000), budgetUsd: input.budgetUsd ?? null, reason: input.reason, requester: input.requester, state: 'active',
    requestedAt: new Date(start).toISOString(), startedAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), adopted: true,
    ratePerHourUsd: input.ratePerHourUsd ?? null };
  saveLeases(root, [...leases, lease]);
  registerBurstHost(root, lease);
  issuePermit(root, lease, 'res-burst-lease');
  receipt(root, { kind: 'lease-adopted', lease: lease.id, host: lease.host, endsAt: lease.endsAt, reason: lease.reason }, now);
  return lease;
}

/** The requester says it is done → the graph drains on its next tick. */
export function markRequesterDone(root: string, hostOrId: string, now: Date): Lease {
  const leases = loadLeases(root);
  const lease = leases.find(l => (l.id === hostOrId || l.host === hostOrId) && LIVE.includes(l.state));
  if (!lease) throw new Error(`no live lease for ${hostOrId}`);
  lease.requesterDone = true;
  saveLeases(root, leases);
  receipt(root, { kind: 'lease-stop-requested', lease: lease.id, host: lease.host }, now);
  return lease;
}

export function updateLease(root: string, id: string, patch: Partial<Lease>): Lease {
  const leases = loadLeases(root);
  const lease = leases.find(l => l.id === id);
  if (!lease) throw new Error(`unknown lease ${id}`);
  Object.assign(lease, patch);
  saveLeases(root, leases);
  return lease;
}

export function spentUsd(lease: Lease, now: Date): number | null {
  if (!lease.startedAt || lease.ratePerHourUsd == null) return null;
  return Math.max(0, (now.getTime() - Date.parse(lease.startedAt)) / 3_600_000) * lease.ratePerHourUsd;
}

export type DueAction = { action: 'activate'; lease: Lease } | { action: 'drain'; lease: Lease; why: 'ttl' | 'requester-done' | 'budget' | 'draining' };

/** What the lease graph must do now, oldest first. Draining leases re-fire every 5 min (a new key) until stopped. */
export function dueLeases(root: string, now: Date): DueAction[] {
  const out: DueAction[] = [];
  for (const lease of loadLeases(root)) {
    if (lease.state === 'requested') out.push({ action: 'activate', lease });
    else if (lease.state === 'draining') out.push({ action: 'drain', lease, why: 'draining' });
    else if (lease.state === 'active') {
      const spent = spentUsd(lease, now);
      if (lease.requesterDone) out.push({ action: 'drain', lease, why: 'requester-done' });
      else if (lease.endsAt && now.getTime() >= Date.parse(lease.endsAt)) out.push({ action: 'drain', lease, why: 'ttl' });
      else if (lease.budgetUsd != null && spent != null && spent >= lease.budgetUsd) out.push({ action: 'drain', lease, why: 'budget' });
    }
  }
  return out;
}

export function dueKey(due: DueAction[], now: Date): string {
  const bucket = Math.floor(now.getTime() / 300_000);
  return due.map(d => `${d.action}:${d.lease.id}${d.action === 'drain' && d.why === 'draining' ? `@${bucket}` : ''}`).join(',');
}

/** Burst hosts whose ready state is older than maxAgeDays or never verified; hosts under a live lease are skipped. */
export function staleHosts(root: string, hosts: readonly string[], maxAgeDays: number, now: Date): Array<{ host: string; why: string }> {
  const ready = loadReady(root); const leases = loadLeases(root);
  const out: Array<{ host: string; why: string }> = [];
  for (const host of hosts) {
    if (liveLease(leases, host)) continue;
    const row = ready[host];
    if (!row) out.push({ host, why: 'never verified' });
    else if (row.state !== 'ready') out.push({ host, why: `last ${row.state} ${row.verifiedAt}` });
    else if (now.getTime() - Date.parse(row.verifiedAt) > maxAgeDays * 86_400_000) out.push({ host, why: `ready ${row.verifiedAt} > ${maxAgeDays}d` });
  }
  return out;
}

export function isReady(root: string, host: string, maxAgeDays: number, now: Date): boolean {
  const row = loadReady(root)[host];
  return !!row && row.state === 'ready' && now.getTime() - Date.parse(row.verifiedAt) <= maxAgeDays * 86_400_000;
}

export function markReady(root: string, host: string, state: ReadyRow['state'], evidence: string, now: Date, sha?: string | null): ReadyRow {
  const ready = loadReady(root);
  const row: ReadyRow = { host, state, verifiedAt: now.toISOString(), evidence: evidence.slice(0, 400), ...(sha !== undefined ? { sha } : {}) };
  ready[host] = row;
  writeJson(readyPath(root), ready);
  writeBoard(root, now);
  receipt(root, { kind: `ready-${state}`, host, evidence: row.evidence }, now);
  return row;
}

/** The status board row block (one line per burst host) — `{root}/BOARD.md`. */
export function writeBoard(root: string, now: Date): void {
  const ready = loadReady(root); const leases = loadLeases(root);
  const lines = [`# RES burst pool (graph-written ${now.toISOString()})`, '', '| host | ready | verified | lease |', '|---|---|---|---|'];
  for (const host of BURST_HOSTS) {
    const r = ready[host]; const l = liveLease(leases, host);
    const fresh = r && r.state === 'ready' && now.getTime() - Date.parse(r.verifiedAt) <= READY_MAX_AGE_DAYS * 86_400_000;
    lines.push(`| ${host} | ${r ? (fresh ? 'ready' : r.state === 'ready' ? 'stale' : r.state) : 'never'} | ${r?.verifiedAt ?? '—'} | ${l ? `${l.id} ${l.state}${l.endsAt ? ` →${l.endsAt}` : ''}` : '—'} |`);
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'BOARD.md'), `${lines.join('\n')}\n`);
}

/** The rail permit the graph issues (lease or ready-pool run). rail-catchup accepts it when the lease is live. */
export function issuePermit(root: string, lease: Pick<Lease, 'id' | 'host' | 'startedAt' | 'endsAt' | 'requestedAt'>, graph: string): RailPermit {
  const start = lease.startedAt ?? lease.requestedAt;
  const permit: RailPermit = { issuer: 'res-graph', leaseId: lease.id, host: lease.host, start, end: lease.endsAt ?? new Date(Date.parse(start) + 90 * 60_000).toISOString(), graph };
  writeJson(permitPath(root, lease.host), permit);
  return permit;
}

export function revokePermit(root: string, host: string): void {
  const p = permitPath(root, host);
  if (existsSync(p)) renameSync(p, `${p}.revoked`);
}

export interface BurstHostCap { host: string; leaseId: string; pregateSlots: number; until: string | null }
export function registerBurstHost(root: string, lease: Lease, pregateSlots = 2): void {
  const rows = readJson<BurstHostCap[]>(burstHostsPath(root), []).filter(r => r.host !== lease.host);
  writeJson(burstHostsPath(root), [...rows, { host: lease.host, leaseId: lease.id, pregateSlots, until: lease.endsAt ?? null }]);
}
export function unregisterBurstHost(root: string, host: string): void {
  writeJson(burstHostsPath(root), readJson<BurstHostCap[]>(burstHostsPath(root), []).filter(r => r.host !== host));
}

/**
 * Release phase from the release graph's own state (`{stateRoot}/release-graph/<v>/state.json`), not from a cron:
 * a non-rehearsal run that is not done and not hard-stopped is `pre-cut` from cutAt − 2h (L-0 reserve) and `window`
 * from cutAt to publishAt + 45 min (L-8 release + max_wait fallback). Done / hard stop / past the tail → idle.
 */
export function releasePhase(stateRoot: string, now: Date): { phase: ReleasePhase; version: string | null; until: string | null } {
  const dir = join(stateRoot, 'release-graph');
  if (!existsSync(dir)) return { phase: 'idle', version: null, until: null };
  let best: { phase: ReleasePhase; version: string | null; until: string | null } = { phase: 'idle', version: null, until: null };
  for (const v of readdirSync(dir).filter(x => /^\d+\.\d+\.\d+$/.test(x)).sort()) {
    const st = readJson<{ done?: boolean; hardStop?: unknown; kind?: string; clock?: { cutAt?: string; publishAt?: string } } | null>(join(dir, v, 'state.json'), null);
    if (!st || st.done || st.hardStop || st.kind === 'rehearsal' || !st.clock?.cutAt || !st.clock.publishAt) continue;
    const cut = Date.parse(st.clock.cutAt); const tail = Date.parse(st.clock.publishAt) + RESERVATION_TAIL_MIN * 60_000;
    const t = now.getTime();
    if (t >= cut && t < tail) return { phase: 'window', version: v, until: new Date(tail).toISOString() };
    if (t >= cut - PRE_CUT_LEAD_MIN * 60_000 && t < cut) best = { phase: 'pre-cut', version: v, until: new Date(tail).toISOString() };
  }
  return best;
}

/** Apply the reservation that matches the phase. Returns what changed. */
export function syncReservation(root: string, stateRoot: string, now: Date): { change: 'reserved' | 'lifted' | 'unchanged'; reservation: Reservation } {
  const { phase, version, until } = releasePhase(stateRoot, now);
  const prev = loadReservation(root);
  const active = phase !== 'idle';
  const next: Reservation = { active, host: 'node-b', nonReleaseSlots: active ? 1 : 0, phase, version, until,
    since: prev && prev.active === active && prev.version === version ? prev.since : now.toISOString() };
  const change = (prev?.active ?? false) === active && (prev?.version ?? null) === version ? 'unchanged' : active ? 'reserved' : 'lifted';
  writeJson(reservationPath(root), next);
  if (change !== 'unchanged') receipt(root, { kind: `reservation-${change}`, phase, version, until }, now);
  return { change, reservation: next };
}
