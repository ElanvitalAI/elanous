/** Opt-in warm Pod transport. It never creates a Pod or changes the gate's Job verdict. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kubectl } from './self-implement-pod.js';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { parseWarmWorkerReply, type WarmWorkerCommand, type WarmWorkerKey, type WarmWorkerReply } from './pod-warm-worker-protocol.js';
import type { WarmWorkerOutcome } from './pod-warm-worker-runtime.js';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DNS = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const pendingByKubectl = new WeakMap<Kubectl, Set<string>>();
const equalKey = (a: WarmWorkerKey, b: WarmWorkerKey) => a.context === b.context
  && a.imageDigest === b.imageDigest && a.lockHash === b.lockHash && a.architecture === b.architecture;

/** A test process can exceed the generic 120 s kubectl timeout; the worker itself enforces deadlineAt. */
const warmKubectl: Kubectl = (args, input) => {
  const env = { ...process.env };
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[name];
  const result = spawnSync('kubectl', [...args], { encoding: 'utf8', input, env,
    timeout: 1_800_000, maxBuffer: 8 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: (result.stderr ?? '') + (result.error ? String(result.error) : '') };
};

export interface WarmPodSpec {
  name: string;
  namespace: string;
  /** The kubectl context is explicit; the worker key context is a separate pool identity. */
  kubectlContext: string;
  workerId: string;
  image: string;
  /** Public checkout URL, or use the explicit node-local mirror below for private source. */
  sourceUrl?: string;
  /** Existing readable git mirror on a pinned node. Mounted read-only into the init container only. */
  sourceMirrorHostPath?: string;
  nodeName?: string;
  cutSha: string;
  key: WarmWorkerKey;
  /** Caller resolves the live host daemon endpoint; no guessed port. */
  hostProbeUrl: string;
  /** Cluster service endpoint to prove production network isolation. */
  prodProbeUrl: string;
}

/** Same fail-closed host/prod reachability condition as command Jobs, before prep and every request. */
export const WARM_POD_ISOLATION_PROBE = `async function warmIsolationEnforced() {
const targets = [process.env.WARM_HOST_PROBE_URL, process.env.WARM_PROD_PROBE_URL];
if (targets.some(url => !url)) throw new Error('warm Pod isolation probe URLs missing');
let blocked = 0;
for (let probe = 0; probe < 60; probe++) {
  const reachable = await Promise.all(targets.map(async url => {
    try { await fetch(url, { signal: AbortSignal.timeout(1000) }); return true; }
    catch { return false; }
  }));
  blocked = reachable.some(Boolean) ? 0 : blocked + 1;
  if (blocked >= 3) return true;
  await Bun.sleep(500);
}
return false;
}`;
export const WARM_POD_ISOLATION = `${WARM_POD_ISOLATION_PROBE}
if (!(await warmIsolationEnforced())) throw new Error('warm Pod isolation not enforced');`;

/** Clone and verify source while the private mirror is mounted only here. */
export const WARM_POD_PREPARE = `import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const checked = (argv) => { const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); if (r.status !== 0) throw new Error(argv[0] + ': ' + r.stderr); return r.stdout.trim(); };
checked(['git', 'clone', '--quiet', '--no-checkout', process.env.WARM_SOURCE_URL, '/workspace/repo']);
checked(['git', '-C', '/workspace/repo', 'checkout', '--detach', '--quiet', process.env.WARM_CUT_SHA]);
if (checked(['git', '-C', '/workspace/repo', 'rev-parse', 'HEAD']) !== process.env.WARM_CUT_SHA) throw new Error('warm source SHA mismatch');
const lock = createHash('sha256').update(readFileSync('/workspace/repo/bun.lock')).digest('hex');
if (lock !== process.env.WARM_LOCK_HASH) throw new Error('warm lock mismatch');
checked(['git', '-C', '/workspace/repo', 'remote', 'remove', 'origin']);`;

/** Install after the checkout init container and its private mirror mount have exited. */
export const WARM_POD_INSTALL = `import { spawnSync } from 'node:child_process';
const checked = (argv) => { const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); if (r.status !== 0) throw new Error(argv[0] + ': ' + r.stderr); return r.stdout.trim(); };
checked(['bun', 'install', '--frozen-lockfile', '--cwd', '/workspace/repo']);
// The test subprocess runs as uid 65534; it must traverse the read-only checkout and node_modules.
checked(['chmod', '-R', 'a+rX', '/workspace/repo']);`;

/** Each exec starts a short-lived Bun process; the Pod, checkout and installed dependencies remain warm. */
export const WARM_POD_EXEC = `import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
${WARM_POD_ISOLATION_PROBE}
const command = JSON.parse(await Bun.stdin.text());
if (command.workerId !== process.env.WARM_WORKER_ID || command.cutSha !== process.env.WARM_CUT_SHA
  || command.key?.context !== process.env.WARM_CONTEXT
  || command.key?.imageDigest !== process.env.WARM_IMAGE_DIGEST
  || command.key?.lockHash !== process.env.WARM_LOCK_HASH
  || command.key?.architecture !== process.env.WARM_ARCHITECTURE)
  throw new Error('warm command differs from Pod identity');
chmodSync('/workspace/data', 0o755);
if (statSync('/workspace/data').uid !== Number(process.env.WARM_BRIDGE_UID)) throw new Error('warm data owner changed');
mkdirSync('/workspace/data/scratch', { recursive: true, mode: 0o755 });
chmodSync('/workspace/data/scratch', 0o755);
mkdirSync('/workspace/data/artifacts', { recursive: true, mode: 0o700 });
chmodSync('/workspace/data/artifacts', 0o700);
const control = '/workspace/data/control';
mkdirSync(control, { recursive: true, mode: 0o700 });
const controlStat = statSync(control);
if (controlStat.uid !== Number(process.env.WARM_BRIDGE_UID) || (controlStat.mode & 0o077) !== 0) throw new Error('warm control is not private');
const active = control + '/request-active';
const quarantine = control + '/quarantine';
if (existsSync(quarantine) || existsSync(active)) {
  process.stdout.write(JSON.stringify({ reply: null, quarantineWorker: true, reason: 'quarantined' }));
  process.exit(0);
}
try { mkdirSync(active, { mode: 0o700 }); }
catch {
  process.stdout.write(JSON.stringify({ reply: null, quarantineWorker: true, reason: 'quarantined' }));
  process.exit(0);
}
try {
if (!(await warmIsolationEnforced())) throw new Error('warm Pod isolation changed');
const gitEnv = { ...process.env };
for (const name of Object.keys(gitEnv)) if (name.startsWith('GIT_')) delete gitEnv[name];
const git = (args, maxBuffer = 1024 * 1024) => { const result = spawnSync('git', ['-C', '/workspace/repo', ...args],
  { encoding: 'utf8', env: gitEnv, maxBuffer });
  if (result.status !== 0) throw new Error('warm source verification failed'); return result.stdout.trim(); };
const tracked = git(['ls-files', '-v', '-z'], 16 * 1024 * 1024).split('\\0').filter(Boolean);
if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== realpathSync('/workspace/repo')
  || git(['rev-parse', 'HEAD']) !== process.env.WARM_CUT_SHA
  || git(['status', '--porcelain', '--untracked-files=no'])
  || tracked.some(entry => !entry.startsWith('H ')))
  throw new Error('warm source changed');
if (createHash('sha256').update(readFileSync('/workspace/repo/bun.lock')).digest('hex') !== process.env.WARM_LOCK_HASH)
  throw new Error('warm lock changed');
const { WarmWorkerRuntime } = await import(pathToFileURL('/workspace/repo/src/task-orchestrator/surfaces/pod-warm-worker-runtime.ts').href);
const { runWarmWorkerFile } = await import(pathToFileURL('/workspace/repo/src/task-orchestrator/surfaces/pod-warm-worker-runner.ts').href);
const runtime = new WarmWorkerRuntime({ repoDir: '/workspace/repo', scratchDir: '/workspace/data/scratch', artifactsRoot: '/workspace/data/artifacts', workerId: process.env.WARM_WORKER_ID,
  runFile: runWarmWorkerFile });
const result = await runtime.handle(command);
const names = ['log', 'junit.xml', 'json', 'warm-manifest.json', 'rc'];
const artifactHashes = result.reply ? result.reply.files.map((_, index) => Object.fromEntries(names.map(name => [name, createHash('sha256').update(readFileSync(result.artifactsDir + '/file-' + index + '.' + name)).digest('hex')]))) : undefined;
if (result.quarantineWorker || result.reason !== 'complete') writeFileSync(quarantine, result.reason, { mode: 0o600 });
else writeFileSync(active + '/identity', JSON.stringify({ runId: command.runId, attemptId: command.attemptId,
  leaseId: command.leaseId, generation: command.generation }), { mode: 0o600 });
process.stdout.write(JSON.stringify({ ...result, artifactHashes }));
} catch (error) {
  writeFileSync(quarantine, String(error), { mode: 0o600 });
  throw error;
}`;

/** The Pod stays fenced until the host has validated all artifact bytes and acknowledges this identity. */
export const WARM_POD_ACK = `import { existsSync, readFileSync, rmSync } from 'node:fs';
const active = '/workspace/data/control/request-active';
if (existsSync('/workspace/data/control/quarantine')) throw new Error('worker quarantined');
const expected = JSON.parse(await Bun.stdin.text());
const actual = JSON.parse(readFileSync(active + '/identity', 'utf8'));
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('warm request identity changed');
rmSync(active, { recursive: true });
process.stdout.write('ack');`;

/** Artifact bytes travel as ASCII so kubectl's UTF-8 decoding cannot change their hashes. */
export const WARM_POD_READ = `import { readFileSync } from 'node:fs';
process.stdout.write(readFileSync(process.argv.at(-1)).toString('base64'));`;

function validateSpec(spec: WarmPodSpec): void {
  const publicHttpsSource = (value: string): boolean => {
    try { const url = new URL(value); return url.protocol === 'https:' && !!url.hostname
      && !url.username && !url.password && !url.search && !url.hash; }
    catch { return false; }
  };
  const probeValid = (value: string, host: string) => {
    try { const url = new URL(value); return url.protocol === 'http:' && url.hostname === host
      && !!url.port && !url.username && !url.password && !url.hash; }
    catch { return false; }
  };
  if (!DNS.test(spec.name) || spec.name.length > 63 || !DNS.test(spec.namespace) || !spec.kubectlContext
    || !spec.workerId || !SHA.test(spec.cutSha) || !DIGEST.test(spec.key.imageDigest)
    || !/^[a-f0-9]{64}$/.test(spec.key.lockHash) || !spec.key.context || !spec.key.architecture
    || !spec.image.endsWith(`@${spec.key.imageDigest}`)
    || (spec.sourceUrl === undefined) === (spec.sourceMirrorHostPath === undefined)
    || (spec.sourceUrl !== undefined && !publicHttpsSource(spec.sourceUrl))
    || (spec.sourceMirrorHostPath !== undefined && (!isAbsolute(spec.sourceMirrorHostPath)
      || normalize(spec.sourceMirrorHostPath) !== spec.sourceMirrorHostPath || !spec.nodeName))
    || !probeValid(spec.hostProbeUrl, 'host.orb.internal')
    || !probeValid(spec.prodProbeUrl, 'core.elanous-prod')
    || (spec.nodeName !== undefined && !DNS.test(spec.nodeName.replace(/\./g, '-')))) throw new Error('invalid warm Pod spec');
}

/** The caller may apply this manifest only through an explicit canary flow. This function has no side effects. */
export function warmWorkerPodManifest(spec: WarmPodSpec): Record<string, unknown> {
  validateSpec(spec);
  const annotations = {
    'elanous.dev/warm-cut-sha': spec.cutSha,
    'elanous.dev/warm-lock-hash': spec.key.lockHash,
    'elanous.dev/warm-image-digest': spec.key.imageDigest,
    'elanous.dev/warm-worker-id': spec.workerId,
    'elanous.dev/warm-context': spec.key.context,
    'elanous.dev/warm-architecture': spec.key.architecture,
  };
  const mirror = spec.sourceMirrorHostPath;
  return {
    apiVersion: 'v1', kind: 'Pod', metadata: { name: spec.name, namespace: spec.namespace,
      labels: { 'elanous.kind': 'warm-worker' }, annotations },
    spec: { restartPolicy: 'Never', automountServiceAccountToken: false,
      nodeSelector: { 'kubernetes.io/arch': spec.key.architecture },
      ...(spec.nodeName ? { nodeName: spec.nodeName } : {}),
      securityContext: { runAsUser: 1000, fsGroup: 1000 },
      initContainers: [{ name: 'isolation-gate', image: spec.image, imagePullPolicy: 'IfNotPresent',
        command: ['bun', '-e', WARM_POD_ISOLATION], env: [
          { name: 'WARM_HOST_PROBE_URL', value: spec.hostProbeUrl },
          { name: 'WARM_PROD_PROBE_URL', value: spec.prodProbeUrl }] },
      { name: 'prepare', image: spec.image, imagePullPolicy: 'IfNotPresent',
        securityContext: { runAsUser: 0, allowPrivilegeEscalation: false },
        command: ['bun', '-e', WARM_POD_PREPARE], env: [
          { name: 'WARM_SOURCE_URL', value: mirror ? '/source-mirror' : spec.sourceUrl },
          { name: 'WARM_CUT_SHA', value: spec.cutSha },
          { name: 'WARM_LOCK_HASH', value: spec.key.lockHash },
        ], volumeMounts: [{ name: 'workspace', mountPath: '/workspace' },
          ...(mirror ? [{ name: 'source-mirror', mountPath: '/source-mirror', readOnly: true }] : [])] },
      { name: 'install', image: spec.image, imagePullPolicy: 'IfNotPresent',
        securityContext: { runAsUser: 0, allowPrivilegeEscalation: false },
        command: ['bun', '-e', WARM_POD_INSTALL],
        volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }] }],
      containers: [{ name: 'worker', image: spec.image, imagePullPolicy: 'IfNotPresent',
        securityContext: { runAsUser: 0, allowPrivilegeEscalation: false,
          capabilities: { drop: ['ALL'], add: ['CHOWN', 'SETUID', 'SETGID', 'KILL'] } },
        command: ['sleep', 'infinity'], env: [
          { name: 'WARM_WORKER_ID', value: spec.workerId },
          { name: 'WARM_CUT_SHA', value: spec.cutSha },
          { name: 'WARM_LOCK_HASH', value: spec.key.lockHash },
          { name: 'WARM_IMAGE_DIGEST', value: spec.key.imageDigest },
          { name: 'WARM_CONTEXT', value: spec.key.context },
          { name: 'WARM_ARCHITECTURE', value: spec.key.architecture },
          { name: 'WARM_BRIDGE_UID', value: '0' },
          { name: 'WARM_POD_UID', valueFrom: { fieldRef: { apiVersion: 'v1', fieldPath: 'metadata.uid' } } },
          { name: 'WARM_HOST_PROBE_URL', value: spec.hostProbeUrl },
          { name: 'WARM_PROD_PROBE_URL', value: spec.prodProbeUrl },
        ],
        volumeMounts: [{ name: 'workspace', mountPath: '/workspace/repo', subPath: 'repo', readOnly: true },
          { name: 'runtime-data', mountPath: '/workspace/data' }] }],
      volumes: [{ name: 'workspace', emptyDir: {} },
        { name: 'runtime-data', emptyDir: {} },
        ...(mirror ? [{ name: 'source-mirror', hostPath: { path: mirror, type: 'Directory' } }] : [])],
    },
  };
}

