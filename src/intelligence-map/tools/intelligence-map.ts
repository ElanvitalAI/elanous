import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S5 P5: IntelligenceMap LLM tool ──
//
// Aggregates catalog + enabled models + system snapshot + cost
// snapshot + cap status into a single structured payload. Also
// produces a compact text formatting for injection into the
// auto-mode loop-prompt.


import { discoverModels, enabledModels } from '../model-catalog.js';
import {
  loadCostConfig,
  snapshotCost,
  weeklyCapStatus,
} from '../cost-meter.js';
import { formatSystemLine, getSystemSnapshot } from '../system-monitor.js';
import type {
  CostCapConfig,
  CostCapStatus,
  CostSnapshot,
  ModelCatalog,
  ModelEntry,
  SystemSnapshot,
} from '../types.js';
import { getAutoModeState } from '../../auto-research/auto-mode/index.js';

export type IntelligenceMapResult = {
  catalog_summary: {
    total: number;
    enabled: number;
    local: number;
    paid: number;
  };
  enabled_models: Array<{
    id: string;
    provider: string;
    local: boolean;
    context_k: number;
    price_text: string;
  }>;
  system: SystemSnapshot;
  system_line: string;
  cost: CostSnapshot;
  cost_cap: CostCapConfig;
  weekly_cap_status: CostCapStatus;
  active_goal?: string;
  active_goal_cost_usd?: number;
  format: string;
  notices?: string[];
}

export interface IntelligenceMapDispatchOpts {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export async function dispatchIntelligenceMap(
  opts: IntelligenceMapDispatchOpts = {},
): Promise<IntelligenceMapResult> {
  const env = opts.env ?? process.env;
  const catalog = await discoverModels({ home: opts.home, env });
  const enabled = enabledModels(catalog, env);
  const system = getSystemSnapshot();
  const cost = snapshotCost({ home: opts.home, env });
  const costConfig = loadCostConfig({ home: opts.home, env });
  const weekly = weeklyCapStatus(cost, costConfig);

  const activeGoal = safeActiveGoal();
  const activeGoalCost = activeGoal ? (cost.perGoal[activeGoal]?.usd ?? 0) : undefined;

  const summary = catalogSummary(catalog, enabled);
  const enabledDescribed = enabled.map(describeEntry);

  const format = renderFormat({
    summary,
    weekly,
    costConfig,
    cost,
    activeGoal,
    activeGoalCost,
    system,
    enabled,
  });

  return {
    catalog_summary: summary,
    enabled_models: enabledDescribed,
    system,
    system_line: formatSystemLine(system),
    cost,
    cost_cap: costConfig,
    weekly_cap_status: weekly,
    ...(activeGoal ? { active_goal: activeGoal } : {}),
    ...(activeGoalCost !== undefined ? { active_goal_cost_usd: round2(activeGoalCost) } : {}),
    format,
  };
}

function safeActiveGoal(): string | undefined {
  try { return getAutoModeState().goalSlug; } catch { return undefined; }
}

function catalogSummary(catalog: ModelCatalog, enabled: ModelEntry[]): IntelligenceMapResult['catalog_summary'] {
  const local = enabled.filter(m => m.local).length;
  const paid = enabled.filter(m => !m.local).length;
  return {
    total: catalog.models.length,
    enabled: enabled.length,
    local,
    paid,
  };
}

function describeEntry(m: ModelEntry) {
  const price = m.local
    ? 'local (free)'
    : `$${m.inputPerMtok}/$${m.outputPerMtok} per Mtok`;
  return {
    id: m.id,
    provider: m.provider,
    local: m.local,
    context_k: Math.round(m.contextWindow / 1000),
    price_text: price,
  };
}

interface RenderArgs {
  summary: IntelligenceMapResult['catalog_summary'];
  weekly: CostCapStatus;
  costConfig: CostCapConfig;
  cost: CostSnapshot;
  activeGoal?: string | undefined;
  activeGoalCost?: number | undefined;
  system: SystemSnapshot;
  enabled: ModelEntry[];
}

function renderFormat(a: RenderArgs): string {
  const lines: string[] = [];
  lines.push(`🧠 ${a.summary.enabled}/${a.summary.total} models ready · ${a.summary.local} local · ${a.summary.paid} paid`);
  if (a.costConfig.weeklyCapUsd !== undefined) {
    const pct = Math.round((a.cost.weeklyUsd / a.costConfig.weeklyCapUsd) * 100);
    lines.push(`$${a.cost.weeklyUsd.toFixed(2)} used this week (cap $${a.costConfig.weeklyCapUsd.toFixed(2)} — ${pct}%) [${a.weekly}]`);
  } else {
    lines.push(`$${a.cost.weeklyUsd.toFixed(2)} used this week (no cap)`);
  }
  if (a.activeGoal) {
    const gc = a.activeGoalCost ?? 0;
    lines.push(`Active goal: ${a.activeGoal} · $${gc.toFixed(2)} attributed`);
  }
  lines.push(formatSystemLine(a.system));
  const top = a.enabled.slice(0, 3).map(m => m.id).join(' · ');
  if (top) lines.push(`Top: ${top}`);
  return lines.join('\n');
}

export function formatIntelligenceMap(r: IntelligenceMapResult): string {
  return r.format;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ── LLM tool spec ──────────────────────────────────────────────────────

export function buildIntelligenceMapTool(): LLMToolSpec {
  return {
    name: 'IntelligenceMap',
    description:
      'Snapshot the gateway between compute resources and LLM cost: active model catalog (filtered by enabled '
      + 'API keys), system load (CPU / RAM), weekly/monthly cost usage, cap status, and the currently active '
      + 'auto-research goal (if any). Returns structured JSON + a compact text form suitable for turn-kickoff '
      + 'injection. Purely read — no side effects.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  };
}
