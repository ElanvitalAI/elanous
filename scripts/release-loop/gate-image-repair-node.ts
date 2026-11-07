#!/usr/bin/env bun
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import { createGateRunner, judgeGate, type GateOptions, type GateRunner } from './gate-node.js';
import { preflightGateExecutionIdentity, preflightGateImageDigest } from './gate-radius-live.js';
import { readGraphContext, finishNode, errorResult, type GraphContext } from './node-verdict.js';
import { syncPoolImages } from '../../src/task-orchestrator/surfaces/pod-pool.js';

export interface GateImageRepairDeps {
  runner?: GateRunner;
  instanceRoot?: string;
  imageProbe?: typeof preflightGateImageDigest;
  identityProbe?: typeof preflightGateExecutionIdentity;
  syncImages?: typeof syncPoolImages;
}

function repairInput(context: GraphContext): { version: string; runId: string; commit: string; pool: string } {
  const node = context.nodeInput;
  const input = context.input;
  const triage = context.outputs['gate-triage'];
  const cut = context.outputs['version-release'];
  const invalidContextKeys = [
    ...(!node || typeof node !== 'object' || Array.isArray(node) ? ['nodeInput'] : []),
    ...(!input || typeof input !== 'object' || Array.isArray(input) ? ['releaseInput'] : []),
    ...(!triage ? ['outputs.gate-triage'] : []), ...(!cut ? ['outputs.version-release'] : []),
  ];
  debug.log('release-loop.gate-image-repair', 'context-preflight', { invalidKeys: invalidContextKeys,
    nodeInputKeys: node && typeof node === 'object' && !Array.isArray(node) ? Object.keys(node) : [],
    releaseInputKeys: input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : [],
    outputs: { gatePresent: Boolean(context.outputs.gate), triagePresent: Boolean(triage), cutPresent: Boolean(cut) } });
  if (invalidContextKeys.length) throw new Error(`image repair context missing or invalid: ${invalidContextKeys.join(',')}`);
  const repair = node as Record<string, unknown>;
  const release = input as Record<string, unknown>;
  const triageOutput = triage as Record<string, unknown>;
  const cutOutput = cut as Record<string, unknown>;
  if (context.graphId !== 'release-loop' || typeof context.runId !== 'string' || repair.runId !== context.runId
    || typeof repair.version !== 'string' || repair.version !== release.version || typeof repair.commit !== 'string'
    || !/^[0-9a-f]{40}$/i.test(repair.commit) || repair.commit !== cutOutput.commit || triageOutput.commit !== repair.commit
    || (repair.failureCode !== 'pod-gate-missing-cut-image-pin' && repair.failureCode !== 'pod-gate-missing-run-scope')
    || triageOutput.classification !== 'unmeasured'
    || !Array.isArray(triageOutput.introduced) || triageOutput.introduced.length !== 0
    || typeof release.previousVersion !== 'string' || typeof repair.pool !== 'string' || !repair.pool.trim()
    || repair.pool !== release.gatePodPool || release.gateExecutor === 'host') {
    throw new Error('image repair is only allowed for this run’s unmeasured missing cut-image pin with its original Pod pool');
  }
  return { version: repair.version, runId: context.runId, commit: repair.commit, pool: repair.pool };
}

/** Build and pin the exact cut image through judgeGate's production image preparation path, without sweeping tests. */
export async function runGateImageRepairNode(context: GraphContext, deps: GateImageRepairDeps = {}): Promise<GateResultOutput> {
  const { version, runId, commit, pool } = repairInput(context);
  const releaseInput = context.input as Record<string, unknown>;
  const options: GateOptions = {
    graphId: context.graphId,
    graphRunId: runId,
    version,
    baselineVersion: releaseInput.previousVersion as string,
    commit,
    repo: process.cwd(),
    instanceRoot: deps.instanceRoot ?? effectiveInstanceRoot(),
    executor: 'pod',
    imagePin: 'cut-commit',
    imagePinPrepareOnly: true,
    pod: { pool },
  };
  const runner = deps.runner ?? createGateRunner(options.repo!, typeof releaseInput.gateRemote === 'string' ? releaseInput.gateRemote : undefined,
    undefined, undefined, undefined, undefined, { graphRunId: runId });
  const result = await judgeGate(options, runner, deps.imageProbe, deps.identityProbe, deps.syncImages);
  if (result.outcome !== 'ok' || result.imagePin !== 'cut-commit' || result.imagePinRunId !== runId || result.commit !== commit
    || !result.imagePinDigest) {
    debug.log('release-loop.gate-image-repair', 'pin-preparation-incomplete', { runId, version, commit,
      outcome: result.outcome, imagePin: result.imagePin ?? null, imagePinRunId: result.imagePinRunId ?? null,
      resultCommit: result.commit, digestPresent: Boolean(result.imagePinDigest), error: result.error ?? null }, { level: 'error' });
    throw new Error(`cut image pin preparation incomplete: ${JSON.stringify({ runId, version, commit,
      outcome: result.outcome, imagePin: result.imagePin ?? null, imagePinRunId: result.imagePinRunId ?? null,
      resultCommit: result.commit, digestPresent: Boolean(result.imagePinDigest), error: result.error ?? null })}`);
  }
  debug.log('release-loop.gate-image-repair', 'image-pinned', { runId, version, commit, digest: result.imagePinDigest });
  return result;
}

interface GateResultOutput {
  outcome: 'ok';
  commit: string;
  imagePin: 'cut-commit';
  imagePinRunId: string;
  imagePinDigest: string;
  summary?: string;
}

if (import.meta.main) {
  await registerStandaloneLogSink('release-loop');
  let version = 'unknown';
  try {
    const context = readGraphContext();
    version = typeof context.input.version === 'string' ? context.input.version : 'unknown';
    finishNode('gate-image-repair', version, await runGateImageRepairNode(context));
  } catch (error) {
    const result = errorResult(error);
    debug.log('release-loop.gate-image-repair', 'failed', { version, error: result.summary }, { level: 'error' });
    finishNode('gate-image-repair', version, result);
  }
}
