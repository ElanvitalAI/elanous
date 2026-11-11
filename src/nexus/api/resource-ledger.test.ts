import { expect, test } from 'bun:test';
import { handleResourceLedgerHostReadinessPost } from './resource-ledger.js';
import type { HostReadinessHeartbeat } from '../../resource-ledger/resource-ledger.js';

const heartbeat = {
  at: '2026-11-11T11:00:00.000Z', sshAvailable: true, maintenance: false, gateProtected: false,
  tools: { bun: true }, sample: { loadPercent: 10, load15Percent: 20, memoryAvailablePercent: 50, rootDiskUsedPercent: 60, tmpDiskUsedPercent: 60 },
};

test('machine heartbeat endpoint binds host identity to the authenticated machine', async () => {
  let recorded: HostReadinessHeartbeat | undefined;
  const record = (value: HostReadinessHeartbeat) => { recorded = value; };
  const mismatch = await handleResourceLedgerHostReadinessPost(new Request('https://nexus.test/v1/resource-ledger/host-readiness', {
    method: 'POST', body: JSON.stringify({ ...heartbeat, host: 'aws1' }),
  }), 'minim5', record);
  expect(mismatch.status).toBe(403);
  expect(recorded).toBeUndefined();

  const accepted = await handleResourceLedgerHostReadinessPost(new Request('https://nexus.test/v1/resource-ledger/host-readiness', {
    method: 'POST', body: JSON.stringify(heartbeat),
  }), 'minim5', record);
  expect(accepted.status).toBe(201);
  expect(accepted.headers.get('cache-control')).toBe('no-store');
  expect(recorded).toEqual({ ...heartbeat, host: 'minim5' });
});
