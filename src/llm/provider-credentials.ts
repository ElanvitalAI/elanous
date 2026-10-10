// ── provider ↔ credential SSOT (2026-07-26 · escalate 401 근본수리) ────────────
//
// **문제**: provider 를 바꾸는 경로(self-dev escalate·cross-family override)가 provider 만 바꾸고
// **키는 base config 것을 그대로** 들고 갔다. `user-config.ts` escalate 블록이 정확히 그 형태였다:
//
//     provider: normalizeProvider(env.ELANOUS_ESCALATE_PROVIDER || llm.provider),   // ✅ 전환
//     apiKey:   str(llm.apiKey),                                                  // ❌ 미전환
//
// 결과: escalate(tier=opus·anthropic)가 openai-codex 용 키를 들고 anthropic 에 붙어 **100% 401 즉사**
// (실측 2026-07-26: `provider: anthropic / claude-opus-4-8 · API key (config)` → 2초 뒤 401 · toolCalls 0).
//
// `llm.ts` 의 기존 key-family 가드는 진입 조건이 `if (model && !isModelCompatible(provider, model))` 이라
// **escalate 에 구조적으로 눈이 멀다** — escalate 는 provider↔model 이 정합(anthropic + claude-opus-4-8)
// 하므로 분기가 발동조차 안 한다. 그래서 "판정을 하나 더" 가 아니라 **provider 를 바꾸는 자리에서 키를
// 함께 해석**하는 것이 근본이다.
//
// **대표 결정(2026-07-26)**:
//   (a) 키 소스 우선순위 = **rotation(config) 우선 · env fallback** — 프로젝트 원칙 "env 말고 config화"
//       (새 노브는 user-config 우선·env 는 fallback)와 정합. 키 출처가 감사 가능해진다.
//   (b) 범위 = **전 provider 정합화 + SSOT 승격** — anthropic 국소 수리는 grok/gemini escalate 에서
//       같은 결함이 다른 이름으로 재발한다.
//
// ⚠️ **SSOT 는 "catalog 파생 + 명시 오버레이"다 (단순 치환 금지·실측 근거)**:
//   model-catalog 의 모델별 `envKey` 를 provider 로 접으면 대부분 맞지만 두 곳이 어긋난다 —
//     · `openai-codex` → catalog 파생값이 **null**(OAuth 구독이라 모델에 envKey 를 안 단다).
//       그러나 API 경로에서는 openai 와 **키 패밀리를 공유**하므로 OPENAI_API_KEY 가 맞다.
//     · `local`/`ollama` → 키 자체가 불필요(null 이 정답).
//   catalog 만으로 갈아끼웠다면 codex 경로가 조용히 깨졌다. 그래서 오버레이를 명시로 남긴다.

import { BUILTIN_CATALOG } from '../intelligence-map/model-catalog.js';
import { debug } from '../debug/log.js';

/** provider → API-key env var. catalog 이 envKey 를 안 다는 provider 의 명시 보정.
 *  ⚠️ catalog 파생이 이미 값을 주는 provider 는 **여기 적지 않는다** — 이중 진실을 만들지 않기 위해. */
const ENV_KEY_OVERLAY: Readonly<Record<string, string>> = {
  // OAuth 구독이라 catalog 모델엔 envKey 가 없지만, API 경로에선 openai 와 키 패밀리를 공유한다.
  'openai-codex': 'OPENAI_API_KEY',
  // 결정 2026-09-23 — openrouter 모델은 BUILTIN_CATALOG 가 아니라 발견 폴드(`catalog/providers/openrouter.yaml`
  //   apiKeyEnv)에서 온다 ⇒ 파생 맵이 비어 하니스 자식에게 키가 릴레이되지 않았다(env 로만 키를 둔 사용자는 자식이 죽는다).
  openrouter: 'OPENROUTER_API_KEY',
};

/** 키가 필요 없는 provider — 자격증명 부재가 **정상**이다(누락 경고를 내면 안 됨).
 *  ⚠️ `auto` 는 여기 없다(리뷰 must-fix 5R): `auto` 는 "키가 필요 없다"가 아니라 **"아직 어느 provider
 *  인지 정해지지 않았다"** 이다. production 은 미지정 provider 를 `normalizeProvider()` 로 `auto` 로
 *  만들므로, `auto` 를 keyless 로 분류하면 `undefined` 만 고쳐도 **실제 경로에서는 누락 경고가 계속
 *  억제된다**(4R 수정이 절반만 된 지점). 로컬 실행은 `local`/`ollama` 로 명시된다. */
