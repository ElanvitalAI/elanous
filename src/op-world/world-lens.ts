// OP-WORLD-LENS — the ledger-driven «OP world card» (CEO 11-27 13:0x «OP 가 보는 세계를 우리가 잘 조정해 줘야 합니다 ·
// 관측 툴부터 · 클린징 · 맥락 기억»).
// S: eln OP hand-assembled its numbers every pulse: it read the 0.3.37 board while 0.3.38 was live, its bulletin said
//    «main 착지 0» while 7 had landed (wrong source/window), the land-graph refusal list it quoted was full of closed PRs,
//    the snapshot said «idle 측정 실패», and TC's 36-mail backlog (oldest 26h) was nowhere in its view.
// C: the facts all exist in ledgers (checklist · first-parent main · land graph · hand pool · msg store · commitments ·
//    HOLD ledger · loop-agent homes · lease ledger); what was missing is ONE card that reads them the same way every
//    time, names the source command per number, and says what changed since OP's last turn.
// Q: what is the smallest card OP reads at every turn and pulse that replaces the hand-assembly?
// A: `collectWorldLens` (async · each reader fails open to null = «?», never 0) → `renderLensLines` (pure). Land
//    throughput uses `gitLandFacts` (the same first-parent source as `eln fed kpi`); the land queue drops PRs that are no
//    longer open (gh open set, cached); the board counts stale and obsolete cells (graphs/policies/op-world.yaml); the
//    previous release's leftovers are a separate line. The card is cached in <state>/op-world/lens.json so the sync turn
//    path reads it; the «Δ since your last turn» line diffs against the seat's last-seen numbers.
// 세 얼굴: 관측 = the card itself (each line ends in `[src: <command>]`) ⊕ lens.json ⊕ `eln op world --json` /
//    판단 근거 = the policy file values (stale_hours · obsolete_markers · coordinators · stale_tick_min) /
//    수복과 인계 = every reader fails open to «?» and the unread list is printed; nothing here writes a ledger.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ChecklistItem } from '../release-loop/checklist.js';
import type { HandPoolEntry } from '../seat/hand-pool.js';
import type { LedgerRow } from '../land-graph/land-graph.js';

const HOUR = 3_600_000;
const MIN = 60_000;

// ── policy (graphs/policies/op-world.yaml) ──────────────────────────────────────────────────────────────────────────

export interface LensPolicy {
  staleHours: number;
  obsoleteMarkers: string[];
  coordinators: string[];
  oldestWarnMin: number;
  openPrsCacheMin: number;
  staleTickMin: number;
  cacheMaxAgeMin: number;
  /** Cheat lines (exact CLI forms) that ride every card — 내부 문서 `KNOWHOW` K-OP-158 is the full card. */
  cheat: string[];
  /** OP-HELPERS-STABILIZE: OP's body helpers whose health the card shows (graphs/policies/op-world.yaml `helpers`). */
  helpers: HelperSpec[];
}
/** One OP body helper: a registered trigger graph (its fires) or a JSONL ledger (its last row's at/ts, optionally the
 *  last row matching `match`). Unhealthy = never ran · its latest finished fire is an exception · older than maxAgeMin. */
export interface HelperSpec { id: string; trigger?: string; ledger?: string; match?: Record<string, string>; maxAgeMin: number }
export const DEFAULT_LENS_POLICY: LensPolicy = {
  staleHours: 24, obsoleteMarkers: ['obsolete', 'superseded', '폐기', '대체됨', '무효'], coordinators: ['OP', 'TC', 'UX', 'MK', 'JUD', 'REL', 'RES'],
  oldestWarnMin: 60, openPrsCacheMin: 10, staleTickMin: 30, cacheMaxAgeMin: 10, cheat: [], helpers: [],
};
export const lensPolicyPath = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'policies', 'op-world.yaml');

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
const strs = (v: unknown, d: string[]) => (Array.isArray(v) && v.every(x => typeof x === 'string') && v.length ? v as string[] : d);

export function parseLensPolicy(text: string): LensPolicy {
  const { parse } = require('yaml') as typeof import('yaml');
  const raw = (parse(text) ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const d = DEFAULT_LENS_POLICY;
  return {
    staleHours: num(raw.board?.stale_hours, d.staleHours), obsoleteMarkers: strs(raw.board?.obsolete_markers, d.obsoleteMarkers),
    coordinators: strs(raw.mail?.coordinators, d.coordinators).map(s => s.toUpperCase()), oldestWarnMin: num(raw.mail?.oldest_warn_min, d.oldestWarnMin),
    openPrsCacheMin: num(raw.land?.open_prs_cache_min, d.openPrsCacheMin), staleTickMin: num(raw.supervisors?.stale_tick_min, d.staleTickMin),
    cacheMaxAgeMin: num(raw.lens?.cache_max_age_min, d.cacheMaxAgeMin),
    cheat: strs((raw as Record<string, unknown>).cheat, d.cheat).slice(0, 8),
    helpers: parseHelpers((raw as Record<string, unknown>).helpers),
  };
}
/** `helpers:` rows — a row needs an id and exactly one of trigger | ledger; anything else is dropped (never guessed). */
export function parseHelpers(v: unknown): HelperSpec[] {
  if (!Array.isArray(v)) return [];
  const out: HelperSpec[] = [];
  for (const r of v as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) continue;
    const trigger = typeof r.trigger === 'string' && r.trigger ? r.trigger : undefined;
    const ledger = typeof r.ledger === 'string' && r.ledger ? r.ledger : undefined;
    if (!!trigger === !!ledger) continue;
    const match = r.match && typeof r.match === 'object' ? Object.fromEntries(Object.entries(r.match as Record<string, unknown>).filter(([, x]) => typeof x === 'string')) as Record<string, string> : undefined;
    out.push({ id: r.id, ...(trigger ? { trigger } : {}), ...(ledger ? { ledger } : {}), ...(match && Object.keys(match).length ? { match } : {}), maxAgeMin: num(r.max_age_min, 120) });
  }
  return out;
}
export function loadLensPolicy(path = lensPolicyPath()): LensPolicy {
  try { return parseLensPolicy(readFileSync(path, 'utf8')); } catch { return DEFAULT_LENS_POLICY; }
}

