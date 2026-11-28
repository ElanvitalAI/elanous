/**
 * OP-CONTEXT-BUS (CEO 11-26 · 내부 문서 `CLAUDE-OP-PROXY` §A4) — one shared context stream for Claude OP and eln OP.
 *
 * S: Claude OP and eln OP shared context through mail, coach notes and hand-written files (ceo-requests-*.md ·
 *    memory/seats/OP/*.md). Neither side knew what the other had seen; the CEO's words were copied by hand.
 * C: append-only · typed · both sides read and write · event-driven readers (no polling) · bounded size · the CEO's
 *    lines pinned and deduplicated across surfaces · the proxy writes only when its process-bound grant verifies.
 * Q: what is the one record both sides read before acting, and how does each know what the other has seen?
 * A: `<stateRoot>/op-context-bus/<SPACE>.jsonl` (default space OP): typed entries (ceo-request · decision · commitment ·
 *    status · handoff · opinion · consult) with refs; a separate `<SPACE>.acks.jsonl` records who saw what. Writes run
 *    under an O_EXCL lock (dedupe and conflict marks are decided on the same read they append after). A CEO line seen on
 *    a second surface appends an «also» row onto the first item, never a second item; a decision on a ref that already
 *    has a different decision keeps both and marks the later one `conflictsWith`. Past MAX lines, old status/opinion rows
 *    fold into one rollup row per day (atomic rewrite under the lock); ceo-request · decision · commitment never fold.
 *
 * 세 얼굴: 관측 = debug.log('bus', 'bus.post' | 'bus.ack' | 'bus.rollup') · `eln bus tail/since/digest` ·
 *          인지 = busPost (pure decisions over the read log) · busDigest · catchUp ·
 *          수복과 인계 = a torn line is skipped, a stale lock (> 5 s) is broken, a refused proxy write names the fix.
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const BUS_TYPES = ['ceo-request', 'decision', 'commitment', 'status', 'handoff', 'opinion', 'consult'] as const;
export type BusType = typeof BUS_TYPES[number];
/** Types that are never folded by the rollup and always listed first in a digest (ceo-request pinned on top). */
export const BUS_PINNED_TYPES: readonly BusType[] = ['ceo-request', 'decision', 'commitment'];
/** Types the rollup may fold. */
const FOLDABLE: ReadonlySet<string> = new Set(['status', 'opinion']);
export const BUS_MAX_LINES = 1000;
export const BUS_DEFAULT_SPACE = 'OP';
/** The two readers whose acks bound the OP space's rollup (a row neither has seen is never folded) — other spaces: their ackers. */
export const BUS_READERS: readonly string[] = ['OP', 'CLAUDE-OP'];

export interface BusEntry {
  readonly id: string;
  readonly at: string;
  readonly type: BusType | 'rollup';
  readonly from: string;
  readonly body: string;
  readonly refs: readonly string[];
  readonly source?: string;
  readonly dedupeKey?: string;
  readonly conflictsWith?: string;
  readonly owner?: string;
  readonly due?: string;
  readonly doneWhen?: string;
}
/** A second surface of an existing CEO line (not a new item). */
export interface BusAlso { readonly also: string; readonly at: string; readonly source: string; readonly from: string }
type BusLine = BusEntry | BusAlso;

/** An item as readers see it: the entry plus every other surface it arrived on. */
export interface BusItem extends BusEntry { readonly alsoFrom: readonly string[] }
export interface BusAck { readonly id: string; readonly by: string; readonly at: string }

const safeSpace = (space: string): string => space.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_') || BUS_DEFAULT_SPACE;
export function busDir(stateRoot: string): string { return join(stateRoot, 'op-context-bus'); }
export function busFile(stateRoot: string, space = BUS_DEFAULT_SPACE): string { return join(busDir(stateRoot), `${safeSpace(space)}.jsonl`); }
export function busAckFile(stateRoot: string, space = BUS_DEFAULT_SPACE): string { return join(busDir(stateRoot), `${safeSpace(space)}.acks.jsonl`); }

/** The normalized-body key of a CEO line (whitespace and case folded) — the same words from two surfaces collide. */
export function ceoDedupeKey(text: string): string {
  return createHash('sha256').update(text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()).digest('hex').slice(0, 20);
}

