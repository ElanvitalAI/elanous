// OR-DEEPSEEK-TUNE (2026-10-11) — OpenRouter `deepseek/*` 전용 요청 조정.
//
// 왜 따로 두나: llm.ts 는 동결(RFC #25983)이라 새 판단은 여기 두고 llm.ts 엔 배선만 남긴다.
// ⛔ 불변식: 여기 함수들은 «DeepSeek 가 아닌» 모델에 대해 항상 «아무것도 안 바꾼다» 는 값을 돌려준다
//    (빈 객체 · 원래 값 · false) — OpenRouter 의 다른 모델 요청 바이트는 이 모듈 때문에 바뀌지 않는다.
//
// 근거(MIT · 패턴만 참고):
//   - openclaw extensions/openrouter/models.ts:56-60 `isOpenRouterDeepSeekV4ModelId` — V4 판정 정규식.
//   - openclaw extensions/openrouter/thinking-policy.ts:8-11 — OpenRouter 의 DeepSeek V4 effort 단계는 off..xhigh
//     (OpenRouter 통일 effort 에 `max` 는 없다 → 이 저장소 실측: `max` 를 보내면 400).
//   - openclaw packages/ai/src/transports/openai-completions-replay.ts:101-127 — «빈» 추론 조각은
//     OpenRouter/DeepSeek 재전송에서 거부된다 ⇒ 빈 placeholder 를 만들지 않고 빈 조각을 걷는다.
//   - opencode packages/opencode/src/provider/transform.ts:303-319 — DeepSeek 는 «모든» assistant 턴에 추론을 요구.
//     (opencode 는 빈 placeholder 를 넣지만 위 openclaw 근거로 여기선 넣지 않는다.)
//   - 상류 고정: 대상 이름은 설정 기본값 `./openrouter-upstream-pins.config.ts` ⊕ 사용자 `llm.openrouter.upstreamPins`.
//   - hermes-agent agent/reasoning_effort.py:130-133 — DeepSeek V4 의 최상위 단계(직결 API 는 `max`) ↔ xhigh.

import { debug } from '../debug/log.js';
import { getCatalog } from '../registry/loader.js';
import { DEFAULT_OPENROUTER_UPSTREAM_PINS } from './openrouter-upstream-pins.config.js';

/** OpenRouter wire 모델(`openrouter/` 를 뗀 id)이 DeepSeek 인가. */
export function isOpenRouterDeepSeekWireModel(wireModel: string): boolean {
  return wireModel.toLowerCase().startsWith('deepseek/');
}

/** DeepSeek V4 계열(v4-flash · v4.1-flash · v4-pro · 날짜 고정판 · `:variant`)인가. */
export function isOpenRouterDeepSeekV4WireModel(wireModel: string): boolean {
  return /^deepseek\/deepseek-v4(?:\.\d+)?-/.test(wireModel.toLowerCase());
}

export type OpenRouterEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** DeepSeek V4 effort 표. `xhigh`·`max` → `xhigh`(OpenRouter 가 `max` 를 400 으로 거부) · `off`/모르는 값 → 칸 없음. */
const DEEPSEEK_V4_EFFORT: Record<string, OpenRouterEffort> = {
  minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh',
};

/** DeepSeek V4 이면 그 표의 값(없으면 `null` = 칸 없음), V4 가 아니면 `undefined`(호출자가 기존 표를 쓴다). */
export function openRouterDeepSeekEffort(wireModel: string, effort: string | undefined): OpenRouterEffort | null | undefined {
  if (!isOpenRouterDeepSeekV4WireModel(wireModel)) return undefined;
  if (effort === undefined || !Object.hasOwn(DEEPSEEK_V4_EFFORT, effort)) return null;
  return DEEPSEEK_V4_EFFORT[effort];
}

/** 카탈로그(YAML · `catalog/models/openrouter/<id>.yaml` 의 `reasoning`)가 정한 DeepSeek 기본 effort.
 *  ⛔ 코드에 기본값을 박지 않는다 — 카탈로그(손 레코드)가 정본이다(MK #26055). 없으면 `undefined` → 호출자의 기존 폴백.
 *  ⚠️ 발견 폴드가 자동으로 채운 레코드(`discoveryMeta.autoFilled`)는 «능력 추정»(reasoning 칸이 있으면 'high')이라 기본값으로 쓰지 않는다.
 *  `lookup` 은 시험용 주입점(미지정 = 실제 카탈로그). */
export function openRouterDeepSeekCatalogEffort(
  catalogId: string,
  lookup: (id: string) => { reasoning?: string | null; discoveryMeta?: { autoFilled?: boolean } } | undefined
    = (id) => getCatalog().models.get(id),
): 'low' | 'medium' | 'high' | undefined {
  if (!catalogId.startsWith('openrouter/') || !isOpenRouterDeepSeekWireModel(catalogId.slice('openrouter/'.length))) return undefined;
  let spec: ReturnType<typeof lookup>;
  try { spec = lookup(catalogId); } catch { return undefined; }
  if (!spec || spec.discoveryMeta?.autoFilled === true) return undefined;
  const r = spec.reasoning;
  return r === 'low' || r === 'medium' || r === 'high' ? r : undefined;
}

