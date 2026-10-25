import { expect, test } from 'bun:test';
import { createFakeKubectl } from './fake-kubectl.js';
import { PodPoolScheduler, measureMemberOccupancy, parsePodPool } from '../task-orchestrator/surfaces/pod-pool.js';
import { WarmPodProvider } from '../task-orchestrator/surfaces/pod-warm-worker-provider.js';
import { WarmPodTransport, warmWorkerPodManifest, type WarmPodSpec } from '../task-orchestrator/surfaces/pod-warm-worker-pod.js';
import { cleanAndReturnChildPod, type ChildPodLease } from '../task-orchestrator/surfaces/pod-child-reuse.js';
import { podSelfImplementSpawn } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { HostPoolLease } from '../pod-lease/host-lease.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const key = { context: 'pool-node-c', imageDigest: `sha256:${'b'.repeat(64)}`, lockHash: 'c'.repeat(64), architecture: 'amd64' };
const spec: WarmPodSpec = { name: 'warm-node-c', namespace: 'elanous-test', kubectlContext: 'node-c',
  workerId: 'worker-1', image: `registry.example/elanous@${key.imageDigest}`,
  sourceUrl: 'https://github.com/ElanvitalAI/elanous.git', cutSha: 'a'.repeat(40), key,
  memoryLimit: '16Gi', nodeName: 'pool-node-c-server-0', hostProbeUrl: 'http://host.orb.internal:10001/health',
  prodProbeUrl: 'http://core.elanous-prod:10002/' };
const member = parsePodPool('node-c:1')[0]!;
const replay = () => ({ protocol: 1 as const, runId: 'run-1', attemptId: 'attempt-1', cutSha: spec.cutSha,
  deadlineAt: Date.now() + 60_000, files: ['src/example.test.ts'], envProfile: 'gate-v1' as const });

function stage(jobForLease?: string) {
  const device = createFakeKubectl({ context: member.context, node: spec.nodeName! });
  const manifest = warmWorkerPodManifest(spec);
  device.putPod({ ...manifest, metadata: {
    ...(manifest.metadata as object), uid: 'uid-1', resourceVersion: '1',
  }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [{ name: 'worker', ready: true }] } });
  if (jobForLease) device.putJob(jobForLease);
  device.setWarmLease({ workerId: spec.workerId, podUid: 'uid-1', key,
    ...(jobForLease ? { job: jobForLease } : {}) });
  let transports = 0;
  const provider = new WarmPodProvider({ candidates: [{ host: 'node-c', tier: 'standard', spec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64), machineTokens: { node-c: '2'.repeat(64) },
    kubectl: device.kubectl, fetch: device.fetchLease, transport: () => ({ request: async () => { transports++;
      return { status: 'observed', reason: 'complete', reply: null }; } }),
  });
  return { device, provider, paths: device.leaseCalls, transports: () => transports };
}

test('MOCK-FAKE-KUBECTL: tracks Job disappearance, Pod UID and fenced lease transitions', async () => {
  const device = createFakeKubectl({ context: member.context, node: spec.nodeName! });
  const command = ['--context', member.context, '-n', spec.namespace] as const;
  device.putJob('job-1');
  device.putPod({ metadata: { name: spec.name, namespace: spec.namespace, uid: 'uid-1', resourceVersion: '1' } });
  device.setWarmLease({ workerId: spec.workerId, podUid: 'uid-1', key, job: 'job-1' });
  expect(JSON.parse(device.kubectl([...command, 'get', 'jobs', '-o', 'json']).stdout).items).toHaveLength(1);
  expect((await device.fetchLease('http://control/v1/leases/pod-worker')).status).toBe(200);
  expect(device.warmLeaseState()).toBe('leased');
  expect((await device.fetchLease('http://control/v1/leases/pod-worker')).status).toBe(503);
  expect((await device.fetchLease(`http://control/v1/leases/pod-worker/${spec.workerId}/release`)).status).toBe(200);
  expect((await device.fetchLease(`http://control/v1/leases/pod-worker/${spec.workerId}/release`)).status).toBe(409);
  expect((await device.fetchLease(`http://control/v1/leases/pod-worker/${spec.workerId}/sanitize`)).status).toBe(200);
  device.removeJob('job-1');
  device.replacePodUid(spec.name, 'uid-2');
  expect(JSON.parse(device.kubectl([...command, 'get', 'jobs', '-o', 'json']).stdout).items).toHaveLength(0);
  expect(JSON.parse(device.kubectl([...command, 'get', 'pod', spec.name, '-o', 'json']).stdout).metadata.uid).toBe('uid-2');
  expect((await device.fetchLease('http://control/v1/leases/pod-worker')).status).toBe(503);
});