/** Monotonic ids: `b-<ms base36 padded>-<rand>` sort lexically in time order; a same-ms id still sorts after its parent read. */
export function busId(nowMs: number, after?: string): string {
  let ms = nowMs;
  const prev = after ? parseInt(after.split('-')[1] ?? '', 36) : NaN;
  if (Number.isFinite(prev) && prev >= ms) ms = prev + 1;
  return `b-${ms.toString(36).padStart(10, '0')}-${randomBytes(3).toString('hex')}`;
}

function readLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (error) { log('bus.read-failed', { file, error: String(error).slice(0, 160) }); return []; }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* a torn line is skipped */ }
  }
  return out;
}

/** Every item in log order, with its «also» surfaces attached. */
export function readBus(stateRoot: string, space = BUS_DEFAULT_SPACE): BusItem[] {
  const lines = readLines<BusLine>(busFile(stateRoot, space));
  const items: BusItem[] = [];
  const byId = new Map<string, { item: BusEntry; also: string[] }>();
  for (const l of lines) {
    if ('also' in l) { const t = byId.get(l.also); if (t) t.also.push(l.source); continue; }
    if (typeof l.id !== 'string' || typeof l.body !== 'string') continue;
    byId.set(l.id, { item: l, also: [] });
  }
  for (const { item, also } of byId.values()) items.push({ ...item, refs: item.refs ?? [], alsoFrom: also });
  return items;
}

export function readAcks(stateRoot: string, space = BUS_DEFAULT_SPACE): BusAck[] {
  return readLines<BusAck>(busAckFile(stateRoot, space)).filter((a) => typeof a.id === 'string' && typeof a.by === 'string');
}

/**
 * Append one JSONL line. A torn last line (no trailing newline — a writer died mid-write) is closed with a newline first,
 * so the new line never glues onto it (the torn fragment is then skipped by readers, the new line parses).
 */
function appendLine(file: string, line: string): void {
  if (existsSync(file)) {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) appendFileSync(file, '\n');
      }
    } finally { closeSync(fd); }
  }
  appendFileSync(file, `${line}\n`, { mode: 0o600 });
}

const LOCK_STALE_MS = 30_000;
const LOCK_TRIES = 250;
const LOCK_WAIT_MS = 20;

const pidAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException)?.code === 'EPERM'; }
};

/**
 * Break a lock only when its holder is gone (its pid is dead, or the lock is older than 30 s). The break is a rename to
 * a unique name (one breaker wins); if what was renamed is not the lock we judged dead (a new writer took it in
 * between), it is linked back (link fails if yet another lock exists — then that one stands).
 */
