#!/usr/bin/env bun
import { debug } from '../../src/debug/log.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import { releaseGateCutoverPath } from '../../src/graph-runner/release-gate-cutover-policy.js';
import { emitNodeResult, readGraphContext } from './node-verdict.js';

/** Choose the declared gate route from the pinned run input, never from live config on resume. */
export function runGateCutoverSwitch(env: NodeJS.ProcessEnv = process.env): number {
  try {
    const context = readGraphContext(env);
    const configuredMode = releaseGateCutoverPath(context.input);
    const repairOutputs = Object.entries(context.outputs).filter(([nodeId]) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId));
    const repairedCut = context.input.autoAppendRepair === true && repairOutputs.length > 0;
    if (repairedCut && !repairOutputs.some(([, repair]) => repair.outcome === 'ok'
      && repair.requiresReceiptAudit === true && repair.commit === context.outputs.gate?.commit
      && Array.isArray(repair.appendedPicks) && repair.appendedPicks.length > 0
      && Array.isArray(repair.repairedFiles) && repair.repairedFiles.length > 0)) {
      throw new Error('automatic cut repair lacks matching receipt-audit evidence');
    }
    const mode = repairedCut ? 'audit' : configuredMode;
    const evidenceId = context.input.graphCutoverEvidenceId;
    if (env.ELANOUS_GRAPH_DRY_RUN !== '1' && context.outputs.gate?.outcome !== 'ok')
      throw new Error('gate must pass before cutover route selection');
    debug.log('release-loop.cutover', 'selected', { graphId: context.graphId ?? 'release-loop',
      runId: context.runId ?? null, version: context.input.version, mode,
      evidenceId: typeof evidenceId === 'string' ? evidenceId : null,
      ...(repairedCut ? { reason: 'automatic-cut-repair' } : {}) });
    emitNodeResult({ outcome: mode, verdict: 'pass', mode,
      evidenceId: typeof evidenceId === 'string' ? evidenceId : null,
      summary: `release gate route ${mode}` });
    return 0;
  } catch (error) {
    emitNodeResult({ outcome: 'error', verdict: 'fail',
      summary: error instanceof Error ? error.message : String(error) });
    return 2;
  }
}

if (import.meta.main) {
  await registerStandaloneLogSink('release-loop');
  process.exitCode = runGateCutoverSwitch();
}
