import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../control-plane/ledger.js';
import { createFakeCloudVm } from '../ux-sim/fake-cloud-vm.js';
import { discoverCloudResources } from './cloud-resource-discovery.js';
import { createRegisteredInventoryResource, inspectInventory, registerInventoryResource, stopReleasedInventoryResources, unregisterInventoryResource } from './resource-inventory.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-inventory-')); roots.push(root);
  return new ResourceLedger(root);
}
function resource(id: string, overrides: Partial<Parameters<typeof registerInventoryResource>[0]> = {}) {
  const now = Date.now();
  return { id, machine: 'aws2', name: id, provider: 'aws' as const, purpose: 'focused verification', ownerSeat: 'OPT',
    role: 'implementation' as const, account: 'test-account', region: 'test-region', instanceType: 'm7i.large',
    hourlyCost: 3.6, startSignedAt: now, firstWorkAt: now, lastActivityAt: now, ...overrides };
}

test('fake cloud VM creation registers in Nexus and deletion archives it from active inventory', async () => {
  const ledger = setup();
  const device = createFakeCloudVm();
  await createRegisteredInventoryResource(resource('vm-1'), async () => device.createFromImage({ id: 'vm-1', imageDigest: 'sha256:test', hourlyCost: 3.6 }), async () => { device.stop('vm-1'); }, ledger);
  expect(inspectInventory(ledger).resources).toHaveLength(1);
  expect(ledger.list({ kind: 'machine' }).some(row => row.id === 'fleet:vm-1')).toBe(false);
  device.stop('vm-1');
  unregisterInventoryResource('vm-1', 'OPT', ledger);
  expect(inspectInventory(ledger).resources).toEqual([]);
  expect(ledger.list({ kind: 'fleet-resource' }).find(row => row.id === 'fleet:vm-1')?.attrs.inventory).toBe('archived');
});

test('inventory flags outside-ledger VMs, expired resources, missing purpose, and seven-day idle', () => {
  const ledger = setup();
  const now = Date.now();
  registerInventoryResource(resource('expired', { expiresAt: now - 1 }), ledger, now - 2);
  registerInventoryResource(resource('no-purpose', { purpose: '   ' }), ledger);
  registerInventoryResource(resource('idle', { lastActivityAt: now - 8 * 24 * 60 * 60 * 1000 }), ledger);
  const snapshot = inspectInventory(ledger, [{ id: 'orphan', machine: 'gcp1', provider: 'gcp' }], now);
  expect(snapshot.alerts).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'orphan', reason: 'unregistered', message: 'gcp resource orphan is outside the inventory' }),
    expect.objectContaining({ id: 'expired', reason: 'expired' }),
    expect.objectContaining({ id: 'no-purpose', reason: 'missing-purpose' }),
    expect.objectContaining({ id: 'idle', reason: 'idle-over-7-days' }),
  ]));
});

test('read-only cloud discovery feeds named unregistered VM alerts without leaking provider stderr', async () => {
  const ledger = setup();
  const discovery = await discoverCloudResources(command => command === 'aws'
    ? { status: 0, stdout: JSON.stringify({ Reservations: [{ Instances: [
      { InstanceId: 'i-hackers-win-test', State: { Name: 'running' }, Tags: [{ Key: 'Name', Value: 'hackers-win-test' }] },
      { InstanceId: 'i-terminated', State: { Name: 'terminated' } },
    ] }] }) }
    : { status: 0, stdout: JSON.stringify([{ id: '123123', name: 'n8n-guide-verify', status: 'RUNNING', zone: 'https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a', selfLink: 'https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances/n8n-guide-verify' }]) });
  const snapshot = inspectInventory(ledger, discovery.resources, Date.UTC(2026, 10, 4));

  expect(snapshot.alerts).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'i-hackers-win-test', reason: 'unregistered', message: 'aws resource hackers-win-test (i-hackers-win-test) is outside the inventory' }),
    expect.objectContaining({ id: '123123', reason: 'unregistered', message: 'gcp resource n8n-guide-verify (123123) is outside the inventory' }),
  ]));
});

test('discovery IDs and aliases match existing AWS and GCP ledger identifiers', async () => {
  const ledger = setup();
  const awsId = 'i-registered-aws';
  const gcpNumericId = '123456';
  const gcpPath = 'projects/p/zones/us-central1-a/instances/registered-gcp-path';
  registerInventoryResource(resource(awsId), ledger);
  registerInventoryResource({ ...resource(gcpNumericId), machine: 'gcp1', provider: 'gcp' }, ledger);
  registerInventoryResource({ ...resource(gcpPath), machine: 'gcp1', provider: 'gcp' }, ledger);
  const discovery = await discoverCloudResources(command => command === 'aws'
    ? { status: 0, stdout: JSON.stringify({ Reservations: [{ Instances: [
      { InstanceId: awsId, State: { Name: 'running' }, Tags: [{ Key: 'Name', Value: 'registered-aws' }] },
    ] }] }) }
    : { status: 0, stdout: JSON.stringify([
      { id: gcpNumericId, name: 'registered-gcp-id', status: 'RUNNING', zone: 'https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a', selfLink: `https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances/${gcpNumericId}` },
      { id: '123457', name: 'registered-gcp-path', status: 'RUNNING', zone: 'https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a', selfLink: 'https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances/registered-gcp-path' },
    ]) });

  expect(inspectInventory(ledger, discovery.resources).alerts.filter(alert => alert.reason === 'unregistered')).toEqual([]);
});

