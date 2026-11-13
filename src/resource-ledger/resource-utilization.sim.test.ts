import { expect, test } from 'bun:test';
import { parseResourceLedgerEvents, type HostReadinessHeartbeat, type ResourceLane, type ResourceLease, type ResourceLedgerEvent } from './resource-ledger.js';
import { resourceUtilizationView } from './resource-utilization.js';

// Source: RESOURCE-UTILIZATION-VIEW acceptance: six named lanes; idle means no lease and L15 < 10 percent.
const now = new Date('2026-11-12T06:00:00.000Z');
const at = now.toISOString();
const capacity = { gate: 2, train: 2, ta: 4, hand: 1, warm: 2, bench: 1 };
function created(lane: ResourceLane, host = 'node-b', id = `fp_test_${lane}`): ResourceLedgerEvent {
  const lease: ResourceLease = { id, fp: id, host, lane, resources: { cpu: 1 }, mission: {},
    ttlMs: 60_000, startedAt: at, heartbeatAt: at };
  return { event: 'lease-created', at, lease };
}
function heartbeat(host: string, load15Percent: number, observedAt = at): ResourceLedgerEvent {
  const value: HostReadinessHeartbeat = { host, at: observedAt, sshAvailable: true, maintenance: false,
    gateProtected: false, tools: {}, sample: { loadPercent: 5, load15Percent,
      memoryAvailablePercent: 50, rootDiskUsedPercent: 40, tmpDiskUsedPercent: 40 } };
  return { event: 'host-readiness-heartbeat', at: observedAt, heartbeat: value };
}
function replay(events: ResourceLedgerEvent[]): ResourceLedgerEvent[] {
  return parseResourceLedgerEvents(events.map(event => JSON.stringify(event)).join('\n'));
}

test('ledger events project every consumer lane into lease utilization without clamping overcommit', () => {
  const events = replay([
    ...(['gate', 'train', 'ta', 'hand', 'warm', 'bench'] as const).map(lane => created(lane)),
    created('hand', 'node-b', 'fp_test_extra_hand'), heartbeat('node-b', 5),
  ]);
  const view = resourceUtilizationView({ hosts: [{ host: 'node-b', capacity }], events, now });
  // 출처: R-TST43 — 위 fixture의 여섯 차선 lease + 추가 hand lease, capacity 합 12; 활용률은 lease 수/용량.
  expect(view.hosts[0]).toMatchObject({ host: 'node-b', leases: 7, capacity: 12, utilizationRatio: 7 / 12, idle: false });
  // 출처: R-TST43 — RESOURCE-UTILIZATION-VIEW 차선별 lease 합/용량; 이 fixture에서 사용 중인 차선만 비교.
  expect(view.lanes.filter(row => row.leases > 0).map(({ lane, utilizationRatio }) => [lane, utilizationRatio]))
    .toEqual([['gate', 0.5], ['train', 0.5], ['ta', 0.25], ['hand', 2], ['warm', 0.5], ['bench', 1]]);
  expect(view.idleHosts).toEqual([]);
});

test('ended and reaped leases leave the view; an expired but unreaped lease still blocks idle', () => {
  const expired = created('gate', 'unreaped');
  if (expired.event === 'lease-created') {
    expired.lease.startedAt = '2026-11-12T05:00:00.000Z';
    expired.lease.heartbeatAt = expired.lease.startedAt;
  }
  const events = replay([
    created('ta', 'ended'), { event: 'lease-ended', at, id: 'fp_test_ta', reason: 'done', stoppedBy: 'test' },
    created('warm', 'reaped'), { event: 'lease-reaped', at, id: 'fp_test_warm', expectedHeartbeatAt: at,
      expectedExpiresAt: at, observedAt: at, reason: 'expired-and-absent' },
    expired,
    heartbeat('ended', 5), heartbeat('reaped', 5), heartbeat('unreaped', 5),
  ]);
  const view = resourceUtilizationView({ hosts: ['ended', 'reaped', 'unreaped'].map(host => ({ host, capacity })), events, now });
  expect(view.idleHosts).toEqual(['ended', 'reaped']);
  expect(view.hosts.find(row => row.host === 'unreaped')).toMatchObject({ leases: 1, idle: false });
});

test('idle uses strict L15 boundary and latest fresh heartbeat, never missing or stale observations', () => {
  const events = replay([
    heartbeat('idle', 9), heartbeat('boundary', 10), heartbeat('busy', 11),
    heartbeat('stale', 0, '2026-11-12T05:00:00.000Z'),
    heartbeat('future', 0, '2026-11-12T07:00:00.000Z'),
    heartbeat('latest', 20), heartbeat('latest', 0, '2026-11-12T05:59:00.000Z'),
  ]);
  const hosts = ['idle', 'boundary', 'busy', 'stale', 'future', 'latest', 'missing'].map(host => ({ host, capacity }));
  const view = resourceUtilizationView({ hosts, events, now });
  expect(view.idleHosts).toEqual(['idle']);
  expect(view.hosts.find(row => row.host === 'boundary')?.idle).toBe(false);
  expect(view.hosts.filter(row => ['stale', 'future', 'missing'].includes(row.host)).map(row => row.idle))
    .toEqual([null, null, null]);
  expect(view.hosts.find(row => row.host === 'latest')).toMatchObject({ load15Percent: 20, idle: false });
});

test('zero, missing, and invalid capacity stay unmeasured instead of reporting zero utilization', () => {
  const view = resourceUtilizationView({ hosts: [{ host: 'node-b', capacity: { gate: 0, ta: Number.NaN, hand: -1 } }],
    events: replay([created('gate'), created('unknown')]), now });
  expect(view.lanes.filter(row => ['gate', 'train', 'ta', 'hand'].includes(row.lane)).map(row => row.utilizationRatio))
    .toEqual([null, null, null, null]);
  expect(view.hosts[0]).toMatchObject({ leases: 2, capacity: null, utilizationRatio: null, idle: false });
});

test('unknown consumers prevent idle and ledger hosts absent from inventory remain visible', () => {
  const view = resourceUtilizationView({ hosts: [], events: replay([created('unknown', 'unlisted'), heartbeat('observed-only', 5)]), now });
  expect(view.hosts.find(row => row.host === 'unlisted')).toMatchObject({ leases: 1, capacity: null, idle: false });
  expect(view.lanes.find(row => row.host === 'unlisted' && row.lane === 'unknown')).toMatchObject({ leases: 1, utilizationRatio: null });
  expect(view.idleHosts).toEqual(['observed-only']);
});
