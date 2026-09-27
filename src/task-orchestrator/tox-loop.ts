import { OpportunisticLauncher, type LaunchCandidate } from '../dispatch/opportunistic-launcher.js';
import { ResourceScheduler } from '../dispatch/resource-scheduler.js';
import { TimeSlotManager } from '../dispatch/time-slot.js';
import { debug } from '../debug/log.js';
import type { TaskGraph } from './graph.js';
import type { DispatchTickResult, TaskDispatcher } from './dispatcher.js';
import type { TaskEventBus } from './events.js';
import type { BudgetGate } from './feedback-loop.js';
import { PRIORITY_RANK } from './priority.js';
import type { Task } from './types.js';
import { decideBudget, readBudgetInputsLive, type ReadBudgetInputsDeps } from '../self-implement/budget-gate.js';
import { getUserConfig } from '../user-config.js';

async function defaultBudgetCheck(readBudget?: ReadBudgetInputsDeps & { readLiveGrok?: () => Promise<number | undefined> }): Promise<{ canAfford: boolean; tripped: readonly string[] }> {
  const inputs = await readBudgetInputsLive({ config: getUserConfig(), ...readBudget });
  const maxUsedPercent = {
    ...inputs.maxUsedPercent,
    'openai-codex': Math.min(inputs.maxUsedPercent['openai-codex'] ?? 60, 60),
    grok: Math.min(inputs.maxUsedPercent.grok ?? 50, 50),
  };
  const decision = decideBudget({ ...inputs, maxUsedPercent });
  // TOX adapters do not receive the selected fallback provider. Do not admit
  // a next-provider decision until that provider can actually be routed.
  const canAfford = decision.action === 'proceed';
  return {
    canAfford,
    tripped: canAfford ? [] : decision.reasons,
  };
}

export interface ToxLoopOptions {
  graph: TaskGraph;
  dispatcher: Pick<TaskDispatcher, 'tickTask'>;
  bus?: TaskEventBus;
  maxConcurrent?: number;
  intervalMs?: number;
  budgetCheck?: BudgetGate;
  /** Usage-reader seam; still exercises the default P15 evaluator. */
  readBudget?: ReadBudgetInputsDeps & { readLiveGrok?: () => Promise<number | undefined> };
  /** Test seam; production hands each admitted task to the TOX dispatcher. */
  launch?: (task: Task) => Promise<void> | void;
  log?: (event: 'tick' | 'launched' | 'waiting-capacity' | 'budget-hold' | 'skipped', data: {
    taskId?: string; priority?: Task['priority']; running: number; ready: number;
    traceId?: string; reason?: string;
  }) => void;
}

export function startToxLoop({ graph, dispatcher, bus, maxConcurrent = 2, intervalMs = 1000,
  budgetCheck, readBudget, launch, log }: ToxLoopOptions): { tick: () => Promise<DispatchTickResult>; stop: () => void } {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError('maxConcurrent must be a positive integer');
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new RangeError('intervalMs must be positive');
  const slot = new TimeSlotManager();
  const scheduler = new ResourceScheduler({ slot: () => slot.currentSlot() });
  const inflight = new Set<string>();
  const gate = budgetCheck ?? (() => defaultBudgetCheck(readBudget));
  let stopped = false;
  let pending = false;
  let tickPromise: Promise<DispatchTickResult> | undefined;
  let currentResult: DispatchTickResult | undefined;
  const emit: NonNullable<ToxLoopOptions['log']> = (event, data) => {
    try { (log ?? ((kind, fields) => debug.log('tox.loop', kind, fields)))(event, data); }
    catch { /* observation cannot interrupt dispatch */ }
  };
  const runningCount = () => graph.listRunning().length + [...inflight].filter((id) => graph.getTask(id)?.status !== 'running').length;
  const snapshot = () => ({ running: runningCount(), ready: graph.countByStatus().ready });
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  const wake = () => {
    if (stopped || wakeTimer) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      void tick();
    }, 0);
  };
  const launcher = new OpportunisticLauncher({
    slot: () => slot.currentSlot(), scheduler, intervalMs, onTick: () => tick(),
    readyTasks: () => graph.listAll()
      .filter((task) => task.status === 'ready' && !inflight.has(task.id))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((task): LaunchCandidate => ({
        id: task.id, ready: true, priorityRank: -PRIORITY_RANK[task.priority],
        surface: task.surface.kind,
      })),
    perTickCap: maxConcurrent,
    concurrencyOK: () => runningCount() < maxConcurrent,
    admit: async (candidate) => {
      const task = graph.getTask(candidate.id);
      if (stopped || !task || task.status !== 'ready' || inflight.has(task.id)) return 'not-ready';
      const decision = await gate(task.goalSlug ?? '', task.estimateUsd);
      if (!decision.canAfford || decision.tripped.length > 0) return 'budget-hold';
      return undefined;
    },
    launch: (candidate) => {
      const task = graph.getTask(candidate.id);
      if (!task || task.status !== 'ready' || stopped) throw new Error('not-ready');
      let completion: Promise<void> | void;
      if (launch) {
        completion = launch(task);
      } else {
        const result = dispatcher.tickTask(task.id);
        const started = result.dispatched[0];
        if (!started) {
          currentResult?.deferred.push(...result.deferred);
          throw new Error(result.deferred[0]?.reason ?? 'not-dispatched');
        }
        currentResult?.dispatched.push(started);
        completion = started.promise;
      }
      inflight.add(task.id);
      emit('launched', { taskId: task.id, priority: task.priority, ...snapshot() });
      void Promise.resolve(completion).catch((err) => {
        emit('skipped', { taskId: task.id, priority: task.priority, ...snapshot(), reason: String(err) });
      }).finally(() => {
        inflight.delete(task.id);
        if (!stopped) wake();
      });
    },
  });

  function tick(): Promise<DispatchTickResult> {
    if (stopped) return Promise.resolve({ dispatched: [], deferred: [] });
    if (tickPromise) { pending = true; return tickPromise; }
    const result: DispatchTickResult = { dispatched: [], deferred: [] };
    tickPromise = (async () => {
      currentResult = result;
      try {
        do {
          pending = false;
          emit('tick', snapshot());
          const outcomes = await launcher.tick();
          for (const outcome of outcomes) {
            if (outcome.ok) continue;
            const task = graph.getTask(outcome.taskId);
            const reason = outcome.reason ?? 'unknown';
            emit(reason === 'concurrency-cap' ? 'waiting-capacity' : reason === 'budget-hold' || reason.startsWith('admission-error:') ? 'budget-hold' : 'skipped', {
              taskId: outcome.taskId, priority: task?.priority, ...snapshot(), reason,
            });
          }
        } while (pending && !stopped);
      } catch (err) {
        emit('skipped', { ...snapshot(), reason: `tick-error:${err instanceof Error ? err.message : String(err)}` });
      } finally {
        currentResult = undefined;
      }
      return result;
    })();
    void tickPromise.finally(() => { tickPromise = undefined; });
    return tickPromise;
  }

  const subscription = bus?.subscribe((event) => {
    if (event.kind === 'task-created' || (event.kind === 'task-status-changed' && event.to === 'ready')) wake();
    if (event.kind === 'task-completed' || event.kind === 'task-failed' || event.kind === 'task-cancelled') wake();
  }, { kinds: ['task-created', 'task-status-changed', 'task-completed', 'task-failed', 'task-cancelled'] });
  launcher.start();
  wake();
  return {
    tick,
    stop() {
      stopped = true;
      launcher.stop();
      if (wakeTimer) clearTimeout(wakeTimer);
      subscription?.dispose();
    },
  };
}
