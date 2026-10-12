import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { debug } from '../debug/log.js';
import { extractVerbatimOriginalAsk } from '../self-implement/goal-author.js';
import { loadRunLedger } from '../self-implement/run-ledger.js';
import { queryRunningRuns, type QueriedRunningRunsResult } from '../self-implement/running-runs.js';
import { CODEX_PROVIDER, GROK_PROVIDER, decideLaunchBudget, type BudgetAction, type BudgetDecision, type BudgetInputs } from '../self-implement/budget-gate.js';
import { DEFAULT_FALLBACK_CHAIN } from '../oauth/fallback-chain.js';

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

const LAUNCH_BUDGET_PROVIDER: Readonly<Record<string, string>> = { 'codex-rotate': CODEX_PROVIDER, grok: GROK_PROVIDER };

/**
 * L6 발사 관문의 예산 입력 보정 — 발사 우주의 config 에 체인이 없으면(작업 트리 = 시험 우주) 막지 않고
 * 코드 기본 체인으로 판단한다. `--child-llm-provider` 를 명시했으면 그것이 체인이다(예산 판정 밖 provider 는 통과).
 */
export function harnessLaunchBudgetDecision(
  inputs: BudgetInputs,
  opts: { readonly childLlmProvider?: string; readonly childLlmModel?: string } = {},
): { readonly decision: BudgetDecision; readonly warning?: string; readonly unmeasuredProvider?: string } {
  const explicit = opts.childLlmProvider?.trim();
  const judged = (selected: BudgetInputs) => {
    const { decision, unmeasuredProvider } = decideLaunchBudget(selected);
    return { decision, ...(unmeasuredProvider ? { unmeasuredProvider, warning: `budget: ${unmeasuredProvider} usage unmeasured — launching` } : {}) };
  };
  if (explicit) {
    if (explicit !== CODEX_PROVIDER && explicit !== GROK_PROVIDER) {
      return {
        decision: { action: 'proceed', provider: explicit, ...(opts.childLlmModel ? { model: opts.childLlmModel } : {}), reasons: [`${explicit}: 명시 provider — 예산 판정 밖`] },
        warning: `budget: ${explicit} is outside the budget gate — launched as requested`,
      };
    }
    const chain = [{ provider: explicit, ...(opts.childLlmModel ? { model: opts.childLlmModel } : {}) }];
    return judged({ ...inputs, preference: { ...inputs.preference, chain } });
  }
  if (inputs.preference.chain.length > 0) return judged(inputs);
  const chain = DEFAULT_FALLBACK_CHAIN.map((step) => ({ provider: LAUNCH_BUDGET_PROVIDER[step] ?? step }));
  const result = judged({ ...inputs, preference: { ...inputs.preference, chain } });
  return {
    ...result,
    warning: `budget: no chain in this universe's config — judged with the code default ${DEFAULT_FALLBACK_CHAIN.join(',')}${result.warning ? ` · ${result.warning}` : ''}`,
  };
}

/** Parent → Pod budget snapshot env. Numbers and names only — never a credential, never free-text reasons. */
export const BUDGET_SNAPSHOT_ENV = 'ELANOUS_BUDGET_SNAPSHOT';
export const BUDGET_SNAPSHOT_MAX_AGE_SEC = 15 * 60;
// Host and Pod clocks may differ slightly even when the Job carries a freshly measured verdict.
const BUDGET_SNAPSHOT_CLOCK_SKEW_SEC = 30;

/** The verdict the host's launch gate reached (chain ⊕ the user's caps) — the Pod follows it instead of judging again. */
export interface HostBudgetVerdict {
  action: BudgetAction;
  provider?: string;
  model?: string;
}

export interface BudgetSnapshot {
  /** The provider the host verdict picked, or the one asked for when nothing was picked. */
  provider: string;
  /** Percent of that provider's window still unspent (0–100) — observation only; absent when the host could not measure it. */
  remaining?: number;
  window: string;
  /** Epoch milliseconds on the measuring host. */
  measuredAt: number;
  host: string;
  /** The explicit child provider the host judged for (`--child-llm-provider`). Absent = the host's configured chain. */
  requested?: string;
  /** The host launch-gate verdict. Absent = the host reached none, and the Pod treats the budget as unmeasured. */
  decision?: HostBudgetVerdict;
}

export type BudgetSource = 'snapshot' | 'local' | 'unmeasured';

export interface ResolvedLaunchBudget {
  budget: BudgetDecision | 'unknown';
  budgetSource: BudgetSource;
  snapshotAgeSec?: number;
}

const BUDGET_ACTIONS: readonly BudgetAction[] = ['proceed', 'next-provider', 'wait-reset', 'stop'];

function canonicalBudgetProvider(name: string): string {
  const id = name.trim();
  return id === 'codex' || id === 'codex-rotate' ? 'openai-codex' : id;
}

function pickVerdict(value: unknown): HostBudgetVerdict | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { action, provider, model } = value as Record<string, unknown>;
  if (typeof action !== 'string' || !(BUDGET_ACTIONS as readonly string[]).includes(action)) return undefined;
  if (provider !== undefined && (typeof provider !== 'string' || !provider.trim())) return undefined;
  if (model !== undefined && typeof model !== 'string') return undefined;
  return { action: action as BudgetAction, ...(provider ? { provider: canonicalBudgetProvider(provider) } : {}), ...(model ? { model } : {}) };
}

