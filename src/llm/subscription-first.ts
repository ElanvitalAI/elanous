// 「구독이 있으면 «항상» 구독을 쓴다」 — provider 별 구독 존재 판정 ⊕ 과금 env 차단의 단일 자리.
//
// ⛔ 왜 이 모듈이 있나 (대표 2026-08-18 지시 · RFC-role-scoped-llm-selection-2026-08-18):
//   ⓐ 강제가 «OpenAI 전용 하드코딩 세 곳»뿐이었다(`delete process.env.OPENAI_API_KEY`) —
//      anthropic·grok·gemini 는 구독이 있어도 API 키가 있으면 «API 로 나갔다».
//   ⓑ 107차에 codex 유료 크레딧이 실제로 소모됐고, 110차엔 `--acp-backend grok` 이 조용히
//      API 로 갔다. 둘 다 「어느 과금 경로로 갔나」가 관측에 «없어서» 늦게 알았다.
//   ⇒ 그래서 이 모듈의 계약은 둘이다: ***한 자리에서 판정하고, 무엇을 왜 지웠는지 반드시 남긴다.***
//
// ⚠️ 한계(정직하게): 여기서 말할 수 있는 것은 ***「API 키 경로를 «막았다»」***까지다.
//   토큰이 만료됐는지, 실제 청구가 얼마인지는 이 축이 «안 잰다». 그 판정은 호출이 실패해야 나온다.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LLMProviderName } from '../user-config/types.js';

/** 구독이 어디서 확인됐나 — ⛔ 값 옆에 «출처»를 둔다. */
export type SubscriptionSource = 'elanous-auth-store' | 'provider-home' | 'none';

/** 토큰 만료를 「곧」으로 볼 여유 — 이 안에 만료하면 「쓸 수 있는 구독」으로 «안» 센다.
 *  ⛔ 여기서 관대하면 「구독 있음」으로 API 키를 지운 뒤 그 구독이 죽어 «되던 것이 안 된다». */
const EXPIRY_BUFFER_MS = 60_000;

export interface SubscriptionCheck {
  provider: LLMProviderName;
  /** ⛔ 「자격이 있다」가 아니라 ***「지금 쓸 수 있다」***다 — 만료(임박)면 false. */
  hasSubscription: boolean;
  source: SubscriptionSource;
  /** 자격은 찾았는데 만료(임박)라 «못 쓰는» 경우 true — 「없다」와 구분해 관측에 남긴다. */
  expired?: boolean;
  /** 만료를 «판정할 수 있었나». provider 홈 파일은 형식을 모르므로 false(= 안 쟀다). */
  expiryChecked: boolean;
  /** 구독을 강제하려면 지워야 할 과금 경로 env(키·대체 토큰·프로바이더 스위치). */
  billingEnv: readonly string[];
  /** 구독을 확인한 실제 경로(있을 때만) — 사람이 「어디를 봤나」를 알 수 있게. */
  checkedPath?: string;
}

/** provider 마다 ⑴elanous auth store 키 ⑵provider 자체 홈 파일 ⑶지울 과금 env.
 *  ⛔ 과금 env 목록은 `src/agent-mission/driver.ts` 의 backend scrubEnv 와 «같은 지식»이다 —
 *  거기는 자식 PTY 용이고 여기는 부모 LLM 용이라 자리가 다르지만, 값이 갈리면 사고가 난다.
 *  둘 중 하나를 고치면 다른 하나도 본다. */
interface ProviderSubscriptionSpec {
  authStoreKey?: string;
  homeFile?: readonly string[];
  billingEnv: readonly string[];
}

const SUBSCRIPTION_SPECS: Partial<Record<LLMProviderName, ProviderSubscriptionSpec>> = {
  'openai-codex': {
    authStoreKey: 'openai-codex',
    homeFile: ['.codex', 'auth.json'],
    billingEnv: ['OPENAI_API_KEY'],
  },
  anthropic: {
    authStoreKey: 'anthropic',
    billingEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
  },
  grok: {
    authStoreKey: 'grok',
    homeFile: ['.grok', 'auth.json'],
    billingEnv: ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY'],
  },
  gemini: {
    authStoreKey: 'gemini',
    billingEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS'],
  },
};

