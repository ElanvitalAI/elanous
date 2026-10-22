import { expect, test } from 'bun:test';
import { handleLoopResourcesGet, observeLoopResources } from './loop-resources.js';
import { trafficTick } from '../../loops/orchestrator/traffic.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { ensureControlTokens, startControlServer } from '../../control-plane/server.js';
import { issueMemberToken } from '../../control-plane/member-tokens.js';

const now = new Date('2026-10-05T00:00:00Z');
const result = trafficTick({ now, caps: { OP: 2, TC: 4, MK: 6, UX: 2 }, totalSlots: 14,
  processes: [{ seat: 'MK', elapsedSeconds: 2400, command: 'bun bin/elanous.mjs harness ask goal' }],
  openCells: [{ owner: 'MK', status: 'yellow', id: 'MK-1', title: 'next job' }], nextRound: [] });

test('production observation returns pending MK work with no running processes and no launch approval', async () => {
  const cell = { id: 'MK-WAIT', title: 'waiting work', owner: 'MK', status: 'yellow' as const };
  const response = handleLoopResourcesGet(() => observeLoopResources({
    now, processes: { status: 'ok', records: [], excludedCount: 0 }, version: '0.2.28',
    openCells: [cell], nextRound: [], totalSlots: 0,
  }), () => []);
  expect(response.status).toBe(200);
  const body = await response.json() as { resource: { seats: Array<{ seat: string; running: number; idle: boolean;
    nextCell: { id: string } | null }> } };
  expect(body.resource.seats.find(row => row.seat === 'MK')).toMatchObject({
    running: 0, idle: false, nextCell: { id: 'MK-WAIT' },
  });
});

test('a blank waiting cell id is served as no cell, so the API and the PWA screen cannot name different cells', async () => {
  const unnamed = trafficTick({ now, caps: { OP: 2, TC: 4, MK: 6, UX: 2 }, totalSlots: 14,
    processes: [{ seat: 'MK', elapsedSeconds: 2400, command: 'bun bin/elanous.mjs harness ask goal' }],
    openCells: [{ owner: 'MK', status: 'yellow', id: '   ', title: 'unnamed work' }], nextRound: [] });
  expect(unnamed.seats.find(row => row.seat === 'MK')?.nextCell?.id).toBe('   ');
  const response = handleLoopResourcesGet(() => unnamed, () => []);
  expect(response.status).toBe(200);
  const body = await response.json() as { resource: { seats: Array<{ seat: string; nextCell: { id: string } | null }> } };
  expect(body.resource.seats.find(row => row.seat === 'MK')?.nextCell).toBeNull();
});

test('resource GET returns the actual traffic decision without writing a new ledger shape', async () => {
  const response = handleLoopResourcesGet(() => result, () => []);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ resource: JSON.parse(JSON.stringify(result)), podWorkers: [] });
  const failed = handleLoopResourcesGet(() => { throw Error('observation unavailable'); }, () => []);
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ error: 'resource-unavailable' });
  const workersFailed = handleLoopResourcesGet(() => result, () => { throw Error('ledger unreadable'); });
  expect(workersFailed.status).toBe(200);
  expect(await workersFailed.json()).toEqual({ resource: JSON.parse(JSON.stringify(result)), podWorkers: null, podWorkersError: 'unmeasured' });
});

test('Nexus default view reads the same ledger that the real control API writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-warm-ledger-'));
  setElanousConfigDir(root);
  const control = startControlServer({ root, port: 0, leaseView: { async get() {
    return { holder: 'local', generation: 1, iAmHolder: true, known: true };
  } } });
  try {
    const tokens = ensureControlTokens(root);
    const host = issueMemberToken('node-c', root);
    const key = { context: 'node-c', imageDigest: 'sha256:image', lockHash: 'lock', architecture: 'arm64' };
    const post = (path: string, token: string, body: unknown) => fetch(`${control.url}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await post('/v1/workers/pod', host, { workerId: 'worker-1', machine: 'node-c', podUid: 'pod-uid-1', key, ttlMs: 30_000 })).status).toBe(200);
    const leased = await post('/v1/leases/pod-worker', tokens.member, { machine: 'node-c', key, runId: 'run', attemptId: 'attempt', ttlMs: 10_000 });
    expect(leased.status).toBe(200);
    const lease = await leased.json() as { attrs: { leaseId: string } };
    const response = handleLoopResourcesGet(() => result);
    const body = await response.json() as { podWorkers: Array<{ id: string; state: string; generation: number }> };
    expect(body.podWorkers).toEqual([expect.objectContaining({ id: 'pod-worker-lease:worker-1', state: 'leased', generation: 1 })]);
    expect(JSON.stringify(body)).not.toContain(lease.attrs.leaseId);
  } finally {
    control.stop();
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Nexus resource view exposes the existing warm worker lease state without its lease token', async () => {
  const response = handleLoopResourcesGet(() => result, () => [{
    id: 'pod-worker-lease:worker-1', kind: 'pod-worker-lease', machine: 'node-c', name: 'worker-1', owner: 'owner',
    attrs: { key: { context: 'node-c', imageDigest: 'sha256:image', lockHash: 'lock', architecture: 'arm64' },
      state: 'leased', generation: 2, leaseId: 'secret-lease', leaseOwner: 'secret-owner' },
    observedAt: 100, ttlMs: 1000, ageMs: 5, expired: false,
  }]);
  const body = await response.json() as { podWorkers: Array<Record<string, unknown>> };
  expect(body.podWorkers).toEqual([{ id: 'pod-worker-lease:worker-1', machine: 'node-c', workerId: 'worker-1',
    key: { context: 'node-c', imageDigest: 'sha256:image', lockHash: 'lock', architecture: 'arm64' },
    state: 'leased', generation: 2, ageMs: 5, expired: false }]);
  expect(JSON.stringify(body)).not.toContain('secret-lease');
});
