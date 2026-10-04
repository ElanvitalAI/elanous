import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CONSULT_MAX_BYTES = 8 * 1024;
export const CONSULT_QUEUE_MAX_AGE_MS = 7 * 24 * 3600_000;

export interface ConsultInput {
  name: string;
  org?: string;
  kind: 'company' | 'personal';
  interest: 'A' | 'B';
  contact: string;
  consent: true;
}

export interface QueuedConsult { id: string; receivedAt: string; consult: ConsultInput }

const singleLine = (value: string): string => value.trim().replace(/[\r\n\u2028\u2029]+/g, ' ');

/** The Primary accepts optional org and requires nonblank name/contact, kind, interest and explicit consent. */
export function validateConsult(body: unknown): { ok: true; consult: ConsultInput } | { ok: false; field: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, field: 'body' };
  const b = body as Record<string, unknown>;
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 256) return { ok: false, field: 'name' };
  if (b.org !== undefined && (typeof b.org !== 'string' || !b.org.trim() || b.org.length > 256)) return { ok: false, field: 'org' };
  if (b.kind !== 'company' && b.kind !== 'personal') return { ok: false, field: 'kind' };
  if (b.interest !== 'A' && b.interest !== 'B') return { ok: false, field: 'interest' };
  if (typeof b.contact !== 'string' || !b.contact.trim() || b.contact.length > 512) return { ok: false, field: 'contact' };
  if (b.consent !== true) return { ok: false, field: 'consent' };
  return { ok: true, consult: { name: singleLine(b.name), ...(typeof b.org === 'string' ? { org: singleLine(b.org) } : {}),
    kind: b.kind, interest: b.interest, contact: b.contact.trim(), consent: true } };
}

/** Sliding windows; neither rejected hits nor invalid submissions consume quota. */
export class ConsultLimiter {
  private readonly ips = new Map<string, number[]>();
  private daily: number[] = [];
  constructor(private readonly now: () => number = Date.now) {}

  admit(ip: string): number | null {
    const t = this.now();
    const hits = (this.ips.get(ip) ?? []).filter(x => t - x < 600_000);
    this.daily = this.daily.filter(x => t - x < 86_400_000);
    const wait = hits.length >= 3 ? 600_000 - (t - hits[0]!) :
      this.daily.length >= 200 ? 86_400_000 - (t - this.daily[0]!) : null;
    if (wait !== null) { this.ips.set(ip, hits); return Math.max(1, Math.ceil(wait / 1000)); }
    hits.push(t);
    this.ips.set(ip, hits);
    this.daily.push(t);
    return null;
  }
}

/** Atomic JSONL rewrite on every mutation, with a private file and directory. */
export class ConsultQueue {
  readonly path: string;
  constructor(root: string, private readonly log: (event: string, data: Record<string, unknown>) => void = () => {}) {
    this.path = join(root, 'hooks', 'consult-queue.jsonl');
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
  }

  private read(): QueuedConsult[] {
    try { return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as QueuedConsult); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }

  private write(items: QueuedConsult[]): void {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try { writeSync(fd, items.map(item => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '')); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temp, this.path);
    } finally { rmSync(temp, { force: true }); }
  }

  enqueue(item: QueuedConsult): void { this.write([...this.read(), item]); }
  entries(now: number = Date.now()): QueuedConsult[] {
    const items = this.read();
    const kept = items.filter(item => Number.isFinite(Date.parse(item.receivedAt)) && now - Date.parse(item.receivedAt) <= CONSULT_QUEUE_MAX_AGE_MS);
    if (kept.length !== items.length) { this.write(kept); this.log('dropped', { expired: items.length - kept.length }); }
    return kept;
  }
  count(): number { return existsSync(this.path) ? this.read().length : 0; }
  delivered(id: string): void { this.write(this.read().filter(item => item.id !== id)); }
}

/** Accept only a validated body; responses and logs never contain user-provided values. */
export async function handleConsultPost(request: Request, deps: {
  limiter: ConsultLimiter; queue: ConsultQueue; now?: () => number; ip?: string;
  log?: (event: string, data: Record<string, unknown>) => void; wake?: () => void;
}): Promise<Response> {
  const log = deps.log ?? (() => {});
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > CONSULT_MAX_BYTES) { log('rejected', { reason: 'too-large' }); return Response.json({ error: 'too-large' }, { status: 413 }); }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > CONSULT_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          log('rejected', { reason: 'too-large' });
          return Response.json({ error: 'too-large' }, { status: 413 });
        }
        chunks.push(value);
      }
    }
  } catch {
    log('rejected', { reason: 'body' });
    return Response.json({ error: 'invalid', field: 'body' }, { status: 400 });
  } finally { reader?.releaseLock(); }
  let body: unknown;
  try {
    const raw = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder().decode(raw));
  }
  catch { log('rejected', { reason: 'body' }); return Response.json({ error: 'invalid', field: 'body' }, { status: 400 }); }
  const checked = validateConsult(body);
  if (!checked.ok) { log('rejected', { reason: checked.field }); return Response.json({ error: 'invalid', field: checked.field }, { status: 400 }); }
  const ip = deps.ip ?? 'unknown';
  const wait = deps.limiter.admit(ip);
  if (wait !== null) {
    log('rejected', { reason: 'rate-limited' });
    return Response.json({ error: 'rate-limited', retryAfterSec: wait }, { status: 429, headers: { 'Retry-After': String(wait) } });
  }
  const id = randomUUID();
  try { deps.queue.enqueue({ id, receivedAt: new Date((deps.now ?? Date.now)()).toISOString(), consult: checked.consult }); }
  catch { log('rejected', { reason: 'queue-unavailable' }); return Response.json({ error: 'queue-unavailable' }, { status: 503 }); }
  log('received', { queued: true, kind: checked.consult.kind, interest: checked.consult.interest,
    nameLength: checked.consult.name.length, contactLength: checked.consult.contact.length, orgLength: checked.consult.org?.length ?? 0 });
  deps.wake?.();
  return Response.json({ id }, { status: 202 });
}

/** Forward in arrival order; a failure leaves that item and all following items queued. */
export async function drainConsults(queue: ConsultQueue, forward: (item: QueuedConsult) => Promise<boolean>, now: number = Date.now()): Promise<{ delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;
  for (const item of queue.entries(now)) {
    let ok = false;
    try { ok = await forward(item); } catch { ok = false; }
    if (ok) { queue.delivered(item.id); delivered++; } else { failed++; break; }
  }
  return { delivered, failed };
}
