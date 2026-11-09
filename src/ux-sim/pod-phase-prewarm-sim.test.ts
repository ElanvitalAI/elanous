import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { WarmPodProvider } from '../task-orchestrator/surfaces/pod-warm-worker-provider.js';
import { warmWorkerPodManifest, type WarmPodSpec } from '../task-orchestrator/surfaces/pod-warm-worker-pod.js';
import { podPhaseGateIdentityMatches, type PodPhasePrewarmConfig } from '../task-orchestrator/surfaces/pod-warm-switch.js';
import { loadMockScenarioCatalog } from './mock-scenario-catalog.js';
import { simulatePodPhasePrewarm } from './pod-phase-prewarm-sim.js';

describe('POD-PHASE-PREWARM simulation', () => {
  const schedules = [{ version: '0.3.6', cutAt: '2026-11-07T19:30:00.000Z', publishAt: '2026-11-07T21:00:00.000Z' }];
  test('moves rehearsal to cut gate, publication, then normal', () => {
    expect(simulatePodPhasePrewarm({ now: '2026-11-07T12:31:00.000Z', schedules }).phase).toBe('rehearsal');
    expect(simulatePodPhasePrewarm({ now: '2026-11-07T19:00:00.000Z', schedules })).toMatchObject({ phase: 'cut-gate', target: { gate: 2, implementation: 0 } });
    expect(simulatePodPhasePrewarm({ now: '2026-11-07T20:00:00.000Z', schedules }).phase).toBe('publication');
    expect(simulatePodPhasePrewarm({ now: '2026-11-07T22:00:00.000Z', schedules }).phase).toBe('normal');
  });
  test('a completed prior cut does not shadow the next rehearsal window', () => {
    const adjacent = [
      { version: '0.3.5', cutAt: '2026-11-06T19:30:00.000Z', publishAt: '2026-11-07T21:00:00.000Z' },
      ...schedules,
    ];
    expect(simulatePodPhasePrewarm({ now: '2026-11-07T12:31:00.000Z', schedules: adjacent }))
      .toMatchObject({ phase: 'rehearsal', version: '0.3.6' });
    expect(simulatePodPhasePrewarm({ now: '2026-11-07T19:05:00.000Z', schedules: adjacent }))
      .toMatchObject({ phase: 'cut-gate', version: '0.3.6' });
  });
  test('malformed release timestamps fail closed', () => {
    expect(() => simulatePodPhasePrewarm({ now: '2026-11-07T19:05:00.000Z',
      schedules: [{ version: '0.3.6', cutAt: 'not-a-date', publishAt: null }] })).toThrow('invalid-release-schedule-cut-at');
  });
  test('gate prewarm requires exact configured cut and lock identity', () => {
    const config: PodPhasePrewarmConfig = { gateIdentity: { cutSha: 'a'.repeat(40), lockHash: 'b'.repeat(64) } };
    expect(podPhaseGateIdentityMatches({ cutSha: 'a'.repeat(40), lockHash: 'b'.repeat(64) }, config)).toBe(true);
    expect(podPhaseGateIdentityMatches({ cutSha: 'a'.repeat(40), lockHash: 'c'.repeat(64) }, config)).toBe(false);
  });
  test('shared host/tier slots shift from a rehearsal split to the cut gate target', () => {
    const candidates = [
      { id: 'slot-gate', kind: 'gate' as const, cutSha: 'a'.repeat(40), lockHash: 'b'.repeat(64) },
      { id: 'slot-implementation', kind: 'implementation' as const, cutSha: 'a'.repeat(40), lockHash: 'b'.repeat(64) },
    ];
    const config: PodPhasePrewarmConfig = { gateIdentity: { cutSha: 'a'.repeat(40), lockHash: 'b'.repeat(64) } };
    expect(simulatePodPhasePrewarm({ now: '2026-11-07T12:31:00.000Z', schedules, candidates, config }).assignments)
      .toEqual([{ id: 'slot-gate', kind: 'gate' }, { id: 'slot-implementation', kind: 'implementation' }]);
    expect(simulatePodPhasePrewarm({ now: '2026-11-07T19:00:00.000Z', schedules, candidates, config }).assignments)
      .toEqual([{ id: 'slot-gate', kind: 'gate' }, { id: 'slot-implementation', kind: 'gate' }]);
  });
  test('scenario device is registered in the Nexus mock catalog', () => {
    const catalog = loadMockScenarioCatalog();
    expect(catalog.devices.some(device => device.id === 'pod-phase-prewarm-sim')).toBe(true);
    expect(catalog.scenarios.some(scenario => scenario.id === 'UX-MS-POD-PHASE-PREWARM')).toBe(true);
  });

  test('pod-phase-prewarm-hit-sim prewarms the real provider and serves its first gate request warm', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-phase-prewarm-hit-'));
    const nowBase = Date.parse('2026-11-07T19:05:00.000Z');
    let nowMs = nowBase;
    const now = () => nowMs++;
    const cutSha = 'a'.repeat(40);
    const lockHash = 'b'.repeat(64);
    const key = { context: 'aws2-gate', imageDigest: `sha256:${'c'.repeat(64)}`, lockHash, architecture: 'amd64' };
    const spec: WarmPodSpec = { name: 'warm-aws2-standard-gate-1', namespace: 'elanous-test', kubectlContext: 'k3d-aws2',
      workerId: 'aws2-gate-worker-1', image: `registry.example/elanous@${key.imageDigest}`,
      sourceUrl: 'https://github.com/ElanvitalAI/elanous.git', nodeName: 'aws2-node-1', cutSha, key,
      runtimeContract: { baseImageDigest: key.imageDigest, bunVersion: '1.4.2', os: 'linux', architecture: 'amd64', requiredTools: ['bun', 'git'] },
      memoryLimit: '16Gi', hostProbeUrl: 'http://host.orb.internal:10001/health',
      prodProbeUrl: 'http://core.elanous-prod:10002/' };
    const candidate = { host: 'aws2', tier: 'standard' as const, kind: 'gate' as const, spec };
    const manifest = warmWorkerPodManifest(spec) as any;
    const pods = new Map<string, any>();
    const leases = new Map<string, any>();
    const podUid = 'aws2-gate-pod-uid';
    const leaseId = 'aws2-gate-lease-1';
    const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
    const kubectl = (args: readonly string[], input?: string) => {
      if (args[0] === 'config' && args[1] === 'get-contexts') return { status: 0, stdout: 'k3d-aws2\n', stderr: '' };
      const verb = args[4];
      if (verb === 'get' && args[5] === 'pods') {
        const selector = args.find(arg => arg.startsWith('--field-selector=metadata.name='));
        const rows = selector ? [...pods.values()].filter(row => row.metadata.name === selector.split('=').at(-1))
          : [...pods.values()].filter(row => row.metadata.labels?.['elanous.kind'] === 'warm-worker');
        return result({ kind: 'PodList', metadata: { continue: '' }, items: rows });
      }
      if (verb === 'create') {
        const created = JSON.parse(input!);
        const pod = { ...created, metadata: { ...created.metadata, uid: podUid, resourceVersion: '1' },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }],
            containerStatuses: [{ name: 'worker', ready: true }] } };
        pods.set(spec.name, pod);
        return result(pod);
      }
      if (verb === 'wait') return result({});
      if (verb === 'get' && (args[5] === 'pod' || args[5]?.startsWith('pod/'))) {
        const name = args[5] === 'pod' ? args[6] : args[5].slice('pod/'.length);
        return result(pods.get(name!));
      }
      if (verb === 'patch' && args[5] === 'pod') {
        const pod = pods.get(args[6]!);
        if (!pod) return { status: 1, stdout: '', stderr: 'pod missing' };
        const patch = JSON.parse(args[args.indexOf('-p') + 1]!) as Array<{ path: string; value: any }>;
        if (patch[0]?.value !== pod.metadata.uid || patch[1]?.value !== pod.metadata.resourceVersion)
          return { status: 1, stdout: '', stderr: 'UID/resourceVersion precondition failed' };
        const labels = patch.find(row => row.path === '/metadata/labels')?.value;
        const annotations = patch.find(row => row.path === '/metadata/annotations')?.value;
        pod.metadata = { ...pod.metadata, labels, annotations,
          resourceVersion: String(Number(pod.metadata.resourceVersion) + 1) };
        return result(pod);
      }
      throw new Error(`unexpected simulated kubectl: ${args.join(' ')}`);
    };
    const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/v1/resources') {
        const name = parsed.searchParams.get('name');
        return Response.json({ resources: [...leases.values()].filter(row => !name || row.name === name) });
      }
      if (parsed.pathname === '/v1/workers/pod') {
        const body = JSON.parse(String(init?.body));
        const lease = { kind: 'pod-worker-lease', machine: 'aws2', name: body.workerId, observedAt: now(),
          ttlMs: body.ttlMs, attrs: { state: 'idle', podUid: body.podUid, idleTtlMs: body.ttlMs, key: body.key } };
        leases.set(body.workerId, lease);
        return Response.json({ name: body.workerId, attrs: lease.attrs });
      }
      if (parsed.pathname === '/v1/leases/pod-worker' && init?.method === 'POST') {
        const lease = leases.get(spec.workerId);
        if (!lease || lease.attrs.state !== 'idle') return Response.json({}, { status: 503 });
        lease.attrs.state = 'leased';
        return Response.json({ name: spec.workerId, attrs: { ...lease.attrs, leaseId, generation: 1 } });
      }
      throw new Error(`unexpected simulated control request: ${parsed.pathname}`);
    };
    let firstGateTransportCalls = 0;
    let phaseObservation: Record<string, unknown> | undefined;
    let prepareDecision: Record<string, unknown> | undefined;
    const phaseLog = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      if (category === 'task-orchestrator.pod-phase' && event === 'reconcile') phaseObservation = data as Record<string, unknown>;
      if (category === 'pod.warm' && event === 'pool-reconcile-decision') prepareDecision = data as Record<string, unknown>;
    }) as typeof debug.log);
    try {
      const provider = new WarmPodProvider({ candidates: [candidate],
        profileConfig: { pod: { warmPoolProfile: 'gate' } }, controlUrl: 'http://127.0.0.1:31413/',
        memberToken: '1'.repeat(64), machineTokens: { aws2: '2'.repeat(64) }, kubectl,
        fetch, now, prepareLockDirectory: join(root, 'prepare-locks'), prepareFlock: () => 0,
        rotationStatePath: join(root, 'rotation-state.json'),
        phaseFenceStatePath: join(root, 'phase-fence'),
        phasePrewarmForTest: { gateIdentity: { cutSha, lockHash },
          targets: { 'cut-gate': { gate: 1, implementation: 0 } } },
        releaseSchedulesForTest: [{ version: '0.3.8', cutAt: new Date(nowBase + 20 * 60_000).toISOString(),
          publishAt: new Date(nowBase + 90 * 60_000).toISOString(), landBy: null, updatedAt: '', updatedBy: '' }],
        transport: () => ({ request: async command => {
          firstGateTransportCalls++;
          return { status: 'observed', reason: 'complete', reply: {
            protocol: 1, runId: command.runId, attemptId: command.attemptId, cutSha: command.cutSha,
            leaseId: command.leaseId, generation: command.generation, workerId: command.workerId,
            key: command.key, envProfile: command.envProfile, startedAt: now(), finishedAt: now(),
            files: command.files.map(file => ({ file, rc: 0, failureIds: [], errorIds: [], junitComplete: true })),
            resetReceipt: { baseImageDigest: command.baseImageDigest ?? command.key.imageDigest,
              resetMethod: 'git-reset-clean-status-v1', postRunDiff: [] },
          } };
        } }),
      });
      const reconcile = await provider.reconcilePool();
      expect(reconcile.failed, JSON.stringify({ reconcile, prepareDecision, phaseObservation })).toEqual([]);
      expect(reconcile).toMatchObject({ target: 1, ready: 1 });
      expect(phaseObservation).toMatchObject({ phase: 'cut-gate', target: { gate: 1, implementation: 0 },
        actual: { gate: 1, implementation: 0 }, prewarmMs: expect.any(Number) });
      const warmHit = await provider.request({ protocol: 1, runId: 'phase-prewarm-run', attemptId: 'gate-first-request',
        cutSha, deadlineAt: nowBase + 60_000, files: ['src/example/gate.test.ts'], envProfile: 'gate-v1' }, {
        kind: 'gate', lockHash, imageDigest: key.imageDigest, runtimeContract: spec.runtimeContract,
        runtimeIdentity: { baseImageDigest: key.imageDigest, lockHash, os: 'linux', architecture: 'amd64', bunVersion: '1.4.2' },
      });
      expect(warmHit).toMatchObject({ command: { workerId: spec.workerId, podUid },
        transport: { status: 'observed', reason: 'complete' } });
      expect(firstGateTransportCalls).toBe(1);
    } finally {
      phaseLog.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