/** 사용자가 라우팅을 «명시»했는가 — `order`·`only`·`allow_fallbacks` 중 하나라도 있으면 그대로 둔다. */
function hasExplicitRouting(explicit: unknown): boolean {
  if (!explicit || typeof explicit !== 'object' || Array.isArray(explicit)) return false;
  const e = explicit as Record<string, unknown>;
  return 'order' in e || 'only' in e || 'allow_fallbacks' in e;
}

/** 이 모델의 상류 고정 목록 — 사용자 `llm.openrouter.upstreamPins` 가 기본값(설정 표)을 모델별로 덮는다.
 *  빈 배열·문자열 아닌 값·표에 없음 = 고정 안 함(`undefined`). ⛔ 상류 이름은 여기(코드)가 아니라 설정 기본값에 있다. */
export function resolveOpenRouterUpstreamPin(
  wireModel: string,
  userPins: unknown,
  defaults: Readonly<Record<string, readonly string[]>> = DEFAULT_OPENROUTER_UPSTREAM_PINS,
): string[] | undefined {
  const user = userPins && typeof userPins === 'object' && !Array.isArray(userPins) ? userPins as Record<string, unknown> : {};
  const raw = Object.hasOwn(user, wireModel) ? user[wireModel]
    : Object.hasOwn(defaults, wireModel) ? defaults[wireModel] : undefined;
  if (!Array.isArray(raw)) return undefined;
  const order = raw.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return order.length > 0 ? order : undefined;
}

/** 본문 `provider` 칸 덮어쓰기 — `order=<고정 목록>` ⊕ `allow_fallbacks:false`.
 *  DeepSeek 가 아니거나 · 사용자가 라우팅을 명시했거나 · 고정 목록이 없으면 `{}`(아무것도 안 싣는다 = OR 기본 라우팅).
 *  `base` 는 이미 실린 provider 칸(require_parameters 등 ⊕ 사용자 설정) — 키 순서를 지키려고 그 위에 덮는다. */
export function openRouterDeepSeekProviderField(
  wireModel: string,
  base: unknown,
  explicit: unknown,
  userPins?: unknown,
  defaults?: Readonly<Record<string, readonly string[]>>,
): { provider?: Record<string, unknown> } {
  if (!isOpenRouterDeepSeekWireModel(wireModel) || hasExplicitRouting(explicit)) return {};
  const order = resolveOpenRouterUpstreamPin(wireModel, userPins, defaults);
  if (!order) return {};
  const b = base && typeof base === 'object' && !Array.isArray(base) ? base as Record<string, unknown> : {};
  return { provider: { ...b, order, allow_fallbacks: false } };
}

/** 도구 스키마에 Kimi sanitizer(`$ref` 단독 · 단일 items)를 씌울 모델인가 — moonshotai/* ⊕ deepseek/*. */
export function openRouterNeedsKimiToolSchema(wireModel: string): boolean {
  return wireModel.startsWith('moonshotai/') || isOpenRouterDeepSeekWireModel(wireModel);
}

/** 재전송용 `reasoning_details` 에서 «빈» 조각을 걷는다(text·summary·data 가 모두 비었으면 버림).
 *  다 걷히면 `undefined` — 빈 배열·빈 문자열 placeholder 를 절대 싣지 않는다. */
export function nonEmptyReasoningDetails(
  details: ReadonlyArray<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(details) || details.length === 0) return undefined;
  const kept = details.filter((d) => ['text', 'summary', 'data'].some((k) => typeof d?.[k] === 'string' && (d[k] as string).length > 0));
  return kept.length > 0 ? kept : undefined;
}

/** 관측 `llm.openrouter deepseek-replay` 의 재료 — 보낼 wire 메시지에서 assistant 턴과 추론 재전송 수를 센다. */
export function summarizeDeepSeekReplay(wireMessages: ReadonlyArray<Record<string, unknown>>): {
  assistantTurns: number; withReasoning: number; toolTurns: number; textTurnsWithReasoning: number;
} {
  let assistantTurns = 0; let withReasoning = 0; let toolTurns = 0; let textTurnsWithReasoning = 0;
  for (const m of wireMessages) {
    if (m.role !== 'assistant') continue;
    assistantTurns++;
    const hasTools = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    if (hasTools) toolTurns++;
    if (Array.isArray(m.reasoning_details) && m.reasoning_details.length > 0) {
      withReasoning++;
      if (!hasTools) textTurnsWithReasoning++;
    }
  }
  return { assistantTurns, withReasoning, toolTurns, textTurnsWithReasoning };
}

/** 요청 한 번의 DeepSeek 부가물 — 본문 `provider` 칸(상류 고정) ⊕ 관측 `llm.openrouter deepseek-replay` 한 줄.
 *  ⛔ DeepSeek 가 아니면 `{}` 이고 아무것도 남기지 않는다. */
export function openRouterDeepSeekRequestExtras(
  wireModel: string,
  wireMessages: ReadonlyArray<Record<string, unknown>>,
  baseProvider: unknown,
  explicitPreferences: unknown,
  userPins?: unknown,
): { provider?: Record<string, unknown> } {
  if (!isOpenRouterDeepSeekWireModel(wireModel)) return {};
  const field = openRouterDeepSeekProviderField(wireModel, baseProvider, explicitPreferences, userPins);
  debug.log('llm.openrouter', 'deepseek-replay', {
    model: wireModel, ...summarizeDeepSeekReplay(wireMessages),
    upstreamPin: (field.provider?.order as string[] | undefined) ?? null,
  });
  return field;
}
