// ── 턴 결과 그림자 비교 `turn-outcome-shadow` (ELN-PLAN-LEDGER-ONE · 2026-11-17) ──────────────────────────
//
// 🚨 무엇을 푸는가: 턴 끝 판정을 문장 파싱(약속 추출기 · #38049/#38067 감지기)에 맡기면 언어·문체·모델마다 깨진다
//   (seat-state/OP/RETHINK-TURN-OUTCOME-STRUCTURED-1117 L4). 판정의 정본은 «계획 도구 상태» 하나로 옮기고,
//   문장 추출기는 행동을 바꾸지 않는 «그림자 관측»으로 내린다(내부 문서 `ELN-SELF-PROACTIVE` v2).
// ⭐ 이 모듈은 비교만 한다 — 추출기 결과(약속 꼴 목록)와 계획 상태 스냅샷(호출자가 넘김)을 맞대어
//   agree / missed / spurious / no-structure 를 정하고, 불일치일 때만 `turn.outcome-mismatch` 를 남긴다.
// ⛔ 순수 판정 — 파일 쓰기 0 · 원장 쓰기 0. 이벤트에 답 원문·약속 내용·항목 제목을 싣지 않는다(꼴 이름·개수·id 형식 값만).
// ⛔ 계획 상태 타입: 확장 상태(blocked/waiting)를 지닌 계획 원장은 아직 열린 PR(#38066 ELN-PLAN-WIRE-SEAT) 너머라,
//   여기서는 최소 읽기 인터페이스(PlanOutcomeReadView)만 정의한다. 계획 저장소 → 뷰 어댑터와 생산 호출부(턴 끝에서
//   plan 을 넘겨 recordReplyCommitments 를 부르는 곳)는 관문 v2 2단계 PR(HAND-TUI-C · ELN-TURN-END-DECISION-GATE v2)
//   몫이다 — 그 PR 이 착지하기 전까지 이 비교는 호출되지 않는다(#38073 r1 Claude MF · 쓰는 곳 없는 어댑터 제거).
//
// 세 얼굴:
//   관측 = `turn.outcome-mismatch` {kind missed|spurious · seat · turnId · pattern · extracted · open}
//   판단 근거 = 계획 상태(정본) — 추출기는 측정 대상일 뿐 판정을 바꾸지 않는다
//   수복과 인계 = 11-24 까지 불일치율을 재 문장 감지기 제거 여부를 정한다(만료 · OP 판단)

import { debug } from '../../debug/log.js';
import type { CommitmentPattern } from './commitment-extract.js';

/** 계획 항목 상태(v2 스키마) — done 은 update_plan 의 completed 와 같다. */
export type PlanOutcomeStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'waiting';

/** 최소 읽기 인터페이스 — 비교에 필요한 것은 항목 id 와 상태뿐(제목·원문은 읽지 않는다). */
export interface PlanOutcomeItemView { id: string; status: PlanOutcomeStatus }
export interface PlanOutcomeReadView { items: readonly PlanOutcomeItemView[] }

/** «아직 할 일이 남았다» — 계속하거나(pending·in_progress) 깨우개로 다시 올(waiting) 항목. blocked 는 사람 몫이라 뺀다. */
const OPEN_WORK: ReadonlySet<PlanOutcomeStatus> = new Set(['pending', 'in_progress', 'waiting']);

export function countOpenWork(view: PlanOutcomeReadView): number {
  return view.items.filter(i => OPEN_WORK.has(i.status)).length;
}

export type TurnOutcomeVerdict = 'agree' | 'missed' | 'spurious' | 'no-structure';
export const TURN_OUTCOME_MISMATCH_EVENT = 'turn.outcome-mismatch';
export const TURN_OUTCOME_LOG_CATEGORY = 'turn';

export interface TurnOutcomeCompareInput {
  seat: string;
  turnId: string;
  /** 추출기가 이번 답에서 잡은 약속 꼴들(내용은 넘기지 않는다). */
  extractedPatterns: readonly CommitmentPattern[];
  /** 계획 상태 스냅샷 — 없거나 항목 0 이면 구조 공백(no-structure · 비교하지 않는다). */
  plan?: PlanOutcomeReadView;
}

export interface TurnOutcomeCompareResult {
  verdict: TurnOutcomeVerdict;
  extracted: number;
  open: number;
}

export type TurnOutcomeEmit = (category: string, event: string, data: Record<string, unknown>) => void;

/**
 * 추출기(측정 대상) ↔ 계획 상태(정본) 비교.
 *   · missed   = 계획엔 할 일이 남았는데 추출기는 약속 0 — 문장 감지기라면 멈췄을 턴.
 *   · spurious = 계획엔 할 일이 없는데(전부 done·blocked) 추출기는 약속을 잡음 — 문장 감지기라면 헛돌았을 턴.
 *   · agree    = 둘이 같은 쪽.
 *   · no-structure = 계획 상태가 없음 — 비교 기준이 없어 이벤트 0(구조 공백 넛지는 관문 몫).
 * 불일치일 때만 `turn.outcome-mismatch` 를 남긴다(답 원문·약속 내용·항목 제목 0).
 */
export function compareTurnOutcome(
  input: TurnOutcomeCompareInput,
  deps: { emit?: TurnOutcomeEmit } = {},
): TurnOutcomeCompareResult {
  const extracted = input.extractedPatterns.length;
  if (!input.plan || input.plan.items.length === 0) return { verdict: 'no-structure', extracted, open: 0 };
  const open = countOpenWork(input.plan);
  const verdict: TurnOutcomeVerdict = open > 0 && extracted === 0 ? 'missed'
    : open === 0 && extracted > 0 ? 'spurious'
      : 'agree';
  if (verdict === 'missed' || verdict === 'spurious') {
    const emit = deps.emit ?? ((category, event, data) => debug.log(category, event, data));
    emit(TURN_OUTCOME_LOG_CATEGORY, TURN_OUTCOME_MISMATCH_EVENT, {
      kind: verdict,
      seat: input.seat.trim().toUpperCase(),
      turnId: input.turnId,
      pattern: verdict === 'spurious' ? input.extractedPatterns[0]! : null,
      extracted,
      open,
    });
  }
  return { verdict, extracted, open };
}
