import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WarmPodProvider, requestWarmPodReplay, configureWarmPodProvider, loadWarmPodProvider, parseWarmPodProviderArgs,
  pairWarmReuseTimeLegs, readWarmReuseTimePairs, runWarmPodProviderCli, type WarmPodProviderOptions, type WarmWorkerCandidate } from './pod-warm-worker-provider.js';
import { LogStore, StoreSink } from '../../mss/logging/log-store.js';
import { warmWorkerPodManifest, type WarmPodSpec } from './pod-warm-worker-pod.js';
import { resolveWarmPoolQuota } from '../../self-implement/pod-warm-pool-profile.js';
import { ensureControlTokens, startControlServer } from '../../control-plane/server.js';
import { issueMemberToken } from '../../control-plane/member-tokens.js';
import { createFakeKubectl } from '../../ux-sim/fake-kubectl.js';
import { loadSiWarmPodProvider, SiWarmPodProvider } from './pod-si-warm-provider.js';
import { assembleWarmPoolProviderConfig, selectSingleWarmPoolCandidate, writeWarmPoolProviderConfig,
  type WarmPoolProviderConfig } from '../../../scripts/warm-pool-provider-config.js';

test('warm provider records correlated diagnostics for control-plane 404 and 503 responses', async () => {
  for (const status of [404, 503]) {
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64),
      runtimeIdentity: { baseImageDigest, lockHash: key.lockHash, os: 'linux', architecture: 'amd64', bunVersion: '1.4.2' },
      kubectl: args => args[4] === 'get' && args[5] === 'pods'
        ? { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: spec.name, namespace: spec.namespace, uid: 'provider-gap-uid' } }] }), stderr: '' }
        : { status: 0, stdout: '', stderr: '' },
      fetch: async () => Response.json({ detail: 'must not be logged', token: 'secret' }, { status }) });
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      if ((category === 'pod.warm.provider' && event === 'control-http-failure')
        || (category === 'pod.warm' && ['candidate-match-score', 'request-selection'].includes(event))) events.push({ category, event, data });
    }) as typeof debug.log);
    try {
      const result = await requestWarmPodReplay({ ...input(), runId: 'provider-gap-run' }, provider, {
        lockHash: key.lockHash, imageDigest: key.imageDigest, runtimeContract: spec.runtimeContract,
        runtimeIdentity: { baseImageDigest, lockHash: key.lockHash, os: 'linux', architecture: 'amd64', bunVersion: '1.4.2' },
      });
      expect(result.command).toBeNull();
    } finally { log.mockRestore(); }
    expect(events).toContainEqual({ category: 'pod.warm.provider', event: 'control-http-failure', data: {
      runId: 'provider-gap-run', method: 'POST', path: '/v1/leases/pod-worker', status,
    } });
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(JSON.stringify(events)).not.toContain('1111111111111111111111111111111111111111111111111111111111111111');
  }
});

const warmPoolAssemblerInput = (host = 'test-host') => {
  return {
    config: {
      pod: { warmPoolProfile: 'gate', warmPool: {
        namespace: 'elanous-test', sourceMirrorHostPath: '/srv/elanous-mirror',
        hostProbeUrl: 'http://host.orb.internal:10001/health', prodProbeUrl: 'http://core.elanous-prod:10002/',
        imageRepository: 'registry.example/elanous', imageDigest: `sha256:${'d'.repeat(64)}`,
        lockHash: 'e'.repeat(64), architecture: 'amd64', expandPoolTemplatesToQuota: true,
        templates: [{ host, tier: 'standard', nodeName: `pool-${host}-server-0` }],
      } },
      harness: { imageCommit: 'a'.repeat(40), podPool: 'k3d-elanous-pool' },
    },
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64), machineTokens: { [host]: '2'.repeat(64) },
  };
};

const key = { context: 'pool-test-host', imageDigest: `sha256:${'b'.repeat(64)}`, lockHash: 'c'.repeat(64), architecture: 'amd64' };
const baseImageDigest = `sha256:${'f'.repeat(64)}`;
const spec: WarmPodSpec = { name: 'warm-test-1', namespace: 'elanous-test', kubectlContext: 'test-host',
  workerId: 'warm-test-1-uid', image: `registry.example/elanous@${key.imageDigest}`,
  sourceUrl: 'https://github.com/ElanvitalAI/elanous.git', cutSha: 'a'.repeat(40), key,
  runtimeContract: { baseImageDigest, bunVersion: '1.4.2', os: 'linux', architecture: 'amd64', requiredTools: ['bun', 'git'] },
  memoryLimit: '16Gi', hostProbeUrl: 'http://host.orb.internal:10001/health',
  prodProbeUrl: 'http://core.elanous-prod:10002/' };
const candidate = { host: 'test-host', tier: 'standard' as const, spec };
const testHostQuota: typeof resolveWarmPoolQuota = (profile, host, tier) =>
  (host === 'test-host' || host === 'test-host-b') ? (tier === 'standard' ? 4 : 0)
    : resolveWarmPoolQuota(profile, host, tier);
const providerStateRoot = mkdtempSync(join(tmpdir(), 'warm-provider-state-tests-'));
let providerStateIndex = 0;
afterAll(() => rmSync(providerStateRoot, { recursive: true, force: true }));
const newTestWarmPodProvider = (options: ConstructorParameters<typeof WarmPodProvider>[0]) =>
  new WarmPodProvider({ quotaResolverForTest: testHostQuota, ...options,
    rotationStatePath: options.rotationStatePath ?? join(providerStateRoot, `provider-${++providerStateIndex}.json`) });
const input = () => ({ protocol: 1 as const, runId: 'run-1', attemptId: 'attempt-1', cutSha: spec.cutSha,
  deadlineAt: Date.now() + 60_000, files: ['src/example/worker.test.ts'], envProfile: 'gate-v1' });
const completeReply = (command: import('./pod-warm-worker-protocol.js').WarmWorkerCommand) => ({
  protocol: 1 as const, runId: command.runId, attemptId: command.attemptId, cutSha: command.cutSha,
  ...(command.baselineSha ? { baselineSha: command.baselineSha } : {}), leaseId: command.leaseId,
  generation: command.generation, workerId: command.workerId, key: command.key,
  envProfile: command.envProfile, startedAt: Date.now(), finishedAt: Date.now(),
  files: command.files.map(file => ({ file, rc: 0, failureIds: [], errorIds: [], junitComplete: true })),
  resetReceipt: { baseImageDigest: command.baseImageDigest ?? command.key.imageDigest,
    resetMethod: 'git-reset-clean-status-v1' as const, postRunDiff: [] },
});
const gateSelection = (target = key) => ({ kind: 'gate' as const,
  lockHash: target.lockHash, imageDigest: target.imageDigest,
  runtimeContract: { baseImageDigest, bunVersion: '1.4.2', os: 'linux' as const,
    architecture: target.architecture, requiredTools: [] as string[] },
  runtimeIdentity: { baseImageDigest, lockHash: target.lockHash, os: 'linux', architecture: target.architecture, bunVersion: '1.4.2' } });
const lease = () => ({ name: spec.workerId, attrs: { key, leaseId: 'lease-1', generation: 1,
  podUid: 'lease-pod-uid', state: 'leased' } });
const leaseKubectl = (specs: WarmPodSpec[] = [spec]) => {
  const pods = new Map(specs.map(item => [item.name, { metadata: {
    ...(warmWorkerPodManifest(item).metadata as { labels: Record<string, string>; annotations: Record<string, string> }),
    uid: 'lease-pod-uid', resourceVersion: '1',
  } }]));
  return (args: readonly string[]) => {
    if (args[4] === 'get' && args[5] === 'pods') {
      const selectedName = args.find(arg => arg.startsWith('--field-selector=metadata.name='))?.split('=').at(-1);
      const pod = selectedName ? pods.get(selectedName) : undefined;
      const items = pod && pod.metadata.labels['elanous.ai/quarantined'] !== 'true' ? [pod] : [];
      return { status: 0, stdout: JSON.stringify({ apiVersion: 'v1', kind: 'PodList', items }), stderr: '' };
    }
    const name = args[6]!;
    const pod = pods.get(name);
    if (!pod) return { status: 1, stdout: '', stderr: 'pod missing' };
    if (args[4] === 'get') return { status: 0, stdout: JSON.stringify(pod), stderr: '' };
    if (args[4] === 'patch') {
      const patch = JSON.parse(args[args.indexOf('-p') + 1]!) as Array<{ op: string; path?: string; value: any }>;
      if (patch[0]?.value !== pod.metadata.uid || patch[1]?.value !== pod.metadata.resourceVersion)
        return { status: 1, stdout: '', stderr: 'precondition failed' };
      if (patch[2]?.path === '/metadata/labels/elanous.ai~1quarantined') {
        pod.metadata = { ...pod.metadata, labels: { ...pod.metadata.labels, 'elanous.ai/quarantined': patch[2].value },
          resourceVersion: String(Number(pod.metadata.resourceVersion) + 1) };
      } else {
        pod.metadata = { ...pod.metadata, labels: patch[2]!.value, annotations: patch[3]!.value,
          resourceVersion: String(Number(pod.metadata.resourceVersion) + 1) };
      }
      return { status: 0, stdout: JSON.stringify(pod), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected kubectl' };
  };
};

test('unconfigured replay fails closed without making a control or kubectl request', async () => {
  configureWarmPodProvider(null);
  expect(await requestWarmPodReplay(input())).toEqual({ command: null,
    transport: { status: 'fallback', reason: 'no-candidate', reply: null } });
});

test('--prepare reports a private-config parse failure as prepared:false with rc2', () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-provider-invalid-'));
  try {
    const file = join(root, 'provider.json');
    writeFileSync(file, '{not-json', { mode: 0o600 });
    const run = spawnSync(process.execPath,
      [join(import.meta.dir, 'pod-warm-worker-provider.ts'), '--prepare', spec.workerId],
      { encoding: 'utf8', env: { ...process.env, ELANOUS_WARM_POD_PROVIDER_CONFIG: file } });
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout)).toEqual({ workerId: spec.workerId, prepared: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--reconcile reports a private-config parse failure as unavailable with rc2', () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-provider-reconcile-invalid-'));
  try {
    const file = join(root, 'provider.json');
    writeFileSync(file, '{not-json', { mode: 0o600 });
    const run = spawnSync(process.execPath,
      [join(import.meta.dir, 'pod-warm-worker-provider.ts'), '--reconcile'],
      { encoding: 'utf8', env: { ...process.env, ELANOUS_WARM_POD_PROVIDER_CONFIG: file } });
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout)).toEqual({ target: 0, ready: 0, failed: ['config-unavailable'] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--reconcile exits nonzero when phase retirement fails at a zero target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-provider-phase-retire-'));
  const previousConfig = process.env.ELANOUS_WARM_POD_PROVIDER_CONFIG;
  try {
    const file = join(root, 'provider.json');
    const options = { candidates: [{ ...candidate, host: 'gcp1', kind: 'implementation' }],
      profileConfig: { pod: { warmPoolProfile: 'gate' } }, controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), phasePrewarmForTest: { targets: { normal: { implementation: 0 } } },
      releaseSchedulesForTest: [] };
    writeFileSync(file, JSON.stringify(options), { mode: 0o600 });
    process.env.ELANOUS_WARM_POD_PROVIDER_CONFIG = file;
    const output: string[] = [];
    const result = await runWarmPodProviderCli(['--reconcile'], { registerLogSink: async () => {}, write: line => output.push(line) });
    expect(result).toMatchObject({ exitCode: 2, result: { target: 0, ready: 0,
      failed: ['phase-retire-unconfirmed:warm-test-1-uid'] } });
    expect(JSON.parse(output[0]!)).toMatchObject({ target: 0, ready: 0, failed: ['phase-retire-unconfirmed:warm-test-1-uid'] });
  } finally {
    if (previousConfig === undefined) delete process.env.ELANOUS_WARM_POD_PROVIDER_CONFIG;
    else process.env.ELANOUS_WARM_POD_PROVIDER_CONFIG = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test('--reconcile exits nonzero when schedule lookup fails even if fallback target is ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-provider-phase-schedule-'));
  const previousConfig = process.env.ELANOUS_WARM_POD_PROVIDER_CONFIG;
  try {
    const file = join(root, 'provider.json');
    const options = { candidates: [], profileConfig: { pod: { warmPoolProfile: 'gate' } },
      controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
      phasePrewarmForTest: { targets: { normal: { gate: 0, implementation: 0 } } },
      scheduleLookupErrorForTest: true };
    writeFileSync(file, JSON.stringify(options), { mode: 0o600 });
    process.env.ELANOUS_WARM_POD_PROVIDER_CONFIG = file;
    const output: string[] = [];
    const result = await runWarmPodProviderCli(['--reconcile'], { registerLogSink: async () => {}, write: line => output.push(line) });
    expect(result).toMatchObject({ exitCode: 2, result: { target: 0, ready: 0,
      failed: ['phase-schedule-unavailable:cold-fallback'] } });
    expect(JSON.parse(output[0]!)).toMatchObject({ target: 0, ready: 0, failed: ['phase-schedule-unavailable:cold-fallback'] });
  } finally {
    if (previousConfig === undefined) delete process.env.ELANOUS_WARM_POD_PROVIDER_CONFIG;
    else process.env.ELANOUS_WARM_POD_PROVIDER_CONFIG = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test('named slots are independently reconciled and bounded by the measured host quota', async () => {
  const first = { ...spec, name: 'warm-test-host', workerId: 'test-host-uid-1', nodeName: 'pool-test-host-server-0' };
  const second = { ...spec, name: 'warm-test-host-2', workerId: 'test-host-uid-2', nodeName: 'pool-test-host-server-0' };
  const candidates = [first, second].map(item => ({ ...candidate, spec: item }));
  const created: string[] = [];
  const registered = new Map<string, string>();
  const pods = new Map<string, any>();
  for (let index = 0; index < 55; index++) pods.set(`unrelated-${index}`, { kind: 'Pod', metadata: {
    name: `unrelated-${index}`, namespace: spec.namespace, annotations: { payload: 'x'.repeat(55_000) },
  }, spec: { nodeName: 'unrelated-node' } });
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const listQueries: string[][] = [];
  const occupancyEvents: Array<{ event: string; data: any }> = [];
  const provider = newTestWarmPodProvider({ candidates, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) },
    observationRunIdForTest: 'occupancy-run-1',
    kubectl: (args, input) => {
      if (args[4] === 'get' && args[5] === 'pods') {
        listQueries.push([...args]);
        const selector = args.find(arg => arg.startsWith('--field-selector=metadata.name='));
        const rows = selector ? [...pods.values()].filter(pod => pod.metadata.name === selector.split('=').at(-1))
          : [...pods.values()].filter(pod => pod.metadata.labels?.['elanous.kind'] === 'warm-worker');
        if (args.includes('-l')) {
          expect(args).toContain('--limit=25');
          expect(Buffer.byteLength(JSON.stringify({ kind: 'PodList', metadata: { continue: '' }, items: rows })))
            .toBeLessThan(2 * 1024 * 1024);
        }
        return result({ kind: 'PodList', metadata: { continue: '' }, items: rows });
      }
      if (args[4] === 'create') {
        const manifest = JSON.parse(input!);
        const pod = { ...manifest, metadata: { ...manifest.metadata, uid: `${manifest.metadata.name}-uid` },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
        pods.set(manifest.metadata.name, pod);
        created.push(manifest.metadata.name);
        return result(pod);
      }
      if (args[4] === 'wait') return result({});
      if (args[4] === 'get' && args[5] === 'pod') return result(pods.get(args[6]!));
      if (args[4] === 'get') return result(pods.get(args[5]!.slice(4)));
      throw new Error(`unexpected ${args.join(' ')}`);
    },
    fetch: async (url, init) => {
      if (new URL(String(url)).pathname === '/v1/resources') {
        const name = new URL(String(url)).searchParams.get('name')!;
        return Response.json({ resources: registered.has(name) ? [{ name, kind: 'pod-worker-lease',
          machine: 'test-host', observedAt: Date.now(), ttlMs: 1_800_000,
          attrs: { state: 'idle', podUid: registered.get(name), idleTtlMs: 1_800_000, key } }] : [] });
      }
      const body = JSON.parse(String(init?.body));
      registered.set(body.workerId, body.podUid);
      return Response.json({ name: body.workerId, attrs: { state: 'idle', podUid: body.podUid, key } });
    },
  });
  const occupancyLog = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm' && event === 'pool-occupancy') occupancyEvents.push({ event, data });
  }) as typeof debug.log);
  expect(await provider.reconcilePool()).toMatchObject({ target: 2, ready: 2, failed: [] });
  occupancyLog.mockRestore();
  expect(occupancyEvents).toHaveLength(1);
  expect(occupancyEvents[0]!.data).toMatchObject({ schema: 1, profile: 'fixed', host: 'test-host', tier: 'standard',
    candidateCount: 2, ready: 2, leased: 0, measured: true, runId: 'occupancy-run-1',
    consumer: 'warm-pod-provider', observedAt: expect.any(String) });
  expect(await provider.reconcilePool()).toMatchObject({ target: 2, ready: 2, failed: [] });
  expect(created).toEqual(['warm-test-host', 'warm-test-host-2']);
  const namespaceRows = [...pods.values()];
  const filler = pods.get('unrelated-0')!;
  const currentBytes = Buffer.byteLength(JSON.stringify(namespaceRows));
  filler.metadata.annotations.payload += 'x'.repeat(3_174_232 - currentBytes);
  expect(namespaceRows).toHaveLength(57);
  expect(Buffer.byteLength(JSON.stringify(namespaceRows))).toBe(3_174_232);
  expect(Buffer.byteLength(JSON.stringify({ kind: 'PodList', metadata: { continue: '' }, items: namespaceRows })))
    .toBeGreaterThan(2 * 1024 * 1024);
  expect(await provider.reconcilePool()).toMatchObject({ target: 2, ready: 2, failed: [] });
  expect([...pods.values()].filter(pod => pod.metadata.labels?.['elanous.kind'] === 'warm-worker').length).toBe(2);
  expect(listQueries.some(args => args.some(arg => arg.startsWith('--field-selector=metadata.name=')))).toBe(true);
  expect(listQueries.some(args => args.includes('-l') && args.includes('elanous.kind=warm-worker'))).toBe(true);
  expect(listQueries.some(args => args.includes('--limit=25'))).toBe(true);
  let attemptedCreates = 0;
  const incompleteProvider = newTestWarmPodProvider({ candidates: [candidates[0]!],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { [candidates[0]!.host]: '2'.repeat(64) },
    kubectl: args => {
      if (args[4] === 'get' && args[5] === 'pods' && args.some(arg => arg.startsWith('--field-selector=')))
        return result({ kind: 'PodList', metadata: {}, items: [] });
      if (args[4] === 'get' && args[5] === 'pods' && args.includes('-l')) {
        if (args.some(arg => arg.startsWith('--continue='))) return { status: 1, stdout: '', stderr: 'injected page failure' };
        return result({ kind: 'PodList', metadata: { continue: 'page-2' }, items: [] });
      }
      if (args[4] === 'create') attemptedCreates++;
      return { status: 1, stdout: '', stderr: 'unexpected kubectl' };
    },
  });
  const incompleteEvents: Array<{ event: string; data: unknown }> = [];
  const incompleteLog = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm' && event === 'warm-pod-list-skipped') incompleteEvents.push({ event, data });
  }) as typeof debug.log);
  try {
    expect(await incompleteProvider.reconcilePool()).toMatchObject({ target: 1, ready: 0,
      failed: [candidates[0]!.spec.workerId] });
    expect(incompleteEvents).toEqual([{ event: 'warm-pod-list-skipped', data: { reason: 'kubectl-failed' } }]);
  } finally { incompleteLog.mockRestore(); }
  expect(attemptedCreates).toBe(0);
  let missingMetadataCreates = 0;
  const missingMetadataProvider = newTestWarmPodProvider({ candidates: [candidates[0]!],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    kubectl: args => {
      if (args[4] === 'get' && args[5] === 'pods' && args.some(arg => arg.startsWith('--field-selector=')))
        return result({ kind: 'PodList', metadata: {}, items: [] });
      if (args[4] === 'get' && args[5] === 'pods' && args.includes('-l'))
        return result({ kind: 'PodList', items: [] });
      if (args[4] === 'create') missingMetadataCreates++;
      return { status: 1, stdout: '', stderr: 'unexpected kubectl' };
    },
    fetch: async () => { throw new Error('incomplete Pod page must fail before ledger access'); },
  });
  expect(await missingMetadataProvider.reconcilePool()).toMatchObject({ target: 1, ready: 0,
    failed: [candidates[0]!.spec.workerId] });
  expect(missingMetadataCreates).toBe(0);
  expect(() => newTestWarmPodProvider({ candidates: [candidates[0]!, candidates[0]!],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64) })).toThrow();
  expect(() => newTestWarmPodProvider({ candidates: Array.from({ length: 5 }, (_, index) => ({
    ...candidate, spec: { ...second, name: 'warm-test-host-' + (index + 1), workerId: 'test-host-uid-' + (index + 1) },
  })), controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64) })).toThrow('quota');
});

test('phase reconcile reports gate identity shortfall and keeps the target cold', async () => {
  const fixedNow = Date.parse('2026-11-07T19:05:00.000Z');
  const kubectlCalls: string[][] = [];
  const provider = newTestWarmPodProvider({ candidates: [{ ...candidate, kind: 'gate' }],
    profileConfig: { pod: { warmPoolProfile: 'gate' } }, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), now: () => fixedNow,
    kubectl: args => { kubectlCalls.push([...args]); return { status: 1, stdout: '', stderr: 'unexpected' }; },
    phasePrewarmForTest: { gateIdentity: { cutSha: 'd'.repeat(40), lockHash: 'f'.repeat(64) } },
    releaseSchedulesForTest: [{ version: '0.3.6', cutAt: '2026-11-07T19:30:00.000Z', publishAt: '2026-11-07T21:00:00.000Z', landBy: null, updatedAt: '', updatedBy: '' }] });
  const result = await provider.reconcilePool();
  expect(result.target).toBe(2);
  expect(result.ready).toBe(0);
  expect(result.failed).toContain('phase-gate-identity-mismatch:0/2');
  expect(kubectlCalls).toEqual([]);
});

test('phase reconcile reports an unconfirmed implementation Pod retirement', async () => {
  const fixedNow = Date.parse('2026-11-07T19:05:00.000Z');
  const provider = newTestWarmPodProvider({ candidates: [{ ...candidate, kind: 'implementation' }],
    profileConfig: { pod: { warmPoolProfile: 'gate' } }, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), now: () => fixedNow,
    phasePrewarmForTest: { targets: { normal: { gate: 0, implementation: 0 } },
      gateIdentity: { cutSha: spec.cutSha, lockHash: spec.key.lockHash } }, releaseSchedulesForTest: [] });
  const result = await provider.reconcilePool();
  expect(result.target).toBe(0);
  expect(result.ready).toBe(0);
  expect(result.failed).toContain('phase-retire-unconfirmed:warm-test-1-uid');
});

test('phase reconcile reports a thrown UID-pinned retirement attempt', async () => {
  const fixedNow = Date.parse('2026-11-07T19:05:00.000Z');
  const provider = newTestWarmPodProvider({ candidates: [{ ...candidate, kind: 'implementation' }],
    profileConfig: { pod: { warmPoolProfile: 'gate' } }, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) },
    rotationStatePath: '/tmp/pod-phase-prewarm-rotations-test', now: () => fixedNow,
    kubectl: () => { throw new Error('injected-retire-boundary-failure'); },
    phasePrewarmForTest: { targets: { normal: { gate: 0, implementation: 0 } },
      gateIdentity: { cutSha: spec.cutSha, lockHash: spec.key.lockHash } }, releaseSchedulesForTest: [] });
  const result = await provider.reconcilePool();
  expect(result.failed).toContain('phase-retire-unconfirmed:warm-test-1-uid');
});

