/** Fenced warm-Pod lease bridge with one-worker-per-host preparation. The Job remains authoritative. */
import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { debug } from '../../debug/log.js';
import { getUserConfig } from '../../user-config.js';
import { resolveWarmPoolProfile, resolveWarmPoolQuota, type WarmPoolTier } from '../../self-implement/pod-warm-pool-profile.js';
import { WarmPodTransport, probeWarmPodContext, warmWorkerPodManifest, type WarmPodSpec, type WarmPodTransportResult } from './pod-warm-worker-pod.js';
import type { WarmWorkerCommand } from './pod-warm-worker-protocol.js';
import { patchWarmLeaseMetadata, warmLeaseMetadata } from './pod-warm-provenance.js';

// Cold source install on node-b exceeded the old five-minute Ready wait (2026-10-20).
const POD_READY_WAIT_SECONDS = 900;

export type WarmReplayInput = Omit<WarmWorkerCommand, 'leaseId' | 'generation' | 'workerId' | 'key'>;
export interface WarmReplayResult { command: WarmWorkerCommand | null; transport: WarmPodTransportResult }
export interface WarmWorkerCandidate { host: string; tier: WarmPoolTier; spec: WarmPodSpec }
export interface WarmPodProviderOptions {
  candidates: readonly WarmWorkerCandidate[];
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
}

const fallback = (reason: 'no-candidate' | 'lease-unavailable'): WarmReplayResult =>
  ({ command: null, transport: { status: 'fallback', reason, reply: null } });
const keyEquals = (left: WarmPodSpec['key'], right: WarmPodSpec['key']) =>
  left.context === right.context && left.imageDigest === right.imageDigest
  && left.lockHash === right.lockHash && left.architecture === right.architecture;
const token = (value: string | undefined): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const workerId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value);

export class WarmPodProvider {
  private readonly fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  constructor(private readonly options: WarmPodProviderOptions) {
    const url = new URL(options.controlUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || !token(options.memberToken)) throw new Error('invalid warm control address');
    if (options.candidates.some(candidate => !workerId(candidate.spec.workerId)
      || !candidate.host.trim() || resolveWarmPoolQuota(resolveWarmPoolProfile(options.profileConfig ?? getUserConfig()), candidate.host, candidate.tier) < 1
      || candidate.spec.memoryLimit !== (candidate.tier === 'lite' ? '2Gi' : '16Gi')
      || !warmWorkerPodManifest(candidate.spec))) throw new Error('invalid warm candidate');
    if (new Set(options.candidates.map(candidate => candidate.spec.workerId)).size !== options.candidates.length)
      throw new Error('duplicate warm worker ID');
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

  /** Prepare at most one standing worker per host. A foreign or replaced Pod is never deleted. */
  async ensureStandingWorker(candidate: WarmWorkerCandidate): Promise<boolean> {
    const configured = this.options.candidates.find(row => row.host === candidate.host
      && row.spec.workerId === candidate.spec.workerId && row.spec.cutSha === candidate.spec.cutSha
      && keyEquals(row.spec.key, candidate.spec.key));
    // A single API name per host makes concurrent creates contend on Kubernetes object identity.
    if (!configured || !configured.spec.nodeName || configured.spec.name !== `warm-${configured.host}`
      || candidate.spec.name !== configured.spec.name || candidate.spec.nodeName !== configured.spec.nodeName) return false;
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
    if (pod && !matches(pod)) return false;
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
      if (!before || before.length !== 0) return false;
      pod = parse(kubectl(['create', '-f', '-', '-o', 'json'], JSON.stringify(manifest)));
      if (!matches(pod)) return false;
    }
    const uid = pod.metadata.uid as string;
    if (kubectl(['wait', `pod/${spec.name}`, '--for=condition=Ready', `--timeout=${POD_READY_WAIT_SECONDS}s`]).status !== 0) return false;
    const ready = parse(kubectl(['get', `pod/${spec.name}`, '-o', 'json']));
    if (!matches(ready) || ready.metadata.uid !== uid || ready.status?.phase !== 'Running'
      || !ready.status?.conditions?.some((row: any) => row.type === 'Ready' && row.status === 'True')) return false;
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
    const candidate = this.options.candidates.find(row => row.spec.workerId === workerId);
    if (!candidate) return false;
    return this.ensureStandingWorker(candidate);
  }

