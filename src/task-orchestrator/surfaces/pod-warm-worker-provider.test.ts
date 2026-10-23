import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WarmPodProvider, requestWarmPodReplay, configureWarmPodProvider, parseWarmPodProviderArgs,
  pairWarmReuseTimeLegs, readWarmReuseTimePairs } from './pod-warm-worker-provider.js';
import { LogStore, StoreSink } from '../../mss/logging/log-store.js';
import { warmWorkerPodManifest, type WarmPodSpec } from './pod-warm-worker-pod.js';
import { ensureControlTokens, startControlServer } from '../../control-plane/server.js';
import { issueMemberToken } from '../../control-plane/member-tokens.js';

const key = { context: 'pool-node-c', imageDigest: `sha256:${'b'.repeat(64)}`, lockHash: 'c'.repeat(64), architecture: 'amd64' };
const spec: WarmPodSpec = { name: 'warm-test-1', namespace: 'elanous-test', kubectlContext: 'node-c',
  workerId: 'warm-test-1-uid', image: `registry.example/elanous@${key.imageDigest}`,
  sourceUrl: 'https://github.com/ElanvitalAI/elanous.git', cutSha: 'a'.repeat(40), key,
  memoryLimit: '16Gi', hostProbeUrl: 'http://host.orb.internal:10001/health',
  prodProbeUrl: 'http://core.elanous-prod:10002/' };
const candidate = { host: 'node-c', tier: 'standard' as const, spec };
const input = () => ({ protocol: 1 as const, runId: 'run-1', attemptId: 'attempt-1', cutSha: spec.cutSha,
  deadlineAt: Date.now() + 60_000, files: ['src/example/worker.test.ts'], envProfile: 'gate-v1' });
const lease = () => ({ name: spec.workerId, attrs: { key, leaseId: 'lease-1', generation: 1,
  podUid: 'lease-pod-uid', state: 'leased' } });
