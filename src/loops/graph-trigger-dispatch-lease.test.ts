import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Database } from 'bun:sqlite';
import { claimGraphTriggerDispatchLease, getGraphTriggerDispatchBinding, releaseGraphTriggerDispatchLease,
  renewGraphTriggerDispatchLease, withGraphTriggerDispatchLeaseFence } from './graph-trigger-dispatch-lease.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'graph-trigger-lease-'));
  roots.push(root);
  return root;
}

test('graph trigger dispatch lease is run-bound, renews, expires and can be reacquired safely', () => {
  const stateRoot = fixture();
  const input = { triggerId: 'webhook', dedupeKey: 'event-17', graphId: 'orders', runId: 'run-17' };
  const firstResult = claimGraphTriggerDispatchLease(input, { registryRoot: stateRoot, stateRoot, now: () => 100, leaseMs: 10 });
  expect(firstResult.claimed).toBe(true);
  if (!firstResult.claimed) throw new Error('first lease claim unexpectedly failed');
  const first = firstResult.lease;
  expect(first).toMatchObject({ ...input, registryRoot: resolve(stateRoot), stateRoot: resolve(stateRoot), expiresAt: 110 });

  const duplicate = claimGraphTriggerDispatchLease(input, { registryRoot: stateRoot, stateRoot, now: () => 109, leaseMs: 10 });
  expect(duplicate).toMatchObject({ claimed: false, lease: { expiresAt: 110 } });
  expect('owner' in duplicate.lease).toBe(false);
  expect(renewGraphTriggerDispatchLease(first, { now: () => 109, leaseMs: 10 })).toBe(true);

  const recoveredResult = claimGraphTriggerDispatchLease(input, { registryRoot: stateRoot, stateRoot, now: () => 120, leaseMs: 10 });
  expect(recoveredResult.claimed).toBe(true);
  if (!recoveredResult.claimed) throw new Error('expired lease was not recovered');
  const recovered = recoveredResult.lease;
  expect(recovered).toMatchObject({ ...input, registryRoot: resolve(stateRoot), stateRoot: resolve(stateRoot), expiresAt: 130 });
  expect(recovered.owner).not.toBe(first.owner);
  expect(recoveredResult.reclaimedOwner).toBe(first.owner);
  releaseGraphTriggerDispatchLease(first);
  expect(renewGraphTriggerDispatchLease(first, { now: () => 121, leaseMs: 10 })).toBe(false);
  const stillHeld = claimGraphTriggerDispatchLease(input, { registryRoot: stateRoot, stateRoot, now: () => 121, leaseMs: 10 });
  expect(stillHeld).toMatchObject({ claimed: false, lease: { expiresAt: 130 } });
  expect('owner' in stillHeld.lease).toBe(false);
});

test('distinct trigger keys may resume the same run and fenced persistence rejects an expired owner', () => {
  const registryRoot = fixture();
  const stateRoot = fixture();
  const firstInput = { triggerId: 'webhook', dedupeKey: 'delivery-a', graphId: 'orders', runId: 'shared-run' };
  const first = claimGraphTriggerDispatchLease(firstInput, { registryRoot, stateRoot, now: () => 100, leaseMs: 10 });
  expect(first.claimed).toBe(true);
  if (!first.claimed) throw new Error('first lease claim unexpectedly failed');
  const otherDelivery = claimGraphTriggerDispatchLease({ ...firstInput, triggerId: 'schedule', dedupeKey: 'delivery-b' },
    { registryRoot, stateRoot, now: () => 100, leaseMs: 10 });
  expect(otherDelivery.claimed).toBe(true);
  expect(getGraphTriggerDispatchBinding({ triggerId: firstInput.triggerId, dedupeKey: firstInput.dedupeKey, graphId: firstInput.graphId },
    { registryRoot })).toMatchObject({ runId: 'shared-run', stateRoot: resolve(stateRoot) });

  const reclaimed = claimGraphTriggerDispatchLease(firstInput, { registryRoot, stateRoot, now: () => 111, leaseMs: 10 });
  expect(reclaimed.claimed).toBe(true);
  if (!reclaimed.claimed) throw new Error('expired lease was not reclaimed');
  let writes = 0;
  expect(() => withGraphTriggerDispatchLeaseFence(first.lease, () => { writes += 1; }, { now: () => 112 }))
    .toThrow('graph trigger dispatch lease lost');
  withGraphTriggerDispatchLeaseFence(reclaimed.lease, () => { writes += 1; }, { now: () => 112 });
  expect(writes).toBe(1);
});

