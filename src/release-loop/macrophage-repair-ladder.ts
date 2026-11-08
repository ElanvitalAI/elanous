export const MACROPHAGE_REPAIR_LADDER_LIMITS = {
  maxRepairChildren: 4,
  maxParallelChildren: 2,
  maxElapsedMs: 90 * 60_000,
  cutoffOnlySteps: ['R3-revert-proposal', 'R4-hitl'],
  maxRemeasureAttempts: 1,
} as const;

export type MacrophageRepairLadderStep = 'none' | 'R0-remeasure' | 'R1-single-file' | 'R2-split-files' | 'R3-revert-proposal' | 'R4-hitl';
export type MacrophageRepairEvidence = 'preexisting' | 'self-healed' | 'external' | 'unmeasured' | 'load-flaky' | 'known-env' | 'image-drift' | 'introduced';
export type MacrophageRepairChangeKind = 'expectation' | 'fixture' | 'snapshot' | 'config' | 'production' | 'unknown';
export type MacrophageRepairConfidence = 'high' | 'ambiguous' | 'unmeasured';

export function macrophageEvidenceMatchesObservedGate(evidence: MacrophageRepairEvidence,
  gate: { outcome: string; introduced?: readonly string[]; loadFlaky?: readonly string[]; stalledEnv?: readonly unknown[] },
  triage: { classification: string; introduced: readonly string[]; failureIds: readonly string[] }): boolean {
  const gateFailed = gate.outcome === 'fail' || gate.outcome === 'error' || gate.outcome === 'regression';
  const gateIntroduced = [...(gate.introduced ?? [])].sort();
  const triageIntroduced = [...triage.introduced].sort();
  if (JSON.stringify(gateIntroduced) !== JSON.stringify(triageIntroduced)) return false;
  switch (evidence) {
    case 'introduced':
      return gateFailed && triage.classification === 'regression' && gateIntroduced.length > 0
        && gateIntroduced.every((id) => triage.failureIds.includes(id));
    case 'load-flaky':
      return gateFailed && triage.classification === 'load' && (gate.loadFlaky?.length ?? 0) > 0;
    case 'known-env':
    case 'image-drift':
      return gateFailed && triage.classification === 'env' && (gate.stalledEnv?.length ?? 0) > 0;
    case 'unmeasured':
      return gateFailed && (triage.classification === 'unmeasured' || triage.classification === 'exhausted');
    case 'preexisting':
    case 'self-healed':
    case 'external':
      return gate.outcome === 'ok' && triage.classification === 'clean'
        && triage.failureIds.length === 0 && gateIntroduced.length === 0;
  }
}

export interface MacrophageRepairLadderInput {
  readonly runId: string;
  readonly signature: string;
  readonly evidence: MacrophageRepairEvidence;
  readonly failureIds: readonly string[];
  readonly sourceFiles?: readonly string[];
  readonly independentFiles?: boolean;
  readonly changeKind?: MacrophageRepairChangeKind;
  readonly causePr?: number;
  /** Failure IDs independently attributed to causePr; must match the active regression set for R3. */
  readonly causePrFailureIds?: readonly string[];
  readonly attributionConfidence?: MacrophageRepairConfidence;
  readonly revertSafe?: boolean;
  readonly previousStep?: MacrophageRepairLadderStep;
  readonly previousStepOutcome?: 'passed' | 'failed' | 'blocked';
  readonly r0Attempts?: number;
  readonly attemptedSteps?: readonly MacrophageRepairLadderStep[];
  /** Run identity that produced attemptedSteps; R3 cannot use unscoped history. */
  readonly attemptedStepsRunId?: string;
  readonly attemptedFiles?: readonly string[];
  readonly r3ProposalUsed?: boolean;
  readonly repairChildrenUsed: number;
  readonly elapsedMs: number;
  /** Minutes remaining to the scheduled release cut. Unknown time fails closed to R3/R4. */
  readonly minutesToCut: number | null;
  /** Conservative estimate for the proposed step; prevents starting work that overruns the 90-minute ladder budget. */
  readonly estimatedStepMs: number;
}

export interface MacrophageRepairUnit {
  readonly sourceFile: string;
  readonly failureIds: readonly string[];
  readonly writeTarget: 'cut-append';
}

