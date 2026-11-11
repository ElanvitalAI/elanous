import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { parseResourceLedgerEvents, latestTrainWorkerPolicy, readResourceLedger, recordTrainWorkerPolicy } from '../../resource-ledger/resource-ledger.js';
import { RESOURCE_RECONCILE_INTERVAL_MS } from '../../resource-ledger/guardian-reconcile.js';
import { createObservedOnlyTrainWorkerProvider, DEFAULT_TRAIN_WORKER_POLICY, planTrainWorkerLifecycle, resolveTrainWorkerRuntime, startGuardianTrainWorkerRuntime, startTrainWorkerLifecycleLoop, superviseTrainWorkers, type TrainWorkerLifecycleInput } from './worker-lifecycle.js';

const FIRST = 1; // Source: #36395 worker-scaling simulation's one-worker minimum fixture.
const TOTAL = 5; // Source: #36395 worker-scaling simulation's bounded worker-pool fixture.
const BUSY = 80; // Source: #36395 worker-scaling simulation's scale-down CPU boundary.
const IDLE = 40; // Source: #36395 worker-scaling simulation's scale-up CPU boundary.
const RESERVED = 1; // Source: #36395 worker-scaling simulation's publish-capacity reserve.
const POLICY = { minWorkers: FIRST, maxWorkers: TOTAL, scaleDownCpuPercent: BUSY, scaleUpCpuPercent: IDLE, gateReserveWorkers: RESERVED } as const; // Source: #36395 worker-scaling simulation context; policy is an explicit test input.
const policyFromLedger = latestTrainWorkerPolicy(parseResourceLedgerEvents(JSON.stringify({
  event: 'train-worker-policy', at: '2026-11-10T00:00:00.000Z', policy: POLICY,
})));

