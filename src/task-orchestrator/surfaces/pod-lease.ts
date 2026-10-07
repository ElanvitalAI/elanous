import type { PodPoolMember, PoolKubectl } from './pod-pool.js';
import { debug } from '../../debug/log.js';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dlopen } from 'bun:ffi';
import { hostLeaseBaseDir, type PendingJobIdentity } from '../../pod-lease/host-lease.js';

/** The harness Pod's container requests (self-implement-pod Job manifest). Lives here so admission reuses the real request. */
export const POD_CHILD_REQUESTS = { cpu: '1', memory: '6Gi' } as const;
/** POD-ADMIT-BY-USAGE — observed usage is scaled by this before it reserves memory. */
const POD_USAGE_HEADROOM = 1.5;
/** POD-ADMIT-BY-USAGE — a node keeps at least this share of allocatable memory free (real usage and bookkeeping). */
const POD_NODE_FREE_FLOOR_RATIO = 0.1;

/** Persisted on a Job admitted through the host lease; the file lease remains until its Pod is observed Running or terminal. */
export const POD_HOST_LEASE_ANNOTATION = 'elanous.dev/host-lease-admitted';

// `get pods --all-namespaces -o json` on a busy cluster is several MB — the default spawnSync
// buffer fails with ENOBUFS (10-03 node-b measured). Same proxy stripping as the Pod launch kubectl.
export const LEASE_KUBECTL_MAX_BUFFER = 256 * 1024 * 1024;
export function leaseKubectl(args: readonly string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  const r = spawnSync('kubectl', [...args], { encoding: 'utf8', input, env, timeout: 120_000, maxBuffer: LEASE_KUBECTL_MAX_BUFFER });
  const error = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS'
    ? `kubectl 출력 너무 큼 (ENOBUFS; maxBuffer=${LEASE_KUBECTL_MAX_BUFFER} bytes)`
    : r.error ? String(r.error) : '';
  return { status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + error };
}

export interface PodLeaseMember {
  context: string;
  capacity: number;
  running: number | null;
  pending: number | null;
  /** Job names of Pending harness Pods already included in pending (used to avoid counting the same Job's host lease twice). */
  pendingJobs?: PendingJobIdentity[];
  /** Running harness Pods whose Jobs predate host lease admission. */
  unleasedRunning: number | null;
  memoryLimitBytes: number | null;
  /** All-node allocatable memory, before existing reservations. */
  allocatableMemoryBytes: number | null;
  allocatableCpuMillicores: number | null;
  /** Node-by-node memory left after all assigned Pod requests and harness Running limits. */
  availableMemoryByNodeBytes: number[] | null;
  reason: string | null;
  /**
   * POD-ADMIT-BY-USAGE (only when measured with `measureUsage`): observed memory of Running harness Pods
   * (`kubectl top pods`). null = metrics unreadable (see usageReason) — every Pod is then reserved at its limit, as before.
   */
  harnessUsageBytes?: number[] | null;
  usageReason?: string | null;
  /** Pool-wide harness reservation: Σ min(limit, max(request, usage×1.5)), or max(request, limit) when the Pod's usage is unmeasured. */
  memoryReservedBytes?: number | null;
  /** Parallel to availableMemoryByNodeBytes: each schedulable node's allocatable memory. */
  allocatableMemoryByNodeBytes?: number[] | null;
  /** Parallel to availableMemoryByNodeBytes: each node's real memory use (`kubectl top nodes`), null when unmeasured. */
  usedMemoryByNodeBytes?: Array<number | null> | null;
}

/** POD-ADMIT-BY-USAGE — how much memory one new goal is counted at, and why. */
export interface PodAdmissionByUsage {
  samples: number;
  p95Bytes: number | null;
  admitBytes: number;
  /** Why admission stayed on the conservative per-goal size; null when usage drove it. */
  fallback: string | null;
}

export interface PoolLeaseMeasure {
  members: PodLeaseMember[];
}

export interface PoolLeaseRecommendation {
  recommended: number | null;
  limitedBy: 'capacity' | 'memory' | null;
  reason: string | null;
  capacitySlots: number | null;
  memorySlots: number | null;
  /** POD7 — the same memory headroom counted in lite goals (2Gi) · observation only: `recommended` stays on the standard size. */
  liteMemorySlots?: number | null;
  placeableSlots: number | null;
  accountSlots: number | null;
  running: number | null;
  pending: number | null;
  /** Names of Pending Jobs already counted in pending. */
  pendingJobs?: PendingJobIdentity[];
  /** Absent only for injected legacy status fixtures; real measurements always report a number or null. */
  unleasedRunning?: number | null;
  /** POD-ADMIT-BY-USAGE — the per-goal size this recommendation used. */
  admission?: PodAdmissionByUsage;
}

