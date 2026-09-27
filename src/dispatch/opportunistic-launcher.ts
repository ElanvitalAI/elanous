/**
 * `OpportunisticLauncher` — Phase 2 D5 / RESEARCH §8.
 *
 * Tick loop that walks the TOX ready queue and dispatches anything
 * that passes the four-axes check:
 *
 *   Time        — TimeSlotManager.currentSlot() · per-slot policy
 *   Resource    — ResourceScheduler.tryReserve()
 *   Priority    — TOX graph's priority order + myelin boost (D6 hook)
 *   Concurrency — surface-level cap (deferred to caller)
 *
 * The launcher is pure orchestration — it never touches the LLM or
 * spawns processes directly. Each `launch(task)` hands off to the
 * injected `launch` callable that's wired to the TOX dispatcher in
 * production (`src/task-orchestrator/dispatcher.ts`).
 *
 * Lifecycle:
 *   - `start()`    — kick off the tick loop (default 1000ms interval)
 *   - `stop()`     — clear interval, release any reservations
 *   - `tick()`     — single iteration; exposed for tests / D7 wake
 *
 * No persistence here — the TOX graph is authoritative for queue state
 * and lifetimes of inflight launches live in ResourceScheduler.
 */
import type { DispatchRunRecord } from './dispatch-metrics.js';
import type { ResolvedSlot, SlotKind } from './time-slot.js';
import type {
  LlmCapability,
  ReservationOutcome,
  ResourceScheduler,
  TaskResourceRequirement,
} from './resource-scheduler.js';
import type { IdleDetector } from './idle-detector.js';

// ──────────────────── Public shapes ────────────────────────────────────

export interface LaunchCandidate {
  id: string;
  /** Lower = sooner; matches TOX priority numeric order. */
  priorityRank: number;
  /** True when every dependency is `done`. */
  ready: boolean;
  capabilities?: readonly LlmCapability[];
  /** Slot tag — when present, the task is only run in matching slots. */
  preferredSlot?: SlotKind;
  /** Per-task surface label — concurrency / dedup. */
  surface?: string;
  /** Whether the task is OK with API fallback (forwarded to scheduler). */
  apiFallbackAllowed?: boolean;
  /** Whether the task is "long-running" (sleep slot bias). */
  longRunning?: boolean;
  /** Whether the task is "noisy" (focused-work slot bias). */
  noisy?: boolean;
}

export interface LaunchOutcome {
  ok: boolean;
  taskId: string;
  /** Reason for skip / failure. */
  reason?: string;
  reservation?: ReservationOutcome;
}

export interface LauncherDeps {
  slot: () => ResolvedSlot;
  scheduler: ResourceScheduler;
  /** Optional idle detector. When omitted, idle gating is skipped. */
  idle?: IdleDetector;
  /** Source of ready tasks (TOX graph or stub). Caller is responsible
   *  for honouring priority + dependency ordering. */
  readyTasks: () => Promise<LaunchCandidate[]> | LaunchCandidate[];
  /** Hand off the task for actual dispatch. Returns when the launch
   *  decision is made (the underlying dispatcher may run async). */
  launch: (task: LaunchCandidate, slot: ResolvedSlot) => Promise<void> | void;
  /** Surface concurrency check — return false to skip the task. */
  concurrencyOK?: (surface: string | undefined) => boolean;
  /** Admission check before taking a resource reservation or launching. */
  admit?: (task: LaunchCandidate) => Promise<string | undefined> | string | undefined;
  /** D8.2 (FU8 PR #1) — observer hook fired once per evaluated task.
   *  Production wiring (NEXUS daemon) injects
   *  `createDispatchOutcomeRecorder()` so each decision flows into the
   *  D8 JSONL · MSS Signal Bus · user-intent log triplet. The launcher
   *  itself stays pure orchestration — all sinks are best-effort and
   *  errors never crash the tick. */
  recordOutcome?: (record: DispatchRunRecord) => void;
  /** Sleep-window status snapshot at decision time. Optional — when
   *  omitted, `axes.inSleepWindow` is reported as `false`. */
  inSleepWindow?: () => boolean;
  /** Per-tick cap; safety guard against runaway launches. Default 8. */
  perTickCap?: number;
  /** Tick interval (ms). Default 1000. */
  intervalMs?: number;
  /** Optional caller-owned interval observer; defaults to tick(). */
  onTick?: () => Promise<unknown>;
}

export interface OpportunisticLauncherOptions extends LauncherDeps {}

// ──────────────────── Launcher ─────────────────────────────────────────