export function encodeBudgetSnapshot(snapshot: BudgetSnapshot): string {
  const { provider, remaining, window, measuredAt, host, requested, decision } = snapshot;
  const verdict = pickVerdict(decision);
  return JSON.stringify({
    provider: canonicalBudgetProvider(provider),
    ...(typeof remaining === 'number' && Number.isFinite(remaining) ? { remaining } : {}),
    window, measuredAt, host,
    ...(requested?.trim() ? { requested: canonicalBudgetProvider(requested) } : {}),
    ...(verdict ? { decision: verdict } : {}),
  });
}

function parseBudgetSnapshot(raw: string | undefined): BudgetSnapshot | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== 'object') return undefined;
    const { provider, remaining, window, measuredAt, host, requested, decision } = value;
    if (typeof provider !== 'string' || !provider.trim() || typeof window !== 'string' || typeof host !== 'string') return undefined;
    if (remaining !== undefined && (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 || remaining > 100)) return undefined;
    if (typeof measuredAt !== 'number' || !Number.isFinite(measuredAt)) return undefined;
    if (requested !== undefined && (typeof requested !== 'string' || !requested.trim())) return undefined;
    const verdict = decision === undefined ? undefined : pickVerdict(decision);
    if (decision !== undefined && !verdict) return undefined;
    return {
      provider: canonicalBudgetProvider(provider), ...(remaining !== undefined ? { remaining } : {}), window, measuredAt, host,
      ...(requested ? { requested: canonicalBudgetProvider(requested) } : {}), ...(verdict ? { decision: verdict } : {}),
    };
  } catch { return undefined; }
}

/** The host's verdict as the Pod's decision — never re-judged with one provider or code-constant caps. */
function decisionFromSnapshot(snapshot: BudgetSnapshot, verdict: HostBudgetVerdict, ageSec: number): BudgetDecision {
  const target = verdict.provider ? ` → ${verdict.provider}` : '';
  const used = snapshot.remaining === undefined ? '' : ` · ${snapshot.provider} ${Math.round((100 - snapshot.remaining) * 100) / 100}% used (${snapshot.window})`;
  return {
    action: verdict.action,
    ...(verdict.provider ? { provider: verdict.provider } : {}),
    ...(verdict.model ? { model: verdict.model } : {}),
    reasons: [`host ${snapshot.host} verdict ${verdict.action}${target}${used} · ${ageSec}s ago`],
  };
}

export interface ResolveLaunchBudgetDeps {
  env?: Readonly<Record<string, string | undefined>> | undefined;
  now?: () => number;
  /** The provider this launch will use, when named explicitly. */
  provider?: string | undefined;
  /** Host-side measurement. Never called inside a Pod. */
  measureLocal: () => Promise<BudgetDecision | 'unknown'>;
}

/** A Pod has no subscription credential or usage cache, so it follows the parent's verdict ⊕ its age and never measures. */
export async function resolveLaunchBudget(deps: ResolveLaunchBudgetDeps): Promise<ResolvedLaunchBudget> {
  const env = deps.env ?? process.env;
  if (env.ELANOUS_SUBSTRATE !== 'pod') return { budget: await deps.measureLocal(), budgetSource: 'local' };
  const snapshot = parseBudgetSnapshot(env[BUDGET_SNAPSHOT_ENV]);
  if (!snapshot) return { budget: 'unknown', budgetSource: 'unmeasured' };
  const ageSec = Math.round(((deps.now ?? Date.now)() - snapshot.measuredAt) / 1000);
  const requested = deps.provider?.trim() ? canonicalBudgetProvider(deps.provider) : undefined;
  // The verdict holds only for the question the host answered: the same explicit provider, or both on the configured chain.
  if (!snapshot.decision || ageSec < -BUDGET_SNAPSHOT_CLOCK_SKEW_SEC || ageSec > BUDGET_SNAPSHOT_MAX_AGE_SEC || requested !== snapshot.requested) {
    return { budget: 'unknown', budgetSource: 'unmeasured', snapshotAgeSec: ageSec };
  }
  return { budget: decisionFromSnapshot(snapshot, snapshot.decision, Math.max(0, ageSec)), budgetSource: 'snapshot', snapshotAgeSec: ageSec };
}

export interface PreLaunchGateInput {
  goalId: string;
  budget?: BudgetDecision | 'unknown';
  budgetSource?: BudgetSource;
  snapshotAgeSec?: number;
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
  debug.log('execution-loop.launch-gate', 'decision', { goalId: input.goalId, action: decision.action, sameGoalActiveRuns: decision.sameGoalActiveRuns, budget: decision.budget === 'unknown' ? 'unknown' : decision.budget.action, forceLaunch: input.forceLaunch === true, reason: decision.reason, ...(input.budgetSource ? { budgetSource: input.budgetSource } : {}), ...(input.snapshotAgeSec !== undefined ? { snapshotAgeSec: input.snapshotAgeSec } : {}) });
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
