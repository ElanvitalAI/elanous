// kit/seat-area — SEAT-AREA-GUARD (0.3.39 P0 · Claude OP 11-28) — the ONE «may this seat be handed this cell?» reader
// (graphs/policies/seat-roles.yaml · first slice of YAML-SEAT-ROLES). Consumers: `eln seat assign` (the door every push
// path goes through — resource steward RO rows · 행정관 · OP direct · SeatAssign tool), OP's next-action planner, the hand
// steward (hints ⊕ claim-for), the space steward (R1 `fits`), the resource matching table and `eln work next`.
//
// S: 11-28 the hand pool listed MK and UX (coordinators under OP, ladder depth 3) as general hands, so every idle MK/UX pane
//    drew the top stalled P0 whatever it was — 40 assigns to MK in one day, four after the CEO made MK the docs-P0 owner.
// C: «judge hands are kingdom-only» was the only role rule (isJudgeHand); nothing said what a coordinator's area is.
// Q: who is a pool hand, and which cells fit a seat?
// A: seatTakesCell(seat, cell, policy) — pool: false = never handed a cell · areas present = only cells whose target paths
//    or id match them · a cell with no area signal = general hands only · the seat's own cell always fits. The answer
//    carries the rule it matched («area match: path website/x ~ website/**») so the assignment mail can show it.
// 세 얼굴: 관측 = the rule string in every SEAT-ASSIGN mail ⊕ the `off-area` refusal code ⊕ `liveSeatRoles().error` ·
//          판단 근거 = rules only (globs over declared paths / ids · no LLM) · 수복과 인계 = a refused pair falls through to the
//          next hand (matching table · steward refusals) · an unreadable file = the pre-policy board, the error named.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { parseChecklistTargetPaths } from '../../release-loop/checklist.js';

export type SeatKind = 'coordinator' | 'hand' | 'judge';
const KINDS: readonly SeatKind[] = ['coordinator', 'hand', 'judge'];

export interface SeatAreas { readonly paths: readonly string[]; readonly cells: readonly string[] }
export interface SeatRule { readonly kind: SeatKind; readonly pool: boolean; readonly areas?: SeatAreas }
export interface SeatRolesPolicy { readonly fallback: SeatRule; readonly seats: ReadonlyArray<{ readonly key: string; readonly rule: SeatRule }> }

/** The board before this policy: every seat a pool hand with no areas (what the code did before seat-roles.yaml). */
export const legacySeatRoles = (): SeatRolesPolicy => ({ fallback: { kind: 'hand', pool: true }, seats: [] });

export const seatRolesPath = (root = resolve(import.meta.dir, '../../..')): string => join(root, 'graphs', 'policies', 'seat-roles.yaml');

const globList = (v: unknown, key: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) throw new Error(`seat-roles policy: ${key} must be a list of globs`);
  return (v as string[]).map((x) => x.trim());
};

function parseRule(v: unknown, key: string): SeatRule {
  if (!v || typeof v !== 'object') throw new Error(`seat-roles policy: ${key} must be a mapping`);
  const raw = v as Record<string, unknown>;
  if (!KINDS.includes(raw.kind as SeatKind)) throw new Error(`seat-roles policy: ${key}.kind must be one of ${KINDS.join(' · ')}`);
  if (typeof raw.pool !== 'boolean') throw new Error(`seat-roles policy: ${key}.pool must be true or false`);
  if (raw.areas === undefined) return { kind: raw.kind as SeatKind, pool: raw.pool };
  if (!raw.areas || typeof raw.areas !== 'object') throw new Error(`seat-roles policy: ${key}.areas must be a mapping`);
  const a = raw.areas as Record<string, unknown>;
  const areas = { paths: globList(a.paths, `${key}.areas.paths`), cells: globList(a.cells, `${key}.areas.cells`) };
  if (!areas.paths.length && !areas.cells.length) throw new Error(`seat-roles policy: ${key}.areas needs paths or cells (drop areas for «any cell»)`);
  return { kind: raw.kind as SeatKind, pool: raw.pool, areas };
}