const leaseKubectl = (specs: WarmPodSpec[] = [spec]) => {
  const pods = new Map(specs.map(item => [item.name, { metadata: {
    ...(warmWorkerPodManifest(item).metadata as { labels: Record<string, string>; annotations: Record<string, string> }),
    uid: 'lease-pod-uid', resourceVersion: '1',
  } }]));
  return (args: readonly string[]) => {
    const name = args[6]!;
    const pod = pods.get(name);
    if (!pod) return { status: 1, stdout: '', stderr: 'pod missing' };
    if (args[4] === 'get') return { status: 0, stdout: JSON.stringify(pod), stderr: '' };
    if (args[4] === 'patch') {
      const patch = JSON.parse(args[args.indexOf('-p') + 1]!) as Array<{ op: string; value: any }>;
      if (patch[0]?.value !== pod.metadata.uid || patch[1]?.value !== pod.metadata.resourceVersion)
        return { status: 1, stdout: '', stderr: 'precondition failed' };
      pod.metadata = { ...pod.metadata, labels: patch[2]!.value, annotations: patch[3]!.value,
        resourceVersion: String(Number(pod.metadata.resourceVersion) + 1) };
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

test('named slots are independently reconciled and bounded by the measured host quota', async () => {
  const first = { ...spec, name: 'warm-node-c', workerId: 'node-c-uid-1', nodeName: 'pool-node-c-server-0' };
  const second = { ...spec, name: 'warm-node-c-2', workerId: 'node-c-uid-2', nodeName: 'pool-node-c-server-0' };
  const candidates = [first, second].map(item => ({ ...candidate, spec: item }));
  const created: string[] = [];
  const registered = new Map<string, string>();
  const pods = new Map<string, any>();
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const provider = new WarmPodProvider({ candidates, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { node-c: '2'.repeat(64) },
    kubectl: (args, input) => {
      if (args[4] === 'get' && args[5] === 'pods') return result({ items: [...pods.values()] });
      if (args[4] === 'create') {
        const manifest = JSON.parse(input!);
        const pod = { ...manifest, metadata: { ...manifest.metadata, uid: `${manifest.metadata.name}-uid` },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
        pods.set(manifest.metadata.name, pod);
        created.push(manifest.metadata.name);
        return result(pod);
      }
      if (args[4] === 'wait') return result({});
      if (args[4] === 'get') return result(pods.get(args[5]!.slice(4)));
      throw new Error(`unexpected ${args.join(' ')}`);
    },
    fetch: async (url, init) => {
      if (new URL(String(url)).pathname === '/v1/resources') {
        const name = new URL(String(url)).searchParams.get('name')!;
        return Response.json({ resources: registered.has(name) ? [{ name, kind: 'pod-worker-lease',
          machine: 'node-c', observedAt: Date.now(), ttlMs: 1_800_000,
          attrs: { state: 'idle', podUid: registered.get(name), idleTtlMs: 1_800_000, key } }] : [] });
      }
      const body = JSON.parse(String(init?.body));
      registered.set(body.workerId, body.podUid);
      return Response.json({ name: body.workerId, attrs: { state: 'idle', podUid: body.podUid, key } });
    },
  });
  expect(await provider.reconcilePool()).toMatchObject({ target: 2, ready: 2, failed: [] });
  expect(await provider.reconcilePool()).toMatchObject({ target: 2, ready: 2, failed: [] });
  expect(created).toEqual(['warm-node-c', 'warm-node-c-2']);
  expect(() => new WarmPodProvider({ candidates: [candidates[0]!, candidates[0]!],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64) })).toThrow();
  expect(() => new WarmPodProvider({ candidates: Array.from({ length: 5 }, (_, index) => ({
    ...candidate, spec: { ...second, name: `warm-node-c-${index + 1}`, workerId: `node-c-uid-${index + 1}` },
  })), controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64) })).toThrow('quota');
});

test('a pinned template expands to every measured profile slot with separate Pod and worker identities', async () => {
  const template = { ...candidate, spec: { ...spec, name: 'unused-template',
    workerId: 'generation-20261022', nodeName: 'pool-node-c-server-0' } };
  const provider = new WarmPodProvider({ candidates: [], poolTemplates: [template],
    profileConfig: { pod: { warmPoolProfile: 'gate' } },
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64) });
  const names: string[] = [];
  const ids: string[] = [];
  const prepare = spyOn(provider, 'ensureStandingWorker').mockImplementation(async row => {
    names.push(row.spec.name); ids.push(row.spec.workerId); return true;
  });
  try {
    expect(await provider.reconcilePool()).toMatchObject({ profile: 'gate', target: 4, ready: 4, failed: [] });
    expect(names).toEqual(['warm-node-c-standard-1', 'warm-node-c-standard-2',
      'warm-node-c-standard-3', 'warm-node-c-standard-4']);
    expect(new Set(ids).size).toBe(4);
  } finally { prepare.mockRestore(); }
});

test('an old physical warm Pod consumes quota even when absent from configured candidates', async () => {
  const active = { ...candidate, spec: { ...spec, name: 'warm-node-c-standard-1',
    workerId: 'new-generation-1', nodeName: 'pool-node-c-server-0' } };
  const old = Array.from({ length: 4 }, (_, index) => ({
    metadata: { name: `old-generation-${index}`, labels: { 'elanous.kind': 'warm-worker' } },
    spec: { nodeName: 'pool-node-c-server-0', containers: [{ resources: { limits: { memory: '16Gi' } } }] },
    status: { phase: 'Running' },
  }));
  const calls: string[] = [];
  const provider = new WarmPodProvider({ candidates: [active],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: args => { calls.push(args[4]!); return {
      status: 0, stdout: JSON.stringify({ items: old }), stderr: '',
    }; },
    fetch: async () => { throw new Error('physical quota must refuse before control access'); },
  });
  expect(await provider.reconcilePool()).toMatchObject({ target: 1, ready: 0, failed: ['new-generation-1'] });
  expect(calls).toEqual(['get']);
});

test('a busy or unavailable first host lets the request lease a matching worker on the next host', async () => {
  const first = { ...candidate, spec: { ...spec, name: 'warm-node-c',
    workerId: 'node-c-worker', nodeName: 'pool-node-c-server-0' } };
  const second = { host: 'elangram-wsl', tier: 'standard' as const,
    spec: { ...spec, name: 'warm-elangram-wsl-standard-1', workerId: 'elangram-worker',
      nodeName: 'pool-elangram-server-0' } };
  for (const firstFailure of ['busy', 'network', 'unavailable'] as const) {
    const hosts: string[] = [];
    const provider = new WarmPodProvider({ candidates: [first, second],
      controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
      machineTokens: { node-c: '2'.repeat(64), 'elangram-wsl': '3'.repeat(64) },
      kubectl: leaseKubectl([first.spec, second.spec]),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.machine) {
          hosts.push(body.machine);
          if (body.machine === 'node-c') {
            if (firstFailure === 'network') throw new Error('unavailable');
            return new Response('{}', { status: firstFailure === 'busy' ? 409 : 503 });
          }
          return Response.json({ name: second.spec.workerId, attrs: { key, leaseId: 'lease-2',
            generation: 1, podUid: 'lease-pod-uid', state: 'leased' } });
        }
        return Response.json({});
      },
      transport: () => ({ request: async () => ({ status: 'observed', reason: 'complete', reply: null }) }),
    });
    const replay = await provider.request(input());
    expect(hosts).toEqual(['node-c', 'elangram-wsl']);
    expect(replay.command?.workerId).toBe('elangram-worker');
    expect(replay.command).toMatchObject({ podName: second.spec.name, podContext: second.spec.kubectlContext, image: second.spec.image,
      podUid: 'lease-pod-uid', generation: 1, leaseId: 'lease-2' });
  }
});