test('graph trigger dispatch lease keeps the original runId for a retried trigger key', () => {
  const stateRoot = fixture();
  const input = { triggerId: 'api', dedupeKey: 'request-9', graphId: 'orders', runId: 'run-9' };
  claimGraphTriggerDispatchLease(input, { registryRoot: stateRoot, stateRoot, now: () => 100, leaseMs: 10 });
  const retry = claimGraphTriggerDispatchLease({ ...input, runId: 'different-run' }, { registryRoot: stateRoot, stateRoot, now: () => 111, leaseMs: 10 });
  expect(retry.claimed).toBe(true);
  if (retry.claimed) expect(retry.lease.runId).toBe('run-9');
});

test('graph trigger run binding survives a changed state root in its shared registry', () => {
  const registryRoot = fixture();
  const firstStateRoot = fixture();
  const changedStateRoot = fixture();
  const input = { triggerId: 'schedule', dedupeKey: 'tick-1', graphId: 'daily', runId: 'run-tick-1' };
  const first = claimGraphTriggerDispatchLease(input, { registryRoot, stateRoot: firstStateRoot, now: () => 100, leaseMs: 10 });
  expect(first.claimed).toBe(true);
  expect(() => claimGraphTriggerDispatchLease(input, {
    registryRoot, stateRoot: changedStateRoot, now: () => 111, leaseMs: 10,
  })).toThrow('graph trigger dispatch binding conflict');
});

test('graph trigger lease evaluates expiration after waiting for the SQLite write lock', async () => {
  const registryRoot = fixture();
  const input = { triggerId: 'event', dedupeKey: 'event-12', graphId: 'orders', runId: 'run-event-12' };
  const first = claimGraphTriggerDispatchLease(input, { registryRoot, stateRoot: registryRoot, now: Date.now, leaseMs: 100 });
  expect(first.claimed).toBe(true);
  const dbPath = join(registryRoot, 'graph-trigger-registry.db');
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { Database } = require('bun:sqlite');
    const db = new Database(workerData.path);
    db.exec('BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    // Source: hold beyond the lease window to cover a lock wait that crosses expiration.
    setTimeout(() => { db.exec('COMMIT'); db.close(); parentPort.postMessage('released'); }, 300);
  `, { eval: true, workerData: { path: dbPath } });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once('message', message => message === 'locked' ? resolve() : reject(new Error(`unexpected worker message: ${String(message)}`)));
      worker.once('error', reject);
    });
    const afterWait = claimGraphTriggerDispatchLease(input, { registryRoot, stateRoot: registryRoot, leaseMs: 100 });
    expect(afterWait.claimed).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`lease lock worker exited ${code}`)));
      worker.once('error', reject);
    });
    await worker.terminate();
  }
});

test('graph trigger renewal cannot revive a lease after waiting past expiration', async () => {
  const registryRoot = fixture();
  const input = { triggerId: 'event', dedupeKey: 'event-renew', graphId: 'orders', runId: 'run-event-renew' };
  const claimed = claimGraphTriggerDispatchLease(input, { registryRoot, stateRoot: registryRoot, leaseMs: 100 });
  expect(claimed.claimed).toBe(true);
  if (!claimed.claimed) throw new Error('initial lease claim unexpectedly failed');
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { Database } = require('bun:sqlite');
    const db = new Database(workerData.path);
    db.exec('BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    // Source: hold beyond the initial lease so renewal must observe expiry after lock acquisition.
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);
  `, { eval: true, workerData: { path: join(registryRoot, 'graph-trigger-registry.db') } });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once('message', message => message === 'locked' ? resolve() : reject(new Error(`unexpected worker message: ${String(message)}`)));
      worker.once('error', reject);
    });
    expect(renewGraphTriggerDispatchLease(claimed.lease, { leaseMs: 100 })).toBe(false);
  } finally {
    await worker.terminate();
  }
});