test('assembled same-host templates reassign the spare implementation slot to the cut gate', async () => {
  const typedConfig = { pod: { ...warmPoolAssemblerInput().config.pod,
    warmPool: { ...warmPoolAssemblerInput().config.pod.warmPool,
      templates: [
        { host: 'gcp1', tier: 'standard', nodeName: 'gcp1-node', kind: 'gate' },
        { host: 'gcp1', tier: 'standard', nodeName: 'gcp1-node', kind: 'implementation' },
      ] } },
    harness: { imageCommit: spec.cutSha, podPool: 'gcp1-context' } };
  const assembled = assembleWarmPoolProviderConfig({ config: typedConfig,
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64), machineTokens: { gcp1: '2'.repeat(64) },
    machinePools: [{ purpose: 'gate', fanoutGroupId: 'gate-v1', members: [{ host: 'gcp1', count: 2,
      digest: `sha256:${'d'.repeat(64)}`, role: 'both' }], fanoutGroup: { shard: { kind: 'gate', input: 'gate-shard',
      result: 'gate-result', fingerprint: 'runtime-env' } }, fingerprint: { runtime: 'bun-test', environment: 'linux', skillPacks: [] },
      cleanup: { procedure: 'clean-v1', verify: 'verify-v1' } }] });
  const provider = newTestWarmPodProvider({ ...assembled, now: () => Date.parse('2026-11-07T19:05:00.000Z'),
    kubectl: () => { throw new Error('simulated-prewarm-failure'); },
    phasePrewarmForTest: { gateIdentity: { cutSha: spec.cutSha, lockHash: 'e'.repeat(64) } },
    releaseSchedulesForTest: [{ version: '0.3.6', cutAt: '2026-11-07T19:30:00.000Z',
      publishAt: '2026-11-07T21:00:00.000Z', landBy: null, updatedAt: '', updatedBy: '' }] });
  let phaseEvent: Record<string, unknown> | undefined;
  const phaseLog = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'task-orchestrator.pod-phase' && event === 'reconcile') phaseEvent = data as Record<string, unknown>;
  }) as typeof debug.log);
  const result = await provider.reconcilePool();
  phaseLog.mockRestore();
  expect(result.target).toBe(2);
  expect(result.ready).toBe(0);
  expect(result.failed).toHaveLength(2);
  expect(result.failed.some(reason => reason.startsWith('phase-target-unmet:gate:'))).toBe(false);
  expect(phaseEvent).toMatchObject({ phase: 'cut-gate', target: { gate: 2, implementation: 0 },
    actual: { gate: 0, implementation: 0 } });
});

test('phase reconcile persists a cold fence when schedule lookup fails, including existing gate candidates', async () => {
  const fixedNow = Date.parse('2026-11-07T19:05:00.000Z');
  const root = mkdtempSync(join(tmpdir(), 'warm-provider-phase-fence-'));
  const phaseFenceStatePath = join(root, 'provider.phase-fence');
  const kubectlCalls: string[][] = [];
  let controlCalls = 0;
  const options: WarmPodProviderOptions = { candidates: [{ ...candidate, kind: 'gate' }],
    profileConfig: { pod: { warmPoolProfile: 'gate' } }, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), now: () => fixedNow, scheduleLookupErrorForTest: true,
    phaseFenceStatePath,
    kubectl: args => { kubectlCalls.push([...args]); return { status: 1, stdout: '', stderr: 'unexpected' }; },
    fetch: async () => { controlCalls++; return Response.json({ resources: [] }); },
    phasePrewarmForTest: { gateIdentity: { cutSha: spec.cutSha, lockHash: spec.key.lockHash } } };
  const provider = newTestWarmPodProvider(options);
  const result = await provider.reconcilePool();
  expect(result.target).toBe(1);
  expect(result.ready).toBe(0);
  expect(result.failed).toContain('phase-schedule-unavailable:cold-fallback');
  expect(result.failed).toContain('phase-target-unmet:implementation:0/1');
  expect(kubectlCalls).toEqual([]);
  expect(result.failed).toContain(`phase-retire-unconfirmed:${spec.workerId}`);
  // Simulate the separate replay process loading the same warm config after an
  // existing gate Pod's retire was not confirmed. The candidate matcher honors
  // its durable eligibility fence before it can consult the existing lease.
  const replayProvider = newTestWarmPodProvider(options);
  expect(await replayProvider.request(input())).toEqual({ command: null,
    transport: { status: 'fallback', reason: 'no-candidate', reply: null } });
  expect(controlCalls).toBe(0);
  expect(kubectlCalls).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test('replay revalidates the current cut and lock identity before using a gate candidate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-provider-phase-identity-'));
  const phaseFenceStatePath = join(root, 'provider.phase-fence');
  writeFileSync(phaseFenceStatePath, JSON.stringify({ schema: 1, workerIds: [] }), { mode: 0o600 });
  let controlCalls = 0;
  const provider = newTestWarmPodProvider({ candidates: [{ ...candidate, kind: 'gate' }],
    profileConfig: { pod: { warmPoolProfile: 'gate' } }, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), now: () => Date.parse('2026-11-07T19:05:00.000Z'),
    phaseFenceStatePath,
    phasePrewarmForTest: { gateIdentity: { cutSha: spec.cutSha, lockHash: 'e'.repeat(64) } },
    releaseSchedulesForTest: [{ version: '0.3.6', cutAt: '2026-11-07T19:30:00.000Z',
      publishAt: '2026-11-07T21:00:00.000Z', landBy: null, updatedAt: '', updatedBy: '' }],
    fetch: async () => { controlCalls++; return Response.json({ resources: [lease()] }); } });
  expect(await provider.request(input())).toEqual({ command: null,
    transport: { status: 'fallback', reason: 'no-candidate', reply: null } });
  expect(controlCalls).toBe(0);
  rmSync(root, { recursive: true, force: true });
});

test('phase fence persistence failure prevents prewarm and leaves replay cold', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-provider-phase-fence-write-fail-'));
  const kubectlCalls: string[][] = [];
  try {
    const options: WarmPodProviderOptions = { candidates: [{ ...candidate, kind: 'gate' }],
      profileConfig: { pod: { warmPoolProfile: 'gate' } }, controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), now: () => Date.parse('2026-11-07T19:05:00.000Z'),
      phaseFenceStatePath: root, phasePrewarmForTest: { gateIdentity: { cutSha: spec.cutSha, lockHash: spec.key.lockHash } },
      releaseSchedulesForTest: [{ version: '0.3.6', cutAt: '2026-11-07T19:30:00.000Z',
        publishAt: '2026-11-07T21:00:00.000Z', landBy: null, updatedAt: '', updatedBy: '' }],
      kubectl: args => { kubectlCalls.push([...args]); return { status: 1, stdout: '', stderr: 'unexpected' }; } };
    const provider = newTestWarmPodProvider(options);
    const result = await provider.reconcilePool();
    expect(result.ready).toBe(0);
    expect(result.failed.some(reason => reason.startsWith('phase-fence-state-unavailable:'))).toBe(true);
    expect(await provider.request(input())).toEqual({ command: null,
      transport: { status: 'fallback', reason: 'no-candidate', reply: null } });
    const replayWithoutState = newTestWarmPodProvider({ ...options, phaseFenceStatePath: undefined });
    expect(await replayWithoutState.request(input())).toEqual({ command: null,
      transport: { status: 'fallback', reason: 'no-candidate', reply: null } });
    expect(kubectlCalls).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pool occupancy is unmeasured when the lease row is absent or belongs to an older Pod UID', async () => {
  const currentPodUid = 'current-pod-uid';
  const manifest = warmWorkerPodManifest(spec);
  const podMetadata = manifest.metadata as Record<string, unknown>;
  const pod = { ...manifest, metadata: { ...podMetadata, uid: currentPodUid },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
  for (const ledgerCase of ['missing', 'stale-uid'] as const) {
    const events: any[] = [];
    const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) },
      observationRunIdForTest: `occupancy-${ledgerCase}`,
      kubectl: args => {
        if (args[4] === 'get' && args[5] === 'pods') return { status: 0,
          stdout: JSON.stringify({ kind: 'PodList', metadata: {}, items: [pod] }), stderr: '' };
        if (args[4] === 'get' && args[5] === 'pod' && args[6] === spec.name)
          return { status: 0, stdout: JSON.stringify(pod), stderr: '' };
        if (args[4] === 'wait') return { status: 0, stdout: '', stderr: '' };
        throw new Error(`unexpected ${args.join(' ')}`);
      },
      fetch: async () => Response.json({ resources: ledgerCase === 'missing' ? [] : [{
        name: spec.workerId, kind: 'pod-worker-lease', machine: 'test-host', observedAt: Date.now(), ttlMs: 1_800_000,
        attrs: { state: 'idle', podUid: 'previous-pod-uid', idleTtlMs: 1_800_000, key },
      }] }),
    });
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      if (category === 'pod.warm' && event === 'pool-occupancy') events.push(data);
    }) as typeof debug.log);
    try {
      expect(await provider.reconcilePool()).toMatchObject({ target: 1, ready: 0, failed: [spec.workerId] });
    } finally { log.mockRestore(); }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ candidateCount: 1, ready: null, leased: null,
      measured: false, runId: `occupancy-${ledgerCase}`, reason: 'occupancy-incomplete' });
  }
});

test('reconcile reaps only proven quarantined Pods, rotates IDs persistently, and restores target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-reap-'));
  let apiServer: ReturnType<typeof Bun.serve> | undefined;
  try {
    const candidates = Array.from({ length: 3 }, (_, index) => ({ ...candidate, spec: {
      ...spec, name: `warm-test-host-standard-${index + 1}`, workerId: `generation-${index + 1}`,
      nodeName: 'pool-test-host-server-0',
    } }));
    const originalIds = candidates.map(row => row.spec.workerId);
    const pods = new Map<string, any>();
    const ledger = new Map<string, any>();
    const deleted: string[] = [];
    const deleteBodies: unknown[] = [];
    const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
    for (const [index, row] of candidates.entries()) {
      const manifest = warmWorkerPodManifest(row.spec);
      const uid = `pod-uid-${index + 1}`;
      pods.set(row.spec.name, { ...manifest, metadata: { ...(manifest.metadata as Record<string, unknown>), uid,
        resourceVersion: '1' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } });
      ledger.set(row.spec.workerId, { id: `pod-worker-lease:${row.spec.workerId}`, kind: 'pod-worker-lease',
        machine: 'test-host', name: row.spec.workerId, observedAt: Date.now(), ttlMs: 1_800_000,
        attrs: { state: index < 2 ? 'quarantined' : 'leased', podUid: uid, idleTtlMs: 1_800_000, key } });
    }
    for (let index = 0; index < 56; index++) pods.set(`unrelated-warm-${index + 1}`, { kind: 'Pod', metadata: {
      name: `unrelated-warm-${index + 1}`, namespace: spec.namespace, uid: `unrelated-uid-${index + 1}`,
      labels: { 'elanous.kind': 'warm-worker' }, annotations: { payload: 'x'.repeat(60_000) },
    }, spec: { nodeName: 'other-node' } });
    expect(Buffer.byteLength(JSON.stringify([...pods.values()]))).toBeGreaterThan(2 * 1024 * 1024);
    const podListCalls: string[][] = [];
    const kubectl = (args: readonly string[], input?: string) => {
      const verb = args[4]!;
      if (verb === 'get' && args[5] === 'pods') {
        podListCalls.push([...args]);
        const fieldSelector = args.find(arg => arg.startsWith('--field-selector='));
        if (fieldSelector) {
          const rows = [...pods.values()].filter(pod => pod.metadata.name === fieldSelector.slice('--field-selector=metadata.name='.length));
          return result({ metadata: {}, items: rows });
        }
        const allWarm = [...pods.values()].filter(pod => pod.metadata.labels?.['elanous.kind'] === 'warm-worker');
        const pageToken = args.find(arg => arg.startsWith('--continue='))?.split('=')[1];
        const offset = pageToken ? Number(pageToken.slice('page-'.length)) * 25 : 0;
        const rows = allWarm.slice(offset, offset + 25);
        const next = offset + rows.length < allWarm.length ? `page-${offset / 25 + 1}` : '';
        return result({ metadata: { continue: next }, items: rows });
      }
      if (verb === 'get') return result(pods.get(args[5] === 'pod' ? args[6]! : args[5]!.slice('pod/'.length)));
      if (verb === 'create') {
        const manifest = JSON.parse(input!);
        const pod = { ...manifest, metadata: { ...manifest.metadata, uid: `replacement-${manifest.metadata.name}`,
          resourceVersion: '1' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
        pods.set(manifest.metadata.name, pod);
        return result(pod);
      }
      if (verb === 'wait') return result({});
      throw new Error(`unexpected kubectl ${args.join(' ')}`);
    };
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/v1/resources') {
        const name = parsed.searchParams.get('name');
        const rows = [...ledger.values()].filter(row => !name || row.name === name);
        return Response.json({ resources: rows });
      }
      const reap = parsed.pathname.match(/^\/v1\/leases\/pod-worker\/([^/]+)\/reap$/);
      if (reap) {
        const worker = decodeURIComponent(reap[1]!);
        const body = JSON.parse(String(init?.body));
        const row = ledger.get(worker);
        if (!row || row.attrs.podUid !== body.podUid || !['quarantined', 'timeout-fenced', 'reaping'].includes(row.attrs.state)
          || [...ledger.values()].some(other => other !== row && other.attrs.podUid === body.podUid))
          return new Response('{}', { status: 409 });
        row.attrs.state = 'reaping';
        return Response.json(row);
      }
      if (parsed.pathname === '/v1/workers/pod') {
        const body = JSON.parse(String(init?.body));
        const row = { id: `pod-worker-lease:${body.workerId}`, kind: 'pod-worker-lease', machine: 'test-host',
          name: body.workerId, observedAt: Date.now(), ttlMs: 1_800_000,
          attrs: { state: 'idle', podUid: body.podUid, idleTtlMs: 1_800_000, key } };
        ledger.set(body.workerId, row);
        return Response.json({ name: body.workerId, attrs: row.attrs });
      }
      throw new Error(`unexpected control request ${parsed.pathname}`);
    };
    apiServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const path = new URL(request.url).pathname;
      if (request.method !== 'DELETE' || !path.startsWith(`/api/v1/namespaces/${spec.namespace}/pods/`))
        return new Response('{}', { status: 404 });
      const name = decodeURIComponent(path.split('/').at(-1)!);
      const body = await request.json() as any;
      deleteBodies.push(body);
      const current = pods.get(name);
      if (!current || body?.apiVersion !== 'v1' || body?.kind !== 'DeleteOptions'
        || body?.preconditions?.uid !== current.metadata.uid)
        return Response.json({ reason: 'Conflict' }, { status: 409 });
      deleted.push(name);
      pods.delete(name);
      return Response.json({ kind: 'Status', status: 'Success' });
    } });
    const statePath = join(root, 'rotations.json');
    const options = { candidates, profileConfig: { pod: { warmPoolProfile: 'gate' } },
      rotationStatePath: statePath, controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), machineTokens: { ['test-host']: '2'.repeat(64) }, kubectl,
      kubectlProxyUrlForTest: `http://127.0.0.1:${apiServer.port}`,
      kubernetesFetch: globalThis.fetch,
      fetch: fetch as typeof globalThis.fetch };
    const provider = newTestWarmPodProvider(options as any);
    const reconciled = await provider.reconcilePool();
    expect(deleted).toEqual(['warm-test-host-standard-1', 'warm-test-host-standard-2']);
    expect(podListCalls.every(args => args.some(arg => arg.startsWith('--field-selector=metadata.name='))
      || (args.includes('-l') && args.includes('elanous.kind=warm-worker')))).toBe(true);
    expect(podListCalls.filter(args => args.includes('-l')).every(args => args.includes('--limit=25'))).toBe(true);
    expect(deleteBodies).toEqual([
      { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'pod-uid-1' } },
      { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'pod-uid-2' } },
    ]);
    expect(await (provider as any).deletePodWithUid(candidates[0]!.spec, 'stale-pod-uid')).toBe(false);
    expect(pods.has(candidates[0]!.spec.name)).toBe(true);
    expect(pods.has('warm-test-host-standard-3')).toBe(true);
    expect(reconciled).toMatchObject({ target: 3, ready: 3, failed: [] });
    expect(candidates.map(row => row.spec.workerId)).toEqual(originalIds);
    const currentCandidates = (provider as any).candidates as WarmWorkerCandidate[];
    expect(currentCandidates.slice(0, 2).every((row, index) => row.spec.workerId !== originalIds[index])).toBe(true);
    expect(originalIds.slice(0, 2).map(id => ledger.get(id)?.attrs?.state)).toEqual(['reaping', 'reaping']);
    const restartCandidates = candidates.map((row, index) => ({ ...row,
      spec: { ...row.spec, workerId: originalIds[index]! } }));
    const restored = newTestWarmPodProvider({ ...options, candidates: restartCandidates } as any);
    expect(restartCandidates.map(row => row.spec.workerId)).toEqual(originalIds);
    const restoredCandidates = (restored as any).candidates as WarmWorkerCandidate[];
    expect(restoredCandidates.slice(0, 2).map(row => row.spec.workerId)).toEqual(currentCandidates.slice(0, 2).map(row => row.spec.workerId));
    expect(await restored.reconcilePool()).toMatchObject({ target: 3, ready: 3, failed: [] });
    const rotations = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(rotations['test-host/warm-test-host-standard-1']).toBe(currentCandidates[0]!.spec.workerId);
    expect(rotations['test-host/warm-test-host-standard-2']).toBe(currentCandidates[1]!.spec.workerId);
  } finally { apiServer?.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test('a quarantined Pod is preserved when a lease on another machine references its UID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-reap-cross-machine-'));
  try {
    const pinned = { ...candidate, spec: { ...spec, name: 'warm-test-host-standard-1', workerId: 'worker-quarantine',
      nodeName: 'pool-test-host-server-0' } };
    const manifest = warmWorkerPodManifest(pinned.spec);
    const pod = { ...manifest, metadata: { ...(manifest.metadata as Record<string, unknown>), uid: 'shared-pod-uid', resourceVersion: '1' },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
    const rows = [
      { kind: 'pod-worker-lease', machine: 'test-host', name: pinned.spec.workerId,
        attrs: { state: 'quarantined', podUid: 'shared-pod-uid' } },
      { kind: 'pod-worker-lease', machine: 'other-host', name: 'other-worker',
        attrs: { state: 'leased', podUid: 'shared-pod-uid' } },
    ];
    let deleteCalls = 0;
    const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
    const provider = newTestWarmPodProvider({ candidates: [pinned], profileConfig: { pod: { warmPoolProfile: 'gate' } },
      rotationStatePath: join(root, 'rotations.json'), controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), machineTokens: { ['test-host']: '2'.repeat(64) },
      kubectl: args => {
        if (args[4] === 'get' && args[5] === 'pods') return result({ metadata: {}, items: [pod] });
        if (args[4] === 'get') return result(pod);
        throw new Error(`unexpected kubectl ${args.join(' ')}`);
      },
      kubernetesFetch: (async () => { deleteCalls++; return Response.json({ status: 'Success' }); }) as unknown as typeof fetch,
      fetch: async url => {
        const query = new URL(String(url)).searchParams;
        return Response.json({ resources: rows.filter(row => !query.has('name') || row.name === query.get('name')) });
      },
    });
    expect(await provider.reconcilePool()).toMatchObject({ target: 1, ready: 0, failed: ['worker-quarantine'] });
    expect(deleteCalls).toBe(0);
    expect(pod.metadata.uid).toBe('shared-pod-uid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a stalled reap ledger read fails closed within a bounded reconciliation pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-reap-ledger-timeout-'));
  try {
    const pinned = { ...candidate, spec: { ...spec, name: 'warm-test-host-standard-1', workerId: 'worker-stalled-ledger',
      nodeName: 'pool-test-host-server-0' } };
    const manifest = warmWorkerPodManifest(pinned.spec);
    const pod = { ...manifest, metadata: { ...(manifest.metadata as Record<string, unknown>), uid: 'stalled-ledger-pod', resourceVersion: '1' },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
    const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
    const provider = newTestWarmPodProvider({ candidates: [pinned], profileConfig: { pod: { warmPoolProfile: 'gate' } },
      rotationStatePath: join(root, 'rotations.json'), controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), machineTokens: { ['test-host']: '2'.repeat(64) },
      kubectl: args => {
        if (args[4] === 'get' && args[5] === 'pods') return result({ metadata: {}, items: [pod] });
        if (args[4] === 'get') return result(pod);
        if (args[4] === 'wait') return result({});
        throw new Error(`unexpected kubectl ${args.join(' ')}`);
      },
      fetch: async () => new Promise<Response>(() => {}),
    });
    const startedAt = Date.now();
    expect(await provider.reconcilePool()).toMatchObject({ target: 1, ready: 0, failed: ['worker-stalled-ledger'] });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('warm Pod discovery failures emit one redacted reason and never create a Pod', async () => {
  const failureCandidate = { ...candidate, spec: { ...spec, name: 'warm-test-host', nodeName: 'pool-test-host-server-0' } };
  const ok = () => ({ status: 0, stdout: JSON.stringify({ kind: 'PodList', metadata: {}, items: [] }), stderr: '' });
  const enobufs = () => Object.assign(new Error('secret-token'), { code: 'ENOBUFS' });
  const cases: Array<{ stage: 'named' | 'list'; reason: string; response: () => any }> = [
    { stage: 'named', reason: 'kubectl-failed', response: () => ({ status: 1, stdout: '', stderr: 'secret-token' }) },
    { stage: 'named', reason: 'malformed-output', response: () => ({ status: 0, stdout: '{bad json', stderr: '' }) },
    { stage: 'list', reason: 'kubectl-failed', response: () => ({ status: 1, stdout: '', stderr: 'secret-token' }) },
    { stage: 'list', reason: 'malformed-output', response: () => ({ status: 0, stdout: '{bad json', stderr: '' }) },
    { stage: 'list', reason: 'output-too-large', response: () => { throw enobufs(); } },
    { stage: 'list', reason: 'output-too-large', response: () => ({ status: null, stdout: '', stderr: '', error: enobufs() }) },
  ];
  const events: Array<{ event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm' && event === 'warm-pod-list-skipped') events.push({ event, data });
  }) as typeof debug.log);
  try {
    for (const scenario of cases) {
      events.length = 0;
      let creates = 0;
      const provider = newTestWarmPodProvider({ candidates: [failureCandidate],
        controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
        machineTokens: { [failureCandidate.host]: '2'.repeat(64) },
        kubectl: args => {
          const isNamed = args[4] === 'get' && args.some(arg => arg.startsWith('--field-selector=metadata.name='));
          const isList = args[4] === 'get' && args.includes('-l') && args.includes('elanous.kind=warm-worker');
          if ((scenario.stage === 'named' && isNamed) || (scenario.stage === 'list' && isList))
            return scenario.response();
          if (isNamed || isList) return ok();
          if (args[4] === 'create') creates++;
          return { status: 1, stdout: '', stderr: '' };
        },
        fetch: async () => { throw new Error('discovery failure must stop before ledger access'); },
      });
      expect(await provider.ensureStandingWorker(failureCandidate)).toBe(false);
      expect(creates).toBe(0);
      expect(events).toEqual([{ event: 'warm-pod-list-skipped', data: { reason: scenario.reason } }]);
      expect(JSON.stringify(events)).not.toContain('secret-token');
    }
  } finally { log.mockRestore(); }
});

test('a pool template defaults to one candidate unless quota expansion is opted in', async () => {
  const template = { ...candidate, spec: { ...spec, name: 'warm-test-host-standard-template',
    workerId: 'generation-20261022', nodeName: 'pool-test-host-server-0' } };
  const provider = newTestWarmPodProvider({ candidates: [], poolTemplates: [template],
    profileConfig: { pod: { warmPoolProfile: 'gate' } },
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64) });
  const names: string[] = [];
  const ids: string[] = [];
  const prepare = spyOn(provider, 'ensureStandingWorker').mockImplementation(async row => {
    names.push(row.spec.name); ids.push(row.spec.workerId); return true;
  });
  (provider as any).readClusterQuarantineState = () => 'available';
  try {
    expect(await provider.reconcilePool()).toMatchObject({ profile: 'gate', target: 1, ready: 1, failed: [] });
    expect(names).toEqual(['warm-test-host-standard-1']);
    expect(ids).toEqual(['generation-20261022-standard-1']);
  } finally { prepare.mockRestore(); }
});

