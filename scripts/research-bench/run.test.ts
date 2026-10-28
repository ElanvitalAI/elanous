import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_CATALOG } from '../../src/intelligence-map/model-catalog.js';
import { buildPrompt, buildResumeEvent, claudeAuthSummary, completedCallKeys, execute, makeRunPlan, nextClaudeExitOneCount, processTimedOutInvocation, shouldSkipCallAfterClaudeFailures, usageCostUsd, validateCliArgs, validateConfig, validateQuestions, verifyConfiguredBaseline, type AdapterConfig } from './run.js';

const questions = validateQuestions(JSON.parse(readFileSync(fileURLToPath(new URL('./questions.json', import.meta.url)), 'utf8')));
const adapter = {
  command: 'unused', args: ['ELANOUS_STATE_DIR=/tmp/fixture-state', '{prompt}', '--question', '{questionId}', '--run', '{runId}', '--cell', '{cellId}', '--bloom', '{bloomCeiling}', '--layout', '{layout}'],
  model: 'fixture-model', toolPolicyId: 'readonly-web-v1', maxTurns: 8, timeoutMs: 60_000,
  usageSource: 'elanous-logs' as const, usageCommand: 'eln', usageArgs: ['logs', '--session', '{sessionId}', '--category', 'llm.usage'],
};
const pairedCell = () => ({ description: 'test cell', elanous: { ...adapter }, claudeCode: { ...adapter, usageSource: 'claude-stream-json' as const, usageCommand: undefined, usageArgs: undefined } });
const config: AdapterConfig = { version: 2, baselineProbe: { command: '/bin/echo', args: ['0.2.38-dev.0', 'f'.repeat(40)] }, cells: {
  A0: pairedCell(), A1: pairedCell(), A2: pairedCell(), A3: pairedCell(),
  B: { description: 'product', elanous: { ...adapter, model: 'best-config' }, claudeCode: { ...adapter, model: 'default', usageSource: 'claude-stream-json' as const, usageCommand: undefined, usageArgs: undefined } },
  P1: { description: 'linear', elanous: { ...adapter } },
  P5: { description: 'recommended', elanous: { ...adapter } },
  'P5-no-front6': { description: 'without front 6', elanous: { ...adapter } },
} };

