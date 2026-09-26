// P4 (2026-05-10) — Multi-instance PWA daemon registry.
//
// Tracks every `elanous nexus pwa start` / `pwa test` daemon currently
// running on this host so `pwa global status` / `pwa global clean`
// (P5) can see across folders / projects / lock dirs. Without a
// registry, two instances in different cwds or `~/.elanous/nexus/` vs
// `<repo>/.elanous-test/` are invisible to each other; the registry
// makes them addressable from one place.
//
// Wire points (P4 hookups in pwa-start / pwa-stop / pwa-test):
//   - On daemon spawn success → `registerPwaInstance(entry)`
//   - On `pwa stop` / `pwa test --stop` → `unregisterPwaInstance(pid)`
//   - On `pwa global status` (P5) → `listPwaInstances({ prune: true })`
//   - On `pwa global clean` (P5) → list → kill / unmount each → wipe file
//
// File: `~/.elanous/pwa-registry.json` (JSON · single source of truth
// per host). Schema versioned (`version: 1`). Atomic write via
// `tmpfile + rename` so a concurrent reader never sees a half-written
// file. Stale entries (pid no longer alive) are pruned lazily on read
// — write path stays lock-free for simplicity.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { debug } from '../debug/log.js';

export type PwaInstanceMode = 'static' | 'hmr';
export type PwaInstanceKind = 'production' | 'test';

export type PwaLauncherProvenance =
  | { kind: 'autonomous-run'; runId: string }
  | { kind: 'service-manager'; serviceName: string }
  | { kind: 'background-child' }
  | { kind: 'human-terminal' }
  | { kind: 'unknown' };

export interface PwaLauncherProvenanceOpts {
  env: Readonly<Record<string, string | undefined>>;
  isTTY: boolean | undefined;
}

/** Resolve only directly observable launch context. The precedence keeps
 * run identity over parent/service signals, and does not infer a person when
 * no signal is present. */
export function resolvePwaLauncherProvenance(
  { env, isTTY }: PwaLauncherProvenanceOpts,
): PwaLauncherProvenance {
  const runId = env.ELANOUS_RUN_ID;
  if (runId) return { kind: 'autonomous-run', runId };

  const serviceName = env.LAUNCH_JOB_NAME;
  if (serviceName) return { kind: 'service-manager', serviceName };
  if (env.XPC_SERVICE_NAME?.startsWith('com.elanous.')) {
    return { kind: 'service-manager', serviceName: env.XPC_SERVICE_NAME };
  }
  if (env.INVOCATION_ID && (env.SYSTEMD_EXEC_PID || env.JOURNAL_STREAM)) {
    return { kind: 'service-manager', serviceName: 'systemd' };
  }

  if (env.ELANOUS_NEXUS_BG_PARENT) return { kind: 'background-child' };
  if (isTTY) return { kind: 'human-terminal' };
  return { kind: 'unknown' };
}

function currentPwaLauncherProvenance(): PwaLauncherProvenance {
  return resolvePwaLauncherProvenance({ env: process.env, isTTY: process.stdin.isTTY });
}

function normalizePwaLauncherProvenance(value: unknown): PwaLauncherProvenance {
  if (!value || typeof value !== 'object') return { kind: 'unknown' };
  const provenance = value as Record<string, unknown>;
  switch (provenance.kind) {
    case 'autonomous-run':
      return typeof provenance.runId === 'string' ? { kind: 'autonomous-run', runId: provenance.runId } : { kind: 'unknown' };
    case 'service-manager':
      return typeof provenance.serviceName === 'string' ? { kind: 'service-manager', serviceName: provenance.serviceName } : { kind: 'unknown' };
    case 'background-child':
      return { kind: 'background-child' };
    case 'human-terminal':
      return { kind: 'human-terminal' };
    case 'unknown':
      return { kind: 'unknown' };
    default:
      return { kind: 'unknown' };
  }
}

export interface PwaRegistryEntry {
  /** OS pid of the daemon process. Primary key for unregister + alive
   *  probe. */
  pid: number;
  /** All ports this instance owns: nexus HTTP + (hmr) Next.js dev.
   *  `pwa global clean` iterates this list to release Tailscale Serve
   *  per-port unmounts. */
  ports: number[];
  mode: PwaInstanceMode;
  kind: PwaInstanceKind;
  /** Working directory the user invoked `pwa start` / `pwa test` from.
   *  Distinguishes "multi-folder same machine" instances. */
  cwd: string;
  /** Daemon state directory. `~/.elanous/nexus/` for production · per-
   *  repo `<repo>/.elanous-test/` for test mode. */
  daemonDir: string;
  /** True when Tailscale Serve was mounted at boot (`share enable` or
   *  `--https`). `pwa global clean` knows whether to attempt unmount. */
  shareMounted: boolean;
  /** True when the user passed `--https` (P2) — config 비저장 ad-hoc
   *  share. Distinguishes from switch-driven persistent share. */
  https: boolean;
  /** ISO 8601 wall clock at register time. */
  startedAt: string;
  /** Observable launch context. Optional on disk for version-1 compatibility. */
  launcherProvenance?: PwaLauncherProvenance;
}

