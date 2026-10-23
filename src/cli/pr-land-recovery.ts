import { classifyPrLandRefusal } from './pr-land-refusal.js';
import { readJourneyEdge, recordJourneyEdge } from '../self-dev/graph-journey-route.js';
import { GRAPH_SPECS } from '../self-implement/graph-templates.js';
import { debug } from '../debug/log.js';

/** The task card that launched this `pr land` (TA `defaultLand` sets it). Observation only. */
export const PR_LAND_CARD_ID_ENV = 'ELANOUS_PR_LAND_CARD_ID';

/** A recover unit selects a next action. The train or TA still owns every effect. */
export interface PrLandRecoveryContext {
  refusal: string;
  pr?: number;
  head?: string;
  isDraft?: boolean;
}

export interface PrLandRecoveryPlan {
  outcome: 'rework' | 'needs-human' | 'failed';
  result: { action: 'wait-retry' | 'request-review' | 'needs-human' | 'none'; pr?: number; head?: string; delayMs?: number; reason: string };
  evidence: { refusal: string; label: string; route: string | null; source: string };
}

export function planPrLandRecovery(context: PrLandRecoveryContext): PrLandRecoveryPlan {
  const raw = typeof context.refusal === 'string' ? context.refusal : '';
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // Callers must extract exactly one refusal line. A second diagnostic may be
  // unmarked (for example `error: review-missing`), so never select a line
  // from a larger transcript and mistake it for the whole verdict.
  const refusal = lines.length === 1 ? lines[0]! : raw.trim();
  const label = classifyPrLandRefusal(refusal, { isDraft: context.isDraft });
  const route = readJourneyEdge('merge', label);
  const evidence = { refusal: refusal.slice(0, 500), label, route: route.to, source: route.source };
  const pr = Number.isSafeInteger(context.pr) && context.pr! > 0 ? context.pr : undefined;
  const head = typeof context.head === 'string' && /^[0-9a-f]{40}$/i.test(context.head) ? context.head.toLowerCase() : undefined;
  if (!refusal || !pr || !head) return { outcome: 'failed', result: { action: 'none', reason: 'pinned PR, head and refusal are required' }, evidence };
  if (lines.length !== 1 || !refusal.startsWith('✗')) return { outcome: 'needs-human', result: { action: 'needs-human', pr, head, reason: `expected one marked refusal line, observed ${lines.length} nonempty lines` }, evidence };
  if (route.source !== 'graph') return { outcome: 'needs-human', result: { action: 'needs-human', pr, head, reason: 'refusal has no declared graph route' }, evidence };
  if (label === 'gate-host-busy' && route.to === 'next-move') {
    return { outcome: 'rework', result: { action: 'wait-retry', pr, head, delayMs: 30_000, reason: 'remote gate host busy; retry through existing admission after delay' }, evidence };
  }
  if (label === 'review-missing' && route.to === 'review') {
    return { outcome: 'rework', result: { action: 'request-review', pr, head, reason: 'request exact-head review through existing review gate' }, evidence };
  }
  return { outcome: 'needs-human', result: { action: 'needs-human', pr, head, reason: `${label} requires the existing ${route.to ?? 'unknown'} admission before another landing` }, evidence };
}

/** A graph call_entry cannot turn one refusal into another action. */
export function planPrLandRecoveryForEntry(context: PrLandRecoveryContext, entry: string): PrLandRecoveryPlan {
  const plan = planPrLandRecovery(context);
  // The default entry keeps the original read-only planner contract.
  if (entry === 'plan') return plan;
  if (entry === 'human-review') {
    if (plan.outcome === 'needs-human' && plan.result.action === 'needs-human') return plan;
    return { outcome: 'failed', result: { action: 'none', reason: `recover entry ${entry} does not match ${plan.result.action}` }, evidence: plan.evidence };
  }
  if (entry === 'request-review' || entry === 'wait-retry') {
    if (plan.outcome === 'rework' && plan.result.action === entry) return plan;
    return {
      outcome: 'failed',
      result: { action: 'none', reason: `recover entry ${entry} does not match ${plan.result.action}` },
      evidence: plan.evidence,
    };
  }
  return {
    outcome: 'failed',
    result: { action: 'none', reason: `unknown recover entry: ${entry}` },
    evidence: plan.evidence,
  };
}

