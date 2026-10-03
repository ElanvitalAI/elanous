import { describe, expect, test } from 'bun:test';
import { parsePodPool, type PoolKubectl } from './pod-pool.js';
import { measurePoolLease, recommendConcurrency } from './pod-lease.js';

const gi = 1024 ** 3;
const node = (memory = '263471132Ki', cpu = '32') => JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory, cpu }, conditions: [{ type: 'Ready', status: 'True' }] } }] });
interface FixturePod {
  metadata: { namespace: string; name: string; labels: Record<string, string> };
  status: { phase?: string };
  spec: { nodeName?: string; containers: Array<{ resources: { limits: { memory: string }; requests?: { memory: string } } }>; initContainers?: Array<{ resources: { limits?: { memory: string }; requests?: { memory: string } } }> };
}
let podSerial = 0;
const pod = (phase: string, memory = '16Gi', labeled = true): FixturePod => ({
  metadata: { namespace: 'elanous-test', name: `fixture-${++podSerial}`, labels: labeled ? { 'elanous.substrate': 'pod', 'elanous.job': 'harness-job' } : {} },
  status: { phase }, spec: { nodeName: 'node-1', containers: [{ resources: { limits: { memory }, requests: { memory } } }] },
});
const fixture = (pods: ReturnType<typeof pod>[], nodes = node()): PoolKubectl => (args) => {
  expect(args.slice(0, 3)).toEqual(['--context', 'node-b', '--request-timeout=10s']);
  expect(args).toContain('get');
  if (args.includes('nodes')) return { status: 0, stdout: nodes, stderr: '' };
  if (args.includes('jobs')) expect(args).toContain('elanous-test');
  else expect(args).toContain('--all-namespaces');
  if (args.includes('jobs')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'harness-job', labels: { 'elanous.substrate': 'pod' } } }] }), stderr: '' };
  expect(args).toContain('pods');
  return { status: 0, stdout: JSON.stringify({ items: pods }), stderr: '' };
};
const measured = (pods: ReturnType<typeof pod>[], nodes = node()) => measurePoolLease(parsePodPool('node-b:20'), { kubectl: fixture(pods, nodes) });
const recommend = (pods: ReturnType<typeof pod>[], accounts = 10, nodes = node()) => recommendConcurrency(measured(pods, nodes), { capacity: 20, accounts, perAccount: 4 });