/** `kubectl top … --no-headers` → name → memory bytes; null when any line cannot be read (fail conservative). */
function topMemory(stdout: string, column: number): Map<string, number> | null {
  const out = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.trim().split(/\s+/u);
    const bytes = cols.length > column ? quantity(cols[column]!, 'memory') : null;
    if (bytes === null || out.has(cols[0]!)) return null;
    out.set(cols[0]!, bytes);
  }
  return out;
}

/** Nearest-rank p95. */
function p95(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
}

/** Kubernetes quantity to bytes (memory) or millicores (CPU). */
/** Kubernetes memory quantity (`16Gi`, `2Gi`, `512Mi`) → bytes; null when unparseable. */
export function memoryQuantityBytes(raw: string): number | null { return quantity(raw, 'memory'); }

function quantity(raw: string, unit: 'memory' | 'cpu'): number | null {
  const m = /^(\d+(?:\.\d+)?)(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/.exec(raw);
  if (!m) return null;
  const scale: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6 };
  const suffix = m[2] ?? '';
  if (unit === 'memory' && ['n', 'u', 'm'].includes(suffix)) return null;
  if (unit === 'cpu' && suffix.endsWith('i')) return null;
  const result = Number(m[1]) * (scale[suffix] ?? 1) * (unit === 'cpu' ? 1000 : 1);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function items(value: unknown): Record<string, unknown>[] | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { items?: unknown }).items)) return null;
  const list = (value as { items: unknown[] }).items;
  return list.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v)) ? list as Record<string, unknown>[] : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Effective scheduling reservation: max(sum of app requests, largest init request, Pod-level request) + overhead. */
function requestedMemory(spec: Record<string, unknown>): number | null {
  const request = (resources: unknown): number | null => {
    const r = object(resources);
    if (resources !== undefined && !r) return null;
    const requests = object(r?.requests);
    const limits = object(r?.limits);
    if ((r?.requests !== undefined && !requests) || (r?.limits !== undefined && !limits)) return null;
    const raw = requests?.memory ?? limits?.memory;
    return raw === undefined ? 0 : typeof raw === 'string' ? quantity(raw, 'memory') : null;
  };
  const containers = spec.containers;
  if (!Array.isArray(containers) || !containers.length) return null;
  let app = 0;
  for (const c of containers) {
    if (!object(c)) return null;
    const v = request(object(c)?.resources);
    if (v === null) return null;
    app += v;
  }
  let init = 0;
  if (spec.initContainers !== undefined && !Array.isArray(spec.initContainers)) return null;
  for (const c of (spec.initContainers ?? []) as unknown[]) {
    if (!object(c)) return null;
    const v = request(object(c)?.resources);
    if (v === null) return null;
    init = Math.max(init, v);
  }
  const pod = spec.resources === undefined ? 0 : request(spec.resources);
  const overheadRaw = object(spec.overhead)?.memory;
  const overhead = spec.overhead !== undefined && !object(spec.overhead) ? null
    : overheadRaw === undefined ? 0 : typeof overheadRaw === 'string' ? quantity(overheadRaw, 'memory') : null;
  return pod === null || overhead === null ? null : Math.max(app, init, pod) + overhead;
}

function runningLimit(spec: Record<string, unknown>): number | null {
  if (!Array.isArray(spec.containers) || !spec.containers.length) return null;
  let total = 0;
  for (const c of spec.containers) {
    const raw = object(object(object(c)?.resources)?.limits)?.memory;
    const value = typeof raw === 'string' ? quantity(raw, 'memory') : null;
    if (value === null) return null;
    total += value;
  }
  return total;
}

/** A short-lived Pod proves cluster DNS from inside the same namespace as harness Jobs. Image pull failures are not DNS failures. */
export type PoolDnsProbe = 'ready' | 'dns' | 'image' | 'unknown';
const DNS_CACHE_MS = 10 * 60_000;
const DNS_LOCK_WAIT_MS = 6 * 60_000;
// flock is released by the kernel on process exit, including a crash before any cache write.
// The lock file is never unlinked: unlinking it would let waiters lock different inodes.
const dnsFlock = process.platform === 'linux' || process.platform === 'darwin'
  ? dlopen(process.platform === 'linux' ? 'libc.so.6' : 'libSystem.B.dylib', {
    flock: { args: ['int', 'int'], returns: 'int' },
  }).symbols.flock : null;

