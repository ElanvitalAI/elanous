// kit/heartbeat — ONE source of truth for «is it alive?» (PLATFORM-KITS-DUPLICATION-MAP-1127 §1-10 · CEO 11-27 «중복 정리»).
//
// S: two stores answered the same question — the watcher ledger `{root}/watchers/beats.jsonl` (watchers-check · guardian 맥박 ·
//    silence-watch · els board · world) and the SQLite `loop_signals` table in `{root}/msg/messages.db` (seat loops · orchestrator ·
//    neighbor check · steward triage). A loop could be DEAD in one and healthy in the other.
// A: beats.jsonl is the truth. Every writer goes through `beat()` (or `emitSignal()` for leased loops, which beats first and then
//    refreshes the `loop_signals` row as a read-only mirror for the transactional neighbor check). Nobody else writes that table.
//    Readers ask `lastBeat(id)` and `staleness(beat, now, slaMin)` — one SLA rule: late > 1× cadence, dead > 2× cadence, a
//    declared lease (`endsAt` in the future) outranks both.
//
// WATCHER-HEARTBEAT — «watch the watchers» (대표 11-25 20:4x «watchers fail silently»).
//
// 세 얼굴: 관측 = every watcher appends one beat line (`eln watch beat <name> --saw n --last id|ts [--err msg]`) to one
// ledger under the instance root / 판단 근거 = `judgeWatchers`: no beat > 2× cadence = DEAD · last beats all errored =
// BROKEN · saw 0 for N windows while the source moved past the watcher's cursor (or the cursor is ahead of the source,
// e.g. a start id 166000 while ids are 1659xx) = BLIND / 수복과 인계 = one deduped card to CLAUDE-OP per status change
// (repeat at most hourly) ⊕ a «👁 Watchers» row on `els status-board`; the watcher owner fixes the watcher.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';

export type WatcherStatus = 'OK' | 'DEAD' | 'BLIND' | 'BROKEN';

export interface Beat {
  readonly name: string;
  readonly at: string;
  readonly saw: number;
  readonly last?: string;
  readonly err?: string;
  /** Expected cadence in minutes (declared by the watcher on each beat). */
  readonly everyMin: number;
  /** What the watcher reads, so BLIND can compare against it: `msg` = msg store max id. */
  readonly source?: string;
  /** Declared lease end (ISO): a scheduled loop idle between windows is not stale until this passes. */
  readonly endsAt?: string;
  /** `loop-signal` = a leased loop beat (seat loops · orchestrator) mirrored into `loop_signals`; not a watcher card subject. */
  readonly kind?: 'loop-signal';
  /** Loop health carried by a loop-signal beat. */
  readonly health?: LoopHealth;
}

export type LoopHealth = 'healthy' | 'degraded';

export interface WatcherVerdict {
  readonly name: string;
  readonly status: WatcherStatus;
  readonly ageMin: number;
  readonly everyMin: number;
  readonly sawLastWindow: number;
  readonly last: string | null;
  readonly lastError: string | null;
  readonly source: string | null;
  readonly sourceHead: number | null;
  readonly reason: string;
}

/** DEAD after this many missed cadences (대표 rule: «no beat > 2× cadence»). */
export const DEAD_AFTER_CADENCES = 2;
/** BLIND after this many consecutive zero-seen windows while the source moved. */
export const BLIND_AFTER_WINDOWS = 3;
/** BROKEN after this many consecutive errored beats. */
export const BROKEN_AFTER_ERRORS = 3;
/** A still-bad watcher is re-carded at most this often. */
export const REALERT_MIN = 60;
const TAIL_BYTES = 2 * 1024 * 1024;

export function watchDir(root = effectiveInstanceRoot()): string { return join(root, 'watchers'); }
export function beatLedgerPath(root?: string): string { return join(watchDir(root), 'beats.jsonl'); }
export function alertStatePath(root?: string): string { return join(watchDir(root), 'alerts.json'); }

const NAME = /^[A-Za-z0-9][\w.:-]{0,63}$/;

export interface BeatInput { name: string; saw: number; last?: string; err?: string; everyMin?: number; source?: string; endsAt?: string; kind?: 'loop-signal'; health?: LoopHealth }

