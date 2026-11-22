// A control-plane projection only. It never probes an ELS endpoint or authorizes read/input.
import { validateElsEndpoint } from './store.js';
import type { HostRow, WorkerRegistrySnapshot } from './types.js';

export interface RemoteElsHostMetadata {
  readonly name: string;
  readonly state: 'registered' | 'unavailable';
  readonly generation: number;
  readonly elsEndpoint?: string;
  readonly principal?: string;
  readonly aliveAt?: string;
  readonly heartbeatTtlMs?: number;
  readonly readAllowed: false;
}

function projectedHost(host: HostRow, nowMs: number): RemoteElsHostMetadata {
  if (typeof host.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(host.name)
    || !Number.isSafeInteger(host.generation) || host.generation < 1) throw new Error('invalid host identity');
  const base = { name: host.name, generation: host.generation, readAllowed: false as const };
  const aliveAt = host.aliveAt === null ? NaN : Date.parse(host.aliveAt);
  const ttl = host.heartbeatTtlMs;
  const live = host.revokedAt === null && host.alive === true
    && Number.isFinite(aliveAt) && aliveAt <= nowMs
    && ttl !== null && Number.isSafeInteger(ttl) && ttl > 0 && nowMs - aliveAt < ttl;
  if (!live) return { ...base, state: 'unavailable' };
  if (typeof host.principal !== 'string' || host.principal.length === 0
    || typeof host.elsEndpoint !== 'string' || validateElsEndpoint(host.elsEndpoint) !== null)
    return { ...base, state: 'unavailable' };
  return { ...base, state: 'registered', principal: host.principal, elsEndpoint: host.elsEndpoint,
    aliveAt: host.aliveAt!, heartbeatTtlMs: ttl! };
}

/** One complete, fresh snapshot is the only source for every field. A malformed snapshot fails as a whole. */
export function projectRemoteElsHosts(snapshot: WorkerRegistrySnapshot, nowMs: number) {
  const atMs = Date.parse(snapshot.at);
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Number.isFinite(atMs)
    || !Number.isFinite(nowMs) || atMs > nowMs || !Number.isSafeInteger(snapshot.maxFreshnessMs)
    || snapshot.maxFreshnessMs <= 0 || nowMs - atMs > snapshot.maxFreshnessMs || !Array.isArray(snapshot.hosts))
    throw new Error('invalid worker registry snapshot');
  return { revision: snapshot.revision, at: snapshot.at, maxFreshnessMs: snapshot.maxFreshnessMs,
    hosts: snapshot.hosts.map((host) => projectedHost(host, nowMs)) };
}
