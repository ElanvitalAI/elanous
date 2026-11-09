import { auditGateFileReceiptSet, carryGateFileReceipt, gateFileReceiptClosureDigest, gateFileReceiptKey, planGateFileReceipts, type GateFileReceipt, type GateFileReceiptIdentity } from '../../scripts/release-loop/gate-file-receipts.js';

// 출처: 내부 문서 `RFC-release-gate-file-receipts-2026-11-08` § sweep certificate fixture policy.
const SWEEP_CERTIFICATE_MAX_AGE_MS = 60_000;
// 출처: 내부 문서 `RFC-release-gate-file-receipts-2026-11-08` § dirty-set full-sweep policy.
const SWEEP_CERTIFICATE_MAX_DIRTY_RATIO = 0.1;
// 출처: 내부 문서 `RFC-release-gate-file-receipts-2026-11-08` § same-concurrency supplemental run fixture.
const SIMULATED_SWEEP_CONCURRENCY = 24;

export interface GateReceiptFileClosureScenario {
  sourceRunId: string;
  trainHead40: string;
  cutHead40: string;
  imageDigest: string;
  prior: readonly GateFileReceiptIdentity[];
  priorReceipts: readonly GateFileReceipt[];
  appended: readonly GateFileReceiptIdentity[];
  isolated: readonly GateFileReceiptIdentity[];
  interference?: Readonly<Record<string, readonly string[]>>;
  supplementalOutcome?: 'pass' | 'fail' | 'unmeasured';
  runSupplemental: (input: { tests: string[]; priorCommit: string; commit: string; selectedFiles: string[]; concurrency: number },
    outcome: 'pass' | 'fail' | 'unmeasured') => GateReceiptSupplementalGate;
}

export interface GateReceiptSupplementalGate {
  aggregate: 'complete' | 'incomplete';
  gateOutcome: 'pass' | 'fail' | 'unmeasured';
  publishDecision: 'eligible' | 'blocked';
  executedConcurrency: number;
  plan: { fullSweep: boolean; rerunShardIds: string[] };
}

export interface GateReceiptFileClosureObservation {
  appendPlan: ReturnType<typeof planGateFileReceipts>;
  cutPlan: ReturnType<typeof planGateFileReceipts>;
  isolatedPlan: ReturnType<typeof planGateFileReceipts>;
  measuredAfterAppend: GateFileReceipt[];
  carriedToCut: GateFileReceipt[];
  isolatedResults: GateFileReceipt[];
  sweepCertificate: GateSweepCertificate;
  refreshedSweepCertificate?: GateSweepCertificate;
  appendInvalidation: GateSweepAppendInvalidation;
  supplementalGate: GateReceiptSupplementalGate;
  certificateRefreshBlocked: boolean;
}

export interface GateSweepCertificate {
  sourceHead40: string;
  imageDigest: string;
  fileKeys: Readonly<Record<string, string>>;
  sweepConcurrency: number;
  measuredAt: number;
  maxAgeMs: number;
  maxDirtyRatio: number;
  thresholdSource: string;
}

export interface GateSweepAppendInvalidation {
  dirtyFiles: string[];
  removedFiles: string[];
  supplementalFiles: string[];
  supplementalConcurrency: number;
  fullSweepRequired: boolean;
  reason?: 'image-changed' | 'dirty-ratio-exceeded' | 'certificate-too-old';
}

