import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WarmPodProvider, requestWarmPodReplay, configureWarmPodProvider } from './pod-warm-worker-provider.js';
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
const lease = () => ({ name: spec.workerId, attrs: { key, leaseId: 'lease-1', generation: 1, state: 'leased' } });

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

test('cold init beyond five minutes reaches Ready and registers its exact created UID', async () => {
  const prepareSpec = { ...spec, name: 'warm-node-c', nodeName: 'pool-node-c-server-0' };
  const manifest = warmWorkerPodManifest(prepareSpec);
  const createdPod = { ...manifest, metadata: { ...(manifest.metadata as object), uid: 'cold-uid' } };
  const readyPod = { ...createdPod, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
  const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  let registeredUid: string | undefined;
  const provider = new WarmPodProvider({ candidates: [{ ...candidate, spec: prepareSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
    machineTokens: { node-c: '2'.repeat(64) },
    kubectl: args => {
      if (args[4] === 'get' && args[5] === 'pods') return result({ items: [] });
      if (args[4] === 'create') return result(createdPod);
      if (args[4] === 'wait') {
        const timeout = args.find(arg => arg.startsWith('--timeout='));
        // The cold install takes seven minutes; kubectl's old 300s bound fails here.
        return timeout && Number.parseInt(timeout.slice('--timeout='.length), 10) >= 420
          ? result({}) : { status: 1, stdout: '', stderr: 'timed out' };
      }
      if (args[4] === 'get') return result(readyPod);
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
  expect(actions).toEqual(['get', 'create', 'wait']);
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
  expect(calls[2]!.token).toBe(`Bearer ${'2'.repeat(64)}`);
  expect(calls[1]!.body).toMatchObject({ leaseId: 'lease-1', generation: 1 });
});

test('a host/key lease executes the worker ID returned by the control plane', async () => {
  const secondSpec = { ...spec, name: 'warm-test-2', workerId: 'warm-test-2-uid' };
  const paths: string[] = [];
  let transported = '';
  const provider = new WarmPodProvider({ candidates: [candidate, { ...candidate, spec: secondSpec }],
    controlUrl: 'http://127.0.0.1:31413/', memberToken: '1'.repeat(64),
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
    }, transport: () => ({ request: async () => ({ status: 'fallback', reason: 'invalid-result', reply: null }) }) });
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
    memberToken: '1'.repeat(64), maxShadowMs: 0, fetch: async (url) => {
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
      memberToken: '1'.repeat(64), maxShadowMs: 8_000, fetch: async (url) => {
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

test('standing Pod preparation refuses a candidate without a pinned node', async () => {
  let calls = 0;
  const provider = new WarmPodProvider({ candidates: [candidate], controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { node-c: '2'.repeat(64) },
    fetch: async () => { calls++; throw new Error('unexpected control call'); },
  });
  expect(await provider.ensureStandingWorker(candidate)).toBe(false);
  expect(calls).toBe(0);
});
