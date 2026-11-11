/** Fenced warm-Pod lease bridge. The Job remains authoritative. */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dlopen, read, type Pointer } from 'bun:ffi';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { debug } from '../../debug/log.js';
import { listSchedules } from '../../release-loop/release-schedule.js';
import { allocatePodPhaseCandidates, resolvePodPhasePlan, podPhaseGateIdentityMatches,
  type PodKind, type PodPhasePrewarmConfig } from './pod-warm-switch.js';
import { getUserConfig } from '../../user-config/reader.js';
import { resolveWarmPoolProfile, resolveWarmPoolQuota, type WarmPoolProfile, type WarmPoolTier } from '../../self-implement/pod-warm-pool-profile.js';
import { WarmPodTransport, probeWarmPodContext, probeWarmPodRuntimeContract, imageReferencesDifferOnlyByDigest, warmWorkerPodManifest, type WarmPodSpec, type WarmPodTransportResult } from './pod-warm-worker-pod.js';
import { parseWarmWorkerReply, type WarmWorkerCommand } from './pod-warm-worker-protocol.js';
import { runtimeArchitecturesMatch, type RuntimeIdentityInput } from '../../runtime-identity.js';
import { resolveWarmPodPhasePlan, selectWarmPodPhaseCandidates, type WarmPodPhasePlan, type WarmPodPhaseSchedule } from './pod-warm-switch.js';
import { patchWarmLeaseMetadata, scoreWarmPodCandidates, warmLeaseMetadata, type WarmPodKind } from './pod-warm-provenance.js';
import type { LogStore } from '../../mss/logging/log-store.js';

// Cold source install on node-b exceeded five minutes; recheck the pinned Pod UID in bounded intervals.
const POD_READY_WAIT_SECONDS = 900;
const POD_READY_RECHECK_SECONDS = 300;
const POD_READY_RETRY_DELAY_MS = 1_000;
const WARM_CONTROL_REQUEST_TIMEOUT_MS = 2_000;
const WARM_POD_LIST_PAGE_SIZE = 25;
const WARM_POD_LIST_MAX_PAGES = 20;
const WARM_QUARANTINED_LABEL = 'elanous.ai/quarantined';

function throwIfPrepareAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(reason === undefined ? 'warm prepare cancelled' : String(reason));
}

function waitForPrepareRetry(signal?: AbortSignal): Promise<void> {
  throwIfPrepareAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, POD_READY_RETRY_DELAY_MS);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try { throwIfPrepareAborted(signal); } catch (error) { reject(error); }
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export type WarmReplayInput = Omit<WarmWorkerCommand, 'leaseId' | 'generation' | 'workerId' | 'key'>;
export interface WarmReplayResult { command: WarmWorkerCommand | null; transport: WarmPodTransportResult }
export interface WarmWorkerCandidate { host: string; tier: WarmPoolTier; spec: WarmPodSpec; slotCount?: number;
  /** Worker purpose is part of admission identity; untagged legacy pool entries are gate workers. */
  kind?: WarmPodKind }
export interface WarmPodDeleteOptions {
  apiVersion: 'v1'; kind: 'DeleteOptions'; preconditions: { uid: string };
}
/** The OS `flock(fd, operation)` binding the prepare lease waits on. */
export type WarmPrepareFlock = (fd: number, operation: number) => number;
export interface WarmPodProviderOptions {
  candidates: readonly WarmWorkerCandidate[];
  /** One pinned template per host/tier. It creates one candidate unless expansion is opted in. */
  poolTemplates?: readonly WarmWorkerCandidate[];
  /** Expand each pool template to its measured profile quota. Defaults to false. */
  expandPoolTemplatesToQuota?: boolean;
  /** Hosts in a drain window may finish current leases but cannot prepare or acquire warm workers. */
  drainingHosts?: readonly string[];
  /** This address is resolved by the control-plane join/primary mechanism, never guessed from a Pod context. */
  controlUrl: string;
  memberToken: string;
  /** Only the trusted producer host has these credentials; consumers may omit them. */
  machineTokens?: Readonly<Record<string, string>>;
  profileConfig?: unknown;
  /** Release calendar and phase targets are read from the same private provider config. */
  phaseSchedule?: WarmPodPhaseSchedule;
  /** Optional multi-arch image policy. Omitted means exact runtime architecture only. */
  allowedArchitectures?: readonly ('amd64' | 'arm64')[];
  /** Trusted target tuple; absent or malformed identity disables reuse. */
  runtimeIdentity?: RuntimeIdentityInput;
  leaseTtlMs?: number;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  transport?: (spec: WarmPodSpec) => Pick<WarmPodTransport, 'request'>;
  maxShadowMs?: number;
  now?: () => number;
  kubectl?: (args: readonly string[], input?: string) => {
    status: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException;
  };
  /** Private directory for cross-process prepare leases; defaults to a per-user directory under tmpdir(). */
  prepareLockDirectory?: string;
  /** Private durable slot-generation file. Set by loadWarmPodProvider for production reconciliation. */
  rotationStatePath?: string;
  /** Private durable phase fence shared by the reconciler and replay processes. */
  phaseFenceStatePath?: string;
  /** Test-only loopback API endpoint for exercising the production DeleteOptions request. */
  kubectlProxyUrlForTest?: string;
  /** Test-only quota resolver injection; omitted keeps the production measured-host table. */
  quotaResolverForTest?: typeof resolveWarmPoolQuota;
  /** Separate fetch for the Kubernetes API; control-plane calls continue using fetch. */
  kubernetesFetch?: typeof fetch;
  /** Cancels a prepare waiting for another process to finish the same host/worker slot. */
  prepareAbortSignal?: AbortSignal;
  /** Injects the prepare-lease flock binding. Omitted keeps this platform's binding; null/false declares it unsupported. */
  prepareFlock?: WarmPrepareFlock | null | false;
  /** Gate file this pool serves, used to bind cold prepare legs to their 1-file gate measurement key. */
  pairingGateFile?: string;
  /** Test-only correlation for isolated reconcile simulations. */
  observationRunIdForTest?: string;
  /** Test-only deterministic release phase inputs; production reads config and release ledger. */
  phasePrewarmForTest?: PodPhasePrewarmConfig;
  releaseSchedulesForTest?: readonly import('../../release-loop/release-schedule.js').ReleaseSchedule[];
  scheduleLookupErrorForTest?: boolean;
}
type WarmPodProviderRuntimeOverrides = Pick<WarmPodProviderOptions, 'controlUrl' | 'fetch' | 'kubectl' | 'prepareLockDirectory'>;
export interface WarmPodProviderLoadOptions {
  pairingGateFile?: string;
  runtimeOverrides?: Partial<WarmPodProviderRuntimeOverrides>;
}

export interface WarmPoolReconcileResult {
  profile: string;
  target: number;
  ready: number;
  failed: readonly string[];
}
type WarmPoolFailureDecision = { stage: string; reason: string; stderr?: string };

const WARM_POOL_STDERR_LIMIT = 512;
function safeWarmPoolStderr(stderr: string, secrets: readonly string[]): string {
  let safe = stderr;
  for (const secret of secrets.filter(value => value.length >= 8)) safe = safe.split(secret).join('[REDACTED]');
  safe = safe.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/((?:token|password|secret|api[_-]?key|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]');
  return safe.length > WARM_POOL_STDERR_LIMIT
    ? `${safe.slice(0, WARM_POOL_STDERR_LIMIT)}…[truncated]` : safe;
}

/** One leg of a read-only warm/cold prepare-time measurement pair, bound to one 1-file gate key. */
export interface WarmPreparePairLeg {
  file: string;
  commit: string;
  host: string;
  /** True when an already-standing Pod was reused; false when this leg created the Pod. */
  reuse: boolean;
  prepareDurationMs: number;
  totalDurationMs: number;
  podUid: string;
  success: boolean;
}
/** A read-only measurement row pairing the cold create and the warm reuse of the same 1-file gate. */
export interface WarmReuseTimePair {
  gateKey: string;
  file: string;
  commit: string;
  host: string;
  cold: WarmPreparePairLeg | null;
  warm: WarmPreparePairLeg | null;
}
/** The shared observation row each process emits (`pod.warm` / `warm-reuse-time-pair` in logs.db). */
export type WarmReuseTimeLegRow = WarmPreparePairLeg & { gateKey: string; leg: 'cold' | 'warm' };
const PAIR_CATEGORY = 'pod.warm';
const PAIR_EVENT = 'warm-reuse-time-pair';

function parseLegRow(value: unknown): WarmReuseTimeLegRow | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const text = (key: string) => typeof row[key] === 'string';
  const ms = (key: string) => typeof row[key] === 'number' && Number.isFinite(row[key] as number) && (row[key] as number) >= 0;
  if (!(row.leg === 'cold' || row.leg === 'warm') || !text('gateKey') || !text('file') || !row.file
    || !text('commit') || !text('host') || !text('podUid') || typeof row.reuse !== 'boolean'
    || typeof row.success !== 'boolean' || !ms('prepareDurationMs') || !ms('totalDurationMs')) return null;
  // The key must be the row's own file·commit·host; a mismatched key cannot join another gate.
  if (row.gateKey !== `${row.file}/${row.commit}/${row.host}`) return null;
  return row as unknown as WarmReuseTimeLegRow;
}

/** Pure read-only join: oldest→newest leg rows into one pair per 1-file gate key (newest leg wins). */
export function pairWarmReuseTimeLegs(rows: readonly unknown[]): WarmReuseTimePair[] {
  const pairs = new Map<string, WarmReuseTimePair>();
  for (const value of rows) {
    const row = parseLegRow(value);
    if (!row) continue;
    const { gateKey, leg, ...measured } = row;
    const pair = pairs.get(gateKey) ?? { gateKey, file: row.file, commit: row.commit, host: row.host, cold: null, warm: null };
    pair[leg] = { file: measured.file, commit: measured.commit, host: measured.host, reuse: measured.reuse,
      prepareDurationMs: measured.prepareDurationMs, totalDurationMs: measured.totalDurationMs,
      podUid: measured.podUid, success: measured.success };
    pairs.set(gateKey, pair);
  }
  return [...pairs.values()];
}

/** Read-only measurement rows from the logs.db both the cold CLI and the warm gate process write. */
export function readWarmReuseTimePairs(store: Pick<LogStore, 'queryAll'>, opts: { sinceMs?: number } = {}): WarmReuseTimePair[] {
  const rows = store.queryAll({ exactCategories: [PAIR_CATEGORY], events: [PAIR_EVENT],
    ...(opts.sinceMs !== undefined ? { sinceMs: opts.sinceMs } : {}) });
  // queryAll is newest-first; replay oldest-first so the newest leg per key wins.
  return pairWarmReuseTimeLegs(rows.slice().reverse().map(row => {
    try { return row.data ? JSON.parse(row.data) : null; } catch { return null; }
  }));
}

const fallback = (reason: 'no-candidate' | 'lease-unavailable'): WarmReplayResult =>
  ({ command: null, transport: { status: 'fallback', reason, reply: null } });
const keyEquals = (left: WarmPodSpec['key'], right: WarmPodSpec['key']) =>
  left.context === right.context && left.imageDigest === right.imageDigest
  && left.lockHash === right.lockHash && left.architecture === right.architecture;

function withObservedPodImagePin(spec: WarmPodSpec, pod: any): WarmPodSpec | null {
  const expectedTemplate = warmWorkerPodManifest(spec).spec as any;
  const expectedImages = [...expectedTemplate.initContainers, ...expectedTemplate.containers].map((row: any) => row.image);
  const observedImages = [...(pod?.spec?.initContainers ?? []), ...(pod?.spec?.containers ?? [])].map((row: any) => row?.image);
  if (expectedImages.length === observedImages.length && expectedImages.every((image: string, index: number) => image === observedImages[index]))
    return spec;
  if (!imageReferencesDifferOnlyByDigest(expectedImages, observedImages)) return null;
  const workerImage = pod?.spec?.containers?.find((row: any) => row?.name === 'worker')?.image;
  const parsed = typeof workerImage === 'string' ? /^(.*)@(sha256:[a-f0-9]{64})$/.exec(workerImage) : null;
  if (!parsed || observedImages.some((image: unknown) => image !== workerImage)
    || pod?.metadata?.annotations?.['elanous.dev/warm-image-digest'] !== parsed[2]
    || pod?.spec?.containers?.find((row: any) => row?.name === 'worker')?.env
      ?.find((row: any) => row?.name === 'WARM_IMAGE_DIGEST')?.value !== parsed[2]) return null;
  return { ...spec, image: workerImage, key: { ...spec.key, imageDigest: parsed[2]! } };
}
const token = (value: string | undefined): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const workerId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value);

function checkedPrivateDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && info.uid !== process.getuid()))
    throw new Error('unsafe warm prepare lock directory');
}

const prepareLockLib = process.platform === 'linux' || process.platform === 'darwin'
  ? dlopen(process.platform === 'linux' ? 'libc.so.6' : 'libSystem.B.dylib', {
    flock: { args: ['int', 'int'], returns: 'int' },
    [process.platform === 'linux' ? '__errno_location' : '__error']: { args: [], returns: 'ptr' },
  }) : null;
const prepareFlock: WarmPrepareFlock | null = prepareLockLib?.symbols.flock ?? null;
const prepareErrnoLocation = prepareLockLib?.symbols[process.platform === 'linux' ? '__errno_location' : '__error'];
const readPrepareErrno = (): number => (prepareErrnoLocation ? read.i32(prepareErrnoLocation() as Pointer) : -1);
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const PREPARE_LOCK_WAIT_MS = (POD_READY_WAIT_SECONDS * 1_000) + 30_000;

