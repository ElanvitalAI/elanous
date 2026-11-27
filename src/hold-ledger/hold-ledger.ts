// HOLD-AS-LEDGER-OBJECT (D1 · fed-ontology-bottleneck §4 · 0.3.38 P0 · 대표 rollout 11-27)
//
// S: on 11-26 a HOLD was a sentence in a mail. «TC HOLD freezes 16 hands», «OP HOLD freezes 5 hands» (rail 73 · 00:44
//    `eln fed snapshot --anomalies`); 244 mails in one night quoted a HOLD, and #178978 (one MOB-1 answer) was read as a
//    federation-wide ban for 13 h. A hand that cannot see a HOLD's scope, expiry or unlock condition safely picks «keep it».
// C: a HOLD had no id, no scope, no expiry and no unlock condition, so nobody could narrow it, lift it or prove it lapsed.
//    eln OP 00:1x refused to declare unregistered HOLDs void — they must be registered, and the unregistered ones surface
//    to OP after 30 min instead.
// Q: what is the smallest object that lets a hand, the judge-butler and the snapshot answer «does a HOLD cover this cell,
//    until when, and what lifts it»?
// A: HOLD = {id · owner seat · scope cells[] · reason · expiry · unlock condition}, kept as append-only events
//    (`add | narrow | lift | expire`) under `<state>/hold-ledger/events.jsonl` and folded on read. Expiry is mandatory
//    (default 2 h = DIRECTIVE_TTL_MS · a wildcard scope `*` is capped at 2 h · any HOLD at 24 h). A read at time t never
//    counts a HOLD whose expiry passed, and the sweep (`eln hold expire` · judge-butler body) writes the audit row.
//    Narrowing only narrows (cells ⊆ old · expiry ≤ old); widening is a new HOLD.
//    COORD-RIGHTS (CEO 11-27): narrow/lift = the owner · L0 · or a coordinator in the owner's scope (HQ ⊕ the owner's space
//    coordinator, from the federation ladder) — every change is one ledger event with `by` (the audit row).
//
// 세 얼굴: 관측 = `eln hold ls` ⊕ fed-state `hold:*` facts ⊕ the snapshot's hold-freeze rule (reads this ledger) ·
// 판단 근거 = {@link covers} / {@link frozenBy} / {@link unlockMet} (structured fields only, never body words) ·
// 수복과 인계 = expiry auto-lifts with an audit row; an unregistered broadcast HOLD older than 30 min becomes one OP card.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DIRECTIVE_TTL_MS, STANDING_TTL_MS } from '../msg/directive-expiry.js';

export const HOLD_DEFAULT_TTL_MS = DIRECTIVE_TTL_MS;
/** A wildcard scope froze 16 hands on 11-26 — it may live at most one directive window. */
export const HOLD_WILDCARD_MAX_MS = DIRECTIVE_TTL_MS;
export const HOLD_MAX_TTL_MS = STANDING_TTL_MS;
/** eln OP 00:1x — an unregistered broadcast HOLD is not void; after 30 min it becomes OP's card. */
export const HOLD_UNREGISTERED_CARD_AFTER_MS = 30 * 60_000;
export const WILDCARD = '*';

export type HoldState = 'active' | 'lifted' | 'expired';
export interface Hold {
  readonly id: string;
  readonly owner: string;
  readonly cells: readonly string[];
  readonly reason: string;
  readonly unlock: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
  readonly state: HoldState;
  /** The mail that first said it (a registered broadcast). */
  readonly sourceMsg?: number;
  readonly narrowed: number;
  readonly closedAt?: string;
  readonly closedBy?: string;
  readonly closeReason?: string;
}

export type HoldEvent =
  | { readonly at: string; readonly by: string; readonly op: 'add'; readonly id: string; readonly owner: string; readonly cells: readonly string[]; readonly reason: string; readonly unlock: string; readonly expiresAt: string; readonly sourceMsg?: number }
  | { readonly at: string; readonly by: string; readonly op: 'narrow'; readonly id: string; readonly cells?: readonly string[]; readonly expiresAt?: string; readonly reason?: string }
  | { readonly at: string; readonly by: string; readonly op: 'lift' | 'expire'; readonly id: string; readonly reason: string };

