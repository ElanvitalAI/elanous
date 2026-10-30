#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import type { PoolKubectl } from '../task-orchestrator/surfaces/pod-pool.js';

/** In-memory Kubernetes boundary for real pool admission and warm-provider tests. Unknown operations fail closed. */
export function createFakeKubectl(options: { context: string; node: string; jobState?: 'running' | 'complete';
  failGetPods?: string; podReadinessOnCreate?: boolean }) {
  const jobs = new Map<string, Record<string, unknown>>();
  const pods = new Map<string, Record<string, any>>();
  const calls: string[][] = [];
  const leaseCalls: string[] = [];
  const jobCreates: string[] = [];
  const jobDeletes: string[] = [];
  let lease: { workerId: string; podUid: string; key: unknown; job?: string; state: 'idle' | 'leased' | 'released' | 'quarantined' } | null = null;
  let loseNextLeaseResponse = false;
  const ok = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const missing = (kind: string) => ({ status: 1, stdout: '', stderr: `${kind} not found` });
  const kubectl: PoolKubectl = (args, input) => {
    calls.push([...args]);
    if (args[0] === 'config' && args[1] === 'get-contexts')
      return args[2] === options.context ? { status: 0, stdout: `${options.context}\n`, stderr: '' } : missing('context');
    if (args[0] !== '--context' || args[1] !== options.context) return missing('context');
    if (args.includes('apply') && input) {
      let manifest: Record<string, any>;
      try { manifest = JSON.parse(input); } catch { return missing('invalid manifest'); }
      const name = manifest.metadata?.name;
      if (manifest.kind === 'Secret' && typeof name === 'string') return ok({ kind: 'Secret', metadata: { name } });
      if (manifest.kind !== 'Job' || typeof name !== 'string' || jobs.has(name)) return missing('existing or invalid Job');
      const completed = (options.jobState ?? 'complete') === 'complete';
      jobs.set(name, { ...manifest, status: { conditions: completed ? [{ type: 'Complete', status: 'True' }] : [] } });
      jobCreates.push(name);
      return ok({ kind: 'Job', metadata: { name } });
    }
    const deleteIndex = args.indexOf('delete');
    if (deleteIndex >= 0) {
      const target = args[deleteIndex + 1] ?? '';
      const resource = target === 'secret' ? 'secret'
        : target === 'job' || target.startsWith('job/') ? 'job' : '';
      const name = target === 'job' ? args[deleteIndex + 2] ?? ''
        : target.startsWith('job/') ? target.slice('job/'.length)
        : target === 'secret' ? args[deleteIndex + 2] ?? '' : '';
      if (!resource || !name) return missing(`unsupported delete target: ${target || '(missing)'}`);
      if (resource === 'job' && !jobs.has(name) && !args.includes('--ignore-not-found')) return missing(`job ${name}`);
      if (resource === 'job') {
        jobs.delete(name);
        jobDeletes.push(name);
      }
      return ok({ status: 'Success' });
    }
    const at = args.indexOf('get');
    const verb = args.find(arg => ['get', 'create', 'wait', 'patch'].includes(arg));
    if (verb === 'create' && args[args.indexOf('create') + 1] === 'secret') return ok({ kind: 'Secret' });
    if (verb === 'get' && args[at + 1] === 'nodes') return ok({ items: [{ metadata: { name: options.node },
      status: { allocatable: { memory: '64Gi', cpu: '16' }, conditions: [{ type: 'Ready', status: 'True' }] } }] });
    if (verb === 'get' && args[at + 1] === 'node') return ok({ metadata: { name: options.node, labels: { 'kubernetes.io/arch': 'amd64' } } });
    if (verb === 'get' && args[at + 1] === 'jobs') return ok({ items: [...jobs.values()] });
    if (verb === 'get' && args[at + 1] === 'job') {
      const name = args[at + 2] ?? '';
      const job = jobs.get(name);
      if (!job) return missing('job');
      const query = args.find(arg => arg.startsWith('jsonpath=')) ?? '';
      if (query.includes('.metadata.uid')) return { status: 0, stdout: `${name}-uid`, stderr: '' };
      if (query.includes('.status.conditions')) return { status: 0, stdout: (job.status as { conditions?: Array<{ type?: string }> })?.conditions?.map((condition) => condition.type).join(' ') ?? '', stderr: '' };
      return ok(job);
    }
    if (verb === 'get' && args[at + 1] === 'pods') {
      if (options.failGetPods) return { status: 1, stdout: '', stderr: options.failGetPods };
      return ok({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: '1', continue: '' }, items: [...pods.values()] });
    }
    if (verb === 'get' && (args[at + 1] === 'pod' || args[at + 1]?.startsWith('pod/'))) {
      const name = args[at + 1] === 'pod' ? args[at + 2] : args[at + 1]?.slice(4);
      const pod = pods.get(name ?? '');
      return pod ? ok(pod) : missing('pod');
    }
    if (verb === 'create' && input) {
      let manifest: Record<string, any>;
      try { manifest = JSON.parse(input); } catch { return missing('invalid manifest'); }
      const name = manifest.metadata?.name;
      if (typeof name !== 'string' || pods.has(name)) return missing('existing or invalid pod');
      const created = { ...manifest, metadata: { ...manifest.metadata, uid: `${name}-uid`, resourceVersion: '1' },
        ...(options.podReadinessOnCreate ? { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } } : {}) };
      pods.set(name, created);
      return ok(created);
    }
    if (verb === 'wait') return pods.has((args.find(arg => arg.startsWith('pod/')) ?? '').slice(4))
      ? ok({}) : missing('pod');
    if (verb === 'patch' && args.includes('pod')) {
      const name = args[args.indexOf('pod') + 1] ?? '';
      const pod = pods.get(name);
      if (!pod) return missing('pod');
      let patch: Array<{ op: string; path: string; value: any }>;
      try { patch = JSON.parse(args[args.indexOf('-p') + 1] ?? ''); } catch { return missing('patch'); }
      if (patch[0]?.op !== 'test' || patch[0].path !== '/metadata/uid' || patch[0].value !== pod.metadata.uid
        || patch[1]?.op !== 'test' || patch[1].path !== '/metadata/resourceVersion'
        || patch[1].value !== pod.metadata.resourceVersion) return missing('precondition');
      const labels = patch.find(row => row.path === '/metadata/labels');
      const annotations = patch.find(row => row.path === '/metadata/annotations');
      if (!labels || !annotations) return missing('patch');
      const updated = { ...pod, metadata: { ...pod.metadata, labels: labels.value, annotations: annotations.value,
        resourceVersion: String(Number(pod.metadata.resourceVersion) + 1) } };
      pods.set(name, updated);
      return ok(updated);
    }
    return missing('unsupported kubectl operation');
  };
  const fetchLease = async (url: string | URL | Request): Promise<Response> => {
    const path = new URL(String(url)).pathname;
    leaseCalls.push(path);
    if (path === '/v1/leases/pod-worker') {
      if (!lease || lease.state !== 'idle' || (lease.job && !jobs.has(lease.job)))
        return Response.json({ unavailable: true }, { status: 503 });
      lease.state = 'leased';
      if (loseNextLeaseResponse) {
        loseNextLeaseResponse = false;
        throw new TypeError('simulated response lost after lease commit');
      }
      return Response.json({ name: lease.workerId, attrs: { key: lease.key, leaseId: 'lease-1',
        generation: 1, podUid: lease.podUid, state: 'leased' } });
    }
    if (!lease || !path.startsWith(`/v1/leases/pod-worker/${lease.workerId}/`))
      return Response.json({ unavailable: true }, { status: 404 });
    const action = path.split('/').at(-1);
    if (action === 'quarantine') {
      if (lease.state === 'quarantined') return Response.json({ unavailable: true }, { status: 409 });
      lease.state = 'quarantined';
      return Response.json({ attrs: { state: lease.state } });
    }
    if (action === 'release' && lease.state === 'leased') {
      if (lease.job && !jobs.has(lease.job)) return Response.json({ unavailable: true }, { status: 409 });
      lease.state = 'released'; return Response.json({ attrs: { state: lease.state } });
    }
    if (action === 'sanitize' && lease.state === 'released') {
      lease.state = 'idle'; return Response.json({ attrs: { state: lease.state } });
    }
    return Response.json({ unavailable: true }, { status: 409 });
  };
  return {
    kubectl, calls, fetchLease, leaseCalls, jobCreates, jobDeletes,
    setWarmLease: (value: { workerId: string; podUid: string; key: unknown; job?: string }) => {
      lease = { ...value, state: 'idle' };
    },
    loseNextLeaseResponse: () => { loseNextLeaseResponse = true; },
    warmLeaseState: () => lease?.state ?? null,
    putPod: (pod: Record<string, any>) => { pods.set(pod.metadata.name, structuredClone(pod)); },
    replacePodUid: (name: string, uid: string) => {
      const pod = pods.get(name);
      if (!pod) throw new Error(`pod not found: ${name}`);
      pods.set(name, { ...pod, metadata: { ...pod.metadata, uid,
        resourceVersion: String(Number(pod.metadata.resourceVersion ?? '0') + 1) } });
    },
    putJob: (name: string) => { jobs.set(name, { metadata: { name, namespace: 'elanous-test', labels: { 'elanous.substrate': 'pod' } } }); },
    removeJob: (name: string) => { jobs.delete(name); },
    hasJob: (name: string) => jobs.has(name),
  };
}

if (import.meta.main) {
  const endpoint = process.env.ELANOUS_FAKE_KUBECTL_URL;
  if (!endpoint) {
    process.stderr.write('fake-kubectl requires ELANOUS_FAKE_KUBECTL_URL\n');
    process.exitCode = 2;
  } else {
    try {
      const input = readFileSync(0, 'utf8');
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: process.argv.slice(2), input }) });
      const result = await response.json() as { status: number | null; stdout: string; stderr: string };
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.status ?? 2;
    } catch (error) {
      process.stderr.write(`fake-kubectl: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  }
}
