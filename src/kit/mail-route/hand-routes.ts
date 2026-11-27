// KIT mail-route · routing table loader — the ✋ domain routes and the dormant-seat routes are DATA (hand-routes.yaml),
// not TypeScript branches (HAND-RAISE-DOMAIN-ROUTING · DORMANT-SEAT-ROUTE · 0.3.38 · north star «everything YAML-definable»).
//
// Read order: the built-in `hand-routes.yaml` next to this file ⊕ an optional override `<state>/msg/hand-routes.yaml`
// (each top-level section it names replaces the built-in one). Re-read only when a file changes.
//
// 세 얼굴: 관측 = {@link readHandRoutes}().source names the files in force (callers log it with each move) · 판단 근거 =
// the YAML (an invalid row is dropped with a reason in `problems`) · 수복과 인계 = a broken or missing table is an EMPTY
// table: every ✋ keeps its old rung and every post keeps its address — routing never blocks a hand.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { elanousStateRoot } from '../../autopilot/state-paths.js';

/** The roots a ✋ can have. `ambiguous` = nothing decided it (the old rung). */
export const HAND_ROOTS = ['wip-handoff', 'jud-verdict', 'hold', 'env', 'cell-scope', 'auto-continue', 'design-decision', 'ambiguous'] as const;
export type HandRoot = typeof HAND_ROOTS[number];
const isRoot = (v: unknown): v is HandRoot => typeof v === 'string' && (HAND_ROOTS as readonly string[]).includes(v);

/** `keep` = the old rung · `cell-owner` = the ✋ cell's checklist owner · anything else = that address. */
export type HandOwnerSpec = { readonly kind: 'keep' } | { readonly kind: 'cell-owner'; readonly otherwise: HandOwnerSpec } | { readonly kind: 'address'; readonly address: string };

export interface HandRootRoute { readonly owner: HandOwnerSpec; readonly attach?: string }

export interface HandRoutesTable {
  readonly relievedRungs: ReadonlySet<string>;
  readonly roots: Readonly<Partial<Record<HandRoot, HandRootRoute>>>;
  readonly causes: Readonly<Record<string, HandRoot>>;
  readonly reasons: Readonly<Record<string, HandRoot>>;
  /** model answer word → root and what the word means (the classifier prompt is built from this). */
  readonly classifier: Readonly<Record<string, { readonly root: HandRoot; readonly means: string }>>;
  /** Reason codes whose root is only a default the classifier may refine. */
  readonly refineReasons: ReadonlySet<string>;
  readonly classifierTimeoutMs: number;
  /** Top Jev probability needed for a classifier word to route. */
  readonly classifierMinProbability: number;
  /** plan-limit (the TUI auto-continue cap): the 행정관 resumes the hand until it hits the cap this many times in an hour → card to its leader. */
  readonly autoContinueCardAfterHitsPerHour: number;
  readonly dedupeWindowMs: number;
  readonly dormant: {
    readonly routes: Readonly<Record<string, string>>;
    readonly alternates: Readonly<Record<string, readonly string[]>>;
    readonly resourceAddresses: ReadonlySet<string>;
    readonly unansweredMs: number;
    readonly cardTo: string;
    readonly sweepWindowMs: number;
  };
  /**
   * GUARDIAN-HAND-SLA — ✋ at a loop-agent address (no tab reads ✋ there) unanswered for `slaMs` are re-routed once:
   * `byReason[reason]` (else `otherwise`) names the taker — {@link LOOP_HAND_ROUTED_FROM} = the rung the ✋ was moved from
   * (its `hand-routed-from:` ref · the hand's leader) · an address · the HQ seat = left to the HQ beacon card.
   */
  readonly loopHands: {
    readonly receivers: ReadonlySet<string>;
    readonly slaMs: number;
    readonly byReason: Readonly<Record<string, string>>;
    readonly otherwise: string;
  };
  /** Files read (built-in first). */
  readonly source: readonly string[];
  /** Rows dropped while reading (shown by tests and the caller's log). */
  readonly problems: readonly string[];
}

