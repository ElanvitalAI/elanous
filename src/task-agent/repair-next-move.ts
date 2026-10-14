/** Existing TA retry judgement, routed through the declared recover → dispatch graph edge. */
import { judgeNextMove, type TaskJudgement } from './judge.js';
import { readJourneyEdge, type JourneyRoute } from '../self-dev/graph-journey-route.js';

export interface RepairNextMoveInput {
  pr: number;
  head: string;
  branch: string;
  mustFix: readonly string[];
  priorNarrowAttempts: number;
  priorAlternativeAttempts: number;
}

export type RepairNextMove = { kind: 'dispatch'; judgement: TaskJudgement; route: JourneyRoute; source: `pr:${number}` }
  | { kind: 'stop'; judgement: TaskJudgement; route: JourneyRoute; reason: string };

export function repairNextMove(input: RepairNextMoveInput): RepairNextMove {
  const judged = judgeNextMove({ stopReason: 'needs-human', pr: input.pr, prState: 'OPEN', review: 'fail', mustFix: input.mustFix,
    failures: { 'narrow-relaunch': input.priorNarrowAttempts, alternative: input.priorAlternativeAttempts } });
  const route = readJourneyEdge('next-move', judged.move, { move: judged.move, source: `pr:${input.pr}`, head: input.head, branch: input.branch });
  if (!input.mustFix.length) return { kind: 'stop', judgement: judged, route, reason: 'review must-fix text unavailable' };
  // RFC §6a D4 is a tighter cap for same-PR repair than the general retry vocabulary.
  if (input.priorNarrowAttempts + input.priorAlternativeAttempts >= 2) {
    return { kind: 'stop', judgement: judged, route, reason: 'repair convergence failed after two relaunches' };
  }
  if (route.source !== 'graph' || route.to !== 'dispatch') return { kind: 'stop', judgement: judged, route, reason: `graph next-move ${judged.move} routes to ${route.to ?? 'none'}` };
  if (judged.move !== 'narrow-relaunch' && judged.move !== 'salvage-relaunch' && judged.move !== 'alternative') {
    return { kind: 'stop', judgement: judged, route, reason: `next move ${judged.move} is not a repair launch` };
  }
  return { kind: 'dispatch', judgement: judged, route, source: `pr:${input.pr}` };
}