test('explicitly opting in expands a pool template to its measured quota', async () => {
  const host = 'gate-host-a';
  const template = { host, tier: 'standard' as const, spec: { ...spec, name: 'unused-template',
    workerId: 'generation-20261022', kubectlContext: host, nodeName: 'pool-gate-host-a-server-0',
    key: { ...key, context: 'pool-gate-host-a' } } };
  const provider = newTestWarmPodProvider({ candidates: [], poolTemplates: [template], expandPoolTemplatesToQuota: true,
    profileConfig: { pod: { warmPoolProfile: 'gate' } },
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    quotaResolverForTest: (_profile, candidateHost, tier) => candidateHost === host && tier === 'standard' ? 4 : 0 });
  const names: string[] = [];
  const ids: string[] = [];
  const prepare = spyOn(provider, 'ensureStandingWorker').mockImplementation(async row => {
    names.push(row.spec.name); ids.push(row.spec.workerId); return true;
  });
  (provider as any).readClusterQuarantineState = () => 'available';
  try {
    expect(await provider.reconcilePool()).toMatchObject({ profile: 'gate', target: 4, ready: 4, failed: [] });
    expect(names).toEqual(['warm-gate-host-a-standard-1', 'warm-gate-host-a-standard-2',
      'warm-gate-host-a-standard-3', 'warm-gate-host-a-standard-4']);
    expect(ids).toEqual(['generation-20261022-standard-1', 'generation-20261022-standard-2',
      'generation-20261022-standard-3', 'generation-20261022-standard-4']);
  } finally { prepare.mockRestore(); }
});

test('explicit template expansion refuses a target beyond the measured quota before Pod work', () => {
  let kubectlCalls = 0;
  expect(() => newTestWarmPodProvider({ candidates: [candidate],
    poolTemplates: [{ ...candidate, spec: { ...spec, name: 'unused-template', workerId: 'generation-20261022',
      nodeName: 'pool-test-host-server-0' } }], expandPoolTemplatesToQuota: true,
    profileConfig: { pod: { warmPoolProfile: 'gate' } }, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), kubectl: () => { kubectlCalls++; return { status: 0, stdout: '{}', stderr: '' }; },
  })).toThrow('warm candidate quota exceeded');
  expect(kubectlCalls).toBe(0);
});

test('declared template slots cannot bypass quota or double-count one host across tiers', () => {
  const template = { host: 'test-host', tier: 'standard' as const, slotCount: 5,
    spec: { ...spec, name: 'standard-template', workerId: 'standard-generation', nodeName: 'test-host-server-0' } };
  expect(() => newTestWarmPodProvider({ candidates: [], poolTemplates: [template],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64), quotaResolverForTest: () => 2 })).toThrow('warm candidate quota exceeded');
  expect(() => newTestWarmPodProvider({ candidates: [], poolTemplates: [
    { ...template, slotCount: 2 }, { ...template, tier: 'lite' as const, slotCount: 1, spec: { ...spec, name: 'lite-template', workerId: 'lite-generation', nodeName: 'test-host-server-0' } },
  ], controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64), quotaResolverForTest: (_profile, _host, tier) => tier === 'standard' ? 2 : 1 })).toThrow('warm candidate quota exceeded');
});

test('an unmeasured template quota fails closed before Pod work even with declared slots', () => {
  let kubectlCalls = 0;
  const template = { host: 'unmeasured-host', tier: 'standard' as const, slotCount: 1,
    spec: { ...spec, name: 'unmeasured-template', workerId: 'generation-20261022', nodeName: 'pool-test-host-server-0' } };
  expect(() => newTestWarmPodProvider({ candidates: [], poolTemplates: [template], expandPoolTemplatesToQuota: true,
    profileConfig: { pod: { warmPoolProfile: 'gate' } }, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), quotaResolverForTest: () => undefined as unknown as number,
    kubectl: () => { kubectlCalls++; return { status: 0, stdout: '{}', stderr: '' }; },
  })).toThrow('unmeasured warm pool template');
  expect(kubectlCalls).toBe(0);
});

test('reconcile records a bounded pod-list output-limit decision without secrets', async () => {
  const events: Array<{ category: string; event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm' || category === 'pod.warm.provider') events.push({ category, event, data });
  }) as typeof debug.log);
  const pinned = { ...candidate, spec: { ...spec, name: 'warm-test-host-standard-1',
    workerId: 'failure-list-worker', nodeName: 'pool-test-host-server-0' } };
  try {
    const provider = newTestWarmPodProvider({ candidates: [pinned], profileConfig: { pod: { warmPoolProfile: 'gate' } },
      controlUrl: 'http://127.0.0.1:31413/', memberToken: 'a'.repeat(64),
      machineTokens: { ['test-host']: 'b'.repeat(64) },
      kubectl: args => args.includes('-l')
        ? { status: null, stdout: '', stderr: 'maxBuffer length exceeded 3.17MB token=machine-secret-value' }
        : { status: 0, stdout: '{"items":[]}', stderr: '' },
    });
    await provider.reconcilePool();
    const decision = events.find(row => row.category === 'pod.warm' && row.event === 'pool-reconcile-decision')?.data;
    expect(decision).toMatchObject({ workerId: 'failure-list-worker', stage: 'pod-label-page', reason: 'kubectl-output-limit' });
    expect(decision.stderr).toContain('[REDACTED]');
    expect(decision.stderr).not.toContain('machine-secret-value');
    expect(decision.stderr.length).toBeLessThanOrEqual(512);
    const refusal = events.find(row => row.category === 'pod.warm.provider' && row.event === 'prepare-refused')?.data;
    expect(refusal).toEqual({ reason: 'kubectl-output-limit', host: 'test-host', slot: 'failure-list-worker' });
  } finally { log.mockRestore(); }
});

test('request cannot bypass a phase target selected for another cut', async () => {
  const otherCut = { ...candidate, spec: { ...spec, name: 'warm-a-other-cut', workerId: 'warm-a-other-cut',
    cutSha: 'd'.repeat(40) } };
  const requestedCut = { ...candidate, spec: { ...spec, name: 'warm-b-request-cut', workerId: 'warm-b-request-cut' } };
  let leaseCalls = 0;
  const provider = newTestWarmPodProvider({ candidates: [requestedCut, otherCut],
    phaseSchedule: { steadyTargets: { gate: 1, implementation: 0 }, windows: [] },
    now: () => 10_000, controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: (args, body) => {
      if (args[4] === 'get' && args[5] === 'pods') return { status: 0,
        stdout: JSON.stringify({ kind: 'PodList', metadata: { continue: '' }, items: [] }), stderr: '' };
      if (args[4] === 'create') {
        return { status: 1, stdout: '', stderr: 'injected create refusal' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected kubectl' };
    },
    fetch: async url => {
      if (new URL(String(url)).pathname === '/v1/leases/pod-worker') leaseCalls++;
      return Response.json({ resources: [] });
    },
  });
  expect(await provider.reconcilePool()).toMatchObject({ target: 1, ready: 0, failed: [otherCut.spec.workerId] });
  expect(await provider.request(input(), gateSelection())).toEqual({ command: null,
    transport: { status: 'fallback', reason: 'no-candidate', reply: null } });
  expect(leaseCalls).toBe(0);
});

test('a failed gate prewarm stays unavailable through the matching gate window and records the cold fallback reason', async () => {
  const gateStart = 30_000_000;
  let nowMs = gateStart - 30 * 60_000;
  let leaseCalls = 0;
  const phaseEvents: Array<{ event: string; data: any }> = [];
  const prepareFailures: Array<{ reason?: string }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'task-orchestrator.pod-phase') phaseEvents.push({ event, data });
    if (category === 'pod.warm' && event === 'pool-reconcile-decision') prepareFailures.push(data as { reason?: string });
  }) as typeof debug.log);
  const gateCandidate: WarmWorkerCandidate = { ...candidate, kind: 'gate', spec: { ...spec,
    name: 'prewarm-failure-gate', workerId: 'prewarm-failure-gate', cutSha: 'a'.repeat(40),
    image: `registry.example/elanous@sha256:${'c'.repeat(64)}`,
    key: { ...key, lockHash: 'b'.repeat(64), imageDigest: `sha256:${'c'.repeat(64)}` } } };
  const provider = newTestWarmPodProvider({ candidates: [gateCandidate],
    phaseSchedule: { steadyTargets: { gate: 1, implementation: 0 }, windows: [{ phase: 'gate',
      startAtMs: gateStart, endAtMs: gateStart + 60 * 60_000, targets: { gate: 1, implementation: 0 },
      cutSha: 'a'.repeat(40), lockHash: 'b'.repeat(64), imageDigest: `sha256:${'c'.repeat(64)}` }] },
    now: () => nowMs, controlUrl: 'http://127.0.0.1:31413/', memberToken: 'a'.repeat(64),
    machineTokens: { ['test-host']: 'b'.repeat(64) },
    kubectl: args => args.includes('-l')
      ? { status: null, stdout: '', stderr: 'maxBuffer length exceeded 3.17MB' }
      : { status: 0, stdout: '{"items":[]}', stderr: '' },
    fetch: async () => { leaseCalls++; return Response.json({ resources: [] }); },
  });
  try {
    const reconcile = await provider.reconcilePool();
    expect(reconcile.failed).toContain('prewarm-failure-gate');
    nowMs = gateStart;
    expect(await provider.request(input(), { ...gateSelection(gateCandidate.spec.key) })).toEqual({ command: null,
      transport: { status: 'fallback', reason: 'no-candidate', reply: null } });
    expect(leaseCalls).toBe(0);
    const fallbackEvent = phaseEvents.find(row => row.event === 'cold-fallback')?.data;
    expect(fallbackEvent).toMatchObject({ phase: 'gate', runId: 'run-1' });
    expect(fallbackEvent.reason).toBe(prepareFailures[0]?.reason);
    expect(fallbackEvent.reason).toBeTruthy();
  } finally { log.mockRestore(); }
});

test('reconcile records a redacted kubectl create denial decision', async () => {
  const events: Array<{ event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm') events.push({ event, data });
  }) as typeof debug.log);
  const pinned = { ...candidate, spec: { ...spec, name: 'warm-test-host-standard-1',
    workerId: 'failure-create-worker', nodeName: 'pool-test-host-server-0' } };
  try {
    const provider = newTestWarmPodProvider({ candidates: [pinned], profileConfig: { pod: { warmPoolProfile: 'gate' } },
      controlUrl: 'http://127.0.0.1:31413/', memberToken: 'a'.repeat(64),
      machineTokens: { ['test-host']: 'b'.repeat(64) },
      kubectl: args => args[4] === 'get'
        ? { status: 0, stdout: '{"metadata":{},"items":[]}', stderr: '' }
        : { status: 1, stdout: '', stderr: `admission denied token=${'b'.repeat(64)} authorization: Bearer abcdef123456` },
      fetch: async () => Response.json({ resources: [] }),
    });
    await provider.reconcilePool();
    const decision = events.find(row => row.event === 'pool-reconcile-decision')?.data;
    expect(decision).toMatchObject({ workerId: 'failure-create-worker', stage: 'pod-create', reason: 'kubectl-create-denied' });
    expect(decision.stderr).toContain('admission denied');
    expect(decision.stderr).not.toContain('b'.repeat(64));
    expect(decision.stderr).not.toContain('abcdef123456');
  } finally { log.mockRestore(); }
});

test('a 57-Pod 3.17MB warm-worker set is read in bounded label pages around one exact candidate', async () => {
  const pinned = { ...candidate, spec: { ...spec, name: 'warm-test-host-standard-1',
    workerId: 'paged-list-worker', nodeName: 'pool-test-host-server-0' } };
  const manifest = warmWorkerPodManifest(pinned.spec);
  const pod = { ...manifest,
    metadata: { ...(manifest.metadata as Record<string, unknown>), uid: 'paged-list-uid', resourceVersion: '1' },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
  const extras = Array.from({ length: 56 }, (_, index) => ({ metadata: {
    name: `other-warm-${index + 1}`, namespace: spec.namespace, uid: `other-uid-${index + 1}`,
    labels: { 'elanous.kind': 'warm-worker' }, annotations: { 'filler': 'x'.repeat(60_000) },
  }, spec: { nodeName: 'other-node', containers: [{ resources: { limits: { memory: '16Gi' } } }] },
  status: { phase: 'Running' } }));
  const all = [pod, ...extras];
  let listPage = 0;
  let creates = 0;
  const provider = newTestWarmPodProvider({ candidates: [pinned], profileConfig: { pod: { warmPoolProfile: 'gate' } },
    controlUrl: 'http://127.0.0.1:31413/', memberToken: 'a'.repeat(64),
    machineTokens: { ['test-host']: 'b'.repeat(64) },
    kubectl: (args, body) => {
      if (args.some(arg => arg.startsWith('--field-selector='))) return { status: 0, stdout: JSON.stringify({ items: [pod] }), stderr: '' };
      if (args.includes('-l')) {
        const token = args.find(arg => arg.startsWith('--continue='))?.split('=')[1];
        const offset = token === 'page-1' ? 25 : token === 'page-2' ? 50 : 0;
        const rows = all.slice(offset, offset + 25);
        const next = offset + rows.length < all.length ? `page-${offset / 25 + 1}` : '';
        listPage++;
        return { status: 0, stdout: JSON.stringify({ items: rows, metadata: { continue: next } }), stderr: '' };
      }
      if (args[4] === 'wait') return { status: 0, stdout: '{}', stderr: '' };
      if (args[4] === 'get') return { status: 0, stdout: JSON.stringify(pod), stderr: '' };
      if (args[4] === 'create') { creates++; return { status: 1, stdout: '', stderr: 'unexpected create' }; }
      throw new Error(`unexpected kubectl ${args.join(' ')} ${body ? 'with body' : ''}`);
    },
    fetch: async () => Response.json({ resources: [{ kind: 'pod-worker-lease', machine: 'test-host',
      name: pinned.spec.workerId, observedAt: Date.now(), ttlMs: 1_800_000,
      attrs: { state: 'idle', podUid: 'paged-list-uid', idleTtlMs: 1_800_000, key } }] }),
  });
  expect(await provider.reconcilePool()).toMatchObject({ target: 1, ready: 1, failed: [] });
  expect(listPage).toBe(3);
  expect(creates).toBe(0);
});

test('an old physical warm Pod consumes quota even when absent from configured candidates', async () => {
  const active = { ...candidate, spec: { ...spec, name: 'warm-test-host-standard-1',
    workerId: 'new-generation-1', nodeName: 'pool-test-host-server-0' } };
  const old = Array.from({ length: 4 }, (_, index) => ({
    metadata: { name: `old-generation-${index}`, labels: { 'elanous.kind': 'warm-worker' } },
    spec: { nodeName: 'pool-test-host-server-0', containers: [{ resources: { limits: { memory: '16Gi' } } }] },
    status: { phase: 'Running' },
  }));
  const calls: string[] = [];
  const provider = newTestWarmPodProvider({ candidates: [active],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: args => { calls.push(args[4]!); return {
      status: 0, stdout: JSON.stringify({ metadata: {}, items: old }), stderr: '',
    }; },
    fetch: async () => { throw new Error('physical quota must refuse before control access'); },
  });
  expect(await provider.reconcilePool()).toMatchObject({ target: 1, ready: 0, failed: ['new-generation-1'] });
  expect(calls).toEqual(['get', 'get']);
});

test('a busy or unavailable first host lets the request lease a matching worker on the next host', async () => {
  const first = { ...candidate, spec: { ...spec, name: 'warm-test-host',
    workerId: 'test-host-worker', nodeName: 'pool-test-host-server-0' } };
  const second = { host: 'test-host-b', tier: 'standard' as const,
    spec: { ...spec, name: 'warm-test-host-b-standard-1', workerId: 'elangram-worker',
      nodeName: 'pool-test-host-b-server-0' } };
  for (const firstFailure of ['busy', 'network', 'unavailable'] as const) {
    const hosts: string[] = [];
    const provider = newTestWarmPodProvider({ candidates: [first, second],
      controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
      machineTokens: { 'test-host': '2'.repeat(64), 'test-host-b': '3'.repeat(64) },
      kubectl: leaseKubectl([first.spec, second.spec]),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.machine) {
          hosts.push(body.machine);
          if (body.machine === 'test-host') {
            if (firstFailure === 'network') throw new Error('unavailable');
            return new Response('{}', { status: firstFailure === 'busy' ? 409 : 503 });
          }
          return Response.json({ name: second.spec.workerId, attrs: { key, leaseId: 'lease-2',
            generation: 1, podUid: 'lease-pod-uid', state: 'leased' } });
        }
        return Response.json({});
      },
      transport: () => ({ request: async command => ({ status: 'observed' as const, reason: 'complete', reply: completeReply(command) }) }),
    });
    const replay = await provider.request(input(), gateSelection());
    expect(hosts).toEqual(['test-host', 'test-host-b']);
    expect(replay.command?.workerId).toBe('elangram-worker');
    expect(replay.command).toMatchObject({ podName: second.spec.name, podContext: second.spec.kubectlContext, image: second.spec.image,
      podUid: 'lease-pod-uid', generation: 1, leaseId: 'lease-2' });
  }
});

test('WARM-POD-PRODUCER-UID-FU: delayed install and competing prepares register one pinned Pod UID', async () => {
  const prepareSpec = { ...spec, name: 'warm-test-host', nodeName: 'pool-test-host-server-0' };
  const manifest = warmWorkerPodManifest(prepareSpec);
  const createdPod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'cold-uid' } };
  const readyPod = { ...createdPod, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const created: string[] = [];
  const waits: string[] = [];
  const registrations: string[] = [];
  let releasePreflight!: () => void;
  let preflightStarted!: () => void;
  const preflight = new Promise<void>(resolve => { releasePreflight = resolve; });
  const started = new Promise<void>(resolve => { preflightStarted = resolve; });
  let preflightCalls = 0;
  const pods: any[] = [];
  const provider = newTestWarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: args => {
      if (args[4] === 'get' && args[5] === 'pods') return result({ metadata: {}, items: pods });
      if (args[4] === 'create') { created.push(prepareSpec.name); pods.push(createdPod); return result(createdPod); }
      if (args[4] === 'wait') { waits.push(args.find(arg => arg.startsWith('--timeout='))!); return result({}); }
      if (args[4] === 'get') return result(readyPod);
      throw new Error(`unexpected ${args.join(' ')}`);
    },
    fetch: async (url, init) => {
      if (new URL(String(url)).pathname === '/v1/resources') {
        if (++preflightCalls === 1) { preflightStarted(); await preflight; }
        return Response.json({ resources: [] });
      }
      registrations.push(JSON.parse(String(init?.body)).podUid);
      return Response.json({ name: prepareSpec.workerId, attrs: { state: 'idle', podUid: 'cold-uid', key } });
    },
  });
  const first = provider.prepareWorker(prepareSpec.workerId);
  await started;
  const competing = provider.prepareWorker(prepareSpec.workerId);
  await Promise.resolve();
  releasePreflight();
  expect(await Promise.all([first, competing])).toEqual([true, true]);
  expect(created).toHaveLength(1);
  expect(waits).toEqual(['--timeout=300s']);
  expect(registrations).toEqual(['cold-uid']);
});

test('WARM-POD-PRODUCER-UID-FU: separate providers serialize the same host worker prepare', async () => {
  const prepareSpec = { ...spec, name: 'warm-test-host', nodeName: 'pool-test-host-server-0' };
  const lockRoot = mkdtempSync(join(tmpdir(), 'warm-provider-prepare-lock-'));
  const pods = new Map<string, any>();
  const created: string[] = [];
  const actions: string[] = [];
  const registrations: string[] = [];
  const controlCalls: string[] = [];
  let registeredUid: string | null = null;
  let releaseFirst!: () => void;
  let preflightStarted!: () => void;
  const pause = new Promise<void>(resolve => { releaseFirst = resolve; });
  const started = new Promise<void>(resolve => { preflightStarted = resolve; });
  let pauseNextPreflight = true;
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const kubectl = (args: readonly string[], input?: string) => {
    actions.push(args[4]!);
    if (args[4] === 'get' && args[5] === 'pods') return result({ metadata: {}, items: [...pods.values()] });
    if (args[4] === 'create') {
      const body = JSON.parse(input!);
      const pod = { ...body, metadata: { ...body.metadata, uid: 'one-pod-uid' },
        spec: { ...body.spec, nodeName: prepareSpec.nodeName } };
      pods.set(body.metadata.name, pod);
      created.push(body.metadata.name);
      return result(pod);
    }
    if (args[4] === 'wait') return result({});
    if (args[4] === 'get') return result({ ...pods.get(prepareSpec.name),
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } });
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    controlCalls.push(`${init?.method} ${new URL(String(url)).pathname}`);
    if (new URL(String(url)).pathname === '/v1/resources') {
      if (pauseNextPreflight) { pauseNextPreflight = false; preflightStarted(); await pause; }
      return Response.json({ resources: registeredUid ? [{ kind: 'pod-worker-lease', machine: 'test-host',
        name: prepareSpec.workerId, observedAt: Date.now(), ttlMs: 1_800_000,
        attrs: { state: 'idle', podUid: registeredUid, idleTtlMs: 1_800_000, key } }] : [] });
    }
    const body = JSON.parse(String(init?.body));
    registrations.push(body.podUid);
    registeredUid = body.podUid;
    return Response.json({ name: prepareSpec.workerId, attrs: { state: 'idle', podUid: body.podUid, key } });
  };
  const options = { candidates: [{ ...candidate, spec: prepareSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) }, kubectl, fetch, prepareLockDirectory: lockRoot };
  const pendingPrepares: Promise<boolean>[] = [];
  try {
    const firstProvider = newTestWarmPodProvider(options);
    const secondProvider = newTestWarmPodProvider(options);
    const first = firstProvider.prepareWorker(prepareSpec.workerId);
    pendingPrepares.push(first);
    await started;
    const second = secondProvider.prepareWorker(prepareSpec.workerId);
    pendingPrepares.push(second);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect({ actions, created, registrations, controlCalls }).toEqual({
      actions: ['get', 'get', 'create', 'wait', 'get', 'get', 'get', 'wait', 'get'],
      created: [prepareSpec.name], registrations: ['one-pod-uid'],
      controlCalls: ['GET /v1/resources', 'GET /v1/resources', 'POST /v1/workers/pod', 'GET /v1/resources'],
    });
    expect(created).toEqual([prepareSpec.name]);
    expect(registrations).toEqual(['one-pod-uid']);
  } finally {
    releaseFirst();
    await Promise.allSettled(pendingPrepares);
    rmSync(lockRoot, { recursive: true, force: true });
  }
}, 20_000);

test('prepare lease wait is cancellable, records the reason, and kernel unlock permits retry', async () => {
  const prepareSpec = { ...spec, name: 'warm-test-host', nodeName: 'pool-test-host-server-0' };
  const lockRoot = mkdtempSync(join(tmpdir(), 'warm-provider-abort-lock-'));
  const events: Array<{ event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm') events.push({ event, data });
  }) as typeof debug.log);
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const pause = new Promise<void>(resolve => { releaseFirst = resolve; });
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  let blockFirst = true;
  const pods = new Map<string, any>();
  const created: string[] = [];
  let registrations = 0;
  let registeredUid: string | null = null;
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const providerOptions = (prepareAbortSignal?: AbortSignal) => ({
    candidates: [{ ...candidate, spec: prepareSpec }], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) },
    prepareLockDirectory: lockRoot, prepareAbortSignal,
    kubectl: (args: readonly string[], body?: string) => {
      if (args[4] === 'get' && args[5] === 'pods') return result({ metadata: {}, items: [...pods.values()] });
      if (args[4] === 'create') {
        const manifest = JSON.parse(body!);
        const pod = { ...manifest, metadata: { ...manifest.metadata, uid: 'retry-pod-uid' },
          spec: { ...manifest.spec, nodeName: prepareSpec.nodeName },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
        pods.set(prepareSpec.name, pod); created.push(prepareSpec.name); return result(pod);
      }
      if (args[4] === 'wait') return result({});
      if (args[4] === 'get') return result(pods.get(prepareSpec.name));
      throw new Error(`unexpected ${args.join(' ')}`);
    },
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
        if (new URL(String(url)).pathname === '/v1/resources') {
          if (blockFirst) { blockFirst = false; firstStarted(); await pause; }
          return Response.json({ resources: registeredUid ? [{ kind: 'pod-worker-lease', machine: 'test-host',
            name: prepareSpec.workerId, observedAt: Date.now(), ttlMs: 1_800_000,
            attrs: { state: 'idle', podUid: registeredUid, idleTtlMs: 1_800_000, key } }] : [] });
        }
        registrations++;
        const body = JSON.parse(String(init?.body));
        registeredUid = body.podUid;
        return Response.json({ name: prepareSpec.workerId, attrs: { state: 'idle', podUid: body.podUid, key } });

    },
  });
  const pendingPrepares: Promise<boolean>[] = [];
  try {
    const firstProvider = newTestWarmPodProvider(providerOptions());
    const first = firstProvider.prepareWorker(prepareSpec.workerId);
    pendingPrepares.push(first);
    await started;
    const abort = new AbortController();
    const waitingProvider = newTestWarmPodProvider(providerOptions(abort.signal));
    const waiting = waitingProvider.prepareWorker(prepareSpec.workerId);
    pendingPrepares.push(waiting);
    abort.abort();
    await expect(waiting).rejects.toThrow('warm prepare lock wait cancelled');
    expect(events).toContainEqual({ event: 'prepare-lease-failed', data: {
      host: 'test-host', workerId: prepareSpec.workerId, reason: 'warm prepare lock wait cancelled',
    } });
    releaseFirst();
    expect(await first).toBe(true);
    const retry = newTestWarmPodProvider(providerOptions());
    const retryPrepare = retry.prepareWorker(prepareSpec.workerId);
    pendingPrepares.push(retryPrepare);
    expect(await retryPrepare).toBe(true);
    expect(created).toEqual([prepareSpec.name]);
    expect(registrations).toBe(1);
  } finally {
    releaseFirst();
    await Promise.allSettled(pendingPrepares);
    log.mockRestore();
    rmSync(lockRoot, { recursive: true, force: true });
  }
});

