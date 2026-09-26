import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { installHarnessCliCommand, runHarnessBudget } from './harness-cli-command.js';
import { decideBudget } from '../self-implement/budget-gate.js';

const repoRoot = resolve(import.meta.dir, '../..');
const ACTIONS = ['proceed', 'next-provider', 'wait-reset', 'stop'] as const;

describe('harness budget CLI', () => {
  test('bun bin/elanous.mjs harness budget --json 은 rc 0 · 마지막 줄 JSON · outcome 넷 중 하나 · reasons 배열', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-budget-cli-'));
    writeFileSync(join(dir, 'config.json'), '{}\n');
    try {
      const result = spawnSync(
        process.execPath,
        ['bin/elanous.mjs', '--test', '--config-dir', dir, 'harness', 'budget', '--json'],
        { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
      );
      expect(result.status).toBe(0);
      const lines = (result.stdout ?? '').split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
      const last = lines.at(-1);
      expect(last).toBeDefined();
      const parsed = JSON.parse(last!) as { outcome?: unknown; reasons?: unknown; provider?: unknown; model?: unknown };
      expect(ACTIONS).toContain(parsed.outcome as typeof ACTIONS[number]);
      expect(Array.isArray(parsed.reasons)).toBe(true);
      expect('provider' in parsed).toBe(true);
      expect('model' in parsed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 130_000);

  test('사람 모드는 한 줄 요약이고 JSON outcome 키를 찍지 않는다', async () => {
    const lines: string[] = [];
    const decision = await runHarnessBudget({ json: false }, {
      log: (line) => { lines.push(line); },
      read: () => ({
        preference: {
          mode: 'auto',
          chain: [{ provider: 'openai-codex' }, { provider: 'grok' }],
          budgetGate: { minHeadroomPercent: 15, onShortfall: 'next-provider', maxUsedPercent: { 'openai-codex': 95, grok: 48 } },
          source: { mode: 'explicit', chain: 'config' },
        },
        codexCandidates: [{ name: 'default', usedPercent: 100 }, { name: 'team', usedPercent: 95 }, { name: 'third', usedPercent: 96 }],
        grokUsedPercent: 7,
        maxUsedPercent: { 'openai-codex': 95, grok: 48 },
      }),
    });
    expect(decision.action).toBe('next-provider');
    expect(decision.provider).toBe('grok');
    expect(lines).toEqual([expect.stringMatching(/^budget: next-provider grok — /)]);
    expect(lines.join('\n')).not.toContain('"outcome"');
  });

  test('--json 마지막 줄은 decideBudget action 을 outcome 으로 싣는다', async () => {
    const lines: string[] = [];
    const inputs = {
      preference: {
        mode: 'auto' as const,
        chain: [{ provider: 'openai-codex' }, { provider: 'grok' }],
        budgetGate: { minHeadroomPercent: 15, onShortfall: 'wait-reset' as const, maxUsedPercent: { 'openai-codex': 95, grok: 48 } },
        source: { mode: 'explicit' as const, chain: 'config' as const },
      },
      codexCandidates: [{ name: 'default', usedPercent: 100 }],
      grokUsedPercent: 49,
      maxUsedPercent: { 'openai-codex': 95, grok: 48 },
    };
    await runHarnessBudget({ json: true }, { log: (line) => { lines.push(line); }, read: () => inputs });
    const parsed = JSON.parse(lines.at(-1)!);
    expect(parsed.outcome).toBe(decideBudget(inputs).action);
    expect(parsed.outcome).toBe('wait-reset');
    expect(parsed.reasons.some((line: string) => line.includes('grok:'))).toBe(true);
  });

  test('installHarnessCliCommand 가 budget 서브커맨드를 단다', () => {
    const program = new Command();
    program.exitOverride();
    installHarnessCliCommand(program, {
      registerSink: async () => {},
      resolveSurface: async () => 'cli',
    });
    const harness = program.commands.find((command) => command.name() === 'harness');
    const budget = harness?.commands.find((command) => command.name() === 'budget');
    expect(budget).toBeDefined();
    expect(budget?.options.some((option) => option.long === '--json')).toBe(true);
  });
});
