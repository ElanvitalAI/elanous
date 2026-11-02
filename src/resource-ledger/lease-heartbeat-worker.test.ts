import { expect, test } from 'bun:test';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readResourceLedger, resourceLedgerPath } from './resource-ledger.js';
import { resourceLeaseHeartbeatInterval, startResourceLeaseHeartbeatWorker, withBlockingResourceLease } from './lease-heartbeat-worker.js';

test('mock clock advances the worker lease while the owner thread is blocked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lease-heartbeat-clock-'));
  const path = resourceLedgerPath(root);
  const startMs = Date.parse('2026-11-02T00:00:00.000Z');
  const clockBuffer = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
  const clock = new BigInt64Array(clockBuffer);
  Atomics.store(clock, 0, BigInt(startMs));
  const heartbeatBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const doneBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const done = new Int32Array(doneBuffer);
  let clockDriver: Worker | undefined;
  try {
    const result = await withBlockingResourceLease({ host: 'aws2', lane: 'gate', ttlMs: 60_000,
      resources: { shards: 1 }, mission: { cell: 'heartbeat-evidence' } }, () => {
      clockDriver = new Worker(`
        const { workerData } = require('node:worker_threads');
        const clock = new BigInt64Array(workerData.clockBuffer);
        const heartbeats = new Int32Array(workerData.heartbeatBuffer);
        const done = new Int32Array(workerData.doneBuffer);
        for (let beat = 1; beat <= workerData.periodicBeats; beat++) {
          while (Atomics.load(heartbeats, 0) < beat) Atomics.wait(heartbeats, 0, Atomics.load(heartbeats, 0), 2_000);
          Atomics.add(clock, 0, BigInt(workerData.stepMs));
          Atomics.notify(clock, 0);
          while (Atomics.load(heartbeats, 0) < beat + 1) Atomics.wait(heartbeats, 0, Atomics.load(heartbeats, 0), 2_000);
        }
        Atomics.store(done, 0, 1);
        Atomics.notify(done, 0);
      `, { eval: true, workerData: { clockBuffer, heartbeatBuffer, doneBuffer, stepMs: 1_000, periodicBeats: 2 } });

      // Owner blocks synchronously; the clock driver advances only after each durable worker heartbeat.
      const wait = Atomics.wait(done, 0, 0, 10_000);
      expect(wait).toBe('ok');
      return 'completed';
    }, { statePath: path,
      startHeartbeat: (id, ledgerPath) => startResourceLeaseHeartbeatWorker(id, ledgerPath, {
        intervalMs: 1_000, mockClock: clockBuffer, mockHeartbeatCounter: heartbeatBuffer,
      }) });
    expect(result).toBe('completed');
    await clockDriver?.terminate();
    clockDriver = undefined;
    const events = readResourceLedger(path);
    const beats = events.filter(event => event.event === 'lease-heartbeat' && Date.parse(event.heartbeatAt) > startMs);
    expect(beats).toHaveLength(2);
    expect(events.at(-1)?.event).toBe('lease-ended');
  } finally {
    await clockDriver?.terminate();
    rmSync(root, { recursive: true, force: true });
  }
});

test('heartbeat interval stays within the lease ttl', () => {
  expect(resourceLeaseHeartbeatInterval(30_000)).toBe(10_000);
  expect(() => resourceLeaseHeartbeatInterval(29_999)).toThrow('at least 30000ms');
});

test('blocking operation fails closed when heartbeat worker startup fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lease-heartbeat-startup-'));
  const path = resourceLedgerPath(root);
  let ran = false;
  try {
    await expect(withBlockingResourceLease({ host: 'aws2', lane: 'train', ttlMs: 60_000 }, () => {
      ran = true;
    }, { statePath: path, startHeartbeat: async () => { throw new Error('worker readiness failed'); } }))
      .rejects.toThrow('worker readiness failed');
    expect(ran).toBe(false);
    expect(readResourceLedger(path).map(event => event.event)).toEqual(['lease-created', 'lease-ended']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('blocking operation reports lease end failure after successful work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lease-heartbeat-end-failure-'));
  const path = resourceLedgerPath(root);
  let ran = false;
  let endCalled = false;
  try {
    await expect(withBlockingResourceLease({ host: 'aws2', lane: 'train', ttlMs: 60_000 }, () => { ran = true; }, {
      statePath: path, startHeartbeat: async () => async () => {}, endLease: () => { endCalled = true; throw new Error('lease end failed'); },
    })).rejects.toThrow('lease end failed');
    expect(ran).toBe(true);
    expect(endCalled).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('blocking operation keeps its lease until an async callback settles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lease-heartbeat-async-'));
  const path = resourceLedgerPath(root);
  let finishOperation!: (value: string) => void;
  let stopped = false;
  try {
    const resultPromise = withBlockingResourceLease({ host: 'aws2', lane: 'train', ttlMs: 60_000 }, async () => {
      await new Promise<string>(resolve => { finishOperation = resolve; });
      return 'finished';
    }, { statePath: path, startHeartbeat: async () => async () => { stopped = true; } });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(readResourceLedger(path).map(event => event.event)).toEqual(['lease-created']);
    finishOperation('finished');
    await expect(resultPromise).resolves.toBe('finished');
    expect(stopped).toBe(true);
    expect(readResourceLedger(path).at(-1)?.event).toBe('lease-ended');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
