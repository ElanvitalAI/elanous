import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../control-plane/ledger.js';
import { HostPoolLease } from '../pod-lease/host-lease.js';
import { PodPoolScheduler } from '../task-orchestrator/surfaces/pod-pool.js';
import type { UserConfig } from '../user-config/types.js';
import { cloudBurstRuntimeConfig, cloudPoolImageDigestReady, installCloudBurstAuto } from './cloud-burst-runtime.js';

// Source: 내부 문서 `CONDUCTOR` §6c defines the cost, capacity, TTL and pinned image inputs.
const burstConfigFixture = () => ({
  joinCommand: '/Users/user/elanous-hq/seat-state/OP/tools/cloud-join.sh',
  host: 'aws2', context: 'pool-cloud', capacity: 2, threshold: 2, // Source: 내부 문서 `CONDUCTOR` §6c.
  hourlyCostKrw: 100_000, ttlHours: 2, imageDigest: `sha256:${'a'.repeat(64)}`,
  owner: 'NT-3', purpose: 'execution',
});

function configWith(raw: Record<string, unknown>): UserConfig { return { raw } as unknown as UserConfig; }

test('cloud burst config requires explicit complete argv command settings', () => {
  expect(cloudBurstRuntimeConfig(configWith({}))).toBeUndefined();
  const parsed = cloudBurstRuntimeConfig(configWith({ fleet: { cloudBurst: burstConfigFixture() } }));
  expect(parsed).toMatchObject({ joinCommand: '/Users/user/elanous-hq/seat-state/OP/tools/cloud-join.sh', host: 'aws2', capacity: 2, purpose: 'execution' }); // Source: 내부 문서 `CONDUCTOR` §6c.
});

test('cloud burst config fails closed for unsafe command paths, hosts, and incomplete cost bounds', () => {
  const valid = burstConfigFixture();
  expect(cloudBurstRuntimeConfig(configWith({ fleet: { cloudBurst: { ...valid, joinCommand: 'cloud-join.sh' } } }))).toBeUndefined();
  expect(cloudBurstRuntimeConfig(configWith({ fleet: { cloudBurst: { ...valid, host: 'aws1' } } }))).toBeUndefined();
  expect(cloudBurstRuntimeConfig(configWith({ fleet: { cloudBurst: { ...valid, hourlyCostKrw: 0 } } }))).toBeUndefined();
  for (const key of ['joinCommand', 'host', 'context', 'capacity', 'threshold', 'hourlyCostKrw', 'ttlHours', 'imageDigest', 'owner', 'purpose']) {
    const incomplete = { ...valid } as unknown as Record<string, unknown>;
    delete incomplete[key];
    expect(cloudBurstRuntimeConfig(configWith({ fleet: { cloudBurst: incomplete } }))).toBeUndefined();
  }
  for (const invalid of [
    { ...valid, capacity: Number.NaN }, { ...valid, threshold: Number.NaN }, { ...valid, ttlHours: Number.NaN },
    { ...valid, imageDigest: 'sha256:wrong' }, { ...valid, owner: ' ' }, { ...valid, purpose: 'approve' },
  ]) expect(cloudBurstRuntimeConfig(configWith({ fleet: { cloudBurst: invalid } }))).toBeUndefined();
});

test('cloud burst image readiness requires the exact digest on every ready node', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const nodes = JSON.stringify({ items: [
    { status: { conditions: [{ type: 'Ready', status: 'True' }], images: [{ names: [`registry/elanous-harness@${digest}`] }] } },
    { status: { conditions: [{ type: 'Ready', status: 'True' }], images: [{ names: [`registry/other@sha256:${'b'.repeat(64)}`] }] } },
  ] });
  expect(cloudPoolImageDigestReady('pool-cloud', digest, () => ({ status: 0, stdout: nodes }))).toBe(false);
  const readyNodes = JSON.stringify({ items: [{ status: { conditions: [{ type: 'Ready', status: 'True' }], images: [{ names: [`registry/elanous-harness@${digest}`] }] } }] });
  expect(cloudPoolImageDigestReady('pool-cloud', digest, args => {
    expect(args).toEqual(['--context', 'pool-cloud', '--request-timeout=10s', 'get', 'nodes', '-o', 'json']);
    return { status: 0, stdout: readyNodes };
  })).toBe(true);
  expect(cloudPoolImageDigestReady('pool-cloud', digest, () => ({ status: 1, stdout: '' }))).toBe(false);
});

test('cloud burst install passes the planned image digest to join and keeps admission closed when join fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-burst-join-argv-'));
  let dispose: (() => void) | undefined;
  try {
    const config = cloudBurstRuntimeConfig(configWith({ fleet: { cloudBurst: { ...burstConfigFixture(), hourlyCostKrw: 10_000, threshold: 1 } } }))!; // Source: 내부 문서 `CONDUCTOR` §6c — a budgeted fixture at the first starvation threshold.
    const calls: Array<{ command: string; args: string[] }> = [];
    let warmChecks = 0;
    const pool = new PodPoolScheduler([
      { context: 'full', sshHost: 'aws3', capacity: 1, k3dCluster: 'full', federationRole: 'task' }, // Source: 내부 문서 `pod-federation-mapreduce` §2 — a saturated task member signals starvation.
      { context: config.context, sshHost: config.host, capacity: 0, k3dCluster: 'elanous-pool', federationRole: 'cloud' }, // Source: 내부 문서 `pod-federation-mapreduce` §2 — cloud candidate starts withdrawn.
    ], { hostLease: new HostPoolLease('cloud-burst-join-argv', { dir: root }),
      occupancy: () => ({ full: { occupied: 1 }, [config.context]: { occupied: 0 } }) });
    dispose = installCloudBurstAuto({
      pool, config, ledger: new ResourceLedger(root),
      cloudVm: {
        async start() {}, async stop() {},
        async status(host) { return { host, state: 'running' }; },
      },
      runJoinCommand: async (command, args) => { calls.push({ command, args: [...args] }); throw new Error('image digest mismatch'); },
      isWarm: async () => { warmChecks++; return true; },
      now: () => Date.parse('2026-11-10T00:00:00.000Z'),
    });
    const pressureHandler = (pool as unknown as { cloudStarvationHandler?: (pressure: { queueDepth: number; blockedCount: number; reason: string }) => Promise<void> }).cloudStarvationHandler;
    if (!pressureHandler) throw new Error('cloud burst starvation handler was not installed');
    const pressure = { queueDepth: 1, blockedCount: 1, reason: 'test the configured burst command boundary' };
    await pressureHandler(pressure);
    await pressureHandler(pressure);
    expect(calls).toEqual([{ command: config.joinCommand!, args: [config.host, '--caps', '2', '--image-digest', config.imageDigest] }]);
    expect(warmChecks).toBe(0);
    expect(pool.members.find(member => member.context === config.context)?.capacity).toBe(0);
  } finally { dispose?.(); rmSync(root, { recursive: true, force: true }); }
});