/** LAND-REFUSAL-EDGES — bind one observed landing refusal to the declared recover@1 edge.
 *  The row carries the raw refusal, card, PR, head and the read-only plan. It never retries,
 *  merges or requests anything: `execution: 'none'` and `mergeSha: null` are part of the row. */
export function bindPrLandRefusalToRecover(context: PrLandRecoveryContext & { cardId?: string }): PrLandRecoveryPlan {
  const plan = planPrLandRecovery(context);
  try {
    if (!plan.result.pr || !plan.result.head) return plan;
    const route = readJourneyEdge('merge', 'land-refused');
    const node = route.to ? GRAPH_SPECS['self-implement']?.nodes.find((n) => n.nodeId === route.to) : undefined;
    const call = node?.kind === 'subgraph' ? node.call ?? null : null;
    const cardId = typeof context.cardId === 'string' && context.cardId.trim() ? context.cardId.trim() : null;
    const reason = 'pr-land-refused; recover@1 bound; recovery-execution=none';
    // Only a declared recover@1 subgraph is a binding. A fallback edge (e.g. merge → cleanup) is not.
    if (route.source !== 'graph' || route.on !== 'recovery' || call !== 'recover@1') {
      debug.log('self-implement', 'graph-edge-unresolved', { from: 'merge', label: 'land-refused', to: route.to, call, reason });
      return plan;
    }
    recordJourneyEdge(route, route.to!, reason, {
      call, execution: 'none', mergeSha: null,
      evidence: { cardId, pr: plan.result.pr, head: plan.result.head, refusal: plan.evidence.refusal,
        refusalLabel: plan.evidence.label, refusalRoute: plan.evidence.route },
      recover: { outcome: plan.outcome, action: plan.result.action, reason: plan.result.reason, delayMs: plan.result.delayMs ?? null },
    });
  } catch { /* Observation must never replace the landing refusal. */ }
  return plan;
}

type RecoverRun = { runId?: string; status?: string; path?: readonly string[]; nodes?: ReadonlyArray<{ nodeId?: string; output?: unknown }> };
export interface PrLandRecoveryExecution {
  /** The plan the caller may act on. An untrusted or failed run is replaced by a needs-human plan. */
  plan: PrLandRecoveryPlan;
  /** True only when the declared recover@1 binding existed and the unit was run. */
  executed: boolean;
}

/** LAND-REFUSAL-EXEC — bind one refusal (row `execution: 'none'`), then run the existing recover@1 unit
 *  (graphs/units/recover.yaml · read-only `cmd:recover-plan`) for one step to the terminal the unit selects,
 *  and record that run on the same edge keys with `execution: 'graph-run'`. A run that does not reproduce the
 *  pinned plan fails closed to `needs-human`. It still never retries, requests, merges or enqueues. */
/** recover@1 한 단계 실행의 시간 한도 — 운영 TA 착지 틱이 매달린 유닛에 붙잡히지 않게(넘으면 fail-closed needs-human). */
export const PR_LAND_RECOVER_TIMEOUT_MS = 60_000;

