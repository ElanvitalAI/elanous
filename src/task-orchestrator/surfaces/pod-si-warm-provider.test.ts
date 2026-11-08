import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warmWorkerPodManifest, type WarmPodSpec } from './pod-warm-worker-pod.js';
import { SiWarmPodProvider, configureSiWarmPodProvider, acquireSiWarmLease,
  loadSiWarmPodProvider } from './pod-si-warm-provider.js';
import { cleanAndReturnChildPod } from './pod-child-reuse.js';

const key = { context: 'pool-host-a', imageDigest: `sha256:${'b'.repeat(64)}`,
  lockHash: 'c'.repeat(64), architecture: 'amd64' };
const baseImageDigest = `sha256:${'f'.repeat(64)}`;
const runtimeContract = { baseImageDigest, bunVersion: '1.2.3', os: 'linux' as const, architecture: 'amd64', requiredTools: ['bun', 'git'] };
const selection = { kind: 'implementation' as const,
  imageDigest: key.imageDigest, runtimeContract };
const runtimeObservation = JSON.stringify({ bunVersion: '1.2.3', os: 'linux', architecture: 'amd64',
  baseImageDigest, tools: { bun: true, git: true } });
const spec: WarmPodSpec = { name: 'warm-host-a-standard-1', namespace: 'elanous-test',
  kubectlContext: 'host-a', workerId: 'worker-1', image: `registry.example/elanous@${key.imageDigest}`,
  sourceUrl: 'https://github.com/ElanvitalAI/elanous.git', cutSha: 'a'.repeat(40), key,
  runtimeContract, memoryLimit: '16Gi', hostProbeUrl: 'http://host.orb.internal:10001/health',
  prodProbeUrl: 'http://core.elanous-prod:10002/' };
const candidate = { host: 'host-a', tier: 'standard' as const, kind: 'implementation' as const, spec };
const input = () => ({ runId: 'run-1', attemptId: 'attempt-1', executionKey: 'e'.repeat(64),
  sourceSha: spec.cutSha, lockHash: key.lockHash, deadlineAt: 20_000,
  payload: new TextEncoder().encode('private goal'),
  credentialBundle: new TextEncoder().encode('private credential'),
  adopt: async () => {} });

