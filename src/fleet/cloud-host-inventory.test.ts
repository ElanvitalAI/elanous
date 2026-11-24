import { expect, test } from 'bun:test';
import { cloudHostInventory } from './cloud-host-inventory.js';

test('census includes stopped and protected machines and exposes provider failure', async () => {
  const snapshot = await cloudHostInventory(async command => command === 'aws'
    ? { status: 0, stdout: JSON.stringify({ Reservations: [{ Instances: [{ InstanceId: 'i-fake', State: { Name: 'stopped' }, Tags: [{ Key: 'Name', Value: 'elanous-aws1' }] }] }] }) }
    : { status: 0, stdout: JSON.stringify([{ id: '123', name: 'elanous-members', status: 'RUNNING' }]) });
  expect(snapshot.hosts).toEqual([
    { provider: 'aws', id: 'i-fake', name: 'elanous-aws1', state: 'stopped', protected: null },
    { provider: 'gcp', id: '123', name: 'elanous-members', state: 'running', protected: true },
  ]);
  const failed = await cloudHostInventory(async command => command === 'aws' ? { status: 1, stdout: '' } : { status: 0, stdout: '[]' });
  expect(failed.providers).toEqual([{ provider: 'aws', status: 'unavailable' }, { provider: 'gcp', status: 'measured' }]);
});


test('malformed AWS reservations are unavailable, never an empty measured inventory', async () => {
  const result = await cloudHostInventory(async command => command === 'aws'
    ? { status: 0, stdout: JSON.stringify({ Reservations: [{ Instances: null }] }) }
    : { status: 0, stdout: '[]' });
  expect(result.providers).toEqual([{ provider: 'aws', status: 'unavailable' }, { provider: 'gcp', status: 'measured' }]);
});

test('status fails closed on missing providers and duplicate names', async () => {
  const { findCloudHost } = await import('./cloud-host-inventory.js');
  const hosts = [
    { provider: 'aws' as const, id: 'i-1', name: 'shared', state: 'running', protected: null },
    { provider: 'gcp' as const, id: '2', name: 'shared', state: 'stopped', protected: null },
  ];
  const providers = [{ provider: 'aws' as const, status: 'measured' as const }, { provider: 'gcp' as const, status: 'measured' as const }];
  expect(findCloudHost({ hosts, providers }, 'shared').status).toBe('ambiguous');
  expect(findCloudHost({ hosts, providers }, 'i-1')).toEqual({ status: 'measured', host: hosts[0] });
  expect(findCloudHost({ hosts, providers }, 'missing').status).toBe('not-found');
  expect(findCloudHost({ hosts, providers: [providers[0]!, { provider: 'gcp', status: 'unavailable' }] }, 'i-1').status).toBe('unmeasured');
});
