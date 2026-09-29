// codex 한도 정책 — 「구독 한도가 차면 무엇을 하나」를 config 한 값(`llm.codexQuotaPolicy`)으로 정한다.
//
// 대표 2026-09-28: 크레딧 허가(09~10월 출시 특별기간) 뒤에도 매시 한도 알림이 «폴백이 grok 으로 갑니다»를 냈다 —
//   회전·Pod 브로커·폴백·알림이 각자 다른 스위치를 읽었기 때문이다. ⇒ 정책을 «한 자리»에서 해석하고 넷이 같이 읽는다.
//
// 정책 셋(모든 정책에서 «한도가 남은 다른 계정으로 회전»은 먼저 한다 — 회전은 무료다):
//   within-quota — 구독 한도 안에서만. 크레딧 ✗ · 다른 provider 폴백 ✗ ⇒ 전부 차면 «멈춘다».
//   fallback     — 한도 안 ⊕ 폴백 체인(`llm.fallbackChain` · 예: grok). 크레딧 ✗. (기본)
//   credits      — 한도 안 ⊕ 크레딧(찬 계정을 선불 크레딧으로 계속). 크레딧도 떨어져 요청이 한도 오류를 내면 폴백 체인.
//
// ⛔ 옛 키 `llm.codexCreditsAllowed: true` 는 `credits` 로 읽는다(새 키가 있으면 새 키가 이긴다).
// ⛔ 못 읽거나 모르는 값이면 `fallback` — 크레딧은 돈이라 fail-closed(종전 기본과 같다).

export const CODEX_QUOTA_POLICIES = ['within-quota', 'fallback', 'credits'] as const;
export type CodexQuotaPolicy = (typeof CODEX_QUOTA_POLICIES)[number];

export interface ResolvedCodexQuotaPolicy {
  readonly policy: CodexQuotaPolicy;
  /** 어디서 정해졌나 — `config`(새 키) · `legacy-credits`(옛 `codexCreditsAllowed`) · `default` · `invalid`(모르는 값 → 기본). */
  readonly source: 'env' | 'config' | 'legacy-credits' | 'default' | 'invalid';
}

export const CODEX_QUOTA_POLICY_LABEL: Readonly<Record<CodexQuotaPolicy, string>> = {
  'within-quota': '한도 안에서만',
  fallback: '한도 안 ⊕ 자동 폴백',
  credits: '크레딧까지',
};

export function isCodexQuotaPolicy(value: unknown): value is CodexQuotaPolicy {
  return typeof value === 'string' && (CODEX_QUOTA_POLICIES as readonly string[]).includes(value);
}

export function resolveCodexQuotaPolicy(
  llm: { readonly codexQuotaPolicy?: unknown; readonly codexCreditsAllowed?: unknown } | undefined,
): ResolvedCodexQuotaPolicy {
  // A Pod has no copy of the host config; the launcher hands the host's policy down in this variable
  // (09-29: without it every Pod child fell back to grok while all three accounts still had credits).
  const fromEnv = process.env.ELANOUS_CODEX_QUOTA_POLICY?.trim();
  if (fromEnv && isCodexQuotaPolicy(fromEnv)) return { policy: fromEnv, source: 'env' };
  const raw = llm?.codexQuotaPolicy;
  if (isCodexQuotaPolicy(raw)) return { policy: raw, source: 'config' };
  if (llm?.codexCreditsAllowed === true) return { policy: 'credits', source: 'legacy-credits' };
  if (raw !== undefined) return { policy: 'fallback', source: 'invalid' };
  return { policy: 'fallback', source: 'default' };
}

/** 찬 계정을 선불 크레딧으로 계속 쓰나. */
export function codexPolicyAllowsCredits(policy: CodexQuotaPolicy): boolean {
  return policy === 'credits';
}

/** codex 밖(grok 등)으로 폴백하나. */
export function codexPolicyAllowsFallback(policy: CodexQuotaPolicy): boolean {
  return policy !== 'within-quota';
}
