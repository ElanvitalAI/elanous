/**
 * SEAT-STEER-PREEMPT ② (OP #132479 ② · #129162/#132157 ② · JUD-C #132473 재대조) —
 * 결정 우편의 중도 도착을 «분류 → 전달(steer 오퍼) → 선점» 경로로 잇는 순수 오퍼 함수.
 *
 * 보안 계약(b5c5c3b3 · seat-mail-priority.ts) 보존: 보낸 자리 이름은 인증되지 않아 아무 우선권이
 * 없다. 결정은 구조화 intent(`--intent decision` · legacy `--kind decision` 정규화)만으로 인식하며,
 * 그것이 주는 것은 «실행 중 턴을 끊고 다음 요청에 본문을 반영하는 긴급 steer 제안»뿐이다.
 * 결정이 아니면 기존 그대로 — urgent 없는 일반 steer 오퍼(선점 없음 · 다음 요청에 반영).
 */

import type { PendingSeatMailSource } from '../session/pending-input.js';

/** seatMailOnArrived 의 enqueueMidTurn 이벞트 모양(entry.ts:841 배선과 동일). */
export interface SeatMailMidTurnEvent {
  kind: string;
  id: string;
  text: string;
  from?: string;
  intent?: string | null;
  crownDirective?: string | null;
  originKind?: string | null;
  viaLedger?: boolean;
}

/** entry.ts:2233 의 steer 오퍼 시그니처와 동일 — true = 오퍼가 접수됐다(이벤트함 폴백 없음). */
export type SeatMailSteerOffer = (
  steerId: string,
  text: string,
  urgent: boolean,
  seatMail?: PendingSeatMailSource,
) => boolean;

/** 결정 우편 판정 — seat-mail-priority.isDecisionMail 과 같은 구조화 계약(intent==='decision'). */
function isDecision(event: SeatMailMidTurnEvent): boolean {
  return event.intent === 'decision';
}

/**
 * 중도 도착 우편 한 건을 steer 오퍼로 바꾼다.
 * - 결정(intent==='decision'): urgent steer 오퍼 — 접수되면 실행 중 요청이 중단되고 다음 요청에
 *   결정 본문이 반영된다(«결정 우편 → 30초 안 선점» · SEAT-STEER-PREEMPT).
 * - 그 외: urgent 없는 일반 steer 오퍼(선점 없음 — 다음 요청에 반영).
 * - 오퍼 거부(steer 라우터 부재 등) 또는 kind 불일치: null — 호출자는 이벤트함 폴백으로 돌아간다.
 */
export function offerSeatMailSteer(
  event: SeatMailMidTurnEvent,
  offer: SeatMailSteerOffer,
  nextSerial: () => number,
): string | null {
  if (event.kind !== 'seat-mail') return null;
  const msgId = Number(event.id);
  if (!Number.isSafeInteger(msgId)) return null;
  const decision = isDecision(event);
  const steerId = `mail-${msgId}-${nextSerial()}`;
  // 구조화 출처: 결정 여부와 무관하게 자식은 이 줄을 «operator input»이 아니라 «미신뢰 seat-mail 데이터»로
  // 그린다(next-tui-steer 계약 · entry.ts:845 주석과 동일).
  const seatMail: PendingSeatMailSource = { msgId, from: event.from ?? '?', ...(event.intent !== undefined ? { intent: event.intent } : {}),
    ...(event.crownDirective ? { crownDirective: event.crownDirective } : {}), ...(event.originKind ? { originKind: event.originKind } : {}),
    ...(event.viaLedger === true ? { viaLedger: true } : {}) };
  const accepted = offer(steerId, event.text, decision, seatMail);
  return accepted ? steerId : null;
}
