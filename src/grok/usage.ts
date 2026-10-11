// ── Grok 구독 사용량 조회 ──
//
// 대표 지시 2026-08-14 — 리포트 §6 ②「사용량 조회 배선」.
//
// ⭐ **구독 토큰 하나로 조회된다** — 새 인증이 필요 없다. `resolveGrokCredential()` 이
// 내는 자격을 그대로 쓴다(구독일 때만 · API 키로는 이 엔드포인트가 의미 없다).
//
// 🧪 실측 (2026-08-13):
//   GET /v1/billing?format=credits → 200 · currentPeriod=USAGE_PERIOD_TYPE_WEEKLY
//                                        · isUnifiedBillingUser=true
//   GET /v1/billing                → 200 · monthlyLimit·used·billingPeriod*
//
// ⛔⚠️ **미문서화 엔드포인트다** — `docs.x.ai` 전 문서에서 0건. 1차 문서는 벤더 저장소
//   README(`xai-grok-shell/README.md` 「Using auth.json for API Access」)뿐이고 거기에도
//   billing 은 «없다**(chat 만 있다). ⇒ 조용히 깨질 수 있다.
//   그래서 이 모듈은 **실패를 값으로 낸다** — 던지지 않는다. 「모른다」와 「0」을 다른 값으로.
//
// ⛔ 형태는 orca(`stablyai/orca`)의 `rate-limits/grok-fetcher.ts` 를 «참고»했다(코드 이식 아님):
//   두 URL(credits/default)·헤더 구성·unified-billing 분기가 거기서 확인된 사실이다.

import { isGrokUnauthorized, refreshGrokSubscriptionToken, resolveGrokCredential } from './credential.js';
import type { GrokCredential, GrokRefreshOutcome } from './credential.js';

/** 조회 결과. ⛔ 실패를 «예외»가 아니라 값으로 낸다. */
export type GrokUsageResult =
  | { readonly status: 'ok'; readonly usage: GrokUsage }
  | { readonly status: 'no-subscription' }
  | { readonly status: 'unauthorized' }
  | { readonly status: 'error'; readonly detail: string };

export interface GrokUsage {
  /** 사용률(%) — 없을 수 있다. ⛔ `null` 은 «모른다»이지 0 이 아니다. */
  readonly usedPercent: number | null;
  /** 구독 등급 문자열(그대로). */
  readonly tier: string | null;
  /** 현재 창의 종류 — 실측값 예: `USAGE_PERIOD_TYPE_WEEKLY`. */
  readonly periodType: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  /** 금액류 — 문자열/수 어느 쪽으로도 오므로 수로 정규화한다. `null`=모른다. */
  readonly monthlyLimit: number | null;
  readonly used: number | null;
  readonly onDemandCap: number | null;
  readonly onDemandUsed: number | null;
  readonly prepaidBalance: number | null;
  readonly unifiedBilling: boolean | null;
}

interface MoneyVal { val?: unknown }

