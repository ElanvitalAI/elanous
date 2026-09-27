/**
 * TaskGraph — in-memory DAG with priority-aware ready-set dispatch.
 *
 * Origin: `내부 문서 `PLAN-session-task-orchestrator-coevolution`` §3.2
 * Session: TOX-1 foundation · Phase 2 (feat/tox-foundation-graph).
 *
 * Responsibilities:
 *   - CRUD for Task nodes (add / update / supersede / get / listByGoal)
 *   - Edge maintenance (dependsOn / triggers — inverse index)
 *   - Ready-set computation (promoteReady + readySet)
 *   - Cycle detection (DFS, O(V+E))
 *   - Subtree traversal (cascade ops)
 *   - Status propagation on completion
 *
 * **Not** responsible for:
 *   - Persistence (Phase 1b SQLite store)
 *   - Actually running tasks (Phase 2b dispatcher)
 *   - Generating tasks (Phase 2c generator)
 *   - Event emission (Phase 3 events bus — graph exposes hooks but
 *     doesn't subscribe)
 *
 * Purity: Graph is a *state container* with mutation methods. No IO.
 * The only non-determinism is `Date.now()` inside `updateTask` — and
 * that can be injected via `opts.now`.
 */
import {
  isOpenStatus,
  isTerminalStatus,
  type Task,
  type TaskStatus,
} from './types.js';
import {
  compareByPriority,
  type PriorityContext,
  type PriorityWeights,
} from './priority.js';

// ─────────────────────── Errors ─────────────────────────────────────

export class TaskGraphError extends Error {
  constructor(
    public readonly code: string,
    reason: string,
    public readonly taskId?: string
  ) {
    // Prefix with the machine-readable code so that programmatic
    // matchers ( toThrow(/CYCLE_DETECTED/) ) + human log lines agree.
    super(`${code}: ${reason}`);
    this.name = 'TaskGraphError';
  }
}

// ─────────────────────── Public shapes ─────────────────────────────

export interface ReadySetOptions {
  /** Filter by surface kind. */
  surface?: Task['surface']['kind'];
  /** Max tasks to return. Default 16. */
  limit?: number;
  /** Priority overrides (tests / tuning). */
  priority?: PriorityContext;
}

export interface GraphSnapshot {
  readonly tasks: readonly Task[];
  readonly countsByStatus: Readonly<Record<TaskStatus, number>>;
}

// ─────────────────────── TaskGraph ─────────────────────────────────

export class TaskGraph {
  /** Canonical store: id → Task (includes superseded — history kept). */
  private readonly tasks = new Map<string, Task>();
  /** Inverse index: id → ids that depend on it. Rebuilt on add/update. */
  private readonly dependents = new Map<string, Set<string>>();
  /** Goal index: goalSlug → set of task ids. */
  private readonly goalIndex = new Map<string, Set<string>>();

  // ──────────────── CRUD ─────────────────────────────────────────

  /**
   * Insert a new task. Rebuilds dependent/goal indices. Throws if
   * `task.id` already exists — use `updateTask` for in-place changes.
   *
   * Also detects cycles incrementally: if adding this task's dependsOn
   * edges introduces a cycle, it's rolled back and throws.
   */
  addTask(task: Task): void {
    if (this.tasks.has(task.id)) {
      throw new TaskGraphError('DUPLICATE_ID', `Task ${task.id} already in graph`, task.id);
    }
    // Verify all dependsOn exist (or tolerate — we tolerate missing
    // deps since they may be added later by generator's apply loop).
    // We only check for cycles.
    this.tasks.set(task.id, task);
    this.indexEdgesForAdd(task);
    this.indexGoal(task);
    const cycle = this.detectCycleStartingAt(task.id);
    if (cycle) {
      // rollback
      this.tasks.delete(task.id);
      this.unindexEdgesForRemove(task);
      this.unindexGoal(task);
      throw new TaskGraphError(
        'CYCLE_DETECTED',
        `Adding ${task.id} creates cycle: ${cycle.join(' → ')}`,
        task.id
      );
    }
  }