describe('pod lease read-only measurement and recommendation', () => {
  test('20 slots, 10 Running (6×16Gi + 4×32Gi): memory allows one 16Gi goal', () => {
    const pods = [...Array.from({ length: 6 }, () => pod('Running')), ...Array.from({ length: 4 }, () => pod('Running', '32Gi'))];
    const measuredPool = measured(pods);
    expect(measuredPool.members[0]).toMatchObject({ capacity: 20, running: 10, pending: 0, memoryLimitBytes: 224 * gi, allocatableCpuMillicores: 32_000 });
    expect(recommendConcurrency(measuredPool, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 1, limitedBy: 'memory', capacitySlots: 10, memorySlots: 1, accountSlots: 30 });
  });
  test('18 Running with plenty of memory: capacity allows two', () => {
    expect(recommend(Array.from({ length: 18 }, () => pod('Running', '1Gi')), 10, node('1024Gi'))).toMatchObject({ recommended: 2, limitedBy: 'capacity' });
  });
  test('Pending occupies capacity; negative slot budgets clamp to zero', () => {
    expect(recommend([pod('Running'), pod('Pending')], 10, node('1024Gi'))).toMatchObject({ running: 1, pending: 1, capacitySlots: 18, recommended: 18, limitedBy: 'capacity' });
    expect(recommend(Array.from({ length: 22 }, () => pod('Running')), 10, node('1024Gi'))).toMatchObject({ capacitySlots: 0, recommended: 0, limitedBy: 'capacity' });
  });
  test('accounts are observed only, never a bound (10-03 decision): zero accounts still recommend by slots and memory', () => {
    expect(recommend([], 0, node('1024Gi'))).toMatchObject({ recommended: 20, limitedBy: 'capacity', accountSlots: 0 });
    expect(recommend(Array.from({ length: 20 }, () => pod('Running')), 0, node('1024Gi'))).toMatchObject({ recommended: 0, limitedBy: 'capacity' });
  });
  test('configured per-goal memory and per-account slots are applied without usage percentages', () => {
    expect(recommendConcurrency(measured([pod('Running')], node('64Gi')), { capacity: 20, accounts: 1, perAccount: 2, perGoalMemory: '32Gi' })).toMatchObject({ memorySlots: 1, accountSlots: 1, recommended: 1 });
  });
  test('unreachable context is unknown, never zero', () => {
    const measure = measurePoolLease(parsePodPool('node-b:20'), { kubectl: () => ({ status: 1, stdout: '', stderr: 'connection refused' }) });
    expect(measure.members[0]).toMatchObject({ running: null, pending: null, allocatableMemoryBytes: null, reason: expect.stringContaining('connection refused') });
    expect(recommendConcurrency(measure, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null, limitedBy: null, reason: expect.stringContaining('측정 불가: cluster') });
  });
  test('a Pod with a substrate label and no job label is counted', () => {
    const labeled = { ...pod('Running'), metadata: { namespace: 'elanous-test', name: 'labeled', labels: { 'elanous.substrate': 'pod' } } };
    expect(measured([labeled]).members[0]).toMatchObject({ running: 1, memoryLimitBytes: 16 * gi });
  });
  test('finished init container does not add to a Running Pod memory limit', () => {
    const running = { ...pod('Running'), spec: { containers: [{ resources: { limits: { memory: '16Gi' } } }], initContainers: [{ resources: { limits: { memory: '64Gi' } } }] } };
    expect(measured([running]).members[0]?.memoryLimitBytes).toBe(16 * gi);
  });
  test('legacy harness Pod with only elanous.job is counted through the labeled Job', () => {
    const legacy = { ...pod('Running'), metadata: { namespace: 'elanous-test', name: 'legacy', labels: { 'elanous.job': 'harness-job' } } };
    expect(measured([legacy]).members[0]).toMatchObject({ running: 1, memoryLimitBytes: 16 * gi });
  });
  test('unlabeled infrastructure Pod is not counted', () => {
    const result = measured([pod('Running', '64Gi', false), pod('Running', '16Gi'), pod('Pending')]);
    expect(result.members[0]).toMatchObject({ running: 1, pending: 1, memoryLimitBytes: 16 * gi });
  });
  test('each member has its own memory budget; unused capacity on a full cluster cannot be borrowed', () => {
    const members = parsePodPool('node-b:20,other:20');
    const kubectl: PoolKubectl = (args) => args[1] === 'node-b'
      ? fixture(Array.from({ length: 10 }, () => pod('Running', '16Gi')), node('160Gi'))(args)
      : { status: 0, stdout: args.includes('nodes') ? node('16Gi') : JSON.stringify({ items: [] }), stderr: '' };
    const measure = measurePoolLease(members, { kubectl });
    expect(recommendConcurrency(measure, { capacity: 40, accounts: 10, perAccount: 4 }).memorySlots).toBe(1);
  });
  test('disjoint capacity and memory across clusters never recommend an unplaceable goal', () => {
    const members = parsePodPool('node-b:2,other:2');
    const kubectl: PoolKubectl = (args) => {
      const first = args[1] === 'node-b';
      if (args.includes('nodes')) return { status: 0, stdout: node(first ? '64Gi' : '31Gi'), stderr: '' };
      if (args.includes('jobs')) return { status: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
      return { status: 0, stdout: JSON.stringify({ items: first ? [pod('Running'), pod('Running')] : [pod('Running')] }), stderr: '' };
    };
    const measure = measurePoolLease(members, { kubectl });
    expect(measure.members.map((m) => ({ capacity: m.capacity, running: m.running, freeMemory: m.allocatableMemoryBytes! - m.memoryLimitBytes! })))
      .toEqual([{ capacity: 2, running: 2, freeMemory: 32 * gi }, { capacity: 2, running: 1, freeMemory: 15 * gi }]);
    expect(recommendConcurrency(measure, { capacity: 4, accounts: 10, perAccount: 4 })).toMatchObject({
      capacitySlots: 1, memorySlots: 2, placeableSlots: 0, accountSlots: 37, recommended: 0, limitedBy: 'memory',
    });
  });
  test('an unassigned Pending harness Pod occupies a slot but not a node memory reservation', () => {
    const pending = { ...pod('Pending'), spec: { ...pod('Pending').spec, nodeName: '' } };
    const m = measured([pending], node('16Gi'));
    expect(m.members[0]).toMatchObject({ pending: 1, running: 0, availableMemoryByNodeBytes: [16 * gi] });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 1, capacitySlots: 19, placeableSlots: 1 });
  });
  test('a foreign namespace reservation exhausts memory despite empty harness slots', () => {
    const infrastructure = { ...pod('Running', '16Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} } };
    const m = measured([infrastructure], node('16Gi'));
    expect(m.members[0]).toMatchObject({ running: 0, memoryLimitBytes: 0, availableMemoryByNodeBytes: [0] });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, limitedBy: 'memory' });
  });
  test('a foreign Pod limit without an explicit request reserves memory without counting as harness Running', () => {
    const foreign = { ...pod('Running', '16Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} }, spec: { ...pod('Running').spec, containers: [{ resources: { limits: { memory: '16Gi' } } }] } };
    const m = measured([foreign], node('16Gi'));
    expect(m.members[0]).toMatchObject({ running: 0, memoryLimitBytes: 0, availableMemoryByNodeBytes: [0] });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, limitedBy: 'memory' });
  });
  test('node-local availability reflects the largest init request and Pod overhead without changing Running app limits', () => {
    const running = { ...pod('Running'), spec: { ...pod('Running').spec,
      initContainers: [{ resources: { requests: { memory: '32Gi' } } }], overhead: { memory: '1Gi' } } };
    const m = measured([running], node('48Gi'));
    expect(m.members[0]).toMatchObject({ memoryLimitBytes: 16 * gi, availableMemoryByNodeBytes: [15 * gi] });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, memorySlots: 2, placeableSlots: 0, limitedBy: 'memory' });
  });
  test('a foreign reservation is subtracted once, not once per harness Pod', () => {
    const foreign = { ...pod('Running', '16Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} } };
    const m = measured([foreign, pod('Running')], node('48Gi'));
    expect(m.members[0]).toMatchObject({ running: 1, memoryLimitBytes: 16 * gi, availableMemoryByNodeBytes: [16 * gi] });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 1, placeableSlots: 1, limitedBy: 'memory' });
  });
  test('node-local reservations cannot be pooled between nodes for a 16Gi goal', () => {
    const nodes = JSON.stringify({ items: [
      { metadata: { name: 'node-1' }, status: { allocatable: { memory: '16Gi', cpu: '4' }, conditions: [{ type: 'Ready', status: 'True' }] } },
      { metadata: { name: 'node-2' }, status: { allocatable: { memory: '16Gi', cpu: '4' }, conditions: [{ type: 'Ready', status: 'True' }] } },
    ] });
    const first = { ...pod('Running', '8Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} } };
    const second = { ...first, metadata: { ...first.metadata, name: 'foreign-2' }, spec: { ...first.spec, nodeName: 'node-2' } };
    const m = measured([first, second], nodes);
    expect(m.members[0]?.availableMemoryByNodeBytes).toEqual([8 * gi, 8 * gi]);
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, memorySlots: 2, placeableSlots: 0, limitedBy: 'memory' });
  });
  test('NotReady and cordoned nodes cannot place a goal despite abundant allocatable memory', () => {
    for (const unavailable of [
      { status: { allocatable: { memory: '128Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'False' }] } },
      { status: { allocatable: { memory: '128Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'True' }] }, spec: { unschedulable: true } },
    ]) {
      const nodes = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, ...unavailable }] });
      const m = measured([], nodes);
      expect(m.members[0]).toMatchObject({ allocatableMemoryBytes: 128 * gi, availableMemoryByNodeBytes: [] });
      expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, limitedBy: 'memory', placeableSlots: 0 });
    }
  });
  test('a NoSchedule/NoExecute taint keeps toleration-less harness Jobs off the node; PreferNoSchedule does not', () => {
    for (const effect of ['NoSchedule', 'NoExecute']) {
      const nodes = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '128Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'True' }] }, spec: { taints: [{ key: 'dedicated', value: 'gpu', effect }] } }] });
      const m = measured([], nodes);
      expect(m.members[0]).toMatchObject({ allocatableMemoryBytes: 128 * gi, availableMemoryByNodeBytes: [] });
      expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, placeableSlots: 0 });
    }
    const soft = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '128Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'True' }] }, spec: { taints: [{ key: 'x', effect: 'PreferNoSchedule' }] } }] });
    expect(measured([], soft).members[0]?.availableMemoryByNodeBytes).toEqual([128 * gi]);
  });
  test('a malformed taint list makes node placement unknown', () => {
    const nodes = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '128Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'True' }] }, spec: { taints: [{ key: 'x' }] } }] });
    expect(recommend([], 10, nodes)).toMatchObject({ recommended: null, reason: expect.stringContaining('측정 불가: cluster') });
  });
  test('missing node readiness cannot be interpreted as available memory', () => {
    const nodes = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '128Gi', cpu: '32' } } }] });
    expect(recommend([], 10, nodes)).toMatchObject({ recommended: null, reason: expect.stringContaining('측정 불가: cluster') });
  });
  test('missing or Unknown phase makes the whole measurement unknown, including foreign Pods', () => {
    for (const status of [{}, { phase: 'Unknown' }]) {
      const foreign = { ...pod('Running', '16Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} }, status };
      const m = measured([foreign], node('32Gi'));
      expect(m.members[0]).toMatchObject({ running: null, pending: null, memoryLimitBytes: null, availableMemoryByNodeBytes: null, reason: expect.stringContaining('missing/Unknown phase') });
      expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null, limitedBy: null, reason: expect.stringContaining('측정 불가: cluster') });
    }
  });
  test('duplicate Pod name makes reservations unknown instead of double-counting', () => {
    const duplicate = pod('Running');
    const m = measured([duplicate, duplicate], node('48Gi'));
    expect(m.members[0]?.availableMemoryByNodeBytes).toBeNull();
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null });
  });
  test('a foreign Pod with invalid reservation cannot turn missing data into free space', () => {
    const foreign = { ...pod('Running', 'bad', false), metadata: { namespace: 'system', name: 'foreign', labels: {} } };
    const m = measured([foreign], node('16Gi'));
    expect(m.members[0]?.availableMemoryByNodeBytes).toBeNull();
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null, limitedBy: null });
  });
  test('unassigned foreign Running Pod makes memory unknown rather than free', () => {
    const foreign = { ...pod('Running', '16Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} }, spec: { ...pod('Running').spec, nodeName: undefined } };
    const m = measured([foreign], node('16Gi'));
    expect(m.members[0]?.availableMemoryByNodeBytes).toBeNull();
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null, reason: expect.stringContaining('측정 불가: cluster') });
  });
  test('a failed all-namespace Pod read leaves reservation and recommendation unknown', () => {
    const kubectl: PoolKubectl = (args) => args.includes('pods')
      ? { status: 1, stdout: '', stderr: 'forbidden' } : fixture([])(args);
    const measure = measurePoolLease(parsePodPool('node-b:20'), { kubectl });
    expect(measure.members[0]).toMatchObject({ running: null, availableMemoryByNodeBytes: null, reason: expect.stringContaining('forbidden') });
    expect(recommendConcurrency(measure, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null, limitedBy: null });
  });
  test('malformed Job metadata cannot hide legacy harness Pods from the counts', () => {
    const kubectl: PoolKubectl = (args) => args.includes('jobs')
      ? { status: 0, stdout: JSON.stringify({ items: [{ metadata: { labels: { 'elanous.substrate': 'pod' } } }] }), stderr: '' }
      : fixture([pod('Running')])(args);
    const m = measurePoolLease(parsePodPool('node-b:20'), { kubectl });
    expect(m.members[0]).toMatchObject({ running: null, memoryLimitBytes: null, reason: expect.stringContaining('cluster jobs') });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null });
  });
  test('a malformed jobs response does not erase the node reading', () => {
    const kubectl: PoolKubectl = (args) => args.includes('jobs')
      ? { status: 0, stdout: '{bad', stderr: '' } : fixture([])(args);
    const member = measurePoolLease(parsePodPool('node-b:20'), { kubectl }).members[0]!;
    expect(member).toMatchObject({ allocatableCpuMillicores: 32_000, running: null, memoryLimitBytes: null, reason: expect.stringContaining('cluster jobs') });
  });
  test('malformed node or missing Running memory limits are unknown rather than zero', () => {
    expect(measured([pod('Running', '')]).members[0]?.memoryLimitBytes).toBeNull();
    expect(measured([], JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: 'bad', cpu: '32' } } }] })).members[0]?.allocatableMemoryBytes).toBeNull();
  });
});
