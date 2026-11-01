#!/usr/bin/env bun
/** Validate that a paired benchmark has measurement sources and private sinks planned.
 * This checks the plan only: it never launches arms, reads credentials, or claims measurements. */
import { readFile } from 'node:fs/promises';

export type BenchProvider = 'openrouter' | 'bedrock' | 'elanous' | 'claude-code';

export interface BenchMetricSource {
  readonly collector: string;
  readonly evidenceRef: string;
  readonly region?: string;
  readonly windowStartUtc?: string;
  readonly windowEndUtc?: string;
}

export interface BenchArmMeteringPlan {
  readonly armId: string;
  readonly provider: BenchProvider;
  /** Product/agent identity is separate from the provider that supplies billing. */
  readonly agent?: 'elanous' | 'claude-code' | 'provider-arm';
  readonly billingProvider: string;
  readonly noAutoMerge: boolean;
  readonly metrics: Readonly<Record<string, BenchMetricSource | BenchMetricDisposition>>;
}

export interface BenchMetricDisposition {
  readonly status: 'not-applicable' | 'estimated' | 'unmeasured';
  readonly reason: string;
  readonly evidenceRef: string;
}

export interface BenchMeteringPlan {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly promptSha256: string;
  readonly baseSha: string;
  readonly installedPin: string;
  readonly arms: readonly BenchArmMeteringPlan[];
  readonly sealed: {
    readonly directory: string;
    readonly directoryMode: string;
    readonly unblindKey: string;
    readonly meteringReceipt: string;
    readonly fileMode: string;
  };
  readonly publicFields: readonly string[];
}

export interface BenchMeteringPlanCheck {
  readonly readyToMeasure: boolean;
  readonly metricsMeasured: false;
  readonly armsLaunched: 0;
  readonly issues: readonly string[];
}

const SHA256 = /^[0-9a-f]{64}$/i;
const COMMIT = /^[0-9a-f]{40}$/i;
const PROVIDER_PAIR_METRICS = [
  'actualProvider',
  'actualModel',
  'rounds',
  'inputTokens',
  'outputTokens',
  'elapsedMs',
  'humanInterventions',
  'actualChargeUsd',
  'creditDelta',
] as const;
const COMPARISON_METRICS = [
  'actualProvider', 'actualModel', 'rounds', 'inputTokens', 'outputTokens',
  'toolCalls', 'elapsedMs', 'humanInterventions',
] as const;
const BEDROCK_METRICS = ['awsInvocationCount'] as const;
const PRIVATE_PUBLIC_FIELDS = /^(armId|provider|billingProvider|model|actualProvider|actualModel|elapsedMs|durationMs|humanInterventions|toolCalls|actualChargeUsd|estimatedChargeUsd|creditDelta|awsInvocationCount|accountId|region)$/i;
const SECRET_PROPERTY = /^(api[_-]?key|(?:secret|access)[_-]?(?:access)?key(?:id)?|authorization|password|credential|token)$/i;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scanSecretPropertyNames(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => scanSecretPropertyNames(entry, `${path}[${index}]`));
  if (!record(value)) return [];
  return Object.entries(value).flatMap(([key, nested]) => [
    ...(SECRET_PROPERTY.test(key) ? [`${path}.${key}: credentials are not allowed in a measurement plan`] : []),
    ...scanSecretPropertyNames(nested, `${path}.${key}`),
  ]);
}

function validSource(value: unknown): value is BenchMetricSource {
  const usableRef = (candidate: unknown): candidate is string => typeof candidate === 'string'
    && candidate.trim().length > 0
    && !/^(pending|tbd|unknown|n\/a)$/i.test(candidate.trim());
  return record(value) && usableRef(value.collector) && usableRef(value.evidenceRef);
}

function isDisposition(value: unknown): value is BenchMetricDisposition {
  return record(value) && ['not-applicable', 'estimated', 'unmeasured'].includes(String(value.status));
}

function validDisposition(value: unknown): value is BenchMetricDisposition {
  return isDisposition(value) && typeof value.reason === 'string' && value.reason.trim().length > 0
    && validSource({ collector: 'disposition', evidenceRef: value.evidenceRef });
}

