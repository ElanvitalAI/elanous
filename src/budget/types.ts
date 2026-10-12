// H6 P1 Bundle 1 · Budget tracker core types.
//
// Normalized shapes that every fetcher / store / UI widget agrees on.
// Inspired by CodexBar's `UsageSnapshot` / `RateWindow` (Swift) — see
// `~/source/ref/CodexBar/Sources/CodexBar/*.swift` — but
// trimmed to what H6 P1 Bundle 1 actually needs (no per-account
// sessions · no widget snapshot · no plan utilization history — those
// are v2 / Bundle 2 concerns).
//
// See `내부 문서 `PLAN-h6-p1-budget-tracker`` §4.1 for the canonical shape
// + §5 for the architectural decisions backing each field.

/** Which LLM brand owns the usage. `'local-llm'` is an H6 P2 hookup
 *  point — Bundle 1 doesn't fetch for it (fetcher = stub in Bundle 2). */
export type UsageProvider = 'codex' | 'claude' | 'gemini' | 'local-llm' | 'grok';

/** Rolling window kind surfaced on every `RateWindow`.
 *  - `session` = 5-hour rolling (mirrors CodexBar `five_hour`).
 *  - `weekly`  = 7-day rolling (mirrors CodexBar `seven_day`).
 *  - `monthly` = billing cycle (for `extra_usage` / credits windows).  */
export type WindowKind = 'session' | 'weekly' | 'monthly';

/** Which pipeline produced the snapshot. Labels flow through to LLM
 *  tool output so the agent knows how fresh / authoritative the data
 *  is (OAuth API = most authoritative · local-log = best-effort). */
export type UsageSource =
  | 'oauth-api'
  | 'cli-rpc'
  | 'cli-pty'
  | 'web-cookie'
  | 'local-log';

/** One window's worth of usage state.
 *  `used` is a count in `limit`'s unit (tokens OR credits depending on
 *  plan); `remainingPercent` is derived (0..100) and always defined so
 *  UI code doesn't have to redo the arithmetic. */
export interface RateWindow {
  readonly kind: WindowKind;
  readonly windowMinutes: number;
  readonly limit: number;
  readonly used: number;
  readonly remainingPercent: number;
  /** Epoch ms · next cycle boundary. 0 = unknown. */
  readonly resetsAt: number;
  /** Model-specific window (e.g. CodexBar's `seven_day_opus`). Undefined
   *  = brand-level aggregate across all models. */
  readonly model?: string;
}

/** Credits-style sub-meter (OpenAI credits · Anthropic extra usage).
 *  Orthogonal to `RateWindow` — some plans show % quota AND a dollar
 *  balance. `unlimited: true` short-circuits any "low balance" alert. */
export interface CreditsInfo {
  readonly balance: number;
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
}

/** Full per-brand snapshot as produced by a fetcher + stored in the
 *  UsageStore. Fetchers produce these; LLM tools read them; history-
 *  store persists a derivative (turn-level rows). */
export interface UsageSnapshot {
  readonly provider: UsageProvider;
  /** Hash of account email — enables future multi-account support
   *  without schema churn. Undefined = single-account / not determined. */
  readonly accountKey?: string;
  readonly windows: readonly RateWindow[];
  readonly credits?: CreditsInfo;
  readonly plan?: 'free' | 'paid' | 'pro' | 'team' | 'enterprise' | 'workspace';
  /** ⭐ provider 가 「리밋이 찼다」고 «말한» 문자열 그대로(예: codex `rate_limit_reached`).
   *  ⛔ 우리가 `used >= limit` 로 «추론하지 않는다» — 공급자 판정이 우리 산술보다 권위 있다.
   *  undefined = 안 찼거나 provider 가 말하지 않았다(둘을 구분하지 않는다 — 그 구분은 응답에 없다). */
  readonly rateLimitReached?: string;
  readonly fetchedAt: number;
  readonly source: UsageSource;
}

/** Rolling-average forecast output · produced by the forecaster from
 *  recent `TurnSummary` history. Bundle 2 scope — kept here so the
 *  UsageStore can declare the type without a circular import when
 *  Bundle 2 lands. */
export interface UsagePace {
  readonly windowKind: WindowKind;
  readonly elapsedPercent: number;
  readonly usedPercent: number;
  readonly expectedUsedPercent: number;
  readonly daysRemaining: number;
  /** Epoch ms at which, at the observed pace, the limit hits 100%.
   *  `null` means the pace projects arrival *after* the window resets. */
  readonly atCurrentPaceReachesLimitAt: number | null;
}

/** User-configurable or brand-default limit.
 *  Storage key = (brand, model?, window). `source` tells the UI whether
 *  to show an "edit" affordance (only `user-config` is editable). */