export function parseSeatRoles(text: string): SeatRolesPolicy {
  const raw = parse(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new Error('seat-roles policy: not a mapping');
  if (raw.version !== 1) throw new Error('seat-roles policy: version must be 1');
  const seats = raw.seats ?? {};
  if (typeof seats !== 'object' || Array.isArray(seats)) throw new Error('seat-roles policy: seats must be a mapping');
  return {
    fallback: raw.default === undefined ? legacySeatRoles().fallback : parseRule(raw.default, 'default'),
    seats: Object.entries(seats as Record<string, unknown>).map(([key, rule]) => ({ key: key.trim().toUpperCase(), rule: parseRule(rule, `seats.${key}`) })),
  };
}

export function loadSeatRoles(path = seatRolesPath()): SeatRolesPolicy {
  if (!existsSync(path)) throw new Error(`seat-roles policy missing: ${path}`);
  return parseSeatRoles(readFileSync(path, 'utf8'));
}

let cached: { policy: SeatRolesPolicy; source: 'yaml' | 'legacy'; error?: string } | undefined;
/** The live read (once per process): the shipped file, else the pre-policy board with the error named. */
export function liveSeatRoles(): { policy: SeatRolesPolicy; source: 'yaml' | 'legacy'; error?: string } {
  if (cached) return cached;
  try { cached = { policy: loadSeatRoles(), source: 'yaml' }; } catch (error) { cached = { policy: legacySeatRoles(), source: 'legacy', error: String(error).slice(0, 200) }; }
  return cached;
}

// ── pure rules ─────────────────────────────────────────────────────────────────────────────────

const escape = (s: string): string => s.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
/** `**` = any depth · `*` = within one segment (for ids: any run) · `?` = one char. `x/**` also matches `x` itself. */
export function globMatch(glob: string, value: string, opts: { segments?: boolean } = {}): boolean {
  const seg = opts.segments !== false;
  const g = glob.trim();
  const v = value.trim().replace(/\/+$/u, '');
  if (!g || !v) return false;
  if (g.endsWith('/**') && v === g.slice(0, -3)) return true;
  const re = g.split('**').map((part) => part.split('*').map((p) => p.split('?').map(escape).join(seg ? '[^/]' : '.')).join(seg ? '[^/]*' : '.*')).join('.*');
  return new RegExp(`^${re}$`, seg ? 'u' : 'iu').test(v);
}

/** The rule of a seat: exact id → the longest matching glob key → the policy default. */
export function seatRuleOf(seat: string, policy: SeatRolesPolicy): { readonly key: string; readonly rule: SeatRule } {
  const id = seat.trim().toUpperCase();
  const exact = policy.seats.find((s) => s.key === id);
  if (exact) return exact;
  const glob = policy.seats.filter((s) => s.key.includes('*') && globMatch(s.key, id, { segments: false })).sort((a, b) => b.key.length - a.key.length)[0];
  return glob ?? { key: 'default', rule: policy.fallback };
}

/** Pool hand = a seat the planner / stewards / work next may hand cells to (judges: the maker ≠ judge rules decide). */
export const isPoolSeat = (seat: string, policy: SeatRolesPolicy): boolean => seatRuleOf(seat, policy).rule.pool;

export interface AreaCell {
  readonly id: string;
  readonly title?: string;
  readonly owner?: string;
  readonly body?: string;
  readonly doneCriterion?: string;
  /** Target paths the caller already parsed (hand steward) — merged with what the text declares. */
  readonly paths?: readonly string[];
}

// A repo-relative path token: a top-level segment ⊕ «/» (website/ · release/next.md · src/els/x.ts).
const PATH_TOKEN = /(?:^|[\s`'"(«])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*)/gu;

/** The cell's area signals: the «대상 경로:» line of title/body ⊕ repo-looking paths in title/body/done-when ⊕ given paths.
 *  A labelled fragment may run on into prose («대상 경로: src/tui/entry.ts — 큐 항목별 …»): its first token is the path. */
export function cellAreaPaths(cell: AreaCell): string[] {
  const out = new Set<string>(cell.paths ?? []);
  for (const text of [cell.title ?? '', cell.body ?? '']) { try { for (const p of parseChecklistTargetPaths(text)) if (p.trim()) out.add(p); } catch { /* no label */ } }
  for (const text of [cell.title ?? '', cell.body ?? '', cell.doneCriterion ?? '']) for (const m of text.matchAll(PATH_TOKEN)) out.add(m[1]!.replace(/[.,;:)»]+$/u, ''));
  return [...new Set([...out].map((p) => (p.trim().split(/\s+/u)[0] ?? '').replace(/^`+|`+$/gu, '').replace(/^\.\//u, '').replace(/\/+$/u, '')))].filter((p) => p.length > 1 && !p.includes('..') && !p.startsWith('/') && !/^https?:/iu.test(p));
}

/** ok ⊕ `area` = the seat fits BY ITS AREA (owner · id namespace · path) — preferred over a general hand for the same cell. */
export type AreaFit = { readonly ok: true; readonly rule: string; readonly area: boolean } | { readonly ok: false; readonly code: 'not-pool' | 'off-area' | 'no-area'; readonly reason: string };

/** May `seat` be handed `cell`? The answer names the rule (ok) or why not (refusal). Pure. */
export function seatTakesCell(seatRaw: string, cell: AreaCell, policy: SeatRolesPolicy): AreaFit {
  const seat = seatRaw.trim().toUpperCase();
  const { key, rule } = seatRuleOf(seat, policy);
  const owner = (cell.owner ?? '').trim().split(/[/:\s]/u)[0]?.toUpperCase() ?? '';
  if (owner && owner === seat) return { ok: true, rule: `owner (${seat} holds ${cell.id})`, area: true };
  if (rule.kind === 'judge') return { ok: true, rule: `judge seat (${key}) — maker ≠ judge rules decide`, area: false };
  if (!rule.pool) return { ok: false, code: 'not-pool', reason: `${seat} is a ${rule.kind} seat outside the hand pool (seat-roles.yaml ${key}: pool false)` };
  if (!rule.areas) return { ok: true, rule: key === 'default' ? 'pool hand (any area)' : `${key} ${rule.kind} (any area)`, area: false };
  const idGlob = rule.areas.cells.find((g) => globMatch(g, cell.id.toUpperCase(), { segments: false }));
  if (idGlob) return { ok: true, rule: `cell ${cell.id} ~ ${idGlob}`, area: true };
  const paths = cellAreaPaths(cell);
  for (const p of paths) {
    const g = rule.areas.paths.find((glob) => globMatch(glob, p));
    if (g) return { ok: true, rule: `path ${p} ~ ${g}`, area: true };
  }
  if (!paths.length) return { ok: false, code: 'no-area', reason: `${cell.id} declares no target path and no ${seat} id namespace — general hands only (seat-roles.yaml ${key} areas)` };
  return { ok: false, code: 'off-area', reason: `${cell.id} paths ${paths.slice(0, 3).join(' · ')} are outside ${seat}'s areas (seat-roles.yaml ${key})` };
}

/** The live predicate (shipped policy, else the pre-policy board where every seat fits). Never throws. */
export function liveSeatFit(): (seat: string, cell: AreaCell) => AreaFit {
  const { policy } = liveSeatRoles();
  return (seat, cell) => { try { return seatTakesCell(seat, cell, policy); } catch { return { ok: true, rule: 'seat-roles unreadable (pre-policy board)', area: false }; } };
}

/**
 * The one pairing rule every pusher shares: for this cell, the first candidate (callers pass them longest-idle first) that
 * fits BY ITS AREA, else the first that fits at all, else -1. A specialist (MK on a docs cell · UX on a surface cell) is
 * not left idle while a general hand takes the only work it may do. `fit` absent = the first candidate (pre-policy).
 */
export function pickByArea<T>(candidates: readonly T[], seatOf: (c: T) => string, fit?: (seat: string) => { readonly ok: boolean; readonly area?: boolean }): number {
  if (!fit) return candidates.length ? 0 : -1;
  let general = -1;
  for (let i = 0; i < candidates.length; i++) {
    let f: { readonly ok: boolean; readonly area?: boolean };
    try { f = fit(seatOf(candidates[i]!)); } catch { f = { ok: true }; }
    if (!f.ok) continue;
    if (f.area) return i;
    if (general < 0) general = i;
  }
  return general;
}
