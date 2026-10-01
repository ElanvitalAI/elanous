// ⛔⭐⭐ **codex 가 소진되면 «체인의 다음 칸»으로 간다** (대표 결정 2026-08-13).
//
// 왜 이것이 있나 — `codex-account-rotation.ts` 는 「다른 codex 계정」까지만 답한다.
// `no-candidate`(찼는데 갈 곳이 없다)를 내면 거기서 끝이고, 런은 죽는다. 대표 이 그 다음
// 칸을 물었다: *"multi codex 로 넘어갈지, grok 으로 넘어갈지 로직을 개발"*.
//
// ⭐ **모양은 「순서 리스트」다**(대표 선택). 단일 스위치가 아니라 배열이라
//   나중에 claude/gemini 를 끼워도 «코드 변경이 0»이다.
//
// ⛔⭐ **이 파일은 `codex-account-rotation.ts` 의 규율을 그대로 잇는다**:
//   ① 판정은 «순수» — 스토어·전역을 안 읽는다. 「무엇을 보고 정했나」가 인자에 다 있다.
//   ② 사람이 «명시»했으면 안 바꾼다 — 의도가 이긴다.
//   ③ ***「모른다」로는 전환하지 않는다*** — 신호가 확정일 때만 움직인다.
//   ④ 후보 선택은 «결정론» — 같은 입력이면 같은 답.
//
// ⭐⭐ **grok 이 왜 안전한 다음 칸인가** — elanous 의 grok 경로는 «둘 다» 구독으로 나간다:
//   ACP 자식은 env 스크럽(`grokBackend.scrubEnv` ⊕ `GROK_DISABLE_API_KEY_AUTH=1`),
//   LLM 프로바이더는 `resolveGrokCredential()`(구독 1순위). ⇒ 소진을 피하려다 «다른
//   지갑을 여는» 일이 없다. (2026-08-13 실측 · RESEARCH-grok-oauth-… §7b)

import type { RotationCandidate } from './codex-account-rotation.js';

/** 체인에 놓을 수 있는 칸. ⛔ 모르는 이름은 «조용히 건너뛰지 않고» 거부한다(오타 방어). */
export const FALLBACK_STEPS = ['codex-rotate', 'grok'] as const;
export type FallbackStep = (typeof FALLBACK_STEPS)[number];

/** 기본 체인 — ⛔⭐ **2026-08-20 에 `grok` 이 «기본»으로 들어왔다**(대표 지시).
 *
 *  ⛔ 초판 주석은 *"지금 동작과 «같다» · 옵션을 안 켠 사용자는 무변경"* 이었다. 그 선택이
 *  «설정을 안 쥔 우주»에서 문제였다 — 운영 config 는 `['codex-rotate','grok']` 을 명시하는데,
 *  ***임시 격리 우주는 빈 config 디렉토리를 받아*** (`establishElanousTuiIsolation` 이
 *  `mkdtemp('elanous-drive-')` 아래에 «빈» `config/` 를 만든다) 이 기본값으로 떨어진다.
 *  ⇒ 그 우주에서 codex 가 `no-candidate` 를 내면 갈 곳이 없어 런이 «죽는다».
 *
 *  ⭐ `grok` 을 기본에 두어도 «지갑이 안 열린다» — 이 파일 머리말이 적은 대로 elanous 의 grok
 *  경로는 둘 다 구독으로 나가고, 자격이 없으면 `decideFallback` 이 `grok-unavailable` 로
 *  «머문다». 즉 기본에 두는 비용은 0 이고 얻는 것은 「죽지 않음」이다. */
export const DEFAULT_FALLBACK_CHAIN: readonly FallbackStep[] = ['codex-rotate', 'grok'];

export function isFallbackStep(value: unknown): value is FallbackStep {
  return typeof value === 'string' && (FALLBACK_STEPS as readonly string[]).includes(value);
}

/** config 의 `llm.fallbackChain` 을 읽어 «쓸 수 있는» 체인으로 만든다.
 *
 *  ⛔ 모르는 이름은 «버리되 조용히는 아니다» — 호출자가 `dropped` 를 관측에 남긴다.
 *  ⛔ 비었거나 전부 무효면 기본 체인으로 — 「설정이 있다」와 「설정이 유효하다」는 다르다. */
export function normalizeFallbackChain(
  value: unknown,
): { chain: readonly FallbackStep[]; dropped: readonly string[]; usedDefault: boolean } {
  if (!Array.isArray(value)) {
    return { chain: DEFAULT_FALLBACK_CHAIN, dropped: [], usedDefault: true };
  }
  const chain: FallbackStep[] = [];
  const dropped: string[] = [];
  for (const raw of value) {
    if (isFallbackStep(raw)) {
      if (!chain.includes(raw)) chain.push(raw);   // 중복은 무의미 — 결정론 유지
    } else {
      dropped.push(String(raw));
    }
  }
  if (chain.length === 0) {
    return { chain: DEFAULT_FALLBACK_CHAIN, dropped, usedDefault: true };
  }
  return { chain, dropped, usedDefault: false };
}

