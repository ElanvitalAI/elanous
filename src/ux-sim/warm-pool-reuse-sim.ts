import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureControlTokens, startControlServer } from '../control-plane/server.js';
import { issueMemberToken } from '../control-plane/member-tokens.js';
import { WarmPodProvider, requestWarmPodReplay, type WarmWorkerCandidate } from '../task-orchestrator/surfaces/pod-warm-worker-provider.js';
import { WarmPodTransport, WARM_POD_ACK, WARM_POD_EXEC, WARM_POD_READ, WARM_POD_RUNTIME_PROBE,
  warmWorkerPodManifest, type WarmPodSpec } from '../task-orchestrator/surfaces/pod-warm-worker-pod.js';
import type { WarmWorkerCommand } from '../task-orchestrator/surfaces/pod-warm-worker-protocol.js';
import { createFakeKubectl } from './fake-kubectl.js';
import { createFakeCloudVm } from './fake-cloud-vm.js';
import { assembleWarmPoolProviderConfig, type WarmPoolProviderConfig } from '../../scripts/warm-pool-provider-config.js';
import { activeResourcePools, beginResourceLease, declareResourcePool, readResourceLedger, reapResourceLeaseIfCurrent, recordWarmPoolPodReceipt } from '../resource-ledger/resource-ledger.js';
import { withSimClock } from './fake-clock.js';

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
  evidence: ProtocolEvidence, transportFailure: boolean, runtimeContractMismatch = false) {
  const artifactFiles = new Map<string, string>();
  const boundaryKubectl = (args: readonly string[], input?: string) => {
    if (args.includes(WARM_POD_RUNTIME_PROBE)) {
      const expected = specification.runtimeContract!;
      const observed = { bunVersion: runtimeContractMismatch ? '0.0.0' : expected.bunVersion,
        os: expected.os, architecture: expected.architecture,
        tools: Object.fromEntries(expected.requiredTools.map(tool => [tool, true])) };
      return { status: 0, stdout: JSON.stringify(observed), stderr: '' };
    }
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
  transportFailure?: boolean; candidateHost?: 'pool-host-a' | 'pool-host-b'; providerConfig?: WarmPoolProviderConfig;
  drainingHosts?: readonly string[]; seedDrainingPod?: boolean;
  imagePinDigests?: { expected: string; observed: string }; runtimeContractMismatch?: boolean;
  imagePinLeaseState?: 'idle' | 'leased' }) {
  const fault = options.fault;
  const assembledTemplate = options.providerConfig?.poolTemplates[0];
  const candidateHost = assembledTemplate?.host ?? options.candidateHost ?? 'pool-host-a';
  const baseCandidate: WarmWorkerCandidate = assembledTemplate ?? { host: candidateHost, tier: 'standard', spec: {
    ...spec, kubectlContext: `${candidateHost}-context`, nodeName: `${candidateHost}-server-0`,
    name: `warm-${candidateHost}-standard-1`, workerId: `warm-${candidateHost}-standard-1-generation-1`,
    runtimeContract: { bunVersion: Bun.version, os: 'linux', architecture: 'amd64', requiredTools: ['bun', 'git'] },
  } };
  const candidate: WarmWorkerCandidate = options.imagePinDigests ? { ...baseCandidate, spec: {
    ...baseCandidate.spec, key: { ...baseCandidate.spec.key, imageDigest: options.imagePinDigests.expected },
    image: `${baseCandidate.spec.image.slice(0, baseCandidate.spec.image.lastIndexOf('@') + 1)}${options.imagePinDigests.expected}`,
  } } : baseCandidate;
  const kubernetes = createFakeKubectl({ context: candidate.spec.kubectlContext, node: candidate.spec.nodeName!, podReadinessOnCreate: true });
  if (fault === 'image-pin-mismatch' || fault === 'profile-mismatch' || fault === 'detail-callback-missing' || options.imagePinDigests) {
    const manifest = warmWorkerPodManifest(candidate.spec) as Record<string, any>;
    manifest.metadata.uid = 'preexisting-pod-uid'; manifest.metadata.resourceVersion = '1';
    manifest.status = { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'worker', ready: true }] };
    if (fault === 'image-pin-mismatch' || fault === 'detail-callback-missing')
      manifest.spec.containers[0].image = options.imagePinDigests
        ? `${candidate.spec.image.slice(0, candidate.spec.image.lastIndexOf('@') + 1)}${options.imagePinDigests.observed}`
        : 'registry.example/elanous@sha256:' + '9'.repeat(64);
    else manifest.spec.containers[0].resources.limits.memory = '2Gi';
    if (options.imagePinDigests) {
      const oldImage = `${candidate.spec.image.slice(0, candidate.spec.image.lastIndexOf('@') + 1)}${options.imagePinDigests.observed}`;
      manifest.metadata.annotations['elanous.dev/warm-image-digest'] = options.imagePinDigests.observed;
      for (const container of [...manifest.spec.initContainers, ...manifest.spec.containers]) container.image = oldImage;
      manifest.spec.containers[0].env.find((row: any) => row.name === 'WARM_IMAGE_DIGEST').value = options.imagePinDigests.observed;
    }
    kubernetes.putPod(manifest);
  }
  const primary = await createFakePrimaryControl();
  const prepareLockDirectory = mkdtempSync(join(tmpdir(), 'warm-pool-reuse-sim-'));
  const protocol: ProtocolEvidence = { requests: [], responses: [], acknowledgements: [] };
  const deletionEvidence: { podUid: string | null } = { podUid: null };
  if (options.imagePinDigests) {
    const pod = kubernetes.getPod(candidate.spec.name);
    const machine = primary.machineTokens[candidateHost as keyof typeof primary.machineTokens];
    if (!pod || !machine) throw new Error('image drift fixture is missing its Pod or host token');
    const registered = await primary.fetch(new URL('/v1/workers/pod', primary.url), { method: 'POST',
      headers: { authorization: `Bearer ${machine}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: candidate.spec.workerId, machine: candidateHost,
        podUid: pod.metadata.uid, key: options.imagePinDigests
          ? { ...candidate.spec.key, imageDigest: options.imagePinDigests.observed } : candidate.spec.key,
        ttlMs: 60_000 }) });
    if (registered.status !== 200) throw new Error('image drift fixture could not register its idle worker');
    if (options.imagePinLeaseState === 'leased') {
      const leased = await primary.fetch(new URL('/v1/leases/pod-worker', primary.url), { method: 'POST',
        headers: { authorization: `Bearer ${primary.memberToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ machine: candidateHost, key: options.imagePinDigests
          ? { ...candidate.spec.key, imageDigest: options.imagePinDigests.observed } : candidate.spec.key,
          runId: `${options.runId}-active`, attemptId: `${options.runId}-active-attempt`, ttlMs: 60_000 }) });
      if (leased.status !== 200) throw new Error('image drift fixture could not seed its active lease');
    }
  }
  if (options.seedDrainingPod) {
    const manifest = warmWorkerPodManifest(candidate.spec) as Record<string, any>;
    manifest.metadata.uid = 'drained-pod-uid';
    manifest.metadata.resourceVersion = '1';
    manifest.status = { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] };
    kubernetes.putPod(manifest);
    const seedMachineToken = primary.machineTokens[candidateHost as keyof typeof primary.machineTokens];
    if (!seedMachineToken) throw new Error('no machine token for seeded drained host');
    const registered = await primary.fetch(new URL('/v1/workers/pod', primary.url), { method: 'POST',
      headers: { authorization: `Bearer ${seedMachineToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: candidate.spec.workerId, machine: candidateHost,
        podUid: 'drained-pod-uid', key: candidate.spec.key, ttlMs: 60_000 }) });
    if (registered.status !== 200) throw new Error('failed to seed the idle drained worker');
  }
  const simulationMachineTokens = { ...(options.providerConfig?.machineTokens ?? {}) };
  for (const host of ['pool-host-a', 'pool-host-b'] as const) simulationMachineTokens[host] = primary.machineTokens[host];
  if (fault === 'machine-token-scope-mismatch')
    simulationMachineTokens[candidateHost] = primary.machineTokens[candidateHost === 'pool-host-a' ? 'pool-host-b' : 'pool-host-a'];
  const provider = new WarmPodProvider({ ...(options.providerConfig ?? { candidates: [candidate] }), controlUrl: primary.url,
    ...(options.drainingHosts ? { drainingHosts: options.drainingHosts } : {}),
    memberToken: primary.memberToken,
    machineTokens: simulationMachineTokens,
    profileConfig: { pod: { warmPoolProfile: 'gate' } }, kubectl: (args, input) => {
      if (args.includes(WARM_POD_RUNTIME_PROBE)) {
        const expected = candidate.spec.runtimeContract!;
        const contractMismatch = options.runtimeContractMismatch === true
          || (fault === 'image-pin-mismatch' && !options.imagePinDigests);
        const observed = { bunVersion: contractMismatch ? '0.0.0' : expected.bunVersion,
          os: expected.os, architecture: expected.architecture,
          tools: Object.fromEntries(expected.requiredTools.map(tool => [tool, true])) };
        return { status: 0, stdout: JSON.stringify(observed), stderr: '' };
      }
      return kubernetes.kubectl(args, input);
    },
    fetch: primary.fetch, prepareLockDirectory,
    ...(options.seedDrainingPod || options.imagePinDigests ? {
      rotationStatePath: join(prepareLockDirectory, 'rotations.json'),
      kubectlProxyUrlForTest: 'http://127.0.0.1:1',
      kubernetesFetch: (async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { preconditions?: { uid?: string } };
        const uid = body.preconditions?.uid ?? null;
        const expectedUid = options.imagePinDigests ? 'preexisting-pod-uid' : 'drained-pod-uid';
        const deleted = uid === expectedUid && kubernetes.deletePod(candidate.spec.name, uid);
        deletionEvidence.podUid = deleted ? uid : null;
        return new Response(null, { status: deleted ? 200 : 409 });
      }) as typeof fetch,
    } : {}),
    observationRunIdForTest: options.runId,
    quotaResolverForTest: () => 1,
    transport: transportSpec => createProtocolBoundary(transportSpec, kubernetes.kubectl, protocol,
      options.transportFailure === true, options.runtimeContractMismatch === true),
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
    if (fault && !options.imagePinDigests) return { runId: options.runId, reconcile, selection: null, protocol,
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
    return { runId: options.runId, reconcile, protocol, controlRequests: primary.requests,
      deletedPodUid: deletionEvidence.podUid, selection: {
      selected: selection.command !== null, workerId: selection.command?.workerId ?? null,
      transport: selection.transport.status, reason: selection.transport.reason,
    } };
  } finally {
    primary.stop();
    rmSync(prepareLockDirectory, { recursive: true, force: true });
  }
}

/** Advance the real warm-pool provider across an idle TTL and verify fenced Pod replacement. */
export async function simulateWarmPoolTtlRotation(options: { runId: string; ttlMs?: number; registrationTtlMs?: number;
  replacePodBeforeDelete?: boolean; probeElapsedMs?: number }) {
  const ttlMs = options.ttlMs ?? 1_000;
  const registrationTtlMs = options.registrationTtlMs ?? ttlMs;
  if (![ttlMs, registrationTtlMs].every(value => Number.isSafeInteger(value) && value > 0))
    throw new Error('warm TTL simulation requires positive integer TTLs');
  const epoch = Date.parse('2026-11-05T00:00:00.000Z');
  return withSimClock(epoch, async clock => {
    const candidate: WarmWorkerCandidate = { host: 'pool-host-a', tier: 'standard', spec: {
      ...spec, name: 'warm-pool-host-a-standard-1', workerId: 'warm-pool-host-a-standard-generation-1',
    } };
    const kubernetes = createFakeKubectl({ context: candidate.spec.kubectlContext,
      node: candidate.spec.nodeName!, podReadinessOnCreate: true, uniquePodUids: true });
    const primary = await createFakePrimaryControl();
    const prepareLockDirectory = mkdtempSync(join(tmpdir(), 'warm-pool-ttl-rotation-'));
    const rotationStatePath = join(prepareLockDirectory, 'rotations.json');
    const deleteRequests: Array<{ name: string; uid: string; deleted: boolean }> = [];
    const kubernetesFetch = Object.assign((async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const prefix = `/api/v1/namespaces/${encodeURIComponent(candidate.spec.namespace)}/pods/`;
      if (init?.method !== 'DELETE' || !url.pathname.startsWith(prefix)) return new Response(null, { status: 404 });
      const name = decodeURIComponent(url.pathname.slice(prefix.length));
      const body = JSON.parse(String(init.body ?? '{}')) as { preconditions?: { uid?: string } };
      const uid = body.preconditions?.uid ?? '';
      if (options.replacePodBeforeDelete && deleteRequests.length === 0)
        kubernetes.replacePodUid(name, 'raced-replacement-uid');
      const deleted = kubernetes.deletePod(name, uid);
      deleteRequests.push({ name, uid, deleted });
      return new Response(null, { status: deleted ? 200 : 409 });
    }) as typeof fetch, { preconnect: fetch.preconnect }) as typeof fetch;
    const protocol: ProtocolEvidence = { requests: [], responses: [], acknowledgements: [] };
    const makeProvider = (leaseTtlMs: number) => new WarmPodProvider({ candidates: [candidate], controlUrl: primary.url,
      memberToken: primary.memberToken, machineTokens: { 'pool-host-a': primary.machineTokens['pool-host-a'] },
      profileConfig: { pod: { warmPoolProfile: 'gate' } }, leaseTtlMs,
      now: clock.now,
      kubectl: kubernetes.kubectl, fetch: primary.fetch, prepareLockDirectory, rotationStatePath,
      kubectlProxyUrlForTest: 'http://127.0.0.1:1', kubernetesFetch,
      observationRunIdForTest: options.runId, quotaResolverForTest: () => 1,
      transport: transportSpec => createProtocolBoundary(transportSpec, kubernetes.kubectl, protocol, false),
    });
    let provider = makeProvider(registrationTtlMs);
    const readRows = async () => {
      const response = await primary.fetch(new URL(`/v1/resources?kind=pod-worker-lease&machine=pool-host-a`, primary.url), {
        headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}` },
      });
      if (!response.ok) throw new Error(`warm TTL ledger read failed (${response.status})`);
      return (await response.json() as { resources: Array<any> }).resources;
    };
    try {
      const firstReconcile = await provider.reconcilePool();
      const originalRow = (await readRows())[0];
      const originalPod = kubernetes.getPod(candidate.spec.name);
      if (!originalRow || !originalPod) throw new Error('warm TTL simulation did not create its initial worker');
      provider = makeProvider(ttlMs);
      let stillValidReconcile: Awaited<ReturnType<WarmPodProvider['reconcilePool']>> | null = null;
      let stillValidRow: any = null;
      if (options.probeElapsedMs !== undefined) {
        if (!Number.isSafeInteger(options.probeElapsedMs) || options.probeElapsedMs < 0)
          throw new Error('warm TTL probe must be a nonnegative integer');
        clock.tick(options.probeElapsedMs);
        stillValidReconcile = await provider.reconcilePool();
        stillValidRow = (await readRows()).find(row => row.name === originalRow.name) ?? null;
        const injectedExpiryElapsed = registrationTtlMs;
        if (injectedExpiryElapsed <= options.probeElapsedMs)
          throw new Error('warm TTL probe must precede the injected-clock expiry');
        clock.tick(injectedExpiryElapsed - options.probeElapsedMs);
      } else clock.tick(registrationTtlMs);
      const rotatedReconcile = await provider.reconcilePool();
      const rows = await readRows();
      const oldRow = rows.find(row => row.name === originalRow.name);
      const replacementRow = rows.find(row => row.name !== originalRow.name);
      const replacementPod = kubernetes.getPod(candidate.spec.name);
      let selection: { selected: boolean; workerId: string | null; transport: string; reason: string } | null = null;
      if (rotatedReconcile.ready === 1) {
        const result = await requestWarmPodReplay({ protocol: 1, runId: options.runId,
          attemptId: `${options.runId}-ttl-gate-1`, cutSha: spec.cutSha, deadlineAt: clock.now() + 60_000,
          files: ['src/task-orchestrator/surfaces/pod-warm-worker-provider.test.ts'], envProfile: 'gate-v1' }, provider);
        selection = { selected: result.command !== null, workerId: result.command?.workerId ?? null,
          transport: result.transport.status, reason: result.transport.reason };
        if (result.command && result.transport.status === 'observed' && result.transport.reason === 'complete')
          await provider.finalize(result.command);
      }
      return { runId: options.runId, ttlMs, registrationTtlMs, advancedTo: clock.now(), firstReconcile,
        stillValidReconcile, stillValidRow, rotatedReconcile,
        original: { workerId: originalRow.name, podUid: originalPod.metadata.uid, ttlMs: originalRow.ttlMs,
          stateAfterRotation: oldRow?.attrs?.state ?? null },
        replacement: replacementRow && replacementPod ? { workerId: replacementRow.name,
          podUid: replacementPod.metadata.uid, state: replacementRow.attrs?.state } : null,
        deleteRequests, podAfterRotation: kubernetes.getPod(candidate.spec.name), selection, protocol,
        controlRequests: primary.requests };
    } finally {
      primary.stop();
      rmSync(prepareLockDirectory, { recursive: true, force: true });
    }
  });
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
