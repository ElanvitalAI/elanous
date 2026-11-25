// WATCHER-HEARTBEAT — «watch the watchers» (대표 11-25 20:4x «watchers fail silently»).
//
// 세 얼굴: 관측 = every watcher appends one beat line (`eln watch beat <name> --saw n --last id|ts [--err msg]`) to one
// ledger under the instance root / 판단 근거 = `judgeWatchers`: no beat > 2× cadence = DEAD · last beats all errored =
// BROKEN · saw 0 for N windows while the source moved past the watcher's cursor (or the cursor is ahead of the source,
// e.g. a start id 166000 while ids are 1659xx) = BLIND / 수복과 인계 = one deduped card to CLAUDE-OP per status change
// (repeat at most hourly) ⊕ a «👁 Watchers» row on `els status-board`; the watcher owner fixes the watcher.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';

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
}

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

export function makeBeat(input: { name: string; saw: number; last?: string; err?: string; everyMin?: number; source?: string }, now: Date): Beat {
  if (!NAME.test(input.name)) throw new Error(`watch beat: invalid watcher name ${JSON.stringify(input.name)}`);
  if (!Number.isFinite(input.saw) || input.saw < 0) throw new Error('watch beat: --saw must be a number ≥ 0');
  const everyMin = input.everyMin ?? 5;
  if (!Number.isFinite(everyMin) || everyMin <= 0) throw new Error('watch beat: --every must be minutes > 0');
  return { name: input.name, at: now.toISOString(), saw: Math.floor(input.saw), everyMin,
    ...(input.last !== undefined && input.last !== '' ? { last: input.last } : {}),
    ...(input.err ? { err: input.err.slice(0, 500) } : {}),
    ...(input.source ? { source: input.source } : {}) };
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

export function judgeWatchers(beats: readonly Beat[], now: Date, sourceHead: SourceHead = () => null): WatcherVerdict[] {
  const byName = new Map<string, Beat[]>();
  for (const b of beats) { const list = byName.get(b.name) ?? []; list.push(b); byName.set(b.name, list); }
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
    if (ageMin > DEAD_AFTER_CADENCES * everyMin) {
      status = 'DEAD'; reason = `no beat for ${Math.round(ageMin)}m (cadence ${everyMin}m)`;
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

/** Fail-soft beat for in-repo watchers: a broken ledger must never break the watcher itself. */
export function beatSafe(input: { name: string; saw: number; last?: string; err?: string; everyMin?: number; source?: string }, path?: string): void {
  try { appendBeat(makeBeat(input, new Date()), path); } catch { /* fail-soft */ }
}
