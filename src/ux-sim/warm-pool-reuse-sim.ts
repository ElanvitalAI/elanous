import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureControlTokens, startControlServer } from '../control-plane/server.js';
import { issueMemberToken } from '../control-plane/member-tokens.js';
import { WarmPodProvider, requestWarmPodReplay, type WarmWorkerCandidate } from '../task-orchestrator/surfaces/pod-warm-worker-provider.js';
import { WarmPodTransport, WARM_POD_ACK, WARM_POD_EXEC, WARM_POD_READ,
  warmWorkerPodManifest, type WarmPodSpec } from '../task-orchestrator/surfaces/pod-warm-worker-pod.js';
import type { WarmWorkerCommand } from '../task-orchestrator/surfaces/pod-warm-worker-protocol.js';
import { createFakeKubectl } from './fake-kubectl.js';
import { createFakeCloudVm } from './fake-cloud-vm.js';
import { assembleWarmPoolProviderConfig, type WarmPoolProviderConfig } from '../../scripts/warm-pool-provider-config.js';
import { activeResourcePools, beginResourceLease, declareResourcePool, readResourceLedger, reapResourceLeaseIfCurrent, recordWarmPoolPodReceipt } from '../resource-ledger/resource-ledger.js';

export type WarmPoolReuseFault = 'image-pin-mismatch' | 'profile-mismatch' | 'machine-token-scope-mismatch'
  | 'detail-callback-missing';

const key = { context: 'pool-host-a-context', imageDigest: `sha256:${'d'.repeat(64)}`,
  lockHash: 'e'.repeat(64), architecture: 'amd64' };
const spec: WarmPodSpec = { name: 'warm-pool-host-a-standard-1', namespace: 'elanous-test', kubectlContext: 'pool-host-a-context',
  workerId: 'warm-pool-host-a-standard-1-generation-1', image: `registry.example/elanous@${key.imageDigest}`,
  sourceUrl: 'https://github.com/ElanvitalAI/elanous.git', cutSha: 'f'.repeat(40), key,
  memoryLimit: '16Gi', nodeName: 'pool-host-a-server-0', hostProbeUrl: 'http://host.orb.internal:10001/health',
  prodProbeUrl: 'http://core.elanous-prod:10002/' };

