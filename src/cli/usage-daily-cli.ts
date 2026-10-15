import type { Command } from 'commander';
import { logsDbPath } from '../mss/logging/log-store.js';
import { readUsageDaily, type DailyUsageRow } from '../budget/usage-daily-store.js';

type Axis = 'day' | 'model' | 'role' | 'stage' | 'account';
const metricFields = ['calls', 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens',
  'reasoningOutputTokens', 'usdKnown', 'unknownCostCalls', 'includedCalls', 'apiEquivalentUsd'] as const;
type Period = 'day' | 'hour';
type Summary = Pick<DailyUsageRow, typeof metricFields[number]> & { period: string; key: string };

export function summarizeDailyUsage(rows: readonly DailyUsageRow[], axis: Axis, period: Period = 'day'): Summary[] {
  const groups = new Map<string, Summary>();
  for (const row of rows) {
    const bucket = row[period];
    const key = axis === 'day' ? bucket : row[axis];
    const id = JSON.stringify([bucket, key]);
    let summary = groups.get(id);
    if (!summary) {
      summary = { period: bucket, key, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0, reasoningOutputTokens: 0, usdKnown: 0, unknownCostCalls: 0,
        includedCalls: 0, apiEquivalentUsd: 0 };
      groups.set(id, summary);
    }
    for (const field of metricFields) summary[field] += row[field];
  }
  return [...groups.values()].sort((a, b) => a.period.localeCompare(b.period) || a.key.localeCompare(b.key));
}

export function registerUsageDailyCommand(program: Command, deps: {
  path?: () => string; read?: typeof readUsageDaily;
  out?: (line: string) => void; exit?: (code: number) => void;
} = {}): void {
  const usage = program.commands.find((command) => command.name() === 'usage');
  if (!usage) throw new Error('usage command must be registered before usage daily');
  const out = deps.out ?? console.log;
  const exit = deps.exit ?? ((code: number) => { process.exitCode = code; });
  usage.command('daily')
    .description('현재 logs.db에 남은 호스트 시간·일 LLM 사용량 (UTC)')
    .option('--since <day>', 'UTC 시작일 YYYY-MM-DD')
    .option('--period <period>', 'day | hour', 'day')
    .option('--by <axis>', 'day | model | role | stage | account', 'day')
    .option('--json', 'JSON 출력')
    .action((opts: { since?: string; period: string; by: string; json?: boolean }) => {
      const parsedSince = opts.since === undefined ? null : Date.parse(`${opts.since}T00:00:00Z`);
      if (!['day', 'model', 'role', 'stage', 'account'].includes(opts.by) || !['day', 'hour'].includes(opts.period)
        || opts.since !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(opts.since)
          || !Number.isFinite(parsedSince) || new Date(parsedSince!).toISOString().slice(0, 10) !== opts.since)) {
        const detail = '--period day|hour · --by day|model|role|stage|account · --since YYYY-MM-DD (UTC)';
        if (opts.json) out(JSON.stringify({ status: 'error', reason: 'invalid-arguments', detail }));
        else out(`⛔ ${detail}`);
        exit(2); return;
      }
      const path = (deps.path ?? logsDbPath)();
      const scope = { source: 'current-logs-db', sinceDay: opts.since ?? null, timeZone: 'UTC' };
      const unavailable = (reason: 'logs-db-missing' | 'logs-db-unreadable', detail?: string) => {
        if (opts.json) out(JSON.stringify({ status: 'unmeasured', hostStatus: 'unmeasured', podStatus: 'unmeasured',
          reason, scope, ...(detail === undefined ? {} : { detail }), rows: [] }));
        else out(`사용량 집계 불가: ${reason === 'logs-db-missing' ? 'logs.db 없음' : 'logs.db 읽기 실패'} · UTC${opts.since ? ` · ${opts.since} 이후` : ''} · Pod 사용량 측정 불가${detail ? ` (${detail})` : ''}`);
        exit(1);
      };
      let source: ReturnType<typeof readUsageDaily>;
      try {
        source = (deps.read ?? readUsageDaily)(path, opts.since);
      }
      catch (error) {
        unavailable('logs-db-unreadable', String(error)); return;
      }
      if (source === null) {
        unavailable('logs-db-missing'); return;
      }
      const report = { status: 'partial', hostStatus: 'measured-within-current-logs-horizon',
        podStatus: 'unmeasured', podObservedRows: source.podObservedRows,
        unclassifiedRows: source.unclassifiedRows, sourceMaxId: source.sourceMaxId,
        scope,
        timeZone: 'UTC', period: opts.period, by: opts.by,
        rows: summarizeDailyUsage(source.rows, opts.by as Axis, opts.period as Period) };
      if (opts.json) { out(JSON.stringify(report)); return; }
      out(`집계 범위: 현재 logs.db에 남은 로그 · UTC${opts.since ? ` · ${opts.since} 이후` : ''} (보존 기간 밖은 포함되지 않음)`);
      out(`Pod 사용량: 측정 불가 · 위 범위에서 ${report.podObservedRows}행 관측 (0행도 사용량 0을 뜻하지 않음)`);
      if (report.unclassifiedRows > 0) out(`분류 불가 사용량: 측정 불가 · 위 범위에서 ${report.unclassifiedRows}행 관측`);
      if (!report.rows.length) { out('(현재 로그에 남은 호스트 사용량 없음 · 과거 로그는 복구 불가)'); return; }
      for (const row of report.rows) out(`${row.period} ${opts.by}=${row.key} calls=${row.calls} input=${row.inputTokens} output=${row.outputTokens} cacheRead=${row.cacheReadInputTokens} usdKnown=${row.usdKnown} unknownCostCalls=${row.unknownCostCalls}`);
    });
}