// ⭐ BEDROCK-PROVIDER — `bedrock` 은 «API 키»가 아니라 AWS 기본 자격 체인(env·~/.aws·SSO·IMDS)으로 선다.
//   키 칸(rotation·env 키)이 비는 것이 정상이므로 누락 경고를 내지 않는다 — 실제 해석은 공급자가 호출 때 한다.
const KEYLESS_PROVIDERS: ReadonlySet<string> = new Set(['local', 'ollama', 'bedrock']);

/** catalog 에서 provider → envKey 를 접어 만든 파생 맵(모듈 1회). 카탈로그가 자라면 자동 반영된다.
 *  ⚠️ 캐시는 **불변** BUILTIN_CATALOG 기반이라 무효화 훅을 두지 않는다(리뷰 should-fix: 테스트 편의로
 *  production export 를 늘리지 않는다). */
let derivedEnvKeys: Map<string, string> | undefined;
function catalogEnvKeys(): Map<string, string> {
  if (derivedEnvKeys) return derivedEnvKeys;
  derivedEnvKeys = buildCatalogEnvKeys();
  return derivedEnvKeys;
}

/**
 * 순수 fold. ⚠️ **상충은 "첫 항목 승"이 아니라 해석 포기다** (리뷰 must-fix #5488 2R):
 * 같은 provider 의 모델들이 **서로 다른** envKey 를 선언하면 어느 모델을 먼저 넣느냐로 인증이 바뀐다.
 * 경고만 하고 첫 항목을 계속 쓰면 실질 가드가 아니므로, 그 provider 는 **env 해석 대상에서 뺀다**
 * (`providerEnvKey` → undefined). 그러면 모호한 키를 집는 대신 rotation/명시 경로만 남고, 키가
 * 없으면 `provider-key-missing` warn 이 401 전에 뜬다 = fail-safe.
 *
 * 부팅을 깨뜨리지 않는 이유: throw 하지 않는다. catalog 편집 실수가 전체 다운으로 번지면 안 되고,
 * "그 provider 만 env 폴백을 잃는" 축소가 정확히 필요한 만큼의 degrade 다.
 */
function buildCatalogEnvKeys(): Map<string, string> {
  // ⚠️ 부작용(관측)은 **여기 wrapper 에만** 둔다 — fold 는 순수해야 검증이 값싸다(리뷰 must-fix 4R).
  const { map, conflicts } = foldEnvKeys(BUILTIN_CATALOG.models);
  for (const c of conflicts) {
    try {
      debug.log('llm.credential', 'catalog-envkey-conflict',
        { provider: c.provider, a: `${c.a.model}=${c.a.envKey}`, b: `${c.b.model}=${c.b.envKey}`, effect: 'env 해석 제외' },
        { level: 'warn' });
    } catch { /* fail-soft */ }
  }
  return map;
}

/** 같은 provider 를 두 모델이 서로 다른 envKey 로 선언한 사실. */
interface EnvKeyConflict {
  provider: string;
  a: { model: string; envKey: string };
  b: { model: string; envKey: string };
}

/**
 * **순수** fold — 인자만 읽고 부작용이 없다(로깅조차 안 한다·리뷰 must-fix 4R). 상충은 반환값으로
 * 알리고, 로깅은 호출부(`buildCatalogEnvKeys`)가 한다.
 *
 * 모델 목록을 **인자로** 받는 이유: 상충 처리(해석 제외)를 catalog 실체와 무관하게 검증할 수 있어야
 * 하기 때문(3R: 상충 0 인 고정 catalog 만 보는 테스트는 first-wins 로 회귀해도 통과하는 Goodhart).
 */
function foldEnvKeys(
  models: readonly { provider: string; envKey?: string; id: string }[],
): { map: Map<string, string>; conflicts: EnvKeyConflict[] } {
  const first = new Map<string, { envKey: string; model: string }>();
  const conflicts: EnvKeyConflict[] = [];
  const conflicted = new Set<string>();
  for (const e of models) {
    if (!e.envKey) continue;
    const prev = first.get(e.provider);
    if (!prev) { first.set(e.provider, { envKey: e.envKey, model: e.id }); continue; }
    if (prev.envKey === e.envKey) continue;
    if (!conflicted.has(e.provider)) {
      conflicts.push({ provider: e.provider, a: { model: prev.model, envKey: prev.envKey }, b: { model: e.id, envKey: e.envKey } });
    }
    conflicted.add(e.provider);
  }
  const map = new Map<string, string>();
  for (const [provider, { envKey }] of first) {
    if (!conflicted.has(provider)) map.set(provider, envKey);
  }
  return { map, conflicts };
}

