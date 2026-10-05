// ── 리뷰 프로바이더 폴백 (대표 2026-08-19) ─────────────────────────────────────
//
// 대표 지시: *"과부하시에 그럼 grok review 나 claude review 로 도는 로직도 만들 필요가 있겠네요.
//          기본 codex review 말고요"*
//
// 🚨 왜 필요한가(🅢 실측 · `#10069`):
//   ```
//   merge-decision  autoMerge=true · reviewed=false · verdict="pass" · decision="hitl"
//                   reason="no-real-review" · requiredEvidence=3 · coveredEvidence=***3***
//   provider-error  provider="openai-codex"
//                   message="Codex API error: ***Our servers are currently overloaded.***"
//   ```
//   ⇒ 🔑 ***증거는 3/3 다 덮였고 자식 잘못도 아니다.*** 제공자 과부하로 리뷰가 «안 돌았을» 뿐인데
//     PR 이 draft 로 «조용히» 남았다.
//
// ⛔⭐⭐ **기존 폴백 체인(`DEFAULT_FALLBACK_CHAIN`)과 «다른 축»이다 — 섞지 않는다.**
//   그 자는 「쓸 «계정»이 남았나」(쿼터)를 보고, 이 자는 「그 «제공자»가 지금 살아 있나」(가용성)를 본다.
//   📏 실측이 그 분리를 뒷받침한다: 폴백 판정 전수 493 중 `action=grok` ***0건*** —
//     쿼터 축은 과부하에 «반응하지 않는다».
import { resolveModelAlias } from '../intelligence-map/model-alias.js';
import type { LLMProvider } from '../llm.js';

export type ReviewFailureReason =
  | 'overloaded'
  | 'rate-limited'
  | 'server-error'
  | 'timeout'
  | 'model-provider-mismatch'
  | 'unknown-model-provider'
  | 'other';

export type ReviewFallbackReason = Extract<ReviewFailureReason, 'overloaded' | 'rate-limited' | 'server-error' | 'timeout'>;

/** 실패 사유는 집계 가능한 유한 값으로 남긴다. */
export function classifyReviewProviderFailure(message: string): ReviewFailureReason {
  const m = message.toLowerCase();
  // ⭐ 실물 문면을 먼저 둔다 — `#10069` 가 낸 그 문장이다.
  if (m.includes('overloaded') || m.includes('server_overloaded')) return 'overloaded';
  if (m.includes('rate limit') || m.includes('rate_limit') || m.includes('429')) return 'rate-limited';
  if (/\b5\d\d\b/.test(m) || m.includes('internal server error') || m.includes('bad gateway')) return 'server-error';
  if (m.includes('timed out') || m.includes('timeout') || m.includes('etimedout')) return 'timeout';
  if (m.includes('model is not supported') || m.includes('model') && m.includes('provider')) return 'model-provider-mismatch';
  return 'other';
}

function isReviewFallbackReason(reason: ReviewFailureReason): reason is ReviewFallbackReason {
  return reason === 'overloaded' || reason === 'rate-limited' || reason === 'server-error' || reason === 'timeout';
}

export interface ReviewProviderAttempt {
  /** 이 시도가 쓸 모델. */
  readonly model: string;
  /** 이 모델을 호스팅하는 제공자. `undefined`면 시도를 호출하지 않는다. */
  readonly provider?: LLMProvider;
  /** 관측·산출에 쓰는 라벨(모델 이름이 길어 사람이 못 읽는 것을 막는다). */
  readonly label: string;
}

/**
 * ⛔⭐⭐⭐ **시도 순서는 «순수»하게 정한다** — 실제 호출은 호출자가 한다(테스트 가능성).
 *
 * ⭐ 기본 순서의 근거:
 *   ① 기본 리뷰 모델(현재 codex 계열) — 종전 동작을 «그대로» 유지한다
 *   ② `grok`  — 별도 구독/과금 경로라 codex 과부하와 «상관이 낮다»
 *   ③ `claude` — 세 번째 독립 제공자
 * ⛔ 같은 제공자로 «재시도만» 하지 않는다 — 과부하는 재시도로 안 풀린다(그래서 폴백이다).
 * ⛔ 목록을 여기 «박지 않는다» — 호출자가 config 로 준다. 이 함수는 «순서와 중복 제거»만 한다.
 */
export function buildReviewProviderAttempts(
  primary: ReviewProviderAttempt,
  fallbacks: readonly ReviewProviderAttempt[],
): ReviewProviderAttempt[] {
  const out: ReviewProviderAttempt[] = [primary];
  const seen = new Set([primary.model]);
  for (const f of fallbacks) {
    if (!f.model.trim() || seen.has(f.model) || (primary.provider && f.provider?.name === primary.provider.name)) continue;
    seen.add(f.model);
    out.push(f);
  }
  return out;
}

/** A distinct provider is available even when the optional config list is empty. */
export function defaultReviewFallbackModel(primaryProvider?: string): string {
  return resolveModelAlias(primaryProvider === 'grok' ? 'claude' : 'grok')!;
}

