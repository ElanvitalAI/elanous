// LLM vision-capability allowlist — used by the wire layer to decide
// whether a tool_result that carries `image/<sub>` content can be sent
// to the model as actual image bytes (vs. text-fallback metadata).
//
// Origin: Image-pipeline P3 (BACKLOG #5, 2026-05-05). P1 wired the
// Anthropic side; this module gates the OpenAI Responses (Codex) wire
// extension and documents the OpenAI Chat / Grok / Gemini limitations
// so future workarounds (synthetic follow-up user messages) land in
// the right place.
//
// Design:
//   - Hot-path lookup. wire converters call `isToolResultImageCapable`
//     once per LLM round; we keep it allocation-free + provider-keyed.
//   - Decoupled from `policy/model-capabilities.ts`. That table drives
//     ROUTING decisions (which model to pick); this allowlist drives
//     WIRE decisions (which shape to emit). Same `vision` concept,
//     different consumers — one lookup may say yes for routing while
//     the other says no for tool-result wire (e.g. OpenAI Chat: vision-
//     capable in user messages, NOT in tool messages per spec).
//   - String matching is generous on prefix to absorb dated suffixes
//     (gpt-5-codex-2026-04, claude-3-5-sonnet-20241022, etc.) without
//     a per-version table edit each time the provider ships a new
//     point release.
//
// Spec verification (2026-05-05 · live external docs via omni-crawl):
//   - Anthropic: tool_result.content array supports {type:'image',source}
//     on all Claude 3.5+ models. ✅ wired in P1.
//   - OpenAI Responses (Codex / gpt-5+ family · /v1/responses): The
//     Responses API `function_call_output.output` accepts string OR
//     ContentItem[] with input_text + input_image entries. Confirmed
//     by `developers.openai.com/api/docs/models/gpt-5.5` + the gpt-5
//     models guide. Covers gpt-5, gpt-5-codex, gpt-5-mini, gpt-5.4,
//     gpt-5.4-mini, gpt-5.5. ✅ wired in P3.
//   - OpenAI Chat Completions (`/chat/completions` · gpt-4o family):
//     tool message content array officially text-only (`{type:'text'}`
//     only). No `image_url` in tool messages. Confirmed by OpenAI's
//     images-vision guide. ❌ deferred — needs synthetic user-message
//     follow-up workaround.
//   - Grok 4.x (xAI): xAI ships an OpenAI-compatible Responses API at
//     api.x.ai/v1/responses with same multimodal function_call_output
//     shape. monad-agent's GrokProvider currently routes through Chat
//     Completions only (toOpenAIMessages + streamOpenAIEvents) → tool
//     messages text-only on this path. Migration to xAI Responses
//     endpoint is the unblocker. ❌ deferred.
//   - Gemini 3.x (3.1 Pro / 3.1 Flash · gemini-api/docs/function-calling):
//     Multimodal function responses NEW in Gemini 3 — `functionResponse`
//     gains an array `parts` field carrying `FunctionResponsePart` items
//     (each with `inline_data: {mime_type, display_name, data}` or
//     `file_data: {file_uri}`). The legacy `response: {output: text}`
//     stays as the textual companion / $ref pointer. ✅ wired in P3.5.
//     Pre-3.x Gemini (1.x / 2.x) keeps the text-only constraint.
//   - Local (LM Studio / vllm / SGLang OpenAI-compat proxies): vision-
//     capable families verified 2026-05 via omni-crawl:
//     · Qwen 3-VL series (2B/4B/8B/30B-A3B/32B/235B-A22B-Instruct)
//     · Qwen 3.5 / 3.6 (multimodal MoE, vision native from 3.5+)
//     · Qwen 2.5-VL / Qwen-VL-* (legacy VL family)
//     · Gemma 4 (E2B / E4B / 26B-A4B / 31B — all sizes have native
//       text+image; sources: ai.google.dev/gemma · lmstudio.ai/models/
//       gemma-4 · huggingface.co/blog/gemma4)
//     · LLaVA family (common local multimodal alias)
//     ✅ wired in P3.5 (userMessage axis). Tool messages still text-only
//     per OpenAI Chat Completions spec, but the follow-up workaround
//     in toOpenAIMessages bridges this for any userMessage-vision model.

