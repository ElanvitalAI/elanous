#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { debug } from '../../src/debug/log.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import type { GateResult } from './gate-node.js';
import { emitNodeResult, readGraphContext, type GraphContext } from './node-verdict.js';

/** A shadow recommendation. No value here is a release waiver or a graph edge. */
export type GateTriageClass = 'unmeasured' | 'load' | 'env' | 'regression' | 'clean' | 'exhausted';

export interface GateTriageEvidence {
  /** Observed from the Pod/host during this gate; a timeout alone is not proof of load. */
  highLoad?: boolean;
  /** Count of the suspected failure IDs reproduced in an isolated run. */
  isolatedReproductions?: number;
  /** Exact introduced IDs that actually received an isolated recheck. */
  isolatedCheckedFailureIds?: string[];
  /** Timeout shard files that completed an isolated recheck. */
  isolatedPassedFiles?: string[];
  /** Exact test IDs independently attributed to the Pod environment. */
  environmentFailureIds?: string[];
  /** The last two actual decisions, including their measured identities. */
  priorDecisions?: Array<{ classification: GateTriageClass; commit: string; failureIds: string[] }>;
}

export interface GateTriageShadow {
  classification: GateTriageClass;
  reason: string;
  commit: string;
  introduced: string[];
  stalledFiles: string[];
  failureIds: string[];
  evidence: {
    highLoad: boolean | null;
    isolatedReproductions: number | null;
    isolatedCheckedFailureIds: string[] | null;
    isolatedPassedFiles: string[] | null;
    environmentFailureIds: string[] | null;
    loadFlaky: string[] | null;
    stalledEnv: Array<{ file: string; local: string }>;
  };
  /** Shadow always goes to the existing failure exit. */
  outcome: 'fail';
}

function timeoutShape(gate: GateResult): boolean {
  return gate.stalledShards?.some((shard) => shard.reason === 'timeout' || shard.reason === 'no-output') === true
    || (gate.loadFlaky?.length ?? 0) > 0;
}

