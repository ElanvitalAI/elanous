// 웹 터미널 연결이 끊긴 «이유»를 사람의 말로 — 그리고 다시 붙을지.
// 대표 2026-09-28: 화면은 «연결 실패»만 말했고 원인(소유자 토큰 없음 → 서버 `1008 auth_failed`)은
// 로그에 200줄+ 쌓여 있었는데 아무도 못 읽었다. 관측은 됐는데 인지·힐링이 0 이던 자리다.

export type AcpFailureKind = 'auth' | 'transient';

/** 닫힘 사유 문자열(`socket closed: 1008: auth_failed` 등)을 가른다. 토큰 문제는 다시 붙어도 또 실패하므로 따로 둔다. */
export function classifyAcpFailure(reason: string | undefined): AcpFailureKind {
  if (!reason) return 'transient';
  return /auth_failed|\b1008\b|unauthori[sz]ed|\b401\b/i.test(reason) ? 'auth' : 'transient';
}

/** 승인 탭(🅞 #21591)과 같은 문면 — 원인 한 문장 ⊕ 할 일. */
export const ACP_AUTH_MESSAGE = '이 기기에 소유자 토큰이 없어 터미널에 연결하지 못했습니다 — 설정에서 토큰을 붙이면 바로 연결됩니다.';
/** 어디서 토큰을 얻나(대표 2026-09-28: 안내가 이걸 말하지 않았다). 값은 화면에 절대 싣지 않는다 — 명령만. */
export const ACP_AUTH_HOWTO = '토큰 얻기: 이미 연결된 기기의 설정 › 연결 토큰 만들기 에서 만들거나, 데몬 기계에서 pbcopy < ~/.elanous/acp-token → 이 기기의 설정 › 데몬 연결 › 연결 토큰 칸에 붙여 넣기';

/** 다시 붙기 간격 — 1s · 2s · 4s … 최대 30s. 데몬 재시작(수 초)을 넘기되 죽은 데몬을 두드리지 않는다. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
}
