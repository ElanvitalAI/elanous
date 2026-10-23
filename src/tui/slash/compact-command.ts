/** Lightweight `/compact` command recognition for next TUI startup. */
export const COMPACT_BUSY_STATUS = '응답 중에는 /compact 를 받지 않습니다 · 완료(또는 Esc 취소) 뒤 다시';
export const COMPACT_NO_SESSION_STATUS = '압축할 대화가 없습니다';

export function isCompactCommand(text: string): boolean {
  return text.trim() === '/compact';
}
