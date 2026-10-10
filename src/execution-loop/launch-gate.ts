import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { debug } from '../debug/log.js';
import { extractVerbatimOriginalAsk } from '../self-implement/goal-author.js';
import { loadRunLedger } from '../self-implement/run-ledger.js';
import { queryRunningRuns, type QueriedRunningRunsResult } from '../self-implement/running-runs.js';
import type { BudgetDecision } from '../self-implement/budget-gate.js';

export type ActiveRunsForGoal = readonly string[] | 'unknown';

/** Match an un-authored CLI request to the verbatim ask recorded in an authored run. */
export function launchRequestId(text: string): string {
  return `request-${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
}

export interface ActiveRunsForGoalDeps {
  queryRuns?: () => QueriedRunningRunsResult;
  loadLedger?: typeof loadRunLedger;
  readGoalDocument?: (path: string) => string;
}

/** Only a live process with an exact goal ID or verbatim authored ask is a duplicate. Incomplete observation is not absence. */
export function activeRunsForGoal(goalId: string, deps: ActiveRunsForGoalDeps = {}): ActiveRunsForGoal {
  try {
    const observation = (deps.queryRuns ?? (() => queryRunningRuns({ includeTest: true, caller: 'execution-loop.launch-gate' })))();
    const loadLedger = deps.loadLedger ?? loadRunLedger;
    const readGoalDocument = deps.readGoalDocument ?? ((path: string) => readFileSync(path, 'utf8'));
    let unknown = observation.completeness !== 'complete' || observation.pty.unreadable.length > 0;
    const unknownReasons = new Set<string>();
    if (observation.completeness !== 'complete') unknownReasons.add(`ledger observation ${observation.completeness}`);
    for (const root of observation.pty.unreadable) unknownReasons.add(`unreadable PTY: ${root}`);
    const active = new Set<string>();
    let skippedTerminal = 0;
    for (const run of observation.entries) {
      if (run.status === 'ended-unclosed') { skippedTerminal += 1; continue; }
      const hasObservedPty = run.ptyRefs.length > 0;
      const live = run.status === 'running' && hasObservedPty;
      if (run.ledgerDirectories.length === 0) {
        if (hasObservedPty) { unknown = true; unknownReasons.add(`${run.runId}: ledger directory absent`); }
        else skippedTerminal += 1;
        continue;
      }
      let identified = false;
      for (const directory of run.ledgerDirectories) {
        try {
          const ledger = loadLedger(run.runId, directory);
          if (ledger === null) {
            if (hasObservedPty) { unknown = true; unknownReasons.add(`${run.runId}: ledger unavailable`); }
            continue;
          }
          const ids = new Set(ledger.flatMap((entry) => entry.goalId ? [entry.goalId] : []));
          if (ids.size !== 1) {
            if (hasObservedPty) { unknown = true; unknownReasons.add(`${run.runId}: expected one goalId, found ${ids.size}`); }
            continue;
          }
          identified = true;
          let matches = ids.has(goalId);
          if (!matches && goalId.startsWith('request-') && live) {
            const document = ledger.find((entry) => entry.event === 'start')?.data.goalFile;
            if (typeof document === 'string') {
              try {
                const ask = extractVerbatimOriginalAsk(readGoalDocument(document));
                matches = ask?.range !== undefined && launchRequestId(ask.ask) === goalId;
              } catch { unknown = true; unknownReasons.add(`${run.runId}: goal document unreadable`); }
            }
          }
          if (matches) {
            if (live) active.add(run.runId);
            else { unknown = true; unknownReasons.add(`${run.runId}: matching ledger without live PTY`); }
          }
        } catch {
          if (hasObservedPty) { unknown = true; unknownReasons.add(`${run.runId}: ledger read failed`); }
        }
      }
      if (!identified && !hasObservedPty) skippedTerminal += 1;
    }
    // Positive evidence wins even if a different process or store is unreadable.
    const result: ActiveRunsForGoal = active.size > 0 ? [...active].sort() : unknown ? 'unknown' : [];
    try {
      debug.log('execution-loop.launch-gate', 'active-runs-result', { goalId, result, skippedTerminal });
      if (result === 'unknown') debug.log('execution-loop.launch-gate', 'active-runs-unknown', { goalId, reasons: [...unknownReasons], skippedTerminal });
    } catch { /* observation is fail-soft */ }
    return result;
  } catch (error) {
    try { debug.log('execution-loop.launch-gate', 'active-runs-unknown', { goalId, reasons: [error instanceof Error ? error.message : String(error)] }); } catch { /* observation is fail-soft */ }
    return 'unknown';
  }
}

export interface PreLaunchGateInput {
  goalId: string;
  budget?: BudgetDecision | 'unknown';
  forceLaunch?: boolean;
}

export interface PreLaunchGateDeps extends ActiveRunsForGoalDeps {
  activeRuns?: (goalId: string) => ActiveRunsForGoal;
}

export interface PreLaunchGateDecision {
  action: 'proceed' | 'blocked-duplicate' | 'blocked-budget' | 'wait-reset';
  sameGoalActiveRuns: ActiveRunsForGoal;
  budget: BudgetDecision | 'unknown';
  reason: string;
}

/** Force bypasses only a duplicate observation, never an exhausted budget. */
export function preLaunchGate(input: PreLaunchGateInput, deps: PreLaunchGateDeps = {}): PreLaunchGateDecision {
  const decision = decidePreLaunch(input, deps);
  debug.log('execution-loop.launch-gate', 'decision', { goalId: input.goalId, action: decision.action, sameGoalActiveRuns: decision.sameGoalActiveRuns, budget: decision.budget === 'unknown' ? 'unknown' : decision.budget.action, forceLaunch: input.forceLaunch === true, reason: decision.reason });
  return decision;
}

function decidePreLaunch(input: PreLaunchGateInput, deps: PreLaunchGateDeps): PreLaunchGateDecision {
  const sameGoalActiveRuns = (deps.activeRuns ?? ((goalId) => activeRunsForGoal(goalId, deps)))(input.goalId);
  const budget = input.budget ?? 'unknown';
  if (budget !== 'unknown' && (budget.action === 'stop' || budget.action === 'wait-reset')) {
    return { action: budget.action === 'stop' ? 'blocked-budget' : 'wait-reset', sameGoalActiveRuns, budget, reason: budget.reasons.join(' · ') || `budget: ${budget.action}` };
  }
  if (sameGoalActiveRuns !== 'unknown' && sameGoalActiveRuns.length > 0 && !input.forceLaunch) {
    return { action: 'blocked-duplicate', sameGoalActiveRuns, budget, reason: `same-goal active runs: ${sameGoalActiveRuns.join(', ')}` };
  }
  return { action: 'proceed', sameGoalActiveRuns, budget, reason: sameGoalActiveRuns === 'unknown' ? 'active runs unknown' : input.forceLaunch && sameGoalActiveRuns.length > 0 ? 'duplicate overridden by force-launch' : 'no confirmed duplicate' };
}
