import { debug } from '../../debug/log.js';
import { latestTrainWorkerPolicy, readResourceLedger, recordTrainWorkerPolicy, type TrainWorkerPolicy } from '../../resource-ledger/resource-ledger.js';

export interface TrainWorkerObservation {
  id: string;
  state: 'healthy' | 'dead' | 'starting';
  cpuPercent?: number;
}

export interface TrainWorkerLifecycleInput {
  policy?: TrainWorkerPolicy;
  workers: readonly TrainWorkerObservation[];
  requestedWorkers: number;
  releasePhase: 'idle' | 'gate' | 'publish' | 'verify';
}

export interface TrainWorkerLifecyclePlan {
  /** Unknown when the worker policy or observations are unavailable. */
  targetWorkers: number | null;
  restart: string[];
  startCount: number;
  stop: string[];
  reason: string;
}

export const DEFAULT_TRAIN_WORKER_POLICY: TrainWorkerPolicy = {
  // Source: #36421 explicit-policy fixture; zero workers disables reconciliation until a human supplies policy.
  minWorkers: 0, maxWorkers: 0, scaleDownCpuPercent: 80, scaleUpCpuPercent: 40, gateReserveWorkers: 0,
};

// Source: worker counts are nonnegative integers and CPU utilization is a percentage on the 0–100 scale.
export function isValidTrainWorkerPolicy(value: unknown): value is TrainWorkerPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return Number.isSafeInteger(policy.minWorkers) && Number(policy.minWorkers) >= 0
    && Number.isSafeInteger(policy.maxWorkers) && Number(policy.maxWorkers) >= Number(policy.minWorkers)
    && Number.isFinite(policy.scaleDownCpuPercent) && Number(policy.scaleDownCpuPercent) >= 0 && Number(policy.scaleDownCpuPercent) <= 100
    && Number.isFinite(policy.scaleUpCpuPercent) && Number(policy.scaleUpCpuPercent) >= 0 && Number(policy.scaleUpCpuPercent) <= 100
    && Number(policy.scaleUpCpuPercent) < Number(policy.scaleDownCpuPercent)
    && Number.isSafeInteger(policy.gateReserveWorkers) && Number(policy.gateReserveWorkers) >= 0;
}

/** Observe an injected adapter while suppressing every mutating worker operation. */
export function createObservedOnlyTrainWorkerProvider(source?: TrainWorkerLifecycleAdapter): TrainWorkerLifecycleAdapter {
  return {
    mode: 'observe-only',
    observe: () => source?.observe(),
    requestedWorkers: () => source?.requestedWorkers(),
    releasePhase: () => source?.releasePhase(),
    now: () => source?.now() ?? new Date(),
    restart: () => {},
    start: () => {},
    stop: () => {},
  };
}

/** Nexus only enables worker reconciliation when a complete, valid policy was explicitly supplied. */
export function resolveTrainWorkerRuntime(adapter: TrainWorkerLifecycleAdapter | undefined, policy: unknown):
  { adapter: TrainWorkerLifecycleAdapter; policy?: TrainWorkerPolicy } {
  if (isValidTrainWorkerPolicy(policy)) return { adapter: adapter ?? createObservedOnlyTrainWorkerProvider(), policy };
  return { adapter: createObservedOnlyTrainWorkerProvider(adapter) };
}