test('prepare cancellation after acquiring the lease stops before Pod creation and records its reason', async () => {
  const prepareSpec = { ...spec, name: 'warm-test-host', nodeName: 'pool-test-host-server-0' };
  const abort = new AbortController();
  const events: Array<{ event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm') events.push({ event, data });
  }) as typeof debug.log);
  let releasePreflight!: () => void;
  let preflightStarted!: () => void;
  const pause = new Promise<void>(resolve => { releasePreflight = resolve; });
  const started = new Promise<void>(resolve => { preflightStarted = resolve; });
  const actions: string[] = [];
  const provider = newTestWarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) }, prepareAbortSignal: abort.signal,
    kubectl: args => { actions.push(args[4]!); return { status: 0, stdout: JSON.stringify({ metadata: {}, items: [] }), stderr: '' }; },
    fetch: async () => { preflightStarted(); await pause; return Response.json({ resources: [] }); },
  });
  try {
    const preparing = provider.prepareWorker(prepareSpec.workerId);
    await started;
    abort.abort(new Error('operator cancelled prepare'));
    releasePreflight();
    await expect(preparing).rejects.toThrow('operator cancelled prepare');
    expect(actions).toEqual(['get', 'get']);
    expect(events).toContainEqual({ event: 'prepare-lease-failed', data: {
      host: 'test-host', workerId: prepareSpec.workerId, reason: 'operator cancelled prepare',
    } });
  } finally { releasePreflight(); log.mockRestore(); }
});

test('WARM-POD-PRODUCER-UID-FU-FU6: an injected flock-unsupported platform refuses only that slot and keeps reconciling', async () => {
  const first = { ...candidate, spec: { ...spec, name: 'warm-test-host-standard-1',
    workerId: 'fu6-worker-1', nodeName: 'pool-test-host-server-0' } };
  const second = { ...candidate, spec: { ...spec, name: 'warm-test-host-standard-2',
    workerId: 'fu6-worker-2', nodeName: 'pool-test-host-server-0' } };
  const lockRoot = mkdtempSync(join(tmpdir(), 'warm-provider-flock-unsupported-'));
  const events: Array<{ event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm') events.push({ event, data });
  }) as typeof debug.log);
  const kubectlCalls: string[] = [];
  const created: string[] = [];
  let controlCalls = 0;
  try {
    const provider = newTestWarmPodProvider({ candidates: [first, second],
      controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
      machineTokens: { 'test-host': '2'.repeat(64) }, prepareLockDirectory: lockRoot,
      // The injected seam: this platform cannot take an OS prepare lease.
      prepareFlock: false,
      kubectl: (args, body) => {
        kubectlCalls.push(args[4]!);
        if (args[4] === 'create') {
          const manifest = JSON.parse(body!);
          const pod = { ...manifest, metadata: { ...manifest.metadata, uid: `${manifest.metadata.name}-uid` },
            status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
          created.push(manifest.metadata.name);
          return { status: 0, stdout: JSON.stringify(pod), stderr: '' };
        }
        if (args[4] === 'get' && args[5] === 'pods') return { status: 0, stdout: JSON.stringify({ metadata: {}, items: [] }), stderr: '' };
        if (args[4] === 'wait') return { status: 0, stdout: '{}', stderr: '' };
        if (args[4] === 'get') return { status: 0, stdout: '{}', stderr: '' };
        throw new Error(`unexpected ${args.join(' ')}`);
      },
      fetch: async () => { controlCalls++; return Response.json({ resources: [] }); },
    });
    expect(await provider.reconcilePool()).toMatchObject({ target: 2, ready: 0,
      failed: ['fu6-worker-1', 'fu6-worker-2'] });
    // Zero Pods: no slot reached kubectl or the control plane after the lease refusal.
    expect(created).toEqual([]);
    expect(kubectlCalls).toEqual([]);
    expect(controlCalls).toBe(0);
    // Only that slot is refused, with the unchanged reason text.
    expect(events.filter(row => row.event === 'prepare-lease-failed').map(row => row.data)).toEqual([
      { host: 'test-host', workerId: 'fu6-worker-1', reason: 'warm prepare OS locks are unavailable on this platform' },
      { host: 'test-host', workerId: 'fu6-worker-2', reason: 'warm prepare OS locks are unavailable on this platform' },
    ]);
    // The next candidate is still evaluated after the first refusal.
    expect(events.filter(row => row.event === 'pool-slot').map(row => [row.data.workerId, row.data.ready]))
      .toEqual([['fu6-worker-1', false], ['fu6-worker-2', false]]);
  } finally { log.mockRestore(); rmSync(lockRoot, { recursive: true, force: true }); }
});

test('WARM-POD-PRODUCER-UID-FU-FU6: production --reconcile absorbs a config-declared flock-unsupported platform per slot', () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-provider-flock-cli-'));
  try {
    const bin = join(root, 'bin');
    const marker = join(root, 'kubectl-calls');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'kubectl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$WARM_KUBECTL_MARKER"\nexit 1\n', { mode: 0o700 });
    const file = join(root, 'provider.json');
    const prepareSpec = { ...spec, name: 'warm-node-b', nodeName: 'pool-node-b-server-0' };
    writeFileSync(file, JSON.stringify({
      candidates: [{ host: 'node-b', tier: 'standard', spec: prepareSpec }],
      controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64),
      machineTokens: { 'node-b': '2'.repeat(64) },
      prepareFlock: false,
    }), { mode: 0o600 });
    // The private config is loaded by the real loadWarmPodProvider call chain of --reconcile;
    // the fake kubectl would record its first `get pods` if a slot ever reached Pod creation.
    const run = spawnSync(process.execPath,
      [join(import.meta.dir, 'pod-warm-worker-provider.ts'), '--reconcile'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        WARM_KUBECTL_MARKER: marker, ELANOUS_WARM_POD_PROVIDER_CONFIG: file,
        HOME: join(root, 'home'), ELANOUS_STATE_DIR: join(root, 'state'),
        ELANOUS_STATE_DIR_SOURCE: 'explicit', ELANOUS_CONFIG_DIR: join(root, 'config') } });
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout.trim().split('\n')[0]!)).toMatchObject({ target: 1, ready: 0,
      failed: [prepareSpec.workerId] });
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);

test('a failed kubectl wait backs off and its retry delay is cancellable', async () => {
  const prepareSpec = { ...spec, name: 'warm-test-host', nodeName: 'pool-test-host-server-0' };
  const manifest = warmWorkerPodManifest(prepareSpec);
  const createdPod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'retry-uid' } };
  const abort = new AbortController();
  const actions: string[] = [];
  const provider = newTestWarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) }, prepareAbortSignal: abort.signal,
    kubectl: args => {
      actions.push(args[4]!);
      if (args[4] === 'get' && args[5] === 'pods') return { status: 0, stdout: '{"metadata":{},"items":[]}', stderr: '' };
      if (args[4] === 'create') return { status: 0, stdout: JSON.stringify(createdPod), stderr: '' };
      if (args[4] === 'wait') { abort.abort(new Error('cancel retry')); return { status: 1, stdout: '', stderr: 'transient API failure' }; }
      throw new Error(`unexpected ${args.join(' ')}`);
    },
    fetch: async () => Response.json({ resources: [] }),
  });
  await expect(provider.prepareWorker(prepareSpec.workerId)).rejects.toThrow('cancel retry');
  expect(actions).toEqual(['get', 'get', 'create', 'wait']);
});

test('an immediate kubectl wait failure retries after a bounded delay and registers only the pinned UID', async () => {
  const prepareSpec = { ...spec, name: 'warm-test-host', nodeName: 'pool-test-host-server-0' };
  const manifest = warmWorkerPodManifest(prepareSpec);
  const createdPod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'delayed-ready-uid' } };
  const readyPod = { ...createdPod, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
  const actions: string[] = [];
  let waitCalls = 0;
  let registrations = 0;
  const provider = newTestWarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: args => {
      actions.push(args[4]!);
      if (args[4] === 'get' && args[5] === 'pods') return { status: 0, stdout: '{"metadata":{},"items":[]}', stderr: '' };
      if (args[4] === 'create') return { status: 0, stdout: JSON.stringify(createdPod), stderr: '' };
      if (args[4] === 'wait') return { status: ++waitCalls === 1 ? 1 : 0, stdout: '', stderr: 'temporary wait failure' };
      if (args[4] === 'get') return { status: 0, stdout: JSON.stringify(waitCalls > 1 ? readyPod : createdPod), stderr: '' };
      throw new Error(`unexpected ${args.join(' ')}`);
    },
    fetch: async (url, init) => {
      if (new URL(String(url)).pathname === '/v1/resources') return Response.json({ resources: [] });
      registrations++;
      expect(JSON.parse(String(init?.body)).podUid).toBe('delayed-ready-uid');
      return Response.json({ name: prepareSpec.workerId, attrs: { state: 'idle', podUid: 'delayed-ready-uid', key } });
    },
  });
  const startedAt = Date.now();
  expect(await provider.prepareWorker(prepareSpec.workerId)).toBe(true);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
  expect(waitCalls).toBe(2);
  expect(registrations).toBe(1);
  expect(actions).toEqual(['get', 'get', 'create', 'wait', 'get', 'wait', 'get']);
});

test('a Pod UID replaced during the Ready recheck is never registered', async () => {
  const prepareSpec = { ...spec, name: 'warm-test-host', nodeName: 'pool-test-host-server-0' };
  const manifest = warmWorkerPodManifest(prepareSpec);
  const createdPod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'created-uid' } };
  const replacementPod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'replacement-uid' } };
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const actions: string[] = [];
  let registrations = 0;
  const provider = newTestWarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: args => {
      actions.push(args[4]!);
      if (args[4] === 'get' && args[5] === 'pods') return result({ metadata: {}, items: [] });
      if (args[4] === 'create') return result(createdPod);
      if (args[4] === 'wait') return { status: 1, stdout: '', stderr: 'timed out' };
      if (args[4] === 'get') return result(replacementPod);
      throw new Error(`unexpected ${args.join(' ')}`);
    },
    fetch: async (url, init) => {
      if (new URL(String(url)).pathname === '/v1/resources') return Response.json({ resources: [] });
      registrations++;
      return Response.json({ name: prepareSpec.workerId, attrs: { state: 'idle', podUid: 'created-uid', key } });
    },
  });
  expect(await provider.prepareWorker(prepareSpec.workerId)).toBe(false);
  expect(actions).toEqual(['get', 'get', 'create', 'wait', 'get']);
  expect(registrations).toBe(0);
});

test('cold init beyond five minutes reaches Ready and registers its exact created UID', async () => {
  const prepareSpec = { ...spec, name: 'warm-test-host', nodeName: 'pool-test-host-server-0' };
  const manifest = warmWorkerPodManifest(prepareSpec);
  const createdPod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'cold-uid' } };
  const readyPod = { ...createdPod, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  let registeredUid: string | undefined;
  let waitCalls = 0;
  let clock = 1_000_000;
  const provider = newTestWarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
    now: () => clock,
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: args => {
      if (args[4] === 'get' && args[5] === 'pods') return result({ metadata: {}, items: [] });
      if (args[4] === 'create') return result(createdPod);
      if (args[4] === 'wait') {
        const timeout = args.find(arg => arg.startsWith('--timeout='));
        expect(timeout).toBe('--timeout=300s');
        waitCalls++;
        clock += 300_000;
        return { status: 1, stdout: '', stderr: 'timed out' };
      }
      if (args[4] === 'get') return waitCalls >= 2 ? result(readyPod) : result(createdPod);
      throw new Error(`unexpected ${args.join(' ')}`);
    },
    fetch: async (url, init) => {
      if (new URL(String(url)).pathname === '/v1/resources') return Response.json({ resources: [] });
      registeredUid = JSON.parse(String(init?.body)).podUid;
      return Response.json({ name: prepareSpec.workerId, attrs: { state: 'idle', podUid: registeredUid, key } });
    },
  });
  expect(await provider.prepareWorker(prepareSpec.workerId)).toBe(true);
  expect(registeredUid).toBe('cold-uid');
});

test('Ready deadline leaves a created Pod unregistered for explicit recovery', async () => {
  const prepareSpec = { ...spec, name: 'warm-test-host', nodeName: 'pool-test-host-server-0' };
  const manifest = warmWorkerPodManifest(prepareSpec);
  const pod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'slow-uid' } };
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const actions: string[] = [];
  const controlPaths: string[] = [];
  const provider = newTestWarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: args => {
      actions.push(args[4]!);
      if (args[4] === 'get') return result({ metadata: {}, items: [] });
      if (args[4] === 'create') return result(pod);
      if (args[4] === 'wait') return { status: 1, stdout: '', stderr: 'timed out' };
      throw new Error(`unexpected ${args.join(' ')}`);
    },
    fetch: async url => {
      controlPaths.push(new URL(String(url)).pathname);
      return Response.json({ resources: [] });
    },
  });
  expect(await provider.prepareWorker(prepareSpec.workerId)).toBe(false);
  expect(actions).toEqual(['get', 'get', 'create', 'wait', 'get']);
  expect(controlPaths).toEqual(['/v1/resources']);
});

test('standing producer refuses a replaced Pod without create/delete and registers one Ready Pod', async () => {
  const prepareSpec = { ...spec, name: 'warm-test-host', nodeName: 'pool-test-host-server-0' };
  const prepareCandidate = { ...candidate, spec: prepareSpec };
  const manifest = warmWorkerPodManifest(prepareSpec);
  const pod = (uid: string) => ({ ...manifest, metadata: { ...(manifest.metadata as object), uid },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } });
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const paths: string[] = [];
  const displacedCommands: string[] = [];
  const displaced = newTestWarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: args => {
      const action = args[4]!; displacedCommands.push(action);
      if (action === 'get' && args[5] === 'pods') return result({ metadata: {}, items: [pod('old-uid')] });
      if (action === 'wait') return result({});
      if (action === 'get') return result(pod('replacement-uid'));
      throw new Error(`unexpected ${args.join(' ')}`);
    },
    fetch: async url => { paths.push(new URL(String(url)).pathname); return Response.json({}); },
  });
  let forgedKubectlCalls = 0;
  const unpinned = newTestWarmPodProvider({ candidates: [candidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: () => { forgedKubectlCalls++; return result({ metadata: {}, items: [] }); },
  });
  expect(await unpinned.ensureStandingWorker(prepareCandidate)).toBe(false);
  expect(forgedKubectlCalls).toBe(0);
  expect(await displaced.ensureStandingWorker(prepareCandidate)).toBe(false);
  expect(displacedCommands).toEqual(['get', 'get', 'wait', 'get']);
  expect(paths).toEqual([]);

  for (const changed of [
    { ...pod('foreign'), spec: { ...(manifest.spec as object), initContainers: [] } },
    { ...pod('foreign'), spec: { ...(manifest.spec as object), hostPID: true } },
    { ...pod('foreign'), spec: { ...(manifest.spec as object), nodeName: 'another-node' } },
    { ...pod('foreign'), metadata: { ...pod('foreign').metadata, labels: {} },
      spec: { ...(manifest.spec as object), nodeName: 'another-node' } },
    { ...pod('foreign'), metadata: { ...pod('foreign').metadata, labels: {} } },
    { ...pod('foreign'), metadata: { ...pod('foreign').metadata,
      ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: 'foreign', uid: 'foreign-owner' }] } },
    { ...pod('foreign'), metadata: { ...pod('foreign').metadata,
      deletionTimestamp: '2026-10-19T13:00:00Z' } },
    { ...pod('foreign'), spec: { ...(manifest.spec as object), containers: [
      ...(manifest.spec as { containers: unknown[] }).containers, { name: 'sidecar', image: prepareSpec.image }] } },
    { ...pod('foreign'), spec: { ...(manifest.spec as object), containers: [
      { ...(manifest.spec as { containers: Record<string, unknown>[] }).containers[0], command: ['sleep', '60'] }] } },
  ]) {
    const calls: string[] = [];
    const refused = newTestWarmPodProvider({ candidates: [prepareCandidate],
      controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
      machineTokens: { 'test-host': '2'.repeat(64) },
      kubectl: args => { calls.push(args[4]!); return result({ metadata: {}, items: [changed] }); },
      fetch: async () => { throw new Error('mutated Pod reached the control plane'); },
    });
    expect(await refused.prepareWorker(prepareSpec.workerId)).toBe(false);
    expect(calls).toEqual(['get', 'get']);
  }

  const commands: string[] = [];
  const registered: Array<{ path: string; authorization: string | null; body: any }> = [];
  const prepared = newTestWarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: args => {
      const action = args[4]!; commands.push(action);
      if (action === 'get' && args[5] === 'pods') {
        if (args.some(arg => arg.startsWith('--field-selector='))) {
          expect(args.some(arg => arg.includes('metadata.name=warm-test-host'))).toBe(true);
          return result({ metadata: {}, items: [] });
        }
        expect(args).toContain('-l');
        expect(args).toContain('elanous.kind=warm-worker');
        return result({ metadata: {}, items: [{ metadata: { name: 'warm-other-host', annotations: { 'elanous.dev/warm-worker-id': 'other-worker' } } }] });
      }
      if (action === 'create' || action === 'get') return result(pod('new-uid'));
      if (action === 'wait') return result({});
      throw new Error(`unexpected ${args.join(' ')}`);
    },
    fetch: async (url, init) => {
      if (new URL(String(url)).pathname === '/v1/resources') return Response.json({ resources: [] });
      registered.push({ path: new URL(String(url)).pathname,
        authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) });
      return Response.json({ name: prepareSpec.workerId, attrs: { state: 'idle', podUid: 'new-uid', key } });
    },
  });
  expect(await prepared.prepareWorker(prepareSpec.workerId)).toBe(true);
  expect(commands).toEqual(['get', 'get', 'create', 'wait', 'get']);
  expect(registered).toEqual([{ path: '/v1/workers/pod', authorization: `Bearer ${'2'.repeat(64)}`, body: {
    workerId: prepareSpec.workerId, machine: 'test-host', podUid: 'new-uid', key, ttlMs: 30 * 60_000,
  } }]);

  for (const appearsAfterPreflight of [false, true]) {
    const actions: string[] = [];
    const controlCalls: string[] = [];
    let reads = 0;
    const conflicting = newTestWarmPodProvider({ candidates: [prepareCandidate],
      controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
      machineTokens: { 'test-host': '2'.repeat(64) },
      kubectl: args => {
        actions.push(args[4]!);
        if (args[5] === 'pods') return result({ metadata: {}, items: [] });
        if (args[4] === 'create' || args[4] === 'get') return result(pod('new-uid'));
        if (args[4] === 'wait') return result({});
        throw new Error(`unexpected ${args.join(' ')}`);
      },
      fetch: async (url, init) => {
        controlCalls.push(`${init?.method} ${new URL(String(url)).pathname}`);
        if (init?.method === 'POST') throw new Error('conflicting worker ID reached registration');
        reads++;
        return Response.json({ resources: appearsAfterPreflight && reads === 1 ? [] : [{
          kind: 'pod-worker-lease', machine: 'test-host', name: prepareSpec.workerId,
          observedAt: Date.now(), ttlMs: 30 * 60_000,
          attrs: { state: 'idle', podUid: 'old-uid', key, idleTtlMs: 30 * 60_000 },
        }] });
      },
    });
    expect(await conflicting.prepareWorker(prepareSpec.workerId)).toBe(false);
    expect(actions).toEqual(appearsAfterPreflight ? ['get', 'get', 'create', 'wait', 'get'] : ['get', 'get']);
    expect(controlCalls).toEqual(appearsAfterPreflight
      ? ['GET /v1/resources', 'GET /v1/resources'] : ['GET /v1/resources']);
  }

  let foreignRegistrations = 0;
  const foreignIdentical = newTestWarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: args => result(args[5] === 'pods' ? { metadata: {}, items: [pod('foreign-uid')] } : pod('foreign-uid')),
    fetch: async (_url, init) => {
      if (init?.method === 'POST') foreignRegistrations++;
      return Response.json({ resources: [] });
    },
  });
  expect(await foreignIdentical.prepareWorker(prepareSpec.workerId)).toBe(false);
  expect(foreignRegistrations).toBe(0);

  for (const state of ['idle', 'leased', 'quarantined']) {
    const repeatCommands: string[] = [];
    const controlCalls: string[] = [];
    const repeated = newTestWarmPodProvider({ candidates: [prepareCandidate],
      controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
      machineTokens: { 'test-host': '2'.repeat(64) },
      kubectl: args => {
        repeatCommands.push(args[4]!);
        const defaulted = { ...pod('new-uid'), spec: { ...(manifest.spec as object),
          dnsPolicy: 'ClusterFirst', serviceAccountName: 'default', serviceAccount: 'default',
          schedulerName: 'default-scheduler',
          terminationGracePeriodSeconds: 30, enableServiceLinks: true,
          tolerations: [
            { effect: 'NoExecute', key: 'node.kubernetes.io/not-ready', operator: 'Exists', tolerationSeconds: 300 },
            { effect: 'NoExecute', key: 'node.kubernetes.io/unreachable', operator: 'Exists', tolerationSeconds: 300 },
          ],
          containers: (manifest.spec as { containers: Record<string, unknown>[] }).containers.map(row => ({
            ...row, terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File',
          })),
          initContainers: (manifest.spec as { initContainers: Record<string, unknown>[] }).initContainers.map(row => ({
            ...row, ...(!('resources' in row) ? { resources: {} } : {}),
            terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File',
          })),
        } };
        return args[5] === 'pods' ? result({ metadata: {}, items: [defaulted] }) : result(defaulted);
      },
      fetch: async (url, init) => {
        controlCalls.push(`${init?.method} ${new URL(String(url)).pathname}`);
        return Response.json({ resources: [{ kind: 'pod-worker-lease', machine: 'test-host',
          name: prepareSpec.workerId, observedAt: Date.now(), ttlMs: 30 * 60_000,
          attrs: { state, podUid: 'new-uid', key, idleTtlMs: 30 * 60_000 } }] });
      },
    });
    expect(await repeated.prepareWorker(prepareSpec.workerId)).toBe(state !== 'quarantined');
    expect(repeatCommands).toEqual(state === 'quarantined'
      ? ['get', 'get', 'wait', 'get', 'get', 'get'] : ['get', 'get', 'wait', 'get']);
    expect(controlCalls).toEqual(['GET /v1/resources']);
  }

  const wrongUidCalls: string[] = [];
  const wrongUid = newTestWarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: args => result(args[5] === 'pods' ? { metadata: {}, items: [pod('new-uid')] } : pod('new-uid')),
    fetch: async (url, init) => {
      wrongUidCalls.push(`${init?.method} ${new URL(String(url)).pathname}`);
      return Response.json({ resources: [{ kind: 'pod-worker-lease', machine: 'test-host',
        name: prepareSpec.workerId, observedAt: Date.now(), ttlMs: 30 * 60_000,
        attrs: { state: 'idle', podUid: 'old-uid', key, idleTtlMs: 30 * 60_000 } }] });
    },
  });
  expect(await wrongUid.prepareWorker(prepareSpec.workerId)).toBe(false);
  expect(wrongUidCalls).toEqual(['GET /v1/resources']);

  const legacyCalls: string[] = [];
  const legacyUid = newTestWarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: args => result(args[5] === 'pods' ? { metadata: {}, items: [pod('new-uid')] } : pod('new-uid')),
    fetch: async (url, init) => {
      legacyCalls.push(`${init?.method} ${new URL(String(url)).pathname}`);
      return Response.json({ resources: [{ kind: 'pod-worker-lease', machine: 'test-host',
        name: prepareSpec.workerId, attrs: { state: 'idle', key } }] });
    },
  });
  expect(await legacyUid.prepareWorker(prepareSpec.workerId)).toBe(false);
  expect(legacyCalls).toEqual(['GET /v1/resources']);

  const expiredCalls: string[] = [];
  const expired = newTestWarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: args => result(args[5] === 'pods' ? { metadata: {}, items: [pod('new-uid')] } : pod('new-uid')),
    fetch: async (url, init) => {
      expiredCalls.push(`${init?.method} ${new URL(String(url)).pathname}`);
      return Response.json({ resources: [{ kind: 'pod-worker-lease', machine: 'test-host',
        name: prepareSpec.workerId, observedAt: Date.now() - 31 * 60_000, ttlMs: 30 * 60_000,
        attrs: { state: 'idle', podUid: 'new-uid', key, idleTtlMs: 30 * 60_000 } }] });
    },
  });
  expect(await expired.prepareWorker(prepareSpec.workerId)).toBe(false);
  expect(expiredCalls).toEqual(['GET /v1/resources', 'GET /v1/resources',
    'POST /v1/leases/pod-worker/warm-test-1-uid/expire']);

  const priorTtl = newTestWarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: args => result(args[5] === 'pods' ? { metadata: {}, items: [pod('new-uid')] } : pod('new-uid')),
    fetch: async () => Response.json({ resources: [{ kind: 'pod-worker-lease', machine: 'test-host',
      name: prepareSpec.workerId, observedAt: Date.now(), ttlMs: 60_000,
      attrs: { state: 'idle', podUid: 'new-uid', key, idleTtlMs: 60_000 } }] }),
  });
  expect(await priorTtl.prepareWorker(prepareSpec.workerId)).toBe(true);

  const injectedClockTtl = newTestWarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) }, now: () => Date.now() + 120_000,
    kubectl: args => result(args[5] === 'pods' ? { metadata: {}, items: [pod('new-uid')] } : pod('new-uid')),
    fetch: async () => Response.json({ resources: [{ kind: 'pod-worker-lease', machine: 'test-host',
        name: prepareSpec.workerId, observedAt: Date.now(), ttlMs: 60_000,
        attrs: { state: 'idle', podUid: 'new-uid', key, idleTtlMs: 60_000 } }] }),
  });
  const coldPrepareWithInjectedClock = (injectedClockTtl as unknown as {
    coldPrepare: (candidate: typeof prepareCandidate, outcome: { preexisting: boolean; podUid: string | null }) => Promise<boolean>;
  }).coldPrepare.bind(injectedClockTtl);
  expect(await coldPrepareWithInjectedClock(prepareCandidate, { preexisting: true, podUid: 'new-uid' })).toBe(false);

  const future = newTestWarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: args => result(args[5] === 'pods' ? { metadata: {}, items: [pod('new-uid')] } : pod('new-uid')),
    fetch: async () => Response.json({ resources: [{ kind: 'pod-worker-lease', machine: 'test-host',
      name: prepareSpec.workerId, observedAt: Date.now() + 60_000, ttlMs: 30 * 60_000,
      attrs: { state: 'idle', podUid: 'new-uid', key } }] }),
  });
  expect(await future.prepareWorker(prepareSpec.workerId)).toBe(false);
});