/** A real isolated control server with a deterministic primary lease view and real token authorization. */
export async function createFakePrimaryControl() {
  const root = mkdtempSync(join(tmpdir(), 'warm-pool-primary-sim-'));
  try {
    const tokens = ensureControlTokens(root);
    const machineTokens = {
      'pool-host-a': issueMemberToken('pool-host-a', root),
      'pool-host-b': issueMemberToken('pool-host-b', root),
    };
    const requests: Array<{ path: string; status: number }> = [];
    const server = startControlServer({ root, port: 0, leaseView: { async get() {
      return { holder: 'primary', generation: 1, iAmHolder: true, known: true };
    } } });
    return { root, url: server.url, memberToken: tokens.member, machineTokens,
      requests,
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const response = await fetch(input, init);
        requests.push({ path: new URL(String(input)).pathname, status: response.status });
        return response;
      },
      stop() { server.stop(); rmSync(root, { recursive: true, force: true }); } };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

type ProtocolEvidence = {
  requests: WarmWorkerCommand[];
  responses: Array<{ runId: string; reason: string; replyRunId: string | null }>;
  acknowledgements: string[];
};

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function buildProtocolReply(command: WarmWorkerCommand) {
  const file = command.files[0]!;
  const junit = `<testsuites tests="1"><testsuite name="${file}" file="${file}" tests="1"><testcase name="works" file="${file}"/></testsuite></testsuites>`;
  const log = `[warm-worker] file=${file}\n[warm-worker] cut=${command.cutSha} attempt=${command.attemptId}\nbun test v1.0.0\n${file}:\n(pass) works\n1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n[warm-worker] junit-sha256=${sha256(junit)}\n`;
  const meta = JSON.stringify({ rc: 0, files: [file], commit: command.cutSha, attemptId: command.attemptId,
    warmKey: command.key, jobExitCode: 0, jobFailed: false });
  const rc = '0';
  const manifest = JSON.stringify({ protocol: 1, cutSha: command.cutSha, attemptId: command.attemptId,
    file, rc: 0, logSha256: sha256(log), junitSha256: sha256(junit), metaSha256: sha256(meta), rcSha256: sha256(rc) });
  const artifacts = { log, 'junit.xml': junit, json: meta, 'warm-manifest.json': manifest, rc };
  const artifactsDir = `/workspace/data/artifacts/${[
    command.runId, command.attemptId, command.leaseId, String(command.generation), command.workerId,
  ].join('/')}`;
  const artifactHashes = [Object.fromEntries(Object.entries(artifacts).map(([name, content]) => [name, sha256(content)]))];
  return { artifacts, artifactsDir, artifactHashes, reply: {
    protocol: 1, runId: command.runId, attemptId: command.attemptId, cutSha: command.cutSha,
    leaseId: command.leaseId, generation: command.generation, workerId: command.workerId,
    key: command.key, envProfile: command.envProfile, startedAt: Date.now(), finishedAt: Date.now(),
    files: [{ file, rc: 0, failureIds: [], errorIds: [], junitComplete: true }],
  } };
}

function createProtocolBoundary(specification: WarmPodSpec, kubectl: ReturnType<typeof createFakeKubectl>['kubectl'],
  evidence: ProtocolEvidence, transportFailure: boolean) {
  const artifactFiles = new Map<string, string>();
  const boundaryKubectl = (args: readonly string[], input?: string) => {
    if (args.includes(WARM_POD_EXEC)) {
      let command: WarmWorkerCommand;
      try { command = JSON.parse(input ?? '') as WarmWorkerCommand; }
      catch { return { status: 1, stdout: '', stderr: 'invalid gate request protocol' }; }
      evidence.requests.push(command);
      if (transportFailure) {
        const reply = { reason: 'exec-failed', quarantineWorker: true, reply: null };
        evidence.responses.push({ runId: command.runId, reason: reply.reason, replyRunId: null });
        return { status: 0, stdout: JSON.stringify(reply), stderr: '' };
      }
      const output = buildProtocolReply(command);
      for (const [suffix, contents] of Object.entries(output.artifacts))
        artifactFiles.set(`${output.artifactsDir}/file-0.${suffix}`, contents);
      const reply = { reason: 'complete', quarantineWorker: false, artifactsDir: output.artifactsDir,
        artifactHashes: output.artifactHashes, reply: output.reply };
      evidence.responses.push({ runId: command.runId, reason: reply.reason, replyRunId: output.reply.runId });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '' };
    }
    if (args.includes(WARM_POD_READ)) {
      const content = artifactFiles.get(args.at(-1) ?? '');
      return content === undefined ? { status: 1, stdout: '', stderr: 'artifact absent' }
        : { status: 0, stdout: Buffer.from(content).toString('base64'), stderr: '' };
    }
    if (args.includes(WARM_POD_ACK)) {
      let identity: { runId?: string; attemptId?: string; leaseId?: string; generation?: number };
      try { identity = JSON.parse(input ?? '') as typeof identity; }
      catch { return { status: 1, stdout: '', stderr: 'invalid ACK protocol' }; }
      const request = evidence.requests.at(-1);
      if (!request || request.runId !== identity.runId || request.attemptId !== identity.attemptId
        || request.leaseId !== identity.leaseId || request.generation !== identity.generation)
        return { status: 1, stdout: '', stderr: 'ACK identity mismatch' };
      evidence.acknowledgements.push(identity.runId!);
      return { status: 0, stdout: 'ack', stderr: '' };
    }
    return kubectl(args, input);
  };
  const transport = new WarmPodTransport(specification, boundaryKubectl);
  return { request: (command: WarmWorkerCommand) => transport.request(command) };
}

