import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import type { LaunchPlan } from './launch.js';
import type { ScheduledDecision } from './triage.js';

// Planning estimates, not invoices: one harness run per launch, one Pod-hour per run.
// No model/token or runtime telemetry is present in the shadow decision line.
const ESTIMATED_LLM_USD_PER_LAUNCH = 2;
const ESTIMATED_POD_USD_PER_LAUNCH = 1;
const CATEGORY = 'steward.readiness';
const EVENT = 'shadow-tick';

export interface ShadowTick {
  at: string;
  decisions: Array<{ issue: string; rung: ScheduledDecision['rung']; disposition: ScheduledDecision['disposition'] }>;
  actions: Array<{ issue: string; kind: 'launch' | 'hitl'; llmUsd: number; podUsd: number }>;
}

function ledgerPath(root: string): string { return join(root, 'steward', 'readiness.jsonl'); }

/** Called by the shadow schedule after its launch/HITL candidates have been selected. */
export function recordShadowTick(root: string, rows: ScheduledDecision[], plan: LaunchPlan, now: Date = new Date()): ShadowTick {
  const tick: ShadowTick = {
    at: now.toISOString(),
    decisions: rows.map(({ issue, rung, disposition }) => ({ issue, rung, disposition })),
    actions: [
      ...plan.launches.map(({ issue }) => ({ issue: issue.identifier, kind: 'launch' as const, llmUsd: ESTIMATED_LLM_USD_PER_LAUNCH, podUsd: ESTIMATED_POD_USD_PER_LAUNCH })),
      ...plan.hitl.map(({ issue }) => ({ issue: issue.identifier, kind: 'hitl' as const, llmUsd: 0, podUsd: 0 })),
    ],
  };
  appendFileSync(ledgerPath(root), `${JSON.stringify(tick)}\n`);
  return tick;
}

export interface ReadinessReport {
  since: string;
  until: string;
  ticks: number;
  judgments: number;
  distribution: Record<string, number>;
  actions: Array<ShadowTick['actions'][number] & { at: string }>;
  budgetGate: { estimatedLlmUsd: number; estimatedPodUsd: number; estimatedTotalUsd: number; basis: string; verdict: 'estimate-only' };
  hitlGate: { requiringHuman: number };
  source: { decisions: string; logs: string };
}

/** Snapshot-only reader: no CardStore, stage, config setter, logger or write-capable DB handle. */
export function stewardReadiness(root: string, sinceHours = 24, now: Date = new Date()): ReadinessReport {
  if (!Number.isFinite(sinceHours) || sinceHours <= 0) throw new Error('--since must be a positive duration such as 24h');
  const since = new Date(now.getTime() - sinceHours * 3_600_000);
  if (!Number.isFinite(since.getTime())) throw new Error('--since is out of range');
  const path = ledgerPath(root);
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    text = '';
  }
  const ticks: ShadowTick[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let parsed: ShadowTick;
    try { parsed = JSON.parse(line) as ShadowTick; }
    catch { throw new Error(`Invalid steward shadow decision line ${index + 1}`); }
    if (!parsed || typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at)) ||
      !Array.isArray(parsed.decisions) || !parsed.decisions.every(row => row && typeof row.issue === 'string' &&
        [0, 1, 2, 3, 4, 5, 'hitl'].includes(row.rung) && ['now', 'wait', 'hitl'].includes(row.disposition)) ||
      !Array.isArray(parsed.actions) || !parsed.actions.every(action => action && typeof action.issue === 'string' &&
        ['launch', 'hitl'].includes(action.kind) && Number.isFinite(action.llmUsd) && action.llmUsd >= 0 &&
        Number.isFinite(action.podUsd) && action.podUsd >= 0))
      throw new Error(`Invalid steward shadow decision line ${index + 1}`);
    const at = Date.parse(parsed.at);
    if (at >= since.getTime() && at <= now.getTime()) ticks.push(parsed);
  }
  const distribution: Record<string, number> = {};
  const actions = ticks.flatMap(tick => tick.actions.map(action => ({ at: tick.at, ...action })));
  for (const row of ticks.flatMap(tick => tick.decisions)) {
    const key = `${row.disposition} / rung ${row.rung}`;
    distribution[key] = (distribution[key] ?? 0) + 1;
  }
  const estimatedLlmUsd = actions.reduce((sum, action) => sum + action.llmUsd, 0);
  const estimatedPodUsd = actions.reduce((sum, action) => sum + action.podUsd, 0);
  return {
    since: since.toISOString(), until: now.toISOString(), ticks: ticks.length,
    judgments: ticks.reduce((sum, tick) => sum + tick.decisions.length, 0), distribution, actions,
    budgetGate: { estimatedLlmUsd, estimatedPodUsd, estimatedTotalUsd: estimatedLlmUsd + estimatedPodUsd,
      basis: 'Planning assumption per launch: LLM $2 + Pod $1 (one Pod-hour); not metered usage or budget approval', verdict: 'estimate-only' },
    hitlGate: { requiringHuman: actions.filter(action => action.kind === 'hitl').length },
    source: { decisions: path, logs: `elanous logs --category ${CATEGORY} --event ${EVENT} --since ${sinceHours}h` },
  };
}

export function formatStewardReadiness(report: ReadinessReport): string {
  return [
    `Steward shadow readiness | ${report.since} → ${report.until}`,
    `Ticks | ${report.ticks}`,
    `Judgments | ${report.judgments}`,
    `Judgment distribution | ${Object.entries(report.distribution).map(([kind, count]) => `${kind}: ${count}`).join(' · ') || 'none'}`,
    `If live, actions | ${report.actions.map(a => `${a.at} ${a.kind} ${a.issue}`).join(' · ') || 'none'}`,
    `Budget gate | LLM ~$${report.budgetGate.estimatedLlmUsd} · Pod ~$${report.budgetGate.estimatedPodUsd} · total ~$${report.budgetGate.estimatedTotalUsd} (estimate only; not approval)`,
    `HITL gate | ${report.hitlGate.requiringHuman} human confirmations`,
    `Estimate basis | ${report.budgetGate.basis}`,
    `Shadow decisions | ${report.source.decisions}`,
    `First-class logs | ${report.source.logs}`,
  ].join('\n');
}

export function parseReadinessSince(value: string): number {
  if (!/^(?:\d+)(?:\.\d+)?h$/.test(value)) throw new Error('--since must be a positive duration such as 24h');
  const hours = Number(value.slice(0, -1));
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('--since must be a positive duration such as 24h');
  return hours;
}

export function runStewardReadinessCli(opts: { since: string; json?: boolean }, root = effectiveInstanceRoot()): number {
  try {
    const report = stewardReadiness(root, parseReadinessSince(opts.since));
    console.log(opts.json ? JSON.stringify(report) : formatStewardReadiness(report));
    return 0;
  } catch (error) {
    console.error(`steward readiness: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