/** Provider brand the wire layer cares about. Mirrors LLMProvider.name
 *  values from src/llm.ts plus 'openai-codex' which is what
 *  makeCodexProvider exposes (separate from 'openai' Chat). */
import { getCatalog } from './registry/loader.js';
import { cachedOpenRouterVision, normalizeOpenRouterUpstreamId } from './llm/openrouter-vision-lookup.js';

export type LlmBrand =
  | 'anthropic'
  | 'openai'
  | 'openai-codex'
  | 'grok'
  | 'gemini'
  | 'local'
  // 대표 2026-09-23 — 게이트웨이. 비전은 «이름»이 아니라 카탈로그 폴드의 `vision` 사실로 판정한다.
  | 'openrouter'
  // VISION-CATALOG-BUILTIN (대표 2026-11-25) — Z.ai GLM 직결(`makeZaiCodingPlanProvider` 가 호환 공급자를 'glm' 이름으로 만든다).
  | 'glm';

/**
 * U22·c (2026-05-18) — coarse-grained vision capability hint by brand
 * alone (model id 모를 때). 모든 modern multimodal provider (anthropic /
 * openai / openai-codex / gemini / grok) 가 default-line model 에서 vision
 * 지원. local 만 일반적으로 small text-only models.
 *
 * Use case: ACP `_meta.terminalContext.llmHint` 가 brand 만 (model 없이)
 * 명시했을 때 — 정확한 `isVisionCapableModel` 호출이 불가능하지만, 사용자가
 * vision-incapable 가능성 높은 backend (`local`) 사용 중인지는 알 수 있음.
 * 모를 때 (undefined) → true (alt-screen 휴리스틱 유지).
 */
export function brandLikelyVisionCapable(brand: LlmBrand | undefined): boolean {
  if (!brand) return true; // unknown → optimistic (휴리스틱 정상 진행)
  switch (brand) {
    case 'anthropic':
    case 'openai':
    case 'openai-codex':
    case 'gemini':
    case 'grok':
      return true;
    case 'local':
      return false; // local model 일반적으로 text-only
    case 'glm':
      return true; // GLM 직결은 이미지가 든 요청을 비전 형제(glm-5.3-flash)로 돌린다(zai-coding-plan.ts)
    case 'openrouter':
      return true; // 모델을 모를 때는 다른 cloud brand 와 같은 낙관(모델을 알면 isVisionCapableModel 이 카탈로그로 가른다)
  }
}

/** Capability axis of the wire decision. `userMessage` = "can the model
 *  receive image bytes inside a user message" (well-supported across
 *  most modern multimodal providers). `toolResult` = "can the model
 *  receive image bytes inside a tool_result / function_call_output"
 *  (much narrower — only Anthropic + Codex Responses today). */
export type VisionWireAxis = 'userMessage' | 'toolResult';

/** Return true if the (brand, model) pair is known to accept image
 *  bytes on the given wire axis. Defaults to false (text fallback) for
 *  any pair the allowlist doesn't recognize — safe regression: the
 *  worst case is a metadata note instead of bytes, never a 400 from
 *  the provider.
 *
 *  Model-id matching is case-insensitive prefix-or-substring on the
 *  curated list below. Empty/null model id → defaults to `false` so
 *  callers without an explicit model selection get the conservative
 *  fallback. */
