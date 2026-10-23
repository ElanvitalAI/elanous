/** Host-owned si-v1 admission. It never creates a Pod and is inert until explicitly configured. */
import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';
import type { ChildPodLease, ChildPodReuseOperations } from './pod-child-reuse.js';
import { siWarmSha256, type SiWarmCommand, type SiWarmReply, type SiWarmReturnedBytes } from './pod-si-warm-protocol.js';
import type { SiWarmExecReceipt, SiWarmFixedRunner, SiWarmPodIdentity } from './pod-si-warm-transport.js';
import { probeWarmPodContext, type WarmPodSpec } from './pod-warm-worker-pod.js';
import type { WarmWorkerCandidate } from './pod-warm-worker-provider.js';
import { resolveWarmPoolProfile, resolveWarmPoolQuota } from '../../self-implement/pod-warm-pool-profile.js';
import type { SiWarmChildAttempt, Kubectl } from './self-implement-pod.js';
import { debug } from '../../debug/log.js';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const RUNNER = '/workspace/repo/src/task-orchestrator/surfaces/pod-si-warm-runner.ts';
const MAX_OUTPUT = 128 * 1024 * 1024;
const MAX_LEASE_MS = 24 * 60 * 60_000;
type SiWarmLeasedPodIdentity = SiWarmPodIdentity & { kubectlContext: string };
const safeToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);
const sameKey = (a: WarmPodSpec['key'], b: WarmPodSpec['key']) => a.context === b.context
  && a.imageDigest === b.imageDigest && a.lockHash === b.lockHash && a.architecture === b.architecture;

export interface SiWarmProviderInput {
  runId: string;
  attemptId: string;
  executionKey: string;
  sourceSha: string;
  deadlineAt: number;
  payload: Uint8Array;
  credentialBundle: Uint8Array;
  /** Host collector for bytes already verified by the transport. */
  adopt: (command: SiWarmCommand, reply: SiWarmReply, bytes: SiWarmReturnedBytes) => Promise<void>;
}

export interface SiWarmProviderOptions {
  candidates: readonly WarmWorkerCandidate[];
  controlUrl: string;
  memberToken: string;
  machineTokens: Readonly<Record<string, string>>;
  leaseTtlMs?: number;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  kubectl?: Kubectl;
  now?: () => number;
  /** Test seam. Production runs fixed kubectl argv with binary stdin. */
  exec?: (argv: readonly string[], stdin: Uint8Array, timeoutMs: number) => Promise<{ status: number | null; stdout: Uint8Array }>;
  /** A trusted host canary must confirm the fixed si-v1 runner in this exact source Pod. Missing proof is no entry. */
  siRunnerReady?: (spec: WarmPodSpec) => boolean;
  /** Durable host observation hook for ambiguous control-plane transitions. */
  observe?: (event: string, data: Record<string, unknown>) => void;
}

export type SiWarmAcquireResult =
  | { status: 'acquired'; attempt: SiWarmChildAttempt }
  | { status: 'no-entry'; reason: 'disabled' | 'invalid-input' | 'no-candidate' | 'runner-unavailable' | 'context-unavailable' | 'busy' }
  | { status: 'uncertain'; reason: string };

function defaultKubectl(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[name];
  const result = spawnSync('kubectl', [...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env });
  return { status: result.status, stdout: result.stdout ?? '', stderr: '' };
}

/** Kill the process group on timeout, including kubectl's remote stream. Never expose stderr. */
async function defaultExec(argv: readonly string[], stdin: Uint8Array, timeoutMs: number): Promise<{ status: number | null; stdout: Uint8Array }> {
  return new Promise(resolve => {
    const env = { ...process.env };
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[name];
    const child = spawn('kubectl', [...argv], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    const chunks: Buffer[] = [];
    let length = 0;
    let killed = false;
    let settled = false;
    const stop = () => {
      killed = true;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: killed ? null : status, stdout: Buffer.concat(chunks) });
    };
    const timer = setTimeout(stop, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { length += chunk.length; if (length > MAX_OUTPUT) stop(); else chunks.push(chunk); });
    child.stderr?.on('data', () => { /* drain private child diagnostics */ });
    child.on('error', () => { stop(); finish(null); });
    child.on('close', finish);
    child.stdin?.on('error', () => { stop(); });
    child.stdin?.end(Buffer.from(stdin));
  });
}

