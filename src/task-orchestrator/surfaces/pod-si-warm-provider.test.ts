import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warmWorkerPodManifest, type WarmPodSpec } from './pod-warm-worker-pod.js';
import { SiWarmPodProvider, configureSiWarmPodProvider, acquireSiWarmLease,
  loadSiWarmPodProvider } from './pod-si-warm-provider.js';
import { cleanAndReturnChildPod } from './pod-child-reuse.js';

const key = { context: 'pool-node-c', imageDigest: `sha256:${'b'.repeat(64)}`,
  lockHash: 'c'.repeat(64), architecture: 'amd64' };
const spec: WarmPodSpec = { name: 'warm-node-c-standard-1', namespace: 'elanous-test',
  kubectlContext: 'node-c', workerId: 'worker-1', image: `registry.example/elanous@${key.imageDigest}`,
  sourceUrl: 'https://github.com/ElanvitalAI/elanous.git', cutSha: 'a'.repeat(40), key,
  memoryLimit: '16Gi', hostProbeUrl: 'http://host.orb.internal:10001/health',
  prodProbeUrl: 'http://core.elanous-prod:10002/' };
const candidate = { host: 'node-c', tier: 'standard' as const, spec };
const input = () => ({ runId: 'run-1', attemptId: 'attempt-1', executionKey: 'e'.repeat(64),
  sourceSha: spec.cutSha, deadlineAt: 20_000,
  payload: new TextEncoder().encode('private goal'),
  credentialBundle: new TextEncoder().encode('private credential'),
  adopt: async () => {} });

test('private shared inventory keeps standard SI candidates and rejects a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'si-provider-config-'));
  try {
    const file = join(dir, 'inventory.json');
    writeFileSync(file, JSON.stringify({ controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), machineTokens: { 'node-c': '2'.repeat(64) },
      candidates: [candidate, { ...candidate, tier: 'lite' }] }), { mode: 0o600 });
    expect(loadSiWarmPodProvider(file)).toBeInstanceOf(SiWarmPodProvider);
    const alias = join(dir, 'alias.json');
    symlinkSync(file, alias);
    expect(() => loadSiWarmPodProvider(alias)).toThrow('must be private');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fixture(stopRemaining = 0) {
  const paths: string[] = [];
  let generation = 0;
  const manifest = warmWorkerPodManifest(spec);
  let pod = { metadata: { ...(manifest.metadata as object), uid: 'uid-1', resourceVersion: '1' },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } } as any;
  const kubectl = (args: readonly string[]) => {
    if (args[0] === 'config') return { status: 0, stdout: 'node-c\n', stderr: '' };
    if (args[4] === 'get') return { status: 0, stdout: JSON.stringify(pod), stderr: '' };
    if (args[4] === 'patch') {
      const changes = JSON.parse(args[args.indexOf('-p') + 1]!) as Array<{ value: any }>;
      if (changes[0]?.value !== pod.metadata.uid || changes[1]?.value !== pod.metadata.resourceVersion)
        return { status: 1, stdout: '', stderr: '' };
      pod = { ...pod, metadata: { ...pod.metadata, labels: changes[2]!.value,
        annotations: changes[3]!.value, resourceVersion: String(Number(pod.metadata.resourceVersion) + 1) } };
      return { status: 0, stdout: JSON.stringify(pod), stderr: '' };
    }
    throw new Error('unexpected kubectl');
  };
  const fetcher = async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === '/v1/leases/pod-worker') generation++;
    return Response.json(path === '/v1/leases/pod-worker'
      ? { name: spec.workerId, attrs: { leaseId: `lease-${generation}`, generation, podUid: 'uid-1', key } }
      : { attrs: { state: 'idle' } });
  };
  const provider = new SiWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'node-c': '2'.repeat(64) },
    kubectl, fetch: fetcher as typeof fetch, now: () => 0,
    siRunnerReady: () => true,
    exec: async argv => ({ status: 0, stdout: new TextEncoder().encode(JSON.stringify(
      argv.at(-1) === '--stop' ? { remaining: stopRemaining }
        : argv.at(-1) === '--revoke' ? { remaining: 0 }
          : { status: 0, stdout: '' })) }) });
  return { provider, paths, pod: () => pod, replace: () => { pod.metadata.uid = 'uid-replaced'; } };
}

test('default off never contacts the control plane', async () => {
  configureSiWarmPodProvider(null);
  expect(await acquireSiWarmLease(input())).toEqual({ status: 'no-entry', reason: 'disabled' });
});