export interface Limit {
  readonly brand: UsageProvider;
  readonly model?: string;
  readonly window: WindowKind;
  readonly quota: number;
  readonly cycleStart: number;
  readonly source: 'user-config' | 'brand-default' | 'fetched';
}

/** One completed agent turn, recorded by the recorder (log-scan in
 *  Bundle 1 · adapter hook in Bundle 2 if the PTY transport gains
 *  structured turn events). `turnId` is the idempotency key — the
 *  recorder MUST NOT double-count a turn even if two scanners observe
 *  the same raw log file.
 *
 *  For Claude dedup, the canonical turnId encodes `messageId + requestId`
 *  (CodexBar 내부 문서 `claude` §Cost usage). For Codex it encodes the
 *  native `event_msg` id from `~/.codex/sessions/**\/*.jsonl`.  */
/** 구독 주기 한도 축. ⛔ 크레딧 사용률과 한 칸에 접지하지 않는다.
 *  `unavailable` 은 0·빈칸·모름이 아니라 「이 조회가 이 축을 주지 않는다」. */
export type SubscriptionAxis =
  | {
      readonly status: 'available';
      readonly remainingPercent: number;
      readonly resetsAt: number;
      readonly windowKind: WindowKind;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'query-does-not-supply' | 'not-a-subscription';
    };

/** 크레딧(종량·선불) 축. ⛔ 구독 잔량 필드를 두지 않는다. */
export type CreditAxis =
  | {
      readonly status: 'ok';
      readonly usedPercent: number | null;
      readonly periodType: string | null;
      readonly periodStart: string | null;
      readonly periodEnd: string | null;
      readonly monthlyLimit: number | null;
      readonly used: number | null;
      readonly onDemandCap: number | null;
      readonly onDemandUsed: number | null;
      readonly prepaidBalance: number | null;
      readonly balance: number | null;
      readonly hasCredits: boolean | null;
      readonly unlimited: boolean | null;
    }
  | { readonly status: 'absent' }
  | { readonly status: 'no-subscription' }
  | { readonly status: 'unauthorized' }
  | { readonly status: 'error'; readonly detail: string };

/** 통합 조회 한 행 — 계정 · 크레딧 · 구독이 각각 칸이다. */
export type ResetCreditExpiryAxis =
  | { readonly status: 'not-applicable' }
  | { readonly status: 'unavailable'; readonly detail: string }
  | { readonly status: 'none' }
  | { readonly status: 'unknown-expiry' }
  | { readonly status: 'available'; readonly expiresAt: string; readonly hasUnknownExpiry: boolean }
  | { readonly status: 'expiring-soon'; readonly expiresAt: string; readonly hasUnknownExpiry: boolean }
  | { readonly status: 'expired'; readonly expiresAt: string; readonly hasUnknownExpiry: boolean };

export interface AccountUsageRow {
  /** `zai` = GLM Coding Plan(ZAI-CODING-PLAN-PROVIDER) — `ZAI_API_KEY` 가 있을 때만 행이 생긴다.
   *  `claude` = Claude Code 구독(CLAUDE-USAGE-WINDOW) — OAuth 토큰이 있을 때만 행이 생긴다. */
  readonly provider: 'codex' | 'claude' | 'grok' | 'openrouter' | 'zai';
  readonly accountName: string;
  readonly accountCount: number;
  readonly soleAccount: boolean;
  readonly credits: CreditAxis;
  readonly subscription: SubscriptionAxis;
  readonly resetCredits: ResetCreditExpiryAxis;
  /** 행 끝에 붙는 한 줄(출처·실수치) — 없으면 종전 문면과 바이트 동일. */
  readonly note?: string;
}

export interface UnifiedUsageReport {
  readonly rows: readonly AccountUsageRow[];
  /** `zai` 는 키가 있을 때만 실린다(없으면 종전 JSON 과 같다). */
  /** `claude` 도 토큰이 있을 때만 실린다(없으면 종전 JSON 과 같다). */
  readonly accountCounts: Readonly<Record<'codex' | 'grok' | 'openrouter', number>> & { readonly claude?: number; readonly zai?: number };
  /** GLM Coding Plan 상세(창 · 우리 적산 · 잔액 사용 · 마지막 한도 코드) — 키가 있을 때만. */
  readonly zaiCodingPlan?: import('../llm/zai-coding-plan.js').ZaiUsageView;
}

export interface TurnSummary {
  readonly turnId: string;
  readonly sessionId: string;
  readonly provider: UsageProvider;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreateTokens?: number;
  readonly costUsd?: number;
  readonly completedAt: number;
}
