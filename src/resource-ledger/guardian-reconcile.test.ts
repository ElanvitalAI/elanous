import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeGateTrainFingerprints, readActiveGateTrainFingerprints, resourceReconcileTick, startResourceReconcileLoop, RESOURCE_RECONCILE_INTERVAL_MS } from './guardian-reconcile.js';
import type { ResourceLease } from './resource-ledger.js';
import type { LogStoreRow } from '../mss/logging/log-store.js';
import { LogStore } from '../mss/logging/log-store.js';

const staleLease: ResourceLease = { id: 'fp_stale01', fp: 'fp_stale01', host: 'aws2', lane: 'gate', resources: {},
  mission: { cell: 'GATE-1' }, ttlMs: 1_000, heartbeatAt: '2026-11-01T00:00:00.000Z', startedAt: '2026-11-01T00:00:00.000Z' };

test('guardian resource tick sends measured findings and atomically reaps an absent expired lease', async () => {
  const reaped: unknown[] = [];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const report = await resourceReconcileTick({
    events: () => [{ event: 'lease-created', at: staleLease.startedAt, lease: staleLease }],
    hosts: () => [{ host: 'aws2', context: 'pool-aws2', capacity: { gate: 8 } }],
    now: () => new Date('2026-11-01T00:00:02.000Z'),
    run: (command, args) => command === 'kubectl'
      ? { status: 0, stdout: JSON.stringify({ items: args.includes('nodes') ? [{ metadata: { name: 'aws2-node' } }] : [] }), stderr: '' }
      : { status: 0, stdout: '', stderr: '' },
    reap: input => { reaped.push(input); return true; },
    cleanupExpired: true,
    log: (event, data) => { events.push({ event, data }); },
  });
  expect(reaped).toEqual([{ id: staleLease.id, expectedHeartbeatAt: staleLease.heartbeatAt,
    expectedExpiresAtMs: Date.parse(staleLease.heartbeatAt) + staleLease.ttlMs, observedAtMs: Date.parse('2026-11-01T00:00:02.000Z') }]);
  expect(report.cleanup.reaped).toEqual([{ id: staleLease.id, host: 'aws2' }]);
  expect(report.findings.map(row => row.kind)).toContain('reaped-candidate');
  expect(events).toMatchObject([{ event: 'resource-reconcile', data: { findingCounts: { stale: 1, 'reaped-candidate': 1 }, reaped: 1 } }]);
});

test('guardian resource loop ticks immediately, never overlaps, and cancels cleanly', async () => {
  let resolve!: () => void;
  let calls = 0;
  const pending = new Promise<void>(done => { resolve = done; });
  const stop = startResourceReconcileLoop({ intervalMs: 60_000, tick: async () => { calls += 1; await pending; } });
  await Promise.resolve();
  expect(calls).toBe(1);
  stop();
  resolve();
  await pending;
  expect(RESOURCE_RECONCILE_INTERVAL_MS).toBe(300_000);
});