/** 회전 판정이 낸 이유 — `codex-account-rotation.ts` 의 `RotationReason` 과 같은 어휘.
 *  ⛔ 그쪽 타입이 비공개라 구조적으로 받는다(그 파일의 리뷰 규율: dead export 금지). */
export type RotationOutcome =
  | { readonly reason: 'rotated' | 'reset-credit-unknown' | 'credit-pace'; readonly to: RotationCandidate }
  | { readonly reason: 'explicit' | 'disabled' | 'not-reached' | 'credit-pace' | 'reset-credit-available' | 'no-candidate' };

export type FallbackDecision =
  /** codex 계정을 갈아탄다(종전 동작). */
  | { readonly action: 'codex-rotate'; readonly to: RotationCandidate }
  /** 백엔드를 통째로 바꾼다. 지금은 grok 뿐. */
  | { readonly action: 'switch-backend'; readonly backend: 'grok' }
  /** 아무것도 안 한다 — 이유를 «값으로» 남긴다. */
  | { readonly action: 'stay'; readonly why: StayReason };

export type StayReason =
  /** 사람이 계정을 명시했다 — 의도가 이긴다. */
  | 'explicit'
  /** 회전이 config 로 꺼져 있고 체인에 다른 칸도 없다. */
  | 'disabled'
  /** 지금 계정이 「찼다」가 아니다(안 찼거나 «모른다»). */
  | 'not-reached'
  /** 리셋권이 있는데 호출자가 머무름을 «켠» 경우 — 기본은 체인을 탄다. */
  | 'reset-credit-available'
  /** 체인을 끝까지 갔는데 갈 곳이 없다. */
  | 'chain-exhausted'
  /** 쓸 계정이 하나도 없다 — 체인을 다 써 본 것과 «다른 사실». */
  | 'no-candidate'
  /** 다음 칸이 grok 인데 grok 자격이 «없다». */
  | 'grok-unavailable'
  /** grok 자격은 있는데 «잔량이 소진»됐다 — 자격 부재와 «다른 값»이다. */
  | 'grok-exhausted';

type FallbackRunPosition =
  | { readonly currentCredentialRateLimited?: false; readonly currentStep?: FallbackStep }
  | { readonly currentCredentialRateLimited: true; readonly currentStep: FallbackStep };

export type FallbackInput = {
  /** codex 회전 판정 결과(그대로 받는다). */
  readonly rotation: RotationOutcome;
  /** 정규화된 체인. `normalizeFallbackChain()` 산출. */
  readonly chain: readonly FallbackStep[];
  /** grok 자격이 «있나». ⛔ 「모른다」를 boolean 에 접지 마라 — 호출자가
   *  `resolveGrokCredential() !== null` 로 확정해서 준다. */
  readonly grokAvailable: boolean;
  /**
   * grok 이 «지금 쓸 수 있나» — ⛔ 자격(`grokAvailable`)과 «다른 축»이다.
   *   'usable'    쓸 수 있다(잔량 있음 · 무제한 · 임계 미만)
   *   'exhausted' 잔량이 소진됐다
   *   'unknown'   ***못 읽었다*** — ⛔ 「소진」으로 접지 «않는다». 생략도 같다.
   * ⭐ 왜 unknown 이 통과인가: 못 읽었다고 폴백을 막으면 codex 가 100% 인 상황에서
   *   «갈 곳이 사라진다». 그 위험이 「모르는 채로 한 번 가 보는」 것보다 크다.
   *   (⇒ 그리고 그 사실은 관측에 값으로 남는다 — 「모르고 갔다」를 셀 수 있다.)
   */
  readonly grokQuota?: 'usable' | 'exhausted' | 'unknown';
  /**
   * `reset-credit-available` 에서 체인을 타지 않고 머문다.
   * 기본(생략·false)은 `no-candidate` 와 같이 `codex-rotate` 다음 칸을 찾는다.
   * 켜면 종전 `{ action: 'stay', why: 'reset-credit-available' }`.
   * ⛔ 이 함수는 config 를 읽지 않는다 — 호출자가 이 칸을 준다.
   */
  readonly stayOnResetCreditAvailable?: boolean;
} & FallbackRunPosition;