test('private shared inventory keeps standard SI candidates and rejects a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'si-provider-config-'));
  try {
    const file = join(dir, 'inventory.json');
    writeFileSync(file, JSON.stringify({ controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), machineTokens: { 'host-a': '2'.repeat(64) },
      siSelection: selection, candidates: [candidate, { ...candidate, tier: 'lite' }] }), { mode: 0o600 });
    expect(loadSiWarmPodProvider(file)).toBeInstanceOf(SiWarmPodProvider);
    const alias = join(dir, 'alias.json');
    symlinkSync(file, alias);
    expect(() => loadSiWarmPodProvider(alias)).toThrow('must be private');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fixture(stopRemaining = 0, cutShaDistance?: (candidateSha: string, requestedSha: string) => number | null) {
  const paths: string[] = [];
  let generation = 0;
  const manifest = warmWorkerPodManifest(spec);
  let pod = { metadata: { ...(manifest.metadata as object), uid: 'uid-1', resourceVersion: '1' },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } } as any;
  const kubectl = (args: readonly string[]) => {
    if (args[0] === 'config') return { status: 0, stdout: 'host-a\n', stderr: '' };
    if (args.includes('exec')) return { status: 0, stdout: JSON.stringify({ bunVersion: '1.2.3',
      os: 'linux', architecture: 'amd64', tools: { bun: true, git: true } }), stderr: '' };
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
  const provider = new SiWarmPodProvider({ candidates: [candidate], selection, controlUrl: 'http://127.0.0.1:31413/',
    ...(cutShaDistance ? { cutShaDistance } : {}),
    memberToken: '1'.repeat(64), machineTokens: { 'host-a': '2'.repeat(64) },
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
  const provider = new SiWarmPodProvider({ candidates: [candidate], selection,
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'host-a': '2'.repeat(64) }, now: () => 0,
    kubectl: args => ({ status: 0, stdout: args.includes('-e') ? runtimeObservation : 'host-a\n', stderr: '' }),
    siRunnerReady: () => true,
    fetch: async () => Response.json({ name: spec.workerId, attrs: { leaseId: '', generation: 1, podUid: 'uid-1' } }),
    observe: (event, data) => observed.push({ event, data }),
  });
  expect(await provider.acquire(input())).toEqual({ status: 'uncertain', reason: 'lease-receipt-invalid' });
  expect(observed).toContainEqual({ event: 'si-lease-receipt-invalid', data: {
    runId: 'run-1', attemptId: 'attempt-1', host: 'host-a', workerId: spec.workerId,
    sourceSha: spec.cutSha, key,
  } });
});

test('a configured gate-v1 Pod without an si runner never acquires a lease', async () => {
  const calls: string[] = [];
  const provider = new SiWarmPodProvider({ candidates: [candidate], selection, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'host-a': '2'.repeat(64) }, now: () => 0,
    fetch: async url => { calls.push(String(url)); throw new Error('unexpected Nexus request'); },
    kubectl: args => {
      if (args.includes('-e')) return { status: 0, stdout: runtimeObservation, stderr: '' };
      expect(args.slice(-5, -2)).toEqual(['bun',
        '/workspace/repo/src/task-orchestrator/surfaces/pod-si-warm-runner.ts', '--probe']);
      return { status: 1, stdout: '', stderr: 'runner missing' };
    } });
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
  const f = fixture(0, () => null);
  expect(await f.provider.acquire({ ...input(), sourceSha: 'f'.repeat(40) }))
    .toEqual({ status: 'no-entry', reason: 'no-candidate' });
  expect(f.paths).toEqual([]);
});

test('implementation matcher fails closed for untagged gate candidates and source lock mismatch', async () => {
  const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
  const provider = new SiWarmPodProvider({ candidates: [{ ...candidate, kind: undefined }], selection,
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64), machineTokens: {}, now: () => 0,
    kubectl: args => args.includes('-e') ? { status: 0, stdout: runtimeObservation, stderr: '' }
      : { status: 0, stdout: 'host-a\n', stderr: '' },
    observe: (event, data) => observed.push({ event, data }),
    fetch: async () => { throw new Error('gate candidate must not be leased'); },
  });
  expect(await provider.acquire(input())).toEqual({ status: 'no-entry', reason: 'no-candidate' });
  expect(observed[0]?.data.candidates).toEqual([expect.objectContaining({
    workerId: 'worker-1', kind: 'gate', accepted: false, reason: 'kind-mismatch',
  })]);
  expect(await fixture().provider.acquire({ ...input(), lockHash: 'f'.repeat(64) }))
    .toEqual({ status: 'no-entry', reason: 'no-candidate' });
});

test('implementation matcher compares image digest to configured target and records drift', async () => {
  const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
  const drifted = { ...candidate, spec: { ...spec, key: { ...key, imageDigest: `sha256:${'d'.repeat(64)}` } } };
  const provider = new SiWarmPodProvider({ candidates: [drifted], selection,
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64), machineTokens: {}, now: () => 0,
    kubectl: args => args.includes('-e') ? { status: 0, stdout: runtimeObservation, stderr: '' }
      : { status: 0, stdout: 'host-a\n', stderr: '' },
    siRunnerReady: () => true,
    observe: (event, data) => observed.push({ event, data }),
    fetch: async () => { throw new Error('stop after scoring'); },
  });
  expect(await provider.acquire(input())).toEqual({ status: 'uncertain', reason: 'lease-response-lost' });
  expect(observed[0]?.data.candidates).toEqual([expect.objectContaining({
    workerId: 'worker-1', kind: 'implementation', imageDigestDrift: true,
  })]);
});

