// kit/work-pull — WORK-PULL-REACHES-ROSTER (0.3.39 P0 · Claude OP 11-28) — the ONE «ready for a hand» policy reader
// (graphs/policies/work-pull.yaml). Builds on STEWARD-READY-LANES (#40649: one cell-wait / lane rule) with the rest of the
// definition every consumer shares — `eln work next` · `eln work block` · the space steward (live R1 · steward:hq) · OP's
// assignment table:
//   · coordinator authority = ladder depth in `coordinator_depths` (HQ 1 ⊕ space coordinators 2 · from the ladder, no seat
//     names): a cell such a seat holds is the board — a hand claims it as WRITER, the coordinator stays owner
//   · order = roster rank (OP's roster ledger) → priority → the rest · reserve («[예비 …]») only when no roster cell is
//     claimable · «[WIP 잔류 …]» never
//   · a claim (writer or owner) lives `writer.lease_min` past the latest progress signal in `writer.progress`
//   · a parked (`work block`) cell comes back only on an answer about it (`block.resolve_on`)
// 세 얼굴: 관측 = the policy file ⊕ `livePullPolicy().error` when unreadable · 판단 근거 = rules only (no LLM) · 수복과
// 인계 = an unreadable file is the pre-policy board ({@link legacyPullPolicy} — what the code did before this file), the
// reader's error names it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { LEASE_MINUTES } from '../../steward/space/model.js';

export type ProgressSignal = 'claim' | 'cell-change' | 'activity' | 'pr-update';
export type BlockResolve = 'reply-to' | 'cell-ref' | 'cell-touch' | 'addressed-mail';
const PROGRESS: readonly ProgressSignal[] = ['claim', 'cell-change', 'activity', 'pr-update'];
const RESOLVE: readonly BlockResolve[] = ['reply-to', 'cell-ref', 'cell-touch', 'addressed-mail'];

export interface PullPolicy {
  readonly coordinatorDepths: readonly number[];
  readonly priorities: readonly string[];
  readonly reserveMarkers: readonly string[];
  readonly neverMarkers: readonly string[];
  readonly writerLeaseMin: number;
  readonly progress: readonly ProgressSignal[];
  readonly blockResolve: readonly BlockResolve[];
}

/** The board before this policy (fail-open): depth-2 coordinators only · P0>P1>P2 · no roster classes · the 45-min
 *  lease on claim/cell/activity · a block answered by any later mail to the hand or its coordinator. */
// A function, not a const: model.ts ⇄ this module import each other, and LEASE_MINUTES must be read after both load.
export const legacyPullPolicy = (): PullPolicy => ({
  coordinatorDepths: [2], priorities: ['P0', 'P1', 'P2'], reserveMarkers: [], neverMarkers: [],
  writerLeaseMin: LEASE_MINUTES, progress: ['claim', 'cell-change', 'activity'], blockResolve: ['reply-to', 'addressed-mail'],
});

export const pullPolicyPath = (root = resolve(import.meta.dir, '../../..')): string => join(root, 'graphs', 'policies', 'work-pull.yaml');

const strings = (v: unknown, key: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) throw new Error(`work-pull policy: ${key} must be a list of strings`);
  return v as string[];
};
const oneOf = <T extends string>(v: unknown, key: string, allowed: readonly T[]): T[] => {
  const list = strings(v, key);
  const bad = list.filter((x) => !(allowed as readonly string[]).includes(x));
  if (bad.length) throw new Error(`work-pull policy: ${key} has unknown ${bad.join(', ')} (allowed: ${allowed.join(' · ')})`);
  return list as T[];
};