/** Compare a sweep certificate with a later tree and expand dirty files by interference neighbors. */
export function planGateSweepAppend(input: {
  certificate: GateSweepCertificate;
  current: readonly GateFileReceiptIdentity[];
  interference: Readonly<Record<string, readonly string[]>>;
  now: number;
  sweepConcurrency: number;
}): GateSweepAppendInvalidation {
  if (input.sweepConcurrency !== input.certificate.sweepConcurrency)
    throw new Error('sweep concurrency does not match certificate');
  const currentKeys = Object.fromEntries(input.current.flatMap((row) => {
    const key = gateFileReceiptKey(row);
    return key ? [[row.file, key]] : [];
  }));
  const currentFiles = new Set(input.current.map((row) => row.file));
  const files = [...new Set([...Object.keys(input.certificate.fileKeys), ...currentFiles])].sort();
  const changedFiles = files.filter((file) => input.certificate.fileKeys[file] !== currentKeys[file]);
  const removedFiles = changedFiles.filter((file) => !currentFiles.has(file));
  const dirtyFiles = changedFiles.filter((file) => currentFiles.has(file));
  const dirtyRatio = changedFiles.length / Math.max(1, Object.keys(input.certificate.fileKeys).length);
  const reason = input.current.some((row) => row.imageDigest !== input.certificate.imageDigest) ? 'image-changed'
    : dirtyRatio > input.certificate.maxDirtyRatio ? 'dirty-ratio-exceeded'
      : input.now - input.certificate.measuredAt > input.certificate.maxAgeMs ? 'certificate-too-old' : undefined;
  const supplementalFiles = reason ? [...currentFiles].sort()
    : [...new Set(changedFiles.flatMap((file) => [file, ...(input.interference[file] ?? [])]))]
      .filter((file) => currentFiles.has(file)).sort();
  return { dirtyFiles, removedFiles, supplementalFiles, supplementalConcurrency: input.sweepConcurrency, fullSweepRequired: reason !== undefined, ...(reason ? { reason } : {}) };
}

export function buildGateSweepCertificate(input: {
  sourceHead40: string;
  imageDigest: string;
  identities: readonly GateFileReceiptIdentity[];
  receipts: readonly GateFileReceipt[];
  measuredAt: number;
  sweepConcurrency: number;
  maxAgeMs: number;
  maxDirtyRatio: number;
  thresholdSource: string;
}): GateSweepCertificate {
  if (!/^[a-f0-9]{40}$/i.test(input.sourceHead40) || !/^sha256:[a-f0-9]{64}$/i.test(input.imageDigest))
    throw new Error('invalid sweep certificate identity');
  if (input.identities.some((row) => row.imageDigest !== input.imageDigest)) throw new Error('sweep certificate image mismatch');
  const audit = auditGateFileReceiptSet({ identities: input.identities, receipts: input.receipts });
  if (!audit.ok) throw new Error(`sweep certificate receipt audit failed: ${audit.reason}`);
  if (input.receipts.some((receipt) => receipt.sourceHead40 !== input.sourceHead40
    && receipt.carriedToHead40 !== input.sourceHead40)) throw new Error('sweep certificate receipt head mismatch');
  const fileKeys = Object.fromEntries(input.identities.flatMap((row) => {
    const key = gateFileReceiptKey(row);
    return key ? [[row.file, key]] : [];
  }));
  if (Object.keys(fileKeys).length !== input.identities.length) throw new Error('sweep certificate has unmeasurable files');
  const { identities: _identities, receipts: _receipts, ...metadata } = input;
  return { ...metadata, fileKeys };
}

export function makeGateFileReceiptSimulationReceipt(identity: GateFileReceiptIdentity, head: string, sourceRunId: string,
  lane: 'train' | 'cut' | 'isolated-recheck' = 'train'): GateFileReceipt {
  const key = gateFileReceiptKey(identity);
  if (!key) throw new Error(`unmeasurable closure: ${identity.file}`);
  const closureFiles = [...new Set(identity.closureFiles)].sort();
  const closureDigest = gateFileReceiptClosureDigest(identity);
  return { file: identity.file, closureFiles, closureDigest, imageDigest: identity.imageDigest, key,
    ...(identity.opaqueReasons?.length ? { opaqueReasons: [...identity.opaqueReasons] } : {}),
    sourceHead40: head, outcome: 'pass', lane, evidence: { file: identity.file, pass: 1, fail: 0, sourceRunId } };
}