test('guardian crosschecks active self-gate/train run fingerprints against measured ledger leases', async () => {
  const row = (id: number, event: string, data: Record<string, unknown>): LogStoreRow => ({ id, ts: '2026-11-01T00:00:01.000Z',
    ts_ms: Date.parse('2026-11-01T00:00:01.000Z'), level: 'info', instance: 'test', surface: 'test', category: 'run.fp',
    event, session_id: null, trace_id: null, data: JSON.stringify(data) });
  const fingerprints = activeGateTrainFingerprints([
    row(1, 'begin', { fp: 'fp_gate001', entrance: 'self-gate', host: 'runner', reservedHost: 'gcp1' }),
    row(2, 'begin', { fp: 'fp_train01', entrance: 'train', host: 'gcp2' }),
    row(3, 'begin', { fp: 'fp_ended01', entrance: 'self-gate', reservedHost: 'gcp1' }),
    row(4, 'end', { fp: 'fp_ended01', status: 'completed' }),
    row(5, 'begin', { fp: 'fp_ignored', entrance: 'harness-say' }),
  ]);
  expect(fingerprints).toEqual([
    { fp: 'fp_gate001', entrance: 'self-gate', host: 'runner', reservedHost: 'gcp1' },
    { fp: 'fp_train01', entrance: 'train', host: 'gcp2' },
  ]);
  const leases: ResourceLease[] = [
    { id: 'fp_gate001', fp: 'fp_gate001', host: 'gcp1', lane: 'gate', resources: {}, mission: {}, ttlMs: 60_000,
      heartbeatAt: '2026-11-01T00:00:01.000Z', startedAt: '2026-11-01T00:00:01.000Z' },
    { id: 'fp_train01', fp: 'fp_train01', host: 'gcp2', lane: 'train', resources: {}, mission: {}, ttlMs: 60_000,
      heartbeatAt: '2026-11-01T00:00:01.000Z', startedAt: '2026-11-01T00:00:01.000Z' },
    { id: 'fp_host01', fp: 'fp_host01', host: 'gcp1', lane: 'gate', resources: {}, mission: {}, ttlMs: 60_000,
      heartbeatAt: '2026-11-01T00:00:01.000Z', startedAt: '2026-11-01T00:00:01.000Z' },
  ];
  const report = await resourceReconcileTick({
    events: () => leases.map(lease => ({ event: 'lease-created' as const, at: lease.startedAt, lease })),
    hosts: () => [{ host: 'gcp1', poolMapped: true }, { host: 'gcp2', poolMapped: true }], now: () => new Date('2026-11-01T00:00:02.000Z'),
    fingerprints: () => [...fingerprints, { fp: 'fp_host01', entrance: 'self-gate' as const, reservedHost: 'gcp1' }],
    run: (command, args) => command === 'kubectl'
      ? { status: 0, stdout: JSON.stringify({ items: args.includes('nodes') ? [{ metadata: { name: 'node' } }] : [] }), stderr: '' }
      : { status: 0, stdout: '', stderr: '' },
    log: () => {},
  });
  expect(report.findings.filter(row => row.kind === 'orphan' || row.kind === 'drift')).toEqual([]);

  const drift = await resourceReconcileTick({
    events: () => leases.map(lease => ({ event: 'lease-created' as const, at: lease.startedAt,
      lease: lease.fp === 'fp_train01' ? { ...lease, lane: 'gate' as const } : lease })),
    hosts: () => [{ host: 'gcp1', poolMapped: true }, { host: 'gcp2', poolMapped: true }], now: () => new Date('2026-11-01T00:00:02.000Z'),
    fingerprints: () => [...fingerprints,
      { fp: 'fp_host01', entrance: 'self-gate' as const, reservedHost: 'gcp2' },
      { fp: 'fp_missing1', entrance: 'self-gate' as const, reservedHost: 'gcp1' }],
    run: (command, args) => command === 'kubectl'
      ? { status: 0, stdout: JSON.stringify({ items: args.includes('nodes') ? [{ metadata: { name: 'node' } }] : [] }), stderr: '' }
      : { status: 0, stdout: '', stderr: '' },
    log: () => {},
  });
  expect(drift.findings).toContainEqual(expect.objectContaining({ kind: 'drift', id: 'fp_train01',
    detail: 'train fingerprint expected=gcp2/train lease=gcp2/gate', action: 'report-only' }));
  expect(drift.findings).toContainEqual(expect.objectContaining({ kind: 'orphan', id: 'fp_missing1', fp: 'fp_missing1' }));
  expect(drift.findings).toContainEqual(expect.objectContaining({ kind: 'drift', id: 'fp_host01',
    detail: 'self-gate fingerprint expected=gcp2/gate lease=gcp1/gate', action: 'report-only' }));

  const unavailable = await resourceReconcileTick({
    events: () => [], hosts: () => [], now: () => new Date('2026-11-01T00:00:02.000Z'),
    fingerprints: () => { throw new Error('injected LogStore read failure'); }, log: () => {},
  });
  expect(unavailable.findings).toContainEqual(expect.objectContaining({ kind: 'measurement-unavailable', id: 'run.fp',
    detail: 'injected LogStore read failure', action: 'report-only' }));
});

test('LogStore paging finds an old active gate fingerprint beyond 5000 rows and drops one ended later', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-fp-crosscheck-'));
  const path = join(dir, 'logs.db');
  const writer = new LogStore(path, { instance: 'test' });
  try {
    const rows: Array<{ rec: { ts: string; category: string; event: string; data: Record<string, unknown> }; surface: string }> = [
      { rec: { ts: '2026-10-31T00:00:00.000Z', category: 'run.fp', event: 'begin', data: { fp: 'fp_oldactv1', entrance: 'self-gate', reservedHost: 'gcp1' } }, surface: 'test' },
      { rec: { ts: '2026-10-31T00:00:01.000Z', category: 'run.fp', event: 'begin', data: { fp: 'fp_oldended', entrance: 'train', host: 'gcp2' } }, surface: 'test' },
    ];
    for (let i = 0; i < 5_001; i++) rows.push({ rec: { ts: new Date(Date.parse('2026-11-01T00:00:00.000Z') + i * 1000).toISOString(),
      category: 'run.fp', event: 'begin', data: { fp: `fp_fill${String(i).padStart(5, '0')}`, entrance: 'harness-say' } }, surface: 'test' });
    rows.push({ rec: { ts: '2026-11-02T00:00:00.000Z', category: 'run.fp', event: 'end', data: { fp: 'fp_oldended', status: 'completed' } }, surface: 'test' });
    writer.insertBatch(rows);
  } finally { writer.close(); }
  try {
    const reader = LogStore.openReadOnly(path);
    try {
      expect(readActiveGateTrainFingerprints(reader)).toEqual([
        { fp: 'fp_oldactv1', entrance: 'self-gate', reservedHost: 'gcp1' },
      ]);
    } finally { reader.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