function parseJson(bytes: Uint8Array): any | null {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return null; }
}
function decodeBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length > MAX_OUTPUT * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  return Buffer.from(value, 'base64');
}

export class SiWarmPodProvider {
  private readonly fetcher: NonNullable<SiWarmProviderOptions['fetch']>;
  private readonly kubectl: Kubectl;
  private readonly exec: NonNullable<SiWarmProviderOptions['exec']>;
  private readonly now: () => number;
  constructor(private readonly options: SiWarmProviderOptions) {
    const url = new URL(options.controlUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || !DIGEST.test(options.memberToken) || options.candidates.some(row => row.tier !== 'standard'
        || !row.host || !safeToken(row.spec.workerId) || !SHA.test(row.spec.cutSha))) throw new Error('invalid si warm provider');
    this.fetcher = options.fetch ?? fetch;
    this.kubectl = options.kubectl ?? defaultKubectl;
    this.exec = options.exec ?? defaultExec;
    this.now = options.now ?? Date.now;
  }

  private async control(path: string, credential: string, body: Record<string, unknown>) {
    const response = await this.fetcher(new URL(path, this.options.controlUrl), {
      method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    let value: any = null;
    try { value = await response.json(); } catch { /* uncertain responses stay fenced */ }
    return { status: response.status, value };
  }

  private readPod(spec: WarmPodSpec): any | null {
    const result = this.kubectl(['--context', spec.kubectlContext, '-n', spec.namespace,
      'get', 'pod', spec.name, '-o', 'json']);
    return result.status === 0 ? parseJson(Buffer.from(result.stdout)) : null;
  }

  private podIdentity(spec: WarmPodSpec, pod: any, uid: string, state: 'idle' | 'leased'): SiWarmLeasedPodIdentity | null {
    const meta = pod?.metadata;
    const a = meta?.annotations;
    const l = meta?.labels;
    if (meta?.name !== spec.name || meta?.namespace !== spec.namespace || meta?.uid !== uid
      || !meta?.resourceVersion || a?.['elanous.dev/warm-worker-id'] !== spec.workerId
      || a?.['elanous.dev/warm-cut-sha'] !== spec.cutSha
      || a?.['elanous.dev/warm-lock-hash'] !== spec.key.lockHash
      || a?.['elanous.dev/warm-image-digest'] !== spec.key.imageDigest
      || a?.['elanous.dev/warm-context'] !== spec.key.context
      || a?.['elanous.dev/warm-architecture'] !== spec.key.architecture
      || (l?.['elanous.ai/state'] ?? 'idle') !== state
      || pod?.status?.phase !== 'Running'
      || !pod.status.conditions?.some((condition: any) => condition.type === 'Ready' && condition.status === 'True')) return null;
    return { context: spec.key.context, kubectlContext: spec.kubectlContext,
      namespace: spec.namespace, name: spec.name,
      podUid: uid, workerId: spec.workerId, sourceSha: spec.cutSha,
      imageDigest: spec.key.imageDigest, lockHash: spec.key.lockHash, architecture: spec.key.architecture };
  }

  private patch(spec: WarmPodSpec, command: SiWarmCommand, next: 'leased' | 'idle' | 'quarantined'): boolean {
    const uid = command.podUid, leaseId = command.leaseId;
    const pod = this.readPod(spec);
    if (!pod || !this.podIdentity(spec, pod, uid, next === 'leased' ? 'idle' :
      pod?.metadata?.labels?.['elanous.ai/state'] === 'leased' ? 'leased' : 'idle')) return false;
    const priorLease = pod.metadata.labels?.['elanous.ai/lease'];
    if ((next === 'leased' && priorLease !== undefined)
      || (next === 'idle' && priorLease !== leaseId)
      || (next === 'quarantined' && priorLease !== undefined && priorLease !== leaseId)) return false;
    if (next === 'leased' && [...Object.keys(pod.metadata.labels ?? {}),
      ...Object.keys(pod.metadata.annotations ?? {})].some(name => name.startsWith('elanous.ai/')
        && !['elanous.ai/state', 'elanous.ai/pool', 'elanous.ai/image-digest',
          'elanous.ai/launch-host'].includes(name))) return false;
    const labels = { ...pod.metadata.labels, 'elanous.ai/state': next };
    const annotations = { ...pod.metadata.annotations };
    if (next === 'leased') {
      labels['elanous.ai/lease'] = leaseId;
      Object.assign(annotations, { 'elanous.ai/lease': leaseId, 'elanous.ai/run': command.runId,
        'elanous.ai/attempt': command.attemptId, 'elanous.ai/source': command.sourceSha,
        'elanous.ai/execution-key': command.executionKey });
    } else {
      delete labels['elanous.ai/lease'];
      for (const name of ['lease', 'run', 'attempt', 'source', 'execution-key']) delete annotations[`elanous.ai/${name}`];
    }
    const patch = [
      { op: 'test', path: '/metadata/uid', value: uid },
      { op: 'test', path: '/metadata/resourceVersion', value: pod.metadata.resourceVersion },
      { op: 'add', path: '/metadata/labels', value: labels },
      { op: 'add', path: '/metadata/annotations', value: annotations },
    ];
    const result = this.kubectl(['--context', spec.kubectlContext, '-n', spec.namespace,
      'patch', 'pod', spec.name, '--type=json', '-p', JSON.stringify(patch), '-o', 'json']);
    const after = result.status === 0 ? parseJson(Buffer.from(result.stdout)) : null;
    return after?.metadata?.uid === uid && after.metadata.labels?.['elanous.ai/state'] === next
      && after.metadata.labels?.['elanous.ai/lease'] === (next === 'leased' ? leaseId : undefined);
  }

  private async transition(command: Pick<SiWarmCommand, 'workerId' | 'leaseId' | 'generation'>,
    action: 'release' | 'sanitize' | 'quarantine', credential: string, reason?: string): Promise<boolean> {
    try { const response = await this.control(`/v1/leases/pod-worker/${encodeURIComponent(command.workerId)}/${action}`,
      credential, { leaseId: command.leaseId, generation: command.generation,
        ...(reason ? { reason: reason.slice(0, 120) } : {}) }); return response.status === 200; }
    catch { return false; }
  }

  private observe(event: string, data: Record<string, unknown>): void {
    if (this.options.observe) this.options.observe(event, data);
    else debug.log('pod.reuse', event, data, { level: 'warn' });
  }

  /** A read-only canary in the exact prepared checkout; an image tag alone is not runner proof. */
  private runnerReady(spec: WarmPodSpec): boolean {
    if (this.options.siRunnerReady) return this.options.siRunnerReady(spec);
    const result = this.kubectl(['--context', spec.kubectlContext, '-n', spec.namespace,
      'exec', `pod/${spec.name}`, '-c', 'worker', '--', 'bun', RUNNER, '--probe']);
    const proof = result.status === 0 ? parseJson(Buffer.from(result.stdout)) : null;
    return proof?.protocol === 'si-v1' && proof.runner === 'ready'
      && proof.workerId === spec.workerId && proof.sourceSha === spec.cutSha
      && typeof proof.podUid === 'string' && proof.podUid.length > 0;
  }

  private async quarantineAcquired(command: Pick<SiWarmCommand,
    'runId' | 'attemptId' | 'workerId' | 'podUid' | 'leaseId' | 'generation'>, reason: string): Promise<boolean> {
    const confirmed = await this.transition(command, 'quarantine', this.options.memberToken, reason);
    if (!confirmed) this.observe('si-quarantine-unconfirmed', { runId: command.runId,
      attemptId: command.attemptId, workerId: command.workerId, podUid: command.podUid,
      leaseId: command.leaseId, generation: command.generation, reason });
    return confirmed;
  }

  async acquire(input: SiWarmProviderInput): Promise<SiWarmAcquireResult> {
    if (!safeToken(input.runId) || !safeToken(input.attemptId) || !DIGEST.test(input.executionKey)
      || !SHA.test(input.sourceSha) || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= this.now()
      || !(input.payload instanceof Uint8Array) || !(input.credentialBundle instanceof Uint8Array))
      return { status: 'no-entry', reason: 'invalid-input' };
    const matching = this.options.candidates.filter(row => row.spec.cutSha === input.sourceSha);
    if (!matching.length) return { status: 'no-entry', reason: 'no-candidate' };
    const candidates = matching.filter(row => this.runnerReady(row.spec));
    if (!candidates.length) return { status: 'no-entry', reason: 'runner-unavailable' };
    const leaseTtlMs = Math.max(this.options.leaseTtlMs ?? 30 * 60_000,
      input.deadlineAt - this.now() + 60_000);
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1 || leaseTtlMs > MAX_LEASE_MS)
      return { status: 'no-entry', reason: 'invalid-input' };
    const seen = new Set<string>();
    let contextUnavailable = false;
    for (const candidate of candidates) {
      const { spec, host } = candidate;
      const pool = `${host}/${JSON.stringify(spec.key)}`;
      if (seen.has(pool)) continue;
      seen.add(pool);
      if (probeWarmPodContext(spec.kubectlContext, this.kubectl)) { contextUnavailable = true; continue; }
      let acquired: Awaited<ReturnType<SiWarmPodProvider['control']>>;
      try { acquired = await this.control('/v1/leases/pod-worker', this.options.memberToken,
        { machine: host, key: spec.key, runId: input.runId, attemptId: input.attemptId,
          ttlMs: leaseTtlMs }); }
      catch {
        // No lease ID is available for a safe quarantine request. Record a
        // precise reconciliation key before leaving this worker unavailable.
        this.observe('si-lease-response-lost', { runId: input.runId, attemptId: input.attemptId,
          host, workerId: spec.workerId, sourceSha: input.sourceSha, key: spec.key });
        return { status: 'uncertain', reason: 'lease-response-lost' };
      }
      if (acquired.status === 409 || acquired.status === 503) continue;
      if (acquired.status !== 200) {
        this.observe('si-lease-rejected-unknown', { runId: input.runId, attemptId: input.attemptId,
          host, workerId: spec.workerId, sourceSha: input.sourceSha, key: spec.key,
          status: acquired.status });
        return { status: 'uncertain', reason: 'lease-rejected-unknown' };
      }
      const row = acquired.value;
      const attrs = row?.attrs;
      if (!safeToken(row?.name) || !safeToken(attrs?.leaseId) || attrs.leaseId.length > 63 || !safeToken(attrs?.podUid)
        || !Number.isSafeInteger(attrs?.generation) || attrs.generation < 1) {
        this.observe('si-lease-receipt-invalid', { runId: input.runId, attemptId: input.attemptId,
          host, workerId: spec.workerId, sourceSha: input.sourceSha, key: spec.key });
        return { status: 'uncertain', reason: 'lease-receipt-invalid' };
      }
      const leased = candidates.find(item => item.host === host && item.spec.workerId === row.name
        && sameKey(item.spec.key, spec.key));
      if (!leased) {
        const unknown = { ...input, workerId: row.name, podUid: attrs.podUid,
          leaseId: attrs.leaseId, generation: attrs.generation };
        const confirmed = await this.quarantineAcquired(unknown, 'candidate-unmatched');
        return { status: 'uncertain', reason: confirmed ? 'lease-worker-unmatched' : 'quarantine-unconfirmed' };
      }
      const command: SiWarmCommand = { protocol: 'si-v1', runId: input.runId, attemptId: input.attemptId,
        executionKey: input.executionKey, sourceSha: input.sourceSha, leaseId: attrs.leaseId,
        generation: attrs.generation, workerId: row.name, podUid: attrs.podUid, key: leased.spec.key,
        envProfile: 'si-standard-v1', deadlineAt: input.deadlineAt,
        payloadSha256: siWarmSha256(input.payload), credentialBundleSha256: siWarmSha256(input.credentialBundle) };
      if (!attrs.key || !sameKey(attrs.key, leased.spec.key)) {
        const confirmed = await this.quarantineAcquired(command, 'key-mismatch');
        return { status: 'uncertain', reason: confirmed ? 'lease-key-mismatch' : 'quarantine-unconfirmed' };
      }
      const podBefore = this.readPod(leased.spec);
      if (!this.podIdentity(leased.spec, podBefore, command.podUid, 'idle')
        || !this.patch(leased.spec, command, 'leased')) {
        const confirmed = await this.quarantineAcquired(command, 'pod-identity-or-patch');
        return { status: 'uncertain', reason: confirmed ? 'pod-identity-or-patch' : 'quarantine-unconfirmed' };
      }
      const pod = this.podIdentity(leased.spec, this.readPod(leased.spec), command.podUid, 'leased');
      if (!pod) {
        const confirmed = await this.quarantineAcquired(command, 'pod-replaced-after-patch');
        return { status: 'uncertain', reason: confirmed ? 'pod-replaced-after-patch' : 'quarantine-unconfirmed' };
      }
      return { status: 'acquired', attempt: this.makeAttempt(input, command, leased, pod) };
    }
    return { status: 'no-entry', reason: contextUnavailable ? 'context-unavailable' : 'busy' };
  }

  private makeAttempt(input: SiWarmProviderInput, command: SiWarmCommand, candidate: WarmWorkerCandidate,
    pod: SiWarmPodIdentity): SiWarmChildAttempt {
    const spec = candidate.spec;
    const prefix = ['--context', spec.kubectlContext, '-n', spec.namespace] as const;
    const fixed = (verb: string) => [...prefix, 'exec', `pod/${spec.name}`, '-c', 'worker', '-i', '--', 'bun', RUNNER, verb];
    const assertLease = (lease: ChildPodLease) => {
      if (lease.workerId !== command.workerId || lease.podUid !== command.podUid
        || lease.leaseId !== command.leaseId || lease.generation !== command.generation
        || lease.sourceSha !== command.sourceSha || !sameKey(lease.key, command.key)) throw new Error('si warm lease changed');
    };
    const runMaintenance = async (verb: string, lease: ChildPodLease) => {
      assertLease(lease);
      const live = this.readPod(spec);
      if (!this.podIdentity(spec, live, command.podUid, 'leased')
        || live?.metadata?.labels?.['elanous.ai/lease'] !== command.leaseId)
        throw new Error('si warm Pod identity changed before maintenance');
      const result = await this.exec(fixed(verb), Buffer.from(JSON.stringify(lease)), 30_000);
      if (result.status !== 0) throw new Error('si warm maintenance failed');
      const parsed = parseJson(result.stdout);
      if (!parsed || typeof parsed !== 'object') throw new Error('si warm maintenance invalid');
      return parsed;
    };
    let quarantineRecorded = false;
    const quarantine = async (reason: string) => {
      if (quarantineRecorded) return;
      const marked = await this.transition(command, 'quarantine', this.options.memberToken, reason);
      if (!marked) throw new Error('si warm quarantine unavailable');
      quarantineRecorded = true;
      if (!this.patch(spec, command, 'quarantined')) debug.log('pod.reuse', 'quarantine-pod-patch-unavailable',
        { workerId: command.workerId, podUid: command.podUid, leaseId: command.leaseId }, { level: 'warn' });
    };
    const runner: SiWarmFixedRunner = {
      inspect: async () => {
        const live = this.readPod(spec);
        const observed = this.podIdentity(spec, live, command.podUid, 'leased');
        const a = live?.metadata?.annotations;
        return observed && live?.metadata?.labels?.['elanous.ai/lease'] === command.leaseId
          && a?.['elanous.ai/lease'] === command.leaseId
          && a?.['elanous.ai/run'] === command.runId
          && a?.['elanous.ai/attempt'] === command.attemptId
          && a?.['elanous.ai/source'] === command.sourceSha
          && a?.['elanous.ai/execution-key'] === command.executionKey ? observed : null;
      },
      execute: async (argv, stdin, timeoutMs): Promise<SiWarmExecReceipt> => {
        const expected = [...prefix, 'exec', `pod/${spec.name}`, '-c', 'worker', '-i', '--', 'bun', RUNNER];
        if (argv.length !== expected.length || argv.some((part, index) => part !== expected[index]))
          throw new Error('si warm argv rejected');
        if (!await runner.inspect(pod)) throw new Error('si warm Pod identity changed before exec');
        const result = await this.exec(expected, stdin, timeoutMs);
        if (!await runner.inspect(pod)) return { reply: null, bytes: null, cleanup: 'unknown' };
        if (result.status !== 0) return { reply: null, bytes: null, cleanup: 'unknown' };
        const wire = parseJson(result.stdout);
        const b = wire?.bytes;
        const terminal = decodeBytes(b?.terminal), ledger = decodeBytes(b?.ledger), log = decodeBytes(b?.log);
        const artifacts = Array.isArray(b?.artifacts) ? b.artifacts.map((part: any) =>
          ({ path: part?.path, bytes: decodeBytes(part?.bytes) })) : null;
        if (!terminal || !ledger || !log || !artifacts || artifacts.some((part: any) =>
          typeof part.path !== 'string' || !part.bytes)) return { reply: null, bytes: null, cleanup: 'unknown' };
        return { reply: wire.reply, bytes: { terminal, ledger, log, artifacts },
          cleanup: wire.cleanup === 'clean' ? 'clean' : 'unknown' };
      },
      quarantine: async (seen, reason) => {
        if (seen.leaseId !== command.leaseId || seen.generation !== command.generation
          || seen.workerId !== command.workerId || seen.podUid !== command.podUid) return false;
        try { await quarantine(reason); return true; } catch { return false; }
      },
    };
    const cleanup: ChildPodReuseOperations = {
      stopChildProcesses: async lease => ({ remaining: (await runMaintenance('--stop', lease)).remaining }),
      git: async (lease, args) => {
        const verb = args[0] === 'reset' && args[1] === '--hard' && args[2] === lease.sourceSha && args.length === 3
          ? '--git-reset' : args[0] === 'clean' && args[1] === '-ffdx' ? '--git-clean'
            : args[0] === 'status' && args[1] === '--porcelain' ? '--git-status' : null;
        if (!verb) throw new Error('si warm git argv rejected');
        const result = await runMaintenance(verb, lease);
        return { status: result.status, stdout: result.stdout };
      },
      removeRunCredentials: async lease => ({ remaining: (await runMaintenance('--revoke', lease)).remaining }),
      returnLease: async (lease, receipt) => {
        assertLease(lease);
        if (!receipt.clean) throw new Error('si warm return requires clean receipt');
        if (!await this.transition(command, 'release', this.options.memberToken)) throw new Error('si warm release unavailable');
        if (!this.patch(spec, command, 'idle')) { await quarantine('idle-patch-failed'); throw new Error('si warm idle patch failed'); }
        const machineToken = this.options.machineTokens[candidate.host];
        if (!machineToken || !DIGEST.test(machineToken)
          || !await this.transition(command, 'sanitize', machineToken)) {
          await quarantine('sanitize-unavailable'); throw new Error('si warm sanitize unavailable');
        }
      },
      quarantine: async (lease, receipt) => { assertLease(lease); await quarantine(receipt.reason); },
      observe: (event, data) => debug.log('pod.reuse', event, data),
    };
    return { leaseFenced: true, command, transport: { pod, runner, now: this.now },
      payload: input.payload, credentialBundle: input.credentialBundle,
      adopt: input.adopt, cleanup, quarantineUnknown: quarantine };
  }
}

let configured: SiWarmPodProvider | null = null;
export function configureSiWarmPodProvider(provider: SiWarmPodProvider | null): void { configured = provider; }
/** Share the private producer inventory but keep SI admission behind its own explicit switch. */
export function loadSiWarmPodProvider(path: string): SiWarmPodProvider {
  if (!isAbsolute(path)) throw new Error('si warm provider config must be private');
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error('si warm provider config must be private');
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid si warm provider config');
  const value = raw as Record<string, unknown>;
  const templates = Array.isArray(value.poolTemplates)
    ? (value.poolTemplates as WarmWorkerCandidate[]).filter(candidate => candidate.tier === 'standard') : [];
  const direct = Array.isArray(value.candidates)
    ? (value.candidates as WarmWorkerCandidate[]).filter(candidate => candidate.tier === 'standard') : [];
  const profile = resolveWarmPoolProfile(value.profileConfig);
  const expanded = templates.flatMap(candidate => {
    const quota = resolveWarmPoolQuota(profile, candidate.host, candidate.tier);
    if (!quota || !candidate.spec.nodeName) throw new Error('unmeasured si warm pool template');
    return Array.from({ length: quota }, (_, index): WarmWorkerCandidate => ({
      host: candidate.host, tier: candidate.tier, spec: { ...candidate.spec,
        name: `warm-${candidate.host}-${candidate.tier}-${index + 1}`,
        workerId: `${candidate.spec.workerId}-${candidate.tier}-${index + 1}` },
    }));
  });
  return new SiWarmPodProvider({ candidates: [...direct, ...expanded],
    controlUrl: String(value.controlUrl ?? ''), memberToken: String(value.memberToken ?? ''),
    machineTokens: value.machineTokens && typeof value.machineTokens === 'object'
      ? value.machineTokens as Record<string, string> : {} });
}
export async function acquireSiWarmLease(input: SiWarmProviderInput): Promise<SiWarmAcquireResult> {
  if (!configured && process.env.ELANOUS_SI_WARM_REUSE === '1') {
    const file = process.env.ELANOUS_WARM_POD_PROVIDER_CONFIG;
    if (file) {
      try { configured = loadSiWarmPodProvider(file); }
      catch (error) { debug.log('pod.reuse', 'si-provider-unavailable',
        { reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
    }
  }
  return configured ? configured.acquire(input) : { status: 'no-entry', reason: 'disabled' };
}
