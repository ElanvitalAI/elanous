#!/usr/bin/env bun
import { decideEmergencyPublishSwitch } from './emergency-publish-switch.js';
import { emitNodeResult, readGraphContext } from './node-verdict.js';
import { debug } from '../../src/debug/log.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';

/** Production graph decision node. Inputs cannot opt into the unfinished emergency lane. */
export function runEmergencyPublishSwitchSimulation(env: NodeJS.ProcessEnv = process.env): number {
  let version = '';
  try {
    const context = readGraphContext(env);
    version = context.input.version;
    if (!context.runId) throw new Error('current normal release runId required');
    const normalGateOutcome = typeof context.outputs.gate?.outcome === 'string' ? context.outputs.gate.outcome : 'unavailable';
    const decision = decideEmergencyPublishSwitch(context.runId, normalGateOutcome);
    debug.log('release-loop.emergency-publish', 'switch-declined', {
      runId: context.runId, version, action: decision.action, evidence: decision.evidence, reasons: decision.reasons,
    });
    emitNodeResult({ ...decision, outcome: decision.action, verdict: 'pass',
      summary: `emergency publish remains disabled: ${decision.reasons[0]}` });
    return 0;
  } catch (error) {
    emitNodeResult({ outcome: 'error', verdict: 'fail',
      summary: `${version ? `v${version}: ` : ''}${error instanceof Error ? error.message : String(error)}` });
    return 2;
  }
}

if (import.meta.main) {
  await registerStandaloneLogSink('release-loop');
  process.exitCode = runEmergencyPublishSwitchSimulation();
}
