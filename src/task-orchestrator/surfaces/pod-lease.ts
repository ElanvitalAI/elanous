import type { PodPoolMember, PoolKubectl } from './pod-pool.js';
import { spawnSync } from 'node:child_process';

// `get pods --all-namespaces -o json` on a busy cluster is several MB — the default spawnSync
// buffer fails with ENOBUFS (10-03 node-b measured). Same proxy stripping as the Pod launch kubectl.
const LEASE_KUBECTL_MAX_BUFFER = 256 * 1024 * 1024;
export function leaseKubectl(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  const r = spawnSync('kubectl', [...args], { encoding: 'utf8', env, timeout: 120_000, maxBuffer: LEASE_KUBECTL_MAX_BUFFER });
  return { status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error) : '') };
}

export interface PodLeaseMember {
  context: string;
  capacity: number;
  running: number | null;
  pending: number | null;
  memoryLimitBytes: number | null;
  /** All-node allocatable memory, before existing reservations. */
  allocatableMemoryBytes: number | null;
  allocatableCpuMillicores: number | null;
  /** Node-by-node memory left after all assigned Pod requests and harness Running limits. */
  availableMemoryByNodeBytes: number[] | null;
  reason: string | null;
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
  placeableSlots: number | null;
  accountSlots: number | null;
  running: number | null;
  pending: number | null;
}

/** Kubernetes quantity to bytes (memory) or millicores (CPU). */
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

/** Read only: each cluster probe is kubectl get. Missing reservations cannot become zero. */
export function measurePoolLease(members: readonly PodPoolMember[], deps: { kubectl?: PoolKubectl } = {}): PoolLeaseMeasure {
  const kubectl = deps.kubectl ?? leaseKubectl;
  return { members: members.map((member) => {
    const base = ['--context', member.context, '--request-timeout=10s'];
    const result: PodLeaseMember = { context: member.context, capacity: member.capacity, running: null, pending: null, memoryLimitBytes: null, allocatableMemoryBytes: null, allocatableCpuMillicores: null, availableMemoryByNodeBytes: null, reason: null };
    try {
      const nodes = kubectl([...base, 'get', 'nodes', '-o', 'json']);
      const jobs = kubectl([...base, '-n', 'elanous-test', 'get', 'jobs', '-l', 'elanous.substrate=pod', '-o', 'json']);
      // All namespaces are necessary: unrelated workloads also reserve memory on these nodes.
      const pods = kubectl([...base, 'get', 'pods', '--all-namespaces', '-o', 'json']);
      const reasons: string[] = [];
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
          if (spec?.unschedulable !== true && !repels && object(ready[0])?.status === 'True') nodeFree.set(name, mem);
          memory += mem; cpu += cores;
        }
        if (valid) { result.allocatableMemoryBytes = memory; result.allocatableCpuMillicores = cpu; }
        else { nodeFree.clear(); nodeNames.clear(); reasons.push('cluster nodes: invalid name/allocatable memory/cpu/readiness'); }
      }
      const jobItems = parsedItems(jobs);
      const podItems = parsedItems(pods);
      if (!jobItems) reasons.push(`cluster jobs: ${jobs.status === 0 ? 'invalid response' : jobs.stderr.trim().split('\n').pop() || `rc=${jobs.status}`}`);
      if (!podItems) reasons.push(`cluster pods: ${pods.status === 0 ? 'invalid response' : pods.stderr.trim().split('\n').pop() || `rc=${pods.status}`}`);
      if (podItems && jobItems) {
        const jobNames = new Set<string>();
        let jobsValid = true;
        for (const job of jobItems) {
          const meta = object(job.metadata);
          if (!meta || !object(meta.labels)) { jobsValid = false; continue; }
          if (object(meta.labels)?.['elanous.substrate'] !== 'pod') continue;
          if (typeof meta.name !== 'string' || !meta.name) { jobsValid = false; continue; }
          jobNames.add(meta.name);
        }
        if (!jobsValid) reasons.push('cluster jobs: missing name/labels');
        let running = 0, pending = 0, limits = 0, limitsValid = true, reservationsValid = nodeItems !== null && nodeNames.size === nodeItems.length;
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
          const harness = metadata?.namespace === 'elanous-test' &&
            (labels?.['elanous.substrate'] === 'pod' || jobNames.has(String(labels?.['elanous.job'] ?? '')));
          const spec = object(pod.spec);
          let limit: number | null = null;
          if (harness) {
            if (phase === 'Pending') pending++;
            else {
              running++;
              limit = spec ? runningLimit(spec) : null;
              if (limit === null) limitsValid = false;
              else limits += limit;
            }
          }
          // Pending Pods with no assigned node have no node reservation yet. They already occupy a pool slot.
          const nodeName = spec?.nodeName;
          if ((nodeName === undefined || nodeName === '') && phase === 'Pending' && spec && typeof metadata?.namespace === 'string' &&
              requestedMemory(spec) !== null) continue;
          const requested = spec ? requestedMemory(spec) : null;
          if (typeof nodeName !== 'string' || !nodeNames.has(nodeName) || requested === null) { reservationsValid = false; continue; }
          if (nodeFree.has(nodeName)) nodeFree.set(nodeName, nodeFree.get(nodeName)! - Math.max(requested, limit ?? 0));
        }
        if (unknownPhase) reasons.push('cluster pods: missing/Unknown phase');
        if (jobsValid && !unknownPhase) { result.running = running; result.pending = pending; }
        if (limitsValid && jobsValid && !unknownPhase) result.memoryLimitBytes = limits;
        else if (!limitsValid) reasons.push('cluster pods: Running Pod memory limit missing/invalid');
        if (reservationsValid && limitsValid && jobsValid && !unknownPhase) result.availableMemoryByNodeBytes = [...nodeFree.values()];
        else if (!reservationsValid && !unknownPhase) reasons.push('cluster reservations: node assignment or memory request/limit missing/invalid');
      }
      result.reason = reasons.length ? reasons.join('; ').slice(0, 240) : null;
    } catch (error) {
      result.running = null; result.pending = null; result.memoryLimitBytes = null;
      result.allocatableMemoryBytes = null; result.allocatableCpuMillicores = null; result.availableMemoryByNodeBytes = null;
      result.reason = `cluster: ${error instanceof Error ? error.message : String(error)}`.split('\n')[0]!.slice(0, 240);
    }
    return result;
  }) };
}

