// 수호자 (super loop agent) — world ledger ⊕ supervisor health ⊕ the 1-min heart (GUARDIAN-CHARTER-1127 §1 · §4 ①②④).
//
// S: OP learned what exists, whether it is healthy and who uses it by a 9-minute census; supervisors died silently
//    (51 loops wake=none · zombie runs · 7 kinds of supervisor with no signal).
// C: no one held the world — machines · supervisors · fuel — as one ledger with a heartbeat.
// A: the guardian's thin body aggregates the world every pulse (entries shaped like the Nexus WORLD-REGISTRY / lease ledger
//    rows — no new ledger: the snapshot is the agent's own result file, status changes are memory cases). A 1-min LLM-0 pulse reads host load,
//    supervisor heartbeats (watcher beats ⊕ trigger registry) and the world diff, and wakes on events: a host over load/ncpu
//    1.0 → the full tick now · a dead supervisor → one restart (its trigger) ⊕ a card to its owner · a supervisor whose
//    outcome stays bad ≥ 60 min → a «reattach» proposal to its L0 (never retire) · an LLM account ≥ 90 % → OP.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HostProbe } from './hosts.js';
import { ratio } from './hosts.js';

export type WorldKind = 'host' | 'supervisor' | 'account' | 'credential';
export type WorldStatus = 'ok' | 'overloaded' | 'unreachable' | 'dead' | 'broken' | 'bad' | 'stale' | 'low' | 'exhausted' | 'unknown';
/** Same fields the Nexus WORLD-REGISTRY entry carries (kind · id · owner · status · lastSeen · facts) — migration = copy. */
export interface WorldEntry { readonly kind: WorldKind; readonly id: string; readonly owner: string | null; readonly status: WorldStatus; readonly lastSeen: string | null; readonly facts: Record<string, unknown> }
export interface WorldChange { readonly at: string; readonly kind: WorldKind; readonly id: string; readonly from: WorldStatus | null; readonly to: WorldStatus | null }

const key = (e: Pick<WorldEntry, 'kind' | 'id'>) => `${e.kind}:${e.id}`;

/** Pure: status changes between two snapshots (added · removed · changed). */
export function diffWorld(prev: readonly WorldEntry[], next: readonly WorldEntry[], at: string): WorldChange[] {
  const p = new Map(prev.map(e => [key(e), e] as const)); const n = new Map(next.map(e => [key(e), e] as const));
  const out: WorldChange[] = [];
  for (const [k, e] of n) { const was = p.get(k); if (!was || was.status !== e.status) out.push({ at, kind: e.kind, id: e.id, from: was?.status ?? null, to: e.status }); }
  for (const [k, e] of p) if (!n.has(k)) out.push({ at, kind: e.kind, id: e.id, from: e.status, to: null });
  return out;
}

/** The pulse's last aggregate — the agent's own result file (like last-tick.json · the trigger goal), overwritten each pulse.
 *  Not a ledger: the resource SSOT is the Nexus lease ledger; status changes are guardian memory cases. */
export const pulseSnapshotPath = (stateRoot: string): string => join(stateRoot, 'loop-agents', 'guardian', 'last-pulse.json');
export interface PulseSnapshot { readonly at: string; readonly world: WorldEntry[]; readonly kpi: import('./subagents.js').KpiRow[] }
export function readPulseSnapshot(stateRoot: string): PulseSnapshot | null {
  try { return JSON.parse(readFileSync(pulseSnapshotPath(stateRoot), 'utf8')) as PulseSnapshot; } catch { return null; }
}
export function writePulseSnapshot(stateRoot: string, snap: PulseSnapshot): void {
  const p = pulseSnapshotPath(stateRoot); mkdirSync(dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, JSON.stringify(snap)); renameSync(`${p}.tmp`, p);
}

// ── host entries ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function hostEntries(probes: readonly HostProbe[], at: string): WorldEntry[] {
  return probes.map(p => ({ kind: 'host' as const, id: p.host, owner: 'GUARDIAN', lastSeen: p.reachable ? at : null,
    status: (!p.reachable ? 'unreachable' : ratio(p) > 1.0 ? 'overloaded' : 'ok') as WorldStatus,
    facts: { load1: p.load1, ncpu: p.ncpu, ratio: p.reachable ? Math.round(ratio(p) * 100) / 100 : null, ...(p.why ? { why: p.why } : {}) } }));
}

// ── supervisor health (watcher beats ⊕ trigger registry) ─────────────────────────────────────────────────────────────

export interface SupervisorIn {
  readonly id: string;
  readonly owner: string | null;
  /** Expected cadence (min); null = unknown (cron) → only an exception / bad outcome counts. */
  readonly everyMin: number | null;
  readonly lastAt: string | null;
  readonly lastStatus: string | null;
  /** outcome probe: bad since (null = good / none) */
  readonly badSince: string | null;
  /** 'trigger' = restartable through `loop trigger tick --only <id>` · 'beat' = a watcher heartbeat */
  readonly via: 'trigger' | 'beat';
  readonly watcherStatus?: string;
}
export const DEAD_AFTER_CADENCES = 3;
export const REATTACH_AFTER_MIN = 60;