test('real control GET keeps a matching Pod preparation idempotent with one registration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-producer-control-'));
  const server = startControlServer({ root, port: 0, leaseView: { async get() {
    return { holder: 'test-host', generation: 1, iAmHolder: true, known: true };
  } } });
  try {
    const prepareSpec = { ...spec, name: 'warm-test-host', nodeName: 'pool-test-host-server-0' };
    const manifest = warmWorkerPodManifest(prepareSpec);
    const pod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'real-uid' },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
    let created = false;
    let registrations = 0;
    const provider = newTestWarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
      controlUrl: `${server.url}/`, memberToken: ensureControlTokens(root).member,
      machineTokens: { 'test-host': issueMemberToken('test-host', root) },
      kubectl: args => {
        const result = args[5] === 'pods' ? { metadata: {}, items: created ? [pod] : [] } : pod;
        if (args[4] === 'create') created = true;
        return { status: 0, stdout: JSON.stringify(result), stderr: '' };
      },
      fetch: (input, init) => {
        if (new URL(String(input)).pathname === '/v1/workers/pod') registrations++;
        return fetch(input, init);
      },
    });
    expect(await provider.prepareWorker(prepareSpec.workerId)).toBe(true);
    expect(await provider.prepareWorker(prepareSpec.workerId)).toBe(true);
    expect(registrations).toBe(1);
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('provider retains the lease through gate comparison, then releases and machine-sanitizes it', async () => {
  const calls: Array<{ path: string; token: string; body: any }> = [];
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: leaseKubectl(),
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body));
      calls.push({ path, token: new Headers(init?.headers).get('authorization')!, body });
      return Response.json(path === '/v1/leases/pod-worker' ? lease() : { attrs: { state: 'idle' } });
    },
    transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
  });
  const result = await provider.request(input(), gateSelection());
  expect(result.command).toMatchObject({ workerId: spec.workerId, generation: 1, leaseId: 'lease-1', key });
  expect(result.transport.reason).toBe('complete');
  const cleanupKey = JSON.stringify([spec.workerId, 'lease-1', 1, 'lease-pod-uid']);
  expect((provider as any).cleanupVerifiedLeases.has(cleanupKey)).toBe(true);
  expect(calls.map(call => call.path)).toEqual(['/v1/leases/pod-worker']);
  await provider.finalize(result.command!);
  expect((provider as any).cleanupVerifiedLeases.has(cleanupKey)).toBe(false);
  expect(calls.map(call => call.path)).toEqual([
    '/v1/leases/pod-worker', `/v1/leases/pod-worker/${spec.workerId}/release`,
    `/v1/leases/pod-worker/${spec.workerId}/sanitize`,
  ]);
  await provider.finalize(result.command!);
  expect(calls).toHaveLength(3);
  expect(calls[0]!.token).toBe(`Bearer ${'1'.repeat(64)}`);
  expect(calls[1]!.token).toBe(`Bearer ${'1'.repeat(64)}`);
  expect(calls[2]!.token).toBe(`Bearer ${'2'.repeat(64)}`);
  expect(calls[1]!.body).toMatchObject({ leaseId: 'lease-1', generation: 1 });
});

test('a missing, dirty, or mismatched reset receipt quarantines the lease before reuse', async () => {
  for (const corrupt of [
    (reply: ReturnType<typeof completeReply>) => ({ ...reply, resetReceipt: undefined }),
    (reply: ReturnType<typeof completeReply>) => ({ ...reply, resetReceipt: { ...reply.resetReceipt, postRunDiff: ['src/dirty.ts'] } }),
    (reply: ReturnType<typeof completeReply>) => ({ ...reply, resetReceipt: { ...reply.resetReceipt, baseImageDigest: `sha256:${'0'.repeat(64)}` } }),
  ]) {
    const paths: string[] = [];
    const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl(),
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        return Response.json(path === '/v1/leases/pod-worker' ? lease() : { attrs: { state: 'quarantined' } });
      },
      transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete',
        reply: corrupt(completeReply(command)) }) }),
    });
    const result = await provider.request(input(), gateSelection());
    expect(result.transport.status).toBe('fallback');
    expect(paths).toContain(`/v1/leases/pod-worker/${spec.workerId}/quarantine`);
    expect((provider as any).cleanupVerifiedLeases.size).toBe(0);
  }
});

test('a retryable finalize error retains cleanup proof until the exact lease can be returned', async () => {
  const paths: string[] = [];
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl(),
    fetch: async url => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return Response.json(path === '/v1/leases/pod-worker' ? lease() : { attrs: { state: 'idle' } });
    },
    transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
  });
  const result = await provider.request(input(), gateSelection());
  const command = result.command!;
  const cleanupKey = JSON.stringify([command.workerId, command.leaseId, command.generation, command.podUid]);
  const candidates = (provider as any).candidates as WarmWorkerCandidate[];
  candidates.splice(0, candidates.length);

  await expect(provider.finalize(command)).rejects.toThrow('warm finalize candidate missing');
  expect((provider as any).cleanupVerifiedLeases.has(cleanupKey)).toBe(true);
  expect(paths).toEqual(['/v1/leases/pod-worker']);

  candidates.push(candidate);
  await provider.finalize(command);
  expect((provider as any).cleanupVerifiedLeases.has(cleanupKey)).toBe(false);
  expect(paths).toEqual(['/v1/leases/pod-worker', `/v1/leases/pod-worker/${spec.workerId}/release`,
    `/v1/leases/pod-worker/${spec.workerId}/sanitize`]);
});

test('a quarantine racing cleanup prevents a late complete receipt from reviving the lease', async () => {
  const paths: string[] = [];
  let markTransportStarted!: () => void;
  let finishTransport!: () => void;
  const transportStarted = new Promise<void>(resolve => { markTransportStarted = resolve; });
  const transportPause = new Promise<void>(resolve => { finishTransport = resolve; });
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl(),
    fetch: async url => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return Response.json(path === '/v1/leases/pod-worker' ? lease() : { attrs: { state: 'quarantined' } });
    },
    transport: () => ({ request: async command => {
      markTransportStarted();
      await transportPause;
      return { status: 'observed', reason: 'complete', reply: completeReply(command) };
    } }),
  });
  const request = provider.request(input(), gateSelection());
  await transportStarted;
  const command = { ...input(), leaseId: 'lease-1', generation: 1, podUid: 'lease-pod-uid',
    podName: spec.name, podContext: spec.kubectlContext, image: spec.image,
    requestedAt: new Date().toISOString(), workerId: spec.workerId, key };
  await provider.quarantine(command, 'concurrent-gate-fallback');
  finishTransport();
  const result = await request;
  const cleanupKey = JSON.stringify([command.workerId, command.leaseId, command.generation, command.podUid]);

  expect(result.transport.reason).toBe('complete');
  expect((provider as any).cleanupVerifiedLeases.has(cleanupKey)).toBe(false);
  await expect(provider.finalize(result.command!)).rejects.toThrow('warm lease already quarantined');
  expect(paths).toEqual(['/v1/leases/pod-worker', `/v1/leases/pod-worker/${spec.workerId}/quarantine`]);
});
test('provider quarantines a return without the runtime cleanup receipt', async () => {
  const paths: string[] = [];
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl(),
    fetch: async url => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return Response.json(path === '/v1/leases/pod-worker' ? lease() : { attrs: { state: 'quarantined' } });
    },
  });
  const command = { ...input(), leaseId: 'lease-1', generation: 1, podUid: 'lease-pod-uid',
    podName: spec.name, podContext: spec.kubectlContext, image: spec.image,
    requestedAt: new Date().toISOString(), workerId: spec.workerId, key };

  await expect(provider.finalize(command)).rejects.toThrow('warm cleanup unverified');
  expect(paths).toEqual([`/v1/leases/pod-worker/${spec.workerId}/quarantine`]);
});

test('provider quarantines incomplete runtime cleanup without releasing the lease', async () => {
  const paths: string[] = [];
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl(),
    fetch: async url => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return Response.json(path === '/v1/leases/pod-worker' ? lease() : { attrs: { state: 'quarantined' } });
    },
    transport: () => ({ request: async () => ({ status: 'observed', reason: 'worker-quarantined', reply: null }) }),
  });
  const result = await provider.request(input(), gateSelection());
  expect(result.command).not.toBeNull();
  expect(result.transport.reason).toBe('worker-quarantined');
  await expect(provider.finalize(result.command!)).rejects.toThrow('warm lease already quarantined');
  expect(paths).toEqual([`/v1/leases/pod-worker`, `/v1/leases/pod-worker/${spec.workerId}/quarantine`]);
});

test('cleanup proof is scoped to worker, lease, generation, and Pod UID', async () => {
  for (const [field, value] of [
    ['workerId', 'other-worker'], ['leaseId', 'other-lease'], ['generation', 2], ['podUid', 'other-pod-uid'],
  ] as const) {
    const paths: string[] = [];
    const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl(),
      fetch: async url => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        return Response.json(path === '/v1/leases/pod-worker' ? lease() : { attrs: { state: 'quarantined' } });
      },
      transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
    });
    const result = await provider.request(input(), gateSelection());
    expect(result.command).not.toBeNull();
    const mismatched = Object.assign({}, result.command, { [field]: value });
    await expect(provider.finalize(mismatched)).rejects.toThrow('warm cleanup unverified');
    expect(paths.some(path => path.endsWith('/release') || path.endsWith('/sanitize'))).toBe(false);
    expect(paths.some(path => path.endsWith('/quarantine'))).toBe(true);
  }
});

test('lease occupancy transitions carry stable run identity and measured acquisition wait', async () => {
  const events: Array<{ event: string; data: any }> = [];
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl(),
    fetch: async url => new URL(String(url)).pathname === '/v1/leases/pod-worker'
      ? Response.json(lease()) : Response.json({ attrs: { state: 'idle' } }),
    transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
  });
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm' && ['lease-acquire-wait', 'lease-occupancy-transition'].includes(event))
      events.push({ event, data });
  }) as typeof debug.log);
  try {
    const result = await provider.request(input(), gateSelection());
    expect(result.command).not.toBeNull();
    await provider.finalize(result.command!);
  } finally { log.mockRestore(); }
  expect(events.find(row => row.event === 'lease-acquire-wait')?.data).toMatchObject({
    schema: 1, profile: 'fixed', host: 'test-host', tier: 'standard', runId: 'run-1',
    consumer: 'warm-pod-provider', waitMs: expect.any(Number), status: 200, outcome: 'response',
    measured: true, observedAt: expect.any(String),
  });
  expect(events.filter(row => row.event === 'lease-occupancy-transition').map(row => row.data))
    .toEqual([expect.objectContaining({ state: 'leased', leasedDelta: 1, measured: true, runId: 'run-1' }),
      expect.objectContaining({ state: 'idle', leasedDelta: -1, measured: true, runId: 'run-1' })]);
});

test('quarantine with unconfirmed Pod cleanup does not report measured lease release', async () => {
  const events: Array<{ event: string; data: any }> = [];
  const baseKubectl = leaseKubectl();
  let failQuarantinePatch = false;
  let failedPatchCalls = 0;
  const kubectl: NonNullable<WarmPodProviderOptions['kubectl']> = args => {
    if (failQuarantinePatch && args.includes('patch') && failedPatchCalls === 0) {
      failedPatchCalls += 1;
      return { status: 1, stdout: '', stderr: 'injected quarantine metadata patch failure' };
    }
    return baseKubectl(args);
  };
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, kubectl,
    fetch: async url => {
      const path = new URL(String(url)).pathname;
      return path === '/v1/leases/pod-worker' ? Response.json(lease()) : Response.json({ attrs: { state: 'quarantined' } });
    },
    transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
  });
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm' && event === 'lease-occupancy-transition') events.push({ event, data });
  }) as typeof debug.log);
  let command: any;
  try {
    const result = await provider.request(input(), gateSelection());
    expect(result.command).not.toBeNull();
    command = result.command;
    failQuarantinePatch = true;
    await provider.quarantine(command, 'cleanup-failure');
    // If a later observation confirms cleanup, the original measured lease must still be paired.
    (provider as any).logLeaseOccupancyTransition(candidate, command!.leaseId, command!.generation,
      command!.podUid, 'run-1', 'quarantined');
  } finally { log.mockRestore(); }
  expect(failedPatchCalls).toBe(1);
  expect(events.slice(0, 2).map(row => row.data)).toEqual([
    expect.objectContaining({ state: 'leased', leasedDelta: 1, measured: true }),
    expect.objectContaining({ state: 'quarantined', leasedDelta: null, measured: false,
      reason: 'lease-cleanup-unconfirmed' }),
  ]);
  expect(events.at(-1)?.data).toMatchObject({ state: 'quarantined', leasedDelta: -1, measured: true });
});

test('Kubernetes quarantine fences sibling providers when both local state writes fail', async () => {
  const baseKubectl = leaseKubectl();
  const leaseCalls: string[] = [];
  const sharedStatePath = join(providerStateRoot, `shared-failure-${++providerStateIndex}.json`);
  const options: WarmPodProviderOptions = { candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, rotationStatePath: sharedStatePath,
    kubectl: baseKubectl,
    fetch: async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/leases/pod-worker') { leaseCalls.push(path); return Response.json(lease()); }
      return Response.json({ attrs: { state: 'quarantined' } });
    },
    transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
  };
  const first = newTestWarmPodProvider(options);
  const sibling = newTestWarmPodProvider(options);
  (first as any).persistQuarantinedWorkerIds = () => { throw new Error('injected quarantine state write failure'); };
  (first as any).persistWarmReuseDisabled = () => { throw new Error('injected disabled marker write failure'); };

  const used = await first.request(input(), gateSelection());
  expect(used.command).not.toBeNull();
  await first.quarantine(used.command!, 'injected-local-state-write-failure');
  const adoptedPod = JSON.parse(baseKubectl(['--context', spec.kubectlContext, '-n', spec.namespace,
    'get', 'pod', spec.name, '-o', 'json']).stdout);
  expect(adoptedPod.metadata.labels['elanous.ai/quarantined']).toBe('true');

  const siblingReplay = await sibling.request(input(), gateSelection());
  expect(siblingReplay.command).toBeNull();
  expect(siblingReplay.transport.reason).toBe('no-candidate');
  expect(leaseCalls).toHaveLength(1);
});

test('failed Kubernetes label quarantine falls back to shared durable block for sibling and restarted providers', async () => {
  const baseKubectl = leaseKubectl();
  const leaseCalls: string[] = [];
  const order: string[] = [];
  const events: Array<{ event: string; data: any }> = [];
  const sharedStatePath = join(providerStateRoot, `shared-label-failure-${++providerStateIndex}.json`);
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm.provider' && event === 'cluster-quarantine-failed') events.push({ event, data });
  }) as typeof debug.log);
  const options: WarmPodProviderOptions = { candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, rotationStatePath: sharedStatePath,
    kubectl: args => {
      if (args[4] === 'patch') {
        const body = JSON.parse(args[args.indexOf('-p') + 1]!);
        if (body[2]?.path === '/metadata/labels/elanous.ai~1quarantined') {
          order.push('pod-label');
          return { status: 1, stdout: '', stderr: 'injected label patch failure' };
        }
      }
      return baseKubectl(args);
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/leases/pod-worker') { leaseCalls.push(path); return Response.json(lease()); }
      if (path.endsWith('/quarantine')) order.push('control-quarantine');
      return Response.json({ attrs: { state: 'quarantined' } });
    },
    transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
  };
  try {
    const first = newTestWarmPodProvider(options);
    const sibling = newTestWarmPodProvider(options);
    const used = await first.request(input(), gateSelection());
    expect(used.command).not.toBeNull();
    await first.quarantine(used.command!, 'injected-kubernetes-label-failure');
    expect(order.slice(0, 2)).toEqual(['pod-label', 'control-quarantine']);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ workerId: spec.workerId, reason: 'conditional-patch-failed' });

    const siblingReplay = await sibling.request(input(), gateSelection());
    expect(siblingReplay.command).toBeNull();
    expect(siblingReplay.transport.reason).toBe('no-candidate');
    const restarted = newTestWarmPodProvider(options);
    const restartedReplay = await restarted.request(input(), gateSelection());
    expect(restartedReplay.command).toBeNull();
    expect(restartedReplay.transport.reason).toBe('no-candidate');
    expect(await restarted.reconcilePool()).toMatchObject({ target: 1, ready: 0, failed: [spec.workerId] });
    expect(leaseCalls).toHaveLength(1);
  } finally { log.mockRestore(); }
});

test('lease acquisition timeout records a measured wait without inventing occupancy', async () => {
  const events: Array<{ event: string; data: any }> = [];
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), kubectl: leaseKubectl(),
    fetch: async () => new Promise<Response>(() => {}),
  });
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm' && event === 'lease-acquire-wait') events.push({ event, data });
  }) as typeof debug.log);
  try {
    const replay = await provider.request({ ...input(), deadlineAt: Date.now() + 20 }, gateSelection());
    expect(replay.command).toBeNull();
    expect(replay.transport.reason).toBe('lease-unavailable');
  } finally { log.mockRestore(); }
  expect(events).toHaveLength(1);
  expect(events[0]!.data).toMatchObject({ schema: 1, profile: 'fixed', host: 'test-host', tier: 'standard',
    runId: 'run-1', consumer: 'warm-pod-provider', outcome: 'timeout', status: null,
    measured: true, waitMs: expect.any(Number), observedAt: expect.any(String) });
});

test('a verified cleanup still cannot return a Pod whose lease metadata patch mismatches', async () => {
  const paths: string[] = [];
  let patches = 0;
  const baseKubectl = leaseKubectl();
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { ['test-host']: '2'.repeat(64) },
    kubectl: args => {
      if (args[4] === 'patch' && ++patches === 2) return { status: 1, stdout: '', stderr: 'lease state changed' };
      return baseKubectl(args);
    },
    fetch: async url => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return Response.json(path === '/v1/leases/pod-worker' ? lease() : { attrs: { state: 'quarantined' } });
    },
    transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
  });
  const result = await provider.request(input(), gateSelection());
  expect(result.command).not.toBeNull();
  await expect(provider.finalize(result.command!)).rejects.toThrow('warm sanitize unavailable');
  expect(paths).toEqual([
    `/v1/leases/pod-worker`,
    `/v1/leases/pod-worker/${spec.workerId}/release`,
    `/v1/leases/pod-worker/${spec.workerId}/quarantine`,
  ]);
});

test('a sanitize failure followed by the gate fallback quarantines one lease only once', async () => {
  const paths: string[] = [];
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl(),
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return path === '/v1/leases/pod-worker' ? Response.json(lease())
        : new Response('{}', { status: path.endsWith('/sanitize') ? 503 : 200 });
    },
    transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
  });
  const result = await provider.request(input(), gateSelection());
  expect(result.command).not.toBeNull();
  await expect(provider.finalize(result.command!)).rejects.toThrow('warm sanitize unavailable');
  await provider.quarantine(result.command!, 'gate-finalize-failed');
  expect(paths.filter(path => path.endsWith('/quarantine'))).toHaveLength(1);
});

test('gate fallback quarantines a lease even when sanitize completes after the timeout', async () => {
  const paths: string[] = [];
  const sibling = { ...spec, name: 'warm-test-2', workerId: 'warm-test-2-uid' };
  let acquisitions = 0;
  let releaseSanitize: (() => void) | undefined;
  let sanitizeStarted: (() => void) | undefined;
  const sanitizePause = new Promise<void>(resolve => { releaseSanitize = resolve; });
  const enteredSanitize = new Promise<void>(resolve => { sanitizeStarted = resolve; });
  const provider = newTestWarmPodProvider({ candidates: [candidate, { ...candidate, spec: sibling }], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl([spec, sibling]),
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path.endsWith('/sanitize')) { sanitizeStarted!(); await sanitizePause; }
      return path === '/v1/leases/pod-worker'
        ? Response.json(acquisitions++ === 0 ? lease() : { ...lease(), name: sibling.workerId, attrs: { ...lease().attrs, leaseId: 'lease-2' } })
        : Response.json({ attrs: { state: 'idle' } });
    },
    transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
  });
  const result = await provider.request(input(), gateSelection());
  const finalizing = provider.finalize(result.command!);
  await enteredSanitize;
  const fallback = provider.quarantine(result.command!, 'adoption-fallback');
  const next = await provider.request(input(), gateSelection());
  expect(next.command?.workerId).toBe(sibling.workerId);
  expect(paths.filter(path => path === '/v1/leases/pod-worker')).toHaveLength(2);
  releaseSanitize!();
  const settled = await Promise.allSettled([finalizing, fallback]);
  expect(settled[0]).toMatchObject({ status: 'rejected' });
  expect(settled[1]).toMatchObject({ status: 'fulfilled' });
  expect(paths.filter(path => path.endsWith('/sanitize'))).toHaveLength(1);
  expect(paths.filter(path => path.endsWith('/quarantine'))).toHaveLength(1);
});