const up = (s: string): string => s.trim().toUpperCase();
const normCells = (cells: readonly string[]): string[] => {
  const out = [...new Set(cells.flatMap(c => c.split(',')).map(c => c.trim()).filter(Boolean).map(c => (c === WILDCARD ? c : c.toUpperCase())))];
  return out.includes(WILDCARD) ? [WILDCARD] : out.sort();
};

/** Pure: fold events into holds (insertion order). A HOLD whose expiry passed at `now` reads `expired` even before the sweep. */
export function foldHolds(events: readonly HoldEvent[], now?: Date): Hold[] {
  const byId = new Map<string, Hold>();
  for (const e of events) {
    if (e.op === 'add') {
      if (byId.has(e.id)) continue;
      byId.set(e.id, { id: e.id, owner: up(e.owner), cells: normCells(e.cells), reason: e.reason, unlock: e.unlock, createdAt: e.at, createdBy: up(e.by),
        expiresAt: e.expiresAt, state: 'active', narrowed: 0, ...(e.sourceMsg ? { sourceMsg: e.sourceMsg } : {}) });
      continue;
    }
    const h = byId.get(e.id);
    if (!h || h.state !== 'active') continue;
    if (e.op === 'narrow') byId.set(e.id, { ...h, ...(e.cells ? { cells: normCells(e.cells) } : {}), ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}), narrowed: h.narrowed + 1 });
    else byId.set(e.id, { ...h, state: e.op === 'lift' ? 'lifted' : 'expired', closedAt: e.at, closedBy: up(e.by), closeReason: e.reason });
  }
  const t = now?.getTime();
  return [...byId.values()].map(h => (t !== undefined && h.state === 'active' && Date.parse(h.expiresAt) <= t
    ? { ...h, state: 'expired' as const, closedAt: h.expiresAt, closedBy: 'EXPIRY', closeReason: `expiry ${h.expiresAt} passed` } : h));
}

export const isActive = (h: Hold, now: Date): boolean => h.state === 'active' && Date.parse(h.expiresAt) > now.getTime();
export const activeHolds = (holds: readonly Hold[], now: Date): Hold[] => holds.filter(h => isActive(h, now));

/** Does `hold` cover `cell` at `now`? Wildcard covers every cell. */
export function covers(hold: Hold, cell: string, now: Date): boolean {
  if (!isActive(hold, now)) return false;
  return hold.cells.includes(WILDCARD) || hold.cells.includes(up(cell));
}

export function holdsCovering(holds: readonly Hold[], cell: string, now: Date): Hold[] {
  return holds.filter(h => covers(h, cell, now));
}

// ── unlock conditions (structured; anything else is free text and only the expiry lifts it) ─────────────────────────

export type Unlock = { kind: 'merged'; pr: number } | { kind: 'green'; cell: string } | { kind: 'text'; text: string };
/** `merged:#40324` · `green:JUD-BUTLER` — else free text. */
export function parseUnlock(raw: string): Unlock {
  const t = raw.trim();
  const m = /^merged:#?(\d{1,7})$/iu.exec(t);
  if (m) return { kind: 'merged', pr: Number(m[1]) };
  const g = /^green:([A-Za-z0-9][\w.-]*)$/u.exec(t);
  if (g) return { kind: 'green', cell: g[1]!.toUpperCase() };
  return { kind: 'text', text: t };
}
export function unlockMet(hold: Hold, facts: { merged: ReadonlySet<number>; green: ReadonlySet<string> }): string | null {
  const u = parseUnlock(hold.unlock);
  if (u.kind === 'merged' && facts.merged.has(u.pr)) return `unlock met: #${u.pr} merged`;
  if (u.kind === 'green' && facts.green.has(u.cell)) return `unlock met: ${u.cell} green`;
  return null;
}

