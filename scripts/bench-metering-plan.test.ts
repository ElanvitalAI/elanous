import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkBenchMeteringPlan, type BenchMeteringPlan } from './bench-metering-plan.js';

const source = (collector: string) => ({ collector, evidenceRef: `planned:${collector}` });
const arm = (armId: string, provider: 'openrouter' | 'bedrock') => ({
  armId,
  provider,
  billingProvider: provider,
  noAutoMerge: true,
  metrics: {
    actualProvider: source('run-event.provider'),
    actualModel: source('run-event.model'),
    rounds: source('run-ledger.rounds'),
    inputTokens: source('usage.inputTokens'),
    outputTokens: source('usage.outputTokens'),
    elapsedMs: source('run-event.elapsedMs'),
    humanInterventions: source('intervention-ledger.count'),
    actualChargeUsd: source('provider-billing.actual'),
    creditDelta: source('provider-credits.before-after'),
    ...(provider === 'bedrock' ? {
      awsInvocationCount: {
        ...source('cloudwatch.Invocations'),
        region: 'us-east-1', windowStartUtc: '2026-10-31T10:00:00Z', windowEndUtc: '2026-10-31T10:05:00Z',
      },
    } : {}),
  },
});

const plan = (): BenchMeteringPlan => ({
  schemaVersion: 1,
  runId: 'mock-pair-1',
  promptSha256: 'a'.repeat(64),
  baseSha: 'b'.repeat(40),
  installedPin: 'c'.repeat(40),
  arms: [arm('arm-openrouter', 'openrouter'), arm('arm-bedrock', 'bedrock')],
  sealed: {
    directory: 'sealed', directoryMode: '0700',
    unblindKey: 'sealed/unblind-key.json', meteringReceipt: 'sealed/metering-receipt.json', fileMode: '0600',
  },
  publicFields: ['promptSha256', 'qualityScores'],
});

test('BENCH-METERING-READY: complete source plan is ready-to-measure, never measured or launched', () => {
  expect(checkBenchMeteringPlan(plan())).toEqual({
    readyToMeasure: true, metricsMeasured: false, armsLaunched: 0, issues: [],
  });
});

test('BENCH-METERING-READY: checked-in example is explicitly mock-only and validates as plan-ready', async () => {
  const path = join(import.meta.dir, '../docs/measurements/examples/bench-metering-plan.mock.json');
  const fixture = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const result = checkBenchMeteringPlan(fixture);
  expect(result).toEqual({ readyToMeasure: true, metricsMeasured: false, armsLaunched: 0, issues: [] });
});

test('BENCH-METERING-READY: checked-in Claude subscription fixture is loaded by a regression test', async () => {
  const path = join(import.meta.dir, '../docs/measurements/examples/bench-claude-subscription.mock.json');
  const fixture = JSON.parse(await readFile(path, 'utf8')) as unknown;
  expect(checkBenchMeteringPlan(fixture)).toEqual({ readyToMeasure: true, metricsMeasured: false, armsLaunched: 0, issues: [] });
});

test('BENCH-METERING-READY: missing cost or AWS source blocks the plan before launch', () => {
  const incomplete = plan();
  const bedrock = incomplete.arms[1]!;
  const { awsInvocationCount: _removed, actualChargeUsd: _charge, ...metrics } = bedrock.metrics;
  const result = checkBenchMeteringPlan({ ...incomplete, arms: [incomplete.arms[0], { ...bedrock, metrics }] });
  expect(result.readyToMeasure).toBe(false);
  expect(result.issues).toContain('arms[1].metrics.actualChargeUsd needs a collector and evidenceRef');
  expect(result.issues).toContain('arms[1].metrics.awsInvocationCount needs a collector and evidenceRef, region, and an ordered UTC window');
  expect(result.metricsMeasured).toBe(false);
  expect(result.armsLaunched).toBe(0);
});