  /** Acquire a matching idle worker before exec. Every uncertain result is fenced out of reuse. */
  async request(input: WarmReplayInput): Promise<WarmReplayResult> {
    if (input.protocol !== 1 || input.envProfile !== 'gate-v1' || !Array.isArray(input.files)
      || !input.files.length || !Number.isFinite(input.deadlineAt) || input.deadlineAt <= this.now()) return fallback('no-candidate');
    const candidate = this.options.candidates.find(row => row.spec.cutSha === input.cutSha);
    if (!candidate) return fallback('no-candidate');
    const { spec, host } = candidate;
    const contextFailure = probeWarmPodContext(spec.kubectlContext, this.options.kubectl);
    if (contextFailure) return { command: null, transport: contextFailure };
    let acquired: { status: number; value: any };
    try {
      acquired = await this.control('/v1/leases/pod-worker', this.options.memberToken, {
        machine: host, key: spec.key, runId: input.runId, attemptId: input.attemptId,
        ttlMs: this.options.leaseTtlMs ?? 30 * 60_000,
      });
    } catch { return fallback('lease-unavailable'); }
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
    const leasedCandidate = this.options.candidates.find(entry => entry.host === host
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
    if (transport.status !== 'observed' || transport.reason !== 'complete') {
      await this.quarantine(command, transport.reason);
      return { command, transport };
    }
    // Keep the lease fenced until the gate has compared these bytes with its Job baseline.
    // A missing finalization leaves the worker leased and therefore unavailable.
    return { command, transport };
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
    const candidate = this.options.candidates.find(row => row.spec.workerId === command.workerId);
    if (!candidate) throw new Error('warm finalize candidate missing');
    const released = await this.transition(command, 'release');
    const machineToken = this.options.machineTokens?.[candidate.host];
    // Sanitizing is the producer's machine-scoped acknowledgement, after transport's cleanup and ACK.
    const cleared = released ? patchWarmLeaseMetadata(candidate.spec, command, 'idle', this.options.kubectl)
      : { ok: false, reason: 'release-failed' };
    if (!cleared.ok) debug.log('pod.provenance', 'lease-patch-refused', { pod: candidate.spec.name,
      podUid: command.podUid, leaseId: command.leaseId, reason: cleared.reason }, { level: 'warn' });
    if (!cleared.ok || !token(machineToken) || !await this.transition(command, 'sanitize', machineToken)) {
      await this.quarantine(command, 'sanitize-unavailable');
      throw new Error('warm sanitize unavailable');
    }
    debug.log('pod.provenance', 'lease-end', { pod: candidate.spec.name, podUid: command.podUid,
      leaseId: command.leaseId, runId: command.runId, attemptId: command.attemptId,
      releasedAt: new Date(this.now()).toISOString(), result: 'sanitized' });
  }

  /** `leaseStarted=false` marks a refusal before `lease-start`, so start/end history stays paired. */
  async quarantine(command: WarmWorkerCommand, reason: string, leaseStarted = true): Promise<void> {
    if (!await this.transition(command, 'quarantine', this.options.memberToken, reason.slice(0, 120) || 'mismatch')) {
      throw new Error('warm quarantine unavailable');
    }
    const candidate = this.options.candidates.find(row => row.spec.workerId === command.workerId);
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
export function loadWarmPodProvider(path: string): WarmPodProvider {
  if (!isAbsolute(path) || (statSync(path).mode & 0o077) !== 0) throw new Error('warm provider config must be private');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid warm provider config');
  return new WarmPodProvider(parsed as WarmPodProviderOptions);
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
  return currentProvider() ? currentProvider()!.request(input) : fallback('no-candidate');
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

if (import.meta.main) {
  const [action, workerId] = process.argv.slice(2);
  const file = process.env.ELANOUS_WARM_POD_PROVIDER_CONFIG;
  if (action !== '--prepare' || !workerId) throw new Error('usage: --prepare <workerId> with private provider config');
  let prepared = false;
  try { if (file) prepared = await loadWarmPodProvider(file).prepareWorker(workerId); }
  catch { /* An invalid private config is a failed preparation, never a Pod mutation. */ }
  process.stdout.write(JSON.stringify({ workerId, prepared }) + '\n');
  if (!prepared) process.exitCode = 2;
}
