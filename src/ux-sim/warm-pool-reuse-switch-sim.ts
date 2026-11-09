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
        key: command.key, envProfile: command.envProfile, startedAt: now, finishedAt: now + 1, files,
        resetReceipt: { baseImageDigest: command.baseImageDigest ?? key.imageDigest,
          resetMethod: "git-reset-clean-status-v1", postRunDiff: [] } };
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

/** Inject a valid-but-dirty reset receipt, then prove only a new Pod incarnation can be reused. */
export async function runWarmResetReceiptReplacementSimulation(runId = `warm-reset-replacement-${Date.now()}`) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'warm-reset-replacement-sim-'));
  const replacementSpec: WarmPodSpec = { ...spec, name: 'warm-pool-host-a-standard-2',
    workerId: 'warm-pool-host-a-standard-2-generation-1' };
  const candidates: WarmWorkerCandidate[] = [
    { host, tier: 'standard', spec: { ...spec } },
    { host, tier: 'standard', spec: replacementSpec },
  ];
  const kubernetes = createFakeKubectl({ context: spec.kubectlContext, node: spec.nodeName!,
    podReadinessOnCreate: true, uniquePodUids: true });
  const primary = await createFakePrimaryControl();
  const kubernetesFetch = (podName: string): typeof fetch => Object.assign(
    async (_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const uid = (JSON.parse(String(init?.body ?? '{}')) as { preconditions?: { uid?: string } }).preconditions?.uid ?? '';
      return new Response('{}', { status: kubernetes.deletePod(podName, uid) ? 200 : 409 });
    },
    { preconnect: () => { throw new Error('fake Kubernetes fetch: preconnect is blocked'); } },
  );
  let injectDirtyReceipt = true;
  const provider = new WarmPodProvider({ candidates, controlUrl: primary.url,
    memberToken: primary.memberToken, machineTokens: { [host]: primary.machineTokens[host] },
    profileConfig: { pod: { warmPoolProfile: 'gate' } }, kubectl: kubernetes.kubectl,
    kubectlProxyUrlForTest: 'http://127.0.0.1:1',
    kubernetesFetch: kubernetesFetch(spec.name),
    fetch: primary.fetch, prepareLockDirectory: stateRoot, rotationStatePath: join(stateRoot, 'rotations.json'),
    quotaResolverForTest: () => 2,
    transport: () => ({ request: async (command) => {
      const dirty = injectDirtyReceipt;
      injectDirtyReceipt = false;
      const now = Date.now();
      const files: WarmWorkerFileResult[] = command.files.map((file) => ({ file, rc: 0,
        failureIds: [], errorIds: [], junitComplete: true }));
      const reply: WarmWorkerReply = { protocol: 1, runId: command.runId, attemptId: command.attemptId,
        cutSha: command.cutSha, ...(command.baselineSha ? { baselineSha: command.baselineSha } : {}),
        leaseId: command.leaseId, generation: command.generation, workerId: command.workerId,
        key: command.key, envProfile: command.envProfile, startedAt: now, finishedAt: now + 1, files,
        resetReceipt: { baseImageDigest: command.baseImageDigest ?? runtimeContract.baseImageDigest,
          resetMethod: 'git-reset-clean-status-v1', postRunDiff: dirty ? ['src/dirty.fixture'] : [] } };
      return { status: 'observed', reason: 'complete', reply };
    } }),
  });
  try {
    const initial = await provider.reconcilePool();
    if (initial.ready !== 2 || initial.failed.length) throw new Error('initial warm Pods did not become ready');
    const selection = { kind: 'gate' as const, lockHash: key.lockHash, imageDigest: key.imageDigest,
      runtimeContract, runtimeIdentity };
    const request = (suffix: string) => ({ protocol: 1 as const, runId: `${runId}-${suffix}`,
      attemptId: `${runId}-${suffix}-attempt`, cutSha: spec.cutSha, deadlineAt: Date.now() + 60_000,
      files: ['src/ux-sim/warm-pool-reuse-evidence-sim.test.ts'], envProfile: 'gate-v1' });
    const contaminated = await requestWarmPodReplay(request('dirty'), provider, selection);
    if (!contaminated.command || contaminated.transport.status !== 'fallback' || contaminated.transport.reason !== 'exec-failed')
      throw new Error('dirty reset receipt was not refused');
    const quarantined = primary.requests.some((row) => row.path.endsWith('/quarantine') && row.status === 200);
    if (!quarantined) throw new Error('dirty Pod was not quarantined');

    const replacementProvider = new WarmPodProvider({ candidates: [candidates[1]!], controlUrl: primary.url,
      memberToken: primary.memberToken, machineTokens: { [host]: primary.machineTokens[host] },
      profileConfig: { pod: { warmPoolProfile: 'gate' } }, kubectl: kubernetes.kubectl,
      kubectlProxyUrlForTest: 'http://127.0.0.1:1',
      kubernetesFetch: kubernetesFetch(replacementSpec.name),
      fetch: primary.fetch, prepareLockDirectory: stateRoot, rotationStatePath: join(stateRoot, 'rotations.json'),
      quotaResolverForTest: () => 2,
      transport: () => ({ request: async (command) => {
        const now = Date.now();
        const files: WarmWorkerFileResult[] = command.files.map((file) => ({ file, rc: 0,
          failureIds: [], errorIds: [], junitComplete: true }));
        const reply: WarmWorkerReply = { protocol: 1, runId: command.runId, attemptId: command.attemptId,
          cutSha: command.cutSha, ...(command.baselineSha ? { baselineSha: command.baselineSha } : {}),
          leaseId: command.leaseId, generation: command.generation, workerId: command.workerId,
          key: command.key, envProfile: command.envProfile, startedAt: now, finishedAt: now + 1, files,
          resetReceipt: { baseImageDigest: command.baseImageDigest ?? runtimeContract.baseImageDigest,
            resetMethod: 'git-reset-clean-status-v1', postRunDiff: [] } };
        return { status: 'observed', reason: 'complete', reply };
      } }),
    });
    const replacementReady = await replacementProvider.reconcilePool();
    if (replacementReady.ready !== 1 || replacementReady.failed.length)
      throw new Error(`replacement provider did not adopt the clean worker: ${JSON.stringify(replacementReady)}`);
    const clean = await requestWarmPodReplay(request('clean'), replacementProvider, selection);
    if (!clean.command || clean.command.workerId === contaminated.command.workerId
      || clean.command.podUid === contaminated.command.podUid
      || clean.transport.status !== 'observed' || clean.transport.reason !== 'complete')
      throw new Error('replacement Pod did not accept a clean receipt');
    const receipt = (clean.transport.reply as WarmWorkerReply | null)?.resetReceipt;
    if (!receipt || receipt.baseImageDigest !== runtimeContract.baseImageDigest
      || receipt.resetMethod !== 'git-reset-clean-status-v1' || receipt.postRunDiff.length !== 0)
      throw new Error('replacement receipt fields are incomplete or dirty');
    await replacementProvider.finalize(clean.command);
    return { dirtyReceiptQuarantined: quarantined,
      originalPodUid: contaminated.command.podUid, replacementPodUid: clean.command.podUid,
      originalWorkerId: contaminated.command.workerId, replacementWorkerId: clean.command.workerId,
      replacementReady: replacementReady.ready, receipt };
  } finally {
    primary.stop();
    rmSync(stateRoot, { recursive: true, force: true });
  }
}