test('BENCH-METERING-READY: estimated charge and unordered CloudWatch windows cannot masquerade as measurement sources', () => {
  const input = plan();
  const bedrock = input.arms[1]!;
  const result = checkBenchMeteringPlan({
    ...input,
    arms: [
      { ...input.arms[0]!, metrics: { ...input.arms[0]!.metrics, actualChargeUsd: source('rate-card estimate') } },
      { ...bedrock, metrics: {
        ...bedrock.metrics,
        awsInvocationCount: { ...bedrock.metrics.awsInvocationCount!, windowStartUtc: '2026-10-31T10:05:00Z' },
      } },
    ],
  });
  expect(result.readyToMeasure).toBe(false);
  expect(result.issues).toContain('arms[0].metrics.actualChargeUsd must identify an actual billing source, not an estimate');
  expect(result.issues).toContain('arms[1].metrics.awsInvocationCount needs a collector and evidenceRef, region, and an ordered UTC window');
});

test('BENCH-METERING-READY: missing collector markers are rejected while legitimate catalog labels remain source references', () => {
  const input = plan();
  const openrouter = input.arms[0]!;
  const result = checkBenchMeteringPlan({
    ...input,
    arms: [{ ...openrouter, metrics: {
      ...openrouter.metrics,
      elapsedMs: { collector: 'tbd', evidenceRef: 'mock://openrouter/elapsed' },
      creditDelta: { collector: 'provider-balance-export', evidenceRef: 'unknown' },
      actualChargeUsd: source('billing-catalog-import'),
    } }, input.arms[1]],
  });
  expect(result.readyToMeasure).toBe(false);
  expect(result.issues).toContain('arms[0].metrics.elapsedMs needs a collector and evidenceRef');
  expect(result.issues).toContain('arms[0].metrics.creditDelta needs a collector and evidenceRef');
  expect(result.issues).not.toContain('arms[0].metrics.actualChargeUsd must identify an actual billing source, not an estimate');
});

test('BENCH-METERING-READY: refuses provider mismatch, merge-enabled arms, and public metering fields', () => {
  const input = plan();
  const badBedrock = { ...input.arms[1]!, billingProvider: 'openrouter', noAutoMerge: false };
  const result = checkBenchMeteringPlan({ ...input, arms: [input.arms[0], badBedrock], publicFields: ['actualChargeUsd'] });
  expect(result.readyToMeasure).toBe(false);
  expect(result.issues).toContain('arms[1].billingProvider must match bedrock');
  expect(result.issues).toContain('arms[1].noAutoMerge must be true');
  expect(result.issues).toContain('private metering/identity field cannot enter public output: actualChargeUsd');
});

test('BENCH-METERING-READY: rejects credentials in the plan and non-private seal destinations', () => {
  const input = plan();
  const result = checkBenchMeteringPlan({
    ...input,
    apiKey: 'must-not-be-present',
    sealed: { ...input.sealed, fileMode: '0644' },
  });
  expect(result.readyToMeasure).toBe(false);
  expect(result.issues).toContain('$.apiKey: credentials are not allowed in a measurement plan');
  expect(result.issues).toContain('sealed files must use mode 0600');
});

test('BENCH-METERING-READY: Claude subscription dry-run explicitly records no billing source and compares tokens, calls, and wall time', () => {
  const comparisonArm = (armId: string, provider: 'elanous' | 'claude-code') => ({
    armId,
    provider,
    agent: provider,
    billingProvider: provider === 'claude-code' ? 'subscription' : 'openrouter',
    noAutoMerge: true,
    metrics: {
      actualProvider: source(`mock-${provider}.provider`), actualModel: source(`mock-${provider}.model`),
      rounds: source(`mock-${provider}.rounds`), inputTokens: source(`mock-${provider}.input-tokens`),
      outputTokens: source(`mock-${provider}.output-tokens`), toolCalls: source(`mock-${provider}.tool-calls`),
      elapsedMs: source(`mock-${provider}.wall-clock`), humanInterventions: source(`mock-${provider}.interventions`),
      ...(provider === 'claude-code' ? {
        actualChargeUsd: {
          status: 'not-applicable' as const,
          reason: 'subscription · no billing source',
          evidenceRef: 'mock://claude-code/subscription-billing-disposition',
        },
      } : {
        actualChargeUsd: source('mock-openrouter.actual-charge'),
        estimatedChargeUsd: {
          status: 'estimated' as const,
          reason: 'illustrative estimate only; never used as actual billing',
          evidenceRef: 'mock://elanous/estimate',
        },
      }),
    },
  });
  const input = {
    ...plan(), runId: 'mock-claude-comparison-plan-only',
    arms: [comparisonArm('mock-elanous-arm', 'elanous'), comparisonArm('mock-claude-code-arm', 'claude-code')],
  };
  expect(checkBenchMeteringPlan(input)).toEqual({ readyToMeasure: true, metricsMeasured: false, armsLaunched: 0, issues: [] });
  const claude = input.arms[1]!;
  const { toolCalls: _toolCalls, ...missingCalls } = claude.metrics;
  const result = checkBenchMeteringPlan({ ...input, arms: [input.arms[0], { ...claude, metrics: missingCalls }] });
  expect(result.readyToMeasure).toBe(false);
  expect(result.issues).toContain('arms[1].metrics.toolCalls needs a collector and evidenceRef');
  expect(result.metricsMeasured).toBe(false);
  expect(result.armsLaunched).toBe(0);
});

