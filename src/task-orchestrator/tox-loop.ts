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
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { projectLinearTask } from '../connectors/linear-projector.js';
import type { TaskStore } from './store.js';

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
  store?: TaskStore;
  /** Optional projection IO seams for isolated TOX tests. */
  linearProjection?: {
    getApiKey: () => Promise<string | undefined>;
    project: typeof projectLinearTask;
  };
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

export function startToxLoop({ graph, dispatcher, bus, store, linearProjection, maxConcurrent = 2, intervalMs = 1000,
  budgetCheck, readBudget, launch, log }: ToxLoopOptions): { tick: () => Promise<DispatchTickResult>; stop: () => void } {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError('maxConcurrent must be a positive integer');
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new RangeError('intervalMs must be positive');
  const slot = new TimeSlotManager();
  const scheduler = new ResourceScheduler({ slot: () => slot.currentSlot() });
  const inflight = new Set<string>();
  const gate = budgetCheck ?? (() => defaultBudgetCheck(readBudget));
  let stopped = false;
  const projections = new Map<string, Promise<void>>();
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

    const status = event.kind === 'task-status-changed' ? event.to
      : event.kind === 'task-started' ? 'running'
      : event.kind === 'task-completed' ? 'done'
      : event.kind === 'task-failed' ? 'failed' : undefined;
    if (status !== 'running' && status !== 'review' && status !== 'done' && status !== 'failed') return;
    if (event.kind === 'task-status-changed' && (event.from === event.to || event.to !== 'review')) return;
    if (!event.taskId) return;
    const task = graph.getTask(event.taskId);
    if (task?.generatedBy?.kind !== 'external' || task.generatedBy.provider !== 'linear') return;
    const projectionTask = { ...task, status };
    const executionId = event.kind === 'task-started' || event.kind === 'task-completed' || event.kind === 'task-failed'
      ? event.executionId : task.lastExecutionId;
    if (executionId) projectionTask.lastExecutionId = executionId;
    const previous = projections.get(task.id);
    const current = (async () => {
      if (previous) await previous;
      if (stopped) return;
      try {
        const apiKey = await (linearProjection?.getApiKey ?? (() => getSecretAsync('connector.linear.apiKey')))();
        if (!apiKey || stopped) return;
        const execution = executionId ? store?.getExecution(executionId) ?? undefined : undefined;
        await (linearProjection?.project ?? projectLinearTask)({ task: projectionTask, apiKey, execution });
      } catch (error) {
        emit('skipped', { taskId: task.id, ...snapshot(), reason: `linear-projection:${String(error)}` });
      }
    })();
    projections.set(task.id, current);
    void current.finally(() => { if (projections.get(task.id) === current) projections.delete(task.id); });
  }, { kinds: ['task-created', 'task-status-changed', 'task-started', 'task-completed', 'task-failed', 'task-cancelled'] });
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