/**
 * ⭐ 체인 판정 — 순수. 「무엇을 보고 정했나」가 인자에 다 있다.
 *
 * 규칙:
 *   ⑴ `explicit`  → 사람 의도가 이긴다. 체인을 «타지 않는다».
 *   ⑵ `not-reached` → 아직 소진이 아니다(「모른다」 포함). 움직이지 않는다.
 *   ⑶ `rotated`/`reset-credit-unknown` → 회전이 이미 답을 냈다. 체인의 첫 칸이 `codex-rotate` 면 그것을 쓴다.
 *   ⑷ `reset-credit-available` → 기본은 `no-candidate` 와 같이 체인의 다음 칸을 찾는다.
 *      리셋권은 사람만 쓸 수 있다(`redeem --yes`). `stayOnResetCreditAvailable` 을 켠 때만
 *      종전 `{ action: 'stay', why: 'reset-credit-available' }` 를 낸다.
 *   ⑸ `no-candidate`/`disabled` → 체인에서 `codex-rotate` «다음» 칸을 찾는다.
 *
 * ⛔ ⑸ 에서 `disabled` 도 체인을 타는 이유: 회전을 껐다고 «grok 도 싫다»는 뜻은 아니다.
 *   회전을 끄고 grok 만 쓰려는 구성(`fallbackChain: ['grok']`)이 자연스럽다.
 *   ⇒ 다만 체인에 grok 이 «없으면» `disabled` 로 남는다(무변경 보장).
 */
export function decideFallback(input: FallbackInput): FallbackDecision {
  const {
    rotation, chain, currentStep, currentCredentialRateLimited = false,
    grokAvailable, grokQuota = 'unknown', stayOnResetCreditAvailable = false,
  } = input;

  if (currentCredentialRateLimited) {
    if (currentStep === undefined) return { action: 'stay', why: 'chain-exhausted' };
    return stepAfter(chain, currentStep, grokAvailable, grokQuota, 'chain-exhausted');
  }
  if (rotation.reason === 'explicit') return { action: 'stay', why: 'explicit' };
  if (rotation.reason === 'not-reached' || (rotation.reason === 'credit-pace' && !('to' in rotation))) {
    return { action: 'stay', why: 'not-reached' };
  }
  if (rotation.reason === 'reset-credit-available' && stayOnResetCreditAvailable) {
    return { action: 'stay', why: 'reset-credit-available' };
  }

  if (rotation.reason === 'rotated' || rotation.reason === 'reset-credit-unknown' || (rotation.reason === 'credit-pace' && 'to' in rotation)) {
    // 회전이 답을 냈는데 체인이 codex-rotate 를 «빼» 놨다면 그 뜻을 존중하고
    // 다음 칸으로 간다(회전을 원치 않는 구성).
    if (chain.includes('codex-rotate')) return { action: 'codex-rotate', to: rotation.to };
    return stepAfterCodex(chain, grokAvailable, grokQuota, 'chain-exhausted');
  }

  // no-candidate | disabled | reset-credit-available(기본) — codex 축이 끝났다. 다음 칸을 본다.
  // ⛔ 다음 칸이 «없을 때»의 이름만 고른다. 진행(stepAfterCodex)은 그대로다.
  const fallbackWhy = stayReasonWhenCodexAxisEnds(rotation.reason === 'credit-pace' ? 'no-candidate' : rotation.reason);
  return stepAfterCodex(chain, grokAvailable, grokQuota, fallbackWhy);
}

/** codex 축이 끝났는데 체인 다음 칸도 없을 때 머무는 이유.
 *  'no-candidate'(쓸 계정 없음)를 'chain-exhausted'(체인을 다 써 봄)로 접지 않는다.
 *  'chain-exhausted' 는 체인을 «실제로» 소진한 끝(reset-credit-available 기본 포함)에만 쓴다. */
export function stayReasonWhenCodexAxisEnds(
  reason: 'no-candidate' | 'disabled' | 'reset-credit-available',
): StayReason {
  if (reason === 'disabled') return 'disabled';
  if (reason === 'no-candidate') return 'no-candidate';
  return 'chain-exhausted';
}

function stepAfterCodex(
  chain: readonly FallbackStep[],
  grokAvailable: boolean,
  grokQuota: 'usable' | 'exhausted' | 'unknown',
  whyIfNone: StayReason,
): FallbackDecision {
  return stepAfter(chain, 'codex-rotate', grokAvailable, grokQuota, whyIfNone);
}

