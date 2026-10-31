import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { parseGraphTemplateYaml, type LandUnitTrainPolicySpec } from '../../src/self-implement/graph-yaml.js';

type RecordValue = Record<string, unknown>;
type EnqueueResult = {
  outcome: 'done' | 'needs-human';
  result: string;
  evidence: RecordValue;
};

/** Facts collected by the train runner for one landing batch. Keep this input explicit:
 * the graph unit enqueues one PR and cannot infer batch/theme/scenario facts itself. */
export type LandTrainObservation = {
  readonly express: boolean;
  readonly waitedForBatch: boolean;
  readonly batchSize: number;
  readonly groupBy: readonly string[];
  readonly waitMinutes: number;
  readonly scenarioSource: string;
  readonly mockUsed: boolean;
  readonly gateRuns: number;
  readonly land: {
    readonly perPr: string;
    readonly pinnedHead: boolean;
    readonly ejectOnFail: boolean;
    readonly integrationPr: boolean;
  };
};

export type LandPolicyDrift = {
  readonly field: string;
  readonly expected: unknown;
  readonly observed: unknown;
};

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((value) => actual.includes(value));
}

/** Compare runner-measured facts with the declared policy. Missing/invalid facts are drift,
 * never an implicit pass. Express work bypasses batch size/theme waiting as declared. */
export function compareLandTrainPolicy(
  policy: LandUnitTrainPolicySpec,
  observed: LandTrainObservation,
): LandPolicyDrift[] {
  const drift: LandPolicyDrift[] = [];
  const check = (field: string, expected: unknown, actual: unknown, matches: boolean): void => {
    if (!matches) drift.push({ field, expected, observed: actual ?? null });
  };
  if (typeof observed.express !== 'boolean') {
    check('/express', 'boolean', observed.express, false);
  } else if (observed.express) {
    check('/express/waitsForBatch', policy.express.waitsForBatch, observed.waitedForBatch, observed.waitedForBatch === policy.express.waitsForBatch);
  } else {
    const validSize = Number.isSafeInteger(observed.batchSize)
      && observed.batchSize >= policy.batch.min && observed.batchSize <= policy.batch.max;
    check('/batch/size', `${policy.batch.min}..${policy.batch.max}`, observed.batchSize, validSize);
    check('/batch/groupBy', policy.batch.groupBy, observed.groupBy,
      Array.isArray(observed.groupBy) && sameMembers(observed.groupBy, policy.batch.groupBy));
    check('/batch/waitMinutes', `<=${policy.batch.maxWaitMin}`, observed.waitMinutes,
      Number.isFinite(observed.waitMinutes) && observed.waitMinutes >= 0 && observed.waitMinutes <= policy.batch.maxWaitMin);
  }
  check('/scenarioPrebuild/source', policy.scenarioPrebuild.source, observed.scenarioSource,
    policy.scenarioPrebuild.source.includes(observed.scenarioSource as typeof policy.scenarioPrebuild.source[number]));
  check('/scenarioPrebuild/mock', policy.scenarioPrebuild.mock, observed.mockUsed,
    observed.mockUsed === (policy.scenarioPrebuild.mock === 'required'));
  check('/gate/runs', policy.gate.oncePerBatch ? 1 : 'unspecified', observed.gateRuns,
    !policy.gate.oncePerBatch || observed.gateRuns === 1);
  check('/land/perPr', policy.land.perPr, observed.land?.perPr, observed.land?.perPr === policy.land.perPr);
  check('/land/pinnedHead', policy.land.pinnedHead, observed.land?.pinnedHead, observed.land?.pinnedHead === policy.land.pinnedHead);
  check('/land/ejectOnFail', policy.land.ejectOnFail, observed.land?.ejectOnFail, observed.land?.ejectOnFail === policy.land.ejectOnFail);
  check('/land/integrationPr', policy.land.integrationPr, observed.land?.integrationPr, observed.land?.integrationPr === policy.land.integrationPr);
  return drift;
}

/** Runtime contract for the OP train runner: emit only on measured drift; tests inject the sink. */
export function observeLandPolicyDrift(
  policy: LandUnitTrainPolicySpec,
  observed: LandTrainObservation,
  emit: (event: 'land.policy-drift', payload: { drift: readonly LandPolicyDrift[] }) => void = (_event, payload) => {
    debug.log('land', 'policy-drift', payload, { level: 'warn' });
  },
): LandPolicyDrift[] {
  const drift = compareLandTrainPolicy(policy, observed);
  if (drift.length > 0) emit('land.policy-drift', { drift });
  return drift;
}