/**
 * VISION-CATALOG-BUILTIN (대표 2026-11-25 «이미지는 모든 공급자에서») — 내장 비전 사실.
 * 발견 스냅숏이 없거나(시험 우주) 낡아도 현행 주력 모델의 이미지 입력을 «모른다»로 떨어뜨리지 않는다.
 * 근거 = OpenRouter `GET /api/v1/models` `architecture.input_modalities` 실측 2026-11-25:
 *   anthropic/claude-{opus-5.5,sonnet-5.5,sonnet-5,haiku-5.5,fable-5.x,opus-4.x} = text+image+file ·
 *   x-ai/grok-4.{20,3,5,6,7} = text+image+file · google/gemini-3.x = text+image+… ·
 *   openai/gpt-6.x(terra·sol·luna·astra) = text+image+file ·
 *   z-ai/glm-5.3-flash(·flashx) · glm-5v-turbo · glm-4.6v · glm-4.5v = image ✅ / z-ai/glm-5.3 · 5.2 · 5.1 · 5 · 4.7(-flash) · 4.6 · 4.5 = text-only ❌.
 * 입력 = upstream id(`<vendor>/<model>`, 소문자 · `openrouter/` 없음). 반환 = 사실(true/false) 또는 undefined(모른다).
 */
export function builtinVisionFact(upstreamId: string): boolean | undefined {
  const id = upstreamId.toLowerCase();
  const slash = id.indexOf('/');
  if (slash < 0) return undefined;
  const vendor = id.slice(0, slash);
  const model = id.slice(slash + 1);
  switch (vendor) {
    case 'anthropic':
      return model.startsWith('claude-') ? true : undefined;
    case 'x-ai':
      return /^grok-([4-9]|\d{2,})/.test(model) && !model.startsWith('grok-code') ? true : undefined;
    case 'google':
      return model.startsWith('gemini-') ? true : undefined;
    case 'openai':
      if (model.startsWith('gpt-4o') || isGpt5OrLaterGeneration(model)) return true;
      return undefined;
    case 'z-ai':
      return glmVisionFact(model);
    default:
      return undefined;
  }
}