/** Per-node memory and per-member slots cannot be exchanged across nodes/clusters. */
export function recommendConcurrency(measure: PoolLeaseMeasure, options: { capacity: number; perGoalMemory?: string; accounts: number; perAccount: number }): PoolLeaseRecommendation {
  const empty: PoolLeaseRecommendation = { recommended: null, limitedBy: null, reason: null, capacitySlots: null, memorySlots: null, placeableSlots: null, accountSlots: null, running: null, pending: null };
  const goalBytes = quantity(options.perGoalMemory ?? '16Gi', 'memory');
  if (goalBytes === null || goalBytes <= 0) return { ...empty, reason: '측정 불가: perGoalMemory' };
  if (!measure.members.length || measure.members.some((m) => m.running === null || m.pending === null || m.allocatableMemoryBytes === null || m.memoryLimitBytes === null || m.allocatableCpuMillicores === null || m.availableMemoryByNodeBytes === null)) {
    return { ...empty, reason: `측정 불가: cluster${measure.members.map((m) => m.reason ? ` ${m.context}: ${m.reason}` : '').join('')}` };
  }
  if (!Number.isSafeInteger(options.capacity) || options.capacity < 0) return { ...empty, reason: '측정 불가: capacity' };
  const running = measure.members.reduce((sum, m) => sum + m.running!, 0);
  const pending = measure.members.reduce((sum, m) => sum + m.pending!, 0);
  const capacitySlots = Math.max(0, Math.min(options.capacity - running - pending,
    measure.members.reduce((sum, m) => sum + Math.max(0, m.capacity - m.running! - m.pending!), 0)));
  const memberMemorySlots = measure.members.map((m) => m.availableMemoryByNodeBytes!.reduce(
    (sum, bytes) => sum + Math.max(0, Math.floor(bytes / goalBytes)), 0));
  // Preserve the requested allocatable-minus-harness-limit metric. The node-local
  // placement bound additionally accounts for every namespace's reservations.
  const memorySlots = measure.members.reduce((sum, m) => sum + Math.max(0,
    Math.floor((m.allocatableMemoryBytes! - m.memoryLimitBytes!) / goalBytes)), 0);
  const placeableSlots = measure.members.reduce((sum, m, i) => sum + Math.min(
    Math.max(0, m.capacity - m.running! - m.pending!), memberMemorySlots[i]!,
  ), 0);
  // Account count is not a concurrency limit (same IP · own accounts, 10-03 decision) — observed only, never a bound.
  const accountSlots = [options.accounts, options.perAccount].every((n) => Number.isSafeInteger(n) && n >= 0)
    ? Math.max(0, options.accounts * options.perAccount - running) : null;
  const memoryBound = Math.min(memorySlots, placeableSlots);
  const recommended = Math.min(capacitySlots, memoryBound);
  const limitedBy = recommended === memoryBound && memoryBound < capacitySlots ? 'memory' : 'capacity';
  return { recommended, limitedBy, reason: null, capacitySlots, memorySlots, placeableSlots, accountSlots, running, pending };
}
