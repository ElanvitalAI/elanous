/**
 * Surface adapter registry — the injection seam between the
 * dispatcher (policy: "should this run now?") and the surface-
 * specific execution (`SurfaceAdapter` for terminal / subagent /
 * skill / chat-prompt / llm-direct / vw-slot / cron).
 *
 * Origin: `내부 문서 `PLAN-session-task-orchestrator-coevolution`` §3.5.
 *
 * Keeping this as a registry (not a switch) means:
 *   - Tests can register mock adapters for any subset of surfaces
 *   - Surfaces depending on heavy elanous infra (terminal-matrix,
 *     VW stack, agent-team) can be added lazily from the boot code
 *     without touching the dispatcher core
 *   - Future additions (e.g. `acx-session` from AXON-P6) just register
 *     another adapter
 */
import type { Task, TaskExecution, TaskSurfaceKind } from './types.js';

/**
 * Result of dispatching a task to its surface.
 *
 * The adapter returns **immediately** after spawning the underlying
 * work — the final `TaskExecution` arrives via the `promise` field.
 * This lets the dispatcher schedule multiple tasks concurrently
 * (up to the per-surface cap) without waiting for any one to finish.
 */
export interface DispatchResult {
  readonly executionId: string;
  /** e.g. `term:5` / `agent:explore` / `skill:omni-crawl`. Unset when
   *  the surface hasn't spawned yet (rare). */
  readonly surfaceAddress?: string;
  /** Resolves when the execution reaches a terminal status. Rejects
   *  only on unexpected adapter errors — deterministic failures come
   *  back as `TaskExecution { status: 'failed', error }`. */
  readonly promise: Promise<TaskExecution>;
}

/** Context threaded through every dispatch — injection only.
 *  Individual surfaces pick what they need. */
export interface DispatchContext {
  /** Cancellable. AbortController downstream propagates to surface-
   *  specific kill path (terminal SIGTERM / subagent abort / skill
   *  subprocess.kill / …). */
  readonly signal?: AbortSignal;
  /** Working directory override; defaults to getSessionCwd(). */
  readonly cwd?: string;
  /** Carry-over for LLM surfaces that need turn-kickoff model
   *  recommendation (PFC-S5). */
  readonly modelHint?: string;
  /** Free-form — tests + callers extend as needed. */
  readonly metadata?: Record<string, unknown>;
}

/** An adapter is a pure-ish function bound to one surface kind. */
export type SurfaceAdapter = ((
  task: Task,
  ctx: DispatchContext
) => Promise<DispatchResult>) & {
  /** Admission check before the dispatcher changes ready → running. */
  deferReason?: (task: Task) => 'intake-sequential' | undefined;
};

/**
 * In-memory registry with a singleton escape for dashboard boot.
 * Adapters register at module-eval or lifecycle time; the dispatcher
 * reads via `resolve()`.
 */
export class SurfaceRegistry {
  private readonly adapters = new Map<TaskSurfaceKind, SurfaceAdapter>();

  register(kind: TaskSurfaceKind, adapter: SurfaceAdapter): void {
    if (this.adapters.has(kind)) {
      throw new Error(`SurfaceRegistry: '${kind}' already registered`);
    }
    this.adapters.set(kind, adapter);
  }

  /** Overwrite an existing registration — tests mostly. */
  override(kind: TaskSurfaceKind, adapter: SurfaceAdapter): void {
    this.adapters.set(kind, adapter);
  }

  resolve(kind: TaskSurfaceKind): SurfaceAdapter | null {
    return this.adapters.get(kind) ?? null;
  }

  has(kind: TaskSurfaceKind): boolean {
    return this.adapters.has(kind);
  }

  listKinds(): TaskSurfaceKind[] {
    return [...this.adapters.keys()];
  }

  clear(): void {
    this.adapters.clear();
  }
}

// ───────────────────────── Singleton ────────────────────────────────

let _registry: SurfaceRegistry | null = null;

export function getSurfaceRegistry(): SurfaceRegistry {
  if (!_registry) _registry = new SurfaceRegistry();
  return _registry;
}

export function __setSurfaceRegistryForTest(r: SurfaceRegistry | null): void {
  _registry = r;
}