  /**
   * Mutate a task. Status transitions are validated; invalid ones
   * throw `TaskGraphError('INVALID_TRANSITION')`. Indices are
   * maintained automatically.
   *
   * `patch.dependsOn` replacement triggers a cycle check.
   */
  updateTask(id: string, patch: Partial<Task>, opts?: { now?: number }): Task {
    const existing = this.tasks.get(id);
    if (!existing) {
      throw new TaskGraphError('NOT_FOUND', `Task ${id} not in graph`, id);
    }
    if (patch.status !== undefined && patch.status !== existing.status) {
      if (!isValidTransition(existing.status, patch.status)) {
        throw new TaskGraphError(
          'INVALID_TRANSITION',
          `Illegal ${existing.status} → ${patch.status} for ${id}`,
          id
        );
      }
    }
    // If dependsOn changes, re-index + re-check cycle.
    const depsChanged =
      patch.dependsOn !== undefined && !arrayEqual(patch.dependsOn, existing.dependsOn);
    const goalChanged =
      patch.goalSlug !== undefined && patch.goalSlug !== existing.goalSlug;

    if (depsChanged) this.unindexEdgesForRemove(existing);
    if (goalChanged) this.unindexGoal(existing);

    const merged: Task = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      version: patch.version ?? existing.version,
      updatedAt: opts?.now ?? Date.now(),
      dependsOn:
        patch.dependsOn !== undefined
          ? Object.freeze([...patch.dependsOn])
          : existing.dependsOn,
      triggerChain: existing.triggerChain,
      notes: patch.notes ?? existing.notes,
    };
    this.tasks.set(id, merged);
    if (depsChanged) this.indexEdgesForAdd(merged);
    if (goalChanged) this.indexGoal(merged);

    if (depsChanged) {
      const cycle = this.detectCycleStartingAt(id);
      if (cycle) {
        // revert
        this.tasks.set(id, existing);
        if (depsChanged) {
          this.unindexEdgesForRemove(merged);
          this.indexEdgesForAdd(existing);
        }
        if (goalChanged) {
          this.unindexGoal(merged);
          this.indexGoal(existing);
        }
        throw new TaskGraphError(
          'CYCLE_DETECTED',
          `Updating ${id} dependsOn creates cycle: ${cycle.join(' → ')}`,
          id
        );
      }
    }
    return merged;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  hasTask(id: string): boolean {
    return this.tasks.has(id);
  }

  /** Restore a task after a persistence transaction fails, including a new insertion. */
  restoreTask(id: string, previous?: Task): void {
    const current = this.tasks.get(id);
    if (current) {
      this.tasks.delete(id);
      this.unindexEdgesForRemove(current);
      this.unindexGoal(current);
    }
    if (previous) {
      this.tasks.set(id, previous);
      this.indexEdgesForAdd(previous);
      this.indexGoal(previous);
    }
  }

  size(): number {
    return this.tasks.size;
  }

  /**
   * All tasks, in insertion order (Map iteration). Includes
   * superseded — callers who only want live tasks should filter with
   * `isOpenStatus(t.status)` or `t.status !== 'superseded'`.
   */
  listAll(): Task[] {
    return [...this.tasks.values()];
  }

  /** Live (non-superseded) tasks for a goal. */
  listByGoal(goalSlug: string): Task[] {
    const ids = this.goalIndex.get(goalSlug);
    if (!ids) return [];
    const out: Task[] = [];
    for (const id of ids) {
      const t = this.tasks.get(id);
      if (t && t.status !== 'superseded') out.push(t);
    }
    return out;
  }

  /**
   * Replace `oldId`'s role in the graph with `replacementIds`. The
   * old task is marked `superseded` (terminal). Dependents that
   * pointed at `oldId` now point at the first replacement.
   *
   * This is the regeneration pathway: the LLM decided the old
   * decomposition was wrong and issued a new set.
   */
  supersede(oldId: string, replacementIds: string[], opts?: { now?: number }): void {
    const old = this.tasks.get(oldId);
    if (!old) throw new TaskGraphError('NOT_FOUND', `Task ${oldId} not in graph`, oldId);
    if (isTerminalStatus(old.status) && old.status !== 'failed') {
      // already terminal — legal for 'failed' (retry path) but not
      // for done/cancelled/superseded.
      throw new TaskGraphError(
        'INVALID_TRANSITION',
        `Cannot supersede terminal status ${old.status}`,
        oldId
      );
    }
    for (const rid of replacementIds) {
      if (!this.tasks.has(rid)) {
        throw new TaskGraphError('NOT_FOUND', `Replacement ${rid} not in graph`, rid);
      }
    }

    // Redirect dependents: any task whose dependsOn includes oldId
    // gets that entry replaced by replacementIds[0] (or removed if
    // replacementIds is empty).
    const depIds = [...(this.dependents.get(oldId) ?? [])];
    for (const depId of depIds) {
      const dep = this.tasks.get(depId);
      if (!dep) continue;
      const newDeps = dep.dependsOn.filter((d) => d !== oldId);
      if (replacementIds.length > 0) newDeps.push(replacementIds[0]);
      this.updateTask(depId, { dependsOn: newDeps }, opts);
    }

    // Mark old as superseded.
    this.updateTask(oldId, { status: 'superseded' }, opts);
  }

