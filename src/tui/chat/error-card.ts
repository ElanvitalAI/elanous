import { safeStatusText } from './log-view.js';

/** A failed turn's visible receipt and the three valid recovery routes. */
export function nextTuiErrorCard(error: string): string[] {
  const detail = safeStatusText(error).trim() || '오류 상세 없음';
  return [
    `✘ 응답 실패 · ${detail}`,
    '재시도: ↑ 이전 입력 후 Enter · 제공자 변경: /provider · 이어가기: /resume',
  ];
}