test('an invalid successful lease receipt leaves a reconciliation event', async () => {
  const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
  const provider = new SiWarmPodProvider({ candidates: [candidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'node-c': '2'.repeat(64) }, now: () => 0,
    kubectl: () => ({ status: 0, stdout: 'node-c\n', stderr: '' }),
    siRunnerReady: () => true,
    fetch: async () => Response.json({ name: spec.workerId, attrs: { leaseId: '', generation: 1, podUid: 'uid-1' } }),
    observe: (event, data) => observed.push({ event, data }),
  });
  expect(await provider.acquire(input())).toEqual({ status: 'uncertain', reason: 'lease-receipt-invalid' });
  expect(observed).toContainEqual({ event: 'si-lease-receipt-invalid', data: {
    runId: 'run-1', attemptId: 'attempt-1', host: 'node-c', workerId: spec.workerId,
    sourceSha: spec.cutSha, key,
  } });
});

test('a configured gate-v1 Pod without an si runner never acquires a lease', async () => {
  const calls: string[] = [];
  const provider = new SiWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'node-c': '2'.repeat(64) }, now: () => 0,
    fetch: async url => { calls.push(String(url)); throw new Error('unexpected Nexus request'); },
    kubectl: args => { expect(args.slice(-3)).toEqual(['bun',
      '/workspace/repo/src/task-orchestrator/surfaces/pod-si-warm-runner.ts', '--probe']);
      return { status: 1, stdout: '', stderr: 'runner missing' }; } });
  expect(await provider.acquire(input())).toEqual({ status: 'no-entry', reason: 'runner-unavailable' });
  expect(calls).toEqual([]);
});

test('acquires an actual lease, conditionally binds UID and fences unknown execution', async () => {
  const { provider, paths, pod } = fixture();
  const result = await provider.acquire(input());
  expect(result.status).toBe('acquired');
  if (result.status !== 'acquired') return;
  expect(result.attempt.command).toMatchObject({ leaseId: 'lease-1', generation: 1,
    podUid: 'uid-1', sourceSha: spec.cutSha, key });
  expect(result.attempt.leaseFenced).toBe(true);
  expect(result.attempt.transport.pod.context).toBe(key.context);
  expect(pod().metadata.labels['elanous.ai/state']).toBe('leased');
  expect(await result.attempt.transport.runner.inspect(result.attempt.transport.pod))
    .toMatchObject({ podUid: 'uid-1' });
  await result.attempt.quarantineUnknown('uncertain-exec');
  expect(paths).toEqual(['/v1/leases/pod-worker', `/v1/leases/pod-worker/${spec.workerId}/quarantine`]);
  expect(pod().metadata.labels['elanous.ai/state']).toBe('quarantined');
});

test('Pod replacement after the lease never enters the runner and quarantines control lease', async () => {
  const f = fixture();
  f.replace();
  expect(await f.provider.acquire(input())).toEqual({ status: 'uncertain', reason: 'pod-identity-or-patch' });
  expect(f.paths).toEqual(['/v1/leases/pod-worker', `/v1/leases/pod-worker/${spec.workerId}/quarantine`]);
});

test('source SHA mismatch is safe no-entry before lease request', async () => {
  const f = fixture();
  expect(await f.provider.acquire({ ...input(), sourceSha: 'f'.repeat(40) }))
    .toEqual({ status: 'no-entry', reason: 'no-candidate' });
  expect(f.paths).toEqual([]);
});

test('lost lease response emits the exact reconciliation identity', async () => {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const provider = new SiWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'node-c': '2'.repeat(64) }, now: () => 0,
    siRunnerReady: () => true, observe: (event, data) => events.push({ event, data }),
    fetch: async () => { throw new Error('response lost after lease assignment'); },
    kubectl: () => { throw new Error('must not enter Pod'); } });
  expect(await provider.acquire(input())).toEqual({ status: 'uncertain', reason: 'lease-response-lost' });
  expect(events).toEqual([{ event: 'si-lease-response-lost', data: {
    runId: 'run-1', attemptId: 'attempt-1', host: 'node-c', workerId: 'worker-1',
    sourceSha: spec.cutSha, key } }]);
});

test('failed quarantine is reported as unconfirmed with the fenced lease identity', async () => {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const provider = new SiWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'node-c': '2'.repeat(64) }, now: () => 0,
    siRunnerReady: () => true, observe: (event, data) => events.push({ event, data }),
    fetch: async url => new URL(String(url)).pathname === '/v1/leases/pod-worker'
      ? Response.json({ name: 'other-source-worker', attrs: { leaseId: 'lease-other', generation: 1,
        podUid: 'uid-other', key } })
      : new Response('{"error":"not-primary"}', { status: 409 }),
    kubectl: () => { throw new Error('unmatched worker must not contact a Pod'); } });
  expect(await provider.acquire(input())).toEqual({ status: 'uncertain', reason: 'quarantine-unconfirmed' });
  expect(events).toEqual([{ event: 'si-quarantine-unconfirmed', data: {
    runId: 'run-1', attemptId: 'attempt-1', workerId: 'other-source-worker',
    podUid: 'uid-other', leaseId: 'lease-other', generation: 1, reason: 'candidate-unmatched' } }]);
});