test('simultaneous first dispatch claims from separate SQLite connections have one owner', async () => {
  const registryRoot = fixture();
  const input = { triggerId: 'webhook', dedupeKey: 'concurrent-first', graphId: 'orders', runId: 'concurrent-run' };
  claimGraphTriggerDispatchLease(input, { registryRoot, stateRoot: registryRoot });
  const db = new Database(join(registryRoot, 'graph-trigger-registry.db'));
  try {
    db.query('DELETE FROM graph_trigger_dispatch_leases WHERE trigger_id = ? AND dedupe_key = ?').run(input.triggerId, input.dedupeKey);
  } finally { db.close(); }
  const lock = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { Database } = require('bun:sqlite');
    const db = new Database(workerData.path);
    db.exec('BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    parentPort.once('message', message => {
      if (message === 'release') { db.exec('COMMIT'); db.close(); parentPort.postMessage('released'); }
    });
  `, { eval: true, workerData: { path: join(registryRoot, 'graph-trigger-registry.db') } });
  const moduleUrl = new URL('./graph-trigger-dispatch-lease.ts', import.meta.url).href;
  let claimWorker: Worker | undefined;
  let secondClaimWorker: Worker | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      lock.once('message', message => message === 'locked' ? resolve() : reject(new Error(`unexpected lock message: ${String(message)}`)));
      lock.once('error', reject);
    });
    const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { claimGraphTriggerDispatchLease } = await import(workerData.moduleUrl);
      parentPort.postMessage('ready');
      await new Promise(resolve => parentPort.once('message', resolve));
      parentPort.postMessage('claiming');
      const result = claimGraphTriggerDispatchLease(workerData.input, {
        registryRoot: workerData.registryRoot, stateRoot: workerData.registryRoot,
      });
      parentPort.postMessage({ claimed: result.claimed });
    })().catch(error => { parentPort.postMessage({ error: String(error) }); process.exitCode = 1; });
  `;
    claimWorker = new Worker(workerSource, { eval: true, workerData: { moduleUrl, input, registryRoot } });
    secondClaimWorker = new Worker(workerSource, { eval: true, workerData: { moduleUrl, input, registryRoot } });
    const ready = (worker: Worker) => new Promise<void>((resolve, reject) => {
      worker.once('message', message => message === 'ready' ? resolve() : reject(new Error(`unexpected claim message: ${String(message)}`)));
      worker.once('error', reject);
    });
    await Promise.all([ready(claimWorker), ready(secondClaimWorker)]);
    claimWorker.postMessage('go');
    secondClaimWorker.postMessage('go');
    const claiming = (worker: Worker) => new Promise<void>((resolve, reject) => {
      worker.once('message', message => message === 'claiming' ? resolve() : reject(new Error(`unexpected claim message: ${String(message)}`)));
      worker.once('error', reject);
    });
    await Promise.all([claiming(claimWorker), claiming(secondClaimWorker)]);
    lock.postMessage('release');
    const result = (worker: Worker) => new Promise<boolean>((resolve, reject) => {
      worker.once('message', message => {
        if (typeof message === 'object' && message !== null && 'claimed' in message) resolve(Boolean((message as { claimed: unknown }).claimed));
        else reject(new Error(`unexpected claim result: ${String(message)}`));
      });
      worker.once('error', reject);
    });
    const results = await Promise.all([result(claimWorker), result(secondClaimWorker)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  } finally {
    await Promise.all([lock, claimWorker, secondClaimWorker].filter((worker): worker is Worker => worker !== undefined).map(worker => worker.terminate()));
  }
});