export function classifyGateShadow(gate: GateResult, evidence: GateTriageEvidence = {}): GateTriageShadow {
  const stalledFiles = [...new Set((gate.stalledShards ?? []).flatMap((shard) => shard.files))].sort();
  const failureIds = [...new Set([...gate.introduced, ...stalledFiles, ...gate.stalledEnv.map((item) => item.file)])].sort();
  let classification: GateTriageClass;
  let reason: string;

  const unmeasured = gate.stalledShards?.some((shard) => shard.reason !== 'timeout' && shard.reason !== 'no-output') === true;
  const loadExplainsIntroduced = gate.introduced.every((id) => gate.loadFlaky?.includes(id) === true
    && evidence.isolatedCheckedFailureIds?.includes(id) === true);
  const loadExplainsStalled = stalledFiles.every((file) => evidence.isolatedPassedFiles?.includes(file) === true);
  const noUnexplainedEnvironmentFailure = gate.stalledEnv.length === 0;
  const envFiles = new Set(gate.stalledEnv.filter((item) => item.local === 'passed').map((item) => item.file));
  const envExplainsIntroduced = gate.introduced.every((id) => envFiles.has(id.split(' > ', 1)[0]!)
    && evidence.environmentFailureIds?.includes(id) === true);
  const envExplainsStalled = stalledFiles.every((file) => envFiles.has(file));
  const allEnvironmentChecksPassed = gate.stalledEnv.length > 0 && gate.stalledEnv.every((item) => item.local === 'passed');
  if (unmeasured) {
    classification = 'unmeasured';
    reason = 'gate has unfinished or unattributed shard files';
  } else if ((gate.introduced.length > 0 || stalledFiles.length > 0)
    && timeoutShape(gate) && loadExplainsIntroduced && loadExplainsStalled && noUnexplainedEnvironmentFailure
    && evidence.highLoad === true && evidence.isolatedReproductions === 0) {
    classification = 'load';
    reason = 'timeout shape under observed load did not reproduce in isolation';
  } else if (gate.outcome !== 'ok' && allEnvironmentChecksPassed && envExplainsIntroduced && envExplainsStalled) {
    classification = 'env';
    reason = 'Pod environment failure passed outside the Pod';
  } else if (stalledFiles.length || (gate.outcome === 'error' && gate.introduced.length === 0)) {
    classification = 'unmeasured';
    reason = stalledFiles.length ? 'timeout-shaped files remain unmeasured' : 'gate errored without a measured regression';
  } else if (gate.introduced.length > 0 || gate.outcome === 'regression') {
    classification = 'regression';
    reason = 'gate measured an introduced regression';
  } else if (gate.outcome === 'ok') {
    classification = 'clean';
    reason = 'gate passed';
  } else {
    classification = 'unmeasured';
    reason = 'gate failure has no measured regression identity';
  }

  const repeated = failureIds.length > 0 && evidence.priorDecisions?.slice(-2).length === 2
    && evidence.priorDecisions.slice(-2).every((prior) => prior.classification === classification
      && prior.commit === gate.commit
      && JSON.stringify([...prior.failureIds].sort()) === JSON.stringify(failureIds));
  if (classification !== 'clean' && repeated) {
    classification = 'exhausted';
    reason = 'the same class and failure identities already recurred twice';
  }
  return { classification, reason, commit: gate.commit, introduced: [...gate.introduced], stalledFiles, failureIds,
    evidence: { highLoad: evidence.highLoad ?? null, isolatedReproductions: evidence.isolatedReproductions ?? null,
      isolatedCheckedFailureIds: evidence.isolatedCheckedFailureIds ? [...evidence.isolatedCheckedFailureIds] : null,
      isolatedPassedFiles: evidence.isolatedPassedFiles ? [...evidence.isolatedPassedFiles] : null,
      environmentFailureIds: evidence.environmentFailureIds ? [...evidence.environmentFailureIds] : null,
      loadFlaky: gate.loadFlaky ? [...gate.loadFlaky] : null,
      stalledEnv: gate.stalledEnv.map((item) => ({ file: item.file, local: item.local })) },
    outcome: 'fail' };
}

/** Read only the completed gate output. The graph wiring is a separate change after M3. */
export function gateTriageShadowFromContext(context: GraphContext, evidence?: GateTriageEvidence): GateTriageShadow {
  const value = context.outputs.gate;
  if (!value || typeof value.commit !== 'string' || !Array.isArray(value.introduced)
    || !value.introduced.every((item) => typeof item === 'string')
    || !Array.isArray(value.stalledEnv)
    || !value.stalledEnv.every((item) => item && typeof item === 'object' && typeof item.file === 'string'
      && ['passed', 'failed', 'timeout'].includes(String(item.local)))
    || (value.stalledShards !== undefined && (!Array.isArray(value.stalledShards)
      || !value.stalledShards.every((item) => item && typeof item === 'object' && Array.isArray(item.files)
        && item.files.every((file: unknown) => typeof file === 'string') && typeof item.reason === 'string')))
    || (value.loadFlaky !== undefined && (!Array.isArray(value.loadFlaky)
      || !value.loadFlaky.every((item) => typeof item === 'string')))
    || !['ok', 'regression', 'error'].includes(String(value.outcome))) {
    throw new Error('gate output is missing or malformed');
  }
  const input = context.input.gateTriageEvidence;
  const supplied = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const observed: GateTriageEvidence = evidence ?? {
    ...(supplied.highLoad === true ? { highLoad: true } : {}),
    ...(Number.isSafeInteger(supplied.isolatedReproductions) && Number(supplied.isolatedReproductions) >= 0
      ? { isolatedReproductions: Number(supplied.isolatedReproductions) } : {}),
    ...(Array.isArray(supplied.isolatedCheckedFailureIds) && supplied.isolatedCheckedFailureIds.every((id) => typeof id === 'string')
      ? { isolatedCheckedFailureIds: supplied.isolatedCheckedFailureIds as string[] } : {}),
    ...(Array.isArray(supplied.isolatedPassedFiles) && supplied.isolatedPassedFiles.every((file) => typeof file === 'string')
      ? { isolatedPassedFiles: supplied.isolatedPassedFiles as string[] } : {}),
    ...(Array.isArray(supplied.environmentFailureIds) && supplied.environmentFailureIds.every((id) => typeof id === 'string')
      ? { environmentFailureIds: supplied.environmentFailureIds as string[] } : {}),
    ...(Array.isArray(supplied.priorDecisions) && supplied.priorDecisions.every((item) => item && typeof item === 'object'
      && typeof item.classification === 'string' && typeof item.commit === 'string' && Array.isArray(item.failureIds)
      && item.failureIds.every((id: unknown) => typeof id === 'string'))
      ? { priorDecisions: supplied.priorDecisions as GateTriageEvidence['priorDecisions'] } : {}),
  };
  return classifyGateShadow(value as unknown as GateResult, observed);
}

