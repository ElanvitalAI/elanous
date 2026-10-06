import { afterEach, expect, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { podSelfImplementSpawn } from './self-implement-pod.js';
import { PodPoolScheduler, parsePodPool } from './pod-pool.js';
import type { PoolLeaseRecommendation } from './pod-lease.js';

// LAUNCH-STALL (10-06): a 12.5GB member under a 16Gi standard Job waited 22 min silently; Pod authoring sat 3–5 h with no event.
const GiB = 2 ** 30;
const events: Array<{ event: string; data: Record<string, unknown> }> = [];
const off = debug.registerSink({ name: 'launch-stall-test', emit: ({ category, event, data }) => {
  if (category === 'harness.launch') events.push({ event, data: data as Record<string, unknown> });
} });
afterEach(() => { events.length = 0; });
process.on('exit', () => off());

const status = (recommended: number) => (): PoolLeaseRecommendation => ({ recommended, accountSlots: 0, limitedBy: recommended ? 'capacity' : 'memory', reason: null,
  capacitySlots: 2, memorySlots: recommended, placeableSlots: recommended, running: 0, pending: 0 } as PoolLeaseRecommendation);

test('every member too small for the Job limit fails fast with the reason and applies no Job', async () => {
  const calls: string[] = [];
  const pool = new PodPoolScheduler(parsePodPool('small:2'), { status: status(0), pollMs: 2,
    memberMemory: () => [{ context: 'small', allocatableMemoryBytes: 12.5 * GiB }] });
  const spawn = podSelfImplementSpawn({ pool, env: {}, pollMs: 2, launchStallMs: 10_000,
    kubectl: (args) => { calls.push(args.join(' ')); return { status: 0, stdout: '', stderr: '' }; } });
  const result = await spawn({ feature: 'standard goal', spaceId: 'unfit-all' }).done;
  expect(result.error?.code).toBe('pod-pool-unfit');
  expect(result.error?.message).toContain('16Gi');
  expect(result.error?.message).toContain('small 12.5GiB');
  expect(events.filter((e) => e.event === 'launch-member-skipped')).toEqual([
    { event: 'launch-member-skipped', data: expect.objectContaining({ member: 'small', reason: 'memory-never-fits', memoryLimit: '16Gi' }) }]);
  expect(calls.filter((c) => c.includes('apply'))).toEqual([]);
});

const completingKubectl = (calls: string[][]) => (args: readonly string[]) => {
  calls.push([...args]);
  if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
  return { status: 0, stdout: '', stderr: '' };
};

test('an unfit member is skipped for this launch and the Job is applied on a member that fits', async () => {
  const calls: string[][] = [];
  const pool = new PodPoolScheduler(parsePodPool('small:2,big:2'), { status: status(2), pollMs: 2,
    memberMemory: () => [{ context: 'small', allocatableMemoryBytes: 12.5 * GiB }, { context: 'big', allocatableMemoryBytes: 400 * GiB }],
    occupancy: () => ({ small: { occupied: 0 }, big: { occupied: 0 } }) });
  const done = await podSelfImplementSpawn({ kubectl: completingKubectl(calls), pool, pollMs: 1, launchStallMs: 60_000, imageCommit: null, sleep: async () => {},
    credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }) })({ spaceId: 'partial-unfit', feature: 'standard goal' }).done;
  expect(done.exitCode).toBe(0);
  expect(events.filter((e) => e.event === 'launch-member-skipped').map((e) => e.data.member)).toEqual(['small']);
  const applies = calls.filter((c) => c.includes('apply'));
  expect(applies.length).toBeGreaterThan(0);
  expect(applies.every((c) => c[0] === '--context' && c[1] === 'big')).toBe(true);
  // The skip is per launch: the shared scheduler still offers the small member to a launch that fits it.
  expect((await pool.tryAcquire())?.context).toBe('small');
  // A member whose memory could not be read is not judged unfit (unknown ≠ too small).
  const unknown = new PodPoolScheduler(parsePodPool('x:1'), { status: status(1), memberMemory: () => [{ context: 'x', allocatableMemoryBytes: null }] });
  expect(await unknown.unfitMembers(16 * GiB)).toEqual([]);
});