export interface WarmPodTransportResult {
  /** Every non-complete response leaves the existing one-shot Job authoritative. */
  status: 'observed' | 'fallback';
  reason: 'complete' | 'key-drift' | 'pod-unready' | 'pod-replaced' | 'exec-failed' | 'invalid-result' | 'worker-quarantined';
  reply: WarmWorkerReply | null;
  artifactsDir?: string;
  /** Base64 preserves the exact bytes copied from the same Pod. Keys are artifact suffixes. */
  artifacts?: readonly { file: string; data: Readonly<Record<string, string>> }[];
}
const fallback = (reason: WarmPodTransportResult['reason']): WarmPodTransportResult => ({ status: 'fallback', reason, reply: null });

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]));
  return value;
}
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writePendingLedger(path: string, contents: string): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try { writeFileSync(descriptor, contents); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  syncDirectory(resolve(path, '..'));
}

/** Re-run the same complete-JUnit parser against the bytes fetched from the Pod. */
const WARM_HOST_REPARSE = `import { pathToFileURL } from 'node:url';
const [parserPath, prefix, file, cutSha, attemptId] = process.argv.slice(-5);
const { warmReferenceFromJobArtifacts } = await import(pathToFileURL(parserPath).href);
process.stdout.write(JSON.stringify(warmReferenceFromJobArtifacts(prefix, file,
  { cutSha, attemptId })));`;
