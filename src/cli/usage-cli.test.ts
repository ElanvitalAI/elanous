import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { registerUsageCommand } from './usage-cli.js';
import { outcomeTableHasCodexGrokUnknown, type UsageOutcomesReport } from '../budget/usage-outcomes.js';
import type { collectUnifiedUsage } from '../budget/unified-usage.js';
import { LogStore, type LogStoreRow } from '../mss/logging/log-store.js';
import type { LogRecord } from '../mss/logging/record.js';

function row(data: unknown, category = 'llm.usage', event = 'llm-usage'): LogStoreRow {
  return { id: 1, ts: '2026-09-25T00:00:00Z', ts_ms: 1, level: 'info', instance: 'test', surface: 'tui', category, event,
    session_id: null, trace_id: null, data: typeof data === 'string' ? data : JSON.stringify(data) };
}

async function run(args: string[], readRunLogs: NonNullable<Parameters<typeof registerUsageCommand>[1]>['readRunLogs']) {
  const lines: string[] = [];
  const command = new Command();
  registerUsageCommand(command, { readRunLogs, out: { log: (line) => lines.push(line) }, exit: (code) => { throw new Error(`exit ${code}`); } });
  await command.parseAsync(['usage', ...args], { from: 'user' });
  return lines;
}

describe('usage runs', () => {
  it('passes the exact category/event and shared --since grammar to the injected reader, filters run IDs exactly, and rolls up billing/cost axes', async () => {
    let query: unknown;
    const read = (q: Parameters<LogStore['query']>[0]) => {
      query = q;
      return [
        row({ runId: 'run-a', model: 'm', billingProvider: 'gateway', billing: 'api', hostId: 'h1', inputTokens: 2, cost: { kind: 'known', usd: 0 } }),
        row({ runId: 'run-a', model: 'm', billingProvider: 'gateway', billing: 'api', hostId: 'h2', outputTokens: 3, cost: { kind: 'unknown' } }),
        row({ runId: 'run-b', model: 'm', billingProvider: 'gateway', billing: 'api', cost: { kind: 'known', usd: 10 } }),
        row({ runId: 'run-a', model: 'm', billingProvider: 'gateway', billing: 'subscription', cost: { kind: 'included', apiEquivalentUsd: 4 } }),
        row({ runId: 'run-a' }, 'llm.other'), row('{broken'),
      ];
    };
    const lines = await run(['runs', '--run', 'run-a', '--since', '2026-09-24T00:00:00Z', '--json'], read);
    expect(query).toEqual({ exactCategories: ['llm.usage'], events: ['llm-usage'], sinceMs: Date.parse('2026-09-24T00:00:00Z') });
    expect(JSON.parse(lines[0]!)).toEqual([
      { runId: 'run-a', model: 'm', billingProvider: 'gateway', billing: 'api', hostIds: ['h1', 'h2'], calls: 2,
        inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
        usdKnown: 0, unknownCostCalls: 1, includedCalls: 0, apiEquivalentUsd: 0 },
      { runId: 'run-a', model: 'm', billingProvider: 'gateway', billing: 'subscription', hostIds: [], calls: 1,
        inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
        usdKnown: 0, unknownCostCalls: 0, includedCalls: 1, apiEquivalentUsd: 4 },
    ]);
    expect((await run(['runs'], read))[0]).toContain('unknownCostCalls=1');
    expect(await run(['runs', '--run', 'missing', '--json'], read)).toEqual(['[]']);
  });

  it('rejects invalid --since before reading the store', async () => {
    expect(run(['runs', '--since', 'invalid'], () => { throw new Error('reader called'); })).rejects.toThrow('exit 2');
  });

  it('reads actual LogStore-shaped rows via its query seam and preserves the parent usage command', async () => {
    const store = new LogStore(':memory:');
    try {
      const rec = (category: string, event: string, data: object): LogRecord => ({ ts: '2026-09-25T00:00:00Z', category, event, data });
      store.insertBatch([
        { rec: rec('llm.usage', 'llm-usage', { runId: 'real', model: 'm', cost: { kind: 'unknown' } }), surface: 'tui' },
        { rec: rec('llm.usage', 'other', { runId: 'wrong' }), surface: 'tui' },
      ]);
      expect(JSON.parse((await run(['runs', '--json'], (query) => store.query(query)))[0]!)).toMatchObject([{ runId: 'real', calls: 1, unknownCostCalls: 1 }]);
      const lines: string[] = [];
      const command = new Command();
      const report: Awaited<ReturnType<typeof collectUnifiedUsage>> = { rows: [], accountCounts: { codex: 0, grok: 0, openrouter: 0 } };
      registerUsageCommand(command, { collect: async () => report, creditPlan: () => null, out: { log: (line) => lines.push(line) } });
      await command.parseAsync(['usage', '--json'], { from: 'user' });
      expect(lines).toEqual([JSON.stringify({ ...report, codexCreditPlan: null }, null, 2)]);
    } finally { store.close(); }
  });

  it('prints the codex credit plan under the table and carries the same values in --json', async () => {
    const report: Awaited<ReturnType<typeof collectUnifiedUsage>> = { rows: [], accountCounts: { codex: 0, grok: 0, openrouter: 0 } };
    const plan = { expiresAt: '2026-12-31', daysLeft: 92, totalBalance: 45_000, unknownBalances: 0, accounts: [{ name: 'team', balance: 45_000, expires: null }],
      dailyNeeded: 45_000 / 92, targetPerDay: null, actualPerDay: 500, actualSpanDays: 7, note: '연말까지 소진' };
    const text: string[] = [];
    const a = new Command();
    registerUsageCommand(a, { collect: async () => report, creditPlan: () => plan, out: { log: (line) => text.push(line) } });
    await a.parseAsync(['usage'], { from: 'user' });
    const shown = text.join('\n');
    expect(shown).toContain('codex 크레딧');
    expect(shown).toContain('계산      만료까지 92일 · 하루 소진 필요 489 · 최근 7일 실제 500/일');
    expect(shown).toContain('메모      연말까지 소진');
    const json: string[] = [];
    const b = new Command();
    registerUsageCommand(b, { collect: async () => report, creditPlan: () => plan, out: { log: (line) => json.push(line) } });
    await b.parseAsync(['usage', '--json'], { from: 'user' });
    expect(JSON.parse(json[0]!).codexCreditPlan).toEqual(plan);
  });
});