test('implementation matcher admits a proven ancestor at its measured distance', async () => {
  const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
  let probed: { sourceSha: string; lockHash: string } | null = null;
  const older = { ...candidate, spec: { ...spec, cutSha: '9'.repeat(40) } };
  const provider = new SiWarmPodProvider({ candidates: [older], selection,
    cutShaDistance: (candidateSha, requestedSha) => candidateSha === older.spec.cutSha
      && requestedSha === spec.cutSha ? 1 : null,
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64), machineTokens: {}, now: () => 0,
    kubectl: args => args.includes('-e') ? { status: 0, stdout: runtimeObservation, stderr: '' }
      : { status: 0, stdout: 'host-a\n', stderr: '' },
    siRunnerReady: (_spec, sourceSha, lockHash) => {
      probed = { sourceSha, lockHash };
      return true;
    }, observe: (event, data) => observed.push({ event, data }),
    fetch: async () => { throw new Error('stop after matching'); },
  });
  expect(await provider.acquire(input())).toEqual({ status: 'uncertain', reason: 'lease-response-lost' });
  expect(observed[0]?.data.candidates).toEqual([expect.objectContaining({
    workerId: 'worker-1', accepted: true, score: [1], cutShaDistance: 1,
  })]);
  expect(probed!).toEqual({ sourceSha: spec.cutSha, lockHash: key.lockHash });
});

test('implementation matcher rejects a candidate with a different requested architecture before leasing', async () => {
  const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
  let leaseRequests = 0;
  const provider = new SiWarmPodProvider({ candidates: [candidate],
    selection: { ...selection, runtimeContract: { ...runtimeContract, architecture: 'arm64' } },
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64), machineTokens: { 'host-a': '2'.repeat(64) },
    now: () => 0,
    kubectl: args => args.includes('-e') ? { status: 0, stdout: runtimeObservation, stderr: '' }
      : { status: 0, stdout: 'host-a\n', stderr: '' },
    siRunnerReady: () => true, observe: (event, data) => observed.push({ event, data }),
    fetch: async () => { leaseRequests++; throw new Error('architecture mismatch must stop before lease'); },
  });
  expect(await provider.acquire(input())).toEqual({ status: 'no-entry', reason: 'no-candidate' });
  expect(leaseRequests).toBe(0);
  expect(observed[0]?.data.candidates).toEqual([expect.objectContaining({
    workerId: 'worker-1', accepted: false, reason: 'runtime-identity-mismatch',
  })]);
});

test('lost lease response emits the exact reconciliation identity', async () => {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const provider = new SiWarmPodProvider({ candidates: [candidate], selection, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'host-a': '2'.repeat(64) }, now: () => 0,
    siRunnerReady: () => true, observe: (event, data) => events.push({ event, data }),
    fetch: async () => { throw new Error('response lost after lease assignment'); },
    kubectl: args => {
      if (args.includes('-e')) return { status: 0, stdout: runtimeObservation, stderr: '' };
      throw new Error('must not enter Pod');
    } });
  expect(await provider.acquire(input())).toEqual({ status: 'uncertain', reason: 'lease-response-lost' });
  expect(events).toEqual([{ event: 'si-candidate-match-score', data: expect.objectContaining({
    kind: 'implementation', runId: 'run-1', selectedWorkerId: 'worker-1' }) },
  { event: 'si-lease-response-lost', data: {
    runId: 'run-1', attemptId: 'attempt-1', host: 'host-a', workerId: 'worker-1',
    sourceSha: spec.cutSha, key } }]);
});

