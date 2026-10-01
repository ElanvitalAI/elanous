import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { debug } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { submitIntakeWork } from '../../intake-plane/submit-intake-work.js';
import { parseSeatAddress, resolveSeat } from '../../seat-address/seat-address.js';
import trackData from '../../../scripts/coord-tracks.json';
import { jsonResponse } from './json-response.js';

export const SEAT_REQUESTS_PATH = '/v1/seat-requests';

interface SeatRequestItem {
  receiptId: string;
  seat: string;
  text: string;
  queuedAt: string;
  status: 'queued';
}

interface PendingRequest {
  status: 'pending';
  key: string;
  seat: string;
  text: string;
  queuedAt: string;
  ref: string;
}

interface RejectedRequest extends Omit<PendingRequest, 'status'> {
  status: 'rejected';
}

type RecordEntry = (SeatRequestItem & { key: string }) | PendingRequest | RejectedRequest;

export interface SeatRequestsDeps {
  root?: () => string;
  submit?: typeof submitIntakeWork;
  now?: () => string;
  append?: (path: string, entry: RecordEntry) => void;
}

const seats = trackData.tracks.filter((entry): entry is typeof entry & { title: string } => 'title' in entry)
  .map(({ id, title }) => ({ id, title }));
const inFlight = new Map<string, { payload: string; task: Promise<Response> }>();

function unknownSeat(): Response {
  debug.log('seat-address.pwa', 'rejected', { reason: 'unknown-seat' });
  return jsonResponse({ error: 'unknown-seat', seats }, 400);
}

function file(root: string): string {
  return join(root, 'seat-requests', 'requests.jsonl');
}