/** GLM 비전 규칙(z.ai id 와 OpenRouter `z-ai/` id 공용) — flash 5.3+ 와 «V» 변형만 이미지 · 나머지 glm 은 text-only. */
export function glmVisionFact(model: string): boolean | undefined {
  const m = model.toLowerCase().replace(/^z-ai\//, '');
  if (!m.startsWith('glm-')) return undefined;
  if (/^glm-\d+(\.\d+)?v(\b|-|$)/.test(m)) return true;           // glm-4.5v · glm-4.6v · glm-5v-turbo
  const flash = /^glm-(\d+)(?:\.(\d+))?-flash/.exec(m);
  if (flash) {
    const major = Number(flash[1]);
    const minor = Number(flash[2] ?? 0);
    return major > 5 || (major === 5 && minor >= 3);                // glm-5.3-flash(·flashx) ✅ · glm-4.7-flash ❌
  }
  return false;
}

/** OpenRouter 비전 «사실» — 카탈로그(발견 폴드·손 YAML) → 내장 표 → 공급자 메타데이터 캐시 순. 모르면 undefined. */
export function openRouterVisionFact(model: string): boolean | undefined {
  const m = model.toLowerCase();
  const rec = getCatalog().models.get(m) ?? getCatalog().models.get(model);
  if (rec && rec.vision !== undefined) return rec.vision === 'images' || rec.vision === 'pdf' || rec.vision === 'video';
  const upstream = normalizeOpenRouterUpstreamId(model);
  return builtinVisionFact(upstream) ?? cachedOpenRouterVision(upstream);
}

/** gpt-5 «이후» 세대(gpt-6·gpt-7 …)인가 — 이름 접두가 아니라 «세대 숫자»로 가른다.
 *  ⛔ 2026-09-23: `startsWith('gpt-5')` 가 gpt-6 을 비전 불가로 읽어 운영 기본(gpt-6-sol)에 이미지를 안 보냈다.
 *  codex 모델 캐시 실측: gpt-6-sol·astra·luna 전부 `input_modalities: [text, image]`.
 *  `llm.ts` `isNewGenerationOpenAiModel` 과 같은 규칙(순환 import 를 피해 여기 둔다 · o-series 제외). */
function isGpt5OrLaterGeneration(m: string): boolean {
  const match = /^gpt-(\d+)/.exec(m);
  return match !== null && Number.parseInt(match[1]!, 10) >= 5;
}

export function isVisionCapableModel(
  brand: LlmBrand,
  model: string | undefined,
  axis: VisionWireAxis,
): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  switch (brand) {
    case 'anthropic':
      // All Claude 3.5+ models ship vision. The literal 'claude'
      // prefix covers the dashed (claude-3-5-sonnet-...) and short
      // (sonnet, opus, haiku, sonnet-4-5) aliases elanous uses
      // throughout the user config.
      if (m === 'opus' || m === 'sonnet' || m === 'haiku') return true;
      if (m.startsWith('claude')) return true;
      // Legacy short ids like 'sonnet-4-5' / 'opus-4-7'.
      if (m.startsWith('opus-') || m.startsWith('sonnet-') || m.startsWith('haiku-')) return true;
      return false;

    case 'openai-codex':
      // Codex Responses API path — gpt-5 family (gpt-5, gpt-5-codex,
      // gpt-5-mini, gpt-5.4, gpt-5.4-mini, gpt-5.5, …) supports
      // function_call_output.output as ContentItem[] (input_image).
      // The toolResult axis is the meaningful one here; user-message
      // images already work via input_image in messagesToResponsesInput.
      if (isGpt5OrLaterGeneration(m)) return true;
      if (m === 'codex' || m.startsWith('codex-')) return true;
      return false;

    case 'openai':
      // OpenAI Chat Completions (`/chat/completions`):
      //   - userMessage: gpt-4o family + gpt-5.x in non-Responses mode
      //     (rare — most callers use Responses for gpt-5+) accept
      //     image_url in user content arrays. Already wired by
      //     toOpenAIMessages.
      //   - toolResult: NOT in the public spec; tool message content
      //     array is text-only per OpenAI's images-vision guide.
      //     Reported false to keep the wire conservative.
      if (axis === 'userMessage') {
        if (m.startsWith('gpt-4o')) return true;
        if (m.startsWith('gpt-4-turbo') || m === 'gpt-4-turbo') return true;
        if (m.startsWith('gpt-4-vision')) return true;
        if (m.startsWith('chatgpt-4o')) return true;
        // gpt-5.x routed through Chat Completions (not Responses)
        // also accepts image_url on user role.
        if (isGpt5OrLaterGeneration(m)) return true;
        return false;
      }
      // toolResult axis — deferred (Chat Completions tool role text-only).
      return false;

    case 'grok':
      // xAI Grok (api.x.ai). Two paths:
      //   - Chat Completions (`/v1/chat/completions`) — current elanous
      //     route via toOpenAIMessages. Vision in user messages OK,
      //     but tool messages text-only (same constraint as OpenAI
      //     Chat).
      //   - Responses (`/v1/responses`) — supports multimodal
      //     function_call_output (mirrors OpenAI Responses semantics).
      //     elanous's GrokProvider not yet migrated; until then
      //     toolResult stays false.
      if (axis === 'userMessage') {
        if (m.includes('vision')) return true;
        // grok-2 / grok-3 / grok-4 (4.2 / 4.3) base models accept
        // vision via image_url per xAI docs (2026-05 verification).
        if (m.startsWith('grok-2') || m.startsWith('grok-3')) return true;
        if (m.startsWith('grok-4')) return true;
        return false;
      }
      return false;

    case 'openrouter': {
      // ⛔ 2026-09-23 — 454개가 한 게이트웨이 뒤에 있고 절반 가까이는 text-only 다 ⇒ 이름 패턴은 «늙는다».
      //   카탈로그 폴드(`/api/v1/models` 의 `architecture.input_modalities` → `vision`)만 믿는다.
      //   카탈로그에 없으면(스냅숏 미갱신) «모른다» → 보내지 않는다(400 보다 텍스트 전용이 낫다).
      //   toolResult: Chat Completions 의 tool 메시지는 text-only(openai 와 같은 제약).
      //   VISION-CATALOG-BUILTIN (11-25) — 카탈로그에 없으면 내장 표 → 메타데이터 캐시(openRouterVisionFact).
      if (axis !== 'userMessage') return false;
      return openRouterVisionFact(model) === true;
    }

    case 'glm':
      // Z.ai GLM 직결(OpenAI 호환 Chat Completions · user content 의 `image_url`). 도구 메시지는 text-only 라
      // userMessage 축이 follow-up(합성 user 메시지) 우회를 켠다 — openai·grok 과 같은 제약.
      if (axis !== 'userMessage') return false;
      return glmVisionFact(m) === true;

    case 'gemini':
      // Gemini native wire (messagesToGeminiInput in src/llm.ts):
      //   - userMessage: inlineData on parts works for all Gemini
      //     models (pro / flash / pro-1.5 / 2.x / 3.x). Already wired.
      //   - toolResult: NEW in Gemini 3.x — `functionResponse.parts`
      //     accepts FunctionResponsePart entries with inline_data
      //     (mime_type + base64). Pre-3.x (1.x / 2.x) is text-only
      //     per the legacy spec, so we gate the toolResult axis on
      //     the gemini-3+ prefix.
      if (axis === 'userMessage') {
        if (m.startsWith('gemini')) return true;
        if (m === 'pro' || m === 'flash') return true;
        return false;
      }
      // toolResult axis — only Gemini 3+.
      if (m.startsWith('gemini-3')) return true;
      // Future-proof: any 4.x / 5.x release that ships in this
      // generation continues the multimodal functionResponse contract.
      if (/^gemini-[4-9]/.test(m)) return true;
      return false;

    case 'local':
      // Vision-capable local model families verified 2026-05 via
      // omni-crawl. All route through the OpenAI-compat Chat
      // Completions path (LM Studio · vLLM · SGLang) so the
      // userMessage axis activates the synthetic follow-up workaround
      // in toOpenAIMessages — non-vision local models keep the
      // strict text-only contract.
      if (axis !== 'userMessage') {
        // Tool messages text-only per OpenAI Chat Completions spec —
        // workaround is on the userMessage axis via follow-up.
        return false;
      }
      // Qwen VL family — qwen3-vl-* / qwen3.5-vl-* / qwen3.6-vl-* /
      // qwen2.5-vl-* / qwen-vl-* / qwenvl-*.
      if (m.startsWith('qwen3-vl')) return true;
      if (m.startsWith('qwen3.5-vl') || m.startsWith('qwen3.6-vl')) return true;
      if (m.startsWith('qwen2.5-vl')) return true;
      if (m.startsWith('qwen-vl') || m.startsWith('qwenvl')) return true;
      // Qwen 3.5 / 3.6 base (multimodal native from 3.5+ per
      // huggingface.co/Qwen/Qwen3.5-27B + qwen.ai blog 3.6).
      // Exact major.minor prefix to avoid pulling in Qwen 3 base
      // (text-only) or Qwen 2.5 coder.
      if (m.startsWith('qwen3.5') || m.startsWith('qwen3.6')) return true;
      if (m.startsWith('qwen-3.5') || m.startsWith('qwen-3.6')) return true;
      // Gemma 4 family (E2B / E4B / 26B-A4B / 31B · ai.google.dev/gemma).
      // All sizes ship native vision per Google's blog + LM Studio
      // catalog. Match across registry prefixes: bare ('gemma-4-31b'),
      // 'google/' (LM Studio), 'mlx-community/' (Apple-silicon MLX
      // optimized · LM Studio default for Mac users), 'huggingface/',
      // and the literal 'gemma' alias elanous emits when no registry is
      // configured.
      if (m.startsWith('gemma-4')) return true;
      if (m.includes('/gemma-4')) return true;
      // LLaVA family (legacy but common local alias). llava-1.5,
      // llava-1.6, llava-next.
      if (m.includes('llava')) return true;
      return false;
  }
}

/** Convenience — short-circuit the common case: "this turn carries an
 *  image-bearing tool_result; will the model accept image bytes there?"
 *  Equivalent to `isVisionCapableModel(brand, model, 'toolResult')`,
 *  read at the wire boundary. */
export function acceptsToolResultImage(brand: LlmBrand, model: string | undefined): boolean {
  return isVisionCapableModel(brand, model, 'toolResult');
}
