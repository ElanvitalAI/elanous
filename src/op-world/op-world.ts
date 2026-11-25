// COACH-CONTEXT-AUTO-INJECT — the OP world model («WORLD» block) (CEO 11-26 01:1x).
// S: eln OP did not know the current release board, the new org (11-25), or what the Claude OP coach did outside it.
//    The coach patched this by hand-writing seat-state/OP/WORLD-NOW.md.
// C: a hand-written page goes stale within the hour and nothing put it into the OP turn.
// Q: what does every OP turn need to know about the world, computed from facts, in ≤40 lines?
// A: `collectWorldFacts` reads the existing fact sources (current-version resolver · release checklist · release graph
//    last tick · org map or federation.yaml roles · git log origin/main · ✋ ladder · coach ledger); `renderWorldBlock`
//    is pure and prints «unknown» for any missing fact. The block rides the volatile tail of each seat turn for the
//    opted-in seats (default OP · `ELANOUS_WORLD_SEATS=OP,TC` widens it), and `eln op world --write` (run by the pulse)
//    regenerates WORLD-NOW.md from the same facts.
// Faces: observe = `op-world` debug rows (facts missing · chars) · judge = the block itself · heal = every reader fails
//    open to «unknown»; the block never throws into a turn.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { coachCursorPath, coachDelta, coachLedgerPath, readCoachActions, readCoachCursor, writeCoachCursor, type CoachDelta } from './coach-ledger.js';

export const WORLD_MAX_LINES = 40;
export const WORLD_TARGET = { landedPerH: 10, greenPerH: 10 } as const;

export interface WorldFacts {
  release: { version: string; source: string; cutAt: string | null; publishAt: string | null; published: boolean } | null;
  board: { total: number; green: number; yellow: number; owners: Array<[string, number]>; opHeld: number } | null;
  graph: { mode: string | null; hardStop: string | null; done: boolean } | null;
  org: { source: string; lines: string[] } | null;
  rate: { landed1h: number | null; green1h: number | null } | null;
  handsOpen: number | null;
  coach: CoachDelta | null;
}

const UNKNOWN = 'unknown';

/** «HH:MM» when on the same local day as `now`, else «MM-DD HH:MM» (local = UTC + tzOffsetMin). */
export function worldTime(iso: string | null | undefined, now: Date, tzOffsetMin: number): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return UNKNOWN;
  const d = new Date(ms + tzOffsetMin * 60_000);
  const n = new Date(now.getTime() + tzOffsetMin * 60_000);
  const p = (x: number) => String(x).padStart(2, '0');
  const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  const same = d.getUTCFullYear() === n.getUTCFullYear() && d.getUTCMonth() === n.getUTCMonth() && d.getUTCDate() === n.getUTCDate();
  return same ? hm : `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${hm}`;
}