test('MOCK-FAKE-KUBECTL: delete accepts both Kubernetes job target forms and rejects unsupported targets', () => {
  const device = createFakeKubectl({ context: member.context, node: spec.nodeName! });
  device.putJob('job-spaced');
  device.putJob('job-slashed');
  expect(device.kubectl(['--context', member.context, '-n', spec.namespace, 'delete', 'job', 'job-spaced']).status).toBe(0);
  expect(device.hasJob('job-spaced')).toBe(false);
  expect(device.kubectl(['--context', member.context, '-n', spec.namespace, 'delete', 'job/job-slashed']).status).toBe(0);
  expect(device.hasJob('job-slashed')).toBe(false);
  expect(device.kubectl(['--context', member.context, '-n', spec.namespace, 'delete', 'deployment', 'job-spaced']).status).not.toBe(0);
});

test('MOCK-FAKE-KUBECTL: UID replacement fences warm lease before transport and quarantines once', async () => {
  const { device, provider, paths, transports } = stage();
  device.replacePodUid(spec.name, 'uid-2');
  expect(await provider.request(replay())).toMatchObject({ command: null,
    transport: { status: 'fallback', reason: 'lease-unavailable' } });
  expect(transports()).toBe(0);
  expect(paths).toEqual(['/v1/leases/pod-worker', `/v1/leases/pod-worker/${spec.workerId}/quarantine`]);
  expect(device.warmLeaseState()).toBe('quarantined');
  expect(device.calls.filter(call => call.includes('create'))).toHaveLength(0);
});

test('MOCK-FAKE-KUBECTL: real warm transport refuses an isolation-drifted Pod before exec', async () => {
  const { device } = stage();
  const manifest = warmWorkerPodManifest(spec);
  device.putPod({ ...manifest, metadata: { ...(manifest.metadata as object), uid: 'uid-1', resourceVersion: '2' },
    spec: { ...(manifest.spec as object), hostNetwork: true },
    status: { phase: 'Running', containerStatuses: [{ name: 'worker', ready: true }] } });
  const transport = new WarmPodTransport(spec, device.kubectl);
  expect(await transport.request({ ...replay(), key, workerId: spec.workerId, leaseId: 'lease-1',
    generation: 1, podUid: 'uid-1' })).toMatchObject({ status: 'fallback', reason: 'pod-unready' });
  expect(device.calls.filter(call => call.includes('exec'))).toHaveLength(0);
  expect(device.calls.filter(call => call.includes('create'))).toHaveLength(0);
});

