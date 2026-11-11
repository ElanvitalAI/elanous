#!/usr/bin/env bun
import { decideEmergencyPublishSwitch } from './emergency-publish-switch.js';
import { emitNodeResult, latestGateOutput, readGraphContext } from './node-verdict.js';
import { debug } from '../../src/debug/log.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isFailedGateOutput(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  if (output.outcome === 'error') return false;
  if (['fail', 'regression', 'blocked'].includes(String(output.outcome ?? ''))) return true;
  return output.outcome === undefined && output.verdict === 'fail';
}

/** Find the start of the current uninterrupted failure streak, using confirmation times rather than gate start times. */
export function emergencyGateBlockedSince(history: NonNullable<ReturnType<typeof readGraphContext>['nodeHistory']>): string | undefined {
  const gates = history.filter((row) => row.nodeId === 'gate' || row.nodeId === 'residual-run');
  if (!gates.length || !isFailedGateOutput(gates.at(-1)?.output)) return undefined;
  let firstFailure: string | undefined;
  for (const row of [...gates].reverse()) {
    if (!isFailedGateOutput(row.output)) break;
    if (row.endedAt) firstFailure = row.endedAt;
  }
  return firstFailure;
}

/** Production graph decision node. Failure age comes from this run's contiguous gate failures. */
export function runEmergencyPublishSwitchSimulation(env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now): number {
  let version = '';
  try {
    const context = readGraphContext(env);
    version = context.input.version;
    if (!context.runId) throw new Error('current normal release runId required');
    const gate = latestGateOutput(context);
    const blockedSince = emergencyGateBlockedSince(context.nodeHistory ?? []);
    const request = record(context.input.emergencyPublish);
    const normalGateOutcome = typeof gate?.outcome === 'string' ? gate.outcome : 'unavailable';
    const commits = request?.hotfixCommits;
    if (!request || typeof request.securityFix !== 'boolean' || !Array.isArray(commits)
      || !commits.every((item) => typeof item === 'string') || !blockedSince)
      throw new Error('same-run failed-gate confirmation time and emergency security-fix request required');
    const decision = decideEmergencyPublishSwitch({ normalRunId: context.runId, normalGateOutcome,
      securityFix: request.securityFix, hotfixCommits: commits, blockedSince, nowMs: now() });
    debug.log('release-loop.emergency-publish', decision.action === 'switch' ? 'switch-selected' : 'switch-declined', {
      runId: context.runId, version, action: decision.action, evidence: decision.evidence, reasons: decision.reasons,
    });
    emitNodeResult({ ...decision, outcome: decision.action, verdict: 'pass',
      summary: decision.eligible ? 'emergency reduced gate selected from same-run evidence'
        : `emergency publish declined: ${decision.reasons.join(', ')}` });
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
