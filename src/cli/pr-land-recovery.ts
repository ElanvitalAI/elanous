import { classifyPrLandRefusal } from './pr-land-refusal.js';
import { readJourneyEdge } from '../self-dev/graph-journey-route.js';

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
