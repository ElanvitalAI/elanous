#!/usr/bin/env bun
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../src/instance/resolve.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import { podCommandImageFor } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { auditGateFileReceiptSet, gateFileReceiptIdentityFromClosure, gateFileReceiptKey, type GateFileReceiptIdentity } from './gate-file-receipts.js';
import { gateAssignableTestsAtCommit } from './gate-baseline-receipt.js';
import { gitClosureTree } from './gate-closure.js';
import { gateImagePinPath, readGateImagePin } from './gate-image-pin.js';
import { readGateFileReceipt } from './gate-shard-receipts.js';
import { finishNode, latestGateOutput, readGraphContext, type GraphContext } from './node-verdict.js';

export interface GateFileReceiptAudit {
  outcome: 'ok' | 'fail' | 'error';
  verdict: 'pass' | 'fail';
  commit: string | null;
  measurement: { complete: boolean; totalFiles: number; coveredFiles: number; unmeasuredFiles: number };
  introduced: string[];
  ledgerDefects: Array<{ kind: 'receipt-write' | 'verdict-write' | 'baseline-write'; detail: string }>;
  otherFailures: string[];
  summary: string;
}

export type GateFileReceiptAuditNodeDeps = {
  repo?: string;
  roots?: { instance: string; ledger: string };
  testsAtCommit?: typeof gateAssignableTestsAtCommit;
  closureTree?: typeof gitClosureTree;
  pinnedImage?: (instanceRoot: string, version: string, runId: string, commit: string) => string | null;
  readReceipt?: typeof readGateFileReceipt;
  finish?: typeof finishNode;
};

const SHA40 = /^[a-f0-9]{40}$/i;

function receiptWasMeasuredInRun(receipt: { file: string; evidence: unknown }, opaqueFiles: ReadonlySet<string>, runId: string): boolean {
  if (!opaqueFiles.has(receipt.file)) return true;
  if (!receipt.evidence || typeof receipt.evidence !== 'object' || Array.isArray(receipt.evidence)) return false;
  return (receipt.evidence as Record<string, unknown>).runId === runId;
}

