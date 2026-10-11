/**
 * TA-LAND-ORDER-LEDGER — 겹침 쌍·착지 순서 원장(첫 조각 · MK 0.2.24 칸 LAND-ORDER-LEDGER).
 *
 * - 왜: 재판정 틱이 같은 PR 의 여러 머리를 겹쳐 재게이트·land 하면서 «무엇이 먼저 착지했고 그때 리뷰·게이트가
 *   무엇을 말했나»가 카드 이력 흐름에만 남는다. 착지 순서를 정하는 다음 소비자(L8 머지 큐 · OVERLAP-METRIC 집계 —
 *   다음 조각)는 한 줄씩인 «원장» 모양이 필요하다 — 이 모듈은 그 행을 만들고 붙인다(순서 결정은 여기서 하지 않는다).
 * - 행 = {pr, head, cardId, gateBase, reviewVerdict, mustFix, landOk, landClass, at} — `joinLandOrderRow` 가 순수하게
 *   만들고(파일을 읽지 않는다) `appendLandOrderRow` 가 카드 상태 파일 옆 `land-order-ledger.jsonl`(JSONL) 에 붙인다.
 * - reviewVerdict: review-results 파일(`review-result-capture.ts` 의 reviewResultPath 꼴)을 못 읽으면 'missing' —
 *   0 으로 쓰지 않는다. mustFix 도 읽었을 때만 수로, 모르면 null(0 이 아니다).
 * - 같은 pr+head 는 한 줄만 — 두 번 불러도 첫 줄이 그대로다(덮어쓰지 않는다).
 * - 호출자: `rejudge-on-head.ts` ③ land 단계 — executeLiveLand 직후 한 번. 쓰기 실패는 호출자가 삼킨다(land 결과 무변).
 * - 관측: `task-agent.land-order` · 'appended' | 'append-failed' {pr, head} — 호출자가 남긴다.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LiveMoveResult } from './live-moves.js';
import type { ParsedReviewResult } from './review-result-capture.js';

/** 원장 행 — 같은 pr+head 는 한 줄만. */
export interface LandOrderRow {
  pr: number;
  head: string;
  cardId: string;
  /** 재게이트 base — 겹침 증거(#26023 꼴)의 `gate.baseCommit`. */
  gateBase: string;
  /** review-results 파일을 못 읽으면 'missing' — 0 으로 쓰지 않는다. */
  reviewVerdict: string;
  /** must-fix 수 — 읽었을 때만. 모르면 null(0 이 아니다). */
  mustFix: number | null;
  landOk: boolean;
  /** 실패 갈래(infra|judgement|base-stale) — 갈래가 없으면(성공) null. */
  landClass: string | null;
  at: string;
}

/**
 * 겹침 증거(#26023 꼴 `{pr, head, gate:{head, baseCommit, passed}, reviewResult}`) ⊕ 카드 식별.
 * `cardId` 는 증거 «파일»에는 없는 칸이라 호출자가 메모리에서 싣는다(파일 형식은 무변).
 */
export interface LandOrderOverlapEvidence {
  pr: number;
  head: string;
  cardId: string;
  gate: { head: string; baseCommit: string; passed: boolean };
  reviewResult?: string;
}

/** 원장 파일 — 카드 상태 파일 옆(reviewResultPath 와 같은 «옆» 규칙). */
export function landOrderLedgerPath(statePath: string): string {
  return join(dirname(statePath), 'land-order-ledger.jsonl');
}

/** 순수 함수 — 겹침 증거 ⊕ 회수한 리뷰 결과 ⊕ land 결과를 원장 한 행으로 합친다(파일을 읽지 않는다). */
export function joinLandOrderRow(input: {
  overlapEvidence: LandOrderOverlapEvidence;
  /** review-results 파일을 읽어 해석한 결과 — 못 읽으면 null(→ reviewVerdict 'missing'). */
  reviewResult: ParsedReviewResult | null;
  landed: Pick<LiveMoveResult, 'ok' | 'landAttempt'>;
  at: string;
}): LandOrderRow {
  return {
    pr: input.overlapEvidence.pr,
    head: input.overlapEvidence.head,
    cardId: input.overlapEvidence.cardId,
    gateBase: input.overlapEvidence.gate.baseCommit,
    reviewVerdict: input.reviewResult?.verdict ?? 'missing',
    mustFix: input.reviewResult?.mustFix ?? null,
    landOk: input.landed.ok === true,
    landClass: input.landed.landAttempt?.class ?? null,
    at: input.at,
  };
}

/** 원장에 한 줄 붙인다 — 같은 pr+head 가 이미 있으면 그대로(두 번 불러도 1행). 못 붙이면 던진다(호출자가 삼킨다). */
export function appendLandOrderRow(statePath: string, row: LandOrderRow): void {
  const ledgerPath = landOrderLedgerPath(statePath);
  let existing: string;
  try {
    existing = readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    existing = '';
  }
  const samePair = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entry = value as Partial<LandOrderRow>;
    return entry.pr === row.pr && typeof entry.head === 'string' && entry.head.toLowerCase() === row.head.toLowerCase();
  };
  const seen = existing.split('\n').filter(Boolean).some((line) => {
    try { return samePair(JSON.parse(line)); } catch { return false; }
  });
  if (seen) return;
  appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
}
