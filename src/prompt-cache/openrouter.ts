// OR-ANTHROPIC-CACHE (2026-10-10) — OpenRouter 경유 Anthropic·Moonshot(Kimi) 호출의 프롬프트 캐시 중단점.
//
// OpenRouter 는 OpenAI 꼴 본문을 받아 상류(Anthropic·Moonshot)로 옮긴다. 이 두 계열은 «요청이 청해야»
// 캐시를 쓴다 — 본문에 `cache_control` 이 없으면 적중 0 이다(10-10 벤치: Haiku·Sonnet 5.5 팔 cachedInput 0).
//
// 배치(참고 구현 대조):
//   - opencode `provider/transform.ts` applyCaching — system 앞 2 ⊕ 비-system 끝 2 (상한 4).
//   - hermes `agent/prompt_caching.py` envelope layout — OpenRouter 는 «content 파트»의 cache_control 만 따른다.
//     · role:tool 의 «최상위» cache_control 은 OpenRouter 에서 조용히 멎는다 → 파트에만 단다(OpenRouter 가
//       tool_result 블록으로 옮긴다).
//     · content 가 비거나 null 인 assistant(순수 tool_calls)는 중단점을 낭비하므로 건너뛴다.
//     · Kimi(moonshotai/*) 도 같은 envelope 꼴로 적중 1% → 97% (hermes #25970).
//   - tools: 따로 표시하지 않는다. Anthropic 접두 순서가 tools → system → messages 라 system 끝 중단점이
//     도구 정의까지 덮는다. hermes 도 tools 배열 표시는 «직접 Anthropic» 경로에만 쓴다.
//
// ⛔ 순수 함수 — 입력 배열·메시지를 고치지 않고 바뀐 메시지만 새로 만든다.

/** Anthropic 상한. */
export const OPENROUTER_MAX_CACHE_BREAKPOINTS = 4;

export type OpenRouterCacheFamily = 'anthropic' | 'moonshotai';

/** wire 모델(`anthropic/claude-haiku-5.5`)이 캐시 중단점 대상인가. 대상이 아니면 null. */
export function openRouterPromptCacheFamily(wireModel: string): OpenRouterCacheFamily | null {
  if (wireModel.startsWith('anthropic/')) return 'anthropic';
  if (wireModel.startsWith('moonshotai/')) return 'moonshotai';
  return null;
}

type WireMessage = Record<string, unknown>;
type CacheMarker = { type: 'ephemeral'; ttl?: '1h' };

function isMarkablePart(part: unknown): boolean {
  // 텍스트 파트에만 단다 — image_url 파트 위 cache_control 의 OpenRouter 전달은 확인하지 않았다(보수).
  return !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text';
}

function canCarryMarker(msg: WireMessage): boolean {
  const content = msg.content;
  if (typeof content === 'string') return content.length > 0;
  if (Array.isArray(content) && content.length > 0) return isMarkablePart(content[content.length - 1]);
  return false;
}

function withMarker(msg: WireMessage, marker: CacheMarker): WireMessage {
  const content = msg.content;
  if (typeof content === 'string') {
    return { ...msg, content: [{ type: 'text', text: content, cache_control: { ...marker } }] };
  }
  const parts = (content as Array<Record<string, unknown>>).slice();
  parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: { ...marker } };
  return { ...msg, content: parts };
}

export interface OpenRouterCachePlan {
  messages: WireMessage[];
  /** 실제로 단 중단점 수(0~4). */
  breakpoints: number;
  systemBreakpoints: number;
  tailBreakpoints: number;
}

/** system 앞 2 ⊕ 비-system 끝 2 (합 ≤ 4) 의 마지막 텍스트 파트에 `cache_control` 을 단다.
 *  `ttl:'1h'` 은 anthropic 계열에만 싣는다(Moonshot 의 1h 계층은 확인하지 않았다 → 기본 5m). */
export function applyOpenRouterCacheControl(
  messages: readonly WireMessage[],
  opts: { family: OpenRouterCacheFamily; ttl?: '5m' | '1h' },
): OpenRouterCachePlan {
  const marker: CacheMarker = opts.family === 'anthropic' && opts.ttl === '1h'
    ? { type: 'ephemeral', ttl: '1h' }
    : { type: 'ephemeral' };
  const out = messages.slice();
  let systemBreakpoints = 0;
  for (let i = 0; i < out.length && systemBreakpoints < 2; i++) {
    if (out[i]!.role !== 'system') continue;
    if (!canCarryMarker(out[i]!)) continue;
    out[i] = withMarker(out[i]!, marker);
    systemBreakpoints++;
  }
  const remaining = Math.min(2, OPENROUTER_MAX_CACHE_BREAKPOINTS - systemBreakpoints);
  const tail: number[] = [];
  for (let i = out.length - 1; i >= 0 && tail.length < remaining; i--) {
    const m = out[i]!;
    if (m.role === 'system') continue;
    if (canCarryMarker(m)) tail.push(i);
  }
  for (const i of tail) out[i] = withMarker(out[i]!, marker);
  return {
    messages: out,
    breakpoints: systemBreakpoints + tail.length,
    systemBreakpoints,
    tailBreakpoints: tail.length,
  };
}
