// 보드 공개 캡처 — 카드의 문자열(제목·요약)을 Live·Trace 와 같은 가면으로 가린다.
// 2026-09-30 티저 S02: 카드 제목 «[eln][run] mbp-node-b 임대 기계 이름 실측» 이 녹화에 그대로 찍혔다.
import { maskValueForPublic } from '@/lib/live-public';
import type { TaskCard } from '@/lib/task-card-model';

export function maskCardsForPublic(cards: readonly TaskCard[]): TaskCard[] {
  // 회신 주소(텔레그램 대화·PWA 세션 id)는 가면 패턴에 안 걸리는 숫자일 수 있어 공개 캡처에선 표면만 남긴다.
  return cards.map((card) => ({ ...maskValueForPublic(card, []), taskId: card.taskId,
    ...(card.wishReply ? { wishReply: { surface: card.wishReply.surface, address: null } } : {}) }));
}
