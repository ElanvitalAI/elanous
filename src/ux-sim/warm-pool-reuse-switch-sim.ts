import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessWarmWorkerShadow, type WarmWorkerFileResult, type WarmWorkerReply } from '../task-orchestrator/surfaces/pod-warm-worker-protocol.js';
import { WarmPodProvider, requestWarmPodReplay, type WarmWorkerCandidate } from '../task-orchestrator/surfaces/pod-warm-worker-provider.js';
import { type WarmPodSpec } from '../task-orchestrator/surfaces/pod-warm-worker-pod.js';
import { loadWarmReuseEvidenceByConsumer, recordWarmReuseComparison,
  type WarmReuseEvidenceConsumer } from '../task-orchestrator/surfaces/warm-reuse-evidence.js';
import { createFakeKubectl } from './fake-kubectl.js';
import { createFakePrimaryControl } from './warm-pool-reuse-sim.js';

const host = 'pool-host-a';
const key = { context: 'pool-host-a-context', imageDigest: `sha256:${'d'.repeat(64)}`,
  lockHash: 'e'.repeat(64), architecture: 'amd64' };
const runtimeContract = { baseImageDigest: `sha256:${'a'.repeat(64)}`, bunVersion: Bun.version,
  os: 'linux' as const, architecture: 'amd64', requiredTools: ['bun', 'git'] };
const runtimeIdentity = { baseImageDigest: runtimeContract.baseImageDigest, lockHash: key.lockHash,
  os: 'linux' as const, architecture: 'amd64', bunVersion: Bun.version };
const spec: WarmPodSpec = { name: 'warm-pool-host-a-standard-1', namespace: 'elanous-test',
  kubectlContext: key.context, workerId: 'warm-pool-host-a-standard-1-generation-1',
  image: `registry.example/elanous@${key.imageDigest}`,
  sourceUrl: 'https://github.com/ElanvitalAI/elanous.git', cutSha: 'f'.repeat(40), key, runtimeContract,
  memoryLimit: '16Gi', nodeName: 'pool-host-a-server-0',
  hostProbeUrl: 'http://host.orb.internal:10001/health', prodProbeUrl: 'http://core.elanous-prod:10002/' };

/** One real provider lease through fake Kubernetes/control/worker boundaries and the production evidence journal. */
export async function runWarmPoolReuseSwitchSimulation(input: {
  consumer: WarmReuseEvidenceConsumer; runId: string; head: string; main: string; evidencePath: string;
}) {
  const candidate: WarmWorkerCandidate = { host, tier: 'standard', spec };
  const kubernetes = createFakeKubectl({ context: spec.kubectlContext, node: spec.nodeName!, podReadinessOnCreate: true });
  const primary = await createFakePrimaryControl();
  const prepareLockDirectory = mkdtempSync(join(tmpdir(), 'warm-reuse-switch-sim-'));
  const provider = new WarmPodProvider({ candidates: [candidate], controlUrl: primary.url,
    memberToken: primary.memberToken, machineTokens: { [host]: primary.machineTokens[host] },
    profileConfig: { pod: { warmPoolProfile: 'gate' } }, kubectl: kubernetes.kubectl,
    fetch: primary.fetch, prepareLockDirectory, rotationStatePath: join(prepareLockDirectory, 'rotations.json'),
    quotaResolverForTest: () => 1,
    transport: () => ({ request: async (command) => {
      const now = Date.now();
      const files: WarmWorkerFileResult[] = command.files.map((file) => ({ file, rc: 0,
        failureIds: [], errorIds: [], junitComplete: true }));
      const reply: WarmWorkerReply = { protocol: 1, runId: command.runId, attemptId: command.attemptId,
        cutSha: command.cutSha, ...(command.baselineSha ? { baselineSha: command.baselineSha } : {}),
        leaseId: command.leaseId, generation: command.generation, workerId: command.workerId,
        key: command.key, envProfile: command.envProfile, startedAt: now, finishedAt: now + 1, files };
      return { status: 'observed', reason: 'complete', reply };
    } }),
  });
  try {
    const reconciled = await provider.reconcilePool();
    if (reconciled.ready !== 1 || reconciled.failed.length) throw new Error('sim warm worker did not reconcile ready');
    const replay = await requestWarmPodReplay({ protocol: 1, runId: input.runId, attemptId: `${input.runId}-attempt`,
      cutSha: spec.cutSha, baselineSha: spec.cutSha, deadlineAt: Date.now() + 60_000,
      files: ['src/ux-sim/warm-pool-reuse-switch-sim.test.ts'], envProfile: 'gate-v1' }, provider,
    { kind: 'gate', lockHash: key.lockHash, imageDigest: key.imageDigest, runtimeContract, runtimeIdentity });
    const command = replay.command;
    const reply = replay.transport.reply;
    if (!command || replay.transport.status !== 'observed' || replay.transport.reason !== 'complete' || !reply)
      throw new Error('sim did not return a complete warm lease');

    // This is the fake fresh-Job edge. The real production comparator decides whether the two results agree.
    const fresh: WarmWorkerFileResult[] = command.files.map((file) => ({ file, rc: 0,
      failureIds: [], errorIds: [], junitComplete: true }));
    const comparison = assessWarmWorkerShadow(command, fresh, reply);
    if (comparison.reason !== 'match') throw new Error(`warm/fresh comparison did not match: ${comparison.reason}`);
    await provider.finalize(command);
    const finalized = primary.requests.some((request) => request.path === `/v1/leases/pod-worker/${command.workerId}/release` && request.status === 200)
      && primary.requests.some((request) => request.path === `/v1/leases/pod-worker/${command.workerId}/sanitize` && request.status === 200);
    const lease = { workerId: command.workerId, leaseId: command.leaseId, generation: command.generation,
      expectedLockHash: command.key.lockHash, workerLockHash: reply.key.lockHash,
      leaseValid: finalized && !!command.workerId && !!command.leaseId && command.generation > 0,
      canaryPassed: comparison.reason === 'match' && finalized, agree: comparison.reason === 'match' };
    recordWarmReuseComparison({ consumer: input.consumer, head: input.head, main: input.main,
      lease, comparison, finalized }, input.evidencePath);
    const supplied = loadWarmReuseEvidenceByConsumer({ head: input.head, main: input.main }, input.evidencePath);
    return { comparison, finalized, supplied: supplied?.[input.consumer] };
  } finally {
    primary.stop();
    rmSync(prepareLockDirectory, { recursive: true, force: true });
  }
}