/**
 * provider 의 API-key env var 이름. **이 축의 SSOT** — `run-context.ts` 의 사설 PROVIDER_ENV_KEY 를
 * 대체한다(종전엔 catalog `envKey` 와 이중화돼 있었고, kimi/qwen/glm 은 한쪽에만 있었다).
 * 키가 필요 없는 provider(local/ollama)와 미지 provider 는 undefined.
 */
export function providerEnvKey(
  provider: string | undefined,
  /** 파생 소스 override — 상충 처리(해석 제외)를 **공개 동작으로** 검증하기 위한 seam.
   *  실 catalog 는 상충이 0 이라 그 분기를 실물로 만들 수 없다(리뷰 6R: 내부 fold 를 export 하지 말고
   *  공개 동작을 통해 검증할 것). 미지정=BUILTIN_CATALOG 파생(캐시). */
  models?: readonly { provider: string; envKey?: string; id: string }[],
): string | undefined {
  if (!provider || KEYLESS_PROVIDERS.has(provider)) return undefined;
  const derived = models ? foldEnvKeys(models).map : catalogEnvKeys();
  return ENV_KEY_OVERLAY[provider] ?? derived.get(provider);
}

/** 이 provider 가 자격증명 없이 도는 게 정상인가(local 등). 누락 관측을 억제할지 판단에 쓴다.
 *  ⚠️ `undefined`(= provider 미지정)는 **keyless 가 아니다**(리뷰 should-fix 4R) — "키가 필요 없다"와
 *  "무엇이 필요한지 모른다"는 다르고, 후자를 정상으로 취급하면 누락 경고가 조용히 억제된다. */
export function isKeylessProvider(provider: string | undefined): boolean {
  return !!provider && KEYLESS_PROVIDERS.has(provider);
}

/** 키가 어디서 왔나 — 관측·진단용(제1원칙: "왜 이 키인가"가 로그로 답해져야 한다). */
type CredentialSource = 'rotation' | 'env' | 'inherited' | 'none';

interface ResolvedCredential {
  /** 해석된 키. 없으면 undefined(호출자가 provider 기본 인증으로 폴백하거나 명시 실패). */
  apiKey?: string;
  source: CredentialSource;
  /** 해석에 쓴 env var 이름(관측용 · **값은 절대 싣지 않는다**). */
  envKey?: string;
  /** 목표 provider 의 엔드포인트. **키와 같은 규율** — provider 가 바뀌면 옛 baseUrl 은 틀린 주소다
   *  (리뷰 should-fix 10R: 새 키·provider 를 옛 엔드포인트로 보내면 401 과 같은 계열의 실패).
   *  rotation 엔트리에 있으면 그걸 쓰고, 없으면 undefined(= provider 기본 엔드포인트). */
  baseUrl?: string;
}

interface RotationLike {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
}

