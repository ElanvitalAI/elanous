// SEARCH-BENCH metrics — recall@k = |expected ∩ top-k| / min(|expected|, k) · MRR = 1/rank of the first expected
// path (0 when absent) · calls / bytes (model-visible) / ms per query · decoy@5 = ignored-decoy paths in the top 5.
import { DECOY_DIR } from './corpus.js';
import type { Aggregate, GoldItem, QueryResult, StrategySummary, SearchStrategy, TraceEntry } from './types.js';

export function recallAt(ranked: readonly string[], expected: readonly string[], k: number): number {
  const top = new Set(ranked.slice(0, k));
  const found = expected.filter((p) => top.has(p)).length;
  return found / Math.min(expected.length, k);
}
export function firstRank(ranked: readonly string[], expected: readonly string[]): number | null {
  const i = ranked.findIndex((p) => expected.includes(p));
  return i < 0 ? null : i + 1;
}
export const decoyCount = (ranked: readonly string[]): number => ranked.slice(0, 5).filter((p) => p.startsWith(`${DECOY_DIR.split('/')[0]}/`)).length;

export function scoreQuery(strategy: string, item: GoldItem, ranked: readonly string[], trace: readonly TraceEntry[], ms: number, error?: string): QueryResult {
  const top = ranked.slice(0, 10);
  return {
    strategy, queryId: item.id, ranked: top, firstRank: firstRank(ranked, item.expected),
    recall1: recallAt(ranked, item.expected, 1), recall5: recallAt(ranked, item.expected, 5),
    calls: trace.filter((t) => t.bytes > 0 || t.hits > 0 || t.error).length, bytes: trace.reduce((n, t) => n + t.bytes, 0), ms,
    decoy5: decoyCount(ranked), ...(error ? { error } : {}), trace,
  };
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
export function aggregate(rows: readonly QueryResult[]): Aggregate {
  const n = rows.length || 1;
  const sum = (f: (r: QueryResult) => number) => rows.reduce((a, r) => a + f(r), 0);
  return {
    n: rows.length,
    recall1: round(sum((r) => r.recall1) / n), recall5: round(sum((r) => r.recall5) / n),
    mrr: round(sum((r) => (r.firstRank ? 1 / r.firstRank : 0)) / n),
    calls: round(sum((r) => r.calls) / n, 2), bytes: Math.round(sum((r) => r.bytes) / n), ms: Math.round(sum((r) => r.ms) / n),
    decoy5: round(sum((r) => r.decoy5) / n, 2),
  };
}

export function summarize(strategy: SearchStrategy, rows: readonly QueryResult[], items: readonly GoldItem[]): StrategySummary {
  const byId = new Map(items.map((it) => [it.id, it]));
  const group = (key: (it: GoldItem) => string) => {
    const m: Record<string, QueryResult[]> = {};
    for (const r of rows) { const it = byId.get(r.queryId); if (!it) continue; (m[key(it)] ??= []).push(r); }
    return Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, aggregate(v)]));
  };
  return {
    id: strategy.id, version: strategy.version, track: strategy.track, label: strategy.label,
    ...(strategy.source ? { source: strategy.source } : {}), ...(strategy.params ? { params: strategy.params } : {}),
    all: aggregate(rows), byDomain: group((it) => it.domain), byCategory: group((it) => it.category),
  };
}