const up = (s: string): string => s.trim().toUpperCase();
/** loopHands taker word: the rung the ✋ was moved from (`hand-routed-from:` ref). */
export const LOOP_HAND_ROUTED_FROM = 'routed-from';
const ADDRESS = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const MAX_MINUTES = 24 * 60;

function ownerSpec(raw: unknown, otherwise: unknown, problems: string[], where: string): HandOwnerSpec | null {
  if (typeof raw !== 'string' || !raw.trim()) { problems.push(`${where}: owner missing`); return null; }
  const v = raw.trim();
  if (v === 'keep') return { kind: 'keep' };
  if (v === 'cell-owner') return { kind: 'cell-owner', otherwise: (otherwise === undefined ? null : ownerSpec(otherwise, undefined, problems, `${where}.else`)) ?? { kind: 'keep' } };
  if (!ADDRESS.test(up(v))) { problems.push(`${where}: owner ${v} is not an address`); return null; }
  return { kind: 'address', address: up(v) };
}

const minutes = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_MINUTES ? v * 60_000 : d);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const addresses = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(up).filter((x) => ADDRESS.test(x)) : []);

/** The empty table: nothing is moved, nothing is folded (the old behaviour of every entrance). */
export const EMPTY_HAND_ROUTES: HandRoutesTable = {
  relievedRungs: new Set(), roots: {}, causes: {}, reasons: {}, classifier: {}, refineReasons: new Set(), classifierTimeoutMs: 8_000, classifierMinProbability: 0.5, autoContinueCardAfterHitsPerHour: 3, dedupeWindowMs: 0,
  dormant: { routes: {}, alternates: {}, resourceAddresses: new Set(), unansweredMs: 10 * 60_000, cardTo: 'OP', sweepWindowMs: 2 * 60 * 60_000 },
  loopHands: { receivers: new Set(), slaMs: 10 * 60_000, byReason: {}, otherwise: 'OP' },
  source: [], problems: [],
};

