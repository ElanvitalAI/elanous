/**
 * TOX Feedback Loop — babyagi core.
 *
 * Origin: `내부 문서 `PLAN-session-tox-feedback-loop`` · TOX-2c.
 *
 * Connects Generator + Dispatcher into a closed loop. On every
 * task-completed / task-failed event we walk a 6-stage gate:
 *
 *   1. andon         — escalation live → paused
 *   2. paused?       — manual / prior trip → bail
 *   3. termination   — goal done → terminate
 *   4. budget        — tripped → paused
 *   5. reprioritize  — every N completions, run the hook
 *   6. dispatch      — promoteReady + dispatcher.tick()
 *   7. regenerate?   — idle + incomplete + depth OK → decompose + apply
 *
 * All external checks are **injected** (terminationCheck / budgetCheck
 * / hasPendingCritical). The loop itself has zero IO; this keeps the
 * module pure, unit-testable, and decoupled from the surrounding
 * elanous trackers (auto-research / cost-meter / cft).
 */
import type { TaskGraph } from './graph.js';
import type { TaskDispatcher } from './dispatcher.js';
import type { TaskEvent, TaskEventBus, TaskEventDisposable } from './events.js';
import type { TaskGenerator } from './generator.js';
import type { DecomposeProposal, ProposedTask } from './generator-schema.js';
import {
  TASK_DEFAULTS,
  createTask,
  type Task,
  type TaskGeneratedBy,
} from './types.js';

// ───────────────────────── Types ───────────────────────────────────

export type PauseReason = 'andon' | 'budget' | 'manual';

export type FeedbackOutcome =
  | { kind: 'terminate'; goalSlug: string; reason: string }
  | { kind: 'paused'; reason: PauseReason; detail?: string }
  | {
      kind: 'continue';
      dispatched: number;
      deferred: number;
      reprioritized: boolean;
      regenerated: { goalSlug: string; taskIds: string[] } | null;
    };

export type RegenerateOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'applied'; taskIds: string[] }
  | { kind: 'approval-required'; reasons: string[]; proposal: DecomposeProposal; applyToken: string };

export interface TerminationGate {
  (goalSlug: string): Promise<{ shouldTerminate: boolean; reason?: string }>;
}

export interface BudgetGate {
  (goalSlug: string, estimateUsd?: number): Promise<{
    canAfford: boolean;
    tripped: readonly string[];
  }>;
}

export interface FeedbackLoopOptions {
  graph: TaskGraph;
  dispatcher: TaskDispatcher;
  /** Boot can route follow-up dispatch through the admitted TOX queue. */
  dispatchReady?: () => ReturnType<TaskDispatcher['tick']> | Promise<ReturnType<TaskDispatcher['tick']>>;
  bus?: TaskEventBus;
  generator?: TaskGenerator;

  terminationCheck?: TerminationGate;
  budgetCheck?: BudgetGate;
  hasPendingCritical?: () => boolean;

  /** Map `goalSlug → objective text`. Returning null disables regenerate
   *  for that goal. */
  regenerateObjective?: (goalSlug: string) => string | null;
  /** Called every `reprioritizeEvery` completions. Default = no-op. */
  reprioritize?: (graph: TaskGraph, goalSlug: string | undefined) => void;

  reprioritizeEvery?: number;
  maxRegenerateDepth?: number;
  now?: () => number;

  /** Optional logger for telemetry — swallowed otherwise. */
  log?: (line: string) => void;
}

export interface FeedbackLoopStats {
  completedTotal: number;
  regenerateDepthByGoal: Record<string, number>;
  paused: boolean;
  pausedReason: PauseReason | null;
}

// ───────────────────────── Loop ─────────────────────────────────────

export class TaskFeedbackLoop {
  private readonly reprioritizeEvery: number;
  private readonly maxRegenerateDepth: number;
  private readonly now: () => number;

  private completedTotal = 0;
  private readonly regenerateDepth = new Map<string, number>();
  private paused = false;
  private pausedReason: PauseReason | null = null;

  private subscription: TaskEventDisposable | null = null;

  constructor(private readonly opts: FeedbackLoopOptions) {
    this.reprioritizeEvery = opts.reprioritizeEvery ?? 5;
    if (this.reprioritizeEvery <= 0 || !Number.isInteger(this.reprioritizeEvery)) {
      throw new RangeError('reprioritizeEvery must be a positive integer');
    }
    this.maxRegenerateDepth =
      opts.maxRegenerateDepth ?? TASK_DEFAULTS.decomposeMaxDepth;
    if (this.maxRegenerateDepth < 0 || !Number.isInteger(this.maxRegenerateDepth)) {
      throw new RangeError('maxRegenerateDepth must be a non-negative integer');
    }
    this.now = opts.now ?? Date.now;
  }

  // ──────────────── lifecycle ──────────────────────────────────────