/** Check one exact release file universe against closure+image-keyed receipts; missing files go to residual-run. */
export function auditGateFileReceipts(context: GraphContext, deps: GateFileReceiptAuditNodeDeps = {}): GateFileReceiptAudit {
  const repairedCommit = Object.entries(context.outputs)
    .filter(([nodeId, output]) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId) && output.outcome === 'ok'
      && typeof output.commit === 'string' && SHA40.test(output.commit))
    .at(-1)?.[1]?.commit;
  const commit = typeof repairedCommit === 'string' ? repairedCommit
    : context.outputs.cutoff?.commit ?? context.outputs['version-release']?.commit;
  const denied = (reason: string): GateFileReceiptAudit => ({ outcome: 'error', verdict: 'fail',
    commit: typeof commit === 'string' && SHA40.test(commit) ? commit : null,
    measurement: { complete: false, totalFiles: 0, coveredFiles: 0, unmeasuredFiles: 0 }, introduced: [], ledgerDefects: [],
    otherFailures: [reason], summary: `file receipt audit unavailable: ${reason}` });
  if (typeof commit !== 'string' || !SHA40.test(commit)) return denied('cut commit is missing or invalid');
  if (!context.runId) return denied('release graph run id is missing');
  const runId = context.runId;
  const gateOutput = latestGateOutput(context);
  if (!gateOutput) return denied('gate output is missing');
  const repo = deps.repo ?? resolve(import.meta.dir, '../..');
  const roots = deps.roots ?? { instance: effectiveInstanceRoot(), ledger: releaseLedgerRoot() };
  let files: string[] | null;
  try { files = (deps.testsAtCommit ?? gateAssignableTestsAtCommit)(repo, commit); }
  catch (error) { return denied(`test inventory failed: ${String(error)}`); }
  if (!files?.length) return denied('test inventory is empty or unreadable');
  const image = `${podCommandImageFor([], true).split(':')[0]}:${commit.slice(0, 12)}`;
  let imageDigest: string | null;
  try { imageDigest = (deps.pinnedImage ?? ((instance, version, runId, sha) =>
    readGateImagePin(gateImagePinPath(instance, version, runId), runId, image, sha)?.digest ?? null))
    (roots.instance, context.input.version, context.runId, commit); }
  catch (error) { return denied(`pinned image lookup failed: ${String(error)}`); }
  if (!imageDigest) return denied('pinned image digest is missing');
  let tree: ReturnType<typeof gitClosureTree>;
  try { tree = (deps.closureTree ?? gitClosureTree)(repo, commit); }
  catch (error) { return denied(`cut closure snapshot failed: ${String(error)}`); }
  const identities: GateFileReceiptIdentity[] = [];
  let opaque = 0;
  let unavailable = 0;
  for (const file of files) {
    const identity = gateFileReceiptIdentityFromClosure(tree, file, imageDigest);
    if (!identity) { unavailable++; continue; }
    if (identity.opaqueReasons?.length) opaque++;
    identities.push(identity);
  }
  const receipts = identities.flatMap((identity) => {
    const key = gateFileReceiptKey(identity);
    if (!key) return [];
    const receipt = (deps.readReceipt ?? readGateFileReceipt)(`${roots.ledger}/release/${context.input.version}/gate-logs/cut/receipts`, key);
    return receipt ? [receipt] : [];
  });
  const opaqueFiles = new Set(identities.filter((identity) => identity.opaqueReasons?.length).map((identity) => identity.file));
  const attributableReceipts = receipts.filter((receipt) => {
    const headMatches = receipt.sourceHead40 === commit
      ? receipt.carriedToHead40 === undefined || receipt.carriedToHead40 === commit
      : receipt.carriedToHead40 === commit;
    if (!headMatches) return false;
    return receiptWasMeasuredInRun(receipt, opaqueFiles, runId);
  });
  const audited = auditGateFileReceiptSet({ identities, receipts: attributableReceipts });
  const complete = unavailable === 0 && audited.ok && identities.length === files.length;
  const coveredFiles = identities.filter((identity) => {
    const fileReceipts = attributableReceipts.filter((receipt) => receipt.file === identity.file);
    return auditGateFileReceiptSet({ identities: [identity], receipts: fileReceipts }).ok;
  }).length;
  const unmeasuredFiles = files.length - coveredFiles;
  const introduced = Array.isArray(gateOutput?.introduced) ? gateOutput.introduced.filter((id): id is string => typeof id === 'string') : [];
  const gatePassed = gateOutput?.outcome === 'ok' && introduced.length === 0;
  const outcome = complete && gatePassed ? 'ok'
    : unavailable > 0 ? 'error' : 'fail';
  const result: GateFileReceiptAudit = { outcome, verdict: outcome === 'ok' ? 'pass' : 'fail', commit,
    measurement: { complete, totalFiles: files.length, coveredFiles, unmeasuredFiles }, introduced,
    ledgerDefects: [], otherFailures: gatePassed ? [] : [
      typeof gateOutput.summary === 'string' ? gateOutput.summary : `gate outcome was ${String(gateOutput.outcome)}`,
    ], summary: complete && gatePassed
      ? `file receipt audit complete: ${coveredFiles}/${files.length} files`
      : `file receipt audit incomplete: ${coveredFiles}/${files.length} files; gate passed=${gatePassed}; ${opaque} opaque closure(s); ${audited.ok ? 'none' : audited.reason}` };
  return result;
}

/** Execute the receipt-audit graph node with injectable filesystem and ledger boundaries for simulations. */
export function runGateFileReceiptAuditNode(context: GraphContext, deps: GateFileReceiptAuditNodeDeps = {}):
  { result: GateFileReceiptAudit; exitCode: number } {
  const result = auditGateFileReceipts(context, deps);
  const exitCode = (deps.finish ?? finishNode)(context.nodeId ?? 'receipt-audit', context.input.version, { ...result });
  return { result, exitCode };
}

function main(): void {
  void registerStandaloneLogSink('release-loop').then(() => {
    const context = readGraphContext();
    const { result, exitCode } = runGateFileReceiptAuditNode(context);
    debug.log('release-loop.gate', 'file-receipt-audit', { commit: result.commit,
      ...result.measurement, outcome: result.outcome, summary: result.summary });
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
