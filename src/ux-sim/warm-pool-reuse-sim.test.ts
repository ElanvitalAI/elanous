import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { debug } from '../debug/log.js';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';
import { getTestStateRoot } from '../nexus/paths.js';
import { assembleWarmPoolProviderConfig } from '../../scripts/warm-pool-provider-config.js';
import { createFakePrimaryControl, runWarmPoolReuseSimulation, simulateWarmPoolMachineLossRecovery, type WarmPoolReuseFault } from './warm-pool-reuse-sim.js';
import { simulateWarmPoolTtlRotation } from './warm-pool-reuse-sim.js';

test('fake primary preserves member and machine lease scope contract', async () => {
  const primary = await createFakePrimaryControl();
  try {
    const key = { context: 'pool-host-a-context', imageDigest: `sha256:${'d'.repeat(64)}`,
      lockHash: 'e'.repeat(64), architecture: 'amd64' };
    const register = await primary.fetch(new URL('/v1/workers/pod', primary.url), { method: 'POST',
      headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'scope-contract-worker', machine: 'pool-host-a', podUid: 'scope-contract-uid', key, ttlMs: 60_000 }) });
    expect(register.status).toBe(200);
    const lease = await primary.fetch(new URL('/v1/leases/pod-worker', primary.url), { method: 'POST',
      headers: { authorization: `Bearer ${primary.memberToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ machine: 'pool-host-a', key, runId: 'scope-contract-run',
        attemptId: 'scope-contract-attempt', ttlMs: 60_000 }) });
    expect(lease.status).toBe(200);
    const leaseValue = await lease.json() as { attrs: { leaseId: string; generation: number } };
    const wrongMachineLease = await primary.fetch(new URL('/v1/leases/pod-worker', primary.url), { method: 'POST',
      headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ machine: 'pool-host-b', key, runId: 'scope-contract-run-2',
        attemptId: 'scope-contract-attempt-2', ttlMs: 60_000 }) });
    expect(wrongMachineLease.status).toBe(403);
    expect(await wrongMachineLease.json()).toMatchObject({ error: 'machine-scope' });
    const machineRelease = await primary.fetch(new URL('/v1/leases/pod-worker/scope-contract-worker/release', primary.url), {
      method: 'POST', headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId: leaseValue.attrs.leaseId, generation: leaseValue.attrs.generation }),
    });
    expect(machineRelease.status).toBe(403);
    const memberRelease = await primary.fetch(new URL('/v1/leases/pod-worker/scope-contract-worker/release', primary.url), {
      method: 'POST', headers: { authorization: `Bearer ${primary.memberToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId: leaseValue.attrs.leaseId, generation: leaseValue.attrs.generation }),
    });
    expect(memberRelease.status).toBe(200);
    const machineWorker = await primary.fetch(new URL('/v1/workers/pod', primary.url), { method: 'POST',
      headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'scope-contract-machine-worker', machine: 'pool-host-a',
        podUid: 'scope-contract-machine-uid', key, ttlMs: 60_000 }) });
    expect(machineWorker.status).toBe(200);
    const machineLease = await primary.fetch(new URL('/v1/leases/pod-worker', primary.url), { method: 'POST',
      headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ machine: 'pool-host-a', key, runId: 'scope-contract-machine-run',
        attemptId: 'scope-contract-machine-attempt', ttlMs: 60_000 }) });
    expect(machineLease.status).toBe(200);
    const activeRetirement = await primary.fetch(new URL('/v1/leases/pod-worker/scope-contract-machine-worker/retire', primary.url), {
      method: 'POST', headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ podUid: 'scope-contract-machine-uid' }),
    });
    expect(activeRetirement.status).toBe(409);
    const idleWorker = await primary.fetch(new URL('/v1/workers/pod', primary.url), { method: 'POST',
      headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'scope-contract-retire-worker', machine: 'pool-host-a',
        podUid: 'scope-contract-retire-uid', key, ttlMs: 60_000 }) });
    expect(idleWorker.status).toBe(200);
    const retired = await primary.fetch(new URL('/v1/leases/pod-worker/scope-contract-retire-worker/retire', primary.url), {
      method: 'POST', headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ podUid: 'scope-contract-retire-uid' }),
    });
    expect(retired.status).toBe(200);
    expect(await retired.json()).toMatchObject({ attrs: { state: 'quarantined', reason: 'host-drained' } });
    const retryRetire = await primary.fetch(new URL('/v1/leases/pod-worker/scope-contract-retire-worker/retire', primary.url), {
      method: 'POST', headers: { authorization: `Bearer ${primary.machineTokens['pool-host-a']}`, 'content-type': 'application/json' },
      body: JSON.stringify({ podUid: 'scope-contract-retire-uid' }),
    });
    expect(retryRetire.status).toBe(200);
  } finally { primary.stop(); }
});

