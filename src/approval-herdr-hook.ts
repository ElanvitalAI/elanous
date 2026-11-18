// 승인/질문 모달 ↔ herdr blocked 훅.
// approval-modal(화면)과 tui-run-state(상태 기록)가 서로를 import 하지 않게 이 파일만 공유한다.

export type ApprovalModalKind = 'askUser' | 'planExit' | 'approval';

export type ApprovalHerdrBlockedHook = (blocked: boolean, kind: ApprovalModalKind) => void;

let herdrBlockedHook: ApprovalHerdrBlockedHook | null = null;

export function setApprovalHerdrBlockedHook(hook: ApprovalHerdrBlockedHook | null): void {
  herdrBlockedHook = hook;
}

/** 등록한 그 훅일 때만 해제한다 — 먼저 시작한 녹음기의 stop 이 뒤 녹음기의 훅을 지우지 않게. */
export function clearApprovalHerdrBlockedHook(hook: ApprovalHerdrBlockedHook): void {
  if (herdrBlockedHook === hook) herdrBlockedHook = null;
}

export function notifyApprovalHerdrBlocked(blocked: boolean, kind: ApprovalModalKind): void {
  try { herdrBlockedHook?.(blocked, kind); } catch { /* 보고 실패가 모달을 막지 않는다 */ }
}