test('WARM-POD-PRODUCER-UID-FU: delayed install and competing prepares register one pinned Pod UID', async () => {
  const prepareSpec = { ...spec, name: 'warm-node-c', nodeName: 'pool-node-c-server-0' };
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
  const provider = new WarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: args => {
      if (args[4] === 'get' && args[5] === 'pods') return result({ items: pods });
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
  const prepareSpec = { ...spec, name: 'warm-node-c', nodeName: 'pool-node-c-server-0' };
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
    if (args[4] === 'get' && args[5] === 'pods') return result({ items: [...pods.values()] });
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
      return Response.json({ resources: registeredUid ? [{ kind: 'pod-worker-lease', machine: 'node-c',
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
    machineTokens: { node-c: '2'.repeat(64) }, kubectl, fetch, prepareLockDirectory: lockRoot };
  try {
    const firstProvider = new WarmPodProvider(options);
    const secondProvider = new WarmPodProvider(options);
    const first = firstProvider.prepareWorker(prepareSpec.workerId);
    await started;
    const second = secondProvider.prepareWorker(prepareSpec.workerId);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect({ actions, created, registrations, controlCalls }).toEqual({
      actions: ['get', 'create', 'wait', 'get', 'get', 'wait', 'get'],
      created: [prepareSpec.name], registrations: ['one-pod-uid'],
      controlCalls: ['GET /v1/resources', 'GET /v1/resources', 'POST /v1/workers/pod', 'GET /v1/resources'],
    });
    expect(created).toEqual([prepareSpec.name]);
    expect(registrations).toEqual(['one-pod-uid']);
  } finally { rmSync(lockRoot, { recursive: true, force: true }); }
}, 20_000);

test('prepare lease wait is cancellable, records the reason, and kernel unlock permits retry', async () => {
  const prepareSpec = { ...spec, name: 'warm-node-c', nodeName: 'pool-node-c-server-0' };
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
    memberToken: '1'.repeat(64), machineTokens: { node-c: '2'.repeat(64) },
    prepareLockDirectory: lockRoot, prepareAbortSignal,
    kubectl: (args: readonly string[], body?: string) => {
      if (args[4] === 'get' && args[5] === 'pods') return result({ items: [...pods.values()] });
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
          return Response.json({ resources: registeredUid ? [{ kind: 'pod-worker-lease', machine: 'node-c',
            name: prepareSpec.workerId, observedAt: Date.now(), ttlMs: 1_800_000,
            attrs: { state: 'idle', podUid: registeredUid, idleTtlMs: 1_800_000, key } }] : [] });
        }
        registrations++;
        const body = JSON.parse(String(init?.body));
        registeredUid = body.podUid;
        return Response.json({ name: prepareSpec.workerId, attrs: { state: 'idle', podUid: body.podUid, key } });

    },
  });
  try {
    const firstProvider = new WarmPodProvider(providerOptions());
    const first = firstProvider.prepareWorker(prepareSpec.workerId);
    await started;
    const abort = new AbortController();
    const waitingProvider = new WarmPodProvider(providerOptions(abort.signal));
    const waiting = waitingProvider.prepareWorker(prepareSpec.workerId);
    abort.abort();
    await expect(waiting).rejects.toThrow('warm prepare lock wait cancelled');
    expect(events).toContainEqual({ event: 'prepare-lease-failed', data: {
      host: 'node-c', workerId: prepareSpec.workerId, reason: 'warm prepare lock wait cancelled',
    } });
    releaseFirst();
    expect(await first).toBe(true);
    const retry = new WarmPodProvider(providerOptions());
    expect(await retry.prepareWorker(prepareSpec.workerId)).toBe(true);
    expect(created).toEqual([prepareSpec.name]);
    expect(registrations).toBe(1);
  } finally { releaseFirst(); log.mockRestore(); rmSync(lockRoot, { recursive: true, force: true }); }
});

test('prepare cancellation after acquiring the lease stops before Pod creation and records its reason', async () => {
  const prepareSpec = { ...spec, name: 'warm-node-c', nodeName: 'pool-node-c-server-0' };
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
  const provider = new WarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) }, prepareAbortSignal: abort.signal,
    kubectl: args => { actions.push(args[4]!); return { status: 0, stdout: JSON.stringify({ items: [] }), stderr: '' }; },
    fetch: async () => { preflightStarted(); await pause; return Response.json({ resources: [] }); },
  });
  try {
    const preparing = provider.prepareWorker(prepareSpec.workerId);
    await started;
    abort.abort(new Error('operator cancelled prepare'));
    releasePreflight();
    await expect(preparing).rejects.toThrow('operator cancelled prepare');
    expect(actions).toEqual(['get']);
    expect(events).toContainEqual({ event: 'prepare-lease-failed', data: {
      host: 'node-c', workerId: prepareSpec.workerId, reason: 'operator cancelled prepare',
    } });
  } finally { releasePreflight(); log.mockRestore(); }
});

test('a failed kubectl wait backs off and its retry delay is cancellable', async () => {
  const prepareSpec = { ...spec, name: 'warm-node-c', nodeName: 'pool-node-c-server-0' };
  const manifest = warmWorkerPodManifest(prepareSpec);
  const createdPod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'retry-uid' } };
  const abort = new AbortController();
  const actions: string[] = [];
  const provider = new WarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) }, prepareAbortSignal: abort.signal,
    kubectl: args => {
      actions.push(args[4]!);
      if (args[4] === 'get' && args[5] === 'pods') return { status: 0, stdout: '{"items":[]}', stderr: '' };
      if (args[4] === 'create') return { status: 0, stdout: JSON.stringify(createdPod), stderr: '' };
      if (args[4] === 'wait') { abort.abort(new Error('cancel retry')); return { status: 1, stdout: '', stderr: 'transient API failure' }; }
      throw new Error(`unexpected ${args.join(' ')}`);
    },
    fetch: async () => Response.json({ resources: [] }),
  });
  await expect(provider.prepareWorker(prepareSpec.workerId)).rejects.toThrow('cancel retry');
  expect(actions).toEqual(['get', 'create', 'wait']);
});

