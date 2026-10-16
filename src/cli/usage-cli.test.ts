import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { registerUsageCommand } from './usage-cli.js';
import { formatAutoLandRatio, measureAutoLandRatio, outcomeTableHasCodexGrokUnknown, queryUsageOutcomes, type UsageOutcomesReport } from '../budget/usage-outcomes.js';
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
  it('counts a Pod Job rollup once on model, stage, and account axes while retaining raw-only Jobs', async () => {
    const read = () => [
      row({ origin: 'pod', podJob: 'job-a', originalData: JSON.stringify({ runId: 'child-a', model: 'raw-model', role: 'implement', account: 'raw-account', inputTokens: 12, cost: { kind: 'known', usd: 2 } }) }),
      row({ site: 'pod-rollup:agent-turn', job: 'job-a', model: 'rollup-model', stage: 'implement', account: 'rollup-account', inputTokens: 12, cost: { kind: 'known', usd: 2 }, podRollupKey: 'job-a|agent-turn' }),
      row({ origin: 'pod', podJob: 'job-b', runId: 'child-b', model: 'raw-only', role: 'review', account: 'raw-only-account', inputTokens: 5, cost: { kind: 'known', usd: 1 } }),
      row({ site: 'pod-rollup:missing', job: 'job-b', measured: false, podRollupKey: 'job-b|missing' }),
      row({ runId: 'local', model: 'local-model', role: 'review', account: 'local-account', inputTokens: 3 }),
    ];
    const byModel = JSON.parse((await run(['runs', '--by', 'model', '--json'], read))[0]!);
    expect(byModel.find((entry: { model: string }) => entry.model === 'raw-model')).toBeUndefined();
    expect(byModel.find((entry: { model: string }) => entry.model === 'rollup-model')).toMatchObject({ calls: 1, inputTokens: 12, usdKnown: 2 });
    expect(byModel.find((entry: { model: string }) => entry.model === 'raw-only')).toMatchObject({ calls: 1, inputTokens: 5, usdKnown: 1 });
    const byStage = JSON.parse((await run(['runs', '--by', 'stage', '--json'], read))[0]!);
    expect(byStage.find((entry: { stage: string }) => entry.stage === 'implement')).toMatchObject({ calls: 1, inputTokens: 12 });
    expect(byStage.find((entry: { stage: string }) => entry.stage === 'review')).toMatchObject({ calls: 2, inputTokens: 8 });
    const byAccount = JSON.parse((await run(['runs', '--by', 'account', '--json'], read))[0]!);
    expect(byAccount.find((entry: { account: string }) => entry.account === 'raw-account')).toBeUndefined();
    expect(byAccount.find((entry: { account: string }) => entry.account === 'rollup-account')).toMatchObject({ calls: 1, inputTokens: 12 });
    expect(byAccount.find((entry: { account: string }) => entry.account === 'raw-only-account')).toMatchObject({ calls: 1, inputTokens: 5 });
  });

  it('passes the exact category/event and shared --since grammar to the injected reader, filters run IDs exactly, and rolls up billing/cost axes', async () => {
    let query: unknown;
    const read = (q: Parameters<LogStore['query']>[0]) => {
      query = q;
      return [
        row({ runId: 'run-a', model: 'm', billingProvider: 'gateway', billing: 'api', hostId: 'h1', inputTokens: 2, cost: { kind: 'known', usd: 0 } }),
        row({ runId: 'run-a', model: 'm', billingProvider: 'gateway', billing: 'api', hostId: 'h2', outputTokens: 3, cost: { kind: 'unknown' } }),
        row({ runId: 'run-b', model: 'm', billingProvider: 'gateway', billing: 'api', cost: { kind: 'known', usd: 10 } }),
        row({ runId: 'run-a', model: 'm', billingProvider: 'gateway', billing: 'subscription', cost: { kind: 'included', apiEquivalentUsd: 4 } }),
        row({ origin: 'pod', originalData: JSON.stringify({ runId: 'run-a', model: 'pod-only', billingProvider: 'gateway', billing: 'api', cost: { kind: 'known', usd: 99 } }) }),
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

  it('aggregates stage, model, and account axes and keeps missing axes in a (none) bucket', async () => {
    const read = () => [
      row({ runId: 'a', stage: 'authoring', role: 'planning', model: 'm-author', account: 'acct-a', inputTokens: 2 }),
      row({ runId: 'b', role: 'implement', model: 'm-impl', account: 'acct-b', outputTokens: 3 }),
      row({ runId: 'c', inputTokens: 5 }),
      row({ origin: 'pod', originalData: JSON.stringify({ runId: 'd', model: 'm-pod', account: 'acct-a', role: 'review', inputTokens: 7 }) }),
      row({ runId: 'e', role: 'gate', model: 'm-gate', account: 'acct-c', inputTokens: 11 }),
      row({ runId: 'f', role: 'research', model: 'm-other', account: 'acct-d', inputTokens: 13 }),
      row({ runId: 'g', stage: 'custom', model: 'm-custom', account: 'acct-e', inputTokens: 17 }),
      row({ runId: 'h', role: 'planning', model: 'm-plan', account: 'acct-f', inputTokens: 19 }),
    ];
    const byStage = JSON.parse((await run(['runs', '--by', 'stage', '--json'], read))[0]!);
    const stages = Object.fromEntries(byStage.map((entry: { stage: string }) => [entry.stage, entry]));
    expect(stages).toMatchObject({
      authoring: { calls: 2, inputTokens: 21 },
      implement: { calls: 1, outputTokens: 3 },
      '(none)': { calls: 1, inputTokens: 5 },
      review: { calls: 1, inputTokens: 7 },
      gate: { calls: 1, inputTokens: 11 },
      '기타': { calls: 2, inputTokens: 30 },
    });
    expect(byStage).toHaveLength(6);

    const byModel = JSON.parse((await run(['runs', '--by', 'model', '--json'], read))[0]!);
    expect(byModel).toMatchObject([
      { model: 'm-author', calls: 1 },
      { model: 'm-impl', calls: 1 },
      { model: '(none)', calls: 1 },
      { model: 'm-pod', calls: 1 },
      { model: 'm-gate', calls: 1 },
      { model: 'm-other', calls: 1 },
      { model: 'm-custom', calls: 1 },
      { model: 'm-plan', calls: 1 },
    ]);

    const byAccount = JSON.parse((await run(['runs', '--by', 'account', '--json'], read))[0]!);
    expect(byAccount).toMatchObject([
      { account: 'acct-a', calls: 2 },
      { account: 'acct-b', calls: 1 },
      { account: '(none)', calls: 1 },
      { account: 'acct-c', calls: 1 },
      { account: 'acct-d', calls: 1 },
      { account: 'acct-e', calls: 1 },
      { account: 'acct-f', calls: 1 },
    ]);
  });

  it('usage runs --by model ranks subscription rows by apiEquivalentUsd (shadow cost)', async () => {
    const read = () => [
      row({ runId: 'r-api', model: 'api-model', billingProvider: 'gateway', billing: 'api', cost: { kind: 'known', usd: 0.5 } }),
      row({ runId: 'r-api', model: 'api-model', billingProvider: 'gateway', billing: 'api', cost: { kind: 'known', usd: 0.5 } }),
      row({ runId: 'r-api', model: 'api-model', billingProvider: 'gateway', billing: 'api', cost: { kind: 'known', usd: 0.5 } }),
      row({ runId: 'r-codex', model: 'gpt-6-sol', billingProvider: 'codex', billing: 'subscription', cost: { kind: 'included', usd: 0, apiEquivalentUsd: 5 } }),
    ];
    const byModel = JSON.parse((await run(['runs', '--by', 'model', '--json'], read))[0]!);
    expect(byModel).toHaveLength(2);
    expect(byModel[0]).toMatchObject({ model: 'gpt-6-sol', calls: 1, usdKnown: 0, apiEquivalentUsd: 5, rankUsd: 5 });
    expect(byModel[1]).toMatchObject({ model: 'api-model', calls: 3, usdKnown: 1.5, apiEquivalentUsd: 0, rankUsd: 1.5 });
    expect((await run(['runs', '--by', 'model'], read))[0]).toContain('rankUsd=5');
  });

  it('rejects invalid --by values before reading logs', async () => {
    const lines: string[] = [];
    const command = new Command();
    registerUsageCommand(command, {
      readRunLogs: () => { throw new Error('reader called'); },
      out: { log: (line) => lines.push(line) },
      exit: (code) => { throw new Error(`exit ${code}`); },
    });
    await expect(command.parseAsync(['usage', 'runs', '--by', 'invalid'], { from: 'user' })).rejects.toThrow('exit 2');
    expect(lines).toEqual(['⛔ --by 는 run | role | stage | model | account']);
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

describe('measureAutoLandRatio — 원장 집계와 손 착지 수의 순수 결합', () => {
  const report = (unreadableLedgers = 0): UsageOutcomesReport => ({
    sinceDays: 2, sinceMs: 0, unreadableLedgers,
    rows: [
      { provider: 'codex', runs: 3, landed: 2, draft: 0, failed: 1, open: 0, unattendedLandRate: 2 / 3, rounds: 1, blockReasons: { timeout: 1, stalled: 2 } },
      { provider: 'grok', runs: 1, landed: 0, draft: 0, failed: 1, open: 0, unattendedLandRate: 0, rounds: 1, blockReasons: { timeout: 2 } },
    ],
  });

  it('measureAutoLandRatio: 자율 2 · 손 1 → 2/3', () => {
    const measured = measureAutoLandRatio(report(), 1);
    expect(measured).toMatchObject({ selfLanded: 2, handMerges: 1, totalMerges: 3, autoLandRatio: 2 / 3 });
    expect(formatAutoLandRatio(measured)).toBe('자율 착지 2 / 전체 3 (66.7%) · 손 착지 1 · 멈춤 사유 timeout=3,stalled=2');
  });

  it('handMerges null → 비율 null 이고 형식 줄에 -', () => {
    const measured = measureAutoLandRatio(report(), null);
    expect(measured.autoLandRatio).toBeNull();
    expect(measured.totalMerges).toBeNull();
    expect(formatAutoLandRatio(measured)).toContain('전체 - (-) · 손 착지 -');
  });

  it('unreadableLedgers>0 → 비율 null', () => {
    const measured = measureAutoLandRatio(report(1), 1);
    expect(measured.autoLandRatio).toBeNull();
    expect(measured.totalMerges).toBeNull();
  });

  it('provider 둘의 blockReasons 가 사유별로 합쳐진다', () => {
    const measured = measureAutoLandRatio(report(), 1);
    expect(Object.entries(measured.blockReasons)).toEqual([['timeout', 3], ['stalled', 2]]);
    expect(formatAutoLandRatio(measured)).toContain('timeout=3,stalled=2');
  });

  it('분모가 0이면 0%라고 지어내지 않는다', () => {
    const measured = measureAutoLandRatio({ ...report(), rows: [] }, 0);
    expect(measured.autoLandRatio).toBeNull();
    expect(formatAutoLandRatio(measured)).toContain('전체 - (-)');
  });

  it('원장 디렉터리가 없어서 빈 보고서가 나오면 손 착지 1건도 0%로 지어내지 않는다', () => {
    const missing = queryUsageOutcomes(2, {
      dir: '/missing-run-ledgers',
      list: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    });
    expect(missing.rows).toHaveLength(0);
    const measured = measureAutoLandRatio(missing, 1);
    expect(measured.autoLandRatio).toBeNull();
    expect(formatAutoLandRatio(measured)).toContain('전체 - (-) · 손 착지 1');
  });

  it('전체 착지 수가 안전 정수를 넘으면 부정확한 비율을 내지 않는다', () => {
    const huge = { ...report(), rows: [{ ...report().rows[0]!, landed: Number.MAX_SAFE_INTEGER }] };
    const measured = measureAutoLandRatio(huge, 1);
    expect(measured.totalMerges).toBeNull();
    expect(measured.autoLandRatio).toBeNull();
  });
});

// ⭐ METER-POD-ROLLUP-GAP-2 — `elanous usage` 도 Pod 재방출(같은 podRollupKey)을 한 번만 센다.
describe('usage runs — pod rollup re-emit dedup', () => {
  it('counts a partial and a final re-emit of the same Pod bucket once (final wins); unkeyed rows are untouched', async () => {
    const read = () => [
      row({ runId: 'run-p', model: 'm', billingProvider: 'gateway', billing: 'api', inputTokens: 2, podRollupKey: 'K', partial: true, partialSeq: 3, cost: { kind: 'known', usd: 1 } }),
      row({ runId: 'run-p', model: 'm', billingProvider: 'gateway', billing: 'api', inputTokens: 9, podRollupKey: 'K', cost: { kind: 'known', usd: 4 } }),
      row({ runId: 'run-p', model: 'm', billingProvider: 'gateway', billing: 'api', inputTokens: 1, cost: { kind: 'known', usd: 0.5 } }),
    ];
    const [first] = JSON.parse((await run(['runs', '--run', 'run-p', '--json'], read))[0]!);
    expect(first).toMatchObject({ calls: 2, inputTokens: 10, usdKnown: 4.5 });
  });
});

describe('usage runs --hosts all', () => {
  const remoteModel = {
    model: 'm', hostIds: ['pod-node-b'], calls: 2, inputTokens: 20, outputTokens: 3,
    cacheReadInputTokens: 4, cacheCreationInputTokens: 0, reasoningOutputTokens: 1,
    usdKnown: 1.5, unknownCostCalls: 0, includedCalls: 0, apiEquivalentUsd: 0, rankUsd: 1.5,
  };

  it('accepts the installed local JSON contract on every grouping axis', async () => {
    const read = () => [row({ runId: 'r', site: 'agent-turn', role: 'review', stage: 'review',
      model: 'm', account: 'acct', hostId: 'pod-mbp', inputTokens: 5, cost: { kind: 'known', usd: 1 } })];
    for (const axis of ['run', 'role', 'stage', 'model', 'account'] as const) {
      const remoteJson = (await run(['runs', '--by', axis, '--json'], read))[0]!;
      const lines: string[] = [];
      const cli = new Command();
      registerUsageCommand(cli, {
        readRunLogs: read,
        usageHosts: () => ({ local: 'mbp', remote: ['node-b'] }),
        ssh: () => ({ status: 0, stdout: remoteJson, stderr: '' }),
        out: { log: (line) => lines.push(line) },
      });
      await cli.parseAsync(['usage', 'runs', '--hosts', 'all', '--by', axis, '--json'], { from: 'user' });
      const report = JSON.parse(lines[0]!);
      expect(report.hosts).toEqual([{ host: 'mbp', status: 'ok' }, { host: 'node-b', status: 'ok' }]);
      expect(report.complete).toBe(true);
      expect(report.rows[0].inputTokens).toBe(10);
    }
  });

  it('reports an empty remote roster without inventing a host', async () => {
    const lines: string[] = [];
    const cli = new Command();
    registerUsageCommand(cli, {
      readRunLogs: () => [row({ runId: 'r', model: 'm', inputTokens: 5 })],
      usageHosts: () => ({ local: 'mbp', remote: [] }),
      ssh: () => { throw new Error('unexpected SSH'); },
      out: { log: (line) => lines.push(line) },
    });
    await cli.parseAsync(['usage', 'runs', '--hosts', 'all', '--by', 'model', '--json'], { from: 'user' });
    const report = JSON.parse(lines[0]!);
    expect(report.hosts).toEqual([{ host: 'mbp', status: 'ok' }]);
    expect(report).toMatchObject({ complete: false, reason: 'taskAgent.parentHost 설정 없음' });
    expect(report.rows[0].inputTokens).toBe(5);
  });

  it('does not count local usage twice when the local host identity is missing', async () => {
    const lines: string[] = [];
    const cli = new Command();
    registerUsageCommand(cli, {
      readRunLogs: () => [row({ runId: 'r', model: 'm', inputTokens: 5 })],
      usageHosts: () => ({ local: '', remote: ['mbp'] }),
      ssh: () => { throw new Error('unexpected SSH'); },
      out: { log: (line) => lines.push(line) },
    });
    await cli.parseAsync(['usage', 'runs', '--hosts', 'all', '--by', 'model', '--json'], { from: 'user' });
    expect(JSON.parse(lines[0]!)).toMatchObject({ rows: [], hosts: [
      { host: 'mbp', status: 'unmeasured', reason: '로컬 식별 불가로 조회 중지' },
    ], complete: false });
    expect(JSON.parse(lines[0]!).reason).toContain('hq.hostName');
  });

  it('does not treat a remote missing logs.db as zero measured usage', async () => {
    const lines: string[] = [];
    const cli = new Command();
    registerUsageCommand(cli, {
      readRunLogs: () => [],
      usageHosts: () => ({ local: 'mbp', remote: ['node-b'] }),
      ssh: (_host, script) => {
        expect(script).toContain('test -f "$HOME"/.elanous/logs/logs.db');
        return { status: 68, stdout: '', stderr: 'usage-store-missing' };
      },
      out: { log: (line) => lines.push(line) },
    });
    await cli.parseAsync(['usage', 'runs', '--hosts', 'all', '--by', 'model', '--json'], { from: 'user' });
    expect(JSON.parse(lines[0]!)).toMatchObject({ complete: false, hosts: [
      { host: 'mbp', status: 'ok' }, { host: 'node-b', status: 'unmeasured', reason: '원격 logs.db 없음' },
    ] });
  });

  it('combines the local store with configured remote hosts and marks an SSH failure as an incomplete partial sum', async () => {
    const lines: string[] = [];
    const calls: Array<{ host: string; script: string; timeoutMs: number }> = [];
    const cli = new Command();
    registerUsageCommand(cli, {
      readRunLogs: () => [row({ runId: 'r', model: 'm', hostId: 'pod-mbp', inputTokens: 5, cost: { kind: 'known', usd: 0.5 } })],
      usageHosts: () => ({ local: 'mbp', remote: ['node-b', 'node-c'] }),
      ssh: (host, script, timeoutMs) => {
        calls.push({ host, script, timeoutMs });
        return host === 'node-b'
          ? { status: 0, stdout: JSON.stringify([remoteModel]), stderr: '' }
          : { status: 255, stdout: '', stderr: 'connection refused' };
      },
      out: { log: (line) => lines.push(line) },
    });
    await cli.parseAsync(['usage', 'runs', '--hosts', 'all', '--by', 'model', '--since', '2026-10-14T00:00:00Z', '--json'], { from: 'user' });
    const report = JSON.parse(lines[0]!);
    expect(report.complete).toBe(false);
    expect(report.hosts).toEqual([
      { host: 'mbp', status: 'ok' }, { host: 'node-b', status: 'ok' },
      { host: 'node-c', status: 'unmeasured', reason: 'SSH/원격 명령 rc=255' },
    ]);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ model: 'm', calls: 3, inputTokens: 25, usdKnown: 2, hostIds: ['pod-mbp', 'pod-node-b'] });
    expect(calls.map((call) => call.host)).toEqual(['node-b', 'node-c']);
    expect(calls.every((call) => call.timeoutMs === 20_000 && call.script.includes('usage runs --by model --json --since 2026-10-14T00:00:00.000Z'))).toBe(true);
    expect(calls.every((call) => !call.script.includes('--hosts'))).toBe(true);
  });

  it('reports invalid JSON and timeout as unmeasured, including in text, while local JSON stays an array', async () => {
    const lines: string[] = [];
    const deps = {
      readRunLogs: () => [row({ runId: 'r', model: 'm', inputTokens: 5 })],
      usageHosts: () => ({ local: 'mbp', remote: ['node-b', 'node-c'] }),
      ssh: (host: string) => host === 'node-b'
        ? { status: 0, stdout: '{broken', stderr: '' }
        : { status: null, stdout: '', stderr: 'timeout' },
      out: { log: (line: string) => lines.push(line) },
    };
    const local = new Command();
    registerUsageCommand(local, deps);
    await local.parseAsync(['usage', 'runs', '--json'], { from: 'user' });
    expect(Array.isArray(JSON.parse(lines[0]!))).toBe(true);
    lines.length = 0;
    const federated = new Command();
    registerUsageCommand(federated, deps);
    await federated.parseAsync(['usage', 'runs', '--hosts', 'all'], { from: 'user' });
    expect(lines.join('\n')).toContain('부분 합계');
    expect(lines.join('\n')).toContain('node-b: 못 잼');
    expect(lines.join('\n')).toContain('node-c: 못 잼');
  });

  it('does not present an unreadable local store as zero usage', async () => {
    const lines: string[] = [];
    const cli = new Command();
    registerUsageCommand(cli, {
      readRunLogs: () => { throw new Error('database is locked'); },
      usageHosts: () => ({ local: 'mbp', remote: ['node-b'] }),
      ssh: () => ({ status: 0, stdout: JSON.stringify([remoteModel]), stderr: '' }),
      out: { log: (line) => lines.push(line) },
    });
    await cli.parseAsync(['usage', 'runs', '--hosts', 'all', '--by', 'model', '--json'], { from: 'user' });
    const report = JSON.parse(lines[0]!);
    expect(report.complete).toBe(false);
    expect(report.hosts[0]).toEqual({ host: 'mbp', status: 'unmeasured', reason: '로컬 logs.db 조회 실패' });
    expect(report.rows[0]).toMatchObject({ model: 'm', calls: 2, inputTokens: 20 });
  });

  it('rejects a syntactically valid but incomplete remote summary', async () => {
    const lines: string[] = [];
    const cli = new Command();
    registerUsageCommand(cli, {
      readRunLogs: () => [],
      usageHosts: () => ({ local: 'mbp', remote: ['node-b'] }),
      ssh: () => ({ status: 0, stdout: JSON.stringify([{ model: 'm', calls: 9 }]), stderr: '' }),
      out: { log: (line) => lines.push(line) },
    });
    await cli.parseAsync(['usage', 'runs', '--hosts', 'all', '--by', 'model', '--json'], { from: 'user' });
    expect(JSON.parse(lines[0]!)).toMatchObject({ complete: false, rows: [], hosts: [
      { host: 'mbp', status: 'ok' }, { host: 'node-b', status: 'unmeasured', reason: '원격 JSON 형식 오류' },
    ] });
  });
});