// ── facts ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface BoardLens {
  version: string; total: number; green: number; open: number;
  owners: Array<[string, number]>; opHeld: number;
  /** OP-held cells another implementer already carries (owner OP/claude · evidence «implementing: Claude OP PR #…»). */
  opImplementing: number; stale: number; obsolete: number; obsoleteIds: string[]; green1h: number;
}
export interface LandLens {
  landed1h: number | null; landedToday: number | null;
  /** Open PRs the land graph has a latest decision for (null = open set unread → ledger view whole). */
  openPrs: number | null; droppedClosed: number;
  waiting: Array<[string, number]>; refused: Array<[string, number]>; refusedPrs: Array<[string, number[]]>;
}
export interface PoolLens { idle: number; working: number; noPane: number; wip1: Array<{ seat: string; cells: string[] }> }
export interface MailLens { seat: string; unacked: number; oldestAt: string | null }
export interface SupervisorLens { id: string; lastTickAt: string | null; journal1h: number }
export interface LensFacts {
  at: string;
  board: BoardLens | null;
  prevBoard: { version: string; open: number; total: number; owners: Array<[string, number]> } | null;
  land: LandLens | null;
  pool: PoolLens | null;
  mail: MailLens[] | null;
  hands: Array<{ id: number; from: string; to: string; reason: string; waitedMin: number }> | null;
  commitments: { open: number; overdue: number } | null;
  holds: { active: number; expired: number } | null;
  supervisors: SupervisorLens[] | null;
  /** YAML-SUPERVISORS-RUNTIME: agent.yaml lint (`eln loop agent lint`) — refused definitions run their v2 fallback · null = unread. */
  agentYaml?: { total: number; refused: Array<{ id: string; error: string }> } | null;
  /** LOOP-EXCEPTION-WATCH: registered loops · those whose last fire is `exception` · «미정상화 사건» (kit/case-ledger · target 0) · null = unread. */
  loops?: { total: number; exceptions: Array<{ id: string; at: string | null }>; unnormalized: number | null } | null;
  world: string | null;
  /** OP-HELPERS-STABILIZE: one row per policy helper · null = unread. */
  helpers?: HelperHealth[] | null;
  /** FED-ANALYST-LOOP-AGENT: the newest 30-min analysis (loops/fed-analyst.jsonl) · undefined = no line · null = no row yet. */
  analyst?: { windowEnd: string; passed: number; breaches: number; bottleneck: string } | null;
  unmeasured: string[];
}
export interface HelperHealth { id: string; ok: boolean; why: string }

const seatOf = (owner: string | undefined) => (owner ?? '').split(/[/:\s]/u)[0]?.toUpperCase() ?? '';
const isOpen = (s: string) => s !== 'green' && s !== 'done';

/** Pure: board counts — open by owner, stale (open + untouched ≥ staleHours), obsolete (open but its evidence carries a
 *  marker — the checklist has no obsolete status: an obsolete cell is closed `--status done` with «obsolete: …» evidence,
 *  so an OPEN cell carrying the marker is one the cleanse missed). Title/body are not read (they describe, not decide). */
export function boardLens(version: string, items: ReadonlyArray<Pick<ChecklistItem, 'id' | 'status' | 'owner' | 'updatedAt' | 'evidence'>>, now: Date, p: LensPolicy = DEFAULT_LENS_POLICY): BoardLens {
  const owners = new Map<string, number>();
  let green = 0; let open = 0; let opHeld = 0; let opImplementing = 0; let stale = 0; let green1h = 0; const obsoleteIds: string[] = [];
  const markers = p.obsoleteMarkers.map(m => m.toLowerCase());
  for (const i of items) {
    if (!isOpen(i.status)) {
      green++;
      const t = Date.parse(i.updatedAt ?? '');
      if (i.status === 'green' && Number.isFinite(t) && now.getTime() - t >= 0 && now.getTime() - t <= HOUR) green1h++;
      continue;
    }
    open++;
    const s = seatOf(i.owner) || '(none)';
    owners.set(s, (owners.get(s) ?? 0) + 1);
    if (s === 'OP') {
      opHeld++;
      if (/^op\/claude\b/iu.test(i.owner ?? '') || /implementing:\s*claude op/iu.test(i.evidence ?? '')) opImplementing++;
    }
    const t = Date.parse(i.updatedAt ?? '');
    if (Number.isFinite(t) && now.getTime() - t >= p.staleHours * HOUR) stale++;
    const text = (i.evidence ?? '').toLowerCase();
    if (markers.some(m => text.includes(m))) obsoleteIds.push(i.id);
  }
  return { version, total: items.length, green, open, owners: [...owners].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), opHeld, opImplementing, stale,
    obsolete: obsoleteIds.length, obsoleteIds, green1h };
}

/** Who acts on a waiting class (the «who's waiting on what» column). */
export const WAIT_ACTOR: Record<string, string> = {
  'review-required': 'reviewer (terra)', 'no-receipt': 'author pregate', 'main-moved-overlap': 'train (serialize)', 'focused-unreadable': 'author receipt',
  held: 'HOLD owner', '': 'land graph',
};