function observeEnvelopePolicy(context: RecordValue, emit?: Parameters<typeof observeLandPolicyDrift>[2]): void {
  if (context.landTrainObservation === undefined) return;
  const parsed = parseGraphTemplateYaml(readFileSync(new URL('../../graphs/units/land/land.yaml', import.meta.url), 'utf8'), 'land.yaml');
  const policy = parsed.template?.policy;
  if (!policy) throw new Error(`land policy unavailable: ${parsed.errors.map((issue) => issue.message).join('; ')}`);
  // Runtime envelopes are untrusted; the comparator treats absent fields as drift evidence.
  observeLandPolicyDrift(policy, record(context.landTrainObservation) as unknown as LandTrainObservation, emit);
}

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function needsHuman(reason: string, evidence: RecordValue = {}): EnqueueResult {
  return { outcome: 'needs-human', result: reason, evidence: { enqueued: false, reason, ...evidence } };
}

const OWNERS = new Set(['TC', 'MK', 'UX', 'OPC', 'OPT', 'OP', 'tf']);

/** The graph asks the existing OP train to enqueue; it never performs a merge. */
export function runLandEnqueue(
  envelope: unknown,
  executable = process.env.ELANOUS_LAND_ENQUEUE,
  spawn: typeof spawnSync = spawnSync,
  emitPolicyDrift?: Parameters<typeof observeLandPolicyDrift>[2],
): EnqueueResult {
  const context = record(record(envelope).context);
  observeEnvelopePolicy(context, emitPolicyDrift);
  const rawPr = context.pr;
  const pr = typeof rawPr === 'number' ? rawPr : typeof rawPr === 'string' && /^\d+$/.test(rawPr) ? Number(rawPr) : NaN;
  const expectedHead = text(context.expectedHead);
  const review = text(context.review);
  const rawOwner = text(context.owner);
  const owner = rawOwner.startsWith('train:') ? rawOwner.slice(6) : rawOwner;
  if (!Number.isSafeInteger(pr) || pr <= 0) return needsHuman('pr-missing-or-invalid');
  if (!/^[0-9a-f]{40}$/i.test(expectedHead)) return needsHuman('expected-head-missing-or-invalid', { pr });
  if (!isAbsolute(review) || !existsSync(review)) return needsHuman('review-json-missing', { pr, expectedHead, review });
  if (!OWNERS.has(owner)) return needsHuman('train-owner-missing-or-invalid', { pr, expectedHead, review });
  if (!executable || !isAbsolute(executable) || !existsSync(executable)) {
    return needsHuman('land-enqueue-command-unavailable', { pr, expectedHead, review, owner });
  }
  const args = [String(pr), `train:${owner}`, '--expected-head', expectedHead, '--review', review];
  const result = spawn(executable, args, { encoding: 'utf8', timeout: 55_000, shell: false });
  const evidence = {
    pr, expectedHead, review, owner,
    exitCode: result.status,
    stdout: String(result.stdout ?? '').slice(-2000),
    stderr: String(result.stderr ?? '').slice(-2000),
  };
  if (result.error || result.status !== 0) {
    return needsHuman(result.error ? `land-enqueue-error: ${result.error.message}` : 'land-enqueue-refused', evidence);
  }
  return { outcome: 'done', result: 'train-enqueued', evidence: { enqueued: true, ...evidence } };
}

if (import.meta.main) {
  try {
    const path = process.env.ELANOUS_GRAPH_CONTEXT;
    if (!path) throw new Error('ELANOUS_GRAPH_CONTEXT missing');
    const graph = JSON.parse(readFileSync(path, 'utf8')) as { input?: unknown };
    const result = runLandEnqueue(graph.input);
    debug.log('harness.journey', 'land-enqueue', {
      outcome: result.outcome,
      reason: result.outcome === 'needs-human' ? result.result : null,
      pr: result.evidence.pr ?? null,
      expectedHead: result.evidence.expectedHead ?? null,
      enqueued: result.evidence.enqueued,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify(needsHuman(`land-context-invalid: ${error instanceof Error ? error.message : String(error)}`)));
  }
}