function append(path: string, entry: RecordEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  // Atomically replace the journal so a failed write cannot leave a truncated JSON line.
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${previous}${JSON.stringify(entry)}\n`);
    const fd = openSync(temp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* no temp file to remove */ }
    throw error;
  }
}

function records(path: string): Map<string, RecordEntry> {
  let data: string;
  try { data = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(path)) data = '';
    else throw error;
  }
  const entries = new Map<string, RecordEntry>();
  for (const line of data.split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line) as RecordEntry;
    if (typeof entry.key !== 'string' || typeof entry.seat !== 'string' || typeof entry.text !== 'string'
      || typeof entry.queuedAt !== 'string' || !['pending', 'queued', 'rejected'].includes(entry.status)
      || (entry.status === 'queued' && typeof entry.receiptId !== 'string')
      || (entry.status !== 'queued' && typeof entry.ref !== 'string')) {
      throw new Error('invalid seat request journal');
    }
    entries.set(entry.key, entry);
  }
  const dir = join(dirname(path), 'outcomes');
  let names: string[];
  try { names = readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return entries;
    throw error;
  }
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const item = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RecordEntry;
    if (item.key !== name.slice(0, -5) || (item.status !== 'queued' && item.status !== 'rejected')) {
      throw new Error('invalid seat request outcome');
    }
    const current = entries.get(item.key);
    if (current?.status === 'queued') continue;
    if (current?.status === 'pending') {
      if (item.status === 'rejected' && current.ref !== item.ref) continue;
      if (item.status === 'queued' && current.queuedAt !== item.queuedAt) continue;
    }
    entries.set(item.key, item);
  }
  return entries;
}

function outcomeFile(path: string, key: string): string {
  return join(dirname(path), 'outcomes', `${key}.json`);
}

function persistOutcome(path: string, entry: RecordEntry, write: typeof append): void {
  try {
    write(path, entry);
    const sidecar = outcomeFile(path, entry.key);
    if (existsSync(sidecar)) unlinkSync(sidecar);
  } catch {
    // The primary journal may be unavailable while the outcome is already committed
    // to the intake queue. Keep a durable sidecar rather than a process-local receipt.
    const target = outcomeFile(path, entry.key);
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(entry));
      const fd = openSync(temp, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, target);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* no temp file */ }
      throw error;
    }
  }
}

function receipt(item: SeatRequestItem): Response {
  return jsonResponse({ receiptId: item.receiptId, seat: item.seat, queuedAt: item.queuedAt }, 202);
}

function unavailable(): Response {
  debug.log('seat-address.pwa', 'rejected', { reason: 'journal-unavailable' });
  return jsonResponse({ error: 'enqueue-failed' }, 503);
}

export async function handleSeatRequests(req: Request, deps: SeatRequestsDeps = {}): Promise<Response> {
  const path = file((deps.root ?? effectiveInstanceRoot)());
  if (req.method === 'GET') {
    const params = new URL(req.url).searchParams;
    const requestedSeat = params.get('seat');
    const seat = requestedSeat ? resolveSeat(requestedSeat) : undefined;
    if (requestedSeat && !seat) return unknownSeat();
    const rawLimit = params.get('limit');
    const limit = rawLimit === null ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return jsonResponse({ error: 'bad_request' }, 400);
    try {
      const items = [...records(path).values()].filter((entry): entry is RecordEntry & SeatRequestItem => entry.status === 'queued')
        .reverse().filter((item) => !seat || item.seat === seat.id).slice(0, limit)
        .map(({ receiptId, seat: id, text, queuedAt, status }) => ({ receiptId, seat: id, text, queuedAt, status }));
      return jsonResponse({ items, seats });
    } catch { return unavailable(); }
  }
  if (req.method !== 'POST') return jsonResponse({ error: 'method-not-allowed' }, 405);

  let body: unknown;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'bad_request' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'bad_request' }, 400);
  const input = body as Record<string, unknown>;
  if (typeof input.text !== 'string' || !input.text.trim()
    || (input.seat !== undefined && typeof input.seat !== 'string')) {
    debug.log('seat-address.pwa', 'rejected', { reason: 'invalid-body' });
    return jsonResponse({ error: 'bad_request' }, 400);
  }
  // An implicit address must start the text; parseSeatAddress also accepts later lines.
  const parsed = input.text.startsWith('@') ? parseSeatAddress(input.text) : null;
  const prefix = parsed ? `@${parsed.seats.join(',')}` : '';
  const firstAddress = parsed && input.text.startsWith(prefix)
    && (input.text.length === prefix.length || /[ \t\r\n]/.test(input.text[prefix.length]!)) ? parsed : null;
  const address = input.seat ?? (firstAddress?.seats.length === 1 ? firstAddress.seats[0] : undefined);
  const seat = address ? resolveSeat(address) : undefined;
  if (!seat) return unknownSeat();
  const text = input.seat === undefined ? firstAddress!.body.trim() : input.text.trim();
  if (!text) {
    debug.log('seat-address.pwa', 'rejected', { reason: 'empty-text', seat: seat.id });
    return jsonResponse({ error: 'bad_request' }, 400);
  }
  debug.log('seat-address.pwa', 'parsed', { seat: seat.id, textLength: text.length });
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const header = req.headers.get('idempotency-key');
  if (header !== null && (!header.trim() || header.length > 200)) return jsonResponse({ error: 'bad_request' }, 400);
  const payload = `${seat.id}\0${text}`;
  const key = header === null ? createHash('sha256').update(randomUUID()).digest('hex')
    : createHash('sha256').update(`client\0${header}`).digest('hex');
  const lock = `${path}\0${key}`;
  const pending = inFlight.get(lock);
  if (pending) {
    if (pending.payload !== payload) return jsonResponse({ error: 'idempotency-conflict' }, 409);
    return pending.task.then((response) => response.clone());
  }
  // Install the lock before starting disk or queue work; a second caller must
  // wait for the first instead of independently submitting the same key.
  let start!: () => void;
  const gate = new Promise<void>((resolve) => { start = resolve; });
  const task = (async (): Promise<Response> => {
    await gate;
    let existing: RecordEntry | undefined;
    try { existing = records(path).get(key); }
    catch { return unavailable(); }
    if (existing) {
      if (existing.seat !== seat.id || existing.text !== text) return jsonResponse({ error: 'idempotency-conflict' }, 409);
      if (existing.status === 'queued') return receipt(existing);
    }
    const intent: PendingRequest = existing?.status === 'pending'
      ? existing : { key, seat: seat.id, text, queuedAt: now, status: 'pending', ref: `pwa:${randomUUID()}` };
    if (existing?.status !== 'pending') {
      try {
        (deps.append ?? append)(path, intent);
        if (existing?.status === 'rejected') {
          const sidecar = outcomeFile(path, key);
          if (existsSync(sidecar)) unlinkSync(sidecar);
        }
      } catch { return unavailable(); }
    }
    let result: Awaited<ReturnType<typeof submitIntakeWork>>;
    try {
      result = await (deps.submit ?? submitIntakeWork)({
        text: `@${seat.title ?? seat.id} ${text}`,
        track: 'graph',
        origin: { kind: 'external', ledgerSource: 'pwa', provider: 'other', ref: intent.ref, reportTo: { channel: 'pwa' } },
      });
    } catch { return unavailable(); }
    if (!result.ok || result.track !== 'graph') {
      debug.log('seat-address.pwa', 'rejected', { reason: result.ok ? 'unexpected-track' : result.reason, seat: seat.id });
      try { persistOutcome(path, { ...intent, status: 'rejected' }, deps.append ?? append); }
      catch { return unavailable(); }
      return unavailable();
    }
    const item: RecordEntry & SeatRequestItem = { key, receiptId: result.acceptanceId, seat: seat.id, text, queuedAt: intent.queuedAt, status: 'queued' };
    try { persistOutcome(path, item, deps.append ?? append); }
    catch { return unavailable(); }
    debug.log('seat-address.pwa', 'enqueued', { seat: seat.id, receiptId: item.receiptId });
    return receipt(item);
  })();
  inFlight.set(lock, { payload, task });
  start();
  try { return await task; }
  finally { inFlight.delete(lock); }
}
