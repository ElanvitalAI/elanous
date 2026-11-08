export type MacrophageIncidentLabel = 'noise' | 'fix' | 'hitl';
export type MacrophageRepairStep = 'none' | 'R0-remeasure' | 'R1-single-file' | 'R2-split-files' | 'R3-revert-proposal' | 'R4-hitl';

export interface MacrophageIncidentSignal {
  readonly id: string;
  readonly source: 'release-graph' | 'train' | 'host';
  readonly signature: string;
  readonly evidence: 'preexisting' | 'self-healed' | 'introduced' | 'unmeasured' | 'external';
  readonly failureIds?: readonly string[];
  readonly sourceFiles?: readonly string[];
  readonly independentFiles?: boolean;
  readonly causePr?: number;
  readonly revertSafe?: boolean;
  readonly retryable?: boolean;
  readonly priorRepairStepsFailed?: number;
}

export interface MacrophageIncidentPlan {
  readonly id: string;
  readonly label: MacrophageIncidentLabel;
  readonly step: MacrophageRepairStep;
  readonly reason: string;
  readonly files: readonly string[];
  readonly causePr?: number;
}

export interface MacrophageRecoveryReceipt {
  readonly schema: 'elanous.release.macrophage-receipt.v1';
  readonly runId: string;
  readonly incidentId: string;
  readonly label: MacrophageIncidentLabel;
  readonly step: MacrophageRepairStep;
  readonly disposition: 'continued' | 'resumed-after-land' | 'resumed-after-hitl';
  readonly gateVisit: number;
  readonly rerunFiles: readonly string[];
  readonly receiptIds: readonly string[];
}

const MAX_SPLIT_FILES = 4;

function normalizedFiles(files: readonly string[] | undefined): string[] {
  return [...new Set(files ?? [])].sort();
}

/** Production decision core. The graph adapter is intentionally separate so this can be proven in the sim world first. */
export function planMacrophageIncident(signal: MacrophageIncidentSignal): MacrophageIncidentPlan {
  if (!signal.id.trim() || !signal.signature.trim()) throw new Error('incident id and signature are required');
  const files = normalizedFiles(signal.sourceFiles);
  if (files.some((file) => !file || file.startsWith('/') || file.split('/').includes('..'))) {
    throw new Error(`incident ${signal.id} has unsafe source-file attribution`);
  }
  if (signal.evidence === 'preexisting' || signal.evidence === 'self-healed' || signal.evidence === 'external') {
    return { id: signal.id, label: 'noise', step: signal.retryable ? 'R0-remeasure' : 'none',
      reason: signal.evidence === 'preexisting' ? 'failure is present on the baseline' :
        signal.evidence === 'self-healed' ? 'gate already healed the incident' : 'event is outside the release graph owner boundary', files };
  }
  if (signal.evidence === 'unmeasured' || files.length === 0) {
    return { id: signal.id, label: 'hitl', step: 'R4-hitl', reason: 'failure evidence or source attribution is unmeasured', files,
      ...(signal.causePr === undefined ? {} : { causePr: signal.causePr }) };
  }
  if (signal.priorRepairStepsFailed && signal.priorRepairStepsFailed > 0 && signal.causePr && signal.revertSafe) {
    return { id: signal.id, label: 'hitl', step: 'R3-revert-proposal', reason: 'safe revert proposal needs owner approval', files, causePr: signal.causePr };
  }
  if (files.length === 1) {
    return { id: signal.id, label: 'fix', step: 'R1-single-file', reason: 'introduced failure has one attributed source file', files,
      ...(signal.causePr === undefined ? {} : { causePr: signal.causePr }) };
  }
  if (files.length <= MAX_SPLIT_FILES && signal.independentFiles === true) {
    return { id: signal.id, label: 'fix', step: 'R2-split-files', reason: 'independent attributed files can be repaired as separate child PRs', files,
      ...(signal.causePr === undefined ? {} : { causePr: signal.causePr }) };
  }
  return { id: signal.id, label: 'hitl', step: 'R4-hitl', reason: files.length > MAX_SPLIT_FILES
    ? `attribution spans more than ${MAX_SPLIT_FILES} source files` : 'multi-file attribution is coupled or not proven independent', files,
    ...(signal.causePr === undefined ? {} : { causePr: signal.causePr }) };
}

