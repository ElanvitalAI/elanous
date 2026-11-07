import { warmWorkerPodManifest, type WarmPodSpec } from '../task-orchestrator/surfaces/pod-warm-worker-pod.js';
import { cleanAndReturnChildPod } from '../task-orchestrator/surfaces/pod-child-reuse.js';
import { measurePoolLease, recommendConcurrency } from '../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool } from '../task-orchestrator/surfaces/pod-pool.js';
import { SiWarmPodProvider } from '../task-orchestrator/surfaces/pod-si-warm-provider.js';
import { executeSiWarmTransport } from '../task-orchestrator/surfaces/pod-si-warm-transport.js';
import { siWarmSha256, type SiWarmCommand } from '../task-orchestrator/surfaces/pod-si-warm-protocol.js';
import { appendRunLedgerEntry, runLedgerDir, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import { debug } from '../debug/log.js';
import { createFakeKubectl } from './fake-kubectl.js';
import { createFakePrimaryControl } from './warm-pool-reuse-sim.js';
import type { PodReuseSharedFakeBoundary } from './pod-reuse-shared-fake-boundary.js';
import type { PodReuseResidueFaultFixture } from './fault-pod-reuse-residue.js';

const key = { context: 'pool-host-a-context', imageDigest: `sha256:${'d'.repeat(64)}`,
  lockHash: 'e'.repeat(64), architecture: 'amd64' };
type WarmPoolHost = 'pool-host-a' | 'pool-host-b';
const spec: WarmPodSpec = { name: 'warm-pool-host-a-si-1', namespace: 'elanous-test',
  kubectlContext: key.context, workerId: 'warm-pool-host-a-si-1-generation-1',
  image: `registry.example/elanous@${key.imageDigest}`,
  sourceUrl: 'https://github.com/ElanvitalAI/elanous.git', cutSha: 'f'.repeat(40), key,
  memoryLimit: '16Gi', nodeName: 'pool-host-a-server-0',
  hostProbeUrl: 'http://host.orb.internal:10001/health', prodProbeUrl: 'http://core.elanous-prod:10002/' };

export interface WarmSiReuseEvidence {
  runId: string;
  coldAdmission: ReturnType<typeof recommendConcurrency> | null;
  leaseGenerations: number[];
  podUids: string[];
  leaseHosts: string[];
  leaseArchitectures: string[];
  recoveryHost: string | null;
  cleanupOutcomes: Array<'returned' | 'quarantined'>;
  controlTransitions: string[];
  cleanupObservations: string[];
  ledgerRows: RunLedgerEntry[];
  retryAcquire: string;
  finalPodState: string | undefined;
  artifactCapRejected: boolean;
  artifactDecodeCalls: number;
  residueAtReturn: Array<ReturnType<PodReuseResidueFaultFixture['residue']>>;
  liveChildPidsAtReturn: number[][];
}

/**
 * Runs the production SI admission and child-return chain. Only the Kubernetes,
 * fixed-runner maintenance, and isolated primary-control boundaries are simulated.
 * `exhaustColdJobSlots` seeds a Running cold-slot occupant Pod into this same Kubernetes boundary,
 * measures it through production pool admission, then runs the warm lease path against that state.
 */
export async function runWarmSiReuseSimulation(options: { runId: string; processResidue?: number; now?: () => number;
  exhaustColdJobSlots?: boolean;
  stateRoot?: string; ledgerRunId?: string; ledgerRowPrefix?: string; residueFixture?: PodReuseResidueFaultFixture;
  cleanResidueForReuse?: boolean;
  includeAlternateHost?: boolean; recoverOnAlternateHost?: boolean; hostAvailable?: (host: string) => boolean;
  hostArchitectures?: Readonly<Record<WarmPoolHost, 'arm64' | 'amd64'>>;
  afterAcquireAtLease?: number | 'each'; afterAcquire?: (host: string, leaseIndex: number) => Promise<void>;
  stopLiveChildProcesses?: () => Promise<number>;
  readLiveChildProcessPids?: () => readonly number[];
  injectOversizedArtifact?: boolean; boundary?: PodReuseSharedFakeBoundary }) {
  const now = options.now ?? (() => 0);
  const fixtureSourceSha = options.cleanResidueForReuse && options.residueFixture
    ? options.residueFixture.remote.git(options.residueFixture.remote.checkout, ['rev-parse', 'HEAD']).trim()
    : undefined;
  const specA: WarmPodSpec = { ...spec, cutSha: fixtureSourceSha ?? spec.cutSha,
    key: { ...key, architecture: options.hostArchitectures?.['pool-host-a'] ?? key.architecture } };
  const specB: WarmPodSpec = { ...specA, name: 'warm-pool-host-b-si-1', workerId: 'warm-pool-host-b-si-1-generation-1',
    kubectlContext: 'pool-host-b-context', nodeName: 'pool-host-b-server-0',
    key: { ...specA.key, context: 'pool-host-b-context', architecture: options.hostArchitectures?.['pool-host-b'] ?? 'arm64' } };
  const candidates: Array<{ host: WarmPoolHost; tier: 'standard'; spec: WarmPodSpec }> = options.includeAlternateHost
    ? [{ host: 'pool-host-a', tier: 'standard' as const, spec: specA }, { host: 'pool-host-b', tier: 'standard' as const, spec: specB }]
    : [{ host: 'pool-host-a', tier: 'standard' as const, spec: specA }];
  const kubernetes = options.boundary?.kubernetes ?? new Map(candidates.map(({ spec: candidateSpec }) => {
    const device = createFakeKubectl({ context: candidateSpec.kubectlContext, node: candidateSpec.nodeName!, podReadinessOnCreate: true });
    return [candidateSpec.kubectlContext, device] as const;
  }));
  for (const { spec: candidateSpec } of candidates) {
    const device = kubernetes.get(candidateSpec.kubectlContext);
    if (!device) throw new Error(`shared SI simulation boundary has no Kubernetes context: ${candidateSpec.kubectlContext}`);
    const manifest = warmWorkerPodManifest(candidateSpec) as Record<string, any>;
    const seeded = device.getPod(candidateSpec.name);
    manifest.metadata.uid = seeded?.metadata.uid ?? (candidateSpec.kubectlContext === specA.kubectlContext ? 'si-warm-pod-uid-1' : 'si-warm-pod-uid-2');
    manifest.metadata.resourceVersion = '1';
    manifest.status = { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] };
    if (!seeded) device.putPod(manifest);
  }
  if (options.exhaustColdJobSlots) {
    const device = kubernetes.get(specA.kubectlContext)!;
    device.putPod({ apiVersion: 'v1', kind: 'Pod', metadata: { namespace: specA.namespace,
      name: 'cold-job-slot-occupant', labels: { 'elanous.substrate': 'pod', 'elanous.job': 'cold-job-slot-occupant' } },
    status: { phase: 'Running' }, spec: { nodeName: specA.nodeName,
      containers: [{ name: 'harness', resources: { requests: { cpu: '250m', memory: '1Gi' }, limits: { memory: '1Gi' } } }] } });
  }
  const kubectl = options.boundary?.kubectl ?? ((argv: readonly string[], input?: string) => {
    const contextIndex = argv.indexOf('--context');
    const context = contextIndex >= 0 ? argv[contextIndex + 1] : undefined;
    const device = context ? kubernetes.get(context) : undefined;
    return device ? device.kubectl(argv, input) : { status: 1, stdout: '', stderr: `unknown SI simulation context: ${context ?? '(missing)'}` };
  });

  const primary = options.boundary?.primary ?? await createFakePrimaryControl();
  const ownsPrimary = !options.boundary;
  let oversizedRunnerCommand: SiWarmCommand | undefined;
  let artifactDecodeCalls = 0;
  for (const candidate of candidates) {
    const host = candidate.host;
    const registered = await primary.fetch(new URL('/v1/workers/pod', primary.url), {
      method: 'POST', headers: { authorization: `Bearer ${primary.machineTokens[host]}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: candidate.spec.workerId, machine: host,
        podUid: candidate.spec.kubectlContext === specA.kubectlContext ? 'si-warm-pod-uid-1' : 'si-warm-pod-uid-2',
        key: candidate.spec.key, ttlMs: 300_000 }),
    });
    if (registered.status !== 200) {
      if (ownsPrimary) primary.stop();
      throw new Error(`fake primary worker registration failed: ${host}/${registered.status}`);
    }
  }

  const cleanupObservations: string[] = [];
  const ledgerRows: RunLedgerEntry[] = [];
  const residueAtReturn: Array<ReturnType<PodReuseResidueFaultFixture['residue']>> = [];
  const liveChildPidsAtReturn: number[][] = [];
  let ledgerRowSequence = 0;
  const observe = (event: string, data: Record<string, unknown>) => {
    cleanupObservations.push(event);
    if (event === 'return-decision' && data.outcome === 'eligible') {
      if (options.residueFixture) residueAtReturn.push(options.residueFixture.residue());
      if (options.readLiveChildProcessPids) liveChildPidsAtReturn.push([...options.readLiveChildProcessPids()]);
    }
    debug.log('pod.reuse', event, data, {
      level: event === 'return-decision' && (data.outcome === 'eligible' || data.outcome === 'returned') ? 'info' : 'warn',
    });
    if (!options.stateRoot) return;
    const row: RunLedgerEntry = { runId: options.ledgerRunId ?? options.runId, event: `pod.reuse.${event}`,
      data: { ...data, injectionRowId: `${options.ledgerRowPrefix ?? options.runId}:${++ledgerRowSequence}` },
      timestamp: new Date(now()).toISOString() };
    appendRunLedgerEntry(row, runLedgerDir(options.stateRoot));
    ledgerRows.push(row);
  };
  let activeCommand: SiWarmCommand | undefined;
  const provider = new SiWarmPodProvider({ candidates,
    controlUrl: primary.url, memberToken: primary.memberToken, machineTokens: primary.machineTokens,
    kubectl, fetch: primary.fetch, now,
    siRunnerReady: candidateSpec => options.hostAvailable?.(candidateSpec.kubectlContext === specA.kubectlContext ? 'pool-host-a' : 'pool-host-b') ?? true,
    observe: (event, data) => observe(event, data),
    decodeArtifactForTest: options.injectOversizedArtifact ? encoded => {
      artifactDecodeCalls++;
      return Buffer.from(encoded, 'base64');
    } : undefined,
    exec: async argv => {
      const operation = argv.at(-1);
      const contextIndex = argv.indexOf('--context');
      const host: WarmPoolHost = contextIndex >= 0 && argv[contextIndex + 1] === specB.kubectlContext
        ? 'pool-host-b' : 'pool-host-a';
      if (options.hostAvailable && !options.hostAvailable(host)) return { status: 1,
        stdout: new TextEncoder().encode('{"status":1,"stdout":"host unavailable"}') };
      if (operation === '/workspace/repo/src/task-orchestrator/surfaces/pod-si-warm-runner.ts'
        && options.injectOversizedArtifact) {
        const oversized = 'A'.repeat(Math.ceil((5 * 1024 * 1024 + 1) / 3) * 4);
        const command = oversizedRunnerCommand!;
        const terminal = new TextEncoder().encode('{"ok":true,"stage":"done"}');
        const ledger = new TextEncoder().encode('{"event":"done"}\n');
        const log = new TextEncoder().encode('done\n');
        return { status: 0, stdout: new TextEncoder().encode(JSON.stringify({
          reply: { protocol: 'si-v1', runId: command.runId, attemptId: command.attemptId,
            executionKey: command.executionKey, sourceSha: command.sourceSha, leaseId: command.leaseId,
            generation: command.generation, workerId: command.workerId, podUid: command.podUid,
            key: command.key, envProfile: command.envProfile, payloadSha256: command.payloadSha256,
            startedAt: 1, finishedAt: 2, exitCode: 0, terminalSha256: siWarmSha256(terminal),
            ledgerSha256: siWarmSha256(ledger), logSha256: siWarmSha256(log),
            artifacts: [{ path: 'oversized.bin', sha256: 'a'.repeat(64), bytes: 5 * 1024 * 1024 + 1 }] },
          bytes: { terminal: Buffer.from(terminal).toString('base64'), ledger: Buffer.from(ledger).toString('base64'),
            log: Buffer.from(log).toString('base64'), artifacts: [{ path: 'oversized.bin', bytes: oversized }] },
        })) };
      }
      if (operation === '--stop') {
        const liveRemaining = host === 'pool-host-a' && options.cleanResidueForReuse
          ? await options.stopLiveChildProcesses?.() ?? 0 : 0;
        if (host === 'pool-host-a' && options.cleanResidueForReuse) options.residueFixture?.processes.killHost('worker-1');
        return { status: 0, stdout: new TextEncoder().encode(JSON.stringify({
          remaining: host === 'pool-host-a' && options.residueFixture && options.cleanResidueForReuse
            ? options.residueFixture.residue().processes.length + liveRemaining
            : host === 'pool-host-a' && options.residueFixture
              ? options.residueFixture.residue().processes.length
              : host === 'pool-host-a' ? options.processResidue ?? liveRemaining : 0 })) };
      }
      if (operation === '--revoke') {
        const remaining = host === 'pool-host-a' ? options.residueFixture?.revokeCredentials() ?? 0 : 0;
        return { status: 0, stdout: new TextEncoder().encode(JSON.stringify({ remaining })) };
      }
      if (operation === '--git-status') return { status: 0, stdout: new TextEncoder().encode(JSON.stringify({
        status: 0, stdout: host === 'pool-host-a' ? options.residueFixture?.residue().gitStatus ?? '' : '' })) };
      if (operation === '--git-reset' || operation === '--git-clean') {
        if (host !== 'pool-host-a' || !options.residueFixture || !options.cleanResidueForReuse) return { status: 0,
          stdout: new TextEncoder().encode('{"status":0,"stdout":""}') };
        try {
          const args = operation === '--git-reset'
            ? ['reset', '--hard', activeCommand?.sourceSha ?? '']
            : ['clean', '-ffdx', '-e', 'node_modules', '-e', 'apps/pwa/node_modules', '-e', '*.tsbuildinfo'];
          options.residueFixture.remote.git(options.residueFixture.remote.checkout, args);
          return { status: 0, stdout: new TextEncoder().encode('{"status":0,"stdout":""}') };
        } catch {
          return { status: 0, stdout: new TextEncoder().encode('{"status":1,"stdout":""}') };
        }
      }
      throw new Error(`unexpected simulated runner operation: ${String(operation)}`);
    },
  });
  const coldLeaseMeasure = options.exhaustColdJobSlots
    ? measurePoolLease(parsePodPool(`${specA.kubectlContext}:1`), { kubectl, dns: () => 'ready', skipDnsProbe: true })
    : null;
  const evidence: WarmSiReuseEvidence = { runId: options.runId,
    coldAdmission: coldLeaseMeasure ? recommendConcurrency(coldLeaseMeasure,
      { capacity: 1, perGoalMemory: '1Gi', accounts: 1, perAccount: 1 }) : null,
    leaseGenerations: [], podUids: [],
    leaseHosts: [], leaseArchitectures: [], recoveryHost: null, cleanupOutcomes: [], controlTransitions: [], cleanupObservations, ledgerRows,
    retryAcquire: 'not-attempted', finalPodState: undefined, artifactCapRejected: false, artifactDecodeCalls: 0,
    residueAtReturn, liveChildPidsAtReturn };
  try {
    const count = options.processResidue ? 1 : 2;
    for (let index = 1; index <= count; index++) {
      const sourceSha = options.cleanResidueForReuse && options.residueFixture
        ? options.residueFixture.remote.git(options.residueFixture.remote.checkout, ['rev-parse', 'HEAD']).trim()
        : specA.cutSha;
      const acquired = await provider.acquire({ runId: `${options.runId}-${index}`, attemptId: `attempt-${index}`,
        executionKey: 'a'.repeat(64), sourceSha, deadlineAt: now() + 60_000,
        payload: new TextEncoder().encode('simulated SI payload'),
        credentialBundle: new TextEncoder().encode('simulated credential bundle'), adopt: async () => {} });
      if (acquired.status !== 'acquired') throw new Error(`SI lease acquisition failed: ${acquired.status}/${acquired.reason}`);
      const command = acquired.attempt.command!;
      activeCommand = command;
      if (options.injectOversizedArtifact) oversizedRunnerCommand = command;
      evidence.leaseGenerations.push(command.generation);
      evidence.podUids.push(command.podUid);
      const candidate = candidates.find(({ spec: row }) => row.workerId === command.workerId)!;
      evidence.leaseHosts.push(candidate.host);
      evidence.leaseArchitectures.push(command.key.architecture);
      if (options.injectOversizedArtifact) {
        const result = await executeSiWarmTransport({ command, pod: acquired.attempt.transport.pod,
          leaseFenced: acquired.attempt.leaseFenced, payload: acquired.attempt.payload,
          credentialBundle: acquired.attempt.credentialBundle, runner: acquired.attempt.transport.runner, now });
        evidence.artifactCapRejected = result.quarantineWorker && result.quarantineRecorded
          && result.reason === 'exec-uncertain' && result.validationReason === 'invalid-reply' && result.bytes === null;
        evidence.artifactDecodeCalls = artifactDecodeCalls;
        if (evidence.artifactCapRejected) {
          evidence.cleanupOutcomes.push('quarantined');
          break;
        }
        throw new Error('oversized SI artifact was not quarantined');
      }
      if (options.afterAcquire && (options.afterAcquireAtLease === 'each' || index === (options.afterAcquireAtLease ?? 1))) {
        await options.afterAcquire(candidate.host, index);
      }
      const returned = await cleanAndReturnChildPod({ workerId: command.workerId, podUid: command.podUid,
        leaseId: command.leaseId, generation: command.generation, key: command.key, sourceSha: command.sourceSha },
      acquired.attempt.cleanup);
      evidence.cleanupOutcomes.push(returned.outcome);
      if (returned.outcome === 'quarantined') break;
    }
    if (evidence.cleanupOutcomes.at(-1) === 'quarantined') {
      const retrySourceSha = options.cleanResidueForReuse && options.residueFixture
        ? options.residueFixture.remote.git(options.residueFixture.remote.checkout, ['rev-parse', 'HEAD']).trim()
        : specA.cutSha;
      const retry = await provider.acquire({ runId: `${options.runId}-retry`, attemptId: 'attempt-retry',
        executionKey: 'a'.repeat(64), sourceSha: retrySourceSha, deadlineAt: now() + 60_000,
        payload: new TextEncoder().encode('simulated SI payload'),
        credentialBundle: new TextEncoder().encode('simulated credential bundle'), adopt: async () => {} });
      if (retry.status === 'acquired' && options.recoverOnAlternateHost) {
        const command = retry.attempt.command!;
        const candidate = candidates.find(({ spec: row }) => row.workerId === command.workerId)!;
        evidence.retryAcquire = `acquired:${candidate.host}`;
        evidence.recoveryHost = candidate.host;
        evidence.leaseGenerations.push(command.generation);
        evidence.podUids.push(command.podUid);
        evidence.leaseHosts.push(candidate.host);
        evidence.leaseArchitectures.push(command.key.architecture);
        const returned = await cleanAndReturnChildPod({ workerId: command.workerId, podUid: command.podUid,
          leaseId: command.leaseId, generation: command.generation, key: command.key, sourceSha: command.sourceSha },
        retry.attempt.cleanup);
        evidence.cleanupOutcomes.push(returned.outcome);
        if (returned.outcome === 'quarantined') throw new Error('alternate SI worker failed cleanup after host loss');
      } else {
        evidence.retryAcquire = retry.status === 'no-entry' ? `${retry.status}:${retry.reason}` : retry.status;
      }
      if (retry.status === 'acquired') {
        if (!options.recoverOnAlternateHost) {
          await retry.attempt.quarantineUnknown('unexpected-reacquire-after-residue');
          throw new Error('quarantined SI worker was reacquired');
        }
      }
    }
    evidence.controlTransitions = primary.requests.map(request => `${request.path}:${request.status}`);
    const finalCandidate = candidates.find(({ host }) => host === evidence.leaseHosts.at(-1)) ?? candidates[0]!;
    const pod = kubernetes.get(finalCandidate.spec.kubectlContext)!.kubectl(['--context', finalCandidate.spec.kubectlContext,
      '-n', finalCandidate.spec.namespace, 'get', 'pod', finalCandidate.spec.name, '-o', 'json']);
    evidence.finalPodState = pod.status === 0
      ? (JSON.parse(pod.stdout) as any).metadata.labels['elanous.ai/state']
      : undefined;
    return evidence;
  } finally {
    if (ownsPrimary) primary.stop();
  }
}
