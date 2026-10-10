import { describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parsePodPool, type PoolKubectl } from './pod-pool.js';
import { harnessCpuSlotsBesideGate, measurePoolLease, probePoolDns, recommendConcurrency, POD_HOST_LEASE_ANNOTATION, type PoolLeaseMeasure } from './pod-lease.js';
import { podJobManifest } from './self-implement-pod.js';
import { podCommandJobManifest } from './pod-command-job.js';
import { debug } from '../../debug/log.js';

const uncachedProbe = (context: string, kubectl: PoolKubectl) => {
  const dir = mkdtempSync(join(tmpdir(), 'dns-probe-test-'));
  try { return probePoolDns(context, kubectl, { dir }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};
const emptyDnsProbeList = JSON.stringify({ items: [] });
const gi = 1024 ** 3;
const node = (memory = '263471132Ki', cpu = '32') => JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory, cpu }, conditions: [{ type: 'Ready', status: 'True' }] } }] });
interface FixturePod {
  metadata: { namespace: string; name: string; labels: Record<string, string> };
  status: { phase?: string };
  spec: { nodeName?: string; containers: Array<{ resources: { limits: { memory: string }; requests?: { memory: string } } }>; initContainers?: Array<{ resources: { limits?: { memory: string }; requests?: { memory: string } } }> };
}
let podSerial = 0;
const pod = (phase: string, memory = '16Gi', labeled = true): FixturePod => ({
  metadata: { namespace: 'elanous-test', name: `fixture-${++podSerial}`, labels: labeled ? { 'elanous.substrate': 'pod', 'elanous.job': 'harness-job' } : {} },
  status: { phase }, spec: { nodeName: 'node-1', containers: [{ resources: { limits: { memory }, requests: { memory } } }] },
});
const fixture = (pods: ReturnType<typeof pod>[], nodes = node()): PoolKubectl => (args) => {
  expect(args.slice(0, 3)).toEqual(['--context', 'node-b', '--request-timeout=10s']);
  expect(args).toContain('get');
  if (args.includes('nodes')) return { status: 0, stdout: nodes, stderr: '' };
  if (args.includes('jobs')) expect(args).toContain('elanous-test');
  else expect(args).toContain('--all-namespaces');
  if (args.includes('jobs')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'harness-job', labels: { 'elanous.substrate': 'pod' }, annotations: { [POD_HOST_LEASE_ANNOTATION]: 'true' } } }] }), stderr: '' };
  expect(args).toContain('pods');
  return { status: 0, stdout: JSON.stringify({ items: pods }), stderr: '' };
};
const measured = (pods: ReturnType<typeof pod>[], nodes = node()) => measurePoolLease(parsePodPool('node-b:20'), { kubectl: fixture(pods, nodes), dns: () => 'ready' });
const recommend = (pods: ReturnType<typeof pod>[], accounts = 10, nodes = node()) => recommendConcurrency(measured(pods, nodes), { capacity: 20, accounts, perAccount: 4 });

