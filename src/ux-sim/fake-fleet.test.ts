import { expect, test } from 'bun:test';
import { preflightParentHost } from '../task-agent/parent-host.js';
import { checkPodPool, parsePodPool } from '../task-orchestrator/surfaces/pod-pool.js';
import { createFakeFleetDevice } from './fake-fleet.js';
import { packageVersion } from '../version/code-revision.js';

const fleet = () => createFakeFleetDevice({
  clusters: [
    { host: 'node-b', context: 'k3d-node-b', nodes: ['node-b-control', 'node-b-worker'] },
    { host: 'node-b', context: 'k3d-node-b-alt', nodes: ['node-b-alt-control'] },
    { host: 'node-c', context: 'k3d-node-c', nodes: ['node-c-control'] },
  ],
});

test('fake fleet serves isolated Kubernetes contexts with multiple nodes per cluster', () => {
  const device = fleet();
  expect(device.clusters.map(({ host, context }) => ({ host, context }))).toEqual([
    { host: 'node-b', context: 'k3d-node-b' },
    { host: 'node-b', context: 'k3d-node-b-alt' },
    { host: 'node-c', context: 'k3d-node-c' },
  ]);
  const pool = parsePodPool('k3d-node-b@node-b:2,k3d-node-b-alt@node-b:1,k3d-node-c@node-c:1');
  const checked = checkPodPool(pool, device.kubectl);
  expect(checked).toMatchObject({ ok: true, ready: [{ context: 'k3d-node-b' }, { context: 'k3d-node-b-alt' }, { context: 'k3d-node-c' }], dropped: [] });

  const nodes = (context: string) => JSON.parse(device.kubectl(['--context', context, 'get', 'nodes', '-o', 'json']).stdout)
    .items.map((item: { metadata: { name: string } }) => item.metadata.name);
  expect(nodes('k3d-node-b')).toEqual(['node-b-control', 'node-b-worker']);
  expect(nodes('k3d-node-b-alt')).toEqual(['node-b-alt-control']);
  expect(nodes('k3d-node-c')).toEqual(['node-c-control']);

  const unknown = device.kubectl(['--context', 'k3d-unknown', 'get', 'nodes', '-o', 'json']);
  expect(unknown.status).not.toBe(0);
  expect(unknown.stderr).toContain('context');
  expect(device.kubectlCalls.some(({ context }) => context === 'k3d-node-b')).toBe(true);
  expect(device.kubectlCalls.some(({ context }) => context === 'k3d-node-c')).toBe(true);
  expect(device.kubectlCalls.find(({ context, args }) => context === 'k3d-node-b' && args.includes('-o'))?.args)
    .toEqual(['--context', 'k3d-node-b', 'get', 'nodes', '-o', 'json']);

  device.setHostOnline('node-c', false);
  const degraded = checkPodPool(pool, device.kubectl);
  expect(degraded.ready.map(({ context }) => context)).toEqual(['k3d-node-b', 'k3d-node-b-alt']);
  expect(degraded.dropped.map(({ context }) => context)).toContain('k3d-node-c');
  device.setHostOnline('node-c', true);
  expect(checkPodPool(pool, device.kubectl).ready.map(({ context }) => context))
    .toEqual(['k3d-node-b', 'k3d-node-b-alt', 'k3d-node-c']);

  device.setHostOnline('node-b', false);
  const sharedHostDown = checkPodPool(pool, device.kubectl);
  expect(sharedHostDown.ready.map(({ context }) => context)).toEqual(['k3d-node-c']);
  expect(sharedHostDown.dropped.map(({ context }) => context)).toEqual(['k3d-node-b', 'k3d-node-b-alt']);
  expect(device.kubectl(['--context', 'k3d-node-b-alt', 'get', 'nodes', '-o', 'json']).status).not.toBe(0);
  expect(device.kubectl(['--context', 'k3d-node-c', 'get', 'nodes', '-o', 'json']).status).toBe(0);
  device.setHostOnline('node-b', true);
  expect(checkPodPool(pool, device.kubectl).ready.map(({ context }) => context))
    .toEqual(['k3d-node-b', 'k3d-node-b-alt', 'k3d-node-c']);
});

