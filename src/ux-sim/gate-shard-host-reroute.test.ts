import { describe, expect, test } from 'bun:test';
import { gateShardRerouteScenario, simGateShardHostReroute } from './gate-shard-host-reroute.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const SHA = 'c'.repeat(64);
const hosts = [
  { id: 'node-b', platform: 'darwin' as const, available: true, reserved: false },
  { id: 'wsl', platform: 'linux' as const, available: true, reserved: false },
  { id: 'node-c', platform: 'darwin' as const, available: true, reserved: false },
];
const shards = [
  { id: 'pod-0', files: ['src/a.test.ts'] },
  { id: 'pod-1', files: ['src/b.test.ts'] },
  { id: 'pod-2', files: ['src/c.test.ts'] },
];

function receipt(id: string, files: string[], host: string, overrides: Record<string, unknown> = {}) {
  return { id, files, head40: HEAD, base40: BASE, host, envKey: `${host}-env`, status: 'complete' as const,
    failureIds: [], errorIds: [], evidencePath: `gate-logs/${id}-${host}.json`, evidenceSha256: SHA,
    measuredAt: '2026-10-27T00:00:00.000Z', attempt: 1, ...overrides };
}

describe('gate shard host reroute S1 device', () => {
  test('OS capability is declared by shard and bound to a live host at dispatch', () => {
    const required = { id: 'pod-0', files: ['src/a.test.ts'], requiredOs: 'darwin' as const };
    const scenario = gateShardRerouteScenario({ head40: HEAD, base40: BASE, shards: [required], hosts,
      receipts: [receipt('pod-0', required.files, 'wsl')] }, [
      { shardId: 'pod-0', host: 'node-b', status: 'complete', failureIds: [], errorIds: [] },
    ]);
    const observed = simGateShardHostReroute(scenario);
    expect(observed.actions[0]).toMatchObject({ kind: 'run', host: 'node-b' });
    expect(observed.reduction.status).toBe('complete');
  });
  test('map distributes three missing shards across fake hosts and reduce reads only their receipts', () => {
    const scenario = gateShardRerouteScenario({ head40: HEAD, base40: BASE, shards, hosts, receipts: [] }, [
      { shardId: 'pod-0', host: 'node-b', status: 'complete', failureIds: [], errorIds: [] },
      { shardId: 'pod-1', host: 'wsl', status: 'complete', failureIds: ['src/b.test.ts > known'], errorIds: [] },
      { shardId: 'pod-2', host: 'node-c', status: 'complete', failureIds: [], errorIds: [] },
    ]);
    const observed = simGateShardHostReroute(scenario);
    expect(observed.actions.map((a) => [a.shardId, a.kind, a.kind === 'run' ? a.host : null]))
      .toEqual([['pod-0', 'run', 'node-b'], ['pod-1', 'run', 'wsl'], ['pod-2', 'run', 'node-c']]);
    expect(observed.hostCalls.map((c) => [c.shardId, c.host, c.head40, c.base40, c.files]))
      .toEqual(shards.map((s, i) => [s.id, hosts[i]!.id, HEAD, BASE, s.files]));
    expect(observed.reduction).toMatchObject({ status: 'complete', failureIds: ['src/b.test.ts > known'], errorIds: [] });
  });

  test('auto reroutes only the unattributed mac-passing shard; complete siblings are reused', () => {
    const prior = [
      receipt('pod-0', shards[0]!.files, 'wsl'),
      receipt('pod-1', shards[1]!.files, 'wsl', { status: 'unmeasured' }),
      receipt('pod-2', shards[2]!.files, 'node-c', { failureIds: ['src/c.test.ts > existing'] }),
    ];
    const scenario = gateShardRerouteScenario({ head40: HEAD, base40: BASE, shards, hosts, receipts: prior,
      rerouteShard: 'auto', macPassShardIds: ['pod-1'] }, [
      { shardId: 'pod-1', host: 'node-b', status: 'complete', failureIds: [], errorIds: [] },
    ]);
    const observed = simGateShardHostReroute(scenario);
    expect(observed.actions.map((a) => a.kind)).toEqual(['reuse', 'run', 'reuse']);
    expect(observed.hostCalls.map((c) => [c.shardId, c.host, c.files])).toEqual([['pod-1', 'node-b', shards[1]!.files]]);
    expect(observed.reduction).toMatchObject({ status: 'complete', failureIds: ['src/c.test.ts > existing'] });
    expect(observed.receipts.map((r) => r.host)).toEqual(['wsl', 'node-b', 'node-c']);
  });

  test('auto does not remeasure a complete macOS shard just because it has a mac-pass policy tag', () => {
    const complete = receipt('pod-0', shards[0]!.files, 'node-b');
    const scenario = gateShardRerouteScenario({ head40: HEAD, base40: BASE, shards: [shards[0]!], hosts,
      receipts: [complete], rerouteShard: 'auto', macPassShardIds: ['pod-0'] }, []);
    const observed = simGateShardHostReroute(scenario);
    expect(observed.actions[0]).toMatchObject({ kind: 'reuse', receipt: complete });
    expect(observed.hostCalls).toEqual([]);
    expect(observed.reduction.status).toBe('complete');
  });

  test.each([
    ['head', { head40: 'd'.repeat(40) }],
    ['base', { base40: 'd'.repeat(40) }],
    ['file cohort', { files: ['src/else.test.ts'] }],
  ])('a stale %s receipt is not inherited', (_label, override) => {
    const prior = receipt('pod-0', shards[0]!.files, 'wsl', override);
    const scenario = gateShardRerouteScenario({ head40: HEAD, base40: BASE, shards: [shards[0]!], hosts,
      receipts: [prior] }, [{ shardId: 'pod-0', host: 'node-b', status: 'complete', failureIds: [], errorIds: [] }]);
    const observed = simGateShardHostReroute(scenario);
    expect(observed.actions[0]).toMatchObject({ kind: 'run' });
    expect(observed.hostCalls).toHaveLength(1);
    expect(observed.reduction.status).toBe('complete');
  });

  test('dead and reserved hosts cause an unmeasured result, with zero fake host calls', () => {
    const scenario = gateShardRerouteScenario({ head40: HEAD, base40: BASE, shards: [shards[0]!], receipts: [],
      hosts: [ { ...hosts[0]!, available: false }, { ...hosts[1]!, reserved: true } ] }, []);
    const observed = simGateShardHostReroute(scenario);
    expect(observed.actions[0]).toMatchObject({ kind: 'unmeasured', reason: 'no eligible host' });
    expect(observed.hostCalls).toEqual([]);
    expect(observed.reduction.status).toBe('unmeasured');
  });

  test('forced reroute replaces one complete receipt; failed fake remeasurement cannot be hidden by its predecessor', () => {
    const prior = receipt('pod-0', shards[0]!.files, 'wsl');
    const scenario = gateShardRerouteScenario({ head40: HEAD, base40: BASE, shards: [shards[0]!], hosts,
      receipts: [prior], rerouteShard: 'pod-0', shardHost: 'node-b' }, [
      { shardId: 'pod-0', host: 'node-b', status: 'unmeasured', failureIds: [], errorIds: [] },
    ]);
    const observed = simGateShardHostReroute(scenario);
    expect(observed.actions[0]).toMatchObject({ kind: 'run', host: 'node-b', replacing: prior });
    expect(observed.hostCalls).toHaveLength(1);
    expect(observed.reduction.status).toBe('unmeasured');
  });

  test('a host call without a scripted result remains unmeasured instead of inventing a pass', () => {
    const scenario = gateShardRerouteScenario({ head40: HEAD, base40: BASE, shards: [shards[0]!], hosts, receipts: [] }, []);
    const observed = simGateShardHostReroute(scenario);
    expect(observed.actions[0]).toMatchObject({ kind: 'run', host: 'node-b' });
    expect(observed.hostCalls).toHaveLength(1);
    expect(observed.receipts).toEqual([]);
    expect(observed.reduction.status).toBe('unmeasured');
  });
});