test('concurrent quarantine callers share one fenced lease transition', async () => {
  const paths: string[] = [];
  let releaseQuarantine: (() => void) | undefined;
  const quarantinePause = new Promise<void>(resolve => { releaseQuarantine = resolve; });
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl(),
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path.endsWith('/quarantine')) await quarantinePause;
      return path === '/v1/leases/pod-worker' ? Response.json(lease()) : Response.json({ attrs: { state: 'quarantined' } });
    },
    transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
  });
  const result = await provider.request(input(), gateSelection());
  const first = provider.quarantine(result.command!, 'first-failure');
  const second = provider.quarantine(result.command!, 'same-failure');
  releaseQuarantine!();
  await Promise.all([first, second]);
  expect(paths.filter(path => path.endsWith('/quarantine'))).toHaveLength(1);
});

test('a failed quarantine transition can retry the same lease', async () => {
  let quarantineCalls = 0;
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl(),
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/leases/pod-worker') return Response.json(lease());
      if (path.endsWith('/quarantine')) return new Response('{}', { status: ++quarantineCalls === 1 ? 503 : 200 });
      return Response.json({ attrs: { state: 'idle' } });
    },
    transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
  });
  const result = await provider.request(input(), gateSelection());
  await expect(provider.quarantine(result.command!, 'first-failure')).rejects.toThrow('warm quarantine unavailable');
  await provider.quarantine(result.command!, 'retry');
  expect(quarantineCalls).toBe(2);
});

test('a failed quarantine blocks the worker for sibling and restarted provider requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-quarantine-block-'));
  try {
    const statePath = join(root, 'rotations.json');
    let quarantineCalls = 0;
    let unexpectedControlCalls = 0;
    const options: WarmPodProviderOptions = { candidates: [candidate], rotationStatePath: statePath,
      controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
      machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl(),
      fetch: async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/leases/pod-worker') return Response.json(lease());
        if (path.endsWith('/quarantine')) return new Response('{}', { status: ++quarantineCalls === 1 ? 503 : 200 });
        unexpectedControlCalls++;
        return Response.json({ attrs: { state: 'idle' } });
      },
      transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
    };
    const provider = newTestWarmPodProvider(options);
    const alreadyRunningSibling = newTestWarmPodProvider(options);
    const acquired = await provider.request(input(), gateSelection());
    await expect(provider.quarantine(acquired.command!, 'failed-transition')).rejects.toThrow('warm quarantine unavailable');
    expect(await provider.request({ ...input(), runId: 'sibling-run', attemptId: 'sibling-attempt' }, gateSelection()))
      .toMatchObject({ command: null, transport: { status: 'fallback', reason: 'no-candidate' } });
    expect(await alreadyRunningSibling.request({ ...input(), runId: 'other-provider-run', attemptId: 'other-provider-attempt' }, gateSelection()))
      .toMatchObject({ command: null, transport: { status: 'fallback', reason: 'no-candidate' } });
    expect(JSON.parse(readFileSync(`${statePath}.quarantined`, 'utf8'))).toEqual([spec.workerId]);

    const restarted = newTestWarmPodProvider(options);
    expect(await restarted.request({ ...input(), runId: 'later-run', attemptId: 'later-attempt' }, gateSelection()))
      .toMatchObject({ command: null, transport: { status: 'fallback', reason: 'no-candidate' } });
    expect(unexpectedControlCalls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a quarantine state write failure disables warm reuse in the current and restarted provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-quarantine-state-failure-'));
  try {
    const statePath = join(root, 'rotations.json');
    let leaseCalls = 0;
    const options: WarmPodProviderOptions = { candidates: [candidate], rotationStatePath: statePath,
      controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
      machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl(),
      fetch: async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/leases/pod-worker') { leaseCalls++; return Response.json(lease()); }
        if (path.endsWith('/quarantine')) return new Response('{}', { status: 503 });
        return Response.json({ attrs: { state: 'idle' } });
      },
      transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
    };
    const provider = newTestWarmPodProvider(options);
    const acquired = await provider.request(input(), gateSelection());
    // A non-file at the state target deterministically injects the atomic rename failure.
    mkdirSync(`${statePath}.quarantined`);
    await expect(provider.quarantine(acquired.command!, 'failed-transition')).rejects.toThrow('warm quarantine unavailable');
    await expect(provider.request({ ...input(), runId: 'disabled-run' }, gateSelection()))
      .resolves.toMatchObject({ command: null, transport: { status: 'fallback', reason: 'no-candidate' } });
    expect(JSON.parse(readFileSync(`${statePath}.disabled`, 'utf8'))).toEqual({ disabled: true });

    const restarted = newTestWarmPodProvider(options);
    await expect(restarted.request({ ...input(), runId: 'after-restart' }, gateSelection()))
      .resolves.toMatchObject({ command: null, transport: { status: 'fallback', reason: 'no-candidate' } });
    expect(leaseCalls).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a provider without durable quarantine state never selects a worker', async () => {
  let leaseCalls = 0;
  const options: WarmPodProviderOptions = { candidates: [candidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    fetch: async () => { leaseCalls++; return Response.json(lease()); },
    transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
  };
  for (const provider of [new WarmPodProvider({ ...options, quotaResolverForTest: testHostQuota }),
    new WarmPodProvider({ ...options, quotaResolverForTest: testHostQuota })]) {
    await expect(provider.request(input(), gateSelection()))
      .resolves.toMatchObject({ command: null, transport: { status: 'fallback', reason: 'no-candidate' } });
    expect(await provider.reconcilePool()).toMatchObject({ target: 1, ready: 0, failed: [spec.workerId] });
  }
  expect(leaseCalls).toBe(0);
});

test('WARM-POOL-CORE-FU1: 지연 응답→timeout→늦은 lease 응답과 finalize/quarantine 경합에서 종결을 한 번만 채택한다', async () => {
  const events: Array<{ event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.provenance'
      || (category === 'pod.warm' && (event === 'request-selection' || event === 'lease-terminal-refused')))
      events.push({ event, data });
  }) as typeof debug.log);
  // Fake provider: 첫 lease 획득 응답이 timeout 경계를 넘어 지연되고, 경합 종결 뒤에 늦게 도착한다.
  const terminal = () => {
    const terminalCalls: string[] = [];
    let acquisitions = 0;
    let releaseAcquisition: (() => void) | undefined;
    let acquisitionEntered: (() => void) | undefined;
    const acquisitionPause = new Promise<void>(resolve => { releaseAcquisition = resolve; });
    const acquisitionStarted = new Promise<void>(resolve => { acquisitionEntered = resolve; });
    const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl(),
      fetch: async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/leases/pod-worker') {
          acquisitions++;
          if (acquisitions === 1) { acquisitionEntered!(); await acquisitionPause; }
          return Response.json(lease());
        }
        if (path.endsWith('/release') || path.endsWith('/sanitize') || path.endsWith('/quarantine'))
          terminalCalls.push(path);
        return Response.json({ attrs: { state: 'idle' } });
      },
      transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
    });
    return { provider, terminalCalls, started: acquisitionStarted, release: () => releaseAcquisition!() };
  };
  const command = () => ({ ...input(), leaseId: 'lease-1', generation: 1, podUid: 'lease-pod-uid',
    podName: spec.name, podContext: spec.kubectlContext, image: spec.image,
    requestedAt: new Date().toISOString(), workerId: spec.workerId, key });
  try {
    // finalize 경합: 정상 finalize가 같은 키의 종결을 먼저 채택하면 늦은 lease 응답은 재채택되지 않는다.
    const finalizeRace = terminal();
    const late = finalizeRace.provider.request(input(), gateSelection());
    await finalizeRace.started;
    await expect(finalizeRace.provider.finalize(command())).rejects.toThrow('warm cleanup unverified');
    finalizeRace.release();
    const lateResult = await late;
    expect(lateResult.command).toBeNull();
    expect(lateResult.transport).toEqual({ status: 'fallback', reason: 'lease-unavailable', reply: null });
    expect(finalizeRace.terminalCalls).toEqual([
      `/v1/leases/pod-worker/${spec.workerId}/quarantine`,
    ]);
    // terminal 요청 중복 0 — 격리된 종결을 finalize로 뒤집지 못한다.
    await expect(finalizeRace.provider.finalize(command())).rejects.toThrow('warm lease already quarantined');
    expect(finalizeRace.terminalCalls).toHaveLength(1);
    // lease-end 중복 0
    expect(events.filter(row => row.event === 'lease-end')).toHaveLength(1);
    // 격리 terminal은 성공 여부와 관계없이 worker 전체를 막는다.
    const blocked = await finalizeRace.provider.request(input(), gateSelection());
    expect(blocked.command).toBeNull();
    expect(blocked.transport.reason).toBe('no-candidate');
    expect(events.filter(row => row.event === 'lease-terminal-refused')).toHaveLength(1);

    // quarantine 경합: 불확실한 종료(격리) 뒤 늦은 lease 응답도 재채택 없이 냉 Job 판정을 유지한다.
    events.length = 0;
    const quarantineRace = terminal();
    const lateQuarantine = quarantineRace.provider.request(input(), gateSelection());
    await quarantineRace.started;
    await quarantineRace.provider.quarantine(command(), 'adoption-fallback');
    quarantineRace.release();
    const quarantineResult = await lateQuarantine;
    expect(quarantineResult.command).toBeNull();
    expect(quarantineResult.transport.reason).toBe('lease-unavailable');
    expect(quarantineRace.terminalCalls).toEqual([`/v1/leases/pod-worker/${spec.workerId}/quarantine`]);
    await quarantineRace.provider.quarantine(command(), 'late-failure');
    expect(quarantineRace.terminalCalls).toHaveLength(1);
    expect(events.filter(row => row.event === 'lease-end')).toHaveLength(1);
    const blockedQuarantine = await quarantineRace.provider.request(input(), gateSelection());
    expect(blockedQuarantine.command).toBeNull();
    expect(blockedQuarantine.transport.reason).toBe('no-candidate');

    // One adopted lease can enter finalize and caller-timeout quarantine concurrently; quarantine wins once sanitize settles.
    events.length = 0;
    const terminalCalls: string[] = [];
    let releaseSanitize!: () => void;
    let enterSanitize!: () => void;
    let enterQuarantine!: () => void;
    const sanitizeEntered = new Promise<void>(resolve => { enterSanitize = resolve; });
    const quarantineEntered = new Promise<void>(resolve => { enterQuarantine = resolve; });
    const sanitizePause = new Promise<void>(resolve => { releaseSanitize = resolve; });
    let controlState = 'idle';
    let acquisitions = 0;
    const fetchControl = async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/leases/pod-worker') {
        if (controlState !== 'idle') return new Response('{}', { status: 409 });
        acquisitions++;
        controlState = 'leased';
        return Response.json(lease());
      }
      if (path.endsWith('/release')) controlState = 'sanitizing';
      if (path.endsWith('/quarantine')) { controlState = 'quarantined'; enterQuarantine(); }
      if (path.endsWith('/sanitize')) {
        terminalCalls.push(path);
        enterSanitize();
        await sanitizePause;
        if (controlState !== 'quarantined') controlState = 'idle';
        return Response.json({ attrs: { state: 'idle' } });
      }
      if (path === '/v1/resources') return Response.json({ resources: [{ name: spec.workerId,
        attrs: { state: controlState === 'quarantined' ? 'quarantined' : controlState } }] });
      terminalCalls.push(path);
      return Response.json({ attrs: { state: controlState } });
    };
    const raceOptions: WarmPodProviderOptions = { candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), machineTokens: { ['test-host']: '2'.repeat(64) }, kubectl: leaseKubectl(), fetch: fetchControl,
      now: () => Date.now() - 1_000,
      transport: () => ({ request: async command => ({ status: 'observed', reason: 'complete', reply: completeReply(command) }) }),
    };
    const adoptedRace = newTestWarmPodProvider(raceOptions);
    const contender = newTestWarmPodProvider(raceOptions);
    const adopted = await adoptedRace.request(input(), gateSelection());
    expect(adopted.command).not.toBeNull();
    const finalizing = adoptedRace.finalize(adopted.command!);
    await sanitizeEntered;
    const quarantineAfterTimeout = adoptedRace.quarantine(adopted.command!, 'caller-timeout');
    await quarantineEntered;
    const contenderAttempt = await contender.request(input(), gateSelection());
    expect(contenderAttempt.command).toBeNull();
    expect(contenderAttempt.transport.reason).toBe('no-candidate');
    releaseSanitize();
    const [finalized, quarantined] = await Promise.allSettled([finalizing, quarantineAfterTimeout]);
    expect(finalized.status).toBe('rejected');
    expect(quarantined.status).toBe('fulfilled');
    expect(terminalCalls).toEqual([
      `/v1/leases/pod-worker/${spec.workerId}/release`,
      `/v1/leases/pod-worker/${spec.workerId}/sanitize`,
      `/v1/leases/pod-worker/${spec.workerId}/quarantine`,
    ]);
    expect(events.filter(row => row.event === 'lease-end')).toHaveLength(1);
    const refusedAfterRace = await contender.request(input(), gateSelection());
    expect(refusedAfterRace.command).toBeNull();
    expect(refusedAfterRace.transport.reason).toBe('no-candidate');
  } finally { log.mockRestore(); }
});

test('a timed-out acquisition fences only its worker; its sibling remains reusable and late lease is quarantined', async () => {
  const siblingSpec: WarmPodSpec = { ...spec, name: 'warm-test-2', workerId: 'warm-test-2-uid',
    key: { ...key, context: 'pool-test-host-sibling' } };
  const siblingCandidate = { ...candidate, spec: siblingSpec };
  const states = new Map([[spec.workerId, 'idle'], [siblingSpec.workerId, 'idle']]);
  let enterAcquire!: () => void;
  const acquireEntered = new Promise<void>(resolve => { enterAcquire = resolve; });
  let enterFence!: () => void;
  const fenceEntered = new Promise<void>(resolve => { enterFence = resolve; });
  let releaseLate!: (response: Response) => void;
  let lateQuarantine!: () => void;
  const lateQuarantined = new Promise<void>(resolve => { lateQuarantine = resolve; });
  let transported = 0;
  const provider = newTestWarmPodProvider({ candidates: [candidate, siblingCandidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { [candidate.host]: '2'.repeat(64) }, kubectl: leaseKubectl([spec, siblingSpec]),
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/leases/pod-worker') {
        const body = JSON.parse(String(init?.body));
        const worker = body.key.context === siblingSpec.key.context ? siblingSpec : spec;
        if (states.get(worker.workerId) !== 'idle') return new Response('{}', { status: 409 });
        states.set(worker.workerId, 'leased');
        const response = Response.json({ name: worker.workerId, attrs: { key: worker.key,
          leaseId: `lease-${worker.workerId}`, generation: 1, podUid: 'lease-pod-uid', state: 'leased' } });
        if (worker.workerId === spec.workerId) {
          enterAcquire();
          return new Promise<Response>(resolve => { releaseLate = resolve; });
        }
        return response;
      }
      const workerId = path.split('/').at(-2)!;
      if (path.endsWith('/timeout')) { states.set(workerId, 'timeout-fenced'); enterFence(); return Response.json({ attrs: { state: 'timeout-fenced' } }); }
      if (path.endsWith('/quarantine')) {
        states.set(workerId, 'quarantined');
        if (workerId === spec.workerId) lateQuarantine();
        return Response.json({ attrs: { state: 'quarantined' } });
      }
      return Response.json({ attrs: { state: 'released' } });
    },
    transport: () => ({ request: async command => { transported++; return { status: 'observed', reason: 'complete', reply: completeReply(command) }; } }),
  });
  const timedOut = provider.request({ ...input(), deadlineAt: Date.now() + 30 }, gateSelection());
  await acquireEntered;
  const timeoutResult = await timedOut;
  expect(timeoutResult).toMatchObject({ command: null, transport: { status: 'fallback', reason: 'lease-unavailable' } });
  const sibling = await provider.request({ ...input(), runId: 'sibling-run', attemptId: 'sibling-attempt' }, gateSelection());
  expect(sibling.command).toMatchObject({ workerId: siblingSpec.workerId, leaseId: `lease-${siblingSpec.workerId}` });
  expect(transported).toBe(1);
  expect(states.get(spec.workerId)).toBe('leased');
  releaseLate!(Response.json({ name: spec.workerId, attrs: { key, leaseId: `lease-${spec.workerId}`,
    generation: 1, podUid: 'lease-pod-uid', state: 'leased' } }));
  await fenceEntered;
  await lateQuarantined;
  expect(states.get(spec.workerId)).toBe('quarantined');
  expect(transported).toBe(1);
  await provider.quarantine(sibling.command!, 'test-cleanup');
});

test('a delayed sibling lease is fenced and quarantined by the worker ID actually returned', async () => {
  const returnedSpec: WarmPodSpec = { ...spec, name: 'warm-test-returned', workerId: 'warm-test-returned-uid' };
  const returnedCandidate = { ...candidate, spec: returnedSpec };
  let enterAcquire!: () => void;
  const acquireEntered = new Promise<void>(resolve => { enterAcquire = resolve; });
  let releaseAcquire!: (response: Response) => void;
  let enterFence!: (workerId: string) => void;
  let enterQuarantine!: (workerId: string) => void;
  const fenceEntered = new Promise<string>(resolve => { enterFence = resolve; });
  const quarantineEntered = new Promise<string>(resolve => { enterQuarantine = resolve; });
  const provider = newTestWarmPodProvider({ candidates: [candidate, returnedCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64), machineTokens: { ['test-host']: '2'.repeat(64) },
    kubectl: leaseKubectl([spec, returnedSpec]),
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/leases/pod-worker') {
        enterAcquire();
        return new Promise<Response>(resolve => { releaseAcquire = resolve; });
      }
      if (path.endsWith('/timeout')) { enterFence(path.split('/').at(-2)!); return Response.json({ attrs: { state: 'timeout-fenced' } }); }
      if (path.endsWith('/quarantine')) { enterQuarantine(path.split('/').at(-2)!); return Response.json({ attrs: { state: 'quarantined' } }); }
      return Response.json({ attrs: { state: 'released' } });
    },
  });
  const pending = provider.request({ ...input(), deadlineAt: Date.now() + 30 }, gateSelection());
  await acquireEntered;
  const result = await pending;
  expect(result.command).toBeNull();
  releaseAcquire!(Response.json({ name: returnedSpec.workerId, attrs: { key, leaseId: 'lease-returned',
    generation: 2, podUid: 'lease-pod-uid', state: 'leased' } }));
  expect(await fenceEntered).toBe(returnedSpec.workerId);
  expect(await quarantineEntered).toBe(returnedSpec.workerId);
});

test('a timed-out fence request is bounded and the late lease is still quarantined', async () => {
  let enterAcquire!: () => void;
  const acquireEntered = new Promise<void>(resolve => { enterAcquire = resolve; });
  let releaseAcquire!: (response: Response) => void;
  let enterQuarantine!: () => void;
  const quarantineEntered = new Promise<void>(resolve => { enterQuarantine = resolve; });
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { ['test-host']: '2'.repeat(64) }, kubectl: leaseKubectl(),
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/leases/pod-worker') {
        enterAcquire();
        return new Promise<Response>(resolve => { releaseAcquire = resolve; });
      }
      if (path.endsWith('/timeout')) return new Promise<Response>(() => {});
      if (path.endsWith('/quarantine')) { enterQuarantine(); return Response.json({ attrs: { state: 'quarantined' } }); }
      return Response.json({ attrs: { state: 'released' } });
    },
  });
  const pending = provider.request({ ...input(), deadlineAt: Date.now() + 30 }, gateSelection());
  await acquireEntered;
  const result = await pending;
  expect(result.command).toBeNull();
  releaseAcquire!(Response.json({ name: spec.workerId, attrs: { key, leaseId: 'lease-late-timeout',
    generation: 1, podUid: 'lease-pod-uid', state: 'leased' } }));
  await quarantineEntered;
});

test('a quarantined warm worker emits a slot-hold observation when acquisition is refused', async () => {
  const observations: Array<{ category: string; event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (event === 'quarantine-holds-slot') observations.push({ category, event, data });
  }) as typeof debug.log);
  try {
    const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), machineTokens: { ['test-host']: '2'.repeat(64) }, kubectl: leaseKubectl(),
      fetch: async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === '/v1/leases/pod-worker') return new Response('{}', { status: 409 });
        if (parsed.pathname === '/v1/resources') return Response.json({ resources: [{ name: spec.workerId,
          attrs: { state: 'timeout-fenced' } }] });
        return Response.json({});
      },
    });
    const result = await provider.request(input(), gateSelection());
    expect(result.transport).toMatchObject({ status: 'fallback', reason: 'lease-unavailable' });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ category: 'pod.warm', event: 'quarantine-holds-slot',
      data: { workerId: spec.workerId, state: 'timeout-fenced' } });
    expect(typeof observations[0]?.data.at).toBe('string');
  } finally { log.mockRestore(); }
});

test('a stalled diagnostic ledger read after lease conflict stays within its bound', async () => {
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { ['test-host']: '2'.repeat(64) }, kubectl: leaseKubectl(),
    fetch: async url => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/v1/leases/pod-worker') return new Response('{}', { status: 409 });
      if (parsed.pathname === '/v1/resources') return new Promise<Response>(() => {});
      throw new Error(`unexpected request ${parsed.pathname}`);
    },
  });
  const startedAt = Date.now();
  const result = await provider.request(input(), gateSelection());
  expect(result).toMatchObject({ command: null,
    transport: { status: 'fallback', reason: 'lease-unavailable', reply: null } });
  expect(Date.now() - startedAt).toBeLessThan(3_000);
});

test('multiple lease conflicts respect the request deadline instead of accumulating diagnostic waits', async () => {
  const second = { host: 'test-host-b', tier: 'standard' as const, spec: { ...spec,
    name: 'warm-test-host-b-standard-1', workerId: 'other-worker',
    nodeName: 'pool-test-host-b-server-0' } };
  let diagnostics = 0;
  const provider = newTestWarmPodProvider({ candidates: [candidate, second], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { ['test-host']: '2'.repeat(64), 'test-host-b': '3'.repeat(64) },
    kubectl: leaseKubectl([spec, second.spec]),
    fetch: async url => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/v1/leases/pod-worker') return new Response('{}', { status: 409 });
      if (parsed.pathname === '/v1/resources') { diagnostics++; return new Promise<Response>(() => {}); }
      throw new Error(`unexpected request ${parsed.pathname}`);
    },
  });
  const startedAt = Date.now();
  const result = await provider.request({ ...input(), deadlineAt: startedAt + 100 }, gateSelection());
  expect(result.transport.reason).toBe('lease-unavailable');
  expect(diagnostics).toBe(1);
  expect(Date.now() - startedAt).toBeLessThan(150);
});

test('a late lease returns cold fallback when its quarantine control response stalls', async () => {
  let nowCalls = 0;
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { ['test-host']: '2'.repeat(64) }, kubectl: leaseKubectl(),
    now: () => ++nowCalls <= 3 ? 100 : 102,
    fetch: async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/leases/pod-worker') return Response.json({ name: spec.workerId,
        attrs: { key, leaseId: 'lease-late', generation: 1, podUid: 'lease-pod-uid', state: 'leased' } });
      if (path.endsWith('/quarantine')) return new Promise<Response>(() => {});
      throw new Error(`unexpected request ${path}`);
    },
  });
  const startedAt = Date.now();
  const result = await provider.request({ ...input(), deadlineAt: 101 }, gateSelection());
  expect(result).toMatchObject({ command: null,
    transport: { status: 'fallback', reason: 'lease-unavailable', reply: null } });
  expect(Date.now() - startedAt).toBeLessThan(3_000);
});

test('an uncertain quarantine refuses the same Pod before a second transport', async () => {
  let acquisitions = 0;
  let transportRuns = 0;
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl(),
    fetch: async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/leases/pod-worker') return Response.json({ ...lease(), attrs: {
        ...lease().attrs, leaseId: `lease-${++acquisitions}`, generation: acquisitions,
      } });
      if (path.endsWith('/quarantine') && acquisitions === 1) return new Response('{}', { status: 503 });
      return Response.json({ attrs: { state: 'quarantined' } });
    },
    transport: () => ({ request: async command => { transportRuns++; return { status: 'observed', reason: 'complete', reply: completeReply(command) }; } }),
  });
  const first = await provider.request(input(), gateSelection());
  await expect(provider.quarantine(first.command!, 'first-failure')).rejects.toThrow('warm quarantine unavailable');
  const second = await provider.request(input(), gateSelection());
  expect(second.command).toBeNull();
  expect(transportRuns).toBe(1);
});