export async function runWarmPoolReuseSimulation(options: { runId: string; fault?: WarmPoolReuseFault;
  transportFailure?: boolean; candidateHost?: 'pool-host-a' | 'pool-host-b'; providerConfig?: WarmPoolProviderConfig }) {
  const fault = options.fault;
  const assembledTemplate = options.providerConfig?.poolTemplates[0];
  const candidateHost = assembledTemplate?.host ?? options.candidateHost ?? 'pool-host-a';
  const candidate: WarmWorkerCandidate = assembledTemplate ?? { host: candidateHost, tier: 'standard', spec: { ...spec, kubectlContext: `${candidateHost}-context`, nodeName: `${candidateHost}-server-0`, name: `warm-${candidateHost}-standard-1`, workerId: `warm-${candidateHost}-standard-1-generation-1` } };
  const kubernetes = createFakeKubectl({ context: candidate.spec.kubectlContext, node: candidate.spec.nodeName!, podReadinessOnCreate: true });
  if (fault === 'image-pin-mismatch' || fault === 'profile-mismatch' || fault === 'detail-callback-missing') {
    const manifest = warmWorkerPodManifest(candidate.spec) as Record<string, any>;
    manifest.metadata.uid = 'preexisting-pod-uid'; manifest.metadata.resourceVersion = '1';
    manifest.status = { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] };
    if (fault === 'image-pin-mismatch' || fault === 'detail-callback-missing')
      manifest.spec.containers[0].image = 'registry.example/elanous@sha256:' + '9'.repeat(64);
    else manifest.spec.containers[0].resources.limits.memory = '2Gi';
    kubernetes.putPod(manifest);
  }
  const primary = await createFakePrimaryControl();
  const prepareLockDirectory = mkdtempSync(join(tmpdir(), 'warm-pool-reuse-sim-'));
  const protocol: ProtocolEvidence = { requests: [], responses: [], acknowledgements: [] };
  const provider = new WarmPodProvider({ ...(options.providerConfig ?? { candidates: [candidate] }), controlUrl: primary.url,
    memberToken: primary.memberToken,
    machineTokens: { [candidateHost]: fault === 'machine-token-scope-mismatch'
      ? primary.machineTokens[candidateHost === 'pool-host-a' ? 'pool-host-b' : 'pool-host-a'] : primary.machineTokens[candidateHost as keyof typeof primary.machineTokens] },
    profileConfig: { pod: { warmPoolProfile: 'gate' } }, kubectl: kubernetes.kubectl,
    fetch: primary.fetch, prepareLockDirectory,
    observationRunIdForTest: options.runId,
    quotaResolverForTest: () => 1,
    transport: transportSpec => createProtocolBoundary(transportSpec, kubernetes.kubectl, protocol,
      options.transportFailure === true),
  });
  try {
    // Exercise the in-flight reuse path: another caller starts a failing cold
    // prepare without a detail callback, then reconcile asks for its reason.
    const reconcile = fault === 'detail-callback-missing'
      ? await (async () => {
        const preparing = provider.ensureStandingWorker(candidate);
        const reconciliation = provider.reconcilePool();
        await preparing;
        return reconciliation;
      })()
      : await provider.reconcilePool();
    if (fault) return { runId: options.runId, reconcile, selection: null, protocol,
      controlRequests: primary.requests };
    const selection = await requestWarmPodReplay({ protocol: 1, runId: options.runId,
      attemptId: `${options.runId}-gate-1`, cutSha: spec.cutSha, deadlineAt: Date.now() + 60_000,
      files: ['src/task-orchestrator/surfaces/pod-warm-worker-provider.test.ts'], envProfile: 'gate-v1' }, provider);
    if (selection.command && selection.transport.status === 'observed' && selection.transport.reason === 'complete') {
      try { await provider.finalize(selection.command); }
      catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; control=${JSON.stringify(primary.requests)}`);
      }
    }
    return { runId: options.runId, reconcile, protocol, controlRequests: primary.requests, selection: {
      selected: selection.command !== null, workerId: selection.command?.workerId ?? null,
      transport: selection.transport.status, reason: selection.transport.reason,
    } };
  } finally {
    primary.stop();
    rmSync(prepareLockDirectory, { recursive: true, force: true });
  }
}


/** Exercise the production simulation devices' mesh-loss contract without contacting cloud APIs. */
export async function simulateWarmPoolMachineLossRecovery() {
  const fleet = createFakeCloudVm();
  const digest = key.imageDigest;
  const lostHost = 'pool-host-a' as const;
  const survivingHost = 'pool-host-b' as const;
  fleet.createFromImage({ id: lostHost, imageDigest: digest, hourlyCost: 1 });
  fleet.createFromImage({ id: survivingHost, imageDigest: digest, hourlyCost: 1 });
  fleet.openLease(lostHost);
  const lost = fleet.disappear(lostHost);
  const replacement = fleet.status(survivingHost);
  if (lost.state !== 'disappeared' || replacement.state !== 'ready' || replacement.imageDigest !== digest)
    throw new Error('warm pool recovery requires a live same-digest mesh member');
  fleet.openLease(survivingHost);
  const ledgerDir = mkdtempSync(join(tmpdir(), 'warm-pool-machine-loss-ledger-'));
  const ledgerPath = join(ledgerDir, 'events.jsonl');
  try {
    declareResourcePool({ purpose: 'gate', fanoutGroupId: 'mesh-loss-v1', members: [
      { host: lostHost, count: 1, digest, role: 'both' }, { host: survivingHost, count: 1, digest, role: 'both' }],
      fanoutGroup: { shard: { kind: 'gate', input: 'mesh-loss-canary', result: 'gate-result', fingerprint: 'runtime-env-skill' } },
      fingerprint: { runtime: 'bun-sim-v1', environment: 'linux-amd64', skillPacks: [] },
      cleanup: { procedure: 'worktree-env-credential-v1', verify: 'workspace-clean-v1' } }, new Date(), ledgerPath);
    const prior = new Date(Date.now() - 120_000);
    const lease = beginResourceLease({ fp: 'fp_mesh_gcp1_warm', host: lostHost, lane: 'warm',
      resources: { pods: 1 }, mission: { cell: 'WARM-POOL-DESIGN-FLEX' }, ttlMs: 60_000, now: prior }, ledgerPath);
    const expiry = Date.parse(lease.heartbeatAt) + lease.ttlMs;
    const reaped = reapResourceLeaseIfCurrent({ id: lease.id, expectedHeartbeatAt: lease.heartbeatAt,
      expectedExpiresAtMs: expiry, observedAtMs: Date.now(), reason: 'machine-disappeared' }, ledgerPath);
    const authoritativePool = activeResourcePools(readResourceLedger(ledgerPath))[0];
    const survivingMember = authoritativePool?.members.find(member => member.host !== lostHost && member.digest === digest && member.role !== 'assigner');
    if (!survivingMember) throw new Error('Nexus resource-ledger declaration did not retain an executable surviving mesh member');
    const providerConfig = assembleWarmPoolProviderConfig({
      config: { pod: { warmPoolProfile: 'gate', warmPool: { namespace: 'elanous-test',
        imageRepository: 'registry.example/elanous', imageDigest: digest, lockHash: key.lockHash,
        architecture: key.architecture, hostProbeUrl: 'http://host.orb.internal:10001/health',
        prodProbeUrl: 'http://core.elanous-prod:10002/', sourceUrl: 'https://github.com/ElanvitalAI/elanous.git',
        templates: [{ host: survivingMember.host, tier: 'standard', nodeName: `${survivingMember.host}-node` }] } },
        harness: { imageCommit: spec.cutSha, podPool: `${survivingMember.host}-context` } },
      controlUrl: 'https://control.example:8413', memberToken: 'd'.repeat(64),
      machineTokens: { [survivingMember.host]: 'e'.repeat(64) }, machinePools: [authoritativePool],
    });
    const providerTemplate = providerConfig.poolTemplates[0];
    if (!providerTemplate || providerTemplate.host !== survivingMember.host || providerTemplate.spec.key.imageDigest !== digest)
      throw new Error('provider assembler ignored the surviving ledger member or digest');
    const providerSelection = await runWarmPoolReuseSimulation({ runId: 'machine-loss-survivor-provider', providerConfig });
    if (!providerSelection.selection?.selected || !providerSelection.selection.workerId?.startsWith('warm-' + survivingHost + '-'))
      throw new Error('production warm provider did not select the assembled same-digest surviving host template');
    recordWarmPoolPodReceipt({ purpose: 'ta', host: lostHost, podUid: 'sim-pod-gcp1',
      digest, runtime: 'bun-sim-v1', environment: 'linux-amd64', skillPacks: [{ name: 'research', version: '2' }],
      lastJob: 'crawl-shard-1', cleanupResult: { state: 'unknown', procedure: 'worktree-env-credential-v1',
        reason: 'host-disappeared-before-cleanup', verifiedAt: new Date().toISOString() } }, new Date(), ledgerPath);
    const ledger = readResourceLedger(ledgerPath);
    const terminal = ledger.find(event => event.event === 'lease-reaped' && event.reason === 'machine-disappeared');
    const receiptEvent = [...ledger].reverse().find(event => event.event === 'pool-pod-receipt');
    const disappearance = fleet.events().find(event => event.type === 'vm-disappeared');
    return { reason: 'machine-disappeared', lostHost: lostHost,
      lostLeaseCount: disappearance?.type === 'vm-disappeared' ? disappearance.lostLeases : 0,
      reassignedHost: survivingMember.host, digest, providerTemplate: { host: providerTemplate.host,
        slotCount: providerTemplate.slotCount, imageDigest: providerTemplate.spec.key.imageDigest },
      providerSelection: providerSelection.selection, leaseReaped: reaped,
      ledgerReason: terminal?.event === 'lease-reaped' ? terminal.reason : null,
      podReceipt: receiptEvent?.event === 'pool-pod-receipt' ? receiptEvent.receipt : null,
      events: fleet.events() };
  } finally { rmSync(ledgerDir, { recursive: true, force: true }); }

}