function reparseCopiedArtifacts(bytes: Record<string, Buffer>, file: string, command: WarmWorkerCommand) {
  const directory = mkdtempSync(join(tmpdir(), 'elanous-warm-pod-'));
  try {
    const prefix = join(directory, 'file');
    for (const [suffix, value] of Object.entries(bytes)) writeFileSync(`${prefix}.${suffix}`, value, { mode: 0o600 });
    const sourceParser = fileURLToPath(new URL('../../../scripts/release-loop/gate-warm-artifacts.ts', import.meta.url));
    const parserPath = existsSync(sourceParser) ? sourceParser
      : resolve(process.cwd(), 'scripts/release-loop/gate-warm-artifacts.ts');
    if (!existsSync(parserPath)) return null;
    const parsed = spawnSync(process.execPath,
      ['-e', WARM_HOST_REPARSE, parserPath, prefix, file, command.cutSha, command.attemptId],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (parsed.status !== 0) return null;
    try { return JSON.parse(parsed.stdout); } catch { return null; }
  } finally { rmSync(directory, { recursive: true }); }
}

/** Admission checks the actual source and isolation init contract, not just copied annotations. */
function matchesPodManifest(pod: any, spec: WarmPodSpec): boolean {
  const expected = warmWorkerPodManifest(spec).spec as any;
  const actual = pod?.spec;
  if (!actual || actual.restartPolicy !== expected.restartPolicy
    || actual.automountServiceAccountToken !== false
    || actual.hostNetwork === true || actual.hostPID === true || actual.hostIPC === true
    || actual.hostUsers === true || actual.shareProcessNamespace === true
    || actual.hostAliases !== undefined || actual.dnsConfig !== undefined
    || (actual.dnsPolicy !== undefined && actual.dnsPolicy !== 'ClusterFirst')
    || (Array.isArray(actual.ephemeralContainers) && actual.ephemeralContainers.length > 0)
    || !sameJson(actual.nodeSelector, expected.nodeSelector)
    || !sameJson(actual.securityContext, expected.securityContext)
    || !sameJson(actual.volumes, expected.volumes)
    || (spec.nodeName !== undefined && actual.nodeName !== spec.nodeName)
    || !Array.isArray(actual.initContainers) || actual.initContainers.length !== expected.initContainers.length
    || !Array.isArray(actual.containers) || actual.containers.length !== expected.containers.length) return false;
  for (const section of ['initContainers', 'containers'] as const) {
    for (let index = 0; index < expected[section].length; index++) {
      const want = expected[section][index];
      const got = actual[section][index];
      // API-server defaults may add resources/termination fields; execution-bearing fields stay exact.
      for (const field of ['name', 'image', 'imagePullPolicy', 'command', 'args', 'workingDir', 'env', 'envFrom',
        'volumeMounts', 'volumeDevices', 'ports', 'securityContext', 'stdin', 'stdinOnce', 'tty', 'lifecycle',
        'startupProbe', 'livenessProbe', 'readinessProbe', 'resizePolicy', 'restartPolicy']) {
        if (!sameJson(got?.[field], want?.[field])) return false;
      }
    }
  }
  return true;
}

/** Host-side serial queue. It observes an existing Pod; it never applies the manifest. */
export class WarmPodTransport {
  private tail: Promise<unknown> = Promise.resolve();
  private podUid: string | null = null;
  private quarantined = false;
  private readonly ledgerDir: string | null;
  constructor(private readonly spec: WarmPodSpec, private readonly kubectl: Kubectl = warmKubectl,
    quarantineLedgerDir?: string) {
    validateSpec(spec);
    if (quarantineLedgerDir !== undefined && !isAbsolute(quarantineLedgerDir)) throw new Error('quarantine ledger must be absolute');
    this.ledgerDir = quarantineLedgerDir ?? (kubectl === warmKubectl
      ? join(elanousStateRoot(), 'warm-pod-quarantine') : null);
    if (this.ledgerDir && !isAbsolute(this.ledgerDir)) throw new Error('quarantine ledger must be absolute');
  }

  request(command: WarmWorkerCommand): Promise<WarmPodTransportResult> {
    const next = this.tail.then(() => this.send(command));
    this.tail = next.catch(() => undefined);
    return next;
  }

  private send(command: WarmWorkerCommand): WarmPodTransportResult {
    if (this.quarantined) return fallback('worker-quarantined');
    if (!command?.key || command.envProfile !== 'gate-v1'
      || command.workerId !== this.spec.workerId || command.cutSha !== this.spec.cutSha
      || !equalKey(command.key, this.spec.key)
      || ![command.runId, command.attemptId, command.leaseId, command.workerId].every(value => TOKEN.test(value))
      || !Number.isSafeInteger(command.generation) || command.generation < 1) return fallback('key-drift');
    const prefix = ['--context', this.spec.kubectlContext, '-n', this.spec.namespace];
    const observed = this.kubectl([...prefix, 'get', 'pod', this.spec.name, '-o', 'json']);
    if (observed.status !== 0) return fallback('pod-unready');
    let pod: any;
    try { pod = JSON.parse(observed.stdout); } catch { return fallback('pod-unready'); }
    const a = pod?.metadata?.annotations;
    const uid = pod?.metadata?.uid;
    if (pod?.metadata?.name !== this.spec.name || pod?.metadata?.namespace !== this.spec.namespace
      || typeof uid !== 'string' || !uid || pod?.status?.phase !== 'Running'
      || !pod?.status?.containerStatuses?.some((row: any) => row.name === 'worker' && row.ready === true)
      || !matchesPodManifest(pod, this.spec)
      || a?.['elanous.dev/warm-cut-sha'] !== this.spec.cutSha
      || a?.['elanous.dev/warm-lock-hash'] !== this.spec.key.lockHash
      || a?.['elanous.dev/warm-image-digest'] !== this.spec.key.imageDigest
      || a?.['elanous.dev/warm-worker-id'] !== this.spec.workerId
      || a?.['elanous.dev/warm-context'] !== this.spec.key.context
      || a?.['elanous.dev/warm-architecture'] !== this.spec.key.architecture) return fallback('pod-unready');
    const nodeName = pod?.spec?.nodeName;
    if (typeof nodeName !== 'string' || !nodeName) return fallback('pod-unready');
    const sameAdmittedPod = (raw: string): boolean => {
      try {
        const current = JSON.parse(raw);
        return current?.metadata?.uid === uid && current?.metadata?.name === this.spec.name
          && current?.metadata?.namespace === this.spec.namespace
          && sameJson(current?.metadata?.annotations, a)
          && current?.status?.phase === 'Running'
          && current?.status?.containerStatuses?.some((row: any) => row.name === 'worker' && row.ready === true)
          && current?.spec?.nodeName === nodeName && matchesPodManifest(current, this.spec);
      } catch { return false; }
    };
    const node = this.kubectl(['--context', this.spec.kubectlContext, 'get', 'node', nodeName, '-o', 'json']);
    let nodeArch: unknown;
    try { nodeArch = node.status === 0 ? JSON.parse(node.stdout)?.metadata?.labels?.['kubernetes.io/arch'] : null; }
    catch { nodeArch = null; }
    if (nodeArch !== this.spec.key.architecture) return fallback('pod-unready');
    if (this.podUid && uid !== this.podUid) { this.quarantined = true; return fallback('pod-replaced'); }
    this.podUid = uid;
    const ledgerKey = sha256([this.spec.kubectlContext, this.spec.namespace, this.spec.name, uid].join('\0'));
    const ledgerPath = this.ledgerDir ? join(this.ledgerDir, ledgerKey) : null;
    let pending = pendingByKubectl.get(this.kubectl);
    if (!pending) { pending = new Set<string>(); pendingByKubectl.set(this.kubectl, pending); }
    if (pending.has(ledgerKey) || (ledgerPath && existsSync(ledgerPath))) {
      this.quarantined = true;
      return fallback('worker-quarantined');
    }
    const exec = this.kubectl([...prefix, 'exec', '-i', this.spec.name, '-c', 'worker', '--', 'bun', '-e', WARM_POD_EXEC], JSON.stringify(command));
    if (exec.status !== 0) { this.quarantined = true; return fallback('exec-failed'); }
    // UID alone is insufficient: ephemeral containers can be added to a live Pod under the same UID.
    const after = this.kubectl([...prefix, 'get', 'pod', this.spec.name, '-o', 'json']);
    if (after.status !== 0 || !sameAdmittedPod(after.stdout)) { this.quarantined = true; return fallback('pod-replaced'); }
    let outcome: WarmWorkerOutcome & { artifactHashes?: Array<Record<string, string>> };
    try { outcome = JSON.parse(exec.stdout) as WarmWorkerOutcome & { artifactHashes?: Array<Record<string, string>> }; }
    catch { this.quarantined = true; return fallback('invalid-result'); }
    if (outcome.quarantineWorker || outcome.reason !== 'complete') {
      this.quarantined = true;
      return fallback('worker-quarantined');
    }
    const expectedArtifactsDir = `/workspace/data/artifacts/${[
      command.runId, command.attemptId, command.leaseId, String(command.generation), command.workerId,
    ].join('/')}`;
    const reply = parseWarmWorkerReply(outcome.reply);
    if (!reply || outcome.artifactsDir !== expectedArtifactsDir
      || !Array.isArray(outcome.artifactHashes) || outcome.artifactHashes.length !== command.files.length
      || reply.runId !== command.runId || reply.attemptId !== command.attemptId
      || reply.cutSha !== command.cutSha || reply.leaseId !== command.leaseId
      || reply.generation !== command.generation || reply.workerId !== command.workerId
      || reply.envProfile !== command.envProfile || reply.baselineSha !== command.baselineSha
      || !equalKey(reply.key, command.key) || reply.finishedAt > command.deadlineAt
      || reply.files.length !== command.files.length
      || reply.files.some((part, index) => part.file !== command.files[index] || !part.junitComplete)) {
      this.quarantined = true;
      return fallback('invalid-result');
    }
    const audit: Array<{ file: string; data: Readonly<Record<string, string>> }> = [];
    try {
      for (const [index, file] of command.files.entries()) {
        const prefix = `${expectedArtifactsDir}/file-${index}`;
        const fetched: Record<string, Buffer> = {};
        const encoded: Record<string, string> = {};
        for (const suffix of ['log', 'junit.xml', 'json', 'warm-manifest.json', 'rc']) {
          const got = this.kubectl([...prefixArgs(this.spec), 'exec', this.spec.name, '-c', 'worker', '--', 'bun', '-e', WARM_POD_READ, `${prefix}.${suffix}`]);
          if (got.status !== 0 || got.stdout.length > 8 * 1024 * 1024
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(got.stdout)) throw new Error('artifact unavailable');
          const bytes = Buffer.from(got.stdout, 'base64');
          if (bytes.toString('base64') !== got.stdout || sha256(bytes) !== outcome.artifactHashes[index]?.[suffix])
            throw new Error('artifact changed after reply');
          fetched[suffix] = bytes;
          encoded[suffix] = got.stdout;
        }
        const manifest = JSON.parse(fetched['warm-manifest.json']!.toString('utf8')) as Record<string, unknown>;
        const meta = JSON.parse(fetched.json!.toString('utf8')) as Record<string, unknown>;
        const reported = reply.files[index];
        const metaKey = meta.warmKey as WarmWorkerKey | undefined;
        if (!reported || manifest.protocol !== 1 || manifest.cutSha !== command.cutSha
          || manifest.attemptId !== command.attemptId || manifest.file !== file || manifest.rc !== reported.rc
          || manifest.logSha256 !== sha256(fetched.log!)
          || manifest.junitSha256 !== sha256(fetched['junit.xml']!)
          || manifest.metaSha256 !== sha256(fetched.json!) || manifest.rcSha256 !== sha256(fetched.rc!)
          || fetched.rc?.toString('utf8').trim() !== String(reported.rc)
          || meta.rc !== reported.rc || meta.commit !== command.cutSha || meta.attemptId !== command.attemptId
          || meta.jobFailed !== false || meta.jobExitCode !== 0
          || !Array.isArray(meta.files) || meta.files.length !== 1 || meta.files[0] !== file
          || !metaKey || !equalKey(metaKey, command.key)) throw new Error('artifact mismatch');
        const reparsed = reparseCopiedArtifacts(fetched, file, command);
        if (!reparsed || reparsed.rc !== reported.rc || reparsed.junitComplete !== reported.junitComplete
          || !sameJson(reparsed.failureIds, reported.failureIds)
          || !sameJson(reparsed.errorIds, reported.errorIds)) throw new Error('artifact parse mismatch');
        audit.push({ file, data: encoded });
      }
      const finalPod = this.kubectl([...prefixArgs(this.spec), 'get', 'pod', this.spec.name, '-o', 'json']);
      if (finalPod.status !== 0 || !sameAdmittedPod(finalPod.stdout)) throw new Error('Pod changed during artifact return');
    } catch {
      this.quarantined = true;
      return fallback('invalid-result');
    }
    const identity = { runId: command.runId, attemptId: command.attemptId,
      leaseId: command.leaseId, generation: command.generation };
    try {
      if (ledgerPath) {
        mkdirSync(this.ledgerDir!, { recursive: true, mode: 0o700 });
        syncDirectory(resolve(this.ledgerDir!, '..'));
        writePendingLedger(ledgerPath, JSON.stringify({ uid, identity }));
      }
      pending.add(ledgerKey);
    } catch {
      this.quarantined = true;
      return fallback('invalid-result');
    }
    const ack = this.kubectl([...prefixArgs(this.spec), 'exec', '-i', this.spec.name, '-c', 'worker',
      '--', 'bun', '-e', WARM_POD_ACK], JSON.stringify(identity));
    if (ack.status !== 0 || ack.stdout !== 'ack') {
      this.quarantined = true;
      return fallback('invalid-result');
    }
    const afterAck = this.kubectl([...prefixArgs(this.spec), 'get', 'pod', this.spec.name, '-o', 'json']);
    if (afterAck.status !== 0 || !sameAdmittedPod(afterAck.stdout)) {
      this.quarantined = true;
      return fallback('pod-replaced');
    }
    try { if (ledgerPath) { rmSync(ledgerPath); syncDirectory(this.ledgerDir!); } }
    catch { this.quarantined = true; return fallback('invalid-result'); }
    pending.delete(ledgerKey);
    return { status: 'observed', reason: 'complete', reply, artifactsDir: expectedArtifactsDir, artifacts: audit };
  }
}

const prefixArgs = (spec: WarmPodSpec) => ['--context', spec.kubectlContext, '-n', spec.namespace];

/** Explicit shadow caller for a pre-existing warm Pod. Input file is `{spec, command}`; no apply/create path exists here. */
if (import.meta.main) {
  const [mode, inputPath] = process.argv.slice(2);
  if (mode !== '--shadow-request' || !inputPath) throw new Error('usage: bun pod-warm-worker-pod.ts --shadow-request <payload.json>');
  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as { spec: WarmPodSpec; command: WarmWorkerCommand };
  const result = await new WarmPodTransport(input.spec).request(input.command);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== 'observed') process.exitCode = 2;
}