export function makeBeat(input: BeatInput, now: Date): Beat {
  if (!NAME.test(input.name)) throw new Error(`watch beat: invalid watcher name ${JSON.stringify(input.name)}`);
  if (!Number.isFinite(input.saw) || input.saw < 0) throw new Error('watch beat: --saw must be a number ≥ 0');
  const everyMin = input.everyMin ?? 5;
  if (!Number.isFinite(everyMin) || everyMin <= 0) throw new Error('watch beat: --every must be minutes > 0');
  return { name: input.name, at: now.toISOString(), saw: Math.floor(input.saw), everyMin,
    ...(input.last !== undefined && input.last !== '' ? { last: input.last } : {}),
    ...(input.err ? { err: input.err.slice(0, 500) } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.endsAt ? { endsAt: input.endsAt } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.health ? { health: input.health } : {}) };
}

export function appendBeat(beat: Beat, path = beatLedgerPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(beat)}\n`);
}

/** Read the ledger tail (2 MB) — malformed lines are skipped, not fatal. */
export function readBeats(path = beatLedgerPath()): Beat[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = openSync(path, 'r');
  let text: string;
  try { const buf = Buffer.alloc(size - start); readSync(fd, buf, 0, buf.length, start); text = buf.toString('utf8'); } finally { closeSync(fd); }
  const lines = text.split('\n');
  if (start > 0) lines.shift();
  const out: Beat[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const b = JSON.parse(line) as Beat;
      if (typeof b.name === 'string' && typeof b.at === 'string' && typeof b.saw === 'number' && typeof b.everyMin === 'number') out.push(b);
    } catch { /* skip */ }
  }
  return out;
}

/** Head of a source (e.g. msg store max id); null = unknown source or unreadable. */
export type SourceHead = (source: string) => number | null;

/** `retired` = ids of retired (absorbed) triggers (trigger-registry `retiredTriggerIds`) — their old beat is history, not a
 *  watcher: an absorbed job never beats again, so it would read DEAD forever (11-28 guardian `beat:watchers-check`). */
export function judgeWatchers(beats: readonly Beat[], now: Date, sourceHead: SourceHead = () => null, opts: { includeSignals?: boolean; retired?: ReadonlySet<string> | null } = {}): WatcherVerdict[] {
  const byName = new Map<string, Beat[]>();
  for (const b of beats) {
    if (b.kind === 'loop-signal' && !opts.includeSignals) continue;
    if (opts.retired?.has(b.name)) continue;
    const list = byName.get(b.name) ?? []; list.push(b); byName.set(b.name, list); }
  const verdicts: WatcherVerdict[] = [];
  for (const [name, list] of byName) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const latest = list[list.length - 1]!;
    const everyMin = latest.everyMin;
    const ageMin = Math.max(0, (now.getTime() - Date.parse(latest.at)) / 60_000);
    const lastError = [...list].reverse().find(b => b.err)?.err ?? null;
    const source = latest.source ?? null;
    const head = source ? sourceHead(source) : null;
    const lastNum = latest.last !== undefined && /^\d+$/.test(latest.last) ? Number(latest.last) : null;
    let status: WatcherStatus = 'OK';
    let reason = 'beating';
    const tailErr = list.slice(-BROKEN_AFTER_ERRORS);
    const tailZero = list.slice(-BLIND_AFTER_WINDOWS);
    if (staleness(latest, now).state === 'dead') {
      status = 'DEAD'; reason = latest.endsAt ? `lease ended ${latest.endsAt} (last beat ${Math.round(ageMin)}m ago)` : `no beat for ${Math.round(ageMin)}m (cadence ${everyMin}m)`;
    } else if (tailErr.length >= BROKEN_AFTER_ERRORS && tailErr.every(b => b.err)) {
      status = 'BROKEN'; reason = `${BROKEN_AFTER_ERRORS} errored beats in a row: ${latest.err ?? lastError}`;
    } else if (head !== null && lastNum !== null && lastNum > head) {
      status = 'BLIND'; reason = `cursor ${lastNum} is ahead of source ${source} head ${head}`;
    } else if (head !== null && lastNum !== null && head > lastNum && tailZero.length >= BLIND_AFTER_WINDOWS && tailZero.every(b => b.saw === 0)) {
      status = 'BLIND'; reason = `saw 0 for ${BLIND_AFTER_WINDOWS} windows while source ${source} moved to ${head} (cursor ${lastNum})`;
    }
    verdicts.push({ name, status, ageMin: Math.round(ageMin * 10) / 10, everyMin, sawLastWindow: latest.saw, last: latest.last ?? null,
      lastError, source, sourceHead: head, reason });
  }
  return verdicts.sort((a, b) => a.name.localeCompare(b.name));
}

export interface AlertState { readonly [name: string]: { readonly status: WatcherStatus; readonly at: string } }

export function readAlertState(path = alertStatePath()): AlertState {
  try { return JSON.parse(readFileSync(path, 'utf8')) as AlertState; } catch { return {}; }
}

export function writeAlertState(state: AlertState, path = alertStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, path);
}

/** Deduped alert step: card a watcher when it turns bad, changes bad status, or stays bad past REALERT_MIN. */
export function alertStep(prev: AlertState, verdicts: readonly WatcherVerdict[], now: Date): { card: string | null; next: AlertState } {
  const next: Record<string, { status: WatcherStatus; at: string }> = {};
  const lines: string[] = [];
  for (const v of verdicts) {
    if (v.status === 'OK') continue;
    const p = prev[v.name];
    const due = !p || p.status !== v.status || now.getTime() - Date.parse(p.at) >= REALERT_MIN * 60_000;
    if (due) { lines.push(`· ${v.status} ${v.name} — ${v.reason}`); next[v.name] = { status: v.status, at: now.toISOString() }; }
    else next[v.name] = p;
  }
  const card = lines.length ? `[감시자 감시 · watch-the-watchers] ${lines.length}건\n${lines.join('\n')}\n(eln watch status 로 전체 확인)` : null;
  return { card, next };
}

/** Federation Board row; null when nothing has beaten yet. */
export function watchersBoardLine(verdicts: readonly WatcherVerdict[]): string | null {
  if (verdicts.length === 0) return null;
  const bad = verdicts.filter(v => v.status !== 'OK');
  const ok = verdicts.length - bad.length;
  if (bad.length === 0) return `👁 Watchers — ${ok} ok`;
  const shown = bad.slice(0, 4).map(v => `${v.status} ${v.name} ${Math.round(v.ageMin)}m`).join(' · ');
  return `👁 Watchers — ${ok} ok · ${bad.length} bad: ${shown}${bad.length > 4 ? ` · +${bad.length - 4}` : ''}`;
}

/** Fail-soft beat in the BeatInput shape (watch-cli · loop-agent ports) — the same writer as `beat()`. */
export function beatSafe(input: BeatInput, path?: string): void {
  writeBeat(input, new Date(), path ?? beatLedgerPath());
}

function writeBeat(input: BeatInput, now: Date, path: string): void {
  try { appendBeat(makeBeat(input, now), path); }
  catch (e) { try { debug.log('kit.heartbeat', 'beat-failed', { id: input.name, error: String(e).slice(0, 200) }, { level: 'warn' }); } catch { /* observe only */ } }
}

// ── kit API ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `beat(id)` — the one writer. Fail-soft (a broken ledger never breaks the caller); `ok:false`/`err` marks an errored beat. */
export function beat(id: string, opts: { everyMin?: number; saw?: number; last?: string; err?: string; ok?: boolean; source?: string; root?: string; now?: Date } = {}): void {
  const err = opts.err ?? (opts.ok === false ? 'not ok' : undefined);
  writeBeat({ name: id, saw: opts.saw ?? 0, last: opts.last, err, everyMin: opts.everyMin, source: opts.source }, opts.now ?? new Date(), beatLedgerPath(opts.root));
}

/** Latest beat for `id` (by event time), or null when it never beat. */
export function lastBeat(id: string, opts: { root?: string; path?: string; beats?: readonly Beat[] } = {}): Beat | null {
  const beats = opts.beats ?? readBeats(opts.path ?? beatLedgerPath(opts.root));
  let best: Beat | null = null;
  for (const b of beats) if (b.name === id && (!best || Date.parse(b.at) >= Date.parse(best.at))) best = b;
  return best;
}

export type Staleness = 'missing' | 'fresh' | 'late' | 'dead';

/** One SLA rule. `slaMin` defaults to the beat's declared cadence. late = age > 1× SLA · dead = age > DEAD_AFTER_CADENCES × SLA ·
 *  a lease (`endsAt` in the future) keeps a beat fresh; an expired lease is dead at once. */
export function staleness(b: Beat | null, now: Date, slaMin?: number): { state: Staleness; ageMin: number | null; slaMin: number | null; leased: boolean } {
  if (!b) return { state: 'missing', ageMin: null, slaMin: slaMin ?? null, leased: false };
  const sla = slaMin ?? b.everyMin;
  const ageMin = Math.max(0, (now.getTime() - Date.parse(b.at)) / 60_000);
  const end = b.endsAt ? Date.parse(b.endsAt) : NaN;
  if (Number.isFinite(end)) {
    if (end > now.getTime()) return { state: 'fresh', ageMin, slaMin: sla, leased: true };
    return { state: 'dead', ageMin, slaMin: sla, leased: false };
  }
  const state: Staleness = ageMin > DEAD_AFTER_CADENCES * sla ? 'dead' : ageMin > sla ? 'late' : 'fresh';
  return { state, ageMin, slaMin: sla, leased: false };
}

// ── loop_signals mirror (read-only for everyone but this kit) ──────────────────────────────────────────────────────────

const LOOP_ID = /^[a-z][a-z0-9-]*$/;

function withSignalStore<T>(root: string, fn: (store: import('../../msg/msg-store.js').MsgStore) => T): T {
  const { openMsgStore } = require('../../msg/msg-store.js') as typeof import('../../msg/msg-store.js');
  const store = openMsgStore(join(root, 'msg', 'messages.db'));
  try {
    store.db.exec(`CREATE TABLE IF NOT EXISTS loop_signals (loop_id TEXT PRIMARY KEY, at TEXT NOT NULL, health TEXT NOT NULL, ends_at TEXT);`);
    return fn(store);
  } finally { store.close(); }
}

/** A leased loop beat: append to the truth ledger first, then refresh the `loop_signals` mirror row (older beats never win).
 *  Throws on invalid input or a failed write — loop callers already wrap it and log their own failure. */
export function emitSignal(root: string, loopId: string, health: LoopHealth, now: Date, endsAt?: string, everyMin = 15): void {
  if (!LOOP_ID.test(loopId) || !Number.isFinite(now.getTime())) throw new Error('invalid loop heartbeat');
  if (endsAt && !Number.isFinite(Date.parse(endsAt))) throw new Error('invalid heartbeat end');
  appendBeat(makeBeat({ name: loopId, saw: 0, everyMin, kind: 'loop-signal', health, ...(health === 'degraded' ? { err: 'degraded' } : {}),
    ...(endsAt ? { endsAt } : {}) }, now), beatLedgerPath(root));
  withSignalStore(root, store => {
    store.db.query(`INSERT INTO loop_signals(loop_id, at, health, ends_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(loop_id) DO UPDATE SET at=excluded.at, health=excluded.health, ends_at=excluded.ends_at
      WHERE loop_signals.at <= excluded.at`).run(loopId, now.toISOString(), health, endsAt ?? null);
  });
  debug.log(`loop.${loopId}`, 'heartbeat', { loopId, at: now.toISOString(), health, endsAt: endsAt ?? null });
}

/** Renew the lease of a loop that is still beating healthy (≤ 15 min) but whose declared end passed. Compare-and-set on the
 *  mirror row, so a renewal never replaces a newer beat. Returns true when the lease moved. */
export function extendSignalLease(root: string, loopId: string, now: Date, byMs = 15 * 60_000): boolean {
  if (!Number.isFinite(now.getTime())) return false;
  if (!existsSync(join(root, 'msg', 'messages.db'))) return false;
  return withSignalStore(root, store => {
    const db = store.db;
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.query('SELECT at, health, ends_at FROM loop_signals WHERE loop_id=?')
        .get(loopId) as { at: string; health: string; ends_at: string | null } | null;
      const age = row ? now.getTime() - Date.parse(row.at) : NaN;
      if (!row || row.health !== 'healthy' || !Number.isFinite(age) || age < 0 || age > 15 * 60_000 ||
          !row.ends_at || !Number.isFinite(Date.parse(row.ends_at)) || Date.parse(row.ends_at) > now.getTime()) {
        db.exec('COMMIT');
        return false;
      }
      const result = db.query('UPDATE loop_signals SET ends_at=? WHERE loop_id=? AND at=? AND health=? AND ends_at=?')
        .run(new Date(now.getTime() + byMs).toISOString(), loopId, row.at, row.health, row.ends_at);
      db.exec('COMMIT');
      if (result.changes !== 1) return false;
      // Keep the truth in step: same event time (age unchanged), new lease end — lastBeat picks the later line on a tie.
      try {
        const until = new Date(now.getTime() + byMs).toISOString();
        const prev = lastBeat(loopId, { root });
        appendBeat({ name: loopId, at: new Date(row.at).toISOString(), saw: 0, everyMin: prev?.everyMin ?? 15, kind: 'loop-signal', health: 'healthy', endsAt: until },
          beatLedgerPath(root));
      } catch (e) { debug.log('kit.heartbeat', 'lease-truth-failed', { loopId, error: String(e).slice(0, 200) }, { level: 'warn' }); }
      debug.log('kit.heartbeat', 'lease-extended', { loopId, at: row.at });
      return true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
}
