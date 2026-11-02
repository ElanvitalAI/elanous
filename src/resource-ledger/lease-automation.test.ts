import { expect, test } from 'bun:test';
import { reconcileLeaseCleanup, startLeaseHeartbeat } from './lease-automation.js';

test('heartbeat uses the configured interval, isolates errors, and stops idempotently', async () => {
  let tick: (() => void | Promise<void>) | undefined;
  let interval = 0;
  let cancelled = 0;
  let beats = 0;
  const errors: string[] = [];
  const stop = startLeaseHeartbeat({ leaseId: 'fp_run001', ttlMs: 60_000, intervalMs: 30_000,
    heartbeat: async id => { expect(id).toBe('fp_run001'); beats += 1; if (beats === 1) throw new Error('disk unavailable'); },
    onError: async (id, error) => { errors.push(`${id}:${String(error)}`); },
    schedule: (callback, ms) => { tick = callback; interval = ms; return () => { cancelled += 1; }; },
  });
  expect(interval).toBe(30_000);
  await tick!();
  await tick!();
  expect(beats).toBe(2);
  expect(errors).toEqual(['fp_run001:Error: disk unavailable']);
  stop(); stop(); await tick!();
  expect(cancelled).toBe(1);
  expect(beats).toBe(2);
});

test('heartbeat rejects an interval that can expire the lease', () => {
  expect(() => startLeaseHeartbeat({ leaseId: 'fp_run001', ttlMs: 30_000, intervalMs: 30_000, heartbeat: () => {} }))
    .toThrow(/shorter than ttlMs/);
});

test('heartbeat does not overlap an unresolved asynchronous beat', async () => {
  let tick: (() => void | Promise<void>) | undefined;
  let release!: () => void;
  let beats = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const stop = startLeaseHeartbeat({ leaseId: 'fp_run001', ttlMs: 60_000, intervalMs: 30_000,
    heartbeat: async () => { beats += 1; await pending; },
    schedule: callback => { tick = callback; return () => {}; },
  });
  const first = tick!();
  await tick!();
  expect(beats).toBe(1);
  release();
  await first;
  stop();
});

test('a pending error observer does not prevent the next heartbeat', async () => {
  let tick: (() => void | Promise<void>) | undefined;
  let beats = 0;
  const stop = startLeaseHeartbeat({ leaseId: 'fp_run001', ttlMs: 60_000, intervalMs: 30_000,
    heartbeat: async () => { beats += 1; throw new Error('renewal failed'); },
    onError: () => new Promise<void>(() => {}),
    schedule: callback => { tick = callback; return () => {}; },
  });
  await tick!();
  await tick!();
  expect(beats).toBe(2);
  stop();
});

test('cleanup defaults to report-only and only records confirmed reaped candidates', async () => {
  const findings = [
    { kind: 'stale', id: 'fp_not_expired', host: 'gcp1', leaseHeartbeatAt: new Date(1_001).toISOString(), leaseExpiresAtMs: 2_001, observedAtMs: 2_000, resourcePresent: false },
    { kind: 'stale', id: 'fp_still_present', host: 'gcp1', leaseHeartbeatAt: new Date(0).toISOString(), leaseExpiresAtMs: 1_000, observedAtMs: 2_000, resourcePresent: true },
    { kind: 'stale', id: 'fp_reaped', host: 'gcp1', leaseHeartbeatAt: new Date(0).toISOString(), leaseExpiresAtMs: 1_000, observedAtMs: 2_000, resourcePresent: false },
    { kind: 'stale', id: 'fp_reaped', host: 'gcp1', leaseHeartbeatAt: new Date(0).toISOString(), leaseExpiresAtMs: 1_000, observedAtMs: 2_000, resourcePresent: false },
    { kind: 'orphan', id: 'pod-1', host: 'gcp1' },
    { kind: 'measurement-unavailable', id: 'gcp2', host: 'gcp2' },
  ];
  let dryRunRecorderCalls = 0;
  const dryRun = await reconcileLeaseCleanup({ findings, nowMs: 2_000, recordReaped: () => { dryRunRecorderCalls++; return true; } });
  expect(dryRun).toMatchObject({ mode: 'dry-run', candidates: [{ id: 'fp_reaped', host: 'gcp1', expectedLeaseHeartbeatAt: new Date(0).toISOString() }], reaped: [], mutations: [] });
  expect(dryRunRecorderCalls).toBe(0);

  const applied: string[] = [];
  const cleanup = await reconcileLeaseCleanup({ findings, mode: 'cleanup', nowMs: 2_000, recordReaped: async item => { await Promise.resolve(); applied.push(`${item.host}:${item.id}`); return true; } });
  expect(applied).toEqual(['gcp1:fp_reaped']);
  expect(cleanup).toMatchObject({ mode: 'cleanup', reaped: [{ id: 'fp_reaped', host: 'gcp1' }], mutations: ['lease-reaped:gcp1:fp_reaped'] });
});

test('cleanup records per-candidate failures and requires an explicit recorder', async () => {
  const findings = [
    { kind: 'stale', id: 'fp_1', host: 'gcp1', leaseHeartbeatAt: new Date(0).toISOString(), leaseExpiresAtMs: 1, observedAtMs: 2, resourcePresent: false },
    { kind: 'stale', id: 'fp_2', host: 'gcp2', leaseHeartbeatAt: new Date(0).toISOString(), leaseExpiresAtMs: 1, observedAtMs: 2, resourcePresent: false },
  ];
  await expect(reconcileLeaseCleanup({ findings, mode: 'cleanup' })).rejects.toThrow(/requires recordReaped/);
  const result = await reconcileLeaseCleanup({ findings, mode: 'cleanup', nowMs: 2, recordReaped: async ({ id }) => { await Promise.resolve(); if (id === 'fp_2') throw new Error('append failed'); return true; } });
  expect(result.reaped).toEqual([{ id: 'fp_1', host: 'gcp1' }]);
  expect(result.errors).toEqual([{ id: 'fp_2', host: 'gcp2', detail: 'append failed' }]);
});

test('cleanup rejects future measurements and reports a lease renewed before atomic recording', async () => {
  const findings = [
    { kind: 'stale', id: 'future', host: 'gcp1', leaseHeartbeatAt: new Date(0).toISOString(), leaseExpiresAtMs: 1, observedAtMs: 3, resourcePresent: false },
    { kind: 'stale', id: 'renewed', host: 'gcp1', leaseHeartbeatAt: new Date(0).toISOString(), leaseExpiresAtMs: 1, observedAtMs: 2, resourcePresent: false },
    { kind: 'stale', id: 'unversioned', host: 'gcp1', leaseExpiresAtMs: 1, observedAtMs: 2, resourcePresent: false },
  ];
  const seen: string[] = [];
  const result = await reconcileLeaseCleanup({ findings, mode: 'cleanup', nowMs: 2,
    recordReaped: async candidate => { seen.push(`${candidate.id}:${candidate.expectedLeaseHeartbeatAt}`); return false; },
  });
  expect(seen).toEqual([`renewed:${new Date(0).toISOString()}`]);
  expect(result.reaped).toEqual([]);
  expect(result.skipped).toEqual([{ id: 'renewed', host: 'gcp1' }]);
});

test('cleanup rejects invalid clock values', async () => {
  await expect(reconcileLeaseCleanup({ findings: [], nowMs: Number.NaN })).rejects.toThrow(/safe integer nowMs/);
});