test('MOCK-FAKE-KUBECTL: vanished Job leaves its Pod occupied; reuse and isolation fail closed with zero duplicate launch', async () => {
  const { device, provider, paths, transports } = stage('job-1');
  device.putPod({ metadata: { name: 'job-pod', namespace: 'elanous-test', labels: {
    'elanous.substrate': 'pod', 'elanous.job': 'job-1' } },
    spec: { nodeName: spec.nodeName, containers: [{ resources: { limits: { memory: '16Gi' } } }] },
    status: { phase: 'Running' } });
  const granted = await provider.request(replay());
  expect(granted.command).not.toBeNull();
  const command = granted.command!;
  const launchedTransports = transports();
  device.removeJob('job-1');
  const occupancy = measureMemberOccupancy([member], { kubectl: device.kubectl, dns: () => 'ready' });
  expect(occupancy[member.context]).toEqual({ occupied: 1 });
  const scheduler = new PodPoolScheduler([member], { kubectl: device.kubectl, dns: () => 'ready' });
  expect(await scheduler.tryAcquire()).toBeNull();
  expect(scheduler.snapshot()[member.context]).toBe(0);
  const lease: ChildPodLease = { workerId: command.workerId, podUid: command.podUid, leaseId: command.leaseId,
    generation: command.generation, key: command.key, sourceSha: command.cutSha };
  let returns = 0;
  let quarantines = 0;
  const cleaned = await cleanAndReturnChildPod(lease, {
    stopChildProcesses: async () => ({ remaining: 0 }),
    git: async () => ({ status: 0, stdout: '' }),
    removeRunCredentials: async () => ({ remaining: 0 }),
    returnLease: async () => {
      const response = await device.fetchLease(`http://control/v1/leases/pod-worker/${spec.workerId}/release`);
      if (!response.ok) throw new Error(`lease release refused (${response.status})`);
      returns++;
    },
    quarantine: async () => { quarantines++;
      await device.fetchLease(`http://control/v1/leases/pod-worker/${spec.workerId}/quarantine`); },
    observe: () => {},
  });
  expect(cleaned.outcome).toBe('quarantined');
  expect(cleaned.reason).toContain('lease release refused (409)');
  expect(returns).toBe(0);
  expect(quarantines).toBe(1);
  expect(device.warmLeaseState()).toBe('quarantined');
  expect((await provider.request(replay())).command).toBeNull();
  expect(transports()).toBe(launchedTransports);
  expect(paths).toEqual(['/v1/leases/pod-worker', `/v1/leases/pod-worker/${spec.workerId}/release`,
    `/v1/leases/pod-worker/${spec.workerId}/quarantine`, '/v1/leases/pod-worker']);
  expect(paths.filter(path => path.endsWith('/quarantine'))).toHaveLength(1);
  expect(device.calls.filter(call => call.includes('create'))).toHaveLength(0);
});

test('MOCK-FAKE-KUBECTL: provider double finalize releases and sanitizes the warm lease exactly once', async () => {
  const { device, provider, paths, transports } = stage('job-1');
  const granted = await provider.request(replay());
  expect(granted.command).not.toBeNull();
  expect(transports()).toBe(1);
  await provider.finalize(granted.command!);
  await provider.finalize(granted.command!);
  expect(paths).toEqual(['/v1/leases/pod-worker',
    `/v1/leases/pod-worker/${spec.workerId}/release`,
    `/v1/leases/pod-worker/${spec.workerId}/sanitize`]);
  expect(device.warmLeaseState()).toBe('idle');
  device.removeJob('job-1');
  expect((await provider.request(replay())).command).toBeNull();
  expect(transports()).toBe(1);
  expect(device.calls.filter(call => call.includes('create'))).toHaveLength(0);
});

test('MOCK-FAKE-KUBECTL: duplicate admission release does not launch twice or reuse a quarantined lease', async () => {
  const { device, provider, paths, transports } = stage();
  const scheduler = new PodPoolScheduler([member], { kubectl: device.kubectl, dns: () => 'ready' });
  const admission = await scheduler.acquireAdmission();
  admission.applied('job-1', member.context, 'elanous-test');
  admission();
  admission();
  expect(scheduler.admissionSnapshot().active).toBe(0);
  expect(scheduler.admissionSnapshot().queued).toBe(0);
  expect(device.warmLeaseState()).toBe('idle');
  device.replacePodUid(spec.name, 'uid-2');
  const first = await provider.request(replay());
  expect(first.command).toBeNull();
  expect(transports()).toBe(0);
  expect(paths.filter(path => path.endsWith('/quarantine'))).toHaveLength(1);
  expect(device.warmLeaseState()).toBe('quarantined');
  expect((await provider.request(replay())).command).toBeNull();
  expect(transports()).toBe(0);
  expect(paths.filter(path => path === '/v1/leases/pod-worker')).toHaveLength(2);
  expect(device.calls.filter(call => call.includes('create'))).toHaveLength(0);
});