  start(): void {
    if (this.subscription) return;
    const bus = this.opts.bus;
    if (!bus) return; // no bus → caller must drive via onTaskCompleted directly
    this.subscription = bus.subscribe(
      (ev: TaskEvent) => {
        if (ev.kind === 'task-completed') {
          void this.onTaskCompleted(ev.taskId).catch((err) => {
            this.log(`onTaskCompleted failure: ${String(err)}`);
          });
        } else if (ev.kind === 'task-failed' || ev.kind === 'task-cancelled') {
          // Failed/cancelled still shift ready-set — run the dispatch half
          void this.onTaskSettled(ev.taskId).catch((err) => {
            this.log(`onTaskSettled failure: ${String(err)}`);
          });
        } else if (ev.kind === 'escalation') {
          this.onEscalation(ev.severity);
        } else if (ev.kind === 'budget-warning' && ev.remainingPct <= 0) {
          this.pause('budget');
        }
      },
      {
        kinds: ['task-completed', 'task-failed', 'task-cancelled', 'escalation', 'budget-warning'],
      },
    );
  }

  stop(): void {
    this.subscription?.dispose();
    this.subscription = null;
  }

  pause(reason: PauseReason): void {
    this.paused = true;
    this.pausedReason = reason;
    this.log(`paused(${reason})`);
  }

  resume(): void {
    this.paused = false;
    this.pausedReason = null;
    this.log('resumed');
  }

  isPaused(): boolean {
    return this.paused;
  }

  stats(): FeedbackLoopStats {
    return {
      completedTotal: this.completedTotal,
      regenerateDepthByGoal: Object.fromEntries(this.regenerateDepth),
      paused: this.paused,
      pausedReason: this.pausedReason,
    };
  }

  // ──────────────── core ──────────────────────────────────────────

  /**
   * Main 6-stage gate invoked after a task reaches `done`. Safe to call
   * even for unknown ids — returns `continue` with no-op in that case.
   */
  async onTaskCompleted(taskId: string): Promise<FeedbackOutcome> {
    const task = this.opts.graph.getTask(taskId);
    if (!task) return this.continueWithDispatch(undefined, false);

    this.completedTotal++;
    const goalSlug = task.goalSlug;

    // Stage 1 — andon
    if (this.opts.hasPendingCritical?.()) {
      this.pause('andon');
      return { kind: 'paused', reason: 'andon' };
    }
    // Stage 2 — paused flag
    if (this.paused) {
      return { kind: 'paused', reason: this.pausedReason ?? 'manual' };
    }
    // Stage 3 — termination
    if (goalSlug && this.opts.terminationCheck) {
      try {
        const term = await this.opts.terminationCheck(goalSlug);
        if (term.shouldTerminate) {
          return { kind: 'terminate', goalSlug, reason: term.reason ?? 'termination rule satisfied' };
        }
      } catch (err) {
        // treat as "not terminated" — but log so auto-research noise
        // doesn't silently kill the loop
        this.log(`terminationCheck threw: ${String(err)}`);
      }
    }
    // Stage 4 — budget
    if (goalSlug && this.opts.budgetCheck) {
      try {
        const b = await this.opts.budgetCheck(goalSlug, 0);
        if (b.tripped.length > 0) {
          this.pause('budget');
          return {
            kind: 'paused',
            reason: 'budget',
            detail: `tripped: ${b.tripped.join(', ')}`,
          };
        }
      } catch (err) {
        this.log(`budgetCheck threw: ${String(err)}`);
      }
    }
    // Stage 5 — reprioritize
    const reprioritized =
      this.completedTotal > 0 &&
      this.completedTotal % this.reprioritizeEvery === 0;
    if (reprioritized && this.opts.reprioritize) {
      try {
        this.opts.reprioritize(this.opts.graph, goalSlug);
      } catch (err) {
        this.log(`reprioritize threw: ${String(err)}`);
      }
    }
    // Stage 6 — dispatch + optional regenerate
    return this.continueWithDispatch(goalSlug, reprioritized);
  }

  /**
   * Lighter path for `failed` / `cancelled` — bump dispatch; don't
   * termination-check (failed tasks shouldn't end the goal) but still
   * honor andon/budget pauses.
   */
  async onTaskSettled(taskId: string): Promise<FeedbackOutcome> {
    const task = this.opts.graph.getTask(taskId);
    if (!task) return this.continueWithDispatch(undefined, false);
    if (this.opts.hasPendingCritical?.()) {
      this.pause('andon');
      return { kind: 'paused', reason: 'andon' };
    }
    if (this.paused) {
      return { kind: 'paused', reason: this.pausedReason ?? 'manual' };
    }
    return this.continueWithDispatch(task.goalSlug, false);
  }

  onEscalation(severity: string): void {
    if (severity === 'CRITICAL' || severity === 'HIGH') {
      this.pause('andon');
    }
  }

  // ──────────────── regenerate ─────────────────────────────────────

