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
