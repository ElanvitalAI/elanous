import { describe, expect, test } from 'bun:test';
import { PodLeaseAdmission } from './admission.js';
import type { PoolLeaseRecommendation } from '../task-orchestrator/surfaces/pod-lease.js';

function status(recommended: number | null, accountSlots: number | null = 0): PoolLeaseRecommendation {
  return { recommended, accountSlots, limitedBy: 'capacity', reason: null, capacitySlots: recommended,
    memorySlots: recommended, placeableSlots: recommended, running: 0, pending: 0 };
}

const tick = async () => { await Bun.sleep(0); };

describe('pod lease FIFO admission', () => {
  test('admits two launches from recommended N=2 and queues the third until release', async () => {
    const admission = new PodLeaseAdmission({ status: () => status(2, 0) });
    const admitted: string[] = [];
    const first = admission.acquire().then((release) => { admitted.push('a'); return release; });
    const second = admission.acquire().then((release) => { admitted.push('b'); return release; });
    const third = admission.acquire().then((release) => { admitted.push('c'); return release; });
    const releaseA = await first;
    const releaseB = await second;
    await tick();
    expect(admitted).toEqual(['a', 'b']);
    expect(admission.snapshot()).toMatchObject({ active: 2, queued: 1, recommended: 2 });
    releaseA();
    const releaseC = await third;
    expect(admitted).toEqual(['a', 'b', 'c']);
    releaseA();
    expect(admission.snapshot()).toMatchObject({ active: 2, queued: 0, recommended: 2 });
    releaseB(); releaseC();
  });

  test('zero and unknown recommendation queue without falling back to account count or capacity', async () => {
    let recommended: number | null = null;
    const admission = new PodLeaseAdmission({ status: () => status(recommended, 100), pollMs: 1_000 });
    const order: string[] = [];
    const a = admission.acquire().then((release) => { order.push('a'); return release; });
    const b = admission.acquire().then((release) => { order.push('b'); return release; });
    await tick();
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 2 });
    recommended = 0;
    await admission.refresh();
    expect(order).toEqual([]);
    recommended = 1;
    await admission.refresh();
    const releaseA = await a;
    expect(order).toEqual(['a']);
    releaseA();
    const releaseB = await b;
    expect(order).toEqual(['a', 'b']);
    releaseB();
  });

  test('rechecks the pool and admits the oldest queued launch when an external slot opens', async () => {
    let recommended = 0;
    const admission = new PodLeaseAdmission({ status: () => status(recommended), pollMs: 2 });
    const first = admission.acquire();
    const second = admission.acquire();
    await tick();
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 2 });
    recommended = 1;
    const releaseFirst = await first;
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 1 });
    releaseFirst();
    const releaseSecond = await second;
    releaseSecond();
  });

  test('refresh during an in-flight status check rechecks and admits in FIFO order without polling', async () => {
    let resolveInitial!: (value: PoolLeaseRecommendation) => void;
    const initial = new Promise<PoolLeaseRecommendation>((resolve) => { resolveInitial = resolve; });
    let checks = 0;
    const admission = new PodLeaseAdmission({
      status: () => ++checks === 3 ? initial : status(checks > 3 ? 2 : 0, 100),
      pollMs: 60_000,
    });
    const admitted: string[] = [];
    const first = admission.acquire().then((release) => { admitted.push('first'); return release; });
    const second = admission.acquire().then((release) => { admitted.push('second'); return release; });
    await tick();
    expect(checks).toBe(2);
    const inFlight = admission.refresh();
    expect(checks).toBe(3);
    const refreshed = admission.refresh();
    resolveInitial(status(0, 100));
    await Promise.all([inFlight, refreshed]);
    const releaseFirst = await first;
    const releaseSecond = await second;
    expect(admitted).toEqual(['first', 'second']);
    expect(admission.snapshot()).toMatchObject({ active: 2, queued: 0, recommended: 2 });
    expect(checks).toBe(4);
    releaseFirst(); releaseSecond();
  });

  test('an unmerged predecessor waits with a reason but does not block followers from free slots', async () => {
    let merged = false;
    const checked: Array<string | number> = [];
    const admission = new PodLeaseAdmission({
      status: () => status(2),
      dependencyMerged: (after) => { checked.push(after); return merged; },
      pollMs: 1_000,
    });
    const order: string[] = [];
    const first = admission.acquire(undefined, 'goal-before').then((release) => { order.push('first'); return release; });
    const second = admission.acquire().then((release) => { order.push('second'); return release; });
    const releaseSecond = await second;
    expect(checked).toContain('goal-before');
    expect(order).toEqual(['second']);
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 1, recommended: 2,
      waiting: [{ after: 'goal-before', reason: 'predecessor-unmerged:goal-before' }] });
    merged = true;
    await admission.refresh();
    const releaseFirst = await first;
    expect(order).toEqual(['second', 'first']);
    releaseFirst(); releaseSecond();
  });

  test('a predecessor closed without merging rejects as blocked and frees the queue', async () => {
    const admission = new PodLeaseAdmission({ status: () => status(1), dependencyMerged: () => 'blocked', pollMs: 1_000 });
    const blocked = admission.acquire(undefined, 123).catch((error: Error) => error.message);
    const next = admission.acquire();
    expect(await blocked).toBe('pod lease predecessor blocked: 123 was closed without merging');
    const release = await next;
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0, waiting: [] });
    release();
  });

  test('a queued item with no predecessor reports no-free-slot as its waiting reason', async () => {
    const admission = new PodLeaseAdmission({ status: () => status(0), pollMs: 1_000 });
    const controller = new AbortController();
    const waiting = admission.acquire(controller.signal).catch(() => undefined);
    await tick();
    expect(admission.snapshot().waiting).toEqual([{ reason: 'no-free-slot' }]);
    controller.abort(); await waiting;
  });

  test('the dependency check receives an abort signal that fires when the waiter is cancelled', async () => {
    let seen: AbortSignal | undefined;
    const admission = new PodLeaseAdmission({ status: () => status(1), dependencyMerged: (_after, signal) => { seen = signal; return new Promise(() => {}); }, pollMs: 60_000 });
    const controller = new AbortController();
    const waiting = admission.acquire(controller.signal, 'goal-before').catch((error: Error) => error.message);
    await tick();
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(await waiting).toBe('pod lease admission aborted');
    expect(seen?.aborted).toBe(true);
  });

  test('merged PR predecessor admits on refresh, while unknown or failed dependency checks stay waiting', async () => {
    let state: 'unknown' | 'error' | 'merged' = 'unknown';
    const checked: Array<string | number> = [];
    const admission = new PodLeaseAdmission({
      status: () => status(1),
      dependencyMerged: (after) => {
        checked.push(after);
        if (state === 'error') throw new Error('dependency unavailable');
        return state === 'merged';
      },
      pollMs: 1_000,
    });
    const waiting = admission.acquire(undefined, 123);
    await tick();
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 1, recommended: 1 });
    state = 'error';
    await admission.refresh();
    expect(admission.snapshot().queued).toBe(1);
    state = 'merged';
    await admission.refresh();
    const release = await waiting;
    expect(checked).toEqual([123, 123, 123]);
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0 });
    release();
  });

  test('an after item without a dependency checker remains queued rather than admitting optimistically', async () => {
    const admission = new PodLeaseAdmission({ status: () => status(1), pollMs: 1_000 });
    const controller = new AbortController();
    const waiting = admission.acquire(controller.signal, 'goal-before').catch((error: Error) => error.message);
    await tick();
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 1, recommended: 1 });
    controller.abort();
    expect(await waiting).toBe('pod lease admission aborted');
  });

  test('aborting an unresolved dependency check admits the next launch without waiting for the check', async () => {
    let finishCheck!: (merged: boolean) => void;
    let checkStarted!: () => void;
    const started = new Promise<void>((resolve) => { checkStarted = resolve; });
    const check = new Promise<boolean>((resolve) => { finishCheck = resolve; });
    const admission = new PodLeaseAdmission({
      status: () => status(1),
      dependencyMerged: () => { checkStarted(); return check; },
      pollMs: 60_000,
    });
    const controller = new AbortController();
    const cancelled = admission.acquire(controller.signal, 'goal-before').catch((error: Error) => error.message);
    const next = admission.acquire();
    await started;
    controller.abort();
    expect(await cancelled).toBe('pod lease admission aborted');
    const release = await Promise.race([
      next,
      Bun.sleep(500).then(() => { throw new Error('next launch blocked by cancelled dependency check'); }),
    ]);
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0 });
    finishCheck(true);
    await tick();
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0 });
    release();
  });

  test('queued cancellation removes only the cancelled launch without blocking followers', async () => {
    let recommended = 0;
    const admission = new PodLeaseAdmission({ status: () => status(recommended), pollMs: 1_000 });
    const cancel = new AbortController();
    const cancelled = admission.acquire(cancel.signal).catch((error: Error) => error.message);
    const next = admission.acquire();
    await tick();
    cancel.abort();
    expect(await cancelled).toBe('pod lease admission aborted');
    recommended = 1;
    await admission.refresh();
    const release = await next;
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0 });
    release();
  });
});