  async maybeRegenerate(goalSlug: string): Promise<RegenerateOutcome> {
    if (!this.opts.generator) {
      return { kind: 'skipped', reason: 'no generator wired' };
    }
    if (!this.opts.regenerateObjective) {
      return { kind: 'skipped', reason: 'no regenerateObjective wired' };
    }
    // idle?
    if (this.opts.graph.listRunning().length > 0) {
      return { kind: 'skipped', reason: 'tasks still running' };
    }
    if (this.opts.graph.readySet({ limit: 1 }).length > 0) {
      return { kind: 'skipped', reason: 'ready set non-empty' };
    }
    // incomplete?
    const goalTasks = this.opts.graph.listByGoal(goalSlug);
    const openCount = goalTasks.filter(
      (t) => t.status !== 'done' && t.status !== 'cancelled' && t.status !== 'superseded',
    ).length;
    // depth?
    const depth = this.regenerateDepth.get(goalSlug) ?? 0;
    if (depth >= this.maxRegenerateDepth) {
      return { kind: 'skipped', reason: `depth ${depth} >= cap ${this.maxRegenerateDepth}` };
    }
    // Require there to be *some* goal-bound tasks at all; pure zero = nothing to regenerate from.
    if (goalTasks.length === 0) {
      return { kind: 'skipped', reason: 'goal has no tasks yet' };
    }
    // If everything is done already, let termination handle it.
    if (openCount === 0) {
      return { kind: 'skipped', reason: 'goal has no open tasks — termination path' };
    }

    const objective = this.opts.regenerateObjective(goalSlug);
    if (!objective || objective.trim().length === 0) {
      return { kind: 'skipped', reason: 'regenerateObjective returned empty' };
    }

    const result = await this.opts.generator.decompose({
      objective,
      context: { goalSlug },
      depth,
    });

    if (result.requiresApproval) {
      return {
        kind: 'approval-required',
        reasons: result.approvalReasons,
        proposal: result.proposal,
        applyToken: result.applyToken,
      };
    }

    const taskIds = this.applyProposal(result.proposal, goalSlug, depth);
    this.regenerateDepth.set(goalSlug, depth + 1);
    this.opts.bus?.emit({
      kind: 'task-regenerated',
      taskId: null,
      goalSlug,
      replacementIds: taskIds,
      depth: depth + 1,
    });
    return { kind: 'applied', taskIds };
  }

  /**
   * Turn a validated DecomposeProposal into live graph tasks. Sibling
   * index references are resolved to real task ids in-order, so tasks
   * with `dependsOn: [0, 2]` get rewritten to `[map[0], map[2]]` before
   * the graph insert.
   *
   * Exposed for tests + for the future TOX-3 `TaskDecomposeApply` tool.
   */
  applyProposal(
    proposal: DecomposeProposal,
    goalSlug: string | undefined,
    depth: number,
  ): string[] {
    const idxToId = new Map<number, string>();
    const ids: string[] = [];
    for (const p of proposal.tasks) {
      const deps = (p.dependsOn ?? []).map((i) => idxToId.get(i)).filter((v): v is string => !!v);
      const generatedBy: TaskGeneratedBy = { kind: 'regenerate', depth: depth + 1 };
      const task = createTask(
        {
          title: p.title,
          description: p.description,
          surface: p.surface,
          goalSlug,
          dependsOn: deps,
          priority: p.priority,
          isolation: p.isolation,
          estimateMs: p.estimateMs,
          estimateTokens: p.estimateTokens,
          estimateUsd: p.estimateUsd,
          timeoutMs: p.timeoutMs,
          acceptance: p.acceptance,
          generatedBy,
        },
        { now: this.now() },
      );
      this.opts.graph.addTask(task);
      idxToId.set(p.index, task.id);
      ids.push(task.id);
    }
    // After adding, run promoteReady so root-level tasks (no deps) flip
    // to 'ready' and the next dispatch tick picks them up.
    this.opts.graph.promoteReady({ now: this.now() });
    return ids;
  }

  // ──────────────── internals ──────────────────────────────────────

  private async continueWithDispatch(
    goalSlug: string | undefined,
    reprioritized: boolean,
  ): Promise<FeedbackOutcome> {
    // promote first so newly-unblocked deps flip to ready
    this.opts.graph.promoteReady({ now: this.now() });
    const result = await (this.opts.dispatchReady ?? (() => this.opts.dispatcher.tick()))();
    const dispatched = result.dispatched.length;
    const deferred = result.deferred.length;

    let regenerated: { goalSlug: string; taskIds: string[] } | null = null;
    if (dispatched === 0 && goalSlug) {
      const rg = await this.maybeRegenerate(goalSlug);
      if (rg.kind === 'applied') {
        regenerated = { goalSlug, taskIds: rg.taskIds };
        // After regenerate applied, run another dispatch pass so the
        // new ready tasks start immediately.
        const second = await (this.opts.dispatchReady ?? (() => this.opts.dispatcher.tick()))();
        return {
          kind: 'continue',
          dispatched: second.dispatched.length,
          deferred: second.deferred.length,
          reprioritized,
          regenerated,
        };
      }
      // skipped / approval-required → do not start anything; fall through
    }
    return { kind: 'continue', dispatched, deferred, reprioritized, regenerated };
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }
}

// ───────────────────────── Re-export convenience ───────────────────

export type { Task, ProposedTask };