/** Pure policy decision; wall-clock stop times are deliberately not an input. */
export function planTrainWorkerLifecycle(input: TrainWorkerLifecycleInput): TrainWorkerLifecyclePlan {
  const policy = input.policy;
  if (!policy) return { targetWorkers: null, restart: [], startCount: 0, stop: [], reason: 'policy-unavailable' };
  const healthy = input.workers.filter(worker => worker.state === 'healthy');
  const starting = input.workers.filter(worker => worker.state === 'starting');
  const dead = input.workers.filter(worker => worker.state === 'dead');
  let target = Math.max(policy.minWorkers, Math.min(policy.maxWorkers, input.requestedWorkers));
  const measuredCpu = healthy.flatMap(worker => worker.cpuPercent === undefined ? [] : [worker.cpuPercent]);
  if (measuredCpu.length > 0) {
    const averageCpu = measuredCpu.reduce((sum, value) => sum + value, 0) / measuredCpu.length;
    // Source: #36395 worker-scaling simulation; one worker is the minimum adjustment per reconciliation tick.
    if (averageCpu > policy.scaleDownCpuPercent) target = Math.max(policy.minWorkers, Math.min(target, healthy.length + starting.length - 1));
    else if (averageCpu < policy.scaleUpCpuPercent) target = Math.min(policy.maxWorkers, Math.max(target, healthy.length + starting.length + 1));
  }
  if (input.releasePhase !== 'idle') target = Math.max(policy.minWorkers, target - policy.gateReserveWorkers);
  const missing = Math.max(0, target - healthy.length - starting.length);
  const restart = dead.slice(0, missing).map(worker => worker.id);
  const startCount = Math.max(0, missing - restart.length);
  const healthyToKeep = Math.min(healthy.length, target);
  const startingToKeep = Math.max(0, target - healthyToKeep);
  const stop = [
    ...healthy.slice(healthyToKeep).map(worker => worker.id),
    ...starting.slice(startingToKeep).map(worker => worker.id),
  ];
  return {
    targetWorkers: target,
    restart,
    startCount,
    stop,
    reason: input.releasePhase === 'idle' ? 'guardian-policy-reconcile' : 'release-window-capacity-reserved',
  };
}

export interface TrainWorkerLifecycleAdapter {
  mode?: 'connected' | 'observe-only';
  observe(): Promise<TrainWorkerLifecycleInput['workers'] | undefined> | TrainWorkerLifecycleInput['workers'] | undefined;
  requestedWorkers(): Promise<number | undefined> | number | undefined;
  releasePhase(): Promise<TrainWorkerLifecycleInput['releasePhase'] | undefined> | TrainWorkerLifecycleInput['releasePhase'] | undefined;
  now(): Date;
  restart(workerId: string): Promise<void> | void;
  start(): Promise<void> | void;
  stop(workerId: string, reason: string): Promise<void> | void;
}