test('cloud names remain display-only and same-name GCP instances in other zones stay unregistered', async () => {
  const ledger = setup();
  registerInventoryResource(resource('shared-name'), ledger);
  registerInventoryResource(resource('aws-stable-id'), ledger);
  registerInventoryResource({ ...resource('projects/p/zones/zone-a/instances/shared-name'), machine: 'gcp1', provider: 'gcp' }, ledger);
  const discovery = await discoverCloudResources(command => command === 'aws'
    ? { status: 0, stdout: JSON.stringify({ Reservations: [{ Instances: [
      { InstanceId: 'i-orphan', State: { Name: 'running' }, Tags: [{ Key: 'Name', Value: 'shared-name' }] },
      { InstanceId: 'i-rotated', State: { Name: 'running' }, Tags: [{ Key: 'Name', Value: 'friendly-name' }] },
    ] }] }) }
    : { status: 0, stdout: JSON.stringify([
      { id: '100', name: 'shared-name', status: 'RUNNING', zone: 'https://compute.googleapis.com/compute/v1/projects/p/zones/zone-a', selfLink: 'https://compute.googleapis.com/compute/v1/projects/p/zones/zone-a/instances/shared-name' },
      { id: '200', name: 'shared-name', status: 'RUNNING', zone: 'https://compute.googleapis.com/compute/v1/projects/p/zones/zone-b', selfLink: 'https://compute.googleapis.com/compute/v1/projects/p/zones/zone-b/instances/shared-name' },
    ]) });

  const withUnqualifiedNameAliases = discovery.resources.map(item => ({ ...item,
    aliases: [...(item.aliases ?? []), ...(item.id === 'i-rotated' ? ['aws-stable-id'] : []), ...(item.provider === 'gcp' && item.name ? [item.name] : [])] }));
  expect(inspectInventory(ledger, withUnqualifiedNameAliases).alerts.filter(alert => alert.reason === 'unregistered').map(alert => alert.id).sort()).toEqual(['200', 'i-orphan']);
});

test('fixed-time cost view bounds history at stop time and reports unknown prices', () => {
  const ledger = setup();
  const now = Date.UTC(2026, 10, 3, 12);
  registerInventoryResource(resource('costed', { startSignedAt: now - 30 * 60_000, lastActivityAt: now - 30 * 60_000 }), ledger, now - 30 * 60_000);
  expect(inspectInventory(ledger, [], now)).toMatchObject({ estimatedCostToday: 1.8, estimatedCumulativeCost: 1.8, unpricedResources: 0 });
  unregisterInventoryResource('costed', 'OPT', ledger, now + 30 * 60_000);
  expect(inspectInventory(ledger, [], now + 15 * 60_000)).toMatchObject({ estimatedCostToday: 2.7, estimatedCumulativeCost: 2.7 });
  expect(inspectInventory(ledger, [], now + 30 * 60_000)).toMatchObject({ resources: [], estimatedCostToday: 3.6, estimatedCumulativeCost: 3.6 });
  expect(inspectInventory(ledger, [], now + 60 * 60_000)).toMatchObject({ estimatedCostToday: 3.6, estimatedCumulativeCost: 3.6 });

  registerInventoryResource(resource('unknown-rate', { hourlyCost: undefined, startSignedAt: now }), ledger, now);
  expect(inspectInventory(ledger, [], now + 60 * 60_000)).toMatchObject({ estimatedCostToday: 3.6, estimatedCumulativeCost: 3.6, unpricedResources: 1 });
});

test('release uses the earliest expiry even when idle and two expiry fields are also set', async () => {
  const ledger = setup();
  const device = createFakeCloudVm();
  const start = Date.now();
  const nestedDeadline = start + 30_000;
  const topLevelDeadline = start + 60_000;
  device.createFromImage({ id: 'vm-expiring', imageDigest: 'sha256:test', hourlyCost: 3.6 });
  registerInventoryResource(resource('vm-expiring', { startSignedAt: start, expiresAt: topLevelDeadline,
    releaseConditions: { expiresAt: nestedDeadline, idleMinutes: 120 } }), ledger, start);
  const snapshot = inspectInventory(ledger, [], nestedDeadline);
  expect(snapshot.resources[0]?.attrs.expiresAt).toBe(nestedDeadline);
  const finishedAt = nestedDeadline + 1_000;
  const stopped = await stopReleasedInventoryResources(snapshot, async row => { device.stop(row.name); }, async () => {}, nestedDeadline, ledger, () => finishedAt);
  expect(stopped).toEqual(['fleet:vm-expiring']);
  expect(device.status('vm-expiring').state).toBe('parked');
  const archived = ledger.list({ kind: 'fleet-resource' }).find(row => row.id === 'fleet:vm-expiring');
  expect(archived?.attrs.stoppedAt).toBe(finishedAt);
  expect(archived?.attrs.cumulativeCost).toBe(((finishedAt - start) / 3_600_000) * 3.6);
});