export class OpportunisticLauncher {
  private readonly deps: LauncherDeps;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(opts: OpportunisticLauncherOptions) {
    this.deps = opts;
  }

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? 1000;
    this.timer = setInterval(() => {
      void (this.deps.onTick ? this.deps.onTick() : this.tick());
    }, interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Run one round of the tick loop. Exposed for tests + D7 wake events.
   * Re-entry safe (`running` flag), so an overlapping tick is a no-op.
   */
  async tick(): Promise<LaunchOutcome[]> {
    if (this.running) return [];
    this.running = true;
    const outcomes: LaunchOutcome[] = [];
    try {
      const slot = this.deps.slot();
      const cap = Math.max(1, this.deps.perTickCap ?? 8);
      const raw = await this.deps.readyTasks();
      const queued = raw
        .filter((t) => t.ready)
        .sort((a, b) => a.priorityRank - b.priorityRank);
      let launched = 0;
      for (const task of queued) {
        if (launched >= cap) break;
        const decision = await this.evaluate(task, slot);
        outcomes.push(decision);
        if (decision.ok) launched += 1;
      }
    } finally {
      this.running = false;
    }
    return outcomes;
  }

  // ──────────────── 4-axes check ───────────────────────────────

  private async evaluate(task: LaunchCandidate, slot: ResolvedSlot): Promise<LaunchOutcome> {
    // Time / slot policy
    const slotReason = this.slotReason(task, slot);
    if (slotReason) {
      const outcome: LaunchOutcome = { ok: false, taskId: task.id, reason: slotReason };
      this.recordOutcome(task, slot, outcome, 'deferred');
      return outcome;
    }

    // Concurrency
    if (this.deps.concurrencyOK && !this.deps.concurrencyOK(task.surface)) {
      const outcome: LaunchOutcome = { ok: false, taskId: task.id, reason: 'concurrency-cap' };
      this.recordOutcome(task, slot, outcome, 'rejected');
      return outcome;
    }

    // Admission (budget and other caller-owned gates).
    if (this.deps.admit) {
      try {
        const reason = await this.deps.admit(task);
        if (reason) {
          const outcome: LaunchOutcome = { ok: false, taskId: task.id, reason };
          this.recordOutcome(task, slot, outcome, 'rejected');
          return outcome;
        }
      } catch (err) {
        const outcome: LaunchOutcome = {
          ok: false, taskId: task.id,
          reason: `admission-error:${err instanceof Error ? err.message : String(err)}`,
        };
        this.recordOutcome(task, slot, outcome, 'errored');
        return outcome;
      }
    }

    // Resource
    let reservation: ReservationOutcome | undefined;
    if (task.capabilities && task.capabilities.length > 0) {
      const req: TaskResourceRequirement = {
        taskId: task.id,
        capabilities: task.capabilities,
      };
      if (task.apiFallbackAllowed !== undefined) req.apiFallbackAllowed = task.apiFallbackAllowed;
      reservation = this.deps.scheduler.tryReserve(req);
      if (!reservation.ok) {
        const reason = `resource:${reservation.reason}`;
        const outcome: LaunchOutcome = { ok: false, taskId: task.id, reason, reservation };
        this.recordOutcome(task, slot, outcome, 'rejected', reservation);
        return outcome;
      }
    }

    try {
      await this.deps.launch(task, slot);
      const out: LaunchOutcome = { ok: true, taskId: task.id };
      if (reservation) out.reservation = reservation;
      this.recordOutcome(task, slot, out, 'launched', reservation);
      return out;
    } catch (err) {
      // Release any reservation we just took.
      if (reservation && reservation.ok) this.deps.scheduler.release(task.id);
      const outcome: LaunchOutcome = {
        ok: false,
        taskId: task.id,
        reason: `launch-threw:${err instanceof Error ? err.message : String(err)}`,
      };
      this.recordOutcome(task, slot, outcome, 'errored', reservation);
      return outcome;
    }
  }

  /** Fire the D8.2 observer hook. Best-effort — any sink failure is
   *  swallowed so the launcher tick keeps moving. Production wires
   *  `recordOutcome` to the 3-sink fan-out from `dispatch-emit.ts`. */
  private recordOutcome(
    task: LaunchCandidate,
    slot: ResolvedSlot,
    outcome: LaunchOutcome,
    kind: DispatchRunRecord['outcome'],
    reservation?: ReservationOutcome,
  ): void {
    if (!this.deps.recordOutcome) return;
    const record: DispatchRunRecord = {
      at: new Date().toISOString(),
      taskId: task.id,
      outcome: kind,
      reason: outcome.reason ?? 'ok',
      axes: {
        inSleepWindow: this.deps.inSleepWindow?.() ?? false,
        idle: this.deps.idle ? this.deps.idle.isIdle() : true,
        resourceOk: !reservation || reservation.ok,
        priorityBoosted: false,
      },
      slotId: slot.kind,
    };
    if (reservation && reservation.ok) {
      record.resourceKind = reservation.kind;
    } else if (task.capabilities && task.capabilities.length > 0) {
      record.resourceKind = task.capabilities[0];
    }
    try { this.deps.recordOutcome(record); } catch { /* best-effort */ }
  }

  // ──────────────── slot reasoner ──────────────────────────────

  private slotReason(task: LaunchCandidate, slot: ResolvedSlot): string | undefined {
    // Preferred slot mismatch
    if (task.preferredSlot && task.preferredSlot !== slot.kind) {
      return `slot-mismatch:${slot.kind}!=preferred:${task.preferredSlot}`;
    }
    // Idle requirement (when caller asks for `preferredSlot: 'idle'` and we
    // do have an idle detector, ensure the user really is idle).
    if (task.preferredSlot === 'idle' && this.deps.idle && !this.deps.idle.isIdle()) {
      return 'not-idle';
    }
    // Slot-specific policy
    const p = slot.policy;
    if (task.noisy && p.noisyTasks === 'deny') return 'slot:noisyTasks=deny';
    if (task.longRunning && p.longRunning === 'deny') return 'slot:longRunning=deny';
    return undefined;
  }
}