test('an immediate kubectl wait failure retries after a bounded delay and registers only the pinned UID', async () => {
  const prepareSpec = { ...spec, name: 'warm-node-c', nodeName: 'pool-node-c-server-0' };
  const manifest = warmWorkerPodManifest(prepareSpec);
  const createdPod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'delayed-ready-uid' } };
  const readyPod = { ...createdPod, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
  const actions: string[] = [];
  let waitCalls = 0;
  let registrations = 0;
  const provider = new WarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: args => {
      actions.push(args[4]!);
      if (args[4] === 'get' && args[5] === 'pods') return { status: 0, stdout: '{"items":[]}', stderr: '' };
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
  expect(actions).toEqual(['get', 'create', 'wait', 'get', 'wait', 'get']);
});

test('a Pod UID replaced during the Ready recheck is never registered', async () => {
  const prepareSpec = { ...spec, name: 'warm-node-c', nodeName: 'pool-node-c-server-0' };
  const manifest = warmWorkerPodManifest(prepareSpec);
  const createdPod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'created-uid' } };
  const replacementPod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'replacement-uid' } };
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const actions: string[] = [];
  let registrations = 0;
  const provider = new WarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: args => {
      actions.push(args[4]!);
      if (args[4] === 'get' && args[5] === 'pods') return result({ items: [] });
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
  expect(actions).toEqual(['get', 'create', 'wait', 'get']);
  expect(registrations).toBe(0);
});

test('cold init beyond five minutes reaches Ready and registers its exact created UID', async () => {
  const prepareSpec = { ...spec, name: 'warm-node-c', nodeName: 'pool-node-c-server-0' };
  const manifest = warmWorkerPodManifest(prepareSpec);
  const createdPod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'cold-uid' } };
  const readyPod = { ...createdPod, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  let registeredUid: string | undefined;
  let waitCalls = 0;
  let clock = 1_000_000;
  const provider = new WarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
    now: () => clock,
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: args => {
      if (args[4] === 'get' && args[5] === 'pods') return result({ items: [] });
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
  const prepareSpec = { ...spec, name: 'warm-node-c', nodeName: 'pool-node-c-server-0' };
  const manifest = warmWorkerPodManifest(prepareSpec);
  const pod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'slow-uid' } };
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const actions: string[] = [];
  const controlPaths: string[] = [];
  const provider = new WarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: args => {
      actions.push(args[4]!);
      if (args[4] === 'get') return result({ items: [] });
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
  expect(actions).toEqual(['get', 'create', 'wait', 'get']);
  expect(controlPaths).toEqual(['/v1/resources']);
});