  // ──────────────── Scheduling helpers ───────────────────────────

  /**
   * Promote backlog/blocked tasks whose dependencies are now all
   * `done` to `ready`. Returns the list of promoted tasks.
   *
   * Called by the scheduler at each tick. Idempotent.
   */
  promoteReady(opts?: { now?: number }): Task[] {
    const promoted: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.status !== 'backlog' && t.status !== 'blocked') continue;
      if (t.generatedBy?.kind === 'external' && t.approval?.state !== 'auto') continue;
      if (this.depsAllDone(t)) {
        const next = this.updateTask(t.id, { status: 'ready' }, opts);
        promoted.push(next);
      } else if (t.status === 'backlog' && t.dependsOn.length > 0) {
        // start life as blocked if we already know deps aren't done
        const next = this.updateTask(t.id, { status: 'blocked' }, opts);
        promoted.push(next);
      }
    }
    return promoted;
  }

  /**
   * Return priority-sorted ready tasks. Does **not** mutate status —
   * caller dispatches + then calls `updateTask(id, {status:'running'})`.
   */
  readySet(opts: ReadySetOptions = {}): Task[] {
    const limit = opts.limit ?? 16;
    const out: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.status !== 'ready') continue;
      if (opts.surface && t.surface.kind !== opts.surface) continue;
      out.push(t);
    }
    // precompute descendant count for this slice
    const ctx: PriorityContext = {
      ...opts.priority,
      descendantCount: this.computeDescendantCounts(out.map((t) => t.id)),
    };
    out.sort((a, b) => compareByPriority(a, b, ctx));
    return out.slice(0, limit);
  }

  /**
   * Tasks currently running. Useful for concurrency cap checks.
   */
  listRunning(surface?: Task['surface']['kind']): Task[] {
    const out: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.status !== 'running') continue;
      if (surface && t.surface.kind !== surface) continue;
      out.push(t);
    }
    return out;
  }

  /** Count tasks by status — used by ROADMAP snapshots, loop prompts. */
  countByStatus(): Record<TaskStatus, number> {
    const counts: Record<TaskStatus, number> = {
      backlog: 0,
      blocked: 0,
      scheduled: 0,
      ready: 0,
      running: 0,
      review: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      superseded: 0,
    };
    for (const t of this.tasks.values()) counts[t.status]++;
    return counts;
  }

  /**
   * Propagation: mark `id` as `done`, then promote any dependents
   * whose deps are fully satisfied. Returns the newly-ready tasks.
   *
   * Caller is responsible for actually transitioning through
   * `review` first — this method just does the graph ripple.
   */
  onCompleted(id: string, opts?: { now?: number }): Task[] {
    const t = this.tasks.get(id);
    if (!t) throw new TaskGraphError('NOT_FOUND', id, id);
    if (t.status !== 'done') {
      // if caller didn't set done yet, do it now (convenience)
      this.updateTask(id, { status: 'done' }, opts);
    }
    return this.promoteReady(opts);
  }

  // ──────────────── Cycle detection + subtree ───────────────────

  /**
   * Full-graph cycle detection. Returns the first cycle found as an
   * array of task ids (head ... head) or `null` when acyclic. Used
   * primarily by tests; mutations do incremental checks.
   */
  detectCycle(): string[] | null {
    const WHITE = 0,
      GRAY = 1,
      BLACK = 2;
    const color = new Map<string, number>();
    for (const id of this.tasks.keys()) color.set(id, WHITE);
    for (const id of this.tasks.keys()) {
      if (color.get(id) === WHITE) {
        const cyc = this.dfsCycle(id, color, new Map());
        if (cyc) return cyc;
      }
    }
    return null;
  }

  /**
   * Return all tasks reachable from `rootId` by following `dependents`
   * (not dependsOn) — i.e., the *downstream* subtree. Useful for
   * cascade cancel.
   *
   * Result is in BFS order and *includes* the root.
   */
  subtree(rootId: string): Task[] {
    if (!this.tasks.has(rootId)) return [];
    const seen = new Set<string>();
    const queue: string[] = [rootId];
    const out: Task[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const t = this.tasks.get(id);
      if (!t) continue;
      out.push(t);
      const deps = this.dependents.get(id);
      if (deps) for (const d of deps) if (!seen.has(d)) queue.push(d);
    }
    return out;
  }

  /** Snapshot — cheap immutable view for tests / persistence. */
  snapshot(): GraphSnapshot {
    return {
      tasks: [...this.tasks.values()],
      countsByStatus: this.countByStatus(),
    };
  }

  // ──────────────── Internals ───────────────────────────────────

  private indexEdgesForAdd(task: Task): void {
    for (const dep of task.dependsOn) {
      let set = this.dependents.get(dep);
      if (!set) {
        set = new Set();
        this.dependents.set(dep, set);
      }
      set.add(task.id);
    }
  }

  private unindexEdgesForRemove(task: Task): void {
    for (const dep of task.dependsOn) {
      const set = this.dependents.get(dep);
      if (!set) continue;
      set.delete(task.id);
      if (set.size === 0) this.dependents.delete(dep);
    }
  }

  private indexGoal(task: Task): void {
    if (!task.goalSlug) return;
    let set = this.goalIndex.get(task.goalSlug);
    if (!set) {
      set = new Set();
      this.goalIndex.set(task.goalSlug, set);
    }
    set.add(task.id);
  }

  private unindexGoal(task: Task): void {
    if (!task.goalSlug) return;
    const set = this.goalIndex.get(task.goalSlug);
    if (!set) return;
    set.delete(task.id);
    if (set.size === 0) this.goalIndex.delete(task.goalSlug);
  }

  private depsAllDone(task: Task): boolean {
    for (const dep of task.dependsOn) {
      const d = this.tasks.get(dep);
      if (!d) return false; // unknown dep blocks
      if (d.status !== 'done') return false;
    }
    return true;
  }

  private detectCycleStartingAt(startId: string): string[] | null {
    const WHITE = 0,
      GRAY = 1,
      BLACK = 2;
    const color = new Map<string, number>();
    for (const id of this.tasks.keys()) color.set(id, WHITE);
    return this.dfsCycle(startId, color, new Map());
  }

  private dfsCycle(
    id: string,
    color: Map<string, number>,
    parent: Map<string, string>
  ): string[] | null {
    const WHITE = 0,
      GRAY = 1,
      BLACK = 2;
    color.set(id, GRAY);
    const task = this.tasks.get(id);
    if (task) {
      for (const next of task.dependsOn) {
        const c = color.get(next);
        if (c === undefined) continue; // missing dep — not a cycle
        if (c === GRAY) {
          // back edge — reconstruct cycle
          const cycle: string[] = [next];
          let cur = id;
          while (cur !== next && parent.has(cur)) {
            cycle.unshift(cur);
            cur = parent.get(cur)!;
          }
          cycle.unshift(next);
          return cycle;
        } else if (c === WHITE) {
          parent.set(next, id);
          const got = this.dfsCycle(next, color, parent);
          if (got) return got;
        }
      }
    }
    color.set(id, BLACK);
    return null;
  }

  private computeDescendantCounts(ids: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const id of ids) out.set(id, this.subtree(id).length - 1);
    return out;
  }
}

// ─────────────────────── Transition table ─────────────────────────

/**
 * Valid `TaskStatus` transitions. Matches docstring in types.ts.
 * Self-transitions return true (idempotent updates).
 */
const TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = Object.freeze({
  backlog: new Set<TaskStatus>(['blocked', 'scheduled', 'ready', 'cancelled', 'superseded']),
  blocked: new Set<TaskStatus>(['scheduled', 'ready', 'backlog', 'cancelled', 'superseded']),
  scheduled: new Set<TaskStatus>(['ready', 'running', 'cancelled']),
  ready: new Set<TaskStatus>(['scheduled', 'running', 'cancelled', 'superseded', 'backlog']),
  running: new Set<TaskStatus>(['review', 'failed', 'cancelled', 'done']),
  review: new Set<TaskStatus>(['done', 'failed']),
  done: new Set<TaskStatus>(),
  failed: new Set<TaskStatus>(['ready', 'cancelled', 'superseded', 'backlog']),
  cancelled: new Set<TaskStatus>(),
  superseded: new Set<TaskStatus>(),
});

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  const allowed = TRANSITIONS[from];
  return allowed.has(to);
}

// ─────────────────────── Utilities ────────────────────────────────

function arrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
