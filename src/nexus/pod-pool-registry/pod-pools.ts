import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nexusRootDir } from '../paths.js';
import { parsePodPool, type PodPlacementKind, type PodPoolMember } from '../../task-orchestrator/surfaces/pod-pool.js';
import type { PodPoolEntry, PodPoolsFile, PodPoolFederationRole, PodPoolState, PodReusePolicy } from './types.js';

export class PodPoolsReadError extends Error {}

export function podPoolsPath(): string {
  return join(nexusRootDir(), 'pod-pools.json');
}

const STATES = new Set<string>(['available', 'draining']);
const ROLES = new Set<string>(['task', 'gate', 'cloud']);
const POLICIES = new Set<string>(['warm-worker', 'per-job']);

/** Null-prototype map so pool names like __proto__ / constructor are ordinary own keys. */
export function toPodPoolMap(entries: Iterable<[string, PodPoolEntry]>): Record<string, PodPoolEntry> {
  const m: Record<string, PodPoolEntry> = Object.create(null);
  for (const [k, v] of entries) Object.defineProperty(m, k, { value: v, enumerable: true, writable: true, configurable: true });
  return m;
}

function isReuse(v: unknown): v is { policy: PodReusePolicy; maxIdleMs?: number } {
  if (!v || typeof v !== 'object') return false;
  const r = v as { policy?: unknown; maxIdleMs?: unknown };
  if (typeof r.policy !== 'string' || !POLICIES.has(r.policy)) return false;
  return r.maxIdleMs === undefined || (typeof r.maxIdleMs === 'number' && Number.isSafeInteger(r.maxIdleMs) && r.maxIdleMs >= 0);
}

export function isPodPoolEntry(v: unknown): v is PodPoolEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<PodPoolEntry> & { maxIdleMs?: unknown };
  if (typeof e.context !== 'string' || e.context.trim() === '') return false;
  if (typeof e.capacity !== 'number' || !Number.isSafeInteger(e.capacity) || e.capacity < 0) return false;
  if (typeof e.state !== 'string' || !STATES.has(e.state)) return false;
  if (e.host !== undefined && typeof e.host !== 'string') return false;
  if (e.k3dCluster !== undefined && typeof e.k3dCluster !== 'string') return false;
  if (e.imageRef !== undefined && typeof e.imageRef !== 'string') return false;
  if (e.registry !== undefined && typeof e.registry !== 'string') return false;
  if (e.capacityDefaulted !== undefined && typeof e.capacityDefaulted !== 'boolean') return false;
  if (e.federationRole !== undefined && (typeof e.federationRole !== 'string' || !ROLES.has(e.federationRole))) return false;
  if (e.aliases !== undefined && (!Array.isArray(e.aliases) || !e.aliases.every((a) => typeof a === 'string'))) return false;
  if (e.reuse !== undefined && !isReuse(e.reuse)) return false;
  return true;
}

function k3dClusterFor(context: string): string {
  return context.startsWith('k3d-') ? context.slice(4) : 'elanous-pool';
}

/**
 * Strict read: undefined = the file genuinely does not exist (ENOENT).
 * Anything else that is not a valid registry throws (with the offending pool key),
 * so writers never overwrite it. Pool key order is preserved from the file
 * (JSON key order = registration order; no sort).
 */
export function readPodPoolsStrict(path: string = podPoolsPath()): PodPoolsFile | undefined {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new PodPoolsReadError(`pod pool registry unreadable (${path}): ${(e as Error).message}`);
  }
  let parsed: Partial<PodPoolsFile> | null;
  try { parsed = JSON.parse(text) as Partial<PodPoolsFile>; } catch (e) {
    throw new PodPoolsReadError(`pod pool registry corrupt (${path}): ${(e as Error).message}`);
  }
  if (parsed?.version !== 1 || typeof parsed.pools !== 'object' || parsed.pools === null || Array.isArray(parsed.pools)) {
    throw new PodPoolsReadError(`pod pool registry has unsupported version/shape (${path})`);
  }
  const entries = Object.entries(parsed.pools) as [string, unknown][];
  for (const [k, v] of entries) {
    if (!isPodPoolEntry(v)) throw new PodPoolsReadError(`pod pool registry entry "${k}" is malformed (${path})`);
  }
  // Registration order preserved as read — downstream registration-order promises
  // (spec emission order, capacity tie-break) must hold on real files, not just fixtures.
  return { version: 1, pools: toPodPoolMap(entries as [string, PodPoolEntry][]) };
}

