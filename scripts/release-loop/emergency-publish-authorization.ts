import type { GraphContext } from './node-verdict.js';
import { releaseCutRecord } from './release-cut-record.js';

/** A reduced emergency gate can replace the failed normal gate only when every receipt is bound to this run. */
export function hasPassingEmergencyPublishGate(context: GraphContext): boolean {
  const runId = context.runId;
  const request = context.input.emergencyPublish;
  const switched = context.outputs['emergency-switch'];
  const gate = context.outputs['emergency-gate'];
  const releaseCommit = releaseCutRecord(context)?.commit;
  if (!runId || !request || typeof request !== 'object' || Array.isArray(request)) return false;
  const hotfixCommits = (request as Record<string, unknown>).hotfixCommits;
  if (!Array.isArray(hotfixCommits) || hotfixCommits.length !== 1) return false;
  const hotfixCommit = hotfixCommits[0];
  return typeof hotfixCommit === 'string' && /^[0-9a-f]{40}$/i.test(hotfixCommit)
    && switched?.action === 'switch' && switched.eligible === true && switched.promoted === true
    && switched.normalRunId === runId && typeof switched.hotfixCommit === 'string'
    && switched.hotfixCommit.toLowerCase() === hotfixCommit.toLowerCase()
    && gate?.outcome === 'ok' && gate.verdict === 'pass' && gate.ok === true && gate.runId === runId
    && gate.hotfixCommit === hotfixCommit.toLowerCase()
    && typeof releaseCommit === 'string' && gate.releaseCommit === releaseCommit
    && gate.measuredCommit === releaseCommit && gate.unclassified === 0
    && typeof gate.introduced === 'number' && gate.introduced === 0
    && typeof gate.preexisting === 'number' && gate.gateExitCode === 0
    && typeof gate.remote === 'string' && gate.remote.trim().length > 0
    && Number.isSafeInteger(gate.alwaysInclude) && Array.isArray(gate.alwaysIncludeMissing)
    && gate.alwaysIncludeMissing.length === 0 && !gate.unmeasured
    && Array.isArray(gate.changedFiles) && gate.changedFiles.length > 0
    && Array.isArray(gate.testFiles) && gate.testFiles.length > 0;
}