test('a replaced Pod refuses the acquired lease before transport and quarantines it', async () => {
  const paths: string[] = [];
  let transported = 0;
  const manifest = warmWorkerPodManifest(spec);
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), kubectl: args => {
      expect(args[4]).toBe('get');
      return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { ...(manifest.metadata as object),
        name: spec.name, namespace: spec.namespace, uid: 'replacement-uid', resourceVersion: '1' } }] }), stderr: '' };
    },
    fetch: async url => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return Response.json(path === '/v1/leases/pod-worker' ? lease() : {});
    },
    transport: () => ({ request: async command => {
      transported++;
      return { status: 'observed', reason: 'complete', reply: completeReply(command) };
    } }),
  });
  expect(await provider.request(input(), gateSelection())).toMatchObject({ command: null,
    transport: { status: 'fallback', reason: 'lease-unavailable' } });
  expect(transported).toBe(0);
  expect(paths).toEqual(['/v1/leases/pod-worker', `/v1/leases/pod-worker/${spec.workerId}/quarantine`]);
});

test('a lease refused before start logs lease-refused, never an unpaired lease-end', async () => {
  const events: Array<{ event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.provenance') events.push({ event, data });
  }) as typeof debug.log);
  try {
    const manifest = warmWorkerPodManifest(spec);
    const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), kubectl: () => ({ status: 0, stdout: JSON.stringify({ items: [{ metadata: {
        ...(manifest.metadata as object), name: spec.name, namespace: spec.namespace,
        uid: 'replacement-uid', resourceVersion: '1' } }] }), stderr: '' }),
      fetch: async url => Response.json(new URL(String(url)).pathname === '/v1/leases/pod-worker' ? lease() : {}) });
    await provider.request(input(), gateSelection());
  } finally { log.mockRestore(); }
  const names = events.map(row => row.event);
  expect(names).not.toContain('lease-start');
  expect(names).not.toContain('lease-end');
  expect(events.find(row => row.event === 'lease-refused')?.data)
    .toMatchObject({ leaseId: 'lease-1', leaseStarted: false, reason: 'provenance-unavailable' });
});

test('a host/key lease executes the worker ID returned by the control plane', async () => {
  const secondSpec = { ...spec, name: 'warm-test-2', workerId: 'warm-test-2-uid' };
  const paths: string[] = [];
  let transported = '';
  const provider = newTestWarmPodProvider({ candidates: [candidate, { ...candidate, spec: secondSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    kubectl: leaseKubectl([spec, secondSpec]),
    fetch: async url => {
      const path = new URL(String(url)).pathname; paths.push(path);
      return Response.json(path === '/v1/leases/pod-worker'
        ? { ...lease(), name: secondSpec.workerId } : {});
    },
    transport: selected => ({ request: async command => {
      transported = selected.workerId;
      return { status: 'observed', reason: 'complete', reply: completeReply(command) };
    } }),
  });
  const result = await provider.request(input(), gateSelection());
  expect(result.command?.workerId).toBe(secondSpec.workerId);
  expect(transported).toBe(secondSpec.workerId);
  expect(paths).toEqual(['/v1/leases/pod-worker']);
});

test('an unrecognized leased worker is refused without transport or quarantine', async () => {
  const paths: string[] = [];
  let transported = 0;
  const provider = newTestWarmPodProvider({ candidates: [candidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    kubectl: leaseKubectl(),
    fetch: async url => {
      const path = new URL(String(url)).pathname; paths.push(path);
      return Response.json({ ...lease(), name: 'unknown-worker' });
    },
    transport: () => ({ request: async command => {
      transported++;
      return { status: 'observed', reason: 'complete', reply: completeReply(command) };
    } }),
  });
  expect(await provider.request(input(), gateSelection())).toMatchObject({ command: null,
    transport: { status: 'fallback', reason: 'lease-unavailable' } });
  expect(transported).toBe(0);
  expect(paths).toEqual(['/v1/leases/pod-worker']);
});

test('transport mismatch quarantines the leased worker and never sanitizes it', async () => {
  const paths: string[] = [];
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), fetch: async (url) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      return Response.json(path === '/v1/leases/pod-worker' ? lease() : {});
    }, kubectl: leaseKubectl(),
    transport: () => ({ request: async () => ({ status: 'fallback', reason: 'invalid-result', reply: null }) }) });
  const result = await provider.request(input(), gateSelection());
  expect(result.transport.reason).toBe('invalid-result');
  expect(paths).toEqual(['/v1/leases/pod-worker', `/v1/leases/pod-worker/${spec.workerId}/quarantine`]);
});

test('missing remote-internal context refuses before lease, Pod exec or quarantine', async () => {
  const paths: string[] = [];
  const stderr = 'error: context "k3d-elanous-pool" does not exist\n';
  let transportCalls = 0;
  const provider = newTestWarmPodProvider({
    candidates: [{ ...candidate, spec: { ...spec, kubectlContext: 'k3d-elanous-pool' } }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    kubectl: args => {
      expect(args).toEqual(['config', 'get-contexts', 'k3d-elanous-pool', '-o', 'name']);
      return { status: 1, stdout: '', stderr };
    },
    fetch: async url => { paths.push(new URL(String(url)).pathname); return Response.json(lease()); },
    transport: () => ({ request: async command => { transportCalls++; return { status: 'fallback', reason: 'exec-failed', reply: null }; } }),
  });
  expect(await provider.request(input(), gateSelection())).toEqual({ command: null, transport: {
    status: 'fallback', reason: 'context-unavailable', reply: null, kubectlStderr: stderr,
  } });
  expect(paths).toEqual([]);
  expect(transportCalls).toBe(0);
});

test('a zero shadow budget never starts kubectl and quarantines its acquired lease', async () => {
  const paths: string[] = [];
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), maxShadowMs: 0, kubectl: leaseKubectl(), fetch: async (url) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      return Response.json(path === '/v1/leases/pod-worker' ? lease() : {});
    } });
  expect((await provider.request(input(), gateSelection())).transport).toMatchObject({ status: 'fallback', reason: 'exec-failed' });
  expect(paths).toEqual(['/v1/leases/pod-worker', `/v1/leases/pod-worker/${spec.workerId}/quarantine`]);
});

test('a timed-out kubectl child is stopped before the acquired lease is quarantined', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'warm-provider-timeout-'));
  const marker = join(directory, 'kubectl-started');
  const oldPath = process.env.PATH;
  const oldMarker = process.env.WARM_TEST_MARKER;
  const paths: string[] = [];
  try {
    const binary = join(directory, 'kubectl');
    writeFileSync(binary, '#!/bin/sh\nprintf "%s" "$$" > "$WARM_TEST_MARKER"\ntrap "" TERM\nexec sleep 20\n');
    chmodSync(binary, 0o700);
    process.env.PATH = `${directory}:${oldPath}`;
    process.env.WARM_TEST_MARKER = marker;
    const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), maxShadowMs: 8_000, kubectl: leaseKubectl(), fetch: async (url) => {
        const path = new URL(String(url)).pathname; paths.push(path);
        if (path.endsWith('/quarantine')) {
          const pid = readFileSync(marker, 'utf8').trim();
          const state = spawnSync('ps', ['-p', pid, '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
          expect(state === '' || state.startsWith('Z')).toBe(true);
        }
        return Response.json(path === '/v1/leases/pod-worker' ? lease() : {});
      } });
    const started = Date.now();
    const result = await provider.request(input(), gateSelection());
    expect(result.transport).toMatchObject({ status: 'fallback', reason: 'exec-failed' });
    expect(existsSync(marker)).toBe(true);
    expect(Date.now() - started).toBeLessThan(12_000);
    expect(paths).toEqual(['/v1/leases/pod-worker', `/v1/leases/pod-worker/${spec.workerId}/quarantine`]);
  } finally {
    process.env.PATH = oldPath;
    if (oldMarker === undefined) delete process.env.WARM_TEST_MARKER;
    else process.env.WARM_TEST_MARKER = oldMarker;
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

test('WARM-REUSE-TIME-PAIRS: production --reconcile wires pairingGateFile and echoes its cold leg on stdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-provider-pairing-cli-'));
  try {
    const file = join(root, 'provider.json');
    const prepareSpec = { ...spec, name: 'warm-node-b', nodeName: 'pool-node-b-server-0' };
    const gateFile = 'src/example/worker.test.ts';
    writeFileSync(file, JSON.stringify({
      candidates: [{ host: 'node-b', tier: 'standard', spec: prepareSpec }],
      controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64),
      machineTokens: { 'node-b': '2'.repeat(64) },
      pairingGateFile: gateFile,
    }), { mode: 0o600 });
    // The private config path is the real production loadWarmPodProvider call chain; kubectl
    // without a cluster fails closed, so this leg lands as a measured, unsuccessful cold row.
    // The child registers a logs.db sink, so HOME/state/config are isolated to this temp root.
    const run = spawnSync(process.execPath,
      [join(import.meta.dir, 'pod-warm-worker-provider.ts'), '--reconcile'],
      { encoding: 'utf8', env: { ...process.env, ELANOUS_WARM_POD_PROVIDER_CONFIG: file,
        HOME: join(root, 'home'), ELANOUS_STATE_DIR: join(root, 'state'), ELANOUS_STATE_DIR_SOURCE: 'explicit',
        ELANOUS_CONFIG_DIR: join(root, 'config') } });
    expect(run.status).toBe(2);
    const lines = run.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(lines[0]).toMatchObject({ target: 1, ready: 0, failed: [prepareSpec.workerId] });
    // The CLI echoes only its own cold leg; the pair is joined from logs.db (readWarmReuseTimePairs / --pairs).
    const legs = lines[1]?.warmReuseTimeLegs;
    expect(Array.isArray(legs)).toBe(true);
    expect(legs.length).toBe(1);
    expect(legs[0]).toMatchObject({ gateKey: gateFile + '/' + prepareSpec.cutSha + '/node-b', leg: 'cold',
      file: gateFile, commit: prepareSpec.cutSha, host: 'node-b', reuse: false, podUid: '', success: false });
    expect(legs[0].totalDurationMs).toBe(legs[0].prepareDurationMs);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);

test('WARM-REUSE-TIME-PAIRS: production --pairs joins the cold CLI leg persisted in logs.db into one row', () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-provider-pairs-cli-'));
  try {
    const file = join(root, 'provider.json');
    const prepareSpec = { ...spec, name: 'warm-node-b', nodeName: 'pool-node-b-server-0' };
    const gateFile = 'src/example/worker.test.ts';
    writeFileSync(file, JSON.stringify({
      candidates: [{ host: 'node-b', tier: 'standard', spec: prepareSpec }],
      controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64),
      machineTokens: { 'node-b': '2'.repeat(64) },
      pairingGateFile: gateFile,
    }), { mode: 0o600 });
    // NODE_ENV is dropped so the child boots the production log store instead of the test-disabled one.
    const { NODE_ENV: _nodeEnv, ...inherited } = process.env;
    const env = { ...inherited, ELANOUS_WARM_POD_PROVIDER_CONFIG: file,
      HOME: join(root, 'home'), ELANOUS_STATE_DIR: join(root, 'state'), ELANOUS_STATE_DIR_SOURCE: 'explicit',
      ELANOUS_CONFIG_DIR: join(root, 'config') };
    const entry = join(import.meta.dir, 'pod-warm-worker-provider.ts');
    const cold = spawnSync(process.execPath, [entry, '--reconcile'], { encoding: 'utf8', env });
    expect(cold.status).toBe(2);
    // The read-only query entry re-reads the same logs.db the cold process persisted — it holds no legs in memory.
    const query = spawnSync(process.execPath, [entry, '--pairs'], { encoding: 'utf8', env });
    expect({ status: query.status, stderr: query.stderr }).toEqual({ status: 0, stderr: '' });
    const rows = JSON.parse(query.stdout.trim()).warmReuseTimePairs;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ gateKey: gateFile + '/' + prepareSpec.cutSha + '/node-b', file: gateFile,
      commit: prepareSpec.cutSha, host: 'node-b',
      cold: { file: gateFile, commit: prepareSpec.cutSha, host: 'node-b', reuse: false, podUid: '', success: false,
        prepareDurationMs: rows[0].cold.prepareDurationMs, totalDurationMs: rows[0].cold.prepareDurationMs },
      warm: null });
    expect(rows[0].cold.prepareDurationMs).toBeGreaterThanOrEqual(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);

test('WARM-REUSE-TIME-PAIRS: production --pairs reports an empty pair list before any leg was measured', () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-provider-pairs-empty-'));
  try {
    // A host that never ran a gate has no logs.db: that is zero measured pairs, not a broken query.
    const { NODE_ENV: _nodeEnv, ...inherited } = process.env;
    const env = { ...inherited, HOME: join(root, 'home'), ELANOUS_STATE_DIR: join(root, 'state'),
      ELANOUS_STATE_DIR_SOURCE: 'explicit', ELANOUS_CONFIG_DIR: join(root, 'config') };
    const query = spawnSync(process.execPath, [join(import.meta.dir, 'pod-warm-worker-provider.ts'), '--pairs'],
      { encoding: 'utf8', env });
    expect({ status: query.status, stderr: query.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(query.stdout.trim())).toEqual({ warmReuseTimePairs: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);

test('WARM-REUSE-TIME-PAIRS: unset pairingGateFile skips the cold measurement row entirely', async () => {
  const events: Array<{ event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm' && event === 'warm-reuse-time-pair') events.push({ event, data });
  }) as typeof debug.log);
  try {
    const provider = newTestWarmPodProvider({ candidates: [{ ...candidate,
      spec: { ...spec, nodeName: 'pool-test-host-server-0' } }],
      controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
      machineTokens: { 'test-host': '2'.repeat(64) },
      kubectl: () => ({ status: 1, stdout: '', stderr: 'unavailable' }) });
    expect(await provider.prepareWorker(spec.workerId)).toBe(false);
    // No unpaired `file: ''` row may reach the pairing store or the ledger when the gate file is unset.
    expect(provider.warmReuseTimeLegs()).toEqual([]);
    expect(events).toEqual([]);
  } finally { log.mockRestore(); }
});

/** Two separate provider instances — the cold CLI process and the warm gate process — share one fake cluster. */
const pairingFixture = () => {
  const gateFile = 'src/example/worker.test.ts';
  const prepareSpec = { ...spec, name: 'warm-test-host', nodeName: 'pool-test-host-server-0' };
  const pods = new Map<string, any>();
  let clock = Date.now();
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const kubectl = (args: readonly string[], createInput?: string) => {
    const verb = args[4]!;
    if (verb === 'config') return result(prepareSpec.kubectlContext);
    if (verb === 'get' && args[5] === 'pods') return result({ metadata: {}, items: [...pods.values()] });
    if (verb === 'get') return result(pods.get(args[5] === 'pod' ? args[6]! : args[5]!.slice('pod/'.length)));
    if (verb === 'create') {
      clock += 5_000; // the cold leg pays the whole Pod create + Ready wait
      const created = JSON.parse(createInput!);
      const pod = { ...created, metadata: { ...created.metadata, uid: 'new-uid', resourceVersion: '1' },
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
      pods.set(created.metadata.name, pod);
      return result(pod);
    }
    if (verb === 'wait') return result({});
    if (verb === 'patch') {
      const pod = pods.get(args[5] === 'pod' ? args[6]! : args[5]!.slice('pod/'.length));
      const patch = JSON.parse(args[args.indexOf('-p') + 1]!) as Array<{ op: string; value: any }>;
      if (!pod || patch[0]?.value !== pod.metadata.uid || patch[1]?.value !== pod.metadata.resourceVersion)
        return { status: 1, stdout: '', stderr: 'precondition failed' };
      pod.metadata = { ...pod.metadata, labels: patch[2]!.value, annotations: patch[3]!.value,
        resourceVersion: String(Number(pod.metadata.resourceVersion) + 1) };
      return result(pod);
    }
    throw new Error(`unexpected kubectl ${args.join(' ')}`);
  };
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/resources') return Response.json({ resources: [] });
    if (path === '/v1/workers/pod') {
      const body = JSON.parse(String(init?.body));
      return Response.json({ name: body.workerId, attrs: { state: 'idle', podUid: body.podUid, key } });
    }
    if (path === '/v1/leases/pod-worker')
      return Response.json({ name: prepareSpec.workerId, attrs: { key, leaseId: 'lease-1',
        generation: 1, podUid: 'new-uid', state: 'leased' } });
    return Response.json({});
  };
  const base = { candidates: [{ ...candidate, spec: prepareSpec }], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, now: () => clock,
    kubectl, fetch: fetch as typeof globalThis.fetch };
  // The warm leg's exec takes 300ms on the already-standing Pod.
  const transport = () => ({ request: async (command: import('./pod-warm-worker-protocol.js').WarmWorkerCommand) => { clock += 300;
    return { status: 'observed' as const, reason: 'complete' as const, reply: completeReply(command) }; } });
  // Cold process: the --prepare/--reconcile/--serve CLI binds the gate file (loadWarmPodProvider(file, gateFile)).
  const cold = newTestWarmPodProvider({ ...base, pairingGateFile: gateFile, transport } as any);
  // Warm process: gate-node's requestWarmPodReplay → currentProvider() → loadWarmPodProvider(file) — no gate file.
  const warm = newTestWarmPodProvider({ ...base, transport } as any);
  return { gateFile, prepareSpec, cold, warm };
};

test('WARM-REUSE-TIME-PAIRS: separate cold and warm provider processes pair into one row through the shared logs.db', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warm-pair-logs-'));
  const store = new LogStore(join(dir, 'logs', 'logs.db'));
  const sink = new StoreSink(store, 'pod-warm', { installExitHandlers: false });
  const off = debug.registerSink(sink);
  try {
    const { gateFile, prepareSpec, cold, warm } = pairingFixture();
    expect(await cold.prepareWorker(prepareSpec.workerId)).toBe(true);
    expect((await warm.request({ ...input(), files: [gateFile] }, gateSelection())).transport)
      .toMatchObject({ status: 'observed', reason: 'complete' });
    sink.flush();
    // Neither process holds the pair in memory; the read-only reader joins the shared rows.
    const pairs = readWarmReuseTimePairs(store);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({ gateKey: gateFile + '/' + spec.cutSha + '/test-host', file: gateFile,
      commit: spec.cutSha, host: 'test-host',
      cold: { file: gateFile, commit: spec.cutSha, host: 'test-host', reuse: false, podUid: 'new-uid',
        success: true, prepareDurationMs: 5_000, totalDurationMs: 5_000 },
      warm: { file: gateFile, commit: spec.cutSha, host: 'test-host', reuse: true, podUid: 'new-uid',
        success: true, prepareDurationMs: 0, totalDurationMs: 300 } });
    // Concrete saving: cold prepare 5000ms vs warm total 300ms on the same Pod.
    expect(pairs[0]!.cold!.prepareDurationMs - pairs[0]!.warm!.totalDurationMs).toBe(4_700);
  } finally {
    off(); sink.close(); store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

test('WARM-REUSE-TIME-PAIRS: a multi-file gate never becomes a warm leg and logs its skip reason', async () => {
  const { gateFile, prepareSpec, cold, warm } = pairingFixture();
  // The standing Pod must exist first so the warm lease really reaches the exec path.
  expect(await cold.prepareWorker(prepareSpec.workerId)).toBe(true);
  const events: Array<{ event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm' && event.startsWith('warm-reuse-time-pair')) events.push({ event, data });
  }) as typeof debug.log);
  try {
    const replay = await warm.request({ ...input(), files: [gateFile, 'src/example/other.test.ts'] }, gateSelection());
    expect(replay.transport).toMatchObject({ status: 'observed', reason: 'complete' });
    expect(warm.warmReuseTimeLegs()).toEqual([]);
    expect(events).toEqual([{ event: 'warm-reuse-time-pair-skipped',
      data: { reason: 'not-single-file-gate', fileCount: 2, commit: spec.cutSha, host: 'test-host' } }]);
  } finally { log.mockRestore(); }
}, 120_000);

test('WARM-REUSE-TIME-PAIRS: pairing joins only the same file·commit·host and skips malformed rows', () => {
  const leg = (over: Record<string, unknown>) => ({ gateKey: 'f.test.ts/c/test-host', leg: 'cold', file: 'f.test.ts',
    commit: 'c', host: 'test-host', reuse: false, prepareDurationMs: 5_000, totalDurationMs: 5_000,
    podUid: 'u', success: true, ...over });
  const pairs = pairWarmReuseTimeLegs([
    leg({}),
    leg({ leg: 'warm', reuse: true, prepareDurationMs: 0, totalDurationMs: 300 }),
    leg({ gateKey: 'f.test.ts/c/node-b', host: 'node-b', leg: 'warm', reuse: true, prepareDurationMs: 0, totalDurationMs: 200 }),
    leg({ gateKey: 'forged/key' }),
    leg({ totalDurationMs: 'slow' }),
    null,
  ]);
  expect(pairs.map(row => [row.gateKey, row.cold?.totalDurationMs ?? null, row.warm?.totalDurationMs ?? null]))
    .toEqual([['f.test.ts/c/test-host', 5_000, 300], ['f.test.ts/c/node-b', null, 200]]);
});

test('standing Pod preparation refuses a candidate without a pinned node', async () => {
  let calls = 0;
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) },
    fetch: async () => { calls++; throw new Error('unexpected control call'); },
  });
  expect(await provider.ensureStandingWorker(candidate)).toBe(false);
  expect(calls).toBe(0);
});

