import { expect, test } from 'bun:test';
import { discoverCloudResources } from './cloud-resource-discovery.js';

test('read-only cloud discovery reports only running AWS and GCP resources with stable IDs', async () => {
  const calls: Array<[string, string[]]> = [];
  const result = await discoverCloudResources((command, args) => {
    calls.push([command, args]);
    if (command === 'aws') return { status: 0, stdout: JSON.stringify({ Reservations: [{ Instances: [
      { InstanceId: 'i-running', State: { Name: 'running' }, Tags: [{ Key: 'Name', Value: 'forgotten-vm' }] },
      { InstanceId: 'i-stopped', State: { Name: 'stopped' }, Tags: [{ Key: 'Name', Value: 'parked' }] },
      { InstanceId: 'i-terminated', State: { Name: 'terminated' } },
    ] }] }) };
    return { status: 0, stdout: JSON.stringify([
      { id: '123456', name: 'n8n-guide-verify', status: 'RUNNING', zone: 'https://compute.googleapis.com/compute/v1/projects/p/zones/asia-northeast3-a', selfLink: 'https://compute.googleapis.com/compute/v1/projects/p/zones/asia-northeast3-a/instances/n8n-guide-verify' },
      { id: '123457', name: 'stopped', status: 'TERMINATED', zone: 'https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a' },
    ]) };
  });

  expect(result.resources).toEqual([
    { id: 'i-running', machine: 'aws', provider: 'aws', name: 'forgotten-vm' },
    { id: '123456', machine: 'gcp', provider: 'gcp', name: 'n8n-guide-verify', aliases: ['projects/p/zones/asia-northeast3-a/instances/n8n-guide-verify'] },
  ]);
  expect(result.providers).toEqual([
    { provider: 'aws', status: 'measured', resources: 1 },
    { provider: 'gcp', status: 'measured', resources: 1 },
  ]);
  expect(calls).toEqual([
    ['aws', ['ec2', 'describe-instances', '--no-cli-pager', '--output', 'json']],
    ['gcloud', ['compute', 'instances', 'list', '--format=json']],
  ]);
});

test('failed cloud queries are unavailable without exposing provider output', async () => {
  const result = await discoverCloudResources(() => ({ status: 1, stdout: 'credential-secret-must-not-escape' }));
  expect(result).toEqual({ resources: [], providers: [
    { provider: 'aws', status: 'unavailable', resources: 0 },
    { provider: 'gcp', status: 'unavailable', resources: 0 },
  ] });
  expect(JSON.stringify(result)).not.toContain('credential-secret');
});

test('provider commands start concurrently', async () => {
  let calls = 0;
  let releaseBoth: (() => void) | undefined;
  const bothStarted = new Promise<void>(resolve => { releaseBoth = resolve; });
  const result = await discoverCloudResources(async command => {
    calls += 1;
    if (calls === 2) releaseBoth?.();
    await bothStarted;
    return { status: 0, stdout: command === 'aws' ? '{"Reservations":[]}' : '[]' };
  });

  expect(calls).toBe(2);
  expect(result.providers.map(provider => provider.status)).toEqual(['measured', 'measured']);
});

test('malformed provider output is isolated while the other provider still reports resources', async () => {
  const result = await discoverCloudResources(command => command === 'aws'
    ? { status: 0, stdout: '{not-json' }
    : { status: 0, stdout: JSON.stringify([{ id: 1, name: 'vm', status: 'RUNNING', zone: 'zone-a' }]) });
  expect(result.providers).toEqual([
    { provider: 'aws', status: 'unavailable', resources: 0 },
    { provider: 'gcp', status: 'measured', resources: 1 },
  ]);
  expect(result.resources).toHaveLength(1);
});

test('GCP rows without a provider ID are skipped instead of falling back to a collision-prone name', async () => {
  const result = await discoverCloudResources(command => command === 'aws'
    ? { status: 0, stdout: '{"Reservations":[]}' }
    : { status: 0, stdout: JSON.stringify([
      { name: 'shared-name', status: 'RUNNING', zone: 'https://compute.googleapis.com/compute/v1/projects/p/zones/zone-a', selfLink: 'https://compute.googleapis.com/compute/v1/projects/p/zones/zone-a/instances/shared-name' },
    ]) });

  expect(result.resources).toEqual([]);
  expect(result.providers).toEqual([
    { provider: 'aws', status: 'measured', resources: 0 },
    { provider: 'gcp', status: 'partial', resources: 0 },
  ]);
});
