import type { BillingRoute } from './llm-cost.js';

export interface RunUsageInput {
  runId?: string | null;
  hostId?: string | null;
  site?: string | null;
  role?: string | null;
  model?: string | null;
  billingProvider?: string | null;
  billing?: BillingRoute | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  reasoningOutputTokens?: number | null;
  cost?: { kind?: string; usd?: number; apiEquivalentUsd?: number } | null;
}

export interface RunUsageRow {
  runId: string;
  role?: string;
  site?: string;
  model: string;
  billingProvider: string;
  billing: string;
  hostIds: string[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  usdKnown: number;
  unknownCostCalls: number;
  includedCalls: number;
  apiEquivalentUsd: number;
}

/** Aggregate llm-usage observations without turning unavailable prices into a known zero. */
export function rollupRunUsage(...[rows, opts]: [rows: readonly RunUsageInput[], opts?: { by?: 'run' | 'role' }]): RunUsageRow[] {
  const groups = new Map<string, RunUsageRow>();
  const byRole = opts?.by === 'role';
  for (const data of rows) {
    const runId = byRole ? '(all)' : data.runId ?? '(none)';
    const role = data.role ?? '(none)';
    const site = data.site ?? '(none)';
    const model = data.model ?? '(none)';
    const billingProvider = data.billingProvider ?? '(none)';
    const billing = data.billing ?? '(none)';
    const key = JSON.stringify(byRole ? [role, site, model, billingProvider, billing] : [runId, model, billingProvider, billing]);
    let row = groups.get(key);
    if (!row) {
      row = {
        runId, ...(byRole ? { role, site } : {}), model, billingProvider, billing, hostIds: [], calls: 0,
        inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
        usdKnown: 0, unknownCostCalls: 0, includedCalls: 0, apiEquivalentUsd: 0,
      };
      groups.set(key, row);
    }
    if (data.hostId && !row.hostIds.includes(data.hostId)) row.hostIds.push(data.hostId);
    row.calls++;
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'reasoningOutputTokens'] as const) {
      const value = data[field];
      if (typeof value === 'number' && Number.isFinite(value)) row[field] += value;
    }
    const cost = data.cost;
    if (cost?.kind === 'included') {
      row.includedCalls++;
      if (typeof cost.apiEquivalentUsd === 'number' && Number.isFinite(cost.apiEquivalentUsd)) row.apiEquivalentUsd += cost.apiEquivalentUsd;
    } else if (cost?.kind === 'known' || cost?.kind === 'actual') {
      if (typeof cost.usd === 'number' && Number.isFinite(cost.usd)) row.usdKnown += cost.usd;
      else row.unknownCostCalls++;
    } else {
      row.unknownCostCalls++;
      if (cost?.kind === 'partial' && typeof cost.usd === 'number' && Number.isFinite(cost.usd)) row.usdKnown += cost.usd;
    }
  }
  return [...groups.values()];
}
