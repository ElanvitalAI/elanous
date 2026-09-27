import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { registerUsageCommand } from '../cli/usage-cli.js';
import type { LogStoreRow } from '../mss/logging/log-store.js';
import { rollupRunUsage, type RunUsageInput } from './run-usage-rollup.js';

const usageInputs: RunUsageInput[] = [
  { runId: 'A', site: 'stream-llm', role: 'classify', model: 'm', billingProvider: 'p', billing: 'api', hostId: 'h1', inputTokens: 10, outputTokens: 2, cost: { kind: 'known', usd: 1 } },
  { runId: 'A', site: 'agent-turn', role: 'implement', model: 'm', billingProvider: 'p', billing: 'api', hostId: 'h1', inputTokens: 3, cost: { kind: 'included', apiEquivalentUsd: 0.5 } },
  { runId: 'A', site: 'agent-turn', role: 'implement', model: 'm', billingProvider: 'p', billing: 'api', hostId: 'h2', inputTokens: 4, cost: { kind: 'partial', usd: 0.25 } },
  { runId: 'B', site: 'stream-llm', role: 'classify', model: 'm', billingProvider: 'p', billing: 'api', hostId: 'h3', outputTokens: 5, cost: { kind: 'actual', usd: 2 } },
  { runId: 'B', site: 'agent-turn', model: 'm', billingProvider: 'p', billing: 'api', hostId: 'h3' },
];

function logRow(data: RunUsageInput, id: number): LogStoreRow {
  return { id, ts: '2026-09-27T00:00:00Z', ts_ms: Date.parse('2026-09-27T00:00:00Z'),
    level: 'info', instance: 'test', surface: 'tui', category: 'llm.usage', event: 'llm-usage',
    session_id: null, trace_id: null, data: JSON.stringify(data) };
}

async function usageRuns(args: string[], readRunLogs: (query: { sinceMs?: number }) => LogStoreRow[]) {
  const lines: string[] = [];
  const command = new Command();
  registerUsageCommand(command, { readRunLogs, out: { log: (line) => lines.push(line) },
    exit: (code) => { throw new Error(`exit ${code}`); } });
  await command.parseAsync(['usage', 'runs', ...args], { from: 'user' });
  return lines;
}

describe('rollupRunUsage', () => {
  it('groups by the complete run/model/billing-provider/billing tuple and collects distinct hosts', () => {
    const rows = rollupRunUsage([
      { runId: 'run', model: 'm', billingProvider: 'gateway', billing: 'api', hostId: 'h1', inputTokens: 2, outputTokens: 3, cost: { kind: 'actual', usd: 1 } },
      { runId: 'run', model: 'm', billingProvider: 'gateway', billing: 'api', hostId: 'h2', inputTokens: 5, outputTokens: 7, cost: { kind: 'known', usd: 2 } },
      { runId: 'run', model: 'm', billingProvider: 'gateway', billing: 'api', hostId: 'h1', cacheReadInputTokens: 11, cacheCreationInputTokens: 13, reasoningOutputTokens: 17, cost: { kind: 'partial', usd: 0.5 } },
      { runId: 'other', model: 'm', billingProvider: 'gateway', billing: 'api' },
      { runId: 'run', model: 'other', billingProvider: 'gateway', billing: 'api' },
      { runId: 'run', model: 'm', billingProvider: 'other', billing: 'api' },
      { runId: 'run', model: 'm', billingProvider: 'gateway', billing: 'subscription', cost: { kind: 'included', usd: 0, apiEquivalentUsd: 4 } },
    ]);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      runId: 'run', model: 'm', billingProvider: 'gateway', billing: 'api', hostIds: ['h1', 'h2'],
      calls: 3, inputTokens: 7, outputTokens: 10, cacheReadInputTokens: 11,
      cacheCreationInputTokens: 13, reasoningOutputTokens: 17,
      usdKnown: 3.5, unknownCostCalls: 1, includedCalls: 0, apiEquivalentUsd: 0,
    });
    expect(rows[4]).toMatchObject({ calls: 1, includedCalls: 1, unknownCostCalls: 0, usdKnown: 0, apiEquivalentUsd: 4 });
  });

  it('uses (none) for absent runId and keeps missing or unknown costs separate from known zero', () => {
    const rows = rollupRunUsage([
      { model: 'm', billingProvider: 'p', billing: 'api', cost: { kind: 'unknown' } },
      { runId: null, model: 'm', billingProvider: 'p', billing: 'api' },
      { model: 'm', billingProvider: 'p', billing: 'api', cost: { kind: 'known', usd: 0 } },
      { model: 'm', billingProvider: 'p', billing: 'api', cost: { kind: 'actual', usd: Number.NaN } },
      { model: 'm', billingProvider: 'p', billing: 'api', inputTokens: Number.NaN, cost: { kind: 'partial', usd: 1.25 } },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: '(none)', calls: 5, hostIds: [], inputTokens: 0, usdKnown: 1.25, unknownCostCalls: 4 });
    expect(rollupRunUsage([])).toEqual([]);
  });

  it('does not collide when tuple components contain separators', () => {
    const rows = rollupRunUsage([
      { runId: 'a|b', model: 'c', billingProvider: 'p', billing: 'api' },
      { runId: 'a', model: 'b|c', billingProvider: 'p', billing: 'api' },
    ]);
    expect(rows).toHaveLength(2);
  });

  it('keeps the default run row shape while role/site groups merge runs and preserve costs', () => {
    expect(rollupRunUsage(usageInputs)).toEqual([
      { runId: 'A', model: 'm', billingProvider: 'p', billing: 'api', hostIds: ['h1', 'h2'], calls: 3,
        inputTokens: 17, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0, usdKnown: 1.25, unknownCostCalls: 1, includedCalls: 1, apiEquivalentUsd: 0.5 },
      { runId: 'B', model: 'm', billingProvider: 'p', billing: 'api', hostIds: ['h3'], calls: 2,
        inputTokens: 0, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0, usdKnown: 2, unknownCostCalls: 1, includedCalls: 0, apiEquivalentUsd: 0 },
    ]);
    expect(rollupRunUsage(usageInputs, { by: 'run' })).toEqual(rollupRunUsage(usageInputs));
    expect(rollupRunUsage(usageInputs, { by: 'role' })).toEqual([
      { runId: '(all)', role: 'classify', site: 'stream-llm', model: 'm', billingProvider: 'p', billing: 'api',
        hostIds: ['h1', 'h3'], calls: 2, inputTokens: 10, outputTokens: 7, cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0, reasoningOutputTokens: 0, usdKnown: 3, unknownCostCalls: 0,
        includedCalls: 0, apiEquivalentUsd: 0 },
      { runId: '(all)', role: 'implement', site: 'agent-turn', model: 'm', billingProvider: 'p', billing: 'api',
        hostIds: ['h1', 'h2'], calls: 2, inputTokens: 7, outputTokens: 0, cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0, reasoningOutputTokens: 0, usdKnown: 0.25, unknownCostCalls: 1,
        includedCalls: 1, apiEquivalentUsd: 0.5 },
      { runId: '(all)', role: '(none)', site: 'agent-turn', model: 'm', billingProvider: 'p', billing: 'api',
        hostIds: ['h3'], calls: 1, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0, reasoningOutputTokens: 0, usdKnown: 0, unknownCostCalls: 1,
        includedCalls: 0, apiEquivalentUsd: 0 },
    ]);
  });

  it('keeps role/site/model/billing tuple components separate', () => {
    const rows = rollupRunUsage([
      { role: null, site: null, model: 'm', billingProvider: 'p', billing: 'api' },
      { role: 'a|b', site: 'c', model: 'm', billingProvider: 'p', billing: 'api' },
      { role: 'a', site: 'b|c', model: 'm', billingProvider: 'p', billing: 'api' },
      { role: 'a|b', site: 'c', model: 'other', billingProvider: 'p', billing: 'api' },
      { role: 'a|b', site: 'c', model: 'm', billingProvider: 'other', billing: 'api' },
      { role: 'a|b', site: 'c', model: 'm', billingProvider: 'p', billing: 'subscription' },
    ], { by: 'role' });
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ runId: '(all)', role: '(none)', site: '(none)', calls: 1 });
  });
});