export function parsePullPolicy(text: string): PullPolicy {
  const raw = parse(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new Error('work-pull policy: not a mapping');
  const depths = raw.coordinator_depths;
  if (!Array.isArray(depths) || !depths.length || depths.some((d) => !Number.isInteger(d) || (d as number) < 1)) throw new Error('work-pull policy: coordinator_depths must be a list of ladder depths ≥ 1');
  const order = (raw.order ?? {}) as Record<string, unknown>;
  const writer = (raw.writer ?? {}) as Record<string, unknown>;
  const block = (raw.block ?? {}) as Record<string, unknown>;
  const lease = writer.lease_min;
  if (typeof lease !== 'number' || !Number.isFinite(lease) || lease <= 0) throw new Error('work-pull policy: writer.lease_min must be a number > 0');
  return {
    coordinatorDepths: depths as number[],
    priorities: strings(order.priorities, 'order.priorities'),
    reserveMarkers: order.reserve_markers === undefined ? [] : strings(order.reserve_markers, 'order.reserve_markers'),
    neverMarkers: order.never_markers === undefined ? [] : strings(order.never_markers, 'order.never_markers'),
    writerLeaseMin: lease,
    progress: oneOf(writer.progress, 'writer.progress', PROGRESS),
    blockResolve: oneOf(block.resolve_on, 'block.resolve_on', RESOLVE),
  };
}

export function loadPullPolicy(path = pullPolicyPath()): PullPolicy {
  if (!existsSync(path)) throw new Error(`work-pull policy missing: ${path}`);
  return parsePullPolicy(readFileSync(path, 'utf8'));
}

let cached: { policy: PullPolicy; source: 'yaml' | 'legacy'; error?: string } | undefined;
/** The live read (once per process): the shipped file, else the pre-policy board with the error named. */
export function livePullPolicy(): { policy: PullPolicy; source: 'yaml' | 'legacy'; error?: string } {
  if (cached) return cached;
  try { cached = { policy: loadPullPolicy(), source: 'yaml' }; } catch (error) { cached = { policy: legacyPullPolicy(), source: 'legacy', error: String(error).slice(0, 200) }; }
  return cached;
}

// ── pure rules ─────────────────────────────────────────────────────────────────────────────────

/** A seat at one of these ladder depths holds cells as the board (HQ ⊕ space coordinators by default). */
export const hasCoordinatorAuthority = (depth: number, p: PullPolicy): boolean => p.coordinatorDepths.includes(depth);

export type PullClass = 'roster' | 'reserve' | 'never';
/** Roster unless the evidence's first line starts with a reserve / never marker. */
export function pullClass(evidence: string | undefined, p: PullPolicy): PullClass {
  const head = (evidence ?? '').trimStart().split('\n')[0] ?? '';
  if (p.neverMarkers.some((m) => head.startsWith(m))) return 'never';
  if (p.reserveMarkers.some((m) => head.startsWith(m))) return 'reserve';
  return 'roster';
}

/** Index in `order.priorities`; a cell without one (or with another) ranks after all of them. */
export const priorityRankOf = (priority: string | undefined, p: PullPolicy): number => {
  const i = p.priorities.indexOf(priority ?? '');
  return i < 0 ? p.priorities.length : i;
};

/** The shared order key: class (roster before reserve) → roster rank (unranked after ranked) → priority. Consumers add
 *  their own tie-breaks (version · age · id) after it. */
export interface PullKey { readonly id: string; readonly priority?: string; readonly evidence?: string; readonly evidenceHead?: string }
/** A roster rank as a Map (in-process) or a plain record (a snapshot that went through JSON — the steward graph persists its
 *  snapshot between nodes, and `JSON.stringify(new Map())` is `{}`: 11-28 03:30Z every R1 tick died on `rank?.get`). */
export type RosterRankLike = ReadonlyMap<string, number> | Readonly<Record<string, number>>;
/** The rank of `id` in either shape; unranked (or a malformed value) → +∞. Never throws. */
export function rosterRankOf(rank: RosterRankLike | undefined | null, id: string): number {
  if (!rank || typeof rank !== 'object') return Number.POSITIVE_INFINITY;
  const v = rank instanceof Map ? rank.get(id) : Object.hasOwn(rank, id) ? (rank as Readonly<Record<string, number>>)[id] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
}
/** The JSON-safe form of a rank (what a persisted snapshot carries). */
export const rosterRankRecord = (rank: ReadonlyMap<string, number>): Record<string, number> => Object.fromEntries(rank);

export function comparePull(a: PullKey, b: PullKey, p: PullPolicy, rank?: RosterRankLike): number {
  const cls = (c: PullKey): number => (pullClass(c.evidence ?? c.evidenceHead, p) === 'roster' ? 0 : 1);
  const r = (c: { id: string }): number => rosterRankOf(rank, c.id);
  const ra = r(a); const rb = r(b);
  return cls(a) - cls(b) || (ra === rb ? 0 : ra < rb ? -1 : 1) || priorityRankOf(a.priority, p) - priorityRankOf(b.priority, p);
}

/** A claim's end: the latest progress signal the policy counts (absent signals are skipped) + `writer.lease_min`. */
export function claimUntilMs(signals: Partial<Record<ProgressSignal, number | undefined>>, p: PullPolicy): number {
  const stamps = p.progress.map((s) => signals[s]).filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
  return (stamps.length ? Math.max(...stamps) : 0) + p.writerLeaseMin * 60_000;
}

/**
 * The live writer of a coordinator-held cell, else undefined: now ≤ the latest progress signal the policy counts (claim ·
 * the cell changed by the writer — or by an unknown hand · the writer's activity · an open PR naming the cell) + lease.
 * One rule for `eln work next`, the steward snapshot and OP's table (each passes what it can see).
 */
export function liveWriter(cell: { readonly status: string; readonly updatedAt: string; readonly updatedBy?: string; readonly writer?: { readonly seat: string; readonly at: string } },
  seen: { nowMs: number; activityMs?: number; prUpdatedMs?: number }, p: PullPolicy): string | undefined {
  const seat = cell.writer?.seat?.trim().toUpperCase();
  if (!seat || cell.status !== 'yellow') return undefined;
  const by = cell.updatedBy?.trim().toUpperCase();
  const until = claimUntilMs({ claim: Date.parse(cell.writer!.at), 'cell-change': by === undefined || by === seat ? Date.parse(cell.updatedAt) : undefined,
    activity: seen.activityMs, 'pr-update': seen.prUpdatedMs }, p);
  return until >= seen.nowMs ? seat : undefined;
}

/** A recent open PR explicitly declares its cell. Drafts count; title/branch mentions do not.
 * Callers supply the open-only GitHub snapshot, not merged/closed PRs. */
export function recentDeclaredPr(cellId: string, prs: readonly { body?: string; updatedAt: string }[], nowMs: number, p: PullPolicy): boolean {
  if (!p.progress.includes('pr-update')) return false;
  return prs.some((pr) => {
    const t = Date.parse(pr.updatedAt);
    if (!Number.isFinite(t) || t > nowMs || nowMs - t > p.writerLeaseMin * 60_000) return false;
    return (pr.body ?? '').split(/\r?\n/).some((line) => {
      const match = /^\s*칸\s*:\s*`?([A-Za-z0-9][A-Za-z0-9_-]*)`?\s*$/u.exec(line);
      return match?.[1]?.toUpperCase() === cellId.toUpperCase();
    });
  });
}

// ── roster ledger — OP's roster rank (`eln work roster`) ─────────────────────────────────────────────
// A small ledger OP rewrites when it sets a version's roster (ROSTER-<v>.md «로스터 N»): cell ids in rank order. Absent /
// another version / unreadable = no rank (roster cells order by priority).
export const rosterPath = (root: string): string => join(root, 'steward', 'roster.json');
export interface RosterLedger { readonly version: string; readonly cells: readonly string[]; readonly at?: string; readonly by?: string }

export function readRoster(root: string): RosterLedger | undefined {
  try {
    const path = rosterPath(root);
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; cells?: unknown; at?: unknown; by?: unknown };
    if (typeof raw.version !== 'string' || !Array.isArray(raw.cells)) return undefined;
    return { version: raw.version, cells: raw.cells.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()),
      ...(typeof raw.at === 'string' ? { at: raw.at } : {}), ...(typeof raw.by === 'string' ? { by: raw.by } : {}) };
  } catch { return undefined; }
}

/** cell id → rank (0 = first) for `version`, or undefined. */
export function rosterRank(ledger: RosterLedger | undefined, version: string): Map<string, number> | undefined {
  if (!ledger || ledger.version !== version || !ledger.cells.length) return undefined;
  const out = new Map<string, number>();
  ledger.cells.forEach((id, i) => { if (!out.has(id)) out.set(id, i); });
  return out;
}

export function writeRoster(root: string, row: { version: string; cells: readonly string[]; by: string; nowMs: number }): RosterLedger {
  const ledger: RosterLedger = { version: row.version, cells: [...new Set(row.cells.map((c) => c.trim()).filter(Boolean))], at: new Date(row.nowMs).toISOString(), by: row.by.toUpperCase() };
  const path = rosterPath(root);
  mkdirSync(join(root, 'steward'), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(ledger)}\n`);
  renameSync(`${path}.tmp`, path);
  return ledger;
}