/** Pure: the land queue from the ledger — the latest decision/refusal per PR, closed PRs dropped when the open set is known. */
export function landLens(rows: readonly LedgerRow[], open: ReadonlySet<number> | null, landed1h: number | null, now: Date): LandLens {
  const real = rows.filter(r => !r.synthetic);
  const latest = new Map<number, LedgerRow>();
  for (const r of real) if (r.event === 'decision' || r.event === 'refused' || r.event === 'landed') latest.set(r.pr, r);
  let dropped = 0;
  const live: LedgerRow[] = [];
  for (const [pr, r] of latest) {
    if (r.event === 'landed') continue;
    if (open && !open.has(pr)) { dropped++; continue; }
    live.push(r);
  }
  const waiting = new Map<string, number>(); const refused = new Map<string, number>(); const refusedPrs = new Map<string, number[]>();
  for (const r of live) {
    const refusal = r.event === 'refused' || r.action === 'refuse';
    const key = r.cls ?? (r.action === 'hold' ? 'held' : '');
    if (refusal) { const k = key || 'unclassified'; refused.set(k, (refused.get(k) ?? 0) + 1); refusedPrs.set(k, [...(refusedPrs.get(k) ?? []), r.pr]); }
    else if (r.action === 'wait' || r.action === 'hold') waiting.set(key, (waiting.get(key) ?? 0) + 1);
  }
  const today = now.toISOString().slice(0, 10);
  const sort = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { landed1h, landedToday: real.filter(r => r.event === 'landed' && (r.doneAt ?? r.at).startsWith(today)).length,
    openPrs: open ? live.length : null, droppedClosed: dropped, waiting: sort(waiting), refused: sort(refused),
    refusedPrs: [...refusedPrs].map(([k, prs]) => [k, prs.sort((a, b) => a - b)] as [string, number[]]) };
}

/** Pure: hand pool counts ⊕ WIP-1 conflicts (a hand holding ≥2 active cells: open, owned, touched within the window). */
export function poolLens(pool: ReadonlyArray<Pick<HandPoolEntry, 'seat' | 'state'>>, items: ReadonlyArray<Pick<ChecklistItem, 'id' | 'status' | 'owner' | 'updatedAt'>>, now: Date, activeWindowMs: number): PoolLens {
  const hands = new Set(pool.map(h => h.seat.toUpperCase()));
  const active = new Map<string, string[]>();
  for (const i of items) {
    if (!isOpen(i.status)) continue;
    const s = seatOf(i.owner);
    if (!hands.has(s)) continue;
    const t = Date.parse(i.updatedAt ?? '');
    if (!Number.isFinite(t) || now.getTime() - t > activeWindowMs) continue;
    active.set(s, [...(active.get(s) ?? []), i.id]);
  }
  return { idle: pool.filter(h => h.state === 'idle').length, working: pool.filter(h => h.state === 'working').length, noPane: pool.filter(h => h.state === 'no-pane').length,
    wip1: [...active].filter(([, c]) => c.length >= 2).map(([seat, cells]) => ({ seat, cells: cells.sort() })).sort((a, b) => a.seat.localeCompare(b.seat)) };
}

/** Pure: journal rows in the last hour from a cases.jsonl text (rows carry `at`). */
export function journalCount1h(text: string, now: Date): number {
  let n = 0;
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { const t = Date.parse((JSON.parse(l) as { at?: string }).at ?? ''); if (Number.isFinite(t) && now.getTime() - t >= 0 && now.getTime() - t <= HOUR) n++; } catch { /* torn row */ }
  }
  return n;
}

/** The release before `v` on the same minor (0.3.38 → 0.3.37) — the leftovers board; null below .0. */
export function previousVersion(v: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/u.exec(v);
  if (!m || Number(m[3]) === 0) return null;
  return `${m[1]}.${m[2]}.${Number(m[3]) - 1}`;
}

// ── helper health (pure) ────────────────────────────────────────────────────────────────────────────────────────────

/** A trigger helper from its newest fires (newest first): never fired · latest finished fire = exception · too old. */
export function triggerHelperHealth(spec: HelperSpec, fires: ReadonlyArray<{ window: string; status: string; dispatchedAt: string | null; error: string | null }>, now: Date): HelperHealth {
  if (!fires.length) return { id: spec.id, ok: false, why: 'never fired' };
  const finished = fires.find(f => f.status === 'done' || f.status === 'exception' || f.status === 'stale-skipped');
  if (finished?.status === 'exception') return { id: spec.id, ok: false, why: `exception ${finished.window.slice(11, 16)}Z${finished.error ? ` ${finished.error.replace(/\s+/gu, ' ').slice(0, 40)}` : ''}` };
  const last = fires[0]!; const t = Date.parse(last.dispatchedAt ?? last.window);
  const age = Number.isFinite(t) ? Math.round((now.getTime() - t) / MIN) : Infinity;
  if (age > spec.maxAgeMin) return { id: spec.id, ok: false, why: `stale ${Number.isFinite(age) ? fmtMin(age) : '?'}` };
  return { id: spec.id, ok: true, why: `${last.status} ${fmtMin(age)} ago` };
}

/** A ledger helper from its newest matching row time (null = no ledger / no matching row). */
export function ledgerHelperHealth(spec: HelperSpec, lastAt: string | null, now: Date): HelperHealth {
  if (!lastAt) return { id: spec.id, ok: false, why: spec.match ? 'no matching row' : 'no ledger' };
  const t = Date.parse(lastAt);
  if (!Number.isFinite(t)) return { id: spec.id, ok: false, why: 'unreadable time' };
  const age = Math.max(0, Math.round((now.getTime() - t) / MIN));
  return age > spec.maxAgeMin ? { id: spec.id, ok: false, why: `stale ${fmtMin(age)}` } : { id: spec.id, ok: true, why: `${fmtMin(age)} ago` };
}

/** Newest row time (at | ts) in the tail of a JSONL ledger, optionally the newest row whose fields equal `match`. */
export function lastLedgerAt(text: string, match?: Record<string, string>): string | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim(); if (!l) continue;
    try {
      const r = JSON.parse(l) as Record<string, unknown>;
      if (match && !Object.entries(match).every(([k, v]) => String(r[k] ?? '') === v)) continue;
      const at = typeof r.at === 'string' ? r.at : typeof r.ts === 'string' ? r.ts : null;
      if (at) return at;
    } catch { /* a torn tail line */ }
  }
  return null;
}