/** Replay train→cut carry and isolated rechecks without SSH, Pods, or the live gate. */
export function simGateReceiptFileClosureCas(scenario: GateReceiptFileClosureScenario): GateReceiptFileClosureObservation {
  const appendPlan = planGateFileReceipts({ current: scenario.appended, receipts: scenario.priorReceipts });
  const sweepCertificate = buildGateSweepCertificate({
    sourceHead40: scenario.trainHead40,
    imageDigest: scenario.imageDigest,
    identities: scenario.prior,
    receipts: scenario.priorReceipts,
    sweepConcurrency: SIMULATED_SWEEP_CONCURRENCY,
    measuredAt: 1_000,
    maxAgeMs: SWEEP_CERTIFICATE_MAX_AGE_MS,
    maxDirtyRatio: SWEEP_CERTIFICATE_MAX_DIRTY_RATIO,
    thresholdSource: 'fixture: measured sweep policy',
  });
  const appendInvalidation = planGateSweepAppend({ certificate: sweepCertificate, current: scenario.appended,
    interference: scenario.interference ?? {}, now: 2_000, sweepConcurrency: SIMULATED_SWEEP_CONCURRENCY });
  const supplementalRun = scenario.runSupplemental({ tests: appendInvalidation.supplementalFiles,
    priorCommit: scenario.trainHead40, commit: scenario.cutHead40,
    selectedFiles: appendInvalidation.supplementalFiles, concurrency: appendInvalidation.supplementalConcurrency },
  scenario.supplementalOutcome ?? 'pass');
  const supplementalAccepted = supplementalRun.aggregate === 'complete'
    && supplementalRun.executedConcurrency === sweepCertificate.sweepConcurrency;
  const supplementalGate = supplementalAccepted ? supplementalRun : { ...supplementalRun,
    gateOutcome: 'unmeasured' as const, publishDecision: 'blocked' as const };
  const measuredAfterAppend = supplementalGate.aggregate === 'complete' && supplementalGate.gateOutcome === 'pass'
    ? appendInvalidation.supplementalFiles.flatMap((file) => {
      const identity = scenario.appended.find((row) => row.file === file);
      return identity && gateFileReceiptKey(identity) ? [makeGateFileReceiptSimulationReceipt(identity, scenario.cutHead40, scenario.sourceRunId)] : [];
    }) : [];
  const rerunFiles = new Set(appendInvalidation.supplementalFiles);
  const trainReceipts = [...appendPlan.reuse.filter((entry) => !rerunFiles.has(entry.file)), ...measuredAfterAppend];
  const carriedToCut = trainReceipts.map((entry) => carryGateFileReceipt(entry, scenario.cutHead40));
  const cutPlan = planGateFileReceipts({ current: scenario.appended, receipts: carriedToCut });
  const isolatedPlan = planGateFileReceipts({ current: scenario.isolated, receipts: [] });
  const isolatedResults = isolatedPlan.measure.flatMap((identity) => gateFileReceiptKey(identity)
    ? [makeGateFileReceiptSimulationReceipt(identity, scenario.cutHead40, scenario.sourceRunId, 'isolated-recheck')] : []);
  let certificateRefreshBlocked = supplementalGate.aggregate !== 'complete' || supplementalGate.gateOutcome !== 'pass';
  let refreshedSweepCertificate: GateSweepCertificate | undefined;
  if (!certificateRefreshBlocked) {
    try {
      refreshedSweepCertificate = buildGateSweepCertificate({ sourceHead40: scenario.cutHead40, imageDigest: scenario.imageDigest,
        identities: scenario.appended, receipts: carriedToCut,
        measuredAt: appendInvalidation.fullSweepRequired ? 3_000 : sweepCertificate.measuredAt,
        sweepConcurrency: SIMULATED_SWEEP_CONCURRENCY,
        maxAgeMs: sweepCertificate.maxAgeMs, maxDirtyRatio: sweepCertificate.maxDirtyRatio, thresholdSource: sweepCertificate.thresholdSource });
    } catch { certificateRefreshBlocked = true; }
  }
  return { appendPlan, cutPlan, isolatedPlan, measuredAfterAppend, carriedToCut, isolatedResults, sweepCertificate,
    ...(refreshedSweepCertificate ? { refreshedSweepCertificate } : {}), appendInvalidation, supplementalGate, certificateRefreshBlocked };
}