test('standing producer refuses a replaced Pod without create/delete and registers one Ready Pod', async () => {
  const prepareSpec = { ...spec, name: 'warm-node-c', nodeName: 'pool-node-c-server-0' };
  const prepareCandidate = { ...candidate, spec: prepareSpec };
  const manifest = warmWorkerPodManifest(prepareSpec);
  const pod = (uid: string) => ({ ...manifest, metadata: { ...(manifest.metadata as object), uid },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } });
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const paths: string[] = [];
  const displacedCommands: string[] = [];
  const displaced = new WarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: args => {
      const action = args[4]!; displacedCommands.push(action);
      if (action === 'get' && args[5] === 'pods') return result({ items: [pod('old-uid')] });
      if (action === 'wait') return result({});
      if (action === 'get') return result(pod('replacement-uid'));
      throw new Error(`unexpected ${args.join(' ')}`);
    },
    fetch: async url => { paths.push(new URL(String(url)).pathname); return Response.json({}); },
  });
  let forgedKubectlCalls = 0;
  const unpinned = new WarmPodProvider({ candidates: [candidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: () => { forgedKubectlCalls++; return result({ items: [] }); },
  });
  expect(await unpinned.ensureStandingWorker(prepareCandidate)).toBe(false);
  expect(forgedKubectlCalls).toBe(0);
  expect(await displaced.ensureStandingWorker(prepareCandidate)).toBe(false);
  expect(displacedCommands).toEqual(['get', 'wait', 'get']);
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
    const refused = new WarmPodProvider({ candidates: [prepareCandidate],
      controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
      machineTokens: { node-c: '2'.repeat(64) },
      kubectl: args => { calls.push(args[4]!); return result({ items: [changed] }); },
      fetch: async () => { throw new Error('mutated Pod reached the control plane'); },
    });
    expect(await refused.prepareWorker(prepareSpec.workerId)).toBe(false);
    expect(calls).toEqual(['get']);
  }

  const commands: string[] = [];
  const registered: Array<{ path: string; authorization: string | null; body: any }> = [];
  const prepared = new WarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: args => {
      const action = args[4]!; commands.push(action);
      if (action === 'get' && args[5] === 'pods') {
        expect(args).not.toContain('--field-selector');
        expect(args).not.toContain('-l');
        return result({ items: [{ metadata: { name: 'warm-other-host', annotations: { 'elanous.dev/warm-worker-id': 'other-worker' } } }] });
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
  expect(commands).toEqual(['get', 'create', 'wait', 'get']);
  expect(registered).toEqual([{ path: '/v1/workers/pod', authorization: `Bearer ${'2'.repeat(64)}`, body: {
    workerId: prepareSpec.workerId, machine: 'node-c', podUid: 'new-uid', key, ttlMs: 30 * 60_000,
  } }]);

  for (const appearsAfterPreflight of [false, true]) {
    const actions: string[] = [];
    const controlCalls: string[] = [];
    let reads = 0;
    const conflicting = new WarmPodProvider({ candidates: [prepareCandidate],
      controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
      machineTokens: { node-c: '2'.repeat(64) },
      kubectl: args => {
        actions.push(args[4]!);
        if (args[5] === 'pods') return result({ items: [] });
        if (args[4] === 'create' || args[4] === 'get') return result(pod('new-uid'));
        if (args[4] === 'wait') return result({});
        throw new Error(`unexpected ${args.join(' ')}`);
      },
      fetch: async (url, init) => {
        controlCalls.push(`${init?.method} ${new URL(String(url)).pathname}`);
        if (init?.method === 'POST') throw new Error('conflicting worker ID reached registration');
        reads++;
        return Response.json({ resources: appearsAfterPreflight && reads === 1 ? [] : [{
          kind: 'pod-worker-lease', machine: 'node-c', name: prepareSpec.workerId,
          observedAt: Date.now(), ttlMs: 30 * 60_000,
          attrs: { state: 'idle', podUid: 'old-uid', key, idleTtlMs: 30 * 60_000 },
        }] });
      },
    });
    expect(await conflicting.prepareWorker(prepareSpec.workerId)).toBe(false);
    expect(actions).toEqual(appearsAfterPreflight ? ['get', 'create', 'wait', 'get'] : ['get']);
    expect(controlCalls).toEqual(appearsAfterPreflight
      ? ['GET /v1/resources', 'GET /v1/resources'] : ['GET /v1/resources']);
  }

  let foreignRegistrations = 0;
  const foreignIdentical = new WarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: args => result(args[5] === 'pods' ? { items: [pod('foreign-uid')] } : pod('foreign-uid')),
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
    const repeated = new WarmPodProvider({ candidates: [prepareCandidate],
      controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
      machineTokens: { node-c: '2'.repeat(64) },
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
        return args[5] === 'pods' ? result({ items: [defaulted] }) : result(defaulted);
      },
      fetch: async (url, init) => {
        controlCalls.push(`${init?.method} ${new URL(String(url)).pathname}`);
        return Response.json({ resources: [{ kind: 'pod-worker-lease', machine: 'node-c',
          name: prepareSpec.workerId, observedAt: Date.now(), ttlMs: 30 * 60_000,
          attrs: { state, podUid: 'new-uid', key, idleTtlMs: 30 * 60_000 } }] });
      },
    });
    expect(await repeated.prepareWorker(prepareSpec.workerId)).toBe(state !== 'quarantined');
    expect(repeatCommands).toEqual(['get', 'wait', 'get']);
    expect(controlCalls).toEqual(['GET /v1/resources']);
  }

  const wrongUidCalls: string[] = [];
  const wrongUid = new WarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: args => result(args[5] === 'pods' ? { items: [pod('new-uid')] } : pod('new-uid')),
    fetch: async (url, init) => {
      wrongUidCalls.push(`${init?.method} ${new URL(String(url)).pathname}`);
      return Response.json({ resources: [{ kind: 'pod-worker-lease', machine: 'node-c',
        name: prepareSpec.workerId, observedAt: Date.now(), ttlMs: 30 * 60_000,
        attrs: { state: 'idle', podUid: 'old-uid', key, idleTtlMs: 30 * 60_000 } }] });
    },
  });
  expect(await wrongUid.prepareWorker(prepareSpec.workerId)).toBe(false);
  expect(wrongUidCalls).toEqual(['GET /v1/resources']);

  const legacyCalls: string[] = [];
  const legacyUid = new WarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: args => result(args[5] === 'pods' ? { items: [pod('new-uid')] } : pod('new-uid')),
    fetch: async (url, init) => {
      legacyCalls.push(`${init?.method} ${new URL(String(url)).pathname}`);
      return Response.json({ resources: [{ kind: 'pod-worker-lease', machine: 'node-c',
        name: prepareSpec.workerId, attrs: { state: 'idle', key } }] });
    },
  });
  expect(await legacyUid.prepareWorker(prepareSpec.workerId)).toBe(false);
  expect(legacyCalls).toEqual(['GET /v1/resources']);

  const expiredCalls: string[] = [];
  const expired = new WarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: args => result(args[5] === 'pods' ? { items: [pod('new-uid')] } : pod('new-uid')),
    fetch: async (url, init) => {
      expiredCalls.push(`${init?.method} ${new URL(String(url)).pathname}`);
      return Response.json({ resources: [{ kind: 'pod-worker-lease', machine: 'node-c',
        name: prepareSpec.workerId, observedAt: Date.now() - 31 * 60_000, ttlMs: 30 * 60_000,
        attrs: { state: 'idle', podUid: 'new-uid', key, idleTtlMs: 30 * 60_000 } }] });
    },
  });
  expect(await expired.prepareWorker(prepareSpec.workerId)).toBe(false);
  expect(expiredCalls).toEqual(['GET /v1/resources']);

  const wrongTtl = new WarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: args => result(args[5] === 'pods' ? { items: [pod('new-uid')] } : pod('new-uid')),
    fetch: async () => Response.json({ resources: [{ kind: 'pod-worker-lease', machine: 'node-c',
      name: prepareSpec.workerId, observedAt: Date.now(), ttlMs: 60_000,
      attrs: { state: 'idle', podUid: 'new-uid', key, idleTtlMs: 60_000 } }] }),
  });
  expect(await wrongTtl.prepareWorker(prepareSpec.workerId)).toBe(false);

  const future = new WarmPodProvider({ candidates: [prepareCandidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: args => result(args[5] === 'pods' ? { items: [pod('new-uid')] } : pod('new-uid')),
    fetch: async () => Response.json({ resources: [{ kind: 'pod-worker-lease', machine: 'node-c',
      name: prepareSpec.workerId, observedAt: Date.now() + 60_000, ttlMs: 30 * 60_000,
      attrs: { state: 'idle', podUid: 'new-uid', key } }] }),
  });
  expect(await future.prepareWorker(prepareSpec.workerId)).toBe(false);
});

