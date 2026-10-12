#!/usr/bin/env bun
/** One channel fetch, one recipient's durable cursor, and idempotent msg insertion. */
import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { effectiveInstanceRoot } from '../src/instance/resolve.js';
import { SEAT_ALIASES, canonicalSeatId, defaultMsgStorePath, openMsgStore } from '../src/msg/msg-store.js';
import trackData from './coord-tracks.json';
import { fetchCoordChannelComments, type CoordChannelComment } from './coord-requests-bridge.js';

const seats = new Set(trackData.tracks.map((track) => track.id));
const allSeats = [...seats];
type Options = { seat: string; channel: string; since?: string; dryRun: boolean };
type Cursor = { lastId: number; createdAt: string; sinceFloor?: string; parserHash?: string };
type Routed = { sender: string; recipients: string[] };

function parseOptions(args: string[]): Options {
  let seat = '', channel = '26146', since: string | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--seat' && args[i + 1]) seat = canonicalSeatId(args[++i]!);
    else if (arg === '--channel' && args[i + 1]) channel = args[++i]!;
    else if (arg === '--since' && args[i + 1]) since = args[++i]!;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') continue; // output formatting belongs to the CLI entry point
    else throw new Error(`unknown option or missing value: ${arg}`);
  }
  if (!seats.has(seat)) throw new Error('--seat must name a channel seat');
  if (!/^[1-9]\d*$/.test(channel)) throw new Error('--channel must be a positive integer');
  if (since && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(since)
    || !Number.isFinite(Date.parse(since)))) throw new Error('--since must be an ISO timestamp');
  return { seat, channel, ...(since ? { since } : {}), dryRun };
}

/** Only the address part of the first line and explicit body mentions route messages. */
export function routeCoordComment(body: string): Routed | null {
  const [header = '', ...bodyLines] = body.split(/\r?\n/);
  const match = /^\s*(?:#+\s*)?\*\*\[([^\]]+)\]\*\*[^\n]*?→\s*(.+)$/.exec(header);
  if (!match) return null;
  let sender: string;
  try { sender = canonicalSeatId(match[1]!); } catch { return null; }
  const recipients = new Set<string>();
  // The channel also uses `MK(⊕ UX·TC)` for a primary addressee plus copied seats.
  const address = match[2]!.replace(/\(⊕\s*([^)]*)\)/g, ' · cc $1');
  const fields = address.split('·').map((part) => part.trim());
  let inAddress = true;
  for (const field of fields) {
    const cc = /^cc\s+(.+)$/i.exec(field);
    if (!inAddress && !cc) continue;
    const tokens = (cc?.[1] ?? field).split(/[\s,]+/).filter(Boolean);
    // A title may follow the addressee without a middle dot, for example
    // `→ OP 🎓 확인:`. Only the leading seat tokens belong to the address.
    const firstNonSeat = tokens.findIndex((name) => !seats.has(name)
      && name !== '전체' && name !== '전원');
    const names = tokens.slice(0, firstNonSeat < 0 ? tokens.length : firstNonSeat);
    if (!names.length) {
      if (!cc) inAddress = false;
      continue;
    }
    if (names.includes('전체') || names.includes('전원')) {
      for (const seat of allSeats) recipients.add(seat);
    } else for (const name of names) recipients.add(name);
    if (!cc && names.length < tokens.length) inAddress = false;
  }
  for (const match of bodyLines.join('\n').matchAll(/🙋\s*([A-Z][A-Z0-9_-]*)/g)) {
    if (seats.has(match[1]!)) recipients.add(match[1]!);
  }
  recipients.delete(sender);
  return { sender, recipients: [...recipients] };
}

// Include the sender canonicalizer and its aliases: either can change which
// comments route. A harmless build-only hash change causes one safe replay.
const parserHash = createHash('sha256').update(routeCoordComment.toString())
  .update(canonicalSeatId.toString()).update(JSON.stringify(SEAT_ALIASES))
  .update(JSON.stringify(allSeats)).digest('hex');
const REPLAY_WINDOW_MS = 6 * 60 * 60 * 1000;

function validComment(value: CoordChannelComment): void {
  if (!value || !Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.body !== 'string'
    || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))
    || typeof value.html_url !== 'string') throw new Error('invalid channel comment');
}

function readCursor(path: string): Cursor | null {
  if (!existsSync(path)) return null;
  // Each run appends one small record. Concurrent runs cannot replace a newer cursor
  // with an older snapshot; the highest comment ID remains the effective cursor.
  let latest: Cursor | null = null;
  // A process can stop mid-append. The next complete record begins with the
  // stable key prefix and remains readable even when joined to a torn suffix.
  const records = readFileSync(path, 'utf8').replaceAll('{"lastId":', '\n{"lastId":').split('\n').filter(Boolean);
  for (const line of records) {
    let value: Partial<Cursor>;
    try { value = JSON.parse(line) as Partial<Cursor>; }
    catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (!Number.isSafeInteger(value.lastId) || value.lastId! < 0 || typeof value.createdAt !== 'string'
      || !Number.isFinite(Date.parse(value.createdAt)) || (value.sinceFloor !== undefined
        && (typeof value.sinceFloor !== 'string' || !Number.isFinite(Date.parse(value.sinceFloor))))
      || (value.parserHash !== undefined && !/^[a-f0-9]{64}$/.test(value.parserHash))) {
      throw new Error('invalid channel cursor');
    }
    // On equal IDs, keep the current parser marker even if an older overlapping
    // process appends its stale cursor afterward. A current marker also replaces
    // an older marker at the same ID after a replay with no newly fetched comment.
    if (!latest || value.lastId! > latest.lastId || (value.lastId === latest.lastId
      && (value.parserHash === parserHash || latest.parserHash !== parserHash))) latest = {
      lastId: value.lastId!, createdAt: value.createdAt,
      ...(value.sinceFloor ? { sinceFloor: value.sinceFloor } : {}),
      ...(value.parserHash ? { parserHash: value.parserHash } : {}),
    };
  }
  return latest;
}

