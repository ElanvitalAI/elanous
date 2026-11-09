import { gateFileReceiptKey, planGateFileReceipts, type GateFileReceipt, type GateFileReceiptIdentity } from '../../scripts/release-loop/gate-file-receipts.js';
import type { GateSweepCertificate } from './gate-receipt-file-closure-cas.js';

export interface GateSteadyStateCutInvocation {
  runId: string;
  cutHead40: string;
  selectedFiles: readonly string[];
  outcome: 'pass' | 'fail' | 'unmeasured';
}

export interface GateSteadyStateProofInput {
  cutHead40: string;
  trainHead40: string;
  nowMs: number;
  identities: readonly GateFileReceiptIdentity[];
  trainReceipts: readonly GateFileReceipt[];
  certificate: GateSweepCertificate;
  cutInvocations: readonly GateSteadyStateCutInvocation[];
}

export interface GateSteadyStateProof {
  gateRunsForCut: number;
  residualFiles: number;
  totalFiles: number;
  certificateAgeMs: number;
  trainReceiptFiles: number;
  trainReceiptRatio: number;
  complete: boolean;
  reasons: string[];
}

/** One simulated cut report, derived from the production file-receipt planner and persisted proof shapes. */
export function simulateGateSteadyStateProof(input: GateSteadyStateProofInput): GateSteadyStateProof {
  const reasons: string[] = [];
  if (!/^[a-f0-9]{40}$/i.test(input.cutHead40) || !/^[a-f0-9]{40}$/i.test(input.trainHead40))
    reasons.push('invalid-head');
  const files = input.identities.map((row) => row.file);
  const uniqueFiles = new Set(files);
  if (!files.length || uniqueFiles.size !== files.length) reasons.push('invalid-file-inventory');

  const certificate = input.certificate;
  if (!Number.isSafeInteger(certificate.sweepConcurrency) || certificate.sweepConcurrency <= 0
    || !Number.isFinite(certificate.measuredAt) || certificate.measuredAt < 0
    || !Number.isFinite(certificate.maxAgeMs) || certificate.maxAgeMs < 0
    || !Number.isFinite(certificate.maxDirtyRatio) || certificate.maxDirtyRatio < 0 || certificate.maxDirtyRatio > 1
    || typeof certificate.thresholdSource !== 'string' || !certificate.thresholdSource.trim())
    reasons.push('certificate-policy-invalid');

  const certificateAgeMs = input.nowMs - input.certificate.measuredAt;
  if (!Number.isFinite(input.certificate.maxAgeMs) || input.certificate.maxAgeMs < 0
    || !Number.isFinite(certificateAgeMs) || certificateAgeMs < 0 || certificateAgeMs > input.certificate.maxAgeMs)
    reasons.push('certificate-age-invalid');
  if (input.certificate.sourceHead40 !== input.trainHead40
    || input.identities.some((row) => row.imageDigest !== input.certificate.imageDigest)
    || files.some((file) => input.certificate.fileKeys[file] !== gateFileReceiptKey(input.identities.find((row) => row.file === file)!))
    || Object.keys(input.certificate.fileKeys).length !== files.length) reasons.push('certificate-inventory-mismatch');

  const receiptPlan = planGateFileReceipts({ current: input.identities, receipts: input.trainReceipts });
  const trainReceiptFiles = receiptPlan.reuse.filter((receipt) => receipt.lane === 'train'
    && receipt.sourceHead40 === input.trainHead40 && receipt.outcome === 'pass').length;
  if (receiptPlan.reuse.length !== trainReceiptFiles || input.trainReceipts.length !== trainReceiptFiles)
    reasons.push('train-receipts-invalid');
  const residual = receiptPlan.measure.map((row) => row.file).sort();

  const cutRuns = input.cutInvocations.filter((row) => row.cutHead40 === input.cutHead40);
  if (cutRuns.length !== 1 || !cutRuns[0]?.runId.trim()) reasons.push('cut-gate-run-count');
  if (cutRuns.length === 1 && (cutRuns[0]!.outcome !== 'pass'
    || JSON.stringify([...cutRuns[0]!.selectedFiles].sort()) !== JSON.stringify(residual)))
    reasons.push('cut-gate-incomplete');
  // A cut that carries every file still needs one measured gate run; the planner deliberately keeps that boundary explicit.
  if (!residual.length) reasons.push('cut-has-no-measured-files');

  return { gateRunsForCut: cutRuns.length, residualFiles: residual.length, totalFiles: files.length,
    certificateAgeMs, trainReceiptFiles, trainReceiptRatio: files.length ? trainReceiptFiles / files.length : 0,
    complete: reasons.length === 0, reasons };
}
