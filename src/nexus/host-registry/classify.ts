import type { HostRecord, HostState } from './types.js';

export const DEFAULT_STALE_MS = 10 * 60_000;
const SHA = /^[a-f0-9]{40}$/i;

/**
 * Pure. Precedence: stale (heartbeat age > staleMs; age === staleMs is fresh)
 * beats unknown (installed or desired sha missing/invalid) beats current/behind.
 */
export function classifyHost(
  record: Pick<HostRecord, 'installedSha' | 'lastHeartbeatMs'>,
  desiredSha: string | undefined,
  now: number,
  staleMs: number = DEFAULT_STALE_MS,
): HostState {
  if (!Number.isFinite(record.lastHeartbeatMs) || now - record.lastHeartbeatMs > staleMs) return 'stale';
  if (!SHA.test(record.installedSha) || !desiredSha || !SHA.test(desiredSha)) return 'unknown';
  return record.installedSha.toLowerCase() === desiredSha.toLowerCase() ? 'current' : 'behind';
}
