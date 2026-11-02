import { expect, test } from 'bun:test';
import { buildResourceLedgerSnapshot } from './resource-ledger-cli.js';

test('remote gate process title is matched back to its active resource lease by the ps observer', () => {
  const fp = 'fp_remote123';
  const lease = { id: fp, fp, host: 'aws2', lane: 'gate' as const, resources: { shards: 1 }, mission: { cell: 'self-gate' },
    ttlMs: 120_000, heartbeatAt: '2026-11-02T00:00:00.000Z', startedAt: '2026-11-02T00:00:00.000Z' };
  const result = buildResourceLedgerSnapshot({
    events: () => [{ event: 'lease-created', at: lease.startedAt, lease }],
    hosts: () => [{ host: 'aws2', poolMapped: true }],
    now: () => new Date('2026-11-02T00:00:01.000Z'),
    run: (command, args) => command === 'ps'
      ? { status: 0, stdout: `321 1 bun bin/elanous.mjs self gate --resource-fp ${fp}\n`, stderr: '' }
      : { status: 0, stdout: JSON.stringify({ items: args.includes('nodes') ? [{ metadata: { name: 'aws2-node' } }] : [] }), stderr: '' },
  });
  expect(result.matrix.find(row => row.host === 'aws2' && row.lane === 'gate')?.measuredProcesses).toBe(1);
});

test('remote TA resource events are imported from the parent host state root', () => {
  const fp = 'fp_remoteTA123';
  const lease = { id: fp, fp, host: 'aws2', lane: 'ta', resources: { pods: 1 }, mission: { cell: 'TA-CELL' },
    ttlMs: 120_000, heartbeatAt: '2026-11-02T00:00:00.000Z', startedAt: '2026-11-02T00:00:00.000Z' };
  const result = buildResourceLedgerSnapshot({
    events: () => [],
    hosts: () => [{ host: 'aws2', poolMapped: true, stateDir: '$HOME/.elanous' }],
    now: () => new Date('2026-11-02T00:00:01.000Z'),
    run: (command, args) => command === 'cat'
      ? { status: 0, stdout: `${JSON.stringify({ event: 'lease-created', at: lease.startedAt, lease })}\n`, stderr: '' }
      : command === 'ps' ? { status: 0, stdout: `321 1 elanous-resource-lease ${fp}\n`, stderr: '' }
        : { status: 0, stdout: JSON.stringify({ items: args.includes('nodes') ? [{ metadata: { name: 'aws2-node' } }] : [] }), stderr: '' },
  });
  expect(result.leases).toMatchObject([{ fp, host: 'aws2', lane: 'ta', mission: { cell: 'TA-CELL' } }]);
});


test('snapshot exposes the latest recorded lease end and reclaim reasons', () => {
  const fp = 'fp_history123';
  const lease = { id: fp, fp, host: 'gcp1', lane: 'ta' as const, resources: { pods: 1 }, mission: { cell: 'TA-CELL' },
    ttlMs: 1000, heartbeatAt: '2026-11-02T00:00:00.000Z', startedAt: '2026-11-02T00:00:00.000Z' };
  const events = [
    { event: 'lease-created' as const, at: lease.startedAt, lease },
    { event: 'lease-reaped' as const, at: '2026-11-02T00:00:02.000Z', id: fp, expectedHeartbeatAt: lease.heartbeatAt,
      expectedExpiresAt: '2026-11-02T00:00:01.000Z', observedAt: '2026-11-02T00:00:02.000Z', reason: 'expired-and-absent' as const },
  ];
  const result = buildResourceLedgerSnapshot({ events: () => events, hosts: () => [{ host: 'gcp1', poolMapped: true }],
    now: () => new Date('2026-11-02T00:00:03.000Z'),
    run: (_command, args) => ({ status: 0, stdout: JSON.stringify({ items: args.includes('nodes') ? [{ metadata: { name: 'gcp1-node' } }] : [] }), stderr: '' }),
  });
  expect(result.recentReclaims).toEqual([{ id: fp, fp, host: 'gcp1', lane: 'ta', at: '2026-11-02T00:00:02.000Z',
    kind: 'lease-reaped', reason: 'expired-and-absent', stoppedBy: 'guardian-reconcile' }]);
});

test('recent reclaim view filters by host, lane, and mission and keeps only the newest 20', () => {
  const at = '2026-11-02T00:00:00.000Z';
  const events = Array.from({ length: 21 }, (_, index) => {
    const fp = 'fp_history' + String(index).padStart(4, '0');
    const lease = { id: fp, fp, host: index % 2 ? 'aws2' : 'gcp1', lane: (index % 3 ? 'gate' : 'ta') as 'gate' | 'ta',
      resources: {}, mission: { cell: index % 2 ? 'TARGET' : 'OTHER' }, ttlMs: 1000, heartbeatAt: at, startedAt: at };
    return [
      { event: 'lease-created' as const, at, lease },
      { event: 'lease-ended' as const, at: new Date(Date.parse(at) + index * 1000).toISOString(), id: fp, reason: 'test', stoppedBy: 'test' },
    ];
  }).flat();
  const deps = { events: () => events, hosts: () => [{ host: 'aws2', poolMapped: true }, { host: 'gcp1', poolMapped: true }],
    now: () => new Date('2026-11-02T01:00:00.000Z'),
    run: (_command: string, args: string[]) => ({ status: 0, stdout: JSON.stringify({ items: args.includes('nodes') ? [{ metadata: { name: 'node' } }] : [] }), stderr: '' }) };
  const recent = buildResourceLedgerSnapshot(deps);
  expect(recent.recentReclaims).toHaveLength(20);
  expect(recent.recentReclaims[0]?.id).toBe('fp_history0020');
  const filtered = buildResourceLedgerSnapshot(deps, { host: 'aws2', lane: 'gate', mission: 'TARGET' });
  expect(filtered.recentReclaims.length).toBeGreaterThan(0);
  expect(filtered.recentReclaims.map(row => row.id)).toEqual([
    'fp_history0019', 'fp_history0017', 'fp_history0013', 'fp_history0011',
    'fp_history0007', 'fp_history0005', 'fp_history0001',
  ]);
});