/** xAI 는 금액을 `{ val: "12.34" }` 로도 «수»로도 준다(실측). 둘 다 받는다. */
export function parseMoney(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (value && typeof value === 'object' && 'val' in value) return parseMoney((value as MoneyVal).val);
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 응답 본문 → `GrokUsage`. ⛔ 순수 — 테스트가 네트워크 없이 전수로 문다.
 *
 *  ⚠️ 형태가 «둘»이다 — 최상위에 바로 오거나 `config` 아래에 온다(실측: credits 뷰는
 *  `config` 중첩). 둘 다 받는다. */
export function parseGrokBilling(body: unknown): GrokUsage | null {
  if (!body || typeof body !== 'object') return null;
  const top = body as Record<string, unknown>;
  const cfg = (top['config'] && typeof top['config'] === 'object')
    ? top['config'] as Record<string, unknown>
    : top;
  const period = (cfg['currentPeriod'] && typeof cfg['currentPeriod'] === 'object')
    ? cfg['currentPeriod'] as Record<string, unknown>
    : {};

  const usedPercentRaw = cfg['creditUsagePercent'];
  return {
    usedPercent: typeof usedPercentRaw === 'number' && Number.isFinite(usedPercentRaw) ? usedPercentRaw : null,
    tier: str(cfg['subscriptionTier']),
    periodType: str(period['type']),
    periodStart: str(period['start']) ?? str(cfg['billingPeriodStart']),
    periodEnd: str(period['end']) ?? str(cfg['billingPeriodEnd']),
    monthlyLimit: parseMoney(cfg['monthlyLimit']),
    used: parseMoney(cfg['used']),
    onDemandCap: parseMoney(cfg['onDemandCap']),
    onDemandUsed: parseMoney(cfg['onDemandUsed']),
    prepaidBalance: parseMoney(cfg['prepaidBalance']),
    unifiedBilling: typeof cfg['isUnifiedBillingUser'] === 'boolean' ? cfg['isUnifiedBillingUser'] : null,
  };
}

/** 두 뷰를 합친다 — credits 뷰가 창/등급을, default 뷰가 월 한도를 갖는 계정이 있다(실측). */
export function mergeGrokUsage(primary: GrokUsage | null, secondary: GrokUsage | null): GrokUsage | null {
  if (!primary) return secondary;
  if (!secondary) return primary;
  const pick = <K extends keyof GrokUsage>(k: K): GrokUsage[K] =>
    (primary[k] === null || primary[k] === undefined ? secondary[k] : primary[k]);
  return {
    usedPercent: pick('usedPercent'), tier: pick('tier'),
    periodType: pick('periodType'), periodStart: pick('periodStart'), periodEnd: pick('periodEnd'),
    monthlyLimit: pick('monthlyLimit'), used: pick('used'),
    onDemandCap: pick('onDemandCap'), onDemandUsed: pick('onDemandUsed'),
    prepaidBalance: pick('prepaidBalance'), unifiedBilling: pick('unifiedBilling'),
  };
}

const TIMEOUT_MS = 10_000;

/** 구독 사용량을 조회한다. ⛔ 던지지 않는다 — 실패는 `status` 로 온다. */
export async function fetchGrokUsage(
  deps: {
    readonly fetchImpl?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly resolveCredential?: () => GrokCredential | null;
    readonly refreshSubscriptionToken?: () => GrokRefreshOutcome;
  } = {},
): Promise<GrokUsageResult> {
  const resolveCredential = deps.resolveCredential ?? resolveGrokCredential;
  const refreshSubscriptionToken = deps.refreshSubscriptionToken ?? refreshGrokSubscriptionToken;
  const doFetch = deps.fetchImpl ?? fetch;

  const query = async (cred: GrokCredential): Promise<GrokUsageResult> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cred.token}`,
      Accept: 'application/json',
      ...cred.headers,
    };
    // 모델 라우팅 헤더는 billing 과 무관하다 — 보내지 않는다.
    delete headers['x-grok-model-override'];

    const get = async (url: string): Promise<{ ok: boolean; status: number; body: unknown }> => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      try {
        const res = await doFetch(url, { headers, signal: deps.signal ?? ac.signal });
        const text = await res.text();
        let body: unknown = null;
        try { body = JSON.parse(text) as unknown; } catch { body = null; }
        return { ok: res.ok, status: res.status, body };
      } finally {
        clearTimeout(timer);
      }
    };

    const credits = await get(`${cred.baseUrl}/billing?format=credits`);
    if (isGrokUnauthorized(credits.status)) return { status: 'unauthorized' };
    const primary = credits.ok ? parseGrokBilling(credits.body) : null;

    // ⭐ unified-billing 계정은 월 한도가 default 뷰에만 있다 — 그때만 한 번 더 친다.
    let secondary: GrokUsage | null = null;
    if (primary === null || primary.monthlyLimit === null) {
      const dflt = await get(`${cred.baseUrl}/billing`);
      if (isGrokUnauthorized(dflt.status)) return { status: 'unauthorized' };
      secondary = dflt.ok ? parseGrokBilling(dflt.body) : null;
    }

    const merged = mergeGrokUsage(primary, secondary);
    if (!merged) return { status: 'error', detail: `billing 응답을 해석하지 못했다 (HTTP ${credits.status})` };
    return { status: 'ok', usage: merged };
  };

  let cred = resolveCredential();
  // ⛔ API 키로는 이 엔드포인트가 «구독 사용량»을 뜻하지 않는다 — 조용히 답하지 않는다.
  if (!cred || cred.kind !== 'subscription') return { status: 'no-subscription' };

  try {
    let result = await query(cred);
    if (result.status !== 'unauthorized') return result;

    // 최초 401/403에만 기존 갱신을 한 번 시도하고, 실제 갱신된 구독 자격으로만 재조회한다.
    if (refreshSubscriptionToken() !== 'refreshed') return result;
    cred = resolveCredential();
    if (cred?.kind !== 'subscription') return result;
    result = await query(cred);
    return result;
  } catch (err) {
    return { status: 'error', detail: (err as Error)?.message ?? String(err) };
  }
}

/** 주간 사용률·리셋이 없거나 유효하지 않은 응답에서 구독 축이 제공되지 않음을 나타낸다. */
export const GROK_SUBSCRIPTION_AXIS = {
  status: 'unavailable',
  reason: 'query-does-not-supply',
} as const;

/** billing 쿼리가 주간 창과 사용률을 함께 돌려준 경우에만 실제 구독 잔량을 구성한다. */
export function grokUsageToSubscriptionAxis(usage: GrokUsage):
  | { readonly status: 'available'; readonly remainingPercent: number; readonly resetsAt: number; readonly windowKind: 'weekly' }
  | typeof GROK_SUBSCRIPTION_AXIS {
  const end = usage.periodEnd === null ? Number.NaN : Date.parse(usage.periodEnd);
  if (
    usage.periodType !== 'USAGE_PERIOD_TYPE_WEEKLY'
    || usage.usedPercent === null
    || !Number.isFinite(usage.usedPercent)
    || usage.usedPercent < 0
    || usage.usedPercent > 100
    || !Number.isFinite(end)
  ) return GROK_SUBSCRIPTION_AXIS;
  return {
    status: 'available',
    remainingPercent: 100 - usage.usedPercent,
    resetsAt: end,
    windowKind: 'weekly',
  };
}

/** 원본 크레딧 사용률·창·금액류 → 크레딧 축. ⛔ 크레딧 숫자만으로 구독 잔량을 만들지 않는다. */
export function grokUsageToCreditAxis(usage: GrokUsage): {
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
} {
  return {
    status: 'ok',
    usedPercent: usage.usedPercent,
    periodType: usage.periodType,
    periodStart: usage.periodStart,
    periodEnd: usage.periodEnd,
    monthlyLimit: usage.monthlyLimit,
    used: usage.used,
    onDemandCap: usage.onDemandCap,
    onDemandUsed: usage.onDemandUsed,
    prepaidBalance: usage.prepaidBalance,
    balance: usage.prepaidBalance,
    hasCredits: usage.prepaidBalance === null ? null : usage.prepaidBalance > 0,
    unlimited: null,
  };
}

/** 사람이 읽는 한 줄. ⛔ 토큰·이메일 같은 신원은 넣지 않는다. */
export function describeGrokUsage(result: GrokUsageResult): string {
  switch (result.status) {
    case 'no-subscription':
      return 'grok 구독 자격 없음 — `grok login` 후 다시 (API 키로는 구독 사용량을 못 잰다)';
    case 'unauthorized':
      return 'grok 구독 토큰이 거부됐다(401/403) — `grok login` 으로 재인증';
    case 'error':
      return `grok 사용량 조회 실패 — ${result.detail}`;
    case 'ok': {
      const u = result.usage;
      const parts: string[] = [];
      // ⛔ 「모른다」를 0 으로 찍지 않는다.
      parts.push(u.usedPercent === null ? '사용률 미상' : `사용률 ${u.usedPercent}%`);
      if (u.tier) parts.push(`등급 ${u.tier}`);
      if (u.periodType) parts.push(`창 ${u.periodType}`);
      if (u.periodStart && u.periodEnd) parts.push(`${u.periodStart.slice(0, 10)}~${u.periodEnd.slice(0, 10)}`);
      if (u.monthlyLimit !== null) parts.push(`월한도 ${u.monthlyLimit}`);
      if (u.used !== null) parts.push(`사용 ${u.used}`);
      if (u.unifiedBilling === true) parts.push('unified-billing');
      parts.push('표시 수치는 종량(on-demand)·선불 축');
      parts.push('SuperGrok Heavy 주간 구독 풀 잔량·리셋은 이 응답에 없음 — grok.com → Settings → Usage에서 확인');
      if (
        u.unifiedBilling === true
        && u.monthlyLimit === 0
        && u.used === 0
        && u.onDemandCap === 0
        && u.prepaidBalance === 0
        && u.usedPercent === null
      ) {
        parts.push('전부 0·사용률 미상은 사용 없음이 아니라 이 응답이 구독 소비를 담지 않는 경우에 가깝다');
      }
      return parts.join(' · ');
    }
  }
}
