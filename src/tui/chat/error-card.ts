import { redactSecretText } from '../../debug/log.js';

function safeErrorText(text: string): string {
  return redactSecretText(text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')).trim();
}

/** A failed turn's public receipt and the next useful action. */
export function nextTuiErrorCard(
  error: string,
  authFailureKind?: 'codex-auth-missing' | 'codex-auth-failed',
): string[] {
  const detail = safeErrorText(error) || '오류 상세 없음';
  return [
    `✘ ${detail}`,
    authFailureKind ? '  /provider 연결 확인 · 인증 갱신 → ↑ 입력 불러오기 → Enter 재전송'
      : '  ↑ 입력 불러오기 → Enter 재전송 · /provider 확인',
  ];
}