export async function executeBoundPrLandRecover(
  context: PrLandRecoveryContext & { cardId?: string },
  deps: { root?: string; timeoutMs?: number; runGraph?: (path: string, options: { input: unknown; quiet?: boolean; pinChildUniverse?: boolean; deps?: { root?: string } }) => Promise<RecoverRun> } = {},
): Promise<PrLandRecoveryExecution> {
  const plan = bindPrLandRefusalToRecover(context);
  let route: ReturnType<typeof readJourneyEdge>;
  let call: string | null;
  try {
    route = readJourneyEdge('merge', 'land-refused');
    const node = route.to ? GRAPH_SPECS['self-implement']?.nodes.find((n) => n.nodeId === route.to) : undefined;
    call = node?.kind === 'subgraph' ? node.call ?? null : null;
  } catch { return { plan, executed: false }; }
  // Same admission as the binding: pinned identity and a declared recover@1 subgraph edge.
  if (!plan.result.pr || !plan.result.head || route.source !== 'graph' || route.on !== 'recovery' || call !== 'recover@1') return { plan, executed: false };
  const cardId = typeof context.cardId === 'string' && context.cardId.trim() ? context.cardId.trim() : null;
  const unitContext = { refusal: context.refusal, pr: plan.result.pr, head: plan.result.head, ...(context.isDraft === undefined ? {} : { isDraft: context.isDraft }) };
  let run: RecoverRun | undefined;
  let error: string | undefined;
  try {
    const runGraph = deps.runGraph ?? (await import('../graph-runner/runner.js')).runGraph;
    const { fileURLToPath } = await import('node:url');
    const limitMs = deps.timeoutMs ?? PR_LAND_RECOVER_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`recover@1 timeout after ${limitMs}ms`)), limitMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      run = await Promise.race([runGraph(fileURLToPath(new URL('../../graphs/units/recover.yaml', import.meta.url)), {
        input: { ask: `pr land refusal for PR #${plan.result.pr}`, context: unitContext, prior: null },
        quiet: true, pinChildUniverse: true, ...(deps.root ? { deps: { root: deps.root } } : {}),
      }), timeout]);
    } finally { if (timer) clearTimeout(timer); }
  } catch (cause) { error = String(cause).slice(0, 300); run = undefined; }
  const exit = run?.path?.at(-1) ?? null;
  let output: Partial<PrLandRecoveryPlan> | undefined;
  try {
    const raw = run?.nodes?.find((n) => n.nodeId === 'plan')?.output;
    const lines = typeof raw === 'string' ? raw.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    output = lines.length ? JSON.parse(lines.at(-1)!) as Partial<PrLandRecoveryPlan> : undefined;
  } catch { output = undefined; }
  // Trust only a run that reproduces the pinned plan and ends in the terminal the plan names.
  const trusted = !error && !!output && output.outcome === plan.outcome && exit === plan.outcome
    && output.result?.action === plan.result.action && output.result?.pr === plan.result.pr
    && output.result?.head === plan.result.head && (output.result?.delayMs ?? null) === (plan.result.delayMs ?? null)
    && output.evidence?.refusal === plan.evidence.refusal;
  const executed: PrLandRecoveryPlan = trusted ? plan : {
    outcome: 'needs-human',
    result: { action: 'needs-human', pr: plan.result.pr, head: plan.result.head,
      reason: `recover@1 execution untrusted (${error ?? `status ${run?.status ?? 'none'} exit ${exit ?? 'none'}`}); hand to a human` },
    evidence: plan.evidence,
  };
  try {
    recordJourneyEdge(route, route.to!, 'pr-land-refused; recover@1 executed; recovery-execution=graph-run', {
      call, execution: 'graph-run', mergeSha: null,
      evidence: { cardId, pr: plan.result.pr, head: plan.result.head, refusal: plan.evidence.refusal,
        refusalLabel: plan.evidence.label, refusalRoute: plan.evidence.route },
      recover: { outcome: executed.outcome, action: executed.result.action, reason: executed.result.reason, delayMs: executed.result.delayMs ?? null },
      run: { runId: run?.runId ?? null, status: run?.status ?? null, path: run?.path ?? [], exit, trusted, ...(error ? { error } : {}) },
    });
    // A human owns every needs-human/failed exit — say so at warn level, with the same join keys.
    if (executed.outcome !== 'rework') debug.log('pr.land', 'recover-needs-human', {
      cardId, pr: plan.result.pr, head: plan.result.head, outcome: executed.outcome, reason: executed.result.reason, runId: run?.runId ?? null,
    }, { level: 'warn' });
  } catch { /* Observation must never replace the landing refusal. */ }
  // «실행했다» 는 유닛이 실제로 돌아 런을 냈을 때만 — 예외·시간 초과는 결속만 남고 실행 0.
  return { plan: executed, executed: run !== undefined };
}
