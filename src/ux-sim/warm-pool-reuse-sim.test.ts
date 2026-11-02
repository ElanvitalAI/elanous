import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { debug } from '../debug/log.js';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';
import { getTestStateRoot } from '../nexus/paths.js';
import { createFakePrimaryControl, runWarmPoolReuseSimulation, type WarmPoolReuseFault }
  from './warm-pool-reuse-sim.js';

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
    ['image-pin-mismatch', 'image-pin-mismatch'],
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