test('MOCK-FAKE-KUBECTL: the production Pod launcher applies one Job and deletes it once when an admitted run aborts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fake-kubectl-launcher-'));
  const controller = new AbortController();
  const startedAt = Date.now();
  let peakRssBytes = process.memoryUsage().rss;
  const rssMonitor = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    if (peakRssBytes > 1024 ** 3) controller.abort();
  }, 25);
  const abortWatchdog = setTimeout(() => controller.abort(), 5_000);
  const device = createFakeKubectl({ context: member.context, node: spec.nodeName!, jobState: 'running' });
  const scheduler = new PodPoolScheduler([member], {
    kubectl: device.kubectl,
    status: () => ({ recommended: 1, accountSlots: 0, limitedBy: 'capacity', reason: null,
      capacitySlots: 1, memorySlots: 1, placeableSlots: 1, running: 0, pending: 0 }),
    occupancy: () => ({ [member.context]: { occupied: 0 } }),
    memberMemory: () => [{ context: member.context, allocatableMemoryBytes: 64 * 1024 ** 3 }],
    hostLease: new HostPoolLease('fake-kubectl-launcher', { dir: root, pid: 123, processStart: () => 'fixture' }),
  });
  const admissions: Array<() => void> = [];
  let productionReleaseCalls = 0;
  const pool = {
    members: scheduler.members,
    tryAcquire: (...args: Parameters<PodPoolScheduler['tryAcquire']>) => scheduler.tryAcquire(...args),
    release: (...args: Parameters<PodPoolScheduler['release']>) => scheduler.release(...args),
    snapshot: () => scheduler.snapshot(),
    acquireAdmission: async (...args: Parameters<PodPoolScheduler['acquireAdmission']>) => {
      const release = await scheduler.acquireAdmission(...args);
      const trackedRelease = () => { productionReleaseCalls++; release(); };
      admissions.push(trackedRelease);
      return Object.assign(trackedRelease, { applied: release.applied, observed: release.observed });
    },
  } as PodPoolScheduler;
  try {
    const run = podSelfImplementSpawn({
      kubectl: device.kubectl, pool, sleep: async () => new Promise<void>(resolve => setTimeout(resolve, 0)), pollMs: 1,
      credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gho_test' }),
      env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: 'run-fake-kubectl-launcher' },
      budgetSnapshot: () => undefined, fallbackConfig: () => ({ llm: {} } as never),
      openGatewayConfig: () => ({ llm: {} } as never), hostSupervised: false, resultMarker: false,
    })({ feature: 'test', spaceId: 'fake-kubectl-launcher', signal: controller.signal }).done;
    // Abort after the real production caller has emitted its Job manifest; its abort path owns cleanup.
    const setupDeadlineAt = Date.now() + 2_000;
    for (let attempt = 0; attempt < 100 && device.jobCreates.length === 0 && Date.now() < setupDeadlineAt; attempt++)
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    const createdJobs = device.jobCreates.length;
    const admissionCount = admissions.length;
    if (createdJobs !== 1) throw new Error(`launcher did not apply one Job; calls=${JSON.stringify(device.calls)}`);
    if (admissionCount !== 1) throw new Error(`launcher did not acquire one admission; calls=${JSON.stringify(device.calls)}`);
    controller.abort();
    // Bound the production loop even if a future regression stops honoring abort.
    let runTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        runTimer = setTimeout(() => reject(new Error('fake kubectl launcher exceeded 60s')), 60_000);
      }),
    ]).finally(() => { if (runTimer) clearTimeout(runTimer); });
    expect(createdJobs).toBe(1);
    expect(admissionCount).toBe(1);
    expect(device.jobDeletes).toEqual([device.jobCreates[0]!]);
    expect(device.hasJob(device.jobCreates[0]!)).toBe(false);
    expect(productionReleaseCalls).toBe(1);
    expect(scheduler.admissionSnapshot().active).toBe(0);
    expect(scheduler.admissionSnapshot().queued).toBe(0);
    // Exercise duplicate release only after production abort cleanup is independently observed.
    admissions[0]!();
    admissions[0]!();
    expect(productionReleaseCalls).toBe(3);
    expect(device.jobDeletes).toHaveLength(1);
    expect(device.hasJob(device.jobCreates[0]!)).toBe(false);
    expect(device.jobCreates).toHaveLength(1);
    expect(scheduler.snapshot()[member.context]).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(60_000);
    expect(peakRssBytes).toBeLessThan(1024 ** 3);
  } finally {
    controller.abort();
    clearTimeout(abortWatchdog);
    clearInterval(rssMonitor);
    rmSync(root, { recursive: true, force: true });
  }
});