// ── frozen hands (blocks × ledger) ──────────────────────────────────────────────────────────────────────────────────

export interface HoldBlock { readonly by: string; readonly on: string | null; readonly cell: string; readonly reason: string; readonly at: string }
export interface FrozenRow { readonly hold: Hold; readonly hands: readonly string[]; readonly cells: readonly string[] }
/**
 * Pure: which hands each active HOLD freezes — a recent block that waits on the HOLD's owner (or cites its id) on a cell the
 * HOLD covers. Blocks that wait on a seat with no covering registered HOLD are returned under `unregistered` (by seat).
 */
export function frozenBy(holds: readonly Hold[], blocks: readonly HoldBlock[], now: Date, windowMs = 60 * 60_000): { frozen: FrozenRow[]; unregistered: Map<string, string[]> } {
  const active = activeHolds(holds, now);
  const latest = new Map<string, HoldBlock>();
  for (const b of blocks) {
    const t = Date.parse(b.at);
    if (!Number.isFinite(t) || now.getTime() - t > windowMs) continue;
    const prev = latest.get(up(b.by));
    if (!prev || Date.parse(prev.at) <= t) latest.set(up(b.by), b);
  }
  const rows = new Map<string, { hands: Set<string>; cells: Set<string> }>();
  const unregistered = new Map<string, string[]>();
  for (const b of latest.values()) {
    const on = up(b.on ?? '');
    // every covering HOLD counts the hand (overlapping HOLDs each keep their frozen count and their narrowing decision)
    const hits = active.filter(h => (h.owner === on || b.reason.includes(h.id)) && covers(h, b.cell, now));
    for (const hit of hits) {
      const r = rows.get(hit.id) ?? { hands: new Set<string>(), cells: new Set<string>() };
      r.hands.add(up(b.by)); r.cells.add(up(b.cell)); rows.set(hit.id, r);
    }
    if (!hits.length && on) unregistered.set(on, [...(unregistered.get(on) ?? []), up(b.by)].sort());
  }
  const frozen = active.filter(h => rows.has(h.id)).map(h => ({ hold: h, hands: [...rows.get(h.id)!.hands].sort(), cells: [...rows.get(h.id)!.cells].sort() }))
    .sort((a, b) => b.hands.length - a.hands.length || a.hold.id.localeCompare(b.hold.id));
  return { frozen, unregistered };
}

// ── store ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const holdHome = (stateRoot: string): string => join(stateRoot, 'hold-ledger');
export const holdEventsPath = (stateRoot: string): string => join(holdHome(stateRoot), 'events.jsonl');

export function readHoldEvents(stateRoot: string): HoldEvent[] {
  const p = holdEventsPath(stateRoot);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as HoldEvent]; } catch { return []; } });
}
export function readHolds(stateRoot: string, now: Date = new Date()): Hold[] { return foldHolds(readHoldEvents(stateRoot), now); }