export function logGateTriageShadow(result: GateTriageShadow, version: string): void {
  debug.log('graph.ground', 'gate-triage-shadow', { version, ...result });
}

/** A saved verdict has fewer fields than the live gate output. Keep the absent evidence absent. */
export function gateTriageShadowFromSavedVerdict(value: unknown): { version: string; result: GateTriageShadow } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid saved gate verdict');
  const saved = value as Record<string, unknown>;
  if (typeof saved.version !== 'string' || typeof saved.commit !== 'string'
    || !['ok', 'regression', 'error'].includes(String(saved.outcome))
    || !Array.isArray(saved.introduced) || !saved.introduced.every((id) => typeof id === 'string')
    || (saved.loadFlaky !== undefined && (!Array.isArray(saved.loadFlaky)
      || !saved.loadFlaky.every((id) => typeof id === 'string')))) throw new Error('invalid saved gate verdict');
  const gate: GateResult = { outcome: saved.outcome as GateResult['outcome'], commit: saved.commit,
    introduced: saved.introduced, preexisting: 0, fixed: null, knownEnv: 0, knownEnvCleared: [],
    stalledEnv: (saved.stalledEnv ?? []) as GateResult['stalledEnv'], rcNonzeroNoFailures: [], durationMs: 0,
    ...(saved.stalledShards !== undefined ? { stalledShards: saved.stalledShards as GateResult['stalledShards'] } : {}),
    ...(saved.loadFlaky !== undefined ? { loadFlaky: saved.loadFlaky as string[] } : {}) };
  const context: GraphContext = { input: { version: saved.version, previousVersion: '0.0.0' },
    outputs: { gate: gate as unknown as Record<string, unknown> } };
  return { version: saved.version, result: gateTriageShadowFromContext(context) };
}

if (import.meta.main) {
  await registerStandaloneLogSink('release-loop');
  try {
    const savedPath = process.argv[2] === '--gate-verdict' ? process.argv[3] : undefined;
    if (process.argv[2] && !savedPath) throw new Error('usage: gate-triage-node.ts [--gate-verdict <path>]');
    const { version, result } = savedPath
      ? gateTriageShadowFromSavedVerdict(JSON.parse(readFileSync(savedPath, 'utf8')))
      : (() => { const context = readGraphContext(); return { version: context.input.version,
        result: gateTriageShadowFromContext(context) }; })();
    logGateTriageShadow(result, version);
    emitNodeResult({ ...result, verdict: 'fail', summary: `gate-triage shadow: ${result.classification} — ${result.reason}` });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const result: GateTriageShadow = { outcome: 'fail', classification: 'unmeasured', reason,
      commit: 'unknown', introduced: [], stalledFiles: [], failureIds: [],
      evidence: { highLoad: null, isolatedReproductions: null, isolatedCheckedFailureIds: null,
        isolatedPassedFiles: null, environmentFailureIds: null, loadFlaky: null, stalledEnv: [] } };
    logGateTriageShadow(result, 'unknown');
    emitNodeResult({ ...result, verdict: 'fail', summary: `gate-triage shadow: ${reason}` });
  }
  process.exitCode = 1;
}