export function supervisorEntries(sups: readonly SupervisorIn[], now: Date): WorldEntry[] {
  return sups.map(s => {
    const age = s.lastAt ? (now.getTime() - Date.parse(s.lastAt)) / 60_000 : null;
    const dead = s.via === 'beat' ? s.watcherStatus === 'DEAD' : (s.everyMin !== null && (age === null || age > DEAD_AFTER_CADENCES * Math.max(2, s.everyMin)));
    const broken = s.via === 'beat' ? s.watcherStatus === 'BROKEN' : s.lastStatus === 'exception';
    const badMin = s.badSince ? (now.getTime() - Date.parse(s.badSince)) / 60_000 : 0;
    const status: WorldStatus = dead ? 'dead' : broken ? 'broken' : badMin >= REATTACH_AFTER_MIN ? 'bad' : 'ok';
    return { kind: 'supervisor' as const, id: s.id, owner: s.owner, status, lastSeen: s.lastAt,
      facts: { via: s.via, everyMin: s.everyMin, ageMin: age === null ? null : Math.round(age), lastStatus: s.lastStatus, badMin: Math.round(badMin) } };
  });
}

// ── pulse plan (pure) ────────────────────────────────────────────────────────────────────────────────────────────────

/** Rate-limit marks (kept in the guardian's memory state `sent` map — no extra file). */
export interface PulseState { restartedAt: Record<string, string>; reattachAt: Record<string, string>; fuelAlertAt: Record<string, string>; tickWokeAt: string | null }
export const emptyPulseState = (): PulseState => ({ restartedAt: {}, reattachAt: {}, fuelAlertAt: {}, tickWokeAt: null });
export const RESTART_EVERY_MS = 30 * 60_000;
export const REATTACH_EVERY_MS = 6 * 60 * 60_000;
export const FUEL_ALERT_EVERY_MS = 60 * 60_000;
export const TICK_WAKE_EVERY_MS = 10 * 60_000;
export const FUEL_ALERT_SHARE = 0.9;

export interface PulseActions {
  readonly wakeTick: string | null;
  readonly restart: Array<{ id: string; owner: string | null; why: string }>;
  readonly reattach: Array<{ id: string; owner: string | null; why: string }>;
  readonly fuel: Array<{ id: string; used: number }>;
}
/** Pure: what the pulse does now from the world it just read (rate-limited by the pulse state). */
export function planPulse(world: readonly WorldEntry[], state: PulseState, nowMs: number): PulseActions {
  const due = (at: string | undefined | null, every: number) => !at || nowMs - Date.parse(at) >= every;
  const overloaded = world.filter(e => e.kind === 'host' && e.status === 'overloaded').map(e => `${e.id} ${String(e.facts.ratio)}`);
  const wakeTick = overloaded.length && due(state.tickWokeAt, TICK_WAKE_EVERY_MS) ? `host overload ${overloaded.join(' · ')}` : null;
  const restart = world.filter(e => e.kind === 'supervisor' && (e.status === 'dead' || e.status === 'broken') && e.facts.via === 'trigger' && due(state.restartedAt[e.id], RESTART_EVERY_MS))
    .map(e => ({ id: e.id, owner: e.owner, why: `${e.status} · last ${e.lastSeen ?? 'never'} · ${String(e.facts.lastStatus ?? '')}` }));
  const reattach = world.filter(e => e.kind === 'supervisor' && (e.status === 'bad' || (e.status === 'dead' && e.facts.via === 'beat')) && due(state.reattachAt[e.id], REATTACH_EVERY_MS))
    .map(e => ({ id: e.id, owner: e.owner, why: e.status === 'bad' ? `outcome bad ${String(e.facts.badMin)}m` : `heartbeat dead (last ${e.lastSeen ?? 'never'})` }));
  const fuel = world.filter(e => e.kind === 'account' && typeof e.facts.used === 'number' && (e.facts.used as number) >= FUEL_ALERT_SHARE && due(state.fuelAlertAt[e.id], FUEL_ALERT_EVERY_MS))
    .map(e => ({ id: e.id, used: e.facts.used as number }));
  return { wakeTick, restart, reattach, fuel };
}

/** `eln loop guardian world` — one screen: hosts · supervisors · fuel (from the ledger). */
export function renderWorld(world: readonly WorldEntry[]): string {
  const by = (k: WorldKind) => world.filter(e => e.kind === k);
  const hosts = by('host').map(e => `${e.id} ${e.status === 'ok' ? '' : `${e.status} `}${e.facts.ratio ?? '?'}`).join(' · ') || '—';
  const sups = by('supervisor'); const badSups = sups.filter(e => e.status !== 'ok');
  const fuel = by('account').map(e => `${e.id} ${typeof e.facts.used === 'number' ? `${Math.round((e.facts.used as number) * 100)}%` : '?'}${e.status === 'ok' ? '' : ` ${e.status}`}`).join(' · ') || '— (no fuel reading yet)';
  return [`세계 · 호스트 load/ncpu: ${hosts}`,
    `감독자 ${sups.length} · 정상 ${sups.length - badSups.length}${badSups.length ? ` · 이상 ${badSups.map(e => `${e.id}(${e.status}${e.owner ? `·${e.owner}` : ''})`).slice(0, 10).join(' ')}` : ''}`,
    `연료: ${fuel}`].join('\n');
}