test('real control GET keeps a matching Pod preparation idempotent with one registration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-producer-control-'));
  const server = startControlServer({ root, port: 0, leaseView: { async get() {
    return { holder: 'node-c', generation: 1, iAmHolder: true, known: true };
  } } });
  try {
    const prepareSpec = { ...spec, name: 'warm-node-c', nodeName: 'pool-node-c-server-0' };
    const manifest = warmWorkerPodManifest(prepareSpec);
    const pod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'real-uid' },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
    let created = false;
    let registrations = 0;
    const provider = new WarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
      controlUrl: `${server.url}/`, memberToken: ensureControlTokens(root).member,
      machineTokens: { node-c: issueMemberToken('node-c', root) },
      kubectl: args => {
        const result = args[5] === 'pods' ? { items: created ? [pod] : [] } : pod;
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
  const provider = new WarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { node-c: '2'.repeat(64) },
    kubectl: leaseKubectl(),
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body));
      calls.push({ path, token: new Headers(init?.headers).get('authorization')!, body });
      return Response.json(path === '/v1/leases/pod-worker' ? lease() : { attrs: { state: 'idle' } });
    },
    transport: () => ({ request: async () => ({ status: 'observed', reason: 'complete', reply: null }) }),
  });
  const result = await provider.request(input());
  expect(result.command).toMatchObject({ workerId: spec.workerId, generation: 1, leaseId: 'lease-1', key });
  expect(result.transport.reason).toBe('complete');
  expect(calls.map(call => call.path)).toEqual(['/v1/leases/pod-worker']);
  await provider.finalize(result.command!);
  expect(calls.map(call => call.path)).toEqual([
    '/v1/leases/pod-worker', `/v1/leases/pod-worker/${spec.workerId}/release`,
    `/v1/leases/pod-worker/${spec.workerId}/sanitize`,
  ]);
  await provider.finalize(result.command!);
  expect(calls).toHaveLength(3);
  expect(calls[2]!.token).toBe(`Bearer ${'2'.repeat(64)}`);
  expect(calls[1]!.body).toMatchObject({ leaseId: 'lease-1', generation: 1 });
});

test('a sanitize failure followed by the gate fallback quarantines one lease only once', async () => {
  const paths: string[] = [];
  const provider = new WarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { node-c: '2'.repeat(64) }, kubectl: leaseKubectl(),
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return path === '/v1/leases/pod-worker' ? Response.json(lease())
        : new Response('{}', { status: path.endsWith('/sanitize') ? 503 : 200 });
    },
    transport: () => ({ request: async () => ({ status: 'observed', reason: 'complete', reply: null }) }),
  });
  const result = await provider.request(input());
  expect(result.command).not.toBeNull();
  await expect(provider.finalize(result.command!)).rejects.toThrow('warm sanitize unavailable');
  await provider.quarantine(result.command!, 'gate-finalize-failed');
  expect(paths.filter(path => path.endsWith('/quarantine'))).toHaveLength(1);
});

test('concurrent quarantine callers share one fenced lease transition', async () => {
  const paths: string[] = [];
  let releaseQuarantine: (() => void) | undefined;
  const quarantinePause = new Promise<void>(resolve => { releaseQuarantine = resolve; });
  const provider = new WarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { node-c: '2'.repeat(64) }, kubectl: leaseKubectl(),
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path.endsWith('/quarantine')) await quarantinePause;
      return path === '/v1/leases/pod-worker' ? Response.json(lease()) : Response.json({ attrs: { state: 'quarantined' } });
    },
    transport: () => ({ request: async () => ({ status: 'observed', reason: 'complete', reply: null }) }),
  });
  const result = await provider.request(input());
  const first = provider.quarantine(result.command!, 'first-failure');
  const second = provider.quarantine(result.command!, 'same-failure');
  releaseQuarantine!();
  await Promise.all([first, second]);
  expect(paths.filter(path => path.endsWith('/quarantine'))).toHaveLength(1);
});

test('a failed quarantine transition can retry the same lease', async () => {
  let quarantineCalls = 0;
  const provider = new WarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { node-c: '2'.repeat(64) }, kubectl: leaseKubectl(),
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/leases/pod-worker') return Response.json(lease());
      if (path.endsWith('/quarantine')) return new Response('{}', { status: ++quarantineCalls === 1 ? 503 : 200 });
      return Response.json({ attrs: { state: 'idle' } });
    },
    transport: () => ({ request: async () => ({ status: 'observed', reason: 'complete', reply: null }) }),
  });
  const result = await provider.request(input());
  await expect(provider.quarantine(result.command!, 'first-failure')).rejects.toThrow('warm quarantine unavailable');
  await provider.quarantine(result.command!, 'retry');
  expect(quarantineCalls).toBe(2);
});

