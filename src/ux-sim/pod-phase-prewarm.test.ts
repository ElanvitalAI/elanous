import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WarmPodProvider, type WarmPodProviderOptions, type WarmWorkerCandidate } from '../task-orchestrator/surfaces/pod-warm-worker-provider.js';
import { warmWorkerPodManifest, type WarmPodSpec } from '../task-orchestrator/surfaces/pod-warm-worker-pod.js';
import type { WarmWorkerCommand } from '../task-orchestrator/surfaces/pod-warm-worker-protocol.js';
import type { WarmPodPhaseSchedule } from '../task-orchestrator/surfaces/pod-warm-switch.js';
import { resolveWarmPoolQuota } from '../self-implement/pod-warm-pool-profile.js';
import { simulatePodPhasePrewarm } from './pod-phase-prewarm.js';

const gateStart = 20_000_000;
const cutSha = 'a'.repeat(40), lockHash = 'b'.repeat(64), imageDigest = `sha256:${'c'.repeat(64)}`;
const schedule: WarmPodPhaseSchedule = { measuredPrepareDurationMs: 5 * 60_000, steadyTargets: { gate: 1, implementation: 3 },
  windows: [{ phase: 'gate', startAtMs: gateStart, endAtMs: gateStart + 45 * 60_000, targets: { gate: 1, implementation: 0 },
    cutSha, lockHash, imageDigest }] };
const runtimeContract = { baseImageDigest: `sha256:${'f'.repeat(64)}`, bunVersion: '1.4.2', os: 'linux' as const,
  architecture: 'amd64', requiredTools: ['bun', 'git'] };
const key = { context: 'pool-test-host', imageDigest, lockHash, architecture: 'amd64' };
const spec: WarmPodSpec = { name: 'warm-test-host-standard-1', namespace: 'elanous-test', kubectlContext: 'k3d-test-host',
  workerId: 'warm-test-host-standard-1-uid', image: `registry.example/elanous@${imageDigest}`,
  sourceUrl: 'https://github.com/ElanvitalAI/elanous.git', cutSha, key, runtimeContract, memoryLimit: '16Gi',
  nodeName: 'pool-test-host-server-0', hostProbeUrl: 'http://host.orb.internal:10001/health',
  prodProbeUrl: 'http://core.elanous-prod:10002/' };
const candidate: WarmWorkerCandidate = { host: 'test-host', tier: 'standard', kind: 'gate', spec };
const completeReply = (command: WarmWorkerCommand, nowMs: number) => ({
  protocol: 1 as const, runId: command.runId, attemptId: command.attemptId, cutSha: command.cutSha,
  ...(command.baselineSha ? { baselineSha: command.baselineSha } : {}), leaseId: command.leaseId,
  generation: command.generation, workerId: command.workerId, key: command.key, envProfile: command.envProfile,
  startedAt: nowMs, finishedAt: nowMs,
  files: command.files.map(file => ({ file, rc: 0, failureIds: [], errorIds: [], junitComplete: true })),
  resetReceipt: { baseImageDigest: command.baseImageDigest ?? command.key.imageDigest,
    resetMethod: 'git-reset-clean-status-v1' as const, postRunDiff: [] as string[] },
});
const quotaResolverForTest: typeof resolveWarmPoolQuota = (profile, host, tier) =>
  host === 'test-host' ? tier === 'standard' ? 4 : 0 : resolveWarmPoolQuota(profile, host, tier);