test('fake fleet snapshots cluster inputs before exposing its inventory', () => {
  const clusters = [{ host: 'node-b', context: 'k3d-node-b', nodes: ['worker-a', 'worker-b'] }];
  const device = createFakeFleetDevice({ clusters });

  clusters[0]!.host = 'other-host';
  clusters[0]!.context = 'k3d-replaced';
  clusters[0]!.nodes[0] = 'replaced-node';

  expect(device.clusters).toEqual([{ host: 'node-b', context: 'k3d-node-b', nodes: ['worker-a', 'worker-b'] }]);
  expect(device.kubectl(['--context', 'k3d-node-b', 'get', 'node', 'worker-a', '-o', 'json']).status).toBe(0);
  expect(device.kubectl(['--context', 'k3d-replaced', 'get', 'nodes', '-o', 'json']).status).not.toBe(0);
});

test('scripted SSH replies are host-scoped, ordered, delayed, and time out fail-closed', () => {
  const waits: number[] = [];
  const device = createFakeFleetDevice({
    clusters: [
      { host: 'node-b', context: 'k3d-node-b', nodes: ['node-b-worker'] },
      { host: 'node-c', context: 'k3d-node-c', nodes: ['node-c-worker'] },
    ],
    sshScripts: [
      { host: 'node-b', includes: '--version', delayMs: 4, result: { status: 0, stdout: `version=${packageVersion()}\nconfig=1\npodPool=1\nrepo=1\nkubectl=1\ngrokCli=1\ncodexCli=1\ncodexAccountsDefault=3\ncodexAccountsMirror=0\ncodexAccountsMirrorAdditional=0\ncodexAccountsMirrorStatus=measured\ncodexAccounts=3\ngrok=1\nopenrouter=1\ngrokHost=valid\n`, stderr: '' } },
      { host: 'node-c', includes: 'nexus:health', result: { status: 0, stdout: '200', stderr: '' } },
      { host: 'node-c', includes: 'nexus:slow', delayMs: 20, result: { status: 0, stdout: '200', stderr: '' } },
    ],
    wait: (ms) => { waits.push(ms); },
  });

  const result = preflightParentHost({
    target: { host: 'node-b', cwd: '/srv/elanous', podPool: 'k3d-node-b@node-b:1' },
    localVersion: packageVersion(),
    launchHoldActive: false,
    ssh: device.ssh,
  });
  expect(result).toMatchObject({ ok: true, gaps: [], warnings: [] });
  expect(device.sshCalls[0]?.host).toBe('node-b');
  expect(waits).toEqual([4]);

  device.setHostOnline('node-c', false);
  expect(device.hostOnline('node-c')).toBe(false);
  expect(device.kubectl(['--context', 'k3d-node-c', 'get', 'nodes', '-o', 'json'])).toMatchObject({
    status: 1, stderr: expect.stringContaining('unreachable'),
  });
  expect(device.ssh('node-c', 'nexus:health', 5)).toMatchObject({ status: 255, stderr: expect.stringContaining('unreachable') });
  expect(device.remainingSshScripts('node-c')).toBe(2);
  expect(device.kubectl(['--context', 'k3d-node-b', 'get', 'nodes', '-o', 'json']).status).toBe(0);

  device.setHostOnline('node-c', true);
  expect(device.hostOnline('node-c')).toBe(true);
  expect(device.ssh('node-c', 'nexus:health', 5, 'health-request')).toMatchObject({ status: 0, stdout: '200' });
  expect(device.sshCalls[2]).toMatchObject({ host: 'node-c', script: 'nexus:health', timeoutMs: 5, stdin: 'health-request' });
  expect(device.remainingSshScripts('node-c')).toBe(1);
  expect(device.ssh('node-c', 'nexus:slow', 5)).toMatchObject({ status: null, stdout: '', stderr: expect.stringContaining('timeout') });
  expect(waits).toEqual([4, 5]);
  expect(device.ssh('node-b', '--version', 5).status).not.toBe(0); // scripted steps are consumed exactly once.
  expect(device.remainingSshScripts()).toBe(0);
});