interface RegistryFileShape {
  version: 1;
  instances: PwaRegistryEntry[];
}

export type PwaRegistryReadState = 'missing' | 'unreadable' | 'malformed' | 'present-empty' | 'present';
export type PwaPidLiveness = 'alive' | 'dead';
export type PwaServiceObservation = 'responding' | 'not-responding' | 'unknown';

export interface PwaPruneDiagnostic {
  pid: number;
  reason: 'pid-not-alive';
}

export interface PwaRegistryDiagnostics {
  /** Registry-file observation, not a conclusion about whether a daemon serves HTTP. */
  readState: PwaRegistryReadState;
  /** The only authority used for cleanup: process.kill(pid, 0). */
  livenessProbe: 'pid-signal-0';
  /** An optional, non-authoritative observation of expected service endpoints. */
  serviceObservation: PwaServiceObservation;
  /** True only when no registration exists while an expected endpoint responds. */
  serviceMismatch: boolean;
  registeredCount: number;
  pruned: PwaPruneDiagnostic[];
}

export type PwaServiceProbe = (ports: readonly number[]) => PwaServiceObservation;

export interface ListOpts extends RegisterOpts {
  /** When true (default), drop entries whose pid is no longer alive
   *  AND persist the prune. Set false for diagnostic snapshots that
   *  want to see stale entries verbatim. */
  prune?: boolean;
  /** Optional service endpoint diagnostic. It never changes PID-based cleanup. */
  serviceProbe?: PwaServiceProbe;
  /** Expected ports to observe when the registry itself is empty. */
  expectedPorts?: readonly number[];
}

export interface PwaInstanceListResult {
  instances: PwaInstanceListing[];
  diagnostics: PwaRegistryDiagnostics;
}

const REGISTRY_VERSION = 1;

/** Default path: `~/.elanous/pwa-registry.json`. Override via env for
 *  tests or alternate user roots. */
export function pwaRegistryPath(): string {
  const root = process.env.ELANOUS_HOME || join(homedir(), '.elanous');
  return join(root, 'pwa-registry.json');
}

function readRegistry(path: string): { registry: RegistryFileShape; readState: PwaRegistryReadState } {
  if (!existsSync(path)) return { registry: { version: REGISTRY_VERSION, instances: [] }, readState: 'missing' };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RegistryFileShape;
    if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.instances)) {
      return { registry: { version: REGISTRY_VERSION, instances: [] }, readState: 'malformed' };
    }
    // Defensive: drop entries missing required fields. The registry
    // is best-effort — a malformed entry should never break stop/list.
    const validEntries = parsed.instances.filter(
      (e): e is PwaRegistryEntry =>
        typeof e?.pid === 'number'
        && Array.isArray(e?.ports)
        && typeof e?.cwd === 'string',
    );
    const instances = validEntries.map((entry) => ({
      ...entry,
      launcherProvenance: normalizePwaLauncherProvenance(entry.launcherProvenance),
    }));
    if (instances.length !== parsed.instances.length) {
      return { registry: { version: REGISTRY_VERSION, instances }, readState: 'malformed' };
    }
    return { registry: { version: REGISTRY_VERSION, instances }, readState: instances.length === 0 ? 'present-empty' : 'present' };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : undefined;
    return { registry: { version: REGISTRY_VERSION, instances: [] }, readState: code === 'EACCES' || code === 'EPERM' ? 'unreadable' : 'malformed' };
  }
}

/** Atomic write — tmpfile + rename. Survives concurrent readers (a
 *  reader either gets the old file or the new file, never a partial
 *  write). Race between two writers can lose one update; that risk is
 *  acceptable for a best-effort registry (the affected instance can
 *  still be reaped via pid check on next list). */
function writeRegistry(path: string, data: RegistryFileShape): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** True when `pid` corresponds to a live process on this host. Uses
 *  `process.kill(pid, 0)` which is a probe (no signal sent · throws
 *  ESRCH when the process is gone). */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = process exists but we
    // lack permission to signal it (e.g. another user's process or
    // pid 1). Treat EPERM as alive — the pid is held by something.
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : undefined;
    if (code === 'EPERM') return true;
    return false;
  }
}

export type PwaRegistryObservationArgs =
  | [event: 'registered', data: { pid: number; remainingCount: number; registryPath: string }]
  | [event: 'unregistered', data: { pid: number; remainingCount: number; registryPath: string }]
  | [event: 'cleared', data: {
    pids: number[];
    remainingCount: number;
    deletedCount: number;
    success: boolean;
    registryPath: string;
  }];

export type PwaRegistryObservation = (...args: PwaRegistryObservationArgs) => void;

export interface RegisterOpts {
  /** Override registry file path (tests). */
  registryPath?: string;
  /** Structured mutation observation. Its failures never affect registry updates. */
  observe?: PwaRegistryObservation;
  /** Registry-file removal implementation (tests). */
  removeFile?: (path: string) => void;
}

