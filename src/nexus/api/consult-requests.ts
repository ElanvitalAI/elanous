import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { debug } from '../../debug/log.js';
import { routeOutbound } from '../outbound/router.js';
import { getUserConfig } from '../../user-config.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { jsonResponse } from './json-response.js';

export const CONSULT_REQUESTS_PATH = '/v1/consult-requests';

interface ConsultRequest {
  receiptId: string;
  name: string;
  org: string | null;
  kind: 'company' | 'personal';
  interest: 'A' | 'B';
  contact: string;
  consent: true;
  receivedAt: string;
}

export interface ConsultRequestsDeps {
  root?: () => string;
  now?: () => string;
  /** Owner alert. Default = the daemon's own in-process router (the same one `/v1/outbound` uses).
   *  ⛔ Never `sendOutbound` here: it is a synchronous curl to this very daemon's `/v1/outbound`, so inside the
   *  daemon it blocks the event loop until it times out (~25 s · `unreachable`) and the alert is lost (CS1 · 10-01). */
  send?: (text: string, kind: string) => unknown;
}

function file(root: string): string {
  return join(root, 'consult-requests', 'requests.jsonl');
}

function append(path: string, entry: ConsultRequest): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${previous}${JSON.stringify(entry)}\n`, { mode: 0o600 });
    const fd = openSync(temp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* no temp file to remove */ }
    throw error;
  }
}

function records(path: string): ConsultRequest[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as ConsultRequest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function rejected(field: string): Response {
  debug.log('consult.request', 'rejected', { field });
  return jsonResponse({ error: 'bad_request', field }, 400);
}

function singleLine(value: string): string {
  return value.trim().replace(/[\r\n\u2028\u2029]+/g, ' ');
}

export async function handleConsultRequests(req: Request, deps: ConsultRequestsDeps = {}): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'POST') return jsonResponse({ error: 'method-not-allowed' }, 405);
  const path = file((deps.root ?? effectiveInstanceRoot)());
  if (req.method === 'GET') {
    const rawLimit = new URL(req.url).searchParams.get('limit');
    const limit = rawLimit === null ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return rejected('limit');
    try {
      const items = records(path).reverse().slice(0, limit).map(({ receiptId, name, org, kind, interest, receivedAt }) =>
        ({ receiptId, name, org, kind, interest, receivedAt }));
      return jsonResponse({ items });
    } catch {
      return jsonResponse({ error: 'journal-unavailable' }, 503);
    }
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return rejected('body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return rejected('body');
  const input = body as Record<string, unknown>;
  for (const field of ['name', 'contact'] as const) {
    if (typeof input[field] !== 'string' || !input[field].trim()) return rejected(field);
  }
  if (input.org !== undefined && (typeof input.org !== 'string' || !input.org.trim())) return rejected('org');
  if (input.kind !== 'company' && input.kind !== 'personal') return rejected('kind');
  if (input.interest !== 'A' && input.interest !== 'B') return rejected('interest');
  if (input.consent !== true) return rejected('consent');

  const entry: ConsultRequest = {
    receiptId: `R-${randomUUID()}`,
    name: singleLine(input.name as string),
    org: typeof input.org === 'string' ? singleLine(input.org) : null,
    kind: input.kind,
    interest: input.interest,
    contact: (input.contact as string).trim(),
    consent: true,
    receivedAt: (deps.now ?? (() => new Date().toISOString()))(),
  };
  try { append(path, entry); }
  catch {
    debug.log('consult.request', 'rejected', { field: 'journal' });
    return jsonResponse({ error: 'journal-unavailable' }, 503);
  }
  debug.log('consult.request', 'accepted', { receiptId: entry.receiptId });
  const alert = `📮 상담 문의 ${entry.receiptId} · ${entry.name}(${entry.kind === 'personal' ? '개인' : (entry.org ?? '회사')}) · 관심 ${entry.interest}\n앱에서 보기`;
  // Fire and forget — the receipt is already on disk; the answer must not wait for the channel.
  void Promise.resolve()
    .then(() => (deps.send ?? notifyInProcess)(alert, 'alert'))
    .catch((error: unknown) => { debug.log('consult.request', 'notify-failed', { receiptId: entry.receiptId, reason: error instanceof Error ? error.message : String(error) }); });
  return jsonResponse({ receiptId: entry.receiptId, receivedAt: entry.receivedAt }, 202);
}

async function notifyInProcess(text: string, kind: string): Promise<void> {
  const result = await routeOutbound(getUserConfig(), { text, markdown: false, kind });
  debug.log('consult.request', result.delivered ? 'notified' : 'notify-failed', {
    delivered: result.delivered,
    channels: result.channels.map((channel) => `${channel.type}:${channel.ok ? 'ok' : 'fail'}`),
  });
}