const one = (s: string, max: number) => { const t = s.replace(/\s+/gu, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** Pure: the WORLD block (≤ WORLD_MAX_LINES lines). Missing facts print «unknown». */
export function renderWorldBlock(f: WorldFacts, now: Date, tzOffsetMin: number = -now.getTimezoneOffset()): string {
  const t = (iso: string | null | undefined) => worldTime(iso, now, tzOffsetMin);
  const lines: string[] = [`## WORLD — computed from facts at ${t(now.toISOString())} (not hand-written · re-read sources before acting)`];
  // Release
  if (f.release) {
    const r = f.release;
    const stale: string[] = [];
    if (r.published) stale.push('already published');
    else if (r.publishAt && Date.parse(r.publishAt) < now.getTime()) stale.push('publish time passed');
    lines.push(`- Release: ${r.version} (from ${r.source}) · cut ${t(r.cutAt)} · publish ${t(r.publishAt)}${stale.length ? ` · ⚠ STALE: ${stale.join(', ')} — check the next plan` : ''}`);
  } else lines.push(`- Release: ${UNKNOWN}`);
  // Board
  if (f.board) {
    const b = f.board;
    const owners = b.owners.slice(0, 6).map(([o, n]) => `${o} ${n}`).join(' · ') || 'none';
    lines.push(`- Board: ${b.green} green / ${b.yellow} yellow / ${b.total} total · open owners: ${owners}`);
    if (b.opHeld > 0) lines.push(`  ⚠ OP holds ${b.opHeld} open cell(s) — hands cannot pull them; OP should hold 0 (release or hand them out)`);
  } else lines.push(`- Board: ${UNKNOWN}`);
  // Graph
  if (f.graph) lines.push(`- Release graph: mode ${f.graph.mode ?? UNKNOWN} · ${f.graph.hardStop ? `HARD STOP: ${one(f.graph.hardStop, 100)}` : f.graph.done ? 'finished' : 'running/open'}`);
  else lines.push(`- Release graph: ${UNKNOWN}`);
  // Rate
  const rate = (v: number | null | undefined, target: number) => (v === null || v === undefined ? `${UNKNOWN}/${target}` : `${v}/${target}${v < target ? ' ↓' : ''}`);
  lines.push(`- Last 1h: landed ${rate(f.rate?.landed1h, WORLD_TARGET.landedPerH)} · green ${rate(f.rate?.green1h, WORLD_TARGET.greenPerH)} (target ${WORLD_TARGET.landedPerH}/${WORLD_TARGET.greenPerH})`);
  lines.push(`- ✋ open: ${f.handsOpen ?? UNKNOWN}`);
  // Org
  if (f.org && f.org.lines.length) {
    lines.push(`- Org (${f.org.source}):`);
    for (const l of f.org.lines.slice(0, 6)) lines.push(`  ${one(l, 160)}`);
  } else lines.push(`- Org: ${UNKNOWN}`);
  // Coach
  if (!f.coach) lines.push(`- Coach actions: ${UNKNOWN}`);
  else if (!f.coach.total) lines.push('- Coach actions: none recorded');
  else {
    const c = f.coach;
    lines.push(`- Coach actions (outside eln OP): ${c.fresh} new since your last turn · latest ${c.shown.length} of ${c.total}${c.freshOmitted ? ` · ${c.freshOmitted} more new not shown (eln coach list)` : ''}`);
    for (const a of c.shown) {
      lines.push(`  ${a.fresh ? 'NEW ' : ''}${t(a.at)} ${a.by}: ${one(a.what, 140)}${a.why ? ` — why: ${one(a.why, 80)}` : ''}${a.next ? ` — next: ${one(a.next, 80)}` : ''}`);
    }
  }
  return lines.slice(0, WORLD_MAX_LINES).join('\n');
}

// ── live fact readers (each fails open to null) ───────────────────────────────────────────────

export interface WorldDeps {
  now?: Date;
  hqRoot?: string;
  instanceRoot?: string;
  ledgerRoot?: string;
  repoRoot?: string;
  seat?: string;
  /** Advance the seat's coach cursor after reading (a turn did see the delta). */
  advanceCursor?: boolean;
  coachCap?: number;
}

const req = <T>(p: string): T => require(p) as T;
const seatOf = (owner: string | undefined) => (owner ?? '').split(/[/:\s]/u)[0]?.toUpperCase() ?? '';

function readRelease(hqRoot: string, ledgerRoot: string | undefined): WorldFacts['release'] {
  try {
    const { resolveCurrentVersion } = req<typeof import('../ops-dashboard/current-version.js')>('../ops-dashboard/current-version.js');
    const c = resolveCurrentVersion({ hqRoot, ...(ledgerRoot ? { ledgerRoot } : {}) });
    return { version: c.version, source: c.source, cutAt: c.schedule?.cutAt ?? null, publishAt: c.schedule?.publishAt ?? null, published: c.published };
  } catch { return null; }
}

export function boardOf(items: ReadonlyArray<{ status: string; owner?: string; updatedAt?: string }>, now: Date): { board: NonNullable<WorldFacts['board']>; green1h: number } {
  const owners = new Map<string, number>();
  let green = 0; let yellow = 0; let opHeld = 0; let green1h = 0;
  for (const i of items) {
    if (i.status === 'green' || i.status === 'done') {
      green++;
      if (i.status === 'green' && i.updatedAt && now.getTime() - Date.parse(i.updatedAt) <= 3_600_000) green1h++;
      continue;
    }
    if (i.status === 'yellow') yellow++;
    const s = seatOf(i.owner) || '(none)';
    owners.set(s, (owners.get(s) ?? 0) + 1);
    if (s === 'OP') opHeld++;
  }
  return { board: { total: items.length, green, yellow, owners: [...owners].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), opHeld }, green1h };
}

function readBoard(version: string, ledgerRoot: string | undefined, now: Date): { board: WorldFacts['board']; green1h: number | null } {
  try {
    const { listChecklist } = req<typeof import('../release-loop/checklist.js')>('../release-loop/checklist.js');
    const items = listChecklist(version, ledgerRoot).items;
    const r = boardOf(items, now);
    return { board: r.board, green1h: r.green1h };
  } catch { return { board: null, green1h: null }; }
}

function readGraph(instanceRoot: string, version: string | null): WorldFacts['graph'] {
  try {
    const p = join(instanceRoot, 'release-graph', 'last-tick.json');
    if (!existsSync(p)) return null;
    const tick = JSON.parse(readFileSync(p, 'utf8')) as { runs?: Array<{ version?: string; mode?: string; done?: boolean; hardStop?: { reason?: string } | string | null }> };
    const runs = tick.runs ?? [];
    const run = runs.find(r => r.version === version) ?? runs.find(r => version !== null && String(r.version ?? '').startsWith(version)) ?? null;
    if (!run) return null;
    const hs = run.hardStop;
    return { mode: run.mode ?? null, hardStop: hs ? (typeof hs === 'string' ? hs : hs.reason ?? 'yes') : null, done: !!run.done };
  } catch { return null; }
}

export function orgLinesFromMap(org: { seats?: Record<string, { role?: string }>; spaces?: Record<string, { leader?: string; advisor?: string; steward?: string }> }): string[] {
  const seats = Object.entries(org.seats ?? {}).map(([s, v]) => `${s}=${v.role ?? '?'}`).join(' · ');
  const spaces = Object.entries(org.spaces ?? {}).map(([n, v]) => `${n}:${v.leader ?? '?'}${v.advisor ? `+${v.advisor}` : ''}${v.steward ? `/${v.steward}` : ''}`).join(' · ');
  return [seats ? `seats: ${seats}` : '', spaces ? `spaces: ${spaces}` : ''].filter(Boolean);
}

function readOrg(hqRoot: string): WorldFacts['org'] {
  // `eln org show` (#40179) when installed; the module path stays a runtime string so this file builds without it.
  try {
    const modPath = '../org/org-map.js';
    const mod = req<{ loadOrgMap?: (d: { cwd?: string }) => { org: Parameters<typeof orgLinesFromMap>[0] } }>(modPath);
    if (typeof mod.loadOrgMap === 'function') {
      const lines = orgLinesFromMap(mod.loadOrgMap({ cwd: hqRoot }).org);
      if (lines.length) return { source: 'eln org show', lines };
    }
  } catch { /* not installed */ }
  try {
    const { loadDeclaredSeatRoles } = req<typeof import('../msg/hand-raise-ladder.js')>('../msg/hand-raise-ladder.js');
    const roles = loadDeclaredSeatRoles({ cwd: hqRoot });
    const entries = Object.entries(roles);
    if (entries.length) return { source: 'federation.yaml roles', lines: [`seats: ${entries.map(([s, r]) => `${s}=${r}`).join(' · ')}`] };
  } catch { /* fall through to the raw read */ }
  // A declaration the strict parser rejects still names its seats — read the raw YAML seat roles.
  try {
    const p = join(hqRoot, '.elanous', 'federation.yaml');
    if (!existsSync(p)) return null;
    const { parse } = req<typeof import('yaml')>('yaml');
    const raw = parse(readFileSync(p, 'utf8')) as { seats?: Record<string, { role?: unknown }>; hq?: { coordinator?: unknown } };
    const byRole = new Map<string, string[]>();
    for (const [id, v] of Object.entries(raw?.seats ?? {})) {
      const role = typeof v?.role === 'string' ? v.role : '?';
      byRole.set(role, [...(byRole.get(role) ?? []), id]);
    }
    if (!byRole.size) return null;
    const lines = [...byRole].sort((a, b) => a[1].length - b[1].length)
      .map(([role, ids]) => (ids.length > 8 ? `${role}: ${ids.length} seats` : `${role}: ${ids.join(', ')}`)).slice(0, 6);
    return { source: 'federation.yaml roles (raw)', lines };
  } catch { return null; }
}

function readLanded1h(repoRoot: string | undefined, now: Date): number | null {
  if (!repoRoot) return null;
  try {
    const out = spawnSync('git', ['-C', repoRoot, 'log', 'origin/main', `--since=${new Date(now.getTime() - 3_600_000).toISOString()}`, '--format=%s'], { encoding: 'utf8', timeout: 3_000 });
    if (out.status !== 0) return null;
    return out.stdout.split('\n').filter(l => /\(#\d+\)\s*$/u.test(l)).length;
  } catch { return null; }
}

function readHandsOpen(now: Date): number | null {
  try {
    const { openMsgStoreReadOnly, defaultMsgStorePath } = req<typeof import('../msg/msg-store.js')>('../msg/msg-store.js');
    const { openHands } = req<typeof import('../msg/hand-raise-ladder.js')>('../msg/hand-raise-ladder.js');
    const path = defaultMsgStorePath();
    if (!existsSync(path)) return null;
    const store = openMsgStoreReadOnly(path);
    try { return openHands(store, { now: now.getTime() }).length; } finally { store.close(); }
  } catch { return null; }
}

function defaultInstanceRoot(): string | null {
  try { return req<typeof import('../instance/resolve.js')>('../instance/resolve.js').effectiveInstanceRoot(); } catch { return null; }
}
function defaultLedgerRoot(): string | undefined {
  try { return req<typeof import('../instance/resolve.js')>('../instance/resolve.js').releaseLedgerRoot(); } catch { return undefined; }
}
function defaultRepoRoot(): string | undefined {
  try { return req<typeof import('../domains/schedule-registry.js')>('../domains/schedule-registry.js').repoRoot(); } catch { return undefined; }
}
export function defaultHqRoot(): string { return join(homedir(), 'elanous-hq'); }

/** Reads the coach delta for a seat; advances the cursor when asked. */
export function readCoach(instanceRoot: string | null, seat: string, advance: boolean, cap = 5): CoachDelta | null {
  if (!instanceRoot) return null;
  try {
    const rows = readCoachActions(coachLedgerPath(instanceRoot));
    const cursorPath = coachCursorPath(instanceRoot, seat);
    const delta = coachDelta(rows, readCoachCursor(cursorPath), cap);
    const last = rows[rows.length - 1];
    if (advance && last) writeCoachCursor(cursorPath, { lastId: last.id, lastAt: last.at });
    return delta;
  } catch { return null; }
}

export function collectWorldFacts(deps: WorldDeps = {}): WorldFacts {
  const now = deps.now ?? new Date();
  const hqRoot = deps.hqRoot ?? defaultHqRoot();
  const instanceRoot = deps.instanceRoot ?? defaultInstanceRoot();
  const ledgerRoot = deps.ledgerRoot ?? defaultLedgerRoot();
  const release = readRelease(hqRoot, ledgerRoot);
  const { board, green1h } = release ? readBoard(release.version, ledgerRoot, now) : { board: null, green1h: null };
  const landed1h = readLanded1h(deps.repoRoot ?? defaultRepoRoot(), now);
  return {
    release, board,
    graph: instanceRoot ? readGraph(instanceRoot, release?.version ?? null) : null,
    org: readOrg(hqRoot),
    rate: landed1h === null && green1h === null ? null : { landed1h, green1h },
    handsOpen: readHandsOpen(now),
    coach: readCoach(instanceRoot, deps.seat ?? 'OP', deps.advanceCursor ?? false, deps.coachCap ?? 5),
  };
}

// ── seat opt-in + turn injection ─────────────────────────────────────────────────────────────

/** Seats that get WORLD on every turn. Default OP only; `ELANOUS_WORLD_SEATS=OP,TC` opts others in (`none` = off). */
export function worldSeats(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.ELANOUS_WORLD_SEATS?.trim();
  if (raw === undefined || raw === '') return new Set(['OP']);
  if (raw.toLowerCase() === 'none') return new Set();
  return new Set(raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
}

let cache: { seat: string; at: number; facts: WorldFacts } | null = null;
const CACHE_MS = 60_000;

/** The volatile WORLD block for this seat's turn ('' when the seat is not opted in). Never throws. */
export function worldBlockForSeatTurn(seat: string, deps: WorldDeps & { env?: NodeJS.ProcessEnv } = {}): string {
  try {
    if (!worldSeats(deps.env).has(seat.toUpperCase())) return '';
    const now = deps.now ?? new Date();
    let facts: WorldFacts;
    if (cache && cache.seat === seat && now.getTime() - cache.at < CACHE_MS) {
      // Facts stay cached for a minute; the coach delta is always fresh (it is the cheap, fast-moving part).
      facts = { ...cache.facts, coach: readCoach(deps.instanceRoot ?? defaultInstanceRoot(), seat, true, deps.coachCap ?? 5) };
    } else {
      facts = collectWorldFacts({ ...deps, seat, advanceCursor: true, now });
      cache = { seat, at: now.getTime(), facts };
    }
    return renderWorldBlock(facts, now);
  } catch { return ''; }
}

export function resetWorldCacheForTest(): void { cache = null; }

/** seat-state/<SEAT>/WORLD-NOW.md — generated (`eln op world --write` · the pulse). Does not move the coach cursor. */
export function worldNowPath(seatStateRoot: string, seat = 'OP'): string { return join(seatStateRoot, seat, 'WORLD-NOW.md'); }

export function writeWorldNow(path: string, block: string, now: Date): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = `<!-- generated by \`eln op world --write\` at ${now.toISOString()} — do not edit by hand; record coach actions with \`eln coach act\` -->\n${block}\n`;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function defaultSeatStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ELANOUS_SEAT_STATE ?? join(defaultHqRoot(), 'seat-state');
}