const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`);

// ── render (pure) ───────────────────────────────────────────────────────────────────────────────────────────────────

const ago = (iso: string | null, now: Date): string => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '?';
  const m = Math.max(0, Math.round((now.getTime() - t) / MIN));
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
const pairs = (xs: ReadonlyArray<[string, number]>, max = 6) => xs.slice(0, max).map(([k, n]) => `${k || '-'} ${n}`).join(' · ') || 'none';
const q = (v: number | null | undefined) => (v === null || v === undefined ? '?' : String(v));

/** The numbers the Δ line compares (flat · stable keys). */
export function lensNumbers(f: LensFacts): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (k: string, v: number | null | undefined) => { if (typeof v === 'number') out[k] = v; };
  put('open cells', f.board?.open); put('OP-held', f.board?.opHeld); put('stale', f.board?.stale); put('obsolete', f.board?.obsolete);
  put('green', f.board?.green); put('landed today', f.land?.landedToday); put('land queue', f.land?.openPrs);
  put('refused', f.land ? f.land.refused.reduce((a, [, n]) => a + n, 0) : null);
  put('idle hands', f.pool?.idle); put('WIP-1 conflicts', f.pool?.wip1.length); put('✋', f.hands?.length);
  put('OP overdue', f.commitments?.overdue); put('HOLDs', f.holds?.active);
  put('helpers failing', f.helpers ? f.helpers.filter(h => !h.ok).length : null);
  for (const m of f.mail ?? []) put(`mail ${m.seat}`, m.unacked);
  return out;
}

export function deltaLine(prev: { at: string; numbers: Record<string, number> } | null, f: LensFacts, now: Date): string {
  if (!prev) return '- Δ since your last turn: first card (no previous numbers)';
  const cur = lensNumbers(f);
  const ch = Object.keys(cur).filter(k => prev.numbers[k] !== undefined && prev.numbers[k] !== cur[k]).map(k => { const d = cur[k]! - prev.numbers[k]!; return `${k} ${d > 0 ? '+' : ''}${d}`; });
  return `- Δ since your last turn (${ago(prev.at, now)} ago): ${ch.length ? ch.slice(0, 12).join(' · ') : 'no change'}`;
}

/** Pure: the card lines. Every line ends in its source command; «?» = unread (see «unread»), never zero. */
export function renderLensLines(f: LensFacts, now: Date, prev: { at: string; numbers: Record<string, number> } | null, p: LensPolicy = DEFAULT_LENS_POLICY): string[] {
  const L: string[] = ['### OP world card — every number names its source (re-run it before acting on one number)'];
  const b = f.board;
  if (b) {
    L.push(`- Board ${b.version}: ${b.open} open / ${b.total} · by owner ${pairs(b.owners)} · stale(≥${p.staleHours}h) ${b.stale} · obsolete ${b.obsolete}${b.obsolete ? ` (${b.obsoleteIds.slice(0, 6).join(', ')}${b.obsoleteIds.length > 6 ? ', …' : ''})` : ''} [src: eln release checklist list --version ${b.version} --json]`);
    if (b.opHeld) L.push(`  ⚠ OP holds ${b.opHeld} open cell(s)${b.opImplementing ? ` (${b.opImplementing} already carried by a Claude OP PR — judge/land those, do not re-assign)` : ''} — hands cannot pull the rest: hand out, set owner to the implementer, or drop obsolete [src: eln release checklist list --version ${b.version} --owner OP]`);
  } else L.push('- Board: ? [src: eln release checklist list --version <active> --json]');
  if (f.prevBoard && f.prevBoard.open) L.push(`- Leftovers ${f.prevBoard.version}: ${f.prevBoard.open} open / ${f.prevBoard.total} (${pairs(f.prevBoard.owners, 4)}) — NOT the active board; move what still matters, leave the rest [src: eln release checklist status --version ${f.prevBoard.version}]`);
  const l = f.land;
  if (l) {
    L.push(`- Landed: 1h ${q(l.landed1h)} (first-parent main «(#N)», same as fed kpi) · today ${q(l.landedToday)} (land graph) · green 1h ${q(b?.green1h)} [src: eln fed kpi --json · eln land graph status]`);
    L.push(`- Land queue: ${l.openPrs === null ? '? open (gh unread — ledger view, may include closed PRs)' : `${l.openPrs} open PRs`}${l.droppedClosed ? ` · ${l.droppedClosed} closed/merged dropped` : ''} · waiting: ${l.waiting.length ? l.waiting.slice(0, 5).map(([k, n]) => `${k || 'wait'} ${n} → ${WAIT_ACTOR[k] ?? 'land graph'}`).join(' · ') : 'none'} [src: eln land graph status]`);
    if (l.refused.length) L.push(`- Refusals by root: ${[...l.refusedPrs].sort((x, y) => y[1].length - x[1].length).slice(0, 6).map(([k, prs]) => `${k} ${prs.length} (#${prs.slice(0, 4).join(' #')}${prs.length > 4 ? ' …' : ''})`).join(' · ')} [src: eln land graph status]`);
  } else L.push('- Landed: ? [src: eln fed kpi --json · eln land graph status]');
  const pl = f.pool;
  L.push(pl ? `- Hands: working ${pl.working} · idle ${pl.idle} · no-pane ${pl.noPane} · WIP-1 conflicts ${pl.wip1.length}${pl.wip1.length ? ` (${pl.wip1.slice(0, 3).map(w => `${w.seat}: ${w.cells.slice(0, 3).join(',')}`).join(' · ')})` : ''} [src: eln seat pool --json]`
    : '- Hands: ? [src: eln seat pool --json]');
  if (f.mail) {
    const rows = f.mail.filter(m => m.unacked > 0).sort((a, b) => b.unacked - a.unacked);
    const warn = (m: MailLens) => { const t = m.oldestAt ? Date.parse(m.oldestAt) : NaN; return Number.isFinite(t) && now.getTime() - t >= p.oldestWarnMin * MIN ? ' ⚠' : ''; };
    L.push(`- Mail backlog (coordinators): ${rows.length ? rows.map(m => `${m.seat} ${m.unacked} (oldest ${ago(m.oldestAt, now)}${warn(m)})`).join(' · ') : 'all zero'} [src: eln msg count --to <seat> · eln msg list --to <seat>]`);
  } else L.push('- Mail backlog: ? [src: eln msg count --to <seat>]');
  L.push(f.hands ? `- ✋ open ${f.hands.length}${f.hands.length ? `: ${f.hands.slice(0, 4).map(h => `${h.from}→${h.to} ${h.reason} ${h.waitedMin}m`).join(' · ')}` : ''} [src: eln msg hand list]` : '- ✋ open: ? [src: eln msg hand list]');
  L.push(`- OP commitments: ${f.commitments ? `open ${f.commitments.open} · overdue ${f.commitments.overdue}` : '?'} · HOLDs: ${f.holds ? `active ${f.holds.active} · expired ${f.holds.expired}` : '?'} [src: eln commitment list --seat OP · eln hold ls]`);
  if (f.supervisors) {
    const stale = f.supervisors.filter(s => { const t = s.lastTickAt ? Date.parse(s.lastTickAt) : NaN; return !Number.isFinite(t) || now.getTime() - t > p.staleTickMin * MIN; });
    L.push(`- Supervisors: ${f.supervisors.length} loop agents${f.agentYaml ? ` · agent.yaml ${f.agentYaml.total - f.agentYaml.refused.length}/${f.agentYaml.total} clean` : ''} · journal 1h ${f.supervisors.reduce((a, s) => a + s.journal1h, 0)} rows · stale tick(>${p.staleTickMin}m) ${stale.length}${stale.length ? ` (${stale.slice(0, 5).map(s => `${s.id} ${ago(s.lastTickAt, now)}`).join(' · ')})` : ''} [src: eln loop agent list]`);
  } else L.push('- Supervisors: ? [src: eln loop agent list]');
  if (f.loops !== undefined) L.push(f.loops
    ? `- Loops: ok ${f.loops.total - f.loops.exceptions.length}/${f.loops.total}${f.loops.exceptions.length ? ` · exception: ${f.loops.exceptions.slice(0, 4).map(x => `${x.id} ${ago(x.at, now)}`).join(' · ')}` : ''} · 미정상화 사건 ${f.loops.unnormalized ?? '?'} (target 0) [src: eln loop trigger list · eln loop agent run-doctor status]`
    : '- Loops: ? [src: eln loop trigger list]');
  if (f.agentYaml?.refused.length) L.push(`  ⚠ agent.yaml REFUSED ${f.agentYaml.refused.length}: ${f.agentYaml.refused.slice(0, 4).map(r => `${r.id} (${r.error.slice(0, 90)})`).join(' · ')} — fix the YAML (a refused agent.yaml runs its v2 fallback card · a goal.yaml drift needs eln loop agent gen) [src: eln loop agent lint]`);
  if (f.helpers !== undefined) {
    const bad = (f.helpers ?? []).filter(h => !h.ok);
    L.push(f.helpers === null ? '- 조력자 건강 (OP helpers): ? [src: eln loop trigger fires <id> · graphs/policies/op-world.yaml helpers]'
      : `- 조력자 건강 (OP helpers): ok ${f.helpers.length - bad.length}/${f.helpers.length}${bad.length ? ` · failing ${bad.map(h => `${h.id} (${h.why})`).join(' · ')}` : ''} [src: eln loop trigger fires <id> · graphs/policies/op-world.yaml helpers]`);
  }
  if (f.analyst !== undefined) L.push(f.analyst
    ? `- 연방 분석 (loop:fed-analyst · 창 끝 ${ago(f.analyst.windowEnd, now)} 전): 합격판 ${f.analyst.passed}/6 · 기준 밖 ${f.analyst.breaches}/6 · 병목 ${f.analyst.bottleneck.slice(0, 200)} [src: eln fed analyze · seat-state/OP/pulse/FED-ANALYST-NOW.md]`
    : '- 연방 분석 (loop:fed-analyst): 아직 발행 없음 [src: eln fed analyze · eln loop agent fed-analyst status]');
  L.push(`- Resources: ${f.world ?? '?'} [src: eln world anomalies · eln loop guardian status]`);
  L.push(deltaLine(prev, f, now));
  if (f.unmeasured.length) L.push(`- unread (shown as ?, never 0): ${f.unmeasured.join(', ')}`);
  if (p.cheat.length) L.push('- CLI forms (graphs/policies/op-world.yaml cheat · full card docs/roles/OP/KNOWHOW.md K-OP-158):', ...p.cheat.map(c => `  · ${c}`));
  return L.map(x => (x.length > 480 ? `${x.slice(0, 479)}…` : x));
}

// ── live collector (each reader fails open) ─────────────────────────────────────────────────────────────────────────

const req = <T>(p: string): T => require(p) as T;
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/gu, ' ').slice(0, 60);

export interface LensDeps {
  now?: Date;
  hqRoot?: string;
  instanceRoot?: string | null;
  ledgerRoot?: string;
  /** git dir for first-parent lands (default = the fed kpi default). */
  gitDir?: string;
  policy?: LensPolicy;
  /** Open PR numbers (default: cached `gh pr list --state open`). null = unread. */
  openPrs?: () => Set<number> | null;
  pool?: () => Promise<HandPoolEntry[]>;
  /** Board source override (sim): the active version's items ⊕ the previous version's. */
  board?: () => { version: string; items: ChecklistItem[]; prev?: { version: string; items: ChecklistItem[] } | null };
  msgStorePath?: string;
  commitments?: () => LensFacts['commitments'];
  world?: () => string | null;
  /** Loop health (sim seam) · default = the trigger registry ⊕ kit/case-ledger under instanceRoot. */
  loops?: () => LensFacts['loops'];
  /** agent.yaml lint rows (sim seam) · default = lintSupervisor over graphs/loop-agents. */
  agentLint?: () => Array<{ id: string; ok: boolean; errors: string[] }>;
  /** Trigger fires of one graph, newest first (sim seam) · default = the instance's trigger registry. */
  fires?: (graphId: string) => Array<{ window: string; status: string; dispatchedAt: string | null; error: string | null }>;
}

function cachedOpenPrs(instanceRoot: string | null, maxAgeMin: number, now: Date): Set<number> | null {
  const path = instanceRoot ? join(instanceRoot, 'op-world', 'open-prs.json') : null;
  try {
    if (path && existsSync(path)) {
      const c = JSON.parse(readFileSync(path, 'utf8')) as { at: string; prs: number[] };
      if (now.getTime() - Date.parse(c.at) < maxAgeMin * MIN) return new Set(c.prs);
    }
  } catch { /* refetch */ }
  try {
    const r = spawnSync('gh', ['pr', 'list', '--state', 'open', '--limit', '500', '--json', 'number', '-q', '.[].number'], { encoding: 'utf8', timeout: 15_000 });
    if (r.status !== 0) return null;
    const prs = r.stdout.split('\n').map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (path) atomicJson(path, { at: now.toISOString(), prs });
    return new Set(prs);
  } catch { return null; }
}

/** The last `bytes` of a file as text ('' when missing) — a ledger helper reads its newest rows only. */
function tailText(path: string, bytes: number): string {
  if (!existsSync(path)) return '';
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size; const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

function atomicJson(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, `${JSON.stringify(v)}\n`); renameSync(tmp, path);
}

export async function collectWorldLens(deps: LensDeps = {}): Promise<LensFacts> {
  const now = deps.now ?? new Date();
  const p = deps.policy ?? loadLensPolicy();
  const unmeasured: string[] = [];
  const instanceRoot = deps.instanceRoot !== undefined ? deps.instanceRoot : (() => { try { return req<typeof import('../instance/resolve.js')>('../instance/resolve.js').effectiveInstanceRoot(); } catch { return null; } })();
  const ledgerRoot = deps.ledgerRoot ?? (() => { try { return req<typeof import('../instance/resolve.js')>('../instance/resolve.js').releaseLedgerRoot(); } catch { return undefined; } })();
  const hqRoot = deps.hqRoot ?? join(process.env.HOME ?? '', 'elanous-hq');

  // board (active release) ⊕ leftovers (previous release)
  let board: BoardLens | null = null; let prevBoard: LensFacts['prevBoard'] = null; let items: ChecklistItem[] = [];
  try {
    if (deps.board) {
      const b = deps.board(); items = b.items; board = boardLens(b.version, items, now, p);
      if (b.prev) { const pb = boardLens(b.prev.version, b.prev.items, now, p); prevBoard = { version: b.prev.version, open: pb.open, total: pb.total, owners: pb.owners }; }
    } else {
      const { resolveCurrentVersion } = req<typeof import('../ops-dashboard/current-version.js')>('../ops-dashboard/current-version.js');
      const { listChecklist } = req<typeof import('../release-loop/checklist.js')>('../release-loop/checklist.js');
      const version = resolveCurrentVersion({ hqRoot, ...(ledgerRoot ? { ledgerRoot } : {}) }).version;
      items = listChecklist(version, ledgerRoot).items;
      board = boardLens(version, items, now, p);
      const pv = previousVersion(version);
      if (pv) {
        try { const pb = boardLens(pv, listChecklist(pv, ledgerRoot).items, now, p); prevBoard = { version: pv, open: pb.open, total: pb.total, owners: pb.owners }; }
        catch { /* no previous board */ }
      }
    }
  } catch (e) { unmeasured.push(`board(${short(e)})`); }

  // land: first-parent main (fed kpi source) ⊕ land graph ledger, closed PRs dropped
  let land: LandLens | null = null;
  try {
    const { gitLandFacts } = req<typeof import('../fed-state/kpi.js')>('../fed-state/kpi.js');
    const gitDir = deps.gitDir ?? (process.env.ELANOUS_FED_GIT_DIR || join(hqRoot, 'repo.git'));
    const landed1h = existsSync(gitDir) ? new Set(gitLandFacts(new Date(now.getTime() - HOUR), now, gitDir).map(f => f.ref)).size : null;
    if (landed1h === null) unmeasured.push('landed(git dir)');
    const rows = instanceRoot ? req<typeof import('../land-graph/land-graph.js')>('../land-graph/land-graph.js').readLedger(instanceRoot) : [];
    const open = deps.openPrs ? deps.openPrs() : cachedOpenPrs(instanceRoot, p.openPrsCacheMin, now);
    if (!open) unmeasured.push('open PRs(gh)');
    land = landLens(rows, open, landed1h, now);
  } catch (e) { unmeasured.push(`land(${short(e)})`); }

  // hand pool ⊕ WIP-1
  let pool: PoolLens | null = null;
  try {
    const entries = deps.pool ? await deps.pool() : await req<typeof import('../seat/hand-pool-live.js')>('../seat/hand-pool-live.js').liveHandPool({ now: now.getTime() });
    let windowMs = 180 * MIN;
    try { windowMs = req<typeof import('../seat/seat-assign-wip1.js')>('../seat/seat-assign-wip1.js').loadSeatAssignPolicy().wip1.activeWindowMs; } catch { /* default */ }
    pool = poolLens(entries, items, now, windowMs);
  } catch (e) { unmeasured.push(`hand-pool(${short(e)})`); }

  // mail backlog per coordinator ⊕ ✋
  let mail: MailLens[] | null = null; let hands: LensFacts['hands'] = null;
  try {
    const { openMsgStoreReadOnly, defaultMsgStorePath } = req<typeof import('../msg/msg-store.js')>('../msg/msg-store.js');
    const path = deps.msgStorePath ?? defaultMsgStorePath();
    if (!existsSync(path)) throw new Error('no msg store');
    const store = openMsgStoreReadOnly(path);
    try {
      mail = [];
      for (const seat of p.coordinators) {
        try { const n = store.unreadCount(seat); mail.push({ seat, unacked: n, oldestAt: n > 0 ? store.list(seat, store.getCursor(seat), 1)[0]?.createdAt ?? null : null }); } catch { /* one seat */ }
      }
      try {
        const { openHands } = req<typeof import('../msg/hand-raise-ladder.js')>('../msg/hand-raise-ladder.js');
        hands = openHands(store, { now: now.getTime() }).map(h => ({ id: h.id, from: h.sender, to: h.receiver, reason: h.reason, waitedMin: Math.round(h.waitedMs / MIN) }));
      } catch (e) { unmeasured.push(`hands(${short(e)})`); }
    } finally { store.close(); }
  } catch (e) { unmeasured.push(`mail(${short(e)})`); }

  // OP commitments ⊕ HOLD ledger
  let commitments: LensFacts['commitments'] = null;
  if (deps.commitments) commitments = deps.commitments();
  else try {
    const { CommitmentLedger } = req<typeof import('../commitment/ledger.js')>('../commitment/ledger.js');
    const { listWakers } = req<typeof import('../msg/self-timer-watch.js')>('../msg/self-timer-watch.js');
    const { classifyDigest } = req<typeof import('../op-control/pulse-digest.js')>('../op-control/pulse-digest.js');
    const ledger = new CommitmentLedger(); const list = ledger.list('OP');
    const rows = classifyDigest(list, listWakers('OP', { ledger }), now.getTime(), now.getTime());
    commitments = { open: list.filter(c => c.status === 'open').length, overdue: rows.filter(r => r.bucket === 'overdue').length };
  } catch (e) { unmeasured.push(`commitments(${short(e)})`); }
  let holds: LensFacts['holds'] = null;
  try {
    if (instanceRoot) {
      const hs = req<typeof import('../hold-ledger/hold-ledger.js')>('../hold-ledger/hold-ledger.js').readHolds(instanceRoot, now);
      holds = { active: hs.filter(h => h.state === 'active').length, expired: hs.filter(h => h.state === 'expired').length };
    }
  } catch (e) { unmeasured.push(`holds(${short(e)})`); }

  // supervisors: every loop-agent home (v2 cards and bespoke agents share <state>/loop-agents/<id>/{state.json,cases.jsonl})
  let supervisors: SupervisorLens[] | null = null;
  try {
    if (instanceRoot) {
      const root = join(instanceRoot, 'loop-agents');
      supervisors = existsSync(root) ? readdirSync(root).filter(id => /^[a-z0-9][a-z0-9-]*$/u.test(id)).sort().map(id => {
        let lastTickAt: string | null = null; let journal1h = 0;
        try { lastTickAt = (JSON.parse(readFileSync(join(root, id, 'state.json'), 'utf8')) as { lastTickAt?: string | null }).lastTickAt ?? null; } catch { /* no state */ }
        try { journal1h = journalCount1h(readFileSync(join(root, id, 'cases.jsonl'), 'utf8'), now); } catch { /* no journal */ }
        return { id, lastTickAt, journal1h };
      }) : [];
    }
  } catch (e) { unmeasured.push(`supervisors(${short(e)})`); }

  // YAML-SUPERVISORS-RUNTIME: a refused agent.yaml shows here (it would otherwise run its fallback card in silence)
  let agentYaml: LensFacts['agentYaml'] = null;
  try {
    const rows = deps.agentLint ? deps.agentLint() : (() => {
      const { cardsRoot } = req<typeof import('../loop-agent/card.js')>('../loop-agent/card.js');
      const { lintSupervisor } = req<typeof import('../loop-agent/v3/supervisor.js')>('../loop-agent/v3/supervisor.js');
      const root = cardsRoot();
      return readdirSync(root).filter(id => existsSync(join(root, id, 'agent.yaml'))).sort().map(id => { const r = lintSupervisor(id, root, { parity: true }); return { id, ok: r.ok, errors: r.errors }; });
    })();
    agentYaml = { total: rows.length, refused: rows.filter(r => !r.ok).map(r => ({ id: r.id, error: r.errors[0] ?? 'refused' })) };
  } catch (e) { unmeasured.push(`agent.yaml lint(${short(e)})`); }

  // OP-HELPERS-STABILIZE: OP's body helpers (policy list) — trigger fires ⊕ ledger freshness
  // No helpers in the policy = no line (undefined) · a reader fault = «?» (null).
  let helpers: HelperHealth[] | null | undefined;
  if (p.helpers.length) try {
    helpers = null;
    let db: { close(): void } | null = null;
    const fires = deps.fires ?? ((id: string) => {
      if (!instanceRoot) throw new Error('no instance root');
      const reg = req<typeof import('../loops/trigger-registry.js')>('../loops/trigger-registry.js');
      if (!db) db = reg.openTriggerRegistry(instanceRoot);
      return reg.listFires(db as Parameters<typeof reg.listFires>[0], id, 5);
    });
    try {
      helpers = p.helpers.map(h => {
        try {
          if (h.trigger) return triggerHelperHealth(h, fires(h.trigger), now);
          if (!instanceRoot) return { id: h.id, ok: false, why: 'no instance root' };
          return ledgerHelperHealth(h, lastLedgerAt(tailText(join(instanceRoot, h.ledger!), 512 * 1024), h.match), now);
        } catch (e) { return { id: h.id, ok: false, why: `unread ${short(e)}` }; }
      });
    } finally { try { (db as { close(): void } | null)?.close(); } catch { /* read only */ } }
  } catch (e) { unmeasured.push(`helpers(${short(e)})`); }

  // LOOP-EXCEPTION-WATCH: loop health ⊕ «미정상화 사건»
  let loops: LensFacts['loops'] = null;
  try {
    loops = deps.loops ? deps.loops() : instanceRoot ? (() => {
      const reg = req<typeof import('../loops/trigger-registry.js')>('../loops/trigger-registry.js');
      const db = reg.openTriggerRegistry(instanceRoot);
      let rows: ReturnType<typeof reg.listTriggers>;
      try { rows = reg.listLiveTriggers(db); } finally { db.close(); }
      const u = req<typeof import('../kit/case-ledger/index.js')>('../kit/case-ledger/index.js').unnormalizedCases(instanceRoot, now);
      return { total: rows.length, exceptions: rows.filter(t => t.lastStatus === 'exception').map(t => ({ id: t.graphId, at: t.lastAt })), unnormalized: u ? u.open : null };
    })() : null;
  } catch (e) { unmeasured.push(`loops(${short(e)})`); }

  // FED-ANALYST-LOOP-AGENT: the newest analyst row (append-only ledger · a torn tail line is skipped)
  let analyst: LensFacts['analyst'];
  try {
    if (instanceRoot) {
      const r = req<typeof import('../fed-analyst/live.js')>('../fed-analyst/live.js').latestAnalysis(instanceRoot);
      analyst = r ? { windowEnd: r.windowEnd, passed: r.passed, breaches: r.findings.filter(x => x.status === 'breach').length, bottleneck: r.bottleneck } : null;
    }
  } catch (e) { unmeasured.push(`fed-analyst(${short(e)})`); }

  let world: string | null = null;
  try { world = deps.world ? deps.world() : req<typeof import('../resource-ledger/world-summary.js')>('../resource-ledger/world-summary.js').liveWorldDigest(now)?.line ?? null; if (!world) unmeasured.push('world(lease ledger)'); }
  catch (e) { unmeasured.push(`world(${short(e)})`); }

  return { at: now.toISOString(), board, prevBoard, land, pool, mail, hands, commitments, holds, supervisors, agentYaml, loops, world, helpers, ...(analyst !== undefined ? { analyst } : {}), unmeasured };
}

// ── cache (the sync turn path reads it) · seat cursor (Δ since last turn) ───────────────────────────────────────────

/** The live instance root (the same one the turn path reads the card from). */
export function liveInstanceRoot(): string { return req<typeof import('../instance/resolve.js')>('../instance/resolve.js').effectiveInstanceRoot(); }

/** Compute the card now, refresh the turn cache, and render it with the Δ against the seat's last turn (not advanced). */
export async function freshLensLines(seat: string, now: Date = new Date()): Promise<string[]> {
  const root = liveInstanceRoot();
  const f = await collectWorldLens({ now, instanceRoot: root });
  try { writeLensCache(root, f); } catch { /* render anyway */ }
  return renderLensLines(f, now, readLensSeen(root, seat), loadLensPolicy());
}

export const lensCachePath = (instanceRoot: string) => join(instanceRoot, 'op-world', 'lens.json');
export const lensSeenPath = (instanceRoot: string, seat: string) => join(instanceRoot, 'op-world', `seen-${seat.toUpperCase()}.json`);

export function writeLensCache(instanceRoot: string, f: LensFacts): void { atomicJson(lensCachePath(instanceRoot), f); }
export function readLensCache(instanceRoot: string): LensFacts | null {
  try { return JSON.parse(readFileSync(lensCachePath(instanceRoot), 'utf8')) as LensFacts; } catch { return null; }
}
export function readLensSeen(instanceRoot: string, seat: string): { at: string; numbers: Record<string, number> } | null {
  try { const v = JSON.parse(readFileSync(lensSeenPath(instanceRoot, seat), 'utf8')) as { at?: string; numbers?: Record<string, number> }; return v.at && v.numbers ? { at: v.at, numbers: v.numbers } : null; } catch { return null; }
}
export function writeLensSeen(instanceRoot: string, seat: string, f: LensFacts, now: Date): void { atomicJson(lensSeenPath(instanceRoot, seat), { at: now.toISOString(), numbers: lensNumbers(f) }); }

let refreshing: Promise<void> | null = null;
/** Fire-and-forget refresh of the cached card (one at a time per process). */
export function refreshLensInBackground(instanceRoot: string, deps: LensDeps = {}): void {
  if (refreshing) return;
  refreshing = collectWorldLens({ ...deps, instanceRoot }).then(f => writeLensCache(instanceRoot, f)).catch(() => undefined).finally(() => { refreshing = null; });
}

/**
 * The card for a seat turn from the cache (sync). A stale or missing cache is refreshed in the background; a stale card
 * still renders, its header saying how old it is. `advance` records the numbers this turn saw (the next Δ base).
 */
export function lensLinesForTurn(instanceRoot: string | null, seat: string, now: Date, advance: boolean, p: LensPolicy = loadLensPolicy(),
  refresh: (root: string) => void = (root) => refreshLensInBackground(root, { policy: p })): string[] {
  if (!instanceRoot) return [];
  const f = readLensCache(instanceRoot);
  const age = f ? now.getTime() - Date.parse(f.at) : Infinity;
  if (!(age < p.cacheMaxAgeMin * MIN)) refresh(instanceRoot);
  if (!f) return ['### OP world card — not computed yet (refreshing in the background · `eln op world` computes it now)'];
  const prev = readLensSeen(instanceRoot, seat);
  const lines = renderLensLines(f, now, prev, p);
  if (age >= p.cacheMaxAgeMin * MIN) lines[0] = `${lines[0]} · ⚠ computed ${Math.round(age / MIN)}m ago (refreshing)`;
  if (advance) { try { writeLensSeen(instanceRoot, seat, f, now); } catch { /* the Δ base only */ } }
  return lines;
}