describe('pod lease measurement and recommendation', () => {
  // GATE-RESERVE-AUTO — fixtures: a release-gate shard Job (`gate-<uuid>`, kind=command) and Pods with explicit CPU.
  const object = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : null);
  const gateJob = (cpu: Record<string, unknown>, status: Record<string, unknown> = { active: 1 }, extra: Record<string, unknown> = {}) => ({
    metadata: { name: 'gate-shard', labels: { 'elanous.substrate': 'pod', 'elanous.kind': 'command' } },
    spec: { template: { spec: { containers: [{ resources: cpu }], ...extra } } }, status,
  });
  const cpuPod = (name: string, resources: Record<string, unknown>, labels: Record<string, string>, extra: { namespace?: string; nodeName?: string | null; phase?: string } = {}) => ({
    metadata: { namespace: extra.namespace ?? 'elanous-test', name, labels },
    status: { phase: extra.phase ?? 'Running' },
    spec: { ...(extra.nodeName === null ? {} : { nodeName: extra.nodeName ?? 'node-1' }), containers: [{ resources: { ...resources, limits: { memory: '2Gi', ...(object(resources.limits) ?? {}) }, requests: { memory: '1Gi', ...(object(resources.requests) ?? {}) } } }] },
  });
  const gatePodOf = (cpu: string, nodeName: string | null = 'node-1') => cpuPod('gate-pod', { requests: { cpu } }, { 'elanous.job': 'gate-shard', 'elanous.kind': 'command' }, { nodeName, ...(nodeName === null ? { phase: 'Pending' } : {}) });
  const harnessLabels = { 'elanous.substrate': 'pod', 'elanous.job': 'harness-job' };
  const nodesOf = (cpus: string[]) => JSON.stringify({ items: cpus.map((cpu, i) => ({ metadata: { name: i === 0 ? 'node-1' : `node-${i + 1}` }, status: { allocatable: { memory: '128Gi', cpu }, conditions: [{ type: 'Ready', status: 'True' }] } })) });
  const gateMember = (jobs: unknown[], pods: unknown[], cpus: string[] = ['4']) => measurePoolLease(parsePodPool('node-b:4'), { kubectl: (args) => {
    if (args.includes('nodes')) return { status: 0, stdout: nodesOf(cpus), stderr: '' };
    if (args.includes('jobs')) return { status: 0, stdout: JSON.stringify({ items: jobs }), stderr: '' };
    return { status: 0, stdout: JSON.stringify({ items: pods }), stderr: '' };
  }, dns: () => 'ready' }).members[0]!;
  const slots = (member: ReturnType<typeof gateMember>) => harnessCpuSlotsBesideGate({ members: [member] });

  test('GATE-RESERVE-AUTO: a bound gate Pod takes its CPU on its node and is not a harness Pod slot', () => {
    const member = gateMember([gateJob({ requests: { cpu: '2' } })], [gatePodOf('2')]);
    expect(member).toMatchObject({ running: 0, gateJobs: 1, gateUnboundJobs: 0, gateCpuMillicores: 2000, schedulableCpuMillicores: 4000, cpuFreeByNodeMillicores: [2000], pendingHarnessCpuMillicores: 0 });
    expect(recommendConcurrency({ members: [member] }, { capacity: 4, accounts: 0, perAccount: 0 }).recommended).toBe(4);
    expect(slots(member)).toBe(2);
    // No gate Job: normal admission (no CPU bound at all).
    expect(slots(gateMember([], [cpuPod('h', { requests: { cpu: '3' } }, harnessLabels)]))).toBeUndefined();
  });

  test('GATE-RESERVE-AUTO: a gate shard waiting for a node gets the CPU first — no harness admission until it is bound, then the rest', () => {
    // Two 2-core nodes, a 2-core shard: summing free CPU would admit two 1-core harness Pods, and the scheduler can put
    // one on each node so the shard stays Pending. While the shard is unbound nothing is admitted.
    for (const pods of [[], [gatePodOf('2', null)]]) {
      const member = gateMember([gateJob({ requests: { cpu: '2' } })], pods, ['2', '2']);
      expect(member).toMatchObject({ gateJobs: 1, gateUnboundJobs: 1 });
      expect(slots(member)).toBe(0);
    }
    expect(slots(gateMember([gateJob({ requests: { cpu: '2' } })], [gatePodOf('2', 'node-2')], ['2', '2']))).toBe(2);
  });

  test('GATE-RESERVE-AUTO: CPU is counted per node — half-free cores on two nodes are not one slot', () => {
    const member = gateMember([gateJob({ requests: { cpu: '500m' } })], [gatePodOf('500m'), cpuPod('other', { requests: { cpu: '500m' } }, {}, { namespace: 'other', nodeName: 'node-2' })], ['2', '2']);
    expect(member.cpuFreeByNodeMillicores).toEqual([1500, 1500]);
    expect(slots(member)).toBe(2);   // Σ⌊1.5⌋ — not ⌊3⌋
  });

  test('GATE-RESERVE-AUTO: gate CPU counts init containers and overhead before its Pod exists, and ends when the Job is terminal', () => {
    const job = (status: Record<string, unknown>) => gateJob({ requests: { cpu: '500m' } }, status, { initContainers: [{ resources: { requests: { cpu: '2' } } }], overhead: { cpu: '250m' } });
    expect(gateMember([job({ failed: 1, active: 1 })], [])).toMatchObject({ gateJobs: 1, gateCpuMillicores: 2250 });
    for (const terminal of [{ failed: 1, conditions: [{ type: 'Failed', status: 'True' }] }, { succeeded: 1 }, { conditions: [{ type: 'Complete', status: 'True' }] }]) {
      const member = gateMember([job(terminal)], []);
      expect(member).toMatchObject({ gateJobs: 0, gateCpuMillicores: 0 });
      expect(slots(member)).toBeUndefined();
    }
  });

  test('GATE-RESERVE-AUTO: a container without a CPU request reserves its CPU limit, or nothing — the reading stays measurable', () => {
    const pods = [
      gatePodOf('1'),
      cpuPod('limit-only', { limits: { cpu: '1500m' } }, {}, { namespace: 'other' }),
      cpuPod('no-cpu', {}, {}, { namespace: 'other' }),
      cpuPod('harness', { requests: { cpu: '1' } }, harnessLabels),
    ];
    const member = gateMember([gateJob({ requests: { cpu: '1' } })], pods, ['8']);
    // 8 − gate 1 − 1.5 − 0 − harness 1 = 4.5 cores → 4 more harness Pods at 1 core.
    expect(member.cpuFreeByNodeMillicores).toEqual([4500]);
    expect(slots(member)).toBe(4);
    // A gate Pod without any CPU request is still an active gate, reserving 0 — never «unmeasured».
    const bare = gateMember([gateJob({})], [cpuPod('gate-pod', {}, { 'elanous.job': 'gate-shard' })], ['8']);
    expect(bare).toMatchObject({ gateJobs: 1, gateCpuMillicores: 0, cpuFreeByNodeMillicores: [8000] });
    expect(slots(bare)).toBe(8);
  });

  test('GATE-RESERVE-AUTO: a harness Pod not bound to a node yet already counts its CPU; an unreadable quantity is unmeasured', () => {
    const unbound = cpuPod('waiting', { requests: { cpu: '1' } }, harnessLabels, { phase: 'Pending', nodeName: null });
    const member = gateMember([gateJob({ requests: { cpu: '1' } })], [gatePodOf('1'), unbound]);
    expect(member).toMatchObject({ cpuFreeByNodeMillicores: [3000], pendingHarnessCpuMillicores: 1000 });
    expect(slots(member)).toBe(2);
    const broken = gateMember([gateJob({ requests: { cpu: '1' } })], [gatePodOf('1'), cpuPod('broken', { requests: { cpu: 'lots' } }, {}, { namespace: 'other' })]);
    expect(broken.cpuFreeByNodeMillicores).toBeUndefined();
    expect(slots(broken)).toBeNull();
    // An unreadable gate template request is unmeasured even when its (readable) Pod is already bound.
    const template = gateMember([gateJob({ requests: { cpu: 'lots' } })], [gatePodOf('1')]);
    expect(template).toMatchObject({ gateJobs: 1, gateUnboundJobs: 0, cpuFreeByNodeMillicores: [3000] });
    expect(slots(template)).toBeNull();
  });

  test('DNS probe requires Ready coredns and one successful in-Pod lookup, then deletes the probe', () => {
    for (const [ready, succeeded] of [[0, true], [1, false], [1, true]] as const) {
      const calls: string[][] = [];
      const kubectl: PoolKubectl = (args, input) => {
        calls.push([...args]);
        if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: ready } }), stderr: '' };
        if (args.includes('create')) {
          expect(JSON.parse(input!).spec.containers[0].command).toEqual(['nslookup', 'kubernetes.default.svc.cluster.local']);
          expect(JSON.parse(input!).metadata).toMatchObject({ namespace: 'elanous-test', labels: { 'elanous.probe': 'dns' } });
          return { status: 0, stdout: '', stderr: '' };
        }
        if (args.includes('pods')) return { status: 0, stdout: emptyDnsProbeList, stderr: '' };
        if (args.includes('get')) return { status: 0, stdout: JSON.stringify({ status: { phase: succeeded ? 'Succeeded' : 'Failed' } }), stderr: '' };
        return { status: args.includes('wait') && !succeeded ? 1 : 0, stdout: args.includes('logs') ? succeeded ? 'Name: kubernetes.default.svc.cluster.local\nAddress: 10.43.0.1' : 'nslookup: no servers could be reached' : '', stderr: '' };
      };
      expect(uncachedProbe('node-b', kubectl)).toBe(ready === 0 || !succeeded ? 'dns' : 'ready');
      expect(calls.some((args) => args.includes('create'))).toBe(ready === 1);
      if (ready === 1) expect(calls.at(-1)).toContain('delete');
      else expect(calls.some((args) => args.includes('delete'))).toBe(false);
      expect(calls.every((args) => args[1] === 'node-b')).toBe(true);
    }
  });
  test('three existing DNS probes prevent a new probe and leave the lease decision unknown', () => {
    const calls: string[][] = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const kubectl: PoolKubectl = (args) => {
      calls.push([...args]);
      if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
      if (args.includes('pods')) {
        expect(args).toEqual(['--context', 'node-b', '--request-timeout=10s', '-n', 'elanous-test', 'get', 'pods', '-l', 'elanous.probe=dns', '-o', 'json']);
        return { status: 0, stdout: JSON.stringify({ items: [1, 2, 3].map((i) => ({ metadata: { name: `elanous-dns-${i}`, namespace: 'elanous-test', labels: { 'elanous.probe': 'dns' } } })) }), stderr: '' };
      }
      throw new Error(`unexpected kubectl call: ${args.join(' ')}`);
    };
    try {
      expect(uncachedProbe('node-b', kubectl)).toBe('unknown');
      expect(calls.filter((args) => args.includes('create'))).toHaveLength(0);
      expect(calls.filter((args) => args.includes('delete'))).toHaveLength(0);
      expect(log).toHaveBeenCalledWith('pod.lease', 'dns-probe-skipped-crowded', { context: 'node-b', existing: 3 });
    } finally { log.mockRestore(); }
  });
  test('only DNS-labeled probes deleting for over 60 seconds are force-reaped', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    const calls: string[][] = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const probes = [
      { name: 'old', age: 90_000, labels: { 'elanous.probe': 'dns' }, namespace: 'elanous-test' },
      { name: 'new', age: 10_000, labels: { 'elanous.probe': 'dns' }, namespace: 'elanous-test' },
      { name: 'harness', age: 90_000, labels: { 'elanous.substrate': 'pod' }, namespace: 'elanous-test' },
      { name: 'foreign', age: 90_000, labels: { 'elanous.probe': 'dns' }, namespace: 'other' },
    ];
    const kubectl: PoolKubectl = (args) => {
      calls.push([...args]);
      if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
      if (args.includes('pods')) return { status: 0, stdout: JSON.stringify({ items: probes.map((p) => ({ metadata: { name: p.name, namespace: p.namespace, labels: p.labels, deletionTimestamp: new Date(now - p.age).toISOString() } })) }), stderr: '' };
      if (args.includes('get')) return { status: 0, stdout: JSON.stringify({ status: { phase: 'Succeeded' } }), stderr: '' };
      return { status: 0, stdout: args.includes('logs') ? 'Name: kubernetes.default.svc.cluster.local\nAddress: 10.43.0.1' : '', stderr: '' };
    };
    const dir = mkdtempSync(join(tmpdir(), 'dns-reap-'));
    try {
      expect(probePoolDns('node-b', kubectl, { dir, now: () => now })).toBe('ready');
      const forced = calls.filter((args) => args.includes('--force'));
      expect(forced).toHaveLength(1);
      expect(forced[0]).toEqual(['--context', 'node-b', '--request-timeout=10s', '-n', 'elanous-test', 'delete', 'pods', '-l', 'elanous.probe=dns', '--field-selector=metadata.name=old', '--grace-period=0', '--force', '--ignore-not-found=true', '--wait=false']);
      expect(calls.filter((args) => args.includes('delete'))).toHaveLength(2);
      expect(log).toHaveBeenCalledWith('pod.lease', 'dns-probe-stale-reaped', { context: 'node-b', count: 1 });
    } finally { log.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
  test('finished DNS probes do not crowd the node and are removed', () => {
    const calls: string[][] = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    // node-b 10-09 22:1x: 20 Completed leftovers ⊕ 2 live probes — the node is not crowded.
    const listed = [
      ...Array.from({ length: 20 }, (_, i) => ({ metadata: { name: `done-${i}`, namespace: 'elanous-test', labels: { 'elanous.probe': 'dns' } }, status: { phase: 'Succeeded' } })),
      { metadata: { name: 'live-1', namespace: 'elanous-test', labels: { 'elanous.probe': 'dns' } }, status: { phase: 'Running' } },
      { metadata: { name: 'live-2', namespace: 'elanous-test', labels: { 'elanous.probe': 'dns' } }, status: { phase: 'Pending' } },
    ];
    const kubectl: PoolKubectl = (args) => {
      calls.push([...args]);
      if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
      if (args.includes('pods') && args.includes('get')) return { status: 0, stdout: JSON.stringify({ items: listed }), stderr: '' };
      if (args.includes('get')) return { status: 0, stdout: JSON.stringify({ status: { phase: 'Succeeded' } }), stderr: '' };
      return { status: 0, stdout: args.includes('logs') ? 'Name: kubernetes.default.svc.cluster.local\nAddress: 10.43.0.1' : '', stderr: '' };
    };
    const dir = mkdtempSync(join(tmpdir(), 'dns-finished-'));
    try {
      expect(probePoolDns('node-b', kubectl, { dir })).toBe('ready');
      expect(calls.filter((args) => args.includes('create'))).toHaveLength(1);
      const finishedDeletes = calls.filter((args) => args.includes('delete') && args.some((a) => a.startsWith('--field-selector=metadata.name=done-')));
      expect(finishedDeletes).toHaveLength(20);
      expect(finishedDeletes.every((args) => !args.includes('--force'))).toBe(true);
      expect(log).toHaveBeenCalledWith('pod.lease', 'dns-probe-finished-reaped', { context: 'node-b', count: 20 });
      expect(log).not.toHaveBeenCalledWith('pod.lease', 'dns-probe-skipped-crowded', expect.anything());
    } finally { log.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
  test('unreadable DNS probe list fails closed without creating or deleting Pods', () => {
    const calls: string[][] = [];
    const kubectl: PoolKubectl = (args) => {
      calls.push([...args]);
      return args.includes('deployment')
        ? { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' }
        : { status: 1, stdout: '', stderr: 'forbidden' };
    };
    expect(uncachedProbe('node-b', kubectl)).toBe('unknown');
    expect(calls.filter((args) => args.includes('create') || args.includes('delete'))).toHaveLength(0);
  });
  test('both Job manifests share a 30-minute finished TTL without changing retry or active deadline', () => {
    const harness = podJobManifest({ name: 'si-task-example', namespace: 'elanous-test', image: 'image', repoUrl: 'repo', args: [], passEnv: [], deadlineSeconds: 123 });
    const command = podCommandJobManifest({ name: 'cmd-example', namespace: 'elanous-test', image: 'image', repoUrl: 'repo', command: ['true'], skills: [], deadlineSeconds: 456 });
    expect(harness.spec).toMatchObject({ ttlSecondsAfterFinished: 1800, backoffLimit: 0, activeDeadlineSeconds: 123 });
    expect(command.spec).toMatchObject({ ttlSecondsAfterFinished: 1800, backoffLimit: 0, activeDeadlineSeconds: 456 });
  });
  test('a successful member lookup is cached for ten minutes, not shared with another member, and expires', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dns-cache-'));
    let at = 1000, creates = 0, lists = 0;
    const kubectl: PoolKubectl = (args) => {
      if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
      if (args.includes('create')) creates++;
      if (args.includes('pods')) { lists++; return { status: 0, stdout: emptyDnsProbeList, stderr: '' }; }
      return { status: 0, stdout: args.includes('get') ? JSON.stringify({ status: { phase: 'Succeeded' } }) : args.includes('logs') ? 'Name: kubernetes.default.svc.cluster.local\nAddress: 10.43.0.1' : '', stderr: '' };
    };
    try {
      const read = (context: string) => probePoolDns(context, kubectl, { dir, now: () => at });
      expect(read('node-b')).toBe('ready');
      at += 599_999;
      expect(read('node-b')).toBe('ready');
      expect(creates).toBe(1);
      expect(lists).toBe(1);
      expect(read('other')).toBe('ready');
      expect(creates).toBe(2);
      at++;
      expect(read('node-b')).toBe('ready');
      expect(creates).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('DNS-PROBE-STALE-OK: a failed probe uses a 20-minute ready without refreshing its cache, but a 40-minute ready is unknown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dns-stale-ready-'));
    const cache = join(dir, `dns-${createHash('sha256').update('node-b').digest('hex')}.cache`);
    const now = Date.parse('2026-10-09T12:00:00Z');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let creates = 0;
    const kubectl: PoolKubectl = (args) => {
      if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
      if (args.includes('pods')) return { status: 0, stdout: emptyDnsProbeList, stderr: '' };
      if (args.includes('create')) { creates++; return { status: 1, stdout: '', stderr: 'create failed' }; }
      throw new Error(`unexpected kubectl call: ${args.join(' ')}`);
    };
    try {
      const ready20 = JSON.stringify({ result: 'ready', at: now - 20 * 60_000, generation: 'original' });
      writeFileSync(cache, ready20);
      expect(probePoolDns('node-b', kubectl, { dir, now: () => now })).toBe('ready');
      expect(readFileSync(cache, 'utf8')).toBe(ready20);
      expect(log).toHaveBeenCalledWith('pod.lease', 'dns-probe-stale-ready', { context: 'node-b', readyAgeMs: 20 * 60_000 });
      expect(probePoolDns('node-b', kubectl, { dir, now: () => now })).toBe('ready');
      expect(creates).toBe(2); // The stale answer never prevents another measurement.
      const ready30 = JSON.stringify({ result: 'ready', at: now - 30 * 60_000, generation: 'original' });
      writeFileSync(cache, ready30);
      expect(probePoolDns('node-b', kubectl, { dir, now: () => now })).toBe('unknown');
      expect(readFileSync(cache, 'utf8')).toBe(ready30);
      const ready40 = JSON.stringify({ result: 'ready', at: now - 40 * 60_000, generation: 'original' });
      writeFileSync(cache, ready40);
      log.mockClear();
      expect(probePoolDns('node-b', kubectl, { dir, now: () => now })).toBe('unknown');
      expect(readFileSync(cache, 'utf8')).toBe(ready40);
      expect(log).not.toHaveBeenCalledWith('pod.lease', 'dns-probe-stale-ready', expect.anything());
      expect(creates).toBe(4);
      rmSync(cache);
      expect(probePoolDns('node-b', kubectl, { dir, now: () => now })).toBe('unknown');
      expect(creates).toBe(5);
    } finally { log.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
  test('DNS-PROBE-STALE-OK: a 15-minute ready cannot override confirmed dns or image failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dns-stale-failure-'));
    const cache = join(dir, `dns-${createHash('sha256').update('node-b').digest('hex')}.cache`);
    const now = Date.parse('2026-10-09T12:00:00Z');
    const ready15 = JSON.stringify({ result: 'ready', at: now - 15 * 60_000, generation: 'original' });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let readyReplicas = 0;
    const kubectl: PoolKubectl = (args) => {
      if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas } }), stderr: '' };
      if (args.includes('pods')) return { status: 0, stdout: emptyDnsProbeList, stderr: '' };
      if (args.includes('get')) return { status: 0, stdout: JSON.stringify({ status: { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }] } }), stderr: '' };
      return { status: args.includes('wait') ? 1 : 0, stdout: '', stderr: '' };
    };
    try {
      writeFileSync(cache, ready15);
      expect(probePoolDns('node-b', kubectl, { dir, now: () => now })).toBe('dns');
      expect(readFileSync(cache, 'utf8')).toBe(ready15);
      readyReplicas = 1;
      expect(probePoolDns('node-b', kubectl, { dir, now: () => now })).toBe('image');
      expect(readFileSync(cache, 'utf8')).toBe(ready15);
      expect(log).not.toHaveBeenCalledWith('pod.lease', 'dns-probe-stale-ready', expect.anything());
    } finally { log.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
  test('DNS failures and unknown readings are never cached', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dns-failure-'));
    let creates = 0;
    const cache = join(dir, `dns-${createHash('sha256').update('node-b').digest('hex')}.cache`);
    const kubectl: PoolKubectl = (args) => {
      if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
      if (args.includes('create')) creates++;
      if (args.includes('pods')) return { status: 0, stdout: emptyDnsProbeList, stderr: '' };
      if (args.includes('get')) return { status: 0, stdout: JSON.stringify({ status: { phase: 'Failed' } }), stderr: '' };
      return { status: 0, stdout: args.includes('logs') ? 'nslookup: no servers could be reached' : '', stderr: '' };
    };
    try {
      expect(probePoolDns('node-b', kubectl, { dir })).toBe('dns');
      expect(existsSync(cache)).toBe(false);
      expect(probePoolDns('node-b', kubectl, { dir })).toBe('dns');
      expect(existsSync(cache)).toBe(false);
      expect(creates).toBe(2);
      expect(probePoolDns('other', () => ({ status: 1, stdout: '', stderr: '' }), { dir })).toBe('unknown');
      expect(probePoolDns('other', kubectl, { dir })).toBe('dns');
      expect(creates).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('concurrent CLI processes measure one member only once under a host lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dns-parallel-'));
    const bin = join(dir, 'kubectl');
    const calls = join(dir, 'creates');
    writeFileSync(bin, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('deployment')) console.log(JSON.stringify({spec:{replicas:1},status:{readyReplicas:1}}));
else if (args.includes('create')) { appendFileSync(process.env.DNS_CALLS, 'create\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600); }
else if (args.includes('pods')) console.log(JSON.stringify({items:[]}));
else if (args.includes('get')) console.log(JSON.stringify({status:{phase:'Succeeded'}}));
else if (args.includes('logs')) console.log('Name: kubernetes.default.svc.cluster.local\\nAddress: 10.43.0.1');
`);
    chmodSync(bin, 0o755);
    const entry = resolve(import.meta.dir, 'pod-lease.ts');
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, DNS_CALLS: calls };
    const command = ['bun', '-e', `import { probePoolDns } from ${JSON.stringify(entry)}; console.log(probePoolDns('node-b', undefined, {dir:${JSON.stringify(dir)}}))`];
    try {
      const children = Array.from({ length: 4 }, () => Bun.spawn(command, { env, stdout: 'pipe', stderr: 'pipe' }));
      const outputs = await Promise.all(children.map(async (child) => ({ code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() })));
      expect(outputs).toEqual(Array.from({ length: 4 }, () => ({ code: 0, stdout: 'ready\n', stderr: '' })));
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['create']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('concurrent DNS failures share one probe, but the next call retries instead of caching failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dns-failure-parallel-'));
    const calls = join(dir, 'creates');
    const ready = join(dir, 'waiters');
    const entry = resolve(import.meta.dir, 'pod-lease.ts');
    const script = `
      import { appendFileSync, readFileSync } from 'node:fs';
      import { probePoolDns } from ${JSON.stringify(entry)};
      if (process.env.DNS_WAITER === '1') appendFileSync(${JSON.stringify(ready)}, 'ready\\n');
      const kubectl = (args) => {
        if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
        if (args.includes('create')) {
          appendFileSync(${JSON.stringify(calls)}, 'create\\n');
          if (process.env.DNS_HOLDER === '1') {
            const end = Date.now() + 10_000;
            while (Date.now() < end) {
              try { if (readFileSync(${JSON.stringify(ready)}, 'utf8').split('ready').length - 1 === 3) break; } catch {}
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
          }
        }
        return { status: 0, stdout: args.includes('pods') ? JSON.stringify({ items: [] }) : args.includes('get') ? JSON.stringify({ status: { phase: 'Failed' } }) : args.includes('logs') ? 'nslookup: no servers could be reached' : '', stderr: '' };
      };
      console.log(probePoolDns('node-b', kubectl, { dir: ${JSON.stringify(dir)} }));
    `;
    const command = ['bun', '-e', script];
    const env = { ...process.env };
    const children: Array<ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>> = [];
    try {
      children.push(Bun.spawn(command, { env: { ...env, DNS_HOLDER: '1' }, stdout: 'pipe', stderr: 'pipe' }));
      const deadline = Date.now() + 10_000;
      while (!existsSync(calls) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(calls)).toBe(true);
      for (let i = 0; i < 3; i++) children.push(Bun.spawn(command, { env: { ...env, DNS_WAITER: '1' }, stdout: 'pipe', stderr: 'pipe' }));
      const outputs = await Promise.all(children.map(async (child) => ({ code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() })));
      expect(outputs).toEqual(Array.from({ length: 4 }, () => ({ code: 0, stdout: 'dns\n', stderr: '' })));
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['create']);
      const retry = spawnSync('bun', ['-e', script], { env, encoding: 'utf8', timeout: 10_000 });
      expect(retry.status).toBe(0);
      expect(retry.stdout.trim()).toBe('dns');
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['create', 'create']);
    } finally {
      for (const child of children) { child.kill(); await child.exited; }
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('DNS-PROBE-STALE-OK: waiters sharing an unknown outcome use stale ready and still retry on a later call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dns-stale-parallel-'));
    const cache = join(dir, `dns-${createHash('sha256').update('node-b').digest('hex')}.cache`);
    const calls = join(dir, 'creates');
    const waiters = join(dir, 'waiters');
    const entry = resolve(import.meta.dir, 'pod-lease.ts');
    const original = JSON.stringify({ result: 'ready', at: Date.now() - 20 * 60_000, generation: 'original' });
    writeFileSync(cache, original);
    const script = `
      import { appendFileSync, readFileSync } from 'node:fs';
      import { probePoolDns } from ${JSON.stringify(entry)};
      if (process.env.DNS_WAITER === '1') appendFileSync(${JSON.stringify(waiters)}, 'ready\\n');
      const kubectl = (args) => {
        if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
        if (args.includes('pods')) return { status: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
        if (args.includes('create')) {
          appendFileSync(${JSON.stringify(calls)}, 'create\\n');
          if (process.env.DNS_HOLDER === '1') {
            const end = Date.now() + 10_000;
            while (Date.now() < end) {
              try { if (readFileSync(${JSON.stringify(waiters)}, 'utf8').split('ready').length - 1 === 3) break; } catch {}
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
          }
          return { status: 1, stdout: '', stderr: 'create failed' };
        }
        throw new Error('unexpected kubectl call');
      };
      console.log(probePoolDns('node-b', kubectl, { dir: ${JSON.stringify(dir)} }));
    `;
    const command = ['bun', '-e', script];
    const env = { ...process.env };
    const children: Array<ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>> = [];
    try {
      children.push(Bun.spawn(command, { env: { ...env, DNS_HOLDER: '1' }, stdout: 'pipe', stderr: 'pipe' }));
      const deadline = Date.now() + 10_000;
      while (!existsSync(calls) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(calls)).toBe(true);
      for (let i = 0; i < 3; i++) children.push(Bun.spawn(command, { env: { ...env, DNS_WAITER: '1' }, stdout: 'pipe', stderr: 'pipe' }));
      const outputs = await Promise.all(children.map(async (child) => ({ code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() })));
      expect(outputs).toEqual(Array.from({ length: 4 }, () => ({ code: 0, stdout: 'ready\n', stderr: '' })));
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['create']);
      expect(readFileSync(cache, 'utf8')).toBe(original);
      const retry = spawnSync('bun', ['-e', script], { env, encoding: 'utf8', timeout: 10_000 });
      expect(retry.status).toBe(0);
      expect(retry.stdout.trim()).toBe('ready');
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['create', 'create']);
    } finally {
      for (const child of children) { child.kill(); await child.exited; }
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('a process killed while holding the DNS flock before a cache write releases it for the next process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dns-crash-'));
    const key = createHash('sha256').update('node-b').digest('hex');
    const cache = join(dir, `dns-${key}.cache`);
    const lock = join(dir, `dns-${key}.flock`);
    const calls = join(dir, 'creates');
    const entry = resolve(import.meta.dir, 'pod-lease.ts');
    const script = `
      import { appendFileSync } from 'node:fs';
      import { probePoolDns } from ${JSON.stringify(entry)};
      const kubectl = (args) => {
        if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
        if (args.includes('create')) {
          appendFileSync(${JSON.stringify(calls)}, 'create\\n');
          if (process.env.DNS_HOLD === '1') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 360_000);
        }
        return { status: 0, stdout: args.includes('pods') ? JSON.stringify({ items: [] }) : args.includes('get') ? JSON.stringify({ status: { phase: 'Succeeded' } }) : args.includes('logs') ? 'Name: kubernetes.default.svc.cluster.local\\nAddress: 10.43.0.1' : '', stderr: '' };
      };
      console.log(probePoolDns('node-b', kubectl, { dir: ${JSON.stringify(dir)} }));
    `;
    const command = ['bun', '-e', script];
    const holder = Bun.spawn(command, { env: { ...process.env, DNS_HOLD: '1' }, stdout: 'pipe', stderr: 'pipe' });
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(calls) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(calls)).toBe(true);
      expect(existsSync(lock)).toBe(true);
      expect(existsSync(cache)).toBe(false);
      const contender = spawnSync('bun', ['-e', `
        import { openSync, closeSync } from 'node:fs';
        import { dlopen } from 'bun:ffi';
        const fd = openSync(${JSON.stringify(lock)}, 'a');
        const flock = dlopen(process.platform === 'linux' ? 'libc.so.6' : 'libSystem.B.dylib', {
          flock: { args: ['int', 'int'], returns: 'int' },
        }).symbols.flock;
        const held = flock(fd, 1 | 4) !== 0;
        if (!held) flock(fd, 8);
        closeSync(fd);
        process.exit(held ? 0 : 1);
      `], { encoding: 'utf8', timeout: 5_000 });
      expect(contender.status).toBe(0);
      holder.kill('SIGKILL');
      await holder.exited;
      expect(existsSync(cache)).toBe(false);
      const start = Date.now();
      const next = spawnSync('bun', ['-e', script], { env: { ...process.env, DNS_HOLD: '0' }, encoding: 'utf8', timeout: 5_000 });
      expect(next.status).toBe(0);
      expect(next.stdout.trim()).toBe('ready');
      expect(Date.now() - start).toBeLessThan(5_000);
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['create', 'create']);
      expect(existsSync(cache)).toBe(true);
    } finally {
      holder.kill('SIGKILL');
      await holder.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('one member DNS failure contributes zero slots, reason dns; healthy peer remains eligible', () => {
    const kubectl: PoolKubectl = (args) => ({ status: 0, stdout: args.includes('nodes') ? node('64Gi') : JSON.stringify({ items: [] }), stderr: '' });
    const measure = measurePoolLease(parsePodPool('bad:2,good:2'), { kubectl, dns: (context) => context === 'good' ? 'ready' : 'dns' });
    expect(measure.members.map((m) => [m.context, m.capacity, m.reason])).toEqual([['bad', 0, 'dns'], ['good', 2, null]]);
    expect(recommendConcurrency(measure, { capacity: 4, accounts: 1, perAccount: 4 })).toMatchObject({ recommended: 2, capacitySlots: 2, memorySlots: 4, reason: 'dns' });
  });
  test('DNS probe rejects a succeeded Pod without evidence of the requested DNS answer', () => {
    const kubectl: PoolKubectl = (args) => args.includes('deployment')
      ? { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' }
      : { status: 0, stdout: args.includes('pods') ? emptyDnsProbeList : args.includes('get') ? JSON.stringify({ status: { phase: 'Succeeded' } }) : args.includes('logs') ? 'Name: another.service\nAddress: 10.43.0.1' : '', stderr: '' };
    expect(uncachedProbe('node-b', kubectl)).toBe('dns');
  });
  test('부하 노드: wait 시간 초과 · phase Running 이어도 로그에 답이 찍혔으면 ready(10-09 node-b load 78)', () => {
    const kubectl: PoolKubectl = (args) => {
      if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
      if (args.includes('wait')) return { status: 1, stdout: '', stderr: 'timed out waiting for the condition' };
      if (args.includes('pods')) return { status: 0, stdout: emptyDnsProbeList, stderr: '' };
      if (args.includes('get')) return { status: 0, stdout: JSON.stringify({ status: { phase: 'Running' } }), stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: 'Server:\t10.43.0.10\n\nName:\tkubernetes.default.svc.cluster.local\nAddress: 10.43.0.1\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(uncachedProbe('node-b', kubectl)).toBe('ready');
  });
  test('Running 이고 로그에 답이 아직 없으면 지금처럼 unknown(추측해서 ready 로 올리지 않는다)', () => {
    const kubectl: PoolKubectl = (args) => {
      if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
      if (args.includes('wait')) return { status: 1, stdout: '', stderr: 'timed out' };
      if (args.includes('pods')) return { status: 0, stdout: emptyDnsProbeList, stderr: '' };
      if (args.includes('get')) return { status: 0, stdout: JSON.stringify({ status: { phase: 'Running' } }), stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: 'Server:\t10.43.0.10\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(uncachedProbe('node-b', kubectl)).toBe('unknown');
  });
  test('image pull failure is not classified as DNS failure or a measured zero slot', () => {
    const kubectl: PoolKubectl = (args) => {
      if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
      if (args.includes('pods')) return { status: 0, stdout: emptyDnsProbeList, stderr: '' };
      if (args.includes('get')) return { status: 0, stdout: JSON.stringify({ status: { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }] } }), stderr: '' };
      return { status: args.includes('wait') ? 1 : 0, stdout: '', stderr: '' };
    };
    expect(uncachedProbe('node-b', kubectl)).toBe('image');
    const leaseKubectl: PoolKubectl = (args) => ({ status: 0, stdout: args.includes('nodes') ? node('64Gi') : JSON.stringify({ items: [] }), stderr: '' });
    const member = measurePoolLease(parsePodPool('node-b:2'), { kubectl: leaseKubectl, dns: (context) => uncachedProbe(context, kubectl) }).members[0]!;
    expect(member).toMatchObject({ capacity: 2, availableMemoryByNodeBytes: null, reason: '측정 불가: dns probe image' });
    expect(recommendConcurrency({ members: [member] }, { capacity: 2, accounts: 1, perAccount: 4 }).recommended).toBeNull();
  });
  test('pool recommended is the sum of per-member free slots: an over-cap member cannot zero another member', () => {
    const member = (context: string, capacity: number, running: number, unleasedRunning = 0): PoolLeaseMeasure['members'][number] => ({
      context, capacity, running, pending: 0, unleasedRunning, memoryLimitBytes: 0, allocatableMemoryBytes: 256 * gi,
      allocatableCpuMillicores: 32_000, availableMemoryByNodeBytes: [256 * gi], reason: null,
    } as PoolLeaseMeasure['members'][number]);
    // node-b runs 21 on a cap of 20 (one leftover Pod) · node-c is idle with cap 1 → one free slot pool-wide.
    expect(recommendConcurrency({ members: [member('node-b', 20, 21), member('node-c', 1, 0)] }, { capacity: 21, accounts: 1, perAccount: 4 }))
      .toMatchObject({ recommended: 1, capacitySlots: 1 });
    // The over-cap member's unleased Pods only consume its own (zero) free slots.
    expect(recommendConcurrency({ members: [member('node-b', 20, 21, 21), member('node-c', 1, 0)] }, { capacity: 21, accounts: 1, perAccount: 4 }).recommended).toBe(1);
    expect(recommendConcurrency({ members: [member('node-b', 20, 18), member('node-c', 1, 0)] }, { capacity: 21, accounts: 1, perAccount: 4 }).recommended).toBe(3);
  });
  test('DNS-broken member occupancy cannot consume healthy member capacity', () => {
    const kubectl: PoolKubectl = (args) => ({ status: 0, stdout: args.includes('nodes') ? node('64Gi') : args.includes('jobs') ? JSON.stringify({ items: [{ metadata: { name: 'harness-job', labels: { 'elanous.substrate': 'pod' } } }] }) : JSON.stringify({ items: args[1] === 'bad' ? [pod('Running')] : [] }), stderr: '' });
    const measure = measurePoolLease(parsePodPool('bad:2,good:2'), { kubectl, dns: (context) => context === 'good' ? 'ready' : 'dns' });
    expect(measure.members[0]).toMatchObject({ running: 1, unleasedRunning: 1, reason: 'dns' });
    expect(recommendConcurrency(measure, { capacity: 4, accounts: 1, perAccount: 4 })).toMatchObject({ recommended: 2, capacitySlots: 2, unleasedRunning: 1, reason: 'dns' });
  });
  test('20 slots, 10 Running (6×16Gi + 4×32Gi): memory allows one 16Gi goal', () => {
    const pods = [...Array.from({ length: 6 }, () => pod('Running')), ...Array.from({ length: 4 }, () => pod('Running', '32Gi'))];
    const measuredPool = measured(pods);
    expect(measuredPool.members[0]).toMatchObject({ capacity: 20, running: 10, pending: 0, memoryLimitBytes: 224 * gi, allocatableCpuMillicores: 32_000 });
    expect(recommendConcurrency(measuredPool, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 1, limitedBy: 'memory', capacitySlots: 10, memorySlots: 1, accountSlots: 30 });
    // POD7: the same headroom counted in lite (2Gi / 1Gi) goals is reported separately; recommended stays on the standard size.
    const headroom = measuredPool.members[0]!.allocatableMemoryBytes! - measuredPool.members[0]!.memoryLimitBytes!;
    expect(recommendConcurrency(measuredPool, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 1, liteMemorySlots: Math.floor(headroom / (2 * gi)) });
    expect(recommendConcurrency(measuredPool, { capacity: 20, accounts: 10, perAccount: 4, liteGoalMemory: '1Gi' }).liteMemorySlots).toBe(Math.floor(headroom / gi));
  });
  test('18 Running with plenty of memory: capacity allows two', () => {
    expect(recommend(Array.from({ length: 18 }, () => pod('Running', '1Gi')), 10, node('1024Gi'))).toMatchObject({ recommended: 2, limitedBy: 'capacity' });
  });
  test('Pending occupies capacity; negative slot budgets clamp to zero', () => {
    expect(recommend([pod('Running'), pod('Pending')], 10, node('1024Gi'))).toMatchObject({ running: 1, pending: 1, capacitySlots: 18, recommended: 18, limitedBy: 'capacity' });
    expect(recommend(Array.from({ length: 22 }, () => pod('Running')), 10, node('1024Gi'))).toMatchObject({ capacitySlots: 0, recommended: 0, limitedBy: 'capacity' });
  });
  test('accounts are observed only, never a bound (10-03 decision): zero accounts still recommend by slots and memory', () => {
    expect(recommend([], 0, node('1024Gi'))).toMatchObject({ recommended: 20, limitedBy: 'capacity', accountSlots: 0 });
    expect(recommend(Array.from({ length: 20 }, () => pod('Running')), 0, node('1024Gi'))).toMatchObject({ recommended: 0, limitedBy: 'capacity' });
  });
  test('configured per-goal memory and per-account slots are applied without usage percentages', () => {
    expect(recommendConcurrency(measured([pod('Running')], node('64Gi')), { capacity: 20, accounts: 1, perAccount: 2, perGoalMemory: '32Gi' })).toMatchObject({ memorySlots: 1, accountSlots: 1, recommended: 1 });
  });
  test('unreachable context is unknown, never zero', () => {
    const measure = measurePoolLease(parsePodPool('node-b:20'), { kubectl: () => ({ status: 1, stdout: '', stderr: 'connection refused' }) });
    expect(measure.members[0]).toMatchObject({ running: null, pending: null, allocatableMemoryBytes: null, reason: expect.stringContaining('connection refused') });
    expect(recommendConcurrency(measure, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null, limitedBy: null, reason: expect.stringContaining('측정 불가: cluster') });
  });
  test('host lease admission annotation persists on a Job while its file lease awaits Pod observation', () => {
    const options = { name: 'leased-job', namespace: 'elanous-test', image: 'image', repoUrl: 'repo', args: [], passEnv: [], deadlineSeconds: 60 };
    const leased = podJobManifest({ ...options, hostLeaseAdmitted: true, execution: { key: 'key', attempt: 2 } });
    expect(leased.metadata).toMatchObject({ annotations: { [POD_HOST_LEASE_ANNOTATION]: 'true', 'elanous.dev/attempt': '2' } });
    expect(podJobManifest(options).metadata).not.toHaveProperty('annotations');
  });
  test('two unleased Running legacy Jobs consume two more recommendations; Pending and leased Jobs do not', () => {
    const legacy = [0, 1].map((i) => ({ ...pod('Running', '1Gi'), metadata: { namespace: 'elanous-test', name: `legacy-${i}`, labels: { 'elanous.job': `legacy-job-${i}` } } }));
    const leased = { ...pod('Running', '1Gi'), metadata: { namespace: 'elanous-test', name: 'leased', labels: { 'elanous.job': 'leased-job' } } };
    const pending = { ...pod('Pending', '1Gi'), metadata: { namespace: 'elanous-test', name: 'pending', labels: { 'elanous.job': 'legacy-job-0' } } };
    const kubectl: PoolKubectl = (args) => args.includes('jobs')
      ? { status: 0, stderr: '', stdout: JSON.stringify({ items: [
        ...legacy.map((_, i) => ({ metadata: { name: `legacy-job-${i}`, labels: { 'elanous.substrate': 'pod' } } })),
        { metadata: { name: 'leased-job', labels: { 'elanous.substrate': 'pod' }, annotations: { [POD_HOST_LEASE_ANNOTATION]: 'true' } } },
      ] }) }
      : args.includes('pods') ? { status: 0, stderr: '', stdout: JSON.stringify({ items: [...legacy, leased, pending] }) }
        : { status: 0, stderr: '', stdout: node('1024Gi') };
    const m = measurePoolLease(parsePodPool('node-b:20'), { kubectl, dns: () => 'ready' });
    expect(m.members[0]).toMatchObject({ running: 3, pending: 1, pendingJobs: [{ context: 'node-b', namespace: 'elanous-test', job: 'legacy-job-0' }], unleasedRunning: 2, memoryLimitBytes: 3 * gi });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({
        running: 3, pending: 1, pendingJobs: [{ context: 'node-b', namespace: 'elanous-test', job: 'legacy-job-0' }], unleasedRunning: 2, capacitySlots: 16, placeableSlots: 16, recommended: 14, limitedBy: 'capacity',
      });
      expect(log).toHaveBeenCalledWith('pod-lease', 'unleased', { unleasedRunning: 2, running: 3, recommended: 14 });
    } finally { log.mockRestore(); }
  });
  test('a dns-labeled Pod never counts as a goal even with legacy job labels; its node reservation remains real', () => {
    const probe = { ...pod('Running', '1Gi'), metadata: { namespace: 'elanous-test', name: 'elanous-dns-example', labels: { 'elanous.probe': 'dns', 'elanous.substrate': 'pod', 'elanous.job': 'harness-job' } } };
    const result = measured([probe, pod('Running')], node('32Gi'));
    expect(result.members[0]).toMatchObject({ running: 1, pending: 0, unleasedRunning: 0, memoryLimitBytes: 16 * gi, availableMemoryByNodeBytes: [15 * gi] });
    expect(measured([{ ...probe, status: { phase: 'Pending' } }]).members[0]?.pending).toBe(0);
  });
  test('a Pod with a substrate label and no job label is counted', () => {
    const labeled = { ...pod('Running'), metadata: { namespace: 'elanous-test', name: 'labeled', labels: { 'elanous.substrate': 'pod' } } };
    expect(measured([labeled]).members[0]).toMatchObject({ running: 1, memoryLimitBytes: 16 * gi });
  });
  test('finished init container does not add to a Running Pod memory limit', () => {
    const running = { ...pod('Running'), spec: { containers: [{ resources: { limits: { memory: '16Gi' } } }], initContainers: [{ resources: { limits: { memory: '64Gi' } } }] } };
    expect(measured([running]).members[0]?.memoryLimitBytes).toBe(16 * gi);
  });
  test('legacy harness Pod with only elanous.job is counted through the labeled Job', () => {
    const legacy = { ...pod('Running'), metadata: { namespace: 'elanous-test', name: 'legacy', labels: { 'elanous.job': 'harness-job' } } };
    expect(measured([legacy]).members[0]).toMatchObject({ running: 1, memoryLimitBytes: 16 * gi });
  });
  test('unlabeled infrastructure Pod is not counted', () => {
    const result = measured([pod('Running', '64Gi', false), pod('Running', '16Gi'), pod('Pending')]);
    expect(result.members[0]).toMatchObject({ running: 1, pending: 1, memoryLimitBytes: 16 * gi });
  });
  test('each member has its own memory budget; unused capacity on a full cluster cannot be borrowed', () => {
    const members = parsePodPool('node-b:20,other:20');
    const kubectl: PoolKubectl = (args) => args[1] === 'node-b'
      ? fixture(Array.from({ length: 10 }, () => pod('Running', '16Gi')), node('160Gi'))(args)
      : { status: 0, stdout: args.includes('nodes') ? node('16Gi') : JSON.stringify({ items: [] }), stderr: '' };
    const measure = measurePoolLease(members, { kubectl, dns: () => 'ready' });
    expect(recommendConcurrency(measure, { capacity: 40, accounts: 10, perAccount: 4 }).memorySlots).toBe(1);
  });
  test('disjoint capacity and memory across clusters never recommend an unplaceable goal', () => {
    const members = parsePodPool('node-b:2,other:2');
    const kubectl: PoolKubectl = (args) => {
      const first = args[1] === 'node-b';
      if (args.includes('nodes')) return { status: 0, stdout: node(first ? '64Gi' : '31Gi'), stderr: '' };
      if (args.includes('jobs')) return { status: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
      return { status: 0, stdout: JSON.stringify({ items: first ? [pod('Running'), pod('Running')] : [pod('Running')] }), stderr: '' };
    };
    const measure = measurePoolLease(members, { kubectl, dns: () => 'ready' });
    expect(measure.members.map((m) => ({ capacity: m.capacity, running: m.running, freeMemory: m.allocatableMemoryBytes! - m.memoryLimitBytes! })))
      .toEqual([{ capacity: 2, running: 2, freeMemory: 32 * gi }, { capacity: 2, running: 1, freeMemory: 15 * gi }]);
    expect(recommendConcurrency(measure, { capacity: 4, accounts: 10, perAccount: 4 })).toMatchObject({
      capacitySlots: 1, memorySlots: 2, placeableSlots: 0, accountSlots: 37, recommended: 0, limitedBy: 'memory',
    });
  });
  test('an unassigned Pending harness Pod occupies a slot but not a node memory reservation', () => {
    const pending = { ...pod('Pending'), spec: { ...pod('Pending').spec, nodeName: '' } };
    const m = measured([pending], node('16Gi'));
    expect(m.members[0]).toMatchObject({ pending: 1, running: 0, availableMemoryByNodeBytes: [16 * gi] });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 1, capacitySlots: 19, placeableSlots: 1 });
  });
  test('a foreign namespace reservation exhausts memory despite empty harness slots', () => {
    const infrastructure = { ...pod('Running', '16Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} } };
    const m = measured([infrastructure], node('16Gi'));
    expect(m.members[0]).toMatchObject({ running: 0, memoryLimitBytes: 0, availableMemoryByNodeBytes: [0] });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, limitedBy: 'memory' });
  });
  test('a foreign Pod limit without an explicit request reserves memory without counting as harness Running', () => {
    const foreign = { ...pod('Running', '16Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} }, spec: { ...pod('Running').spec, containers: [{ resources: { limits: { memory: '16Gi' } } }] } };
    const m = measured([foreign], node('16Gi'));
    expect(m.members[0]).toMatchObject({ running: 0, memoryLimitBytes: 0, availableMemoryByNodeBytes: [0] });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, limitedBy: 'memory' });
  });
  test('node-local availability reflects the largest init request and Pod overhead without changing Running app limits', () => {
    const running = { ...pod('Running'), spec: { ...pod('Running').spec,
      initContainers: [{ resources: { requests: { memory: '32Gi' } } }], overhead: { memory: '1Gi' } } };
    const m = measured([running], node('48Gi'));
    expect(m.members[0]).toMatchObject({ memoryLimitBytes: 16 * gi, availableMemoryByNodeBytes: [15 * gi] });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, memorySlots: 2, placeableSlots: 0, limitedBy: 'memory' });
  });
  test('a foreign reservation is subtracted once, not once per harness Pod', () => {
    const foreign = { ...pod('Running', '16Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} } };
    const m = measured([foreign, pod('Running')], node('48Gi'));
    expect(m.members[0]).toMatchObject({ running: 1, memoryLimitBytes: 16 * gi, availableMemoryByNodeBytes: [16 * gi] });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 1, placeableSlots: 1, limitedBy: 'memory' });
  });
  test('node-local reservations cannot be pooled between nodes for a 16Gi goal', () => {
    const nodes = JSON.stringify({ items: [
      { metadata: { name: 'node-1' }, status: { allocatable: { memory: '16Gi', cpu: '4' }, conditions: [{ type: 'Ready', status: 'True' }] } },
      { metadata: { name: 'node-2' }, status: { allocatable: { memory: '16Gi', cpu: '4' }, conditions: [{ type: 'Ready', status: 'True' }] } },
    ] });
    const first = { ...pod('Running', '8Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} } };
    const second = { ...first, metadata: { ...first.metadata, name: 'foreign-2' }, spec: { ...first.spec, nodeName: 'node-2' } };
    const m = measured([first, second], nodes);
    expect(m.members[0]?.availableMemoryByNodeBytes).toEqual([8 * gi, 8 * gi]);
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, memorySlots: 2, placeableSlots: 0, limitedBy: 'memory' });
  });
  test('NotReady and cordoned nodes cannot place a goal despite abundant allocatable memory', () => {
    for (const unavailable of [
      { status: { allocatable: { memory: '128Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'False' }] } },
      { status: { allocatable: { memory: '128Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'True' }] }, spec: { unschedulable: true } },
    ]) {
      const nodes = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, ...unavailable }] });
      const m = measured([], nodes);
      expect(m.members[0]).toMatchObject({ allocatableMemoryBytes: 128 * gi, availableMemoryByNodeBytes: [] });
      expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, limitedBy: 'memory', placeableSlots: 0 });
    }
  });
  test('a NoSchedule/NoExecute taint keeps toleration-less harness Jobs off the node; PreferNoSchedule does not', () => {
    for (const effect of ['NoSchedule', 'NoExecute']) {
      const nodes = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '128Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'True' }] }, spec: { taints: [{ key: 'dedicated', value: 'gpu', effect }] } }] });
      const m = measured([], nodes);
      expect(m.members[0]).toMatchObject({ allocatableMemoryBytes: 128 * gi, availableMemoryByNodeBytes: [] });
      expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, placeableSlots: 0 });
    }
    const soft = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '128Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'True' }] }, spec: { taints: [{ key: 'x', effect: 'PreferNoSchedule' }] } }] });
    expect(measured([], soft).members[0]?.availableMemoryByNodeBytes).toEqual([128 * gi]);
  });
  test('a malformed taint list makes node placement unknown', () => {
    const nodes = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '128Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'True' }] }, spec: { taints: [{ key: 'x' }] } }] });
    expect(recommend([], 10, nodes)).toMatchObject({ recommended: null, reason: expect.stringContaining('측정 불가: cluster') });
  });
  test('missing node readiness cannot be interpreted as available memory', () => {
    const nodes = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '128Gi', cpu: '32' } } }] });
    expect(recommend([], 10, nodes)).toMatchObject({ recommended: null, reason: expect.stringContaining('측정 불가: cluster') });
  });
  test('missing or Unknown phase makes the whole measurement unknown, including foreign Pods', () => {
    for (const status of [{}, { phase: 'Unknown' }]) {
      const foreign = { ...pod('Running', '16Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} }, status };
      const m = measured([foreign], node('32Gi'));
      expect(m.members[0]).toMatchObject({ running: null, pending: null, memoryLimitBytes: null, availableMemoryByNodeBytes: null, reason: expect.stringContaining('missing/Unknown phase') });
      expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null, limitedBy: null, reason: expect.stringContaining('측정 불가: cluster') });
    }
  });
  test('duplicate Pod name makes reservations unknown instead of double-counting', () => {
    const duplicate = pod('Running');
    const m = measured([duplicate, duplicate], node('48Gi'));
    expect(m.members[0]?.availableMemoryByNodeBytes).toBeNull();
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null });
  });
  test('a foreign Pod with invalid reservation cannot turn missing data into free space', () => {
    const foreign = { ...pod('Running', 'bad', false), metadata: { namespace: 'system', name: 'foreign', labels: {} } };
    const m = measured([foreign], node('16Gi'));
    expect(m.members[0]?.availableMemoryByNodeBytes).toBeNull();
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null, limitedBy: null });
  });
  test('unassigned foreign Running Pod makes memory unknown rather than free', () => {
    const foreign = { ...pod('Running', '16Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} }, spec: { ...pod('Running').spec, nodeName: undefined } };
    const m = measured([foreign], node('16Gi'));
    expect(m.members[0]?.availableMemoryByNodeBytes).toBeNull();
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null, reason: expect.stringContaining('측정 불가: cluster') });
  });
  test('a failed all-namespace Pod read leaves reservation and recommendation unknown', () => {
    const kubectl: PoolKubectl = (args) => args.includes('pods')
      ? { status: 1, stdout: '', stderr: 'forbidden' } : fixture([])(args);
    const measure = measurePoolLease(parsePodPool('node-b:20'), { kubectl, dns: () => 'ready' });
    expect(measure.members[0]).toMatchObject({ running: null, availableMemoryByNodeBytes: null, reason: expect.stringContaining('forbidden') });
    expect(recommendConcurrency(measure, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null, limitedBy: null });
  });
  test('malformed Job metadata cannot hide legacy harness Pods from the counts', () => {
    const kubectl: PoolKubectl = (args) => args.includes('jobs')
      ? { status: 0, stdout: JSON.stringify({ items: [{ metadata: { labels: { 'elanous.substrate': 'pod' } } }] }), stderr: '' }
      : fixture([pod('Running')])(args);
    const m = measurePoolLease(parsePodPool('node-b:20'), { kubectl, dns: () => 'ready' });
    expect(m.members[0]).toMatchObject({ running: null, memoryLimitBytes: null, reason: expect.stringContaining('cluster jobs') });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null });
  });
  test('a malformed jobs response does not erase the node reading', () => {
    const kubectl: PoolKubectl = (args) => args.includes('jobs')
      ? { status: 0, stdout: '{bad', stderr: '' } : fixture([])(args);
    const member = measurePoolLease(parsePodPool('node-b:20'), { kubectl }).members[0]!;
    expect(member).toMatchObject({ allocatableCpuMillicores: 32_000, running: null, memoryLimitBytes: null, reason: expect.stringContaining('cluster jobs') });
  });
  test('malformed node or missing Running memory limits are unknown rather than zero', () => {
    expect(measured([pod('Running', '')]).members[0]?.memoryLimitBytes).toBeNull();
    expect(measured([], JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: 'bad', cpu: '32' } } }] })).members[0]?.allocatableMemoryBytes).toBeNull();
  });
});

describe('POD-ADMIT-BY-USAGE — admission by observed Pod usage', () => {
  const mi = 1024 ** 2;
  // OP 10-07 14:4x node-b: 18 Running harness Pods (request 6Gi · limit 16Gi) using 0.3–2.6GiB, one 10GiB.
  const usageMi = [300, 290, 640, 600, 1050, 310, 2650, 290, 290, 590, 580, 580, 810, 570, 2880, 560, 500, 10240];
  const harnessPod = (name: string, phase = 'Running') => ({
    metadata: { namespace: 'elanous-test', name, labels: { 'elanous.substrate': 'pod', 'elanous.job': 'harness-job' } },
    status: { phase }, spec: { nodeName: 'node-1', containers: [{ resources: { requests: { memory: '6Gi' }, limits: { memory: '16Gi' } } }] },
  });
  // Unrelated workloads on the same node reserve 180Gi — with 18 × 16Gi limits the node has 12Gi left: today's code admits 0.
  const other = { metadata: { namespace: 'kube-system', name: 'big', labels: {} }, status: { phase: 'Running' },
    spec: { nodeName: 'node-1', containers: [{ resources: { requests: { memory: '180Gi' }, limits: { memory: '180Gi' } } }] } };
  const pods = [...usageMi.map((_, i) => harnessPod(`si-task-${i}`)), other];
  const nodes = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '480Gi', cpu: '64' }, conditions: [{ type: 'Ready', status: 'True' }] } }] });
  const topPods = (names = usageMi.map((_, i) => `si-task-${i}`)) => ['client 0m 0Mi', 'ref-mirror-abc 0m 0Mi',
    ...names.map((name) => `${name}   12m   ${usageMi[Number(name.split('-').pop())]}Mi`)].join('\n');
  const cluster = (top: { status: number; stdout: string; stderr: string } | null, list: object[] = pods, topNodes = 'node-1   6291m   19%   61440Mi   12%'): { kubectl: PoolKubectl; calls: string[][] } => {
    const calls: string[][] = [];
    return { calls, kubectl: (args) => {
      calls.push([...args]);
      if (args.includes('top')) return args.includes('nodes') ? { status: 0, stdout: topNodes, stderr: '' } : top ?? { status: 1, stdout: '', stderr: 'error: Metrics API not available' };
      if (args.includes('nodes')) return { status: 0, stdout: nodes, stderr: '' };
      if (args.includes('jobs')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'harness-job', labels: { 'elanous.substrate': 'pod' }, annotations: { [POD_HOST_LEASE_ANNOTATION]: 'true' } } }] }), stderr: '' };
      return { status: 0, stdout: JSON.stringify({ items: list }), stderr: '' };
    } };
  };
  const measure = (kubectl: PoolKubectl, measureUsage = true) => measurePoolLease(parsePodPool('node-b:25'), { kubectl, dns: () => 'ready', measureUsage });
  const decide = (m: PoolLeaseMeasure) => recommendConcurrency(m, { capacity: 25, accounts: 0, perAccount: 0 });

  test('18 Running Pods using 0.3–2.6GiB (one 10GiB) leave room that limit reservations call 0', () => {
    const today = decide(measure(cluster(null).kubectl, false));
    expect(today.recommended).toBe(0);
    expect(today.limitedBy).toBe('memory');
    const log = spyOn(debug, 'log');
    try {
      const { kubectl, calls } = cluster({ status: 0, stdout: topPods(), stderr: '' });
      const m = measure(kubectl);
      expect(calls.find((a) => a.includes('top') && a.includes('pods'))).toEqual(['--context', 'node-b', '--request-timeout=10s', '-n', 'elanous-test', 'top', 'pods', '--no-headers']);
      expect(m.members[0]!.harnessUsageBytes).toHaveLength(18); // client/ref-mirror are not harness Pods
      // 17 × max(6Gi, usage×1.5) = 6Gi each · the 10GiB Pod reserves 15Gi (< 16Gi limit).
      expect(m.members[0]!.memoryReservedBytes).toBe(17 * 6 * gi + 15 * gi);
      expect(m.members[0]!.memoryLimitBytes).toBe(18 * 16 * gi);
      const now = decide(m);
      expect(now.admission).toEqual({ samples: 18, p95Bytes: 10 * gi, admitBytes: 15 * gi, fallback: null });
      expect(now.recommended).toBeGreaterThan(0);
      expect(now.recommended).toBe(7); // capacity 25 − 18 Running
      expect(now.limitedBy).toBe('capacity');
      // node: 480 − 117 − 180 = 183Gi free, keeps 48Gi (10%) → 9 goals at 15Gi
      expect(now.placeableSlots).toBe(7);
      expect(log.mock.calls.filter((c) => c[0] === 'pod-lease' && c[1] === 'admit-by-usage')).toHaveLength(1);
    } finally { log.mockRestore(); }
  });

  test('the node real-usage floor keeps 10% of allocatable free', () => {
    // top nodes says the node already uses 400Gi: 480 − 400 − 48 = 32Gi → 2 goals at 15Gi, whatever the bookkeeping says.
    const now = decide(measure(cluster({ status: 0, stdout: topPods(), stderr: '' }, pods, 'node-1 1m 1% 409600Mi 85%').kubectl));
    expect(now.recommended).toBe(2);
    expect(now.limitedBy).toBe('memory');
  });

  test('top unavailable (no metrics-server) is identical to today and says why', () => {
    for (const list of [pods, pods.slice(0, 3), [pods[0]!, pods[1]!]]) {
      const today = decide(measure(cluster(null, list).kubectl, false));
      const now = decide(measure(cluster(null, list).kubectl));
      const { admission, ...rest } = now;
      const { admission: before, ...todayRest } = today;
      expect(rest).toEqual(todayRest);
      expect(before?.fallback).toBe('usage not measured');
      expect(admission?.fallback).toContain('top pods unavailable: error: Metrics API not available');
      expect(admission?.admitBytes).toBe(16 * gi);
    }
    // Unparseable output is also unavailable, never a partial read.
    expect(decide(measure(cluster({ status: 0, stdout: '{"items":[]}', stderr: '' }).kubectl)).admission?.fallback).toContain('unparseable');
  });

  test('top nodes unavailable (the real-usage floor cannot be read) is also identical to today', () => {
    const today = decide(measure(cluster(null).kubectl, false));
    const { kubectl } = cluster({ status: 0, stdout: topPods(), stderr: '' });
    const noNodes: PoolKubectl = (args) => args.includes('top') && args.includes('nodes') ? { status: 1, stdout: '', stderr: 'error: metrics not available yet' } : kubectl(args);
    const { admission, ...rest } = decide(measure(noNodes));
    const { admission: _before, ...todayRest } = today;
    expect(rest).toEqual(todayRest);
    expect(admission).toMatchObject({ samples: 0, admitBytes: 16 * gi });
    expect(admission?.fallback).toContain('top nodes unavailable: error: metrics not available yet');
  });

  test('one pool member without metrics keeps the whole pool on the conservative size', () => {
    const good = cluster({ status: 0, stdout: topPods(), stderr: '' }).kubectl;
    const bad = cluster(null).kubectl;
    const kubectl: PoolKubectl = (args) => (args[1] === 'node-c' ? bad : good)(args);
    const members = parsePodPool('node-b:25,node-c:5');
    const usage = measurePoolLease(members, { kubectl, dns: () => 'ready', measureUsage: true });
    const limits = measurePoolLease(members, { kubectl, dns: () => 'ready' });
    const now = recommendConcurrency(usage, { capacity: 30, accounts: 0, perAccount: 0 });
    const today = recommendConcurrency(limits, { capacity: 30, accounts: 0, perAccount: 0 });
    // New goals count at 16Gi again; the unread member's Pods stay at their limits.
    expect(now.admission).toMatchObject({ samples: 18, admitBytes: 16 * gi });
    expect(now.admission?.fallback).toContain('node-c: top pods unavailable');
    expect(usage.members[1]!.availableMemoryByNodeBytes).toEqual(limits.members[1]!.availableMemoryByNodeBytes);
    expect(usage.members[1]!.memoryReservedBytes).toBe(limits.members[1]!.memoryLimitBytes);
    // node-b (usage read) keeps its node floor at the 16Gi goal size: (183 − 48)/16 = 8 → capacity 7. node-c is today's.
    expect(now.placeableSlots).toBe(7 + today.placeableSlots!);
  });

  test('the node floor holds even when the goal size falls back (explicit per-goal size)', () => {
    const small = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '30Gi', cpu: '8' }, conditions: [{ type: 'Ready', status: 'True' }] } }] });
    const { kubectl } = cluster({ status: 0, stdout: topPods(['si-task-0', 'si-task-1']), stderr: '' }, [harnessPod('si-task-0'), harnessPod('si-task-1')], 'node-1 1m 1% 2048Mi 5%');
    const withNodes: PoolKubectl = (args) => args.includes('get') && args.includes('nodes') ? { status: 0, stdout: small, stderr: '' } : kubectl(args);
    const m = measure(withNodes);
    expect(m.members[0]!.availableMemoryByNodeBytes).toEqual([18 * gi]); // 30 − 2 × 6Gi
    // 18Gi free fits one 16Gi goal, but it would leave 2Gi (< 3Gi = 10%): admit none.
    const explicit = recommendConcurrency(m, { capacity: 25, perGoalMemory: '16Gi', accounts: 0, perAccount: 0 });
    expect(explicit.admission?.fallback).toBe('explicit perGoalMemory');
    expect(explicit.placeableSlots).toBe(0);
    expect(explicit.recommended).toBe(0);
  });

  test('top nodes missing a schedulable node keeps the member on limits', () => {
    const two = JSON.stringify({ items: ['node-1', 'node-2'].map((name) => ({ metadata: { name }, status: { allocatable: { memory: '480Gi', cpu: '64' }, conditions: [{ type: 'Ready', status: 'True' }] } })) });
    const { kubectl } = cluster({ status: 0, stdout: topPods(), stderr: '' });
    const partial: PoolKubectl = (args) => args.includes('get') && args.includes('nodes') ? { status: 0, stdout: two, stderr: '' } : kubectl(args);
    const limits: PoolKubectl = (args) => args.includes('top') ? { status: 1, stdout: '', stderr: 'x' } : partial(args);
    const m = measure(partial);
    expect(m.members[0]!.usageReason).toBe('top nodes: no reading for node-2');
    expect(m.members[0]!.harnessUsageBytes).toBeNull();
    const { admission, ...rest } = decide(m);
    const { admission: _a, ...today } = decide(measure(limits, false));
    expect(rest).toEqual(today);
    expect(admission?.admitBytes).toBe(16 * gi);
  });

  test('a Pod whose usage is unmeasured is reserved at max(request, limit)', () => {
    const two = [harnessPod('si-task-0'), harnessPod('si-task-1')];
    const m = measure(cluster({ status: 0, stdout: topPods(['si-task-0']), stderr: '' }, two).kubectl).members[0]!;
    expect(m.harnessUsageBytes).toEqual([300 * mi]);
    expect(m.memoryReservedBytes).toBe(6 * gi + 16 * gi);
    expect(m.availableMemoryByNodeBytes).toEqual([480 * gi - 6 * gi - 16 * gi]);
  });

  test('an explicit per-goal size (OOM retry tier) and a run with no samples stay on the conservative size', () => {
    const m = measure(cluster({ status: 0, stdout: topPods(), stderr: '' }).kubectl);
    expect(recommendConcurrency(m, { capacity: 25, perGoalMemory: '16Gi', accounts: 0, perAccount: 0 }).admission).toMatchObject({ admitBytes: 16 * gi, fallback: 'explicit perGoalMemory' });
    expect(decide(measure(cluster({ status: 0, stdout: 'client 0m 0Mi', stderr: '' }, [other]).kubectl)).admission)
      .toMatchObject({ samples: 0, admitBytes: 16 * gi, fallback: 'no Running harness Pod usage samples' });
  });
});
