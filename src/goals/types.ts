// Goal types — Plan-Mode UX P1.1.
//
// Persistent cross-turn goal object that drives the Ralph loop
// (Hermes/Codex `/goal` lineage). A goal lives across multiple LLM
// turns — the Judge Loop (Mode A) auto-continues until the goal-judge
// reports `done` or the user preempts. Plan mode pause-on-enter is
// honored by GoalRegistry callers (P2 follow-up).
//
// State machine:
//
//   inactive ── /goal <obj> ──► active ──┬─► continue (auto-turn)
//                                        ├─► done (judge) → complete
//                                        ├─► budget exhausted → budget-limited
//                                        └─► pause (user / plan-mode entry) → paused
//   paused ── /goal resume ──► active
//   any    ── /goal clear ──► (registry: dropped, history kept)

/** Discriminated state — `inactive` is implicit (no goal in registry). */
export type GoalStatus =
  | 'active'
  | 'paused'
  /** A user correction has been accepted and must be driven into the next turn. */
  | 'resume_required'
  | 'budget-limited'
  | 'complete';

/** Runtime counterpart of GoalStatus for validating durable ledger data. */
export function isGoalStatus(value: unknown): value is GoalStatus {
  if (typeof value !== 'string') return false;
  const status = value as GoalStatus;
  switch (status) {
    case 'active':
    case 'paused':
    case 'resume_required':
    case 'budget-limited':
    case 'complete':
      return true;
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return false;
    }
  }
}

/** Mode A (Hermes ralph) is P1 default. Mode B (Ouroboros spec) is P3. */
export type GoalMode = 'judge' | 'spec';

/** Judge verdict shape — `goal-judge` runtime returns one of these
 *  per auto-turn. `empty` triggers a single retry then PAUSE+ASK
 *  (CLAUDE.md fail-safe — drift over confirm is unsafe). */
export type GoalJudgeVerdict = 'done' | 'continue' | 'partial' | 'empty';

export interface GoalBudget {
  /** Max auto-turns before the loop forces a pause. Hermes default 20. */
  maxTurns: number;
  /** Wall-clock cap (ms). 30 min default. */
  wallClockMaxMs: number;
  /** Token budget. Optional — when 0, no token cap. */
  tokenBudget: number;
}

export type GoalTokenMeasurement = 'measured' | 'unmeasured';

export interface GoalUsage {
  /** Auto-turns the loop has driven so far (excludes user-initiated turns). */
  turnsUsed: number;
  /** Sum of approximate tokens billed across auto-turns. */
  tokensUsed: number;
  /** Whether every recorded auto-turn supplied a token measurement. */
  tokensMeasured: boolean;
  /** Wall-clock since this activation began (`activeSince`, falling back to
   *  `createdAt` for old snapshots), refreshed on read. */
  elapsedMs: number;
}

export type GoalBudgetAxis = 'maxTurns' | 'wallClockMaxMs' | 'tokenBudget';

export interface GoalBudgetExceededAxis {
  axis: GoalBudgetAxis;
  used: number;
  limit: number;
}

export interface GoalBudgetDiagnostics {
  isOverBudget: boolean;
  exceededAxes: GoalBudgetExceededAxis[];
  tokenMeasurement: GoalTokenMeasurement;
}

export interface Goal {
  /** Short ULID-ish id — stamped at create time. */
  id: string;
  /** User-supplied free-text objective. */
  objective: string;
  /** Mode A (judge loop) is P1 default; Mode B is P3 (Ouroboros). */
  mode: GoalMode;
  status: GoalStatus;
  /** Epoch ms. */
  createdAt: number;
  /** TUI-GOAL-LOOP-FRICTION(#35) — epoch ms when the goal last entered `active`
   *  (start · resume · process restart hydrate). The wall-clock budget is measured
   *  from here, not from `createdAt`: a goal created days ago and resumed now must
   *  not report 4.9e8 ms elapsed. Optional so older snapshots still parse. */
  activeSince?: number;
  /** Last time status transitioned. */
  updatedAt: number;
  budget: GoalBudget;
  usage: GoalUsage;
  /** Optional link to a TOX task — when a goal is created from `/task` or
   *  via plan-exit `(G)oal-loop drive`, the task slug is recorded here.
   *  Not used by the loop itself; surfaces it in `/goal status`. */
  linkedTaskId?: string;
  /** Last judge verdict + summary — surfaced by `/goal status` and by
   *  the continuation prompt (so the model sees what the judge thought
   *  about its previous turn). */
  lastVerdict?: GoalJudgeVerdict;
  lastSummary?: string;
}

export interface GoalCreateInput {
  objective: string;
  mode?: GoalMode;
  budget?: Partial<GoalBudget>;
  linkedTaskId?: string;
}

/** Failure shape — handlers return `{ ok: false, error }` so callers
 *  can render to chat without throwing through the dispatcher. */
export type GoalError =
  | { code: 'GoalAlreadyActive'; message: string; activeId: string }
  | { code: 'GoalNotFound'; message: string }
  | { code: 'GoalNotActive'; message: string; activeId: string }
  | { code: 'InvalidGoal'; message: string }
  | { code: 'GoalBudgetExhausted'; message: string; turnsUsed: number; max: number }
  | { code: 'GoalPlanModeBlocked'; message: string };

/** Default budget — single source of truth, also exported via
 *  GoalsConfig.budget so user-config can override. */
export const DEFAULT_GOAL_BUDGET: GoalBudget = {
  maxTurns: 20,
  wallClockMaxMs: 30 * 60_000,
  tokenBudget: 200_000,
};