function validAwsSource(value: unknown): value is BenchMetricSource {
  if (!validSource(value) || typeof value.region !== 'string' || value.region.trim().length === 0) return false;
  if (typeof value.windowStartUtc !== 'string' || typeof value.windowEndUtc !== 'string') return false;
  const start = Date.parse(value.windowStartUtc);
  const end = Date.parse(value.windowEndUtc);
  return Number.isFinite(start) && Number.isFinite(end) && start < end
    && value.windowStartUtc.endsWith('Z') && value.windowEndUtc.endsWith('Z');
}

/** The output is deliberately plan-ready, never measurement-ready. */
export function checkBenchMeteringPlan(input: unknown): BenchMeteringPlanCheck {
  const issues = scanSecretPropertyNames(input);
  const issue = (message: string): void => { issues.push(message); };
  if (!record(input)) {
    issue('plan must be a JSON object');
    return { readyToMeasure: false, metricsMeasured: false, armsLaunched: 0, issues };
  }
  if (input.schemaVersion !== 1) issue('schemaVersion must be 1');
  if (typeof input.runId !== 'string' || input.runId.trim().length === 0) issue('runId is required');
  if (typeof input.promptSha256 !== 'string' || !SHA256.test(input.promptSha256)) issue('promptSha256 must be a full SHA-256');
  if (typeof input.baseSha !== 'string' || !COMMIT.test(input.baseSha)) issue('baseSha must be a full commit SHA');
  if (typeof input.installedPin !== 'string' || !COMMIT.test(input.installedPin)) issue('installedPin must be a full commit SHA');

  const arms = Array.isArray(input.arms) ? input.arms : [];
  if (arms.length !== 2) issue('exactly two paired arms are required');
  const claudePair = arms.some((arm) => record(arm) && arm.provider === 'elanous')
    && arms.some((arm) => record(arm) && arm.provider === 'claude-code');
  const providers = new Set<string>();
  const armIds = new Set<string>();
  for (const [index, arm] of arms.entries()) {
    const prefix = `arms[${index}]`;
    if (!record(arm)) { issue(`${prefix} must be an object`); continue; }
    if (typeof arm.armId !== 'string' || arm.armId.trim().length === 0) issue(`${prefix}.armId is required`);
    else if (armIds.has(arm.armId)) issue(`${prefix}.armId must be unique`);
    else armIds.add(arm.armId);
    if (!['openrouter', 'bedrock', 'elanous', 'claude-code'].includes(String(arm.provider))) issue(`${prefix}.provider must be openrouter, bedrock, elanous, or claude-code`);
    else providers.add(arm.provider as string);
    if (typeof arm.billingProvider !== 'string' || arm.billingProvider.trim().length === 0) issue(`${prefix}.billingProvider is required`);
    if (arm.provider === 'bedrock' && arm.billingProvider !== 'bedrock') issue(`${prefix}.billingProvider must match bedrock`);
    if (arm.provider === 'openrouter' && arm.billingProvider !== 'openrouter') issue(`${prefix}.billingProvider must match openrouter`);
    if (arm.provider === 'claude-code' && (arm.agent !== 'claude-code' || arm.billingProvider !== 'subscription')) issue(`${prefix} Claude Code arm must identify agent claude-code and subscription billing`);
    if (arm.provider === 'elanous') {
      if (arm.agent !== 'elanous') issue(`${prefix} Elanous arm must identify agent elanous`);
      if (!['openrouter', 'bedrock', 'codex'].includes(String(arm.billingProvider))) issue(`${prefix} Elanous billingProvider must be openrouter, bedrock, or codex`);
    }
    if (arm.noAutoMerge !== true) issue(`${prefix}.noAutoMerge must be true`);
    const metrics = record(arm.metrics) ? arm.metrics : {};
    const requiredMetrics = claudePair
      ? COMPARISON_METRICS
      : PROVIDER_PAIR_METRICS;
    for (const metric of [...requiredMetrics, ...(arm.provider === 'bedrock' ? BEDROCK_METRICS : [])]) {
      const value = metrics[metric];
      if (isDisposition(value)) {
        if (!validDisposition(value)) issue(`${prefix}.metrics.${metric} disposition needs a reason and evidenceRef`);
        else if (value.status === 'unmeasured') issue(`${prefix}.metrics.${metric} is explicitly unmeasured; a collector and evidenceRef are required`);
        else if (value.status === 'estimated') issue(`${prefix}.metrics.${metric} is estimated; a measured source is required`);
        else if (metric !== 'actualChargeUsd' || arm.provider !== 'claude-code') issue(`${prefix}.metrics.${metric} is not applicable and cannot satisfy a required measurement`);
      } else {
        const sourceIsValid = metric === 'awsInvocationCount' ? validAwsSource(value) : validSource(value);
        if (!sourceIsValid) issue(`${prefix}.metrics.${metric} needs a collector and evidenceRef${metric === 'awsInvocationCount' ? ', region, and an ordered UTC window' : ''}`);
      }
    }
    const chargeMetric = metrics.actualChargeUsd;
    const chargeSource = record(chargeMetric) ? chargeMetric.collector : undefined;
    // This is deliberately a naming heuristic; it cannot prove the referenced billing artifact is genuine.
    if (typeof chargeSource === 'string' && /estimate|rate.?card/i.test(chargeSource)) {
      issue(`${prefix}.metrics.actualChargeUsd must identify an actual billing source, not an estimate`);
    }
    if (arm.provider === 'claude-code') {
      if (!record(chargeMetric) || chargeMetric.status !== 'not-applicable'
        || chargeMetric.reason !== 'subscription · no billing source'
        || !validSource({ collector: 'subscription-disposition', evidenceRef: chargeMetric.evidenceRef })) {
        issue(`${prefix}.metrics.actualChargeUsd must explicitly state subscription · no billing source`);
      }
      if ('creditDelta' in metrics) issue(`${prefix}.metrics.creditDelta must not imply subscription credit measurement`);
    } else if (!validSource(chargeMetric)) {
      issue(`${prefix}.metrics.actualChargeUsd needs an actual billing source`);
    }
    if ('estimatedChargeUsd' in metrics) {
      const estimate = metrics.estimatedChargeUsd;
      if (!record(estimate) || estimate.status !== 'estimated' || typeof estimate.reason !== 'string' || !estimate.reason.trim()
        || !validSource({ collector: 'estimate', evidenceRef: estimate.evidenceRef })) {
        issue(`${prefix}.metrics.estimatedChargeUsd must be explicitly marked estimated with reason and evidenceRef`);
      }
    }
  }
  const providerPair = providers.has('openrouter') && providers.has('bedrock');
  const validClaudePair = providers.has('elanous') && providers.has('claude-code');
  if (!providerPair && !validClaudePair) issue('pair must be openrouter + bedrock or elanous + claude-code');

  const sealed = record(input.sealed) ? input.sealed : {};
  if (sealed.directory !== 'sealed' || sealed.directoryMode !== '0700') issue('sealed output directory must be sealed/ with mode 0700');
  if (sealed.unblindKey !== 'sealed/unblind-key.json') issue('unblind key must use the bench-blind-pack sealed path');
  if (sealed.meteringReceipt !== 'sealed/metering-receipt.json') issue('metering receipt must stay beside the unblind key');
  if (sealed.fileMode !== '0600') issue('sealed files must use mode 0600');

  const publicFields = Array.isArray(input.publicFields) ? input.publicFields : [];
  for (const field of publicFields) {
    if (typeof field !== 'string' || PRIVATE_PUBLIC_FIELDS.test(field)) issue(`private metering/identity field cannot enter public output: ${String(field)}`);
  }
  return { readyToMeasure: issues.length === 0, metricsMeasured: false, armsLaunched: 0, issues };
}

async function main(argv: string[]): Promise<number> {
  if (argv.length !== 1 || argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write('Usage: bun scripts/bench-metering-plan.ts <measurement-plan.json>\n');
    return argv.includes('--help') || argv.includes('-h') ? 0 : 2;
  }
  try {
    const plan = JSON.parse(await readFile(argv[0]!, 'utf8')) as unknown;
    const result = checkBenchMeteringPlan(plan);
    if (!result.readyToMeasure) {
      process.stderr.write(`bench metering plan refused (${result.issues.length} issue(s)):\n${result.issues.map((entry) => `- ${entry}`).join('\n')}\n`);
      return 2;
    }
    process.stdout.write('plan-ready; no metrics measured; no benchmark arms launched\n');
    return 0;
  } catch (error) {
    process.stderr.write(`bench metering plan refused: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