function safelyObserve(observe: PwaRegistryObservation, ...args: PwaRegistryObservationArgs): void {
  try { observe(...args); } catch { /* observability must not alter registry mutations */ }
}

/** Add `entry` to the registry, replacing any prior entry with the
 *  same pid (idempotent on re-register). */
export function registerPwaInstance(entry: PwaRegistryEntry, opts: RegisterOpts = {}): void {
  const path = opts.registryPath ?? pwaRegistryPath();
  const { registry } = readRegistry(path);
  registry.instances = registry.instances.filter((e) => e.pid !== entry.pid);
  registry.instances.push({
    ...entry,
    launcherProvenance: entry.launcherProvenance ?? currentPwaLauncherProvenance(),
  });
  writeRegistry(path, registry);
  safelyObserve(opts.observe ?? ((event, data) => debug.log('pwa.registry', event, data)), 'registered', {
    pid: entry.pid,
    remainingCount: registry.instances.length,
    registryPath: path,
  });
}

/** Remove the entry whose `pid === pid`. No-op when absent. */
export function unregisterPwaInstance(pid: number, opts: RegisterOpts = {}): void {
  const path = opts.registryPath ?? pwaRegistryPath();
  const { registry } = readRegistry(path);
  const before = registry.instances.length;
  registry.instances = registry.instances.filter((e) => e.pid !== pid);
  if (registry.instances.length !== before) writeRegistry(path, registry);
  safelyObserve(opts.observe ?? ((event, data) => debug.log('pwa.registry', event, data)), 'unregistered', {
    pid,
    remainingCount: registry.instances.length,
    registryPath: path,
  });
}

export interface PwaInstanceListing extends PwaRegistryEntry {
  /** PID signal-0 result; EPERM deliberately counts as alive. */
  alive: boolean;
  pidLiveness: PwaPidLiveness;
}

/** Observe the registry separately from service discovery. Cleanup remains
 *  intentionally PID-only: a port/HTTP observation must never retain or
 *  delete an entry because it cannot establish that the responder is ours. */
export function inspectPwaInstances(opts: ListOpts = {}): PwaInstanceListResult {
  const path = opts.registryPath ?? pwaRegistryPath();
  const { registry, readState } = readRegistry(path);
  const instances: PwaInstanceListing[] = registry.instances.map((entry) => {
    const alive = isAlive(entry.pid);
    return { ...entry, alive, pidLiveness: alive ? 'alive' : 'dead' };
  });
  const aliveInstances = instances.filter((entry) => entry.alive);
  const pruned = instances
    .filter((entry) => !entry.alive)
    .map((entry) => ({ pid: entry.pid, reason: 'pid-not-alive' as const }));
  const prune = opts.prune !== false;
  if (prune && pruned.length > 0) {
    writeRegistry(path, {
      version: REGISTRY_VERSION,
      instances: aliveInstances.map(({ alive: _alive, pidLiveness: _pidLiveness, ...entry }) => entry),
    });
  }
  const observedPorts = registry.instances.length === 0 ? (opts.expectedPorts ?? []) : registry.instances.flatMap((entry) => entry.ports);
  const serviceObservation = opts.serviceProbe && observedPorts.length > 0
    ? opts.serviceProbe(observedPorts)
    : 'unknown';
  return {
    instances: prune ? aliveInstances : instances,
    diagnostics: {
      readState,
      livenessProbe: 'pid-signal-0',
      serviceObservation,
      serviceMismatch: (registry.instances.length === 0 || aliveInstances.length === 0) && serviceObservation === 'responding',
      registeredCount: registry.instances.length,
      pruned: prune ? pruned : [],
    },
  };
}

/** Compatibility list for existing callers. Use inspectPwaInstances when
 *  the caller needs the read and pruning diagnostics. */
export function listPwaInstances(opts: ListOpts = {}): PwaInstanceListing[] {
  return inspectPwaInstances(opts).instances;
}

/** Drop the registry file entirely. Used by `pwa global clean` after
 *  killing all instances. Caller is responsible for orchestrating the
 *  kills + Tailscale Serve unmounts BEFORE calling this — wiping the
 *  file alone leaves orphan processes. */
export function clearPwaRegistry(opts: RegisterOpts = {}): void {
  const path = opts.registryPath ?? pwaRegistryPath();
  const { registry } = readRegistry(path);
  const existed = existsSync(path);
  let success = true;
  if (existed) {
    try {
      (opts.removeFile ?? ((filePath) => rmSync(filePath, { force: true })))(path);
    } catch {
      success = false;
    }
  }
  safelyObserve(opts.observe ?? ((event, data) => debug.log('pwa.registry', event, data)), 'cleared', {
    pids: registry.instances.map((entry) => entry.pid),
    remainingCount: success ? 0 : registry.instances.length,
    deletedCount: success && existed ? registry.instances.length : 0,
    success,
    registryPath: path,
  });
}
