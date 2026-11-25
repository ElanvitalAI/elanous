/**
 * MAIL-ANTI-FLOOD F·G — the three side ledgers a diverted post lands in instead of the receiver's mailbox.
 *
 *   self-wake   F · a seat's mail to itself → a scheduled wake the seat's TUI arms (ScheduleWakeup door)
 *   coach-note  F · a coach context injection → one note line per 30 min in the seat's next turn
 *   folded      G · a non-urgent post to a saturated receiver → one digest line in the receiver's next turn
 *   retro-turn  · a graph retro step (op-retro) → ONE internal turn (origin retro) the seat's TUI opens directly — never a
 *                 ScheduleWakeup entry, so the wake cap and late-wake folding cannot swallow it (11-25 OP retro loss)
 *
 * Each ledger is an append-only JSONL file per receiver (`<state>/msg/diverted/<ledger>/<SEAT>.jsonl`) with a cursor
 * file (`.cursor` = lines already taken). Nothing is dropped: a taker that fails leaves the cursor where it was.
 * Turn stamps (`turns/<SEAT>.jsonl`) give G its «turns in the last hour» without opening any other store.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';

export type DivertedLedger = 'self-wake' | 'coach-note' | 'folded' | 'retro-turn';

export interface DivertedEntry {
  /** Receiver seat (the ledger's owner). */
  seat: string;
  from: string;
  kind: string;
  body: string;
  at: string;
  refs?: string[];
  /** self-wake: when the wake should fire (ISO) — absent = as soon as the TUI drains it. */
  dueAt?: string;
}

/** Coach notes reach a turn at most once per this window. */
export const COACH_NOTE_WINDOW_MS = 30 * 60_000;
/** Turn stamps kept for G (one hour ⊕ margin). */
const TURN_STAMP_KEEP_MS = 2 * 60 * 60_000;

export function divertedRoot(): string { return join(elanousStateRoot(), 'msg', 'diverted'); }

const seatFile = (seat: string): string => `${seat.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_')}.jsonl`;
export function divertedFile(ledger: DivertedLedger | 'turns', seat: string, root: string = divertedRoot()): string {
  return join(root, ledger, seatFile(seat));
}

function readLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}
function readCursor(file: string): number {
  try { const n = Number(readFileSync(`${file}.cursor`, 'utf8').trim()); return Number.isInteger(n) && n >= 0 ? n : 0; } catch { return 0; }
}
function writeCursor(file: string, n: number): void {
  const tmp = `${file}.cursor.${process.pid}.tmp`;
  writeFileSync(tmp, String(n));
  renameSync(tmp, `${file}.cursor`);
}
function parse(line: string): DivertedEntry | null {
  try { const v = JSON.parse(line) as DivertedEntry; return v && typeof v.body === 'string' && typeof v.at === 'string' ? v : null; } catch { return null; }
}