test('admission waiting past the cap emits one launch-stalled event with the measured reason', async () => {
  const pool = new PodPoolScheduler(parsePodPool('fake:2'), { status: status(0), pollMs: 2,
    memberMemory: () => [{ context: 'fake', allocatableMemoryBytes: 400 * GiB }] });
  const controller = new AbortController();
  const spawn = podSelfImplementSpawn({ pool, env: {}, pollMs: 2, launchStallMs: 30,
    kubectl: () => ({ status: 0, stdout: '', stderr: '' }) });
  const job = spawn({ feature: 'standard goal', spaceId: 'stalled-admission', signal: controller.signal });
  await Bun.sleep(150);
  controller.abort();
  const result = await job.done;
  expect(result.error?.code).toBe('aborted');
  const stalled = events.filter((e) => e.event === 'launch-stalled');
  expect(stalled).toHaveLength(1);
  expect(stalled[0]!.data).toMatchObject({ spaceId: 'stalled-admission', stage: 'admission' });
  expect(String(stalled[0]!.data.reason)).toContain('recommended=0');
  expect(events.filter((e) => e.event === 'launch-member-skipped')).toEqual([]);
});

test('a launch admitted and placed before the cap emits no stall event', async () => {
  const calls: string[][] = [];
  const pool = new PodPoolScheduler(parsePodPool('big:2'), { status: status(2), pollMs: 2,
    memberMemory: () => [{ context: 'big', allocatableMemoryBytes: 400 * GiB }], occupancy: () => ({ big: { occupied: 0 } }) });
  const done = await podSelfImplementSpawn({ kubectl: completingKubectl(calls), pool, pollMs: 1, launchStallMs: 60_000, imageCommit: null, sleep: async () => {},
    credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }) })({ spaceId: 'quick-place', feature: 'standard goal' }).done;
  expect(done.exitCode).toBe(0);
  expect(calls.some((c) => c.includes('apply'))).toBe(true);
  expect(events.filter((e) => e.event === 'launch-stalled' || e.event === 'launch-member-skipped')).toEqual([]);
});

test('a member whose memory could not be read is not skipped: the Job is applied there and no skip event is logged', async () => {
  const calls: string[][] = [];
  const pool = new PodPoolScheduler(parsePodPool('unread:2'), { status: status(2), pollMs: 2,
    memberMemory: () => [{ context: 'unread', allocatableMemoryBytes: null }], occupancy: () => ({ unread: { occupied: 0 } }) });
  const done = await podSelfImplementSpawn({ kubectl: completingKubectl(calls), pool, pollMs: 1, launchStallMs: 60_000, imageCommit: null, sleep: async () => {},
    credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }) })({ spaceId: 'unread-memory', feature: 'standard goal' }).done;
  expect(done.exitCode).toBe(0);
  const applies = calls.filter((c) => c.includes('apply'));
  expect(applies.length).toBeGreaterThan(0);
  expect(applies.every((c) => c[0] === '--context' && c[1] === 'unread')).toBe(true);
  expect(events.filter((e) => e.event === 'launch-member-skipped')).toEqual([]);
});

test('a pool-slot wait past the cap reports the per-member free slots, not the admission lease', async () => {
  const pool = new PodPoolScheduler(parsePodPool('busy:2'), { status: status(2), pollMs: 2,
    memberMemory: () => [{ context: 'busy', allocatableMemoryBytes: 400 * GiB }], occupancy: () => ({ busy: { occupied: 2 } }) });
  const controller = new AbortController();
  const job = podSelfImplementSpawn({ pool, env: {}, pollMs: 2, launchStallMs: 30, kubectl: () => ({ status: 0, stdout: '', stderr: '' }) })(
    { feature: 'standard goal', spaceId: 'slot-full', signal: controller.signal });
  await Bun.sleep(150);
  controller.abort();
  await job.done;
  const stalled = events.filter((e) => e.event === 'launch-stalled');
  expect(stalled).toHaveLength(1);
  expect(stalled[0]!.data).toMatchObject({ stage: 'pool-slot' });
  expect(String(stalled[0]!.data.reason)).toContain('free={"busy":0}');
});
