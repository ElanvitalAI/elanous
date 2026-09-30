// 보드 공개 캡처 — 카드의 문자열(제목·요약)을 Live·Trace 와 같은 가면으로 가린다.
// 2026-09-30 티저 S02: 카드 제목 «[eln][run] mbp-node-b 임대 기계 이름 실측» 이 녹화에 그대로 찍혔다.
import { maskValueForPublic } from '@/lib/live-public';
import type { TaskCard } from '@/lib/task-card-model';

export function maskCardsForPublic(cards: readonly TaskCard[]): TaskCard[] {
  return cards.map((card) => ({ ...maskValueForPublic(card, []), taskId: card.taskId }));
}
