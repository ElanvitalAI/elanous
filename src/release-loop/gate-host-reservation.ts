import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { psProcessStartMs } from '../harness/harness-stop.js';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { psProcessStart, type HostLeaseRecord, type PendingJobIdentity } from '../pod-lease/host-lease.js';
import { parsePodPool, podPoolHostLease, resolvePodPoolSpec, type PodPoolMember } from '../task-orchestrator/surfaces/pod-pool.js';
import { admitGuardianHostLease, endGuardianHostLease, renewGuardianHostLease, requestGuardianHostLease, resourceLedgerPath } from '../resource-ledger/resource-ledger.js';

interface GateHostClaim {
  token: string;
  runId: string;
  hosts: string[];
  pid: number;
  pidStartedAt: number | null;
  /** Wall-clock claim time. Claims written before this field existed stay readable (optional on read). */
  reservedAt?: number;
}

export type GateHostReservation =
  | { status: 'free' }
  | { status: 'reserved' | 'unknown'; reason: string; runId?: string; reservedAt?: number };

/** Read-only snapshots used to decide whether the resource pool behind a gate host is occupied. */
export interface GateHostResourceSnapshot {
  /** null means the lease ledger was unreadable; [] is a measured empty ledger. */
  leases: readonly HostLeaseRecord[] | null;
  /** Active Pending/Running Jobs from the configured Pod pool; null means not measurable. */
  activeJobs: readonly PendingJobIdentity[] | null;
}

export type GateHostResourceReading =
  | { status: 'measured'; empty: boolean; reservations: number; authoringLeases: number; waitingJobs: number; activeJobs: number }
  | { status: 'unmeasurable'; empty: null; reason: 'lease-ledger-unavailable' | 'lease-ledger-invalid' | 'pod-list-unavailable' | 'pod-list-invalid' | 'pod-pool-invalid' | 'pod-pool-unconfigured' | 'host-not-in-pod-pool' | 'kubectl-unavailable' | 'kubectl-context-missing' | 'kubectl-api-unavailable' };

const unavailable = (reason: Extract<GateHostResourceReading, { status: 'unmeasurable' }>['reason']): GateHostResourceReading => ({ status: 'unmeasurable', empty: null, reason });

