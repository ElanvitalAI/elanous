/**
 * TOX Dispatcher — consumes ready tasks from `TaskGraph.readySet()` +
 * enforces per-surface concurrency caps + routes each task to its
 * registered `SurfaceAdapter` + records `TaskExecution` rows.
 *
 * Origin: `내부 문서 `PLAN-session-task-orchestrator-coevolution`` §3.5.
 * Session: TOX-2a (feat/tox-dispatcher-core).
 *
 * Design:
 *   - Dispatcher is **stateless** per-tick — reads from graph, asks
 *     registry for adapter, spawns work, records execution, returns.
 *   - Concurrency cap is a **soft gate** — tick returns the set of
 *     tasks actually dispatched; caller invokes `tick()` again when
 *     capacity frees up (event-driven via bus).
 *   - AbortSignal flows through adapters — `kill(taskId)` aborts the
 *     running work.
 *   - `store?` / `bus?` / `graph?` are injected → fully unit-testable.
 */
import type { TaskSurfaceKind } from './types.js';
import { createExecution, newExecutionId, type Task, type TaskExecution } from './types.js';
import type { TaskGraph } from './graph.js';
import type { TaskEventBus } from './events.js';
import type { TaskStore } from './store.js';
import type {
  DispatchContext,
  DispatchResult,
  SurfaceRegistry,
} from './surface-registry.js';
import {
  evaluateAcceptance,
  type AcceptanceIo,
  type AcceptanceReport,
} from './acceptance.js';
import { recordOpsEventSafe, type OpsEventInput } from '../domains/ops-log.js';

// ───────────────────────── Concurrency caps ────────────────────────

/** Per-surface simultaneous-task ceiling. Chosen to bound system load
 *  while still letting LLM-heavy surfaces parallelise. Override via
 *  `DispatcherOptions.concurrencyCaps`. */
export const DEFAULT_CONCURRENCY_CAPS: Record<TaskSurfaceKind, number> = {
  'terminal-pane': 6,
  'vw-slot':       4,
  subagent:        3,
  skill:           4,
  'chat-prompt':   1,   // serialise — user can only answer one modal at a time
  cron:            8,   // scheduler already throttles; we're a thin passthrough
  'llm-direct':    2,
  // AXON P6 — external ACP agents are heavyweight (subprocess + model
  // call + streaming). Match `subagent` cap; tune per-deployment via
  // `DispatcherOptions.concurrencyCaps`.
  'acx-session':   3,
  // E7 (§7.4 follow-up · 2026-05-17) — showroom surface (role-judge
  // batches, perf/eval flows). Match subagent cap.
  showroom:        3,
  // Parallel self-dev (2026-07-21) — each job is a `elanous self implement`
  // subprocess that itself spawns a goal-loop child (heavyweight: 2 nested
  // processes + model calls + worktree). Three matches comparable agent
  // surfaces while leaving measured saturation available for later tuning.
  'self-implement': 3,
  // Parallel execution line (2026-07-22) — each job is a `harness run-detached`
  // subprocess. Web publish / invest research (--domain) are read-only /
  // render → lighter than self-build's worktree+gate+test, so a higher cap.
  // Code dev-harness jobs are heavier; override via concurrencyCaps if needed.
  'dev-harness':    4,
};

// ───────────────────────── Public shapes ───────────────────────────

export interface DispatcherOptions {
  graph: TaskGraph;
  registry: SurfaceRegistry;
  bus?: TaskEventBus;
  store?: TaskStore;
  /** Override caps — testing / tuning. */
  concurrencyCaps?: Partial<Record<TaskSurfaceKind, number>>;
  /** Override clock — tests. */
  now?: () => number;
  /** Fail-soft ops event sink — tests inject a memory recorder. */
  recordOpsEvent?: (input: OpsEventInput) => unknown;
  /** IO seam for `evaluateAcceptance`. Required only for tasks whose
   *  acceptance.checks reference fs or subprocess (file-exists /
   *  file-contains / shell-zero). */
  acceptanceIo?: AcceptanceIo;
}

