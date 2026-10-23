/** Existing TA retry judgement, routed through the declared recover → dispatch graph edge. */
import { randomBytes } from 'node:crypto';
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

/** HARNESS-FULL-GRAPH-NEXTMOVE — 수 한 건의 식별자. 결정 순간 «한 번» 만들고, 그 값을 결정·간선·발사에 그대로 내려보낸다(다시 계산 금지). */
export function mintMoveId(): string {
  return `mv-${randomBytes(6).toString('hex')}`;
}

/**
 * NEXTMOVE-GENERAL-RELAUNCH-MOVEID — 소비 쪽(결과 파일 · `ta.repair.completed`)이 카드에 적힌 수 id 와 받은 값을 짝짓는다.
 * - `paired`   : 둘 다 있고 같다 → 그 값을 카드 결과 줄에 싣는다.
 * - `legacy`   : 둘 다 없다(#30226 전 원장 줄 · 옛 worker) → 조용히 지나간다.
 * - `unpaired` : 한쪽만 있거나 다르다 → 소비는 그대로 하고(fail-soft) 관측 줄만 남긴다.
 */
export type MoveIdPairing = { kind: 'paired'; moveId: string } | { kind: 'legacy' }
  | { kind: 'unpaired'; expected: string | null; observed: string | null };

export function pairMoveId(expected: unknown, observed: unknown): MoveIdPairing {
  const want = typeof expected === 'string' && expected ? expected : null;
  const got = typeof observed === 'string' && observed ? observed : null;
  if (want === null && got === null) return { kind: 'legacy' };
  if (want !== null && want === got) return { kind: 'paired', moveId: want };
  return { kind: 'unpaired', expected: want, observed: got };
}

export interface RepairNextMoveDeps {
  /** 시험 seam — 기본 `mintMoveId`. dispatch 결정일 때만 한 번 부른다. */
  mintMoveId?: () => string;
}

export type RepairNextMove = { kind: 'dispatch'; judgement: TaskJudgement; route: JourneyRoute; source: `pr:${number}`; moveId: string }
  | { kind: 'stop'; judgement: TaskJudgement; route: JourneyRoute; reason: string };

export function repairNextMove(input: RepairNextMoveInput, deps: RepairNextMoveDeps = {}): RepairNextMove {
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
  return { kind: 'dispatch', judgement: judged, route, source: `pr:${input.pr}`, moveId: (deps.mintMoveId ?? mintMoveId)() };
}
