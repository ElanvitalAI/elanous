import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { hostLedgerPath } from './store.js';
import type { HostChannel } from './types.js';

/** Wire + queue share this shape; `at` is the ISO measurement time and survives queue retries unchanged. */
export interface HostHeartbeatEntry {
  host: string;
  installedSha: string;
  seat?: string;
  channel?: HostChannel;
  at: string;
}

export interface QueueDrainResult { sent: number; kept: number }

export type CentralHeartbeatOutcome =
  | { outcome: 'unconfigured' }
  | { outcome: 'sent'; host: string; state: string; drained: QueueDrainResult }
  | { outcome: 'queued'; reason: string; queued: number; drained: QueueDrainResult };

export class HeartbeatSendError extends Error {
  constructor(public readonly reason: string) {
    super(`host heartbeat central send failed: ${reason}`);
  }
}

/** The offline queue lives next to the local host ledger. */
export function heartbeatQueuePath(ledgerPath: string = hostLedgerPath()): string {
  return join(dirname(ledgerPath), 'host-heartbeat-queue.jsonl');
}

export function enqueueHostHeartbeat(entry: HostHeartbeatEntry, path: string = heartbeatQueuePath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(entry) + '\n', { flag: 'a' });
}

/** Malformed lines are dropped, never fatal: the queue is a best-effort retry log. */
export function readHostHeartbeatQueue(path: string = heartbeatQueuePath()): HostHeartbeatEntry[] {
  if (!existsSync(path)) return [];
  const entries: HostHeartbeatEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as HostHeartbeatEntry);
    } catch { /* malformed line: dropped */ }
  }
  return entries;
}

function rewriteQueueAtomic(entries: HostHeartbeatEntry[], path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(tmp, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

/** Retry every queued entry: successes are removed, failures stay queued in order. */
export async function drainHostHeartbeatQueue(
  send: (entry: HostHeartbeatEntry) => Promise<unknown>,
  path: string = heartbeatQueuePath(),
): Promise<QueueDrainResult> {
  const entries = readHostHeartbeatQueue(path);
  const kept: HostHeartbeatEntry[] = [];
  for (const entry of entries) {
    try { await send(entry); } catch { kept.push(entry); }
  }
  if (entries.length) rewriteQueueAtomic(kept, path);
  return { sent: entries.length - kept.length, kept: kept.length };
}

export interface CentralSendOptions {
  baseUrl?: string;
  bearerToken?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  queuePath?: string;
}

/** POST one heartbeat to the central Nexus hosts endpoint. Throws HeartbeatSendError with a stable reason. */
export async function postHostHeartbeat(
  baseUrl: string,
  entry: HostHeartbeatEntry,
  options: { bearerToken: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<{ ok: true; host: string; state: string }> {
  if (!options.bearerToken) throw new HeartbeatSendError('machine-token-missing');
  let endpoint: URL;
  try {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
      throw new Error();
    endpoint = new URL('/v1/hosts/heartbeat', base);
  } catch { throw new HeartbeatSendError('invalid-nexus-url'); }
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + options.bearerToken, 'content-type': 'application/json' },
      body: JSON.stringify({ heartbeat: { ...entry } }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
  } catch { throw new HeartbeatSendError('endpoint-unavailable'); }
  if (response.status !== 201 && response.status !== 200) {
    let reason = `http-${response.status}`;
    if (response.status === 401 || response.status === 403) {
      try {
        const body = await response.json() as { error?: string };
        if (typeof body?.error === 'string' && body.error) reason = body.error;
      } catch { /* keep http-N */ }
    }
    throw new HeartbeatSendError(reason);
  }
  let body: { ok?: unknown; host?: unknown; state?: unknown };
  try { body = await response.json() as typeof body; } catch { throw new HeartbeatSendError('invalid-response-body'); }
  if (body?.ok !== true || body.host !== entry.host) throw new HeartbeatSendError('invalid-response-body');
  return { ok: true, host: body.host as string, state: typeof body.state === 'string' ? body.state : '' };
}

/**
 * One heartbeat run over the wire: pending queue entries are drained first, then the fresh entry is sent.
 * A send failure queues the fresh entry locally for the next run. Unconfigured (URL/token missing) is a no-op.
 */
export async function sendHostHeartbeatCentral(
  entry: HostHeartbeatEntry,
  options: CentralSendOptions,
): Promise<CentralHeartbeatOutcome> {
  const baseUrl = options.baseUrl?.trim();
  const bearerToken = options.bearerToken?.trim();
  if (!baseUrl || !bearerToken) return { outcome: 'unconfigured' };
  const queuePath = options.queuePath ?? heartbeatQueuePath();
  const post = (candidate: HostHeartbeatEntry) =>
    postHostHeartbeat(baseUrl, candidate, { bearerToken, fetch: options.fetch, timeoutMs: options.timeoutMs });
  const drained = await drainHostHeartbeatQueue(post, queuePath);
  try {
    const result = await post(entry);
    return { outcome: 'sent', host: result.host, state: result.state, drained };
  } catch (e) {
    enqueueHostHeartbeat(entry, queuePath);
    return {
      outcome: 'queued',
      reason: e instanceof HeartbeatSendError ? e.reason : 'send-failed',
      queued: drained.kept + 1,
      drained,
    };
  }
}