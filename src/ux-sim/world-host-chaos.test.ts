import { expect, test } from 'bun:test';
import { createFakeKubectl } from './fake-kubectl.js';
import { createFakePsDevice } from './fake-ps.js';
import { createWorldHostChaosController } from './world-host-chaos.js';
import type { SimWorldSpec } from './world-schema.js';

test('gorilla takes every process on its host down and re-registers them when the host returns', async () => {
  const hosts: NonNullable<SimWorldSpec['hosts']> = [
    { name: 'node-b', arch: 'arm64', cpu: 32, pools: ['gate'], egress: true },
    { name: 'gcp2', arch: 'amd64', cpu: 8, pools: ['gate'], egress: true },
  ];
  const processTable = createFakePsDevice({ processes: [
    { id: 'worker-a', host: 'node-b', releaseVersion: '0.3.5', fingerprint: 'declared-a' },
    { id: 'worker-b', host: 'node-b', releaseVersion: '0.3.5', fingerprint: 'declared-b' },
    { id: 'survivor', host: 'gcp2', releaseVersion: '0.3.5', fingerprint: 'declared-survivor' },
  ] });
  const devices = new Map(hosts.map((host) => {
    const kubectl = createFakeKubectl({ context: `gorilla-world-${host.name}-context`,
      node: `gorilla-${host.name}-node`, arch: host.arch, cpu: host.cpu, pools: [...host.pools] });
    kubectl.setHostState({ egress: true });
    return [`fake-kubectl:${host.name}`, kubectl] as const;
  }));
  let now = 0;
  const controller = createWorldHostChaosController({ world: 'gorilla-world', hosts, devices,
    baseTimeMs: 0, clock: { now: () => now }, processTable });
  const pending = controller.start({ at: '+1m', gorilla: { host: 'node-b', egress: false, cpu: 0, for: '+5m' } }, 60_000);
  expect(processTable.list('node-b')).toEqual([]);
  expect(processTable.list('gcp2').map(({ id, fp }) => ({ id, fp }))).toEqual([{ id: 'survivor', fp: 'declared-survivor' }]);
  now = 360_000;
  const result = await pending.complete();
  expect(result).toMatchObject({ kind: 'gorilla', recoveredAtMs: 360_000, recoveryMs: 300_000,
    recoveryVerdict: expect.stringContaining('surviving host gcp2'), metrics: { hitlCount: 0 } });
  expect(processTable.list('node-b').map(({ id, fp }) => ({ id, fp }))).toEqual([
    { id: 'worker-a', fp: 'declared-a' }, { id: 'worker-b', fp: 'declared-b' },
  ]);
  expect(processTable.find('worker-a', 'node-b')?.pid).toBeGreaterThan(1_700_000_000);
});

test('gorilla recovery fails when the world process device refuses to restart host processes', async () => {
  const hosts: NonNullable<SimWorldSpec['hosts']> = [
    { name: 'node-b', arch: 'arm64', cpu: 32, pools: ['gate'], egress: true },
    { name: 'gcp2', arch: 'amd64', cpu: 8, pools: ['gate'], egress: true },
  ];
  const processTable = createFakePsDevice({ processes: [
    { id: 'worker', host: 'node-b', releaseVersion: '0.3.5', fingerprint: 'declared-worker' },
  ], startAllowed: () => false });
  const devices = new Map(hosts.map((host) => {
    const kubectl = createFakeKubectl({ context: `gorilla-refusal-${host.name}-context`,
      node: `gorilla-refusal-${host.name}-node`, arch: host.arch, cpu: host.cpu, pools: [...host.pools] });
    kubectl.setHostState({ egress: true });
    return [`fake-kubectl:${host.name}`, kubectl] as const;
  }));
  let now = 0;
  const controller = createWorldHostChaosController({ world: 'gorilla-refusal', hosts, devices,
    baseTimeMs: 0, clock: { now: () => now }, processTable });
  const pending = controller.start({ at: '+1m', gorilla: { host: 'node-b', egress: false, cpu: 0, for: '+5m' } }, 60_000);
  now = 360_000;
  const result = await pending.complete();
  expect(result).toMatchObject({ recoveredAtMs: null, recoveryMs: null,
    recoveryVerdict: 'host recovery failed (selected=gcp2; restarted=0/1)', metrics: { hitlCount: 1 } });
  expect(processTable.list('node-b')).toEqual([]);
});
