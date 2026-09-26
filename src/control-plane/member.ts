import { readFileSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';

const DEFAULT_INTERVAL_MS = 30_000;
const MAX_RETRY_MS = 300_000;
// Ordinary ticks start within the 10-minute TTL; first failure retries within 30 seconds.
const MAX_INTERVAL_MS = MAX_RETRY_MS;
const REQUEST_TIMEOUT_MS = 5_000;

export function measureLoad(now: () => number = Date.now): {
  loadAvg: number[]; cpuCount: number; freeMem: number; totalMem: number; observedAt: number;
} {
  return {
    loadAvg: loadavg(), cpuCount: cpus().length,
    freeMem: freemem(), totalMem: totalmem(), observedAt: now(),
  };
}

/** Read only the member credential. A missing or malformed file never creates credentials. */
export function readMemberToken(root: string = effectiveInstanceRoot()): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, 'control', 'tokens.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const token = (parsed as Record<string, unknown>).member;
    return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export interface MemberResource {
  id: string;
  name: string;
  attrs?: Record<string, unknown>;
}

export interface MemberHeartbeatOptions {
  coordinatorUrl: string;
  token: string;
  machine: MemberResource;
  instance: MemberResource & { endpoint: string };
  intervalMs?: number;
  fetch?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

/** Best-effort registration; no network work is awaited by the caller. */
export function startMemberHeartbeat(opts: MemberHeartbeatOptions): () => void {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(interval) || interval <= 0 || interval > MAX_INTERVAL_MS) throw new Error('invalid member heartbeat interval');
  const base = new URL(opts.coordinatorUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('invalid coordinator URL');
  if (!opts.token || !opts.machine.id || !opts.instance.id || !opts.instance.endpoint) throw new Error('missing member configuration');
  const send = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let registered = false;
  let heartbeatsSinceInstanceRefresh = 0;
  let failures = 0;
  let lastFailure: string | undefined;
  const machineId = opts.machine.id;

  const post = async (path: string, body: unknown): Promise<void> => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([controller.signal, timeout]);
    let response: Response;
    try {
      response = await send(new URL(path, base), {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      throw new Error('network-or-timeout');
    }
    if (!response.ok) {
      if (response.status === 404 && path.endsWith('/heartbeat')) registered = false;
      throw new Error(`http-${response.status}`);
    }
  };
  const register = async (): Promise<void> => {
    await post('/v1/resources/register', {
      ...opts.machine, kind: 'machine', machine: machineId, owner: '',
      attrs: { ...opts.machine.attrs, load: measureLoad(now) }, observedAt: now(), ttlMs: MAX_RETRY_MS * 2,
    });
    await post('/v1/resources/register', {
      ...opts.instance, kind: 'instance', machine: machineId, owner: '',
      attrs: opts.instance.attrs ?? {}, observedAt: now(), ttlMs: MAX_RETRY_MS * 2,
    });
    registered = true;
    heartbeatsSinceInstanceRefresh = 0;
  };
  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, ms);
    timer.unref?.();
  };
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (!registered) await register();
      else {
        await post(`/v1/resources/${encodeURIComponent(machineId)}/heartbeat`, { attrs: { load: measureLoad(now) } });
        heartbeatsSinceInstanceRefresh++;
        if (heartbeatsSinceInstanceRefresh * interval >= MAX_RETRY_MS) {
          await post(`/v1/resources/${encodeURIComponent(opts.instance.id)}/heartbeat`, {});
          heartbeatsSinceInstanceRefresh = 0;
        }
      }
      if (stopped) return;
      failures = 0;
      schedule(interval);
    } catch (error) {
      if (stopped) return;
      const reason = error instanceof Error ? error.message : 'unknown';
      if (reason !== lastFailure) {
        try { debug.log('control.member', 'heartbeat-failed', { reason }); } catch { /* logging is best-effort */ }
      }
      lastFailure = reason;
      failures++;
      // A lost record needs immediate re-registration. Other failures retry ahead of
      // the ordinary tick so a single timeout at the longest interval cannot exceed TTL.
      schedule(!registered && reason === 'http-404'
        ? 0
        : Math.min(MAX_RETRY_MS, Math.min(interval, DEFAULT_INTERVAL_MS) * 2 ** (failures - 1)));
    }
  };
  queueMicrotask(() => { void tick(); });
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    controller.abort();
  };
}