/** The cache and lock are shared by CLI processes, keyed by context rather than pool composition. */
export function probePoolDns(context: string, kubectl: PoolKubectl = leaseKubectl, options: { dir?: string; now?: () => number } = {}): PoolDnsProbe {
  const dir = options.dir ?? hostLeaseBaseDir();
  const now = options.now ?? Date.now;
  const key = createHash('sha256').update(context).digest('hex');
  const cache = join(dir, `dns-${key}.cache`);
  const outcome = join(dir, `dns-${key}.outcome`);
  const lock = join(dir, `dns-${key}.flock`);
  const readRecord = (path: string): Record<string, unknown> | null => {
    try { return object(JSON.parse(readFileSync(path, 'utf8'))); }
    catch { return null; }
  };
  const cached = (): boolean => {
    const record = readRecord(cache);
    return record?.result === 'ready' && typeof record.at === 'number' &&
      now() >= record.at && now() - record.at < DNS_CACHE_MS;
  };
  if (cached()) return 'ready';
  const previous = readRecord(outcome);
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return 'unknown'; }
  if (!dnsFlock) return 'unknown';
  let fd: number;
  try { fd = openSync(lock, 'a', 0o600); } catch { return 'unknown'; }
  const deadline = Date.now() + DNS_LOCK_WAIT_MS;
  let held = false;
  try {
    const sharedFailure = (): PoolDnsProbe | null => {
      const record = readRecord(outcome);
      // Only a caller that started before this generation was written can reuse it.
      if (record?.generation !== undefined && record.generation !== previous?.generation &&
          ['dns', 'image', 'unknown'].includes(String(record.result))) return record.result as PoolDnsProbe;
      return null;
    };
    while (!held) {
      if (cached()) return 'ready';
      const shared = sharedFailure();
      if (shared) return shared;
      if (dnsFlock(fd, 2 | 4) === 0) { held = true; break; } // LOCK_EX | LOCK_NB
      if (Date.now() >= deadline) return 'unknown';
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (cached()) return 'ready';
    const shared = sharedFailure();
    if (shared) return shared;
    const result = runPoolDnsProbe(context, kubectl);
    const destination = result === 'ready' ? cache : outcome;
    const temp = `${destination}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ result, at: now(), generation: randomUUID() }), { mode: 0o600 });
      renameSync(temp, destination);
    } catch { try { rmSync(temp, { force: true }); } catch { /* best-effort cleanup */ } }
    return result;
  } finally {
    if (held) dnsFlock(fd, 8); // LOCK_UN
    closeSync(fd);
  }
}

function runPoolDnsProbe(context: string, kubectl: PoolKubectl): PoolDnsProbe {
  const name = `elanous-dns-${randomUUID().slice(0, 12)}`;
  const base = ['--context', context, '--request-timeout=10s'];
  try {
    const core = kubectl([...base, '-n', 'kube-system', 'get', 'deployment', 'coredns', '-o', 'json']);
    if (core.status !== 0) return 'unknown';
    const deployment = object(JSON.parse(core.stdout));
    const spec = object(deployment?.spec);
    const status = object(deployment?.status);
    if (typeof spec?.replicas !== 'number' || spec.replicas < 1 || status?.readyReplicas !== spec.replicas) return 'dns';
    const manifest = JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: 'elanous-test', labels: { 'elanous.probe': 'dns' } }, spec: {
      restartPolicy: 'Never', activeDeadlineSeconds: 40, automountServiceAccountToken: false,
      containers: [{ name: 'dns', image: 'busybox:1.36', command: ['nslookup', 'kubernetes.default.svc.cluster.local'], resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '100m', memory: '64Mi' } } }],
    } });
    if (kubectl([...base, 'create', '-f', '-'], manifest).status !== 0) return 'unknown';
    const waited = kubectl([...base, '-n', 'elanous-test', 'wait', '--for=jsonpath={.status.phase}=Succeeded', `pod/${name}`, '--timeout=30s']);
    const pod = kubectl([...base, '-n', 'elanous-test', 'get', `pod/${name}`, '-o', 'json']);
    if (pod.status !== 0) return 'unknown';
    const state = object(JSON.parse(pod.stdout));
    const phase = object(state?.status)?.phase;
    const statuses = object(state?.status)?.containerStatuses;
    if (Array.isArray(statuses) && statuses.some((c) =>
      ['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName'].includes(String(object(object(object(c)?.state)?.waiting)?.reason)))) return 'image';
    if (phase !== 'Succeeded' && phase !== 'Failed') return 'unknown';
    if (waited.status !== 0 && phase !== 'Failed') return 'unknown';
    const log = kubectl([...base, '-n', 'elanous-test', 'logs', `pod/${name}`]);
    if (log.status !== 0) return 'unknown';
    if (phase === 'Failed') return /can't resolve|server can't find|connection timed out|no servers could be reached|NXDOMAIN|SERVFAIL/iu.test(log.stdout) ? 'dns' : 'unknown';
    return /\bName:\s*kubernetes\.default\.svc\.cluster\.local\b/u.test(log.stdout) && /\bAddress(?:es)?:\s*\S+/u.test(log.stdout) ? 'ready' : 'dns';
  } catch { return 'unknown'; }
  finally { try { kubectl([...base, '-n', 'elanous-test', 'delete', `pod/${name}`, '--ignore-not-found=true', '--wait=false']); } catch { /* best-effort cleanup */ } }
}

/** Each cluster reads resource reservations; DNS requires a bounded disposable Pod. */
export function measurePoolLease(members: readonly PodPoolMember[], deps: { kubectl?: PoolKubectl; dns?: (context: string) => PoolDnsProbe; /** Read-only snapshots must not create the disposable DNS Pod or update its cache. */ skipDnsProbe?: boolean; /** POD-ADMIT-BY-USAGE — also read `kubectl top` so Running harness Pods reserve by observed usage. */ measureUsage?: boolean } = {}): PoolLeaseMeasure {
  const kubectl = deps.kubectl ?? leaseKubectl;
  return { members: members.map((member) => {
    const base = ['--context', member.context, '--request-timeout=10s'];
    const result: PodLeaseMember = { context: member.context, capacity: member.capacity, running: null, pending: null, unleasedRunning: null, memoryLimitBytes: null, allocatableMemoryBytes: null, allocatableCpuMillicores: null, availableMemoryByNodeBytes: null, reason: null };
    try {
      const nodes = kubectl([...base, 'get', 'nodes', '-o', 'json']);
      const jobs = kubectl([...base, '-n', 'elanous-test', 'get', 'jobs', '-l', 'elanous.substrate=pod', '-o', 'json']);
      // All namespaces are necessary: unrelated workloads also reserve memory on these nodes.
      const pods = kubectl([...base, 'get', 'pods', '--all-namespaces', '-o', 'json']);
      const reasons: string[] = [];
      // POD-ADMIT-BY-USAGE: metrics are optional — a failed `top` leaves every reservation at today's limit.
      let podUsage: Map<string, number> | null = null;
      let nodeUsage: Map<string, number> | null = null;
      if (deps.measureUsage) {
        const top = kubectl([...base, '-n', 'elanous-test', 'top', 'pods', '--no-headers']);
        podUsage = top.status === 0 ? topMemory(top.stdout, 2) : null;
        result.usageReason = podUsage ? null
          : `top pods unavailable: ${top.status === 0 ? 'unparseable output' : top.stderr.trim().split('\n').pop() || `rc=${top.status}`}`.slice(0, 160);
        if (podUsage) {
          const topNodes = kubectl([...base, 'top', 'nodes', '--no-headers']);
          nodeUsage = topNodes.status === 0 ? topMemory(topNodes.stdout, 3) : null;
          // The node real-usage floor needs node metrics: without them stay on today's limit reservations.
          if (!nodeUsage) {
            podUsage = null;
            result.usageReason = `top nodes unavailable: ${topNodes.status === 0 ? 'unparseable output' : topNodes.stderr.trim().split('\n').pop() || `rc=${topNodes.status}`}`.slice(0, 160);
          }
        }
      }
      const harnessUsage: number[] = [];
      const nodeAllocatable = new Map<string, number>();
      const parsedItems = (response: ReturnType<PoolKubectl>): Record<string, unknown>[] | null => {
        if (response.status !== 0) return null;
        try { return items(JSON.parse(response.stdout)); } catch { return null; }
      };
      const nodeItems = parsedItems(nodes);
      const nodeFree = new Map<string, number>();
      const nodeNames = new Set<string>();
      if (!nodeItems?.length) reasons.push(`cluster nodes: ${nodes.status === 0 ? 'invalid/empty response' : nodes.stderr.trim().split('\n').pop() || `rc=${nodes.status}`}`);
      else {
        let memory = 0, cpu = 0, valid = true;
        for (const node of nodeItems) {
          const name = object(node.metadata)?.name;
          const status = object(node.status);
          const allocatable = object(status?.allocatable);
          const memRaw = allocatable?.memory, cpuRaw = allocatable?.cpu;
          const mem = typeof memRaw === 'string' ? quantity(memRaw, 'memory') : null;
          const cores = typeof cpuRaw === 'string' ? quantity(cpuRaw, 'cpu') : null;
          const conditions = status?.conditions;
          const ready = Array.isArray(conditions) ? conditions.filter((c) => object(c)?.type === 'Ready') : [];
          const spec = object(node.spec);
          // Harness Pod Jobs declare no tolerations, so a NoSchedule/NoExecute taint keeps them off that node.
          const taints = spec?.taints;
          const taintList = taints === undefined ? [] : Array.isArray(taints) ? taints.map(object) : null;
          if (typeof name !== 'string' || !name || nodeNames.has(name) || mem === null || cores === null ||
              ready.length !== 1 || !['True', 'False', 'Unknown'].includes(String(object(ready[0])?.status)) ||
              (node.spec !== undefined && !spec) || (spec?.unschedulable !== undefined && typeof spec.unschedulable !== 'boolean') ||
              taintList === null || taintList.some((t) => !t || typeof t.effect !== 'string')) {
            valid = false; break;
          }
          nodeNames.add(name);
          const repels = taintList.some((t) => t!.effect === 'NoSchedule' || t!.effect === 'NoExecute');
          if (spec?.unschedulable !== true && !repels && object(ready[0])?.status === 'True') { nodeFree.set(name, mem); nodeAllocatable.set(name, mem); }
          memory += mem; cpu += cores;
        }
        if (valid) { result.allocatableMemoryBytes = memory; result.allocatableCpuMillicores = cpu; }
        else { nodeFree.clear(); nodeAllocatable.clear(); nodeNames.clear(); reasons.push('cluster nodes: invalid name/allocatable memory/cpu/readiness'); }
      }
      // POD-ADMIT-BY-USAGE: every schedulable node needs a real-usage reading, or the member stays on limits.
      const unreadNode = podUsage && nodeUsage ? [...nodeFree.keys()].find((n) => !nodeUsage!.has(n)) : undefined;
      if (unreadNode !== undefined) { podUsage = null; result.usageReason = `top nodes: no reading for ${unreadNode}`.slice(0, 160); }
      const jobItems = parsedItems(jobs);
      const podItems = parsedItems(pods);
      if (!jobItems) reasons.push(`cluster jobs: ${jobs.status === 0 ? 'invalid response' : jobs.stderr.trim().split('\n').pop() || `rc=${jobs.status}`}`);
      if (!podItems) reasons.push(`cluster pods: ${pods.status === 0 ? 'invalid response' : pods.stderr.trim().split('\n').pop() || `rc=${pods.status}`}`);
      if (podItems && jobItems) {
        const jobNames = new Set<string>();
        const leasedJobs = new Set<string>();
        let jobsValid = true;
        for (const job of jobItems) {
          const meta = object(job.metadata);
          if (!meta || !object(meta.labels)) { jobsValid = false; continue; }
          if (object(meta.labels)?.['elanous.substrate'] !== 'pod') continue;
          if (typeof meta.name !== 'string' || !meta.name) { jobsValid = false; continue; }
          jobNames.add(meta.name);
          if (object(meta.annotations)?.[POD_HOST_LEASE_ANNOTATION] === 'true') leasedJobs.add(meta.name);
        }
        if (!jobsValid) reasons.push('cluster jobs: missing name/labels');
        let running = 0, pending = 0, unleasedRunning = 0, limits = 0, reserved = 0, limitsValid = true, reservationsValid = nodeItems !== null && nodeNames.size === nodeItems.length;
        const pendingJobs = new Map<string, PendingJobIdentity>();
        let unknownPhase = false;
        const seenPods = new Set<string>();
        for (const pod of podItems) {
          const metadata = object(pod.metadata);
          const labels = object(metadata?.labels);
          const phase = object(pod.status)?.phase;
          if (phase === 'Succeeded' || phase === 'Failed') continue;
          if (phase !== 'Running' && phase !== 'Pending') { unknownPhase = true; reservationsValid = false; continue; }
          if (typeof metadata?.namespace !== 'string') reservationsValid = false;
          const identity = typeof metadata?.namespace === 'string' && typeof metadata.name === 'string' && metadata.name
            ? `name:${metadata.namespace}/${metadata.name}` : null;
          if (identity) {
            if (seenPods.has(identity)) { reservationsValid = false; continue; }
            seenPods.add(identity);
          } else reservationsValid = false;
          const harness = metadata?.namespace === 'elanous-test' && labels?.['elanous.probe'] !== 'dns' &&
            (labels?.['elanous.substrate'] === 'pod' || jobNames.has(String(labels?.['elanous.job'] ?? '')));
          const spec = object(pod.spec);
          let limit: number | null = null;
          let reserve: number | null = null;
          if (harness) {
            if (phase === 'Pending') {
              pending++;
              const jobName = labels?.['elanous.job'] ?? labels?.['job-name'];
              if (typeof jobName === 'string' && jobName && typeof metadata.namespace === 'string' && metadata.namespace) {
                const identity = { context: member.context, namespace: metadata.namespace, job: jobName };
                pendingJobs.set(JSON.stringify(identity), identity);
              }
            } else {
              running++;
              const jobName = labels?.['elanous.job'] ?? labels?.['job-name'];
              if (typeof jobName !== 'string' || !leasedJobs.has(jobName)) unleasedRunning++;
              limit = spec ? runningLimit(spec) : null;
              if (limit === null) limitsValid = false;
              else {
                limits += limit;
                // Measured usage: max(request, usage×1.5) capped at the limit. Unmeasured: max(request, limit) (today's node reservation).
                const used = typeof metadata.name === 'string' ? podUsage?.get(metadata.name) : undefined;
                const request = spec ? requestedMemory(spec) : null;
                if (used !== undefined) harnessUsage.push(used);
                reserve = used !== undefined && request !== null ? Math.min(limit, Math.max(request, Math.ceil(used * POD_USAGE_HEADROOM))) : Math.max(request ?? 0, limit);
                reserved += reserve;
              }
            }
          }
          // Pending Pods with no assigned node have no node reservation yet. They already occupy a pool slot.
          const nodeName = spec?.nodeName;
          if ((nodeName === undefined || nodeName === '') && phase === 'Pending' && spec && typeof metadata?.namespace === 'string' &&
              requestedMemory(spec) !== null) continue;
          const requested = spec ? requestedMemory(spec) : null;
          if (typeof nodeName !== 'string' || !nodeNames.has(nodeName) || requested === null) { reservationsValid = false; continue; }
          if (nodeFree.has(nodeName)) nodeFree.set(nodeName, nodeFree.get(nodeName)! - Math.max(requested, reserve ?? limit ?? 0));
        }
        if (unknownPhase) reasons.push('cluster pods: missing/Unknown phase');
        if (jobsValid && !unknownPhase) { result.running = running; result.pending = pending; result.pendingJobs = [...pendingJobs.values()]; result.unleasedRunning = unleasedRunning; }
        if (limitsValid && jobsValid && !unknownPhase) {
          result.memoryLimitBytes = limits;
          if (deps.measureUsage) { result.memoryReservedBytes = reserved; result.harnessUsageBytes = podUsage ? harnessUsage : null; }
        }
        else if (!limitsValid) reasons.push('cluster pods: Running Pod memory limit missing/invalid');
        if (reservationsValid && limitsValid && jobsValid && !unknownPhase) {
          result.availableMemoryByNodeBytes = [...nodeFree.values()];
          if (deps.measureUsage) {
            result.allocatableMemoryByNodeBytes = [...nodeFree.keys()].map((n) => nodeAllocatable.get(n)!);
            result.usedMemoryByNodeBytes = [...nodeFree.keys()].map((n) => nodeUsage?.get(n) ?? null);
          }
        }
        else if (!reservationsValid && !unknownPhase) reasons.push('cluster reservations: node assignment or memory request/limit missing/invalid');
      }
      result.reason = reasons.length ? reasons.join('; ').slice(0, 240) : null;
      if (!deps.skipDnsProbe && nodeItems?.length && jobItems && podItems) {
        let dnsState: PoolDnsProbe = 'unknown';
        try { dnsState = (deps.dns ?? ((context) => probePoolDns(context, kubectl)))(member.context); } catch { /* probe could not be measured */ }
        if (dnsState === 'dns') { result.capacity = 0; result.availableMemoryByNodeBytes = []; result.reason = 'dns'; }
        else if (dnsState !== 'ready') { result.availableMemoryByNodeBytes = null; result.reason = `측정 불가: dns probe ${dnsState}`; }
      }
    } catch (error) {
      result.running = null; result.pending = null; result.unleasedRunning = null; result.memoryLimitBytes = null;
      result.allocatableMemoryBytes = null; result.allocatableCpuMillicores = null; result.availableMemoryByNodeBytes = null;
      if (deps.measureUsage) { result.memoryReservedBytes = null; result.harnessUsageBytes = null; result.allocatableMemoryByNodeBytes = null; result.usedMemoryByNodeBytes = null; }
      result.reason = `cluster: ${error instanceof Error ? error.message : String(error)}`.split('\n')[0]!.slice(0, 240);
    }
    return result;
  }) };
}

/** Per-node memory and per-member slots cannot be exchanged across nodes/clusters. */
export function recommendConcurrency(measure: PoolLeaseMeasure, options: { capacity: number; perGoalMemory?: string; liteGoalMemory?: string; accounts: number; perAccount: number }): PoolLeaseRecommendation {
  const empty: PoolLeaseRecommendation = { recommended: null, limitedBy: null, reason: null, capacitySlots: null, memorySlots: null, liteMemorySlots: null, placeableSlots: null, accountSlots: null, running: null, pending: null, unleasedRunning: null };
  const goalBytes = quantity(options.perGoalMemory ?? '16Gi', 'memory');
  if (goalBytes === null || goalBytes <= 0) return { ...empty, reason: '측정 불가: perGoalMemory' };
  const admission = admissionByUsage(measure, goalBytes, options.perGoalMemory !== undefined);
  if (!measure.members.length || measure.members.some((m) => m.running === null || m.pending === null || m.unleasedRunning === null || m.allocatableMemoryBytes === null || m.memoryLimitBytes === null || m.allocatableCpuMillicores === null || m.availableMemoryByNodeBytes === null)) {
    debug.log('pod-lease', 'admit-by-usage', { samples: admission.samples, p95Bytes: admission.p95Bytes, admitBytes: admission.admitBytes, fallback: admission.fallback, recommended: null, limitedBy: null });
    return { ...empty, reason: `측정 불가: cluster${measure.members.map((m) => m.reason ? ` ${m.context}: ${m.reason}` : '').join('')}` };
  }
  if (!Number.isSafeInteger(options.capacity) || options.capacity < 0) return { ...empty, reason: '측정 불가: capacity' };
  const running = measure.members.reduce((sum, m) => sum + m.running!, 0);
  const pending = measure.members.reduce((sum, m) => sum + m.pending!, 0);
  const pendingJobs = measure.members.flatMap((m) => m.pendingJobs ?? []);
  const unleasedRunning = measure.members.reduce((sum, m) => sum + m.unleasedRunning!, 0);
  // Pool-wide free = sum of per-member free slots: a member over its cap counts as full, never negative,
  // so it cannot zero another member's free slot (and its unleased Pods only consume its own free slots).
  const memberFree = measure.members.map((m) => Math.max(0, m.capacity - m.running! - m.pending!));
  const eligibleUnleasedRunning = measure.members.reduce((sum, m, i) => sum + (m.reason === 'dns' ? 0 : Math.min(m.unleasedRunning!, memberFree[i]!)), 0);
  const eligibleOccupied = measure.members.reduce((sum, m) => sum + (m.reason === 'dns' ? 0 : Math.min(m.capacity, m.running! + m.pending!)), 0);
  const capacitySlots = Math.max(0, Math.min(options.capacity - eligibleOccupied,
    memberFree.reduce((sum, free) => sum + free, 0)));
  // The goal size may fall back to the conservative size pool-wide; the node floor is separate and follows each
  // member: once its Running Pods reserve by usage (usage read), its nodes keep 10% free in bookkeeping and real use.
  const admitBytes = admission.admitBytes;
  const usageRead = (m: PodLeaseMember) => Array.isArray(m.harnessUsageBytes);
  const memberMemorySlots = measure.members.map((m) => m.availableMemoryByNodeBytes!.reduce((sum, bytes, i) => {
    if (!usageRead(m)) return sum + Math.max(0, Math.floor(bytes / admitBytes));
    const allocatable = m.allocatableMemoryByNodeBytes?.[i];
    const used = m.usedMemoryByNodeBytes?.[i];
    // A usage-read member always carries both per-node readings; anything missing admits nothing on that node.
    if (typeof allocatable !== 'number' || typeof used !== 'number') return sum;
    const floor = allocatable * POD_NODE_FREE_FLOOR_RATIO;
    const slots = Math.min(Math.floor((bytes - floor) / admitBytes), Math.floor((allocatable - used - floor) / admitBytes));
    return sum + Math.max(0, slots);
  }, 0));
  // Preserve the requested allocatable-minus-harness-limit metric. The node-local
  // placement bound additionally accounts for every namespace's reservations.
  const memorySlots = measure.members.reduce((sum, m) => sum + (m.reason === 'dns' ? 0 : Math.max(0, usageRead(m)
    ? Math.floor((m.allocatableMemoryBytes! * (1 - POD_NODE_FREE_FLOOR_RATIO) - (m.memoryReservedBytes ?? m.memoryLimitBytes!)) / admitBytes)
    : Math.floor((m.allocatableMemoryBytes! - m.memoryLimitBytes!) / admitBytes))), 0);
  const placeableSlots = measure.members.reduce((sum, m, i) => sum + Math.min(
    Math.max(0, m.capacity - m.running! - m.pending!), memberMemorySlots[i]!,
  ), 0);
  // Account count is not a concurrency limit (same IP · own accounts, 10-03 decision) — observed only, never a bound.
  const accountSlots = [options.accounts, options.perAccount].every((n) => Number.isSafeInteger(n) && n >= 0)
    ? Math.max(0, options.accounts * options.perAccount - running) : null;
  const liteBytes = quantity(options.liteGoalMemory ?? '2Gi', 'memory');
  const liteMemorySlots = liteBytes === null || liteBytes <= 0 ? null : measure.members.reduce((sum, m) => sum + (m.reason === 'dns' ? 0 : Math.max(0,
    Math.floor((m.allocatableMemoryBytes! - m.memoryLimitBytes!) / liteBytes))), 0);
  const memoryBound = Math.min(memorySlots, placeableSlots);
  const recommended = Math.max(0, Math.min(capacitySlots, memoryBound) - eligibleUnleasedRunning);
  const limitedBy = memoryBound < capacitySlots ? 'memory' : 'capacity';
  if (unleasedRunning > 0) debug.log('pod-lease', 'unleased', { unleasedRunning, running, recommended });
  debug.log('pod-lease', 'admit-by-usage', { samples: admission.samples, p95Bytes: admission.p95Bytes, admitBytes: admission.admitBytes, fallback: admission.fallback, recommended, limitedBy });
  return { recommended, limitedBy, reason: measure.members.some((m) => m.reason === 'dns') ? 'dns' : null, capacitySlots, memorySlots, liteMemorySlots, placeableSlots, accountSlots, running, pending, pendingJobs, unleasedRunning, admission };
}

/**
 * POD-ADMIT-BY-USAGE — one new goal counts at max(the Pod's memory request, p95 of Running harness Pod usage × 1.5),
 * capped at the per-goal size. No samples (metrics unreadable, nothing running, or an explicit per-goal size such as an
 * OOM retry tier) keeps the conservative per-goal size.
 */
function admissionByUsage(measure: PoolLeaseMeasure, goalBytes: number, explicit: boolean): PodAdmissionByUsage {
  const live = measure.members.filter((m) => m.reason !== 'dns');
  const samples = live.flatMap((m) => m.harnessUsageBytes ?? []);
  const p95Bytes = p95(samples);
  const requestBytes = quantity(POD_CHILD_REQUESTS.memory, 'memory')!;
  // Any live member whose usage was not read keeps the whole pool on today's per-goal size (fail conservative).
  const fallback = explicit ? 'explicit perGoalMemory'
    : live.every((m) => m.harnessUsageBytes === undefined) ? 'usage not measured'
      : live.some((m) => m.harnessUsageBytes == null) ? (live.map((m) => m.harnessUsageBytes == null ? `${m.context}: ${m.usageReason ?? 'usage not measured'}` : '').filter(Boolean).join('; '))
        : p95Bytes === null ? 'no Running harness Pod usage samples'
          : null;
  const admitBytes = fallback !== null || p95Bytes === null ? goalBytes
    : Math.min(goalBytes, Math.max(requestBytes, Math.ceil(p95Bytes * POD_USAGE_HEADROOM)));
  return { samples: samples.length, p95Bytes, admitBytes, fallback };
}