function breakStaleLock(lock: string): void {
  let holder: number;
  try { holder = Number(readFileSync(lock, 'utf8').trim()); } catch { return; }
  let old = false;
  try { old = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { return; }
  // An empty/unreadable pid is a lock being written right now: only age breaks it.
  if (!Number.isSafeInteger(holder) || holder < 1) { if (!old) return; }
  else if (pidAlive(holder) && !old) return;
  const moved = `${lock}.${randomBytes(6).toString('hex')}.stale`;
  try { renameSync(lock, moved); } catch { return; }
  let movedHolder = NaN;
  try { movedHolder = Number(readFileSync(moved, 'utf8').trim()); } catch { /* unreadable: treat as the judged one */ }
  if (Number.isFinite(movedHolder) && movedHolder !== holder) { try { linkSync(moved, lock); } catch { /* another lock exists now */ } }
  try { unlinkSync(moved); } catch { /* gone */ }
}

/** Hold the space's write lock (O_EXCL file holding the writer pid) for `fn`. */
function withBusLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  for (let i = 0; i < LOCK_TRIES; i++) {
    let fd: number;
    try { fd = openSync(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      breakStaleLock(lock);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
      continue;
    }
    try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
    try { return fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
  }
  throw new Error('bus: write lock busy');
}

export interface BusPostInput {
  readonly type: BusType;
  readonly from: string;
  readonly body: string;
  readonly refs?: readonly string[];
  readonly source?: string;
  readonly owner?: string;
  readonly due?: string;
  readonly doneWhen?: string;
  /** CONTEXT-BUS-FEDERATION — an idempotency key for a non-CEO item (a loop agent's notice key): the same key twice in the
   *  space is a `duplicate`, never a second row. Stored as the entry's `dedupeKey`. */
  readonly key?: string;
}

export type BusPostResult =
  | { readonly kind: 'posted'; readonly entry: BusEntry; readonly conflict?: string }
  | { readonly kind: 'also'; readonly id: string; readonly source: string }
  | { readonly kind: 'duplicate'; readonly id: string };

/** Validate a post (closed type set · a commitment names its owner and done-when · a ceo-request names its surface). */
export function busPostError(input: BusPostInput): string | null {
  if (!(BUS_TYPES as readonly string[]).includes(input.type)) return `bus post: unknown --type ${JSON.stringify(input.type)} (${BUS_TYPES.join('|')})`;
  if (!input.body.trim()) return 'bus post: empty body';
  if (input.body.length > 8_000) return 'bus post: body over 8000 chars — put the long text in a file and ref it';
  if (input.type === 'commitment' && (!input.owner || !input.doneWhen)) return 'bus post: a commitment needs --owner and --done-when';
  if (input.type === 'ceo-request' && !input.source) return 'bus post: a ceo-request needs --source <surface> (telegram · tui · web · …)';
  return null;
}

/**
 * Append one item under the lock. A ceo-request whose normalized words already exist becomes an «also» row on the
 * first item (or a no-op when the same surface repeats). A decision on a ref that already holds a decision with
 * different words is kept and marked `conflictsWith` the newest such decision.
 */
export function busPost(stateRoot: string, input: BusPostInput, opts: { space?: string; now?: number; maxLines?: number } = {}): BusPostResult {
  const err = busPostError(input);
  if (err) throw new Error(err);
  const space = opts.space ?? BUS_DEFAULT_SPACE;
  const file = busFile(stateRoot, space);
  const now = opts.now ?? Date.now();
  const result = withBusLock(file, (): BusPostResult => {
    const items = readBus(stateRoot, space);
    const at = new Date(now).toISOString();
    const refs = [...new Set((input.refs ?? []).map((r) => r.trim()).filter(Boolean))];
    let dedupeKey: string | undefined;
    if (input.type === 'ceo-request') {
      dedupeKey = ceoDedupeKey(input.body);
      const first = items.find((i) => i.type === 'ceo-request' && i.dedupeKey === dedupeKey);
      if (first) {
        const source = input.source ?? 'unknown';
        if (first.source === source || first.alsoFrom.includes(source)) return { kind: 'duplicate', id: first.id };
        appendLine(file, JSON.stringify({ also: first.id, at, source, from: input.from } satisfies BusAlso));
        return { kind: 'also', id: first.id, source };
      }
    }
    if (input.type !== 'ceo-request' && input.key?.trim()) {
      dedupeKey = `k:${input.key.trim().slice(0, 200)}`;
      const same = items.find((i) => i.dedupeKey === dedupeKey);
      if (same) return { kind: 'duplicate', id: same.id };
    }
    let conflictsWith: string | undefined;
    if (input.type === 'decision' && refs.length) {
      const norm = (s: string) => s.replace(/\s+/gu, ' ').trim().toLowerCase();
      const clash = [...items].reverse().find((i) => i.type === 'decision' && i.refs.some((r) => refs.includes(r)) && norm(i.body) !== norm(input.body));
      if (clash) conflictsWith = clash.id;
    }
    const entry: BusEntry = {
      id: busId(now, items.at(-1)?.id), at, type: input.type, from: input.from.trim().toUpperCase(), body: input.body, refs,
      ...(input.source ? { source: input.source } : {}), ...(dedupeKey ? { dedupeKey } : {}), ...(conflictsWith ? { conflictsWith } : {}),
      ...(input.owner ? { owner: input.owner } : {}), ...(input.due ? { due: input.due } : {}), ...(input.doneWhen ? { doneWhen: input.doneWhen } : {}),
    };
    appendLine(file, JSON.stringify(entry));
    // The post is durable once appended: a failed rollup never turns it into a reported failure (it retries next post).
    try { rollupLocked(stateRoot, space, opts.maxLines ?? BUS_MAX_LINES, now); }
    catch (error) { log('bus.rollup-failed', { space, error: String(error).slice(0, 160) }); }
    return { kind: 'posted', entry, ...(conflictsWith ? { conflict: conflictsWith } : {}) };
  });
  log('bus.post', { space, type: input.type, from: input.from, result: result.kind });
  return result;
}

/**
 * Past `maxLines` raw lines, fold status/opinion rows older than today into one rollup row per day (count ⊕ the first
 * words of each). Pinned types, handoffs, consults, today's rows and «also» rows stay. Atomic rewrite; caller holds the lock.
 */
function rollupLocked(stateRoot: string, space: string, maxLines: number, nowMs: number): number {
  const file = busFile(stateRoot, space);
  const raw = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  if (raw.length <= maxLines) return 0;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  // Only rows every reader has seen fold: at or below the lowest ack cursor of the space's readers — OP and CLAUDE-OP for
  // the OP space; for every other space (CONTEXT-BUS-FEDERATION) the seats that ever acked there (no cursor = nothing folds).
  const acks = readAcks(stateRoot, space);
  const readers = safeSpace(space) === BUS_DEFAULT_SPACE ? BUS_READERS : [...new Set(acks.map((a) => a.by))];
  if (readers.length === 0) return 0;
  const cursors = readers.map((seat) => ackCursor(acks, seat));
  if (cursors.some((c) => c === null)) return 0;
  const floor = cursors.reduce((a, b) => (a! < b! ? a : b))!;
  const days = new Map<string, BusEntry[]>();
  const keep: string[] = [];
  for (const line of raw) {
    let parsed: BusLine;
    try { parsed = JSON.parse(line) as BusLine; } catch { continue; }
    if (!('also' in parsed) && FOLDABLE.has(parsed.type) && parsed.at.slice(0, 10) < today && parsed.id <= floor) {
      const day = parsed.at.slice(0, 10);
      (days.get(day) ?? days.set(day, []).get(day)!).push(parsed);
      continue;
    }
    keep.push(line);
  }
  if (days.size === 0) return 0;
  const rollups = [...days.entries()].map(([day, rows]) => JSON.stringify({
    id: `${rows[0]!.id}-r`, at: `${day}T23:59:59.999Z`, type: 'rollup', from: 'BUS', refs: [...new Set(rows.flatMap((r) => r.refs))].slice(0, 20),
    body: `${rows.length} status/opinion rows on ${day}: ${rows.map((r) => `${r.from}: ${r.body.replace(/\s+/gu, ' ').slice(0, 60)}`).join(' | ').slice(0, 1500)}`,
  } satisfies BusEntry));
  // Rollup rows keep their place in time: the day's first id, sorted with the rest by id.
  const all = [...keep, ...rollups].map((l) => ({ l, id: (JSON.parse(l) as { id?: string; also?: string }).id ?? (JSON.parse(l) as { also?: string }).also ?? '' }));
  const ordered = all.map((x, i) => ({ ...x, i })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.i - b.i)).map((x) => x.l);
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${ordered.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, file);
  const folded = [...days.values()].reduce((n, r) => n + r.length, 0);
  log('bus.rollup', { space, folded, days: days.size });
  return folded;
}

/** Record that `by` has seen everything up to and including `id` (the cursor) — append-only. */
export function busAck(stateRoot: string, id: string, by: string, opts: { space?: string; now?: number } = {}): BusAck {
  const space = opts.space ?? BUS_DEFAULT_SPACE;
  const ack: BusAck = { id, by: by.trim().toUpperCase(), at: new Date(opts.now ?? Date.now()).toISOString() };
  // The existence check and the append run under the space lock (a rollup cannot fold the item in between).
  withBusLock(busFile(stateRoot, space), () => {
    if (!readBus(stateRoot, space).some((i) => i.id === id)) throw new Error(`bus ack: no item ${id}`);
    appendLine(busAckFile(stateRoot, space), JSON.stringify(ack));
  });
  log('bus.ack', { space, by: ack.by });
  return ack;
}

/** The highest id `seat` acked (its cursor), or null. */
export function ackCursor(acks: readonly BusAck[], seat: string): string | null {
  const s = seat.trim().toUpperCase();
  let best: string | null = null;
  for (const a of acks) if (a.by === s && (best === null || a.id > best)) best = a.id;
  return best;
}

/** Items after `id` (exclusive) in log order; `id` null = everything. */
export function busSince(items: readonly BusItem[], id: string | null): BusItem[] {
  return id === null ? [...items] : items.filter((i) => i.id > id);
}

/** Catch-up after a restart: the items after `seat`'s own last ack. */
export function catchUp(stateRoot: string, seat: string, space = BUS_DEFAULT_SPACE): BusItem[] {
  return busSince(readBus(stateRoot, space), ackCursor(readAcks(stateRoot, space), seat));
}

export interface DigestOptions { readonly forSeat: string; readonly other?: string; readonly maxChars?: number; readonly sinceId?: string | null }

const oneLine = (s: string, n: number): string => { const f = s.replace(/\s+/gu, ' ').trim(); return f.length <= n ? f : `${f.slice(0, n - 1)}…`; };

/**
 * The compact digest a turn envelope carries: items after `forSeat`'s cursor (or `sinceId`), ceo-request pinned first,
 * then decisions/commitments, then the rest — newest first inside each band. `✓` = the other side acked it, `·` = not
 * yet; `⚠` marks a conflicting decision. Bounded by `maxChars` (default 2000); the overflow is counted on the last line.
 */
export function busDigest(stateRoot: string, opts: DigestOptions, space = BUS_DEFAULT_SPACE): string {
  const items = readBus(stateRoot, space);
  const acks = readAcks(stateRoot, space);
  const since = opts.sinceId !== undefined ? opts.sinceId : ackCursor(acks, opts.forSeat);
  const fresh = busSince(items, since);
  if (fresh.length === 0) return '';
  const other = (opts.other ?? (opts.forSeat.toUpperCase() === 'OP' ? 'CLAUDE-OP' : 'OP')).toUpperCase();
  const otherCursor = ackCursor(acks, other);
  const band = (i: BusItem): number => (i.type === 'ceo-request' ? 0 : BUS_PINNED_TYPES.includes(i.type as BusType) ? 1 : 2);
  const ordered = [...fresh].sort((a, b) => band(a) - band(b) || (a.id < b.id ? 1 : -1));
  const max = opts.maxChars ?? 2000;
  const head = `<op_context_bus space="${safeSpace(space)}" new="${fresh.length}">`;
  const lines: string[] = [head];
  let used = head.length;
  let shown = 0;
  for (const i of ordered) {
    const seen = otherCursor !== null && i.id <= otherCursor ? '✓' : '·';
    const mark = i.conflictsWith ? ` ⚠ conflicts ${i.conflictsWith}` : '';
    const where = i.source ? `@${i.source}${i.alsoFrom.length ? `+${i.alsoFrom.join('+')}` : ''}` : '';
    const extra = i.type === 'commitment' ? ` (owner ${i.owner ?? '?'}${i.due ? ` · due ${i.due}` : ''} · done when ${oneLine(i.doneWhen ?? '?', 60)})` : '';
    const refs = i.refs.length ? ` [${i.refs.slice(0, 4).join(' ')}]` : '';
    let line = `${seen} ${i.id} ${i.type} ${i.from}${where}${mark}: ${oneLine(i.body, i.type === 'ceo-request' ? 400 : 160)}${extra}${refs}`;
    const room = max - 40 - used - 1;
    if (line.length > room) {
      // CEO words are never dropped for lack of room while some room is left: they are clipped (marked) instead.
      if (i.type !== 'ceo-request' || room < 60) break;
      line = `${line.slice(0, room - 1)}…`;
    }
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < ordered.length) lines.push(`… ${ordered.length - shown} more (eln bus since ${since ?? '-'})`);
  lines.push('</op_context_bus>');
  return lines.join('\n');
}

/**
 * The capture hook a CEO surface calls with the CEO's own words (Telegram · TUI · web chat). Pure shape only — the
 * caller decides the state root; posting the same words from another surface folds into the first item.
 */
export function captureCeoLine(surface: string, text: string): BusPostInput | null {
  const body = text.trim();
  if (!body) return null;
  return { type: 'ceo-request', from: 'CEO', body, source: surface.trim().toLowerCase() || 'unknown' };
}

/**
 * Event-driven reader: call `onItems` with the new items each time the space file changes (fs.watch on the directory,
 * so the file may be created or rotated by the rollup's rename). Returns a stop function. No polling loop.
 */
export function watchBus(stateRoot: string, onItems: (items: BusItem[]) => void, opts: { space?: string; fromId?: string | null } = {}): () => void {
  const { watch } = require('node:fs') as typeof import('node:fs');
  const space = opts.space ?? BUS_DEFAULT_SPACE;
  const dir = busDir(stateRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${safeSpace(space)}.jsonl`;
  let cursor: string | null = opts.fromId === undefined ? (readBus(stateRoot, space).at(-1)?.id ?? null) : opts.fromId;
  const flush = () => {
    const fresh = busSince(readBus(stateRoot, space), cursor);
    if (fresh.length) { cursor = fresh.at(-1)!.id; onItems(fresh); }
  };
  const watcher = watch(dir, (_event, file) => { if (!file || String(file) === name) flush(); });
  // An append between the cursor read and the watch registration is caught here (once, not a poll).
  flush();
  return () => watcher.close();
}

function log(event: string, data: Record<string, unknown>): void {
  try { (require('../debug/log.js') as typeof import('../debug/log.js')).debug.log('bus', event, data); } catch { /* fail-open */ }
}
