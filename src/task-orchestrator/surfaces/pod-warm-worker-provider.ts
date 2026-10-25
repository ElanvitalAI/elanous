/** Fenced warm-Pod lease bridge. The Job remains authoritative. */
import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { constants, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dlopen, read, type Pointer } from 'bun:ffi';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { debug } from '../../debug/log.js';
import { getUserConfig } from '../../user-config.js';
import { resolveWarmPoolProfile, resolveWarmPoolQuota, type WarmPoolProfile, type WarmPoolTier } from '../../self-implement/pod-warm-pool-profile.js';
import { WarmPodTransport, probeWarmPodContext, warmWorkerPodManifest, type WarmPodSpec, type WarmPodTransportResult } from './pod-warm-worker-pod.js';
import type { WarmWorkerCommand } from './pod-warm-worker-protocol.js';
import { patchWarmLeaseMetadata, warmLeaseMetadata } from './pod-warm-provenance.js';
import type { LogStore } from '../../mss/logging/log-store.js';

// Cold source install on node-b exceeded five minutes; recheck the pinned Pod UID in bounded intervals.
const POD_READY_WAIT_SECONDS = 900;
const POD_READY_RECHECK_SECONDS = 300;
const POD_READY_RETRY_DELAY_MS = 1_000;

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
export interface WarmWorkerCandidate { host: string; tier: WarmPoolTier; spec: WarmPodSpec }
export interface WarmPodProviderOptions {
  candidates: readonly WarmWorkerCandidate[];
  /** One pinned template per host/tier. Each expands to the measured profile quota. */
  poolTemplates?: readonly WarmWorkerCandidate[];
  /** This address is resolved by the control-plane join/primary mechanism, never guessed from a Pod context. */
  controlUrl: string;
  memberToken: string;
  /** Only the trusted producer host has these credentials; consumers may omit them. */
  machineTokens?: Readonly<Record<string, string>>;
  profileConfig?: unknown;
  leaseTtlMs?: number;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  transport?: (spec: WarmPodSpec) => Pick<WarmPodTransport, 'request'>;
  maxShadowMs?: number;
  now?: () => number;
  kubectl?: (args: readonly string[], input?: string) => { status: number | null; stdout: string; stderr: string };
  /** Private directory for cross-process prepare leases; defaults to a per-user directory under tmpdir(). */
  prepareLockDirectory?: string;
  /** Cancels a prepare waiting for another process to finish the same host/worker slot. */
  prepareAbortSignal?: AbortSignal;
  /** Gate file this pool serves, used to bind cold prepare legs to their 1-file gate measurement key. */
  pairingGateFile?: string;
}