describe('research benchmark plan', () => {
  test('covers ten balanced research questions and all six Bloom stages', () => {
    expect(questions).toHaveLength(10);
    expect(new Set(questions.map(q => q.domain))).toEqual(new Set(['finance', 'technology', 'market']));
    expect(new Set(questions.flatMap(q => q.bloom))).toEqual(new Set(['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create']));
    expect(questions.filter(q => q.requiresHigherOrder && q.bloom.some(stage => stage === 'analyze' || stage === 'evaluate')).length).toBeGreaterThanOrEqual(4);
  });

  test('plans pilot and full Bloom/layout matrix and alternates paired harness order', () => {
    validateConfig(config, 200);
    const pilot = makeRunPlan(questions, config, 'fixture-run', true);
    const full = makeRunPlan(questions, config, 'fixture-run');
    expect(pilot.calls).toHaveLength(39);
    expect([...new Set(pilot.calls.map(call => call.questionId))].sort()).toEqual(['finance-01-kgb-10y', 'market-01-enterprise-research-agents', 'technology-01-hbm4']);
    expect(full.calls).toHaveLength(130);
    expect([...new Set(pilot.calls.map(c => c.domain))].sort()).toEqual(['finance', 'market', 'technology']);
    expect(full.calls.filter(c => c.cell.startsWith('P')).every(c => c.harness === 'elanous')).toBe(true);
    expect(full.calls.filter(c => c.cell === 'A2').map(c => c.bloomCeiling)).toEqual(Array(20).fill(5));
    expect(pilot.phase).toBe('pilot');
    expect(full.apiCalls).toBe(80);
    const smoke = makeRunPlan(questions, config, 'fixture-smoke', false, 3);
    expect(smoke.calls).toHaveLength(6);
    expect(new Set(smoke.calls.map(call => call.cell))).toEqual(new Set(['A0']));
    expect(new Set(smoke.calls.map(call => call.questionId))).toEqual(new Set(['finance-01-kgb-10y', 'technology-01-hbm4', 'market-01-enterprise-research-agents']));
    expect(smoke.apiCalls).toBe(3);
    expect(smoke.phase).toBe('execution-validation-smoke');
  });

  test('requires matching controlled arms while allowing product comparison defaults to differ', () => {
    validateConfig(config, 200);
    expect(() => validateConfig({ ...config, cells: { ...config.cells, A0: { ...config.cells.A0, claudeCode: { ...adapter, model: 'other-model', usageSource: 'claude-stream-json' as const } } } }, 200)).toThrow(/matching model/);
    expect(() => validateConfig({ ...config, cells: { ...config.cells, A0: { ...config.cells.A0, claudeCode: { ...adapter, usageSource: 'claude-stream-json' as const, toolPolicyId: 'different-tools' } } } }, 200)).toThrow(/matching model/);
  });

  test('requires isolated session-state args for recoverable Elanous adapters', () => {
    const invalid: AdapterConfig = { ...config, cells: { ...config.cells, A0: { ...config.cells.A0, elanous: { ...adapter, args: ['{prompt}'] } } } };
    expect(() => validateConfig(invalid, 200)).toThrow(/isolated ELANOUS_STATE_DIR/);
  });

  test('verifies the executed baseline reports the requested commit', async () => {
    expect(await verifyConfiguredBaseline(config, 'f'.repeat(40))).toContain('f'.repeat(40));
    await expect(verifyConfiguredBaseline(config, 'e'.repeat(40))).rejects.toThrow(/did not report/);
  }, 30_000);

  test('caps approved total API spend at $200 and calculates Opus usage from official rates', () => {
    expect(() => validateConfig(config, 200.01)).toThrow(/\$200 maximum/);
    expect(() => validateConfig(config, 159.99)).toThrow(/\$160 stop threshold/);
    expect(() => validateConfig(config)).not.toThrow();
    const opusModel = BUILTIN_CATALOG.models.find(model => model.provider === 'anthropic' && model.inputPerMtok === 4 && model.outputPerMtok === 20)?.id;
    expect(opusModel).toBeDefined();
    expect(usageCostUsd({ model: opusModel!, inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 }, { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5, sourceUrl: 'official' })).toBeCloseTo(29.2);
    expect(() => usageCostUsd({ model: 'unknown-model', inputTokens: 1, outputTokens: 1 })).toThrow(/no complete catalog price/);
  });

  test('adds cumulative Bloom directives and distinct layout procedures without changing the question', () => {
    const q = questions[0];
    const baseline = buildPrompt(q, { cell: 'A0', bloomCeiling: 0, layout: 'baseline' }, '2026-10-25');
    const stages1to3 = buildPrompt(q, { cell: 'A1', bloomCeiling: 3, layout: 'baseline' }, '2026-10-25');
    const p5 = buildPrompt(q, { cell: 'P5', bloomCeiling: 6, layout: 'p5-front6-parallel-bottom-loop-4-5' }, '2026-10-25');
    expect(baseline).toContain(q.prompt);
    expect(baseline).not.toContain('Structure the work explicitly');
    expect(stages1to3).toContain('stages 1–3');
    expect(p5).toContain('reverse-design the target answer');
    expect(p5).toContain('central stage 4/5 loop');
  });

  test('accepts option values such as paths and rejects unknown or conflicting flags', () => {
    expect(() => validateCliArgs(['--live', '--pilot', '--baseline-sha', 'f'.repeat(40), '--config', '/tmp/config.json', '--max-total-cost-usd', '200', '--out', '/tmp/evidence'])).not.toThrow();
    expect(() => validateCliArgs(['--live', '--pilot', '--baseline-sha', 'f'.repeat(40), '--config', '/tmp/config.json', '--max-total-cost-usd', '200', '--resume', 'fixture-run', '--out', '/tmp/evidence'])).not.toThrow();
    expect(() => validateCliArgs(['--live', '--pilot', '--baseline-sha', 'f'.repeat(40), '--config', '/tmp/config.json', '--no-cost-cap', '--approval-ref', 'OP#42096', '--out', '/tmp/evidence'])).not.toThrow();
    expect(() => validateCliArgs(['--live', '--smoke-pairs', '3', '--baseline-sha', 'f'.repeat(40), '--config', '/tmp/config.json', '--no-cost-cap', '--approval-ref', 'OP#42096', '--out', '/tmp/evidence'])).not.toThrow();
    expect(() => validateCliArgs(['--live', '--pilot', '--baseline-sha', 'f'.repeat(40), '--config', '/tmp/config.json', '--max-total-cost-usd', '200', '--no-cost-cap', '--out', '/tmp/evidence'])).toThrow(/conflicts/);
    expect(() => validateCliArgs(['--live', '--pilot', '--baseline-sha', 'f'.repeat(40), '--config', '/tmp/config.json', '--no-cost-cap', '--out', '/tmp/evidence'])).toThrow(/--approval-ref/);
    expect(() => validateCliArgs(['--live', '--config', '/tmp/config.json', '--max-total-cost-usd', '200', '--out', '/tmp/evidence'])).toThrow(/exactly one/);
    expect(() => validateCliArgs(['--live', '--pilot', '--config', '/tmp/config.json', '--max-total-cost-usd', '200', '--out', '/tmp/evidence'])).toThrow(/baseline-sha/);
    expect(() => validateCliArgs(['--live', '--smoke-pairs', '0', '--baseline-sha', 'f'.repeat(40), '--config', '/tmp/config.json', '--max-total-cost-usd', '200', '--out', '/tmp/evidence'])).toThrow(/from 1 to 3/);
    expect(() => validateCliArgs(['--live', '--smoke-pairs', '4', '--baseline-sha', 'f'.repeat(40), '--config', '/tmp/config.json', '--max-total-cost-usd', '200', '--out', '/tmp/evidence'])).toThrow(/from 1 to 3/);
    expect(() => validateCliArgs(['--live', '--pilot', '--config', '/tmp/config.json', '--out', '/tmp/evidence'])).toThrow(/requires --max-total-cost-usd or --no-cost-cap/);
    expect(() => validateCliArgs(['--live', '--config', '/tmp/config.json', '--out'])).toThrow(/requires a value/);
    expect(() => validateCliArgs(['--pilot', '--full'])).toThrow(/mutually exclusive/);
    expect(() => validateCliArgs(['--resume', 'fixture-run'])).toThrow(/requires --live/);
    expect(() => validateCliArgs(['--live', '--surprise'])).toThrow(/unknown argument/);
  });

  test('resume treats a recorded failure as terminal and will not bill that call again', () => {
    const keys = completedCallKeys([
      { questionId: 'q1', cell: 'A0', harness: 'elanous', exitCode: 0 },
      { questionId: 'q1', cell: 'A1', harness: 'claudeCode', exitCode: 1, error: 'claudeCode exited 1: ' },
    ]);
    expect(keys.has('q1:A0:elanous')).toBe(true);
    expect(keys.has('q1:A1:claudeCode')).toBe(true);
    expect(keys.has('q1:A1:elanous')).toBe(false);
  });

  test('resume manifest event records the prior result and accounting boundary', () => {
    const event = buildResumeEvent([
      { questionId: 'q1', cell: 'A0', harness: 'elanous', exitCode: 0 },
      { questionId: 'q1', cell: 'A1', harness: 'claudeCode', exitCode: 1, error: 'exit 1' },
    ], { runId: 'fixture-run', maxApiSpendUsd: 200, stopBeforeNextPairAtUsd: 160, cumulativeApiSpendUsd: 4.25, accountingIncomplete: true, records: [] }, '2026-10-26T10:00:00.000Z');
    expect(event).toEqual({ at: '2026-10-26T10:00:00.000Z', savedCallCount: 2, savedFailureCount: 1, apiSpendUsd: 4.25, accountingIncomplete: true });
  });

  test('three Claude Code exit 1s are consecutive per configuration and any other exit resets the streak', () => {
    expect(nextClaudeExitOneCount(0, 1)).toBe(1);
    expect(nextClaudeExitOneCount(1, 1)).toBe(2);
    expect(nextClaudeExitOneCount(2, 1)).toBe(3);
    expect(nextClaudeExitOneCount(2, 0)).toBe(0);
  });

  test('after three Claude Code exit 1s, skips only Claude Code and preserves its paired Elanous calls', () => {
    const skippedCells = new Set(['A0']);
    expect(shouldSkipCallAfterClaudeFailures('claudeCode', 'A0', skippedCells)).toBe(true);
    expect(shouldSkipCallAfterClaudeFailures('elanous', 'A0', skippedCells)).toBe(false);
    expect(shouldSkipCallAfterClaudeFailures('claudeCode', 'A3', skippedCells)).toBe(false);
  });

  test('failure diagnostics retain auth state without retaining account identifiers', () => {
    expect(claudeAuthSummary(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', emailAddress: 'private@example.com', token: 'secret' })))
      .toEqual({ loggedIn: true, authMethod: 'oauth_token' });
    expect(claudeAuthSummary('not-json')).toEqual({ parseError: 'claude auth status returned non-JSON output' });
  });

  test('preserves partial output and returns control after an adapter timeout', async () => {
    const result = await execute(process.execPath, ['-e', "process.stdout.write('partial-answer'); setTimeout(() => {}, 8000)"], 2_000);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe('partial-answer');
    expect(result.durationMs).toBeGreaterThanOrEqual(2_000);
    expect(result.code).toBeNull();
  });

  test('passes env assignments to child processes and writes recovered timeout evidence and usage', async () => {
    const env = await execute('/usr/bin/env', ['RESEARCH_BENCH_FIXTURE=passed', process.execPath, '-e', "process.stdout.write(process.env.RESEARCH_BENCH_FIXTURE ?? '')"], 2_000);
    expect(env.code).toBe(0);
    expect(env.stdout).toBe('passed');
    const directEnv = await execute(process.execPath, ['ELANOUS_STATE_DIR=/tmp/fixture-direct', '-e', "process.stdout.write(JSON.stringify([process.env.ELANOUS_STATE_DIR, ...process.argv.slice(1)]))", 'RESEARCH_BENCH_FIXTURE=keep-as-arg'], 2_000);
    expect(directEnv.code).toBe(0);
    expect(JSON.parse(directEnv.stdout)).toEqual(['/tmp/fixture-direct', 'RESEARCH_BENCH_FIXTURE=keep-as-arg']);

    const root = await mkdtemp(join(tmpdir(), 'research-bench-timeout-'));
    try {
      const stateRoot = join(root, 'state');
      const sessionsRoot = join(stateRoot, 'sessions');
      const outDir = join(root, 'evidence');
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(outDir, { recursive: true });
      const startedAt = new Date(Date.now() - 1_000).toISOString();
      const sessionId = 'fixture-timeout-session';
      await writeFile(join(sessionsRoot, 'index.json'), JSON.stringify([{ id: sessionId, createdAt: startedAt }]) + '\n');
      await writeFile(join(sessionsRoot, `${sessionId}.jsonl`), JSON.stringify({ role: 'assistant', content: 'recovered final answer' }) + '\n');
      const usage = { session_id: sessionId, event: 'llm-usage', data: { model: 'fixture-model', inputTokens: 1_000_000, outputTokens: 100, billing: 'api', cost: { kind: 'unknown' } } };
      const timeoutAdapter = { ...adapter, args: [`ELANOUS_STATE_DIR=${stateRoot}`], usageCommand: '/bin/echo', usageArgs: [JSON.stringify(usage).replace(sessionId, '{sessionId}')], officialPricing: { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0, cacheWritePerM: 0, sourceUrl: 'fixture-price' } };
      const records: Record<string, unknown>[] = [];
      const ledger = { runId: 'timeout-success', maxApiSpendUsd: null, stopBeforeNextPairAtUsd: null, cumulativeApiSpendUsd: 0, records: [] as unknown[] };
      const result = { stdout: 'partial stdout', stderr: 'timed out', code: null, durationMs: 900_000, timedOut: true };
      const outcome = await processTimedOutInvocation({ adapter: timeoutAdapter, args: timeoutAdapter.args, call: { questionId: 'q1', cell: 'A0', harness: 'elanous' }, prompt: 'fixture prompt', startedAt, result, outDir, records, ledger });
      expect(outcome.stop).toBe(false);
      const savedResult = JSON.parse(await readFile(join(outDir, 'timeout-success.results.json'), 'utf8'))[0];
      const savedLedger = JSON.parse(await readFile(join(outDir, 'timeout-success.ledger.json'), 'utf8'));
      expect(savedResult.timedOut).toBe(true);
      expect(savedResult.sessionId).toBe(sessionId);
      expect(savedResult.recoveredAnswer).toBe('recovered final answer');
      expect(savedResult.recoveredAnswerSource).toBe('isolated-session-final-assistant-message');
      expect(savedResult.apiSpendUsd).toBeCloseTo(4.002);
      expect(savedLedger.cumulativeApiSpendUsd).toBeCloseTo(4.002);
      expect(savedLedger.records[0].cumulativeApiSpendUsd).toBeCloseTo(4.002);
      expect(savedLedger.records[0].sessionId).toBe(sessionId);
      expect(savedLedger.accountingIncomplete).toBeUndefined();
      expect(savedLedger.records[0].usage[0].billing).toBe('api');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('stops and marks the ledger incomplete when timed-out usage cannot be recovered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-bench-usage-error-'));
    try {
      const stateRoot = join(root, 'state');
      const sessionsRoot = join(stateRoot, 'sessions');
      const outDir = join(root, 'evidence');
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(outDir, { recursive: true });
      const startedAt = new Date(Date.now() - 1_000).toISOString();
      const sessionId = 'fixture-no-usage-session';
      await writeFile(join(sessionsRoot, 'index.json'), JSON.stringify([{ id: sessionId, createdAt: startedAt }]) + '\n');
      const usageAdapter = { ...adapter, args: [`ELANOUS_STATE_DIR=${stateRoot}`], usageCommand: '/usr/bin/false', usageArgs: ['logs', '--session', '{sessionId}'] };
      const records: Record<string, unknown>[] = [];
      const ledger = { runId: 'timeout-usage-error', maxApiSpendUsd: null, stopBeforeNextPairAtUsd: null, cumulativeApiSpendUsd: 0, records: [] as unknown[] };
      const outcome = await processTimedOutInvocation({ adapter: usageAdapter, args: usageAdapter.args, call: { questionId: 'q1', cell: 'A0', harness: 'elanous' }, prompt: 'fixture prompt', startedAt, result: { stdout: 'partial', stderr: '', code: null, durationMs: 900_000, timedOut: true }, outDir, records, ledger });
      expect(outcome.stop).toBe(true);
      const savedResult = JSON.parse(await readFile(join(outDir, 'timeout-usage-error.results.json'), 'utf8'))[0];
      const savedLedger = JSON.parse(await readFile(join(outDir, 'timeout-usage-error.ledger.json'), 'utf8'));
      expect(savedResult.usageError).toContain('exited 1');
      expect(savedLedger.accountingIncomplete).toBe(true);
      expect(savedLedger.records[0].usageError).toContain('exited 1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not recover a session created before the current invocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-bench-stale-session-'));
    try {
      const stateRoot = join(root, 'state');
      const sessionsRoot = join(stateRoot, 'sessions');
      const outDir = join(root, 'evidence');
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(outDir, { recursive: true });
      const startedAt = new Date().toISOString();
      const previousSessionId = 'fixture-previous-session';
      const previousCreatedAt = new Date(Date.parse(startedAt) - 1_000).toISOString();
      await writeFile(join(sessionsRoot, 'index.json'), JSON.stringify([{ id: previousSessionId, createdAt: previousCreatedAt }]) + '\n');
      await writeFile(join(sessionsRoot, `${previousSessionId}.jsonl`), JSON.stringify({ role: 'assistant', content: 'stale answer' }) + '\n');
      const staleAdapter = { ...adapter, args: [`ELANOUS_STATE_DIR=${stateRoot}`], usageCommand: '/bin/false', usageArgs: ['logs', '--session', '{sessionId}'] };
      const records: Record<string, unknown>[] = [];
      const ledger = { runId: 'stale-session', maxApiSpendUsd: null, stopBeforeNextPairAtUsd: null, cumulativeApiSpendUsd: 0, records: [] as unknown[] };
      const outcome = await processTimedOutInvocation({ adapter: staleAdapter, args: staleAdapter.args, call: { questionId: 'q1', cell: 'A0', harness: 'elanous' }, prompt: 'fixture prompt', startedAt, result: { stdout: 'partial', stderr: '', code: null, durationMs: 900_000, timedOut: true }, outDir, records, ledger });
      expect(outcome.stop).toBe(true);
      const saved = JSON.parse(await readFile(join(outDir, 'stale-session.results.json'), 'utf8'))[0];
      expect(saved.sessionId).toBeUndefined();
      expect(saved.recoveredAnswer).toBeUndefined();
      expect(saved.usageError).toContain('session index did not include sessionId');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