test('POD-PHASE-PREWARM · actual provider reconcile and first request use the pinned Pod', async () => {
  let nowMs = gateStart - 35 * 60_000;
  let measuredAtMs = 1_000;
  const measureNow = () => { const measured = measuredAtMs; measuredAtMs += 7; return measured; };
  const manifest = warmWorkerPodManifest(spec) as any;
  const pod = { ...manifest, metadata: { ...manifest.metadata, uid: 'pod-uid-1', resourceVersion: '1' },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
  const verbs: string[] = [], leaseRequests: string[] = [];
  const lockDirectory = mkdtempSync(join(tmpdir(), 'pod-phase-prewarm-'));
  const providerOptions: WarmPodProviderOptions = { candidates: [candidate], profileConfig: { pod: { warmPoolProfile: 'gate' } },
    phaseSchedule: schedule, now: () => nowMs, quotaResolverForTest, controlUrl: 'http://127.0.0.1:31413/',
    memberToken: '1'.repeat(64), machineTokens: { 'test-host': '2'.repeat(64) }, prepareLockDirectory: lockDirectory, rotationStatePath: join(lockDirectory, 'rotation.json'), prepareFlock: () => 0,
    kubectl: args => {
      const verb = args[4]; verbs.push(verb ?? '');
      if (args[0] === 'config' || verb === 'config') return { status: 0, stdout: 'k3d-test-host\n', stderr: '' };
      if (verb === 'get' && args[5] === 'pods') return { status: 0,
        stdout: JSON.stringify({ metadata: { continue: '' }, items: [pod] }), stderr: '' };
      if (verb === 'get' && (args[5] === 'pod' || args[5]?.startsWith('pod/'))) return { status: 0, stdout: JSON.stringify(pod), stderr: '' };
      if (verb === 'patch') {
        const patch = JSON.parse(args[args.indexOf('-p') + 1]);
        pod.metadata.labels = patch[2].value; pod.metadata.annotations = patch[3].value;
        pod.metadata.resourceVersion = String(Number(pod.metadata.resourceVersion) + 1);
        return { status: 0, stdout: JSON.stringify(pod), stderr: '' };
      }
      if (verb === 'exec') return { status: 0, stdout: JSON.stringify({ bunVersion: '1.4.2', os: 'linux',
        architecture: 'amd64', tools: { bun: true, git: true } }), stderr: '' };
      return { status: 0, stdout: '{}', stderr: '' };
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/leases/pod-worker') {
        const body = JSON.parse(String(init?.body)); leaseRequests.push(body.machine);
        return Response.json({ name: spec.workerId, attrs: { key, leaseId: 'lease-1', generation: 1,
          podUid: 'pod-uid-1', state: 'leased' } });
      }
      if (path.startsWith('/v1/resources')) return Response.json({ resources: [{ kind: 'pod-worker-lease', machine: 'test-host', name: spec.workerId, observedAt: nowMs - 1_000, ttlMs: 1_800_000, attrs: { state: 'idle', podUid: 'pod-uid-1', idleTtlMs: 1_800_000, key } }] });
      return Response.json({});
    },
    transport: () => ({ request: async command => ({ status: 'observed' as const, reason: 'complete' as const, reply: completeReply(command, nowMs) }) }),
  };
  const provider = new WarmPodProvider(providerOptions);
  try {
    const observations = await simulatePodPhasePrewarm({ schedule, provider, setNow: value => { nowMs = value; }, measureNow, steps: [
      { atMs: gateStart - 35 * 60_000, type: 'reconcile' },
      { atMs: gateStart, type: 'gate-request', input: { protocol: 1, runId: 'run-1', attemptId: 'attempt-1',
        cutSha, deadlineAt: gateStart + 60_000, files: ['src/example/worker.test.ts'], envProfile: 'gate-v1' },
        selection: { kind: 'gate', lockHash, imageDigest, runtimeContract,
          runtimeIdentity: { baseImageDigest: runtimeContract.baseImageDigest, lockHash, os: 'linux',
            architecture: 'amd64', bunVersion: '1.4.2' } } },
    ] });
    expect(observations[0]).toMatchObject({ phase: 'gate-prewarm', target: 1, actual: 1, prewarmDurationMs: 7 });
    expect(observations[1]).toMatchObject({ phase: 'gate', firstGateRequestWarmHit: true, actual: 1 });
    expect(verbs).toContain('get');
    expect(leaseRequests).toEqual(['test-host']);
  } finally { rmSync(lockDirectory, { recursive: true, force: true }); }
});