test('WARM-POOL-PROVIDER-DEPLOY: assembles deterministic private templates, rejects missing fields, and keeps its output mode 600', () => {
  const first = assembleWarmPoolProviderConfig(warmPoolAssemblerInput('node-b'));
  const second = assembleWarmPoolProviderConfig(warmPoolAssemblerInput('node-b'));
  expect({ ...first, memberToken: '', machineTokens: {} }).toEqual({ ...second, memberToken: '', machineTokens: {} });
  expect(first).toMatchObject({ controlUrl: 'http://127.0.0.1:31413/', profileConfig: { pod: { warmPoolProfile: 'gate' } },
    expandPoolTemplatesToQuota: true,
    poolTemplates: [{ host: 'node-b', tier: 'standard', spec: { kubectlContext: 'k3d-elanous-pool',
      nodeName: 'pool-node-b-server-0', image: `registry.example/elanous@sha256:${'d'.repeat(64)}`,
      sourceMirrorHostPath: '/srv/elanous-mirror' } }] });
  const defaultQuotaInput = warmPoolAssemblerInput('node-b');
  delete (defaultQuotaInput.config.pod.warmPool as any).expandPoolTemplatesToQuota;
  expect(assembleWarmPoolProviderConfig(defaultQuotaInput).expandPoolTemplatesToQuota).toBe(false);
  const secureControl = assembleWarmPoolProviderConfig({ ...warmPoolAssemblerInput('node-b'),
    controlUrl: 'https://control.example:8413/' });
  expect(secureControl.controlUrl).toBe('https://control.example:8413/');
  const defaultHttpsControl = assembleWarmPoolProviderConfig({ ...warmPoolAssemblerInput('node-b'), controlUrl: 'https://control.example:443/' });
  expect(defaultHttpsControl.controlUrl).toBe('https://control.example/');
  expect(assembleWarmPoolProviderConfig({ ...warmPoolAssemblerInput('node-b'), controlUrl: 'http://control.example:80/' }).controlUrl)
    .toBe('http://control.example/');
  expect(() => assembleWarmPoolProviderConfig({ ...warmPoolAssemblerInput('node-b'), controlUrl: 'ftp://control.example:8413/' }))
    .toThrow('controlUrl must be an http or https URL with an explicit port');
  expect(() => assembleWarmPoolProviderConfig({ ...warmPoolAssemblerInput('node-b'), controlUrl: 'https://control.example/' }))
    .toThrow('controlUrl must be an http or https URL with an explicit port');
  expect(() => assembleWarmPoolProviderConfig({ ...warmPoolAssemblerInput('node-b'), controlUrl: 'https://control.example\\path:8413/' }))
    .toThrow('controlUrl must be an http or https URL with an explicit port');
  for (const controlUrl of ['https://@control.example:8413/', 'https://user:pass@control.example:8413/', 'https://control.example:8413/?token=x',
    'https://control.example:8413/#fragment', 'https://control.example:8413/?', 'https://control.example:8413/#']) {
    expect(() => assembleWarmPoolProviderConfig({ ...warmPoolAssemblerInput('node-b'), controlUrl }))
      .toThrow('controlUrl must be an http or https URL with an explicit port');
  }
  expect(() => assembleWarmPoolProviderConfig({ ...warmPoolAssemblerInput('node-b'), config: { pod: {}, harness: {} } }))
    .toThrow('pod.warmPoolProfile is required');
  expect(() => assembleWarmPoolProviderConfig({ ...warmPoolAssemblerInput('node-b'), config: { pod: warmPoolAssemblerInput('node-b').config.pod, harness: {} } }))
    .toThrow('harness.imageCommit is required');
  const root = mkdtempSync(join(tmpdir(), 'warm-pool-config-'));
  try {
    const file = join(root, 'provider.json');
    writeWarmPoolProviderConfig(file, first);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadWarmPodProvider(file)).toBeInstanceOf(WarmPodProvider);
    expect(loadSiWarmPodProvider(file)).toBeInstanceOf(SiWarmPodProvider);
    const secureFile = join(root, 'https-provider.json');
    writeWarmPoolProviderConfig(secureFile, secureControl);
    expect(loadWarmPodProvider(secureFile)).toBeInstanceOf(WarmPodProvider);
    const defaultPortFile = join(root, 'https-default-port-provider.json');
    writeWarmPoolProviderConfig(defaultPortFile, defaultHttpsControl);
    expect(loadWarmPodProvider(defaultPortFile)).toBeInstanceOf(WarmPodProvider);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('WARM-POOL-PROVIDER-DEPLOY: single-candidate config does not expand the host quota', () => {
  const assembled = assembleWarmPoolProviderConfig(warmPoolAssemblerInput('node-b'));
  const single: WarmPoolProviderConfig = selectSingleWarmPoolCandidate(assembled, 'node-b/standard');
  expect(single.poolTemplates).toEqual([]);
  expect(single.candidates).toHaveLength(1);
  expect(single.candidates[0]).toMatchObject({ host: 'node-b', tier: 'standard', kind: 'gate', spec: {
    name: 'warm-node-b-standard-gate-1', workerId: 'warm-node-b-aaaaaaaaaaaa-gate-standard-1',
    memoryLimit: '16Gi', nodeName: 'pool-node-b-server-0',
  } });
  expect(() => selectSingleWarmPoolCandidate(assembled, 'test-host/standard')).toThrow('warm pool template not found: test-host/standard');
  expect(() => selectSingleWarmPoolCandidate(assembled, 'node-b/unknown')).toThrow('--single-candidate must be HOST/lite');
  const root = mkdtempSync(join(tmpdir(), 'warm-pool-single-candidate-'));
  try {
    const file = join(root, 'provider.json');
    writeWarmPoolProviderConfig(file, single);
    expect(loadWarmPodProvider(file)).toBeInstanceOf(WarmPodProvider);
    expect(loadSiWarmPodProvider(file)).toBeInstanceOf(SiWarmPodProvider);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('WARM-POOL-PROVIDER-DEPLOY: production CLIs redact tokens, reconcile with fake kubectl, and stop --serve child',
  async () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-pool-assembler-cli-'));
  const controlRoot = join(root, 'control');
  const productionHost = 'node-b';
  const controlServer = startControlServer({ root: controlRoot, port: 0, leaseView: { async get() {
    return { holder: productionHost, generation: 1, iAmHolder: true, known: true };
  } } });
  const device = createFakeKubectl({ context: 'k3d-elanous-pool', node: `pool-${productionHost}-server-0`, podReadinessOnCreate: true });
  // One declared slot keeps this production CLI integration bounded while still exercising a real reconcile.
  const pools = [{ purpose: 'gate', fanoutGroupId: 'g', members: [{ host: 'node-b', count: 1,
    digest: `sha256:${'d'.repeat(64)}`, role: 'both' as const }],
  fanoutGroup: { shard: { kind: 'gate' as const, input: 'i', result: 'r', fingerprint: 'f' } },
  fingerprint: { runtime: 'bun', environment: 'linux', skillPacks: [] }, cleanup: { procedure: 'clean', verify: 'verify' } }];
  let ledgerServer: ReturnType<typeof spawn> | undefined;
  const rawPodRequests: string[] = [];
  const receivedKubectlCalls: string[][] = [];
  const fakeKubectlServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { args: string[]; input: string };
    receivedKubectlCalls.push(body.args);
    if (body.args[4] === 'get' && body.args[5] === '--raw' && body.args[6]?.includes('/pods?')) {
      const path = body.args[6]!;
      rawPodRequests.push(path);
      const query = new URLSearchParams(path.slice(path.indexOf('?') + 1));
      const result = device.kubectl(['--context', body.args[1]!, '-n', body.args[3]!, 'get', 'pods', '-o', 'json']);
      if (result.status !== 0) return Response.json(result);
      const podList = JSON.parse(result.stdout) as { items: any[]; metadata?: Record<string, unknown> };
      const selector = query.get('fieldSelector');
      const label = query.get('labelSelector');
      const filtered = podList.items.filter(pod => (!selector || selector === `metadata.name=${pod.metadata?.name}`)
        && (!label || label.split(',').every(part => {
          const [key, value] = part.split('='); return pod.metadata?.labels?.[key!] === value;
        })));
      const offset = Number(query.get('continue')?.replace(/^page-/, '') ?? '0');
      const limit = Number(query.get('limit') ?? '25');
      const items = filtered.slice(offset, offset + limit);
      const next = offset + items.length < filtered.length ? `page-${offset + items.length}` : '';
      return Response.json({ status: 0, stderr: '', stdout: JSON.stringify({ kind: 'PodList', items,
        metadata: { continue: next } }) });
    }
    const result = device.kubectl(body.args, body.input);
    if (body.args[4] === 'get' && body.args[5] === 'pods' && result.status === 0) {
      const podList = JSON.parse(result.stdout);
      if (Array.isArray(podList.items) && !podList.metadata) podList.metadata = {};
      return Response.json({ ...result, stdout: JSON.stringify(podList) });
    }
    return Response.json(result);
  } });
  try {
    const config = join(root, 'config.json'), member = join(root, 'member.token'), machine = join(root, `${productionHost}.token`);
    const output = join(root, 'provider config.json'), dryOutput = join(root, 'dry-run-provider.json');
    const bin = join(root, 'bin');
    mkdirSync(bin, { mode: 0o700 });
    symlinkSync(join(import.meta.dir, '../../ux-sim/fake-kubectl.ts'), join(bin, 'kubectl'));
    writeFileSync(config, JSON.stringify(warmPoolAssemblerInput(productionHost).config), { mode: 0o600 });
    const memberValue = ensureControlTokens(controlRoot).member;
    const machineValue = issueMemberToken(productionHost, controlRoot);
    writeFileSync(member, memberValue, { mode: 0o600 }); writeFileSync(machine, machineValue, { mode: 0o600 });
    const ledgerRequestLog = join(root, 'resource-ledger-requests.log');
    const ledgerServerProgram = `
      const fs = require('node:fs');
      const http = require('node:http');
      const expected = fs.readFileSync(process.env.ELANOUS_TEST_MACHINE_TOKEN_FILE, 'utf8').trim();
      const pools = ${JSON.stringify(pools)};
      http.createServer((request, response) => {
        const requestTarget = request.url;
        fs.appendFileSync(process.env.ELANOUS_TEST_RESOURCE_LEDGER_REQUEST_LOG, request.method + ' ' + requestTarget + '\\n');
        if (request.method !== 'GET') {
          response.writeHead(405, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'method-not-allowed' }));
          return;
        }
        if (requestTarget !== '/v1/resource-ledger/pools') {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'not-found' }));
          return;
        }
        if (request.headers.authorization !== 'Bearer ' + expected) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ pools }));
      }).listen(0, '127.0.0.1', function() { console.log(this.address().port); });
    `;
    const runningLedgerServer = spawn(process.execPath, ['-e', ledgerServerProgram], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELANOUS_TEST_MACHINE_TOKEN_FILE: machine,
        ELANOUS_TEST_RESOURCE_LEDGER_REQUEST_LOG: ledgerRequestLog } });
    ledgerServer = runningLedgerServer;
    const ledgerPort = await new Promise<string>((resolve, reject) => {
      runningLedgerServer.stdout.once('data', chunk => resolve(String(chunk).trim()));
      runningLedgerServer.once('error', reject);
      runningLedgerServer.once('close', code => reject(new Error('ledger fixture exited before listening: ' + code)));
    });
    const script = join(import.meta.dir, '../../../scripts/warm-pool-provider-config.ts');
    const controlUrl = `${controlServer.url}/`;
    const assemblerArgs = [script, '--config', config, '--control-url', controlUrl,
      '--resource-ledger-url', 'http://127.0.0.1:' + ledgerPort + '/v1/resource-ledger/pools',
      '--member-token-file', member, '--machine-token', `${productionHost}=${machine}`, '--output'];
    const dry = spawnSync(process.execPath, [...assemblerArgs, dryOutput, '--dry-run'], { encoding: 'utf8' });
    if (dry.status !== 0) throw new Error(dry.stderr); expect(dry.stdout).toContain('"memberToken":"[redacted]"');
    expect(dry.stdout).not.toContain(memberValue); expect(dry.stdout).not.toContain(machineValue);
    expect(existsSync(dryOutput)).toBe(false);
    const singleDry = spawnSync(process.execPath,
      [...assemblerArgs, dryOutput, '--single-candidate', `${productionHost}/standard`, '--dry-run'], { encoding: 'utf8' });
    expect(singleDry.status).toBe(0);
    expect(JSON.parse(singleDry.stdout)).toMatchObject({ config: { candidates: [{ host: productionHost, tier: 'standard', kind: 'gate',
      spec: { name: `warm-${productionHost}-standard-gate-1`, workerId: `warm-${productionHost}-aaaaaaaaaaaa-gate-standard-1` } }], poolTemplates: [] } });
    expect(singleDry.stdout).not.toContain(memberValue); expect(singleDry.stdout).not.toContain(machineValue);
    expect(existsSync(dryOutput)).toBe(false);
    const assembled = spawnSync(process.execPath, [...assemblerArgs, output], { encoding: 'utf8' });
    expect(assembled.status).toBe(0);
    expect(assembled.stdout).not.toContain(memberValue); expect(assembled.stderr).not.toContain(machineValue);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(loadWarmPodProvider(output)).toBeInstanceOf(WarmPodProvider);
    expect(loadSiWarmPodProvider(output)).toBeInstanceOf(SiWarmPodProvider);
    const env = { ...process.env, ELANOUS_WARM_POD_PROVIDER_CONFIG: output,
      ELANOUS_STATE_DIR: join(root, 'state'), ELANOUS_STATE_DIR_SOURCE: 'explicit',
      ELANOUS_CONFIG_DIR: join(root, 'elanous'), HOME: join(root, 'home'),
      ELANOUS_FAKE_KUBECTL_URL: fakeKubectlServer.url.href,
      PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
    const provider = join(import.meta.dir, 'pod-warm-worker-provider.ts');
    const reconcileChild = spawn(process.execPath, [provider, '--reconcile'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const reconciled = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      let stdout = '', stderr = '';
      reconcileChild.stdout.on('data', chunk => { stdout += String(chunk); });
      reconcileChild.stderr.on('data', chunk => { stderr += String(chunk); });
      reconcileChild.once('close', code => resolve({ code, stdout, stderr }));
    });
    if (reconciled.code !== 0) {
      const logPath = join(env.ELANOUS_STATE_DIR, 'logs', 'logs.db');
      const logStore = existsSync(logPath) ? LogStore.openReadOnly(logPath) : null;
      const decisions = logStore?.query({ events: ['pool-reconcile-decision'] }) ?? [];
      logStore?.close();
      throw new Error(`production --reconcile failed: ${reconciled.stderr}\n${reconciled.stdout}\n${JSON.stringify({
        calls: device.calls, rawPodRequests, receivedKubectlCalls, decisions,
      })}`);
    }
    expect(JSON.parse(reconciled.stdout.trim().split('\n')[0]!)).toMatchObject({ target: 1, ready: 1, failed: [] });
    const podReads = device.calls.filter(args => args[4] === 'get' && args[5] === 'pods');
    expect(podReads).toHaveLength(3);
    const rawPodQueries = rawPodRequests.map(path => new URLSearchParams(path.slice(path.indexOf('?') + 1)));
    expect(rawPodQueries).toHaveLength(2);
    expect(rawPodQueries.filter(query => query.get('fieldSelector')?.startsWith('metadata.name=warm-node-b-standard-'))).toHaveLength(1);
    expect(rawPodQueries.filter(query => query.get('labelSelector') === 'elanous.kind=warm-worker')).toHaveLength(1);
    expect(rawPodQueries.every(query => query.get('limit') === '25')).toBe(true);
    expect(device.calls.filter(args => args[4] === 'create')).toHaveLength(1);
    expect(reconciled.stdout).not.toContain(memberValue); expect(reconciled.stderr).not.toContain(machineValue);

    const serve = spawn(process.execPath, [...assemblerArgs, output, '--serve'], { env,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let serveOutput = '';
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`--serve did not start: ${serveOutput}`)), 10_000);
      serve.stdout.on('data', chunk => {
        serveOutput += String(chunk);
        if (serveOutput.includes('"serve"')) { clearTimeout(timeout); resolve(); }
      });
      serve.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    expect(serveOutput).not.toContain(memberValue); expect(serveOutput).not.toContain(machineValue);
    expect(serveOutput).toContain(`ELANOUS_WARM_POD_PROVIDER_CONFIG='${output}'`);
    expect(readFileSync(ledgerRequestLog, 'utf8').trim().split('\n')).toEqual(Array(4).fill('GET /v1/resource-ledger/pools'));
    const callsBeforeServe = device.calls.length;
    const serveCallsReady = async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && device.calls.length === callsBeforeServe) await Bun.sleep(25);
      return device.calls.length > callsBeforeServe;
    };
    expect(await serveCallsReady()).toBe(true);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
      serve.once('close', (code, signal) => resolve({ code, signal })));
    expect(serve.kill('SIGTERM')).toBe(true);
    const exit = await Promise.race([closed, Bun.sleep(10_000).then(() => { throw new Error('--serve parent/child did not stop'); })]);
    expect(exit).toEqual({ code: 143, signal: null });
    await Bun.sleep(100);
    const callsAfterClose = device.calls.length;
    await Bun.sleep(100);
    expect(device.calls.length).toBe(callsAfterClose);
  } finally {
    fakeKubectlServer.stop(true);
    ledgerServer?.kill('SIGTERM');
    controlServer.stop();
    rmSync(root, { recursive: true, force: true });
  }
  // Source: #35964 follows scripts/ci-pwa-build-gate.ts:39,47 300_000 ms bound for multi-process lifecycle work.
}, { timeout: 300_000 });

describe('parseWarmPodProviderArgs — CLI 인자 배선', () => {
  test('--reconcile/--serve 의 둘째 칸은 gateFile 이다(workerId 아님)', () => {
    expect(parseWarmPodProviderArgs(['--reconcile', 'src/a.test.ts'])).toEqual({ action: '--reconcile', gateFile: 'src/a.test.ts' });
    expect(parseWarmPodProviderArgs(['--serve', 'src/a.test.ts'])).toEqual({ action: '--serve', gateFile: 'src/a.test.ts' });
    expect(parseWarmPodProviderArgs(['--serve'])).toEqual({ action: '--serve' });
    expect(parseWarmPodProviderArgs(['--pairs'])).toEqual({ action: '--pairs' });
  });
  test('--prepare 는 workerId 필수 · gateFile 은 셋째 칸', () => {
    expect(parseWarmPodProviderArgs(['--prepare', 'w1', 'src/a.test.ts'])).toEqual({ action: '--prepare', workerId: 'w1', gateFile: 'src/a.test.ts' });
    expect(() => parseWarmPodProviderArgs(['--prepare'])).toThrow('usage:');
  });
  test('남는 인자·빈 gateFile·모르는 동작은 usage 오류', () => {
    expect(() => parseWarmPodProviderArgs(['--serve', 'a', 'b'])).toThrow('usage:');
    expect(() => parseWarmPodProviderArgs(['--reconcile', ' '])).toThrow('usage:');
    expect(() => parseWarmPodProviderArgs(['--nope'])).toThrow('usage:');
    expect(() => parseWarmPodProviderArgs(['--pairs', 'x'])).toThrow('usage:');
  });
});

test('request gates candidates on exact cut, lock hash, and image digest before lease attempts', async () => {
  const implementation = { host: 'test-host', tier: 'standard' as const, kind: 'implementation' as const,
    spec: { ...spec, name: 'warm-test-implementation', workerId: 'implementation-worker' } };
  const wrongLockGate = { ...candidate, kind: 'gate' as const, spec: { ...spec,
    workerId: 'gate-wrong-lock', key: { ...key, lockHash: 'd'.repeat(64) } } };
  const gateSpec = { ...spec, name: 'warm-test-host-b', workerId: 'gate-worker', kubectlContext: 'test-host-b',
    key: { ...key, lockHash: 'e'.repeat(64) } };
  const gate = { host: 'test-host-b', tier: 'standard' as const, kind: 'gate' as const, spec: gateSpec };
  const attemptedHosts: string[] = [];
  const provider = newTestWarmPodProvider({ candidates: [implementation, wrongLockGate, gate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64), 'test-host-b': '3'.repeat(64) },
    kubectl: args => {
      if (args[4] === 'get' && args[5] === 'pods' && args.includes(`--field-selector=metadata.name=${gateSpec.name}`))
        return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: gateSpec.name,
          namespace: gateSpec.namespace, uid: 'lease-pod-uid', labels: {}, resourceVersion: '1' } }] }), stderr: '' };
      throw new Error('unexpected kubectl for a candidate rejected before cluster lookup');
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/leases/pod-worker' && init?.method === 'POST') {
        attemptedHosts.push(JSON.parse(String(init.body)).machine);
        return new Response('{}', { status: 503 });
      }
      return Response.json({ resources: [] });
    },
  });
  await provider.request(input(), { ...gateSelection(gateSpec.key) });
  expect(attemptedHosts).toEqual(['test-host-b']);
});

test('provider generated with an old base-image digest never leases a warm Pod after the pin changes', async () => {
  const oldImageDigest = `sha256:${'1'.repeat(64)}`;
  const nextImageDigest = `sha256:${'2'.repeat(64)}`;
  const oldBaseImageDigest = `sha256:${'3'.repeat(64)}`;
  const nextBaseImageDigest = `sha256:${'4'.repeat(64)}`;
  const staleProviderCandidate = { ...candidate, spec: { ...spec,
    image: `registry.example/elanous@${oldImageDigest}`,
    key: { ...key, imageDigest: oldImageDigest },
    runtimeContract: { baseImageDigest: oldBaseImageDigest, bunVersion: '1.4.2', os: 'linux' as const,
      architecture: key.architecture, requiredTools: ['bun', 'git'] },
  } };
  const attemptedHosts: string[] = [];
  const provider = newTestWarmPodProvider({ candidates: [staleProviderCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: () => { throw new Error('stale runtime identity must not reach a Pod'); },
    fetch: async (url, init) => {
      if (new URL(String(url)).pathname === '/v1/leases/pod-worker' && init?.method === 'POST')
        attemptedHosts.push('attempted');
      return Response.json({ resources: [] });
    },
  });
  const reply = await provider.request(input(), { ...gateSelection({ ...key, imageDigest: nextImageDigest }),
    imageDigest: nextImageDigest, runtimeIdentity: { baseImageDigest: nextBaseImageDigest, lockHash: key.lockHash,
      os: 'linux', architecture: key.architecture, bunVersion: '1.4.2' } });
  expect(reply).toEqual({ command: null, transport: { status: 'fallback', reason: 'lease-unavailable', reply: null } });
  expect(attemptedHosts).toEqual([]);
});

test('gate request without an independent lock and image tuple cannot infer its target from candidates', async () => {
  const calls: string[] = [];
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: () => { throw new Error('missing selection must fail before Pod access'); },
    fetch: async url => { calls.push(String(url)); throw new Error('missing selection must fail before lease'); },
  });
  expect(await provider.request(input())).toEqual({ command: null,
    transport: { status: 'fallback', reason: 'no-candidate', reply: null } });
  expect(calls).toEqual([]);
});

test('gate request without an architecture-bearing runtime contract fails closed before Pod access', async () => {
  const calls: string[] = [];
  const provider = newTestWarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) },
    kubectl: () => { calls.push('kubectl'); throw new Error('missing gate architecture must fail before Pod access'); },
    fetch: async url => { calls.push(String(url)); throw new Error('missing gate architecture must fail before lease'); },
  });
  const selection = gateSelection();
  expect(await provider.request(input(), { ...selection, runtimeContract: undefined })).toEqual({ command: null,
    transport: { status: 'fallback', reason: 'no-candidate', reply: null } });
  expect(await provider.request(input(), { ...selection,
    runtimeContract: { ...selection.runtimeContract, architecture: '' } })).toEqual({ command: null,
    transport: { status: 'fallback', reason: 'no-candidate', reply: null } });
  expect(calls).toEqual([]);
});

test('provider reuses a cross-architecture candidate only when its private config allowlists both architectures', async () => {
  const arm64Candidate: WarmWorkerCandidate = { host: 'test-host', tier: 'standard', kind: 'gate', spec: {
    ...spec, name: 'warm-test-arm64', workerId: 'gate-arm64-worker',
    key: { ...key, architecture: 'arm64' },
    runtimeContract: { ...spec.runtimeContract!, architecture: 'arm64' },
  } };
  const scores: Array<{ accepted: boolean; reason: string }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm' && event === 'candidate-match-score') {
      const rows = (data as { candidates: Array<{ accepted: boolean; reason: string }> }).candidates;
      scores.push(rows[0]!);
    }
  }) as typeof debug.log);
  try {
    const makeProvider = (allowedArchitectures?: readonly ('amd64' | 'arm64')[]) => newTestWarmPodProvider({
      candidates: [arm64Candidate], controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
      ...(allowedArchitectures ? { allowedArchitectures } : {}), kubectl: () => ({ status: 1, stdout: '', stderr: 'context unavailable' }),
      fetch: async () => Response.json({ resources: [] }),
    });
    await makeProvider().request(input(), gateSelection());
    await makeProvider(['amd64', 'arm64']).request(input(), gateSelection());
  } finally { log.mockRestore(); }
  expect(scores).toEqual([
    expect.objectContaining({ accepted: false, reason: 'runtime-identity-mismatch' }),
    expect.objectContaining({ accepted: true, reason: 'selected' }),
  ]);
});

test('provider allocates an allowlisted arm64 worker for an amd64 gate runtime', async () => {
  const arm64Key = { ...key, architecture: 'arm64' };
  const arm64Spec: WarmPodSpec = { ...spec, name: 'warm-test-arm64', workerId: 'gate-arm64-worker',
    key: arm64Key, runtimeContract: { ...spec.runtimeContract!, architecture: 'arm64' } };
  const arm64Candidate: WarmWorkerCandidate = { host: 'test-host', tier: 'standard', kind: 'gate', spec: arm64Spec };
  const leaseHosts: string[] = [];
  const transported: string[] = [];
  const provider = newTestWarmPodProvider({ candidates: [arm64Candidate], allowedArchitectures: ['amd64', 'arm64'],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { 'test-host': '2'.repeat(64) }, kubectl: leaseKubectl([arm64Spec]),
    fetch: async (url, init) => {
      if (new URL(String(url)).pathname === '/v1/leases/pod-worker' && init?.method === 'POST') {
        leaseHosts.push(JSON.parse(String(init.body)).machine);
        return Response.json({ name: arm64Spec.workerId, attrs: { key: arm64Key, leaseId: 'lease-arm64',
          generation: 1, podUid: 'lease-pod-uid', state: 'leased' } });
      }
      return Response.json({});
    },
    transport: () => ({ request: async command => {
      transported.push(command.workerId);
      return { status: 'observed', reason: 'complete', reply: completeReply(command) };
    } }),
  });

  const result = await provider.request(input(), gateSelection());
  expect(leaseHosts).toEqual(['test-host']);
  expect(transported).toEqual([arm64Spec.workerId]);
  expect(result.command).toMatchObject({ workerId: arm64Spec.workerId, key: arm64Key });
  expect(result.transport).toMatchObject({ status: 'observed', reason: 'complete' });
});