export interface WarmPoolReconcileResult {
  profile: string;
  target: number;
  ready: number;
  failed: readonly string[];
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
const prepareFlock = prepareLockLib?.symbols.flock ?? null;
const prepareErrnoLocation = prepareLockLib?.symbols[process.platform === 'linux' ? '__errno_location' : '__error'];
const readPrepareErrno = (): number => (prepareErrnoLocation ? read.i32(prepareErrnoLocation() as Pointer) : -1);
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const PREPARE_LOCK_WAIT_MS = (POD_READY_WAIT_SECONDS * 1_000) + 30_000;

async function withPrepareLease<T>(candidate: WarmWorkerCandidate, directory: string | undefined,
  work: () => Promise<T>, signal?: AbortSignal): Promise<T | null> {
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
    if (!prepareFlock) throw new Error('warm prepare OS locks are unavailable on this platform');
    const lockDeadline = performance.now() + PREPARE_LOCK_WAIT_MS;
    while (!acquired) {
      if (signal?.aborted) throw new Error('warm prepare lock wait cancelled');
      if (prepareFlock(fd, LOCK_EX | LOCK_NB) === 0) { acquired = true; break; }
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
    if (acquired && fd !== undefined) prepareFlock?.(fd, LOCK_UN);
    if (fd !== undefined) closeSync(fd);
  }
}

export class WarmPodProvider {
  private readonly fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly candidates: readonly WarmWorkerCandidate[];
  private readonly profile: WarmPoolProfile;
  /** This process's own legs, echoed on CLI stdout. Pairing never reads this — see readWarmReuseTimePairs. */
  private readonly legs: WarmReuseTimeLegRow[] = [];
  /** One terminal transition per fenced lease, including concurrent callers. Failed transitions remain retryable. */
  private readonly terminalLeases = new Map<string, Promise<'sanitized' | 'quarantined'>>();
  private readonly standingWorkers = new Map<string, Promise<boolean>>();
  constructor(private readonly options: WarmPodProviderOptions) {
    const url = new URL(options.controlUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || !token(options.memberToken)) throw new Error('invalid warm control address');
    const profile = resolveWarmPoolProfile(options.profileConfig ?? getUserConfig());
    this.profile = profile;
    const templates = options.poolTemplates ?? [];
    if (new Set(templates.map(candidate => `${candidate.host}/${candidate.tier}`)).size !== templates.length)
      throw new Error('duplicate warm pool template');
    const expanded = templates.flatMap(candidate => {
      const quota = resolveWarmPoolQuota(profile, candidate.host, candidate.tier);
      if (!quota || !candidate.spec.nodeName) throw new Error('unmeasured warm pool template');
      return Array.from({ length: quota }, (_, index): WarmWorkerCandidate => ({
        host: candidate.host, tier: candidate.tier, spec: {
          ...candidate.spec,
          name: `warm-${candidate.host}-${candidate.tier}-${index + 1}`,
          // The template worker ID is a generation token. Rotate it when a slot is quarantined.
          workerId: `${candidate.spec.workerId}-${candidate.tier}-${index + 1}`,
        },
      }));
    });
    this.candidates = [...options.candidates, ...expanded];
    if (this.candidates.some(candidate => !workerId(candidate.spec.workerId)
      || !candidate.host.trim() || resolveWarmPoolQuota(profile, candidate.host, candidate.tier) < 1
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
      if (count > resolveWarmPoolQuota(profile, candidate.host, candidate.tier))
        throw new Error('warm candidate quota exceeded');
      counts.set(slot, count);
    }
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async control(path: string, credential: string, body?: Record<string, unknown>): Promise<{ status: number; value: any }> {
    const response = await this.fetcher(new URL(path, this.options.controlUrl), {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${credential}`,
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
    });
    let value: any = null;
    try { value = await response.json(); } catch { /* A missing body is a failed admission. */ }
    return { status: response.status, value };
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
  async ensureStandingWorker(candidate: WarmWorkerCandidate): Promise<boolean> {
    const configured = this.candidates.find(row => row.host === candidate.host
      && row.spec.workerId === candidate.spec.workerId);
    if (!configured) return false;
    const key = `${configured.host}/${configured.spec.workerId}`;
    const inFlight = this.standingWorkers.get(key);
    if (inFlight) return inFlight;
    const preparation = withPrepareLease(configured, this.options.prepareLockDirectory,
      () => this.prepareStandingWorker(configured, this.options.prepareAbortSignal), this.options.prepareAbortSignal)
      .then(result => result === true);
    this.standingWorkers.set(key, preparation);
    try { return await preparation; }
    finally { if (this.standingWorkers.get(key) === preparation) this.standingWorkers.delete(key); }
  }

  private async prepareStandingWorker(candidate: WarmWorkerCandidate, signal?: AbortSignal): Promise<boolean> {
    throwIfPrepareAborted(signal);
    const startedAt = this.now();
    const outcome: { preexisting: boolean; podUid: string | null } = { preexisting: false, podUid: null };
    const ok = await this.coldPrepare(candidate, outcome, signal);
    const totalDurationMs = this.now() - startedAt;
    const gateFile = this.options.pairingGateFile;
    // An unset gate file skips the measurement row entirely instead of recording an unpaired one.
    if (gateFile) this.recordPair('cold', gateFile, candidate.spec.cutSha, candidate.host,
      { reuse: outcome.preexisting, prepareDurationMs: outcome.preexisting ? 0 : totalDurationMs,
        totalDurationMs, podUid: outcome.podUid ?? '', success: ok });
    return ok;
  }

  private async coldPrepare(candidate: WarmWorkerCandidate,
    outcome: { preexisting: boolean; podUid: string | null }, signal?: AbortSignal): Promise<boolean> {
    const configured = this.candidates.find(row => row.host === candidate.host
      && row.spec.workerId === candidate.spec.workerId && row.spec.cutSha === candidate.spec.cutSha
      && keyEquals(row.spec.key, candidate.spec.key));
    // Legacy slot warm-HOST and numbered profile slots can coexist during migration.
    const prefix = configured ? `warm-${configured.host}` : '';
    const suffix = configured?.spec.name.startsWith(`${prefix}-`)
      ? configured.spec.name.slice(prefix.length + 1) : '';
    if (!configured || !configured.spec.nodeName
      || (configured.spec.name !== prefix && !/^[1-9][0-9]*$/.test(suffix)
        && !/^(lite|standard)-[1-9][0-9]*$/.test(suffix))
      || candidate.spec.name !== configured.spec.name || candidate.spec.nodeName !== configured.spec.nodeName) return false;
    throwIfPrepareAborted(signal);
    const { spec, host } = configured;
    const nodeName = spec.nodeName;
    if (!nodeName) return false;
    const credential = this.options.machineTokens?.[host];
    if (!token(credential)) return false;
    const manifest = warmWorkerPodManifest(spec);
    const metadata = manifest.metadata as { labels: Record<string, string>; annotations: Record<string, string> };
    const template = manifest.spec as Record<string, unknown>;
    const kubectl = (args: readonly string[], input?: string) => {
      const argv = ['--context', spec.kubectlContext, '-n', spec.namespace, ...args];
      if (this.options.kubectl) return this.options.kubectl(argv, input);
      const env = { ...process.env };
      for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[name];
      // A new standing worker can spend more than five minutes in its cold init
      // containers. argv[0..3] is context/namespace; argv[4] is the verb.
      // Keep the process deadline beyond kubectl's Ready deadline.
      const result = spawnSync('kubectl', argv, { encoding: 'utf8', input, env,
        timeout: argv[4] === 'wait' ? (POD_READY_WAIT_SECONDS + 30) * 1000 : 360_000,
        maxBuffer: 2 * 1024 * 1024 });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
    const parse = (result: { status: number | null; stdout: string }) => {
      if (result.status !== 0) return null;
      try { return JSON.parse(result.stdout) as any; } catch { return null; }
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
    const normalizedSpec = (actual: any): Record<string, unknown> | null => {
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
    const matches = (pod: any): boolean => typeof pod?.metadata?.uid === 'string' && !!pod.metadata.uid
      && pod.metadata.name === spec.name && pod.metadata.namespace === spec.namespace
      && !pod.metadata.deletionTimestamp
      && (pod.metadata.ownerReferences === undefined || (Array.isArray(pod.metadata.ownerReferences)
        && pod.metadata.ownerReferences.length === 0))
      && Object.entries(metadata.labels).every(([key, value]) => pod.metadata.labels?.[key] === value)
      && Object.entries(metadata.annotations).every(([key, value]) => pod.metadata.annotations?.[key] === value)
      && pod.spec?.nodeName === nodeName
      && sameSpec(normalizedSpec(pod.spec), template);
    // Read the whole namespace: a Pod for this host on another node must block
    // creation, and another host's standing worker must not consume this slot.
    const listed = parse(kubectl(['get', 'pods', '-o', 'json']));
    if (!Array.isArray(listed?.items)) return false;
    const hostPods = listed.items.filter((row: any) => row?.metadata?.name === spec.name
      || row?.metadata?.annotations?.['elanous.dev/warm-worker-id'] === spec.workerId);
    if (hostPods.length > 1) return false;
    let pod = hostPods[0];
    const preexisting = !!pod;
    outcome.preexisting = preexisting;
    if (pod && !matches(pod)) return false;
    // Old generations still occupy memory even when their ledger rows are quarantined.
    // Count physical warm Pods on the pinned node before admitting a new one.
    const physical = listed.items.filter((row: any) => row?.metadata?.labels?.['elanous.kind'] === 'warm-worker'
      && row?.spec?.nodeName === nodeName && !row?.metadata?.deletionTimestamp
      && row?.status?.phase !== 'Succeeded' && row?.status?.phase !== 'Failed'
      && row?.spec?.containers?.[0]?.resources?.limits?.memory === spec.memoryLimit).length;
    if (!preexisting && physical >= resolveWarmPoolQuota(this.profile, host, configured.tier)) {
      debug.log('pod.warm', 'pool-slot-refused', { host, tier: configured.tier,
        workerId: spec.workerId, reason: 'physical-quota', physical }, { level: 'warn' });
      return false;
    }
    const readLedger = async (): Promise<any[] | null> => {
      try {
        const query = new URLSearchParams({ kind: 'pod-worker-lease', machine: host, name: spec.workerId });
        const ledger = await this.control(`/v1/resources?${query}`, credential);
        return ledger.status === 200 && Array.isArray(ledger.value?.resources)
          && ledger.value.resources.length <= 1 ? ledger.value.resources : null;
      } catch { return null; }
    };
    if (!pod) {
      // A worker ID already bound to another UID must not leave a newly created, unregistered Pod.
      const before = await readLedger();
      throwIfPrepareAborted(signal);
      if (!before || before.length !== 0) return false;
      pod = parse(kubectl(['create', '-f', '-', '-o', 'json'], JSON.stringify(manifest)));
      if (!matches(pod)) return false;
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
      if (!matches(observed) || observed.metadata.uid !== uid) return false;
      if (this.now() < deadline) await waitForPrepareRetry(signal);
    }
    if (!isReady) return false;
    // Re-read after create: a registration racing the preflight must fail before our POST.
    const rows = await readLedger();
    if (!rows) return false;
    const existing = rows[0];
    const leaseTtlMs = this.options.leaseTtlMs ?? 30 * 60_000;
    if (existing) return preexisting && existing.kind === 'pod-worker-lease'
      && existing.machine === host && existing.name === spec.workerId
      && (existing.attrs?.state === 'idle' || existing.attrs?.state === 'leased')
      && existing.attrs?.podUid === uid
      && Number.isSafeInteger(existing.observedAt) && Number.isSafeInteger(existing.ttlMs)
      && existing.ttlMs === leaseTtlMs && existing.attrs?.idleTtlMs === leaseTtlMs
      && existing.observedAt <= Date.now()
      && Date.now() - existing.observedAt < existing.ttlMs
      && existing.attrs?.key && keyEquals(existing.attrs.key, spec.key);
    // An unregistered Pod could have been created by anyone with namespace access.
    // Only this invocation's successful create response may become a new ledger row.
    if (preexisting) return false;
    throwIfPrepareAborted(signal);
    let registered: { status: number; value: any };
    try {
      registered = await this.control('/v1/workers/pod', credential, {
        workerId: spec.workerId, machine: host, podUid: uid, key: spec.key,
        ttlMs: leaseTtlMs,
      });
    } catch { return false; }
    return registered.status === 200 && registered.value?.name === spec.workerId
      && registered.value?.attrs?.state === 'idle'
      && registered.value?.attrs?.podUid === uid
      && !!registered.value.attrs.key && keyEquals(registered.value.attrs.key, spec.key);
  }

  async prepareWorker(workerId: string): Promise<boolean> {
    const candidate = this.candidates.find(row => row.spec.workerId === workerId);
    if (!candidate) return false;
    return this.ensureStandingWorker(candidate);
  }

  /** One bounded reconciliation pass. Failed slots stay unavailable until a fresh worker ID is configured. */
  async reconcilePool(): Promise<WarmPoolReconcileResult> {
    const failed: string[] = [];
    let ready = 0;
    for (const candidate of this.candidates) {
      let prepared = false;
      try { prepared = await this.ensureStandingWorker(candidate); }
      catch { /* Uncertain state is never counted as ready. */ }
      if (prepared) ready++;
      else failed.push(candidate.spec.workerId);
      debug.log('pod.warm', 'pool-slot', { profile: this.profile,
        host: candidate.host, tier: candidate.tier, workerId: candidate.spec.workerId,
        pod: candidate.spec.name, ready: prepared }, { level: prepared ? 'info' : 'warn' });
    }
    const result = { profile: this.profile,
      target: this.candidates.length, ready, failed };
    debug.log('pod.warm', 'pool-reconcile', result, { level: failed.length ? 'warn' : 'info' });
    return result;
  }

  /** Acquire a matching idle worker before exec. Every uncertain result is fenced out of reuse. */
  async request(input: WarmReplayInput): Promise<WarmReplayResult> {
    const requestedAt = this.now();
    if (input.protocol !== 1 || input.envProfile !== 'gate-v1' || !Array.isArray(input.files)
      || !input.files.length || !Number.isFinite(input.deadlineAt) || input.deadlineAt <= this.now()) return fallback('no-candidate');
    const matches = this.candidates.filter(row => row.spec.cutSha === input.cutSha);
    if (!matches.length) return fallback('no-candidate');
    let lastFallback: WarmReplayResult = fallback('lease-unavailable');
    // The control plane chooses an idle worker within a host/key. Probe each distinct
    // host/key once so a busy first host cannot strand an idle second pool.
    const tried = new Set<string>();
    for (const candidate of matches) {
    const { spec, host } = candidate;
    const poolKey = `${host}/${spec.key.context}/${spec.key.imageDigest}/${spec.key.lockHash}/${spec.key.architecture}`;
    if (tried.has(poolKey)) continue;
    tried.add(poolKey);
    const contextFailure = probeWarmPodContext(spec.kubectlContext, this.options.kubectl);
    if (contextFailure) { lastFallback = { command: null, transport: contextFailure }; continue; }
    let acquired: { status: number; value: any };
    try {
      acquired = await this.control('/v1/leases/pod-worker', this.options.memberToken, {
        machine: host, key: spec.key, runId: input.runId, attemptId: input.attemptId,
        ttlMs: this.options.leaseTtlMs ?? 30 * 60_000,
      });
    } catch { lastFallback = fallback('lease-unavailable'); continue; }
    if (acquired.status === 409 || acquired.status === 503) {
      lastFallback = fallback('lease-unavailable');
      continue;
    }
    if (acquired.status !== 200) return fallback('lease-unavailable');
    const row = acquired.value;
    const leasedId = row?.attrs?.leaseId;
    const generation = row?.attrs?.generation;
    const podUid = row?.attrs?.podUid;
    if (!workerId(row?.name) || typeof leasedId !== 'string' || !leasedId
      || typeof podUid !== 'string' || !podUid
      || !Number.isSafeInteger(generation) || generation < 1) return fallback('lease-unavailable');
    // Acquisition selects by host/key, not by worker ID. Resolve the returned worker
    // before choosing its transport; an unknown worker must not be executed or fenced.
    const leasedCandidate = this.candidates.find(entry => entry.host === host
      && entry.spec.workerId === row.name && entry.spec.cutSha === input.cutSha
      && keyEquals(entry.spec.key, spec.key));
    if (!leasedCandidate) {
      debug.log('pod.warm', 'lease-candidate-unmatched', { host, workerId: row.name,
        runId: input.runId, attemptId: input.attemptId }, { level: 'warn' });
      return fallback('lease-unavailable');
    }
    if (!row.attrs?.key || !keyEquals(row.attrs.key, leasedCandidate.spec.key)) {
      const command: WarmWorkerCommand = { ...input, leaseId: leasedId, generation, podUid,
        requestedAt: new Date(this.now()).toISOString(),
        workerId: row.name, key: leasedCandidate.spec.key };
      await this.quarantine(command, 'candidate-identity-mismatch', false);
      return fallback('lease-unavailable');
    }
    const command: WarmWorkerCommand = { ...input, leaseId: leasedId, generation, podUid,
      podName: leasedCandidate.spec.name, podContext: leasedCandidate.spec.kubectlContext, image: leasedCandidate.spec.image,
      requestedAt: new Date(this.now()).toISOString(),
      workerId: row.name, key: leasedCandidate.spec.key };
    const admitted = patchWarmLeaseMetadata(leasedCandidate.spec, command, 'leased', this.options.kubectl);
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
    try { transport = await this.runTransport(leasedCandidate.spec, command); }
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
    const terminal = this.finalizeOnce(command);
    this.terminalLeases.set(key, terminal);
    let outcome: 'sanitized' | 'quarantined';
    try { outcome = await terminal; }
    catch (error) { if (this.terminalLeases.get(key) === terminal) this.terminalLeases.delete(key); throw error; }
    if (outcome === 'quarantined') throw new Error('warm sanitize unavailable');
  }

  private async finalizeOnce(command: WarmWorkerCommand): Promise<'sanitized' | 'quarantined'> {
    const candidate = this.candidates.find(row => row.spec.workerId === command.workerId);
    if (!candidate) throw new Error('warm finalize candidate missing');
    const released = await this.transition(command, 'release');
    const machineToken = this.options.machineTokens?.[candidate.host];
    // Sanitizing is the producer's machine-scoped acknowledgement, after transport's cleanup and ACK.
    const cleared = released ? patchWarmLeaseMetadata(candidate.spec, command, 'idle', this.options.kubectl)
      : { ok: false, reason: 'release-failed' };
    if (!cleared.ok) debug.log('pod.provenance', 'lease-patch-refused', { pod: candidate.spec.name,
      podUid: command.podUid, leaseId: command.leaseId, reason: cleared.reason }, { level: 'warn' });
    if (!cleared.ok || !token(machineToken) || !await this.transition(command, 'sanitize', machineToken)) {
      await this.quarantineOnce(command, 'sanitize-unavailable', true);
      return 'quarantined';
    }
    debug.log('pod.provenance', 'lease-end', { pod: candidate.spec.name, podUid: command.podUid,
      leaseId: command.leaseId, runId: command.runId, attemptId: command.attemptId,
      releasedAt: new Date(this.now()).toISOString(), result: 'sanitized' });
    return 'sanitized';
  }

  /** `leaseStarted=false` marks a refusal before `lease-start`, so start/end history stays paired. */
  async quarantine(command: WarmWorkerCommand, reason: string, leaseStarted = true): Promise<void> {
    const key = JSON.stringify([command.workerId, command.leaseId, command.generation, command.podUid]);
    const prior = this.terminalLeases.get(key);
    if (prior) {
      const outcome = await prior;
      debug.log('pod.provenance', 'lease-terminal-suppressed', { workerId: command.workerId,
        leaseId: command.leaseId, generation: command.generation, requested: 'quarantine', outcome });
      return;
    }
    const terminal = this.quarantineOnce(command, reason, leaseStarted).then(() => 'quarantined' as const);
    this.terminalLeases.set(key, terminal);
    try { await terminal; }
    catch (error) { if (this.terminalLeases.get(key) === terminal) this.terminalLeases.delete(key); throw error; }
  }

  private async quarantineOnce(command: WarmWorkerCommand, reason: string, leaseStarted: boolean): Promise<void> {
    if (!await this.transition(command, 'quarantine', this.options.memberToken, reason.slice(0, 120) || 'mismatch')) {
      throw new Error('warm quarantine unavailable');
    }
    const candidate = this.candidates.find(row => row.spec.workerId === command.workerId);
    if (candidate) {
      const cleared = patchWarmLeaseMetadata(candidate.spec, command, 'quarantined', this.options.kubectl);
      if (!cleared.ok && reason !== 'provenance-unavailable') debug.log('pod.provenance', 'lease-patch-refused', { pod: candidate.spec.name,
        podUid: command.podUid, leaseId: command.leaseId, reason: cleared.reason }, { level: 'warn' });
    }
    debug.log('pod.provenance', leaseStarted ? 'lease-end' : 'lease-refused', { podUid: command.podUid,
      leaseId: command.leaseId, runId: command.runId, attemptId: command.attemptId, leaseStarted,
      releasedAt: new Date(this.now()).toISOString(), result: 'quarantined', reason });
  }


}

let configuredProvider: WarmPodProvider | null = null;
/** The trusted producer configures this once; an absent provider fails closed without creating a Pod. */
export function configureWarmPodProvider(provider: WarmPodProvider | null): void { configuredProvider = provider; }
/** Optional private producer config; a missing/unsafe file leaves the Job path untouched. */
export function loadWarmPodProvider(path: string, pairingGateFile?: string): WarmPodProvider {
  if (!isAbsolute(path) || (statSync(path).mode & 0o077) !== 0) throw new Error('warm provider config must be private');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid warm provider config');
  const options = parsed as WarmPodProviderOptions;
  // The production entry points (--prepare/--reconcile/--serve) bind the 1-file gate key here.
  if (pairingGateFile !== undefined) {
    if (!pairingGateFile.trim()) throw new Error('warm provider pairing gate file must not be empty');
    options.pairingGateFile = pairingGateFile;
  }
  return new WarmPodProvider(options);
}
function currentProvider(): WarmPodProvider | null {
  if (configuredProvider) return configuredProvider;
  const file = process.env.ELANOUS_WARM_POD_PROVIDER_CONFIG;
  if (!file) return null;
  try { configuredProvider = loadWarmPodProvider(file); }
  catch { return null; }
  return configuredProvider;
}
export async function requestWarmPodReplay(input: WarmReplayInput): Promise<WarmReplayResult> {
  const provider = currentProvider();
  const result = provider ? await provider.request(input) : fallback('no-candidate');
  debug.log('pod.warm', 'request-selection', { runId: input.runId, attemptId: input.attemptId,
    cutSha: input.cutSha, selected: result.command !== null,
    workerId: result.command?.workerId ?? null, status: result.transport.status,
    reason: result.transport.reason });
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

if (import.meta.main) {
  const { action, workerId, gateFile } = parseWarmPodProviderArgs(process.argv.slice(2));
  const file = process.env.ELANOUS_WARM_POD_PROVIDER_CONFIG;
  // The 1-file gate key this pool serves, bound into every cold prepare leg of this process.
  const load = () => (file ? loadWarmPodProvider(file, gateFile) : null);
  if (action === '--pairs') {
    // Read-only: join the cold CLI legs and the warm gate legs both processes wrote to logs.db.
    try {
      const storeMod = await import('../../mss/logging/log-store.js');
      const dbPath = storeMod.logsDbPath();
      // No logs.db yet means no leg was ever measured: an empty pair list, not a failed query.
      if (!existsSync(dbPath)) process.stdout.write(JSON.stringify({ warmReuseTimePairs: [] }) + '\n');
      else {
        const store = storeMod.LogStore.openReadOnly(dbPath);
        try { process.stdout.write(JSON.stringify({ warmReuseTimePairs: readWarmReuseTimePairs(store) }) + '\n'); }
        finally { store.close(); }
      }
    } catch (error) {
      process.stdout.write(JSON.stringify({ warmReuseTimePairs: null, reason: 'logs-unavailable', detail: String(error) }) + '\n');
      process.exitCode = 2;
    }
  }
  // The cold legs must reach the same logs.db the warm gate process (gate-node) writes; fail-open.
  if (action !== '--pairs') try { await (await import('../../domains/standalone-log-sink.js')).registerStandaloneLogSink('pod-warm'); }
  catch { /* the file trail stays the source of truth */ }
  // This process's own legs, echoed for the caller; the pair itself is read with --pairs.
  const emitPairs = (provider: WarmPodProvider) => {
    const legs = provider.warmReuseTimeLegs();
    if (legs.length) process.stdout.write(JSON.stringify({ warmReuseTimeLegs: legs }) + '\n');
  };
  if (action === '--serve') {
    // Reloading the private config lets the owner rotate a quarantined slot to a new worker ID.
    // The old ID remains fenced in the ledger; this loop never deletes a Pod or rewrites the ledger.
    while (true) {
      try {
        const provider = load();
        const result = provider ? await provider.reconcilePool() : null;
        process.stdout.write(JSON.stringify(result ?? { target: 0, ready: 0, failed: ['config-unavailable'] }) + '\n');
        if (provider) emitPairs(provider);
      } catch {
        debug.log('pod.warm', 'pool-reconcile-unavailable', { reason: 'config-unavailable' }, { level: 'warn' });
        process.stdout.write(JSON.stringify({ target: 0, ready: 0, failed: ['config-unavailable'] }) + '\n');
      }
      await Bun.sleep(60_000);
    }
  }
  if (action === '--reconcile') {
    let result: WarmPoolReconcileResult | null = null;
    let provider: WarmPodProvider | null = null;
    try { provider = load(); result = provider ? await provider.reconcilePool() : null; }
    catch { /* An invalid private config is a failed pass, never a Pod mutation. */ }
    process.stdout.write(JSON.stringify(result ?? { target: 0, ready: 0, failed: ['config-unavailable'] }) + '\n');
    if (provider) emitPairs(provider);
    if (!result || result.ready !== result.target) process.exitCode = 2;
  } else if (action === '--prepare') {
    let prepared = false;
    let provider: WarmPodProvider | null = null;
    try { provider = load(); prepared = provider ? await provider.prepareWorker(workerId!) : false; }
    catch { /* An invalid private config is a failed preparation, never a Pod mutation. */ }
    process.stdout.write(JSON.stringify({ workerId, prepared }) + '\n');
    if (provider) emitPairs(provider);
    if (!prepared) process.exitCode = 2;
  }
}
