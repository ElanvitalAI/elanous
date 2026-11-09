#!/usr/bin/env bun
import { debug } from '../../src/debug/log.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import { emitNodeResult, readGraphContext, type GraphContext } from './node-verdict.js';

/** The receipt-audit producer must report the complete file universe, including opaque files. */
export interface SkipEvidenceAudit {
  commit: string;
  measurement: { complete: boolean; totalFiles: number; coveredFiles: number; unmeasuredFiles: number };
  introduced: string[];
  ledgerDefects: Array<{ kind: 'receipt-write' | 'verdict-write' | 'baseline-write'; detail: string }>;
  otherFailures: string[];
}

export interface SkipEvidenceDecision {
  outcome: 'ok' | 'fail';
  verdict: 'pass' | 'fail';
  eligible: boolean;
  reason: string;
  commit: string | null;
  evidence: { totalFiles: number; coveredFiles: number; unmeasuredFiles: number; ledgerDefects: SkipEvidenceAudit['ledgerDefects'] } | null;
  /** A bookkeeping exception never becomes a public known issue. */
  knownIssues: [];
  summary: string;
}

const SHA = /^[0-9a-f]{40}$/i;
const DEFECTS = new Set(['receipt-write', 'verdict-write', 'baseline-write']);

/** Fail closed on missing coverage, unknown failures, or an unbound audit commit. */
export function decideGateSkipByEvidence(value: unknown, cutCommit: unknown): SkipEvidenceDecision {
  const denied = (reason: string): SkipEvidenceDecision => ({ outcome: 'fail', verdict: 'fail', eligible: false,
    reason, commit: typeof cutCommit === 'string' && SHA.test(cutCommit) ? cutCommit : null,
    evidence: null, knownIssues: [], summary: `skip-by-evidence refused: ${reason}` });
  if (typeof cutCommit !== 'string' || !SHA.test(cutCommit)) return denied('cut commit is missing or invalid');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return denied('receipt audit is missing');
  const audit = value as Partial<SkipEvidenceAudit>;
  if (audit.commit !== cutCommit) return denied('receipt audit is for a different cut commit');
  const measure = audit.measurement;
  if (!measure || measure.complete !== true || !Number.isSafeInteger(measure.totalFiles) || measure.totalFiles <= 0
    || !Number.isSafeInteger(measure.coveredFiles) || measure.coveredFiles < 0
    || !Number.isSafeInteger(measure.unmeasuredFiles) || measure.unmeasuredFiles < 0
    || measure.coveredFiles + measure.unmeasuredFiles !== measure.totalFiles || measure.unmeasuredFiles !== 0)
    return denied('measurement is incomplete or file coverage is inconsistent');
  if (!Array.isArray(audit.introduced) || !audit.introduced.every((id) => typeof id === 'string' && id.length > 0))
    return denied('introduced failures are unmeasured');
  if (audit.introduced.length) return denied('introduced regressions remain');
  if (!Array.isArray(audit.otherFailures) || !audit.otherFailures.every((reason) => typeof reason === 'string'))
    return denied('non-ledger failures are unmeasured');
  if (audit.otherFailures.length) return denied('a non-ledger failure remains');
  if (!Array.isArray(audit.ledgerDefects) || audit.ledgerDefects.length === 0
    || !audit.ledgerDefects.every((item) => item && DEFECTS.has(item.kind)
      && typeof item.detail === 'string' && item.detail.trim().length > 0))
    return denied('the only remaining defects are not proven to be ledger writes');
  const evidence = { totalFiles: measure.totalFiles, coveredFiles: measure.coveredFiles,
    unmeasuredFiles: measure.unmeasuredFiles, ledgerDefects: audit.ledgerDefects };
  return { outcome: 'ok', verdict: 'pass', eligible: true, reason: 'complete measurement; zero introduced regressions; ledger writes only',
    commit: cutCommit, evidence, knownIssues: [], summary: `skip-by-evidence: ${measure.coveredFiles}/${measure.totalFiles} files measured; introduced 0; ${audit.ledgerDefects.length} ledger write defect(s)` };
}

export function skipGateFromContext(context: GraphContext): SkipEvidenceDecision {
  const repairedCommit = Object.entries(context.outputs)
    .filter(([nodeId, output]) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId) && output.outcome === 'ok'
      && typeof output.commit === 'string' && SHA.test(output.commit))
    .at(-1)?.[1]?.commit;
  return decideGateSkipByEvidence(context.outputs['receipt-audit'], typeof repairedCommit === 'string' ? repairedCommit
    : context.outputs.cutoff?.commit ?? context.outputs['version-release']?.commit);
}

if (import.meta.main) {
  await registerStandaloneLogSink('release-loop');
  let result: SkipEvidenceDecision;
  try { result = skipGateFromContext(readGraphContext()); }
  catch (error) { result = decideGateSkipByEvidence(undefined, undefined);
    result = { ...result, reason: String(error), summary: `skip-by-evidence refused: ${String(error)}` }; }
  debug.log('release-loop.gate', 'skip-by-evidence', { eligible: result.eligible, reason: result.reason,
    commit: result.commit, evidence: result.evidence });
  emitNodeResult({ ...result });
  if (!result.eligible) process.exitCode = 1;
}