test('a replaced Pod refuses the acquired lease before transport and quarantines it', async () => {
  const paths: string[] = [];
  let transported = 0;
  const manifest = warmWorkerPodManifest(spec);
  const provider = new WarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), kubectl: args => {
      expect(args[4]).toBe('get');
      return { status: 0, stdout: JSON.stringify({ metadata: { ...(manifest.metadata as object),
        name: spec.name, namespace: spec.namespace, uid: 'replacement-uid', resourceVersion: '1' } }), stderr: '' };
    },
    fetch: async url => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return Response.json(path === '/v1/leases/pod-worker' ? lease() : {});
    },
    transport: () => ({ request: async () => {
      transported++;
      return { status: 'observed', reason: 'complete', reply: null };
    } }),
  });
  expect(await provider.request(input())).toMatchObject({ command: null,
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
    const provider = new WarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64), kubectl: () => ({ status: 0, stdout: JSON.stringify({ metadata: {
        ...(manifest.metadata as object), name: spec.name, namespace: spec.namespace,
        uid: 'replacement-uid', resourceVersion: '1' } }), stderr: '' }),
      fetch: async url => Response.json(new URL(String(url)).pathname === '/v1/leases/pod-worker' ? lease() : {}) });
    await provider.request(input());
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
  const provider = new WarmPodProvider({ candidates: [candidate, { ...candidate, spec: secondSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    kubectl: leaseKubectl([spec, secondSpec]),
    fetch: async url => {
      const path = new URL(String(url)).pathname; paths.push(path);
      return Response.json(path === '/v1/leases/pod-worker'
        ? { ...lease(), name: secondSpec.workerId } : {});
    },
    transport: selected => ({ request: async () => {
      transported = selected.workerId;
      return { status: 'observed', reason: 'complete', reply: null };
    } }),
  });
  const result = await provider.request(input());
  expect(result.command?.workerId).toBe(secondSpec.workerId);
  expect(transported).toBe(secondSpec.workerId);
  expect(paths).toEqual(['/v1/leases/pod-worker']);
});

test('an unrecognized leased worker is refused without transport or quarantine', async () => {
  const paths: string[] = [];
  let transported = 0;
  const provider = new WarmPodProvider({ candidates: [candidate],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    fetch: async url => {
      const path = new URL(String(url)).pathname; paths.push(path);
      return Response.json({ ...lease(), name: 'unknown-worker' });
    },
    transport: () => ({ request: async () => {
      transported++;
      return { status: 'observed', reason: 'complete', reply: null };
    } }),
  });
  expect(await provider.request(input())).toMatchObject({ command: null,
    transport: { status: 'fallback', reason: 'lease-unavailable' } });
  expect(transported).toBe(0);
  expect(paths).toEqual(['/v1/leases/pod-worker']);
});

test('transport mismatch quarantines the leased worker and never sanitizes it', async () => {
  const paths: string[] = [];
  const provider = new WarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), fetch: async (url) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      return Response.json(path === '/v1/leases/pod-worker' ? lease() : {});
    }, kubectl: leaseKubectl(),
    transport: () => ({ request: async () => ({ status: 'fallback', reason: 'invalid-result', reply: null }) }) });
  const result = await provider.request(input());
  expect(result.transport.reason).toBe('invalid-result');
  expect(paths).toEqual(['/v1/leases/pod-worker', `/v1/leases/pod-worker/${spec.workerId}/quarantine`]);
});