export interface SubscriptionDeps {
  /** elanous auth store 조회 — 기본은 `src/oauth/store.ts` 의 loadTokens. */
  loadTokens?: (provider: string) => unknown | null;
  fileExists?: (path: string) => boolean;
  home?: () => string;
}

/** elanous auth store 상태의 만료 판정 — `isExpiringSoon` 재사용(재발명 0).
 *  ⛔ 모양이 아니면 「만료로 단정하지 않는다」 — 모른다를 「죽었다」로 읽는 것도 오판이다. */
function isTokenExpiring(state: unknown): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isExpiringSoon } = require('../oauth/store.js') as typeof import('../oauth/store.js');
    const s = state as { tokens?: { expiresAt?: number | null } };
    if (!s || typeof s !== 'object' || !s.tokens) return false;
    return isExpiringSoon(state as Parameters<typeof isExpiringSoon>[0], EXPIRY_BUFFER_MS);
  } catch { return false; }
}

function defaultLoadTokens(provider: string): unknown | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadTokens, authStorePath } = require('../oauth/store.js') as typeof import('../oauth/store.js');
    const { codexAccountReadStorePath } = require('../oauth/codex-owner-mirror.js') as typeof import('../oauth/codex-owner-mirror.js');
    return loadTokens(provider, codexAccountReadStorePath(authStorePath()));
  } catch { return null; }
}

/** ★ 이 provider 에 구독이 있나 — ⛔ 「없다」를 «확인 없이» 말하지 않는다(두 자리를 다 본다). */
export function inspectSubscription(provider: LLMProviderName, deps: SubscriptionDeps = {}): SubscriptionCheck {
  const spec = SUBSCRIPTION_SPECS[provider];
  if (!spec) return { provider, hasSubscription: false, expiryChecked: false, source: 'none', billingEnv: [] };
  const loadTokens = deps.loadTokens ?? defaultLoadTokens;
  const fileExists = deps.fileExists ?? existsSync;
  const home = deps.home ?? homedir;

  const state = spec.authStoreKey ? loadTokens(spec.authStoreKey) : null;
  if (state) {
    // ⭐ 자격이 «있다»와 «지금 쓸 수 있다»를 가른다 — 만료된 토큰으로 API 키를 지우면
    //   구독도 API 도 못 쓰는 상태가 된다(되던 것이 안 되는 방향의 실패).
    const expired = isTokenExpiring(state);
    return expired
      ? { provider, hasSubscription: false, expired: true, expiryChecked: true, source: 'elanous-auth-store', billingEnv: spec.billingEnv }
      : { provider, hasSubscription: true, expiryChecked: true, source: 'elanous-auth-store', billingEnv: spec.billingEnv };
  }
  if (spec.homeFile) {
    const path = join(home(), ...spec.homeFile);
    if (fileExists(path)) {
      // ⛔ provider 자체 홈 파일은 «형식을 모른다» — 만료를 «안 쟀다»고 적는다(모른다를 「유효」로 읽지 않게).
      return { provider, hasSubscription: true, expiryChecked: false, source: 'provider-home', billingEnv: spec.billingEnv, checkedPath: path };
    }
  }
  return { provider, hasSubscription: false, expiryChecked: false, source: 'none', billingEnv: spec.billingEnv };
}

export interface SubscriptionEnforcement {
  provider: LLMProviderName;
  enforced: boolean;
  /** 실제로 «있어서 지운» 키만 — ⛔ 「지우기로 한 목록」이 아니다(110차 scrubbed 오독의 처방). */
  removed: readonly string[];
  /** 구독은 있는데 지울 것이 없었을 때도 enforced=true 다 — 그 구분을 위해 둔다. */
  present: readonly string[];
  source: SubscriptionSource;
  reason: 'subscription-present' | 'no-subscription' | 'subscription-expired' | 'disabled' | 'unknown-provider';
  /** 만료를 «판정할 수 있었나» — false 면 「유효하다」가 아니라 「안 쟀다」다. */
  expiryChecked: boolean;
}

