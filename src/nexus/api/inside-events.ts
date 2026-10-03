import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { debug } from '../../debug/log.js';
import { nexusRootDir } from '../paths.js';
import { SSE_HEARTBEAT_MS } from './sse-heartbeat.js';

/** The node envelope matches apps/pwa/src/lib/inside-events.ts without importing browser code. */
export interface InsideNodeEvent {
  kind: 'node';
  graphId: string;
  runId: string;
  nodeId: string;
  phase: 'start' | 'ok' | 'fail';
  ts: string;
  seconds?: number;
}

/** Other producers can add their own domain fields without changing the transport. */
export type InsideLiveEvent = InsideNodeEvent | ({ kind: string; ts: string } & Record<string, unknown>);
export type InsideEventInput = { kind: string; ts?: string } & Record<string, unknown>;

export const INSIDE_EVENTS_PATH = '/v1/inside/events';
const MAX_PENDING_FRAMES = 16;
const MAX_FRAME_BYTES = 64 * 1024;
const MASK = '[REDACTED]';
const SECRET_KEY = /(?:secret|password|passwd|token|api[_-]?key|authorization|credential|private[_-]?key|cookie|session[_-]?key)/i;
const INLINE_SECRET = /\b((?:Bearer|Basic)\s+|(?:sk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[baprs])[-_])[^\s"'`,;]+/gi;
const ASSIGNMENT_SECRET = /\b((?:api[_-]?key|(?:access[_-]?)?token|secret|password|authorization)\s*[:=]\s*)(?:(["'])[^\r\n]*?\2|[^\s"'`,;]+)/gi;

function maskString(value: string): string {
  return value.replace(INLINE_SECRET, `$1${MASK}`)
    .replace(ASSIGNMENT_SECRET, (_match, prefix: string, quote?: string) => `${prefix}${quote ?? ''}${MASK}${quote ?? ''}`);
}

/** Sanitize before fan-out; never put an unmasked payload in the subscriber queue. */
export function maskInsideEventValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return maskString(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return MASK;
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => maskInsideEventValue(item, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SECRET_KEY.test(key) ? MASK : maskInsideEventValue(item, seen);
  }
  seen.delete(value);
  return result;
}

type Listener = (event: InsideLiveEvent) => void;
const listeners = new Set<Listener>();
const RELAY_INTERVAL_MS = 20;
const RELAY_MAX_RECORD_BYTES = 64 * 1024;
const RELAY_ROTATE_BYTES = 4 * 1024 * 1024;
const RELAY_RETIRE_GRACE_MS = 2000;
const relayIdentity = randomUUID();

function relayPaths() {
  const root = nexusRootDir();
  return { root, pointer: join(root, 'inside-events-relay.json') };
}

function dispatch(event: InsideLiveEvent): void {
  for (const listener of listeners) {
    try { listener(event); } catch { /* a disconnected observer must not stop a run */ }
  }
}

/** Each daemon owns its journal; child processes append masked records to that journal.
 *  The journal rotates once fully consumed past RELAY_ROTATE_BYTES: the pointer moves to a fresh file and the old one is
 *  drained for a grace period (producers that read the old pointer may still append) before it is removed. */
export function startInsideEventRelay(opts: { rotateBytes?: number; retireGraceMs?: number } = {}): () => void {
  const { root, pointer } = relayPaths();
  mkdirSync(root, { recursive: true });
  const rotateBytes = opts.rotateBytes ?? RELAY_ROTATE_BYTES;
  const retireGraceMs = opts.retireGraceMs ?? RELAY_RETIRE_GRACE_MS;
  type Journal = { file: string; offset: number; pending: string; decoder: StringDecoder; retireAt?: number };
  const journals: Journal[] = [];
  let descriptor = '';
  const open = (): Journal => {
    const id = randomUUID();
    const file = join(root, `inside-events-${id}.jsonl`);
    writeFileSync(file, '', { mode: 0o600, flag: 'wx' });
    descriptor = JSON.stringify({ pid: process.pid, id });
    writeFileSync(pointer, descriptor, { mode: 0o600 });
    const journal: Journal = { file, offset: 0, pending: '', decoder: new StringDecoder('utf8') };
    journals.push(journal);
    return journal;
  };
  let current = open();
  const drain = (journal: Journal): void => {
    const size = statSync(journal.file).size;
    if (size < journal.offset) { journal.offset = 0; journal.pending = ''; journal.decoder = new StringDecoder('utf8'); }
    while (size > journal.offset) {
      const count = Math.min(size - journal.offset, 1024 * 1024);
      const chunk = Buffer.alloc(count);
      const fd = openSync(journal.file, 'r');
      let length: number;
      try { length = readSync(fd, chunk, 0, count, journal.offset); }
      finally { closeSync(fd); }
      if (length <= 0) break;
      journal.offset += length;
      // A chunk boundary may split a multi-byte character; the decoder carries the partial bytes into the next read.
      journal.pending += journal.decoder.write(chunk.subarray(0, length));
      const lines = journal.pending.split('\n');
      journal.pending = lines.pop() ?? '';
      if (journal.pending.length > RELAY_MAX_RECORD_BYTES) journal.pending = '';
      for (const line of lines) {
        if (line.length > RELAY_MAX_RECORD_BYTES) continue;
        try {
          const record = JSON.parse(line) as { origin?: string; event?: InsideEventInput };
          if (record.origin === relayIdentity || !record.event || typeof record.event.kind !== 'string'
            || !/^[a-z][a-z0-9._-]*$/i.test(record.event.kind)) continue;
          dispatch(maskInsideEventValue(record.event) as InsideLiveEvent);
        } catch { /* malformed producer record */ }
      }
    }
  };
  const remove = (journal: Journal): void => {
    try { unlinkSync(journal.file); } catch { /* already removed */ }
    journals.splice(journals.indexOf(journal), 1);
  };
  const timer = setInterval(() => {
    for (const journal of [...journals]) {
      try { drain(journal); } catch { /* journal disappeared during shutdown */ }
      if (journal.retireAt !== undefined && Date.now() >= journal.retireAt && journal.pending === '') remove(journal);
    }
    if (current.offset >= rotateBytes && current.pending === '') {
      try {
        current.retireAt = Date.now() + retireGraceMs;
        current = open();
        debug.log('inside.events', 'relay-rotated', { journals: journals.length });
      } catch { /* keep appending to the current journal */ }
    }
  }, RELAY_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    try { if (readFileSync(pointer, 'utf8') === descriptor) unlinkSync(pointer); } catch { /* another daemon owns it */ }
    for (const journal of [...journals]) remove(journal);
  };
}

/** Ordered local delivery plus best-effort cross-process delivery to the current daemon. */
export function publishInsideEvent(event: InsideEventInput): void {
  if (!event || typeof event.kind !== 'string' || !/^[a-z][a-z0-9._-]*$/i.test(event.kind)) return;
  const safe = maskInsideEventValue({ ...event, ts: event.ts ?? new Date().toISOString() }) as InsideLiveEvent;
  dispatch(safe);
  try {
    const { root, pointer } = relayPaths();
    if (!existsSync(pointer)) return;
    const descriptor = JSON.parse(readFileSync(pointer, 'utf8')) as { pid?: number; id?: string };
    if (!Number.isSafeInteger(descriptor.pid) || typeof descriptor.id !== 'string' || !/^[a-f0-9-]{36}$/.test(descriptor.id)) return;
    process.kill(descriptor.pid!, 0);
    const file = join(root, `inside-events-${descriptor.id}.jsonl`);
    const line = JSON.stringify({ origin: relayIdentity, event: safe }) + '\n';
    if (Buffer.byteLength(line) > RELAY_MAX_RECORD_BYTES) return;
    appendFileSync(file, line, { mode: 0o600, flag: 'a' });
  } catch { /* a missing daemon must not interrupt the producer */ }
}

export function subscribeInsideEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** No history/replay: the stream starts at the moment a client subscribes. */
export function handleInsideEvents(req: Request): Response {
  if (req.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } });
  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const onAbort = () => close();
      cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        unsubscribe();
        req.signal.removeEventListener('abort', onAbort);
      };
      const close = () => {
        cleanup?.();
        try { controller.close(); } catch { /* cancelled already */ }
      };
      const send = (text: string): void => {
        if (closed) return;
        const bytes = encoder.encode(text);
        if (bytes.byteLength > MAX_FRAME_BYTES || (controller.desiredSize ?? 0) <= 0) {
          close();
          return;
        }
        try { controller.enqueue(bytes); } catch { close(); }
      };
      if (req.signal.aborted) {
        close();
        return;
      }
      unsubscribe = subscribeInsideEvent((event) => {
        send(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      heartbeat = setInterval(() => send(': ping\n\n'), SSE_HEARTBEAT_MS);
      req.signal.addEventListener('abort', onAbort, { once: true });
      if (req.signal.aborted) close();
      else send(': inside events stream\n\n');
    },
    cancel() { cleanup?.(); },
  }, { highWaterMark: MAX_PENDING_FRAMES, size: () => 1 });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}