export interface DispatchTickResult {
  /** Tasks we actually started in this tick. Does NOT include those
   *  deferred by the cap. */
  dispatched: Array<{
    taskId: string;
    executionId: string;
    surfaceAddress?: string;
    promise: Promise<void>;
  }>;
  /** Ready tasks we skipped this tick due to caps. Caller may `tick()`
   *  again after any adapter completes. */
  deferred: Array<{ taskId: string; reason: 'cap' | 'no-adapter' | 'intake-sequential' }>;
}

export class TaskDispatcher {
  private readonly caps: Record<TaskSurfaceKind, number>;
  private readonly activeByKind = new Map<TaskSurfaceKind, number>();
  private readonly abortByTask = new Map<string, AbortController>();
  private readonly now: () => number;

  constructor(private readonly opts: DispatcherOptions) {
    this.caps = { ...DEFAULT_CONCURRENCY_CAPS, ...(opts.concurrencyCaps ?? {}) };
    this.now = opts.now ?? Date.now;
  }

  /**
   * Single dispatch pass. Returns what was started / deferred.
   * Idempotent — calling multiple times is safe; each call only
   * dispatches tasks currently in `ready` status.
   */
  tick(): DispatchTickResult {
    return this.dispatch(this.opts.graph.readySet());
  }

  /** Dispatch exactly one admitted task, without walking the rest of the ready queue. */
  tickTask(taskId: string): DispatchTickResult {
    const task = this.opts.graph.getTask(taskId);
    return this.dispatch(task?.status === 'ready' ? [task] : []);
  }

  private dispatch(tasks: Task[]): DispatchTickResult {
    const dispatched: DispatchTickResult['dispatched'] = [];
    const deferred: DispatchTickResult['deferred'] = [];

    for (const task of tasks) {
      if (task.generatedBy?.kind === 'external' && task.approval?.state !== 'approved' && task.approval?.state !== 'auto') continue;
      const kind = task.surface.kind;
      const adapter = this.opts.registry.resolve(kind);
      if (!adapter) {
        deferred.push({ taskId: task.id, reason: 'no-adapter' });
        continue;
      }
      const deferReason = adapter.deferReason?.(task);
      if (deferReason) {
        deferred.push({ taskId: task.id, reason: deferReason });
        continue;
      }
      const active = this.activeByKind.get(kind) ?? 0;
      const cap = this.caps[kind] ?? 1;
      if (active >= cap) {
        deferred.push({ taskId: task.id, reason: 'cap' });
        continue;
      }
      const result = this.spawn(task, adapter);
      dispatched.push({
        taskId: task.id,
        executionId: result.executionId,
        surfaceAddress: result.surfaceAddress,
        promise: this.monitor(task, result),
      });
    }

    this.recordCapDeferrals(deferred);
    return { dispatched, deferred };
  }

  /**
   * Cancel a running task. Aborts the adapter + transitions graph to
   * `cancelled`. Safe to call when the task is not running (no-op).
   */
  kill(taskId: string, reason: 'user' | 'cascade' | 'timeout' = 'user'): void {
    const ctrl = this.abortByTask.get(taskId);
    if (ctrl) ctrl.abort(reason);
    // Graph transition happens in monitor() when the adapter promise
    // resolves with `cancelled` status — we don't pre-empt the state
    // here to avoid double-counting.
  }