describe('Guardian train worker lifecycle simulation', () => {
  test('Nexus uses observe-only for missing or invalid policy with connected existing workers', async () => {
    for (const suppliedPolicy of [undefined, { ...POLICY, minWorkers: 4, maxWorkers: 1 }]) { // Source: #36421 invalid-policy fixture violates minWorkers <= maxWorkers.
      const root = mkdtempSync(join(tmpdir(), 'guardian-train-observe-only-'));
      try {
        const path = join(root, 'events.jsonl');
        const calls: string[] = [];
        let observed = 0;
        let notifyObserved!: () => void;
        const observedOnce = new Promise<void>(resolve => { notifyObserved = resolve; });
        const connectedAdapter = {
          now: () => new Date('2026-11-10T00:00:00.000Z'),
          observe: () => { observed += 1; notifyObserved(); return [
            { id: 'healthy-worker', state: 'healthy' as const },
            { id: 'starting-worker', state: 'starting' as const },
          ]; },
          requestedWorkers: () => { calls.push('requestedWorkers'); return 0; },
          releasePhase: () => { calls.push('releasePhase'); return 'idle' as const; },
          restart: (id: string) => { calls.push(`restart:${id}`); },
          start: () => { calls.push('start'); },
          stop: (id: string) => { calls.push(`stop:${id}`); },
        };
        const runtime = resolveTrainWorkerRuntime(connectedAdapter, suppliedPolicy);
        expect(runtime.adapter.mode).toBe('observe-only');
        expect(runtime.policy).toBeUndefined();
        const stop = startGuardianTrainWorkerRuntime({ ...runtime, intervalMs: 1_000, ledgerPath: path, schedule: () => () => {} });
        await observedOnce;
        await new Promise(resolve => setImmediate(resolve));
        await stop();
        expect(observed).toBe(1);
        expect(calls).toEqual([]);
        expect(readResourceLedger(path)).toEqual([]);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });

  test('supervisor keeps workers across the former stop window and applies resource decisions', async () => {
    const actions: string[] = [];
    const workerAdapter = (at: string) => ({
      now: () => new Date(at),
      observe: () => [1, 2, 3].map(n => ({ id: `w${n}`, state: 'healthy' as const, cpuPercent: 55 })),
      requestedWorkers: () => 3,
      releasePhase: () => 'idle' as const,
      restart: (id: string) => { actions.push(`restart:${id}`); },
      start: () => { actions.push('start'); },
      stop: (id: string) => { actions.push(`stop:${id}`); },
    });
    const beforeFormerStop = await superviseTrainWorkers(workerAdapter('2026-11-10T06:29:59.000Z'), [
      { event: 'train-worker-policy', at: '2026-11-10T00:00:00.000Z', policy: POLICY },
    ]);
    const afterFormerStop = await superviseTrainWorkers(workerAdapter('2026-11-10T06:30:01.000Z'), [
      { event: 'train-worker-policy', at: '2026-11-10T00:00:00.000Z', policy: POLICY },
    ]);
    const afterSecondFormerStop = await superviseTrainWorkers(workerAdapter('2026-11-10T09:00:01.000Z'), [
      { event: 'train-worker-policy', at: '2026-11-10T00:00:00.000Z', policy: POLICY },
    ]);
    expect(beforeFormerStop).toMatchObject({ targetWorkers: 3, stop: [], startCount: 0 });
    expect(afterFormerStop).toMatchObject({ targetWorkers: 3, stop: [], startCount: 0 });
    expect(afterSecondFormerStop).toMatchObject({ targetWorkers: 3, stop: [], startCount: 0 });
    expect(actions).toEqual([]);

    const deadWorkerRecovery = planTrainWorkerLifecycle({ policy: policyFromLedger, requestedWorkers: 3, releasePhase: 'idle',
      workers: [{ id: 'w1', state: 'healthy', cpuPercent: 55 }, { id: 'w2', state: 'dead' }, { id: 'w3', state: 'healthy', cpuPercent: 55 }] });
    expect(deadWorkerRecovery.restart).toEqual(['w2']);
    expect(deadWorkerRecovery.startCount).toBe(0);

    const startingWorkerCountsTowardTarget = planTrainWorkerLifecycle({ policy: policyFromLedger, requestedWorkers: 3, releasePhase: 'idle',
      workers: [{ id: 'w1', state: 'healthy', cpuPercent: 55 }, { id: 'w2', state: 'starting' }] });
    expect(startingWorkerCountsTowardTarget.startCount).toBe(1);

    const excessStartingWorkersConverge = planTrainWorkerLifecycle({ policy: policyFromLedger, requestedWorkers: 1, releasePhase: 'idle',
      workers: [{ id: 's1', state: 'starting' }, { id: 's2', state: 'starting' }] });
    expect(excessStartingWorkersConverge.targetWorkers).toBe(1);
    expect(excessStartingWorkersConverge.stop).toEqual(['s2']);
    expect(excessStartingWorkersConverge.startCount).toBe(0);

    const healthyWorkerWinsOverStartingWorker = planTrainWorkerLifecycle({ policy: policyFromLedger, requestedWorkers: 1, releasePhase: 'idle',
      workers: [{ id: 'healthy', state: 'healthy', cpuPercent: 55 }, { id: 'starting', state: 'starting' }] });
    expect(healthyWorkerWinsOverStartingWorker.targetWorkers).toBe(1);
    expect(healthyWorkerWinsOverStartingWorker.stop).toEqual(['starting']);
    expect(healthyWorkerWinsOverStartingWorker.startCount).toBe(0);

    const overloaded = planTrainWorkerLifecycle({ policy: policyFromLedger, requestedWorkers: 3, releasePhase: 'idle',
      workers: [1, 2, 3].map(n => ({ id: `w${n}`, state: 'healthy' as const, cpuPercent: 91 })) });
    expect(overloaded.targetWorkers).toBe(2);
    expect(overloaded.stop).toEqual(['w3']);

    const underloaded = planTrainWorkerLifecycle({ policy: policyFromLedger, requestedWorkers: 3, releasePhase: 'idle',
      workers: [{ id: 'w1', state: 'healthy', cpuPercent: 20 }] });
    expect(underloaded.targetWorkers).toBe(3);
    expect(underloaded.startCount).toBe(2);

    const gateWindow = planTrainWorkerLifecycle({ policy: policyFromLedger, requestedWorkers: 3, releasePhase: 'publish',
      workers: [1, 2, 3].map(n => ({ id: `w${n}`, state: 'healthy' as const, cpuPercent: 55 })) });
    expect(gateWindow.targetWorkers).toBe(2);
    expect(gateWindow.reason).toBe('release-window-capacity-reserved');
  });

  test('supervisor applies restart/stop actions without human intervention', async () => {
    const actions: string[] = [];
    const plan = await superviseTrainWorkers({
      observe: () => [{ id: 'dead-worker', state: 'dead' }, { id: 'busy-1', state: 'healthy', cpuPercent: 92 }, { id: 'busy-2', state: 'healthy', cpuPercent: 92 }],
      requestedWorkers: () => 2,
      releasePhase: () => 'idle',
      now: () => new Date('2026-11-10T00:00:00.000Z'),
      restart: id => { actions.push(`restart:${id}`); },
      start: () => { actions.push('start'); },
      stop: id => { actions.push(`stop:${id}`); },
    }, [{ event: 'train-worker-policy', at: '2026-11-10T00:00:00.000Z', policy: POLICY }]);
    expect(plan.targetWorkers).toBe(1);
    expect(actions).toEqual(['stop:busy-2']);
  });

  test('policy writes and reloads through the durable ledger; invalid policy is rejected', () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-train-policy-'));
    try {
      const path = join(root, 'events.jsonl');
      recordTrainWorkerPolicy(POLICY, new Date('2026-11-10T00:00:00.000Z'), path);
      expect(latestTrainWorkerPolicy(readResourceLedger(path))).toEqual(POLICY);
      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(() => recordTrainWorkerPolicy({ ...POLICY, scaleUpCpuPercent: POLICY.scaleDownCpuPercent }, new Date(), path)).toThrow('invalid train worker policy');
      expect(readResourceLedger(path)).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('Guardian boot writes policy and starts an immediate plus recurring supervisor tick', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-train-runtime-'));
    try {
      const path = join(root, 'events.jsonl');
      let scheduled: (() => void) | undefined;
      let cancelled = false;
      let observations = 0;
      let starts = 0;
      const waiters = new Map<number, () => void>();
      const waitFor = (target: number) => observations >= target ? Promise.resolve() : new Promise<void>(resolve => waiters.set(target, resolve));
      const stop = startGuardianTrainWorkerRuntime({ policy: POLICY, ledgerPath: path, intervalMs: RESOURCE_RECONCILE_INTERVAL_MS,
        schedule: tick => { scheduled = tick; return () => { cancelled = true; }; },
        adapter: {
          now: () => new Date('2026-11-10T00:00:00.000Z'),
          observe: () => { observations += 1; waiters.get(observations)?.(); return []; },
          requestedWorkers: () => 0,
          releasePhase: () => 'idle',
          restart: () => {}, start: () => { starts += 1; }, stop: () => {},
        },
      });
      await waitFor(1);
      await new Promise(resolve => setImmediate(resolve));
      expect(latestTrainWorkerPolicy(readResourceLedger(path))).toEqual(POLICY);
      expect(starts).toBe(1);
      const secondTick = waitFor(2);
      scheduled?.();
      await secondTick;
      await new Promise(resolve => setImmediate(resolve));
      await stop();
      expect(observations).toBe(2);
      expect(starts).toBe(2);
      expect(cancelled).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('resource ledger read failure in the immediate tick is caught by the loop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-train-invalid-ledger-'));
    try {
      const path = join(root, 'events.jsonl');
      writeFileSync(path, '{malformed ledger row\n', 'utf8');
      let scheduled = false;
      const stop = startTrainWorkerLifecycleLoop({
        observe: () => [], requestedWorkers: () => 0, releasePhase: () => 'idle',
        now: () => new Date('2026-11-10T00:00:00.000Z'),
        restart: () => {}, start: () => {}, stop: () => {},
      }, { intervalMs: 1000, ledgerPath: path, schedule: () => { scheduled = true; return () => {}; } });
      await new Promise(resolve => setImmediate(resolve));
      await stop();
      expect(scheduled).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('shutdown during worker observation prevents the pending tick from starting actions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-train-stop-during-observe-'));
    try {
      const path = join(root, 'events.jsonl');
      recordTrainWorkerPolicy(POLICY, new Date('2026-11-10T00:00:00.000Z'), path);
      const actions: string[] = [];
      let resolveObservation!: (workers: TrainWorkerLifecycleInput['workers']) => void;
      let notifyObserving!: () => void;
      const observing = new Promise<void>(resolve => { notifyObserving = resolve; });
      const observation = new Promise<TrainWorkerLifecycleInput['workers']>(resolve => { resolveObservation = resolve; });
      const stop = startTrainWorkerLifecycleLoop({
        observe: () => { notifyObserving(); return observation; },
        requestedWorkers: () => { actions.push('requestedWorkers'); return 0; },
        releasePhase: () => { actions.push('releasePhase'); return 'idle'; },
        now: () => new Date('2026-11-10T00:00:00.000Z'),
        restart: id => { actions.push(`restart:${id}`); }, start: () => { actions.push('start'); }, stop: id => { actions.push(`stop:${id}`); },
      }, { intervalMs: 1_000, ledgerPath: path, schedule: () => () => {} });
      await observing;
      let shutdownSettled = false;
      const shutdown = stop().then(() => { shutdownSettled = true; });
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);
      resolveObservation([{ id: 'busy-worker', state: 'healthy', cpuPercent: 95 }]);
      await shutdown;
      expect(shutdownSettled).toBe(true);
      expect(actions).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('shutdown waits for an in-flight worker action and prevents later actions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-train-stop-during-action-'));
    try {
      const path = join(root, 'events.jsonl');
      recordTrainWorkerPolicy(POLICY, new Date('2026-11-10T00:00:00.000Z'), path);
      const actions: string[] = [];
      let finishFirstStart!: () => void;
      let notifyFirstStart!: () => void;
      const firstStart = new Promise<void>(resolve => { notifyFirstStart = resolve; });
      const pendingStart = new Promise<void>(resolve => { finishFirstStart = resolve; });
      let startCalls = 0;
      const stop = startTrainWorkerLifecycleLoop({
        observe: () => [], requestedWorkers: () => 2, releasePhase: () => 'idle',
        now: () => new Date('2026-11-10T00:00:00.000Z'),
        restart: id => { actions.push(`restart:${id}`); },
        start: () => { startCalls += 1; actions.push(`start:${startCalls}`); if (startCalls === 1) { notifyFirstStart(); return pendingStart; } },
        stop: (id) => { actions.push(`stop:${id}`); },
      }, { intervalMs: 1_000, ledgerPath: path, schedule: () => () => {} });
      await firstStart;
      let shutdownSettled = false;
      const shutdown = stop().then(() => { shutdownSettled = true; });
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);
      finishFirstStart();
      await shutdown;
      expect(actions).toEqual(['start:1']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('missing provider leaves worker count and release phase unknown without actions', async () => {
    const provider = createObservedOnlyTrainWorkerProvider();
    const events: unknown[] = [];
    const unregister = debug.registerSink({ name: 'guardian-train-worker-unknown-test', emit: record => {
      if (record.category === 'guardian.train-worker-lifecycle' && record.event === 'reconcile') events.push(record.data);
    } });
    try {
      const plan = await superviseTrainWorkers(provider, [{ event: 'train-worker-policy', at: '2026-11-10T00:00:00.000Z', policy: DEFAULT_TRAIN_WORKER_POLICY }]);
      expect(provider.mode).toBe('observe-only');
      expect(plan).toMatchObject({ targetWorkers: null, restart: [], startCount: 0, stop: [], reason: 'observations-unavailable' });
      expect(provider.observe()).toBeUndefined();
      expect(provider.requestedWorkers()).toBeUndefined();
      expect(provider.releasePhase()).toBeUndefined();
    } finally { unregister(); }
    expect(events).toContainEqual(expect.objectContaining({
      observedWorkers: 'unknown', requestedWorkers: 'unknown', releasePhase: 'unknown', targetWorkers: 'unknown',
    }));
  });
});
