import { runRequirementFunnel, type FunnelCandidate, type FunnelOptions, type RequirementDecision } from '../intake-plane/requirement-funnel.js';
import type { ConsensusEngine, ConsensusRepresentative } from '../loops/consensus.js';
import { placeCell, type PlacementDeps, type PlacementDecision } from './placement.js';
import { parseRubric, rubricGrade, rubricScore } from './rubric.js';

export interface ProposalPlacementInput {
  /** The current funnel inputs; ledger capture and adoption hooks are intentionally not accepted here. */
  funnel: Omit<FunnelOptions, 'ledger' | 'adopt' | 'mode' | 'placement'>;
  rubricCandidate: FunnelCandidate;
  consensus: Pick<ConsensusEngine, 'show'>;
  consensusProposalId: string;
  placement: PlacementDeps;
}

export type ProposalPlacementPlan =
  | { status: 'not-eligible'; reason: string; decision?: RequirementDecision }
  | { status: 'awaiting-consensus'; consensusProposalId: string; decision: RequirementDecision }
  | { status: 'planned'; consensus: { id: string; status: 'agreed'; proposedBy: ConsensusRepresentative; agreedBy: ConsensusRepresentative };
      decision: RequirementDecision; rubric: { score: number; grade: NonNullable<FunnelCandidate['grade']> }; placement: PlacementDecision };

/**
 * Safe first slice for the proposal→placement path. It accepts a pre-collected rubric candidate and an existing
 * dual-root card; the requirement funnel and both placement calculations run in shadow/dry-run only. There is no
 * ledger writer, live adopter, proposal creator, or operational scheduler in this seam.
 */
export function planAgreedProposalPlacement(input: ProposalPlacementInput): ProposalPlacementPlan {
  const rubric = input.rubricCandidate;
  if (rubric.score === null || rubric.grade === null) return { status: 'not-eligible', reason: 'candidate has no explicit rubric' };
  const funnel = runRequirementFunnel({
    ...input.funnel,
    mode: 'shadow',
    placement: { ...input.placement, dryRun: true },
  });
  const decision = funnel.decisions.find(({ candidate }) => candidate.id === rubric.id);
  if (!decision) return { status: 'not-eligible', reason: `funnel candidate not found: ${rubric.id}` };
  if (decision.status !== 'would-adopt') return { status: 'not-eligible', reason: decision.reason ?? `funnel status: ${decision.status}`, decision };
  const sourceRubric = parseRubric(decision.candidate.text);
  const sourceTitle = decision.candidate.text.split(/\s+루브릭:/, 1)[0]!.trim().slice(0, 80);
  if (sourceTitle !== rubric.title) return { status: 'not-eligible', reason: 'rubric candidate title does not match funnel source', decision };
  if (!sourceRubric || rubric.score !== rubricScore(sourceRubric) || rubric.grade !== rubricGrade(rubricScore(sourceRubric)))
    return { status: 'not-eligible', reason: 'rubric score or grade does not match funnel source', decision };

  let proposal;
  try { proposal = input.consensus.show(input.consensusProposalId); }
  catch (error) {
    if (error instanceof Error && error.message === `consensus proposal not found: ${input.consensusProposalId}`)
      return { status: 'awaiting-consensus', consensusProposalId: input.consensusProposalId, decision };
    throw error;
  }
  if (proposal.category !== 'period-budget' || proposal.factId !== decision.candidate.id
    || proposal.title !== rubric.title || proposal.thresholds.length > 0 || proposal.status !== 'agreed')
    return { status: 'awaiting-consensus', consensusProposalId: input.consensusProposalId, decision };
  const agreement = proposal.reviews.find((review) => review.verdict === 'agree' && review.by !== proposal.proposedBy);
  if (!agreement) return { status: 'awaiting-consensus', consensusProposalId: input.consensusProposalId, decision };

  const candidate = decision.candidate;
  if (candidate.priority !== 'P1' && candidate.priority !== 'P2')
    return { status: 'not-eligible', reason: 'funnel candidate priority is missing or unsupported', decision };
  if (!candidate.owner) return { status: 'not-eligible', reason: 'funnel candidate owner is missing', decision };
  let placement: PlacementDecision;
  try {
    // The funnel checks urgency/capacity eligibility; this second dry run applies the rubric's deferral grade.
    placement = placeCell({
      id: candidate.id,
      title: candidate.text,
      owner: candidate.owner,
      priority: candidate.priority,
      predecessors: [],
      grade: rubric.grade,
      ...(candidate.deadlineVersion ? { deadlineVersion: candidate.deadlineVersion } : {}),
    }, { ...input.placement, dryRun: true });
  } catch (error) {
    return { status: 'not-eligible', reason: error instanceof Error ? error.message : String(error), decision };
  }

  return {
    status: 'planned',
    consensus: { id: proposal.id, status: 'agreed', proposedBy: proposal.proposedBy, agreedBy: agreement.by },
    decision,
    rubric: { score: rubric.score, grade: rubric.grade },
    placement,
  };
}
