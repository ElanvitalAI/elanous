import type { ResearchEdgeDecision } from '../edge-decision.js';

export type EvidenceGrade = 'low' | 'medium' | 'high';

export interface CounterEvidenceSource {
  claim: string;
  source: string;
  grade: EvidenceGrade;
}

/** One axis from Bloom 4, enriched at Bloom 5 with its strongest rebuttal and outside view. */
export interface CounterEvidenceAxis {
  id: string;
  conclusion: string;
  supportingEvidence: readonly CounterEvidenceSource[];
  counterEvidence: readonly CounterEvidenceSource[];
  referenceClass?: {
    description: string;
    outcomeRate: number;
    /** Probability implied by this axis before its individual-case adjustment. */
    claimOutcomeRate: number;
    sampleSize?: number;
    source: string;
    /** Sourced case-specific evidence explaining a departure from the reference class. */
    adjustmentEvidence?: string;
  };
}

export interface CounterEvidenceAssessment {
  axes: readonly CounterEvidenceAxis[];
}

export interface CounterEvidenceCell {
  axisId: string;
  conclusion: string;
  strongestCounterEvidence?: CounterEvidenceSource;
  outsideView?: CounterEvidenceAxis['referenceClass'];
  outsideViewRelation: 'aligned' | 'adjusted' | 'unexplained-divergence' | 'missing';
  supportGrade: EvidenceGrade | 'missing';
  counterGrade: EvidenceGrade | 'missing';
  finding: 'counterevidence-dominates' | 'support-dominates' | 'balanced' | 'incomplete';
}

const rank: Record<EvidenceGrade, number> = { low: 1, medium: 2, high: 3 };

/**
 * Deterministic T3 lens. It does not manufacture sources or use provider votes:
 * supplied axis-level evidence and reference classes are the complete input.
 */
export function judgeCounterEvidence(assessment: CounterEvidenceAssessment): ResearchEdgeDecision & { cells: readonly CounterEvidenceCell[] } {
  if (!Array.isArray(assessment.axes) || assessment.axes.length === 0) {
    return { action: 'deepen', reason: 'no research axes to evaluate; gather axis-level claims and counterevidence', evidence: [], counterEvidenceRefs: [], outsideViewRefs: [], cells: [] };
  }

  const cells = assessment.axes.map((axis): CounterEvidenceCell => {
    const supporting = [...axis.supportingEvidence].sort((a, b) => rank[b.grade] - rank[a.grade])[0];
    const counter = [...axis.counterEvidence].sort((a, b) => rank[b.grade] - rank[a.grade])[0];
    const hasOutsideView = !!axis.referenceClass && axis.referenceClass.description.trim().length > 0
      && axis.referenceClass.source.trim().length > 0 && Number.isFinite(axis.referenceClass.outcomeRate)
      && axis.referenceClass.outcomeRate >= 0 && axis.referenceClass.outcomeRate <= 1
      && Number.isFinite(axis.referenceClass.claimOutcomeRate) && axis.referenceClass.claimOutcomeRate >= 0
      && axis.referenceClass.claimOutcomeRate <= 1;
    const outsideViewRelation = !hasOutsideView ? 'missing'
      : axis.referenceClass!.outcomeRate === axis.referenceClass!.claimOutcomeRate ? 'aligned'
        : axis.referenceClass!.adjustmentEvidence?.trim() ? 'adjusted' : 'unexplained-divergence';
    if (!supporting || !counter || outsideViewRelation === 'missing' || outsideViewRelation === 'unexplained-divergence') return {
      axisId: axis.id, conclusion: axis.conclusion, strongestCounterEvidence: counter,
      outsideView: axis.referenceClass, supportGrade: supporting?.grade ?? 'missing',
      counterGrade: counter?.grade ?? 'missing', outsideViewRelation, finding: 'incomplete',
    };
    const diff = rank[counter.grade] - rank[supporting.grade];
    return {
      axisId: axis.id, conclusion: axis.conclusion, strongestCounterEvidence: counter,
      outsideView: axis.referenceClass, supportGrade: supporting.grade, counterGrade: counter.grade,
      outsideViewRelation,
      finding: diff > 0 ? 'counterevidence-dominates' : diff < 0 ? 'support-dominates' : 'balanced',
    };
  });

  const evidence = cells.map((cell) => cell.strongestCounterEvidence
    ? `${cell.axisId}: counterevidence [${cell.strongestCounterEvidence.grade}] ${cell.strongestCounterEvidence.claim} (${cell.strongestCounterEvidence.source}); outside-view=${cell.outsideViewRelation}`
    : `${cell.axisId}: counterevidence missing`);
  const counterDominates = cells.some((cell) => cell.finding === 'counterevidence-dominates');
  const action = cells.some((cell) => cell.finding === 'incomplete') ? 'deepen'
    : counterDominates ? 'prune'
      : 'stop';
  const reason = action === 'deepen'
    ? 'complete each axis with sourced strongest counterevidence and a sourced reference class before closing the judgment'
    : action === 'prune'
      ? 'at least one axis has stronger sourced counterevidence than supporting evidence; prune the challenged conclusion'
      : 'all axes include sourced support, strongest counterevidence, and outside view; no axis-level counterevidence dominates';
  return {
    action,
    reason,
    evidence,
    counterEvidenceRefs: [...new Set(cells.flatMap((cell) => cell.strongestCounterEvidence ? [cell.strongestCounterEvidence.source] : []))],
    outsideViewRefs: [...new Set(cells.flatMap((cell) => cell.outsideView?.source ? [cell.outsideView.source] : []))],
    cells,
  };
}