export interface ReviewFallbackObservation {
  readonly attempt: number;
  readonly total: number;
  readonly label: string;
  readonly model: string;
  /** 호출자에서 건네받은 프로바이더. 기존 소비자 호환을 위해 뜻을 유지한다. */
  readonly provider?: string;
  /** 스트리밍 호환성 해석 뒤 실제 호출에 사용한 프로바이더. 알 수 없으면 생략한다. */
  readonly resolvedProvider?: string;
  /** 직전 시도가 «왜» 넘어갔나. 첫 시도면 `undefined`. */
  readonly afterReason?: ReviewFailureReason;
  /** 실패 원문. 집계 키는 `afterReason`이며 이 값은 진단용이다. */
  readonly errorMessage?: string;
}

/**
 * ⛔⭐ 시도들을 순서대로 돌며 «폴백 가능한 실패»에만 다음으로 넘어간다.
 *
 * ⛔ 다음 넷을 «지키는» 것이 이 함수의 계약이다:
 *   ① 첫 시도가 성공하면 ***종전과 완전히 동일***하다(관측 한 줄만 는다)
 *   ② 폴백 «불가능한» 오류(예: 프롬프트 오류)는 ***즉시 던진다*** — 조용히 다른 모델로 새지 않는다
 *   ③ 마지막 시도까지 실패하면 ***마지막 오류를 던진다***(첫 오류로 덮지 않는다 — 진단이 사라진다)
 *   ④ 모든 전이가 «관측»된다 — 「왜 다른 모델이 리뷰했나」를 나중에 셀 수 있어야 한다
 */
export async function runReviewWithFallback(
  attempts: readonly ReviewProviderAttempt[],
  call: (attempt: ReviewProviderAttempt, observeResolvedProvider: (provider?: string) => void) => Promise<string>,
  observe: (event: 'attempt' | 'resolved' | 'fallback' | 'exhausted', data: ReviewFallbackObservation) => void = () => {},
): Promise<{ text: string; used: ReviewProviderAttempt; attemptIndex: number }> {
  if (attempts.length === 0) throw new Error('review fallback: no attempts configured');
  let lastError: unknown;
  let lastReason: ReviewFailureReason | undefined;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]!;
    const base: ReviewFallbackObservation = {
      attempt: i + 1, total: attempts.length, label: attempt.label, model: attempt.model,
      ...(attempt.provider ? { provider: attempt.provider.name } : {}),
      ...(lastReason ? { afterReason: lastReason } : {}),
    };
    try { observe('attempt', base); } catch { /* fail-soft */ }
    if (!attempt.provider) {
      const reason: ReviewFailureReason = 'unknown-model-provider';
      lastReason = reason;
      const errorMessage = `review fallback: unable to infer provider for model ${attempt.model}`;
      const isLast = i === attempts.length - 1;
      try { observe(isLast ? 'exhausted' : 'fallback', { ...base, afterReason: reason, errorMessage }); } catch { /* fail-soft */ }
      continue;
    }
    let resolvedProvider: string | undefined;
    try {
      const text = await call(attempt, (provider) => { resolvedProvider = provider; });
      if (resolvedProvider) {
        try { observe('resolved', { ...base, resolvedProvider }); } catch { /* fail-soft */ }
      }
      return { text, used: attempt, attemptIndex: i };
    } catch (error) {
      lastError = error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const reason = classifyReviewProviderFailure(errorMessage);
      const resolved = resolvedProvider ? { resolvedProvider } : {};
      // ⛔ 제공자 가용성 오류만 다음 시도로 넘긴다. 다른 실패도 유한 사유·원문을 남긴다.
      if (!isReviewFallbackReason(reason)) {
        try { observe('exhausted', { ...base, ...resolved, afterReason: reason, errorMessage }); } catch { /* fail-soft */ }
        throw error;
      }
      lastReason = reason;
      const isLast = i === attempts.length - 1;
      try { observe(isLast ? 'exhausted' : 'fallback', { ...base, ...resolved, afterReason: reason, errorMessage }); } catch { /* fail-soft */ }
    }
  }
  if (lastError) throw lastError;
  throw new Error('review fallback: no attempts with an inferred provider');
}


/**
 * ⛔⭐ **config 에서 폴백 모델 목록을 읽는다** — ⛔ 코드에 «박지 않는다».
 *
 * 📌 노브 = `llm.reviewFallbackModels` (문자열 배열 · 기본 «빈 목록»).
 * ⭐ 기본이 빈 목록인 것이 «의도»다 — 이 착지는 ***기전만 세우고 동작을 안 바꾼다***.
 *   대표 가 모델 이름을 정해 넣는 순간 켜진다(2026-08-19 지시: *"grok review 나 claude review"*).
 * ⛔ 읽기 실패는 «막지» 않는다 — 못 읽으면 폴백 없이 종전대로 돈다(fail-soft).
 */
export function reviewFallbackModelsFromConfig(
  readConfig: () => { llm?: { reviewFallbackModels?: unknown } } = () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('../user-config.js') as typeof import('../user-config.js');
    return m.getUserConfig() as { llm?: { reviewFallbackModels?: unknown } };
  },
): string[] {
  try {
    const raw = readConfig().llm?.reviewFallbackModels;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => resolveModelAlias(v.trim())!);
  } catch {
    return [];
  }
}
