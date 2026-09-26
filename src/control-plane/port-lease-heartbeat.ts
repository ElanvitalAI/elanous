import { readMemberToken } from './member.js';
import { PORT_BANDS } from './ports.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';

const RENEW_MS = 30_000;
const RETRY_MS = 5_000;
export const PORT_LEASE_TTL_MS = 600_000;
// Stop before the coordinator can reassign the port, including request timeout and shutdown time.
const EXPIRY_MARGIN_MS = 10_000;

/** The detached NEXUS owns renewal and cleanup; the short-lived launcher never holds a timer. */
export async function startPortLeaseHeartbeat(port: number, leaseId: string, options: {
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  token?: string;
  intervalMs?: number;
  retryMs?: number;
  now?: () => number;
  onError?: (error: Error) => void;
  onLeaseLost: (error: Error) => void;
}): Promise<() => Promise<void>> {
  if (!Number.isInteger(port) || port < PORT_BANDS.test.start || port > PORT_BANDS.test.end) throw new Error('invalid coordinator lease port');
  if (!leaseId?.trim()) throw new Error('missing coordinator lease id');
  if ((options.intervalMs !== undefined && (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0 || options.intervalMs >= PORT_LEASE_TTL_MS - EXPIRY_MARGIN_MS)) ||
      (options.retryMs !== undefined && (!Number.isFinite(options.retryMs) || options.retryMs <= 0))) throw new Error('invalid coordinator renewal interval');
  const token = options.token ?? readMemberToken(effectiveInstanceRoot());
  if (!token) throw new Error('missing coordinator member token');
  const send = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const base = `http://127.0.0.1:${PORT_BANDS.reserved[0]}/v1/leases/port/${port}`;
  const headers = { Authorization: `Bearer ${token}`, 'x-port-lease-id': leaseId };
  let stopped = false;
  let initialCheckDone = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const startedAt = now();
  let lastSuccess = startedAt;
  const lost = (error: Error): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (initialCheckDone) options.onLeaseLost(error);
  };
  const armDeadline = (): void => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    const remaining = lastSuccess + PORT_LEASE_TTL_MS - EXPIRY_MARGIN_MS - now();
    if (remaining <= 0) { lost(new Error('coordinator port lease renewal deadline exceeded')); return; }
    deadlineTimer = setTimeout(() => lost(new Error('coordinator port lease renewal deadline exceeded')), remaining);
  };
  const renew = async (): Promise<void> => {
    try {
      const response = await send(`${base}/heartbeat`, {
        method: 'POST', headers, signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) throw new Error(`coordinator lease renewal HTTP ${response.status}`);
      if (!stopped) {
        const receivedAt = now();
        if (receivedAt >= lastSuccess + PORT_LEASE_TTL_MS - EXPIRY_MARGIN_MS) {
          lost(new Error('coordinator port lease renewal deadline exceeded'));
          return;
        }
        lastSuccess = receivedAt;
        armDeadline();
        if (!stopped) timer = setTimeout(tick, options.intervalMs ?? RENEW_MS);
      }
    } catch (error) {
      if (stopped) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      try { options.onError?.(failure); } catch { /* logging must not interrupt renewal */ }
      if (now() >= lastSuccess + PORT_LEASE_TTL_MS - EXPIRY_MARGIN_MS || [400, 403, 404, 409].some(status => failure.message === `coordinator lease renewal HTTP ${status}`)) lost(failure);
      else timer = setTimeout(tick, Math.min(options.retryMs ?? RETRY_MS, lastSuccess + PORT_LEASE_TTL_MS - EXPIRY_MARGIN_MS - now()));
    }
    timer?.unref?.();
  };
  const tick = (): void => { if (!stopped) pending = renew(); };
  const initial = await send(`${base}/heartbeat`, {
    method: 'POST', headers, signal: AbortSignal.timeout(1000),
  });
  if (!initial.ok) throw new Error(`coordinator lease renewal HTTP ${initial.status}`);
  const confirmedAt = now();
  if (confirmedAt >= startedAt + PORT_LEASE_TTL_MS - EXPIRY_MARGIN_MS) throw new Error('coordinator port lease renewal deadline exceeded');
  lastSuccess = confirmedAt;
  armDeadline();
  if (stopped) throw new Error('coordinator port lease renewal deadline exceeded');
  initialCheckDone = true;
  if (!stopped) timer = setTimeout(tick, options.intervalMs ?? RENEW_MS);
  timer?.unref?.();
  return async () => {
    if (!stopped) {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
    await pending;
    const response = await send(base, {
      method: 'DELETE', headers, signal: AbortSignal.timeout(1000),
    });
    if (!response.ok && response.status !== 404 && response.status !== 403) throw new Error(`coordinator lease release HTTP ${response.status}`);
  };
}