/** Fake PR, landing, gate and owner-approval boundaries drive the real decision plan in the release simulation world. */
export function simulateMacrophageRecovery(input: {
  readonly runId: string;
  readonly plan: MacrophageIncidentPlan;
  readonly changedShardId: string;
  readonly carriedShardIds: readonly string[];
  readonly repairLanded?: boolean;
  readonly hitlApproved?: boolean;
}): { readonly resumed: boolean; readonly receipt: MacrophageRecoveryReceipt; readonly jsonl: string } {
  if (!input.runId.trim() || !input.changedShardId.trim()) throw new Error('runId and changed shard are required');
  const files = input.plan.files;
  let disposition: MacrophageRecoveryReceipt['disposition'] = 'continued';
  let resumed = true;
  if (input.plan.label === 'fix') {
    if (!input.repairLanded) { resumed = false; }
    else disposition = 'resumed-after-land';
  } else if (input.plan.label === 'hitl') {
    if (!input.hitlApproved) { resumed = false; }
    else disposition = 'resumed-after-hitl';
  }
  const rerunFiles = input.plan.label === 'fix' ? files : [];
  const receiptIds = resumed ? [...new Set([...input.carriedShardIds.filter((id) => id !== input.changedShardId), input.changedShardId])] : [];
  const receipt: MacrophageRecoveryReceipt = { schema: 'elanous.release.macrophage-receipt.v1', runId: input.runId,
    incidentId: input.plan.id, label: input.plan.label, step: input.plan.step, disposition,
    gateVisit: resumed && input.plan.label === 'fix' ? 2 : 1, rerunFiles, receiptIds };
  return { resumed, receipt, jsonl: `${JSON.stringify(receipt)}\n` };
}

/** Creates a continued receipt only after the release graph proves the repair node and re-gate ran. */
export function recordMacrophageGraphRecovery(input: {
  readonly runId: string;
  readonly plan: MacrophageIncidentPlan;
  readonly repairLanded: boolean;
  readonly repairNodeId: string | undefined;
  readonly gateVisits: number;
  readonly failureIds: readonly string[];
  readonly changedShardId: string;
  readonly carriedShardIds: readonly string[];
  readonly attributedFailures: readonly { failureId: string; sourceFiles: readonly string[]; confidence: 'high' | 'ambiguous' | 'unmeasured' }[];
}): { readonly receipt: MacrophageRecoveryReceipt; readonly jsonl: string } {
  const attributedFailures = input.attributedFailures.filter(({ failureId }) => input.failureIds.includes(failureId));
  const attributedFiles = new Set(attributedFailures.flatMap(({ sourceFiles }) => sourceFiles));
  if (input.plan.label !== 'fix' || input.plan.files.length === 0 || !input.repairLanded
    || !/^gate-repair-[a-f0-9]{12}$/.test(input.repairNodeId ?? '') || input.gateVisits < 2
    || input.failureIds.length === 0 || attributedFailures.length !== input.failureIds.length
    || attributedFailures.some(({ confidence }) => confidence === 'unmeasured')
    || !input.plan.files.every((file) => attributedFiles.has(file))) {
    throw new Error(`macrophage ${input.plan.id} cannot continue without its landed repair node and second gate visit`);
  }
  if (!input.runId.trim() || !input.changedShardId.trim()) throw new Error('runId and changed shard are required');
  const receipt: MacrophageRecoveryReceipt = { schema: 'elanous.release.macrophage-receipt.v1', runId: input.runId,
    incidentId: input.plan.id, label: input.plan.label, step: input.plan.step, disposition: 'resumed-after-land',
    gateVisit: input.gateVisits, rerunFiles: [...input.plan.files],
    receiptIds: [...new Set([...input.carriedShardIds.filter((id) => id !== input.changedShardId), input.changedShardId])] };
  return { receipt, jsonl: `${JSON.stringify(receipt)}\n` };
}