/** Append one diverted post. Throws on an I/O failure — the caller then keeps the post as mail. */
export function appendDiverted(ledger: DivertedLedger, entry: DivertedEntry, root: string = divertedRoot()): void {
  const file = divertedFile(ledger, entry.seat, root);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

/** Entries not taken yet. */
export function pendingDiverted(ledger: DivertedLedger, seat: string, root: string = divertedRoot()): DivertedEntry[] {
  const file = divertedFile(ledger, seat, root);
  return readLines(file).slice(readCursor(file)).map(parse).filter((e): e is DivertedEntry => e !== null);
}

/**
 * Take entries (oldest first). `ready` picks which pending entries are taken now — the cursor only advances over the
 * leading run of taken entries, so an entry that is not ready yet (a future self-wake) holds the ones behind it.
 */
export function takeDiverted(ledger: DivertedLedger, seat: string, ready: (e: DivertedEntry) => boolean = () => true, root: string = divertedRoot()): DivertedEntry[] {
  const file = divertedFile(ledger, seat, root);
  const lines = readLines(file);
  const start = readCursor(file);
  const taken: DivertedEntry[] = [];
  let next = start;
  for (let i = start; i < lines.length; i++) {
    const e = parse(lines[i]!);
    if (e === null) { next = i + 1; continue; }
    if (!ready(e)) break;
    taken.push(e);
    next = i + 1;
  }
  if (next !== start) writeCursor(file, next);
  return taken;
}

/** One coach-note line for a turn — null while the 30-min window since the last line has not passed or nothing waits. */
export function coachNoteLine(entries: readonly DivertedEntry[], nowMs: number, lastLineAtMs: number | null): string | null {
  if (entries.length === 0) return null;
  if (lastLineAtMs !== null && nowMs - lastLineAtMs < COACH_NOTE_WINDOW_MS) return null;
  const latest = entries[entries.length - 1]!;
  const head = latest.body.replace(/\s+/g, ' ').trim().slice(0, 200);
  return `[coach note · ${entries.length} since ${entries[0]!.at.slice(11, 16)}Z · no reply needed] ${head}${entries.length > 1 ? ` (+${entries.length - 1} earlier in the coach-note ledger)` : ''}`;
}

/** One digest line for posts folded while the receiver was saturated. */
export function foldedDigestLine(entries: readonly DivertedEntry[]): string | null {
  if (entries.length === 0) return null;
  const bySender = new Map<string, number>();
  for (const e of entries) bySender.set(e.from, (bySender.get(e.from) ?? 0) + 1);
  const senders = [...bySender].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}×${n}`).join(' · ');
  const heads = entries.slice(-3).map((e) => `${e.from}: ${e.body.replace(/\s+/g, ' ').trim().slice(0, 80)}`).join(' | ');
  return `[folded digest · ${entries.length} posts while saturated · ${senders}] ${heads}`;
}

/**
 * G — stamp one turn start for this seat. RAIL30 ①: `mailOpened` = the turn was opened by mail (a seat mail notice ·
 * msg-wake · another seat's request); a self-wake / goal-drive / scheduled / human turn is stamped `<ms> s` and does
 * not count toward G's turns/h (OP is always > 20 turns/h of its own — G folded every delegated result).
 * Plain `<ms>` lines (older writers) read as mail-opened. Best-effort: observability, never a turn failure.
 */
export function noteTurnStamp(seat: string, atMs: number, root: string = divertedRoot(), mailOpened = true): void {
  try {
    const file = divertedFile('turns', seat, root);
    mkdirSync(dirname(file), { recursive: true });
    const keep = readLines(file).filter((line) => { const t = stampMs(line); return Number.isFinite(t) && atMs - t < TURN_STAMP_KEEP_MS; });
    keep.push(mailOpened ? String(atMs) : `${atMs} s`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${keep.join('\n')}\n`);
    renameSync(tmp, file);
  } catch { /* fail-open */ }
}

const stampMs = (line: string): number => Number(line.trim().split(/\s+/)[0]);
const selfStamp = (line: string): boolean => line.trim().split(/\s+/)[1] === 's';

/** G — this seat's MAIL-OPENED turns in the hour before `nowMs` (null when it never stamped a turn: unknown, not zero). */
export function turnsLastHour(seat: string, nowMs: number, root: string = divertedRoot()): number | null {
  const file = divertedFile('turns', seat, root);
  if (!existsSync(file)) return null;
  return readLines(file).filter((line) => !selfStamp(line)).map(stampMs).filter((t) => Number.isFinite(t) && t <= nowMs && nowMs - t < 60 * 60_000).length;
}

/** RAIL30 ⑤ — the seat's latest turn start of any kind (epoch ms) · null when it never stamped one (or > 2 h ago). */
export function lastTurnAt(seat: string, root: string = divertedRoot()): number | null {
  const file = divertedFile('turns', seat, root);
  if (!existsSync(file)) return null;
  const all = readLines(file).map(stampMs).filter((t) => Number.isFinite(t));
  return all.length === 0 ? null : Math.max(...all);
}

/** RAIL30 ② — total lines ever appended to a ledger (taken included): the TUI feed counts new folds from it. */
export function divertedLineCount(ledger: DivertedLedger, seat: string, root: string = divertedRoot()): number {
  return readLines(divertedFile(ledger, seat, root)).length;
}

/** RAIL30 ② — entries appended after line `from` (taken or not), for the flood meter. */
export function divertedSince(ledger: DivertedLedger, seat: string, from: number, root: string = divertedRoot()): { entries: DivertedEntry[]; total: number } {
  const lines = readLines(divertedFile(ledger, seat, root));
  return { entries: lines.slice(Math.max(0, Math.min(from, lines.length))).map(parse).filter((e): e is DivertedEntry => e !== null), total: lines.length };
}
