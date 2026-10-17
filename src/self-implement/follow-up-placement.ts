// FLEX-COORD-FU-PLACE — 후속 골 초안(FollowUpDraftRecord)에 판 배치·우선순위를 «제안»한다.
// FLEX-RFC §A-⑧ L-d 조율자: 후속 골 칸의 판 배치·우선순위를 정하고 작업 지시서에
// 자율 폭·조망 예산을 싣는다. 지금 초안은 판·우선순위 없이 shadow 로만 남는다.
// 이 모듈은 순수 계산만 한다 — 쓰기 없음(제안만). 제안을 초안 기록에 싣고 live 일 때
// placeCell 로 실제 판에 놓는 이어주기는 다음 조각이 recordFollowUpOnMerge·
// recordFollowUpOnBlocked(follow-up-goals.ts)에서 한다.

import type { PlacementPriority } from '../release-loop/placement.js';

/** 배치 제안에 필요한 초안 칸 — FollowUpDraftRecord 의 구조 부분집합이라 그대로 건넬 수 있다. */
export interface FollowUpPlacementRecord {
  cellId: string;
  depth: number;
  ending?: 'blocked';
}

/** 원래 칸(제안의 기준) — 판은 `x.y.z` 체크리스트 판, 우선순위는 배치 우선순위다. */
export interface FollowUpParentCell {
  version: string;
  priority: PlacementPriority;
}

/** 배치 제안 — 초안 기록에 실렸다가 live 배치(placeCell)의 입력이 된다. */
export interface FollowUpPlacementProposal {
  cellId: string;
  version: string;
  priority: PlacementPriority;
  reason: string;
  autonomyWidth: number;
  groundingBudget: number;
}

/** 깊이 1 후속의 자율 폭(단계). 링크가 깊어질수록 1씩 좁히고 1 미만으로는 내려가지 않는다. */
export const FOLLOW_UP_AUTONOMY_WIDTH_BASE = 3;
/** 깊이 1 후속의 조망(그라운딩) 예산(근거 수). 깊이마다 절반씩 좁히고 2 미만으로는 내려가지 않는다. */
export const FOLLOW_UP_GROUNDING_BUDGET_BASE = 8;

const PRIORITY_STEPS: readonly PlacementPriority[] = ['P0', 'P1', 'P2'];

/** 원래 칸의 다음 판 — 마지막 칸을 하나 올린다(release-tool 의 nextVersion 와 같은 계산). */
export function nextReleaseVersion(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch! + 1}`;
}

/** 깊이 2 이상이면 원래 우선순위에서 한 단 낮춘다 — P2 밑으로는 내려가지 않는다. */
function priorityForDepth(parent: PlacementPriority, depth: number): PlacementPriority {
  const index = PRIORITY_STEPS.indexOf(parent);
  if (index < 0 || depth < 2) return parent;
  return PRIORITY_STEPS[Math.min(index + 1, PRIORITY_STEPS.length - 1)]!;
}

/** 후속이 반복될수록 자율은 줄고 조망은 좁힌다 — 같은 칸을 도는 사슬이 제자리 걸음으로 늙지 않게. */
function budgetsForDepth(depth: number): { autonomyWidth: number; groundingBudget: number } {
  const d = Math.max(1, depth);
  return {
    autonomyWidth: Math.max(1, FOLLOW_UP_AUTONOMY_WIDTH_BASE - (d - 1)),
    groundingBudget: Math.max(2, Math.floor(FOLLOW_UP_GROUNDING_BUDGET_BASE / d)),
  };
}

/**
 * 후속 초안 한 건의 판 배치 제안 — 순수 함수, 아무것도 쓰지 않는다.
 * 기본 = 원래 칸의 다음 판 ⊕ 같은 우선순위 · 깊이 2 이상이면 한 단 낮춤(P2 하한) ·
 * ending 이 blocked 면 같은 판. 자율 폭·조망 예산은 깊이로 좁힌다.
 */
export function proposeFollowUpPlacement(record: FollowUpPlacementRecord, parent: FollowUpParentCell): FollowUpPlacementProposal {
  const depth = Math.max(1, record.depth);
  const blocked = record.ending === 'blocked';
  const version = blocked ? parent.version : nextReleaseVersion(parent.version);
  const priority = priorityForDepth(parent.priority, depth);
  const { autonomyWidth, groundingBudget } = budgetsForDepth(depth);
  const reason = `후속 깊이 ${depth} — ${blocked
    ? `막힌 런의 후속은 원래 칸과 같은 판 ${version}`
    : `원래 칸 ${parent.version} 의 다음 판 ${version}`} · ${depth >= 2
    ? `우선순위 한 단 낮춤 ${parent.priority}→${priority}(하한 P2)`
    : `같은 우선순위 ${priority}`} · 자율 폭 ${autonomyWidth} · 조망 예산 ${groundingBudget}`;
  return { cellId: record.cellId, version, priority, reason, autonomyWidth, groundingBudget };
}