export interface MacrophageRepairLadderDecision {
  readonly runId: string;
  readonly signature: string;
  readonly step: MacrophageRepairLadderStep;
  readonly action: 'no-op' | 'remeasure-same-slice' | 'repair-plan' | 'propose-revert-draft' | 'raise-decision';
  readonly reason: string;
  readonly repairUnits: readonly MacrophageRepairUnit[];
  readonly childrenPlanned: number;
  readonly maxParallelChildren: number;
  readonly repositoryWrite: 'none' | 'cut-append-only';
  readonly ownerNotice: boolean;
  readonly revertDraft?: { readonly causePr: number; readonly draftOnly: true };
  readonly decisionCard?: {
    readonly signature: string;
    readonly causePr?: number;
    readonly attemptedSteps: readonly MacrophageRepairLadderStep[];
    readonly remainingFailureIds: readonly string[];
    readonly recommendation: string;
  };
}

function safeFiles(files: readonly string[] | undefined): string[] | undefined {
  const normalized = [...new Set(files ?? [])].sort();
  if (normalized.some((file) => !file || file.startsWith('/') || file.split(/[\\/]/).includes('..'))) return undefined;
  return normalized;
}

function attemptedSteps(input: MacrophageRepairLadderInput): MacrophageRepairLadderStep[] {
  const prior = Array.isArray(input.attemptedSteps) ? input.attemptedSteps.filter((step): step is MacrophageRepairLadderStep =>
    ['none', 'R0-remeasure', 'R1-single-file', 'R2-split-files', 'R3-revert-proposal', 'R4-hitl'].includes(step)) : [];
  const previous = input.previousStep && input.previousStep !== 'none' ? [input.previousStep] : [];
  return [...new Set([...prior, ...previous])];
}

function decision(input: MacrophageRepairLadderInput, step: MacrophageRepairLadderStep,
  action: MacrophageRepairLadderDecision['action'], reason: string,
  extra: Partial<MacrophageRepairLadderDecision> = {}): MacrophageRepairLadderDecision {
  return { runId: input.runId, signature: input.signature, step, action, reason, repairUnits: [], childrenPlanned: 0,
    maxParallelChildren: MACROPHAGE_REPAIR_LADDER_LIMITS.maxParallelChildren, repositoryWrite: 'none', ownerNotice: false, ...extra };
}

function hitl(input: MacrophageRepairLadderInput, reason: string): MacrophageRepairLadderDecision {
  return decision(input, 'R4-hitl', 'raise-decision', reason, { ownerNotice: true,
    decisionCard: { signature: input.signature, ...(input.causePr === undefined ? {} : { causePr: input.causePr }),
      attemptedSteps: attemptedSteps(input), remainingFailureIds: Array.isArray(input.failureIds)
        ? input.failureIds.filter((id): id is string => typeof id === 'string') : [], recommendation: reason } });
}

function canProposeRevert(input: MacrophageRepairLadderInput): input is MacrophageRepairLadderInput & { causePr: number } {
  const causeFailures = Array.isArray(input.causePrFailureIds) ? [...new Set(input.causePrFailureIds)].sort() : [];
  const activeFailures = [...new Set(input.failureIds)].sort();
  return input.evidence === 'introduced' && causeFailures.length > 0
    && JSON.stringify(causeFailures) === JSON.stringify(activeFailures)
    && (input.previousStep === 'R1-single-file' || input.previousStep === 'R2-split-files')
    && input.previousStepOutcome === 'failed' && input.revertSafe === true
    && input.attributionConfidence === 'high' && Number.isSafeInteger(input.causePr) && (input.causePr ?? 0) > 0;
}

function canStartRepairStep(input: MacrophageRepairLadderInput): boolean {
  return input.elapsedMs + input.estimatedStepMs <= MACROPHAGE_REPAIR_LADDER_LIMITS.maxElapsedMs;
}