test('two completed leases reuse the same UID only after measured cleanup and sanitize', async () => {
  const f = fixture();
  for (const generation of [1, 2]) {
    const result = await f.provider.acquire(input());
    expect(result.status).toBe('acquired');
    if (result.status !== 'acquired') return;
    const command = result.attempt.command!;
    expect(command).toMatchObject({ generation, podUid: 'uid-1' });
    const lease = { workerId: command.workerId, podUid: command.podUid,
      leaseId: command.leaseId, generation: command.generation, key: command.key,
      sourceSha: command.sourceSha };
    expect(await cleanAndReturnChildPod(lease, result.attempt.cleanup))
      .toEqual({ outcome: 'returned', reason: 'clean' });
    expect(f.pod().metadata.labels['elanous.ai/state']).toBe('idle');
  }
  expect(f.paths.filter(path => path === '/v1/leases/pod-worker')).toHaveLength(2);
  expect(f.paths.filter(path => path.endsWith('/sanitize'))).toHaveLength(2);
});

test('observed child process residue quarantines the lease and prevents reuse', async () => {
  const f = fixture(1);
  const result = await f.provider.acquire(input());
  expect(result.status).toBe('acquired');
  if (result.status !== 'acquired') return;
  const command = result.attempt.command!;
  expect(await cleanAndReturnChildPod({ workerId: command.workerId, podUid: command.podUid,
    leaseId: command.leaseId, generation: command.generation, key: command.key,
    sourceSha: command.sourceSha }, result.attempt.cleanup))
    .toEqual({ outcome: 'quarantined', reason: 'child-processes-remain' });
  expect(f.pod().metadata.labels['elanous.ai/state']).toBe('quarantined');
  expect(f.paths.some(path => path.endsWith('/sanitize'))).toBe(false);
});

test('control-plane selection of another source worker is quarantined before any exec', async () => {
  const paths: string[] = [];
  const provider = new SiWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'node-c': '2'.repeat(64) }, now: () => 0,
    siRunnerReady: () => true,
    fetch: (async url => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return Response.json(path === '/v1/leases/pod-worker'
        ? { name: 'other-source-worker', attrs: { leaseId: 'lease-other', generation: 1,
          podUid: 'uid-other', key } } : {});
    }) as typeof fetch,
    kubectl: () => { throw new Error('unmatched worker must not contact a Pod'); } });
  expect(await provider.acquire(input())).toEqual({ status: 'uncertain', reason: 'lease-worker-unmatched' });
  expect(paths).toEqual(['/v1/leases/pod-worker',
    '/v1/leases/pod-worker/other-source-worker/quarantine']);
});

test('busy Nexus pools on three hosts leave the fourth measured host available', async () => {
  const hosts = ['node-b', 'node-c', 'elangram-wsl', 'host-e-wsl'];
  const candidates = hosts.map(host => ({ host, tier: 'standard' as const,
    spec: { ...spec, name: `warm-${host}`, kubectlContext: host, workerId: `worker-${host}` } }));
  const last = candidates.at(-1)!.spec;
  const seen: string[] = [];
  let pod: any = { metadata: { ...(warmWorkerPodManifest(last).metadata as object),
    uid: 'uid-last', resourceVersion: '1' }, status: { phase: 'Running',
    conditions: [{ type: 'Ready', status: 'True' }] } };
  const provider = new SiWarmPodProvider({ candidates, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: {}, now: () => 0, siRunnerReady: () => true,
    fetch: async (_url, init) => {
      const host = JSON.parse(String(init?.body)).machine;
      seen.push(host);
      return host === 'host-e-wsl'
        ? Response.json({ name: last.workerId, attrs: { leaseId: 'lease-last', generation: 1,
          podUid: 'uid-last', key } }) : new Response('{}', { status: 409 });
    },
    kubectl: args => {
      if (args[4] === 'get') return { status: 0, stdout: JSON.stringify(pod), stderr: '' };
      if (args[4] === 'patch') {
        const changes = JSON.parse(args[args.indexOf('-p') + 1]!) as Array<{ value: any }>;
        pod = { ...pod, metadata: { ...pod.metadata, labels: changes[2]!.value,
          annotations: changes[3]!.value, resourceVersion: '2' } };
        return { status: 0, stdout: JSON.stringify(pod), stderr: '' };
      }
      throw new Error('unexpected kubectl');
    },
  });
  const result = await provider.acquire(input());
  expect(seen).toEqual(hosts);
  expect(result.status).toBe('acquired');
  if (result.status === 'acquired') expect(result.attempt.command?.workerId).toBe(last.workerId);
});
