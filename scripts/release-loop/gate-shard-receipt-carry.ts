import { createHash } from 'node:crypto';
import { gateShardRuntimeIdentityKey } from './gate-shard-dispatch.js';
import type { GateShardSavedResult } from './gate-shard-receipts.js';

type ReceiptWithSources = GateShardSavedResult['receipt'] & {
  sourceRunIds?: string[];
  sourceEvidence?: Array<{ runId: string; evidencePath: string; evidenceSha256: string }>;
};

function stableRecord(value: Record<string, string> | undefined): Record<string, string> | null {
  if (!value || Object.values(value).some((hash) => !/^[a-f0-9]{64}$/i.test(hash))) return null;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
/** Exact test and execution inputs that must match before two successful runs can share a receipt. */
export function gateShardReceiptInputFingerprint(receipt: GateShardSavedResult['receipt']): string | null {
  const identity = receipt.runtimeIdentity;
  const testedFileHashes = stableRecord(receipt.testedFileHashes);
  if (!identity || !testedFileHashes || !receipt.runtimeSourceFingerprint || !receipt.lockfileHash
    || !receipt.graphEntry || !receipt.recipeCommand || !Number.isSafeInteger(receipt.recipeTimeoutMs)
    || !/^[a-f0-9]{64}$/i.test(receipt.runtimeSourceFingerprint) || !/^[a-f0-9]{64}$/i.test(receipt.lockfileHash)
    || !receipt.imageDigest || !/^sha256:[a-f0-9]{64}$/i.test(receipt.imageDigest) || !receipt.envKey || !receipt.envFingerprint
    || receipt.envFingerprint !== identity.envFingerprint
    || receipt.envKey !== gateShardRuntimeIdentityKey(identity, receipt.lockfileHash)
    || JSON.stringify(Object.keys(testedFileHashes).sort()) !== JSON.stringify([...receipt.files].sort())
    || !receipt.executions?.length || receipt.executions.some((execution) => execution.imageDigest !== receipt.imageDigest
      || execution.runtimeIdentity.bunVersion !== identity.bunVersion || execution.runtimeIdentity.platform !== identity.platform
      || execution.runtimeIdentity.architecture !== identity.architecture || execution.runtimeIdentity.envFingerprint !== identity.envFingerprint
      || (execution.runtimeIdentity.baseImageDigest ?? '') !== (identity.baseImageDigest ?? ''))
    || !/^[a-f0-9]{40}$/i.test(receipt.head40) || !/^[a-f0-9]{40}$/i.test(receipt.base40)) return null;
  const canonical = {
    version: receipt.version,
    head40: receipt.head40.toLowerCase(),
    base40: receipt.base40.toLowerCase(),
    shard: receipt.id,
    files: [...receipt.files],
    testedFileHashes,
    graphSha: receipt.graphSha,
    recipeSha: receipt.recipeSha,
    graphEntry: receipt.graphEntry,
    recipeCommand: receipt.recipeCommand,
    recipeTimeoutMs: receipt.recipeTimeoutMs,
    envKey: receipt.envKey,
    envFingerprint: receipt.envFingerprint,
    imageDigest: receipt.imageDigest,
    runtimeIdentity: {
      bunVersion: identity.bunVersion,
      platform: identity.platform,
      architecture: identity.architecture,
      envFingerprint: identity.envFingerprint,
      baseImageDigest: identity.baseImageDigest ?? '',
    },
    runtimeSourceFingerprint: receipt.runtimeSourceFingerprint,
    lockfileHash: receipt.lockfileHash,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function isPassing(result: GateShardSavedResult): boolean {
  return result.receipt.status === 'complete' && result.receipt.failureIds.length === 0
    && result.receipt.errorIds.length === 0 && result.runs.length > 0
    && result.runs.every((run) => run.rc === 0 && run.ran > 0 && run.fail === 0 && run.errors === 0 && run.pass === run.ran);
}

function withSourceRunIds(result: GateShardSavedResult): GateShardSavedResult {
  const receipt = result.receipt as ReceiptWithSources;
  const sourceRunIds = [...new Set([...(receipt.sourceRunIds ?? []), ...(receipt.graphRunId ? [receipt.graphRunId] : [])])].sort();
  return { ...result, receipt: { ...result.receipt, sourceRunIds } as ReceiptWithSources };
}

function executionKey(value: NonNullable<GateShardSavedResult['receipt']['executions']>[number]): string {
  return JSON.stringify({ branch: value.branch, attemptId: value.attemptId, host: value.host,
    imageDigest: value.imageDigest, runtimeIdentity: value.runtimeIdentity });
}

function sourceEvidenceOf(receipt: ReceiptWithSources): Array<{ runId: string; evidencePath: string; evidenceSha256: string }> {
  const retained = (receipt.sourceEvidence ?? []).filter((row) => typeof row.runId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]*\.result\.json$/.test(row.evidencePath)
    && /^[a-f0-9]{64}$/i.test(row.evidenceSha256));
  const current = /^[A-Za-z0-9][A-Za-z0-9._-]*\.result\.json$/.test(receipt.evidencePath)
    && /^[a-f0-9]{64}$/i.test(receipt.evidenceSha256)
    ? [{ runId: receipt.graphRunId ?? 'unscoped', evidencePath: receipt.evidencePath, evidenceSha256: receipt.evidenceSha256 }] : [];
  return [...new Map([...retained, ...current].map((row) => [`${row.runId}:${row.evidenceSha256}`, row])).values()];
}

/** Merge provenance only when both successful measurements have the exact same test/runtime input. */
export function mergePassingGateShardResults(existing: GateShardSavedResult | null,
  incoming: GateShardSavedResult): GateShardSavedResult {
  const next = withSourceRunIds(incoming);
  if (!existing || !isPassing(existing) || !isPassing(next)) return next;
  const priorFingerprint = gateShardReceiptInputFingerprint(existing.receipt);
  const nextFingerprint = gateShardReceiptInputFingerprint(next.receipt);
  if (!priorFingerprint || priorFingerprint !== nextFingerprint) return next;

  const priorReceipt = existing.receipt as ReceiptWithSources;
  const nextReceipt = next.receipt as ReceiptWithSources;
  const executions = [...(priorReceipt.executions ?? []), ...(nextReceipt.executions ?? [])];
  const uniqueExecutions = [...new Map(executions.map((execution) => [executionKey(execution), execution])).values()];
  const sourceRunIds = [...new Set([
    ...(priorReceipt.sourceRunIds ?? []), ...(priorReceipt.graphRunId ? [priorReceipt.graphRunId] : []),
    ...(nextReceipt.sourceRunIds ?? []), ...(nextReceipt.graphRunId ? [nextReceipt.graphRunId] : []),
  ])].sort();
  const sourceEvidence = [...new Map([...sourceEvidenceOf(priorReceipt), ...sourceEvidenceOf(nextReceipt)]
    .map((evidence) => [`${evidence.runId}:${evidence.evidenceSha256}`, evidence])).values()];
  return { ...next, receipt: { ...next.receipt, executions: uniqueExecutions, sourceRunIds, sourceEvidence } as ReceiptWithSources };
}