describe('usage runs --by role', () => {
  const read = () => usageInputs.map(logRow);

  it('prints role and site in descending calls order, and applies --run, --since and --json', async () => {
    const lines = await usageRuns(['--by', 'role'], read);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('classify  stream-llm  m  p/api  calls=2  input=10  output=7  usdKnown=3  unknownCostCalls=0  includedCalls=0  apiEquivalentUsd=0');
    expect(lines[1]).toStartWith('implement  agent-turn  m  p/api  calls=2');
    expect(lines[2]).toStartWith('(none)  agent-turn  m  p/api  calls=1');
    const unsorted = await usageRuns(['--by', 'role'], () => [logRow(usageInputs[4]!, 5), ...usageInputs.slice(0, 4).map(logRow)]);
    expect(unsorted.at(-1)).toStartWith('(none)  agent-turn  m  p/api  calls=1');

    let sinceMs: number | undefined;
    const filtered = await usageRuns(['--by', 'role', '--run', 'A', '--since', '1d', '--json'], (query) => {
      sinceMs = query.sinceMs;
      return read();
    });
    expect(typeof sinceMs).toBe('number');
    expect(sinceMs!).toBeGreaterThan(Date.now() - 86_400_000 - 5_000);
    expect(sinceMs!).toBeLessThanOrEqual(Date.now());
    expect(JSON.parse(filtered[0]!)).toEqual(rollupRunUsage(usageInputs.filter((item) => item.runId === 'A'), { by: 'role' }).sort((a, b) => b.calls - a.calls));
    expect(JSON.parse((await usageRuns(['--by', 'role', '--json'], read))[0]!)).toEqual(rollupRunUsage(usageInputs, { by: 'role' }));
  });

  it('leaves default CLI JSON keys and human run output unchanged', async () => {
    const defaultRows = JSON.parse((await usageRuns(['--json'], read))[0]!);
    expect(defaultRows).toEqual(rollupRunUsage(usageInputs));
    expect(defaultRows.every((item: object) => !('role' in item) && !('site' in item))).toBe(true);
    expect((await usageRuns([], read))[0]).toBe('A  m  p/api  hosts=h1,h2  calls=3  input=17  output=2  cacheRead=0  cacheCreation=0  reasoning=0  usdKnown=1.25  unknownCostCalls=1  includedCalls=1  apiEquivalentUsd=0.5');
  });

  it('rejects unknown axis with exit 2 before reading logs', async () => {
    const lines: string[] = [];
    const command = new Command();
    registerUsageCommand(command, { readRunLogs: () => { throw new Error('read logs'); },
      out: { log: (line) => lines.push(line) }, exit: (code) => { throw new Error(`exit ${code}`); } });
    expect(command.parseAsync(['usage', 'runs', '--by', 'nope'], { from: 'user' })).rejects.toThrow('exit 2');
    expect(lines).toEqual(['⛔ --by 는 run | role']);
  });
});