/** Pure R0–R4 policy. Execution, PR creation, decisions, and cut append remain adapter responsibilities. */
export function planMacrophageRepairLadder(input: MacrophageRepairLadderInput): MacrophageRepairLadderDecision {
  if (typeof input.runId !== 'string' || typeof input.signature !== 'string'
    || !input.runId.trim() || !input.signature.trim()) return hitl(input, 'run id or incident signature is missing');
  const validAttemptedSteps = input.attemptedSteps === undefined || (Array.isArray(input.attemptedSteps)
    && input.attemptedSteps.every((step) => ['none', 'R0-remeasure', 'R1-single-file', 'R2-split-files', 'R3-revert-proposal', 'R4-hitl'].includes(step)));
  if (!Array.isArray(input.failureIds) || !input.failureIds.every((id) => typeof id === 'string')
    || (input.sourceFiles !== undefined && (!Array.isArray(input.sourceFiles) || !input.sourceFiles.every((file) => typeof file === 'string')))
    || (input.attemptedFiles !== undefined && (!Array.isArray(input.attemptedFiles) || !input.attemptedFiles.every((file) => typeof file === 'string')))
    || !validAttemptedSteps) {
    return hitl(input, 'failure, source-file, or prior-step evidence is malformed');
  }
  const numeric = [input.repairChildrenUsed, input.elapsedMs, input.estimatedStepMs];
  if (numeric.some((value) => !Number.isSafeInteger(value) || value < 0)
    || (input.r0Attempts !== undefined && (!Number.isSafeInteger(input.r0Attempts) || input.r0Attempts < 0))
    || (input.minutesToCut !== null && (!Number.isFinite(input.minutesToCut) || input.minutesToCut < 0))) {
    return hitl(input, 'repair-ladder budget or cut countdown is invalid');
  }
  if (input.repairChildrenUsed >= MACROPHAGE_REPAIR_LADDER_LIMITS.maxRepairChildren) return hitl(input, 'four repair-child limit is exhausted');
  if (input.elapsedMs >= MACROPHAGE_REPAIR_LADDER_LIMITS.maxElapsedMs) return hitl(input, '90-minute repair-ladder limit is exhausted');

  if (input.evidence === 'preexisting' || input.evidence === 'self-healed' || input.evidence === 'external') {
    return decision(input, 'none', 'no-op', `incident is outside active repair scope: ${input.evidence}`);
  }
  if (input.previousStepOutcome === 'passed') return hitl(input, 'prior repair step passed but active failure evidence remains');
  if (input.evidence === 'unmeasured' || input.failureIds.length === 0) return hitl(input, 'failure evidence or attribution is unmeasured');

  const files = safeFiles(input.sourceFiles);
  if (!files || (input.sourceFiles && files.length !== new Set(input.sourceFiles).size)) return hitl(input, 'source-file attribution is unsafe or malformed');
  if (!canStartRepairStep(input)) return hitl(input, 'proposed step would exceed the 90-minute ladder limit');

  const proposedMinutesToCut = input.minutesToCut === null
    ? null : input.minutesToCut - input.estimatedStepMs / 60_000;
  const cutoffRestricted = proposedMinutesToCut === null || proposedMinutesToCut <= 30;
  const attemptedLadderSteps = new Set(attemptedSteps(input));
  const r3AlreadyProposed = input.r3ProposalUsed === true || attemptedLadderSteps.has('R3-revert-proposal');
  const cutoffReason = input.minutesToCut === null
    ? 'countdown is unknown'
    : input.minutesToCut <= 30
      ? `observed countdown is ${input.minutesToCut} minutes`
      : `estimated step completion crosses into the 30-minute cutoff (observed countdown ${input.minutesToCut} minutes; projected ${proposedMinutesToCut} minutes)`;
  const hasPriorRepair = attemptedLadderSteps.has('R1-single-file') || attemptedLadderSteps.has('R2-split-files');
  const failedR1R2 = (input.previousStep === 'R1-single-file' || input.previousStep === 'R2-split-files')
    && input.previousStepOutcome === 'failed';
  if (hasPriorRepair && input.attemptedFiles === undefined && !failedR1R2) {
    return hitl(input, 'prior R1/R2 attempt exists but attempted-file history is unmeasured; refusing a duplicate repair');
  }
  if (cutoffRestricted) {
    if (MACROPHAGE_REPAIR_LADDER_LIMITS.cutoffOnlySteps.includes('R3-revert-proposal') && canProposeRevert(input)) {
      if (!Array.isArray(input.attemptedSteps) || input.attemptedStepsRunId !== input.runId
        || !input.attemptedSteps.includes(input.previousStep!) || input.attemptedFiles === undefined)
        return hitl(input, 'R3 execution history is unmeasured for this run');
      if (!r3AlreadyProposed) {
        return decision(input, 'R3-revert-proposal', 'propose-revert-draft', `${cutoffReason}; introduced regression and cause-PR failure IDs match, so high-confidence revert is proposed as a draft for owner review`, {
          ownerNotice: true, revertDraft: { causePr: input.causePr, draftOnly: true },
        });
      }
    }
    return MACROPHAGE_REPAIR_LADDER_LIMITS.cutoffOnlySteps.includes('R4-hitl')
      ? hitl(input, `${cutoffReason}; only R3/R4 are allowed`)
      : hitl(input, 'cutoff allows no configured repair step');
  }

  if (input.previousStepOutcome === 'failed' && (input.previousStep === 'R1-single-file' || input.previousStep === 'R2-split-files')) {
    if (MACROPHAGE_REPAIR_LADDER_LIMITS.cutoffOnlySteps.includes('R3-revert-proposal') && canProposeRevert(input)) {
      if (!Array.isArray(input.attemptedSteps) || input.attemptedStepsRunId !== input.runId
        || !input.attemptedSteps.includes(input.previousStep!) || input.attemptedFiles === undefined)
        return hitl(input, 'R3 execution history is unmeasured for this run');
      if (!r3AlreadyProposed) {
        return decision(input, 'R3-revert-proposal', 'propose-revert-draft', 'R1/R2 failed; high-confidence cause PR is proposed for owner-reviewed draft revert', {
          ownerNotice: true, revertDraft: { causePr: input.causePr, draftOnly: true },
        });
      }
    }
    return hitl(input, 'R1/R2 failed without a safe, high-confidence revert candidate');
  }
  if (input.previousStep === 'R3-revert-proposal' && input.previousStepOutcome !== undefined) {
    return hitl(input, 'R3 proposal was already attempted; further action requires a person');
  }

  const attempted = new Set(input.attemptedFiles ?? []);
  if (input.evidence === 'load-flaky' || input.evidence === 'known-env' || input.evidence === 'image-drift') {
    if (input.r0Attempts === undefined) return hitl(input, 'R0 remeasurement attempt count is unmeasured');
    if (input.r0Attempts >= MACROPHAGE_REPAIR_LADDER_LIMITS.maxRemeasureAttempts
      || attemptedLadderSteps.has('R0-remeasure')) return hitl(input, 'R0 same-slice remeasurement limit is exhausted');
    return decision(input, 'R0-remeasure', 'remeasure-same-slice', 'same-slice isolated remeasurement is the first repair step');
  }

  const oneLineKinds = new Set<MacrophageRepairChangeKind>(['expectation', 'fixture', 'snapshot', 'config']);
  if (input.evidence === 'introduced' && files?.length === 1 && oneLineKinds.has(input.changeKind ?? 'unknown')
    && !attempted.has(files[0]!)) {
    const repairUnits: MacrophageRepairUnit[] = [{ sourceFile: files[0]!, failureIds: [...input.failureIds], writeTarget: 'cut-append' }];
    return decision(input, 'R1-single-file', 'repair-plan', 'one attributed expectation/fixture/snapshot/config file is eligible for a single-file repair', {
      repairUnits, childrenPlanned: 1, repositoryWrite: 'cut-append-only',
    });
  }

  if (input.evidence === 'introduced' && files && files.length > 1 && files.length <= MACROPHAGE_REPAIR_LADDER_LIMITS.maxRepairChildren
    && input.independentFiles === true && files.every((file) => !attempted.has(file))) {
    const remainingChildren = MACROPHAGE_REPAIR_LADDER_LIMITS.maxRepairChildren - input.repairChildrenUsed;
    if (files.length > remainingChildren) return hitl(input, 'R2 split would exceed the four repair-child run limit');
    const repairUnits = files.map((sourceFile) => ({ sourceFile, failureIds: [...input.failureIds], writeTarget: 'cut-append' as const }));
    return decision(input, 'R2-split-files', 'repair-plan', 'independent attributed source files are split into bounded child repairs', {
      repairUnits, childrenPlanned: repairUnits.length, repositoryWrite: 'cut-append-only',
    });
  }

  if (files && files.some((file) => attempted.has(file))) return hitl(input, 'a source file already has a repair attempt in this run');
  return hitl(input, 'no safe R0/R1/R2 repair plan is supported by the evidence');
}
