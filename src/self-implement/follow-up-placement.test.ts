// FLEX-COORD-FU-PLACE 판정선 — 깊이 1 은 다음 판 같은 우선순위 · 깊이 2 는 한 단 낮춤(P2 하한) ·
// blocked 는 같은 판. 제안은 순수 함수라 같은 입력은 언제나 같은 값을 낸다.

import { describe, expect, test } from 'bun:test';
import type { FollowUpDraftRecord } from './follow-up-goals.js';
import {
  FOLLOW_UP_AUTONOMY_WIDTH_BASE,
  FOLLOW_UP_GROUNDING_BUDGET_BASE,
  nextReleaseVersion,
  proposeFollowUpPlacement,
  type FollowUpParentCell,
} from './follow-up-placement.js';

const PARENT: FollowUpParentCell = { version: '0.2.30', priority: 'P1' };

function draft(depth: number, ending?: 'blocked') {
  return { cellId: 'FLEX-COORD-FU-PLACE', depth, ...(ending ? { ending } : {}) };
}

describe('FLEX-COORD-FU-PLACE — 후속 초안의 판 배치 제안', () => {
  test('깊이 1 은 원래 칸의 다음 판 ⊕ 같은 우선순위를 제안한다', () => {
    const proposal = proposeFollowUpPlacement(draft(1), PARENT);
    expect(proposal).toMatchObject({
      cellId: 'FLEX-COORD-FU-PLACE',
      version: '0.2.31',
      priority: 'P1',
      autonomyWidth: FOLLOW_UP_AUTONOMY_WIDTH_BASE,
      groundingBudget: FOLLOW_UP_GROUNDING_BUDGET_BASE,
    });
    expect(proposal.reason).toContain('0.2.31');
    expect(proposal.reason).toContain('같은 우선순위 P1');
  });

  test('깊이 2 이상은 우선순위를 한 단 낮춘다 — P2 는 하한이다', () => {
    expect(proposeFollowUpPlacement(draft(2), PARENT).priority).toBe('P2');
    expect(proposeFollowUpPlacement(draft(3), PARENT).priority).toBe('P2');
    expect(proposeFollowUpPlacement(draft(2), { version: '0.2.30', priority: 'P0' }).priority).toBe('P1');
    expect(proposeFollowUpPlacement(draft(2), { version: '0.2.30', priority: 'P2' }).priority).toBe('P2');
    expect(proposeFollowUpPlacement(draft(2), PARENT).version).toBe('0.2.31');
  });

  test('ending blocked 면 원래 칸과 같은 판에 둔다', () => {
    const proposal = proposeFollowUpPlacement(draft(1, 'blocked'), PARENT);
    expect(proposal.version).toBe('0.2.30');
    expect(proposal.reason).toContain('같은 판 0.2.30');
  });

  test('자율 폭·조망 예산은 깊이로 좁히고 하한 아래로는 내려가지 않는다', () => {
    const first = proposeFollowUpPlacement(draft(1), PARENT);
    const second = proposeFollowUpPlacement(draft(2), PARENT);
    const third = proposeFollowUpPlacement(draft(3), PARENT);
    expect(first.autonomyWidth).toBeGreaterThan(second.autonomyWidth);
    expect(second.autonomyWidth).toBeGreaterThan(third.autonomyWidth);
    expect(first.groundingBudget).toBeGreaterThan(second.groundingBudget);
    expect(second.groundingBudget).toBeGreaterThan(third.groundingBudget);
    const deep = proposeFollowUpPlacement(draft(6), PARENT);
    expect(deep.autonomyWidth).toBe(1);
    expect(deep.groundingBudget).toBe(2);
  });

  test('제안은 순수하다 — 같은 입력은 같은 제안을 낸다', () => {
    expect(proposeFollowUpPlacement(draft(2), PARENT)).toEqual(proposeFollowUpPlacement(draft(2), PARENT));
  });

  test('다음 조각 접점 — FollowUpDraftRecord 원형을 그대로 건너도 제안이 나온다', () => {
    const record: FollowUpDraftRecord = {
      prNumber: 41,
      cellId: 'FLEX-COORD-FU-PLACE',
      depth: 2,
      draftHash: 'h2',
      kind: 'draft',
      originalAskFirstLine: 'FLEX-COORD-FU-PLACE 첫 줄',
      remainings: ['남은 조각 한 줄'],
      queued: false,
    };
    expect(proposeFollowUpPlacement(record, PARENT)).toMatchObject({ cellId: 'FLEX-COORD-FU-PLACE', version: '0.2.31', priority: 'P2' });
  });

  test('다음 판 계산은 마지막 칸을 하나 올린다', () => {
    expect(nextReleaseVersion('0.2.30')).toBe('0.2.31');
    expect(nextReleaseVersion('1.9.9')).toBe('1.9.10');
  });
});