/** Read leases and active harness Pods from the configured pool without creating, pruning, or updating any ledger. */
export function readGateHostResourcesForHost(host: string, env: NodeJS.ProcessEnv = process.env,
  deps: { members?: readonly PodPoolMember[]; kubectl?: (args: readonly string[]) => { status: number | null; stdout: string; stderr?: string; error?: string; errorCode?: string };
    processStart?: (pid: number) => string | null } = {}): GateHostResourceReading {
  let members: readonly PodPoolMember[];
  try {
    const spec = resolvePodPoolSpec(undefined, env, () => {
      try {
        // The gate path resolves its pool from harness.podPool, unlike generic Pod launches.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return (require('../user-config.js') as typeof import('../user-config.js')).getUserConfig().harness?.podPool;
      } catch { return undefined; }
    });
    members = deps.members ?? (spec ? parsePodPool(spec) : []);
  } catch { return unavailable('pod-pool-invalid'); }
  if (!members.length) return unavailable('pod-pool-unconfigured');
  const selectedHost = host.split('@').at(-1)!;
  const selectedMembers = members.filter(member => member.sshHost === selectedHost);
  if (!selectedMembers.length) return unavailable('host-not-in-pod-pool');
  const selectedContexts = new Set(selectedMembers.map(member => member.context));

  const leasePool = podPoolHostLease(members);
  let leases: HostLeaseRecord[];
  try {
    let names: string[];
    try { names = readdirSync(leasePool.dir).filter(name => name.endsWith('.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = [];
      else return unavailable('lease-ledger-unavailable');
    }
    leases = [];
    const processStart = deps.processStart ?? psProcessStart;
    for (const name of names) {
      if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) return unavailable('lease-ledger-invalid');
      let lease: HostLeaseRecord;
      try { lease = JSON.parse(readFileSync(join(leasePool.dir, name), 'utf8')) as HostLeaseRecord; }
      catch { return unavailable('lease-ledger-invalid'); }
      if (!lease || !Number.isSafeInteger(lease.pid) || lease.pid <= 0 || typeof lease.startedAt !== 'string' || !lease.startedAt ||
        typeof lease.at !== 'string' || (lease.stage !== undefined && lease.stage !== 'authoring' && lease.stage !== 'job') ||
        (lease.stage === 'job' && (!lease.job || !lease.context || !lease.namespace))) return unavailable('lease-ledger-invalid');
      try { process.kill(lease.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
        // EPERM means the PID may still be alive; the start-time comparison below is still read-only.
      }
      const startedAt = processStart(lease.pid);
      if (startedAt === null) return unavailable('lease-ledger-unavailable');
      if (startedAt !== lease.startedAt) continue;
      if (lease.stage !== 'job' || selectedContexts.has(lease.context!)) leases.push(lease);
    }
  } catch { return unavailable('lease-ledger-unavailable'); }

  const kubectl = deps.kubectl ?? ((args: readonly string[]) => {
    const result = spawnSync('kubectl', [...args], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
    const spawnError = result.error as NodeJS.ErrnoException | undefined;
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: spawnError?.message, errorCode: spawnError?.code };
  });
  const activeJobs = new Map<string, PendingJobIdentity>();
  for (const member of selectedMembers) {
    let result: { status: number | null; stdout: string; stderr?: string; error?: string; errorCode?: string };
    try { result = kubectl(['--context', member.context, '--request-timeout=10s', 'get', 'pods', '--all-namespaces', '-l', 'elanous.substrate=pod', '-o', 'json']); }
    catch { return unavailable('kubectl-api-unavailable'); }
    if (result.status !== 0) {
      const diagnostic = `${result.stderr ?? ''} ${result.error ?? ''}`.toLowerCase();
      if (result.status === null && ['ENOENT', 'EACCES', 'EISDIR'].includes(result.errorCode ?? '')) return unavailable('kubectl-unavailable');
      if (/context .* (not found|does not exist)|no context exists/.test(diagnostic)) return unavailable('kubectl-context-missing');
      return unavailable('kubectl-api-unavailable');
    }
    let items: unknown;
    try { items = (JSON.parse(result.stdout) as { items?: unknown }).items; }
    catch { return unavailable('pod-list-invalid'); }
    if (!Array.isArray(items)) return unavailable('pod-list-invalid');
    for (const item of items) {
      if (!item || typeof item !== 'object') return unavailable('pod-list-invalid');
      const pod = item as { metadata?: { name?: unknown; namespace?: unknown; deletionTimestamp?: unknown; labels?: Record<string, unknown>; ownerReferences?: Array<{ kind?: unknown; name?: unknown }> }; status?: { phase?: unknown } };
      const phase = pod.status?.phase;
      if (phase === 'Succeeded' || phase === 'Failed') continue;
      if (phase !== 'Pending' && phase !== 'Running') return unavailable('pod-list-invalid');
      // Deleting Pods are already leaving the pool and must not keep the selected host occupied.
      if (pod.metadata?.deletionTimestamp != null) continue;
      const context = member.context;
      const namespace = pod.metadata?.namespace;
      const owner = pod.metadata?.ownerReferences?.find(ref => ref.kind === 'Job')?.name;
      const job = owner ?? pod.metadata?.labels?.['job-name'];
      if (typeof namespace !== 'string' || !namespace || typeof job !== 'string' || !job) return unavailable('pod-list-invalid');
      const identity = { context, namespace, job };
      activeJobs.set(`${context}\0${namespace}\0${job}`, identity);
    }
  }
  const reading = readGateHostResources({ leases, activeJobs: [...activeJobs.values()] });
  debug.log('release-loop.gate', 'host-resource-probe', { host: selectedHost, poolContexts: selectedMembers.map(member => member.context), ...reading });
  return reading;
}

function activeJobKey(job: PendingJobIdentity): string | null {
  return typeof job?.context === 'string' && job.context.length > 0 &&
    typeof job.namespace === 'string' && job.namespace.length > 0 &&
    typeof job.job === 'string' && job.job.length > 0
    ? `${job.context}\0${job.namespace}\0${job.job}` : null;
}

/**
 * Read the resource ledgers as the authority for host occupancy. Process argv is deliberately not an input:
 * unrelated commands that happen to contain `bun test` do not reserve a gate host.
 * A Job-backed lease and its active Job are one reservation; a lease without an observed Job remains reserved.
 */
export function readGateHostResources(snapshot: GateHostResourceSnapshot): GateHostResourceReading {
  if (snapshot.leases === null) return { status: 'unmeasurable', empty: null, reason: 'lease-ledger-unavailable' };
  if (snapshot.activeJobs === null) return { status: 'unmeasurable', empty: null, reason: 'pod-list-unavailable' };
  if (!Array.isArray(snapshot.leases) || snapshot.leases.some((lease) => !lease ||
    !Number.isSafeInteger(lease.pid) || lease.pid <= 0 || typeof lease.startedAt !== 'string' || !lease.startedAt || typeof lease.at !== 'string' ||
    (lease.stage !== undefined && lease.stage !== 'authoring' && lease.stage !== 'job') ||
    (lease.stage === 'job' && (!lease.job || !lease.context || !lease.namespace)))) {
    return { status: 'unmeasurable', empty: null, reason: 'lease-ledger-invalid' };
  }
  if (!Array.isArray(snapshot.activeJobs) || snapshot.activeJobs.some((job) => !job || activeJobKey(job) === null)) {
    return { status: 'unmeasurable', empty: null, reason: 'pod-list-invalid' };
  }

  const jobs = new Set(snapshot.activeJobs.map(activeJobKey) as string[]);
  // Authoring leases have no host/context yet, so they conservatively occupy each selected host in the shared pool.
  let authoringLeases = 0;
  let waitingJobs = 0;
  for (const lease of snapshot.leases) {
    if (lease.stage !== 'job') { authoringLeases++; continue; }
    const key = lease.job && lease.context && lease.namespace
      ? activeJobKey({ job: lease.job, context: lease.context, namespace: lease.namespace }) : null;
    if (!key || !jobs.has(key)) waitingJobs++;
  }
  const reservations = authoringLeases + waitingJobs + jobs.size;
  return { status: 'measured', empty: reservations === 0, reservations, authoringLeases, waitingJobs, activeJobs: jobs.size };
}

const hostName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const claimsDir = (root: string) => join(root, 'release', 'gate-host-reservations');

/** The release graph's pinned child state and the self gate CLI's selected universe resolve through this same entry. */
export function gateHostReservationRoot(): string { return effectiveInstanceRoot(); }

/** Keep admitted leases alive for gates longer than the initial TTL; stop is idempotent. */
export function startGuardianHostLeaseHeartbeat(leaseIds: readonly string[], root: string, options: {
  intervalMs?: number; ttlMs?: number; now?: () => Date;
  schedule?: (tick: () => void, intervalMs: number) => () => void;
} = {}): () => void {
  const intervalMs = options.intervalMs ?? 30 * 60 * 1000;
  const ttlMs = options.ttlMs ?? 2 * 60 * 60 * 1000;
  const now = options.now ?? (() => new Date());
  if (intervalMs <= 0 || ttlMs <= intervalMs) throw new Error('invalid Guardian host lease heartbeat timing');
  const tick = () => {
    for (const leaseId of leaseIds) {
      try {
        const instant = now();
        if (!renewGuardianHostLease(leaseId, new Date(instant.getTime() + ttlMs).toISOString(), instant, resourceLedgerPath(root)))
          debug.log('release-loop.gate', 'guardian-lease-renewal-refused', { leaseId }, { level: 'error' });
      } catch (error) {
        debug.log('release-loop.gate', 'guardian-lease-renewal-failed', { leaseId, error: String(error) }, { level: 'error' });
      }
    }
  };
  if (options.schedule) return options.schedule(tick, intervalMs);
  const worker = new Worker(new URL('../resource-ledger/guardian-host-lease-heartbeat-worker.ts', import.meta.url), {
    workerData: { leaseIds: [...leaseIds], ledgerPath: resourceLedgerPath(root), intervalMs, ttlMs },
  });
  worker.on('message', (message: unknown) => debug.log('release-loop.gate', 'guardian-lease-heartbeat', { message }));
  worker.on('error', error => debug.log('release-loop.gate', 'guardian-lease-heartbeat-worker-error', { error: String(error) }, { level: 'error' }));
  worker.unref();
  return () => { worker.postMessage('stop'); };
}

/** Fresh instances have no claims yet; initialize the ledger before a gate asks whether a host is reserved. */
export function ensureGateHostReservationDirectory(root: string): void {
  mkdirSync(claimsDir(root), { recursive: true, mode: 0o700 });
}

function claimAlive(claim: GateHostClaim): 'alive' | 'dead' | 'unknown' {
  try { process.kill(claim.pid, 0); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
  if (claim.pidStartedAt === null) return 'unknown';
  const current = psProcessStartMs(claim.pid);
  if (current === null) return 'unknown';
  return Math.abs(current - claim.pidStartedAt) <= 2_000 ? 'alive' : 'dead';
}

/** A gate owns its host until its node exits. A crashed owner's claim is removed on the next read. */
export function reserveReleaseGateHosts(root: string, runId: string, hosts: readonly string[], options: {
  purpose?: string; releaseVersion?: string; requestedBy?: string;
} = {}): () => void {
  const unique = [...new Set(hosts)];
  if (!runId || unique.some(host => host !== '*' && !hostName.test(host))) throw new Error('invalid release gate reservation');
  if (!unique.length) return () => undefined;
  if (unique.includes('*')) throw new Error('Guardian host lease cannot admit an unresolved wildcard host');
  const dir = claimsDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const pidStartedAt = psProcessStartMs(process.pid);
  if (pidStartedAt === null) throw new Error('release gate owner start time unmeasured');
  const claim: GateHostClaim = { token, runId, hosts: unique, pid: process.pid, pidStartedAt, reservedAt: Date.now() };
  const path = join(dir, `${token}.json`);
  const temp = join(dir, `.${token}.tmp`);
  const guardianLeases: string[] = [];
  let stopHeartbeat: () => void = () => undefined;
  try {
    for (const rawHost of unique) {
      const host = rawHost.split('@').at(-1)!;
      const requestId = `release-gate:${token}:${host}`;
      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      const decision = requestGuardianHostLease({ requestId, runId, requestedBy: options.requestedBy ?? 'release-loop.gate',
        consumer: 'release-gate', purpose: options.purpose ?? 'release-cut-gate', host, priority: 'P0: release gate host',
        expiresAt, ...(options.releaseVersion ? { releaseVersion: options.releaseVersion } : {}) }, new Date(), resourceLedgerPath(root));
      if (decision.state !== 'active')
        throw new Error(`Guardian denied release gate host ${host}: ${decision.reason ?? decision.state}; alternatives=${(decision.alternatives ?? []).join(',')}`);
      guardianLeases.push(decision.leaseId);
      if (!admitGuardianHostLease({ leaseId: decision.leaseId, host, runId, consumer: 'release-gate' }, new Date(), resourceLedgerPath(root)))
        throw new Error(`Guardian host lease admission failed for ${host}`);
    }
    stopHeartbeat = startGuardianHostLeaseHeartbeat(guardianLeases, root);
    writeFileSync(temp, JSON.stringify(claim) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } catch (error) {
    stopHeartbeat();
    for (const leaseId of guardianLeases) endGuardianHostLease(leaseId, 'reservation-failed', new Date(), resourceLedgerPath(root));
    throw error;
  } finally { if (existsSync(temp)) rmSync(temp); }
  debug.log('release-loop.gate', 'host-reserved', { runId, hosts: unique, pid: process.pid, path });
  return () => {
    stopHeartbeat();
    try {
      const current = JSON.parse(readFileSync(path, 'utf8')) as Partial<GateHostClaim>;
      if (current.token === token) rmSync(path);
      debug.log('release-loop.gate', 'host-released', { runId, hosts: unique, path });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        debug.log('release-loop.gate', 'host-release-unmeasured', { runId, path, error: String(error) });
    }
    for (const leaseId of guardianLeases) {
      try { endGuardianHostLease(leaseId, 'release-gate-finished', new Date(), resourceLedgerPath(root)); }
      catch (error) { debug.log('release-loop.gate', 'guardian-lease-release-unmeasured', { runId, leaseId, error: String(error) }); }
    }
  };
}

/** An unreadable claim is a reservation, never permission to enter a gate host. */
export function inspectReleaseGateHost(root: string, host: string, options: { reclaimDead?: boolean } = {}): GateHostReservation {
  const dir = claimsDir(root);
  let names: string[];
  try { names = readdirSync(dir).filter(name => name.endsWith('.json')); }
  catch (error) {
    return { status: 'unknown', reason: `reservation directory unreadable: ${String(error)}` };
  }
  for (const name of names) {
    const path = join(dir, name);
    let claim: GateHostClaim;
    try {
      claim = JSON.parse(readFileSync(path, 'utf8')) as GateHostClaim;
      if (!claim || !Array.isArray(claim.hosts) || claim.hosts.length === 0
        || !claim.hosts.every(item => typeof item === 'string' && (item === '*' || hostName.test(item)))
        || !Number.isSafeInteger(claim.pid) || claim.pid <= 0 || typeof claim.token !== 'string'
        || typeof claim.runId !== 'string' || !claim.runId
        || (claim.pidStartedAt !== null && (!Number.isSafeInteger(claim.pidStartedAt)
          || claim.pidStartedAt <= 0 || claim.pidStartedAt > Date.now()))
        || (claim.reservedAt !== undefined && (!Number.isSafeInteger(claim.reservedAt)
          || claim.reservedAt <= 0 || claim.reservedAt > Date.now()))) throw new Error('invalid claim');
    } catch (error) { return { status: 'unknown', reason: `reservation unreadable: ${name}: ${String(error)}` }; }
    const live = claimAlive(claim);
    if (live === 'dead') {
      if (options.reclaimDead !== false) {
        try { rmSync(path); } catch { /* a confirmed dead process cannot still own the host */ }
        const ageMs = claim.reservedAt === undefined ? null : Math.max(0, Date.now() - claim.reservedAt);
        const orphanedLongEnough = ageMs !== null && ageMs >= 2 * 60 * 60 * 1000;
        debug.log('release-loop.gate', orphanedLongEnough ? 'orphan-host-claim-alert' : 'host-claim-reclaimed', {
          runId: claim.runId, hosts: claim.hosts, path, pid: claim.pid, ageMs,
        }, { level: orphanedLongEnough ? 'error' : 'info' });
      }
      continue;
    }
    if (!claim.hosts.includes(host) && !claim.hosts.includes('*')) continue;
    return {
      status: live === 'unknown' ? 'unknown' : 'reserved',
      reason: `release gate ${claim.runId} holds ${host}`,
      runId: claim.runId,
      ...(claim.reservedAt !== undefined ? { reservedAt: claim.reservedAt } : {}),
    };
  }
  return { status: 'free' };
}