/** Parse one table document (already merged). Pure: invalid rows are dropped and named in `problems`. */
export function handRoutesFrom(raw: unknown, source: readonly string[] = []): HandRoutesTable {
  const doc = obj(raw);
  const problems: string[] = [];
  if (doc.version !== 1) { problems.push(`version ${String(doc.version)} is not 1 — empty table`); return { ...EMPTY_HAND_ROUTES, source, problems }; }
  const roots: Partial<Record<HandRoot, HandRootRoute>> = {};
  for (const [name, row] of Object.entries(obj(doc.roots))) {
    if (!isRoot(name) || name === 'ambiguous') { problems.push(`roots.${name}: unknown root`); continue; }
    const r = obj(row);
    const owner = ownerSpec(r.owner, r.else, problems, `roots.${name}`);
    if (!owner) continue;
    roots[name] = { owner, ...(typeof r.attach === 'string' && r.attach.trim() ? { attach: r.attach.trim() } : {}) };
  }
  const rootMap = (section: string, upper: boolean): Record<string, HandRoot> => {
    const out: Record<string, HandRoot> = {};
    for (const [code, root] of Object.entries(obj(doc[section]))) {
      if (!isRoot(root)) { problems.push(`${section}.${code}: unknown root ${String(root)}`); continue; }
      out[upper ? up(code) : code.trim()] = root;
    }
    return out;
  };
  const classifier: Record<string, { root: HandRoot; means: string }> = {};
  for (const [word, row] of Object.entries(obj(doc.classifier))) {
    const r = obj(row);
    if (!isRoot(r.root) || typeof r.means !== 'string' || !r.means.trim()) { problems.push(`classifier.${word}: needs root and means`); continue; }
    classifier[word.trim().toLowerCase()] = { root: r.root, means: r.means.trim() };
  }
  const d = obj(doc.dormant);
  const routes: Record<string, string> = {};
  for (const [from, to] of Object.entries(obj(d.routes))) {
    if (typeof to !== 'string' || !ADDRESS.test(up(to)) || !ADDRESS.test(up(from))) { problems.push(`dormant.routes.${from}: not an address`); continue; }
    routes[up(from)] = up(to);
  }
  const alternates: Record<string, string[]> = {};
  for (const [from, list] of Object.entries(obj(d.alternates))) alternates[up(from)] = addresses(list);
  const cardTo = typeof d.cardTo === 'string' && ADDRESS.test(up(d.cardTo)) ? up(d.cardTo) : EMPTY_HAND_ROUTES.dormant.cardTo;
  const l = obj(doc.loopHands);
  const taker = (v: unknown, where: string): string | null => {
    if (v === LOOP_HAND_ROUTED_FROM) return LOOP_HAND_ROUTED_FROM;
    if (typeof v === 'string' && ADDRESS.test(up(v))) return up(v);
    problems.push(`${where}: ${String(v)} is neither ${LOOP_HAND_ROUTED_FROM} nor an address`);
    return null;
  };
  const byReason: Record<string, string> = {};
  for (const [code, v] of Object.entries(obj(l.byReason))) { const t = taker(v, `loopHands.byReason.${code}`); if (t) byReason[up(code)] = t; }
  const otherwise = l.else === undefined ? EMPTY_HAND_ROUTES.loopHands.otherwise : taker(l.else, 'loopHands.else') ?? EMPTY_HAND_ROUTES.loopHands.otherwise;
  return {
    relievedRungs: new Set(addresses(doc.relievedRungs)),
    roots, causes: rootMap('causes', false), reasons: rootMap('reasons', true), classifier,
    refineReasons: new Set(addresses(doc.refineReasons)),
    classifierTimeoutMs: typeof doc.classifierTimeoutSeconds === 'number' && doc.classifierTimeoutSeconds > 0 && doc.classifierTimeoutSeconds <= 120
      ? doc.classifierTimeoutSeconds * 1000 : EMPTY_HAND_ROUTES.classifierTimeoutMs,
    classifierMinProbability: typeof doc.classifierMinProbability === 'number' && doc.classifierMinProbability > 0 && doc.classifierMinProbability <= 1
      ? doc.classifierMinProbability : EMPTY_HAND_ROUTES.classifierMinProbability,
    autoContinueCardAfterHitsPerHour: (() => { const v = obj(doc.autoContinueCap).cardAfterHitsPerHour; return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 50 ? v : EMPTY_HAND_ROUTES.autoContinueCardAfterHitsPerHour; })(),
    dedupeWindowMs: minutes(obj(doc.dedupe).windowMinutes, 0),
    dormant: {
      routes, alternates, resourceAddresses: new Set(addresses(d.resourceAddresses)),
      unansweredMs: minutes(d.unansweredMinutes, EMPTY_HAND_ROUTES.dormant.unansweredMs), cardTo,
      sweepWindowMs: minutes(d.sweepWindowMinutes, EMPTY_HAND_ROUTES.dormant.sweepWindowMs),
    },
    loopHands: { receivers: new Set(addresses(l.receivers)), slaMs: minutes(l.slaMinutes, EMPTY_HAND_ROUTES.loopHands.slaMs), byReason, otherwise },
    source, problems,
  };
}

export const BUILTIN_HAND_ROUTES_FILE = join(import.meta.dir, 'hand-routes.yaml');
export function handRoutesOverrideFile(root: string = join(elanousStateRoot(), 'msg')): string {
  return join(root, 'hand-routes.yaml');
}

const mtime = (file: string): number | null => { try { return statSync(file).mtimeMs; } catch { return null; } };
const cache = new Map<string, { stamp: string; table: HandRoutesTable }>();

/** The table in force. `files` defaults to [built-in, override]; a file that does not exist is skipped. Never throws. */
export function readHandRoutes(files: readonly string[] = [BUILTIN_HAND_ROUTES_FILE, handRoutesOverrideFile()]): HandRoutesTable {
  const present = files.filter((f) => mtime(f) !== null);
  const stamp = present.map((f) => `${f}@${mtime(f)}`).join('|');
  const key = files.join('|');
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit.table;
  let merged: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const file of present) {
    try { merged = { ...merged, ...obj(parseYaml(readFileSync(file, 'utf8'))) }; }
    catch (error) { problems.push(`${file}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`); }
  }
  const parsed = handRoutesFrom(merged, present);
  const table = problems.length ? { ...parsed, problems: [...problems, ...parsed.problems] } : parsed;
  cache.set(key, { stamp, table });
  return table;
}