/** ★ 구독이 있으면 과금 env 를 «지워» 구독 경로로 좁힌다.
 *  ⛔ 반환값의 `removed` 는 ***실제로 존재해서 지운 것***만 담는다 — 목록을 그대로 찍으면
 *  「지웠다」와 「지우기로 했다」가 구분되지 않는다(110차에 그것으로 오독했다). */
export function enforceSubscriptionFirst(
  provider: LLMProviderName,
  env: NodeJS.ProcessEnv = process.env,
  deps: SubscriptionDeps & { enabled?: boolean } = {},
): SubscriptionEnforcement {
  if (deps.enabled === false) {
    return { provider, enforced: false, removed: [], present: [], source: 'none', reason: 'disabled', expiryChecked: false };
  }
  const check = inspectSubscription(provider, deps);
  if (!SUBSCRIPTION_SPECS[provider]) {
    return { provider, enforced: false, removed: [], present: [], source: 'none', reason: 'unknown-provider', expiryChecked: false };
  }
  const present = check.billingEnv.filter((k) => typeof env[k] === 'string' && env[k] !== '');
  if (!check.hasSubscription) {
    // ⛔ 「자격이 아예 없다」와 「있는데 만료됐다」를 «다른 이유»로 남긴다 — 처방이 다르다(로그인 vs 갱신).
    return {
      provider, enforced: false, removed: [], present, source: check.source,
      reason: check.expired ? 'subscription-expired' : 'no-subscription',
      expiryChecked: check.expiryChecked,
    };
  }
  // ⛔ 「지우기로 했다」와 「지워졌다」를 «다른 값»으로 둔다 — 이 모듈이 세운 원칙을 자기 자신에게도 적용한다.
  //   지운 «뒤» 실제로 사라진 키만 removed 에 담으므로, 삭제가 실패하면(비-configurable 등)
  //   removed.length < present.length 로 드러난다. 예전 판은 present 배열을 그대로 재사용해
  //   removedCount 와 billingEnvPresentCount 가 «항상 같은» 수였다(=관측 칸 하나가 무의미했다).
  //   ⛔ 그리고 `delete` 는 non-configurable 속성에서 «조용히 실패»가 아니라 **throw** 한다 —
  //   한 키가 던지면 나머지가 «안 지워진 채» 남는다(과금 방향의 실패). 그래서 키마다 격리한다.
  //   ⚠️ 이 갈래는 테스트가 Object.defineProperty 로 «조건을 만들어» 문다.
  for (const key of present) {
    try { delete env[key]; } catch { /* 이 키만 못 지웠다 — 아래 검증에서 removed 에 «안 들어간다» */ }
  }
  const removed = present.filter((k) => env[k] === undefined);
  return { provider, enforced: true, removed, present, source: check.source, reason: 'subscription-present', expiryChecked: check.expiryChecked };
}

/** 강제 결과를 관측에 싣는다 — ⛔ 과금 경로가 바뀌는 사건은 «항상» 남긴다. */
export function observeSubscriptionEnforcement(result: SubscriptionEnforcement, origin: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { debug } = require('../debug/log.js') as typeof import('../debug/log.js');
    debug.log('llm.subscription-first', result.enforced ? 'enforced' : 'skipped', {
      origin,
      provider: result.provider,
      reason: result.reason,
      source: result.source,
      removed: result.removed,
      removedCount: result.removed.length,
      billingEnvPresentCount: result.present.length,
      expiryChecked: result.expiryChecked,
    });
  } catch { /* fail-open — 관측 실패가 호출을 막지 않는다 */ }
}