test('missing remote-internal context refuses before lease, Pod exec or quarantine', async () => {
  const paths: string[] = [];
  const stderr = 'error: context "k3d-elanous-pool" does not exist\n';
  let transportCalls = 0;
  const provider = new WarmPodProvider({
    candidates: [{ ...candidate, spec: { ...spec, kubectlContext: 'k3d-elanous-pool' } }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    kubectl: args => {
      expect(args).toEqual(['config', 'get-contexts', 'k3d-elanous-pool', '-o', 'name']);
      return { status: 1, stdout: '', stderr };
    },
    fetch: async url => { paths.push(new URL(String(url)).pathname); return Response.json(lease()); },
    transport: () => ({ request: async () => { transportCalls++; return { status: 'fallback', reason: 'exec-failed', reply: null }; } }),
  });
  expect(await provider.request(input())).toEqual({ command: null, transport: {
    status: 'fallback', reason: 'context-unavailable', reply: null, kubectlStderr: stderr,
  } });
  expect(paths).toEqual([]);
  expect(transportCalls).toBe(0);
});

test('a zero shadow budget never starts kubectl and quarantines its acquired lease', async () => {
  const paths: string[] = [];
  const provider = new WarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), maxShadowMs: 0, kubectl: leaseKubectl(), fetch: async (url) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      return Response.json(path === '/v1/leases/pod-worker' ? lease() : {});
    } });
  expect((await provider.request(input())).transport).toMatchObject({ status: 'fallback', reason: 'exec-failed' });
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
    const provider = new WarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
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
    const result = await provider.request(input());
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
    const prepareSpec = { ...spec, name: 'warm-node-c', nodeName: 'pool-node-c-server-0' };
    const gateFile = 'src/example/worker.test.ts';
    writeFileSync(file, JSON.stringify({
      candidates: [{ host: 'node-c', tier: 'standard', spec: prepareSpec }],
      controlUrl: 'http://127.0.0.1:31413/',
      memberToken: '1'.repeat(64),
      machineTokens: { node-c: '2'.repeat(64) },
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
    expect(legs[0]).toMatchObject({ gateKey: `${gateFile}/${prepareSpec.cutSha}/node-c`, leg: 'cold',
      file: gateFile, commit: prepareSpec.cutSha, host: 'node-c', reuse: false, podUid: '', success: false });
    expect(legs[0].totalDurationMs).toBe(legs[0].prepareDurationMs);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('WARM-REUSE-TIME-PAIRS: unset pairingGateFile skips the cold measurement row entirely', async () => {
  const events: Array<{ event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm' && event === 'warm-reuse-time-pair') events.push({ event, data });
  }) as typeof debug.log);
  try {
    const provider = new WarmPodProvider({ candidates: [{ ...candidate,
      spec: { ...spec, nodeName: 'pool-node-c-server-0' } }],
      controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
      machineTokens: { node-c: '2'.repeat(64) },
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
  const prepareSpec = { ...spec, name: 'warm-node-c', nodeName: 'pool-node-c-server-0' };
  const pods = new Map<string, any>();
  let clock = Date.now();
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const kubectl = (args: readonly string[], createInput?: string) => {
    const verb = args[4]!;
    if (verb === 'config') return result(prepareSpec.kubectlContext);
    if (verb === 'get' && args[5] === 'pods') return result({ items: [...pods.values()] });
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
    memberToken: '1'.repeat(64), machineTokens: { node-c: '2'.repeat(64) }, now: () => clock,
    kubectl, fetch: fetch as typeof globalThis.fetch };
  // The warm leg's exec takes 300ms on the already-standing Pod.
  const transport = () => ({ request: async () => { clock += 300;
    return { status: 'observed' as const, reason: 'complete' as const, reply: null }; } });
  // Cold process: the --prepare/--reconcile/--serve CLI binds the gate file (loadWarmPodProvider(file, gateFile)).
  const cold = new WarmPodProvider({ ...base, pairingGateFile: gateFile, transport } as any);
  // Warm process: gate-node's requestWarmPodReplay → currentProvider() → loadWarmPodProvider(file) — no gate file.
  const warm = new WarmPodProvider({ ...base, transport } as any);
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
    expect((await warm.request({ ...input(), files: [gateFile] })).transport)
      .toMatchObject({ status: 'observed', reason: 'complete' });
    sink.flush();
    // Neither process holds the pair in memory; the read-only reader joins the shared rows.
    const pairs = readWarmReuseTimePairs(store);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({ gateKey: `${gateFile}/${spec.cutSha}/node-c`, file: gateFile,
      commit: spec.cutSha, host: 'node-c',
      cold: { file: gateFile, commit: spec.cutSha, host: 'node-c', reuse: false, podUid: 'new-uid',
        success: true, prepareDurationMs: 5_000, totalDurationMs: 5_000 },
      warm: { file: gateFile, commit: spec.cutSha, host: 'node-c', reuse: true, podUid: 'new-uid',
        success: true, prepareDurationMs: 0, totalDurationMs: 300 } });
    // Concrete saving: cold prepare 5000ms vs warm total 300ms on the same Pod.
    expect(pairs[0]!.cold!.prepareDurationMs - pairs[0]!.warm!.totalDurationMs).toBe(4_700);
  } finally {
    off(); sink.close(); store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WARM-REUSE-TIME-PAIRS: a multi-file gate never becomes a warm leg and logs its skip reason', async () => {
  const { gateFile, prepareSpec, cold, warm } = pairingFixture();
  // The standing Pod must exist first so the warm lease really reaches the exec path.
  expect(await cold.prepareWorker(prepareSpec.workerId)).toBe(true);
  const events: Array<{ event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'pod.warm' && event.startsWith('warm-reuse-time-pair')) events.push({ event, data });
  }) as typeof debug.log);
  try {
    const replay = await warm.request({ ...input(), files: [gateFile, 'src/example/other.test.ts'] });
    expect(replay.transport).toMatchObject({ status: 'observed', reason: 'complete' });
    expect(warm.warmReuseTimeLegs()).toEqual([]);
    expect(events).toEqual([{ event: 'warm-reuse-time-pair-skipped',
      data: { reason: 'not-single-file-gate', fileCount: 2, commit: spec.cutSha, host: 'node-c' } }]);
  } finally { log.mockRestore(); }
});

test('WARM-REUSE-TIME-PAIRS: pairing joins only the same file·commit·host and skips malformed rows', () => {
  const leg = (over: Record<string, unknown>) => ({ gateKey: 'f.test.ts/c/node-c', leg: 'cold', file: 'f.test.ts',
    commit: 'c', host: 'node-c', reuse: false, prepareDurationMs: 5_000, totalDurationMs: 5_000,
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
    .toEqual([['f.test.ts/c/node-c', 5_000, 300], ['f.test.ts/c/node-b', null, 200]]);
});

test('standing Pod preparation refuses a candidate without a pinned node', async () => {
  let calls = 0;
  const provider = new WarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { node-c: '2'.repeat(64) },
    fetch: async () => { calls++; throw new Error('unexpected control call'); },
  });
  expect(await provider.ensureStandingWorker(candidate)).toBe(false);
  expect(calls).toBe(0);
});

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