function saveCursor(path: string, cursor: Cursor): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(cursor)}\n`, { mode: 0o600 });
}

function hasProvenance(db: Database, key: string): boolean {
  return db.query('SELECT 1 FROM msg_provenance WHERE provenance_key = ?').get(key) !== null;
}

export function runBridge(args: string[], fetch = fetchCoordChannelComments): {
  seat: string; read: number; picked: number; added: number; existing: number; cursor: number;
} {
  return runBridgeWithClock(args, fetch, Date.now);
}

export function runBridgeWithClock(args: string[], fetch: typeof fetchCoordChannelComments, now: () => number): {
  seat: string; read: number; picked: number; added: number; existing: number; cursor: number;
} {
  const options = parseOptions(args);
  const cursorPath = join(effectiveInstanceRoot(), 'msg', `coord-bridge-${options.channel}-${options.seat}.json`);
  const cursor = readCursor(cursorPath);
  const replayFloor = cursor && cursor.parserHash !== parserHash ? now() - REPLAY_WINDOW_MS : undefined;
  // GitHub filters `since` by updated_at; the creation-time check below limits
  // parser replay to comments created in the last six hours, even if older
  // comments were edited recently. Numeric IDs decide normal progress.
  // GitHub's `since` is exclusive. Fetch one second before the replay floor
  // so a comment created exactly on the six-hour boundary remains visible.
  const since = cursor ? new Date(Math.min(Date.parse(cursor.createdAt) - 1000,
    replayFloor === undefined ? Infinity : replayFloor - 1000)).toISOString() : options.since;
  const comments = fetch(options.channel, since);
  for (const comment of comments) validComment(comment); // no writes if fetching/parsing fails mid-page
  // GitHub's `since` filters updated_at, so a caller's creation-time floor persists across runs.
  const unseen = comments.filter((comment) => comment.id > (cursor?.lastId ?? 0));
  const sinceFloor = cursor?.sinceFloor ?? (cursor ? undefined : options.since);
  const pending = comments.filter((comment) =>
    (comment.id > (cursor?.lastId ?? 0) || (replayFloor !== undefined
      && Date.parse(comment.created_at) >= replayFloor))
    && (!sinceFloor || Date.parse(comment.created_at) >= Date.parse(sinceFloor)));
  const candidate = unseen.reduce<CoordChannelComment | null>((last, comment) =>
    !last || comment.id > last.id ? comment : last, null);
  let picked = 0, added = 0, existing = 0;
  const dbPath = defaultMsgStorePath();
  if (options.dryRun) {
    const db = existsSync(dbPath) ? new Database(dbPath, { readonly: true }) : null;
    try {
      for (const comment of pending) {
        const route = routeCoordComment(comment.body);
        if (!route?.recipients.includes(options.seat)) continue;
        picked++;
        if (db && hasProvenance(db, `coord:${comment.id}:${options.seat}`)) existing++;
        else added++;
      }
    } finally { db?.close(); }
  } else {
    const store = openMsgStore();
    try {
      store.db.transaction(() => {
        for (const comment of pending) {
          const route = routeCoordComment(comment.body);
          if (!route?.recipients.includes(options.seat)) continue;
          picked++;
          const key = `coord:${comment.id}:${options.seat}`;
          if (hasProvenance(store.db, key)) existing++;
          else added++;
          store.appendWithProvenance({ from: route.sender, to: options.seat, body: comment.body, kind: 'coord' }, key);
        }
      }).immediate();
    } finally { store.close(); }
    if (candidate || (!cursor && sinceFloor) || replayFloor !== undefined) {
      const createdAt = candidate?.created_at ?? cursor?.createdAt ?? sinceFloor!;
      saveCursor(cursorPath, { lastId: candidate?.id ?? cursor?.lastId ?? 0,
        createdAt: sinceFloor && Date.parse(createdAt) < Date.parse(sinceFloor) ? sinceFloor : createdAt,
        ...(sinceFloor ? { sinceFloor } : {}), parserHash });
    }
  }
  return { seat: options.seat, read: comments.length, picked, added, existing,
    cursor: options.dryRun ? cursor?.lastId ?? 0 : readCursor(cursorPath)?.lastId ?? 0 };
}

if (import.meta.main) {
  try {
    const result = runBridge(process.argv.slice(2));
    console.log(process.argv.includes('--json') ? JSON.stringify(result)
      : `${result.seat}: read ${result.read}, picked ${result.picked}, added ${result.added}, existing ${result.existing}, cursor ${result.cursor}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
