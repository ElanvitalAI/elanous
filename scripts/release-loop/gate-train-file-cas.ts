import { createHash } from 'node:crypto';
import { auditGateFileReceiptSet, carryGateFileReceipt, gateFileReceiptIdentityFromClosure, gateFileReceiptKey,
  planGateFileReceipts, type GateFileReceipt, type GateFileReceiptIdentity } from './gate-file-receipts.js';
import { readGateFileReceipt, saveGateFileReceipt } from './gate-shard-receipts.js';
import { gitClosureTree } from './gate-closure.js';
import { testFileOfId } from './gate-partial.js';
import { trainGateCasLane, type GateFilePlanLike, type TrainGateCasLane } from './gate-train-cas-adapter.js';

type UncoveredTrainGateCasLane = Extract<TrainGateCasLane, { action: 'run-uncovered' }>;

export interface TrainFileCasPlan {
  root: string;
  expectedFiles: string[];
  identities: GateFileReceiptIdentity[];
  receipts: GateFileReceipt[];
  plan: GateFilePlanLike<GateFileReceiptIdentity, GateFileReceipt>;
  lane: UncoveredTrainGateCasLane;
}

/** Build the first train consumer's file lane from the canonical content+closure+image CAS. */
export function planTrainFileCas(input: {
  repo: string;
  commit: string;
  imageDigest: string | null;
  receiptRoot: string;
  expectedFiles: readonly string[];
}): TrainFileCasPlan | null {
  if (!input.imageDigest || !/^sha256:[a-f0-9]{64}$/i.test(input.imageDigest)
    || !input.expectedFiles.length || new Set(input.expectedFiles).size !== input.expectedFiles.length) return null;
  let tree: ReturnType<typeof gitClosureTree>;
  try { tree = gitClosureTree(input.repo, input.commit); } catch { return null; }
  const identities = input.expectedFiles.map((file) => gateFileReceiptIdentityFromClosure(tree, file, input.imageDigest!));
  if (identities.some((identity) => !identity)) return null;
  const current = identities as GateFileReceiptIdentity[];
  const previous = current.flatMap((identity) => {
    const key = gateFileReceiptKey(identity);
    const envelope = key ? readGateFileReceipt(input.receiptRoot, key) : null;
    if (!envelope) return [];
    const { recordSha256: _recordSha256, ...receipt } = envelope;
    return [receipt];
  });
  const plan = planGateFileReceipts({ current, receipts: previous });
  const lane = trainGateCasLane(plan, input.expectedFiles);
  if (lane.action !== 'run-uncovered') return null;
  return { root: input.receiptRoot, expectedFiles: [...input.expectedFiles], identities: current,
    receipts: previous, plan, lane };
}

function fileReceipt(identity: GateFileReceiptIdentity, head40: string, outcome: 'pass' | 'fail' | 'error',
  ids: string[], runId: string | null, version: string): GateFileReceipt {
  const file = identity.file;
  const closureFiles = [...new Set(identity.closureFiles)].sort();
  const closureDigest = createHash('sha256').update(JSON.stringify(
    closureFiles.map((path) => [path, identity.contentHashes[path]]))).digest('hex');
  const base = { file, closureFiles, closureDigest, imageDigest: identity.imageDigest,
    key: gateFileReceiptKey(identity)!, sourceHead40: head40, lane: 'train' as const,
    evidence: { producer: 'train-gate', runId, version, measuredFile: file } };
  if (outcome === 'pass') return { ...base, outcome: 'pass' };
  return outcome === 'fail' ? { ...base, outcome: 'fail', owner: 'train-gate', failureIds: ids }
    : { ...base, outcome: 'error', owner: 'train-gate', errorIds: ids };
}

/** Persist a complete train result and independently re-audit what the durable CAS now contains. */
export function recordTrainFileCasResult(input: {
  planned: TrainFileCasPlan;
  head40: string;
  runId: string | null;
  version: string;
  measuredFiles: readonly string[];
  actualImageDigests: readonly (string | null)[] | null;
  failures: readonly string[];
  errors: readonly string[];
  complete: boolean;
}): { ok: true; reused: number; measured: number; files: string[] } | { ok: false; reason: string } {
  const { planned } = input;
  const expectedMeasured = planned.lane.files;
  if (!input.complete) return { ok: false, reason: 'train-file-cas-measurement-incomplete' };
  if (new Set(input.measuredFiles).size !== input.measuredFiles.length
    || JSON.stringify([...input.measuredFiles].sort()) !== JSON.stringify([...expectedMeasured].sort()))
    return { ok: false, reason: 'train-file-cas-measured-inventory-mismatch' };
  if (expectedMeasured.length) {
    const expectedImageDigest = planned.identities[0]?.imageDigest.toLowerCase();
    if (!expectedImageDigest || !input.actualImageDigests?.length
      || input.actualImageDigests.some((digest) => typeof digest !== 'string' || digest.toLowerCase() !== expectedImageDigest))
      return { ok: false, reason: 'train-file-cas-executed-image-mismatch' };
  }
  const measuredSet = new Set(expectedMeasured);
  for (const id of [...input.failures, ...input.errors]) {
    let file: string;
    try { file = testFileOfId(id); }
    catch { return { ok: false, reason: 'train-file-cas-unattributed-result-id' }; }
    if (!measuredSet.has(file)) return { ok: false, reason: 'train-file-cas-result-outside-measured-inventory' };
  }
  const identityByFile = new Map(planned.identities.map((identity) => [identity.file, identity]));
  const reused = planned.plan.reuse.filter((receipt) => receipt.outcome === 'pass')
    .map((receipt) => carryGateFileReceipt(receipt, input.head40));
  const measured = expectedMeasured.flatMap((file) => {
    const identity = identityByFile.get(file);
    if (!identity) return [];
    const failures = input.failures.filter((id) => testFileOfId(id) === file);
    const errors = input.errors.filter((id) => testFileOfId(id) === file);
    return [failures.length && errors.length
      ? fileReceipt(identity, input.head40, 'fail', [...failures, ...errors], input.runId, input.version)
      : failures.length ? fileReceipt(identity, input.head40, 'fail', failures, input.runId, input.version)
        : errors.length ? fileReceipt(identity, input.head40, 'error', errors, input.runId, input.version)
          : fileReceipt(identity, input.head40, 'pass', [], input.runId, input.version)];
  });
  const candidate = [...reused, ...measured];
  const beforeWrite = auditGateFileReceiptSet({ identities: planned.identities, receipts: candidate });
  if (!beforeWrite.ok) return { ok: false, reason: `train-file-cas-audit:${beforeWrite.reason}` };
  try {
    for (const receipt of candidate) saveGateFileReceipt(planned.root, receipt);
    const persisted = candidate.flatMap((receipt) => {
      const envelope = readGateFileReceipt(planned.root, receipt.key);
      if (!envelope) return [];
      const { recordSha256: _recordSha256, ...saved } = envelope;
      return [saved];
    });
    const audit = auditGateFileReceiptSet({ identities: planned.identities, receipts: persisted });
    if (!audit.ok) return { ok: false, reason: `train-file-cas-persisted-audit:${audit.reason}` };
  } catch (error) { return { ok: false, reason: `train-file-cas-write:${String(error).slice(0, 180)}` }; }
  return { ok: true, reused: reused.length, measured: measured.length, files: planned.expectedFiles };
}
