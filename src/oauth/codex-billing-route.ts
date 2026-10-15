/**
 * codex 호출의 «과금 경로» 기억 — 회전 판정이 크레딧 소진을 정했으면 그 호출의 `llm.usage` 가 `billing='credit'` 이다.
 *
 * 🩸 10-14 운영 실측: 세 계정이 주간 100% 라 회전이 `credits-allowed` 로 default 계정 크레딧을 쓰는데,
 *   같은 턴의 `llm.usage` 는 `billing=subscription` · `cost.kind=included($0)` 였다 — 원장·토큰 경보가 크레딧 지출을 $0 로 봤다.
 *   자격 종류(oauth)만으로 과금 경로를 정하면 «구독 한도를 넘어 크레딧으로 나간 호출»을 구분 못 한다.
 *
 * 경로: `loadFreshCodexAuthState` → `resolveCodexAccountForRun`(요청마다 · 판정·핀) → 여기 기록
 *   → 응답 끝 `logAgentTurnUsage` → `billingRouteForProvider('openai-codex')` 가 여기를 읽는다.
 * ⚠️ 프로세스 단위 «마지막 판정»이다 — 같은 프로세스에서 다른 런이 동시에 다른 판정을 내리면 섞일 수 있다
 *   (판정은 같은 스토어·설정을 읽으므로 보통 같은 답이다).
 */

export type CodexCreditSpendReason = 'credits-allowed' | 'credit-pace' | 'credits-rotated';

let lastCreditReason: CodexCreditSpendReason | undefined;

/** 계정 해석이 끝날 때마다 부른다 — 크레딧 소진이 아니면 `undefined` 로 지운다(앞 판정이 남지 않게). */
export function noteCodexBillingDecision(reason: CodexCreditSpendReason | undefined): void {
  lastCreditReason = reason;
}

/** 마지막 codex 계정 해석이 크레딧 소진이었으면 그 이유. */
export function codexCreditSpendReason(): CodexCreditSpendReason | undefined {
  return lastCreditReason;
}

/** ⛔ 테스트 심 — 프로덕션에서는 부르지 않는다. */
export function _resetCodexBillingDecisionForTesting(): void {
  lastCreditReason = undefined;
}
