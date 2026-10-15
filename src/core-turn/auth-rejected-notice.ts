// 인증 거절(401)로 끝난 턴을 «조용한 완료»가 아니라 처방 한 줄로 드러낸다(TUI 결함 #22 · 10-14).
//
// `runCoreTurn` 은 인증 거절을 `stopReason: 'auth_rejected'` 로 «돌려준다»(던지지 않는다) —
// 재인증과 버그를 가르려는 설계다. 그런데 ACP 브리지가 그 값을 안 읽어서 TUI 엔 «✔ 완료»만 떴다.
// 브리지는 이 오류를 던져 서버의 실패 경로(`prompt-failed`)와 TUI 의 오류 줄로 보낸다.
//
// ⚠️ 문면은 #27498(실패 지문 사전 · `src/self-health/signatures.ts`)의 «⚠ 원인 → 처방 · 원문» 형식을
//   따른 «임시 상수»다 — 그 PR 이 착지하면 사전 항목(`auth-rejected`)으로 옮기고 이 상수는 지운다.

import { redactSecretText } from '../debug/log.js';

export const AUTH_REJECTED_NOTICE = '⚠ 모델 공급자가 인증을 거절(401) → 다시 로그인하거나 계정 확인(eln usage)';

const RAW_PREVIEW_MAX = 120;

/** 원문 첫 줄을 비밀값 가림 ⊕ 제어 문자 제거 ⊕ 길이 상한으로 줄인다(화면 한 줄을 넘기지 않게). */
export function authRejectedRawPreview(raw: string | undefined): string {
  const firstLine = (redactSecretText(raw ?? '').split(/\r\n|\r|\n/, 1)[0] ?? '')
    // 단독 CR·ESC 같은 터미널 제어 문자가 오류 줄을 덮어쓰지 않게 공백으로(리뷰 r2 should-fix).
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim();
  return firstLine.length > RAW_PREVIEW_MAX ? `${firstLine.slice(0, RAW_PREVIEW_MAX)}…` : firstLine;
}

/** 처방 한 줄 — 원문이 있으면 꼬리에 붙인다. 줄바꿈은 넣지 않는다(오류 줄이 넘치지 않게). */
export function formatAuthRejectedNotice(raw: string | undefined): string {
  const preview = authRejectedRawPreview(raw);
  return preview ? `${AUTH_REJECTED_NOTICE} · 원문: ${preview}` : AUTH_REJECTED_NOTICE;
}

/** 브리지가 던지는 오류. `status` 를 401 로 둬 상위의 인증 판정(`isAuthRejectionError`)과도 맞는다. */
export class CoreTurnAuthRejectedError extends Error {
  readonly status = 401;
  readonly rawMessage: string;

  constructor(raw: string | undefined) {
    super(formatAuthRejectedNotice(raw));
    this.name = 'CoreTurnAuthRejectedError';
    this.rawMessage = redactSecretText(raw ?? '');
  }
}
