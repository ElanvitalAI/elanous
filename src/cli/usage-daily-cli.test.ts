import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerUsageDailyCommand } from './usage-daily-cli.js';
import type { DailyUsageRow, UsageDailyRead } from '../budget/usage-daily-store.js';
import { LogStore } from '../mss/logging/log-store.js';

const base: DailyUsageRow = { day: '2026-10-14', hour: '2026-10-14T12', role: 'implement', stage: 'implement', account: '(none)',
  model: 'gpt-6-sol', billingProvider: 'openai-codex', billing: 'subscription', site: 'agent-turn', hostId: 'h1',
  calls: 2, inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 1, cacheCreationInputTokens: 0,
  reasoningOutputTokens: 0, usdKnown: 0, unknownCostCalls: 0, includedCalls: 2, apiEquivalentUsd: 0.5 };

async function call(args: string[], read: () => UsageDailyRead | null) {
  const output: string[] = [];
  const exits: number[] = [];
  const command = new Command();
  command.command('usage');
  registerUsageDailyCommand(command, { path: () => '/isolated/logs.db', read,
    out: (line) => output.push(line), exit: (code) => exits.push(code) });
  await command.parseAsync(['usage', 'daily', ...args], { from: 'user' });
  return { output, exits };
}

test('usage daily is read-only and groups a chosen day/model without changing usage runs', async () => {
  const result = await call(['--by', 'model', '--since', '2026-10-14', '--json'], () => ({
    rows: [base, { ...base, role: 'review', calls: 1, inputTokens: 4, apiEquivalentUsd: 0.2 }],
    podObservedRows: 3, unclassifiedRows: 0, sourceMaxId: 12 }));
  expect(result.exits).toEqual([]);
  expect(JSON.parse(result.output[0]!)).toMatchObject({ status: 'partial', hostStatus: 'measured-within-current-logs-horizon',
    podStatus: 'unmeasured', podObservedRows: 3, by: 'model',
    scope: { source: 'current-logs-db', sinceDay: '2026-10-14', timeZone: 'UTC' },
    rows: [{ period: '2026-10-14', key: 'gpt-6-sol', calls: 3, inputTokens: 14, apiEquivalentUsd: 0.7 }] });
  const hourly = await call(['--period', 'hour', '--by', 'model', '--json'], () => ({
    rows: [base, { ...base, hour: '2026-10-14T13', inputTokens: 4 }],
    podObservedRows: 0, unclassifiedRows: 0, sourceMaxId: 12 }));
  expect(JSON.parse(hourly.output[0]!).rows).toMatchObject([
    { period: '2026-10-14T12', inputTokens: 10 }, { period: '2026-10-14T13', inputTokens: 4 },
  ]);
  const human = await call([], () => ({ rows: [base], podObservedRows: 0, unclassifiedRows: 0, sourceMaxId: 12 }));
  expect(human.output[0]).toContain('현재 logs.db에 남은 로그 · UTC');
  expect(human.output[1]).toContain('Pod 사용량: 측정 불가');
  const humanSince = await call(['--since', '2026-10-14'], () => ({ rows: [base], podObservedRows: 2,
    unclassifiedRows: 0, sourceMaxId: 12 }));
  expect(humanSince.output[0]).toContain('2026-10-14 이후');
  expect(humanSince.output[1]).toContain('위 범위에서 2행 관측');
  const missing = await call(['--json'], () => null);
  expect(missing.exits).toEqual([1]);
  expect(JSON.parse(missing.output[0]!)).toMatchObject({ status: 'unmeasured', podStatus: 'unmeasured',
    reason: 'logs-db-missing', scope: { source: 'current-logs-db', sinceDay: null, timeZone: 'UTC' } });
  const missingText = await call([], () => null);
  expect(missingText.exits).toEqual([1]);
  expect(missingText.output).toEqual([expect.stringContaining('logs.db 없음 · UTC')]);
  const unreadableText = await call([], () => { throw new Error('sqlite busy'); });
  expect(unreadableText.exits).toEqual([1]);
  expect(unreadableText.output).toEqual([expect.stringContaining('logs.db 읽기 실패 · UTC')]);
  const unreadableJson = await call(['--json'], () => { throw new Error('sqlite busy'); });
  expect(JSON.parse(unreadableJson.output[0]!)).toMatchObject({ status: 'unmeasured', podStatus: 'unmeasured',
    reason: 'logs-db-unreadable', detail: 'Error: sqlite busy' });
});

test('usage daily invalid options keep JSON output machine-readable and exit 2', async () => {
  for (const args of [['--period', 'week'], ['--by', 'provider'], ['--since', '2026-02-30']]) {
    const result = await call([...args, '--json'], () => { throw new Error('source must not be opened'); });
    expect(result.exits).toEqual([2]);
    expect(result.output).toHaveLength(1);
    expect(JSON.parse(result.output[0]!)).toMatchObject({ status: 'error', reason: 'invalid-arguments' });
  }
});

test('usage daily command opens the real logs DB read-only and leaves source rows intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-daily-cli-'));
  const path = join(root, 'logs', 'logs.db');
  const logs = new LogStore(path);
  try {
    logs.insertBatch([{ rec: { ts: '2026-10-14T12:00:00Z', category: 'llm.usage', event: 'usage-other',
      data: { model: 'm', inputTokens: 8 } }, surface: 'harness' }]);
    const output: string[] = [];
    const command = new Command();
    command.command('usage');
    registerUsageDailyCommand(command, { path: () => path, out: (line) => output.push(line) });
    await command.parseAsync(['usage', 'daily', '--json'], { from: 'user' });
    expect(JSON.parse(output[0]!)).toMatchObject({ status: 'partial', podStatus: 'unmeasured',
      rows: [{ period: '2026-10-14', inputTokens: 8 }] });
    expect(logs.query({ exactCategories: ['llm.usage'], limit: 100 })).toHaveLength(1);
    expect(existsSync(join(root, 'budget'))).toBe(false);
  } finally { logs.close(); rmSync(root, { recursive: true, force: true }); }
});
