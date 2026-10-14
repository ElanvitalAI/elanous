import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
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

  test('a merged predecessor keeps its place ahead of a follower when one slot opens', async () => {
    const admission = new PodLeaseAdmission({ status: () => status(1), dependencyMerged: async () => true, pollMs: 60_000 });
    const order: string[] = [];
    const first = admission.acquire(undefined, 'earlier').then((release) => { order.push('first'); return release; });
    const second = admission.acquire().then((release) => { order.push('second'); return release; });
    const releaseFirst = await first;
    expect(order).toEqual(['first']);
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 1 });
    releaseFirst();
    const releaseSecond = await second;
    expect(order).toEqual(['first', 'second']);
    releaseSecond();
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

  test('late blocked predecessor clears the poll timer after the last waiter leaves', async () => {
    let finishCheck!: (state: 'blocked') => void;
    const dependency = new Promise<'blocked'>((resolve) => { finishCheck = resolve; });
    const admission = new PodLeaseAdmission({ status: () => status(1), dependencyMerged: () => dependency, pollMs: 60_000 });
    const blocked = admission.acquire(undefined, 'earlier').catch((error: Error) => error.message);
    const handles = admission as unknown as { timer?: ReturnType<typeof setTimeout>; expiryTimer?: ReturnType<typeof setTimeout> };
    for (let attempt = 0; attempt < 100 && handles.timer === undefined; attempt++) await Bun.sleep(5);
    expect(admission.snapshot().queued).toBe(1);
    expect(handles.timer).toBeDefined();
    finishCheck('blocked');
    expect(await blocked).toBe('pod lease predecessor blocked: earlier was closed without merging');
    expect(admission.snapshot().queued).toBe(0);
    expect(Number(handles.timer !== undefined) + Number(handles.expiryTimer !== undefined)).toBe(0);
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

  test('rejects an overdue no-free-slot waiter, removes it, and logs starvation without disturbing the next waiter', async () => {
    let now = 0;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      let recommended = 0;
      const admission = new PodLeaseAdmission({ status: () => status(recommended), pollMs: 60_000, maxWaitMs: 60_000 });
      const expired = admission.acquire().catch((error: Error) => error.message);
      await admission.refresh();
      now = 59_000;
      const follower = admission.acquire();
      await admission.refresh();
      now = 60_001;
      await tick();
      await admission.refresh();
      expect(await expired).toBe('pod lease admit-starved: waited 1m · reason no-free-slot');
      expect(log).toHaveBeenCalledWith('pod-lease', 'admit-starved',
        { waitedMs: 60_001, reason: 'no-free-slot', after: undefined });
      expect(admission.snapshot()).toMatchObject({ active: 0, queued: 1, waiting: [{ reason: 'no-free-slot' }] });
      recommended = 1;
      await admission.refresh();
      expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0 });
      const release = await follower;
      release();
    } finally {
      clock.mockRestore();
      log.mockRestore();
    }
  });

  test('automatically rejects and dequeues a starved slot waiter before the next poll', async () => {
    const admission = new PodLeaseAdmission({ status: () => status(0), pollMs: 200, maxWaitMs: 10 });
    const waiting = admission.acquire().catch((error: Error) => error.message);
    await Bun.sleep(50);
    expect(await Promise.race([
      waiting,
      Bun.sleep(50).then(() => 'still waiting'),
    ])).toMatch(/^pod lease admit-starved: waited 0m · reason no-free-slot$/);
    expect(admission.snapshot().queued).toBe(0);
  });

  test('admits a follower from a free slot while the predecessor check never responds', async () => {
    let checkStarted!: () => void;
    const started = new Promise<void>((resolve) => { checkStarted = resolve; });
    const admission = new PodLeaseAdmission({
      status: () => status(1),
      dependencyMerged: () => { checkStarted(); return new Promise<boolean>(() => {}); },
      pollMs: 200,
      maxWaitMs: 10,
    });
    const controller = new AbortController();
    const predecessor = admission.acquire(controller.signal, 'earlier').catch((error: Error) => error.message);
    await started;
    const follower = admission.acquire();
    const release = await Promise.race([
      follower,
      Bun.sleep(100).then(() => { throw new Error('follower blocked by unresolved predecessor'); }),
    ]);
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 1, recommended: 1,
      waiting: [{ after: 'earlier', reason: 'predecessor-unmerged:earlier' }] });
    await Bun.sleep(30);
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 1,
      waiting: [{ after: 'earlier', reason: 'predecessor-unmerged:earlier' }] });
    release();
    controller.abort();
    expect(await predecessor).toBe('pod lease admission aborted');
  });

  test('expires a follower while a predecessor check is still unresolved', async () => {
    let checkStarted!: () => void;
    const started = new Promise<void>((resolve) => { checkStarted = resolve; });
    let finishCheck!: (merged: boolean) => void;
    const check = new Promise<boolean>((resolve) => { finishCheck = resolve; });
    const admission = new PodLeaseAdmission({
      status: () => status(0),
      dependencyMerged: () => { checkStarted(); return check; },
      pollMs: 200,
      maxWaitMs: 10,
    });
    const controller = new AbortController();
    const predecessor = admission.acquire(controller.signal, 'earlier').catch((error: Error) => error.message);
    await started;
    const follower = admission.acquire().catch((error: Error) => error.message);
    expect(await Promise.race([
      follower,
      Bun.sleep(100).then(() => 'still waiting'),
    ])).toBe('pod lease admit-starved: waited 0m · reason no-free-slot');
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 1,
      waiting: [{ after: 'earlier' }] });
    finishCheck(false);
    await admission.refresh();
    expect(admission.snapshot().waiting).toEqual([{ after: 'earlier', reason: 'predecessor-unmerged:earlier' }]);
    controller.abort();
    expect(await predecessor).toBe('pod lease admission aborted');
  });

  test('an already overdue slot waiter cannot jump the queue when a slot opens', async () => {
    let now = 0;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let recommended = 0;
      const admission = new PodLeaseAdmission({ status: () => status(recommended), pollMs: 60_000, maxWaitMs: 1_000 });
      const expired = admission.acquire().catch((error: Error) => error.message);
      await admission.refresh();
      now = 1_001;
      recommended = 1;
      const next = admission.acquire();
      await admission.refresh();
      expect(await expired).toBe('pod lease admit-starved: waited 0m · reason no-free-slot');
      const release = await next;
      expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0 });
      release();
    } finally {
      clock.mockRestore();
    }
  });

  test('defaults to a 30-minute slot-wait cap', async () => {
    let now = 0;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const admission = new PodLeaseAdmission({ status: () => status(0), pollMs: 60_000 });
      const waiting = admission.acquire().catch((error: Error) => error.message);
      await admission.refresh();
      now = 30 * 60_000;
      await admission.refresh();
      expect(admission.snapshot().queued).toBe(1);
      now++;
      await admission.refresh();
      expect(await waiting).toBe('pod lease admit-starved: waited 30m · reason no-free-slot');
      expect(admission.snapshot().queued).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  test('an unmerged predecessor is exempt from the slot wait cap and still lets a follower through', async () => {
    let now = 0;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let merged = false;
      const admission = new PodLeaseAdmission({ status: () => status(1), dependencyMerged: () => merged,
        pollMs: 60_000, maxWaitMs: 1_000 });
      const first = admission.acquire(undefined, 'earlier');
      await admission.refresh();
      now = 120_000;
      await admission.refresh();
      expect(admission.snapshot().waiting).toEqual([{ after: 'earlier', reason: 'predecessor-unmerged:earlier' }]);
      const second = admission.acquire();
      const releaseSecond = await second;
      expect(admission.snapshot()).toMatchObject({ active: 1, queued: 1 });
      releaseSecond();
      merged = true;
      await admission.refresh();
      const releaseFirst = await first;
      expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0 });
      releaseFirst();
    } finally {
      clock.mockRestore();
    }
  });

  test('a predecessor whose slot never opens starts its wait clock only after merging', async () => {
    let now = 0;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let merged = false;
      const admission = new PodLeaseAdmission({ status: () => status(0), dependencyMerged: () => merged,
        pollMs: 60_000, maxWaitMs: 1_000 });
      const waiting = admission.acquire(undefined, 'earlier').catch((error: Error) => error.message);
      await admission.refresh();
      now = 120_000;
      await admission.refresh();
      expect(admission.snapshot().waiting).toEqual([{ after: 'earlier', reason: 'predecessor-unmerged:earlier' }]);
      merged = true;
      await admission.refresh();
      expect(admission.snapshot().waiting).toEqual([{ after: 'earlier', reason: 'no-free-slot' }]);
      now = 121_001;
      await admission.refresh();
      expect(await waiting).toBe('pod lease admit-starved: waited 0m · reason no-free-slot');
      expect(admission.snapshot().queued).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  test('admits within maxWaitMs even after a previous no-free-slot check', async () => {
    let now = 0;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let recommended = 0;
      const admission = new PodLeaseAdmission({ status: () => status(recommended), pollMs: 60_000, maxWaitMs: 1_000 });
      const waiting = admission.acquire();
      await admission.refresh();
      now = 999;
      recommended = 1;
      await admission.refresh();
      const release = await waiting;
      expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0 });
      release();
    } finally {
      clock.mockRestore();
    }
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