/** One writer at a time (mkdir is atomic); a lock older than 30 s is a crashed writer and is taken over. */
function withLock<T>(stateRoot: string, fn: () => T): T {
  mkdirSync(holdHome(stateRoot), { recursive: true });
  const lock = join(holdHome(stateRoot), '.lock');
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { mkdirSync(lock); break; } catch {
      try { const { statSync } = require('node:fs') as typeof import('node:fs'); if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error('hold ledger busy (lock held > 5 s) — retry');
      Bun.sleepSync(25);
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

function append(stateRoot: string, e: HoldEvent, fact?: (e: HoldEvent) => void): void {
  appendFileSync(holdEventsPath(stateRoot), `${JSON.stringify(e)}\n`);
  try { fact?.(e); } catch { /* fail-open */ }
}

/** fed-state attribution (fail-open): every ledger change is a typed `hold` fact. */
function defaultFact(e: HoldEvent): void {
  const { recordFact } = require('../fed-state/ledger.js') as typeof import('../fed-state/ledger.js');
  recordFact({ type: 'hold', seat: up(e.by), state: e.op === 'add' ? 'add' : e.op, ref: e.id, ...(e.op === 'add' ? { to: up(e.owner), kind: e.cells.join(',') } : {}),
    decidedBy: up(e.by), source: 'hold-ledger' });
}

export interface HoldWriteOpts {
  now?: Date; fact?: ((e: HoldEvent) => void) | null;
  /** COORD-RIGHTS: the coordinators whose scope holds this owner seat (default: the live federation ladder). */
  coordinatorsOf?: (owner: string) => readonly string[];
}
/**
 * COORD-RIGHTS (CEO 11-27 08:0x «HOLD 는 범위 안 조율자 누구나 풀기»): the coordinators in scope of a HOLD owner — the HQ
 * coordinator and the space coordinator(s) whose space lists the owner seat. Any lookup failure = none (owner/L0 only).
 */
export function ladderCoordinatorsOf(owner: string): readonly string[] {
  try {
    const { loadFederationLadder } = require('../msg/hand-raise-ladder.js') as typeof import('../msg/hand-raise-ladder.js');
    const ladder = loadFederationLadder();
    const parent = up(ladder.parentOf(owner));
    return [...new Set([up(ladder.hq), ...(ladder.depthOf(parent) === 2 ? [parent] : [])])];
  } catch { return []; }
}
const factOf = (o: HoldWriteOpts) => (o.fact === null ? undefined : o.fact ?? defaultFact);

/** Seats that may change a HOLD they do not own (the L0 judge, HQ, the CEO copy). The judge-butler is NOT one — it only proposes and expires. */
export const HOLD_L0 = new Set(['JUD', 'OP', 'CLAUDE-OP', 'CEO']);
/** Loop agents that only propose and expire — never add, narrow or lift (checked BEFORE ownership: owning a HOLD grants nothing). */
export const HOLD_PROPOSE_ONLY = new Set(['JUDGE-BUTLER']);
export const mayChange = (hold: Hold, by: string, coordinatorsOf?: (owner: string) => readonly string[]): boolean => !HOLD_PROPOSE_ONLY.has(up(by))
  && (up(by) === hold.owner || HOLD_L0.has(up(by)) || inScope(hold, by, coordinatorsOf));
function inScope(hold: Hold, by: string, coordinatorsOf?: (owner: string) => readonly string[]): boolean {
  if (!coordinatorsOf) return false;
  try { return coordinatorsOf(hold.owner).map(up).includes(up(by)); } catch { return false; }
}

export function parseTtl(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(m|h|d)$/iu.exec(raw.trim());
  if (!m) throw new Error(`expiry must look like 30m · 2h · 1d (got ${raw})`);
  return Math.round(Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!.toLowerCase() as 'm' | 'h' | 'd']);
}

export interface AddInput { owner: string; cells: readonly string[]; reason: string; unlock: string; ttlMs?: number; sourceMsg?: number; by: string }
export function addHold(stateRoot: string, input: AddInput, opts: HoldWriteOpts = {}): Hold {
  const now = opts.now ?? new Date();
  const cells = normCells(input.cells);
  if (!cells.length) throw new Error('a HOLD needs a scope — --cells A,B (or * for everything the owner leads, capped at 2h)');
  if (!input.reason.trim()) throw new Error('a HOLD needs --reason');
  if (!input.unlock.trim()) throw new Error('a HOLD needs --unlock (merged:#N · green:CELL · or one line saying what lifts it)');
  if (!up(input.owner)) throw new Error('a HOLD needs --owner');
  if (HOLD_PROPOSE_ONLY.has(up(input.by)) || HOLD_PROPOSE_ONLY.has(up(input.owner))) throw new Error(`${up(input.by)} only proposes and expires HOLDs — the owner or JUD adds them`);
  const want = input.ttlMs ?? HOLD_DEFAULT_TTL_MS;
  if (!(want > 0)) throw new Error('expiry must be positive');
  const ttl = Math.min(want, cells.includes(WILDCARD) ? HOLD_WILDCARD_MAX_MS : HOLD_MAX_TTL_MS);
  return withLock(stateRoot, () => {
    const events = readHoldEvents(stateRoot);
    const n = events.filter(e => e.op === 'add').length + 1;
    const id = `H-${n}`;
    const e: HoldEvent = { at: now.toISOString(), by: up(input.by), op: 'add', id, owner: up(input.owner), cells, reason: input.reason.trim(), unlock: input.unlock.trim(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(), ...(input.sourceMsg ? { sourceMsg: input.sourceMsg } : {}) };
    append(stateRoot, e, factOf(opts));
    return foldHolds([...events, e], now).find(h => h.id === id)!;
  });
}

function current(stateRoot: string, id: string, now: Date): Hold {
  const h = readHolds(stateRoot, now).find(x => x.id === up(id) || x.id === id);
  if (!h) throw new Error(`no HOLD ${id} — eln hold ls --all`);
  if (h.state !== 'active') throw new Error(`HOLD ${h.id} is already ${h.state}${h.closeReason ? ` (${h.closeReason})` : ''}`);
  return h;
}

/** Narrow scope and/or expiry. Only narrows: cells ⊆ old (a wildcard narrows to anything) · expiry ≤ old. */
export function narrowHold(stateRoot: string, id: string, input: { cells?: readonly string[]; ttlMs?: number; by: string; reason?: string }, opts: HoldWriteOpts = {}): Hold {
  const now = opts.now ?? new Date();
  return withLock(stateRoot, () => {
    const h = current(stateRoot, id, now);
    if (!mayChange(h, input.by, opts.coordinatorsOf ?? ladderCoordinatorsOf)) throw new Error(`HOLD ${h.id} belongs to ${h.owner} — only the owner, a coordinator in its scope or ${[...HOLD_L0].join('/')} may narrow it (the judge-butler proposes)`);
    const cells = input.cells ? normCells(input.cells) : undefined;
    if (cells && !cells.length) throw new Error('narrow to at least one cell — or eln hold lift');
    if (cells && !h.cells.includes(WILDCARD) && (cells.includes(WILDCARD) || cells.some(c => !h.cells.includes(c)))) throw new Error(`narrow only narrows — ${cells.join(',')} is not inside ${h.cells.join(',')} (widening = a new HOLD)`);
    const expiresAt = input.ttlMs !== undefined ? new Date(now.getTime() + input.ttlMs).toISOString() : undefined;
    if (expiresAt && Date.parse(expiresAt) > Date.parse(h.expiresAt)) throw new Error(`narrow only shortens — ${expiresAt} is after ${h.expiresAt}`);
    if (!cells && !expiresAt) throw new Error('narrow needs --cells and/or --expires');
    const e: HoldEvent = { at: now.toISOString(), by: up(input.by), op: 'narrow', id: h.id, ...(cells ? { cells } : {}), ...(expiresAt ? { expiresAt } : {}), ...(input.reason ? { reason: input.reason } : {}) };
    append(stateRoot, e, factOf(opts));
    return foldHolds([...readHoldEvents(stateRoot)], now).find(x => x.id === h.id)!;
  });
}

export function liftHold(stateRoot: string, id: string, input: { by: string; reason: string }, opts: HoldWriteOpts = {}): Hold {
  const now = opts.now ?? new Date();
  if (!input.reason.trim()) throw new Error('lift needs --reason');
  return withLock(stateRoot, () => {
    const h = current(stateRoot, id, now);
    if (!mayChange(h, input.by, opts.coordinatorsOf ?? ladderCoordinatorsOf)) throw new Error(`HOLD ${h.id} belongs to ${h.owner} — only the owner, a coordinator in its scope or ${[...HOLD_L0].join('/')} may lift it`);
    append(stateRoot, { at: now.toISOString(), by: up(input.by), op: 'lift', id: h.id, reason: input.reason.trim() }, factOf(opts));
    return foldHolds(readHoldEvents(stateRoot), now).find(x => x.id === h.id)!;
  });
}

export interface ExpireRow { readonly id: string; readonly owner: string; readonly reason: string; readonly audit: string }
/**
 * The sweep: every HOLD whose expiry passed (or whose structured unlock condition is met) gets one `expire` row with the
 * audit line. Idempotent — an already-closed HOLD is skipped. `dryRun` reports without writing.
 */
export function expireDue(stateRoot: string, input: { by: string; unlockFacts?: { merged: ReadonlySet<number>; green: ReadonlySet<string> }; dryRun?: boolean }, opts: HoldWriteOpts = {}): ExpireRow[] {
  const now = opts.now ?? new Date();
  const run = (): ExpireRow[] => {
    const raw = foldHolds(readHoldEvents(stateRoot)); // no `now`: still-open rows whose time passed are what we close
    const out: ExpireRow[] = [];
    for (const h of raw) {
      if (h.state !== 'active') continue;
      const why = Date.parse(h.expiresAt) <= now.getTime() ? `expiry ${h.expiresAt} passed` : input.unlockFacts ? unlockMet(h, input.unlockFacts) : null;
      if (!why) continue;
      const audit = `${now.toISOString()} hold ${h.id} (${h.owner} · ${h.cells.join(',')}) auto-lifted by ${up(input.by)} — ${why}`;
      if (!input.dryRun) append(stateRoot, { at: now.toISOString(), by: up(input.by), op: 'expire', id: h.id, reason: why }, factOf(opts));
      out.push({ id: h.id, owner: h.owner, reason: why, audit });
    }
    return out;
  };
  return input.dryRun ? run() : withLock(stateRoot, run);
}

// ── unregistered broadcast HOLDs → one OP card after 30 min (eln OP 00:1x: not void) ─────────────────────────────────

export interface BroadcastIn { readonly coordinator: string; readonly msgId: number; readonly at: string; readonly frozen: readonly string[]; readonly scoped: boolean; readonly body: string }
export interface UnregisteredCard { readonly msgId: number; readonly coordinator: string; readonly key: string; readonly body: string }
/** Pure: unscoped coordinator broadcasts with frozen hands, ≥ 30 min old, that no ledger HOLD registered (`sourceMsg`). */
export function unregisteredCards(broadcasts: readonly BroadcastIn[], holds: readonly Hold[], nowMs: number): UnregisteredCard[] {
  const registered = new Set(holds.map(h => h.sourceMsg).filter((m): m is number => typeof m === 'number'));
  return broadcasts
    .filter(b => !b.scoped && b.frozen.length > 0 && !registered.has(b.msgId) && nowMs - Date.parse(b.at) >= HOLD_UNREGISTERED_CARD_AFTER_MS)
    .map(b => ({ msgId: b.msgId, coordinator: up(b.coordinator), key: `hold-unregistered:${b.msgId}`,
      body: `[HOLD 미등록 · ${Math.floor((nowMs - Date.parse(b.at)) / 60_000)}분] ${up(b.coordinator)} #${b.msgId} freezes ${b.frozen.length} hands (${b.frozen.slice(0, 6).join(',')}${b.frozen.length > 6 ? ',…' : ''}) with no cells · no expiry — «${b.body.slice(0, 80)}». `
        + `Register it (not void): eln hold add --owner ${up(b.coordinator)} --cells <cells> --expires 2h --unlock '<what lifts it>' --from-msg ${b.msgId} — or the owner tells the hands it is lifted.` }));
}

export function renderHold(h: Hold, now: Date): string {
  const left = Math.round((Date.parse(h.expiresAt) - now.getTime()) / 60_000);
  const life = h.state === 'active' ? `expires ${h.expiresAt} (${left}m)` : `${h.state} ${h.closedAt ?? ''} by ${h.closedBy ?? '?'} — ${h.closeReason ?? ''}`;
  return `${h.id}\t${h.owner}\t${h.cells.join(',')}\t${life}\tunlock: ${h.unlock}\treason: ${h.reason}${h.sourceMsg ? `\tfrom #${h.sourceMsg}` : ''}`;
}