describe('usage outcomes', () => {
  it('최근 이틀 표에 codex·grok·불명 세 줄을 내고 provider 미기록 런은 불명으로 센다', async () => {
    const now = Date.parse('2026-10-05T00:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    const ledger = (provider: string | undefined, event: string, data: Record<string, unknown>, ageDays: number) => ([
      { timestamp: new Date(now - ageDays * day).toISOString(), runId: 'r', event: 'run-origin', data: provider ? { childProvider: provider } : {} },
      { timestamp: new Date(now - ageDays * day + 1000).toISOString(), runId: 'r', event, data },
    ]);
    const files: Record<string, ReturnType<typeof ledger>> = {
      'run-codex.jsonl': ledger('codex', 'merged', { merged: true, round: 1 }, 0),
      'run-grok.jsonl': ledger('grok', 'pr-opened', { draft: true, round: 2 }, 1),
      'run-unknown.jsonl': ledger(undefined, 'failed', { stopReason: 'no-progress', round: 3 }, 1),
      'run-old.jsonl': ledger('codex', 'merged', { merged: true }, 5),
    };
    const lines: string[] = [];
    const command = new Command();
    registerUsageCommand(command, {
      out: { log: (line) => lines.push(line) },
      exit: (code) => { throw new Error(`exit ${code}`); },
      outcomeDeps: {
        nowMs: now,
        dir: '/ledger',
        list: () => Object.keys(files),
        load: (runId) => files[`${runId}.jsonl`] ?? null,
      },
    });
    await command.parseAsync(['usage', 'outcomes', '--days', '2', '--json'], { from: 'user' });
    const report = JSON.parse(lines[0]!) as UsageOutcomesReport & { hasCodexGrokUnknown: boolean };
    expect(outcomeTableHasCodexGrokUnknown(report)).toBe(true);
    expect(report.hasCodexGrokUnknown).toBe(true);
    expect(new Set(report.rows.map((row) => row.provider))).toEqual(new Set(['codex', 'grok', '불명']));
    expect(report.rows.find((row) => row.provider === 'codex')).toMatchObject({ landed: 1, rounds: 1 });
    expect(report.rows.find((row) => row.provider === 'grok')).toMatchObject({ draft: 1, rounds: 1 });
    expect(report.rows.find((row) => row.provider === '불명')).toMatchObject({ failed: 1, rounds: 1, blockReasons: { 'no-progress': 1 } });
    const text: string[] = [];
    const shown = new Command();
    registerUsageCommand(shown, {
      out: { log: (line) => text.push(line) },
      outcomeDeps: {
        nowMs: now,
        dir: '/ledger',
        list: () => Object.keys(files),
        load: (runId) => files[`${runId}.jsonl`] ?? null,
      },
    });
    await shown.parseAsync(['usage', 'outcomes', '--days', '2'], { from: 'user' });
    const table = text.join('\n');
    expect(table).toContain('판정: codex·grok·불명');
    expect(table).toContain('codex');
    expect(table).toContain('grok');
    expect(table).toContain('불명');
    expect(table).toContain('no-progress=1');
  });
});
