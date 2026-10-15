/** Read-only UTC usage buckets from the portion of logs.db still retained. */
import { existsSync } from 'node:fs';
import { LogStore, logsDbPath, type LogStoreRow } from '../mss/logging/log-store.js';

type Metrics = {
  calls: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number;
  cacheCreationInputTokens: number; reasoningOutputTokens: number; usdKnown: number;
  unknownCostCalls: number; includedCalls: number; apiEquivalentUsd: number;
};
const ZERO: Metrics = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0, reasoningOutputTokens: 0, usdKnown: 0, unknownCostCalls: 0,
  includedCalls: 0, apiEquivalentUsd: 0 };
const FIELDS = Object.keys(ZERO) as Array<keyof Metrics>;
const finite = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const nonnegativeOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
const label = (value: unknown): string => typeof value === 'string' && value.length > 0 ? value : '(none)';
const obj = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;

function metrics(data: Record<string, unknown>): Metrics {
  const cost = obj(data.cost);
  const calls = nonnegativeOr(data.calls, 1);
  const kind = cost?.kind;
  return {
    calls, inputTokens: finite(data.inputTokens), outputTokens: finite(data.outputTokens),
    cacheReadInputTokens: finite(data.cacheReadInputTokens), cacheCreationInputTokens: finite(data.cacheCreationInputTokens),
    reasoningOutputTokens: finite(data.reasoningOutputTokens),
    usdKnown: kind === 'known' || kind === 'actual' || kind === 'partial' ? finite(cost?.usd) : 0,
    unknownCostCalls: kind === 'unknown' || kind === 'partial' ? nonnegativeOr(cost?.unknownCostCalls, calls)
      : kind === 'known' || kind === 'actual' || kind === 'included' ? 0 : calls,
    includedCalls: kind === 'included' ? nonnegativeOr(cost?.includedCalls, calls) : finite(cost?.includedCalls),
    apiEquivalentUsd: finite(cost?.apiEquivalentUsd),
  };
}

function classify(row: LogStoreRow): { kind: 'host'; data: Record<string, unknown> } | { kind: 'pod' } | { kind: 'unclassified' } {
  let data: Record<string, unknown> | null = null;
  try { data = obj(JSON.parse(row.data ?? '')); } catch { /* unreadable payload stays unmeasured */ }
  if (!data) return { kind: 'unclassified' };
  if (data.origin === 'pod' || typeof data.podJob === 'string' || data.substrate === 'pod'
    || typeof data.site === 'string' && data.site.startsWith('pod-rollup:')) return { kind: 'pod' };
  if (data.measured === false) return { kind: 'unclassified' };
  return { kind: 'host', data };
}

export interface DailyUsageRow extends Metrics {
  day: string; hour: string; role: string; stage: string; account: string; model: string;
  billingProvider: string; billing: string; site: string; hostId: string;
}
export interface UsageDailyRead {
  rows: DailyUsageRow[];
  podObservedRows: number;
  unclassifiedRows: number;
  sourceMaxId: number;
}

/** Query every llm.usage event in bounded pages. No database or retention writes occur. */
export function readUsageDaily(path = logsDbPath(), sinceDay?: string): UsageDailyRead | null {
  if (!existsSync(path)) return null;
  const logs = LogStore.openReadOnly(path);
  try {
    const upper = logs.maxId();
    const groups = new Map<string, DailyUsageRow>();
    let afterId = 0;
    let podObservedRows = 0;
    let unclassifiedRows = 0;
    const sinceMs = sinceDay === undefined ? undefined : Date.parse(`${sinceDay}T00:00:00Z`);
    while (afterId < upper) {
      const page = logs.query({ exactCategories: ['llm.usage'], sinceMs, afterId, limit: 1000 });
      if (!page.length) break;
      for (const row of page) {
        if (row.id > upper) break;
        const classified = classify(row);
        if (classified.kind === 'pod') { podObservedRows++; continue; }
        if (classified.kind === 'unclassified') { unclassifiedRows++; continue; }
        const { data } = classified;
        const hour = new Date(row.ts_ms).toISOString().slice(0, 13);
        const day = hour.slice(0, 10);
        const dimensions = [label(data.role), label(data.stage), label(data.account), label(data.model),
          label(data.billingProvider ?? data.provider), label(data.billing), label(data.site), label(data.hostId ?? row.host_id)];
        const key = JSON.stringify([hour, ...dimensions]);
        let value = groups.get(key);
        if (!value) {
          const [role, stage, account, model, billingProvider, billing, site, hostId] = dimensions;
          value = { day, hour, role: role!, stage: stage!, account: account!, model: model!, billingProvider: billingProvider!,
            billing: billing!, site: site!, hostId: hostId!, ...ZERO };
          groups.set(key, value);
        }
        const delta = metrics(data);
        for (const field of FIELDS) value[field] += delta[field];
      }
      afterId = page.at(-1)!.id;
    }
    return { rows: [...groups.values()].sort((a, b) => a.hour.localeCompare(b.hour)),
      podObservedRows, unclassifiedRows, sourceMaxId: upper };
  } finally { logs.close(); }
}