test('failed quarantine is reported as unconfirmed with the fenced lease identity', async () => {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const provider = new SiWarmPodProvider({ candidates: [candidate], selection, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'host-a': '2'.repeat(64) }, now: () => 0,
    siRunnerReady: () => true, observe: (event, data) => events.push({ event, data }),
    fetch: async url => new URL(String(url)).pathname === '/v1/leases/pod-worker'
      ? Response.json({ name: 'other-source-worker', attrs: { leaseId: 'lease-other', generation: 1,
        podUid: 'uid-other', key } })
      : new Response('{"error":"not-primary"}', { status: 409 }),
    kubectl: args => {
      if (args.includes('-e')) return { status: 0, stdout: runtimeObservation, stderr: '' };
      throw new Error('unmatched worker must not contact a Pod');
    } });
  expect(await provider.acquire(input())).toEqual({ status: 'uncertain', reason: 'quarantine-unconfirmed' });
  expect(events).toEqual([{ event: 'si-candidate-match-score', data: expect.objectContaining({
    kind: 'implementation', runId: 'run-1', selectedWorkerId: 'worker-1' }) },
  { event: 'si-quarantine-unconfirmed', data: {
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
  const provider = new SiWarmPodProvider({ candidates: [candidate], selection, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'host-a': '2'.repeat(64) }, now: () => 0,
    siRunnerReady: () => true,
    fetch: (async url => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return Response.json(path === '/v1/leases/pod-worker'
        ? { name: 'other-source-worker', attrs: { leaseId: 'lease-other', generation: 1,
          podUid: 'uid-other', key } } : {});
    }) as typeof fetch,
    kubectl: args => {
      if (args.includes('-e')) return { status: 0, stdout: runtimeObservation, stderr: '' };
      throw new Error('unmatched worker must not contact a Pod');
    } });
  expect(await provider.acquire(input())).toEqual({ status: 'uncertain', reason: 'lease-worker-unmatched' });
  expect(paths).toEqual(['/v1/leases/pod-worker',
    '/v1/leases/pod-worker/other-source-worker/quarantine']);
});

test('control plane cannot substitute a same-key gate Pod for an implementation match', async () => {
  const gate = { ...candidate, kind: 'gate' as const,
    spec: { ...spec, workerId: 'gate-worker' } };
  const paths: string[] = [];
  const provider = new SiWarmPodProvider({ candidates: [candidate, gate], selection,
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64), machineTokens: {}, now: () => 0,
    kubectl: args => args.includes('-e') ? { status: 0, stdout: runtimeObservation, stderr: '' }
      : { status: 0, stdout: 'host-a\n', stderr: '' },
    siRunnerReady: () => true,
    fetch: async url => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return path === '/v1/leases/pod-worker'
        ? Response.json({ name: 'gate-worker', attrs: { leaseId: 'lease-gate', generation: 1,
          podUid: 'uid-gate', key } }) : Response.json({});
    },
  });
  expect(await provider.acquire(input())).toEqual({ status: 'uncertain', reason: 'lease-worker-unmatched' });
  expect(paths).toEqual(['/v1/leases/pod-worker', '/v1/leases/pod-worker/gate-worker/quarantine']);
});

test('busy Nexus pools on three hosts leave the fourth measured host available', async () => {
  const hosts = ['node-b', 'host-a', 'elangram-wsl', 'host-e-wsl'];
  const candidates = hosts.map(host => ({ host, tier: 'standard' as const, kind: 'implementation' as const,
    spec: { ...spec, name: `warm-${host}`, kubectlContext: host, workerId: `worker-${host}` } }));
  const last = candidates.at(-1)!.spec;
  const seen: string[] = [];
  let pod: any = { metadata: { ...(warmWorkerPodManifest(last).metadata as object),
    uid: 'uid-last', resourceVersion: '1' }, status: { phase: 'Running',
    conditions: [{ type: 'Ready', status: 'True' }] } };
  const provider = new SiWarmPodProvider({ candidates, selection, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: {}, now: () => 0, siRunnerReady: () => true,
    fetch: async (_url, init) => {
      const host = JSON.parse(String(init?.body)).machine;
      seen.push(host);
      return host === 'host-e-wsl'
        ? Response.json({ name: last.workerId, attrs: { leaseId: 'lease-last', generation: 1,
          podUid: 'uid-last', key } }) : new Response('{}', { status: 409 });
    },
    kubectl: args => {
      if (args.includes('-e')) return { status: 0, stdout: runtimeObservation, stderr: '' };
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