test('BENCH-METERING-READY: estimated charge cannot masquerade as Claude subscription billing disposition', () => {
  const input = {
    ...plan(),
    arms: [
      { ...arm('mock-openrouter-arm', 'openrouter'), provider: 'elanous', agent: 'elanous' },
      {
        armId: 'mock-claude-code-arm', provider: 'claude-code', agent: 'claude-code',
        billingProvider: 'subscription', noAutoMerge: true,
        metrics: {
          ...arm('mock-claude-code-arm', 'openrouter').metrics,
          actualChargeUsd: { status: 'estimated', reason: 'estimate only', evidenceRef: 'mock://estimate' },
          toolCalls: source('mock-tool-calls'),
        },
      },
    ],
  };
  const result = checkBenchMeteringPlan(input);
  expect(result.readyToMeasure).toBe(false);
  expect(result.issues).toContain('arms[1].metrics.actualChargeUsd must explicitly state subscription · no billing source');
});

test('BENCH-METERING-READY: estimated and unmeasured required metrics have distinct blocked dispositions', () => {
  const input = {
    ...plan(),
    arms: [
      { ...plan().arms[0]!, metrics: {
        ...plan().arms[0]!.metrics,
        inputTokens: { status: 'unmeasured', reason: 'mock source absent', evidenceRef: 'mock://openrouter/input-unmeasured' },
      } },
      { ...plan().arms[1]!, metrics: {
        ...plan().arms[1]!.metrics,
        outputTokens: { status: 'estimated', reason: 'catalog estimate only', evidenceRef: 'mock://bedrock/output-estimate' },
      } },
    ],
  };
  const result = checkBenchMeteringPlan(input);
  expect(result.readyToMeasure).toBe(false);
  expect(result.issues).toContain('arms[0].metrics.inputTokens is explicitly unmeasured; a collector and evidenceRef are required');
  expect(result.issues).toContain('arms[1].metrics.outputTokens is estimated; a measured source is required');
  expect(result.metricsMeasured).toBe(false);
  expect(result.armsLaunched).toBe(0);
});

test('BENCH-METERING-READY: Elanous comparison billing source is limited to supported billing providers', () => {
  const input = {
    ...plan(),
    arms: [
      { ...plan().arms[0]!, provider: 'elanous', agent: 'elanous', billingProvider: 'some-arbitrary-source' },
      {
        ...plan().arms[0]!, armId: 'mock-claude-code-arm', provider: 'claude-code', agent: 'claude-code', billingProvider: 'subscription',
        metrics: {
          ...plan().arms[0]!.metrics,
          actualChargeUsd: { status: 'not-applicable', reason: 'subscription · no billing source', evidenceRef: 'mock://claude-code/subscription' },
          toolCalls: source('mock-claude-code.tool-calls'),
        },
      },
    ],
  };
  const result = checkBenchMeteringPlan(input);
  expect(result.readyToMeasure).toBe(false);
  expect(result.issues).toContain('arms[0] Elanous billingProvider must be openrouter, bedrock, or codex');
});