async function withPrepareLease<T>(candidate: WarmWorkerCandidate, directory: string | undefined,
  work: () => Promise<T>, signal?: AbortSignal, flock?: WarmPrepareFlock | null): Promise<T | null> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
  const root = directory ?? join(tmpdir(), `elanous-warm-prepare-${uid}`);
  const identity = createHash('sha256').update(`${candidate.host}/${candidate.spec.workerId}`).digest('hex');
  let fd: number | undefined;
  let acquired = false;
  try {
    checkedPrivateDirectory(root);
    const lock = join(root, `${identity}.flock`);
    fd = openSync(lock, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
    const info = lstatSync(lock);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0)
      throw new Error('unsafe warm prepare lock file');
    if (!flock) throw new Error('warm prepare OS locks are unavailable on this platform');
    const lockDeadline = performance.now() + PREPARE_LOCK_WAIT_MS;
    while (!acquired) {
      if (signal?.aborted) throw new Error('warm prepare lock wait cancelled');
      if (flock(fd, LOCK_EX | LOCK_NB) === 0) { acquired = true; break; }
      const errno = readPrepareErrno();
      // EWOULDBLOCK/EAGAIN: Linux 11, Darwin 35. EINTR is safe to retry.
      if (errno !== 11 && errno !== 35 && errno !== 4)
        throw new Error(`warm prepare flock failed (errno ${errno})`);
      if (performance.now() >= lockDeadline) throw new Error('warm prepare lock wait timed out');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, Math.min(20, Math.max(1, lockDeadline - performance.now())));
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('warm prepare lock wait cancelled')); };
        function done() { signal?.removeEventListener('abort', abort); resolve(); }
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return await work();
  } catch (error) {
    debug.log('pod.warm', 'prepare-lease-failed', { host: candidate.host,
      workerId: candidate.spec.workerId, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    throw error;
  } finally {
    if (acquired && fd !== undefined) flock?.(fd, LOCK_UN);
    if (fd !== undefined) closeSync(fd);
  }
}

export class WarmPodProvider {
  private readonly fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly candidates: WarmWorkerCandidate[];
  private readonly profile: WarmPoolProfile;
  /** This process's own legs, echoed on CLI stdout. Pairing never reads this — see readWarmReuseTimePairs. */
  private readonly legs: WarmReuseTimeLegRow[] = [];
  /** One terminal transition per fenced lease, including concurrent callers. Failed transitions remain retryable. */
  private readonly terminalLeases = new Map<string, Promise<'sanitized' | 'quarantined'>>();
  /** Exact leases whose runtime returned `complete` after whitelist cleanup and residue verification. */
  private readonly cleanupVerifiedLeases = new Set<string>();
  /** A gate fallback supersedes an in-flight sanitize even if its control reply is late. */
  private readonly quarantineRequested = new Set<string>();
  /** Worker IDs with a terminal quarantine request are never selected again by this provider. */
  private readonly quarantineBlockedWorkerIds = new Set<string>();
  /** A failed private-state write disables all warm selections until this provider is replaced. */
  private warmReuseDisabled = false;
  private readonly terminalEndLogged = new Set<string>();
  /** Leases observed at the provider boundary; used only to report transition deltas. */
  private readonly observedOccupancyLeases = new Map<string, { candidate: WarmWorkerCandidate; runId: string | null }>();
  /** Pod identities returned by this provider's bounded prepare/readiness path. */
  private readonly observedPodUids = new Map<string, string>();
  /** Runtime-compatible existing image pins are separate from the configured recreate target. */
  private readonly observedImagePins = new Map<string, WarmPodSpec>();
  /** While quarantine is settling, reject only that Pod incarnation after acquisition. */
  private readonly quarantiningPods = new Set<string>();
  private readonly standingWorkers = new Map<string, Promise<boolean>>();
  private lastPhaseObservationKey = '';
  /** Failed gate prewarms stay unavailable through the gate window for the same immutable cut identity. */
  private readonly phasePrepareFailures = new Map<string, string>();
  private phaseGateIdentityKey = '';
  /** This instance's prepare-lease flock binding; null means the platform cannot lock and every slot fails. */
  private readonly prepareFlock: WarmPrepareFlock | null;
  /** Quarantine-state synchronization uses the real platform lock, independent of prepare test injection. */
  private readonly quarantineStateFlock: WarmPrepareFlock | null;
  private readonly quotaResolver: typeof resolveWarmPoolQuota;
  private readonly configuredDrainingHosts = new Set<string>();
  private readonly phaseUnavailableHosts = new Set<string>();
  private readonly phaseFenceStatePath?: string;
  private phaseFencePersistenceFailed = false;
  constructor(private readonly options: WarmPodProviderOptions) {
    const url = new URL(options.controlUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || !token(options.memberToken)) throw new Error('invalid warm control address');
    if (options.allowedArchitectures !== undefined
      && (!Array.isArray(options.allowedArchitectures)
        || options.allowedArchitectures.some(arch => arch !== 'amd64' && arch !== 'arm64')
        || new Set(options.allowedArchitectures).size !== options.allowedArchitectures.length))
      throw new Error('invalid warm Pod allowed architectures');
    this.quotaResolver = options.quotaResolverForTest ?? resolveWarmPoolQuota;
    this.phaseFenceStatePath = options.phaseFenceStatePath;
    for (const host of options.drainingHosts ?? []) this.configuredDrainingHosts.add(host);
    const profile = resolveWarmPoolProfile(options.profileConfig ?? getUserConfig());
    this.profile = profile;
    const templates = options.poolTemplates ?? [];
    const templateKinds = new Map<string, Set<PodKind | undefined>>();
    for (const candidate of templates) {
      const slot = `${candidate.host}/${candidate.tier}`;
      const kinds = templateKinds.get(slot) ?? new Set<PodKind | undefined>();
      if (kinds.has(candidate.kind) || kinds.has(undefined) || candidate.kind === undefined && kinds.size > 0)
        throw new Error('duplicate warm pool template kind or untyped host/tier slot');
      kinds.add(candidate.kind);
      templateKinds.set(slot, kinds);
    }
    const templateSlots = templates.map(candidate => {
      const measuredQuota = this.quotaResolver(profile, candidate.host, candidate.tier);
      if (!Number.isSafeInteger(measuredQuota) || measuredQuota < 1) throw new Error('unmeasured warm pool template');
      const quota = candidate.slotCount ?? measuredQuota;
      if (!quota || !Number.isSafeInteger(quota) || quota < 1 || !candidate.spec.nodeName) throw new Error('unmeasured warm pool template');
      if (quota > measuredQuota) throw new Error('warm candidate quota exceeded');
      return { candidate, quota, slots: candidate.slotCount !== undefined || options.expandPoolTemplatesToQuota === true ? quota : 1 };
    });
    const requestedByHost = new Map<string, number>();
    for (const row of templateSlots) requestedByHost.set(row.candidate.host, (requestedByHost.get(row.candidate.host) ?? 0) + row.slots);
    for (const [host, requested] of requestedByHost) {
      const measuredHostQuotas = (['lite', 'standard'] as const)
        .map(tier => this.quotaResolver(profile, host, tier))
        .filter((quota): quota is number => Number.isSafeInteger(quota) && quota > 0);
      if (measuredHostQuotas.length === 0) throw new Error('unmeasured warm pool host');
      if (requested > Math.max(...measuredHostQuotas)) throw new Error('warm candidate quota exceeded');
    }
    const expanded = templateSlots.flatMap(({ candidate, slots }) => {
      return Array.from({ length: slots }, (_, index): WarmWorkerCandidate => ({
        host: candidate.host, tier: candidate.tier, ...(candidate.kind ? { kind: candidate.kind } : {}),
        spec: {
          ...candidate.spec,
          name: `warm-${candidate.host}-${candidate.tier}-${candidate.kind ? `${candidate.kind}-` : ''}${index + 1}`,
          // The template worker ID is a generation token. Rotate it when a slot is quarantined.
          workerId: `${candidate.spec.workerId}-${candidate.kind ? `${candidate.kind}-` : ''}${candidate.tier}-${index + 1}`,
        },
      }));
    });
    this.candidates = [...options.candidates.map(row => ({ ...row, spec: { ...row.spec } })), ...expanded];
    if (options.rotationStatePath) {
      const rotations = this.readRotations(options.rotationStatePath);
      this.warmReuseDisabled = this.readWarmReuseDisabled(options.rotationStatePath);
      if (!this.warmReuseDisabled)
        for (const id of this.readQuarantinedWorkerIds(options.rotationStatePath)) this.quarantineBlockedWorkerIds.add(id);
      for (const row of this.candidates) {
        const rotated = rotations[`${row.host}/${row.spec.name}`];
        if (rotated) row.spec = { ...row.spec, workerId: rotated };
      }
    }
    if (this.candidates.some(candidate => !workerId(candidate.spec.workerId)
      || !candidate.host.trim() || !Number.isSafeInteger(this.quotaResolver(profile, candidate.host, candidate.tier))
      || this.quotaResolver(profile, candidate.host, candidate.tier) < 1
      || candidate.spec.memoryLimit !== (candidate.tier === 'lite' ? '2Gi' : '16Gi')
      || !warmWorkerPodManifest(candidate.spec))) throw new Error('invalid warm candidate');
    if (new Set(this.candidates.map(candidate => candidate.spec.workerId)).size !== this.candidates.length)
      throw new Error('duplicate warm worker ID');
    const names = new Set<string>();
    const counts = new Map<string, number>();
    for (const candidate of this.candidates) {
      const identity = `${candidate.spec.kubectlContext}/${candidate.spec.namespace}/${candidate.spec.name}`;
      if (names.has(identity)) throw new Error('duplicate warm Pod name');
      names.add(identity);
      const slot = `${candidate.host}/${candidate.tier}`;
      const count = (counts.get(slot) ?? 0) + 1;
      if (count > this.quotaResolver(profile, candidate.host, candidate.tier))
        throw new Error('warm candidate quota exceeded');
      counts.set(slot, count);
    }
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    // An omitted option keeps the platform binding; an explicit false/null declares flock unsupported.
    this.prepareFlock = options.prepareFlock === undefined ? prepareFlock
      : options.prepareFlock === false ? null : options.prepareFlock;
    this.quarantineStateFlock = prepareFlock;
  }

  private async control(path: string, credential: string, body?: Record<string, unknown>): Promise<{ status: number; value: any }> {
    const response = await this.fetcher(new URL(path, this.options.controlUrl), {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${credential}`,
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
    });
    let value: any = null;
    try { value = await response.json(); } catch { /* A missing body is a failed admission. */ }
    if (response.status === 404 || response.status === 503) {
      const runId = typeof body?.runId === 'string' ? body.runId : this.observationRunId();
      debug.log('pod.warm.provider', 'control-http-failure', { runId, method: body ? 'POST' : 'GET', path,
        status: response.status }, { level: 'warn' });
    }
    return { status: response.status, value };
  }

  private syncPhaseFailureScope(plan?: WarmPodPhasePlan): void {
    const key = plan?.gateIdentity ? JSON.stringify(plan.gateIdentity) : '';
    if (key !== this.phaseGateIdentityKey) {
      this.phasePrepareFailures.clear();
      this.phaseGateIdentityKey = key;
    }
  }

  private async controlBounded(path: string, credential: string, body: Record<string, unknown> | undefined,
    timeoutMs: number): Promise<{ status: number; value: any }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.control(path, credential, body), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('warm control request timed out')), timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /** The child owns kubectl. Timeout terminates only this child process group and fences its lease. */
  private async runTransport(spec: WarmPodSpec, command: WarmWorkerCommand): Promise<WarmPodTransportResult> {
    if (this.options.transport) return this.options.transport(spec).request(command);
    const budget = Math.min(command.deadlineAt - this.now(), this.options.maxShadowMs ?? 120_000);
    if (!Number.isFinite(budget) || budget < 1) return { status: 'fallback', reason: 'exec-failed', reply: null };
    const directory = mkdtempSync(join(tmpdir(), 'elanous-warm-provider-'));
    const path = join(directory, 'request.json');
    try {
      writeFileSync(path, JSON.stringify({ spec, command }), { mode: 0o600, flag: 'wx' });
      return await new Promise<WarmPodTransportResult>((resolve) => {
        const child = spawn(process.execPath,
          [fileURLToPath(new URL('./pod-warm-worker-pod.ts', import.meta.url)), '--shadow-request', path],
          { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
        let stdout = '';
        let settled = false;
        let stopped = false;
        const finish = (result: WarmPodTransportResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const stop = () => {
          if (stopped) return;
          stopped = true;
          // Kill the whole group, including a kubectl child that ignores SIGTERM.
          if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
        };
        const timer = setTimeout(stop, budget);
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (stdout.length > 64 * 1024 * 1024) stop();
        });
        child.stderr?.on('data', () => { /* Drain without revealing Pod output or credentials. */ });
        child.on('error', () => { stop(); finish({ status: 'fallback', reason: 'exec-failed', reply: null }); });
        child.on('close', (code) => {
          if (stopped) { finish({ status: 'fallback', reason: 'exec-failed', reply: null }); return; }
          try {
            const parsed = JSON.parse(stdout) as WarmPodTransportResult;
            if ((code === 0 || code === 2) && parsed
              && (parsed.status === 'observed' || parsed.status === 'fallback')) finish(parsed);
            else { stop(); finish({ status: 'fallback', reason: 'exec-failed', reply: null }); }
          } catch { stop(); finish({ status: 'fallback', reason: 'exec-failed', reply: null }); }
        });
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  private runtimeSpec(candidate: WarmWorkerCandidate): WarmPodSpec {
    return this.observedImagePins.get(candidate.spec.workerId) ?? candidate.spec;
  }

  /** Emit one measurement leg into the shared logs.db row the other process's leg joins. */
  private recordPair(leg: 'cold' | 'warm', file: string, commit: string, host: string,
    row: Omit<WarmPreparePairLeg, 'file' | 'commit' | 'host'>): void {
    const legRow: WarmReuseTimeLegRow = { gateKey: `${file}/${commit}/${host}`, leg, file, commit, host, ...row };
    this.legs.push(legRow);
    debug.log(PAIR_CATEGORY, PAIR_EVENT, legRow, { level: 'info' });
  }

  /** The legs this process emitted (stdout echo only — pairing is readWarmReuseTimePairs over logs.db). */
  warmReuseTimeLegs(): readonly WarmReuseTimeLegRow[] { return [...this.legs]; }

  /** Prepare one named slot. A foreign or replaced Pod is never deleted. */
  async ensureStandingWorker(candidate: WarmWorkerCandidate,
    onFailure?: (decision: WarmPoolFailureDecision) => void): Promise<boolean> {
    if (this.options.drainingHosts?.includes(candidate.host)) return false;
    const configured = this.candidates.find(row => row.host === candidate.host
      && row.spec.workerId === candidate.spec.workerId);
    if (!configured) return false;
    const key = `${configured.host}/${configured.spec.workerId}`;
    const inFlight = this.standingWorkers.get(key);
    if (inFlight) {
      const ready = await inFlight;
      if (!ready) onFailure?.({ stage: 'prepare', reason: 'decision-unavailable' });
      return ready;
    }
    const preparation = withPrepareLease(configured, this.options.prepareLockDirectory,
      () => this.prepareStandingWorker(configured, this.options.prepareAbortSignal, onFailure), this.options.prepareAbortSignal,
      this.prepareFlock)
      .then(result => result === true);
    this.standingWorkers.set(key, preparation);
    try { return await preparation; }
    finally { if (this.standingWorkers.get(key) === preparation) this.standingWorkers.delete(key); }
  }

  private async prepareStandingWorker(candidate: WarmWorkerCandidate, signal?: AbortSignal,
    onFailure?: (decision: WarmPoolFailureDecision) => void): Promise<boolean> {
    throwIfPrepareAborted(signal);
    const startingWorkerId = candidate.spec.workerId;
    const startedAt = this.now();
    const outcome: { preexisting: boolean; podUid: string | null } = { preexisting: false, podUid: null };
    let decision: WarmPoolFailureDecision | undefined;
    let ok = await this.coldPrepare(candidate, outcome, signal, value => { decision = value; });
    if (!ok && decision?.reason === 'runtime-contract-mismatch' && outcome.podUid) {
      try {
        if (await this.retireIncompatibleRuntimeWorker(candidate, outcome.podUid)) {
          outcome.preexisting = false;
          outcome.podUid = null;
          decision = undefined;
          ok = await this.coldPrepare(candidate, outcome, signal, value => { decision = value; });
        }
      } catch (error) {
        debug.log('pod.warm', 'runtime-contract-reap-deferred', { host: candidate.host,
          workerId: candidate.spec.workerId, podUid: outcome.podUid,
          reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
      }
    }
    // Expiry alone never authorizes reuse or deletion. The primary ledger atomically
    // changes only the matching expired idle UID to `reaping` before the normal UID-pinned reaper runs.
    if (!ok && decision?.reason === 'idle-ttl-expired' && await this.expireIdleWorker(candidate))
      decision = { stage: 'lease-registration', reason: 'quarantined-pod-needs-reap' };
    // Reaping is only relevant when normal, bounded reconciliation has found
    // this exact Pod and its ledger proves that its generation is fenced.
    // Empty slots must take the ordinary cold-create path without a namespace
    // dump or a preflight recovery request.
    if (!ok && decision?.reason === 'quarantined-pod-needs-reap') {
      try {
        if (await this.reapQuarantinedWorker(candidate)) {
          outcome.preexisting = false;
          outcome.podUid = null;
          decision = undefined;
          ok = await this.coldPrepare(candidate, outcome, signal, value => { decision = value; });
        }
      } catch (error) {
        debug.log('pod.warm', 'quarantine-reap-failed', { host: candidate.host,
          workerId: candidate.spec.workerId,
          reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
      }
    }
    if (!ok) onFailure?.(decision ?? { stage: 'prepare', reason: 'decision-unavailable' });
    if (candidate.spec.workerId !== startingWorkerId) this.observedPodUids.delete(startingWorkerId);
    if (outcome.podUid) this.observedPodUids.set(candidate.spec.workerId, outcome.podUid);
    else this.observedPodUids.delete(candidate.spec.workerId);
    const totalDurationMs = this.now() - startedAt;
    const gateFile = this.options.pairingGateFile;
    // An unset gate file skips the measurement row entirely instead of recording an unpaired one.
    if (gateFile) this.recordPair('cold', gateFile, candidate.spec.cutSha, candidate.host,
      { reuse: outcome.preexisting, prepareDurationMs: outcome.preexisting ? 0 : totalDurationMs,
        totalDurationMs, podUid: outcome.podUid ?? '', success: ok });
    return ok;
  }

  private readRotations(path: string): Record<string, string> {
    if (!existsSync(path)) return {};
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error('unsafe warm rotation state');
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.entries(parsed).some(([slot, id]) => !slot.includes('/') || typeof id !== 'string' || !workerId(id)))
      throw new Error('invalid warm rotation state');
    return parsed as Record<string, string>;
  }

  private readQuarantinedWorkerIds(rotationPath: string): string[] {
    const path = `${rotationPath}.quarantined`;
    if (!existsSync(path)) return [];
    const info = lstatSync(path);
    const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0)
      throw new Error('unsafe warm quarantine state');
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed) || parsed.some(id => !workerId(id)) || new Set(parsed).size !== parsed.length)
      throw new Error('invalid warm quarantine state');
    return parsed as string[];
  }

  private readWarmReuseDisabled(rotationPath: string): boolean {
    const path = `${rotationPath}.disabled`;
    if (!existsSync(path)) return false;
    const info = lstatSync(path);
    const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0)
      throw new Error('unsafe warm provider disable state');
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || (parsed as { disabled?: unknown }).disabled !== true) throw new Error('invalid warm provider disable state');
    return true;
  }

  private persistQuarantinedWorkerIds(): void {
    const rotationPath = this.options.rotationStatePath;
    if (!rotationPath) return;
    const path = `${rotationPath}.quarantined`;
    if (!this.quarantineStateFlock) throw new Error('warm quarantine state lock is unavailable');
    const lockPath = `${rotationPath}.lock`;
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const info = lstatSync(lockPath);
      const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0
        || this.quarantineStateFlock(fd, LOCK_EX) !== 0) throw new Error('unsafe warm quarantine state lock');
      for (const id of this.readQuarantinedWorkerIds(rotationPath)) this.quarantineBlockedWorkerIds.add(id);
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify([...this.quarantineBlockedWorkerIds].sort()), { mode: 0o600, flag: 'wx' });
      const temporaryFd = openSync(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { fsyncSync(temporaryFd); } finally { closeSync(temporaryFd); }
      try {
        renameSync(temporary, path);
        const directoryFd = openSync(dirname(path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      } catch (error) { rmSync(temporary, { force: true }); throw error; }
    } finally {
      this.quarantineStateFlock(fd, LOCK_UN);
      closeSync(fd);
    }
  }

  private persistWarmReuseDisabled(): void {
    const rotationPath = this.options.rotationStatePath;
    if (!rotationPath || !this.quarantineStateFlock) throw new Error('warm provider disable state is not writable');
    const path = `${rotationPath}.disabled`;
    const lockPath = `${rotationPath}.lock`;
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const info = lstatSync(lockPath);
      const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0
        || this.quarantineStateFlock(fd, LOCK_EX) !== 0) throw new Error('unsafe warm provider disable state lock');
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ disabled: true }), { mode: 0o600, flag: 'wx' });
      const temporaryFd = openSync(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { fsyncSync(temporaryFd); } finally { closeSync(temporaryFd); }
      try {
        renameSync(temporary, path);
        const directoryFd = openSync(dirname(path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      } catch (error) { rmSync(temporary, { force: true }); throw error; }
    } finally {
      this.quarantineStateFlock(fd, LOCK_UN);
      closeSync(fd);
    }
  }

  private refreshQuarantineState(): void {
    if (this.warmReuseDisabled) return;
    if (!this.options.rotationStatePath) {
      this.warmReuseDisabled = true;
      debug.log('pod.warm.provider', 'quarantine-state-read-failed', {
        reason: 'warm quarantine state is not configured',
      }, { level: 'warn' });
      return;
    }
    let fd: number | undefined;
    try {
      if (!this.quarantineStateFlock) throw new Error('warm quarantine state lock is unavailable');
      const lockPath = `${this.options.rotationStatePath}.lock`;
      fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
      const info = lstatSync(lockPath);
      const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0
        || this.quarantineStateFlock(fd, LOCK_EX) !== 0) throw new Error('unsafe warm quarantine state lock');
      const probe = `${this.options.rotationStatePath}.probe.${process.pid}.${randomUUID()}`;
      const probeTemporary = `${probe}.tmp`;
      try {
        writeFileSync(probeTemporary, '{}', { mode: 0o600, flag: 'wx' });
        renameSync(probeTemporary, probe);
      } finally {
        rmSync(probeTemporary, { force: true });
        rmSync(probe, { force: true });
      }
      if (this.readWarmReuseDisabled(this.options.rotationStatePath)) {
        this.warmReuseDisabled = true;
        return;
      }
      for (const id of this.readQuarantinedWorkerIds(this.options.rotationStatePath)) this.quarantineBlockedWorkerIds.add(id);
    } catch (error) {
      this.warmReuseDisabled = true;
      debug.log('pod.warm.provider', 'quarantine-state-read-failed', {
        reason: error instanceof Error ? error.message : String(error),
      }, { level: 'warn' });
    } finally {
      if (fd !== undefined) {
        this.quarantineStateFlock?.(fd, LOCK_UN);
        closeSync(fd);
      }
    }
  }

  private recordQuarantineBlock(workerId: string): void {
    this.quarantineBlockedWorkerIds.add(workerId);
    if (!this.options.rotationStatePath) {
      debug.log('pod.warm.provider', 'quarantine-worker-block-unpersisted', {
        workerId, reason: 'rotation-state-not-configured',
      }, { level: 'warn' });
      return;
    }
    try {
      this.persistQuarantinedWorkerIds();
    }
    catch (error) {
      this.warmReuseDisabled = true;
      let markerError: unknown;
      try { this.persistWarmReuseDisabled(); } catch (persistError) { markerError = persistError; }
      debug.log('pod.warm.provider', 'quarantine-worker-block-persist-failed', {
        workerId, reason: error instanceof Error ? error.message : String(error),
        ...(markerError ? { disableMarkerError: markerError instanceof Error ? markerError.message : String(markerError) } : {}),
      }, { level: 'warn' });
    }
  }

  private writeRotation(slot: string, id: string): void {
    const path = this.options.rotationStatePath;
    if (!path) throw new Error('warm rotation state is not configured');
    if (!this.prepareFlock) throw new Error('warm rotation state lock is unavailable');
    const lockPath = `${path}.lock`;
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const info = lstatSync(lockPath);
      const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0
        || this.prepareFlock(fd, LOCK_EX) !== 0) throw new Error('unsafe warm rotation state lock');
      const rotations = this.readRotations(path);
      rotations[slot] = id;
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(rotations), { mode: 0o600, flag: 'wx' });
      const temporaryFd = openSync(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { fsyncSync(temporaryFd); } finally { closeSync(temporaryFd); }
      try {
        renameSync(temporary, path);
        const directoryFd = openSync(dirname(path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      }
      catch (error) { rmSync(temporary, { force: true }); throw error; }
    } finally {
      this.prepareFlock(fd, LOCK_UN);
      closeSync(fd);
    }
  }

  private readPhaseFence(): Set<string> {
    const path = this.phaseFenceStatePath;
    if (!path || !existsSync(path)) throw new Error('warm phase fence state unavailable');
    const info = lstatSync(path);
    const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0)
      throw new Error('unsafe warm phase fence state');
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || (parsed as { schema?: unknown }).schema !== 1
      || !Array.isArray((parsed as { workerIds?: unknown }).workerIds)
      || (parsed as { workerIds: unknown[] }).workerIds.some(id => typeof id !== 'string' || !workerId(id)))
      throw new Error('invalid warm phase fence state');
    return new Set((parsed as { workerIds: string[] }).workerIds);
  }

  private writePhaseFence(workerIds: readonly string[]): void {
    const path = this.phaseFenceStatePath;
    if (!path) return;
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schema: 1, workerIds: [...new Set(workerIds)].sort() }),
      { mode: 0o600, flag: 'wx' });
    try {
      const temporaryFd = openSync(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { fsyncSync(temporaryFd); } finally { closeSync(temporaryFd); }
      renameSync(temporary, path);
      const directoryFd = openSync(dirname(path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch (error) { rmSync(temporary, { force: true }); throw error; }
  }

  private async deletePodWithUid(spec: WarmPodSpec, uid: string): Promise<boolean> {
    const deleteOptions: WarmPodDeleteOptions = {
      apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid },
    };
    const proxyUrl = this.options.kubectlProxyUrlForTest;
    const path = `/api/v1/namespaces/${encodeURIComponent(spec.namespace)}/pods/${encodeURIComponent(spec.name)}`;
    const acceptPath = `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    // Keep the random-port, loopback proxy alive only for this request and expose only this Pod DELETE path.
    const child = proxyUrl ? null : spawn('kubectl', ['--context', spec.kubectlContext, '-n', spec.namespace,
      'proxy', '--address=127.0.0.1', '--port=0', `--accept-paths=${acceptPath}`],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exitPromise: Promise<void> | null = null;
    try {
      let baseUrl = proxyUrl;
      if (!child) {
        if (!baseUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw new Error('invalid test Kubernetes API URL');
      } else {
        const port = await new Promise<number>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('kubectl proxy start timed out')), 10_000);
          const inspect = (chunk: Buffer | string) => {
            output += String(chunk);
            const match = output.match(/127\.0\.0\.1:(\d+)/);
            if (match) { if (timer) clearTimeout(timer); resolve(Number(match[1])); }
          };
          child.stdout.on('data', inspect);
          child.stderr.on('data', inspect);
          child.once('error', reject);
          child.once('exit', (code, signal) => reject(new Error(`kubectl proxy exited (${code ?? signal})`)));
        });
        exitPromise = new Promise(resolve => child.once('exit', () => resolve()));
        baseUrl = `http://127.0.0.1:${port}`;
      }
      const response = await (this.options.kubernetesFetch ?? this.fetcher)(`${baseUrl}${path}`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(deleteOptions), signal: AbortSignal.timeout(15_000),
      });
      return response.ok;
    } finally {
      if (timer) clearTimeout(timer);
      child?.kill('SIGTERM');
      if (exitPromise) await Promise.race([exitPromise, new Promise(resolve => setTimeout(resolve, 1_000))]);
    }
  }

  private kubectlForSpec(spec: WarmPodSpec, args: readonly string[]) {
    const fullArgs = ['--context', spec.kubectlContext, '-n', spec.namespace, ...args];
    try {
      if (this.options.kubectl) return this.options.kubectl(fullArgs);
      const env = { ...process.env };
      for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[name];
      const result = spawnSync('kubectl', fullArgs, { encoding: 'utf8', env, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
    } catch (error) {
      return { status: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Kubernetes is the shared quarantine authority; missing or uncertain Pods cannot be leased. */
  private readClusterQuarantineState(candidate: WarmWorkerCandidate): 'available' | 'missing' | 'quarantined' | 'unavailable' {
    const spec = this.runtimeSpec(candidate);
    // kubectl get does not expose the Kubernetes ListOptions limit/continue flags.
    // Use the raw API for real clusters, while the injected boundary keeps its
    // small fake-kubectl command contract.
    const observed = this.kubectlForSpec(spec, this.options.kubectl
      ? ['get', 'pods', '-l', `elanous.kind=warm-worker,${WARM_QUARANTINED_LABEL}!=true`,
        `--field-selector=metadata.name=${spec.name}`, '--limit=25', '-o', 'json']
      : ['get', '--raw', `/api/v1/namespaces/${encodeURIComponent(spec.namespace)}/pods?${new URLSearchParams({
        labelSelector: `elanous.kind=warm-worker,${WARM_QUARANTINED_LABEL}!=true`,
        fieldSelector: `metadata.name=${spec.name}`, limit: '25',
      })}`]);
    if (observed.status !== 0) {
      return /notfound|not found|does not exist|pod missing/i.test(observed.stderr) ? 'missing' : 'unavailable';
    }
    try {
      const listing = JSON.parse(observed.stdout);
      if (!Array.isArray(listing?.items)) return 'unavailable';
      const pod = listing.items.find((row: any) => row?.metadata?.name === spec.name);
      if (!pod) return 'missing';
      if (pod?.metadata?.name !== spec.name || pod?.metadata?.namespace !== spec.namespace
        || typeof pod?.metadata?.uid !== 'string' || !pod.metadata.uid || pod.metadata.deletionTimestamp)
        return 'unavailable';
      return 'available';
    } catch { return 'unavailable'; }
  }

  /** Mark the exact Pod incarnation in Kubernetes so every provider observes the same quarantine. */
  private markClusterQuarantined(candidate: WarmWorkerCandidate, podUid: string): { ok: boolean; reason: string } {
    const spec = this.runtimeSpec(candidate);
    const observed = this.kubectlForSpec(spec, ['get', 'pod', spec.name, '-o', 'json']);
    if (observed.status !== 0) return { ok: false, reason: 'pod-read-failed' };
    let pod: any;
    try { pod = JSON.parse(observed.stdout); } catch { return { ok: false, reason: 'pod-read-invalid' }; }
    const metadata = pod?.metadata;
    if (metadata?.name !== spec.name || metadata?.namespace !== spec.namespace || metadata?.uid !== podUid
      || typeof metadata?.resourceVersion !== 'string' || !metadata.resourceVersion
      || !metadata.labels || typeof metadata.labels !== 'object' || Array.isArray(metadata.labels))
      return { ok: false, reason: 'pod-identity-drift' };
    if (metadata.labels[WARM_QUARANTINED_LABEL] === 'true') return { ok: true, reason: 'already-quarantined' };
    const patch = [
      { op: 'test', path: '/metadata/uid', value: podUid },
      { op: 'test', path: '/metadata/resourceVersion', value: metadata.resourceVersion },
      { op: 'add', path: '/metadata/labels/elanous.ai~1quarantined', value: 'true' },
    ];
    const result = this.kubectlForSpec(spec, ['patch', 'pod', spec.name, '--type=json', '-p', JSON.stringify(patch), '-o', 'json']);
    if (result.status !== 0) return { ok: false, reason: 'conditional-patch-failed' };
    try {
      const updated = JSON.parse(result.stdout);
      return updated?.metadata?.uid === podUid && updated?.metadata?.labels?.[WARM_QUARANTINED_LABEL] === 'true'
        ? { ok: true, reason: 'applied' } : { ok: false, reason: 'patch-result-mismatch' };
    } catch { return { ok: false, reason: 'patch-result-invalid' }; }
  }

  private async expireIdleWorker(candidate: WarmWorkerCandidate): Promise<boolean> {
    const { host } = candidate;
    const spec = this.runtimeSpec(candidate);
    const credential = this.options.machineTokens?.[host];
    if (!token(credential)) return false;
    const query = new URLSearchParams({ kind: 'pod-worker-lease', machine: host, name: spec.workerId });
    try {
      const observed = await this.controlBounded(`/v1/resources?${query}`, credential, undefined,
        WARM_CONTROL_REQUEST_TIMEOUT_MS);
      const rows = observed.status === 200 && Array.isArray(observed.value?.resources)
        ? observed.value.resources : null;
      const row = rows?.length === 1 ? rows[0] : null;
      if (!row || row.kind !== 'pod-worker-lease' || row.machine !== host || row.name !== spec.workerId
        || row.attrs?.state !== 'idle' || row.attrs?.podUid == null || !row.attrs?.key
        || !keyEquals(row.attrs.key, spec.key) || !Number.isSafeInteger(row.observedAt)
        || !Number.isSafeInteger(row.ttlMs) || row.ttlMs <= 0
        || row.attrs.idleTtlMs !== row.ttlMs || this.now() < row.observedAt + row.ttlMs) return false;
      const expired = await this.controlBounded(`/v1/leases/pod-worker/${encodeURIComponent(spec.workerId)}/expire`,
        credential, { podUid: row.attrs.podUid, expectedObservedAt: row.observedAt,
          expectedExpiresAtMs: row.observedAt + row.ttlMs }, WARM_CONTROL_REQUEST_TIMEOUT_MS);
      return expired.status === 200 && expired.value?.attrs?.state === 'reaping'
        && expired.value?.attrs?.podUid === row.attrs.podUid;
    } catch { return false; }
  }

  /** Delete only a UID-pinned Pod whose ledger row proves quarantine and has no competing lease. */
  private async reapQuarantinedWorker(candidate: WarmWorkerCandidate, allowImageDrift = false): Promise<boolean> {
    const { host, tier, spec } = candidate;
    const credential = this.options.machineTokens?.[host];
    const observeRefusal = (reason: string) => debug.log('pod.warm', 'quarantine-reap-refused', {
      host, workerId: spec.workerId, pod: spec.name, reason,
    }, { level: 'warn' });
    if (!token(credential) || !this.options.rotationStatePath) {
      observeRefusal('rotation-state-or-credential-unavailable');
      return false;
    }
    const kubectl = (args: readonly string[]) => this.options.kubectl
      ? this.options.kubectl(['--context', spec.kubectlContext, '-n', spec.namespace, ...args])
      : spawnSync('kubectl', ['--context', spec.kubectlContext, '-n', spec.namespace, ...args],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    const parse = (result: { status: number | null; stdout: string }) => {
      if (result.status !== 0) return null;
      try { return JSON.parse(result.stdout) as any; } catch { return null; }
    };
    const readPods = (query: URLSearchParams) => {
      if (this.options.kubectl) {
        const selector = query.get('fieldSelector')
          ? [`--field-selector=${query.get('fieldSelector')}`]
          : ['-l', query.get('labelSelector')!];
        const continuation = query.get('continue');
        return kubectl(['get', 'pods', ...selector, `--limit=${WARM_POD_LIST_PAGE_SIZE}`, '-o', 'json',
          ...(continuation ? [`--continue=${continuation}`] : [])]);
      }
      return kubectl(['get', '--raw', `/api/v1/namespaces/${encodeURIComponent(spec.namespace)}/pods?${query}`]);
    };
    const exactResult = readPods(new URLSearchParams({ fieldSelector: `metadata.name=${spec.name}`,
      limit: String(WARM_POD_LIST_PAGE_SIZE) }));
    const exact = parse(exactResult);
    if (!Array.isArray(exact?.items) || exact.items.length > 1) {
      observeRefusal('exact-pod-lookup-unavailable'); return false;
    }
    const exactPod = exact.items.find((pod: any) => pod?.metadata?.name === spec.name);
    const listedPods: any[] = [];
    const seenContinuations = new Set<string>();
    let continuation: string | undefined;
    for (let page = 0; page < WARM_POD_LIST_MAX_PAGES; page++) {
      const query = new URLSearchParams({ labelSelector: 'elanous.kind=warm-worker',
        limit: String(WARM_POD_LIST_PAGE_SIZE), ...(continuation ? { continue: continuation } : {}) });
      const result = parse(readPods(query));
      if (!Array.isArray(result?.items) || !result.metadata || typeof result.metadata !== 'object'
        || Array.isArray(result.metadata) || result.items.length > WARM_POD_LIST_PAGE_SIZE) {
        observeRefusal('pod-list-page-unavailable'); return false;
      }
      listedPods.push(...result.items);
      const next = result.metadata.continue;
      if (next === undefined || next === '') { continuation = undefined; break; }
      if (typeof next !== 'string' || seenContinuations.has(next)) {
        observeRefusal('pod-list-page-token-invalid'); return false;
      }
      seenContinuations.add(next);
      continuation = next;
    }
    if (continuation) { observeRefusal('pod-list-page-cap-reached'); return false; }
    const matches = [exactPod, ...listedPods].filter((pod: any) => pod?.metadata?.name === spec.name
      || pod?.metadata?.annotations?.['elanous.dev/warm-worker-id'] === spec.workerId);
    const uniqueMatches = [...new Map(matches.map((pod: any) => [`${pod?.metadata?.name}/${pod?.metadata?.uid ?? ''}`, pod])).values()];
    if (uniqueMatches.length === 0) {
      // Recover a crash after successful deletion but before the durable ID rotation.
      const query = new URLSearchParams({ kind: 'pod-worker-lease' });
      try {
        const response = await this.controlBounded(`/v1/resources?${query}`, credential, undefined,
          WARM_CONTROL_REQUEST_TIMEOUT_MS);
        const rows = response.status === 200 && Array.isArray(response.value?.resources) ? response.value.resources : null;
        const own = rows?.filter((row: any) => row?.name === spec.workerId) ?? [];
        // Empty slots are the normal cold-create path, not failed quarantine recovery.
        if (rows && own.length === 0) return false;
        const prior = own.length === 1 ? own[0] : null;
        const uid = prior?.attrs?.podUid;
        if (rows && prior?.kind === 'pod-worker-lease' && prior.machine === host && typeof uid === 'string'
          && prior.attrs?.state === 'reaping'
          && !rows.some((row: any) => row !== prior && row?.attrs?.podUid === uid)) {
          const nextId = `reap-${randomUUID().replaceAll('-', '')}`;
          this.writeRotation(`${host}/${spec.name}`, nextId);
          this.observedImagePins.delete(spec.workerId);
          candidate.spec = { ...spec, workerId: nextId };
          debug.log('pod.warm', 'quarantine-reap-recovered', { host, tier, workerId: spec.workerId,
            nextWorkerId: nextId, pod: spec.name, podUid: uid });
          return true;
        }
      } catch { /* Uncertain state remains unavailable. */ }
      observeRefusal('pod-absence-or-quarantine-unproven');
      return false;
    }
    if (uniqueMatches.length !== 1) { observeRefusal('ambiguous-pod-identity'); return false; }
    const pod = uniqueMatches[0];
    const identitySpec = allowImageDrift ? withObservedPodImagePin(spec, pod) : spec;
    if (!identitySpec) { observeRefusal('image-reference-mismatch'); return false; }
    const manifest = warmWorkerPodManifest(identitySpec);
    const expectedMetadata = manifest.metadata as { labels: Record<string, string>; annotations: Record<string, string> };
    const uid = pod?.metadata?.uid;
    if (pod?.metadata?.name !== spec.name || pod?.metadata?.namespace !== spec.namespace
      || typeof uid !== 'string' || !uid || !pod.metadata.resourceVersion || pod.metadata.deletionTimestamp
      || pod.metadata.ownerReferences?.length || pod.spec?.nodeName !== spec.nodeName
      || pod.metadata.labels?.['elanous.kind'] !== 'warm-worker'
      || pod.metadata.annotations?.['elanous.dev/warm-worker-id'] !== spec.workerId
      || Object.entries(expectedMetadata.labels).some(([key, value]) => pod.metadata.labels?.[key] !== value)
      || Object.entries(expectedMetadata.annotations).some(([key, value]) => pod.metadata.annotations?.[key] !== value)
      || pod.spec?.containers?.find((row: any) => row?.name === 'worker')?.image !== identitySpec.image
      || pod.spec?.containers?.[0]?.resources?.limits?.memory !== spec.memoryLimit) {
      observeRefusal('pod-identity-unproven');
      return false;
    }
    const query = new URLSearchParams({ kind: 'pod-worker-lease' });
    let response: { status: number; value: any };
    try { response = await this.controlBounded(`/v1/resources?${query}`, credential, undefined,
      WARM_CONTROL_REQUEST_TIMEOUT_MS); }
    catch { observeRefusal('lease-ledger-unavailable'); return false; }
    const rows = response.status === 200 && Array.isArray(response.value?.resources) ? response.value.resources : null;
    const own = rows?.filter((row: any) => row?.name === spec.workerId) ?? [];
    const ledger = own.length === 1 ? own[0] : null;
    if (!rows || !ledger || ledger.kind !== 'pod-worker-lease' || ledger.machine !== host
      || ledger.attrs?.podUid !== uid
      || !['quarantined', 'timeout-fenced', 'reaping'].includes(ledger.attrs?.state)
      || rows.some((row: any) => row !== ledger && row?.attrs?.podUid === uid)) {
      observeRefusal('lease-or-identity-unproven');
      return false;
    }
    let reservation: { status: number; value: any };
    try {
      reservation = await this.controlBounded(`/v1/leases/pod-worker/${encodeURIComponent(spec.workerId)}/reap`,
        credential, { podUid: uid }, WARM_CONTROL_REQUEST_TIMEOUT_MS);
    } catch { observeRefusal('reap-reservation-unavailable'); return false; }
    if (reservation.status !== 200 || reservation.value?.attrs?.state !== 'reaping'
      || reservation.value?.attrs?.podUid !== uid) {
      observeRefusal('reap-reservation-refused');
      return false;
    }
    let deleted: boolean;
    try { deleted = await this.deletePodWithUid(spec, uid); }
    catch { deleted = false; }
    if (!deleted) { observeRefusal('uid-precondition-delete-failed'); return false; }
    const after = parse(readPods(new URLSearchParams({ fieldSelector: `metadata.name=${spec.name}`,
      limit: String(WARM_POD_LIST_PAGE_SIZE) })));
    if (!Array.isArray(after?.items) || after.items.some((row: any) => row?.metadata?.name === spec.name)) {
      observeRefusal('pod-removal-unconfirmed');
      return false;
    }
    const nextId = `reap-${randomUUID().replaceAll('-', '')}`;
    const slot = `${host}/${spec.name}`;
    this.writeRotation(slot, nextId);
    this.observedImagePins.delete(spec.workerId);
    candidate.spec = { ...spec, workerId: nextId };
    debug.log('pod.warm', 'quarantine-reaped', { host, tier, workerId: spec.workerId,
      nextWorkerId: nextId, pod: spec.name, podUid: uid });
    return true;
  }

  /** Fence and reap only the incompatible runtime's exact idle Pod UID. */
  private async retireIncompatibleRuntimeWorker(candidate: WarmWorkerCandidate, expectedUid: string): Promise<boolean> {
    const { host, spec } = candidate;
    const credential = this.options.machineTokens?.[host];
    if (!token(credential) || !this.options.rotationStatePath) return false;
    const result = this.options.kubectl
      ? this.options.kubectl(['--context', spec.kubectlContext, '-n', spec.namespace, 'get', 'pod', spec.name, '-o', 'json'])
      : spawnSync('kubectl', ['--context', spec.kubectlContext, '-n', spec.namespace, 'get', 'pod', spec.name, '-o', 'json'],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    if (result.status !== 0) return false;
    let pod: any;
    try { pod = JSON.parse(result.stdout); } catch { return false; }
    const identitySpec = withObservedPodImagePin(spec, pod);
    if (!identitySpec || identitySpec === spec
      || pod?.metadata?.name !== spec.name || pod.metadata.namespace !== spec.namespace
      || pod.metadata.uid !== expectedUid || !pod.metadata.resourceVersion || pod.metadata.deletionTimestamp
      || pod.metadata.ownerReferences?.length || pod.spec?.nodeName !== spec.nodeName) return false;
    const metadata = (warmWorkerPodManifest(identitySpec) as any).metadata;
    if (Object.entries(metadata.labels).some(([key, value]: [string, any]) => pod.metadata.labels?.[key] !== value)
      || Object.entries(metadata.annotations).some(([key, value]: [string, any]) => pod.metadata.annotations?.[key] !== value)
      || probeWarmPodRuntimeContract(spec, (args, input) => this.options.kubectl
        ? this.options.kubectl(['--context', spec.kubectlContext, '-n', spec.namespace, ...args], input)
        : spawnSync('kubectl', ['--context', spec.kubectlContext, '-n', spec.namespace, ...args],
          { encoding: 'utf8', input, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }))
        .status !== 'incompatible') return false;
    const retired = await this.controlBounded(`/v1/leases/pod-worker/${encodeURIComponent(spec.workerId)}/retire`,
      credential, { podUid: expectedUid, reason: 'runtime-contract-mismatch' }, WARM_CONTROL_REQUEST_TIMEOUT_MS);
    if (retired.status !== 200 || retired.value?.attrs?.state !== 'quarantined'
      || retired.value?.attrs?.podUid !== expectedUid || retired.value?.attrs?.reason !== 'runtime-contract-mismatch')
      return false;
    return this.reapQuarantinedWorker(candidate, true);
  }

  /** Retire only a ledger-idle Pod whose UID still matches; active work is left for normal finalize. */
  private async retireDrainedWorker(candidate: WarmWorkerCandidate): Promise<boolean> {
    const { host } = candidate;
    const spec = this.runtimeSpec(candidate);
    this.observedPodUids.delete(spec.workerId);
    const credential = this.options.machineTokens?.[host];
    if (!token(credential) || !this.options.rotationStatePath) return false;
    const kubectl = (args: readonly string[]) => this.options.kubectl
      ? this.options.kubectl(['--context', spec.kubectlContext, '-n', spec.namespace, ...args])
      : spawnSync('kubectl', ['--context', spec.kubectlContext, '-n', spec.namespace, ...args],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    const pod = kubectl(['get', 'pod', spec.name, '-o', 'json']);
    if (pod.status !== 0) return /notfound|not found/i.test(pod.stderr);
    let value: any;
    try { value = JSON.parse(pod.stdout); } catch { return false; }
    const uid = value?.metadata?.uid;
    if (typeof uid !== 'string' || !uid) return false;
    this.observedPodUids.set(spec.workerId, uid);
    const retired = await this.controlBounded(`/v1/leases/pod-worker/${encodeURIComponent(spec.workerId)}/retire`,
      credential, { podUid: uid }, WARM_CONTROL_REQUEST_TIMEOUT_MS);
    if (retired.status !== 200) return false; // leased, stale UID, or control-plane uncertainty: never delete.
    const reapCandidate = { ...candidate, spec };
    if (await this.reapQuarantinedWorker(reapCandidate)) {
      this.observedImagePins.delete(spec.workerId);
      candidate.spec = { ...candidate.spec, workerId: reapCandidate.spec.workerId };
      return true;
    }
    return false;
  }

  private async coldPrepare(candidate: WarmWorkerCandidate,
    outcome: { preexisting: boolean; podUid: string | null }, signal?: AbortSignal,
    onFailure?: (decision: WarmPoolFailureDecision) => void): Promise<boolean> {
    const credentialValues = [this.options.memberToken, ...Object.values(this.options.machineTokens ?? {}),
      ...Object.entries(process.env).filter(([name]) => /TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY|AUTH/i.test(name))
        .map(([, value]) => value ?? '')];
    const fail = (stage: string, reason: string, stderr = ''): false => {
      onFailure?.({ stage, reason, ...(stderr ? { stderr: safeWarmPoolStderr(stderr, credentialValues) } : {}) });
      if (stage === 'pod-exact-lookup' || stage === 'pod-label-page') {
        const listReason = reason === 'invalid-pod-list' || reason === 'invalid-pod-list-page'
          ? 'malformed-output' : reason === 'kubectl-output-limit' ? 'output-too-large' : 'kubectl-failed';
        debug.log('pod.warm', 'warm-pod-list-skipped', { reason: listReason }, { level: 'warn' });
      }
      return false;
    };
    const configured = this.candidates.find(row => row.host === candidate.host
      && row.spec.workerId === candidate.spec.workerId && row.spec.cutSha === candidate.spec.cutSha
      && keyEquals(row.spec.key, candidate.spec.key));
    // Legacy slot warm-HOST and numbered profile slots can coexist during migration.
    const prefix = configured ? `warm-${configured.host}` : '';
    const suffix = configured?.spec.name.startsWith(`${prefix}-`)
      ? configured.spec.name.slice(prefix.length + 1) : '';
    if (!configured || !configured.spec.nodeName
      || (configured.spec.name !== prefix && !/^[1-9][0-9]*$/.test(suffix)
        && !/^(lite|standard)-[1-9][0-9]*$/.test(suffix)
        && !/^(lite|standard)-(gate|implementation)-[1-9][0-9]*$/.test(suffix))
      || candidate.spec.name !== configured.spec.name || candidate.spec.nodeName !== configured.spec.nodeName)
      return fail('slot-validation', 'candidate-mismatch');
    throwIfPrepareAborted(signal);
    let spec = configured.spec;
    const { host } = configured;
    const nodeName = spec.nodeName;
    if (!nodeName) return fail('slot-validation', 'node-unpinned');
    const credential = this.options.machineTokens?.[host];
    if (!token(credential)) return fail('slot-validation', 'machine-credential-unavailable');
    let manifest = warmWorkerPodManifest(spec);
    let metadata = manifest.metadata as { labels: Record<string, string>; annotations: Record<string, string> };
    let template = manifest.spec as Record<string, unknown>;
    const kubectl = (args: readonly string[], input?: string): { status: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException } => {
      const argv = ['--context', spec.kubectlContext, '-n', spec.namespace, ...args];
      if (this.options.kubectl) {
        try { return this.options.kubectl(argv, input); }
        catch (error) {
          return { status: null, stdout: '', stderr: '', error: (error instanceof Error ? error : new Error(String(error))
            ) as NodeJS.ErrnoException };
        }
      }
      const env = { ...process.env };
      for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[name];
      // A new standing worker can spend more than five minutes in its cold init
      // containers. argv[0..3] is context/namespace; argv[4] is the verb.
      // Keep the process deadline beyond kubectl's Ready deadline.
      const result = spawnSync('kubectl', argv, { encoding: 'utf8', input, env,
        timeout: argv[4] === 'wait' ? (POD_READY_WAIT_SECONDS + 30) * 1000 : 360_000,
        maxBuffer: 2 * 1024 * 1024 });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
        error: result.error };
    };
    const parse = (result: { status: number | null; stdout: string }) => {
      if (result.status !== 0) return null;
      try { return JSON.parse(result.stdout) as any; } catch { return null; }
    };
    const isOutputLimit = (result: { stderr?: string; error?: NodeJS.ErrnoException }) =>
      result.error?.code === 'ENOBUFS'
      || /maxBuffer|ENOBUFS|buffer length/i.test([result.stderr, result.error?.message].filter(Boolean).join('\n'));
    const podListPage = (selector: { name?: string; continuation?: string }) => {
      if (this.options.kubectl) {
        const args = selector.name
          ? ['get', 'pods', `--field-selector=metadata.name=${selector.name}`, '-o', 'json']
          : ['get', 'pods', '-l', 'elanous.kind=warm-worker', `--limit=${WARM_POD_LIST_PAGE_SIZE}`, '-o', 'json',
            ...(selector.continuation ? [`--continue=${selector.continuation}`] : [])];
        return kubectl(args);
      }
      const query = new URLSearchParams({
        ...(selector.name ? { fieldSelector: `metadata.name=${selector.name}` } : { labelSelector: 'elanous.kind=warm-worker' }),
        limit: String(WARM_POD_LIST_PAGE_SIZE),
        ...(selector.continuation ? { continue: selector.continuation } : {}),
      });
      const path = `/api/v1/namespaces/${encodeURIComponent(spec.namespace)}/pods?${query}`;
      return kubectl(['get', '--raw', path]);
    };
    const sameSpec = (actual: unknown, expected: unknown): boolean => {
      if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length
        && expected.every((item, index) => sameSpec(actual[index], item));
      if (expected && typeof expected === 'object') return !!actual && typeof actual === 'object'
        && !Array.isArray(actual)
        && Object.keys(actual).length === Object.keys(expected).length
        && Object.entries(expected).every(([key, value]) =>
          sameSpec((actual as Record<string, unknown>)[key], value));
      return actual === expected;
    };
    const normalizedSpec = (actual: any, allowImagePinDrift = false): Record<string, unknown> | null => {
      if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return null;
      const podSpec = { ...actual };
      const defaults: Record<string, unknown> = { dnsPolicy: 'ClusterFirst', serviceAccountName: 'default',
        serviceAccount: 'default', schedulerName: 'default-scheduler', terminationGracePeriodSeconds: 30,
        enableServiceLinks: true, priority: 0, preemptionPolicy: 'PreemptLowerPriority' };
      for (const [key, value] of Object.entries(defaults)) if (podSpec[key] === value) delete podSpec[key];
      const defaultTolerations = [
        { effect: 'NoExecute', key: 'node.kubernetes.io/not-ready', operator: 'Exists', tolerationSeconds: 300 },
        { effect: 'NoExecute', key: 'node.kubernetes.io/unreachable', operator: 'Exists', tolerationSeconds: 300 },
      ];
      if (sameSpec(podSpec.tolerations, defaultTolerations)) delete podSpec.tolerations;
      for (const kind of ['containers', 'initContainers']) {
        if (!Array.isArray(podSpec[kind])) return null;
        podSpec[kind] = podSpec[kind].map((container: any, index: number) => {
          if (!container || typeof container !== 'object' || Array.isArray(container)) return container;
          const copy = { ...container };
          // Image bytes are not the reuse key; actual runtime compatibility is probed below.
          copy.image = (template[kind] as Record<string, unknown>[])[index]?.image;
          if (allowImagePinDrift && kind === 'containers' && Array.isArray(copy.env)) {
            const expectedEnv = ((template[kind] as Record<string, any>[])[index]?.env ?? []) as any[];
            copy.env = copy.env.map((entry: any) => entry?.name === 'WARM_IMAGE_DIGEST'
              ? { ...entry, value: expectedEnv.find(wanted => wanted?.name === 'WARM_IMAGE_DIGEST')?.value } : entry);
          }
          if (copy.terminationMessagePath === '/dev/termination-log') delete copy.terminationMessagePath;
          if (copy.terminationMessagePolicy === 'File') delete copy.terminationMessagePolicy;
          const expected = (template[kind] as Record<string, unknown>[])[index];
          if (expected && !('resources' in expected) && copy.resources
            && typeof copy.resources === 'object' && Object.keys(copy.resources).length === 0) delete copy.resources;
          return copy;
        });
      }
      return podSpec;
    };
    const matches = (pod: any, allowImagePinDrift = false): boolean => typeof pod?.metadata?.uid === 'string' && !!pod.metadata.uid
      && pod.metadata.name === spec.name && pod.metadata.namespace === spec.namespace
      && !pod.metadata.deletionTimestamp
      && (pod.metadata.ownerReferences === undefined || (Array.isArray(pod.metadata.ownerReferences)
        && pod.metadata.ownerReferences.length === 0))
      && Object.entries(metadata.labels).every(([key, value]) => pod.metadata.labels?.[key] === value)
      && Object.entries(metadata.annotations).every(([key, value]) => allowImagePinDrift && key === 'elanous.dev/warm-image-digest'
        ? true : pod.metadata.annotations?.[key] === value)
      && pod.spec?.nodeName === nodeName
      && sameSpec(normalizedSpec(pod.spec, allowImagePinDrift), template);
    // Exact-name lookup finds the pinned candidate. A separate label query is
    // paged so physical quota accounting never needs a namespace-wide dump.
    const exactResult = kubectl(this.options.kubectl
      ? ['get', 'pods', `--field-selector=metadata.name=${spec.name}`, '-o', 'json']
      : ['get', '--raw', `/api/v1/namespaces/${encodeURIComponent(spec.namespace)}/pods?${new URLSearchParams({
        fieldSelector: `metadata.name=${spec.name}`, limit: String(WARM_POD_LIST_PAGE_SIZE),
      })}`]);
    if (exactResult.status !== 0) {
      const detail = [exactResult.stderr, 'error' in exactResult ? exactResult.error : ''].filter(Boolean).join('\n');
      return fail('pod-exact-lookup', isOutputLimit(exactResult)
        ? 'kubectl-output-limit' : 'kubectl-failed', detail);
    }
    const exact = parse(exactResult);
    if (!Array.isArray(exact?.items)) return fail('pod-exact-lookup', 'invalid-pod-list');
    const exactPod = exact.items.find((row: any) => row?.metadata?.name === spec.name);
    const listed: any[] = [];
    const seenContinuations = new Set<string>();
    let continuation: string | undefined;
    for (let page = 0; page < WARM_POD_LIST_MAX_PAGES; page++) {
      const pageResult = podListPage({ continuation });
      if (pageResult.status !== 0) {
        const detail = [pageResult.stderr, 'error' in pageResult ? pageResult.error : ''].filter(Boolean).join('\n');
        const reason = isOutputLimit(pageResult) ? 'kubectl-output-limit' : 'kubectl-failed';
        return fail('pod-label-page', reason, detail);
      }
      const result = parse(pageResult);
      if (!Array.isArray(result?.items) || !result.metadata || typeof result.metadata !== 'object'
        || Array.isArray(result.metadata)) return fail('pod-label-page', 'invalid-pod-list-page');
      if (result.items.length > WARM_POD_LIST_PAGE_SIZE) return fail('pod-label-page', 'pod-list-page-over-cap');
      listed.push(...result.items);
      const next = result.metadata?.continue;
      if (next === undefined || next === '') { continuation = undefined; break; }
      if (typeof next !== 'string' || seenContinuations.has(next)) return fail('pod-label-page', 'pod-list-page-token-invalid');
      seenContinuations.add(next);
      continuation = next;
    }
    if (continuation) return fail('pod-label-page', 'pod-list-page-cap-reached');
    // Read the complete label-selected set: a Pod for this host on another node
    // must block creation, and warm Pods on the pinned node count against quota.
    const hostPods = [exactPod, ...listed].filter((row: any) => !!row && (row?.metadata?.name === spec.name
      || row?.metadata?.annotations?.['elanous.dev/warm-worker-id'] === spec.workerId));
    const uniqueHostPods = [...new Map(hostPods.map((row: any) => [`${row?.metadata?.name}/${row?.metadata?.uid ?? ''}`, row])).values()];
    if (uniqueHostPods.length > 1) return fail('pod-list', 'pod-list-over-cap');
    let pod = uniqueHostPods[0];
    const preexisting = !!pod;
    outcome.preexisting = preexisting;
    if (!pod) this.observedImagePins.delete(spec.workerId);
    if (pod) {
      const adoptedSpec = withObservedPodImagePin(spec, pod);
      const imageDrift = adoptedSpec !== spec;
      if (!imageDrift) this.observedImagePins.delete(spec.workerId);
      if (!adoptedSpec || (imageDrift && !matches(pod, true)) || (!imageDrift && !matches(pod))) {
        const actualMemory = pod.spec?.containers?.[0]?.resources?.limits?.memory;
        const reason = actualMemory !== spec.memoryLimit ? 'profile-mismatch'
          : !adoptedSpec && (() => {
            const expectedImages = [...(template.initContainers as any[]), ...(template.containers as any[])].map(row => row.image);
            const observedImages = [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])].map((row: any) => row?.image);
            return expectedImages.length !== observedImages.length || expectedImages.some((image, index) => image !== observedImages[index]);
          })() ? 'image-reference-mismatch' : 'candidate-pod-mismatch';
        outcome.podUid = typeof pod.metadata?.uid === 'string' ? pod.metadata.uid : null;
        return fail('pod-validation', reason);
      }
      if (imageDrift) {
        const compatibility = probeWarmPodRuntimeContract(spec, kubectl);
        debug.log('pod.warm', compatibility.status === 'compatible' ? 'image-drift' : 'image-drift-refused', {
          host, workerId: spec.workerId, podUid: pod.metadata.uid,
          ...(this.options.observationRunIdForTest ? { runId: this.options.observationRunIdForTest } : {}),
          expectedImage: spec.image, observedImage: adoptedSpec.image,
          runtimeContract: compatibility.observed ?? null, result: compatibility.status,
        }, { level: compatibility.status === 'compatible' ? 'info' : 'warn' });
        if (compatibility.status !== 'compatible') {
          outcome.podUid = typeof pod.metadata?.uid === 'string' ? pod.metadata.uid : null;
          return fail('runtime-contract', compatibility.status === 'incompatible'
            ? 'runtime-contract-mismatch' : 'runtime-contract-unverified');
        }
        // Keep the real Pod pin in the lease and command key. Source checkout is
        // already pinned by cutSha/lockHash; the image is only its runtime shell.
        this.observedImagePins.set(spec.workerId, adoptedSpec);
        spec = adoptedSpec;
        manifest = warmWorkerPodManifest(spec);
        metadata = manifest.metadata as { labels: Record<string, string>; annotations: Record<string, string> };
        template = manifest.spec as Record<string, unknown>;
        if (!matches(pod)) {
          outcome.podUid = typeof pod.metadata?.uid === 'string' ? pod.metadata.uid : null;
          return fail('pod-validation', 'candidate-pod-mismatch');
        }
      }
    }
    // Old generations still occupy memory even when their ledger rows are quarantined.
    // Count physical warm Pods on the pinned node before admitting a new one.
    const physical = listed.filter((row: any) => row?.metadata?.labels?.['elanous.kind'] === 'warm-worker'
      && row?.spec?.nodeName === nodeName && !row?.metadata?.deletionTimestamp
      && row?.status?.phase !== 'Succeeded' && row?.status?.phase !== 'Failed'
      && row?.spec?.containers?.[0]?.resources?.limits?.memory === spec.memoryLimit).length;
    if (!preexisting && physical >= this.quotaResolver(this.profile, host, configured.tier)) {
      debug.log('pod.warm', 'pool-slot-refused', { host, tier: configured.tier,
        workerId: spec.workerId, reason: 'physical-quota', physical }, { level: 'warn' });
      return fail('pod-list', 'physical-quota');
    }
    const readLedger = async (): Promise<any[] | { error: string } | null> => {
      try {
        const query = new URLSearchParams({ kind: 'pod-worker-lease', machine: host, name: spec.workerId });
        const ledger = await this.controlBounded(`/v1/resources?${query}`, credential, undefined,
          WARM_CONTROL_REQUEST_TIMEOUT_MS);
        if (ledger.status === 403 && ledger.value?.error === 'machine-scope')
          return { error: 'machine-token-scope-mismatch' };
        return ledger.status === 200 && Array.isArray(ledger.value?.resources)
          && ledger.value.resources.length <= 1 ? ledger.value.resources : null;
      } catch { return null; }
    };
    if (!pod) {
      // A worker ID already bound to another UID must not leave a newly created, unregistered Pod.
      const before = await readLedger();
      throwIfPrepareAborted(signal);
      if (before && !Array.isArray(before)) return fail('lease-preflight', before.error);
      if (!before || before.length !== 0) return fail('lease-preflight', 'lease-unavailable');
      const createResult = kubectl(['create', '-f', '-', '-o', 'json'], JSON.stringify(manifest));
      if (createResult.status !== 0) {
        const detail = [createResult.stderr, 'error' in createResult ? createResult.error : ''].filter(Boolean).join('\n');
        const reason = /maxBuffer|ENOBUFS|buffer length/i.test(detail) ? 'kubectl-output-limit' : 'kubectl-create-denied';
        return fail('pod-create', reason, detail);
      }
      pod = parse(createResult);
      if (!matches(pod)) return fail('pod-create', 'created-pod-mismatch');
    }
    const uid = pod.metadata.uid as string;
    outcome.podUid = uid;
    const ready = (value: any) => matches(value) && value.metadata.uid === uid
      && value.status?.phase === 'Running'
      && value.status?.conditions?.some((row: any) => row.type === 'Ready' && row.status === 'True');
    const deadline = this.now() + POD_READY_WAIT_SECONDS * 1000;
    let isReady = false;
    while (this.now() < deadline) {
      const remainingSeconds = Math.ceil((deadline - this.now()) / 1000);
      const waitSeconds = Math.min(POD_READY_RECHECK_SECONDS, remainingSeconds);
      throwIfPrepareAborted(signal);
      kubectl(['wait', `pod/${spec.name}`, '--for=condition=Ready', `--timeout=${waitSeconds}s`]);
      throwIfPrepareAborted(signal);
      const observed = parse(kubectl(['get', `pod/${spec.name}`, '-o', 'json']));
      throwIfPrepareAborted(signal);
      if (ready(observed)) { isReady = true; break; }
      if (!matches(observed) || observed.metadata.uid !== uid) return fail('pod-ready', 'pod-replaced-or-mismatched');
      if (this.now() < deadline) await waitForPrepareRetry(signal);
    }
    if (!isReady) return fail('pod-ready', 'ready-deadline-exceeded');
    // Re-read after create: a registration racing the preflight must fail before our POST.
    const rows = await readLedger();
    if (rows && !Array.isArray(rows)) return fail('lease-registration', rows.error);
    if (!rows) return fail('lease-registration', 'lease-read-failed');
    const existing = rows[0];
    const leaseTtlMs = this.options.leaseTtlMs ?? 30 * 60_000;
    if (existing?.kind === 'pod-worker-lease' && existing.machine === host && existing.name === spec.workerId
      && existing.attrs?.podUid === uid
      && ['quarantined', 'timeout-fenced', 'reaping'].includes(existing.attrs?.state))
      return fail('lease-registration', 'quarantined-pod-needs-reap');
    const sameRegisteredIdle = preexisting && existing?.kind === 'pod-worker-lease'
      && existing.machine === host && existing.name === spec.workerId && existing.attrs?.state === 'idle'
      && existing.attrs?.podUid === uid && existing.attrs?.key && keyEquals(existing.attrs.key, spec.key)
      && Number.isSafeInteger(existing.observedAt) && Number.isSafeInteger(existing.ttlMs)
      && existing.ttlMs > 0 && existing.attrs?.idleTtlMs === existing.ttlMs
      && existing.observedAt <= this.now();
    if (existing && sameRegisteredIdle && this.now() - existing.observedAt >= existing.ttlMs)
      return fail('lease-registration', 'idle-ttl-expired');
    if (existing) return preexisting && existing.kind === 'pod-worker-lease'
      && existing.machine === host && existing.name === spec.workerId
      && (existing.attrs?.state === 'idle' || existing.attrs?.state === 'leased')
      && existing.attrs?.podUid === uid
      && Number.isSafeInteger(existing.observedAt) && Number.isSafeInteger(existing.ttlMs)
      && existing.ttlMs > 0 && existing.attrs?.idleTtlMs === existing.ttlMs
      && existing.observedAt <= this.now()
      && this.now() - existing.observedAt < existing.ttlMs
      && existing.attrs?.key && keyEquals(existing.attrs.key, spec.key);
    // An unregistered Pod could have been created by anyone with namespace access.
    // Only this invocation's successful create response may become a new ledger row.
    if (preexisting) return fail('lease-registration', 'preexisting-pod-unregistered');
    throwIfPrepareAborted(signal);
    let registered: { status: number; value: any };
    try {
      registered = await this.control('/v1/workers/pod', credential, {
        workerId: spec.workerId, machine: host, podUid: uid, key: spec.key,
        ttlMs: leaseTtlMs,
      });
    } catch { return fail('lease-registration', 'worker-registration-failed'); }
    if (registered.status === 403 && registered.value?.error === 'machine-scope')
      return fail('lease-registration', 'machine-token-scope-mismatch');
    if (!(registered.status === 200 && registered.value?.name === spec.workerId
      && registered.value?.attrs?.state === 'idle'
      && registered.value?.attrs?.podUid === uid
      && !!registered.value.attrs.key && keyEquals(registered.value.attrs.key, spec.key)))
      return fail('lease-registration', 'worker-registration-rejected');
    return true;
  }

  async prepareWorker(workerId: string): Promise<boolean> {
    const candidate = this.candidates.find(row => row.spec.workerId === workerId);
    if (!candidate) return false;
    return this.ensureStandingWorker(candidate);
  }

  private observationRunId(fallbackRunId?: string): string | null {
    const runId = this.options.observationRunIdForTest ?? fallbackRunId ?? process.env.ELANOUS_RUN_ID;
    return typeof runId === 'string' && runId.trim() ? runId : null;
  }

  private async readOccupancyLeaseState(candidate: WarmWorkerCandidate, podUid: string | null): Promise<'idle' | 'leased' | null> {
    const spec = this.runtimeSpec(candidate);
    if (!podUid) return null;
    const credential = this.options.machineTokens?.[candidate.host];
    if (!token(credential)) return null;
    const query = new URLSearchParams({ kind: 'pod-worker-lease', machine: candidate.host,
      name: spec.workerId });
    try {
      const response = await this.controlBounded(`/v1/resources?${query}`, credential, undefined,
        WARM_CONTROL_REQUEST_TIMEOUT_MS);
      if (response.status !== 200 || !Array.isArray(response.value?.resources)
        || response.value.resources.length > 1) return null;
      if (response.value.resources.length === 0) return null;
      const row = response.value.resources[0];
      if (row?.kind !== 'pod-worker-lease' || row.machine !== candidate.host || row.name !== spec.workerId
        || !['idle', 'leased'].includes(row.attrs?.state)
        || typeof row.attrs?.podUid !== 'string' || !row.attrs.podUid || row.attrs.podUid !== podUid || !row.attrs?.key
        || !keyEquals(row.attrs.key, spec.key)
        || !Number.isSafeInteger(row.observedAt) || !Number.isSafeInteger(row.ttlMs) || row.ttlMs <= 0
        || row.observedAt > this.now() || this.now() - row.observedAt >= row.ttlMs) return null;
      return row.attrs.state;
    } catch { return null; }
  }

  private async logPoolOccupancy(candidateRows: readonly { candidate: WarmWorkerCandidate; prepared: boolean; podUid: string | null }[]): Promise<void> {
    const groups = new Map<string, typeof candidateRows[number][]>();
    for (const row of candidateRows) {
      const key = `${row.candidate.host}\u0000${row.candidate.tier}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const rows of groups.values()) {
      const { host, tier } = rows[0]!.candidate;
      const profile = this.profile;
      const runId = this.observationRunId();
      const observedAtMs = this.now();
      const observedAt = Number.isFinite(observedAtMs) ? new Date(observedAtMs).toISOString() : null;
      if (!runId || !observedAt) {
        debug.log('pod.warm', 'pool-occupancy', { schema: 1, profile, host, tier,
          candidateCount: rows.length, ready: null, leased: null, measured: false,
          consumer: 'warm-pod-provider', observedAt, reason: !runId ? 'run-id-unavailable' : 'observation-time-unavailable',
        }, { level: 'warn' });
        continue;
      }
      try {
        const samples = await Promise.all(rows.map(async row => ({ ...row,
          state: await this.readOccupancyLeaseState(row.candidate, row.podUid) })));
          let ready = 0;
          let leased = 0;
          let complete = true;
          for (const sample of samples) {
            if (sample.state === 'idle') {
              if (sample.prepared) ready++;
            } else if (sample.state === 'leased') leased++;
            else complete = false;
          }
          debug.log('pod.warm', 'pool-occupancy', { schema: 1, profile, host, tier,
            candidateCount: rows.length, ready: complete ? ready : null, leased: complete ? leased : null,
            measured: complete, runId, consumer: 'warm-pod-provider', observedAt,
            ...(complete ? {} : { reason: 'occupancy-incomplete' }),
          }, { level: complete ? 'info' : 'warn' });
      } catch {
          debug.log('pod.warm', 'pool-occupancy', { schema: 1, profile, host, tier,
            candidateCount: rows.length, ready: null, leased: null, measured: false,
            runId, consumer: 'warm-pod-provider', observedAt,
            reason: 'occupancy-read-failed' }, { level: 'warn' });
      }
    }
  }

  private logLeaseAcquireWait(candidate: WarmWorkerCandidate, input: WarmReplayInput, startedAt: number,
    status: number | null, outcome: string): void {
    const observedAtMs = this.now();
    const waitMs = observedAtMs - startedAt;
    const runId = this.observationRunId(input.runId);
    const measured = !!runId && Number.isFinite(waitMs) && waitMs >= 0 && Number.isFinite(observedAtMs);
    debug.log('pod.warm', 'lease-acquire-wait', { schema: 1, profile: this.profile,
      host: candidate.host, tier: candidate.tier, runId, consumer: 'warm-pod-provider',
      observedAt: Number.isFinite(observedAtMs) ? new Date(observedAtMs).toISOString() : null,
      waitMs: measured ? waitMs : null, status, outcome, measured,
      ...(!measured ? { reason: !runId ? 'run-id-unavailable' : 'wait-time-unavailable' } : {}),
    }, { level: measured ? 'info' : 'warn' });
  }

  private logLeaseOccupancyTransition(candidate: WarmWorkerCandidate, leaseId: string | undefined, generation: number | undefined,
    podUid: string | undefined, runId: string | null, state: 'leased' | 'idle' | 'quarantined',
    options: { unmeasuredReason?: string } = {}): void {
    const key = JSON.stringify([candidate.spec.workerId, leaseId, generation, podUid]);
    const prior = this.observedOccupancyLeases.get(key);
    if (state === 'leased' && prior) return;
    let leasedDelta: number | null;
    let stableRunId = runId;
    if (state === 'leased') {
      this.observedOccupancyLeases.set(key, { candidate, runId });
      leasedDelta = 1;
    } else {
      stableRunId = prior?.runId ?? runId;
      // Keep the observed lease until cleanup is confirmed. A later confirmed transition can
      // then close the measured interval instead of permanently losing its occupancy decrement.
      leasedDelta = options.unmeasuredReason ? null
        : this.observedOccupancyLeases.delete(key) ? -1 : this.terminalEndLogged.has(key) ? 0 : null;
    }
    const observedAtMs = this.now();
    const measured = !options.unmeasuredReason && !!stableRunId && !!leaseId && !!podUid && leasedDelta !== null
      && Number.isSafeInteger(generation) && Number.isFinite(observedAtMs);
    debug.log('pod.warm', 'lease-occupancy-transition', { schema: 1, profile: this.profile,
      host: candidate.host, tier: candidate.tier, workerId: candidate.spec.workerId,
      leaseId: leaseId ?? null, generation: Number.isSafeInteger(generation) ? generation : null,
      podUid: podUid ?? null, state, leasedDelta: measured ? leasedDelta : null,
      measured, ...(stableRunId ? { runId: stableRunId } : {}), consumer: 'warm-pod-provider',
      observedAt: Number.isFinite(observedAtMs) ? new Date(observedAtMs).toISOString() : null,
      ...(!measured ? { reason: options.unmeasuredReason ?? (!stableRunId ? 'run-id-unavailable' : 'lease-transition-unpaired') } : {}),
    }, { level: measured ? 'info' : 'warn' });
  }

  /** One bounded reconciliation pass. Failed slots stay unavailable until a fresh worker ID is configured. */
  async reconcilePool(): Promise<WarmPoolReconcileResult> {
    this.refreshQuarantineState();
    const startedAt = this.now();
    const rawPodConfig = getUserConfig().pod as Record<string, unknown> | undefined;
    const phaseConfig = this.options.phasePrewarmForTest ?? rawPodConfig?.phasePrewarm as PodPhasePrewarmConfig | undefined;
    let prewarmPlan = null as ReturnType<typeof resolvePodPhasePlan> | null;
    let phaseFailure: string | undefined;
    if (phaseConfig) {
      try {
        if (this.options.scheduleLookupErrorForTest) throw new Error('injected-schedule-lookup-failure');
        prewarmPlan = resolvePodPhasePlan(this.options.releaseSchedulesForTest ?? listSchedules(), startedAt, phaseConfig);
      }
      catch (error) { phaseFailure = error instanceof Error ? error.message : String(error); }
    }
    if (phaseConfig && !prewarmPlan) for (const candidate of this.candidates) this.phaseUnavailableHosts.add(candidate.host);
    else this.phaseUnavailableHosts.clear();
    this.options.drainingHosts = [...new Set([...this.configuredDrainingHosts, ...this.phaseUnavailableHosts])];
    const failed: string[] = [];
    let ready = 0;
    const prewarmStartedAt = this.now();
    let phasePlan: WarmPodPhasePlan | undefined;
    let phaseCandidates = this.candidates;
    if (this.options.phaseSchedule) {
      try {
        phasePlan = resolveWarmPodPhasePlan(this.now(), this.options.phaseSchedule);
        this.syncPhaseFailureScope(phasePlan);
        phaseCandidates = selectWarmPodPhaseCandidates(this.candidates, phasePlan, candidate =>
          !this.options.drainingHosts?.includes(candidate.host)
          && !this.quarantineBlockedWorkerIds.has(candidate.spec.workerId));
      } catch (error) {
        this.syncPhaseFailureScope(undefined);
        phaseCandidates = [];
        debug.log('task-orchestrator.pod-phase', 'schedule-invalid', {
          reason: error instanceof Error ? error.message : String(error), fallback: 'cold-start',
        }, { level: 'warn' });
      }
    }
    const occupancyRows: { candidate: WarmWorkerCandidate; prepared: boolean; podUid: string | null }[] = [];
    const kindOf = (candidate: WarmWorkerCandidate): PodKind => candidate.kind ?? (this.profile === 'gate' ? 'gate' : 'implementation');
    const fallbackTarget = phaseConfig
      ? prewarmPlan?.target ?? resolvePodPhasePlan([], startedAt, phaseConfig).target
      : undefined;
    const nonDraining = phaseCandidates.filter(candidate => !this.options.drainingHosts?.includes(candidate.host)
      && !this.quarantineBlockedWorkerIds.has(candidate.spec.workerId));
    const phaseAssignments = phaseConfig
      ? prewarmPlan ? allocatePodPhaseCandidates(nonDraining.map(candidate => ({ candidate,
        kind: candidate.kind, cutSha: candidate.spec.cutSha, lockHash: candidate.spec.key.lockHash })), fallbackTarget!, phaseConfig)
        .map(row => ({ candidate: row.candidate.candidate, kind: row.kind })) : []
      : null;
    const phased = phaseAssignments ? phaseAssignments.map(row => row.candidate) : nonDraining;
    const assignedKind = new Map(phaseAssignments?.map(row => [row.candidate.spec.workerId, row.kind] as const) ?? []);
    const effectiveKind = (candidate: WarmWorkerCandidate): PodKind => assignedKind.get(candidate.spec.workerId) ?? kindOf(candidate);
    const selected = new Set(phased.map(candidate => candidate.spec.workerId));
    if (phaseConfig) {
      try {
        // Fence every slot before preparation; a second process sees cold until
        // the complete phase target has been prepared and explicitly admitted.
        this.writePhaseFence(this.candidates.map(row => row.spec.workerId));
        this.phaseFencePersistenceFailed = false;
      } catch (error) {
        this.phaseFencePersistenceFailed = true;
        failed.push(`phase-fence-state-unavailable:${error instanceof Error ? error.message : String(error)}`);
        for (const candidate of this.candidates) this.phaseUnavailableHosts.add(candidate.host);
        this.options.drainingHosts = [...new Set([...this.configuredDrainingHosts, ...this.phaseUnavailableHosts])];
      }
    } else {
      try { this.writePhaseFence([]); this.phaseFencePersistenceFailed = false; }
      catch (error) { this.phaseFencePersistenceFailed = true;
        failed.push(`phase-fence-state-unavailable:${error instanceof Error ? error.message : String(error)}`); }
    }
    const unavailable = this.candidates.filter(row => this.phaseFencePersistenceFailed
      || this.options.drainingHosts?.includes(row.host)
      || this.warmReuseDisabled || this.quarantineBlockedWorkerIds.has(row.spec.workerId)
      || !selected.has(row.spec.workerId));
    const available = this.phaseFencePersistenceFailed || this.warmReuseDisabled ? [] : phased;
    for (const candidate of unavailable) {
      if (this.warmReuseDisabled || this.quarantineBlockedWorkerIds.has(candidate.spec.workerId)) {
        failed.push(candidate.spec.workerId);
        occupancyRows.push({ candidate, prepared: false, podUid: this.observedPodUids.get(candidate.spec.workerId) ?? null });
        continue;
      }
      try {
        const retired = await this.retireDrainedWorker(candidate);
        if (!retired && ((prewarmPlan && !this.configuredDrainingHosts.has(candidate.host) && !this.phaseUnavailableHosts.has(candidate.host)
          && !selected.has(candidate.spec.workerId)) || this.phaseUnavailableHosts.has(candidate.host))) {
          failed.push(`phase-retire-unconfirmed:${candidate.spec.workerId}`);
          debug.log('task-orchestrator.pod-phase', 'retire-unconfirmed', { phase: prewarmPlan?.phase ?? 'schedule-unavailable',
            workerId: candidate.spec.workerId, kind: candidate.kind ?? 'shared', reason: 'uid-pinned-retire-not-confirmed' }, { level: 'warn' });
        }
      }
      catch (error) {
        if ((prewarmPlan && !this.configuredDrainingHosts.has(candidate.host) && !this.phaseUnavailableHosts.has(candidate.host)
          && !selected.has(candidate.spec.workerId)) || this.phaseUnavailableHosts.has(candidate.host))
          failed.push(`phase-retire-unconfirmed:${candidate.spec.workerId}`);
        debug.log('pod.warm.provider', 'drain-retire-deferred', { host: candidate.host,
          workerId: candidate.spec.workerId,
          reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
      }
      occupancyRows.push({ candidate, prepared: false, podUid: this.observedPodUids.get(candidate.spec.workerId) ?? null });
    }
    for (const candidate of available) {
      if (this.warmReuseDisabled) {
        failed.push(candidate.spec.workerId);
        occupancyRows.push({ candidate, prepared: false, podUid: this.observedPodUids.get(candidate.spec.workerId) ?? null });
        continue;
      }
      let prepared = false;
      let decision: WarmPoolFailureDecision | undefined;
      try { prepared = await this.ensureStandingWorker(candidate, value => { decision = value; }); }
      catch (error) {
        this.observedPodUids.delete(candidate.spec.workerId);
        decision = { stage: 'prepare', reason: 'prepare-threw',
          stderr: safeWarmPoolStderr(error instanceof Error ? error.message : String(error), [
            this.options.memberToken, ...Object.values(this.options.machineTokens ?? {}),
          ]) };
      }
      if (prepared) {
        this.phasePrepareFailures.delete(candidate.spec.workerId);
        const clusterState = this.readClusterQuarantineState(candidate);
        if (clusterState === 'quarantined' || clusterState === 'unavailable') {
          prepared = false;
          decision = { stage: 'prepare', reason: `cluster-quarantine-${clusterState}` };
          if (clusterState === 'unavailable') {
            this.warmReuseDisabled = true;
            debug.log('pod.warm.provider', 'cluster-quarantine-state-unavailable', {
              host: candidate.host, workerId: candidate.spec.workerId,
            }, { level: 'warn' });
          }
        }
      }
      occupancyRows.push({ candidate, prepared, podUid: this.observedPodUids.get(candidate.spec.workerId) ?? null });
      if (prepared) ready++;
      else {
        failed.push(candidate.spec.workerId);
        if (phasePlan?.gateIdentity && (phasePlan.phase === 'gate-prewarm' || phasePlan.phase === 'gate')
          && (candidate.kind ?? 'gate') === 'gate')
          this.phasePrepareFailures.set(candidate.spec.workerId, decision?.reason ?? 'prepare-refused');
        debug.log('pod.warm.provider', 'prepare-refused', { reason: decision?.reason ?? 'decision-unavailable',
          host: candidate.host, slot: candidate.spec.workerId,
          ...(this.options.observationRunIdForTest ? { runId: this.options.observationRunIdForTest } : {}) }, { level: 'warn' });
        debug.log('pod.warm', 'pool-reconcile-decision', { profile: this.profile,
          host: candidate.host, tier: candidate.tier, workerId: candidate.spec.workerId,
          stage: decision?.stage ?? 'prepare', reason: decision?.reason ?? 'decision-unavailable',
          ...(this.options.observationRunIdForTest ? { runId: this.options.observationRunIdForTest } : {}),
          ...(decision?.stderr ? { stderr: decision.stderr } : {}),
        }, { level: 'warn' });
      }
      debug.log('pod.warm', 'pool-slot', { profile: this.profile,
        host: candidate.host, tier: candidate.tier, workerId: candidate.spec.workerId,
        pod: candidate.spec.name, ready: prepared }, { level: prepared ? 'info' : 'warn' });
    }
    const plannedTarget = phasePlan ? Object.values(phasePlan.targets).reduce((sum, count) => sum + (count ?? 0), 0) : undefined;
    if (plannedTarget !== undefined && phaseCandidates.length < plannedTarget)
      failed.push(`phase-target-unconfigured:${plannedTarget - phaseCandidates.length}`);
    const desiredTarget = fallbackTarget ? fallbackTarget.gate + fallbackTarget.implementation
      : plannedTarget ?? this.candidates.filter(candidate => !this.options.drainingHosts?.includes(candidate.host)).length;
    if (phaseConfig && !prewarmPlan) failed.push('phase-schedule-unavailable:cold-fallback');
    if (phaseConfig) for (const kind of ['gate', 'implementation'] as const) {
      const assignedCount = phaseAssignments?.filter(row => row.kind === kind).length ?? 0;
      if (assignedCount < fallbackTarget![kind]) {
        if (kind === 'gate' && fallbackTarget!.gate > 0) {
          const exactCount = nonDraining.filter(candidate => podPhaseGateIdentityMatches({ cutSha: candidate.spec.cutSha,
            lockHash: candidate.spec.key.lockHash }, phaseConfig)).length;
          if (!phaseConfig.gateIdentity?.cutSha || !phaseConfig.gateIdentity.lockHash)
            failed.push(`phase-gate-identity-unconfigured:${assignedCount}/${fallbackTarget![kind]}`);
          else if (nonDraining.length > exactCount) failed.push(`phase-gate-identity-mismatch:${assignedCount}/${fallbackTarget![kind]}`);
          else failed.push(`phase-target-unmet:gate:${assignedCount}/${fallbackTarget![kind]}`);
        } else failed.push(`phase-target-unmet:${kind}:${assignedCount}/${fallbackTarget![kind]}`);
      }
    }
    if (phaseConfig && !this.phaseFencePersistenceFailed && failed.length === 0 && ready === desiredTarget) {
      try { this.writePhaseFence(this.candidates.filter(row => !selected.has(row.spec.workerId)).map(row => row.spec.workerId)); }
      catch (error) {
        this.phaseFencePersistenceFailed = true;
        failed.push(`phase-fence-state-unavailable:${error instanceof Error ? error.message : String(error)}`);
        for (const candidate of this.candidates) this.phaseUnavailableHosts.add(candidate.host);
        this.options.drainingHosts = [...new Set([...this.configuredDrainingHosts, ...this.phaseUnavailableHosts])];
      }
    }
    const result = { profile: this.profile,
      target: desiredTarget, ready, failed };
    if (prewarmPlan) {
      const actual = { gate: 0, implementation: 0 };
      for (const row of occupancyRows) if (row.prepared) actual[effectiveKind(row.candidate)]++;
      debug.log('task-orchestrator.pod-phase', 'reconcile', { phase: prewarmPlan.phase,
      version: prewarmPlan.version, target: prewarmPlan.target, actual,
      prewarmMs: Math.max(0, this.now() - startedAt), cutAt: prewarmPlan.cutAt,
      ...(prewarmPlan.phase === 'cut-gate' && (!phaseConfig?.gateIdentity?.cutSha || !phaseConfig.gateIdentity.lockHash)
        ? { reason: 'gate-identity-unconfigured:cold-fallback' } : {}),
      ...(failed.length ? { reason: `prewarm-failed:${failed.join(',')}` } : {}),
      }, { level: failed.length ? 'warn' : 'info' });
    } else if (phaseConfig) {
      const actual = { gate: 0, implementation: ready };
      debug.log('task-orchestrator.pod-phase', 'reconcile', { phase: 'schedule-unavailable', target: fallbackTarget,
        actual, prewarmMs: Math.max(0, this.now() - startedAt),
        reason: `schedule-unavailable:cold-fallback:${phaseFailure ?? 'unknown'}` }, { level: 'warn' });
    }
    if (phasePlan) {
      const target = plannedTarget ?? 0;
      const actual = Object.fromEntries(['gate', 'implementation'].map(kind => [kind,
        occupancyRows.filter(row => (row.candidate.kind ?? 'gate') === kind && row.prepared).length]));
      const observationKey = JSON.stringify({ ...phasePlan, target });
      if (observationKey !== this.lastPhaseObservationKey) {
        this.lastPhaseObservationKey = observationKey;
        debug.log('task-orchestrator.pod-phase', 'target', { phase: phasePlan.phase, target: phasePlan.targets,
          actual, prewarmDurationMs: Math.max(0, this.now() - prewarmStartedAt),
          ...(failed.length ? { reason: [...this.phasePrepareFailures.values()][0] ?? failed[0] } : {}) },
        { level: failed.length ? 'warn' : 'info' });
      }
    }
    debug.log('pod.warm', 'pool-reconcile', result, { level: failed.length ? 'warn' : 'info' });
    await this.logPoolOccupancy(occupancyRows);
    return result;
  }

  /** Acquire a matching idle worker before exec. Every uncertain result is fenced out of reuse. */
  async request(input: WarmReplayInput, selection?: { kind?: WarmPodKind; lockHash?: string; cutShaDistance?: number;
    runtimeIdentity?: RuntimeIdentityInput;
    runtimeContract?: NonNullable<WarmPodSpec['runtimeContract']>; imageDigest?: string }): Promise<WarmReplayResult> {
    const requestedAt = this.now();
    if (input.protocol !== 1 || input.envProfile !== 'gate-v1' || !Array.isArray(input.files)
      || !input.files.length || !Number.isFinite(input.deadlineAt) || input.deadlineAt <= this.now()) return fallback('no-candidate');
    this.refreshQuarantineState();
    if (this.warmReuseDisabled) return fallback('no-candidate');
    const kind = selection?.kind ?? 'gate';
    let phaseFenced: Set<string>;
    let phaseEligible: Set<string> | null = null;
    if (this.phaseFencePersistenceFailed) return fallback('no-candidate');
    const rawPodConfig = getUserConfig().pod as Record<string, unknown> | undefined;
    const phaseConfig = this.options.phasePrewarmForTest ?? rawPodConfig?.phasePrewarm as PodPhasePrewarmConfig | undefined;
    if (phaseConfig && !this.phaseFenceStatePath) return fallback('no-candidate');
    if (phaseConfig) {
      try {
        if (this.options.scheduleLookupErrorForTest) throw new Error('injected-schedule-lookup-failure');
        const phasePlan = resolvePodPhasePlan(this.options.releaseSchedulesForTest ?? listSchedules(), this.now(), phaseConfig);
        if (!phasePlan) return fallback('no-candidate');
        phaseEligible = new Set(allocatePodPhaseCandidates(this.candidates.map(candidate => ({ candidate,
          kind: candidate.kind, cutSha: candidate.spec.cutSha, lockHash: candidate.spec.key.lockHash })),
          phasePlan.target, phaseConfig).filter(row => row.kind === 'gate')
          .map(row => row.candidate.candidate.spec.workerId));
      } catch { return fallback('no-candidate'); }
    }
    try { phaseFenced = !phaseConfig && !this.phaseFenceStatePath ? new Set() : this.readPhaseFence(); }
    catch { return fallback('no-candidate'); }
    let phaseEligibleIds: Set<string> | undefined;
    let phasePlan: WarmPodPhasePlan | undefined;
    if (this.options.phaseSchedule) {
      try {
        phasePlan = resolveWarmPodPhasePlan(this.now(), this.options.phaseSchedule);
        this.syncPhaseFailureScope(phasePlan);
        phaseEligibleIds = new Set(selectWarmPodPhaseCandidates(this.candidates, phasePlan, candidate =>
          !this.options.drainingHosts?.includes(candidate.host)
          && !this.quarantineBlockedWorkerIds.has(candidate.spec.workerId)).map(row => row.spec.workerId));
      } catch (error) {
        this.syncPhaseFailureScope(undefined);
        debug.log('task-orchestrator.pod-phase', 'schedule-invalid', {
          reason: error instanceof Error ? error.message : String(error), fallback: 'cold-start',
        }, { level: 'warn' });
        return fallback('no-candidate');
      }
    }
    const matches = this.candidates.filter(row => !phaseFenced.has(row.spec.workerId)
      && (phaseEligible === null || phaseEligible.has(row.spec.workerId))
      && (!phaseEligibleIds || phaseEligibleIds.has(row.spec.workerId))
      && (row.kind ?? 'gate') === kind
      && row.spec.cutSha === input.cutSha
      && !(phasePlan && (phasePlan.phase === 'gate-prewarm' || phasePlan.phase === 'gate')
        && this.phasePrepareFailures.has(row.spec.workerId))
      && !this.quarantineBlockedWorkerIds.has(row.spec.workerId)
      && !this.options.drainingHosts?.includes(row.host));
    if (!matches.length) {
      if (phasePlan && (phasePlan.phase === 'gate-prewarm' || phasePlan.phase === 'gate'))
        debug.log('task-orchestrator.pod-phase', 'cold-fallback', { phase: phasePlan.phase,
          reason: [...this.phasePrepareFailures.values()][0] ?? 'prewarm-target-not-ready', runId: input.runId }, { level: 'warn' });
      return fallback('no-candidate');
    }
    let lastFallback: WarmReplayResult = fallback('lease-unavailable');
    // The control plane chooses an idle worker within a host/key. Probe each distinct
    // host/key once so a busy first host cannot strand an idle second pool.
    const tried = new Set<string>();
    // Cross-cut checkout refresh is owned by POD-PREP-IO-MIN. Live gate acquisition
    // sees only exact-cut candidates; the scorer still rejects an injected cut mismatch.
    // Production gate requests must carry the cut's lock hash and pinned image digest.
    // Inferring either from a candidate would let a stale first slot define its own target.
    if (kind === 'gate' && (!selection?.lockHash || !selection.imageDigest))
      return fallback('no-candidate');
    // Gate reuse must also be bound to the architecture measured for this execution.
    // The candidate cannot supply its own expected architecture.
    if (kind === 'gate' && !selection?.runtimeContract?.architecture)
      return fallback('no-candidate');
    const targetRuntimeIdentity = selection?.runtimeIdentity ?? this.options.runtimeIdentity;
    if (!targetRuntimeIdentity) return fallback('no-candidate');
    const candidateKind = (candidate: WarmWorkerCandidate) => candidate.kind ?? 'gate';
    const sameKind = matches.filter(row => candidateKind(row) === kind);
    const targetLockHash = selection?.lockHash ?? sameKind[0]?.spec.key.lockHash ?? '';
    const targetImageDigest = selection?.imageDigest ?? sameKind[0]?.spec.key.imageDigest ?? '';
    const runtimeContractMatches = (candidate: WarmWorkerCandidate): boolean => {
      const expected = selection?.runtimeContract;
      const actual = candidate.spec.runtimeContract;
      if (!expected) return kind !== 'gate';
      if (kind === 'gate') return !!actual && !!expected.architecture
        && runtimeArchitecturesMatch(expected.architecture, actual.architecture, this.options.allowedArchitectures);
      return !!actual && actual.bunVersion === expected.bunVersion && actual.os === expected.os
        && runtimeArchitecturesMatch(expected.architecture, actual.architecture, this.options.allowedArchitectures)
        && expected.requiredTools.length === actual.requiredTools.length
        && expected.requiredTools.every(tool => actual.requiredTools.includes(tool));
    };
    const scored = scoreWarmPodCandidates({ kind, cutSha: input.cutSha, lockHash: targetLockHash,
      imageDigest: targetImageDigest, runtimeIdentity: targetRuntimeIdentity, allowedArchitectures: this.options.allowedArchitectures,
      candidates: matches.map(candidate => ({ candidate,
        kind: candidateKind(candidate), cutSha: candidate.spec.cutSha, lockHash: candidate.spec.key.lockHash,
        imageDigest: this.runtimeSpec(candidate).key.imageDigest, cutShaDistance: selection?.cutShaDistance ?? 0,
        runtimeIdentity: candidate.spec.runtimeContract ? { baseImageDigest: candidate.spec.runtimeContract.baseImageDigest ?? '',
          lockHash: candidate.spec.key.lockHash, os: candidate.spec.runtimeContract.os,
          architecture: candidate.spec.runtimeContract.architecture, bunVersion: candidate.spec.runtimeContract.bunVersion } : null,
        contractCompatible: runtimeContractMatches(candidate) })) });
    debug.log('pod.warm', 'candidate-match-score', { kind, runId: input.runId,
      candidates: scored.rows.map(row => ({ workerId: row.candidate.spec.workerId, kind: row.kind,
        accepted: row.accepted, score: row.score, cutShaDistance: row.cutShaDistance,
        lockHashMatches: row.lockHashMatches, imageDigestDrift: row.imageDigestDrift, reason: row.reason })) });
    const orderedMatches = scored.rows.filter(row => row.accepted).map(row => row.candidate);
    for (const candidate of orderedMatches) {
    if (input.deadlineAt <= this.now()) return lastFallback;
    const { host } = candidate;
    const spec = this.runtimeSpec(candidate);
    // A gate run is pinned to its full image digest. Runtime-compatible digest drift
    // remains useful for implementation workers, but cannot silently replace the cut pin.
    if (kind === 'gate' && spec.key.imageDigest !== targetImageDigest) {
      lastFallback = fallback('lease-unavailable');
      continue;
    }
    const poolKey = `${host}/${spec.key.context}/${spec.key.imageDigest}/${spec.key.lockHash}/${spec.key.architecture}`;
    if (tried.has(poolKey)) continue;
    tried.add(poolKey);
    const contextFailure = probeWarmPodContext(spec.kubectlContext, this.options.kubectl);
    if (contextFailure) {
      this.warmReuseDisabled = true;
      debug.log('pod.warm.provider', 'cluster-quarantine-state-unavailable', {
        host, workerId: candidate.spec.workerId, reason: 'context-probe-failed',
      }, { level: 'warn' });
      lastFallback = { command: null, transport: contextFailure };
      continue;
    }
    const clusterState = this.readClusterQuarantineState(candidate);
    if (clusterState !== 'available') {
      lastFallback = fallback('no-candidate');
      debug.log('pod.warm.provider', 'cluster-quarantine-selection-refused', {
        host, workerId: candidate.spec.workerId, reason: clusterState,
      }, { level: 'warn' });
      if (clusterState === 'unavailable') this.warmReuseDisabled = true;
      continue;
    }
    let acquired: { status: number; value: any };
    // Lease selection is a consumer action. Keep its owner at member scope so
    // finalize can release it; the machine token owns registration and sanitize.
    const acquisitionCredential = this.options.memberToken;
    const acquisitionStartedAt = this.now();
    const acquisition = this.control('/v1/leases/pod-worker', acquisitionCredential, {
      machine: host, key: spec.key, runId: input.runId, attemptId: input.attemptId,
      ttlMs: this.options.leaseTtlMs ?? 30 * 60_000,
    });
    const timedOut = Symbol('warm-acquisition-timeout');
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let acquisitionFailed = false;
    let acquisitionResult: typeof timedOut | { status: number; value: any };
    try {
      const remainingMs = input.deadlineAt - this.now();
      if (remainingMs <= 0) acquisitionResult = timedOut;
      else acquisitionResult = await Promise.race([acquisition, new Promise<typeof timedOut>(resolve => {
        deadlineTimer = setTimeout(() => resolve(timedOut), remainingMs);
      })]);
    } catch { acquisitionFailed = true; acquisitionResult = timedOut; }
    finally { if (deadlineTimer) clearTimeout(deadlineTimer); }
    if (acquisitionResult === timedOut) {
      this.logLeaseAcquireWait(candidate, input, acquisitionStartedAt, null, acquisitionFailed ? 'error' : 'timeout');
      void acquisition.then(async late => {
        this.logLeaseAcquireWait(candidate, input, acquisitionStartedAt, late.status, 'late-response');
        const row = late.value;
        const lateWorkerId = row?.name;
        const leaseId = row?.attrs?.leaseId;
        const generation = row?.attrs?.generation;
        const podUid = row?.attrs?.podUid;
        const lateCandidate = this.candidates.find(candidate => candidate.spec.workerId === lateWorkerId
          && candidate.host === host && keyEquals(this.runtimeSpec(candidate).key, spec.key));
        if (late.status !== 200 || !lateCandidate || !row?.attrs?.key
          || !keyEquals(row.attrs.key, this.runtimeSpec(lateCandidate).key)
          || typeof leaseId !== 'string' || !leaseId
          || !Number.isSafeInteger(generation) || typeof podUid !== 'string' || !podUid) return;
        const lateSpec = this.runtimeSpec(lateCandidate);
        const command: WarmWorkerCommand = { ...input, leaseId, generation, podUid,
          podName: lateSpec.name, podContext: lateSpec.kubectlContext, image: lateSpec.image,
          requestedAt: new Date(this.now()).toISOString(), workerId: lateSpec.workerId, key: lateSpec.key };
        this.logLeaseOccupancyTransition(lateCandidate, leaseId, generation, podUid,
          this.observationRunId(input.runId), 'leased');
        debug.log('pod.warm', 'lease-response-after-deadline', { workerId: command.workerId,
          leaseId, generation, podUid, runId: command.runId, attemptId: command.attemptId }, { level: 'warn' });
        debug.log('pod.provenance', 'lease-start', { pod: lateSpec.name, podUid, leaseId,
          runId: command.runId, attemptId: command.attemptId, requestedAt: command.requestedAt,
          metadata: warmLeaseMetadata(command).annotations });
        try {
          const fenced = await this.controlBounded(`/v1/leases/pod-worker/${encodeURIComponent(lateWorkerId)}/timeout`,
            this.options.memberToken, { runId: input.runId, attemptId: input.attemptId }, WARM_CONTROL_REQUEST_TIMEOUT_MS);
          if (fenced.status !== 200) throw new Error(`warm timeout fence returned ${fenced.status}`);
        } catch (error) { debug.log('pod.warm', 'late-lease-timeout-fence-failed', { workerId: lateWorkerId,
          leaseId, generation, error: String(error) }, { level: 'warn' }); }
        let quarantineTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([this.quarantine(command, 'lease-response-after-deadline'), new Promise<never>((_, reject) => {
            quarantineTimer = setTimeout(() => reject(new Error('warm late-lease quarantine timed out')), WARM_CONTROL_REQUEST_TIMEOUT_MS);
          })]);
        }
        catch (error) { debug.log('pod.warm', 'late-lease-quarantine-failed', { workerId: command.workerId,
          leaseId, generation, error: String(error) }, { level: 'warn' }); }
        finally { if (quarantineTimer) clearTimeout(quarantineTimer); }
      }, error => {
        this.logLeaseAcquireWait(candidate, input, acquisitionStartedAt, null, 'late-error');
        debug.log('pod.warm', 'late-lease-response-failed', { workerId: spec.workerId,
          runId: input.runId, attemptId: input.attemptId, error: String(error) }, { level: 'warn' });
      });
      if (acquisitionFailed) continue;
      return fallback('lease-unavailable');
    }
    acquired = acquisitionResult;
    this.logLeaseAcquireWait(candidate, input, acquisitionStartedAt, acquired.status,
      acquired.status === 200 ? 'response' : acquired.status === 409 ? 'busy' : acquired.status === 503 ? 'unavailable' : 'rejected');
    if (acquired.status === 409 || acquired.status === 503) {
      if (acquired.status === 409) {
        try {
          const query = new URLSearchParams({ kind: 'pod-worker-lease', machine: host, name: spec.workerId });
          const remainingMs = input.deadlineAt - this.now();
          if (remainingMs <= 0) return lastFallback;
          const observed = await this.controlBounded(`/v1/resources?${query}`, this.options.memberToken,
            undefined, Math.min(WARM_CONTROL_REQUEST_TIMEOUT_MS, remainingMs));
          const row = observed.status === 200 && Array.isArray(observed.value?.resources)
            ? observed.value.resources.find((entry: any) => entry?.name === spec.workerId) : undefined;
          if (row?.attrs?.state === 'quarantined' || row?.attrs?.state === 'timeout-fenced') {
            debug.log('pod.warm', 'quarantine-holds-slot', { workerId: spec.workerId,
              state: row.attrs.state, at: new Date(this.now()).toISOString() }, { level: 'warn' });
          }
        } catch { /* Slot observation never changes the Job's cold fallback. */ }
      }
      lastFallback = fallback('lease-unavailable');
      continue;
    }
    const row = acquired.value;
    if (acquired.status !== 200) return fallback('lease-unavailable');
    const leasedId = row?.attrs?.leaseId;
    const generation = row?.attrs?.generation;
    const podUid = row?.attrs?.podUid;
    if (!workerId(row?.name) || typeof leasedId !== 'string' || !leasedId
      || typeof podUid !== 'string' || !podUid
      || !Number.isSafeInteger(generation) || generation < 1) return fallback('lease-unavailable');
    // One terminal transition per workerId·leaseId·generation·Pod UID. A lease the
    // control plane already settled (finalize/quarantine raced this acquisition)
    // must never be re-adopted — not by this late reply, not by the next warm request.
    // An uncertain ending keeps its quarantined / cold-Job verdict.
    const terminalKey = JSON.stringify([row.name, leasedId, generation, podUid]);
    if (this.terminalLeases.has(terminalKey) || this.quarantineRequested.has(terminalKey)) {
      debug.log('pod.warm', 'lease-terminal-refused', { workerId: row.name, leaseId: leasedId,
        generation, podUid, runId: input.runId, attemptId: input.attemptId }, { level: 'warn' });
      return fallback('lease-unavailable');
    }
    // Acquisition selects by host/key, not by worker ID. Resolve the returned worker
    // before choosing its transport; an unknown worker must not be executed or fenced.
    const leasedCandidate = this.candidates.find(entry => entry.host === host
      && entry.spec.workerId === row.name && entry.spec.cutSha === input.cutSha
      && keyEquals(this.runtimeSpec(entry).key, spec.key));
    if (!leasedCandidate) {
      debug.log('pod.warm', 'lease-candidate-unmatched', { host, workerId: row.name,
        runId: input.runId, attemptId: input.attemptId }, { level: 'warn' });
      return fallback('lease-unavailable');
    }
    this.logLeaseOccupancyTransition(leasedCandidate, leasedId, generation, podUid,
      this.observationRunId(input.runId), 'leased');
    const leasedSpec = this.runtimeSpec(leasedCandidate);
    if (!row.attrs?.key || !keyEquals(row.attrs.key, leasedSpec.key)) {
      const command: WarmWorkerCommand = { ...input, leaseId: leasedId, generation, podUid,
        requestedAt: new Date(this.now()).toISOString(),
        workerId: row.name, key: leasedSpec.key };
      await this.quarantine(command, 'candidate-identity-mismatch', false);
      return fallback('lease-unavailable');
    }
    const command: WarmWorkerCommand = { ...input, leaseId: leasedId, generation, podUid,
      podName: leasedSpec.name, podContext: leasedSpec.kubectlContext, image: leasedSpec.image,
      requestedAt: new Date(this.now()).toISOString(),
      workerId: row.name, key: leasedSpec.key,
      baseImageDigest: leasedSpec.runtimeContract?.baseImageDigest ?? leasedSpec.key.imageDigest };
    if (command.deadlineAt <= this.now()) {
      debug.log('pod.warm', 'lease-response-after-deadline', { workerId: command.workerId,
        leaseId: command.leaseId, generation: command.generation, podUid: command.podUid,
        runId: command.runId, attemptId: command.attemptId }, { level: 'warn' });
      // The control plane granted a lease, even though the caller's budget expired before Pod adoption.
      // Record its short lifetime as a paired start/end and quarantine it without running transport.
      debug.log('pod.provenance', 'lease-start', { pod: leasedCandidate.spec.name, podUid: command.podUid,
        leaseId: command.leaseId, runId: command.runId, attemptId: command.attemptId,
        requestedAt: command.requestedAt, metadata: warmLeaseMetadata(command).annotations });
      let quarantineTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.quarantine(command, 'lease-response-after-deadline'), new Promise<never>((_, reject) => {
          quarantineTimer = setTimeout(() => reject(new Error('warm late-lease quarantine timed out')),
            WARM_CONTROL_REQUEST_TIMEOUT_MS);
        })]);
      }
      catch (error) { debug.log('pod.warm', 'late-lease-quarantine-failed', { workerId: command.workerId,
        leaseId: command.leaseId, generation: command.generation, error: String(error) }, { level: 'warn' }); }
      finally { if (quarantineTimer) clearTimeout(quarantineTimer); }
      return fallback('lease-unavailable');
    }
    // Acquisition is by pool key. A healthy sibling or replacement Pod must remain eligible.
    // Never run transport on the old Pod while its previous lease is being quarantined.
    if (this.quarantiningPods.has(JSON.stringify([command.workerId, command.podUid]))) {
      await this.quarantine(command, 'prior-lease-quarantine-pending', false);
      return fallback('lease-unavailable');
    }
    const admitted = patchWarmLeaseMetadata(leasedSpec, command, 'leased', this.options.kubectl);
    if (!admitted.ok) {
      debug.log('pod.provenance', 'lease-patch-refused', { pod: leasedCandidate.spec.name,
        podUid, leaseId: leasedId, reason: admitted.reason }, { level: 'warn' });
      await this.quarantine(command, 'provenance-unavailable', false);
      return fallback('lease-unavailable');
    }
    debug.log('pod.provenance', 'lease-start', { pod: leasedCandidate.spec.name, podUid,
      leaseId: leasedId, runId: command.runId, attemptId: command.attemptId,
      requestedAt: command.requestedAt, metadata: warmLeaseMetadata(command).annotations });
    let transport: WarmPodTransportResult;
    try { transport = await this.runTransport(leasedSpec, command); }
    catch { transport = { status: 'fallback', reason: 'exec-failed', reply: null }; }
    // Warm leg: the lease reused an already-standing Pod, so no prepare interval elapsed.
    // Only a 1-file gate has a pairing key; a multi-file gate is skipped (with its reason), never keyed by files[0].
    const gateFile = command.files.length === 1 ? command.files[0] : undefined;
    if (command.files.length !== 1) debug.log(PAIR_CATEGORY, `${PAIR_EVENT}-skipped`, { reason: 'not-single-file-gate',
      fileCount: command.files.length, commit: command.cutSha, host }, { level: 'info' });
    if (gateFile) this.recordPair('warm', gateFile, command.cutSha, host, {
      reuse: true, prepareDurationMs: 0,
      totalDurationMs: this.now() - requestedAt, podUid,
      success: transport.status === 'observed' && transport.reason === 'complete',
    });
    if (transport.status !== 'observed' || transport.reason !== 'complete') {
      await this.quarantine(command, transport.reason);
      return { command, transport };
    }
    const reply = parseWarmWorkerReply(transport.reply);
    const reset = reply?.resetReceipt;
    if (!reply || reply.runId !== command.runId || reply.attemptId !== command.attemptId
      || reply.cutSha !== command.cutSha || reply.leaseId !== command.leaseId
      || reply.generation !== command.generation || reply.workerId !== command.workerId
      || !reset || reset.baseImageDigest !== command.baseImageDigest
      || reset.resetMethod !== 'git-reset-clean-status-v1' || reset.postRunDiff.length !== 0
      || reply.key.imageDigest !== command.key.imageDigest || reply.key.lockHash !== command.key.lockHash) {
      debug.log('pod.reuse', 'reset-receipt-invalid', { workerId: command.workerId,
        leaseId: command.leaseId, generation: command.generation, podUid: command.podUid,
        reason: !reset ? 'missing' : reset.postRunDiff.length ? 'post-run-diff' : 'identity-mismatch' }, { level: 'warn' });
      await this.quarantine(command, 'reset-receipt-invalid');
      return { command, transport: { status: 'fallback', reason: 'exec-failed', reply: null } };
    }
    // The runtime reports complete only after reset/whitelist-clean/status verification.
    // Bind that receipt to the exact fenced lease; finalize must not make an arbitrary
    // or incomplete worker reusable merely because its caller asks to return it.
    const cleanupKey = JSON.stringify([command.workerId, command.leaseId, command.generation, command.podUid]);
    if (this.terminalLeases.has(cleanupKey) || this.quarantineRequested.has(cleanupKey)) {
      // A fallback/quarantine may race the worker's final cleanup ACK. Its terminal
      // decision wins: a late `complete` cannot resurrect a reusable lease receipt.
      this.cleanupVerifiedLeases.delete(cleanupKey);
      debug.log('pod.reuse', 'cleanup-proof-suppressed', { workerId: command.workerId,
        leaseId: command.leaseId, generation: command.generation, podUid: command.podUid,
        reason: 'lease-terminal-during-cleanup' }, { level: 'warn' });
      return { command, transport };
    }
    this.cleanupVerifiedLeases.add(cleanupKey);
    // Keep the lease fenced until the gate has compared these bytes with its Job baseline.
    // A missing finalization leaves the worker leased and therefore unavailable.
    return { command, transport };
    }
    return lastFallback;
  }

  private async transition(command: WarmWorkerCommand, action: 'release' | 'sanitize' | 'quarantine',
    credential = this.options.memberToken, reason?: string): Promise<boolean> {
    try {
      const response = await this.control(`/v1/leases/pod-worker/${encodeURIComponent(command.workerId)}/${action}`,
        credential, { leaseId: command.leaseId, generation: command.generation,
          ...(reason ? { reason } : {}) });
      return response.status === 200;
    } catch { return false; }
  }

  async finalize(command: WarmWorkerCommand): Promise<void> {
    const key = JSON.stringify([command.workerId, command.leaseId, command.generation, command.podUid]);
    const prior = this.terminalLeases.get(key);
    if (prior) {
      const outcome = await prior;
      debug.log('pod.provenance', 'lease-terminal-suppressed', { workerId: command.workerId,
        leaseId: command.leaseId, generation: command.generation, requested: 'finalize', outcome });
      if (outcome === 'quarantined') throw new Error('warm lease already quarantined');
      return;
    }
    if (!this.cleanupVerifiedLeases.has(key)) {
      debug.log('pod.reuse', 'return-blocked', { workerId: command.workerId, podUid: command.podUid,
        leaseId: command.leaseId, generation: command.generation, reason: 'cleanup-unverified' }, { level: 'warn' });
      await this.quarantine(command, 'cleanup-unverified');
      throw new Error('warm cleanup unverified');
    }
    const terminal = this.finalizeOnce(command);
    this.terminalLeases.set(key, terminal);
    let outcome: 'sanitized' | 'quarantined';
    try { outcome = await terminal; }
    catch (error) { if (this.terminalLeases.get(key) === terminal) this.terminalLeases.delete(key); throw error; }
    this.cleanupVerifiedLeases.delete(key);
    if (outcome === 'quarantined' || this.quarantineRequested.has(key)) throw new Error('warm sanitize unavailable');
  }

  private async finalizeOnce(command: WarmWorkerCommand): Promise<'sanitized' | 'quarantined'> {
    const key = JSON.stringify([command.workerId, command.leaseId, command.generation, command.podUid]);
    const candidate = this.candidates.find(row => row.spec.workerId === command.workerId);
    if (!candidate) throw new Error('warm finalize candidate missing');
    const released = await this.transition(command, 'release');
    const machineToken = this.options.machineTokens?.[candidate.host];
    // Sanitizing is the producer's machine-scoped acknowledgement, after transport's cleanup and ACK.
    // Always verify and clear this exact Pod UID/lease metadata before telling the control plane it is reusable.
    // A missing local adoption record is not evidence that no pod-side leased state exists.
    const cleared = released
      ? patchWarmLeaseMetadata(this.runtimeSpec(candidate), command, 'idle', this.options.kubectl)
      : { ok: false, reason: 'release-failed' };
    if (!cleared.ok) debug.log('pod.provenance', 'lease-patch-refused', { pod: candidate.spec.name,
      podUid: command.podUid, leaseId: command.leaseId, reason: cleared.reason }, { level: 'warn' });
    if (!cleared.ok || !token(machineToken) || !await this.transition(command, 'sanitize', machineToken)) {
      if (!this.quarantineRequested.has(key)) {
        this.quarantineRequested.add(key);
        await this.quarantineOnce(command, 'sanitize-unavailable', true);
      }
      return 'quarantined';
    }
    if (!this.quarantineRequested.has(key)) {
      debug.log('pod.provenance', 'lease-end', { pod: candidate.spec.name, podUid: command.podUid,
        leaseId: command.leaseId, runId: command.runId, attemptId: command.attemptId,
        releasedAt: new Date(this.now()).toISOString(), result: 'sanitized' });
      this.logLeaseOccupancyTransition(candidate, command.leaseId, command.generation, command.podUid,
        this.observationRunId(command.runId), 'idle');
      this.terminalEndLogged.add(key);
    }
    return 'sanitized';
  }

  /** `leaseStarted=false` marks a refusal before `lease-start`, so start/end history stays paired. */
  async quarantine(command: WarmWorkerCommand, reason: string, leaseStarted = true): Promise<void> {
    const key = JSON.stringify([command.workerId, command.leaseId, command.generation, command.podUid]);
    this.cleanupVerifiedLeases.delete(key);
    // Fence same-process sibling requests immediately and make the shared block visible before the terminal call.
    this.recordQuarantineBlock(command.workerId);
    const podKey = JSON.stringify([command.workerId, command.podUid]);
    this.quarantiningPods.add(podKey);
    const prior = this.terminalLeases.get(key);
    if (prior) {
      if (this.quarantineRequested.has(key)) {
        try { await prior; this.quarantiningPods.delete(podKey); }
        catch (error) {
          if (this.terminalLeases.get(key) === prior) this.terminalLeases.delete(key);
          throw error;
        }
        return;
      }
      this.quarantineRequested.add(key);
      // Fence the control-plane lease immediately. Waiting for sanitize to settle leaves a window
      // where another request could acquire the just-idled worker before this quarantine lands.
      const terminal = this.quarantineOnce(command, reason, leaseStarted).then(() => 'quarantined' as const);
      this.terminalLeases.set(key, terminal);
      try { await terminal; this.quarantiningPods.delete(podKey); }
      catch (error) {
        if (this.terminalLeases.get(key) === terminal) this.terminalLeases.delete(key);
        throw error;
      }
      return;
    }
    this.quarantineRequested.add(key);
    const terminal = this.quarantineOnce(command, reason, leaseStarted).then(() => 'quarantined' as const);
    this.terminalLeases.set(key, terminal);
    try { await terminal; this.quarantiningPods.delete(podKey); }
    catch (error) {
      if (this.terminalLeases.get(key) === terminal) this.terminalLeases.delete(key);
      throw error;
    }
  }

  private async quarantineOnce(command: WarmWorkerCommand, reason: string, leaseStarted: boolean): Promise<void> {
    const candidate = this.candidates.find(row => row.spec.workerId === command.workerId);
    let occupancyUnmeasuredReason: string | undefined;
    let clusterResult: { ok: boolean; reason: string } = { ok: false, reason: 'candidate-unavailable' };
    if (candidate) {
      const cleared = patchWarmLeaseMetadata(this.runtimeSpec(candidate), command, 'quarantined', this.options.kubectl);
      if (!cleared.ok) {
        occupancyUnmeasuredReason = 'lease-cleanup-unconfirmed';
        if (reason !== 'provenance-unavailable') debug.log('pod.provenance', 'lease-patch-refused', { pod: candidate.spec.name,
          podUid: command.podUid, leaseId: command.leaseId, reason: cleared.reason }, { level: 'warn' });
      }
      clusterResult = typeof command.podUid === 'string' && command.podUid
        ? this.markClusterQuarantined(candidate, command.podUid)
        : { ok: false, reason: 'pod-uid-unavailable' };
      if (!clusterResult.ok) {
        occupancyUnmeasuredReason = 'cluster-quarantine-unconfirmed';
        this.warmReuseDisabled = true;
        debug.log('pod.warm.provider', 'cluster-quarantine-failed', {
          host: candidate.host, workerId: command.workerId, podUid: command.podUid, reason: clusterResult.reason,
        }, { level: 'warn' });
      }
    } else {
      this.warmReuseDisabled = true;
      debug.log('pod.warm.provider', 'cluster-quarantine-failed', {
        workerId: command.workerId, podUid: command.podUid, reason: clusterResult.reason,
      }, { level: 'warn' });
    }
    if (!await this.transition(command, 'quarantine', this.options.memberToken, reason.slice(0, 120) || 'mismatch')) {
      throw new Error('warm quarantine unavailable');
    }
    const key = JSON.stringify([command.workerId, command.leaseId, command.generation, command.podUid]);
    const occupancyCandidate = this.candidates.find(row => row.spec.workerId === command.workerId);
    if (occupancyCandidate) this.logLeaseOccupancyTransition(occupancyCandidate, command.leaseId,
      command.generation, command.podUid, this.observationRunId(command.runId), 'quarantined',
      occupancyUnmeasuredReason ? { unmeasuredReason: occupancyUnmeasuredReason } : undefined);
    debug.log('pod.provenance', this.terminalEndLogged.has(key) ? 'lease-late-quarantine' : leaseStarted ? 'lease-end' : 'lease-refused', { podUid: command.podUid,
      leaseId: command.leaseId, runId: command.runId, attemptId: command.attemptId, leaseStarted,
      releasedAt: new Date(this.now()).toISOString(), result: 'quarantined', reason });
    this.terminalEndLogged.add(key);
  }


}

let configuredProvider: WarmPodProvider | null = null;
/** The trusted producer configures this once; an absent provider fails closed without creating a Pod. */
export function configureWarmPodProvider(provider: WarmPodProvider | null): void { configuredProvider = provider; }
/** Optional private producer config; a missing/unsafe file leaves the Job path untouched. */
export function loadWarmPodProvider(path: string, pairingGateFileOrOptions?: string | WarmPodProviderLoadOptions): WarmPodProvider {
  const pairingGateFile = typeof pairingGateFileOrOptions === 'string'
    ? pairingGateFileOrOptions : pairingGateFileOrOptions?.pairingGateFile;
  const runtimeOverrides = typeof pairingGateFileOrOptions === 'object'
    ? pairingGateFileOrOptions?.runtimeOverrides ?? {} : {};
  if (!isAbsolute(path) || (statSync(path).mode & 0o077) !== 0) throw new Error('warm provider config must be private');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid warm provider config');
  const options = parsed as WarmPodProviderOptions;
  // JSON cannot carry a real OS binding: only the unsupported-platform declaration is meaningful here.
  // Omitting the field keeps this platform's dlopen binding (undefined), so the default path is unchanged.
  if (options.prepareFlock !== undefined && options.prepareFlock !== null && options.prepareFlock !== false)
    throw new Error('invalid warm provider prepare flock');
  // The production entry points (--prepare/--reconcile/--serve) bind the 1-file gate key here.
  if (pairingGateFile !== undefined) {
    if (!pairingGateFile.trim()) throw new Error('warm provider pairing gate file must not be empty');
    options.pairingGateFile = pairingGateFile;
  }
  return new WarmPodProvider({ ...options, ...runtimeOverrides,
    rotationStatePath: options.rotationStatePath ?? `${path}.rotations`,
    phaseFenceStatePath: options.phaseFenceStatePath ?? `${path}.phase-fence` });
}
function currentProvider(): WarmPodProvider | null {
  if (configuredProvider) return configuredProvider;
  const file = process.env.ELANOUS_WARM_POD_PROVIDER_CONFIG;
  if (!file) return null;
  try { configuredProvider = loadWarmPodProvider(file); }
  catch { return null; }
  return configuredProvider;
}
export async function requestWarmPodReplay(input: WarmReplayInput,
  providerOverrideForTest?: WarmPodProvider,
  selection?: { kind?: WarmPodKind; lockHash?: string; cutShaDistance?: number; runtimeIdentity?: RuntimeIdentityInput;
    runtimeContract?: NonNullable<WarmPodSpec['runtimeContract']>; imageDigest?: string }): Promise<WarmReplayResult> {
  const provider = providerOverrideForTest ?? currentProvider();
  const result = provider ? await provider.request(input, selection) : fallback('no-candidate');
  debug.log('pod.warm', 'request-selection', { runId: input.runId, attemptId: input.attemptId,
    cutSha: input.cutSha, selected: result.command !== null,
    workerId: result.command?.workerId ?? null, status: result.transport.status,
    reason: result.transport.reason });
  if (result.command && result.transport.status === 'observed' && result.transport.reason === 'complete')
    debug.log('pod.reuse', 'warm-worker-selected', { runId: input.runId,
    attemptId: input.attemptId, workerId: result.command.workerId, podUid: result.command.podUid });
  return result;
}
export async function quarantineWarmPodReplay(command: WarmWorkerCommand, reason: string): Promise<void> {
  const provider = currentProvider();
  if (!provider) throw new Error('warm provider unavailable');
  await provider.quarantine(command, reason);
}
export async function finalizeWarmPodReplay(command: WarmWorkerCommand): Promise<void> {
  const provider = currentProvider();
  if (!provider) throw new Error('warm provider unavailable');
  await provider.finalize(command);
}


/** CLI 인자 — `--prepare <workerId> [gateFile]` · `--reconcile [gateFile]` · `--serve [gateFile]` · `--pairs`.
 *  gateFile 은 --prepare 에서만 셋째 칸, 나머지는 둘째 칸이다. `--pairs` 는 logs.db 읽기 전용(인자 없음). */
export function parseWarmPodProviderArgs(argv: readonly string[]): { action: '--prepare' | '--reconcile' | '--serve' | '--pairs'; workerId?: string; gateFile?: string } {
  const usage = () => new Error('usage: --prepare <workerId> [gateFile] | --reconcile [gateFile] | --serve [gateFile]'
    + ' with private provider config | --pairs');
  if (argv[0] === '--pairs') {
    if (argv.length !== 1) throw usage();
    return { action: '--pairs' };
  }
  const [action, ...rest] = argv;
  if (action === '--prepare') {
    const [workerId, gateFile, extra] = rest;
    if (!workerId || extra !== undefined || (gateFile !== undefined && !gateFile.trim())) throw usage();
    return { action, workerId, ...(gateFile !== undefined ? { gateFile } : {}) };
  }
  if (action === '--reconcile' || action === '--serve') {
    const [gateFile, extra] = rest;
    if (extra !== undefined || (gateFile !== undefined && !gateFile.trim())) throw usage();
    return { action, ...(gateFile !== undefined ? { gateFile } : {}) };
  }
  throw usage();
}

export interface WarmPodProviderCliDependencies {
  providerRuntime?: Partial<WarmPodProviderRuntimeOverrides>;
  write?: (line: string) => void;
  registerLogSink?: (name: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function runWarmPodProviderCli(argv: readonly string[] = process.argv.slice(2),
  dependencies: WarmPodProviderCliDependencies = {}): Promise<{
    exitCode: number;
    result?: WarmPoolReconcileResult | null;
    prepared?: boolean;
  }> {
  const { action, workerId, gateFile } = parseWarmPodProviderArgs(argv);
  const write = dependencies.write ?? ((line: string) => { process.stdout.write(line); });
  const file = process.env.ELANOUS_WARM_POD_PROVIDER_CONFIG;
  // The 1-file gate key this pool serves, bound into every cold prepare leg of this process.
  const load = () => {
    if (!file) return null;
    return loadWarmPodProvider(file, { pairingGateFile: gateFile, runtimeOverrides: dependencies.providerRuntime });
  };
  if (action === '--pairs') {
    // Read-only: join the cold CLI legs and the warm gate legs both processes wrote to logs.db.
    try {
      const storeMod = await import('../../mss/logging/log-store.js');
      const dbPath = storeMod.logsDbPath();
      // No logs.db yet means no leg was ever measured: an empty pair list, not a failed query.
      if (!existsSync(dbPath)) write(JSON.stringify({ warmReuseTimePairs: [] }) + '\n');
      else {
        const store = storeMod.LogStore.openReadOnly(dbPath);
        try { write(JSON.stringify({ warmReuseTimePairs: readWarmReuseTimePairs(store) }) + '\n'); }
        finally { store.close(); }
      }
    } catch (error) {
      write(JSON.stringify({ warmReuseTimePairs: null, reason: 'logs-unavailable', detail: String(error) }) + '\n');
      return { exitCode: 2 };
    }
    return { exitCode: 0 };
  }
  // The cold legs must reach the same logs.db the warm gate process (gate-node) writes; fail-open.
  try {
    if (dependencies.registerLogSink) await dependencies.registerLogSink('pod-warm');
    else await (await import('../../domains/standalone-log-sink.js')).registerStandaloneLogSink('pod-warm');
  }
  catch { /* the file trail stays the source of truth */ }
  // This process's own legs, echoed for the caller; the pair itself is read with --pairs.
  const emitPairs = (provider: WarmPodProvider) => {
    const legs = provider.warmReuseTimeLegs();
    if (legs.length) write(JSON.stringify({ warmReuseTimeLegs: legs }) + '\n');
  };
  if (action === '--serve') {
    // Reloading the private config lets the owner rotate a quarantined slot to a new worker ID.
    // The old ID remains fenced in the ledger; this loop never deletes a Pod or rewrites the ledger.
    while (true) {
      try {
        const provider = load();
        const result = provider ? await provider.reconcilePool() : null;
        write(JSON.stringify(result ?? { target: 0, ready: 0, failed: ['config-unavailable'] }) + '\n');
        if (provider) emitPairs(provider);
      } catch {
        debug.log('pod.warm', 'pool-reconcile-unavailable', { reason: 'config-unavailable' }, { level: 'warn' });
        write(JSON.stringify({ target: 0, ready: 0, failed: ['config-unavailable'] }) + '\n');
      }
      await (dependencies.sleep ?? Bun.sleep)(60_000);
    }
    return { exitCode: 0 };
  }
  if (action === '--reconcile') {
    let result: WarmPoolReconcileResult | null = null;
    let provider: WarmPodProvider | null = null;
    try { provider = load(); result = provider ? await provider.reconcilePool() : null; }
    catch { /* An invalid private config is a failed pass, never a Pod mutation. */ }
    write(JSON.stringify(result ?? { target: 0, ready: 0, failed: ['config-unavailable'] }) + '\n');
    if (provider) emitPairs(provider);
    return { exitCode: !result || result.ready !== result.target || result.failed.length > 0 ? 2 : 0, result };
  } else if (action === '--prepare') {
    let prepared = false;
    let provider: WarmPodProvider | null = null;
    try { provider = load(); prepared = provider ? await provider.prepareWorker(workerId!) : false; }
    catch { /* An invalid private config is a failed preparation, never a Pod mutation. */ }
    write(JSON.stringify({ workerId, prepared }) + '\n');
    if (provider) emitPairs(provider);
    return { exitCode: prepared ? 0 : 2, prepared };
  }
  return { exitCode: 2 };
}

if (import.meta.main) {
  try { process.exitCode = (await runWarmPodProviderCli()).exitCode; }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