interface ResolveCredentialInput {
  /** 전환된 목표 provider. */
  provider: string | undefined;
  /** config `llm.rotation` — provider 별 키 풀(1순위). */
  rotation?: readonly RotationLike[] | undefined;
  /** base config 의 `llm.apiKey`. **provider 가 안 바뀐 경우에만** 유효한 상속값. */
  baseApiKey?: string | undefined;
  /** base config 의 `llm.provider` — 전환 여부 판정용. */
  baseProvider?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

/**
 * provider 에 맞는 자격증명 해석. **provider 를 바꾸는 모든 자리가 이걸 통과해야 한다.**
 *
 * 우선순위(대표 결정 (a)):
 *   ① `llm.rotation` 에서 같은 provider 엔트리의 apiKey (config·감사 가능)
 *   ② `providerEnvKey(provider)` 로 읽은 env
 *   ③ provider 가 **안 바뀐** 경우에 한해 base `llm.apiKey` 상속
 *   ④ 없음 — 호출자가 판단(구독/OAuth provider 는 이게 정상일 수 있다)
 *
 * ⚠️ ③ 이 마지막인 것이 이 수리의 핵심이다. 종전엔 ③ 이 **무조건 첫 번째**였고, 그래서 provider 가
 * 바뀌어도 옛 provider 의 키가 따라갔다(= 401 의 근본). provider 가 바뀌었으면 base 키는 **틀린 키**다.
 */
export function resolveProviderCredential(input: ResolveCredentialInput): ResolvedCredential {
  const { provider, rotation, baseApiKey, baseProvider } = input;
  const env = input.env ?? process.env;

  // 목표 provider 의 엔드포인트 — 키와 **같은 규율**로 rotation 에서만 가져온다(10R).
  //   전환이면 옛 baseUrl 은 틀린 주소이므로, rotation 에 명시가 없으면 undefined(provider 기본).
  // ⛔⭐ local 은 «런 단위 env»(`LOCAL_LLM_URL`)가 config rotation 을 이긴다 — `ELANOUS_LLM_PROVIDER` 가 config 를 이기는 것과 같은 규칙(BACKLOG B13).
  //   🩸 2026-09-25: 부모에 `LOCAL_LLM_URL=<node-b 경유>` 를 줬는데 rotation 의 `local → localhost:1234` 가 이겨 자식이 «호스트»
  //     LM Studio 로 갔다. Pod(config 없음)에선 안 드러났다.
  const envEndpoint = provider === 'local' ? env.LOCAL_LLM_URL?.trim() : undefined;
  const endpoint = envEndpoint || rotation?.find((r) => r.provider === provider && typeof r.baseUrl === 'string' && r.baseUrl.trim().length > 0)?.baseUrl?.trim();
  const withUrl = endpoint ? { baseUrl: endpoint } : {};

  // ① rotation(config) — 같은 provider 의 명시 키.
  const hit = rotation?.find((r) => r.provider === provider && typeof r.apiKey === 'string' && r.apiKey.trim().length > 0);
  if (hit?.apiKey) return { apiKey: hit.apiKey.trim(), source: 'rotation', ...withUrl };

  // ② env — provider 별 표준 env var.
  const envKey = providerEnvKey(provider);
  const fromEnv = envKey ? env[envKey]?.trim() : undefined;
  if (fromEnv) return { apiKey: fromEnv, source: 'env', ...(envKey ? { envKey } : {}), ...withUrl };

  // ③ 상속 — **provider 가 확실히 그대로일 때만.** 바뀌었으면 base 키는 다른 provider 것이라 틀렸다.
  //   ⚠️ 리뷰 must-fix(#5488 2R): 종전 판정은 `!switched` 였는데 `baseProvider` 가 없으면 switched=false
  //      가 되어 **전환 여부를 모르는데 상속**했다 = 401 재현. 상속은 `provider === baseProvider` 가
  //      **명시적으로 참**일 때만 허용한다(모르면 상속 안 함 = fail-closed).
  //   ⓘ 3R 리뷰 응답: 이 fail-closed 는 **helper 계약 수준의 방어**다. 실배선(`user-config.ts` escalate)은
  //      `normalizeProvider` 가 항상 값을 반환하므로(미지 입력 → 'auto') `baseProvider` 부재로 여기 오지
  //      않는다. base=escalate 로 같아 호출부가 early-return 하는 경우는 **전환이 없는 것**이라 base 키
  //      유지가 정답(무회귀)이며, 그래서 resolver 우회가 아니라 의도된 분기다.
  const sameProvider = !!provider && !!baseProvider && provider === baseProvider;
  if (sameProvider && baseApiKey && baseApiKey.trim().length > 0) {
    return { apiKey: baseApiKey.trim(), source: 'inherited' };
  }

  return { source: 'none', ...(envKey ? { envKey } : {}), ...withUrl };
}

/**
 * 해석 결과를 관측에 남긴다 — 제1원칙(관측 없으면 자기인지·힐링 불가). **키 값은 절대 싣지 않는다**(이름·출처만).
 * 키가 필요한 provider 인데 못 찾은 경우는 warn 으로 올려 401 이 나기 **전에** 보이게 한다.
 */
export function observeCredentialResolution(
  provider: string | undefined,
  resolved: ResolvedCredential,
  context: string,
): void {
  const missing = resolved.source === 'none' && !isKeylessProvider(provider);
  try {
    debug.log(
      'llm.credential',
      missing ? 'provider-key-missing' : 'provider-key-resolved',
      { provider: provider ?? '(none)', source: resolved.source, context, ...(resolved.envKey ? { envKey: resolved.envKey } : {}) },
      missing ? { level: 'warn' } : undefined,
    );
  } catch { /* fail-soft — 관측 실패가 인증을 막지 않는다 */ }
}