/** Display read: undefined = no usable registry → callers report «unmeasured». Malformed registries are skipped. */
export function readPodPools(path: string = podPoolsPath()): PodPoolsFile | undefined {
  try { return readPodPoolsStrict(path); } catch { return undefined; }
}

/** Resolve a pool by key, then by alias. Unknown → PodPoolsReadError naming what was asked for. */
export function resolvePodPool(file: PodPoolsFile, nameOrAlias: string): PodPoolEntry {
  const direct = file.pools[nameOrAlias];
  if (direct) return direct;
  for (const entry of Object.values(file.pools)) {
    if (entry.aliases?.includes(nameOrAlias)) return entry;
  }
  throw new PodPoolsReadError(`pod pool not registered: "${nameOrAlias}"`);
}

/** Registry entry → the existing scheduler's PodPoolMember (k3d cluster derived, ssh host from `host`). */
export function toPodPoolMember(_name: string, entry: PodPoolEntry): PodPoolMember {
  return {
    context: entry.context,
    ...(entry.host ? { sshHost: entry.host } : {}),
    capacity: entry.capacity,
    ...(entry.capacityDefaulted ? { capacityDefaulted: true } : {}),
    k3dCluster: entry.k3dCluster ?? k3dClusterFor(entry.context),
    ...(entry.imageRef ? { imageRef: entry.imageRef } : {}),
    ...(entry.registry ? { registry: entry.registry } : {}),
    ...(entry.federationRole ? { federationRole: entry.federationRole } : {}),
  };
}

/**
 * Registry → the scheduler's spec string (`context[@ssh][:capacity][#registry]`), live members only,
 * in registration order. Round-trips through parsePodPool with identical members.
 */
export function toPodPoolSpec(file: PodPoolsFile): string {
  return Object.entries(file.pools)
    .filter(([, e]) => e.capacity > 0 && e.state === 'available')
    .map(([, e]) => {
      const member = toPodPoolMember('', e);
      let part = member.context;
      if (member.sshHost) part += `@${member.sshHost}`;
      part += `:${member.capacity}`;
      if (member.registry) {
        const [h, ...rest] = member.registry.split(':');
        part += `#${h}:${rest.join(':')}`;
      }
      return part;
    })
    .join(',');
}

export interface AssignablePodPoolsOptions {
  kind?: PodPlacementKind | null;
  skip?: ReadonlySet<string>;
}

/**
 * Pool keys assignable to new Jobs: capacity 0 (off) and draining members are excluded,
 * skipped names are excluded. A kind moves its preferred members first
 * (lite → smallest capacity, standard → largest; ties keep registration order).
 */
export function assignablePodPools(file: PodPoolsFile, opts: AssignablePodPoolsOptions = {}): string[] {
  const live = Object.entries(file.pools)
    .filter(([name, e]) => e.capacity > 0 && e.state === 'available' && !opts.skip?.has(name))
    .map(([name]) => name);
  if (!opts.kind || live.length < 2) return live;
  const caps = live.map((name) => file.pools[name]!.capacity);
  const min = Math.min(...caps);
  const max = Math.max(...caps);
  if (min === max) return live;
  const target = opts.kind === 'lite' ? min : max;
  const preferred = live.filter((name) => file.pools[name]!.capacity === target);
  return [...preferred, ...live.filter((name) => !preferred.includes(name))];
}

export function reusePolicyFor(file: PodPoolsFile, name: string): { reuseWarm: boolean; maxIdleMs: number | undefined } {
  const entry = resolvePodPool(file, name);
  if (!entry.reuse || entry.reuse.policy !== 'warm-worker') return { reuseWarm: false, maxIdleMs: undefined };
  return { reuseWarm: true, maxIdleMs: entry.reuse.maxIdleMs };
}

export function writePodPoolsAtomic(file: PodPoolsFile, path: string = podPoolsPath(), renameImpl: (from: string, to: string) => void = renameSync): void {
  const dir = join(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    renameImpl(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}