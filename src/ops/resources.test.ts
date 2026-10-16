import { expect, test } from 'bun:test';
import { okCell, unmeasured, type MachineRow, type OverviewSnapshot, type PodMemberRow } from './overview.js';
import { resourcesFromOverview } from './resources.js';

const AT = Date.parse('2026-10-12T03:00:00.000Z');
const OBS = '2026-10-12T02:59:30.000Z';

function snapshot(hosts: MachineRow[], pods: PodMemberRow[]): OverviewSnapshot {
  const cell = <T>(value: T) => okCell(value, 'test ledger', OBS);
  return {
    generatedAt: '2026-10-12T03:00:00.000Z', instanceRoot: '/test', since: '최근 1h',
    release: { version: cell('0.2.28'), run: cell('none' as const), schedule: cell('none' as const), checklist: cell({ green: 1, yellow: 0, red: 0, done: 0, p0Yellow: 0 }) },
    tasks: { byOwner: cell({}), done: cell(0),
      launchable: cell({ count: 0, ids: [], skipped: { noTargetPath: 0, predecessorOpen: 0, alreadyHanded: 0 }, interim: true }),
      capacity: cell({ podUsed: 1, podTarget: 2, localUsed: 0, localMax: 0, free: 1 }) },
    machines: { hosts, pods, parents: cell({ count: 0, staleOver6h: 0, oldestHours: null }) },
    landings: cell({ count: 0, recent: [] }), loops: [],
  };
}

test('resources from overview: measured cells carry their value and observedAt', () => {
  const hosts: MachineRow[] = [{ name: 'grid-1', load: okCell({ load1: 1.5, load5: 2.5, load15: 3.5, cpuCount: 8, freeGb: 4.5, totalGb: 16, ageSeconds: 30 }, 'machine heartbeat', OBS) }];
  const pods: PodMemberRow[] = [{ context: 'pool-a', capacity: 2, occupied: okCell(1, 'pod pool background measure', OBS) }];
  const map = resourcesFromOverview(snapshot(hosts, pods), pods, AT);
  expect(map.generatedAt).toBe('2026-10-12T03:00:00.000Z');
  expect(map.readAt).toBe('2026-10-12T03:00:00.000Z');
  expect(map.missing).toEqual([]);
  expect(map.hosts).toEqual([{
    name: 'grid-1',
    load1: { value: 1.5, observedAt: OBS, missing: null },
    load5: { value: 2.5, observedAt: OBS, missing: null },
    load15: { value: 3.5, observedAt: OBS, missing: null },
    cpuCount: { value: 8, observedAt: OBS, missing: null },
    memFreeGb: { value: 4.5, observedAt: OBS, missing: null },
    memTotalGb: { value: 16, observedAt: OBS, missing: null },
  }]);
  expect(map.pods).toEqual([{ context: 'pool-a', capacity: 2, occupied: { value: 1, observedAt: OBS, missing: null } }]);
});

test('resources from overview: a missing host load keeps its reason on every cell, with observedAt when the ledger had one', () => {
  const observed = { value: null, observedAt: OBS, missing: '낡음(90초)' };
  const map = resourcesFromOverview(snapshot([{ name: 'grid-1', load: unmeasured('machine heartbeat', '낡음(90초)', OBS) }], []), [], AT);
  expect(map.hosts[0]).toMatchObject({ name: 'grid-1' });
  expect(map.hosts[0]?.load5).toEqual(observed);
  expect(map.hosts[0]?.memTotalGb).toEqual(observed);
  expect(map.hosts[0]?.load1?.missing).toBe('낡음(90초)');
});

test('resources from overview: the response-time pod overlay wins over the memo cell, and a gap keeps its reason', () => {
  const memoPods: PodMemberRow[] = [{ context: 'pool-a', capacity: 2, occupied: unmeasured('pod pool', 'pending') }];
  const overlay: PodMemberRow[] = [
    { context: 'pool-a', capacity: 2, occupied: okCell(1, 'pod pool background measure', OBS) },
    { context: 'pool-b', capacity: 3, occupied: unmeasured('pod pool background measure', '측정 대기') },
  ];
  const snapshotPods: PodMemberRow[] = [...memoPods, { context: 'pool-b', capacity: 3, occupied: unmeasured('pod pool', 'pending') }];
  const map = resourcesFromOverview(snapshot([], snapshotPods), overlay, AT);
  expect(map.pods).toEqual([
    { context: 'pool-a', capacity: 2, occupied: { value: 1, observedAt: OBS, missing: null } },
    { context: 'pool-b', capacity: 3, occupied: { value: null, observedAt: null, missing: '측정 대기' } },
  ]);
});

test('resources from overview: empty host ledger and empty pool config are named in missing', () => {
  const map = resourcesFromOverview(snapshot([], []), [], AT);
  expect(map.missing).toEqual(['hosts: 하트비트 원장 비어 있음', 'pods: 풀 설정 없음']);
  expect(map.hosts).toEqual([]);
  expect(map.pods).toEqual([]);
});