test('WARM-POOL-REUSE-SIM: production reconcile selects a gate worker; refusals retain concrete reasons', async () => {
  const stateRoot = getTestStateRoot() ?? join(tmpdir(), `warm-pool-reuse-sim-${randomUUID()}`);
  const logPath = join(stateRoot, 'logs', 'logs.db');
  mkdirSync(join(stateRoot, 'logs'), { recursive: true });
  const store = new LogStore(logPath, { instance: 'test:warm-pool-reuse-sim' });
  const sink = new StoreSink(store, 'ux-sim:warm-pool-reuse-sim', { installExitHandlers: false });
  const unregister = debug.registerSink(sink);
  const runId = `run-warm-pool-reuse-${randomUUID()}`;
  const faults: Array<[WarmPoolReuseFault, string]> = [
    ['image-pin-mismatch', 'image-reference-mismatch'],
    ['profile-mismatch', 'profile-mismatch'],
    ['machine-token-scope-mismatch', 'machine-token-scope-mismatch'],
    ['detail-callback-missing', 'decision-unavailable'],
  ];
  try {
    const success = await runWarmPoolReuseSimulation({ runId });
    expect(success.reconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
    expect(success.selection).toMatchObject({ selected: true, transport: 'observed', reason: 'complete' });
    if (!success.selection) throw new Error('successful simulation must select a worker');
    expect(success.protocol.requests).toHaveLength(1);
    expect(success.protocol.requests[0]).toMatchObject({ runId, attemptId: `${runId}-gate-1`,
      workerId: success.selection.workerId });
    expect(success.protocol.responses).toEqual([{ runId, reason: 'complete', replyRunId: runId }]);
    expect(success.protocol.acknowledgements).toEqual([runId]);
    expect(success.controlRequests).toContainEqual({ path: '/v1/workers/pod', status: 200 });
    expect(success.controlRequests).toContainEqual({ path: '/v1/leases/pod-worker', status: 200 });
    expect(success.controlRequests).toContainEqual({
      path: `/v1/leases/pod-worker/${success.selection.workerId}/release`, status: 200 });
    expect(success.controlRequests).toContainEqual({
      path: `/v1/leases/pod-worker/${success.selection.workerId}/sanitize`, status: 200 });
    const transportFailureRunId = `${runId}-transport-failure`;
    const transportFailure = await runWarmPoolReuseSimulation({ runId: transportFailureRunId, transportFailure: true });
    expect(transportFailure.selection).toMatchObject({ selected: true, transport: 'fallback', reason: 'worker-quarantined' });
    for (const [fault, reason] of faults) {
      const refused = await runWarmPoolReuseSimulation({ runId: `${runId}-${fault}`, fault });
      expect(refused.reconcile).toMatchObject({ target: 1, ready: 0, failed: [expect.any(String)] });
      if (fault === 'machine-token-scope-mismatch')
        expect(refused.controlRequests).toContainEqual({ path: '/v1/workers/pod', status: 403 });
    }
    const digestRepro = await runWarmPoolReuseSimulation({ runId: `${runId}-live-image-digests`,
      fault: 'image-pin-mismatch', imagePinDigests: {
        expected: 'sha256:dcddd5af4f4b8bc822107d184ee5644bd6165afc48194681e5cf6303066be014',
        observed: 'sha256:439cda88a55018764f7a2a76e4462b1489ed8f96edbb7132580d2e1f92988181',
      } });
    expect(digestRepro.reconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
    expect(digestRepro.selection).toMatchObject({ selected: true, transport: 'observed', reason: 'complete' });
    expect(digestRepro.deletedPodUid).toBeNull();
    expect(digestRepro.controlRequests.filter(row => row.path === '/v1/workers/pod')).toHaveLength(1);
    expect(digestRepro.controlRequests).not.toContainEqual(expect.objectContaining({ path: expect.stringMatching(/\/(retire|reap)$/) }));
    sink.flush();
    const driftRows = store.query({ categories: ['pod.warm'], limit: 200 });
    expect(driftRows.some(row => row.event === 'image-drift'
      && JSON.parse(row.data ?? '{}').runId === `${runId}-live-image-digests`)).toBe(true);
    const incompatible = await runWarmPoolReuseSimulation({ runId: `${runId}-incompatible-runtime`,
      fault: 'image-pin-mismatch', runtimeContractMismatch: true, imagePinDigests: {
        expected: 'sha256:dcddd5af4f4b8bc822107d184ee5644bd6165afc48194681e5cf6303066be014',
        observed: 'sha256:439cda88a55018764f7a2a76e4462b1489ed8f96edbb7132580d2e1f92988181',
      } });
    expect(incompatible.reconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
    expect(incompatible.deletedPodUid).toBe('preexisting-pod-uid');
    expect(incompatible.selection).toMatchObject({ selected: true, transport: 'observed', reason: 'complete' });
    expect(incompatible.controlRequests).toContainEqual({
      path: '/v1/leases/pod-worker/warm-pool-host-a-standard-1-generation-1/retire', status: 200 });
    expect(incompatible.controlRequests).toContainEqual(expect.objectContaining({ path: expect.stringMatching(/\/reap$/), status: 200 }));
    const activeIncompatible = await runWarmPoolReuseSimulation({ runId: `${runId}-active-incompatible-runtime`,
      fault: 'image-pin-mismatch', runtimeContractMismatch: true, imagePinLeaseState: 'leased', imagePinDigests: {
        expected: 'sha256:dcddd5af4f4b8bc822107d184ee5644bd6165afc48194681e5cf6303066be014',
        observed: 'sha256:439cda88a55018764f7a2a76e4462b1489ed8f96edbb7132580d2e1f92988181',
      } });
    expect(activeIncompatible.reconcile).toMatchObject({ target: 1, ready: 0, failed: [expect.any(String)] });
    expect(activeIncompatible.deletedPodUid).toBeNull();
    expect(activeIncompatible.controlRequests).toContainEqual({
      path: '/v1/leases/pod-worker/warm-pool-host-a-standard-1-generation-1/retire', status: 409 });
    sink.flush();
    const rows = store.query({ categories: ['pod.warm', 'pod.warm.provider', 'pod.reuse'], grep: runId, limit: 100 });
    const events = rows.map(row => ({ category: row.category, event: row.event,
      data: row.data ? JSON.parse(row.data) as Record<string, unknown> : {} }));
    const selected = events.filter(row => row.category === 'pod.warm' && row.event === 'request-selection'
      && row.data.runId === runId && row.data.selected === true);
    expect(selected).toHaveLength(1);
    expect(events.filter(row => row.category === 'pod.reuse' && row.event === 'warm-worker-selected'
      && row.data.runId === runId)).toHaveLength(1);
    expect(events.filter(row => row.category === 'pod.reuse' && row.event === 'warm-worker-selected'
      && row.data.runId === transportFailureRunId)).toHaveLength(0);
    for (const [fault, reason] of faults) {
      const refusalRows = store.query({ categories: ['pod.warm.provider'], grep: `${runId}-${fault}`, limit: 100 });
      const refusals = refusalRows.filter(row => row.event === 'prepare-refused').map(row => row.data
        ? JSON.parse(row.data) as Record<string, unknown> : {});
      expect(refusals).toContainEqual(expect.objectContaining({ reason, host: 'pool-host-a',
        slot: 'warm-pool-host-a-standard-1-generation-1', runId: `${runId}-${fault}` }));
    }
  } finally {
    sink.flush(); unregister(); sink.close(); store.close();
    if (!getTestStateRoot()) rmSync(stateRoot, { recursive: true, force: true });
  }
});


test('WARM-POOL-REUSE-SIM: disappearing mesh member reclaims its lease and reassigns same digest', async () => {
  const result = await simulateWarmPoolMachineLossRecovery();
  expect(result).toMatchObject({ reason: 'machine-disappeared', lostHost: 'pool-host-a', lostLeaseCount: 1,
    reassignedHost: 'pool-host-b', providerSelection: { selected: true, transport: 'observed', reason: 'complete', workerId: expect.stringMatching(/^warm-pool-host-b-[a-f0-9]+-standard-1$/) }, providerTemplate: { host: 'pool-host-b', slotCount: 1, imageDigest: expect.stringMatching(/^sha256:/) }, digest: expect.stringMatching(/^sha256:/), leaseReaped: true, ledgerReason: 'machine-disappeared', podReceipt: { lastJob: 'crawl-shard-1', cleanupResult: { state: 'unknown' } } });
  expect(result.events).toContainEqual(expect.objectContaining({ type: 'vm-disappeared', id: 'pool-host-a', lostLeases: 1 }));
  expect(result.events).toContainEqual(expect.objectContaining({ type: 'lease-opened', id: 'pool-host-b' }));
});

test('POD-REUSE-TTL-ROTATE: expired idle Pod is UID-reaped and replaced before reuse', async () => {
  const result = await simulateWarmPoolTtlRotation({ runId: `run-warm-pool-ttl-${randomUUID()}`,
    registrationTtlMs: 500, ttlMs: 1_000 });
  expect(result.firstReconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
  expect(result.rotatedReconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
  expect(result.original.stateAfterRotation).toBe('reaping');
  expect(result.original.ttlMs).toBe(500);
  expect(result.registrationTtlMs).toBe(500);
  expect(result.ttlMs).toBe(1_000);
  expect(result.replacement).toMatchObject({ state: 'idle' });
  expect(result.replacement?.workerId).not.toBe(result.original.workerId);
  expect(result.replacement?.podUid).not.toBe(result.original.podUid);
  expect(result.deleteRequests).toEqual([{ name: 'warm-pool-host-a-standard-1', uid: result.original.podUid, deleted: true }]);
  expect(result.selection).toMatchObject({ selected: true, workerId: result.replacement?.workerId,
    transport: 'observed', reason: 'complete' });
});

test('POD-REUSE-TTL-ROTATE: persisted TTL survives shorter config and UID race preserves replacement Pod', async () => {
  const shorterConfig = await simulateWarmPoolTtlRotation({ runId: `run-warm-pool-ttl-short-${randomUUID()}`,
    registrationTtlMs: 1_000, ttlMs: 500, probeElapsedMs: 500 });
  expect(shorterConfig.stillValidReconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
  expect(shorterConfig.stillValidRow).toMatchObject({ ttlMs: 1_000, attrs: { state: 'idle', idleTtlMs: 1_000 } });
  expect(shorterConfig.rotatedReconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
  expect(shorterConfig.original.stateAfterRotation).toBe('reaping');

  const raced = await simulateWarmPoolTtlRotation({ runId: `run-warm-pool-ttl-race-${randomUUID()}`,
    registrationTtlMs: 500, ttlMs: 1_000, replacePodBeforeDelete: true });
  expect(raced.deleteRequests).toEqual([{ name: 'warm-pool-host-a-standard-1',
    uid: raced.original.podUid, deleted: false }]);
  expect(raced.podAfterRotation?.metadata.uid).toBe('raced-replacement-uid');
});

test('WARM-POOL-REUSE-SIM: draining host is excluded from reconcile and new lease allocation', async () => {
  const result = await runWarmPoolReuseSimulation({ runId: `run-drain-${randomUUID()}`,
    drainingHosts: ['pool-host-a'] });
  expect(result.reconcile).toMatchObject({ target: 0, ready: 0, failed: [] });
  expect(result.selection).toMatchObject({ selected: false, transport: 'fallback', reason: 'no-candidate' });
  expect(result.controlRequests).not.toContainEqual(expect.objectContaining({ path: '/v1/leases/pod-worker' }));
  expect(result.controlRequests).not.toContainEqual(expect.objectContaining({ path: '/v1/workers/pod' }));
});

test('WARM-POOL-REUSE-SIM: idle drained worker is quarantined and UID-pinned deleted', async () => {
  const result = await runWarmPoolReuseSimulation({ runId: `run-drain-cleanup-${randomUUID()}`,
    drainingHosts: ['pool-host-a'], seedDrainingPod: true });
  expect(result.reconcile).toMatchObject({ target: 0, ready: 0, failed: [] });
  expect(result.deletedPodUid).toBe('drained-pod-uid');
  expect(result.selection).toMatchObject({ selected: false, transport: 'fallback', reason: 'no-candidate' });
  expect(result.controlRequests).toContainEqual(expect.objectContaining({
    path: '/v1/leases/pod-worker/warm-pool-host-a-standard-1-generation-1/retire', status: 200 }));
});

test('WARM-POOL-REUSE-SIM: assembled drain config retains another host through production selection', async () => {
  const digest = `sha256:${'d'.repeat(64)}`;
  const assembled = assembleWarmPoolProviderConfig({
    config: { pod: { warmPoolProfile: 'gate', warmPool: { namespace: 'elanous-test',
      imageRepository: 'registry.example/elanous', imageDigest: digest, lockHash: 'e'.repeat(64),
      architecture: 'amd64', hostProbeUrl: 'http://host.orb.internal:10001/health',
      prodProbeUrl: 'http://core.elanous-prod:10002/', sourceUrl: 'https://github.com/ElanvitalAI/elanous.git',
      drainingHosts: ['pool-host-a'], templates: [
        { host: 'pool-host-a', tier: 'standard', nodeName: 'pool-host-a-server-0' },
        { host: 'pool-host-b', tier: 'standard', nodeName: 'pool-host-a-server-0' },
      ] } }, harness: { imageCommit: 'f'.repeat(40), podPool: 'pool-host-a-context' } },
    controlUrl: 'https://control.example:8413', memberToken: 'a'.repeat(64),
    machineTokens: { 'pool-host-a': 'b'.repeat(64), 'pool-host-b': 'c'.repeat(64) },
  });
  expect(assembled.poolTemplates.map(row => row.host)).toEqual(['pool-host-a', 'pool-host-b']);
  expect(assembled.drainingHosts).toEqual(['pool-host-a']);
  const result = await runWarmPoolReuseSimulation({ runId: `run-assembled-drain-${randomUUID()}`,
    providerConfig: assembled });
  expect(result.reconcile).toMatchObject({ target: 1, ready: 1, failed: [] });
  expect(result.selection).toMatchObject({ selected: true, transport: 'observed', reason: 'complete',
    workerId: expect.stringMatching(/^warm-pool-host-b-/) });
});