function stepAfter(
  chain: readonly FallbackStep[],
  currentStep: FallbackStep | undefined,
  grokAvailable: boolean,
  grokQuota: 'usable' | 'exhausted' | 'unknown',
  whyIfNone: StayReason,
): FallbackDecision {
  const idx = currentStep === undefined ? -1 : chain.indexOf(currentStep);
  const rest = idx === -1 ? chain : chain.slice(idx + 1);
  for (const step of rest) {
    if (step === 'grok') {
      // ⛔ 자격 «먼저» — 자격이 없으면 잔량을 물을 것도 없다(그리고 두 사유는 다른 값이다).
      if (!grokAvailable) return { action: 'stay', why: 'grok-unavailable' };
      // ⛔ 「모른다」는 통과시킨다 — 못 읽었다고 갈 곳을 없애지 않는다(위 계약 주석).
      if (grokQuota === 'exhausted') return { action: 'stay', why: 'grok-exhausted' };
      return { action: 'switch-backend', backend: 'grok' };
    }
  }
  return { action: 'stay', why: whyIfNone };
}

/** 사람이 읽는 한 줄 — 관측·CLI 표면용. ⛔ 토큰·계정 홈은 넣지 않는다. */
export function describeFallback(decision: FallbackDecision): string {
  switch (decision.action) {
    case 'codex-rotate':
      return `codex 계정 전환 → ${decision.to.name}`;
    case 'switch-backend':
      return `백엔드 전환 → ${decision.backend} (구독)`;
    case 'stay':
      return `전환 없음 (${decision.why})`;
  }
}

/**
 * grok 크레딧 축 산출 → 폴백 판정이 쓰는 세 값으로 접는다.
 *
 * ⛔ 「모른다」를 「소진」으로 접지 않는다 — 필드가 전부 `| null` 이라 «못 읽음»이 흔하고,
 *   그것으로 폴백을 막으면 codex 가 100% 일 때 갈 곳이 사라진다.
 * ⛔ 그리고 이 함수는 «네트워크를 치지 않는다» — 이미 읽어 온 값을 받는다(호출자가 재는 자를 고른다).
 */
export function grokQuotaFromCreditAxis(axis: {
  readonly unlimited?: boolean | null;
  readonly hasCredits?: boolean | null;
  readonly usedPercent?: number | null;
} | null | undefined, exhaustedAtPercent = 100): 'usable' | 'exhausted' | 'unknown' {
  if (!axis) return 'unknown';
  if (axis.unlimited === true) return 'usable';
  // ⛔⭐ `usedPercent` 가 `hasCredits` 보다 «앞»이다 — 2026-08-19 실측으로 뒤집었다.
  //   grok 의 hasCredits 는 `prepaidBalance > 0`(=«선불 잔액»)이라
  //   ***구독 사용자는 선불 0 이 «정상»***이다. 그것을 「소진」으로 읽으면
  //   구독이 90% 남았는데 폴백을 막는다(실측: usedPercent=10 · prepaidBalance=0 · hasCredits=false).
  const used = axis.usedPercent;
  if (typeof used === 'number' && Number.isFinite(used)) {
    return used >= exhaustedAtPercent ? 'exhausted' : 'usable';
  }
  // 사용률을 못 읽었을 때만 선불 잔액을 본다 — 그때는 그것이 유일한 재료다.
  if (axis.hasCredits === true) return 'usable';
  if (axis.hasCredits === false) return 'exhausted';
  return 'unknown';
}

/**
 * budget 스냅샷 → 폴백 판정이 쓰는 세 값.
 *
 * ⭐ 공급자가 「리밋이 찼다」고 «말한» 것을 우리 산술보다 «먼저» 본다
 *   (`UsageSnapshot.rateLimitReached` 주석의 그 권위를 그대로 따른다).
 * ⛔ 스냅샷이 없거나 판단할 재료가 없으면 `'unknown'` 이다 — 「소진」으로 접지 «않는다».
 * ⛔ 이 함수는 «네트워크를 안 친다» — 이미 채워진 캐시를 받는다.
 */
export function grokQuotaFromUsageSnapshot(snapshot: {
  readonly rateLimitReached?: string;
  readonly credits?: { readonly hasCredits?: boolean; readonly unlimited?: boolean };
} | null | undefined): 'usable' | 'exhausted' | 'unknown' {
  if (!snapshot) return 'unknown';
  // ⛔ 공급자 판정이 이긴다 — 우리가 used >= limit 로 추론하지 않는다.
  if (typeof snapshot.rateLimitReached === 'string' && snapshot.rateLimitReached.length > 0) return 'exhausted';
  const credits = snapshot.credits;
  if (!credits) return 'unknown';
  if (credits.unlimited === true) return 'usable';
  // ⛔⭐ `hasCredits` 는 브랜드마다 «다른 것»을 뜻할 수 있다 — grok 은 「선불 잔액이 있나」다.
  //   ⇒ 사용률 창(rateLimitReached)이 이미 위에서 판정을 냈고, 여기 오면 그 신호가 «없다».
  //   그러면 hasCredits=false 하나로 「소진」을 단정하지 «않는다» — 「모른다」가 정직하다.
  if (credits.hasCredits === true) return 'usable';
  return 'unknown';
}
