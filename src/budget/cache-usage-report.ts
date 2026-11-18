// ── O4 OP-LONG-SESSION-COMPACT — prompt-cache hit rate over stored llm.usage rows ──
//
// Read-only. Input = `llm.usage`/`llm-usage` rows (llm.ts `logAgentTurnUsage`) and optionally
// `session.compact`/`fired` rows. Provider parsers normalize `inputTokens` to the UNCACHED input
// and carry cache reads/writes separately (prompt-cache/types.ts contract), so the prompt a call
// sent is input + cacheRead + cacheCreation and the hit rate is cacheRead over that — summed over
// the calls that reported cache fields only. Total input still counts every call.
//
// A call whose provider never reports cache fields is counted as `unreported`, not as a miss:
// «0 cached» and «not measured» are different answers.

export interface CacheUsageRow {
  sessionId?: string | null;
  model?: string;
  provider?: string;
  billingProvider?: string;
  inputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface CacheUsageGroup {
  /** `billingProvider/model` (falls back to the wire adapter name). */
  key: string;
  calls: number;
  /** Calls whose usage carried a cache-read or cache-write field. */
  reportedCalls: number;
  /** Uncached input over ALL calls (reported or not). */
  inputTokens: number;
  /** Uncached input over reported calls only — the hit-rate denominator's input part. */
  reportedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** cacheRead / (input + cacheRead + cacheCreation) over reported calls; null when nothing reported. */
  hitRate: number | null;
}

export interface CacheUsageReport {
  sessionId: string | null;
  total: CacheUsageGroup;
  groups: CacheUsageGroup[];
  /** `session.compact` events in the same window (null = not queried). */
  compactions: number | null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function emptyGroup(key: string): CacheUsageGroup {
  return { key, calls: 0, reportedCalls: 0, inputTokens: 0, reportedInputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, hitRate: null };
}

function add(group: CacheUsageGroup, row: CacheUsageRow): void {
  group.calls += 1;
  group.inputTokens += count(row.inputTokens);
  const reported = typeof row.cacheReadInputTokens === 'number' || typeof row.cacheCreationInputTokens === 'number';
  if (!reported) return;
  group.reportedCalls += 1;
  group.reportedInputTokens += count(row.inputTokens);
  group.cacheReadInputTokens += count(row.cacheReadInputTokens);
  group.cacheCreationInputTokens += count(row.cacheCreationInputTokens);
}

function finish(group: CacheUsageGroup): CacheUsageGroup {
  const prompt = group.reportedInputTokens + group.cacheReadInputTokens + group.cacheCreationInputTokens;
  return { ...group, hitRate: group.reportedCalls > 0 && prompt > 0 ? group.cacheReadInputTokens / prompt : null };
}

/** Aggregate cache usage. `sessionId` filters rows; rows are otherwise taken as given. */
export function summarizeCacheUsage(
  rows: readonly CacheUsageRow[],
  opts: { sessionId?: string; compactions?: number | null } = {},
): CacheUsageReport {
  const total = emptyGroup('total');
  const groups = new Map<string, CacheUsageGroup>();
  for (const row of rows) {
    if (opts.sessionId !== undefined && row.sessionId !== opts.sessionId) continue;
    const key = `${row.billingProvider || row.provider || '(unknown)'}/${row.model || '(unknown)'}`;
    const group = groups.get(key) ?? emptyGroup(key);
    add(group, row);
    groups.set(key, group);
    add(total, row);
  }
  return {
    sessionId: opts.sessionId ?? null,
    total: finish(total),
    groups: [...groups.values()].map(finish).sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key)),
    compactions: opts.compactions ?? null,
  };
}

function pct(rate: number | null): string {
  return rate === null ? '못 잼(공급자가 캐시 칸을 안 줌)' : `${(rate * 100).toFixed(1)}%`;
}

function line(group: CacheUsageGroup): string {
  return `${group.key}  calls=${group.calls}  reported=${group.reportedCalls}  input=${group.inputTokens}  reportedInput=${group.reportedInputTokens}  cacheRead=${group.cacheReadInputTokens}  cacheWrite=${group.cacheCreationInputTokens}  hit=${pct(group.hitRate)}`;
}

export function formatCacheUsageReport(report: CacheUsageReport): string {
  const compactions = report.compactions === null ? '' : ` · 압축 ${report.compactions}회`;
  // The compaction count is shown even when no usage row matched (e.g. a provider without a ledger).
  if (report.total.calls === 0) return (report.sessionId ? `(세션 ${report.sessionId} 의 llm.usage 행 없음)` : '(llm.usage 행 없음)') + compactions;
  const head = `캐시 적중률 ${pct(report.total.hitRate)} · 호출 ${report.total.calls} (캐시 보고 ${report.total.reportedCalls})`
    + (report.sessionId ? ` · 세션 ${report.sessionId}` : '')
    + compactions;
  return [head, ...report.groups.map(group => `  ${line(group)}`)].join('\n');
}