  /** Current active count by surface — used by observability. */
  activeSnapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.activeByKind) out[k] = v;
    return out;
  }

  // ──────────────── Internals ───────────────────────────────────

  /** Ops 관측(P0) — 태스크 lifecycle 전이를 감사로그(ops_events)에 심는다(fail-soft).
   *  실행 호스트인 dispatcher 가 기록 주체(pure graph 는 순수 유지). 미션 계보(missionId·
   *  goalSlug)를 refs 로 실어 fan-in. running=cycle_start·done/failed=cycle_end. */
  private recordOps(task: Task, event: 'cycle_start' | 'cycle_end' | 'blocked', toState: string, extra?: Record<string, unknown>): void {
    this.recordOpsEvent({
      entityType: 'task', entityId: task.id, event, toState,
      actor: 'dispatcher',
      rationale: task.title?.slice(0, 120) ?? task.surface.kind,
      refs: {
        surface: task.surface.kind, attempt: task.attempt,
        ...(task.missionId ? { missionId: task.missionId } : {}),
        ...(task.goalSlug ? { goalSlug: task.goalSlug } : {}),
        ...extra,
      },
      now: () => new Date(this.now()).toISOString(),
    });
  }

  private recordCapDeferrals(deferred: DispatchTickResult['deferred']): void {
    const byKind = new Map<TaskSurfaceKind, string[]>();
    for (const entry of deferred) {
      if (entry.reason !== 'cap') continue;
      const task = this.opts.graph.getTask(entry.taskId);
      if (!task) continue;
      const taskIds = byKind.get(task.surface.kind) ?? [];
      taskIds.push(task.id);
      byKind.set(task.surface.kind, taskIds);
    }
    for (const [surface, taskIds] of byKind) {
      const task = this.opts.graph.getTask(taskIds[0]);
      if (!task) continue;
      this.recordOps(task, 'blocked', 'ready', {
        cap: this.caps[surface] ?? 1,
        deferred: taskIds.length,
        deferredTaskIds: taskIds,
      });
    }
  }

  private recordOpsEvent(input: OpsEventInput): void {
    try {
      (this.opts.recordOpsEvent ?? recordOpsEventSafe)(input);
    } catch {
      // Observability must not alter dispatch admission or completion.
    }
  }

  private spawn(task: Task, adapter: Parameters<SurfaceRegistry['override']>[1]): DispatchResult {
    const executionId = newExecutionId();
    const ctrl = new AbortController();
    this.abortByTask.set(task.id, ctrl);
    this.activeByKind.set(task.surface.kind, (this.activeByKind.get(task.surface.kind) ?? 0) + 1);

    const ctx: DispatchContext = {
      signal: ctrl.signal,
      metadata: { executionId },
    };

    // Graph transition: ready → running. This throws if illegal
    // (shouldn't be — readySet guarantees status='ready') so we let
    // errors propagate.
    this.opts.graph.updateTask(task.id, {
      status: 'running',
      lastExecutionId: executionId,
    }, { now: this.now() });
    this.opts.store?.saveTask(this.opts.graph.getTask(task.id)!);
    this.recordOps(task, 'cycle_start', 'running', { executionId });

    this.opts.bus?.emit({
      kind: 'task-started',
      taskId: task.id,
      executionId,
      surfaceAddress: undefined,
      modelId: undefined,
    });

    // Adapter may be sync or async — normalise.
    let promise: Promise<import('./types.js').TaskExecution>;
    try {
      promise = Promise.resolve(adapter(task, ctx)).then((r) => r.promise);
    } catch (err) {
      // Adapter threw synchronously — treat as immediate failure.
      promise = Promise.reject(err);
    }

    // Snapshot for DispatchResult — the immediate metadata we know.
    return {
      executionId,
      surfaceAddress: undefined,
      promise,
    };
  }

  private async monitor(task: Task, res: DispatchResult): Promise<void> {
    const kind = task.surface.kind;
    let savedExecution = false;
    try {
      const exec = { ...await res.promise, id: res.executionId };
      // Keep the task row and execution in the same store read by GET /v1/tasks/:id.
      this.opts.store?.saveTask(this.opts.graph.getTask(task.id)!);
      this.opts.store?.saveExecution(exec);
      savedExecution = true;

      // ── Acceptance gate (TOX-6 FU) ────────────────────────────
      // Only applies when the adapter finished cleanly AND the task
      // declares deterministic checks. Other exec statuses follow the
      // direct mapping below.
      if (
        exec.status === 'completed' &&
        task.acceptance?.checks &&
        task.acceptance.checks.length > 0
      ) {
        await this.runAcceptanceGate(task, exec);
      } else {
        const nextStatus =
          exec.status === 'completed'
            ? 'done'
            : exec.status === 'cancelled'
              ? 'cancelled'
              : exec.status === 'timeout'
                ? 'failed'
                : 'failed';

        try {
          this.opts.graph.updateTask(task.id, { status: nextStatus }, { now: this.now() });
          this.opts.store?.saveTask(this.opts.graph.getTask(task.id)!);
        } catch {
          // illegal transition — caller has already moved the task; bus
          // still receives the terminal event for observability.
        }
        this.recordOps(task, 'cycle_end', nextStatus, { execStatus: exec.status, durationMs: exec.durationMs });

        if (nextStatus === 'done') {
          this.opts.bus?.emit({
            kind: 'task-completed',
            taskId: task.id,
            executionId: exec.id,
            durationMs: exec.durationMs,
            costUsd: exec.costUsd,
          });
          this.opts.graph.promoteReady({ now: this.now() });
        } else if (nextStatus === 'cancelled') {
          this.opts.bus?.emit({
            kind: 'task-cancelled',
            taskId: task.id,
            reason: 'user',
          });
        } else {
          this.opts.bus?.emit({
            kind: 'task-failed',
            taskId: task.id,
            executionId: exec.id,
            errorCode: exec.error?.code ?? 'UNKNOWN',
            errorMessage: exec.error?.message ?? '',
            willRetry: false,
            attempt: task.attempt,
          });
        }
      }
    } catch (err) {
      // An adapter rejection still represents one completed attempt.
      if (!savedExecution) {
        const startedAt = this.opts.graph.getTask(task.id)?.updatedAt ?? this.now();
        const endedAt = this.now();
        const message = err instanceof Error ? err.message : String(err);
        try {
          this.opts.store?.saveTask(this.opts.graph.getTask(task.id)!);
          this.opts.store?.saveExecution({
            ...createExecution(task, { id: res.executionId, now: startedAt }),
            status: 'failed', endedAt, durationMs: endedAt - startedAt,
            error: { code: 'ADAPTER_ERROR', message },
          });
        } catch { /* keep the original adapter error visible on the bus */ }
      }
      try {
        this.opts.graph.updateTask(task.id, { status: 'failed' }, { now: this.now() });
        this.opts.store?.saveTask(this.opts.graph.getTask(task.id)!);
      } catch { /* ignore illegal transition */ }
      this.recordOps(task, 'cycle_end', 'failed', { errorCode: 'ADAPTER_ERROR', error: err instanceof Error ? err.message.slice(0, 120) : String(err) });
      this.opts.bus?.emit({
        kind: 'task-failed',
        taskId: task.id,
        executionId: res.executionId,
        errorCode: 'ADAPTER_ERROR',
        errorMessage: err instanceof Error ? err.message : String(err),
        willRetry: false,
        attempt: task.attempt,
      });
    } finally {
      this.activeByKind.set(kind, Math.max(0, (this.activeByKind.get(kind) ?? 1) - 1));
      this.abortByTask.delete(task.id);
    }
  }

  /**
   * Acceptance path — applies to successfully-completed tasks with
   * `acceptance.checks` declared. Transitions `running → review`,
   * evaluates the checks, then `review → done | failed`. A failed
   * acceptance emits `task-failed` so RetryPolicy can reschedule.
   */
  private async runAcceptanceGate(task: Task, exec: TaskExecution): Promise<void> {
    try {
      this.opts.graph.updateTask(task.id, { status: 'review' }, { now: this.now() });
    } catch {
      // illegal transition — treat as done to avoid stuck
      this.opts.bus?.emit({
        kind: 'task-completed',
        taskId: task.id,
        executionId: exec.id,
        durationMs: exec.durationMs,
        costUsd: exec.costUsd,
      });
      return;
    }

    let report: AcceptanceReport;
    let threw: unknown = null;
    try {
      report = await evaluateAcceptance({
        task,
        exec,
        io: this.opts.acceptanceIo,
      });
    } catch (err) {
      threw = err;
      report = {
        allPass: false,
        passed: [],
        failed: [],
        total: task.acceptance?.checks?.length ?? 0,
      };
    }

    const acceptanceNote = threw
      ? `[ACCEPTANCE check threw: ${threw instanceof Error ? threw.message : String(threw)}]`
      : `[ACCEPTANCE ${report.passed.length}/${report.total} passed]`;

    // ── TOX-6 FU-2 self-heal: append a [LEARNING] note whenever a
    // retry is still possible, so the next attempt (driven by
    // RetryPolicy → graph.updateTask status:ready) sees the prior
    // failure context.
    const mergedNotes = [...task.notes, acceptanceNote];
    const canRetry = task.attempt < task.maxRetries;
    if (!report.allPass && canRetry) {
      const learning = buildLearningNote(report, threw, task.attempt + 1);
      if (learning) mergedNotes.push(learning);
    }

    if (report.allPass && !threw) {
      try {
        this.opts.graph.updateTask(
          task.id,
          { status: 'done', notes: mergedNotes },
          { now: this.now() },
        );
        this.opts.store?.saveTask(this.opts.graph.getTask(task.id)!);
      } catch { /* stale transition */ }
      this.recordOps(task, 'cycle_end', 'done', { acceptance: `${report.passed.length}/${report.total}` });
      this.opts.bus?.emit({
        kind: 'task-completed',
        taskId: task.id,
        executionId: exec.id,
        durationMs: exec.durationMs,
        costUsd: exec.costUsd,
      });
      this.opts.graph.promoteReady({ now: this.now() });
    } else {
      try {
        this.opts.graph.updateTask(
          task.id,
          { status: 'failed', notes: mergedNotes },
          { now: this.now() },
        );
        this.opts.store?.saveTask(this.opts.graph.getTask(task.id)!);
      } catch { /* stale transition */ }
      const failedReasons = report.failed
        .map((r) => r.reason)
        .slice(0, 3)
        .join('; ');
      this.recordOps(task, 'cycle_end', 'failed', { errorCode: threw ? 'ACCEPTANCE_CHECK_THREW' : 'ACCEPTANCE_FAILED', reasons: failedReasons });
      this.opts.bus?.emit({
        kind: 'task-failed',
        taskId: task.id,
        executionId: exec.id,
        errorCode: threw ? 'ACCEPTANCE_CHECK_THREW' : 'ACCEPTANCE_FAILED',
        errorMessage: threw
          ? threw instanceof Error
            ? threw.message
            : String(threw)
          : failedReasons || 'acceptance gate failed',
        willRetry: false,
        attempt: task.attempt,
      });
    }
  }
}

/**
 * Build a `[LEARNING attempt=N] ...` note summarising up to the top 3
 * failed check reasons. Each reason is trimmed to 120 chars so the
 * note stays readable in sidebars + LLM context windows.
 */
function buildLearningNote(
  report: AcceptanceReport,
  threw: unknown,
  nextAttempt: number,
): string | null {
  if (threw) {
    const msg = threw instanceof Error ? threw.message : String(threw);
    return `[LEARNING attempt=${nextAttempt}] evaluator threw: ${truncate(msg, 120)}`;
  }
  if (report.failed.length === 0) return null;
  const reasons = report.failed
    .slice(0, 3)
    .map((r) => {
      const kind = r.check.kind;
      return `${kind}: ${truncate(r.reason, 120)}`;
    })
    .join(' | ');
  return `[LEARNING attempt=${nextAttempt}] ${reasons}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