/** One supervisor tick. Policy is read from Guardian's durable resource ledger on every tick. */
export async function superviseTrainWorkers(adapter: TrainWorkerLifecycleAdapter, ledgerEvents = readResourceLedger(), shouldContinue: () => boolean = () => true): Promise<TrainWorkerLifecyclePlan> {
  const stoppedPlan = (): TrainWorkerLifecyclePlan => ({ targetWorkers: null, restart: [], startCount: 0, stop: [], reason: 'stopped' });
  if (!shouldContinue()) return stoppedPlan();
  const policy = latestTrainWorkerPolicy(ledgerEvents);
  const workers = await adapter.observe();
  if (!shouldContinue()) return stoppedPlan();
  if (adapter.mode === 'observe-only' && workers !== undefined) {
    const plan: TrainWorkerLifecyclePlan = { targetWorkers: null, restart: [], startCount: 0, stop: [], reason: 'observe-only' };
    debug.log('guardian.train-worker-lifecycle', 'reconcile', {
      providerMode: adapter.mode,
      policyAvailable: !!policy,
      observedWorkers: workers.length,
      requestedWorkers: 'not-read',
      releasePhase: 'not-read',
      targetWorkers: 'unknown',
      restart: [], startCount: 0, stop: [], reason: plan.reason,
      observedAt: (await adapter.now()).toISOString(),
    });
    return plan;
  }
  const requestedWorkers = await adapter.requestedWorkers();
  if (!shouldContinue()) return stoppedPlan();
  const releasePhase = await adapter.releasePhase();
  if (!shouldContinue()) return stoppedPlan();
  if (workers === undefined || requestedWorkers === undefined || releasePhase === undefined) {
    const plan: TrainWorkerLifecyclePlan = { targetWorkers: null, restart: [], startCount: 0, stop: [], reason: 'observations-unavailable' };
    debug.log('guardian.train-worker-lifecycle', 'reconcile', {
      providerMode: adapter.mode ?? 'connected',
      policyAvailable: !!policy,
      observedWorkers: workers?.length ?? 'unknown',
      requestedWorkers: requestedWorkers ?? 'unknown',
      releasePhase: releasePhase ?? 'unknown',
      targetWorkers: 'unknown',
      restart: [],
      startCount: 0,
      stop: [],
      reason: plan.reason,
      observedAt: (await adapter.now()).toISOString(),
    });
    return plan;
  }
  const input: TrainWorkerLifecycleInput = {
    policy,
    workers,
    requestedWorkers,
    releasePhase,
  };
  const plan = planTrainWorkerLifecycle(input);
  debug.log('guardian.train-worker-lifecycle', 'reconcile', {
    providerMode: adapter.mode ?? 'connected',
    policyAvailable: !!input.policy,
    observedWorkers: input.workers.length,
    requestedWorkers: input.requestedWorkers,
    releasePhase: input.releasePhase,
    targetWorkers: plan.targetWorkers,
    restart: plan.restart,
    startCount: plan.startCount,
    stop: plan.stop,
    reason: plan.reason,
    observedAt: (await adapter.now()).toISOString(),
  });
  for (const workerId of plan.restart) {
    if (!shouldContinue()) return stoppedPlan();
    await adapter.restart(workerId);
  }
  for (let index = 0; index < plan.startCount; index += 1) {
    if (!shouldContinue()) return stoppedPlan();
    await adapter.start();
  }
  for (const workerId of plan.stop) {
    if (!shouldContinue()) return stoppedPlan();
    await adapter.stop(workerId, plan.reason);
  }
  return plan;
}

export interface TrainWorkerLifecycleLoopOptions { intervalMs: number; ledgerPath?: string; schedule?: (tick: () => void, intervalMs: number) => () => void }

export interface GuardianTrainWorkerRuntimeOptions extends TrainWorkerLifecycleLoopOptions {
  policy?: TrainWorkerPolicy;
  adapter: TrainWorkerLifecycleAdapter;
  ledgerPath?: string;
}

/** Nexus Guardian boot path: durably record the human policy, then start the live supervisor. */
export function startGuardianTrainWorkerRuntime(options: GuardianTrainWorkerRuntimeOptions): () => Promise<void> {
  if (options.policy) recordTrainWorkerPolicy(options.policy, options.adapter.now(), options.ledgerPath);
  return startTrainWorkerLifecycleLoop(options.adapter, options);
}

/** Start an immediate tick and a serialized recurring supervisor for the Guardian runtime. */
export function startTrainWorkerLifecycleLoop(adapter: TrainWorkerLifecycleAdapter, options: TrainWorkerLifecycleLoopOptions): () => Promise<void> {
  // Source: timer intervals must be positive integer milliseconds for setInterval scheduling.
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) throw new Error('train worker lifecycle interval must be positive');
  const schedule = options.schedule ?? ((tick, intervalMs) => {
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  });
  let stopped = false;
  let inFlight = false;
  let inFlightTick: Promise<void> = Promise.resolve();
  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = true;
    inFlightTick = Promise.resolve().then(async () => {
      await superviseTrainWorkers(adapter, readResourceLedger(options.ledgerPath), () => !stopped);
    }).catch(error => {
      debug.log('guardian.train-worker-lifecycle', 'tick-failed', { error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    }).finally(() => { inFlight = false; });
  };
  tick();
  const cancel = schedule(tick, options.intervalMs);
  return async () => {
    stopped = true;
    cancel();
    await inFlightTick;
  };
}