test('top-level expiry still stops a resource that also has an idle condition', async () => {
  const ledger = setup();
  const device = createFakeCloudVm();
  const start = Date.now();
  const deadline = start + 30_000;
  device.createFromImage({ id: 'vm-top-expiry', imageDigest: 'sha256:test', hourlyCost: 3.6 });
  registerInventoryResource(resource('vm-top-expiry', { startSignedAt: start, expiresAt: deadline, releaseConditions: { idleMinutes: 120 } }), ledger, start);
  const snapshot = inspectInventory(ledger, [], deadline);
  const stopped = await stopReleasedInventoryResources(snapshot, async row => { device.stop(row.name); }, async () => {}, deadline, ledger, () => deadline + 10);
  expect(stopped).toEqual(['fleet:vm-top-expiry']);
  expect(device.status('vm-top-expiry').state).toBe('parked');
});

test('legacy machine-kind inventory remains visible and can be stopped after kind migration', async () => {
  const ledger = setup();
  const now = Date.now();
  ledger.register({ id: 'fleet:legacy-vm', kind: 'machine', machine: 'aws2', name: 'legacy-vm', owner: 'OPT',
    attrs: { inventory: true, provider: 'aws', purpose: 'legacy active', ownerSeat: 'OPT', role: 'implementation',
      hourlyCost: 3.6, startSignedAt: now - 60_000, expiresAt: now, releaseConditions: { expiresAt: now } },
    observedAt: now - 60_000, ttlMs: 60_000 }, 'OPT');
  ledger.register({ id: 'fleet:legacy-unregister', kind: 'machine', machine: 'aws2', name: 'legacy-unregister', owner: 'OPT',
    attrs: { inventory: true, provider: 'aws', purpose: 'legacy unregister', ownerSeat: 'OPT', role: 'implementation',
      hourlyCost: 3.6, startSignedAt: now - 60_000 },
    observedAt: now - 60_000, ttlMs: 60 * 60_000 }, 'OPT');
  unregisterInventoryResource('legacy-unregister', 'OPT', ledger, now);
  expect(ledger.list({ kind: 'machine' }).find(row => row.id === 'fleet:legacy-unregister')?.attrs.inventory).toBe('archived');

  const legacyStoppedAt = now - 30 * 60_000;
  ledger.register({ id: 'fleet:legacy-stopped', kind: 'machine', machine: 'aws2', name: 'legacy-stopped', owner: 'OPT',
    attrs: { inventory: 'archived', provider: 'aws', purpose: 'legacy archived', ownerSeat: 'OPT', role: 'implementation',
      hourlyCost: 3.6, startSignedAt: now - 60 * 60_000, stoppedAt: legacyStoppedAt, cumulativeCost: 1.8 },
    observedAt: legacyStoppedAt, ttlMs: 60 * 60_000 }, 'OPT');
  const before = inspectInventory(ledger, [], now);
  expect(before.resources.map(row => row.id)).toContain('fleet:legacy-vm');
  expect(before.estimatedCumulativeCost).toBeGreaterThanOrEqual(1.8);
  const stopped = await stopReleasedInventoryResources(before, async () => {}, async () => {}, now, ledger, () => now + 100);
  expect(stopped).toEqual(['fleet:legacy-vm']);
  expect(ledger.list({ kind: 'machine' }).find(row => row.id === 'fleet:legacy-vm')?.attrs.inventory).toBe('archived');
  const after = inspectInventory(ledger, [], now + 100);
  expect(after.resources).toEqual([]);
  expect(after.estimatedCumulativeCost).toBeCloseTo(1.8 + 60_000 / 3_600_000 * 3.6 + ((now + 100 - (now - 60_000)) / 3_600_000 * 3.6), 6);
  expect(ledger.list({ kind: 'machine' }).find(row => row.id === 'fleet:legacy-stopped')?.attrs.cumulativeCost).toBe(1.8);
});

test('provider stop failure preserves active cost accounting and notifies owner', async () => {
  const ledger = setup();
  const deadline = Date.now() + 90_000;
  registerInventoryResource(resource('vm-failing', { expiresAt: deadline }), ledger);
  const failingSnapshot = inspectInventory(ledger);
  const notices: string[] = [];
  const failed = await stopReleasedInventoryResources(failingSnapshot, async () => { throw new Error('provider unavailable'); }, async message => { notices.push(message); }, deadline + 1, ledger);
  expect(failed).toEqual([]);
  expect(notices).toEqual(['fleet inventory stop failed for fleet:vm-failing: provider unavailable']);
  const afterFailure = inspectInventory(ledger, [], deadline + 60 * 60_000);
  expect(afterFailure.resources.map(row => row.id)).toContain('fleet:vm-failing');
  expect(afterFailure.estimatedCumulativeCost).toBeGreaterThan(inspectInventory(ledger, [], deadline + 1).estimatedCumulativeCost);
});
