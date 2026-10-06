// ── Multi-LLM provider abstraction ──
// Unified streaming interface for Grok (xAI), OpenAI, Anthropic, Local (OpenAI-compatible).
// Auto-routes based on model name prefix, or picks the first available provider.

import { createHash } from 'node:crypto';
import type { LLMUsage } from './prompt-cache/types.js';
import type { ModelRole } from './user-config.js';
// ⭐ grok 자격 해석 — 구독(OAuth) 1순위 · API 키 2순위. ACP 경로와 «같은» 규칙.
import { isGrokUnauthorized, refreshGrokSubscriptionToken, resolveFreshGrokCredential, resolveGrokCredential } from './grok/credential.js';
import {
  GROK_MODEL, GROK_API_URL,
  getOpenAIApiKey, OPENAI_MODEL, OPENAI_API_URL,
  getAnthropicApiKey, ANTHROPIC_MODEL, ANTHROPIC_API_URL,
  getOpenRouterApiKey, OPENROUTER_API_URL, OPENROUTER_MODEL,
  getLocalLLMUrl, LOCAL_LLM_MODEL,
  getGeminiApiKey, GEMINI_MODEL,
  DEFAULT_PROVIDER,
} from './config.js';
import { debug, redactSecrets } from './debug/log.js';
import { llmUsageCostFields } from './budget/llm-cost.js';
import { ToolCallTiming } from './chat/tool-call-timing.js';
import {
  dispatchWithParallelSafety,
  isSafeForParallel,
} from './session-runtime/parallel-dispatch.js';
import {
  DoomLoopTracker,
  decideRetry,
  fingerprintError,
  decideProviderFallback,
  formatProviderFallbackOutput,
  isProviderFallbackEligible,
  providerNamesFromFallbackChain,
  ProviderFallbackError,
  sanitizeProviderFailureReason,
  type ProviderFallbackAttempt,
  type ProviderFallbackTerminalVerdict,
} from './session-runtime/retry-policy.js';
import { fetchApiWithRetry, OverloadFailoverError, type FetchApiWithRetryOpts } from './session-runtime/retry-api.js';
import { resolveModelAlias } from './intelligence-map/model-alias.js';
import { reasoningEffortCeiling as reasoningEffortCeilingOf } from './intelligence-map/model-catalog.js';
import { inferProviderFromModel as registryInferProviderFromModel } from './registry/normalize.js';
import { closestMatches } from './tool-name-suggest.js';
import { undoTurnRuntime } from './tool-runtime/undo-turn-runtime.js';
import { listSnapshots } from './undo-turn/index.js';
// Zero-dep spec module (no tool-runtime registry) — safe for this hot path.
import { takeHydratedTools } from './skills/tools/tool-search-spec.js';
import { dispatchAskUserQuestion } from './ask-user-question/index.js';
import type { AskUserQuestionResult } from './ask-user-question/index.js';
import { isPlanModeActive } from './plan-mode/session.js';
import { mintTurnUri } from './mss/uri/builder.js';
import type { TurnUri } from './mss/uri/brand.js';
import { acceptsToolResultImage, isVisionCapableModel } from './llm-vision-capability.js';
import {
  maybeCaptureDecision,
  type TurnCheckpointLoopSnapshot,
} from './turn-checkpoint/index.js';

/**
 * A single block inside a multimodal user/assistant message. Provider
 * adapters map this to their wire format:
 *   - Anthropic image: { type:'image', source:{ type:'base64', media_type, data } }
 *   - OpenAI/Grok/Local image: { type:'image_url', image_url:{ url:'data:…;base64,…' } }
 *
 * Phase A adds two more variants for native tool rounds:
 *   - tool_use: assistant-side invocation block (Anthropic native; OpenAI
 *     boundary converts to the `tool_calls` field on the assistant message).
 *   - tool_result: user-side result block (Anthropic native; OpenAI boundary
 *     splits into `{role:'tool', tool_call_id}` wire messages — so a single
 *     LLMMessage can expand into N wire messages on the OpenAI side).
 */
/** Inner content items allowed inside a `tool_result.content` array. A
 *  subset of ContentBlock — text + image only. Used by tools that
 *  produce visual output (WT-C-2 WebTerminalScreenshot) so vision-
 *  capable models receive the bytes as an actual image input rather
 *  than a base64 string buried in JSON. Wire layer fans out per
 *  provider: Anthropic passes through, OpenAI/Codex/Gemini fall back
 *  to text-only metadata (image dropped) since their tool-result wire
 *  shape doesn't accept inline image bytes. */
export type ToolResultContentItem =
  | { type: 'text';  text: string }
  | { type: 'image'; mediaType: string; base64: string };

/** 도구 호출에 딸려 «다음 턴에 그대로 되돌려야 하는» 제공자 메타.
 *  - `thoughtSignature`: Gemini OpenAI-compat.
 *  - `reasoningDetails`: OpenRouter `reasoning_details[]` — 2026-09-23 · Kimi K3·GLM 은 도구 루프에서 이전 추론을
 *    되돌려 받아야 한다(Kimi 공식 문서: 「K3 는 다중 턴·도구 호출 루프에서 필수」 · OpenRouter 가 이 배열로 통일). */
export interface ProviderToolMeta { thoughtSignature?: string; reasoningDetails?: Array<Record<string, unknown>> }

export type ContentBlock =
  | { type: 'text';  text: string }
  | { type: 'image'; mediaType: string; base64: string }
  | { type: 'audio'; mediaType: string; base64: string }
  | { type: 'video'; mediaType: string; base64: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; providerMeta?: ProviderToolMeta }
  | { type: 'tool_result'; tool_use_id: string; content: string | ToolResultContentItem[]; isError?: boolean };

/** §3.4 (2026-04-30) — provider audio capability map. Caller (turn
 *  assembly / acpPromptToLlmContent) checks this before forwarding an
 *  `audio` ContentBlock to a provider that would 400 on it. Confirmed
 *  via omni-crawl 2026-04-30:
 *
 *  - **OpenAI Chat Completions**: `gpt-4o-audio-preview` +
 *    `gpt-4o-realtime-preview` accept `input_audio` (data + format,
 *    format ∈ {wav, mp3}). Other GPT models 400 on the field.
 *    https://platform.openai.com/docs/api-reference/chat/create
 *  - **Anthropic Claude**: no audio input via Messages API as of
 *    2026-04 — wishlist (anthropic-sdk-python#1198). Caller must
 *    transcribe upstream + send text. Always returns false.
 *  - **xAI Grok**: Chat Completions does NOT accept audio. The
 *    `Voice Agent` API is a separate WebSocket endpoint
 *    (`wss://api.x.ai/v1/realtime`) — out of elanous's Chat Completions
 *    routing scope. Always returns false for Chat path.
 *    https://docs.x.ai/developers/model-capabilities/audio/voice
 *  - **Gemini**: native `inlineData` audio (wav/mp3/aiff/aac/ogg/flac)
 *    via `generateContent`. elanous routes Gemini through the native
 *    `generateContentStream` SDK call (see callGeminiStream below ·
 *    line 2339) — toGeminiContents (line 2080+) builds inline parts
 *    with mimeType + base64 for image/video/**audio** (W8-A 후속 #3 ·
 *    2026-05-14 audio block dispatch land). Returns true for any
 *    Gemini 1.5+ family model.
 *  - **Local (ollama)**: no audio support — false.
 *
 *  Exported so dashboard / acp / channel adapters can pre-filter
 *  audio blocks with a provider-aware decision instead of relying on
 *  a 400 to surface the issue. */
export function providerSupportsAudio(model: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  // OpenAI audio-preview / realtime-preview families.
  if (m.includes('audio-preview')) return true;
  if (m.includes('realtime-preview')) return true;
  // Future-proof: any *-audio-* / *-realtime-* convention.
  if (m.startsWith('gpt-4o-audio')) return true;
  if (m.startsWith('gpt-4o-realtime')) return true;
  // W8-A 후속 #3 (2026-05-14) — Gemini 1.5+ family native audio via
  // generateContentStream inlineData. toGeminiContents audio block
  // dispatch land.
  if (m.startsWith('gemini-')) return true;
  // Anthropic / xAI Grok / Local: no confirmed Chat-Completions audio
  // support as of 2026-04-30.
  return false;
}

/** PR8 (2026-05-14) — provider video capability map. Caller (turn
 *  assembly / acpPromptToLlmContent) checks this before forwarding a
 *  `video` ContentBlock to a provider that would 400 on it. Confirmed
 *  via omni-crawl 2026-05-14:
 *
 *  - **Gemini 1.5+ (native generateContent path)**: native `inlineData`
 *    video (mp4/quicktime/webm/mpeg/x-flv/x-msvideo/3gpp). Inline ≤20MB
 *    via `inlineData`; bigger needs Files API upload (deferred — out of
 *    scope for this PR · resource_link path can replace).
 *    https://ai.google.dev/gemini-api/docs/vision#video
 *  - **Anthropic Claude**: no video input via Messages API as of 2026-05.
 *    Always returns false.
 *  - **OpenAI Chat Completions**: no video input. Realtime Video API is
 *    a separate WebSocket endpoint — out of elanous's Chat Completions
 *    routing scope. Always returns false for Chat path.
 *  - **xAI Grok**: no video input via Chat Completions. Always false.
 *  - **Local (ollama / Qwen 2.5 VL etc.)**: format-specific · provider-
 *    side wire varies. Conservative false until per-model wiring lands.
 *
 *  Exported so dashboard / acp / channel adapters can pre-filter video
 *  blocks with a provider-aware decision instead of relying on a 400. */
export function providerSupportsVideo(model: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  // Gemini 1.5+ all support inlineData video on user role per
  // generateContent spec. elanous currently routes Gemini through the
  // OpenAI-compat endpoint OR a native mapper; both branches honor
  // inlineData when the message carries a 'video' block.
  if (m.startsWith('gemini-')) return true;
  if (m.includes('/gemini')) return true; // local-router prefix variant
  return false;
}

/** Detect a tool dispatch result that follows the image-bearing
 *  convention (see ToolRunResult docstring): top-level
 *  `mediaType: 'image/<sub>'` + `dataB64: string`. Returns the
 *  destructured payload + the remaining fields as `rest` (which the
 *  caller serializes as the metadata text alongside the image
 *  content), or null if the shape doesn't match. */
export function maybeImageBearingResult(x: unknown):
  | { mediaType: string; dataB64: string; rest: Record<string, unknown> }
  | null
{
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const mediaType = o.mediaType;
  const dataB64 = o.dataB64;
  if (typeof mediaType !== 'string' || !mediaType.startsWith('image/')) return null;
  if (typeof dataB64 !== 'string' || !dataB64) return null;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'mediaType' || k === 'dataB64') continue;
    rest[k] = v;
  }
  return { mediaType, dataB64, rest };
}

/** Append a system notice (budget warning · synthesis reminder) to a
 *  tool_result block, regardless of whether its content is a plain
 *  string or a multimodal array. For arrays we mutate the LAST text
 *  item (or push a new one if absent) so the image content stays
 *  intact and ordering matches the string-content path. */
export function appendNoticeToToolResult(
  block: Extract<ContentBlock, { type: 'tool_result' }>,
  notice: string,
): void {
  if (typeof block.content === 'string') {
    block.content = `${block.content}${notice.startsWith('\n') ? '' : '\n\n'}${notice}`;
    return;
  }
  // Walk backwards to find the last text item.
  for (let i = block.content.length - 1; i >= 0; i--) {
    const item = block.content[i]!;
    if (item.type === 'text') {
      block.content[i] = { type: 'text', text: `${item.text}\n\n${notice}` };
      return;
    }
  }
  // No text item — append one so the notice still reaches the model.
  block.content = [...block.content, { type: 'text', text: notice }];
}

/** Collapse an image-bearing tool_result content array into a text-only
 *  string for providers whose tool-result wire format doesn't accept
 *  inline image bytes (OpenAI Chat tool message · Codex Responses
 *  function_call_output · Gemini functionResponse). The image is
 *  replaced with a size note so the model still gets *some* signal
 *  that visual content was produced, just not the bytes. Anthropic
 *  passes the array through verbatim and skips this fallback. */
export function stringifyToolResultContent(content: string | ToolResultContentItem[]): string {
  if (typeof content === 'string') return content;
  return content.map(item => {
    if (item.type === 'text') return item.text;
    // base64 → bytes ratio is ~3/4. Round to KB so the token-cost note
    // stays human-readable.
    const kb = Math.max(1, Math.round((item.base64.length * 3) / 4 / 1024));
    return `[image: ${item.mediaType} (~${kb} KB) — provider does not accept image in tool_result; metadata only]`;
  }).join('\n');
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  /** Plain string for text-only messages; ContentBlock[] when images are mixed in. */
  content: string | ContentBlock[];
}

/** JSONSchema-shaped tool definition sent to the provider (no handler). */
export interface LLMToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSONSchema
}

/** Events produced by a streaming provider call. Text deltas arrive
 *  incrementally; tool_call events are emitted as COMPLETE units once
 *  the provider finishes streaming the tool_use block — callers don't
 *  see partial argument JSON. `usage` is provider-specific telemetry
 *  (currently Anthropic only) — consumers that don't care should
 *  ignore it; `textOnly()` filters it out. */
export type LLMStreamEvent =
  | { type: 'text'; delta: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      args: Record<string, unknown>;
      /** Optional provider-specific tool-call metadata. Currently used
       *  by Gemini OpenAI-compat to round-trip `thought_signature` —
       *  without it, the next-turn API call returns 400 INVALID_ARGUMENT
       *  ("Function call is missing a thought_signature"). Other
       *  providers ignore this field. */
      providerMeta?: ProviderToolMeta;
    }
  /** Reasoning-summary delta from Codex Responses API (gpt-5 family).
   *  `summary_part_added` is a separator marking the boundary between
   *  successive summary parts (think: paragraph break in the model's
   *  internal reasoning trace). `summary_delta` carries the streamed
   *  text within one part. Only emitted when the request body opts in
   *  with `reasoning: { summary: ... }` and `include:
   *  ["reasoning.encrypted_content"]`. Other providers ignore this
   *  event; `textOnly()` filters it out so existing callers see only
   *  the user-visible answer text. */
  | { type: 'reasoning'; kind: 'summary_part_added'; summaryIndex?: number }
  | { type: 'reasoning'; kind: 'summary_delta'; delta: string; summaryIndex?: number }
  /** Inline thinking trace from OpenAI-compat servers that ship
   *  `delta.reasoning_content` (qwen 3.6 / qwen3 thinking variants
   *  via LM Studio, gpt-oss, deepseek-r1). Wire shape mirrors `text`
   *  but is segregated so the dashboard can route it into the
   *  thinking pane instead of the assistant message body. `textOnly()`
   *  filters it out → no behavior change for legacy callers. */
  | { type: 'reasoning'; kind: 'inline_delta'; delta: string }
  /** Server-side image generation result (OpenAI Responses API
   *  `image_generation_call` output item). Emitted when the Codex
   *  provider opted into `serverTools.imageGeneration` and the model
   *  invoked the built-in tool to produce an image. Carries the final
   *  base64 PNG and (optionally) the prompt the server actually used
   *  after its safety-rewrite. Other providers ignore this event;
   *  `textOnly()` filters it out so legacy text consumers see only
   *  the assistant message body. */
  | {
      type: 'image';
      mediaType: string;
      data: string;
      source?: string;
      revisedPrompt?: string;
    }
  | { type: 'usage'; usage: import('./prompt-cache/types.js').LLMUsage };

/** Tool-calling forcing (opencode parity · 2026-07-09). `'auto'` (default) lets
 *  the model decide; `'required'` forces at least one tool call; `'none'` blocks
 *  tools; `{name}` forces a specific tool. ⚠️ In streamLLMWithTools this is applied
 *  ONLY on turn 0 (then auto) — blanket forcing across all turns would prevent the
 *  model from ever emitting a final text answer (loop never terminates). */
export type ToolChoice = 'auto' | 'required' | 'none' | { name: string };

export interface LLMOpts {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Optional per-request usage telemetry from the provider stream. */
  onUsage?(usage: LLMUsage): void;
  /** Optional model role attached to this request's usage observation. */
  usageRole?: ModelRole;
  /**
   * ⭐⭐⭐ `B3`(2026-08-19 · 대표 지시 ②) — ***턴 «안»으로 들어오는 사용자 발화의 배수구.***
   *
   * 대표: *"큐잉된게 설계된 타이밍에 들어가서 인터럽트? 비슷한게 걸리면서 기존 작업을 트리아지 해야"*
   *
   * ⛔ 종전엔 스트리밍 중 친 발화가 ***턴이 «끝난 뒤»***에야 나갔다(입력 루프 경계).
   * ⭐ ref codex(`core/src/session/turn.rs`)는 ***다음 모델 요청을 «만들기 직전»***에 배수한다:
   *     "Pending input is drained into history before building the next model request."
   *   그리고 유예를 «둘» 둔다 — ⓐ 턴 «시작» 직후 ⓑ 오토컴팩트 직후.
   * ⇒ 여기서는 ⓐ 를 그대로 지킨다(첫 바퀴는 원래 입력이 먼저 샘플링돼야 한다).
   *
   * ⚠️ 미주입이면 종전 동작 그대로 — 이 훅이 없으면 아무것도 배수되지 않는다.
   * ⛔ 호출자는 «비우면서» 돌려줘야 한다(같은 발화를 두 번 넣지 않기 위해).
   */
  drainPendingUserInput?: () => readonly string[];
  /** Per-call codex reasoning effort override (codex/gpt-5 family only).
   *  Wins over cfg.codexReasoning + reasoningLevel for THIS call so a
   *  reasoning-heavy op (e.g. 미션 멀티페이즈 분해) can request high/max
   *  effort without mutating global config. Ignored by non-codex providers. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Tool definitions made available to the model for this turn. */
  tools?: LLMToolSpec[];
  /** Tool-calling forcing for THIS turn. In streamLLMWithTools it forces on
   *  turn 0 only, then reverts to auto so the model can finalize. See ToolChoice. */
  toolChoice?: ToolChoice;
  /** Max tool-loop turns for streamLLMWithTools. Defaults to
   *  TOOL_LOOP_MAX_TURNS_DEFAULT (6) — appropriate for chat. Skills
   *  and agents pass higher values (20–30) so multi-phase work has
   *  room to finish before the loop terminates. */
  maxTurns?: number;
  /** Override the slow-tool watchdog tick (ms). Defaults to SLOW_TOOL_TICK_MS.
   *  Primarily a test seam. */
  slowToolTickMs?: number;
  /** Conditional tool-loop budget extension. When a dispatched tool's name
   *  is in `tools`, the loop bound grows by `perCall` (bounded by
   *  `ceiling`). This lets a surface keep the tight per-family cap for
   *  ordinary turns (e.g. codex's re-read pathology brake) while granting
   *  extra rounds ONLY when a genuinely multi-round activity is underway —
   *  e.g. driving a headless coding-agent terminal (SpawnCodingAgentHeadless
   *  + PtyShell Snapshot/Send loop). Absent ⇒ no extension (default). */
  budgetGrant?: { tools: readonly string[]; perCall: number; ceiling: number };
  /** Prompt-caching toggle. Honored by Anthropic (attaches
   *  cache_control markers on system + tools + 2nd-to-last history
   *  message) and OpenAI (passes stream_options.include_usage so
   *  the automatic cache telemetry reaches us). Default `true`.
   *  Pass `false` for tests that pin the legacy wire shape. */
  promptCache?: boolean;
  /** Cache TTL tier. `'5m'` (default) is the ephemeral tier; `'1h'`
   *  is the extended tier (2x creation cost, same read cost).
   *  Anthropic-only; ignored by other providers. */
  promptCacheTTL?: '5m' | '1h';
  /** Test seam — override the Agent batch tick interval. */
  agentBatchTickIntervalMs?: number;
  /** PLAN §4.1 — TurnUri the checkpoint hook attaches captures to.
   *  Optional: when omitted, `streamLLMWithTools` mints a fresh URI so
   *  every tool-loop turn gets a stable checkpoint identity without
   *  forcing existing callers to thread the brand through. */
  turnUri?: TurnUri;
  /** Chat session id forwarded to the AskUserQuestion bridge when the
   *  tool-loop self-dispatches a doom-loop intervention prompt. Lets
   *  PWA / iOS peers receive the prompt natively via the ACP
   *  `elanous/ask/*` envelope instead of the raw `[ASK USER]` text
   *  fallback. Absent for CLI / startup-script callers without a chat
   *  session context. */
  sessionId?: string;
  /** Server-side built-in tools the provider should advertise to the
   *  model alongside the caller-supplied `tools`. Each provider has
   *  its own native catalog (Codex: `image_generation` · `web_search`
   *  · Gemini: `googleSearch` · `codeExecution` · `urlContext`). The
   *  Codex provider currently honors `imageGeneration` — opting in
   *  lets the model spontaneously produce images mid-turn via the
   *  Responses API built-in tool. Streamed results surface as `image`
   *  events on the same stream the assistant text comes through.
   *  Other providers ignore unsupported keys. */
  serverTools?: {
    imageGeneration?: boolean | {
      size?: '1024x1024' | '1024x1536' | '1536x1024' | 'auto';
      quality?: 'low' | 'medium' | 'high' | 'auto';
      background?: 'transparent' | 'opaque' | 'auto';
    };
  };
  /** Unused configured fallbacks. The HTTP retry layer switches provider
   *  after k consecutive overload responses before spending those retries.
   *  Callers that already pinned a provider omit this (0). */
  remainingFallbacks?: number;
}

export interface LLMProvider {
  name: string;               // 'grok' | 'openai' | 'anthropic' | 'local'
  defaultModel: string;
  available(): boolean;
  /** Stream chunks of assistant text. Yields delta strings. Kept for
   *  callers that don't use tools — internally calls streamChat and
   *  filters to text events. */
  chat(messages: LLMMessage[], opts?: LLMOpts): AsyncGenerator<string, void, unknown>;
  /** Stream mixed text + tool_call events. Providers that don't
   *  support tools emit only text events even when opts.tools is set. */
  streamChat?(messages: LLMMessage[], opts?: LLMOpts): AsyncGenerator<LLMStreamEvent, void, unknown>;
}

/** Filter a streamChat generator down to text deltas — lets providers
 *  keep streamChat as the single source of truth and derive chat(). */
export async function* textOnly(events: AsyncGenerator<LLMStreamEvent, void, unknown>): AsyncGenerator<string, void, unknown> {
  for await (const ev of events) {
    if (ev.type === 'text' && ev.delta) yield ev.delta;
  }
}

// ── Wire-format converters ─────────────────────────────────

/** Image-pipeline P3.5 (2026-05-05) — opt-in for the synthetic
 *  follow-up user-message workaround that lets vision-capable OpenAI
 *  Chat / Grok models receive image-bearing tool results despite the
 *  OpenAI Chat Completions spec restricting `role: 'tool'` content
 *  to text-only. When set, an image-bearing tool_result emits BOTH
 *  the standard text-fallback `{role:'tool', content: stringified}`
 *  AND a follow-up `{role:'user', content: [text-marker, image_url]}`
 *  carrying the actual base64 PNG. Caller (provider) drives this
 *  flag from `isVisionCapableModel(brand, model, 'userMessage')` so
 *  non-vision routes (e.g. gpt-3.5-turbo, grok-1) keep the strict
 *  text-only legacy behavior.
 *
 *  P-3 §6.9 (2026-05-07) — `acceptUserMessageImages` (default true)
 *  is the user-message axis sibling. When false, image blocks on
 *  user-role messages collapse to a `[image: <mime>]` text placeholder
 *  before reaching the wire (defensive layer behind composer Q3=B).
 *  Caller drives via the same `isVisionCapableModel(brand, model,
 *  'userMessage')` lookup that picks the followup workaround. */
export interface ToOpenAIMessagesOpts {
  acceptToolImagesViaFollowup?: boolean;
  acceptUserMessageImages?: boolean;
  /** OpenRouter 전용 — 도구 호출이 든 어시스턴트 메시지에 `reasoning_details` 를 되돌린다. 다른 제공자엔 안 싣는다(모르는 칸 400 방지). */
  echoReasoningDetails?: boolean;
}

/**
 * Translate an LLMMessage to zero-or-more OpenAI/Grok/Local wire messages.
 *
 * Most messages produce exactly one wire message, but a user message that
 * carries `tool_result` blocks splits into N `{role:'tool', tool_call_id}`
 * messages — one per block — because the OpenAI spec does not allow
 * multiple tool results in a single message.
 *
 * Assistant `tool_use` blocks fold into the `tool_calls` field (sibling of
 * `content`), not into the content array.
 */
function toOpenAIMessages(
  m: LLMMessage,
  opts: ToOpenAIMessagesOpts = {},
): Array<Record<string, unknown>> {
  if (typeof m.content === 'string') return [{ role: m.role, content: m.content }];

  const blocks = m.content;

  // tool_result blocks → one {role:'tool'} wire message each. If the same
  // LLMMessage also carries text/image/tool_use, emit those as a separate
  // wire message first (so ordering of tool results after the provoking
  // assistant message is preserved).
  const toolResults = blocks.filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
  if (toolResults.length > 0) {
    const others = blocks.filter(b => b.type !== 'tool_result');
    const out: Array<Record<string, unknown>> = [];
    if (others.length > 0) {
      out.push(...toOpenAIMessages({ role: m.role, content: others as ContentBlock[] }, opts));
    }
    for (const r of toolResults) {
      // OpenAI Chat Completions API spec: `role: 'tool'` messages
      // accept `content: string | Array<{type:'text', text}>` only.
      // image_url in tool messages is NOT in the public spec
      // (verified 2026-05 via OpenAI's images-vision guide). So we
      // ALWAYS emit the text-fallback first via
      // stringifyToolResultContent — image bytes collapse to a
      // size-note placeholder for the model's textual context.
      out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: stringifyToolResultContent(r.content) });
      // Image-pipeline P3.5 (2026-05-05) — synthetic follow-up
      // user-message workaround. When the caller opted in (vision-
      // capable OpenAI / Grok model on the userMessage axis), AND
      // the tool_result carries image bytes, emit a follow-up
      // `{role:'user', content: [text, image_url]}` so the model
      // receives the bytes via the supported user-message vision
      // path. Provenance link: the text marker references the
      // tool_use_id so the model can correlate the image with the
      // preceding tool call. Anthropic + Codex Responses don't go
      // through this path (they have native multimodal tool_result
      // wires); Local / non-vision Grok stay on the strict text-only
      // path because their userMessage axis is false.
      if (opts.acceptToolImagesViaFollowup && Array.isArray(r.content)) {
        const followup: Array<Record<string, unknown>> = [];
        let imgCount = 0;
        for (const item of r.content) {
          if (item.type === 'image') {
            imgCount += 1;
            followup.push({
              type: 'image_url',
              image_url: { url: `data:${item.mediaType};base64,${item.base64}` },
            });
          }
        }
        if (imgCount > 0) {
          // Text marker keeps the model anchored — without it the
          // image arrives as a "free-floating" user-message that
          // could be mistaken for a fresh user prompt.
          followup.unshift({
            type: 'text',
            text: `[Image${imgCount > 1 ? 's' : ''} from tool result above (tool_use_id=${r.tool_use_id})]`,
          });
          out.push({ role: 'user', content: followup });
        }
      }
    }
    return out;
  }

  // tool_use blocks → `tool_calls` field on an assistant message. Text
  // blocks (if any) collapse into `content` as a plain string.
  const toolUses = blocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
  if (toolUses.length > 0) {
    const textContent = blocks
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map(b => b.text)
      .join('');
    const reasoningDetails = opts.echoReasoningDetails
      ? toolUses.find((t) => t.providerMeta?.reasoningDetails?.length)?.providerMeta?.reasoningDetails
      : undefined;
    return [{
      role: m.role,
      content: textContent || null,
      ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
      tool_calls: toolUses.map(t => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.input) },
        // Round-trip Gemini's extra_content.google.thought_signature
        // when the original tool_call had one. Other providers leave
        // providerMeta undefined and this branch is skipped, so the
        // wire payload stays identical for openai/grok/codex/anthropic.
        ...(t.providerMeta?.thoughtSignature !== undefined
          ? { extra_content: { google: { thought_signature: t.providerMeta.thoughtSignature } } }
          : {}),
      })),
    }];
  }

  // Plain text/image/audio: the original Phase-8 mapping +
  // §3.4 audio routing.
  // P-3 §6.9 (2026-05-07) — user-message image gate (default accept).
  // Composer Q3=B is the primary handler; this is the wire-side
  // defensive fallback for non-vision OpenAI / Grok / local routes.
  const acceptUserImages = opts.acceptUserMessageImages ?? true;
  return [{
    role: m.role,
    content: blocks.map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text };
      if (block.type === 'image') {
        if (m.role === 'user' && !acceptUserImages) {
          return { type: 'text', text: `[image: ${block.mediaType} (model not vision-capable)]` };
        }
        return { type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.base64}` } };
      }
      if (block.type === 'audio') {
        // OpenAI Chat Completions audio routing — only
        // gpt-4o-audio-preview + gpt-4o-realtime-preview accept
        // input_audio. Other models would 400 on the field; we drop
        // to a text placeholder per the vision-fallback pattern.
        // Format inferred from mediaType — wav / mp3 / ogg / flac.
        // The wire wants 'wav' | 'mp3' (no 'ogg'/'flac'). For
        // unsupported codecs we fall back to placeholder so the
        // request doesn't 400 at provider boundary.
        const fmt = openAIAudioFormat(block.mediaType);
        if (!fmt) {
          return { type: 'text', text: `[audio: ${block.mediaType} (unsupported codec)]` };
        }
        return { type: 'input_audio', input_audio: { data: block.base64, format: fmt } };
      }
      if (block.type === 'video') {
        // PR8 (2026-05-14) — OpenAI Chat Completions API does NOT
        // accept video. The Realtime Video API is a separate WebSocket
        // endpoint (not in elanous's Chat Completions routing). Drop to
        // text placeholder so the request doesn't 400. Caller should
        // pre-filter via providerSupportsVideo() AND send key-frame
        // images as siblings (iOS PR5/PR6 default path).
        return { type: 'text', text: `[video: ${block.mediaType} (OpenAI Chat Completions does not accept video — key-frame images recommended)]` };
      }
      return { type: 'text', text: '' };   // unreachable
    }),
  }];
}

function openAIAudioFormat(mimeType: string): 'wav' | 'mp3' | null {
  const mt = mimeType.toLowerCase();
  if (mt.includes('wav') || mt.includes('wave')) return 'wav';
  if (mt.includes('mp3') || mt.includes('mpeg')) return 'mp3';
  // OpenAI Chat Completions audio API only supports wav + mp3 as of
  // 2026-04. ogg/flac/m4a need a server-side transcode (out of
  // scope for this PR — caller should pre-transcode).
  return null;
}

/**
 * Single-message variant for call sites that can guarantee no splitting
 * (text/image content only). Throws if the LLMMessage would expand — use
 * `toOpenAIMessages` for messages that may carry `tool_result` blocks.
 */
function toOpenAIMessage(m: LLMMessage): Record<string, unknown> {
  const arr = toOpenAIMessages(m);
  if (arr.length === 1) return arr[0]!;
  throw new Error(`LLMMessage expanded to ${arr.length} wire messages — use toOpenAIMessages`);
}

/** Translate an LLMMessage to the Anthropic wire format.
 *
 *  P-3 §6.9 (2026-05-07) — `acceptUserMessageImages` defends against
 *  user-message images on non-vision Claude variants. Default `true`
 *  (current Claude 3.5+ all support vision per the allowlist), but
 *  call sites pass `isVisionCapableModel('anthropic', model, 'userMessage')`
 *  so a future text-only Claude variant — or an explicit Q3=B kill
 *  switch — falls back to a text placeholder instead of a 400. The
 *  composer (Q3=B toast + skip) still does the user-facing handling;
 *  this is purely the wire-side guardrail. Assistant-role images and
 *  tool_result images are unaffected. */
function toAnthropicMessage(
  m: LLMMessage,
  opts: { acceptUserMessageImages?: boolean } = {},
): { role: string; content: unknown } {
  const acceptUserImages = opts.acceptUserMessageImages ?? true;
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: m.content.map(block => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text };
        case 'image':
          if (m.role === 'user' && !acceptUserImages) {
            return { type: 'text', text: `[image: ${block.mediaType} (model not vision-capable)]` };
          }
          return { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.base64 } };
        case 'audio':
          // Anthropic does not accept audio content blocks as of
          // 2026-04 — encode as a text placeholder so the message
          // still reaches the model. Caller should prepend a
          // transcript text block via buildTranscribedVoiceBlocks
          // when the user wants the audio content reflected.
          return { type: 'text', text: `[audio: ${block.mediaType}]` };
        case 'video':
          // PR8 (2026-05-14) — Anthropic Messages API does NOT accept
          // video content blocks as of 2026-05. Caller should either
          // (a) pre-filter via providerSupportsVideo() before sending,
          // or (b) accept the placeholder + send key-frame images as
          // siblings (iOS PR5/PR6 default path).
          return { type: 'text', text: `[video: ${block.mediaType} (Anthropic Chat Completions does not accept video — key-frame images recommended)]` };
        case 'tool_use':
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            // Array content (image-bearing tool result, WT-C-2) maps
            // each ToolResultContentItem to Anthropic's nested wire
            // shape: text → {type:'text',text}, image → {type:'image',
            // source:{type:'base64', media_type, data}}. String
            // content passes through unchanged.
            content: typeof block.content === 'string'
              ? block.content
              : block.content.map(item => {
                  if (item.type === 'text') return { type: 'text', text: item.text };
                  return {
                    type: 'image',
                    source: { type: 'base64', media_type: item.mediaType, data: item.base64 },
                  };
                }),
            ...(block.isError ? { is_error: true } : {}),
          };
      }
    }),
  };
}

/**
 * Anthropic requires `system` to be a top-level string field; for multimodal
 * system messages we collapse any text blocks into a single string and drop
 * image blocks (Anthropic rejects images in system messages).
 */
function systemToAnthropicString(messages: LLMMessage[]): string {
  const parts: string[] = [];
  for (const m of messages.filter(x => x.role === 'system')) {
    if (typeof m.content === 'string') parts.push(m.content);
    else for (const b of m.content) if (b.type === 'text') parts.push(b.text);
  }
  return parts.join('\n\n');
}

// ── OpenAI-compatible streaming parser (works for Grok, OpenAI, Local) ──
//
// Yields LLMStreamEvent. Tool-call fragments are accumulated by their
// `index` field across multiple SSE chunks and emitted as ONE complete
// event when the provider sets finish_reason='tool_calls'. Text deltas
// flow through unmodified.

interface OpenAIToolCallAccum {
  id: string;
  name: string;
  argsJson: string;
  /** Gemini OpenAI-compat sends `extra_content.google.thought_signature`
   *  alongside each tool_call delta. The same signature must be echoed
   *  back in the assistant message tool_calls when the loop relays the
   *  tool result, otherwise Gemini rejects the request with 400
   *  INVALID_ARGUMENT. Captured here, propagated through the
   *  tool_call event's providerMeta. Other providers leave undefined. */
  thoughtSignature?: string;
}

// ─── OpenAI Harmony channel filter ──────────────────────────────────
//
// gpt-oss / gemma-4 / qwen3-thinking et al. emit OpenAI Harmony tokens
// into `delta.content` when LM Studio (or vLLM / Ollama) passes the
// model's native channel-formatted output through the OpenAI-compat
// `/v1/chat/completions` endpoint without stripping markers.
//
// Spec (https://developers.openai.com/cookbook/articles/openai-harmony +
// https://github.com/openai/harmony · verified via omni-crawl 2026-05-14):
//   - `<|start|>{role}[<|channel|>{channel} [to=...] [<|constrain|>json]] <|message|>{content}{<|end|>|<|return|>|<|call|>}`
//   - Channels (assistant-only): `final` (user-facing) · `analysis`
//     (internal CoT) · `commentary` (tool calls / preambles).
//   - Some non-OpenAI fine-tunes use `thought` as an alias for
//     `analysis` (seen with `mlx-community/gemma-4-26b-a4b-it` on
//     LM Studio 2026-05-14 dogfood).
//
// Routing policy:
//   - `final` channel content → user-facing text delta (text)
//   - `analysis` / `thought` → reasoning delta (renders in thinking pane)
//   - `commentary` → reasoning delta (lower-stakes; tool calls themselves
//     arrive via the OpenAI `tool_calls` API path, not via channel
//     content)
//   - Unknown channel → reasoning delta (safer than discarding)
//
// Marker tokens consumed (never emitted as content):
//   `<|start|>` `<|end|>` `<|return|>` `<|call|>` `<|message|>` `<|channel|>` `<|constrain|>`
//
// Backwards compat: when the stream NEVER produces a `<|channel|>` or
// `<|start|>` marker, all content passes through as text unchanged —
// existing non-Harmony providers (Anthropic, Codex, vanilla OpenAI,
// Gemini) see no behavior change.
//
// Stream safety: deltas may split markers mid-token. The filter
// buffers the trailing unrecognised prefix (potential partial marker)
// until either the marker completes or it's proven to NOT be a marker.

interface HarmonyToolCall {
  name: string;
  argsJson: string;
}

interface HarmonyFilterOutput {
  textDelta: string;
  reasoningDelta: string;
  /** Tool calls decoded from the Harmony `commentary to=functions.X …
   *  <|call|>` channel. gemma-4 / gpt-oss on LM Studio route tool calls
   *  through channel *content* (not the native OpenAI `tool_calls`
   *  field), so without this they were silently rendered as reasoning
   *  text and never executed. Undefined on normal streams. */
  toolCalls?: HarmonyToolCall[];
}

type HarmonyState = 'pre' | 'header' | 'header_broken' | 'body';
type HarmonyChannel = 'final' | 'analysis' | 'thought' | 'commentary' | 'unknown';

const HARMONY_MARKERS = [
  '<|start|>',
  '<|end|>',
  '<|return|>',
  '<|call|>',
  '<|message|>',
  '<|channel|>',
  '<|constrain|>',
  // 2026-05-14 dogfood — tolerant variants for fine-tunes that emit
  // malformed Harmony tokens. mlx-community/gemma-4-26b-a4b-it on
  // LM Studio streams `<|channel>thought\n<channel|>` instead of
  // the spec `<|channel|>thought<|message|>...<|end|>`. We treat:
  //   - `<|channel>`  as a "broken open" — channel name follows
  //                   inline (header-broken state), terminated by
  //                   the next whitespace; body starts immediately
  //                   without `<|message|>`.
  //   - `<channel|>`  as a "broken close" — equivalent to `<|end|>`.
  // The classic `<|channel|>` (with both pipes) still works.
  '<|channel>',
  '<channel|>',
] as const;

class HarmonyChannelFilter {
  private buffer = '';
  private state: HarmonyState = 'pre';
  private channel: HarmonyChannel = 'unknown';
  private headerBuffer = '';
  private harmonySeen = false;
  // Harmony tool-call decoding: gemma-4 / gpt-oss emit tool calls via
  // the `commentary to=functions.X` channel + `<|call|>` terminator
  // instead of the native tool_calls field. `pendingToolName` is set
  // while a tool-call body streams; its content buffers into
  // `toolArgsBuffer`; finalized calls collect in `completedToolCalls`
  // and drain out on each push()/flush().
  private pendingToolName: string | null = null;
  private toolArgsBuffer = '';
  private completedToolCalls: HarmonyToolCall[] = [];
  // Set after a `<|constrain|>` marker so the trailing constraint value
  // (e.g. `json`) is swallowed instead of corrupting the header/tool
  // name. Cleared when a new header starts or the body begins.
  private headerSwallow = false;

  push(chunk: string): HarmonyFilterOutput {
    this.buffer += chunk;
    let textOut = '';
    let reasoningOut = '';

    while (this.buffer.length > 0) {
      // Locate the next `<` (potential marker start). All Harmony
      // markers — both spec (`<|channel|>`, `<|end|>`, ...) and the
      // gemma-4 tolerant variants (`<|channel>`, `<channel|>`) —
      // begin with `<`. Scanning on bare `<` instead of `<|` is the
      // only way the broken-close `<channel|>` (no leading `<|`)
      // gets reached. False positives (legitimate `<` in content,
      // e.g. `2 < 3`) cost a single literal-emit iteration each.
      const markerStart = this.buffer.indexOf('<');
      const safeEnd = markerStart === -1 ? this.buffer.length : markerStart;

      // Flush safe content (before any `<`) to the current sink.
      if (safeEnd > 0) {
        const safe = this.buffer.slice(0, safeEnd);
        this.routeContent(safe, (text, reasoning) => {
          textOut += text;
          reasoningOut += reasoning;
        });
        this.buffer = this.buffer.slice(safeEnd);
      }

      // No marker start at all → done.
      if (markerStart === -1) break;

      // Try to consume a complete marker at the buffer head.
      const consumed = this.tryConsumeMarker();
      if (consumed === 'partial') {
        // Wait for more chunks to complete the marker.
        break;
      }
      if (consumed === 'consumed') {
        // Marker ate buffer prefix · loop continues.
        continue;
      }
      // `consumed === 'literal'` — buffer starts with `<` but it's
      // not a Harmony marker (legitimate content `<foo>`, `2 < 3`).
      // Emit the leading `<` as content and let the loop reprocess
      // the rest.
      this.routeContent(this.buffer[0]!, (text, reasoning) => {
        textOut += text;
        reasoningOut += reasoning;
      });
      this.buffer = this.buffer.slice(1);
    }

    return this.drain(textOut, reasoningOut);
  }

  /** Flush any trailing buffered partial-marker state as if it were
   *  literal content. Called on stream end so a half-formed `<|cha`
   *  doesn't get silently dropped. */
  flush(): HarmonyFilterOutput {
    let textOut = '';
    let reasoningOut = '';
    if (this.buffer.length > 0) {
      this.routeContent(this.buffer, (text, reasoning) => {
        textOut += text;
        reasoningOut += reasoning;
      });
      this.buffer = '';
    }
    // Stream ended mid tool-call (no explicit terminator) — emit what
    // we have so a trailing call isn't lost.
    this.finalizePendingTool();
    return this.drain(textOut, reasoningOut);
  }

  private routeContent(
    content: string,
    sink: (text: string, reasoning: string) => void,
  ): void {
    if (content.length === 0) return;
    if (this.state === 'header') {
      // Accumulate header text — parsed on `<|message|>`. After a
      // `<|constrain|>` marker the constraint value (e.g. `json`) is
      // swallowed so it doesn't get appended to the tool name.
      if (!this.headerSwallow) this.headerBuffer += content;
      return;
    }
    if (this.state === 'header_broken') {
      // gemma-4 variant: channel name follows `<|channel>` inline,
      // terminated by the first whitespace/newline. Anything before
      // the whitespace is the channel name; whitespace itself
      // terminates the header + enters BODY (no `<|message|>`
      // needed). Body content (if any) follows in subsequent
      // routeContent calls.
      for (let i = 0; i < content.length; i++) {
        const ch = content[i]!;
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
          this.applyParsedHeader(this.headerBuffer);
          this.headerBuffer = '';
          this.state = 'body';
          // Remaining content after the terminating whitespace
          // belongs to the body — recurse with the tail. The
          // whitespace itself is swallowed (it's the header
          // terminator, not content).
          const tail = content.slice(i + 1);
          if (tail.length > 0) this.routeContent(tail, sink);
          return;
        }
        this.headerBuffer += ch;
      }
      return;
    }
    if (this.state === 'pre') {
      // Before any Harmony marker: pass content as text for
      // backwards compat with non-Harmony streams. Once we've seen
      // a marker, content in `pre` is discarded (it's between
      // messages — `<|end|>{...}<|start|>` whitespace etc.).
      if (!this.harmonySeen) {
        sink(content, '');
      }
      return;
    }
    // state === 'body'
    if (this.pendingToolName !== null) {
      // Harmony tool-call args JSON — buffer for emission on the
      // terminator marker instead of leaking into reasoning text.
      this.toolArgsBuffer += content;
      return;
    }
    switch (this.channel) {
      case 'final':
        sink(content, '');
        break;
      case 'analysis':
      case 'thought':
      case 'commentary':
      case 'unknown':
        sink('', content);
        break;
    }
  }

  /** Attempt to consume a marker at the current buffer head.
   *  Returns:
   *    - 'consumed' if a full marker was recognised and consumed
   *    - 'partial' if the buffer head is a prefix of a known marker
   *      (caller should wait for more input)
   *    - 'literal' if the `<|` is followed by non-marker text */
  private tryConsumeMarker(): 'consumed' | 'partial' | 'literal' {
    for (const marker of HARMONY_MARKERS) {
      if (this.buffer.startsWith(marker)) {
        this.buffer = this.buffer.slice(marker.length);
        this.handleMarker(marker);
        return 'consumed';
      }
    }
    // Buffer head is `<|` but no full marker yet — is it a prefix?
    for (const marker of HARMONY_MARKERS) {
      if (marker.startsWith(this.buffer)) return 'partial';
    }
    return 'literal';
  }

  private handleMarker(marker: string): void {
    this.harmonySeen = true;
    switch (marker) {
      case '<|channel|>':
        this.state = 'header';
        this.headerBuffer = '';
        this.headerSwallow = false;
        break;
      case '<|channel>':
        // gemma-4 broken-open variant — no trailing `|`. Channel
        // name follows inline, terminated by whitespace, body
        // starts immediately (no `<|message|>` separator).
        this.state = 'header_broken';
        this.headerBuffer = '';
        this.headerSwallow = false;
        break;
      case '<|message|>':
        // Header complete; parse channel + optional tool target.
        this.applyParsedHeader(this.headerBuffer);
        this.headerBuffer = '';
        this.state = 'body';
        break;
      case '<|end|>':
      case '<|return|>':
      case '<|call|>':
      case '<channel|>':
        // `<|call|>` is the Harmony tool-call terminator; `<|end|>` /
        // `<|return|>` end a normal message; `<channel|>` is the gemma-4
        // broken-close variant. Finalize any pending tool-call body on
        // all of them (gemma-4 occasionally closes a call with the
        // broken `<channel|>` rather than the spec `<|call|>`).
        this.finalizePendingTool();
        this.state = 'pre';
        this.channel = 'unknown';
        this.headerBuffer = '';
        break;
      case '<|start|>':
        // Start of a new message — wait for `<|channel|>` to set
        // routing. Finalize a dangling tool call first (malformed
        // boundary) so it isn't lost. State stays 'pre' until then.
        this.finalizePendingTool();
        this.state = 'pre';
        this.channel = 'unknown';
        this.headerBuffer = '';
        break;
      case '<|constrain|>':
        // `<|constrain|>json` appears in the header before
        // `<|message|>` — swallow the constraint value so it doesn't
        // corrupt the tool name (the decode implies json).
        this.headerSwallow = true;
        break;
    }
  }

  /** Parse a completed Harmony header into channel + optional tool
   *  target, and prime tool-call buffering when a `to=functions.X`
   *  target is present. */
  private applyParsedHeader(header: string): void {
    const { channel, toolName } = parseHarmonyHeader(header);
    this.channel = channel;
    this.pendingToolName = toolName;
    this.toolArgsBuffer = '';
    this.headerSwallow = false;
  }

  /** Emit the in-flight Harmony tool call (if any) into the completed
   *  queue and reset the buffers. No-op when no tool call is pending. */
  private finalizePendingTool(): void {
    if (this.pendingToolName === null) return;
    this.completedToolCalls.push({
      name: this.pendingToolName,
      argsJson: this.toolArgsBuffer,
    });
    this.pendingToolName = null;
    this.toolArgsBuffer = '';
  }

  /** Build the output object, draining any completed tool calls. */
  private drain(textOut: string, reasoningOut: string): HarmonyFilterOutput {
    const out: HarmonyFilterOutput = { textDelta: textOut, reasoningDelta: reasoningOut };
    if (this.completedToolCalls.length > 0) {
      out.toolCalls = this.completedToolCalls;
      this.completedToolCalls = [];
    }
    return out;
  }
}

function parseHarmonyHeader(header: string): { channel: HarmonyChannel; toolName: string | null } {
  // Header shape: `final` · `analysis` · `commentary` ·
  // `commentary to=functions.X` · `final to=user`. The channel is the
  // first whitespace-delimited token; a `to=functions.NAME` (or bare
  // `to=NAME`) marks a tool call. `to=user`/`to=assistant` are message
  // routing, not tool calls.
  const trimmed = header.trim();
  const first = trimmed.split(/\s+/)[0]?.toLowerCase() ?? '';
  const channel: HarmonyChannel =
    first === 'final' ? 'final'
      : first === 'analysis' ? 'analysis'
        : first === 'thought' ? 'thought'
          : first === 'commentary' ? 'commentary'
            : 'unknown';
  const m = trimmed.match(/to=(?:functions\.)?([A-Za-z0-9_.\-]+)/i);
  const raw = m ? m[1]! : null;
  const rawLower = raw?.toLowerCase();
  const toolName = raw && rawLower !== 'user' && rawLower !== 'assistant' ? raw : null;
  return { channel, toolName };
}

/** Pure SSE-line parser: takes an iterable of raw `data: ...` lines
 *  (already split + trimmed) and yields LLMStreamEvent. Exported for
 *  unit tests — no fetch dependency. */
export async function* parseOpenAISSELines(
  lines: AsyncIterable<string> | Iterable<string>,
): AsyncGenerator<LLMStreamEvent, void, unknown> {
  const { parseOpenAIUsage } = await import('./prompt-cache/openai.js');
  // Indexed by `tc.index` (OpenAI standard) — partial-chunk streaming
  // assembles into a single accumulator per index. Gemini OpenAI-compat
  // (verified 2026-05-03) emits MULTIPLE complete tool_calls in the
  // same SSE response with identical `index: 0` but different `id`s;
  // those are detected via id-change and flushed as separate events
  // before the next call starts (see id-change branch below).
  const toolCalls: Map<number, OpenAIToolCallAccum> = new Map();
  // OpenRouter `reasoning_details` 조각을 (type,index) 별로 이어 붙인다 — 첫 도구 호출 이벤트에 한 번 싣는다.
  const reasoningDetailsAcc: Map<string, Record<string, unknown>> = new Map();
  let reasoningDetailsAttached = false;
  const takeReasoningDetails = (): Array<Record<string, unknown>> | undefined => {
    if (reasoningDetailsAttached || reasoningDetailsAcc.size === 0) return undefined;
    reasoningDetailsAttached = true;
    return [...reasoningDetailsAcc.values()];
  };
  const yieldAccum = (acc: OpenAIToolCallAccum): LLMStreamEvent | null => {
    if (!acc.name) return null;
    let args: Record<string, unknown> = {};
    try { args = acc.argsJson ? JSON.parse(acc.argsJson) : {}; } catch { /* empty */ }
    const reasoningDetails = takeReasoningDetails();
    const meta: ProviderToolMeta = {
      ...(acc.thoughtSignature !== undefined ? { thoughtSignature: acc.thoughtSignature } : {}),
      ...(reasoningDetails ? { reasoningDetails } : {}),
    };
    return {
      type: 'tool_call',
      id: acc.id,
      name: acc.name,
      args,
      ...(Object.keys(meta).length > 0 ? { providerMeta: meta } : {}),
    };
  };
  // Per-stream Harmony filter — routes `<|channel|>final` content to
  // text and `<|channel|>analysis/thought/commentary` content to
  // reasoning. No-op on streams that never emit Harmony markers, so
  // OpenAI/Anthropic/Gemini compat paths are unchanged.
  const harmony = new HarmonyChannelFilter();
  let harmonyToolSeq = 0;
  // Harmony-decoded tool calls (gemma-4 / gpt-oss `commentary
  // to=functions.X` channel) share the native `tool_call` event shape;
  // ids are synthesized since the channel form carries none.
  const emitHarmonyTools = function* (tcs: HarmonyToolCall[] | undefined): Generator<LLMStreamEvent> {
    for (const tc of tcs ?? []) {
      let args: Record<string, unknown> = {};
      try { args = tc.argsJson ? JSON.parse(tc.argsJson) : {}; } catch { /* keep {} on malformed args */ }
      yield { type: 'tool_call', id: `harmony_${++harmonyToolSeq}`, name: tc.name, args };
    }
  };
  for await (const line of lines as AsyncIterable<string>) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') continue;
    let parsed: any;
    try { parsed = JSON.parse(data); } catch { continue; }

    // The final chunk (when stream_options.include_usage:true is set)
    // carries `usage` alongside an empty `choices` array or no
    // choices at all. Extract before the choice-required path below.
    const usage = parseOpenAIUsage(parsed);
    if (usage) yield { type: 'usage', usage };

    const choice = parsed.choices?.[0];
    if (!choice) continue;

    const textDelta = choice.delta?.content;
    if (textDelta) {
      // Route delta.content through the Harmony filter. For non-
      // Harmony streams the filter passes content through verbatim
      // as text. For Harmony streams (gpt-oss / gemma-4-a4b /
      // qwen3-thinking via LM Studio) the filter consumes channel
      // markers and routes `final` → text, `analysis|thought|
      // commentary` → reasoning_content. Origin: 2026-05-14 iOS
      // dogfood — channel markers were leaking raw into chat
      // bubbles and the `final` channel never fired, so the tool
      // loop budget exhausted into a `[NO FINAL SYNTHESIS]`
      // fallback.
      const routed = harmony.push(textDelta);
      if (routed.textDelta.length > 0) yield { type: 'text', delta: routed.textDelta };
      if (routed.reasoningDelta.length > 0) {
        yield { type: 'reasoning', kind: 'inline_delta', delta: routed.reasoningDelta };
      }
      yield* emitHarmonyTools(routed.toolCalls);
    }

    // OpenAI-compat extension: thinking models (qwen 3.6 / qwen3
    // thinking, gpt-oss, deepseek-r1) stream their hidden chain-of-
    // thought into `delta.reasoning_content` BEFORE the visible
    // `delta.content` arrives. LM Studio passes this through as-is.
    // Surfaced as `kind: 'inline_delta'` so the dashboard's thinking
    // line / pane can render it; `textOnly()` filters it from chat
    // history so prior-conversation persistence stays unchanged.
    // ⛔ 2026-09-23 — OpenRouter 는 같은 것을 ***`delta.reasoning`***(⊕ `reasoning_details`)으로 흘린다(원시 SSE 실측:
    //   glm-5.3 한 판에 reasoning 53 · content 1). 종전엔 이 칸을 몰라 추론하는 동안 이벤트가 «0개»였고,
    //   큰 프롬프트에서 추론이 45초를 넘자 유휴 타임아웃이 하니스 자식을 매번 빈 턴으로 죽였다(evCount 0 · 200 OK).
    const detailsDelta = (choice.delta as { reasoning_details?: unknown } | undefined)?.reasoning_details;
    if (Array.isArray(detailsDelta)) {
      for (const raw of detailsDelta) {
        if (!raw || typeof raw !== 'object') continue;
        const d = raw as Record<string, unknown>;
        const key = `${String(d.type ?? '')}:${String(d.index ?? 0)}`;
        const prev = reasoningDetailsAcc.get(key);
        if (!prev) { reasoningDetailsAcc.set(key, { ...d }); continue; }
        for (const [k, v] of Object.entries(d)) {
          if ((k === 'text' || k === 'summary') && typeof v === 'string' && typeof prev[k] === 'string') prev[k] = (prev[k] as string) + v;
          else if (v !== null && v !== undefined) prev[k] = v;
        }
      }
    }
    const reasoningDelta = choice.delta?.reasoning_content
      ?? (typeof (choice.delta as { reasoning?: unknown } | undefined)?.reasoning === 'string'
        ? (choice.delta as { reasoning: string }).reasoning
        : undefined);
    if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
      yield { type: 'reasoning', kind: 'inline_delta', delta: reasoningDelta };
    }

    const tcFrags = choice.delta?.tool_calls;
    if (Array.isArray(tcFrags)) {
      for (const tc of tcFrags) {
        const idx = tc.index ?? 0;
        let accum = toolCalls.get(idx);
        // Gemini-quirk handling: when a new `tc.id` arrives at the same
        // index AND we already have a completed call (name + args) in
        // that slot, treat this as a new parallel call. Yield the
        // existing one first, then start fresh. Without this, the
        // string-concat of `argsJson` would produce invalid JSON like
        // `{"a":1}{"b":2}` and JSON.parse would fail to {} silently.
        // OpenAI-standard streaming sends partial chunks that share id
        // (or omit id on continuation frags), so this only triggers on
        // the Gemini complete-frag pattern.
        if (accum && tc.id && accum.id && tc.id !== accum.id && accum.argsJson.length > 0) {
          const ev = yieldAccum(accum);
          if (ev) yield ev;
          accum = undefined;
          toolCalls.delete(idx);
        }
        if (!accum) {
          accum = { id: '', name: '', argsJson: '' };
          toolCalls.set(idx, accum);
        }
        if (tc.id) accum.id = tc.id;
        if (tc.function?.name) accum.name = tc.function.name;
        if (tc.function?.arguments) accum.argsJson += tc.function.arguments;
        // Gemini extra_content.google.thought_signature — required for
        // round-trip on subsequent turns (see OpenAIToolCallAccum
        // .thoughtSignature comment).
        const ts = tc.extra_content?.google?.thought_signature;
        if (typeof ts === 'string' && ts.length > 0) {
          accum.thoughtSignature = ts;
        }
        if (debug.enabled) {
          debug.log('llm.sse-frag', 'tool-call-delta', {
            idx,
            id: tc.id,
            name: tc.function?.name,
            argsLen: tc.function?.arguments?.length,
            hasThoughtSig: !!ts,
          });
        }
      }
    }

    // Yield tool_calls when the stream signals end-of-turn AND we have
    // accumulated calls. Standard OpenAI uses `finish_reason ===
    // 'tool_calls'`, but provider variation exists:
    //
    // - **Gemini OpenAI-compat** (generativelanguage.googleapis.com/
    //   v1beta/openai/chat/completions, verified 2026-05-03 via
    //   /tmp/gemini-tool-probe.ts): emits the function-call delta in
    //   one chunk, then a SECOND chunk with `finish_reason: "stop"`
    //   instead of `"tool_calls"`. Without this widening, every
    //   gemini tool-call run emitted 0 tool-call events and the
    //   tool-loop early-exited as an empty turn.
    //
    // The guard `toolCalls.size > 0` prevents false positives when a
    // pure-text response naturally ends with `finish_reason: "stop"`.
    // Provider-agnostic so local LLMs / future providers automatically
    // benefit from the same widened parsing.
    if (
      (choice.finish_reason === 'tool_calls'
        || (choice.finish_reason && toolCalls.size > 0))
    ) {
      for (const [, tc] of toolCalls) {
        const ev = yieldAccum(tc);
        if (ev) yield ev;
      }
      toolCalls.clear();
    }
  }
  // Flush any trailing partial Harmony marker as literal content so a
  // truncated `<|cha` doesn't get silently dropped at stream end.
  const tail = harmony.flush();
  if (tail.textDelta.length > 0) yield { type: 'text', delta: tail.textDelta };
  if (tail.reasoningDelta.length > 0) {
    yield { type: 'reasoning', kind: 'inline_delta', delta: tail.reasoningDelta };
  }
  yield* emitHarmonyTools(tail.toolCalls);
}

/** Pick a stable provider name for `fetchApiWithRetry` telemetry from
 *  the request URL. The OpenAI streamer is shared by openai/grok/local
 *  endpoints — all three pass through here. The string lands in the
 *  `llm.retry` debug snapshot and the `ApiHttpError.provider` field. */
/** Retries still left for this HTTP call. Callers that already know a
 *  fallback remains pass it so overload switches before those retries. */
function retryOptsFor(
  provider: string,
  errorPrefix: string,
  remainingFallbacks?: number,
): FetchApiWithRetryOpts {
  return {
    provider,
    errorPrefix,
    ...(remainingFallbacks !== undefined && remainingFallbacks > 0 ? { remainingFallbacks } : {}),
  };
}

function inferOpenAIProviderName(url: string): string {
  if (url.includes('x.ai')) return 'grok';
  if (url.includes('openai.com')) return 'openai';
  if (url.includes('localhost') || url.includes('127.0.0.1')) return 'local';
  return 'openai-compatible';
}

async function* streamOpenAIEvents(
  url: string,
  apiKey: string | undefined,
  body: any,
  signal?: AbortSignal,
  /** 프로바이더별 «필수» 추가 헤더. 현재 소비자는 grok 구독 프록시 —
   *  `x-grok-client-version` 이 빠지면 HTTP 426 으로 거절된다(실측).
   *  ⛔ 생략하면 종전과 «바이트 동일** — 기존 호출자 무회귀. */
  extraHeaders?: Record<string, string>,
  remainingFallbacks?: number,
): AsyncGenerator<LLMStreamEvent, void, unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const startedAt = Date.now();
  // Summary fields are enough for forensic triage. The full raw body
  // (system prompt + every tool schema + all messages) is tens of KB
  // per event and we fire this once per turn — default mode strips
  // it. Flip `/debug verbose on` to restore the raw `body` field for
  // deep reproduction of a failing LLM call.
  debug.log('llm.request', `POST ${url}`, {
    model: body?.model,
    messages: Array.isArray(body?.messages) ? body.messages.length : undefined,
    tools: observeRequestTools(body?.tools),
    temperature: body?.temperature,
    maxTokens: body?.max_tokens,
    ...(debug.isVerboseEnabled() ? { body: redactSecrets(body) } : {}),
  });

  const response = await fetchApiWithRetry(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    },
    retryOptsFor(inferOpenAIProviderName(url), 'LLM API', remainingFallbacks),
  );

  debug.log('llm.response.status', `${response.status} ${response.statusText || ''}`.trim(), {
    url, status: response.status,
    elapsedMs: Date.now() - startedAt,
  });

  let textChars = 0;
  let toolCalls = 0;
  try {
    for await (const ev of parseOpenAISSELines(sseLineStream(response.body!))) {
      if (ev.type === 'text') textChars += ev.delta.length;
      else if (ev.type === 'tool_call') toolCalls++;
      yield ev;
    }
    debug.log('llm.response.complete', 'stream done', {
      durationMs: Date.now() - startedAt,
      textChars, toolCalls,
    });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      debug.log('llm.response.aborted', 'user/timeout abort', {
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    debug.log('llm.response.error', err?.message || String(err), {
      durationMs: Date.now() - startedAt,
    }, { level: 'error' });
    throw err;
  }
}

/** Read a fetch response body as an async iterable of SSE lines. */
async function* sseLineStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) yield line;
  }
  if (buffer) yield buffer;
}

// ── OpenAI Responses API (Codex backend uses this, NOT /chat/completions) ──
//
// Event stream format:
//   data: {"type":"response.output_text.delta","delta":"Hello"}
//   data: {"type":"response.completed","response":{...}}
//
// Request body differs from chat/completions: `instructions` (string,
// from system msgs) + `input` (array of role/content blocks using
// input_text type). Codex specifically REJECTS max_output_tokens and
// temperature — hermes documents this caveat; we mirror it.

/** Convert elanous LLMMessage[] → Codex Responses API input shape.
 *  System messages concat into `instructions`. Everything else flows
 *  into `input[]` as {role, content:[{type:'input_text', text}]}.
 *  Multimodal blocks get their text extracted (images currently
 *  dropped — Codex supports input_image but we defer that to a
 *  follow-up so the text-only happy path lands first). */
/** Content-block union emitted to the OpenAI Responses API /responses
 *  endpoint. `input_text` + `output_text` are the text carriers;
 *  `input_image` is multimodal user input (data URI or remote URL),
 *  only valid on user/tool messages — assistant messages are
 *  output-only. `detail: 'auto'` lets OpenAI pick low/high automatically. */
type ResponsesContentBlock =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'auto' | 'low' | 'high' };

/** Top-level input items for the Codex Responses API, mirroring the
 *  ResponseItem variants in `ref/codex/codex-rs/protocol/src/models.rs`
 *  (`#[serde(tag = "type", rename_all = "snake_case")]`).
 *
 *  - Plain text/image messages are emitted WITHOUT an explicit `type`
 *    field — historically that's how monad-agent has always shaped them
 *    and the Codex backend accepts it as the implicit `message`
 *    variant. Don't change that for the existing path: prior chat works
 *    on this shape and we don't want to risk a wire regression.
 *  - `tool_use` / `tool_result` blocks become STANDALONE top-level
 *    items (`function_call` / `function_call_output`) — they are NOT
 *    nested inside a Message. This matches the Codex protocol and is
 *    the fix for the silent-drop bug measured in
 *    log/debug-20260503191014.log: codex emitted 8 search calls,
 *    `[AUTO-NARROWED]` Read content was generated, history captured
 *    them — but the prior `messagesToResponsesInput` ignored those
 *    blocks entirely so the model received zero tool context across 5
 *    LLM round-trips ("inputCount" 1 → 3 → 5 → 7 → 10 grew by
 *    text-only items). Force-synthesis preview confirmed this: every
 *    codex answer began with "tool_result 가 없다" because, from the
 *    model's perspective, no tool result ever arrived. */
type ResponsesInputItem =
  | { role: string; content: ResponsesContentBlock[] }
  | { type: 'function_call'; name: string; arguments: string; call_id: string }
  // Image-pipeline P3 (2026-05-05) — `output` accepts string OR a
  // ContentItem[] mirroring the user-message content block shape.
  // Codex Responses backend (gpt-5 family) wires images through
  // `input_image` entries in the array form, allowing a tool that
  // returns `{mediaType, dataB64}` (WT-C-2 WebTerminalScreenshot) to
  // reach a vision-capable model as actual image bytes rather than a
  // size-note placeholder. String form stays the default + fallback
  // for non-vision routes. Per ref/codex/codex-rs/protocol/src/models.rs.
  | { type: 'function_call_output'; call_id: string; output: string | ResponsesContentBlock[] };

/** Image-pipeline P3 (2026-05-05) — opt-in flag for the
 *  function_call_output ContentItem[] wire. When true AND the
 *  tool_result content carries image bytes, emit `output:
 *  [{type:'input_text'}, {type:'input_image'}]`; else fall through to
 *  the legacy stringifyToolResultContent path. Caller (Codex provider)
 *  drives this from `acceptsToolResultImage('openai-codex', model)`
 *  so non-gpt-5 routes stay on the safe text fallback.
 *
 *  P-3 §6.9 (2026-05-07) — `acceptUserMessageImages` (default true) is
 *  the user-message axis sibling: when explicitly false, image blocks on
 *  user-role messages are downgraded to a `[image: <mime>]` text
 *  placeholder before reaching the wire (defensive guard for non-vision
 *  Codex variants — current gpt-5 family all true per allowlist). */
export interface MessagesToResponsesInputOpts {
  acceptToolImages?: boolean;
  acceptUserMessageImages?: boolean;
}

/** Exported for tests. Converts the unified LLMMessage shape into the
 *  OpenAI Responses API `{instructions, input}` payload. See inline
 *  comments for the image-block handling introduced after the
 *  Telegram "I can't see the image" regression. */
export function messagesToResponsesInput(
  messages: LLMMessage[],
  opts: MessagesToResponsesInputOpts = {},
): {
  instructions: string;
  input: ResponsesInputItem[];
} {
  const acceptToolImages = !!opts.acceptToolImages;
  // P-3 §6.9 — user-message image gating (default true; current gpt-5
  // family all vision-capable per allowlist).
  const acceptUserImages = opts.acceptUserMessageImages ?? true;
  // First pass — collect every tool_result.tool_use_id that ever
  // appears across the message list. Second pass below uses this set
  // to drop orphan tool_use blocks (assistant invoked a tool but no
  // matching tool_result followed). Orphans happen when the runtime
  // pre-empts dispatch (e.g. W5-G early force-synthesis fires
  // immediately after the assistant's tool_use stream completes but
  // before dispatchTool runs) — codex Responses API hard-rejects
  // function_call without function_call_output ("No tool output
  // found for function call X" → 400).
  const seenToolResultIds = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && typeof b === 'object' && b.type === 'tool_result' && b.tool_use_id) {
        seenToolResultIds.add(b.tool_use_id);
      }
    }
  }

  const sys: string[] = [];
  const input: ResponsesInputItem[] = [];
  for (const m of messages) {
    // Build typed content blocks: text accumulated into one block,
    // images appended as separate input_image entries. The old
    // implementation dropped image blocks silently — Telegram users
    // who sent a photo saw the bot say "I can't see images" because
    // the wire payload never carried them. Responses API accepts
    // input_image only on user/tool roles; an assistant message with
    // image content (shouldn't happen from our code, but guard) gets
    // its images downgraded to a "[image]" text placeholder rather
    // than trigger a 400.
    //
    // tool_use / tool_result blocks are extracted into standalone
    // `function_call` / `function_call_output` items (see
    // ResponsesInputItem comment above). Per-message ordering is
    // preserved: text/image first (as a `message` item), then each
    // tool block as its own item, in the order they appeared in the
    // source message — this matches how Codex expects to see the
    // assistant's reasoning text immediately followed by its tool
    // invocations.
    const collected: ResponsesContentBlock[] = [];
    const trailingItems: ResponsesInputItem[] = [];
    let textBuf = '';
    const pushText = (t: string): void => {
      if (!t) return;
      textBuf += (textBuf ? '\n' : '') + t;
    };

    if (typeof m.content === 'string') {
      pushText(m.content);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          pushText(b.text);
        } else if (b.type === 'image') {
          if (m.role === 'assistant') {
            // Can't attach input_image to an assistant message — fall
            // back to a textual placeholder so downstream provider
            // doesn't 400 on mixed output content.
            pushText('[image]');
          } else if (m.role === 'user' && !acceptUserImages) {
            // P-3 §6.9 — user-message image gate (defensive). Composer
            // (Q3=B toast + skip) is the primary handler; this is the
            // wire-side fallback for non-vision Codex variants.
            pushText(`[image: ${b.mediaType} (model not vision-capable)]`);
          } else {
            collected.push({
              type: 'input_image',
              image_url: `data:${b.mediaType};base64,${b.base64}`,
              detail: 'auto',
            });
          }
        } else if (b.type === 'tool_use') {
          // Orphan tool_use guard: Codex Responses API requires every
          // function_call to have a matching function_call_output in
          // the same input list. Drop tool_use blocks whose id has no
          // corresponding tool_result anywhere in the message
          // history — otherwise wire body trips a 400. See top-of-
          // function comment for the W5-G pre-emption case.
          if (!seenToolResultIds.has(b.id)) {
            continue;
          }
          // `arguments` is a JSON string per the Codex protocol — the
          // model parses it back to a Value on receipt.
          trailingItems.push({
            type: 'function_call',
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
            call_id: b.id,
          });
        } else if (b.type === 'tool_result') {
          // Image-pipeline P3 (2026-05-05) — when the caller opted in
          // (acceptToolImages, set by Codex provider for gpt-5 family)
          // AND the tool_result content carries image bytes, emit the
          // array form `[{type:'input_text'}, {type:'input_image'}]`
          // so the model receives the PNG as actual vision input.
          // Otherwise (non-vision route, plain text result, or text-
          // only ToolResultContentItem array) collapse to a single
          // string via stringifyToolResultContent — the legacy P1 wire.
          if (
            acceptToolImages
            && Array.isArray(b.content)
            && b.content.some((item) => item.type === 'image')
          ) {
            const items: ResponsesContentBlock[] = [];
            for (const item of b.content) {
              if (item.type === 'text') {
                if (item.text) items.push({ type: 'input_text', text: item.text });
              } else {
                items.push({
                  type: 'input_image',
                  image_url: `data:${item.mediaType};base64,${item.base64}`,
                  detail: 'auto',
                });
              }
            }
            trailingItems.push({
              type: 'function_call_output',
              call_id: b.tool_use_id,
              // Defensive: if every item collapsed to empty (shouldn't
              // happen because we required at least one image), fall
              // back to a string output so the wire payload stays
              // valid (Responses API rejects empty content arrays).
              output: items.length > 0
                ? items
                : stringifyToolResultContent(b.content),
            });
          } else {
            trailingItems.push({
              type: 'function_call_output',
              call_id: b.tool_use_id,
              output: stringifyToolResultContent(b.content),
            });
          }
        }
      }
    }

    if (m.role === 'system') {
      sys.push(textBuf);
      continue;
    }

    // Assemble the final content block list: text first (matches
    // how users usually write prompts — "describe this image" then
    // attachment), images second. Responses API is order-sensitive
    // for display but model-wise both orderings work.
    const textType: 'input_text' | 'output_text' =
      m.role === 'assistant' ? 'output_text' : 'input_text';
    const content: ResponsesContentBlock[] = [];
    if (textBuf) content.push({ type: textType, text: textBuf });
    content.push(...collected);
    // Emit a Message item only when there's actual text/image content.
    // For messages that exist solely to carry tool blocks (e.g. an
    // assistant turn that was nothing but a tool_use, or a user turn
    // that's a single tool_result), the corresponding function_call /
    // function_call_output item below is the entire wire
    // representation — emitting an empty Message wrapper would just
    // add a stray empty-text block to the conversation history.
    if (content.length > 0) {
      input.push({ role: m.role, content });
    }
    input.push(...trailingItems);
  }
  if (input.length === 0) input.push({ role: 'user', content: [{ type: 'input_text', text: '' }] });
  return {
    instructions: sys.length ? sys.join('\n\n') : 'You are a helpful assistant.',
    input,
  };
}

/** store=true wave: compute the incremental tail when `current` is a
 *  strict extension of `prev`. Returns null when the previous input
 *  isn't usable as a baseline — caller falls back to full input + no
 *  `previous_response_id`.
 *
 *  Strict extension = current.length ≥ prev.length AND
 *  current[0..prev.length] deep-equals prev (each item identical to
 *  what the backend already has stored from the prior turn). When
 *  history is truncated (force-synthesis, /clear) or diverged the
 *  prefix won't match and we return null so the next call rebases.
 *
 *  Empty tail (length 0) means the messages list ended up identical
 *  to last turn — also treated as null so we don't ship a degenerate
 *  empty-input wire body. Mirrors ref/codex's get_incremental_items
 *  in `codex-rs/core/src/client.rs`.
 *
 *  Exported for tests + a unit-level seam separate from
 *  messagesToResponsesInput. */
export function getIncrementalItems(
  prev: ResponsesInputItem[] | undefined,
  current: ResponsesInputItem[],
): ResponsesInputItem[] | null {
  if (!prev || prev.length === 0) return null;
  if (current.length < prev.length) return null;
  for (let i = 0; i < prev.length; i++) {
    if (JSON.stringify(prev[i]) !== JSON.stringify(current[i])) return null;
  }
  const tail = current.slice(prev.length);
  return tail.length > 0 ? tail : null;
}

/** Deterministic routing hint for OpenAI's prompt cache. The Codex
 *  backend uses this value to stick the request to the same physical
 *  machine that served a prior request with the same key — which is
 *  how cached tokens get reused (priced ~10× cheaper: $0.125/M vs
 *  $1.25/M on gpt-5-codex). The actual cache hit is decided by shared
 *  token prefix, not by key equality; the key only steers routing.
 *
 *  We hash (model + first 500 chars of the instructions block). The
 *  500-char window is deliberate — in elanous's long-running research
 *  loops, `instructions` changes every turn (budget, pending
 *  questions) but the OPENING stays stable (persona, Andon preamble,
 *  goal kind). Hashing only the prefix keeps the cache key sticky
 *  across turns of the same session, while differing sessions land on
 *  different keys. First 16 bytes (32 hex chars) of SHA-256 is plenty
 *  for uniqueness — OpenAI cares about grouping, not cryptographic
 *  strength. */
export function computePromptCacheKey(model: string, instructions: string): string {
  const prefix = (instructions || '').slice(0, 500);
  return createHash('sha256').update(`${model}::${prefix}`).digest('hex').slice(0, 32);
}

/** Cycle order for the HUD pill click + `/reasoning` no-arg form. */
export const REASONING_CYCLE: readonly import('./user-config.js').ReasoningLevel[] =
  ['off', 'low', 'medium', 'high', 'xhigh'] as const;

/** Does the (provider, model) pair support a "think before answering"
 *  reasoning surface? Capability-based: gpt-5 family on Codex /
 *  Responses API + Anthropic claude-4 / claude-3.7 (extended thinking)
 *  + OpenAI o-series. Other providers / older models return false so
 *  the HUD pill auto-hides and the wire body skips the reasoning
 *  field — no user toggle required. */
export function modelSupportsReasoning(
  provider: import('./user-config.js').LLMProviderName,
  model: string | undefined,
): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  if (provider === 'openai-codex') {
    // gpt-5-chat is the non-reasoning variant; everything else in the
    // gpt-5 / o-series family reasons.
    if (m.startsWith('gpt-5-chat')) return false;
    // ⛔ 2026-09-23 — `startsWith('gpt-5')` 는 gpt-6 을 «추론 없음»으로 읽었다(/reasoning·HUD 가 운영 기본에서
    //   거부). 세대는 «숫자»로 가른다 — codex 모델 캐시 실측: gpt-6-* 도 low~max 추론 단계를 낸다.
    return isNewGenerationOpenAiModel(m) || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4');
  }
  if (provider === 'openai') {
    return m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4');
  }
  if (provider === 'anthropic') {
    // Extended thinking is GA on claude-3.7 onward — anything 4-family
    // (opus-4, sonnet-4, haiku-4) plus the 3.7 line.
    return m.includes('-4-') || m.includes('-3-7') || m.includes('3.7') || m.includes('claude-4');
  }
  if (provider === 'gemini') {
    // Gemini 2.5+ family supports thinking budget (thinkingConfig).
    // 2.0-flash and earlier don't expose the thinking surface — wire
    // body skips thinkingConfig automatically. Wave 1 (2026-05-04)
    // unblocked this surface by routing gemini through the native
    // SDK rather than the OpenAI-compat tunnel.
    return m.startsWith('gemini-2.5') || m.startsWith('gemini-3');
  }
  if (provider === 'grok') {
    // grok-4.3+ family has reasoning always-on (chain-of-thought
    // built into the model — no client-side budget toggle exposed
    // via the xAI Responses API per docs.x.ai/developers/models).
    // The HUD pill still surfaces the level for consistency with
    // codex/claude/gemini cycles, even though the wire body itself
    // has no reasoning field to populate. grok-4-1-fast and earlier
    // legacy models return false. Refreshed 2026-05-04.
    return m.startsWith('grok-4.3') || m.startsWith('grok-4.20') || m.startsWith('grok-5');
  }
  return false;
}

/** Effective reasoning level, considering (in priority order):
 *    1. Advanced override `codexReasoning.effort` (codex only)
 *    2. Explicit user-set `reasoningLevel` (cross-provider primary)
 *    3. Model-default — when the active model supports reasoning we
 *       fall through to **'high'**, so users with a fresh config see
 *       maximum reasoning quality without any opt-in step. Users
 *       explicitly set 'off' / 'low' / 'medium' if they want to step
 *       down. Models that don't support reasoning return 'off' — the
 *       HUD pill auto-hides and the wire body skips the reasoning
 *       field.
 *
 *  Default changed from 'medium' to 'high' on 2026-05-04: per
 *  provider 권고 (codex/anthropic/gemini/grok 모두 reasoning 향상
 *  버전이 main path 가 됐고, gemini 3.1+ / grok 4.3+ 는 reasoning
 *  always-on). cost penalty 는 thinking budget cap (gemini 24576,
 *  anthropic 32000, codex effort=high) 로 bounded — 사용자가 token
 *  비용 우려 시 명시 'medium' / 'low' 로 step down. */
export function effectiveReasoningLevel(
  llm: { reasoningLevel?: import('./user-config.js').ReasoningLevel; codexReasoning?: { effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' } },
  provider: import('./user-config.js').LLMProviderName,
  model: string | undefined,
): import('./user-config.js').ReasoningLevel {
  // 1. Advanced fine-grained override wins (codex only — explicit
  //    effort field). Map onto the cross-provider level so the HUD
  //    pill + slash cycle stay coherent.
  const e = llm.codexReasoning?.effort;
  if (e === 'minimal' || e === 'low') return 'low';
  if (e === 'medium') return 'medium';
  if (e === 'high') return 'high';
  // ⭐ xhigh 는 이제 공통 축에도 칸이 있다 — 옛날엔 여기서 조용히 흘러내려 HUD 가 다른 값을 보였다.
  //   ⛔ `max` 는 공통 축에 칸이 «없다» — 여기서 매핑하지 않고 종전처럼 흘려보낸다(wire 는 override 가 그대로 이긴다).
  if (e === 'xhigh') return 'xhigh';
  // 2. User-set level (any explicit value, including 'off').
  if (llm.reasoningLevel) return llm.reasoningLevel;
  // 3. Model default — supported models opt-in to HIGH reasoning by
  //    default (provider 권고 일치); unsupported models stay 'off'.
  return modelSupportsReasoning(provider, model) ? 'high' : 'off';
}

/** Pretty label for the reasoning level — emoji + word so HUD pill
 *  and `/reasoning` slash output are visually consistent. The emoji
 *  ladder mirrors mental effort: 💤 (sleep, off) → 💭 (light) → 🤔
 *  (active) → 🧠 (deep). Provider-agnostic — same label whether codex
 *  effort or anthropic budget_tokens drives the wire. */
export function reasoningLevelLabel(
  level: import('./user-config.js').ReasoningLevel | undefined,
): string {
  switch (level ?? 'off') {
    case 'off': return '💤 off';
    case 'low': return '💭 low';
    case 'medium': return '🤔 medium';
    case 'high': return '🧠 high';
    case 'xhigh': return '🔬 xhigh';
  }
}

/** Advance one step through `REASONING_CYCLE`, wrapping at the end.
 *  Used by HUD click cycle + slash no-arg form. */
export function nextReasoningLevel(
  current: import('./user-config.js').ReasoningLevel | undefined,
): import('./user-config.js').ReasoningLevel {
  const cur = current ?? 'off';
  const idx = REASONING_CYCLE.indexOf(cur);
  return REASONING_CYCLE[(idx + 1) % REASONING_CYCLE.length] ?? 'off';
}

/** Map the provider-agnostic ReasoningLevel onto the Codex Responses
 *  API native shape. `low/medium/high` each pair an effort level with
 *  a sensible summary granularity (concise for low to keep wire cost
 *  down, detailed for medium/high so the user actually sees the
 *  trace). `off` and undefined both return undefined — caller decides
 *  whether to drop the field. */
export function mapReasoningLevelToCodex(
  level: import('./user-config.js').ReasoningLevel | undefined,
  /** ⭐ 상한 판정용. 안 주면 `xhigh` 도 «high 로 깎는다»(모르는 모델에 xhigh 를 보내지 않는다). */
  model?: string,
): { effort: 'low' | 'medium' | 'high' | 'xhigh'; summary: 'concise' | 'detailed' } | undefined {
  if (!level || level === 'off') return undefined;
  if (level === 'low') return { effort: 'low', summary: 'concise' };
  if (level === 'medium') return { effort: 'medium', summary: 'detailed' };
  if (level === 'xhigh') {
    // ⛔ 모델 상한(`reasoningEffortCeiling` SSOT)이 xhigh 이상일 때만 보낸다 — 넘기면 API 가 400 이다.
    const ceil = model ? reasoningEffortCeilingOf(model) : 'medium';
    if (ceil === 'xhigh' || ceil === 'max') return { effort: 'xhigh', summary: 'detailed' };
  }
  return { effort: 'high', summary: 'detailed' };
}

/** Map the provider-agnostic ReasoningLevel onto Anthropic's
 *  extended-thinking budget_tokens. Budget tiers chosen to roughly
 *  match codex effort levels: low ~ minimal think, medium ~ standard
 *  step-by-step, high ~ deep multi-pass. `off` returns undefined so
 *  the wire body skips the `thinking` field entirely. */
function mapReasoningLevelToAnthropicThinking(
  level: import('./user-config.js').ReasoningLevel | undefined,
): { type: 'enabled'; budget_tokens: number } | undefined {
  if (!level || level === 'off') return undefined;
  if (level === 'low') return { type: 'enabled', budget_tokens: 2000 };
  if (level === 'medium') return { type: 'enabled', budget_tokens: 8000 };
  return { type: 'enabled', budget_tokens: 32000 };
}

/** Map ReasoningLevel onto Anthropic's *adaptive* thinking effort.
 *  claude-opus-4-8+ (the 2026-06 thinking API) rejects the legacy
 *  `thinking.type:'enabled'` + budget_tokens shape with a 400
 *  ("Use thinking.type.adaptive and output_config.effort"). Newer
 *  models instead take `thinking:{type:'adaptive'}` paired with
 *  `output_config:{effort}`. `off`/undefined → undefined (skip). */
function mapReasoningLevelToAnthropicEffort(
  level: import('./user-config.js').ReasoningLevel | undefined,
): 'low' | 'medium' | 'high' | undefined {
  if (!level || level === 'off') return undefined;
  if (level === 'low') return 'low';
  if (level === 'medium') return 'medium';
  return 'high';
}

/** Whether a claude model uses the adaptive thinking API.
 *
 *  ⛔⭐ **계열 이름이 아니라 «세대·마이너»로 판정한다** — 종전 규칙은 `/-4-(?:[89]|\d\d)\b/` 로
 *  「4 세대의 8 이상」만 물었고, 그 바로 위 주석이 *"New top-level families (5.x+) should be
 *  re-checked against the API when they ship"* 라고 «예고해 두고» 아무도 안 고쳤다.
 *  ⇒ 2026-08-12 실측: `claude-opus-5` 요청이 legacy 형상으로 나가 API 가 거부했다 —
 *     `Anthropic API 400: "thinking.type.enabled" is not supported`.
 *     그래서 elanous 가 Anthropic 4.7 «이상 전부»를 못 쓰고 있었다.
 *
 *  📏 근거 = live `GET /v1/models` capabilities (2026-08-12 · HTTP 200):
 *     adaptive 필요(enabled=false): opus-5 · sonnet-5 · fable-5 · opus-4-8 · opus-4-7
 *     legacy 가능(enabled=true):    opus-4-6 · sonnet-4-6 · opus-4-5-* · haiku-4-5-* · sonnet-4-5-*
 *
 *  🩹 그래서 규칙을 이름 목록이 아니라 «수»로 둔다 — 목록은 새 모델마다 늙지만 세대 비교는 안 늙는다.
 *  ⚠️ 알 수 없는 형태는 legacy 로 둔다(무회귀). 판정 못 하면 종전 동작이 정답이다. */
function usesAdaptiveThinking(model: string | undefined): boolean {
  // 끝에 붙는 릴리스 날짜(`-20251101`)는 버전이 아니다 — 떼고 본다.
  const m = (model ?? '').toLowerCase().replace(/-\d{8}$/, '');
  const v = /-(\d+)(?:[-.](\d+))?$/.exec(m);
  if (!v) return false;
  const generation = Number(v[1]);
  const minor = v[2] === undefined ? 0 : Number(v[2]);
  if (generation >= 5) return true;
  return generation === 4 && minor >= 7;
}

/** ⛔ 테스트 전용 노출이 아니다 — 모델 계열 계약은 «이름을 가진 판정»이라 회귀를 테스트로 물어야 한다.
 *  이 파일 안 두 조립부(:3102·:9591)가 그 값을 쓰고, 그 계약이 틀리면 provider 가 통째로 막힌다. */
export const _usesAdaptiveThinkingForContractTest = usesAdaptiveThinking;

/** Anthropic 요청의 `temperature` 칸 — ⛔ 조립부가 «둘»이라 판정을 한 자리에 둔다.
 *  adaptive 모델(4.7+·5 계열)은 thinking 을 안 켜도 `temperature` 를 400 으로 거부한다("deprecated for this model").
 *  thinking(어느 모양이든)이 켜져 있으면 모델 기본에 고정된다.
 *  🩸 2026-09-25: 도구 루프 조립부만 `thinkingActive` 로 판정해 reasoning 이 꺼진 `claude-sonnet-5` 가 첫 호출에서 400
 *    (k3d 벤치 anthropic 팔 · 툴콜 0). 기본 조립부는 07-13 에 같은 400 으로 이미 고쳐져 있었다. */
export function anthropicTemperatureField(model: string | undefined, thinkingActive: boolean, temperature: number | undefined): { temperature?: number } {
  if (thinkingActive || usesAdaptiveThinking(model)) return {};
  return { temperature: temperature ?? 0.3 };
}

/** Map the provider-agnostic ReasoningLevel onto Gemini's native
 *  `thinkingConfig` shape. Wire shape diverges by family:
 *
 *  - **gemini-3+** uses `thinkingLevel: 'LOW'|'MEDIUM'|'HIGH'` (enum).
 *    ref/gemini-cli `defaultModelConfigs.ts` ships `chat-base-3` with
 *    `{ thinkingLevel: ThinkingLevel.HIGH }`. Sending the legacy
 *    `thinkingBudget` number form to gemini-3 silently misinterprets
 *    (measured 2026-05-04 — 0 tool calls / 2,201 chars on multi-turn
 *    cache-rate scenario; baseline elevated 8K+ on other providers).
 *
 *  - **gemini-2.5** uses `thinkingBudget: number`. 24576 is the flash
 *    family's max; pro model accepts ~32K but capping at 24576 keeps
 *    the flash path working. Measured 32000 returns INVALID_ARGUMENT
 *    on flash.
 *
 *  `includeThoughts: true` — opts into the reasoning-summary stream
 *  (HUD reasoning pill renders these). Multi-turn requirement: each
 *  model functionCall part must carry `thoughtSignature`; we satisfy
 *  this in `messagesToGeminiInput` with the
 *  `skip_thought_signature_validator` sentinel ref/gemini-cli uses. */
function mapReasoningLevelToGeminiThinking(
  level: import('./user-config.js').ReasoningLevel | undefined,
  model: string,
): {
  thinkingBudget?: number;
  thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  includeThoughts: boolean;
} | undefined {
  if (!level || level === 'off') return undefined;
  const isGemini3 = model.startsWith('gemini-3');
  if (isGemini3) {
    if (level === 'low')    return { thinkingLevel: 'LOW',    includeThoughts: true };
    if (level === 'medium') return { thinkingLevel: 'MEDIUM', includeThoughts: true };
    return { thinkingLevel: 'HIGH', includeThoughts: true };
  }
  // gemini-2.5 family — legacy thinkingBudget number form.
  if (level === 'low')    return { thinkingBudget: 2000,  includeThoughts: true };
  if (level === 'medium') return { thinkingBudget: 8000,  includeThoughts: true };
  return { thinkingBudget: 24576, includeThoughts: true };
}

/** Stream against /responses (Codex, OpenAI Responses API). Exported
 *  so tests can exercise header/body shape without spinning up the
 *  full makeCodexProvider path. */
export async function* streamCodexResponsesEvents(
  url: string,
  bearer: string,
  body: {
    model: string;
    instructions: string;
    input: unknown[];
    tools?: unknown[];
    /** Responses API tool_choice (auto/required/none/{type:'function',name}). */
    tool_choice?: unknown;
    /** Codex Responses API reasoning controls (gpt-5 family).
     *  When set, the wire body carries `reasoning: { effort, summary }`
     *  and `include: ['reasoning.encrypted_content']` so the model
     *  exposes its summary stream AND so multi-turn continuations can
     *  thread the encrypted reasoning state across requests. Omit to
     *  fall back to the model's default behavior (no summary surface). */
    reasoning?: {
      effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      summary?: 'auto' | 'concise' | 'detailed';
    };
    /** When true, the Codex backend stores the response under the user's
     *  account so a subsequent call can reference it via
     *  `previousResponseId` and send only the delta input items.
     *  Default behavior remains store=false (legacy) when this option
     *  is omitted — preserves backwards-compat for callers that build
     *  the body directly in tests. */
    store?: boolean;
    /** Threads to a prior stored response. When set, the backend
     *  reconstructs full conversation state from that response and
     *  treats `input` as a strict extension (delta only). Requires
     *  store=true on the prior call. Skip on the first call of a
     *  conversation. */
    previousResponseId?: string;
  },
  signal?: AbortSignal,
  extra: {
    /** ChatGPT account uuid extracted from the access-token JWT.
     *  Emitted as `chatgpt-account-id` header so the Codex backend can
     *  route billing/quota to the user's Plus/Pro subscription
     *  instead of rejecting the request or falling back to metered
     *  API pricing. undefined for API-key mode — the header is
     *  omitted entirely in that case. */
    accountId?: string;
    /** Opt-out hook (tests). When false, skips the
     *  `prompt_cache_key` body field; production always passes true. */
    promptCache?: boolean;
    /** Callback fired when the SSE stream emits `response.created`
     *  carrying the new response's id. Used by makeCodexProvider to
     *  capture the id and thread `previousResponseId` on the next
     *  call. Best-effort; null/undefined if the backend skips the
     *  event. */
    onResponseCreated?: (id: string) => void;
    /** Unused configured fallbacks. Overload k times switches before retries. */
    remainingFallbacks?: number;
  } = {},
): AsyncGenerator<LLMStreamEvent, void, unknown> {
  const startedAt = Date.now();
  // See comment in streamOpenAIEvents — we drop the raw body by
  // default. `/debug verbose on` restores the full body for deep
  // reproduction.
  // 'openai-codex llm response' — openai-codex provider(구독 Responses API)로의 순수 **LLM 호출**.
  // codex CLI 프로세스 spawn 이 아니다(self-dev backend=elanous-chat·이건 그 안의 LLM provider 호출).
  if (debug.isAnySinkEnabled()) {
    debug.log('llm.request', `POST ${url} (openai-codex llm response)`, {
      model: body.model,
      inputCount: body.input.length,
      // ⭐ 전송 크기(2026-07-27) — 종전엔 **항목 수만** 있어 "컨텍스트 초과" 가 났을 때
      //   *"무엇이 그렇게 컸나"* 를 판정할 수 없었다(실측: repro 가 초과로 죽었는데
      //   초기 페이로드는 통과 → 누적인지 찌꺼기인지 로그로 못 가림).
      //   ⚠️ codex 백엔드 실효 윈도우는 공칭 1M 이 아니라 **372k(실효 ~353k)** 다
      //      (openai/codex#32486). 그래서 크기 관측이 실제로 필요하다.
      inputChars: (() => { try { return JSON.stringify(body.input).length; } catch { return -1; } })(),
      toolChars: (() => { try { return JSON.stringify(body.tools ?? []).length; } catch { return -1; } })(),
      instructionChars: body.instructions.length,
      tools: observeRequestTools(body.tools),
      instructions: body.instructions.slice(0, 200),
      accountId: extra.accountId ? `${extra.accountId.slice(0, 8)}…` : '(none)',
      // Reasoning opt-in surface — one-line verification that the wire
      // body actually carries the reasoning field (config-effective)
      // vs being dropped somewhere upstream. null = opt-out / config
      // missing; populated = wire shape carries it.
      reasoning: body.reasoning ?? null,
      // store=true wave forensic surface: store flag + prevResponseId
      // presence + actual input length sent on the wire (= delta length
      // when threading, full length on first call). One-line check that
      // the optimization is firing. null when caller didn't opt in.
      store: body.store ?? false,
      previousResponseId: body.previousResponseId ? `${body.previousResponseId.slice(0, 12)}…` : null,
      ...(debug.isVerboseEnabled() ? { body: redactSecrets(body) } : {}),
    });
  }
  // Identifier headers the Codex backend inspects:
  //   chatgpt-account-id  → routes to the user's subscription quota
  //   OpenAI-Beta         → opts into the /responses schema the
  //                         official Codex CLI uses
  //   originator          → marks us as a Codex-style client (same
  //                         value codex_cli_rs ships) so the backend
  //                         applies the same tool/SSE conventions
  const promptCache = extra.promptCache !== false;
  const cacheKey = promptCache ? computePromptCacheKey(body.model, body.instructions) : undefined;
  const response = await fetchApiWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearer}`,
        'Accept': 'text/event-stream',
        ...(extra.accountId ? { 'chatgpt-account-id': extra.accountId } : {}),
        'OpenAI-Beta': 'responses=experimental',
        'originator': 'codex_cli_rs',
        // Versioned UA — the backend parses the Codex client version from
        // here to gate newer models (gpt-5.5 etc.). Without it the request
        // is treated as an old client → 400 "requires a newer version of
        // Codex". See getCodexUserAgent (oauth/codex.ts).
        'User-Agent': getCodexUserAgent(),
      },
      body: JSON.stringify({
        ...body,
        stream: true,
        // store=true wave: when caller opts in, the backend persists the
        // response and the next request can thread `previous_response_id`
        // to send only the delta input items. Default still false so any
        // caller that doesn't opt in (tests building bodies directly)
        // sees the legacy wire shape.
        store: body.store === true,
        ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
        ...(body.previousResponseId ? { previous_response_id: body.previousResponseId } : {}),
        ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
        // Reasoning opt-in (gpt-5 family). When the caller sets
        // body.reasoning we mirror it onto the wire AND append the
        // include directive that lets multi-turn requests thread the
        // model's encrypted reasoning context. Omit both when absent
        // so non-reasoning models / opt-out users see the legacy
        // wire shape unchanged.
        ...(body.reasoning ? {
          reasoning: body.reasoning,
          include: ['reasoning.encrypted_content'],
        } : {}),
      }),
      signal,
    },
    retryOptsFor('codex', 'Codex API', extra.remainingFallbacks),
  );
  debug.log('llm.response.status', `codex ${response.status}`, {
    url, status: response.status, elapsedMs: Date.now() - startedAt,
  });
  try {
    for await (const line of sseLineStream(response.body!)) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      let parsed: any;
      try { parsed = JSON.parse(data); } catch { continue; }
      const type = (parsed.type || '') as string;
      // store=true wave: capture the new response id as soon as the
      // backend emits `response.created`. The provider closure threads
      // this into `previous_response_id` on the next call. Best-effort
      // — if the backend skips this event the provider falls back to
      // full-input mode automatically (no id, no continuation).
      if (type === 'response.created') {
        const id = parsed.response?.id;
        if (typeof id === 'string' && id.length > 0 && extra.onResponseCreated) {
          extra.onResponseCreated(id);
        }
      }
      // Text tokens — both `response.output_text.delta` (new naming) and
      // raw `output_text.delta` (older streams).
      if (type.endsWith('output_text.delta')) {
        const delta = parsed.delta || '';
        if (delta) yield { type: 'text', delta };
      }
      // Tool calls come in as `response.output_item.done` with item.type = 'function_call'.
      if (type === 'response.output_item.done') {
        const item = parsed.item;
        if (item && item.type === 'function_call') {
          let args: Record<string, unknown> = {};
          try { args = item.arguments ? JSON.parse(item.arguments) : {}; } catch { /* empty */ }
          yield { type: 'tool_call', id: item.call_id || item.id || '', name: item.name || '', args };
        }
        // Y2·1 (2026-05-17) — image_generation_call output item carries
        // the final base64 PNG the built-in `image_generation` server-
        // tool produced. Only present when the caller opted in via
        // opts.serverTools.imageGeneration; otherwise the model can't
        // emit this item type and the branch is dead.
        if (item && item.type === 'image_generation_call') {
          const result = typeof item.result === 'string' ? item.result : '';
          if (result) {
            const revised = typeof item.revised_prompt === 'string'
              ? item.revised_prompt
              : undefined;
            yield {
              type: 'image',
              mediaType: 'image/png',
              data: result,
              source: 'image_generation',
              ...(revised ? { revisedPrompt: revised } : {}),
            };
          }
        }
      }
      // Reasoning summary stream events (gpt-5 family). Surfaced only
      // when the request body opted in via `reasoning: { summary }`.
      // `summary_part_added` marks a paragraph break between successive
      // parts; `summary_text.delta` carries the streamed text within
      // one part. Consumers (TUI, agents) decide whether to render
      // these — `textOnly()` filters them out so legacy callers see
      // only the user-visible answer.
      if (type === 'response.reasoning_summary_part.added') {
        const summaryIndex = typeof parsed.summary_index === 'number' ? parsed.summary_index : undefined;
        yield { type: 'reasoning', kind: 'summary_part_added', summaryIndex };
      }
      if (type === 'response.reasoning_summary_text.delta') {
        const delta = parsed.delta || '';
        if (delta) {
          const summaryIndex = typeof parsed.summary_index === 'number' ? parsed.summary_index : undefined;
          yield { type: 'reasoning', kind: 'summary_delta', delta, summaryIndex };
        }
      }
      // Response completed — usage telemetry. Codex Responses API
      // ships its prompt-cache hit count in
      // `response.completed.response.usage.input_tokens_details.cached_tokens`
      // (mirroring the OpenAI Chat Completions
      // `prompt_tokens_details.cached_tokens` shape). Without this we
      // can't tell whether `prompt_cache_key` is actually delivering
      // cached reads — the metrics module would silently report 0%
      // hit rate for codex regardless. See store=true wave (next+1)
      // for the volume-side counterpart.
      if (type === 'response.completed') {
        const u = parsed.response?.usage;
        if (u && typeof u === 'object') {
          const cached = u.input_tokens_details?.cached_tokens
            ?? u.prompt_tokens_details?.cached_tokens;
          const cacheReadInputTokens = typeof cached === 'number' ? cached : undefined;
          // ⛔ Responses `input_tokens` 는 캐시 적중분을 «포함»한다 — elanous 규약(새 입력만)으로 뺀다(BACKLOG C4).
          const inputTokens = typeof u.input_tokens === 'number' ? Math.max(0, u.input_tokens - (cacheReadInputTokens ?? 0)) : undefined;
          const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : undefined;
          const reasoning = u.output_tokens_details?.reasoning_tokens;
          const reasoningOutputTokens = typeof reasoning === 'number' ? reasoning : undefined;
          if (inputTokens !== undefined || outputTokens !== undefined || cacheReadInputTokens !== undefined) {
            yield {
              type: 'usage',
              usage: {
                provider: 'openai',
                ...(inputTokens !== undefined ? { inputTokens } : {}),
                ...(outputTokens !== undefined ? { outputTokens } : {}),
                ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
                ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
              },
            };
          }
        }
      }
      // Response errors — record the provider's structured diagnostics before
      // preserving the legacy error text for callers.
      if (type === 'response.failed' || type === 'error') {
        const responseError = parsed.response?.error;
        const topLevelError = parsed.error;
        const providerError = responseError ?? topLevelError;
        const msg = responseError?.message || topLevelError?.message || 'codex stream failed';
        const errorData = {
          streamEventType: type,
          ...(typeof providerError?.type === 'string' ? { type: providerError.type } : {}),
          ...(typeof providerError?.code === 'string' ? { code: providerError.code } : {}),
          ...(typeof providerError?.param === 'string' ? { param: providerError.param } : {}),
          ...(typeof providerError?.message === 'string' ? { message: providerError.message } : {}),
        };
        try {
          debug.log('llm.response.status', `codex ${type}`, redactSecrets(errorData));
        } catch {
          // Observability must not interfere with the provider error contract.
        }
        throw new Error(`Codex API error: ${msg}`);
      }
    }
  } catch (err: any) {
    if (err.name === 'AbortError') return;
    throw err;
  }
}

function toolNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map(item => {
    if (!item || typeof item !== 'object') return undefined;
    const tool = item as Record<string, unknown>;
    const fn = tool.function;
    if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
      const name = (fn as Record<string, unknown>).name;
      if (typeof name === 'string') return name;
    }
    return typeof tool.name === 'string' ? tool.name : undefined;
  }).filter((name): name is string => typeof name === 'string');
}

/** Request observations must survive the generic logger's array compaction.
 * Names are represented as an index-keyed object, which keeps every name while
 * leaving the logger's array-folding policy unchanged for every other event. */
export function observeRequestTools(raw: unknown): {
  names: Record<string, string>;
  count: number;
  folded: false;
} | undefined {
  const names = toolNames(raw);
  if (!names) return undefined;
  return {
    names: Object.fromEntries(names.map((name, index) => [String(index), name])),
    count: names.length,
    folded: false,
  };
}

/** Translate plugin LLMToolSpec → Codex Responses tools shape. Flat
 *  {type, name, description, parameters} — not wrapped in a
 *  `function` object like chat/completions.
 *
 *  Y2·1 (2026-05-17) — `serverTools.imageGeneration` opt-in appends
 *  the Responses API built-in `image_generation` tool entry alongside
 *  the caller's function tools. When the opt-in value is an object,
 *  its keys (size/quality/background) pass through as native options
 *  on the tool spec. Other server-tool axes (e.g. web_search) follow
 *  the same shape. Mirrors the Gemini `serverTools` pattern from
 *  toGeminiTools (Wave C2). */
/** GPT/codex tool-schema strictness (opencode parity · 2026-07-09). OpenAI models
 *  parse tool args more reliably when object schemas set additionalProperties:false.
 *  ⚠️ Only applied to object schemas that DEFINE `properties` — free-form objects
 *  ({type:'object'} with no properties, e.g. digEvidence) are left untouched so the
 *  model can still pass arbitrary keys. strict mode is NOT enabled (would require
 *  every property in `required`). Recursive · pure · returns a new schema. */
export function strictifyToolSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(strictifyToolSchema);
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = { ...s };
  const props = s.properties as Record<string, unknown> | undefined;
  const hasDefinedProps = props && typeof props === 'object' && Object.keys(props).length > 0;
  if (props && typeof props === 'object') {
    const nextProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) nextProps[k] = strictifyToolSchema(v);
    out.properties = nextProps;
  }
  // object with NON-EMPTY defined properties → forbid extras (unless caller set it).
  // Empty `properties:{}` and free-form `{type:'object'}` are left open (digEvidence etc.).
  if (hasDefinedProps && (s.type === 'object' || s.type === undefined) && !('additionalProperties' in s)) {
    out.additionalProperties = false;
  }
  if (s.items) out.items = strictifyToolSchema(s.items);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(s[key])) out[key] = (s[key] as unknown[]).map(strictifyToolSchema);
  }
  return out;
}

/** LLMOpts.toolChoice → OpenAI Chat Completions `tool_choice`. */
export function toChatToolChoice(tc: ToolChoice | undefined): unknown {
  if (!tc) return undefined;
  if (tc === 'auto' || tc === 'required' || tc === 'none') return tc;
  return { type: 'function', function: { name: tc.name } };
}

/** LLMOpts.toolChoice → OpenAI Responses API (Codex) `tool_choice`. ⚠️ model-family
 *  차이: 현 Codex Responses 백엔드(chatgpt.com)는 'none'|'auto'|'required' 문자열만
 *  받고 특정-도구 객체({type:'function',name})는 400(invalid_type)으로 거부한다(라이브
 *  검증 2026-07-09). 그래서 {name} 특정 강제는 'required'로 다운그레이드한다 — 도구 호출
 *  자체는 보장되고, 어느 도구인지는 프롬프트가 유도한다. Chat API 는 진짜 특정-도구 유지. */
export function toResponsesToolChoice(tc: ToolChoice | undefined): unknown {
  if (!tc) return undefined;
  if (tc === 'auto' || tc === 'required' || tc === 'none') return tc;
  return 'required';
}

export function toCodexResponsesTools(
  tools: LLMToolSpec[] | undefined,
  serverTools?: LLMOpts['serverTools'],
): any[] | undefined {
  const out: any[] = [];
  if (tools && tools.length > 0) {
    for (const t of tools) {
      out.push({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: strictifyToolSchema(t.parameters),
      });
    }
  }
  if (serverTools?.imageGeneration) {
    const opts = typeof serverTools.imageGeneration === 'object'
      ? serverTools.imageGeneration
      : {};
    out.push({
      type: 'image_generation',
      ...(opts.size ? { size: opts.size } : {}),
      ...(opts.quality ? { quality: opts.quality } : {}),
      ...(opts.background ? { background: opts.background } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Translate plugin LLMToolSpec → OpenAI wire format. */
/** ⭐ Tool name UNIQUE 보장 (2026-07-19·비-codex parity). anthropic·grok/xAI 는 중복 tool
 *  name 을 400 거부(anthropic "Tool names must be unique."·grok "Duplicate function definition"),
 *  openai/codex 는 관대. 하니스가 codex-first 로 개발되며 흘러든 중복 tool spec 이 strict provider
 *  에서만 turn 을 죽였다. 모든 provider 변환 직전 name 기준 dedup(첫 항목 유지). */
export function dedupeToolsByName(tools: LLMToolSpec[] | undefined): LLMToolSpec[] | undefined {
  if (!tools || tools.length === 0) return tools;
  const seen = new Set<string>();
  const out = tools.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
  return out.length === tools.length ? tools : out;
}

export function toOpenAITools(tools: LLMToolSpec[] | undefined): any[] | undefined {
  const unique = dedupeToolsByName(tools);
  if (!unique || unique.length === 0) return undefined;
  return unique.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: strictifyToolSchema(t.parameters) },
  }));
}

/** Translate plugin LLMToolSpec → Gemini wire format. Native shape:
 *  `[{ functionDeclarations: [{name, description, parameters}, ...] }]`
 *  (a single Tool entry that contains a function-declaration array,
 *  NOT one Tool per function). Wave 1 (2026-05-04) — lifts gemini
 *  out of the OpenAI-compat tunnel that flattened tools through
 *  toOpenAITools().
 *
 *  Wave C2 (2026-05-04) — `serverTools` opt-in adds native Gemini
 *  tool entries (executed server-side by Google) alongside the
 *  client-side function declarations. Each opt-in becomes a separate
 *  Tool entry per the API spec — google_search / code_execution /
 *  url_context are mutually composable.
 *
 *  Schema sanitize (2026-05-04 hotfix) — Gemini API rejects non-
 *  string enum values with "Invalid value at ... enum[N] (TYPE_STRING)".
 *  Recursively coerce every enum entry to string so monad-agent's
 *  tool catalog (which has a few numeric enums in plugin schemas)
 *  doesn't 400 the request. */
function toGeminiTools(
  tools: LLMToolSpec[] | undefined,
  serverTools?: { googleSearch?: boolean; codeExecution?: boolean; urlContext?: boolean },
): any[] | undefined {
  const out: any[] = [];
  const uniqueTools = dedupeToolsByName(tools);  // 중복 tool name 제거(provider-무관 parity)
  if (uniqueTools && uniqueTools.length > 0) {
    out.push({
      functionDeclarations: uniqueTools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: sanitizeGeminiSchema(t.parameters) as Record<string, unknown> | undefined,
      })),
    });
  }
  if (serverTools?.googleSearch) out.push({ googleSearch: {} });
  if (serverTools?.codeExecution) out.push({ codeExecution: {} });
  if (serverTools?.urlContext) out.push({ urlContext: {} });
  return out.length > 0 ? out : undefined;
}

/** Recursively coerce JSON-Schema fragments so Gemini's strict
 *  validator accepts them. Two coercion rules per measured backend
 *  rejection (2026-05-04 log/debug-20260504000207):
 *
 *  1. Every `enum` entry must be a string (Gemini rejects number /
 *     boolean / null enums with "TYPE_STRING").
 *  2. ANY schema node carrying an `enum` field must have type='string'
 *     (Gemini rejects "{type:'number', enum:[2]}" with "enum: only
 *     allowed for STRING type"). monad-agent's scheduler tool has
 *     such a schema (workflow.version).
 *
 *  Pure deep-walk (object / array). Non-object scalars return as-is.
 *  Idempotent — running on already-string enums leaves them alone. */
function sanitizeGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeGeminiSchema);
  if (!node || typeof node !== 'object') return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const hasEnum = Array.isArray(src.enum);
  for (const [k, v] of Object.entries(src)) {
    if (k === 'enum' && Array.isArray(v)) {
      out[k] = v.map(item =>
        typeof item === 'string' ? item :
        (item === null || item === undefined) ? '' : String(item)
      );
    } else if (k === 'type' && hasEnum && typeof v === 'string' && v !== 'string') {
      // Coerce non-string types when enum is present at the same
      // node. Gemini's validator only allows enum on STRING.
      out[k] = 'string';
    } else {
      out[k] = sanitizeGeminiSchema(v);
    }
  }
  return out;
}

/** Image-pipeline P3.5 (2026-05-05) — opt-in for the Gemini 3+
 *  `functionResponse.parts` multimodal carrier. When true AND the
 *  tool_result content holds image bytes, the helper emits a `parts`
 *  array on the functionResponse with `FunctionResponsePart` items
 *  (`inline_data: {mimeType, displayName, data}`) so the model
 *  receives the bytes as actual image input. The legacy
 *  `response: {output: <text>}` companion stays as-is for the textual
 *  metadata. Set by the Gemini caller when
 *  `acceptsToolResultImage('gemini', model)` reports true (3.x+ only).
 *
 *  Pre-3.x Gemini ignores the `parts` field entirely; callers should
 *  leave the flag false to keep the wire identical to today's text-
 *  only path and avoid sending unrecognized fields.
 *
 *  P-3 §6.9 (2026-05-07) — `acceptUserMessageImages` (default true) is
 *  the user-message axis sibling. Gemini 1.5+ all support `inlineData`
 *  on user-role parts (verified via the existing allowlist); the gate
 *  is the defensive layer behind composer Q3=B for any future text-only
 *  Gemini variant. When false, user-role image parts collapse to a
 *  text placeholder. */
export interface MessagesToGeminiInputOpts {
  acceptToolImages?: boolean;
  acceptUserMessageImages?: boolean;
}

/** Convert the unified LLMMessage shape into Gemini's native
 *  `{systemInstruction, contents}` payload. Distinct from
 *  toOpenAIMessages because Gemini:
 *  - has a dedicated `systemInstruction` field (separate from contents)
 *  - uses role 'model' for assistant turns (not 'assistant')
 *  - emits `parts: [{text}, {functionCall}, {functionResponse}, {inlineData}]`
 *    instead of OpenAI's content-block scheme
 *  - uses `inlineData: {mimeType, data}` for images
 *
 *  Wave 1 (2026-05-04) — replaces the toOpenAIMessages() tunnel that
 *  folded system into messages[0].content (losing Gemini's cacheable
 *  system block) and dropped tool blocks into role:user only. */
export function messagesToGeminiInput(
  messages: LLMMessage[],
  opts: MessagesToGeminiInputOpts = {},
): {
  systemInstruction: string | undefined;
  contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }>;
} {
  const acceptToolImages = !!opts.acceptToolImages;
  // P-3 §6.9 — user-message image gating (default true; current
  // Gemini 1.5+ all accept inlineData on user role per allowlist).
  const acceptUserImages = opts.acceptUserMessageImages ?? true;
  const systemParts: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];
  // Gemini's functionResponse requires the SAME name as the
  // matching functionCall (backend matches by name first, then id).
  // Anthropic-shape tool_result blocks carry only `tool_use_id` —
  // we walk the message history and build an id→name map from
  // every tool_use seen so the converter can look up the correct
  // name when emitting the matching tool_result. Without this map,
  // elanous's pre-2026-05-04 wire used name='tool' hardcoded which
  // backend rejected on multi-turn (400 INVALID_ARGUMENT after the
  // 5th content where the second functionResponse didn't match the
  // active loop's first functionCall).
  const toolUseNameById = new Map<string, string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && typeof b === 'object' && b.type === 'tool_use' && b.id && b.name) {
        toolUseNameById.set(b.id, b.name);
      }
    }
  }

  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') {
        if (m.content) systemParts.push(m.content);
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && typeof b === 'object' && b.type === 'text' && b.text) {
            systemParts.push(b.text);
          }
        }
      }
      continue;
    }

    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
    const parts: Array<Record<string, unknown>> = [];

    if (typeof m.content === 'string') {
      if (m.content) parts.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          if (b.text) parts.push({ text: b.text });
        } else if (b.type === 'image') {
          // Gemini accepts inlineData on user role only; for assistant
          // (shouldn't happen from our code, defensive) downgrade to
          // a placeholder text so the model doesn't 400.
          if (role === 'user') {
            // P-3 §6.9 — defensive gate behind composer Q3=B. Default
            // accepts (current Gemini 1.5+ all support inlineData);
            // setting acceptUserMessageImages=false collapses to text
            // for hypothetical text-only Gemini variants.
            if (!acceptUserImages) {
              parts.push({ text: `[image: ${b.mediaType} (model not vision-capable)]` });
            } else {
              parts.push({ inlineData: { mimeType: b.mediaType, data: b.base64 } });
            }
          } else {
            parts.push({ text: '[image]' });
          }
        } else if (b.type === 'video') {
          // PR8 (2026-05-14) — Gemini 1.5+ native video via inlineData
          // on user role (mp4/quicktime/webm/mpeg/x-flv/x-msvideo/3gpp
          // per ai.google.dev/gemini-api/docs/vision#video). Up to
          // ~20MB inline; larger needs Files API upload (deferred —
          // resource_link path is the future replacement when caller
          // hands us a URI rather than inline base64).
          if (role === 'user') {
            parts.push({ inlineData: { mimeType: b.mediaType, data: b.base64 } });
          } else {
            // Defensive — assistant role with video shouldn't happen.
            parts.push({ text: '[video]' });
          }
        } else if (b.type === 'audio') {
          // W8-A 후속 #3 (2026-05-14) — Gemini 1.5+ native audio via
          // inlineData on user role. Supports wav/mp3/aiff/aac/ogg/flac
          // per ai.google.dev/gemini-api/docs/audio. Up to ~20MB inline ·
          // larger needs Files API upload (deferred · resource_link
          // future replacement). elanous runtime 이 이미 generateContent
          // stream 사용 — audio block dispatch 만 추가하면 native 가능.
          if (role === 'user') {
            parts.push({ inlineData: { mimeType: b.mediaType, data: b.base64 } });
          } else {
            parts.push({ text: '[audio]' });
          }
        } else if (b.type === 'tool_use') {
          parts.push({
            functionCall: {
              id: b.id,
              name: b.name,
              args: b.input ?? {},
            },
          });
        } else if (b.type === 'tool_result') {
          // Look up the corresponding functionCall.name from the
          // pre-walked map. Falls back to 'tool' only when the
          // matching tool_use wasn't seen — defensive for histories
          // where /clear truncated the call but kept the result.
          const matchedName = toolUseNameById.get(b.tool_use_id) ?? 'tool';
          // Image-pipeline P3.5 (2026-05-05) — Gemini 3+ supports
          // multimodal `functionResponse.parts` carrying
          // FunctionResponsePart entries with `inline_data`. When
          // the caller opted in (acceptToolImages, set by Gemini
          // provider for 3.x+) AND the tool_result holds image
          // bytes, attach them as `parts`. The companion `response`
          // stays text-only — keeps the textual metadata as the
          // model's primary read while the parts deliver pixels.
          // Legacy text-only path (string content, plain text array,
          // pre-3.x model) leaves the parts field off so the wire
          // payload stays unchanged for the wide majority of calls.
          const responseText = stringifyToolResultContent(b.content);
          const fr: Record<string, unknown> = {
            id: b.tool_use_id,
            name: matchedName,
            response: { output: responseText },
          };
          if (
            acceptToolImages
            && Array.isArray(b.content)
            && b.content.some((item) => item.type === 'image')
          ) {
            const responseParts: Array<Record<string, unknown>> = [];
            let imgIdx = 0;
            for (const item of b.content) {
              if (item.type === 'image') {
                imgIdx += 1;
                responseParts.push({
                  inlineData: {
                    mimeType: item.mediaType,
                    // Display name lets the model reference the
                    // attachment by friendly id; we mint a stable
                    // synthetic name keyed by call_id + image index
                    // so multi-image results stay deterministic.
                    displayName: `${b.tool_use_id}-img-${imgIdx}`,
                    data: item.base64,
                  },
                });
              }
            }
            if (responseParts.length > 0) {
              fr.parts = responseParts;
            }
          }
          parts.push({ functionResponse: fr });
        }
      }
    }

    if (parts.length > 0) contents.push({ role, parts });
  }

  // Defensive: backend rejects empty contents. Mirror the OpenAI
  // adapter's empty-prompt placeholder.
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: '' }] });
  }

  // 2026-05-04 hotfix — Gemini API 의 thinking-enabled 모드는 model
  // turn 의 첫 번째 functionCall part 에 `thoughtSignature` 가 있어야
  // 다음 turn 의 input 으로 받아들임 ("Function call is missing a
  // thought_signature in functionCall parts" 400). monad-agent 의
  // LLMMessage 는 signature 를 보존하지 않으므로 ref/gemini-cli 의
  // `ensureActiveLoopHasThoughtSignatures` 패턴 차용해 synthetic
  // placeholder 로 채움.
  for (const content of contents) {
    if (content.role !== 'model' || !Array.isArray(content.parts)) continue;
    let firstCallSeen = false;
    for (const part of content.parts) {
      const p = part as { functionCall?: unknown; thoughtSignature?: string };
      if (p.functionCall && !firstCallSeen) {
        firstCallSeen = true;
        if (!p.thoughtSignature) {
          p.thoughtSignature = GEMINI_SYNTHETIC_THOUGHT_SIGNATURE;
        }
      }
    }
  }

  return {
    systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    contents,
  };
}

/** Placeholder thoughtSignature value for model turns that contain a
 *  functionCall part. Required by Gemini's thinking-enabled validator
 *  on multi-turn requests. The backend treats `thought_signature`
 *  as TYPE_BYTES (Base64-decoded) — arbitrary strings fail with
 *  "Base64 decoding failed". ref/gemini-cli's
 *  `ensureActiveLoopHasThoughtSignatures` uses the literal token
 *  `skip_thought_signature_validator`, which the Gemini backend
 *  recognizes as a "skip validation" sentinel. We mirror that exact
 *  string so monad-agent's multi-turn requests pass the same check. */
const GEMINI_SYNTHETIC_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';


/**
 * Gemini `usageMetadata` → elanous 사용량 규약(BACKLOG C8 · 2026-09-25 🅣).
 * ⛔ `promptTokenCount` 는 캐시 적중분(`cachedContentTokenCount`)을 «포함»한다 — elanous 규약(새 입력만 · C4)으로 뺀다.
 * ⛔ `candidatesTokenCount` 는 생각(thinking) 토큰을 «안» 담는다 — Gemini 는 `thoughtsTokenCount` 를 출력 단가로 따로 매긴다.
 *    종전엔 그 칸을 안 읽어 추론 토큰이 과금·관측에서 통째로 빠졌다. ⇒ 출력에 더하고 `reasoningOutputTokens` 로도 남긴다
 *    (OpenAI 규약과 같다: 추론은 출력의 «부분집합»).
 */
export function geminiUsageFromMetadata(t: { promptTokens: number; outputTokens: number; cachedTokens: number; thoughtTokens: number; toolUsePromptTokens?: number }):
  { provider: 'openai'; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; reasoningOutputTokens?: number } | undefined {
  const cached = Math.max(0, t.cachedTokens);
  // ⭐ `toolUsePromptTokenCount`(검색·코드 실행 등 내장 도구의 프롬프트)는 `promptTokenCount` «밖»이고 입력으로 청구된다 —
  //   gemini-cli 도 따로 센다(upstream `google-gemini/gemini-cli` `packages/core/src/telemetry/uiTelemetry.ts` · `input = prompt - cached`).
  const input = Math.max(0, t.promptTokens - cached) + Math.max(0, t.toolUsePromptTokens ?? 0);
  const thoughts = Math.max(0, t.thoughtTokens);
  const output = Math.max(0, t.outputTokens) + thoughts;
  if (t.promptTokens <= 0 && output <= 0 && cached <= 0) return undefined;
  return {
    provider: 'openai',
    ...(input > 0 ? { inputTokens: input } : {}),
    ...(output > 0 ? { outputTokens: output } : {}),
    ...(cached > 0 ? { cacheReadInputTokens: cached } : {}),
    ...(thoughts > 0 ? { reasoningOutputTokens: thoughts } : {}),
  };
}

/** Stream against the native Gemini API via @google/genai SDK.
 *  Replaces the OpenAI-compat tunnel that elanous previously used
 *  (`streamOpenAIEvents(GEMINI_API_URL, ...)`), which couldn't carry
 *  Gemini's native fields:
 *  - `systemInstruction` (separate cacheable system block)
 *  - `thinkingConfig` (extended thinking budget on gemini-2.5+)
 *  - `safetySettings` (filter tuning per category)
 *  - finishReason 'SAFETY' / 'BLOCKED' (filter rejection surface)
 *
 *  Yields the same `LLMStreamEvent` union as the other providers so
 *  upstream callers (streamLLMWithTools, etc) don't care which
 *  provider produced the events. */

export async function* streamGeminiEvents(
  apiKey: string,
  body: {
    model: string;
    systemInstruction?: string;
    contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }>;
    tools?: unknown[];
    /** Native thinking-config opt-in. When set, the wire body carries
     *  `thinkingConfig: { thinkingBudget | thinkingLevel, includeThoughts }`
     *  so the model emits its reasoning trace alongside the answer.
     *  Mapped from the cross-provider ReasoningLevel via
     *  `mapReasoningLevelToGeminiThinking`. gemini-2.5 family uses
     *  `thinkingBudget` (number); gemini-3+ uses `thinkingLevel` enum
     *  (`'LOW'|'MEDIUM'|'HIGH'`). The two are mutually exclusive. */
    thinkingBudget?: number;
    thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
    includeThoughts?: boolean;
    /** Optional safety filter tuning. Empty → backend defaults
     *  (BLOCK_MEDIUM_AND_ABOVE per category). */
    safetySettings?: unknown[];
    /** Wave C4 (2026-05-04) — structured output. When set, the wire
     *  body carries `responseMimeType` + (optional) `responseSchema`
     *  so the model is constrained to emit JSON matching the schema.
     *  Useful for skill / tool-gateway responses that need
     *  programmatic parsing. Omit for free-form text. */
    responseMimeType?: 'application/json' | 'text/plain';
    responseSchema?: Record<string, unknown>;
    temperature?: number;
    /** Wave 2 (2026-05-04) — gemini-3 family wants `temperature: 1`
     *  paired with `topP: 0.95` + `topK: 64` (ref/gemini-cli
     *  `defaultModelConfigs.ts` chat-base-3 alias). monad-agent's
     *  default 0.3 starves the tool-call decision sampling and
     *  produces single-turn termination on multi-turn scenarios. */
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
  },
  signal?: AbortSignal,
): AsyncGenerator<LLMStreamEvent, void, unknown> {
  const startedAt = Date.now();
  debug.log('llm.request', `gemini ${body.model}`, {
    model: body.model,
    contentsCount: body.contents.length,
    tools: Array.isArray(body.tools) ? (body.tools[0] as { functionDeclarations?: unknown[] })?.functionDeclarations?.length ?? 0 : 0,
    systemInstructionChars: body.systemInstruction?.length ?? 0,
    thinkingBudget: body.thinkingBudget ?? null,
    thinkingLevel: body.thinkingLevel ?? null,
    includeThoughts: body.includeThoughts ?? null,
    temperature: body.temperature ?? null,
    topP: body.topP ?? null,
    topK: body.topK ?? null,
    maxOutputTokens: body.maxOutputTokens ?? null,
  });

  const { GoogleGenAI } = await import('@google/genai');
  const client = new GoogleGenAI({ apiKey });

  const config: Record<string, unknown> = {};
  if (body.systemInstruction) {
    config.systemInstruction = { parts: [{ text: body.systemInstruction }] };
  }
  if (body.thinkingBudget !== undefined) {
    config.thinkingConfig = {
      thinkingBudget: body.thinkingBudget,
      includeThoughts: body.includeThoughts ?? false,
    };
  } else if (body.thinkingLevel !== undefined) {
    // gemini-3+ wire shape — `thinkingLevel` enum string. SDK exposes
    // ThinkingLevel enum (HIGH/MEDIUM/LOW/MINIMAL) at runtime; we send
    // the literal string value to keep the wire body decoupled from
    // SDK enum import / version churn.
    config.thinkingConfig = {
      thinkingLevel: body.thinkingLevel,
      includeThoughts: body.includeThoughts ?? false,
    };
  }
  if (body.safetySettings && body.safetySettings.length > 0) {
    config.safetySettings = body.safetySettings;
  }
  if (body.responseMimeType) {
    config.responseMimeType = body.responseMimeType;
    if (body.responseSchema) config.responseSchema = body.responseSchema;
  }
  if (body.tools) config.tools = body.tools;
  if (body.temperature !== undefined) config.temperature = body.temperature;
  if (body.topP !== undefined) config.topP = body.topP;
  if (body.topK !== undefined) config.topK = body.topK;
  if (body.maxOutputTokens !== undefined) config.maxOutputTokens = body.maxOutputTokens;

  // SDK returns its native GenerateContentResponse iterator; we
  // duck-type the chunk fields below (candidates / parts / usage).
  let stream: AsyncIterable<unknown>;
  try {
    stream = await client.models.generateContentStream({
      model: body.model,
      contents: body.contents,
      config,
    });
  } catch (err) {
    // Dual-emit: keep llm.response.status for backward-compat dashboards,
    // add llm.response.error so a `grep llm.response.error` finds gemini
    // failures the same way it finds anthropic/codex/grok ones (incident
    // 2026-05-04 — gemini call failed silently in log/latest because the
    // only emit was status with phase="error" buried in the event field).
    const stack = (err as { stack?: string })?.stack;
    debug.log('llm.response.status', `gemini error`, {
      model: body.model,
      elapsedMs: Date.now() - startedAt,
      err: String(err),
    });
    debug.log('llm.response.error', `gemini ${body.model}`, {
      provider: 'gemini',
      model: body.model,
      phase: 'generateContentStream',
      elapsedMs: Date.now() - startedAt,
      err: String(err),
      errName: (err as { name?: string })?.name ?? null,
      stack: stack ? stack.split('\n').slice(0, 8).join('\n') : null,
    }, { level: 'error' });
    throw err;
  }

  let promptTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let thoughtTokens = 0;
  let toolUsePromptTokens = 0;

  try {
    for await (const rawChunk of stream) {
      if (signal?.aborted) return;
      // Duck-typed view of the SDK's GenerateContentResponse so the
      // wire-shape extraction below stays decoupled from SDK type
      // churn. Field access uses optional chaining + typeof guards.
      const chunk = rawChunk as {
        candidates?: Array<{
          content?: { parts?: Array<Record<string, unknown>> };
          finishReason?: string;
          safetyRatings?: Array<{ category: string; probability: string }>;
        }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          cachedContentTokenCount?: number;
          thoughtsTokenCount?: number;
          toolUsePromptTokenCount?: number;
        };
      };

      const candidate = chunk.candidates?.[0];
      if (candidate) {
        // Safety / policy block — surface as a thrown error so the
        // upstream classifyError() (Wave 2) maps it to
        // 'safety-blocked' category. Includes the safety ratings so
        // forensic reviewers can see WHY the block fired.
        const finish = candidate.finishReason;
        if (finish === 'SAFETY' || finish === 'BLOCKED' || finish === 'PROHIBITED_CONTENT') {
          const ratings = (candidate.safetyRatings ?? [])
            .map(r => `${r.category}=${r.probability}`)
            .join(', ');
          throw new Error(
            `Gemini safety filter blocked content (finishReason=${finish}${ratings ? `; ${ratings}` : ''})`,
          );
        }
        // Wave 2 (2026-05-04) — malformed/unexpected tool call. ref/
        // gemini-cli treats these as retryable mid-stream errors
        // (geminiChat.ts MID_STREAM_RETRY_OPTIONS, 4 attempts). elanous
        // previously let them pass silently → tool-loop saw an empty
        // turn and bailed. Throw a tagged error so the streamGemini
        // wrapper (below) can retry once.
        if (finish === 'MALFORMED_FUNCTION_CALL' || finish === 'UNEXPECTED_TOOL_CALL') {
          const err = new Error(
            `Gemini malformed tool call (finishReason=${finish})`,
          ) as Error & { __geminiRetryable?: true };
          err.__geminiRetryable = true;
          throw err;
        }

        const parts = candidate.content?.parts ?? [];
        for (const part of parts) {
          // `thought: true` parts carry the reasoning summary stream
          // when thinkingConfig.includeThoughts is set. Treat them as
          // reasoning events so the HUD pill renders the same way as
          // codex's reasoning_summary stream.
          if ((part as { thought?: boolean }).thought === true) {
            const text = (part as { text?: string }).text;
            if (text) {
              yield { type: 'reasoning', kind: 'summary_delta', delta: text };
            }
            continue;
          }
          const text = (part as { text?: string }).text;
          if (text) {
            yield { type: 'text', delta: text };
            continue;
          }
          const fc = (part as { functionCall?: { id?: string; name?: string; args?: Record<string, unknown> } }).functionCall;
          if (fc) {
            yield {
              type: 'tool_call',
              id: fc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              name: fc.name || '',
              args: fc.args || {},
            };
          }
        }
      }

      const u = chunk.usageMetadata;
      if (u) {
        if (typeof u.promptTokenCount === 'number') promptTokens = u.promptTokenCount;
        if (typeof u.candidatesTokenCount === 'number') outputTokens = u.candidatesTokenCount;
        if (typeof u.cachedContentTokenCount === 'number') cachedTokens = u.cachedContentTokenCount;
        if (typeof u.thoughtsTokenCount === 'number') thoughtTokens = u.thoughtsTokenCount;
        if (typeof u.toolUsePromptTokenCount === 'number') toolUsePromptTokens = u.toolUsePromptTokenCount;
      }
    }

    const geminiUsage = geminiUsageFromMetadata({ promptTokens, outputTokens, cachedTokens, thoughtTokens, toolUsePromptTokens });
    if (geminiUsage) yield { type: 'usage', usage: geminiUsage };

    debug.log('llm.response.status', `gemini done`, {
      model: body.model,
      elapsedMs: Date.now() - startedAt,
      promptTokens,
      outputTokens,
      cachedTokens,
      thoughtTokens,
      toolUsePromptTokens,
    });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') return;
    const stack = (err as { stack?: string })?.stack;
    debug.log('llm.response.status', `gemini stream error`, {
      model: body.model,
      elapsedMs: Date.now() - startedAt,
      err: String(err),
    });
    debug.log('llm.response.error', `gemini ${body.model}`, {
      provider: 'gemini',
      model: body.model,
      phase: 'stream-iter',
      elapsedMs: Date.now() - startedAt,
      err: String(err),
      errName: (err as { name?: string })?.name ?? null,
      stack: stack ? stack.split('\n').slice(0, 8).join('\n') : null,
      promptTokens,
      outputTokens,
      cachedTokens,
    }, { level: 'error' });
    throw err;
  }
}

// ── Anthropic streaming parser (SSE format differs from OpenAI) ──
// Anthropic streams a sequence of events:
//   content_block_start → { content_block: {type:'text'|'tool_use', id?, name?} }
//   content_block_delta → { delta: {type:'text_delta'|'input_json_delta'} }
//   content_block_stop
// Tool call inputs are streamed as partial_json fragments — we
// accumulate by block index and emit the complete tool_call event
// on content_block_stop.

interface AnthropicToolCallAccum {
  id: string;
  name: string;
  argsJson: string;
}

/** Pure SSE parser for Anthropic's content_block_* event stream.
 *  Exported for unit tests — no fetch dependency. Also emits a
 *  `usage` event whenever message_start / message_delta carries
 *  token counters (including prompt-cache read/creation totals). */
export async function* parseAnthropicSSELines(
  lines: AsyncIterable<string> | Iterable<string>,
): AsyncGenerator<LLMStreamEvent, void, unknown> {
  const { parseAnthropicUsage } = await import('./prompt-cache/anthropic.js');
  const toolBlocks: Map<number, AnthropicToolCallAccum> = new Map();
  let pendingUsage: import('./prompt-cache/types.js').LLMUsage | null = null;
  for await (const line of lines as AsyncIterable<string>) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (!data) continue;
    let parsed: any;
    try { parsed = JSON.parse(data); } catch { continue; }

    // ⛔⭐ 사용량은 한 호출에 «한 줄»이다(BACKLOG C3). message_start(입력·캐시·출력 1)와 message_delta(누적 출력 ·
    //   최신 API 는 입력도 누적으로 다시 싣는다)를 각각 내보내면 소비자(streamLLM 합산·llm-usage)가 «더해» 이중 계수한다.
    //   ⇒ 칸별로 «나중 값이 이긴다»로 합쳐 message_stop(또는 스트림 끝)에 한 번 낸다 — opencode anthropic-messages.ts 와 같은 규칙.
    if (parsed.type === 'message_start' || parsed.type === 'message_delta') {
      const usage = parseAnthropicUsage(parsed);
      if (usage) pendingUsage = { ...(pendingUsage ?? {}), ...usage };
      continue;
    }
    if (parsed.type === 'message_stop') {
      if (pendingUsage) { yield { type: 'usage', usage: pendingUsage }; pendingUsage = null; }
      continue;
    }

    if (parsed.type === 'content_block_start') {
      const idx = parsed.index ?? 0;
      const cb = parsed.content_block;
      if (cb?.type === 'tool_use') {
        toolBlocks.set(idx, { id: cb.id || '', name: cb.name || '', argsJson: '' });
      } else if (cb?.type === 'thinking') {
        // Extended-thinking block start — emit a paragraph separator
        // on the shared reasoning channel so the same dashboard
        // renderer that handles codex `summary_text.delta` also
        // handles anthropic `thinking_delta` uniformly.
        yield { type: 'reasoning', kind: 'summary_part_added', summaryIndex: idx };
      }
    } else if (parsed.type === 'content_block_delta') {
      const idx = parsed.index ?? 0;
      if (parsed.delta?.type === 'text_delta') {
        const text = parsed.delta.text || '';
        if (text) yield { type: 'text', delta: text };
      } else if (parsed.delta?.type === 'input_json_delta') {
        const accum = toolBlocks.get(idx);
        if (accum) accum.argsJson += parsed.delta.partial_json || '';
      } else if (parsed.delta?.type === 'thinking_delta') {
        // Extended-thinking summary delta — same channel as codex.
        const text = parsed.delta.thinking || '';
        if (text) yield { type: 'reasoning', kind: 'summary_delta', delta: text, summaryIndex: idx };
      }
    } else if (parsed.type === 'content_block_stop') {
      const idx = parsed.index ?? 0;
      const accum = toolBlocks.get(idx);
      if (accum) {
        let args: Record<string, unknown> = {};
        try { args = accum.argsJson ? JSON.parse(accum.argsJson) : {}; } catch { /* empty */ }
        yield { type: 'tool_call', id: accum.id, name: accum.name, args };
        toolBlocks.delete(idx);
      }
    }
  }
  // message_stop 없이 끊긴 스트림 — 모은 사용량을 잃지 않는다.
  if (pendingUsage) yield { type: 'usage', usage: pendingUsage };
}

async function* streamAnthropicEvents(
  apiKey: string,
  body: any,
  signal?: AbortSignal,
  remainingFallbacks?: number,
): AsyncGenerator<LLMStreamEvent, void, unknown> {
  // Wave 6 (2026-05-04) — Anthropic beta headers from
  // ref/opencode `provider/provider.ts:181-185` analysis.
  //
  // - **fine-grained-tool-streaming-2025-05-14**: lets the SSE stream
  //   emit tool args incrementally instead of buffering until the
  //   final block — reduces perceived tool-call latency on long-arg
  //   calls (e.g. Edit with large `new_string`). Supported on all
  //   modern Claude families.
  //
  // - **interleaved-thinking-2025-05-14**: allows extended-thinking
  //   models to insert reasoning between tool_use blocks (instead of
  //   forcing a single thinking block before all tools). Improves
  //   multi-tool turn quality — the model can decide what to call
  //   next based on the prior tool's output thinking. Only supported
  //   on extended-thinking-capable models (claude-3-7 / 4 family).
  const model: string = (body?.model ?? '') as string;
  const m = model.toLowerCase();
  const supportsThinking =
    m.includes('-4-') || m.includes('-3-7') || m.includes('3.7') || m.includes('claude-4');
  const betas: string[] = ['fine-grained-tool-streaming-2025-05-14'];
  if (supportsThinking) betas.push('interleaved-thinking-2025-05-14');

  const response = await fetchApiWithRetry(
    ANTHROPIC_API_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': betas.join(','),
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    },
    retryOptsFor('anthropic', 'Anthropic API', remainingFallbacks),
  );

  try {
    yield* parseAnthropicSSELines(sseLineStream(response.body!));
  } catch (err: any) {
    if (err.name === 'AbortError') return;
    throw err;
  }
}

/** Translate plugin LLMToolSpec → Anthropic wire format. */
function toAnthropicTools(tools: LLMToolSpec[] | undefined): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

/** 에러에서 HTTP 상태를 캔다. ⛔ 던지는 쪽 형태가 판본마다 달라 «둘 다» 본다:
 *  구조화 필드(`status`) 우선, 없으면 문면의 3자리 수. 못 캐면 0(=「모른다」). */
function grokHttpStatus(err: unknown): number {
  const s = (err as { status?: unknown })?.status;
  if (typeof s === 'number' && Number.isFinite(s)) return s;
  const m = /\b(4\d{2}|5\d{2})\b/.exec((err as Error)?.message ?? String(err));
  return m ? Number(m[1]) : 0;
}

// ── Provider implementations ──

export const GrokProvider: LLMProvider = {
  name: 'grok',
  defaultModel: GROK_MODEL,
  // ⭐ 구독(auth.json)이 있으면 API 키가 없어도 «가용»이다 — 예전엔 키만 봤다.
  available: () => resolveGrokCredential() !== null,
  async *streamChat(messages, opts = {}) {
    // ⭐⭐ 구독 1순위 · API 키 2순위 (대표 2026-08-13). 자격이 «어디로 무엇을 들고
    //   가나»를 통째로 정한다 — 구독이면 cli-chat-proxy(구독 과금), 키면
    //   api.x.ai(토큰 과금). ACP 경로(env 스크럽)와 «같은 규칙»을 공유한다.
    // ⭐ 「접힌」 해석 — 만료 임박이면 «미리» 갱신을 유도한다(호출자가 기억할 것 0).
    //   ⚠️ 아래 401 강등 경로는 «안전망»으로 그대로 둔다 — 만료 판정이 놓친 경우가 남는다.
    const grokCred = resolveFreshGrokCredential({ model: opts.model || GROK_MODEL });
    if (!grokCred) {
      throw new Error('Grok unavailable: run `grok login` (구독) 또는 XAI_API_KEY/GROK_API_KEY 설정');
    }
    const apiKey = grokCred.token;
    const tools = toOpenAITools(opts.tools);
    // Grok is OpenAI-compatible; we mirror OpenAIProvider's
    // stream_options.include_usage so input/output token counts
    // reach the metrics singleton. Grok itself does not (as of
    // 2026-04) report cache_tokens — parseOpenAIUsage silently
    // returns without that field, which is fine.
    const includeUsage = opts.promptCache !== false;
    // Image-pipeline P3.5 — vision-capable Grok models (grok-2-vision,
    // grok-3, grok-4.x base) accept image_url on user messages. The
    // synthetic follow-up workaround inside toOpenAIMessages turns
    // image-bearing tool_results into a text tool message + follow-up
    // user-message with the actual bytes.
    const grokModel = opts.model || GROK_MODEL;
    const grokFollowup = isVisionCapableModel('grok', grokModel, 'userMessage');
    debug.log('llm.grok', 'credential', { kind: grokCred.kind, source: grokCred.source, baseUrl: grokCred.baseUrl });
    // ⛔⭐⭐ **401 → 강등 → 1회 재시도** (2026-08-14 실측으로 «필요»가 확정됐다).
    //
    //   설계 초안은 "만료돼도 refresh 가 살아 있으면 바이너리가 갱신한다"고 적었는데,
    //   그것은 ***바이너리가 «돌 때»만 참***이다. 프로바이더 경로는 파일을 «읽을 뿐»이라
    //   access token(수명 6시간)이 지나면 갱신해 줄 사람이 없다 ⇒ 그냥 401 이 난다.
    //   (실측: expires_at 19:45 · 조회 21:46 → HTTP 401.)
    //
    //   ⇒ 구독으로 쐈다가 401 이면 «API 키로 한 번» 내려가 본다. 키가 없으면 원 에러를
    //     그대로 올리되 실행 가능한 문면을 잇는다. ⛔ 재시도는 «정확히 1회**(루프 가드).
    const grokBody = {
      model: grokModel,
      messages: messages.flatMap((m) => toOpenAIMessages(m, {
        acceptToolImagesViaFollowup: grokFollowup,
        acceptUserMessageImages: grokFollowup,
      })),
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 2048,
      ...(tools ? { tools } : {}),
      ...(toChatToolChoice(opts.toolChoice) ? { tool_choice: toChatToolChoice(opts.toolChoice) } : {}),
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    };
    try {
      // ⛔ 구독 프록시는 «본문이 아니라 헤더»(x-grok-model-override)로 백엔드를 고른다.
      //   빠지면 HTTP 426(실측).
      yield* streamOpenAIEvents(
        `${grokCred.baseUrl}/chat/completions`, apiKey, grokBody, opts.signal,
        grokCred.kind === 'subscription' ? grokCred.headers : undefined,
      );
    } catch (err) {
      const subscriptionExpired = grokCred.kind === 'subscription' && isGrokUnauthorized(grokHttpStatus(err));
      if (!subscriptionExpired) throw err;

      // ⭐⭐⭐ **① 먼저 «갱신»을 시도한다 — 강등보다 «앞»이다** (2026-08-14 실측).
      //   access token 은 6시간짜리지만 refresh 는 세션 수명 동안 살아 있고, 인증이 필요한
      //   grok 명령 한 번이면 바이너리가 조용히 갱신한다. ⛔ 이 칸이 «없으면» 구독이
      //   멀쩡한데 유료 API 키로 새 나간다 — 이 파일이 지키려던 것과 정반대가 된다.
      const refreshed = refreshGrokSubscriptionToken();
      debug.log('llm.grok', 'refresh-attempt', { outcome: refreshed }, { level: 'warn' });
      if (refreshed === 'refreshed') {
        const renewed = resolveGrokCredential({ model: grokModel });
        if (renewed?.kind === 'subscription') {
          // ⛔ 재시도는 «정확히 1회» — 여기서 또 401 이면 아래 강등으로 안 가고 던진다.
          //   (갱신 직후에도 401 이면 갱신이 아니라 «자격 자체»의 문제다.)
          yield* streamOpenAIEvents(
            `${renewed.baseUrl}/chat/completions`, renewed.token, grokBody, opts.signal, renewed.headers,
          );
          return;
        }
      }

      // ② 갱신이 안 됐다 — 그때만 API 키로 내려간다(지갑이 바뀌므로 관측에 «반드시» 남긴다).
      const downgraded = resolveGrokCredential({ model: grokModel, skipSubscription: true });
      if (!downgraded) {
        // ③ 키도 없다 — 원 에러를 버리지 않고 실행 가능한 한 줄을 잇는다.
        throw new Error(
          `${(err as Error)?.message ?? String(err)} · grok 구독 토큰 만료 (갱신 ${refreshed}) — 터미널에서 \`grok login\` 후 재시도`,
          { cause: err },
        );
      }
      debug.log('llm.grok', 'downgrade', {
        from: 'subscription', to: downgraded.kind, source: downgraded.source, refreshOutcome: refreshed,
      }, { level: 'warn' });
      yield* streamOpenAIEvents(
        `${downgraded.baseUrl}/chat/completions`, downgraded.token, grokBody, opts.signal,
      );
    }
  },
  async *chat(messages, opts = {}) { yield* textOnly(this.streamChat!(messages, opts)); },
};

export const OpenAIProvider: LLMProvider = {
  name: 'openai',
  defaultModel: OPENAI_MODEL,
  available: () => !!getOpenAIApiKey(),
  async *streamChat(messages, opts = {}) {
    const apiKey = getOpenAIApiKey();
    if (!apiKey) throw new Error('OpenAI unavailable: set OPENAI_API_KEY');
    const tools = toOpenAITools(opts.tools);
    // stream_options.include_usage brings the final usage chunk —
    // carries prompt_tokens_details.cached_tokens from OpenAI's
    // automatic prompt cache. Gated on promptCache !== false so
    // callers can opt out for wire-shape-sensitive tests.
    const includeUsage = opts.promptCache !== false;
    // Image-pipeline P3.5 — vision-capable OpenAI models (gpt-4o
    // family + gpt-5.x via Chat Completions) accept image_url on
    // user messages. The synthetic follow-up workaround in
    // toOpenAIMessages bridges this for tool_results carrying images.
    const openaiModel = opts.model || OPENAI_MODEL;
    const openaiFollowup = isVisionCapableModel('openai', openaiModel, 'userMessage');
    yield* streamOpenAIEvents(OPENAI_API_URL, apiKey, {
      model: openaiModel,
      messages: messages.flatMap((m) => toOpenAIMessages(m, {
        acceptToolImagesViaFollowup: openaiFollowup,
        acceptUserMessageImages: openaiFollowup,
      })),
      ...openAiTemperatureField(openaiModel, opts.temperature ?? 0.3),
      ...openAiOutputTokenField(openaiModel, opts.maxTokens ?? 2048),
      ...(tools ? { tools } : {}),
      ...(toChatToolChoice(opts.toolChoice) ? { tool_choice: toChatToolChoice(opts.toolChoice) } : {}),
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    }, opts.signal);
  },
  async *chat(messages, opts = {}) { yield* textOnly(this.streamChat!(messages, opts)); },
};

export const AnthropicProvider: LLMProvider = {
  name: 'anthropic',
  defaultModel: ANTHROPIC_MODEL,
  available: () => !!getAnthropicApiKey(),
  async *streamChat(messages, opts = {}) {
    const apiKey = getAnthropicApiKey();
    if (!apiKey) throw new Error('Anthropic unavailable: set ANTHROPIC_API_KEY');

    // Prompt caching: ON by default for Anthropic. All 4 of
    // Anthropic's cache_control slots are used when the dialogue is
    // long enough:
    //   1. system  — tail block of the collapsed system buffer
    //   2. tools   — tail tool of the tool array
    //   3. history — tail block of messages[N-2] (cascades each turn)
    //   4. anchor  — tail block of messages[0] (stable across the
    //                whole session; activates at ≥4 messages)
    // Callers can opt out with `promptCache:false`; TTL defaults via
    // ELANOUS_PROMPT_CACHE_TTL env (falls back to '5m'), and can be
    // overridden per-call via `promptCacheTTL:'1h'`.
    // See 내부 문서 `PLAN-prompt-cache-phase3`.
    const { getDefaultCacheTTL } = await import('./config.js');
    const cache = opts.promptCache !== false;
    const ttl = opts.promptCacheTTL ?? getDefaultCacheTTL();
    const {
      toAnthropicSystemBlocks, toAnthropicToolsCached,
      applyHistoryCacheBreakpoint, applyAnchorCacheBreakpoint,
    } = await import('./prompt-cache/anthropic.js');
    const system = toAnthropicSystemBlocks(messages, { cache, ttl });
    // P-3 §6.9 — gate user-message image blocks on the vision-capability
    // allowlist (current Claude 3.5+ all true; future text-only variants
    // get a text placeholder instead of a 400 from Anthropic).
    const anthropicModel = opts.model || ANTHROPIC_MODEL;
    const acceptUserImages = isVisionCapableModel('anthropic', anthropicModel, 'userMessage');
    let convo = messages
      .filter(m => m.role !== 'system')
      .map(m => toAnthropicMessage(m, { acceptUserMessageImages: acceptUserImages }));
    convo = applyAnchorCacheBreakpoint(convo, { cache, ttl });
    convo = applyHistoryCacheBreakpoint(convo, { cache, ttl });
    const tools = toAnthropicToolsCached(opts.tools, { cache, ttl });

    yield* streamAnthropicEvents(apiKey, {
      model: anthropicModel,
      messages: convo,
      ...(system !== undefined ? { system } : {}),
      max_tokens: opts.maxTokens ?? 2048,
      // 4.8+ adaptive thinking API 는 temperature 를 거부(400 "deprecated for this model").
      // reasoning-aware 경로(9005)와 동일하게 adaptive 모델엔 temperature 를 빼고, 아니면 0.3
      // (dogfood 2026-07-13: base AnthropicProvider 로 claude-opus-4-8 직접 호출 시 400).
      ...anthropicTemperatureField(anthropicModel, false, opts.temperature),
      ...(tools ? { tools } : {}),
    }, opts.signal);
  },
  async *chat(messages, opts = {}) { yield* textOnly(this.streamChat!(messages, opts)); },
};

// H6 P2 Bundle 1 · local-llm multi-node resolver.
//
// Parses `local-llm:<node>:<model>` specs and routes to the matching
// node's LM Studio API via the Manager's cached inventory. Falls back
// to the legacy `LOCAL_LLM_URL` single-host path when the spec is
// `local:<model>` or the node is `'local'` without a probed baseUrl.
//
// The Manager cache only populates after `/llm nodes` / `/llm refresh`
// / `LlmListNodes` runs. Callers that want fresh data should trigger
// one of those first; we keep resolution synchronous so streamChat
// doesn't spin up a probe in its hot path.
import {
  resolveBaseUrl as managerResolveBaseUrl,
} from './llm/local-manager/manager.js';
import {
  findPresetForModel,
  customPresetFromUserParams,
  NULL_PRESET,
  type LlmParamPreset,
} from './llm/local-manager/preset-registry.js';

/** Strip the local-llm spec prefix from a model id, returning the
 *  bare runtime model identifier that LM Studio / Ollama / MLX
 *  expect on the wire. Idempotent — already-bare ids pass through.
 *
 *  2026-05-05 — extracted from `resolveLocalLlmBase` so the two local
 *  provider builders (`LocalProvider` singleton via auto-mode AND
 *  `makeOpenAICompatProvider('local', ...)` via provider:'local'
 *  config) emit the same wire shape. Forensic trace from
 *  log/debug-20260505… line 454 caught the divergence: the OpenAI-
 *  compat builder was sending the FULL spec
 *  (`local-llm:local:qwen3.6-…`) as `body.model` and LM Studio was
 *  silently fallback-routing on the unrecognised id.
 *
 *  Accepts:
 *   - `local-llm:<node>:<modelId>` → `<modelId>`
 *   - `local-llm:<modelId>`        → `<modelId>` (implicit local node)
 *   - `local:<modelId>` (legacy)   → `<modelId>`
 *   - bare `<modelId>`             → unchanged */
export function stripLocalLlmSpec(model: string | undefined): string {
  const raw = (model ?? '').trim();
  if (!raw) return raw;
  if (raw.startsWith('local-llm:')) {
    const rest = raw.slice('local-llm:'.length);
    const idx = rest.indexOf(':');
    return idx > 0 ? rest.slice(idx + 1) : rest;
  }
  if (raw.startsWith('local:')) return raw.slice('local:'.length);
  return raw;
}

function resolveLocalLlmBase(
  rawModel: string | undefined,
  baseUrlOverride?: string,
): { baseUrl: string; modelId: string } {
  const raw = (rawModel || LOCAL_LLM_MODEL).trim();
  // Multi-node form: local-llm:<node>:<model>
  if (raw.startsWith('local-llm:')) {
    const rest = raw.slice('local-llm:'.length);
    const idx = rest.indexOf(':');
    const nodeId = idx > 0 ? rest.slice(0, idx) : 'local';
    const modelId = idx > 0 ? rest.slice(idx + 1) : rest;
    if (!modelId) {
      throw new Error(`Local LLM · invalid spec '${raw}' · expected local-llm:<node>:<model>`);
    }
    const resolved = managerResolveBaseUrl(nodeId, modelId);
    if (resolved) return { baseUrl: resolved, modelId };
    // Fall through to override / LOCAL_LLM_URL only when nodeId is 'local'.
    if (nodeId !== 'local') {
      throw new Error(
        `Local LLM · node '${nodeId}' not reachable or not probed yet · run /llm refresh (cache populates on first probe)`,
      );
    }
    const fallback = baseUrlOverride || getLocalLLMUrl();
    if (!fallback) throw new Error('Local LLM unavailable: set LOCAL_LLM_URL or run /llm refresh');
    return { baseUrl: fallback, modelId };
  }
  // Legacy `local:<model>` · single-host.
  const fallback = baseUrlOverride || getLocalLLMUrl();
  if (!fallback) throw new Error('Local LLM unavailable: set LOCAL_LLM_URL');
  const modelId = raw.replace(/^local:/, '');
  return { baseUrl: fallback, modelId };
}

/** Read the LLM section of user-config without binding the entire
 *  module — keeps the top-level import graph identical to pre-2026-05
 *  and avoids a circular import between user-config.ts and llm.ts.
 *  Returns a minimal subset (the preset-related fields) so the rest
 *  of LocalProvider doesn't accidentally drift into "look up other
 *  user prefs from this hot path". */
function readLocalProviderUserConfig(): {
  localPresetMode?: 'predefined' | 'custom' | 'none';
  localCustomParams?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    max_tokens?: number;
    auto_prepend_no_think?: boolean;
  };
} {
  try {
    const { getUserConfig } = require('./user-config.js') as typeof import('./user-config.js');
    const llm = getUserConfig().llm;
    return {
      ...(llm.localPresetMode !== undefined ? { localPresetMode: llm.localPresetMode } : {}),
      ...(llm.localCustomParams !== undefined ? { localCustomParams: llm.localCustomParams } : {}),
    };
  } catch {
    return {};
  }
}

/** Resolve the active preset for a local model based on the user's
 *  `localPresetMode` policy. Centralised so future modes (e.g. an
 *  inline UI override) only need to land here. */
function pickLocalPreset(
  modelId: string,
  cfg: ReturnType<typeof readLocalProviderUserConfig>,
  effectiveThinking?: boolean,
): LlmParamPreset {
  const mode = cfg.localPresetMode ?? 'predefined';
  if (mode === 'none') return NULL_PRESET;
  if (mode === 'custom') return customPresetFromUserParams(cfg.localCustomParams ?? {});
  return findPresetForModel(modelId, effectiveThinking);
}

/** Auto-prepend qwen3 `/no_think` soft-switch tag to the latest user
 *  message — saves 35-56% wall time on single-turn text without
 *  shortening the visible answer (5-model bench 2026-05-05).
 *
 *  Skip when that turn already specifies either `/think` or `/no_think`:
 *  qwen's last-tag-wins rule makes the turn's final directive authoritative.
 *  System messages are left alone (the tag belongs in user turns).
 *
 *  Returns the original array reference when no mutation is needed,
 *  so callers don't pay an allocation on the no-op path. When mutating,
 *  copies the array shallow + replaces only the latest user entry —
 *  upstream callers that rely on `messages` identity stay safe. */
function effectiveThinkingState(message: LLMMessage | undefined): boolean | undefined {
  if (!message) return undefined;
  const text = typeof message.content === 'string'
    ? message.content
    : message.content.filter((block) => block.type === 'text').map((block) => block.text).join(' ');
  let effectiveThinking: boolean | undefined;
  for (const match of text.matchAll(/(?:^|\s)\/(no_)?think(?=\s|$)/g)) {
    effectiveThinking = match[1] !== 'no_';
  }
  return effectiveThinking;
}

function latestUserMessage(messages: LLMMessage[]): LLMMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'user') return message;
  }
  return undefined;
}

function maybeAutoPrependNoThink(messages: LLMMessage[]): {
  messages: LLMMessage[];
  effectiveThinking: boolean | undefined;
} {
  const latestUser = latestUserMessage(messages);
  if (!latestUser) return { messages, effectiveThinking: undefined };
  const requestedThinking = effectiveThinkingState(latestUser);
  if (requestedThinking !== undefined) return { messages, effectiveThinking: requestedThinking };

  const out = [...messages];
  const userIndex = messages.lastIndexOf(latestUser);
  if (typeof latestUser.content === 'string') {
    out[userIndex] = { ...latestUser, content: `/no_think ${latestUser.content}` };
  } else {
    const blocks = [...latestUser.content];
    const firstTextIdx = blocks.findIndex((block) => block.type === 'text');
    if (firstTextIdx >= 0) {
      const block = blocks[firstTextIdx]!;
      if (block.type === 'text') blocks[firstTextIdx] = { ...block, text: `/no_think ${block.text}` };
      out[userIndex] = { ...latestUser, content: blocks };
    } else {
      out[userIndex] = { ...latestUser, content: [{ type: 'text', text: '/no_think' }, ...blocks] };
    }
  }
  return { messages: out, effectiveThinking: false };
}

/** Build a Local LLM provider with optional explicit overrides. The
 *  exported `LocalProvider` singleton uses the env-only resolution
 *  path (auto-mode); `makeLocalProvider(cfg)` threads `cfg.baseUrl /
 *  model / apiKey` for the provider:'local' config path. Both go
 *  through the same preset + spec-strip + multi-node pipeline so the
 *  divergence that previously hid in `makeOpenAICompatProvider('local',
 *  ...)` cannot reappear (내부 문서
 *  §11.1 root-fix · 2026-05-05). */
function buildLocalProvider(opts: {
  baseUrlOverride?: string;
  modelOverride?: string;
  apiKey?: string;
} = {}): LLMProvider {
  const { baseUrlOverride, modelOverride, apiKey } = opts;
  const defaultModel = modelOverride || LOCAL_LLM_MODEL;
  return {
    name: 'local',
    defaultModel,
    // Available when an explicit baseUrl was threaded in OR the
    // env-var (LOCAL_LLM_URL) is set. The Manager cache (`/llm nodes`)
    // is a separate signal for fleet discovery · populating it should
    // NOT auto-select this provider in auto-fallthrough mode, since
    // the user may prefer a cloud brand even when LM Studio happens
    // to be running somewhere.
    available: () => !!(baseUrlOverride || getLocalLLMUrl()),
    async *streamChat(messages, opts = {}) {
      const requestedModel = opts.model || defaultModel;
      const { baseUrl, modelId } = resolveLocalLlmBase(requestedModel, baseUrlOverride);
      const url = baseUrl.endsWith('/chat/completions')
        ? baseUrl
        : `${baseUrl.replace(/\/$/, '')}/chat/completions`;
      const tools = toOpenAITools(opts.tools);
      // 2026-05-05 — generalised preset registry replaces the earlier
      // hardcoded `isQwenLocal` regex. Per-family sampling/output/
      // behaviour now lives in `presets.yaml` (built-in) overlaid by
      // `~/.elanous/local-llm-presets.yaml` (user override). The registry
      // matches `modelId` against pattern rules; the first hit wins.
      // See `src/llm/local-manager/preset-registry.ts` + the YAML for
      // the qwen3 / qwen3-instruct / deepseek-r1 / gemma3 / gpt-oss /
      // openai-default entries and their cited vendor sources.
      //
      // Caller-provided opts.temperature / opts.maxTokens still override
      // the preset (existing contract), so skills/agents that pin
      // values for reproducibility keep working.
      //
      // Three modes via `user-config.llm.localPresetMode`:
      //   - 'predefined' (default · undefined) — match registry by id
      //   - 'custom'    — user supplies their own params via
      //                    `localCustomParams`
      //   - 'none'      — apply no preset (legacy bare provider defaults)
      //
      // qwen3 preset 's `auto_prepend_no_think` flag triggers the
      // soft-switch injection helper below; 5-model bench 2026-05-05
      // validated −36% wall, visible-chars unchanged, reasoning −44%.
      //
      // include_usage opts into the final-chunk usage payload — harmless
      // when the runtime omits it.
      const cfg = readLocalProviderUserConfig();
      const initialPreset = pickLocalPreset(modelId, cfg);
      const templateResult = initialPreset.behaviors.auto_prepend_no_think
        ? maybeAutoPrependNoThink(messages)
        : { messages, effectiveThinking: effectiveThinkingState(latestUserMessage(messages)) };
      const preset = pickLocalPreset(modelId, cfg, templateResult.effectiveThinking);
      const wireMessages = templateResult.messages;
      // Image-pipeline P3.5 — isVisionCapableModel('local', ...) on
      // userMessage axis is true for the verified local vision families
      // (Qwen-VL, Qwen 3.5+, Gemma 4, LLaVA per allowlist 2026-05).
      // P-3 §6.9 (2026-05-07) — same flag also gates user-message image
      // blocks in the wire (collapses to text placeholder for non-vision
      // local models like qwen-coder / llama / phi).
      const localFollowup = isVisionCapableModel('local', modelId, 'userMessage');
      const body: Record<string, unknown> = {
        model: modelId,
        messages: wireMessages.flatMap((m) => toOpenAIMessages(m, {
          acceptToolImagesViaFollowup: localFollowup,
          acceptUserMessageImages: localFollowup,
        })),
        temperature: opts.temperature ?? preset.sampling.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? preset.output.max_tokens ?? 4096,
        stream_options: { include_usage: true },
        // Explicit `tool_choice:'auto'` nudges LM Studio / local runtimes
        // to actually surface tool calls (some builds under-call without
        // it). Complements the Harmony channel decode — the real fix for
        // gemma-4, which emits tool calls as channel content.
        ...(tools ? { tools, tool_choice: 'auto' } : {}),
      };
      if (preset.sampling.top_p !== undefined) body.top_p = preset.sampling.top_p;
      if (preset.sampling.top_k !== undefined) body.top_k = preset.sampling.top_k;
      if (preset.sampling.min_p !== undefined) body.min_p = preset.sampling.min_p;
      if (preset.sampling.presence_penalty !== undefined) body.presence_penalty = preset.sampling.presence_penalty;
      if (debug.enabled) {
        debug.log('llm.local.preset', preset.id, {
          modelId,
          mode: cfg.localPresetMode ?? 'predefined',
          sampling: preset.sampling,
          max_tokens: preset.output.max_tokens,
          autoNoThink: !!preset.behaviors.auto_prepend_no_think,
        });
      }
      yield* streamOpenAIEvents(url, apiKey, body, opts.signal);
    },
    async *chat(messages, opts = {}) { yield* textOnly(this.streamChat!(messages, opts)); },
  };
}

export const LocalProvider: LLMProvider = buildLocalProvider();

/** Config-routed Local LLM provider. Mirrors makeAnthropic / makeCodex /
 *  makeGemini precedence: `cfg.baseUrl > LOCAL_LLM_URL env`,
 *  `cfg.model > LOCAL_LLM_MODEL`, `cfg.apiKey` forwarded as Bearer for
 *  gated proxies. The wire body / preset / spec-strip pipeline is
 *  shared with the `LocalProvider` singleton via `buildLocalProvider`. */
function makeLocalProvider(cfg: UCLLMConfig): LLMProvider {
  return buildLocalProvider({
    ...(cfg.baseUrl ? { baseUrlOverride: cfg.baseUrl } : {}),
    ...(cfg.model ? { modelOverride: cfg.model } : {}),
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
  });
}

export const GeminiProvider: LLMProvider = {
  name: 'gemini',
  defaultModel: GEMINI_MODEL,
  available: () => !!getGeminiApiKey(),
  async *streamChat(messages, opts = {}) {
    const apiKey = getGeminiApiKey();
    if (!apiKey) throw new Error('Gemini unavailable: set GEMINI_API_KEY or GOOGLE_API_KEY');
    // Wave 1 (2026-05-04) — native Gemini API via @google/genai SDK.
    // Replaces the OpenAI-compat tunnel. Unblocks systemInstruction,
    // thinkingConfig (gemini-2.5+), safetySettings, finishReason
    // SAFETY/BLOCKED surface. env-key path uses model-default
    // reasoning (medium when supported, off otherwise) since this is
    // the simple flow used by tests / probe scripts; full config-
    // routed path goes through makeGeminiProvider with explicit user
    // reasoning level resolution.
    const model = opts.model || GEMINI_MODEL;
    // Image-pipeline P3.5 (2026-05-05) — gate the multimodal
    // functionResponse.parts wire on the active model. Gemini 3+
    // supports it (verified 2026-05 via gemini-api/docs/function-calling);
    // pre-3.x leaves the legacy text-only path untouched.
    const geminiAcceptToolImages = acceptsToolResultImage('gemini', model);
    // P-3 §6.9 (2026-05-07) — user-message image axis. Gemini 1.5+ all
    // support inlineData on user role per allowlist; the gate is the
    // defensive layer behind composer Q3=B.
    const geminiAcceptUserImages = isVisionCapableModel('gemini', model, 'userMessage');
    const { systemInstruction, contents } = messagesToGeminiInput(messages, {
      acceptToolImages: geminiAcceptToolImages,
      acceptUserMessageImages: geminiAcceptUserImages,
    });
    const tools = toGeminiTools(opts.tools);
    const isGemini3 = model.startsWith('gemini-3');
    const thinking = modelSupportsReasoning('gemini', model)
      ? mapReasoningLevelToGeminiThinking('medium', model)
      : undefined;
    yield* streamGeminiEvents(apiKey, {
      model,
      ...(systemInstruction ? { systemInstruction } : {}),
      contents,
      ...(tools ? { tools } : {}),
      ...(thinking?.thinkingBudget !== undefined
        ? { thinkingBudget: thinking.thinkingBudget, includeThoughts: thinking.includeThoughts }
        : {}),
      ...(thinking?.thinkingLevel !== undefined
        ? { thinkingLevel: thinking.thinkingLevel, includeThoughts: thinking.includeThoughts }
        : {}),
      temperature: opts.temperature ?? (isGemini3 ? 1.0 : 0.3),
      ...(isGemini3 ? { topP: 0.95, topK: 64 } : {}),
      maxOutputTokens: opts.maxTokens ?? (isGemini3 ? 16384 : 2048),
    }, opts.signal);
  },
  async *chat(messages, opts = {}) { yield* textOnly(this.streamChat!(messages, opts)); },
};

/** Config-routed Gemini provider. Mirrors makeCodexProvider /
 *  makeAnthropicProvider precedence:
 *  - cfg.apiKey (explicit) > env var
 *  - cfg.model > GEMINI_MODEL
 *  - effectiveReasoningLevel(cfg, 'gemini', model) drives thinking
 *  Wave 1 (2026-05-04) — replaces makeOpenAICompatProvider('gemini'). */
function makeGeminiProvider(cfg: UCLLMConfig): LLMProvider {
  const model = cfg.model || GEMINI_MODEL;
  const apiKey = cfg.apiKey || getGeminiApiKey();
  return {
    name: 'gemini',
    defaultModel: model,
    available: () => !!apiKey,
    async *streamChat(messages, opts = {}) {
      if (!apiKey) {
        throw new Error('Gemini unavailable: set GEMINI_API_KEY / GOOGLE_API_KEY or `llm.apiKey`');
      }
      const activeModel = opts.model || model;
      const isGemini3 = activeModel.startsWith('gemini-3');
      // Image-pipeline P3.5 (2026-05-05) — Gemini 3+ multimodal
      // functionResponse.parts gate.
      const geminiAcceptToolImages = acceptsToolResultImage('gemini', activeModel);
      // P-3 §6.9 (2026-05-07) — user-message image axis (defensive
      // gate behind composer Q3=B; Gemini 1.5+ all currently true).
      const geminiAcceptUserImages = isVisionCapableModel(
        'gemini',
        activeModel,
        'userMessage',
      );
      const { systemInstruction, contents } = messagesToGeminiInput(messages, {
        acceptToolImages: geminiAcceptToolImages,
        acceptUserMessageImages: geminiAcceptUserImages,
      });
      const tools = toGeminiTools(opts.tools, cfg.geminiServerTools);
      const effLevel = effectiveReasoningLevel(cfg, 'gemini', activeModel);
      const thinking = mapReasoningLevelToGeminiThinking(effLevel, activeModel);
      // Wave C1 (2026-05-04) — safety filter level. Maps user
      // preference onto the native API's safetySettings array (4
      // categories × threshold). Omit field for backend default
      // (BLOCK_MEDIUM_AND_ABOVE per category).
      const safetySettings = mapGeminiSafetySettings(cfg.geminiSafety);
      // Wave C1 follow-up (2026-05-04) — when thinking is on, the
      // model spends a chunk of its output budget on hidden reasoning
      // tokens before answering. Default maxOutputTokens 2048 starves
      // the visible answer (measured: gemini-3.1-pro multi-turn fell
      // from 2.5K → 1.1K chars when thinking enabled with 2K cap).
      // Mirror the anthropic provider: bump maxOutputTokens by
      // thinkingBudget * 1.5 + 2048 so the visible answer keeps its
      // headroom even when the reasoning trace is expansive.
      //
      // Wave 2 (2026-05-04) — gemini-3 family uses thinkingLevel
      // (enum, no numeric budget), so the budget-derived bump doesn't
      // apply. Use a generous fixed cap (16K) instead so the model
      // can run multi-turn agentic loops without truncation.
      const baseMaxOutput = opts.maxTokens ?? 2048;
      const maxOutputTokens = thinking?.thinkingBudget !== undefined
        ? Math.max(baseMaxOutput, Math.floor(thinking.thinkingBudget * 1.5) + 2048)
        : thinking?.thinkingLevel !== undefined
          ? Math.max(baseMaxOutput, 16384)
          : baseMaxOutput;
      // Wave 2 (2026-05-04) — sampling. ref/gemini-cli's chat-base-3
      // alias ships {temperature: 1, topP: 0.95, topK: 64}; elanous's
      // legacy 0.3 default starves tool-call sampling and produces
      // single-turn termination on multi-turn scenarios (measured:
      // 0 tool calls / 2,201 chars vs codex 8 calls / 19K chars on
      // same prompt). Apply ref values for gemini-3 family; keep
      // legacy 0.3 for gemini-2.5 (no measured regression).
      const temperature = opts.temperature ?? (isGemini3 ? 1.0 : 0.3);
      const topP = isGemini3 ? 0.95 : undefined;
      const topK = isGemini3 ? 64   : undefined;
      const buildBody = () => ({
        model: activeModel,
        ...(systemInstruction ? { systemInstruction } : {}),
        contents,
        ...(tools ? { tools } : {}),
        ...(thinking?.thinkingBudget !== undefined
          ? { thinkingBudget: thinking.thinkingBudget, includeThoughts: thinking.includeThoughts }
          : {}),
        ...(thinking?.thinkingLevel !== undefined
          ? { thinkingLevel: thinking.thinkingLevel, includeThoughts: thinking.includeThoughts }
          : {}),
        ...(safetySettings ? { safetySettings } : {}),
        temperature,
        ...(topP !== undefined ? { topP } : {}),
        ...(topK !== undefined ? { topK } : {}),
        maxOutputTokens,
      });
      // Wave 2 (2026-05-04) — bounded retry on MALFORMED_FUNCTION_CALL
      // / UNEXPECTED_TOOL_CALL. ref/gemini-cli does mid-stream retry
      // (4 attempts). elanous previously let these slip through → empty
      // turn → tool-loop bailed. We retry only when nothing has been
      // yielded yet (avoid duplicate output to the user).
      const MAX_GEMINI_RETRIES = 1;
      let attempt = 0;
      while (true) {
        let emittedAny = false;
        try {
          for await (const ev of streamGeminiEvents(apiKey, buildBody(), opts.signal)) {
            emittedAny = true;
            yield ev;
          }
          return;
        } catch (err) {
          const retryable = (err as { __geminiRetryable?: boolean })?.__geminiRetryable === true;
          if (retryable && !emittedAny && attempt < MAX_GEMINI_RETRIES) {
            attempt++;
            debug.log('llm.router', 'gemini.malformed.retry', {
              attempt, model: activeModel, err: String(err),
            });
            continue;
          }
          throw err;
        }
      }
    },
    async *chat(messages, opts = {}) { yield* textOnly(this.streamChat!(messages, opts)); },
  };
}

/** Map user-config geminiSafety preference onto the native API's
 *  safetySettings array. Returns undefined for `default` / unset
 *  (backend's default BLOCK_MEDIUM_AND_ABOVE per category applies).
 *  Mirrors @google/genai SDK's HarmCategory + HarmBlockThreshold
 *  enums. Wave C1 (2026-05-04). */
function mapGeminiSafetySettings(
  pref: 'default' | 'permissive' | 'strict' | undefined,
): Array<{ category: string; threshold: string }> | undefined {
  if (!pref || pref === 'default') return undefined;
  const threshold =
    pref === 'permissive' ? 'BLOCK_ONLY_HIGH' :
    'BLOCK_LOW_AND_ABOVE';
  // 4 categories per Gemini API docs (ai.google.dev/gemini-api/docs/safety-settings).
  return [
    { category: 'HARM_CATEGORY_HARASSMENT',        threshold },
    { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold },
  ];
}

export const PROVIDERS: Record<string, LLMProvider> = {
  grok: GrokProvider,
  openai: OpenAIProvider,
  'openai-codex': {
    name: 'openai-codex',
    get defaultModel() { return CODEX_DEFAULT_MODEL; },
    available: () => makeCodexProvider({ provider: 'openai-codex' }).available(),
    streamChat: (messages, opts = {}) => makeCodexProvider({ provider: 'openai-codex' }).streamChat!(messages, opts),
    chat: (messages, opts = {}) => makeCodexProvider({ provider: 'openai-codex' }).chat!(messages, opts),
  },
  anthropic: AnthropicProvider,
  local: LocalProvider,
  gemini: GeminiProvider,
  // OpenRouter is considered for auto selection only after subscription and other key candidates.
  openrouter: {
    name: 'openrouter',
    get defaultModel() { return OPENROUTER_MODEL; },
    available: () => !!getOpenRouterApiKey(),
    streamChat: (messages, opts = {}) => makeOpenRouterProvider({ provider: 'openrouter' }).streamChat!(messages, opts),
    chat: (messages, opts = {}) => makeOpenRouterProvider({ provider: 'openrouter' }).chat!(messages, opts),
  },
};

const AUTOMATIC_PROVIDER_ORDER = ['grok', 'anthropic', 'gemini', 'local'] as const;
const PROVIDER_DECISION_ORDER = ['grok', 'anthropic', 'openai', 'gemini', 'local', 'openrouter'] as const;
const SUBSCRIPTION_DECISION_ORDER = ['openai-codex', 'grok'] as const;

type AutomaticProviderName = typeof AUTOMATIC_PROVIDER_ORDER[number];
type ProviderDecisionName = typeof PROVIDER_DECISION_ORDER[number];
type SubscriptionDecisionName = typeof SUBSCRIPTION_DECISION_ORDER[number];
type ConcreteProviderName = Exclude<UserConfig['llm']['provider'], 'auto'>;
export type ProviderDecisionProvider = UserConfig['llm']['provider'] | `auto:${ProviderDecisionName | SubscriptionDecisionName}`;
export type ProviderDecisionAuth = 'oauth' | 'apikey' | 'local' | 'none';

export interface ProviderDecision {
  provider: ProviderDecisionProvider;
  model: string;
  auth: ProviderDecisionAuth;
}

/**
 * Makes a provider/model pair safe to send to an external LLM endpoint.
 * A known incompatible model family is rerouted to its inferred provider;
 * an unknown provider inference cannot form a safe pair and is rejected.
 */
export function finalizeProviderModelCompatibility(decision: ProviderDecision): ProviderDecision {
  const configuredProvider = decision.provider.startsWith('auto:')
    ? decision.provider.slice('auto:'.length)
    : decision.provider;
  if (configuredProvider === 'auto') return decision;
  if (!isKnownProviderName(configuredProvider)) {
    throw new Error(`Cannot establish provider-model compatibility: unknown provider "${configuredProvider}" for model "${decision.model}"`);
  }
  const subscriptionRoute = resolveSubscriptionProviderRoute(configuredProvider, decision.model);
  if (subscriptionRoute) return subscriptionRoute;
  if (isModelCompatible(configuredProvider, decision.model)) return decision;

  const inferredProvider = inferProviderFromModel(decision.model);
  if (!inferredProvider || !isKnownProviderName(inferredProvider)) {
    throw new Error(`Cannot establish provider-model compatibility: provider "${configuredProvider}" is incompatible with model "${decision.model}" and no supported provider can be inferred`);
  }

  debug.log('llm.router', 'provider-model-rerouted', {
    fromProvider: configuredProvider,
    toProvider: inferredProvider,
    model: decision.model,
  }, { level: 'warn' });
  return {
    provider: inferredProvider,
    model: decision.model,
    auth: authKindForProvider(inferredProvider, decision.model),
  };
}

function automaticProviderCandidates(): Array<LLMProvider & { name: AutomaticProviderName }> {
  return AUTOMATIC_PROVIDER_ORDER.map((name) => PROVIDERS[name]! as LLMProvider & { name: AutomaticProviderName });
}

function providerDecisionCandidates(): Array<LLMProvider & { name: ProviderDecisionName }> {
  return PROVIDER_DECISION_ORDER.map((name) => PROVIDERS[name]! as LLMProvider & { name: ProviderDecisionName });
}

/** Exported (OB1) so onboarding and `setup` judge «is there a usable ChatGPT/Codex login» exactly as the runtime does. */
export function codexOAuthAvailable(): boolean {
  try {
    const account = resolveCodexAccount(process.env, { storedHome: (key) => loadTokens(key)?.codexHome });
    if (loadTokens(account.storeKey)) return true;
    const home = effectiveCodexHome(account, null, process.env).home;
    return !!home && readCodexMirrorTokens(join(home, 'auth.json')) !== null;
  } catch {
    return false;
  }
}

function subscriptionDecision(): ProviderDecision | undefined {
  for (const provider of SUBSCRIPTION_DECISION_ORDER) {
    const model = defaultModelForProvider(provider);
    const auth = authKindForProvider(provider, model);
    if (auth === 'oauth') return { provider: `auto:${provider}`, model, auth };
  }
  return undefined;
}

function resolveSubscriptionProviderRoute(
  configuredProvider: ConcreteProviderName,
  model: string,
): ProviderDecision | undefined {
  const inferredProvider = inferProviderFromModel(model);
  if (configuredProvider !== 'openai' || inferredProvider !== 'openai-codex') return undefined;

  const inferredAuth = authKindForProvider(inferredProvider, model);
  if (inferredAuth === 'oauth') {
    debug.log('llm.router', 'subscription-provider-rerouted', {
      fromProvider: configuredProvider,
      toProvider: inferredProvider,
      model,
    }, { level: 'info' });
    return { provider: inferredProvider, model, auth: inferredAuth };
  }

  debug.log('llm.router', 'subscription-provider-divergence', {
    configProvider: configuredProvider,
    inferredProvider,
    model,
  }, { level: 'warn' });
  return undefined;
}

/** Pure provider-selection decision shared by runtime construction and provider summaries. */
export function decideProviderForConfig(
  userConfig: UserConfig,
  model?: string,
): ProviderDecision {
  const { provider, apiKey, baseUrl } = userConfig.llm;
  if (provider === 'auto') {
    if (model) {
      const selected = getProvider(model);
      return {
        provider: selected.name as ConcreteProviderName,
        model,
        auth: authKindForProvider(selected.name, model),
      };
    }
    const subscription = subscriptionDecision();
    if (subscription) return subscription;
    for (const candidate of providerDecisionCandidates()) {
      if (candidate.available()) {
        return { provider: `auto:${candidate.name}`, model: candidate.defaultModel, auth: authKindForProvider(candidate.name, candidate.defaultModel) };
      }
    }
    return { provider: 'auto', model: '(none)', auth: 'none' };
  }

  const subscriptionRoute = model && resolveSubscriptionProviderRoute(provider, model);
  if (subscriptionRoute) return subscriptionRoute;
  const modelProvider = model && inferProviderFromModel(model);
  if (modelProvider && !isModelCompatible(provider, model)) {
    const selected = getProvider(model);
    return {
      provider: selected.name as ConcreteProviderName,
      model,
      auth: authKindForProvider(selected.name, model),
    };
  }

  const modelHint = model && isModelCompatible(provider, model) ? model : undefined;

  // ⛔⭐⭐ **호환성 검사를 «폴백에도» 건다** (2026-09-02 · 대표 지시로 기전 추적).
  //   🩸 종전엔 위 가드가 «인자 model» 에만 걸리고, 인자가 없으면 `userConfig.llm.model` 을
  //   ***검사 없이*** 그대로 썼다. 그래서 config/env 의 모델이 provider 와 어긋나면
  //   ***「provider=openai-codex · model=grok-4.6」이 조용히 반환***됐고, 호출은 반드시 400 이었다:
  //     Codex API 400: "The 'grok-4.6' model is not supported when using Codex with a ChatGPT account."
  //   📏 재현(그때): arg=undefined ⊕ config.model=grok-4.6 ⇒ provider=openai-codex · model=grok-4.6
  //   ⇒ 🔑 그 조합은 ***쓸모가 없다***(항상 실패한다). 그래서 «인자 경로와 같은 규칙»으로 맞춘다 —
  //   모델이 자기 provider 를 가리키면 그쪽으로 간다. ⛔ 새 규칙을 지어내지 않았다.
  const configModel = userConfig.llm.model;
  const configModelProvider = !modelHint && configModel ? inferProviderFromModel(configModel) : undefined;
  if (configModelProvider && !isModelCompatible(provider, configModel!)) {
    const selected = getProvider(configModel!);
    return {
      provider: selected.name as ConcreteProviderName,
      model: configModel!,
      auth: authKindForProvider(selected.name, configModel!),
    };
  }

  const selectedModel = modelHint || configModel || defaultModelForProvider(provider);
  switch (provider) {
    case 'openai-codex':
      return { provider, model: selectedModel, auth: codexOAuthAvailable() ? 'oauth' : apiKey ? 'apikey' : 'none' };
    case 'grok':
      return { provider, model: selectedModel, auth: authKindForProvider('grok', selectedModel, apiKey) };
    case 'openai':
      return { provider, model: selectedModel, auth: apiKey || getOpenAIApiKey() ? 'apikey' : 'none' };
    case 'anthropic':
      return { provider, model: selectedModel, auth: apiKey || getAnthropicApiKey() ? 'apikey' : 'none' };
    case 'gemini':
      return { provider, model: selectedModel, auth: apiKey || getGeminiApiKey() ? 'apikey' : 'none' };
    case 'local':
      return { provider, model: selectedModel, auth: baseUrl || getLocalLLMUrl() ? 'local' : 'none' };
    case 'openrouter':
      return { provider, model: selectedModel, auth: apiKey || getOpenRouterApiKey() ? 'apikey' : 'none' };
  }
  throw new Error(`unknown provider: ${provider as string}`);
}

function isKnownProviderName(provider: string): provider is ConcreteProviderName {
  return provider === 'grok' || provider === 'openai' || provider === 'openai-codex' || provider === 'anthropic' || provider === 'gemini' || provider === 'local' || provider === 'openrouter';
}

function authKindForProvider(provider: string, model: string, apiKey?: string): ProviderDecisionAuth {
  if (provider === 'local') return getLocalLLMUrl() ? 'local' : 'none';
  if (provider === 'grok') {
    const cred = resolveGrokCredential({ model });
    if (cred?.kind === 'subscription') return 'oauth';
    if (cred) return 'apikey';
    return apiKey ? 'apikey' : 'none';
  }
  if (provider === 'openai') return getOpenAIApiKey() ? 'apikey' : 'none';
  if (provider === 'anthropic') return getAnthropicApiKey() ? 'apikey' : 'none';
  if (provider === 'gemini') return getGeminiApiKey() ? 'apikey' : 'none';
  if (provider === 'openrouter') return getOpenRouterApiKey() ? 'apikey' : 'none';
  if (provider === 'openai-codex') {
    try {
      return codexOAuthAvailable() ? 'oauth' : 'none';
    } catch {
      return 'none';
    }
  }
  return 'none';
}

function defaultModelForProvider(provider: ConcreteProviderName): string {
  switch (provider) {
    case 'grok': return GROK_MODEL;
    case 'openai': return OPENAI_MODEL;
    case 'openai-codex': return CODEX_DEFAULT_MODEL;
    case 'anthropic': return ANTHROPIC_MODEL;
    case 'gemini': return GEMINI_MODEL;
    case 'local': return LOCAL_LLM_MODEL;
    case 'openrouter': return OPENROUTER_MODEL;
  }
  throw new Error(`unknown provider: ${provider as string}`);
}

function permitsAutomaticProviderFallback(opts: LLMOpts & { provider?: LLMProvider }): boolean {
  if (opts.provider) return false;
  try {
    const { getUserConfig } = require('./user-config.js') as typeof import('./user-config.js');
    return getUserConfig().llm.provider === 'auto';
  } catch {
    return DEFAULT_PROVIDER === 'auto';
  }
}

function configuredFallbackProviders(): LLMProvider[] {
  try {
    const { getUserConfig } = require('./user-config.js') as typeof import('./user-config.js');
    const { normalizeFallbackChain } = require('./oauth/fallback-chain.js') as typeof import('./oauth/fallback-chain.js');
    const { chain } = normalizeFallbackChain(getUserConfig().llm.fallbackChain);
    const out: LLMProvider[] = [];
    for (const name of providerNamesFromFallbackChain(chain)) {
      const provider = PROVIDERS[name];
      if (provider) out.push(provider);
    }
    return out;
  } catch (err) {
    // ⛔ 조용히 삼키면 「설정을 못 읽었다」가 「폴백 후보가 없다」로 «둔갑»한다 —
    //   호출자는 그것을 `fallback candidates exhausted` 로 보고 사람에게 그렇게 말한다.
    //   부재(빈 체인)와 미지(못 읽음)를 같은 값으로 두지 않으려면 «말하고» 비워야 한다.
    debug.log('llm.router', 'fallback-chain-unreadable', {
      message: sanitizeProviderFailureReason(err instanceof Error ? err.message : String(err)),
    }, { level: 'error' });
    return [];
  }
}

function remainingFallbackProviderNames(
  attemptedProviders: ReadonlySet<string>,
  opts: LLMOpts & { provider?: LLMProvider },
): string[] {
  // Priority:
  //   1. per-call opts.provider → no fallback (caller pinned the route)
  //   2. llm.provider === 'auto' → ⭐ 2026-09-24 결정: `llm.fallbackChain` 을 «먼저»(codex-rotate→openai-codex · grok),
  //      그다음 체인이 «다루지 않는» 자동 후보(anthropic·gemini·local). 체인이 grok 을 뺐으면 grok 으로 새지 않는다.
  //      종전엔 auto 가 체인을 통째로 무시하고 AUTOMATIC_PROVIDER_ORDER 만 걸었다.
  //   3. otherwise → configured llm.fallbackChain (read from config; never baked here)
  if (opts.provider) return [];
  if (permitsAutomaticProviderFallback(opts)) {
    const chainGoverned = new Set(providerNamesFromFallbackChain(['codex-rotate', 'grok']));
    const ordered: LLMProvider[] = [
      ...configuredFallbackProviders(),
      ...automaticProviderCandidates().filter((candidate) => !chainGoverned.has(candidate.name)),
    ];
    const seen = new Set<string>();
    return ordered
      .filter((candidate) => {
        if (seen.has(candidate.name)) return false;
        seen.add(candidate.name);
        return !attemptedProviders.has(candidate.name) && candidate.available();
      })
      .map((candidate) => candidate.name);
  }
  return configuredFallbackProviders()
    .filter((candidate) => !attemptedProviders.has(candidate.name) && candidate.available())
    .map((candidate) => candidate.name);
}

/** @internal 시험 seam — auto 폴백 순서(체인 먼저 · 체인이 안 다루는 자동 후보 뒤)를 결정적으로 누른다. */
export function _remainingFallbackProviderNamesForTest(attempted: readonly string[]): string[] {
  return remainingFallbackProviderNames(new Set(attempted), {});
}

function terminalFallbackVerdict(
  verdict: ReturnType<typeof decideProviderFallback>,
  attempts: readonly ProviderFallbackAttempt[],
  reason: string,
): ProviderFallbackTerminalVerdict {
  if (verdict.action === 'stop' || verdict.action === 'exhaust') return verdict;
  return { action: 'exhaust', category: verdict.category, attempts, reason };
}

function providerByName(name: string): LLMProvider | undefined {
  return PROVIDERS[name] ?? automaticProviderCandidates().find((candidate) => candidate.name === name);
}

function finalizeStreamingProviderModel(provider: LLMProvider, model: string): { provider: LLMProvider; model: string } {
  if (!isKnownProviderName(provider.name)) return { provider, model };

  const finalized = finalizeProviderModelCompatibility({
    provider: provider.name as ProviderDecisionProvider,
    model,
    auth: 'none',
  });
  const finalizedProvider = provider.name === finalized.provider
    ? provider
    : providerByName(finalized.provider);
  if (!finalizedProvider) {
    throw new Error(`Cannot establish provider-model compatibility: provider "${finalized.provider}" is unavailable for model "${finalized.model}"`);
  }
  return { provider: finalizedProvider, model: finalized.model };
}

/**
 * Pick a provider based on the model name. If model is undefined, use first
 * available provider (preferring DEFAULT_PROVIDER env var if set).
 */
export function getProvider(model?: string): LLMProvider {
  if (model) {
    // Wave 8 (2026-05-04) — resolve model alias before prefix lookup.
    // Short aliases like `haiku` / `opus` / `flash` map to canonical
    // ids (e.g. `claude-opus-4-7`) so prefix matching works. Existing
    // full ids pass through unchanged.
    const resolved = resolveModelAlias(model) ?? model;
    // Preserve the historical Chat Completions route for gpt-* model-only
    // requests, including future ids that the current catalog does not list.
    if (resolved.toLowerCase().startsWith('gpt-')) return PROVIDERS.openai!;
    const adapted = inferProviderFromModel(resolved);
    if (adapted === 'openai-codex') return PROVIDERS['openai-codex']!;
    const inferred = registryInferProviderFromModel(resolved);
    if (inferred && PROVIDERS[inferred]) return PROVIDERS[inferred]!;
    if (adapted && PROVIDERS[adapted]) return PROVIDERS[adapted]!;
    // Unknown prefix — look up by exact name match on defaults
    for (const p of Object.values(PROVIDERS)) {
      if (p.defaultModel === resolved) return p;
    }
  }

  // No model → preference order
  if (DEFAULT_PROVIDER !== 'auto' && PROVIDERS[DEFAULT_PROVIDER]) {
    const p = PROVIDERS[DEFAULT_PROVIDER]!;
    if (p.available()) return p;
  }

  // ⭐ 2026-09-24 결정: `auto` 는 codex(구독)다 — `decideProviderForConfig` 와 같은 답을 낸다.
  //   종전(07-17 「명시 선택 원칙」)엔 이 경로만 codex 를 건너뛰어, 역할 LLM·대시보드·판정기가
  //   런타임(codex)과 다른 provider 를 말하거나 codex 만 있는 기계에서 예외를 던졌다.
  //   계정 회전은 codex provider 안(`makeCodexProvider` → `resolveCodexAccountForRun`)에서 그대로 돈다.
  if (DEFAULT_PROVIDER === 'auto') {
    const subscription = subscriptionDecision();
    const name = subscription?.provider.startsWith('auto:') ? subscription.provider.slice('auto:'.length) : undefined;
    const p = name ? PROVIDERS[name] : undefined;
    if (p) return p;
  }

  // Fallback: first available. 'openai'(GPT·Chat Completions)는 제외 —
  // OpenAI 는 Codex(openai-codex·Responses API)만 쓰고, 비-OpenAI auto-fallback
  // 은 grok·anthropic(claude)이 담당한다(대표 지시 2026-07-17 · openai/codex 혼란 방지).
  for (const p of automaticProviderCandidates()) {
    if (p.available()) return p;
  }
  if (PROVIDERS.openrouter!.available()) return PROVIDERS.openrouter!;

  throw new NoLlmProviderAvailableError();
}

/**
 * 「No LLM provider available」 문면 — 구독 사용자에게 API 키를 시키지 않는다.
 * ⑤(🅣 인계 2026-09-23): 옛 문면은 누구에게나 키 다섯을 시켰다. 그런데 이 자리는
 * codex 구독을 «자동 후보로 안 쓰는» 경로라, codex 로그인이 «있는» 사람이 가장 먼저
 * 여기 떨어진다 — 그 사람에게 필요한 것은 키가 아니라 provider 한 줄이다.
 */
export class NoLlmProviderAvailableError extends Error {
  constructor() {
    super(noProviderAvailableMessage());
    this.name = 'NoLlmProviderAvailableError';
  }
}

export function noProviderAvailableMessage(): string {
  const head = 'No LLM provider available.';
  const keys = 'XAI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, or LOCAL_LLM_URL';
  let codexOauth = false;
  try {
    codexOauth = authKindForProvider('openai-codex', defaultModelForProvider('openai-codex')) === 'oauth';
  } catch { /* 못 쟀다 — 일반 안내로 */ }
  if (codexOauth) {
    return `${head} An OpenAI Codex login was found but could not be used — run \`elanous config set llm.provider openai-codex\` (or \`elanous setup\`) and check \`elanous usage\`.`;
  }
  return `${head} Run \`elanous setup\` — with a subscription, \`elanous login openai-codex\` then \`elanous config set llm.provider openai-codex\`; with API keys, set ${keys}.`;
}

/**
 * List all providers with availability status, for the /provider command.
 */
export function listProviders(): Array<{ name: string; model: string; available: boolean }> {
  return Object.values(PROVIDERS).map(p => ({
    name: p.name,
    model: p.defaultModel,
    available: p.available(),
  }));
}

// ── Context-aware message builder ─────────────────────────

import { listAttachments, type ContextRegistry } from './context.js';

/** Kind label used in the prepended attachment header. */
const KIND_LABEL: Record<string, string> = {
  text: 'Text', md: 'Markdown', pdf: 'PDF', docx: 'Docx', xlsx: 'Xlsx', image: 'Image',
};

/**
 * Build a `system`/`user` message pair that carries every loaded attachment
 * from `registry` into the LLM call.
 *
 * - **Text-kind attachments** (txt/md/pdf/docx/xlsx) are prepended as labeled
 *   code-fenced sections in the user text.
 * - **Image attachments** (when `.base64` has been populated by the M2 pipeline)
 *   become `ContentBlock[]` entries alongside the combined user text.
 *
 * Returns an `LLMMessage[]` with a single string-content user message when no
 * images are present, or a `ContentBlock[]` user message otherwise — each
 * provider adapter handles both shapes.
 */
export function buildMessagesWithContext(
  userText: string,
  registry: ContextRegistry,
  systemPrompt?: string,
): LLMMessage[] {
  const messages: LLMMessage[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

  const all = listAttachments(registry);
  const texts  = all.filter(a => a.loaded && a.text != null);
  const images = all.filter(a => a.kind === 'image' && a.base64);

  const sections: string[] = [];
  for (const t of texts) {
    const label = `${KIND_LABEL[t.kind] ?? t.kind} #${t.id}: ${t.filename}`;
    sections.push(`[Attached ${label}]\n\`\`\`\n${t.text}\n\`\`\``);
  }
  const joined = sections.length ? `${sections.join('\n\n')}\n\n${userText}` : userText;

  if (images.length === 0) {
    messages.push({ role: 'user', content: joined });
  } else {
    const blocks: ContentBlock[] = images.map(img => ({
      type: 'image',
      mediaType: img.mediaType!,
      base64: img.base64!,
    }));
    blocks.push({ type: 'text', text: joined });
    messages.push({ role: 'user', content: blocks });
  }

  return messages;
}

// Re-export converters so tests/adapters can assert wire-format correctness.
export { toOpenAIMessage, toOpenAIMessages, toAnthropicMessage, systemToAnthropicString };

/**
 * Best-effort classification of whether a model accepts image inputs.
 *
 * Positive-allowlist style: we return `true` only for prefixes we know are
 * vision-capable at the time of writing. Everything else returns `false` so
 * callers can surface a degrade warning — this favors false-positive
 * warnings (on an actually-vision model we haven't learned about yet) over
 * the worse case of silently dropping an image on a text-only model.
 *
 * Kept here rather than in config so adapters/tests can assert the list.
 *
 * OpenRouter ids (`openrouter/<vendor>/<model>`) are the exception to the
 * prefix allowlist: they are judged by the catalog fold's `vision` fact via
 * `isVisionCapableModel('openrouter', model, 'userMessage')` — unknown ⇒ false.
 *
 * Caller (existing execution path): `executeSkill` in `src/skills/runner.ts`
 * — `if (imgCount > 0 && !isLikelyVisionModel(resolvedModel))` emits the
 * image-attachment degrade warning.
 */
export function isLikelyVisionModel(model: string | undefined): boolean {
  if (!model) return false;
  const m = model.toLowerCase();

  // 대표 2026-09-23 — OpenRouter: 수백 개 모델이 한 게이트웨이 뒤에 있고 절반 가까이는
  //   text-only 다 ⇒ 이름 패턴은 «늙는다». 카탈로그 폴드(`/api/v1/models` 의
  //   `architecture.input_modalities` → `vision`)만 믿고, 카탈로그에 없으면 «모른다»
  //   → false(경고를 유지한다 · 400 보다 텍스트 전용이 낫다).
  //   ⛔ 규칙을 여기서 파생하지 않는다 — `isVisionCapableModel` 과 «같은» 판정이다.
  if (m.startsWith('openrouter/')) return isVisionCapableModel('openrouter', model, 'userMessage');

  // Anthropic: all shipped Claude 3/4 families accept images.
  if (m.startsWith('claude-')) return true;

  // OpenAI: omni / 4-turbo / 4.1 / o1 / o3 / o4 / gpt-5 + codex families.
  // Older gpt-4 and all gpt-3.5 are text-only. (gpt-5 / codex accept
  // image inputs — mirrors isVisionCapableModel('openai-codex', …).)
  if (m.startsWith('gpt-4o') || m.startsWith('gpt-4.1') ||
      m.startsWith('gpt-4-turbo') || m.startsWith('gpt-4-vision') ||
      isNewGenerationOpenAiModel(m) || m.startsWith('codex') || m.includes('codex') ||  // gpt-5 이후 «세대 숫자»(gpt-6 포함 · 2026-09-23)
      m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return true;

  // xAI: Grok-4 series and explicit vision SKUs accept images; Grok-3 is
  // text-only as of the writing.
  if (m.startsWith('grok-4') || m.includes('vision')) return true;

  // Google: Gemini 1.5+ is multimodal.
  if (m.startsWith('gemini-')) return true;

  return false;
}

/**
 * Convenience wrapper — stream chunks via a callback, returning the full text.
 * Mirrors the existing `streamGrok()` signature in chat.ts for drop-in use.
 */
type ObservedUsage = Pick<LLMUsage, 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'>;

type ProviderTextResult =
  | { ok: true; full: string; usage: ObservedUsage | 'unmeasured' }
  | { ok: false; full: string; error: unknown };

function accumulateUsage(usage: ObservedUsage | undefined, received: LLMUsage): ObservedUsage {
  const total = { ...usage };
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'] as const) {
    if (received[field] !== undefined) total[field] = (total[field] ?? 0) + received[field];
  }
  return total;
}

async function consumeProviderText(
  provider: LLMProvider,
  messages: LLMMessage[],
  opts: LLMOpts,
  onChunk: (delta: string, full: string) => void,
): Promise<ProviderTextResult> {
  let iterator: AsyncIterator<string | LLMStreamEvent>;
  let full = '';
  let usage: ObservedUsage | undefined;
  try {
    iterator = (provider.streamChat
      ? provider.streamChat(messages, opts)
      : provider.chat(messages, opts))[Symbol.asyncIterator]();
  } catch (error) {
    return { ok: false, full, error };
  }

  const closeIterator = async () => {
    try {
      await iterator.return?.();
    } catch {
      // Preserve the provider or callback error that caused this close.
    }
  };

  while (true) {
    let step: IteratorResult<string | LLMStreamEvent>;
    try {
      step = await iterator.next();
    } catch (error) {
      await closeIterator();
      return { ok: false, full, error };
    }
    if (step.done) return { ok: true, full, usage: usage ?? 'unmeasured' };
    const event = typeof step.value === 'string' ? { type: 'text' as const, delta: step.value } : step.value;
    if (event.type === 'usage') {
      usage = accumulateUsage(usage, event.usage);
      try {
        opts.onUsage?.(event.usage);
      } catch {
        // Usage telemetry must not interrupt text delivery.
      }
      continue;
    }
    if (event.type !== 'text') continue;
    full += event.delta;
    try {
      onChunk(event.delta, full);
    } catch (error) {
      await closeIterator();
      throw error;
    }
  }
}

export async function streamLLM(
  messages: LLMMessage[],
  onChunk: (delta: string, full: string) => void,
  opts: LLMOpts & { provider?: LLMProvider; initialProvider?: LLMProvider; onResolvedProvider?: (provider: string, model: string) => void } = {},
): Promise<string> {
  let activeProvider = opts.provider ?? opts.initialProvider ?? resolveDefaultProvider(opts.model);
  const attemptedProviders = new Set<string>([activeProvider.name]);
  let blockedProviders: ProviderFallbackAttempt[] = [];
  let modelOverride = opts.model;
  const started = Date.now();

  while (true) {
    const finalized = finalizeStreamingProviderModel(
      activeProvider,
      modelOverride ?? activeProvider.defaultModel,
    );
    activeProvider = finalized.provider;
    const activeModel = finalized.model;
    opts.onResolvedProvider?.(activeProvider.name, activeModel);
    debug.log('llm.router', 'streamLLM', {
      provider: activeProvider.name,
      model: activeModel,
      messageCount: messages.length,
      messageRoles: summarizeRoles(messages),
      tools: opts.tools?.map(t => t.name),
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
    }, { level: 'info' });
    const consumed = await consumeProviderText(
      activeProvider,
      messages,
      {
        ...opts,
        model: activeModel,
        remainingFallbacks: opts.provider ? 0 : remainingFallbackProviderNames(attemptedProviders, opts).length,
      },
      onChunk,
    );
    const full = consumed.full;
    if (consumed.ok) {
      if (consumed.usage !== 'unmeasured') {
        try {
          logAgentTurnUsage(activeModel, consumed.usage, { providerName: activeProvider.name, site: 'stream-llm', role: opts.usageRole });
        } catch { /* best-effort observation */ }
      }
      debug.log('llm.router.done', 'streamLLM', {
        provider: activeProvider.name,
        model: activeModel,
        durationMs: Date.now() - started,
        textChars: full.length,
        usage: consumed.usage,
      });
      return full;
    }

    const err: any = consumed.error;
    if (err instanceof OverloadFailoverError && !opts.provider) {
      const switched = providerByName('grok');
      if (switched && !attemptedProviders.has(switched.name) && switched.available() && full.length === 0) {
        debug.log('llm.router', 'overload-failover', {
          blockedProvider: activeProvider.name,
          fallbackProvider: switched.name,
          streak: err.streak,
          status: err.status,
          kind: err.kind,
        }, { level: 'warn' });
        activeProvider = switched;
        modelOverride = undefined;
        attemptedProviders.add(activeProvider.name);
        continue;
      }
    }
    const reason = sanitizeProviderFailureReason(err?.message || String(err));
    debug.log('llm.router.error', 'streamLLM', {
      provider: activeProvider.name,
      model: activeModel,
      durationMs: Date.now() - started,
      message: reason,
      ...(isAuthRejectionError(err) ? { authRejected: true } : {}),
    }, { level: 'error' });
    if (opts.provider) throw err;
    const remaining = remainingFallbackProviderNames(attemptedProviders, opts);
    const verdict = decideProviderFallback({
      err,
      failedProvider: activeProvider.name,
      remainingProviders: remaining,
      attempted: blockedProviders,
    });
    blockedProviders = [...verdict.attempts];
    const fallback = verdict.action === 'advance' ? providerByName(verdict.nextProvider) : undefined;
    if (verdict.action === 'advance' && fallback && full.length === 0) {
      debug.log('llm.router', 'provider-fallback', {
        blockedProvider: activeProvider.name,
        fallbackProvider: fallback.name,
        reason,
        category: verdict.category,
        tools: opts.tools?.map((tool) => tool.name) ?? [],
        ...(opts.model ? { modelOverrideDropped: opts.model } : {}),
      }, { level: 'warn' });
      activeProvider = fallback;
      modelOverride = undefined;
      attemptedProviders.add(activeProvider.name);
      continue;
    }
    if (verdict.action === 'stop') {
      debug.log('llm.router', 'provider-fallback-stop', {
        blockedProviders,
        category: verdict.category,
        reason: verdict.reason,
      }, { level: 'error' });
      throw err;
    }
    const terminal = terminalFallbackVerdict(verdict, blockedProviders, 'fallback candidates exhausted');
    const screenError = formatProviderFallbackOutput(terminal);
    const finalText = full.length > 0 ? `${full}\n\n${screenError}` : screenError;
    const finalDelta = finalText.slice(full.length);
    debug.log('llm.router', fallback ? 'provider-fallback-after-output' : 'provider-fallback-exhausted', {
      blockedProviders,
      category: terminal.category,
      reason: terminal.reason,
      ...(fallback ? { skippedFallbackProvider: fallback.name, emittedChars: full.length } : {}),
    }, { level: 'error' });
    onChunk(finalDelta, finalText);
    return finalText;
  }
}

/** 이 오류가 «자격 거부»인가 — ⛔ 「프로바이더 오류」의 부분집합이지만 ***사람이 할 다음 행동이 다르다***.
 *
 *  📏 2026-08-14 실물(grok 구독 토큰 만료 · `[T]` 83차):
 *    LLM API 401: {"error":"Invalid or expired credentials (auth_kind=bearer,
 *                  x_xai_token_auth=xai-grok-cli, upstream=PermissionDenied, reason=no auth context)"}
 *  그때 하니스가 남긴 것은 「보고 결손」뿐이라, 사람이 ***「이 두뇌가 구현을 못 하나」를 의심하고
 *  런을 하나 더 날렸다.*** 재인증 한 번이면 끝나는 일이었다.
 *
 *  ⭐ 판정 규칙은 ***xAI grok-build 의 `is_auth_rejection_message` 를 따랐다***
 *  (`crates/codegen/xai-grok-mcp/src/servers.rs`) — 두 가지를 그대로 가져온다:
 *    ⛔ **403 은 «일부러» 뺀다** — *"a non-auth policy denial here, not a credential problem."*
 *       403 에 「재인증하세요」는 틀린 처방이고, 이 저장소에선 그 계열이 쿼터 축으로 갈린다.
 *    ⛔ **숫자만 보면 안 된다** — `401ms`(소요)·`4012`(다른 코드)가 물린다.
 *
 *  ⊕ 그리고 우리에겐 레퍼런스에 «없는» 것이 있다 — `ApiHttpError.status` 가 «수»로 있다.
 *    ⇒ 그 값이 있으면 그것을 «먼저» 쓰고, 없을 때만 문면으로 내려간다. */
export function isAuthRejectionError(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') return status === 401;
  const message = (err as { message?: unknown })?.message;
  if (typeof message !== 'string' || !message) return false;
  const l = message.toLowerCase();
  // ⛔⭐ 403 은 «먼저» 자른다 — 자격 낱말보다 «앞»이다(무인 리뷰 must-fix ①).
  //   초판은 낱말 분기를 먼저 뒀고, 그래서 "authentication failed: HTTP 403" 이 통과했다.
  //   ⇒ 「403 은 참이 아니다」를 내 손으로 어겼다. 403 은 정책 거부이고, 자격 낱말이 같이 있어도
  //     사람이 할 행동은 「재인증」이 «아니다».
  if (/(status:? ?(code )?403|http (status )?403|error 403|api 403)(?![0-9a-z])|forbidden/.test(l)) {
    return false;
  }
  if (/auth required|authorizationrequired|authrequired|authentication|unauthorized|invalid or expired credential|expired credential/.test(l)) {
    return true;
  }
  return /(status:? ?(code )?401|http (status )?401|error 401|api 401)(?![0-9a-z])/.test(l);
}

/** Count role occurrences in a message array — compact summary for
 *  the router trace. Avoids dumping full message bodies there (the
 *  fetch-level trace already carries bodies after redaction). */
function summarizeRoles(messages: LLMMessage[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of messages) out[m.role] = (out[m.role] ?? 0) + 1;
  return out;
}

/** Shared default-provider resolution for streamLLM / streamLLMWithTools
 *  / skill-runner when the caller hasn't pinned a provider. Honors
 *  user-config (openai-codex OAuth first, then env fallthrough) — fixes
 *  the regression where legacy call sites picked grok from env even
 *  when config said openai-codex. If user-config isn't loadable (tests
 *  with no config file), falls back to env-only getProvider.
 *
 *  Exported so skill-runner and other non-streamLLM callers can share
 *  the same precedence logic. */
export function resolveDefaultProvider(model?: string): LLMProvider {
  try {
    // Local import to avoid a top-of-file circular dep tangle.
    const { getUserConfig } = require('./user-config.js') as typeof import('./user-config.js');
    const cfg = getUserConfig();
    // Skill model declarations are routing hints, unlike explicit per-call
    // model requests to getProviderForConfig. Keep an explicit configured
    // provider when that hint belongs to another provider family.
    const modelHint = cfg.llm.provider !== 'auto' && !isModelCompatible(cfg.llm.provider, model)
      ? undefined
      : model;
    const decision = decideProviderForConfig(cfg, modelHint);
    const p = getProviderForConfig(cfg, modelHint);
    debug.log('llm.router', 'resolveDefaultProvider', {
      source: cfg.llm.provider === 'auto' ? 'user-config-auto-decision' : 'user-config',
      configProvider: cfg.llm.provider,
      configModel: cfg.llm.model,
      requestedModel: model,
      decisionProvider: decision.provider,
      decisionAuth: decision.auth,
      resolvedTo: p.name,
      resolvedModel: p.defaultModel,
      available: p.available(),
    }, { level: 'info' });
    return p;
  } catch {
    const p = getProvider(model);
    debug.log('llm.router', 'resolveDefaultProvider', {
      source: 'env-fallback',
      requestedModel: model,
      resolvedTo: p.name,
      resolvedModel: p.defaultModel,
      available: p.available(),
    }, { level: 'info' });
    return p;
  }
}

/** Handlers + result for `streamLLMWithTools`. */
export interface StreamWithToolsHandlers {
  /** Streaming text delta — invoked for every text chunk across all turns. */
  onText(delta: string, fullAcrossTurns: string): void;
  /** Dispatch a tool call. Returning undefined/null throws in the loop so
   *  callers should always return a JSON-serializable value (can be an
   *  error object — the model will see it as a tool_result either way).
   *
   *  `ctx` (Phase F5) carries the call id so dispatchers can correlate
   *  their per-call state with later handler callbacks (onAgentComplete,
   *  etc.) — critical when Agent batches run in parallel and a closure
   *  variable would race. Older callers ignoring `ctx` still work. */
  dispatchTool(
    name: string,
    args: Record<string, unknown>,
    ctx?: {
      callId: string;
      /** CC (2026-04-25) — current tool-loop turn index (0-based). The
       *  session-runtime planner uses this to allow same-turn parallel
       *  fan-out (`scopeOpenedAtTurn === turnIndex` → pass through)
       *  while still blocking cross-turn repeats. Optional for back-
       *  compat with dispatchers that don't read it. */
      turnIndex?: number;
    },
  ): Promise<unknown>;
  /** Optional: notify when a tool_call is about to fire (for log line,
   *  HUD segment, etc). */
  onToolCall?(call: { id: string; name: string; args: Record<string, unknown> }): void;
  /** Optional: notify with the resolved tool result. */
  onToolResult?(call: { id: string; name: string; result: unknown }): void;
  /** Optional: notify when each tool-loop turn finishes. Lets callers update
   *  thinking-line UX with turn count + pending tool names. */
  onTurnEnd?(info: { turn: number; durationMs: number; textChars: number; pendingCalls: string[] }): void;
  /** Optional: codex Responses API reasoning summary stream (gpt-5
   *  family). `summary_part_added` marks a paragraph break between
   *  successive parts; `summary_delta` carries text within one part.
   *  Only fires when user-config.llm.codexReasoning.summary is set —
   *  callers that don't render reasoning can omit this handler. */
  onReasoning?(event:
    | { kind: 'summary_part_added'; summaryIndex?: number }
    | { kind: 'summary_delta'; delta: string; summaryIndex?: number }
  ): void;
  /** Optional: notify with per-request usage telemetry emitted by provider streams. */
  onUsage?(usage: import('./prompt-cache/types.js').AnthropicUsage): void;
  /** Y2·1 (2026-05-17) — server-side image generation result. Fires
   *  when the Codex provider streams an `image` event (Responses API
   *  `image_generation_call` output item). Callers that opted into
   *  `opts.serverTools.imageGeneration` use this to surface the
   *  generated PNG (insert at cursor, attach to chat, etc); callers
   *  that didn't opt in never see the event because the tool isn't
   *  advertised to the model. */
  onImage?(image: { mediaType: string; data: string; source?: string; revisedPrompt?: string }): void;
  /**
   * Fires exactly once, right before streamLLMWithTools returns. Delivers
   * the messages the loop ACCUMULATED beyond `messages` — i.e. the full
   * sequence of assistant (text + tool_use blocks) and user (tool_result
   * blocks) turns, ending with the final assistant text. Dashboard /
   * long-running callers use this to persist real tool evidence into
   * their own conversation store so the next user turn sees what the
   * model actually did, not just a string summary.
   *
   * The fallback (no-tools) path also fires this with a single
   * `{ role:'assistant', content: fullText }` so callers can treat tool
   * and non-tool paths uniformly.
   */
  onTurnComplete?(newMessages: LLMMessage[]): void;
  /** Phase F5: fires BEFORE a parallel Agent batch begins dispatching.
   *  The loop detects this condition automatically (≥2 Agent calls in
   *  a single turn's pendingCalls) and switches to Promise.all so the
   *  sub-agents run concurrently instead of strictly sequentially. The
   *  callback gets the full list of Agent calls in call order — use it
   *  to render the launch banner and prime any UI state that needs to
   *  know "we're in batch mode now". */
  onAgentBatchStart?(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): void;
  /** Phase F5: fires once per Agent call in the batch as each promise
   *  resolves (in completion order, not call order). Includes the
   *  individual agent's elapsed wall-clock, count-of-siblings-still-
   *  running at the moment this completes, and the batch-level
   *  elapsed-since-start for the `✻ Baked for Xs` checkpoint. Always
   *  paired with onAgentBatchStart — if the handler saw batch start,
   *  it will see exactly `calls.length` onAgentComplete events. */
  onAgentComplete?(info: {
    id: string;
    description: string;
    elapsedMs: number;
    remaining: number;
    batchElapsedMs: number;
  }): void;
  /** Phase F5: fires AFTER the last Agent in a batch completes, so
   *  callers can clear batch-mode state. Fires exactly once per
   *  onAgentBatchStart, after all onAgentComplete events. */
  onAgentBatchEnd?(info: { totalCount: number; batchElapsedMs: number }): void;
  /** Phase F5 (iter): fires periodically while an Agent batch is
   *  in-flight (approximately every BATCH_TICK_INTERVAL_MS). Lets the
   *  pane show a live `✻ Baked for 1m 52s · 4 still running: …` status
   *  that actually ticks instead of only updating at completion
   *  checkpoints. Exceptions in the handler are swallowed — a renderer
   *  bug must not sink an in-flight batch. The caller gets:
   *    • batchElapsedMs — wall-clock since onAgentBatchStart fired
   *    • total         — agents in the batch
   *    • done          — completed so far
   *    • remaining     — total - done
   *    • runningDescriptions — the still-in-flight agents' descriptions
   *      (in their original call order; empty array if none) */
  onAgentBatchTick?(info: {
    batchElapsedMs: number;
    total: number;
    done: number;
    remaining: number;
    runningDescriptions: string[];
  }): void;
}

/** Interval (ms) at which onAgentBatchTick fires during a parallel
 *  Agent batch. 1000 = once per second — matches claude-code-fork's
 *  TeammateSpinnerTree ticker cadence and is the natural granularity
 *  for the "Baked for Xs" counter (the minor bake-time changes
 *  between sub-second ticks would read as UI jitter). */
export const BATCH_TICK_INTERVAL_MS = 1000;

/** Codex-family default tool-loop budget (fix T · 2026-04-25 → 2026-05-03).
 *
 *  History: capped at 4 (2026-04-25) to trip exploration-synthesis
 *  earlier than the default 6 — rationale was that codex burned 38 tool
 *  calls in 6 turns without producing a final answer. That cap was
 *  measured AGAINST the evaluation/maturity stall pathology specifically.
 *
 *  2026-05-03 reassessment — production coding pipelines need more:
 *    - 분석 (find→read→organize)         ≥ 3 turns
 *    - 구현 (find→read→edit→verify)      ≥ 4 turns
 *    - 디버깅 (find→read→exec→edit→verify) ≥ 5 turns
 *  At 4 turns, NONE of the user-facing pipelines fit. Reference comparison:
 *  codex-rs has NO hard cap (relies on prompt steering); gemini-cli uses
 *  DEFAULT=30 / hard MAX=100. We're the outlier with 4.
 *
 *  Raising to 8 keeps the cap tight enough that runaway codex sessions
 *  still trip exploration-synthesis (around turn 6, well before 8), while
 *  giving normal pipelines headroom for find→read→edit→verify→synthesis.
 *  All other defenses remain (L-2 dedup, AA/BB narrowing fallback, CC
 *  turn-aware planner, codexImmediate*Stop hard-stops, exploration
 *  fallback summary) — the budget itself is just no longer the
 *  bottleneck.
 *
 *  Only applied when LLMOpts.maxTurns is NOT explicitly set — skills
 *  / agents that pass an explicit maxTurns keep that value (caller
 *  knows their workload). Other families keep TOOL_LOOP_MAX_TURNS_DEFAULT. */
// 2026-07-17 — codex 능력 해방. This constant is now only a BASELINE fallback
// (used when resolveFamilyMaxTurns returns undefined). The REAL codex budget is
// UNLIMITED via ANSWER_PRIORITY_MAX_TURNS.codex = 0 (0 → POSITIVE_INFINITY in
// the loop), matching ref codex (core/src/session/turn.rs — `loop {}`, no
// counter) and opencode (`maxSteps ?? Infinity`), which impose NO tool-loop cap
// and bound exploration by CONTEXT COMPACTION, not a turn counter. The old
// 8-cap was "codex stall taming" (c7b5f0ab · 2026-04-25) for the OLD codex
// generation's re-read pathology; gpt-5.6 (sol/terra/luna) no longer needs it,
// and being < BUDGET_WARNING_MIN_TURNS (10) the 8-cap silently disabled the
// synthesis window too. Divergence is now defended by (i) prompt discipline and
// (ii) the mid-loop compaction backstop added above in streamLLMWithTools. Kept
// at 24 (not 0) so the fallback stays a SAFE POSITIVE cap — a literal 0 here
// would mean "0 turns" (resolved===0 unlimited is handled in the loop, not by
// this baseline).
export const TOOL_LOOP_MAX_TURNS_CODEX = 24;

/** SSE 스트림 idle watchdog(2026-07-17) — provider.streamChat 이 완료 신호 없이 hang 하는 간헐
 *  케이스(codex SSE 실측 35분 hang) 방어. 마지막 이벤트 후 이 시간(ms) 동안 새 이벤트가 없으면
 *  스트림을 정리·탈출해 받은 텍스트로 진행한다(무한 hang → 자동 복구). 정상 LLM 은 토큰 간격이
 *  이보다 훨씬 짧아 오탐 없음. */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;

/** reasoning-aware idle watchdog(2026-07-19 goal-exec → 아크4 전-family 일반화) —
 *  reasoning-heavy 모델(codex Responses·claude extended thinking·gemini deep·grok·
 *  느린 local)은 토큰 사이에 수십 초 침묵 추론 구간이 있어 고정 45s watchdog 가 사고
 *  중간을 끊어 "포기함"으로 보였다. 이런 family 는 넉넉히 상향해 긴 침묵 추론을 절단하지
 *  않는다. 여전히 유한값이라 진짜 hang(35분)은 회수. (구 이름 STREAM_IDLE_TIMEOUT_MS_CODEX) */
export const STREAM_IDLE_TIMEOUT_MS_REASONING = 180_000;

/** 긴 침묵 추론을 하는 family — codex 뿐 아니라 claude/gemini/grok/local 도 high effort 에서
 *  수십 초 침묵 구간이 있다. fast/mini(gpt·other)만 짧은 45s 복구를 유지.
 *
 *  ⛔⭐ 2026-09-13 (🅕) — ***계열 이름만으로 가르면 조용히 틀린다.*** `getModelFamily` 는
 *  `startsWith('gpt-5')` 로 codex 를 «버전으로» 박아서, 같은 구독 구동기(`openai-codex`)로 도는
 *  `gpt-6-astra` 가 `gpt` 로 떨어지고 **45초**를 받았다. 실측: 턴 길이는 동료(180초)와 거의 같은데
 *  (82.4초 ↔ 83.8초) 우리가 «도착 전»에 끊어 `calls []` → 빈 턴 → give-up 이 됐다.
 *  ⇒ 그래서 ***「구동기」를 둘째 축으로 둔다*** — `provider` 는 런타임에 실제로 고른 값이라
 *  모델 이름이 올라가도 안 늙는다.
 *  ⚠️ 이 줄은 ***유휴 축 하나만*** 고친다. `modelFamily === 'codex'` 로 갈리는 나머지 자리(도구
 *  루프 상한·재읽기 예산·최종 종합 폴백 …)는 그대로다 — 그 축은 🅣 가 계열 판정기 자체를 고친다. */
export function usesLongReasoningIdle(
  modelFamily: string | undefined,
  providerName?: string,
): boolean {
  if (providerName === 'openai-codex') return true;
  return modelFamily === 'codex' || modelFamily === 'claude'
    || modelFamily === 'gemini' || modelFamily === 'grok' || modelFamily === 'local';
}

/** Slow-tool watchdog tick (2026-07-19 E-follow-up) — the stream idle watchdog
 *  only arms INSIDE the SSE loop; once a turn dispatches a tool it is disarmed,
 *  so a long-running tool (e.g. a drive that ran the full `bun test` suite in
 *  bg) leaves the run silent for minutes and reads as a freeze in logs.db
 *  (RESEARCH-autonomous-runaway-discipline §4c residual). Emit a heartbeat
 *  every tick while a single tool call is still in flight so "waiting on a long
 *  tool" is observable and distinguishable from a true hang. */
export const SLOW_TOOL_TICK_MS = 30_000;

/** ★ walker tool 관측 요약(2026-07-21·제1원칙) — mission.walker 'tool' 로그에 실을 compact argsSummary.
 *  장시간 tool(셸 bun test·PtyShell)은 "지금 무슨 명령을 실행 중"이 조회의 핵심이므로 command/file/pattern
 *  같은 식별 필드만 골라 짧게 자른다(전체 args JSON 은 verbose 폭증 — 라이브 로그 오염). 순수함수(테스트가능). */
export function summarizeWalkerToolArgs(name: string, args: Record<string, unknown>): string {
  const pick = (v: unknown, max = 160): string => {
    const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
    return s.length > max ? `${s.slice(0, max)}…` : s;
  };
  // 식별 우선 필드 — 셸/코딩 tool 은 command, 파일 tool 은 file_path, 검색 tool 은 pattern.
  if (typeof args.command === 'string') return pick(args.command);
  if (typeof args.cmd === 'string') return pick(args.cmd);
  if (typeof args.file_path === 'string') return pick(args.file_path);
  if (typeof args.path === 'string' && (name === 'Read' || name === 'Glob' || name === 'Grep')) {
    return typeof args.pattern === 'string' ? `${pick(args.pattern, 80)} @ ${pick(args.path, 80)}` : pick(args.path);
  }
  if (typeof args.pattern === 'string') return pick(args.pattern);
  if (typeof args.description === 'string') return pick(args.description);
  try { const s = JSON.stringify(args); return s.length > 160 ? `${s.slice(0, 160)}…` : s; } catch { return '<unserializable>'; }
}

/** Default tool-loop budget — used when LLMOpts.maxTurns is not set
 *  AND the user-config + answerPriority resolution returns nothing.
 *  Chat path uses this default; skills override to ~20, agents to
 *  whatever AgentSpawnOpts.maxTurns specifies. */
export const TOOL_LOOP_MAX_TURNS_DEFAULT = 6;

/** Anthropic-family default — claude-code-fork ships interactive chat
 *  with no cap (Opus self-terminates by emitting text-only). elanous
 *  keeps a hard cap as runaway insurance, but raises it well above
 *  TOOL_LOOP_MAX_TURNS_DEFAULT because Anthropic models reliably
 *  finish multi-step debugging without re-read pathology that the
 *  codex cap is defending against. Validated 2026-05-04 — chat hit
 *  6/6 turns mid-debugging and emitted a [NO FINAL SYNTHESIS]
 *  placeholder. 24 = answerPriority='quality' default for claude. */
export const TOOL_LOOP_MAX_TURNS_CLAUDE = 24;

/** codex family tool-use discipline — injected as a LEADING system message when
 *  the backend is codex (opencode-style per-family guidance: tools stay unified,
 *  only the USAGE prompt differs per model). This REPLACES the removed turn cap
 *  as the divergence defense for the now-unlimited codex loop, mirroring codex's
 *  own prompt.md: keep-going (don't stop early) + anti-re-read (don't re-read
 *  after edits) + call-tools-for-real (codex tends to narrate instead of
 *  invoking). Pure ASCII + Korean (no special dashes) per agent-prompt policy. */
export const CODEX_TOOL_DISCIPLINE = [
  '[codex tool-use discipline]',
  '- 작업이 완전히 해결될 때까지 계속하라. 도구로 진전을 낼 수 있는데도 부분 결과로 멈추거나 허락을 구하려 손을 떼지 마라.',
  '- 실제로 도구를 호출하라. 무엇을 하겠다고 서술만 하지 말고 Read/Grep/Glob/Bash 를 직접 불러 실제 출력으로 판단하라.',
  '- 방금 편집한 파일을 확인차 다시 읽지 마라. 편집 도구는 실패하면 시끄럽게 알린다. 재읽기는 턴 낭비다. AGENTS.md/CLAUDE.md 는 이미 프롬프트에 있으니 다시 읽지 마라.',
  // Tier 1(2026-07-19) — read-cap 을 카운터가 아니라 규율로 대체(ref oh-my-codex explore.md 이식).
  // 넓이는 강제하되 read 효율을 요구해 무제한 면제 후 context 폭주를 프롬프트로 bound.
  '- 넓게 시작하라. 비자명한 조사는 최소 3개 검색을 서로 다른 각도(파일명/내용/구조/심볼)로 던져 교차검증하라. 첫 매치가 아니라 관련된 것을 모두 찾아라.',
  '- 200줄 넘는 파일은 먼저 심볼/개요를 보고 필요한 범위만 Read 하라. 한 번에 5개 넘게 통째로 Read 하지 말고, 구조/검색 도구를 풀파일 Read 보다 우선하라.',
  '- 같은 검색을 반복하지 마라. 두 번의 병렬 조사 웨이브가 새 사실을 못 내면 조사를 멈추고 판단하라.',
  // E(2026-07-19) — 검증 범위 보정. iv6 드라이브가 격리된 3파일 재배선에 범위 테스트 통과 후에도
  // "머지 수준 증거"라며 경로 없는 전체 `bun test`(수천 파일)를 bg 로 돌려 수분+ 턴을 막았다(과잉검증).
  // 드라이브는 CI 가 아니다 — 변경 고도에 맞춰 검증하고 전체 스위트는 CI 에 위임하라.
  '- 검증은 변경 범위에 맞춰라. 바꾼 코드에 해당하는 테스트 파일(경로 지정)과 tsc 만 돌려라. 경로 없는 전체 `bun test` 스위트는 드라이브 예산을 초과하고 CI 가 나중에 돌리니 실행하지 마라. 오래 걸리는 명령을 bg 로 띄우고 무한정 기다리지 마라.',
  '- 충분한 근거가 모이면 도구 호출 없이 최종 답을 평문으로 써서 턴을 끝내라.',
].join('\n');

/** grok 계열 전용 툴 규율 (2026-08-14 · 대표 *"커먼화 못 하는 부분은 grok 옵션으로 «구분해» 구현"*).
 *
 *  ⛔ **`CODEX_TOOL_DISCIPLINE` 을 «바이트 하나도» 안 건드린다.** 공통 줄을 뽑아 합성하면 코드는
 *  깔끔해지지만 codex 프롬프트의 바이트가 바뀐다 = 다른 프로바이더에 영향. 지시가 「grok 일 때만
 *  돌게」이므로 ***중복 세 줄을 감수하고 분리***한다. 그 「안 건드림」은 테스트가 문다.
 *
 *  📏 이 문면의 근거는 «전부» 실측이거나 grok 자신의 프롬프트다(추측 0):
 *   ⑴ 병렬 — grok-build 의 explore 에이전트 프롬프트가 그렇게 시킨다:
 *      *"Maximize parallel tool calls for speed — issue independent searches simultaneously."*
 *      ⊕ 이 루프는 `for (let turn…)` 안에서 `pendingCalls[]` «배치 하나»를 1턴으로 센다.
 *      ⊕ 실측: grok 자식이 턴당 4.0콜(80콜/20턴)로 예산을 «두 라운드 다» 소진했다.
 *      ⇒ 캡을 올리지 않고도 같은 탐색이 더 적은 턴에 끝난다.
 *   ⑵ grep 본진 — grok-build 구현 트리(51 파일 전수)에 `glob` 이 «없다». 실측 Grep 28 : Glob 1.
 *      그런데 이 저장소의 broad-search 가드는 Grep·Glob·ListDir «연속»을 세므로, grep 하나로
 *      다 하는 모델이 가장 빨리 걸린다(실측: 5회·10회 연속으로 두 번).
 *   ⑶ 조사→편집 전환 — 실측: 첫 편집이 39/80 · 41/76 으로 «정확히 절반 지점»이었다.
 *
 *  ⚠️ 일부러 «안» 하는 것 둘: 턴 캡 자체(`ANSWER_PRIORITY_MAX_TURNS`)와
 *  `isFrontierExplorationFamily` 의 면제는 그대로 둔다. 셋을 동시에 바꾸면 어느 것이 효과인지 못 가른다. */
export const GROK_TOOL_DISCIPLINE = [
  '[grok tool-use discipline]',
  '- 독립적인 조사는 «한 턴에 함께» 던져라. 이 루프의 예산은 툴 호출 수가 아니라 «턴» 수다 — 한 턴에 다섯을 병렬로 부르면 1턴이고, 다섯 턴에 하나씩 부르면 5턴이다.',
  '- 검색은 grep 이 본진이다. 같은 질문을 낱말만 바꿔 반복하지 마라. 두 번의 병렬 웨이브가 새 사실을 못 내면 조사를 멈추고 판단하라.',
  '- 조사는 판단을 미루는 자리가 아니다. 고칠 파일이 정해졌으면 더 읽지 말고 편집으로 넘어가라.',
  '- 방금 편집한 파일을 확인차 다시 읽지 마라. 편집 도구는 실패하면 시끄럽게 알린다.',
  '- 검증은 변경 범위에 맞춰라. 바꾼 코드에 해당하는 테스트 파일(경로 지정)과 tsc 만 돌려라.',
  '- 충분한 근거가 모이면 도구 호출 없이 최종 답을 평문으로 써서 턴을 끝내라.',
].join('\n');

/** local 계열 전용 툴 규율. 두 실행 표본에서 전체 큰 파일 읽기 뒤 중단이 한 번,
 *  범위 지정 읽기가 완주 실행에서 네 번 관측됐으므로, 단정 대신 잠재적으로 큰 파일의
 *  범위 읽기를 우선하도록만 안내한다. 다른 계열의 문면과는 의도적으로 합성하지 않는다. */
const LOCAL_TOOL_DISCIPLINE = [
  '[local tool-use discipline]',
  '- 관측 표본은 아직 두 실행뿐이다. 잠재적으로 큰 파일은 전체를 한 번에 읽기보다 먼저 심볼이나 검색으로 필요한 범위를 찾고, 범위 지정 Read 를 우선하라.',
  '- 범위 읽기만으로 판단할 수 없을 때에만 전체 읽기를 선택하고, 읽은 뒤에는 다음 행동을 계속 결정하라.',
].join('\n');

/** 모델군 → 그 군에 주입할 툴 규율(없으면 `null`). **능력 술어 판** — 2026-08-14.
 *
 *  ⛔ **왜 `if` 세 개가 아니라 이 표인가**: codex·grok·local 이 각각 「같은 모양의 if」로 붙어 있었고,
 *  넷째가 붙을 때도 그 모양이 반복될 참이었다. 대표 이 그 형태를 짚었다 —
 *  *"claude 제외 다른 LLM 들이 공용화가 많아 보이고, 오히려 claude 일 때 옵션화를 해야 하는 게
 *  아닌지"*. 실측으로 답하면: family 전용 분기는 codex 24 · gemini 6 · claude 5 · grok 4 · local 2 이고,
 *  ***claude 5곳 중 「진짜 claude 전용」은 하나뿐***이다(나머지는 「거의 전부」를 나열한 포함 목록).
 *  ⇒ 📌 ***분기 수는 「특수성」이 아니라 「측정량」의 지표***다. 그러니 새 군이 늘 때 「분기를 하나 더」가
 *  아니라 「칸을 하나 더」가 되게 한다.
 *
 *  ⭐ `Record<ModelFamily, …>` 를 **완전형으로** 쓴다 — 군이 하나 늘면 TypeScript 가 이 표의 칸을
 *  요구한다. 「규율 없음」도 `null` 로 **명시**해야 하므로, 새 군이 «조용히» 규율을 못 받는 일이 없다.
 *  (`#9070` 의 `NAMED_MAX_TURNS_FAMILIES` 와 같은 패턴 — 이 저장소가 이미 고른 형태다.)
 *
 *  ⛔ 이 표는 **동작을 바꾸지 않는다**. 같은 군에 같은 문면이다 — 회귀는 「전송된 messages」로 문다.
 *  ⚠️ 문면 자체를 공통 상수로 합치지 «않는다»: 합치면 한 군의 프롬프트 바이트가 다른 군 때문에 바뀐다
 *  (대표 *"다른 프로바이더까지 영향 주는 부분은 그 군일 때에만"*). 겹치는 줄의 중복은 그 대가다. */
const TOOL_DISCIPLINE_BY_FAMILY: Record<ModelFamily, string | null> = {
  codex: CODEX_TOOL_DISCIPLINE,
  grok: GROK_TOOL_DISCIPLINE,
  local: LOCAL_TOOL_DISCIPLINE,
  // ⬇ 아래 넷은 「아직 안 쟀다」이지 「필요 없다」가 아니다.
  //   `other` 가 0인 것은 ***아무도 other 를 안 쟀기 때문***이고, 실제 자식 하나가 오늘 `other` 였다(`[S]` 실측).
  claude: null,
  gemini: null,
  gpt: null,
  other: null,
};

/** 이 군이 받을 툴 규율. 없으면 `null` — 호출자는 그때 history 를 «건드리지 않는다».
 *
 *  ⛔⭐ **own-property 로만 찾는다**(무인 리뷰 must-fix · `#9079`). 이 함수의 입력은 `string` 이라
 *  `'toString'`·`'constructor'`·`'__proto__'` 가 올 수 있고, 평범한 객체를 그대로 인덱싱하면
 *  ***`Object.prototype` 의 «함수»가 돌아와 system 메시지 본문으로 주입된다.***
 *  ⇒ 오늘 여덟 번 밟은 그 형태의 또 다른 판이다 — 「없는 것」이 「그럴듯한 값」으로 나온다. */
export function resolveToolDiscipline(modelFamily: string | undefined): string | null {
  if (!modelFamily) return null;
  if (!Object.prototype.hasOwnProperty.call(TOOL_DISCIPLINE_BY_FAMILY, modelFamily)) return null;
  return TOOL_DISCIPLINE_BY_FAMILY[modelFamily as ModelFamily] ?? null;
}

// ★ C4(문맥관리 트랙·2026-07-19) — 미션 walker 압축 후 재-read 지시. midloop compaction 이 파일 내용·조사
//   결과를 요약으로 축약하면 walker 가 요약을 진실로 착각해 산출물/아크 관련 파일을 다시 안 읽는 손실체인이
//   생긴다(arcHint 손실 동형). 압축 직후 미션 경로에서만 이 힌트를 history 에 실어 재-read 를 유도한다.
export const MISSION_COMPACT_REREAD_HINT = [
  '[컨텍스트 압축됨] 직전 대화가 요약으로 축약되었다.',
  '요약이 파일 내용·조사 결과를 압축했을 수 있으니, 이어서 작업/검증할 핵심 파일(산출물 .artifacts/*, 아크 관련 소스)은 요약을 신뢰하지 말고 필요 시 Read/Grep 으로 다시 읽어라.',
  '특히 요약의 "Relevant files" 항목을 우선 재확인하고, 확정 사실(아크 통합 의도·acceptance)은 요약본이 아니라 원문/파일로 검증하라.',
].join(' ');

/** Named families that own a budget cell by name.
	 *
	 *  Choice (2026-08-14): a const-array + Record completeness check, not
	 *  `Record<ModelFamily, number>`. Adding a name here makes TypeScript
	 *  require a cell in every ANSWER_PRIORITY_MAX_TURNS row — 「군을 하나
	 *  더 알게 되면 칸도 같이 생긴다」. We did not key the table by
	 *  ModelFamily itself because that union also contains local / gpt /
	 *  other, which this goal must keep on the residual `default` path
	 *  (same numbers, same override key). A ModelFamily-keyed table would
	 *  invent per-family numbers for those residuals.
	 *
	 *  grok is on this list so it no longer collapses into `default`.
	 *  Pair: `MAX_TURNS_BUDGET_KEYS` in user-config.ts (override seam). */
	export const NAMED_MAX_TURNS_FAMILIES = ['claude', 'codex', 'gemini', 'grok', 'openrouter'] as const;
	type NamedMaxTurnsFamily = typeof NAMED_MAX_TURNS_FAMILIES[number];
	type FamilyMaxTurnsKey = NamedMaxTurnsFamily | 'default';

	function isNamedMaxTurnsFamily(family: string): family is NamedMaxTurnsFamily {
	  return (NAMED_MAX_TURNS_FAMILIES as readonly string[]).includes(family);
	}

	/** Map a getModelFamily() tag onto a budget cell. Named families keep
	 *  their own key; everything else (local, gpt, other, unknown) is
	 *  `default`. Exported so tests can assert the path, not just the number. */
	export function familyMaxTurnsKey(modelFamily: string): FamilyMaxTurnsKey {
	  return isNamedMaxTurnsFamily(modelFamily) ? modelFamily : 'default';
	}

	/** answerPriority → per-family maxTurns lookup. Hit when the user
	 *  hasn't pinned `llm.maxTurns.<family>` directly.
	 *  2026-07-17 — codex quality/exhaustive set to 0 (= UNLIMITED, resolved===0 →
	 *  POSITIVE_INFINITY in the loop) to stop starving a capable model; frontier
	 *  agents (ref codex, opencode) run the tool loop uncapped and bound it by
	 *  context compaction (see the mid-loop backstop in streamLLMWithTools). codex
	 *  cost/balanced stay finite (explicit low-budget modes). gemini keeps its
	 *  tight caps (its function-call-only pathology is unresolved).
	 *
	 *  2026-08-14 — grok owns named cells so it no longer collapses into
	 *  `default`. This goal does not invent a grok quality number (the
	 *  2026-08-14 19/20 sample is not a fixed-value warrant). quality
	 *  therefore keeps the residual 20; unlimited is the same user-config
	 *  path codex already has (`llm.maxTurns.grok` = 0 or null). Non-quality
	 *  rows keep the former residual-default policy on purpose (cost 4 /
	 *  balanced 6 / exhaustive 12).
	 *
	 *  2026-09-23 — 결정 「codex 처럼 나머지 모델도 예산을 넉넉하게」. grok · openrouter 의
	 *  quality/exhaustive 를 codex 와 같은 0(무제한)으로 연다. 08-14 판은 「grok 값을 지어내지
	 *  않는다」며 20 을 남겼는데, 그 20 이 실제로 물었다: codex 소진 뒤 grok 으로 떨어진 하니스
	 *  자식이 6시간에 런 9개에서 마감 구간 도구 거부 25회(`tool-loop.synthesis-phase.tool-rejected`
	 *  maxTurns=20). openrouter(kimi·glm·qwen)는 군이 'other' 라 잔여 default 20 으로 새던 것을
	 *  provider 칸으로 뺐다. cost/balanced 는 명시적 저예산 모드라 유한하게 둔다(openrouter 는 codex 값).
	 *  gemini · default(local 등)는 함수호출 병리 기록이 있어 이 판에서 안 연다. */
	const ANSWER_PRIORITY_MAX_TURNS: Record<
	  'cost' | 'balanced' | 'quality' | 'exhaustive',
	  Record<FamilyMaxTurnsKey, number>
	> = {
	  cost:       { claude: 6,  codex: 6,  gemini: 4,  grok: 4,  openrouter: 6,  default: 4 },
	  balanced:   { claude: 12, codex: 12, gemini: 8,  grok: 6,  openrouter: 12, default: 6 },
	  // gemini quality bumped 8 → 16 (2026-05-04) after self-debug session
	  // showed function-call-only pathology exhausting the 8-turn budget
	  // before W5-G could fire (needs noContentReadTurnStreak >= 4 + at
	  // least one synthesis turn afterwards). 16 leaves headroom even when
	  // gemini takes 4-5 search turns before pivoting to Read.
	  //
	  // default quality bumped 6 → 12 (2026-05-14, AM) — iOS dogfood with
	  // mlx-community/gemma-4-26b-a4b-it (LM Studio) hit the same
	  // function-call-only pathology gemini did pre-fix.
	  //
	  // default quality bumped 12 → 20 (2026-05-14, PM) — the 12-turn
	  // budget still wasn't enough for a 4-step Next.js + shadcn setup
	  // because each `npm install` Bash burns its own turn (observed
	  // 35s and 47s back-to-back installs in turns 9-10). The synthesis-
	  // phase guard (maxTurns - 2) then fired at turn 10, hard-rejecting
	  // the Bash needed for step 3 (Verify) and the loop bailed to
	  // `[NO FINAL SYNTHESIS]` with step 3 incomplete. 20 = same
	  // headroom claude exhaustive gives the default-family models, so
	  // a typical 4-step setup with 2-3 long installs + Verify + final
	  // synthesis comfortably fits inside the synthesis-phase window.
	  quality:    { claude: 24, codex: 0,  gemini: 16, grok: 0,  openrouter: 0, default: 20 },
	  exhaustive: { claude: 50, codex: 0,  gemini: 24, grok: 0,  openrouter: 0, default: 12 },
	};

	/** Resolve the family default maxTurns from user-config. Resolution
	 *  order: explicit `llm.maxTurns.<family>` (incl. null = unlimited)
	 *  → answerPriority mapping → hardcoded family baseline.
	 *
	 *  Returned 0 means "unlimited" — the caller turns this into a no-op
	 *  loop terminator. Positive returns are honored verbatim. */
	export function resolveFamilyMaxTurns(modelFamily: string, providerName?: string): number {
	  const { getUserConfig } = require('./user-config.js') as typeof import('./user-config.js');
	  const cfg = getUserConfig();
	  // ⛔ provider 로 고르는 칸이 둘이다 — 모델 군(family)으로는 못 가른다:
	  //   openai-codex 의 모델은 군이 'gpt' 이고, openrouter 의 kimi·glm·qwen 은 군이 'other' 라 잔여 'default' 로 샌다.
	  const familyKey = providerName === 'openai-codex' ? 'codex'
	    : providerName === 'openrouter' ? 'openrouter'
	    : familyMaxTurnsKey(modelFamily);
	  // Per-family explicit override wins (incl. null/0 = unlimited).
	  const override = cfg.llm.maxTurns?.[familyKey];
	  if (override === null) return 0;  // unlimited sentinel
	  if (typeof override === 'number') return override;
	  // answerPriority mapping (default = 'quality').
	  const priority = cfg.llm.answerPriority ?? 'quality';
	  return ANSWER_PRIORITY_MAX_TURNS[priority][familyKey];
	}

/** Fraction of maxTurns at which the budget-warning guard fires. 0.7
 *  leaves ~30% of the budget for synthesis after the warning lands —
 *  for maxTurns=20 that's 6 turns of text generation. */
export const BUDGET_WARNING_RATIO = 0.7;

/** Minimum maxTurns for budget-warning to engage. Chat default (6)
 *  is intentionally excluded — short conversational turns don't need
 *  a synthesis reminder since they're not doing multi-phase research.
 *  Skills (20) and sub-agents (≥10) trigger it. */
export const BUDGET_WARNING_MIN_TURNS = 10;

/** Number of trailing turns in which tool calls are HARD-REJECTED —
 *  the final-synthesis window. When the model is operating under
 *  pressure (large models still love chasing Bash calls), soft warnings
 *  embedded in tool_result content get ignored. Inside this window we
 *  refuse to execute any tool call: the dispatch is skipped and each
 *  pending call gets a synthetic tool_result saying "TOOL CALL REJECTED
 *  — write FINAL ANSWER in plain text now". This leaves the model with
 *  no option but to emit text. Gated by BUDGET_WARNING_MIN_TURNS so the
 *  chat path stays unaffected.
 *
 *  With value=2 and maxTurns=10: turns 8 and 9 are synthesis-only.
 *  Model sees the rejection stub on turn 8 and should produce text on
 *  turn 9. If it still makes tool calls on turn 9 (last), we reject
 *  again but the loop exits — at worst we end with empty text, same
 *  as the no-protection baseline. */
export const FINAL_SYNTHESIS_TURNS = 2;
export const EXPLORATION_SYNTHESIS_TURNS_DEFAULT = 4;
export const INSPECT_BUDGET_DEFAULT = 2;
export const INSPECT_BUDGET_STRUCTURAL_ANALYSIS = 3;
/** codex-family inspect budget(Tier 1 · 2026-07-19 goal-exec) — 2-file 하드월은 옛 codex
 *  세대 re-read pathology 용 taming 이고 gpt-5.6 은 불필요(격리 dogfood 실측: 14~22 파일을
 *  건강히 읽으며 re-read-loop 없음. 하지만 inspect-synthesis-phase 가 수백 번 tool-rejected
 *  발동해 codex 를 억눌렀다). frontier 계열은 이미 exploration streak-cut 을 면제받는데
 *  (`isFrontierExplorationFamily`) inspect-budget 만 면제에서 빠져 있었다 — 동일 취지로 면제.
 *  Infinity → autoNarrowedReadCount 가 이를 못 넘어 inspect-synthesis 가 codex 에 arm 되지
 *  않는다. 폭주는 maxTurns + midloop-compaction 이 bound(ref codex 동형: 카운터 아닌 compaction). */
export const INSPECT_BUDGET_CODEX = Number.POSITIVE_INFINITY;

function appendFinalSynthesisNotice(existingText: string, notice: string): string {
  return existingText.length > 0 ? `${existingText}\n\n${notice}` : notice;
}

function buildNoFinalSynthesisNotice(reason: 'empty-turn' | 'budget-exhausted'): string {
  const why = reason === 'empty-turn'
    ? 'The model stopped after repeated empty turns.'
    : 'The model used the available tool-loop turns without writing a plain-text answer.';
  return (
    '[NO FINAL SYNTHESIS] '
    + `${why} `
    + 'Review the tool results above and retry with a narrower request if needed.'
  );
}

/**
 *  Exploration fallback summary — companion to `buildIgnoredSynthesisNotice('exploration')`.
 *
 *  Problem: when the codex family hits the exploration synthesis phase
 *  and ignores rejection stubs (observed 2026-04-25, log/debug-20260425141718,
 *  log/debug-20260425144120), the loop exits with the apology notice
 *  and *no* useful content. The user's question receives 0 chars of
 *  substantive answer.
 *
 *  This builder reconstructs WHAT the model attempted from the
 *  turn-by-turn tool call history (ListDir / Grep / Glob / Read / Lsp),
 *  then appends a recommendation. Mirrors the `buildInspectFallbackSummary`
 *  pattern that already exists for the inspect path. Empty input → ''
 *  so the caller can short-circuit to the bare notice.
 */
/** W5-E (2026-05-03 PM) — Force-synthesis no-tools pass. Last-resort
 *  intervention when the streamLLMWithTools loop is about to emit a
 *  [...IGNORED] hard-stop notice for codex family. The model has the
 *  file contents in its prior tool_result blocks but kept emitting
 *  more tool calls; removing tools entirely forces a text-only reply.
 *
 *  Returns the synthesized text on success (≥ 50 chars), or null
 *  when the pass fails (provider error, empty / too-short response).
 *  Caller falls back to the original [...IGNORED] notice on null.
 *
 *  Forensic events at every junction:
 *  - tool-loop.force-synthesis-pass.attempted
 *  - tool-loop.force-synthesis-pass.succeeded / .empty / .failed
 *
 *  Safety: 8000-char output cap (stops streaming once exceeded), 60s
 *  effective wall-time via the underlying provider's transport. */
async function tryForceSynthesisPass(args: {
  provider: LLMProvider;
  model: string;
  history: LLMMessage[];
  turn: number;
  modelFamily: string;
  /** When provided, each synthesis delta is emitted progressively
   *  (live streaming UX) instead of collected silently for one
   *  post-hoc emission. Caller MUST skip its own post-success
   *  `handlers.onText('', text)` re-emit when this is set — the
   *  text is already on display. On synthesis failure (< 50 chars
   *  / error), this function emits a clear signal to wipe any
   *  partial text it streamed. */
  streamingHandlers?: { onText: (delta: string, accumulated: string) => void };
}): Promise<string | null> {
  const { provider, model, history, turn, modelFamily, streamingHandlers } = args;
  const synthesisPromptMsg: LLMMessage = {
    role: 'user',
    content:
      'Your tool budget is exhausted and the dispatcher will reject any further tool calls. ' +
      'Based on the file contents and search results already in your prior tool_result blocks, ' +
      'write the final answer NOW as plain text — concise but useful. Do NOT request any tools; ' +
      'just write the synthesis directly. If the prior tool results were insufficient for a ' +
      'substantive answer, say so briefly (1-2 sentences) and stop.',
  };
  const synthesisHistory = [...history, synthesisPromptMsg];
  if (debug.enabled) {
    debug.log('llm.router', 'tool-loop.force-synthesis-pass.attempted', {
      turn,
      historyLen: synthesisHistory.length,
      modelFamily,
      model,
      streaming: streamingHandlers !== undefined,
    });
  }
  // F2 — wall-time timeout guard. Without this, a stuck codex
  // synthesis call could hang the entire turn for many minutes
  // (measured: 645s outlier in log/debug-20260503183812.log run-5).
  // Provider streams that don't deliver a delta within this window
  // are aborted; callers get either the partial text (if substantive,
  // i.e. >=50 chars) or null (the standard "synthesis empty" fallback
  // path takes over with the original hard-stop notice).
  const F2_TIMEOUT_MS = 60_000;
  const f2Controller = new AbortController();
  const f2Timer = setTimeout(() => f2Controller.abort(), F2_TIMEOUT_MS);
  try {
    let collected = '';
    const MAX_OUTPUT_CHARS = 8000;
    for await (const delta of provider.chat(synthesisHistory, { model, signal: f2Controller.signal })) {
      collected += delta;
      // Live progressive emit — TUI shows synthesis text as it
      // generates instead of all-at-once at the end (user-reported
      // "중간에 메시지 노출 없이 나중에 한번에 노출" symptom). Each
      // delta goes through the standard onText path → ACP bridge →
      // dashboard turn-stream-runtime perRoundText accumulator.
      streamingHandlers?.onText(delta, collected);
      if (collected.length >= MAX_OUTPUT_CHARS) {
        collected = collected.slice(0, MAX_OUTPUT_CHARS);
        break;
      }
    }
    const text = collected.trim();
    if (text.length < 50) {
      // Wipe any partial text we streamed before falling back to the
      // caller's notice path — otherwise the display would show a
      // partial sentence followed by the [...IGNORED] / [NO FINAL
      // SYNTHESIS] notice.
      if (streamingHandlers && collected.length > 0) {
        streamingHandlers.onText('', '');
      }
      if (debug.enabled) {
        debug.log('llm.router', 'tool-loop.force-synthesis-pass.empty', {
          turn,
          textLen: text.length,
          preview: text.slice(0, 80),
          streamedPartialChars: collected.length,
        });
      }
      return null;
    }
    if (debug.enabled) {
      debug.log('llm.router', 'tool-loop.force-synthesis-pass.succeeded', {
        turn,
        textLen: text.length,
        preview: text.slice(0, 100),
        streamed: streamingHandlers !== undefined,
      });
    }
    return text;
  } catch (err: any) {
    // Same partial-text cleanup on error path.
    if (streamingHandlers) {
      streamingHandlers.onText('', '');
    }
    const isF2Timeout = err?.name === 'AbortError' && f2Controller.signal.aborted;
    if (debug.enabled) {
      debug.log('llm.router', isF2Timeout ? 'tool-loop.force-synthesis-pass.f2-timeout' : 'tool-loop.force-synthesis-pass.failed', {
        turn,
        timeoutMs: isF2Timeout ? F2_TIMEOUT_MS : undefined,
        error: err?.message ?? String(err),
      }, { level: isF2Timeout ? 'warn' : 'error' });
    }
    return null;
  } finally {
    clearTimeout(f2Timer);
  }
}

function buildExplorationFallbackSummary(
  toolCallHistory: ReadonlyArray<{ name: string; args: Record<string, unknown> }>,
): string {
  if (toolCallHistory.length === 0) return '';
  const listDirPaths = new Set<string>();
  const grepPatterns: string[] = [];
  const globPatterns: string[] = [];
  const readFiles = new Set<string>();
  const lspActions: string[] = [];
  const otherTools = new Map<string, number>();
  const trim = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  for (const call of toolCallHistory) {
    const args = call.args ?? {};
    if (call.name === 'ListDir') {
      const p = typeof args.path === 'string' && args.path.length > 0 ? args.path : '.';
      listDirPaths.add(p);
    } else if (call.name === 'Grep') {
      const p = typeof args.pattern === 'string' ? args.pattern : '';
      if (p) grepPatterns.push(trim(p, 80));
    } else if (call.name === 'Glob') {
      const p = typeof args.pattern === 'string' ? args.pattern : '';
      if (p) globPatterns.push(trim(p, 80));
    } else if (call.name === 'Read') {
      const f = typeof args.file_path === 'string' ? args.file_path : '';
      if (f) readFiles.add(f);
    } else if (call.name === 'Lsp') {
      const a = typeof args.action === 'string' ? args.action : 'unknown';
      lspActions.push(a);
    } else {
      otherTools.set(call.name, (otherTools.get(call.name) ?? 0) + 1);
    }
  }
  const lines: string[] = ['===== EXPLORATION GATHERED ====='];
  if (listDirPaths.size > 0) {
    const arr = [...listDirPaths];
    lines.push(`- ListDir paths (${arr.length}): ${arr.slice(0, 8).join(', ')}${arr.length > 8 ? ', …' : ''}`);
  }
  if (grepPatterns.length > 0) {
    lines.push(`- Grep patterns (${grepPatterns.length}):`);
    for (const p of grepPatterns.slice(0, 6)) lines.push(`  · "${p}"`);
    if (grepPatterns.length > 6) lines.push(`  · …`);
  }
  if (globPatterns.length > 0) {
    lines.push(`- Glob patterns (${globPatterns.length}):`);
    for (const p of globPatterns.slice(0, 6)) lines.push(`  · "${p}"`);
    if (globPatterns.length > 6) lines.push(`  · …`);
  }
  if (readFiles.size > 0) {
    const arr = [...readFiles];
    lines.push(`- Read files (${arr.length}): ${arr.slice(0, 8).join(', ')}${arr.length > 8 ? ', …' : ''}`);
  }
  if (lspActions.length > 0) {
    lines.push(`- Lsp actions (${lspActions.length}): ${lspActions.slice(0, 6).join(', ')}`);
  }
  for (const [name, count] of otherTools) {
    lines.push(`- ${name} (${count}x)`);
  }
  lines.push('');
  if (readFiles.size === 0) {
    lines.push('Recommendation: No file content was read into context, so a substantive answer was not possible within the budget.');
    lines.push('Try: narrow the request to 3-5 specific file paths (e.g. "evaluate src/llm.ts only"), or ask about a specific area instead of the whole project.');
  } else {
    lines.push(`Recommendation: ${readFiles.size} file(s) were read but synthesis was blocked by the tool-loop budget. Retry with a narrower scope, or ask a follow-up question that reuses what was already read.`);
  }
  lines.push('================================');
  return lines.join('\n');
}

function buildIgnoredSynthesisNotice(reason: 'exploration' | 'budget' | 'narrowing' | 'inspect'): string {
  const why = reason === 'exploration'
    ? 'The model kept issuing read/search tools after the exploration budget was exhausted.'
    : reason === 'inspect'
      ? 'The model kept issuing more tool calls after inspecting the top candidate files and being told to synthesize.'
    : reason === 'narrowing'
      ? 'The model kept issuing more candidate-listing searches after being told to narrow to Read/Lsp/content grep.'
      : 'The model kept issuing tool calls after synthesis was explicitly required.';
  return (
    '[SYNTHESIS IGNORED] '
    + `${why} `
    + 'Stopped the loop instead of spending more turns on blocked tool calls. Retry with a narrower request if needed.'
  );
}

function buildIgnoredActionNotice(): string {
  return (
    '[ACTION IGNORED] '
    + 'The model kept issuing more search/listing tools after inspecting the top candidate files '
    + 'and being told to move to Edit/Write/RunShell/Bash or a narrow code-intel followup. '
    + 'Stopped the loop instead of spending more turns on blocked tool calls. '
    + 'Retry with a narrower change request if needed.'
  );
}

function buildIgnoredExecutionNotice(): string {
  return (
    '[EXECUTION IGNORED] '
    + 'The model kept issuing more search/listing tools after inspecting the top candidate files '
    + 'and being told to run the code, tests, or repro command first. '
    + 'Stopped the loop instead of spending more turns on blocked tool calls. '
    + 'Retry with a narrower debugging step if needed.'
  );
}

function buildIgnoredVerifyNotice(): string {
  return (
    '[VERIFY IGNORED] '
    + 'The model kept issuing more search/listing tools after making edits and being told to move to verification. '
    + 'Stopped the loop instead of spending more turns on blocked tool calls. '
    + 'Retry with a narrower verification step if needed.'
  );
}

export type ToolLoopFollowupPhase =
  | 'inspect-synthesis'
  | 'inspect-action'
  | 'inspect-execution'
  | 'repair-action'
  | 'verify-action';

export interface ToolLoopPhaseRejectionLogFields {
  turn: number;
  maxTurns: number;
  exploratoryTurnStreak: number;
  inspectSynthesisArmed: boolean;
  autoNarrowedReadCount: number;
  rejectedTools: string[];
  rejectedCount: number;
}

const TOOL_LOOP_PHASE_DIRECTIVES: Record<ToolLoopFollowupPhase, (autoNarrowedReadCount: number) => string> = {
  'inspect-synthesis': (autoNarrowedReadCount) =>
    `INSPECT BUDGET EXHAUSTED — already inspected ${autoNarrowedReadCount} candidate file(s). `
    + 'Stop gathering more files and synthesize the structure you found from the inspected files.',
  'inspect-action': (autoNarrowedReadCount) =>
    `INSPECT ACTION REQUIRED — already inspected ${autoNarrowedReadCount} candidate file(s). `
    + 'Stop gathering more files and move to Edit/Write/RunShell/Bash/Agent or a narrow code-intel followup (Lsp/AstGrep/Grep content/count), or answer in plain text if no change is needed.',
  'inspect-execution': (autoNarrowedReadCount) =>
    `INSPECT EXECUTION REQUIRED — already inspected ${autoNarrowedReadCount} candidate file(s). `
    + 'Stop gathering more files and run the code, tests, or repro command first via RunShell/Bash, or answer in plain text if execution is unnecessary.',
  'repair-action': () =>
    'REPAIR ACTION REQUIRED — execution has already failed or a debugging repair step is armed. '
    + 'Stop gathering more files and move to Edit/Write/RunShell/Bash or a narrow code-intel followup (Read/Lsp/AstGrep/Grep content/count), '
    + 'or answer in plain text if no code change is needed (e.g. a read-only investigation whose finding is the deliverable).',
  'verify-action': () =>
    'VERIFY ACTION REQUIRED — edits already happened. '
    + 'Stop gathering more files and move to RunShell/Bash/Agent or a narrow verification followup (Read/Lsp/Grep content/count), or answer in plain text if verification is not needed.',
};

const TOOL_LOOP_PHASE_REJECTION_EVENTS: Record<ToolLoopFollowupPhase, string> = {
  'inspect-synthesis': 'tool-loop.inspect-synthesis-phase.tool-rejected',
  'inspect-action': 'tool-loop.inspect-action-phase.tool-rejected',
  'inspect-execution': 'tool-loop.inspect-execution-phase.tool-rejected',
  'repair-action': 'tool-loop.repair-action-phase.tool-rejected',
  'verify-action': 'tool-loop.verify-action-phase.tool-rejected',
};

const TOOL_LOOP_PHASE_REJECTION_PREFIX = 'TOOL CALL REJECTED — ';
const TOOL_LOOP_PHASE_REJECTION_SUFFIX = ' did NOT run. Nothing they would have changed has changed. ';

/** Returns rejected tool names only for the canonical followup-guard stub. */
export function getToolLoopPhaseRejectedTools(content: string): string[] | null {
  if (!content.startsWith(TOOL_LOOP_PHASE_REJECTION_PREFIX)) return null;
  const suffixIndex = content.indexOf(TOOL_LOOP_PHASE_REJECTION_SUFFIX, TOOL_LOOP_PHASE_REJECTION_PREFIX.length);
  if (suffixIndex < 0) return null;
  const names = content
    .slice(TOOL_LOOP_PHASE_REJECTION_PREFIX.length, suffixIndex)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 ? names : null;
}

export function buildToolLoopPhaseRejectionMessage(
  phase: ToolLoopFollowupPhase,
  rejectedTools: readonly string[],
  autoNarrowedReadCount: number,
  executedTools: readonly string[] = [],
): string {
  const toolNames = rejectedTools.join(', ');
  const executionNotice = executedTools.length > 0
    ? ` The following allowed tool call(s) are not blocked and continue in original order: ${executedTools.join(', ')}.`
    : '';
  return `${TOOL_LOOP_PHASE_REJECTION_PREFIX}${toolNames}${TOOL_LOOP_PHASE_REJECTION_SUFFIX}${executionNotice} ${TOOL_LOOP_PHASE_DIRECTIVES[phase](autoNarrowedReadCount)}`;
}

export function buildToolLoopPhaseRejectionLog(
  phase: ToolLoopFollowupPhase,
  fields: ToolLoopPhaseRejectionLogFields,
): { event: string; payload: ToolLoopPhaseRejectionLogFields & { phase: ToolLoopFollowupPhase } } {
  return {
    event: TOOL_LOOP_PHASE_REJECTION_EVENTS[phase],
    payload: { ...fields, phase },
  };
}

function buildAutoUndoRepairNotice(result: { output?: string; restoredId?: string; restoredSha?: string }): string {
  const restored = result.restoredId
    ? `- restored snapshot: ${result.restoredId}${result.restoredSha ? ` (${result.restoredSha.slice(0, 8)})` : ''}`
    : '';
  const summary = typeof result.output === 'string' && result.output.trim().length > 0
    ? `- undo result: ${result.output.trim()}`
    : '';
  return [
    '===== AUTO-UNDO APPLIED =====',
    'The same tool error repeated 3 times in a row, so the system automatically reverted the most recent turn snapshot and switched into repair mode.',
    restored,
    summary,
    'Next step: inspect the restored state, make a smaller corrective change, and continue with Edit/Write plus verification.',
    '=============================',
  ].filter(Boolean).join('\n');
}

// Fallback chat text used only when the AskUserQuestion bridge isn't
// reachable (no resolver, no sessionId, dispatch error). The marker
// `[ASK USER]` is preserved so `isUserInterventionRequired` downstream
// still skips force-synthesis — that gate predates the bridge route and
// other surfaces (TUI) still rely on the marker as a hard-stop signal.
function buildAutoUndoAskUserNotice(reason: DoomLoopReason, detail?: string | null): string {
  const why = reason === 'plan-mode'
    ? 'Auto-undo was skipped because plan mode is active.'
    : reason === 'no-undo-available'
      ? 'Auto-undo was skipped because no undo snapshot is available.'
      : reason === 'undo-failed'
        ? 'Auto-undo was attempted but the undo runtime failed.'
        : 'Retry policy did not authorize auto-undo for this failure.';
  return [
    '[ASK USER] The same tool call kept failing — stopping to avoid wasting more turns.',
    why,
    detail ? `Detail: ${detail}` : '',
    'Reply with how to proceed (retry, change approach, or stop).',
  ].filter(Boolean).join(' ');
}

// ── Doom-loop → AskUserQuestion routing ─────────────────────────
//
// When the tool-loop trips the doom-loop gate (same tool error 3x) it
// previously emitted a raw `[ASK USER]` chat message describing what
// went wrong. With the AskUserQuestion bridge (PR #2611 PWA, #2612
// iOS, #2613 multi-option fan-out) live across PWA + iOS surfaces, we
// can self-dispatch a structured prompt instead so the user sees a
// modal with retry / different-approach / stop options rather than
// raw English instructions intended for the LLM.
//
// Falls back to the legacy `[ASK USER]` chat text when:
//   - no `sessionId` plumbed (CLI / startup script callers),
//   - no resolver wired (TUI-only or dispatch error), or
//   - the bridge throws (peer disconnected, surface mismatch).
//
// The fallback marker `[ASK USER]` is preserved so the downstream
// `isUserInterventionRequired` gate continues to skip force-synthesis.

export type DoomLoopReason = 'plan-mode' | 'no-undo-available' | 'undo-failed' | 'policy';

/** Why this request needs human intervention; distinct from `DoomLoopReason`,
 * which records why automatic recovery was unavailable. */
export type DoomLoopInterventionClass =
  | 'credentials'
  | 'irreversible-external-action'
  | 'consequential-product-decision'
  | 'none'
  | 'unknown';

const DOOM_LOOP_INTERVENTION_CLASSES = new Set<DoomLoopInterventionClass>([
  'credentials',
  'irreversible-external-action',
  'consequential-product-decision',
  'none',
  'unknown',
]);

/** Preserves an explicitly supplied classification; absent or invalid evidence
 * remains unknown rather than being inferred as none. */
export function normalizeDoomLoopInterventionClass(
  value: string | null | undefined,
): DoomLoopInterventionClass {
  return value && DOOM_LOOP_INTERVENTION_CLASSES.has(value as DoomLoopInterventionClass)
    ? value as DoomLoopInterventionClass
    : 'unknown';
}

export interface DoomLoopInterventionEvidence {
  detail?: string | null;
  doomWindow: string[];
}

/**
 * Classifies only failure context that explicitly establishes a north-star
 * intervention condition. Ambiguous failures remain unknown; `none` requires
 * an explicit statement that every intervention condition is inapplicable.
 */
export function classifyDoomLoopIntervention(
  evidence: DoomLoopInterventionEvidence,
): DoomLoopInterventionClass {
  const context = [evidence.detail, ...evidence.doomWindow]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase();
  const credentialsMentioned = /\b(?:credential|credentials|api[- ]?key|access token|oauth token|authentication)\b/.test(context);
  const credentialsBlocked = /\b(?:missing|invalid|expired|denied|unauthorized|forbidden|no) (?:credential|credentials|api[- ]?key|access token|oauth token|authentication)\b|\b(?:credential|credentials|api[- ]?key|access token|oauth token|authentication) (?:is )?(?:not configured|not available|not provided|required)\b/.test(context);
  if (credentialsMentioned && credentialsBlocked) return 'credentials';

  if (/\b(?:credential|credentials) (?:are |is )?not required\b/.test(context)
    && /\birreversible external action (?:is )?not required\b/.test(context)
    && /\bconsequential product decision (?:is )?not required\b/.test(context)) return 'none';

  const irreversible = /\b(?:irreversible|cannot be undone|non[- ]reversible)\b/.test(context);
  const externalAction = /\b(?:external (?:action|system|service|api)|(?:deploy|publish|send|delete|charge) (?:to|on|via) (?:production|remote|external))\b/.test(context);
  if (irreversible && externalAction) return 'irreversible-external-action';

  const productDecision = /\b(?:product decision|product choice|product direction|user[- ]facing decision)\b/.test(context);
  const cannotInferSafely = /\b(?:cannot|can't|unable to|not safe to) (?:be )?(?:safely )?(?:infer(?:red)?|decide|choose)\b/.test(context);
  const consequential = /\b(?:consequential|material|significant|high[- ]impact)\b/.test(context);
  if (productDecision && cannotInferSafely && consequential) return 'consequential-product-decision';

  return 'unknown';
}

function stringifyDoomFailureDetail(value: unknown): string {
  if (typeof value === 'string') return value;
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, entry) => {
      if (typeof entry === 'bigint') return `${entry}n`;
      if (entry && typeof entry === 'object') {
        if (seen.has(entry)) return '[Circular]';
        seen.add(entry);
      }
      return entry;
    });
  } catch {
    try {
      return String(value);
    } catch {
      return '[unserializable tool failure]';
    }
  }
}

export type DoomLoopRouteOutcome =
  | { kind: 'retry'; interventionClass: DoomLoopInterventionClass }
  | { kind: 'guidance'; userMessage: string; interventionClass: DoomLoopInterventionClass }
  | { kind: 'stop'; hardStopText: string; interventionClass: DoomLoopInterventionClass }
  | { kind: 'fallback'; hardStopText: string; interventionClass: DoomLoopInterventionClass };

export interface DoomLoopRouteOpts {
  reason: DoomLoopReason;
  /** Explicit evidence only. Omission means the intervention class is unknown. */
  interventionClass?: DoomLoopInterventionClass | null;
  detail?: string | null;
  doomWindow: string[];
  sessionId?: string;
  signal?: AbortSignal;
  /** Override the AskUser gate timeout (ms). Defaults to
   *  DOOM_ASK_TIMEOUT_MS. Primarily a test seam. */
  timeoutMs?: number;
}

export function buildDoomLoopAskRequest(opts: DoomLoopRouteOpts): Record<string, unknown> {
  const interventionClass = normalizeDoomLoopInterventionClass(opts.interventionClass);
  const why = opts.reason === 'plan-mode'
    ? 'plan mode is active so auto-undo was skipped'
    : opts.reason === 'undo-failed'
      ? `auto-undo was attempted but failed (${opts.detail ?? 'no detail'})`
      : `auto-undo was not authorized by the retry policy (${opts.detail ?? 'no detail'})`;
  const lastFingerprint = opts.doomWindow[opts.doomWindow.length - 1] ?? 'unknown';
  return {
    interventionClass,
    questions: [
      {
        id: 'doom_loop_next_step',
        header: 'Loop blocked',
        question:
          'The same tool call kept failing after 3 attempts — '
          + `${why}. How should I proceed?\n\nLast failure: ${lastFingerprint}`,
        options: [
          {
            label: 'Retry once more',
            description: 'Reset the retry tracker and let me try the same approach one more time.',
          },
          {
            label: 'Different approach',
            description: 'Type guidance in Other and I will follow it on the next turn.',
          },
          {
            label: 'Stop here',
            description: 'Halt this run. I will summarize what was tried and what was blocked.',
          },
        ],
        includeOther: true,
      },
    ],
  };
}

export function interpretDoomLoopAskResult(
  result: AskUserQuestionResult,
  interventionClass: DoomLoopInterventionClass = 'unknown',
): DoomLoopRouteOutcome {
  if (result.cancelled === true) {
    return {
      kind: 'stop',
      interventionClass,
      hardStopText:
        '[ASK USER] The same tool call kept failing and you cancelled the prompt — stopping this run.',
    };
  }
  const answer = result.answers?.['doom_loop_next_step'];
  const picked = Array.isArray(answer) ? (answer[0] ?? '') : (answer ?? '');
  const otherText = result.otherText?.['doom_loop_next_step']?.trim();

  if (picked.startsWith('Retry')) {
    return { kind: 'retry', interventionClass };
  }
  if (picked.startsWith('Different') || picked === 'Other') {
    const guidance = otherText && otherText.length > 0
      ? otherText
      : 'Please try a different approach to the same goal — the previous tool call kept failing.';
    return { kind: 'guidance', userMessage: guidance, interventionClass };
  }
  if (picked.startsWith('Stop')) {
    return {
      kind: 'stop',
      interventionClass,
      hardStopText: '[ASK USER] Stopped at your request after the repeated tool failure.',
    };
  }
  return {
    kind: 'stop',
    interventionClass,
    hardStopText:
      '[ASK USER] The same tool call kept failing and the response was unrecognized — stopping this run.',
  };
}

// Doom-loop AskUser gate timeout — the doom-loop HITL prompt awaits an
// operator answer with NO timeout of its own (TUI modal `await modal.promise`
// and the ACP bridge `Promise.race([pushAskRequest, cancellation])` both lack
// a timer). In an autonomous drive there is no operator to answer, so the
// dispatch region freezes indefinitely — between tool-loop turns, invisible to
// the stream idle-watchdog (armed only inside the stream loop) and to the
// goal-loop (which awaits the hung iteration). This was the 16-minute freeze in
// RESEARCH-autonomous-runaway-discipline-2026-07-19 (R2). Bound the wait: after
// this budget, fall back to the same auto-undo notice used when no session /
// no cap-able peer is present. Generous enough that a present operator answers
// first; short enough that an absent one doesn't stall the run for long.
const DOOM_ASK_TIMEOUT_MS = 5 * 60_000;

export async function routeDoomLoopToAskUser(opts: DoomLoopRouteOpts): Promise<DoomLoopRouteOutcome> {
  const interventionClass = normalizeDoomLoopInterventionClass(opts.interventionClass);
  if (!opts.sessionId) {
    return {
      kind: 'fallback',
      interventionClass,
      hardStopText: buildAutoUndoAskUserNotice(opts.reason, opts.detail),
    };
  }
  try {
    const dispatchCtx: { sessionId: string; signal?: AbortSignal } = { sessionId: opts.sessionId };
    if (opts.signal) dispatchCtx.signal = opts.signal;
    const timeoutMs = opts.timeoutMs ?? DOOM_ASK_TIMEOUT_MS;
    const TIMED_OUT = Symbol('doom-ask-timeout');
    let askTimer: ReturnType<typeof setTimeout> | undefined;
    const raced = await Promise.race([
      dispatchAskUserQuestion(buildDoomLoopAskRequest(opts), dispatchCtx),
      new Promise<typeof TIMED_OUT>((res) => {
        askTimer = setTimeout(() => res(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (askTimer) clearTimeout(askTimer);
    if (raced === TIMED_OUT) {
      debug.log('llm.tool-loop.retry', 'doom-loop-ask-timeout', {
        reason: opts.reason,
        interventionClass,
        timeoutMs,
      }, { level: 'warn' });
      return {
        kind: 'fallback',
        interventionClass,
        hardStopText: buildAutoUndoAskUserNotice(opts.reason, opts.detail),
      };
    }
    const r = raced;
    if (!r.result) {
      debug.log('llm.tool-loop.retry', 'doom-loop-ask-route-failed', {
        error: r.output,
        reason: opts.reason,
        interventionClass,
      }, { level: 'error' });
      return {
        kind: 'fallback',
        interventionClass,
        hardStopText: buildAutoUndoAskUserNotice(opts.reason, opts.detail),
      };
    }
    return interpretDoomLoopAskResult(r.result, interventionClass);
  } catch (err) {
    debug.log('llm.tool-loop.retry', 'doom-loop-ask-route-failed', {
      error: err instanceof Error ? err.message : String(err),
      reason: opts.reason,
      interventionClass,
    }, { level: 'error' });
    return {
      kind: 'fallback',
      interventionClass,
      hardStopText: buildAutoUndoAskUserNotice(opts.reason, opts.detail),
    };
  }
}

interface AutoNarrowedInspection {
  filePath: string;
  excerpt: string | null;
}

interface ExecutionSignalDetails {
  fileHints: string[];
  testHints: string[];
  stackHints: string[];
  interestingLine: string | null;
}

interface LoopSignalSnapshot {
  primarySourceFile: string | null;
  primaryTestFile: string | null;
  stackPreview: string[];
  interestingLine: string | null;
}

interface PrioritizedRepairTarget {
  path: string;
  reasons: string[];
  score: number;
}

interface VerificationHistoryEntry {
  command: string;
  summary: string;
  hints: string[];
  ok: boolean;
}

interface RepairLoopRecommendation {
  topEditTarget: string | null;
  rereadCandidates: string[];
  verifyCommandSuggestion: string;
  verifyHintLine: string | null;
  verifyHistoryLine: string | null;
  pendingVerifyLine: string | null;
  verifyLoopHealthLine: string | null;
  executionDoomLine: string | null;
  repeatedFailureTarget: string | null;
  repeatedFailureTargetLine: string | null;
  loopClosureSummary: string | null;
  resolutionHints: string[];
}

interface LoopHealthSnapshot {
  lastVerificationPassed: boolean;
  pendingVerifyLine: string | null;
  verifyLoopHealthLine: string | null;
  executionDoomLine: string | null;
  repeatedFailureTarget: string | null;
  repeatedFailureTargetLine: string | null;
  loopClosureSummary: string | null;
}

interface ExecutionLoopState {
  doomTracker: DoomLoopTracker;
  lastCommand: string | null;
  lastSummary: string | null;
  lastHints: string[];
  lastDetails: ExecutionSignalDetails;
  lastSignal: LoopSignalSnapshot;
}

interface VerificationLoopState {
  lastCommand: string | null;
  lastSummary: string | null;
  lastHints: string[];
  lastDetails: ExecutionSignalDetails;
  lastSignal: LoopSignalSnapshot;
  history: VerificationHistoryEntry[];
  /** True only when an Edit or Write tool definitely changed the tree after verification. */
  needsRefresh: boolean;
  /** A non-verification shell command ran after verification, so tree freshness is unknowable. */
  unknownSinceShellCommand: string | null;
}

interface FinalizationPolicySnapshot {
  verificationStillCurrent: boolean;
  forceFinalAnswer: boolean;
  recommendation: RepairLoopRecommendation;
  finalVerificationSummary: string | null;
}

function summarizeVerificationHistoryEntries(
  history: readonly VerificationHistoryEntry[] = [],
  limit = 2,
): string | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  // Preserve first-seen order so repeated verification flows do not obscure chronology.
  const unique = history.filter((entry, index, entries) => entries.findIndex((candidate) => (
    candidate.command === entry.command
    && candidate.summary === entry.summary
    && candidate.ok === entry.ok
  )) === index);
  const recent = unique.slice(-limit);
  return recent
    .map((entry) => `${entry.command} -> ${entry.ok ? 'PASS' : 'FAIL'}${entry.summary ? ` (${entry.summary})` : ''}`)
    .join(' | ');
}

function didLastVerificationPass(history: readonly VerificationHistoryEntry[] = []): boolean {
  return Array.isArray(history) && history.length > 0 && history[history.length - 1]?.ok === true;
}

function summarizeVerifyFingerprint(entry: VerificationHistoryEntry): string {
  const command = entry.command.replace(/\s+/g, ' ').trim().toLowerCase();
  const summary = entry.summary.replace(/\s+/g, ' ').trim().toLowerCase();
  return `${command} -> ${summary}`;
}

function buildVerifyLoopHealthLine(
  history: readonly VerificationHistoryEntry[] = [],
): string | null {
  if (!Array.isArray(history)) return null;
  const recentFailures = [...history]
    .reverse()
    .filter((entry) => !entry.ok)
    .slice(0, 2);
  if (recentFailures.length < 2) return null;
  const [latest, previous] = recentFailures;
  if (!latest || !previous) return null;
  const sameFingerprint = summarizeVerifyFingerprint(latest) === summarizeVerifyFingerprint(previous);
  if (!sameFingerprint) return null;
  return `- 검증 루프 상태: 같은 검증 실패가 반복됨 (${latest.command} -> ${latest.summary || 'unknown failure'}). 재실행보다 수정 우선이 맞습니다.`;
}

function detectRepeatedFailureTarget(
  verificationHistory: readonly VerificationHistoryEntry[] = [],
  executionSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
  verificationSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
): string | null {
  const counts = new Map<string, number>();
  const push = (value: string | null | undefined) => {
    const normalized = typeof value === 'string' ? normalizeRepairCandidate(value) : null;
    if (!normalized) return;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  };

  for (const signal of [executionSignal, verificationSignal]) {
    push(signal.primarySourceFile);
    push(signal.primaryTestFile);
  }
  for (const entry of verificationHistory.filter((item) => !item.ok).slice(-3)) {
    for (const hint of entry.hints.slice(0, 3)) push(hint);
  }

  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return !top || top[1] < 2 ? null : top[0];
}

function buildRepeatedFailureTargetLine(
  repeatedFailureTarget: string | null,
): string | null {
  if (!repeatedFailureTarget) return null;
  return `- 반복 실패 대상: ${repeatedFailureTarget} 중심으로 같은 실패 패턴이 이어집니다. 이 파일/테스트 기준으로 수정 또는 재검증이 맞습니다.`;
}

function buildLoopHealthSnapshot(
  verificationHistory: readonly VerificationHistoryEntry[] = [],
  executionDoomWindow: readonly string[] = [],
  verificationFreshness: 'current' | 'stale' | 'unknown' | boolean = 'current',
  executionSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
  verificationSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
): LoopHealthSnapshot {
  const normalizedFreshness = verificationFreshness === true
    ? 'current'
    : verificationFreshness === false
    ? 'stale'
    : verificationFreshness;
  const lastVerificationPassed = normalizedFreshness === 'current' && didLastVerificationPass(verificationHistory);
  const pendingVerifyLine = normalizedFreshness === 'stale'
    ? '- 검증 최신성 상태: 최근 수정 이후 재검증이 아직 필요합니다.'
    : normalizedFreshness === 'unknown'
    ? '- 검증 최신성 상태: 미지 — 검증 시도가 아닌 셸 명령이 이후 실행되어 트리 변경 여부를 알 수 없습니다. 재검증이 필요합니다.'
    : null;
  const verifyLoopHealthLine = buildVerifyLoopHealthLine(verificationHistory);
  const executionDoomLine = executionDoomWindow.length > 0
    ? `- 실행 루프 상태: 같은 실행 실패가 반복됨 (${executionDoomWindow.slice(0, 2).map((item) => describeExecutionFingerprint(item)).join(' | ')})`
    : null;
  const repeatedFailureTarget = detectRepeatedFailureTarget(
    verificationHistory,
    executionSignal,
    verificationSignal,
  );
  const repeatedFailureTargetLine = buildRepeatedFailureTargetLine(repeatedFailureTarget);
  const loopClosureSummary = lastVerificationPassed
    ? '마지막 검증이 성공했으므로 추가 탐색보다 최종 답변 정리가 맞습니다.'
    : executionDoomLine
    ? '같은 실행 실패가 반복 중이므로 재실행보다 수정 또는 repair 정리가 맞습니다.'
    : pendingVerifyLine
    ? '최근 수정 이후 재검증이 아직 필요하므로 close-out보다 검증 재실행이 맞습니다.'
    : repeatedFailureTargetLine
    ? '같은 파일/테스트를 중심으로 실패가 반복되므로 대상 파일을 우선 수정하고 필요한 검증만 다시 돌리는 것이 맞습니다.'
    : verifyLoopHealthLine
    ? '같은 검증 실패가 반복 중이므로 재검증보다 수정 우선이 맞습니다.'
    : null;
  return {
    lastVerificationPassed,
    pendingVerifyLine,
    verifyLoopHealthLine,
    executionDoomLine,
    repeatedFailureTarget,
    repeatedFailureTargetLine,
    loopClosureSummary,
  };
}

function createExecutionLoopState(): ExecutionLoopState {
  return {
    doomTracker: new DoomLoopTracker(3),
    lastCommand: null,
    lastSummary: null,
    lastHints: [],
    lastDetails: EMPTY_EXECUTION_SIGNAL_DETAILS,
    lastSignal: EMPTY_LOOP_SIGNAL_SNAPSHOT,
  };
}

function createVerificationLoopState(): VerificationLoopState {
  return {
    lastCommand: null,
    lastSummary: null,
    lastHints: [],
    lastDetails: EMPTY_EXECUTION_SIGNAL_DETAILS,
    lastSignal: EMPTY_LOOP_SIGNAL_SNAPSHOT,
    history: [],
    needsRefresh: false,
    unknownSinceShellCommand: null,
  };
}

function verificationFreshness(state: VerificationLoopState): 'current' | 'stale' | 'unknown' {
  if (state.needsRefresh) return 'stale';
  return state.unknownSinceShellCommand ? 'unknown' : 'current';
}

function isVerificationStillCurrent(state: VerificationLoopState): boolean {
  return verificationFreshness(state) === 'current';
}

/** PLAN §4.1 — flatten the four core loop states into the
 *  serialisable snapshot the turn-checkpoint module persists.
 *  Runtime class instances (`DoomLoopTracker`) are intentionally
 *  excluded — the snapshot is JSON-only. */
function snapshotLoopStateForCheckpoint(
  execution: ExecutionLoopState,
  verification: VerificationLoopState,
): TurnCheckpointLoopSnapshot {
  return {
    execution: {
      lastCommand: execution.lastCommand,
      lastSummary: execution.lastSummary,
      primarySourceFile: execution.lastSignal.primarySourceFile,
      interestingLine: execution.lastSignal.interestingLine,
    },
    verification: {
      lastCommand: verification.lastCommand,
      lastSummary: verification.lastSummary,
      historyLen: verification.history.length,
      needsRefresh: verification.needsRefresh,
      unknownSinceShellCommand: verification.unknownSinceShellCommand,
    },
    finalization: {
      verificationStillCurrent: isVerificationStillCurrent(verification),
      forceFinalAnswer: shouldForceFinalAnswerAfterVerify(verification),
    },
    signal: {
      primarySourceFile:
        execution.lastSignal.primarySourceFile ?? verification.lastSignal.primarySourceFile,
      primaryTestFile:
        verification.lastSignal.primaryTestFile ?? execution.lastSignal.primaryTestFile,
      interestingLine:
        execution.lastSignal.interestingLine ?? verification.lastSignal.interestingLine,
    },
  };
}

function shouldForceFinalAnswerAfterVerify(state: VerificationLoopState): boolean {
  return isVerificationStillCurrent(state) && didLastVerificationPass(state.history);
}

function buildResolutionHints(
  verificationHints: readonly string[],
  failureHints: readonly string[],
  prioritizedTargets: readonly PrioritizedRepairTarget[],
): string[] {
  return [
    ...verificationHints,
    ...failureHints,
    ...prioritizedTargets.map((target) => target.path),
  ]
    .map((path) => normalizeRepairCandidate(path))
    .filter((path): path is string => !!path)
    .filter((path, index, arr) => arr.indexOf(path) === index)
    .slice(0, 3);
}

function buildResolutionHintsFromSignals(
  signalSnapshots: readonly LoopSignalSnapshot[],
  fallbackHints: readonly string[] = [],
): string[] {
  return [
    ...signalSnapshots.flatMap((signal) => [
      signal.primarySourceFile,
      signal.primaryTestFile,
    ]),
    ...fallbackHints,
  ]
    .map((hint) => (typeof hint === 'string' ? normalizeRepairCandidate(hint) : null))
    .filter((hint): hint is string => !!hint)
    .filter((hint, index, arr) => arr.indexOf(hint) === index)
    .slice(0, 3);
}

function buildDisplayHintsFromSignal(
  signal: LoopSignalSnapshot,
  fallbackHints: readonly string[] = [],
  limit = 3,
): string[] {
  return [
    signal.primarySourceFile,
    signal.primaryTestFile,
    ...fallbackHints,
  ]
    .map((hint) => (typeof hint === 'string' ? normalizeRepairCandidate(hint) : null))
    .filter((hint): hint is string => !!hint)
    .filter((hint, index, arr) => arr.indexOf(hint) === index)
    .slice(0, limit);
}

function buildRepairLoopRecommendation(
  prioritizedTargets: readonly PrioritizedRepairTarget[],
  verificationCommand: string | null = null,
  verificationSummary: string | null = null,
  verificationHints: readonly string[] = [],
  verificationSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
  verificationHistory: readonly VerificationHistoryEntry[] = [],
  failureHints: readonly string[] = [],
  failureSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
  executionDoomWindow: readonly string[] = [],
  verificationFreshness: 'current' | 'stale' | 'unknown' | boolean = 'current',
): RepairLoopRecommendation {
  const topEditTarget = prioritizedTargets[0]?.path ?? null;
  const loopHealth = buildLoopHealthSnapshot(
    verificationHistory,
    executionDoomWindow,
    verificationFreshness,
    failureSignal,
    verificationSignal,
  );
  const rereadCandidates = [
    loopHealth.repeatedFailureTarget,
    topEditTarget,
    ...prioritizedTargets.map((target) => target.path),
    ...verificationHints.filter((hint) => normalizeRepairCandidate(hint) !== null),
  ]
    .filter((path): path is string => typeof path === 'string')
    .map((path) => normalizeRepairCandidate(path))
    .filter((path): path is string => !!path)
    .filter((path, index, arr) => arr.indexOf(path) === index)
    .slice(0, 2);
  const verifyCommandSuggestion = buildTargetedVerificationCommandSuggestion(
    verificationCommand,
    verificationHints,
    verificationHistory,
    loopHealth.repeatedFailureTarget,
  );
  const verifyDisplayHints = buildDisplayHintsFromSignal(
    verificationSignal,
    verificationHints,
    2,
  );
  const verifyHintLine = verifyDisplayHints.length > 0
    ? `- 검증 기준 파일/테스트: ${verifyDisplayHints.join(', ')}`
    : null;
  const verifyHistorySummary = summarizeVerificationHistoryEntries(verificationHistory);
  const verifyHistoryLine = verifyHistorySummary
    ? `- 최근 검증 흐름: ${verifyHistorySummary}`
    : null;
  const resolutionHints = buildResolutionHints(
    verifyDisplayHints,
    buildDisplayHintsFromSignal(failureSignal, failureHints, 3),
    prioritizedTargets,
  );
  return {
    topEditTarget,
    rereadCandidates,
    verifyCommandSuggestion: `${verifyCommandSuggestion}${verificationSummary ? `  // 최근 결과: ${verificationSummary}` : ''}`,
    verifyHintLine,
    verifyHistoryLine,
    pendingVerifyLine: loopHealth.pendingVerifyLine,
    verifyLoopHealthLine: loopHealth.verifyLoopHealthLine,
    executionDoomLine: loopHealth.executionDoomLine,
    repeatedFailureTarget: loopHealth.repeatedFailureTarget,
    repeatedFailureTargetLine: loopHealth.repeatedFailureTargetLine,
    loopClosureSummary: loopHealth.loopClosureSummary,
    resolutionHints,
  };
}

function buildFinalRecommendationFromLoopState(
  inspections: readonly AutoNarrowedInspection[],
  executionState: ExecutionLoopState,
  verificationState: VerificationLoopState,
): RepairLoopRecommendation {
  const executionResolutionHints = buildResolutionHintsFromSignals(
    [executionState.lastSignal],
    executionState.lastHints,
  );
  const verificationResolutionHints = buildResolutionHintsFromSignals(
    [verificationState.lastSignal],
    verificationState.lastHints,
  );
  return buildRepairLoopRecommendation(
    buildPrioritizedRepairTargets(
      inspections,
      executionResolutionHints,
      executionState.lastDetails,
      executionState.lastSignal,
      verificationState.lastSignal,
    ),
    verificationState.lastCommand,
    verificationState.lastSummary,
    verificationResolutionHints,
    verificationState.lastSignal,
    verificationState.history,
    executionResolutionHints,
    executionState.lastSignal,
    [],
    verificationFreshness(verificationState),
  );
}

function buildFinalizationPolicySnapshot(
  inspections: readonly AutoNarrowedInspection[],
  editedFiles: readonly string[],
  executionState: ExecutionLoopState,
  verificationState: VerificationLoopState,
): FinalizationPolicySnapshot {
  const verificationStillCurrent = isVerificationStillCurrent(verificationState);
  const recommendation = buildFinalRecommendationFromLoopState(
    inspections,
    executionState,
    verificationState,
  );
  return {
    verificationStillCurrent,
    forceFinalAnswer: verificationStillCurrent && didLastVerificationPass(verificationState.history),
    finalVerificationSummary: buildFinalVerificationSummary(
      editedFiles,
      verificationState.lastCommand,
      verificationState.lastSummary,
      verificationState.lastHints,
      verificationState.lastSignal,
      recommendation.resolutionHints,
      verificationState.history,
      verificationFreshness(verificationState),
    ),
    recommendation,
  };
}

function buildTargetedVerificationCommandSuggestion(
  verificationCommand: string | null,
  verificationHints: readonly string[] = [],
  verificationHistory: readonly VerificationHistoryEntry[] = [],
  preferredTarget: string | null = null,
): string {
  const normalizedPreferredTarget = preferredTarget ? normalizeRepairCandidate(preferredTarget) : null;
  const hintedTests = [
    ...(normalizedPreferredTarget && looksLikeTestPath(normalizedPreferredTarget) ? [normalizedPreferredTarget] : []),
    ...verificationHints,
    ...verificationHistory.flatMap((entry) => entry.hints),
  ].filter((hint) => looksLikeTestPath(hint));
  const testTarget = hintedTests
    .map((hint) => normalizeRepairCandidate(hint))
    .find((hint): hint is string => !!hint);
  const normalizedVerificationCommand = verificationCommand?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
  const shouldSpecializeGenericCommand = !!testTarget && (
    normalizedVerificationCommand === 'bun test'
    || normalizedVerificationCommand === 'npm test'
    || normalizedVerificationCommand === 'pnpm test'
    || normalizedVerificationCommand === 'yarn test'
  );
  if (shouldSpecializeGenericCommand) {
    return `RunShell(["bun","test",${JSON.stringify(testTarget)}]) 또는 Bash("bun test ${testTarget}")`;
  }
  if (verificationCommand) return verificationCommand;

  if (testTarget) {
    return `RunShell(["bun","test",${JSON.stringify(testTarget)}]) 또는 Bash("bun test ${testTarget}")`;
  }

  const recentVerifyCommand = [...verificationHistory]
    .reverse()
    .map((entry) => entry.command.trim())
    .find((command) => command.length > 0);
  if (recentVerifyCommand) {
    return `${recentVerifyCommand}  // 최근 검증 명령 재사용`;
  }

  return 'RunShell(["bun","test"]) 또는 Bash("bun test")';
}

function buildRepairActionLines(
  prioritizedTargets: readonly PrioritizedRepairTarget[],
  verificationCommand: string | null = null,
  verificationSummary: string | null = null,
  verificationHints: readonly string[] = [],
  verificationSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
  verificationHistory: readonly VerificationHistoryEntry[] = [],
  failureHints: readonly string[] = [],
  failureSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
  executionDoomWindow: readonly string[] = [],
  verificationFreshness: 'current' | 'stale' | 'unknown' | boolean = 'current',
  preferVerifyFirst = false,
): string[] {
  const recommendation = buildRepairLoopRecommendation(
    prioritizedTargets,
    verificationCommand,
    verificationSummary,
    verificationHints,
    verificationSignal,
    verificationHistory,
    failureHints,
    failureSignal,
    executionDoomWindow,
    verificationFreshness,
  );
  const verifyFirstRereadCandidates = [
    recommendation.topEditTarget,
    ...buildDisplayHintsFromSignal(verificationSignal, verificationHints, 2),
  ]
    .map((path) => (typeof path === 'string' ? normalizeRepairCandidate(path) : null))
    .filter((path): path is string => !!path)
    .filter((path, index, arr) => arr.indexOf(path) === index)
    .slice(0, 2);
  const followupReadCandidates = preferVerifyFirst && verifyFirstRereadCandidates.length > 0
    ? verifyFirstRereadCandidates
    : recommendation.rereadCandidates;
  const followupReadLine = followupReadCandidates.length > 0
    ? `- 재수정 전 추가 확인: ${followupReadCandidates.map((path) => `Read(file_path=${JSON.stringify(path)})`).join(', ')}`
    : null;
  const verifyActionLabel = recommendation.executionDoomLine || recommendation.verifyLoopHealthLine
    ? '수정 후 재검증'
    : '다음 검증';
  const firstActionLine = preferVerifyFirst
    ? `- 먼저 시도할 재검증: ${recommendation.verifyCommandSuggestion}`
    : recommendation.topEditTarget
    ? `- 먼저 시도할 수정: Edit(file_path=${JSON.stringify(recommendation.topEditTarget)}, ...) 또는 Write(file_path=${JSON.stringify(recommendation.topEditTarget)}, ...)`
    : '- 먼저 시도할 수정: Edit/Write 로 실패 원인 후보를 수정';
  return [
    firstActionLine,
    ...(followupReadLine ? [followupReadLine] : []),
    ...(preferVerifyFirst ? [] : [`- ${verifyActionLabel}: ${recommendation.verifyCommandSuggestion}`]),
    ...(recommendation.verifyHintLine ? [recommendation.verifyHintLine] : []),
    ...(recommendation.verifyHistoryLine ? [recommendation.verifyHistoryLine] : []),
    ...(recommendation.pendingVerifyLine ? [recommendation.pendingVerifyLine] : []),
    ...(recommendation.verifyLoopHealthLine ? [recommendation.verifyLoopHealthLine] : []),
    ...(recommendation.executionDoomLine ? [recommendation.executionDoomLine] : []),
    ...(recommendation.repeatedFailureTargetLine ? [recommendation.repeatedFailureTargetLine] : []),
    ...(recommendation.loopClosureSummary ? [`- 루프 권장 상태: ${recommendation.loopClosureSummary}`] : []),
    '- 필요하면 Read/Lsp/AstGrep 또는 Grep(output_mode="content"|"count") 로 실패 지점만 좁게 확인',
  ];
}

function renderPrioritizedTargetSection(
  prioritizedTargets: readonly PrioritizedRepairTarget[],
): string {
  return prioritizedTargets.length > 0
    ? `우선 수정 후보:\n${prioritizedTargets
        .slice(0, 3)
        .map((target) => `- ${target.path} — ${target.reasons.slice(0, 2).join(', ')}`)
        .join('\n')}`
    : '';
}

function renderNextActionsSection(
  lines: readonly string[],
  trailingLine: string | null = null,
): string {
  return `다음 권장 단계:\n${[
    ...lines,
    ...(trailingLine ? [trailingLine] : []),
  ].join('\n')}`;
}

function buildResolutionConfidenceLine(
  editedFiles: readonly string[],
  resolutionHints: readonly string[] = [],
  verificationHints: readonly string[] = [],
): string | null {
  const normalizedEditedFiles = editedFiles
    .map((hint) => normalizeRepairCandidate(hint))
    .filter((hint): hint is string => !!hint);
  const normalizedResolutionHints = [
    ...resolutionHints,
    ...verificationHints,
  ]
    .map((hint) => normalizeRepairCandidate(hint))
    .filter((hint): hint is string => !!hint);
  if (normalizedEditedFiles.length === 0 || normalizedResolutionHints.length === 0) return null;

  const sourceOverlap = normalizedEditedFiles.find((file) => normalizedResolutionHints.includes(file) && !looksLikeTestPath(file));
  if (sourceOverlap) {
    return `해결 근거 연결: 수정 파일 ${sourceOverlap} 이(가) 실패/검증 힌트와 직접 겹칩니다.`;
  }

  const testOverlap = normalizedEditedFiles.find((file) => normalizedResolutionHints.includes(file));
  if (testOverlap) {
    return `해결 근거 연결: 수정 파일 ${testOverlap} 이(가) 검증 기준과 직접 겹칩니다.`;
  }

  return `해결 근거 연결: 수정 파일과 검증 기준 파일/테스트를 함께 좁혀 close-out 했습니다.`;
}

function buildFinalVerificationSummary(
  editedFiles: readonly string[],
  verificationCommand: string | null,
  verificationSummary: string | null,
  verificationHints: readonly string[] = [],
  verificationSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
  resolutionHints: readonly string[] = [],
  verificationHistory: readonly VerificationHistoryEntry[] = [],
  verificationFreshness: 'current' | 'stale' | 'unknown' | boolean = 'current',
): string | null {
  if (
    editedFiles.length === 0
    && !verificationCommand
    && !verificationSummary
    && verificationHints.length === 0
    && verificationHistory.length === 0
  ) {
    return null;
  }
  const lines: string[] = [];
  // Preserve first-seen order so repeated edits do not obscure chronology.
  const uniqueEditedFiles = editedFiles.filter((file, index, files) => files.indexOf(file) === index);
  const normalizedFreshness = verificationFreshness === true
    ? 'current'
    : verificationFreshness === false
    ? 'stale'
    : verificationFreshness;
  const loopHealth = buildLoopHealthSnapshot(
    verificationHistory,
    [],
    normalizedFreshness,
    EMPTY_LOOP_SIGNAL_SNAPSHOT,
    verificationSignal,
  );
  if (uniqueEditedFiles.length > 0) {
    lines.push(`변경 파일: ${uniqueEditedFiles.slice(0, 3).join(', ')}`);
  }
  if (verificationCommand) {
    lines.push(`${normalizedFreshness === 'current' ? '검증 명령' : '최근 검증 명령'}: ${verificationCommand}`);
  }
  if (verificationSummary) {
    lines.push(`${normalizedFreshness === 'current' ? '검증 결과' : '최근 검증 결과'}: ${verificationSummary}`);
  }
  const verificationDisplayHints = buildDisplayHintsFromSignal(
    verificationSignal,
    verificationHints,
    3,
  );
  if (verificationDisplayHints.length > 0) {
    lines.push(`검증 기준 파일/테스트: ${verificationDisplayHints.join(', ')}`);
  }
  if (verificationSignal.stackPreview.length > 0) {
    lines.push(`검증 스택/신호: ${verificationSignal.stackPreview.join(' | ')}`);
  }
  const primaryCloseOutHints = [
    ...uniqueEditedFiles,
    ...verificationDisplayHints,
  ]
    .map((hint) => normalizeRepairCandidate(hint))
    .filter((hint): hint is string => !!hint)
    .filter((hint, index, arr) => arr.indexOf(hint) === index);
  const closeOutResolutionHints = [
    ...primaryCloseOutHints,
    ...(primaryCloseOutHints.length > 0 ? [] : resolutionHints),
  ]
    .map((hint) => normalizeRepairCandidate(hint))
    .filter((hint): hint is string => !!hint)
    .filter((hint, index, arr) => arr.indexOf(hint) === index)
    .slice(0, 3);
  if (closeOutResolutionHints.length > 0) {
    lines.push(`해결 기준 파일/테스트: ${closeOutResolutionHints.join(', ')}`);
  }
  const resolutionConfidenceLine = buildResolutionConfidenceLine(
    uniqueEditedFiles,
    resolutionHints,
    verificationDisplayHints,
  );
  if (resolutionConfidenceLine) {
    lines.push(resolutionConfidenceLine);
  }
  const verificationHistoryLine = summarizeVerificationHistoryEntries(verificationHistory, 3);
  if (verificationHistoryLine) {
    lines.push(`최근 검증 흐름: ${verificationHistoryLine}`);
  }
  if (loopHealth.pendingVerifyLine) {
    lines.push(loopHealth.pendingVerifyLine.replace(/^- /, ''));
  }
  if (loopHealth.repeatedFailureTargetLine) {
    lines.push(loopHealth.repeatedFailureTargetLine.replace(/^- /, ''));
  }
  if (loopHealth.loopClosureSummary) {
    lines.push(`루프 마감 상태: ${loopHealth.loopClosureSummary}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

function maybeEnrichFinalAnswerWithVerifyContext(
  finalText: string,
  editedFiles: readonly string[],
  verificationCommand: string | null,
  verificationSummary: string | null,
  verificationHints: readonly string[] = [],
  verificationSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
  resolutionHints: readonly string[] = [],
  verificationHistory: readonly VerificationHistoryEntry[] = [],
  verificationStillCurrent = true,
): string {
  const trimmed = finalText.trim();
  const supplement = buildFinalVerificationSummary(
    editedFiles,
    verificationCommand,
    verificationSummary,
    verificationHints,
    verificationSignal,
    resolutionHints,
    verificationHistory,
    verificationStillCurrent,
  );
  if (!supplement) return finalText;
  const mentionsEditedFile = editedFiles.some((file) => trimmed.includes(file));
  const mentionsVerifyCommand = verificationCommand ? trimmed.includes(verificationCommand) : false;
  const mentionsVerifySummary = verificationSummary ? trimmed.includes(verificationSummary) : false;
  const displayHints = buildDisplayHintsFromSignal(verificationSignal, verificationHints, 3);
  const mentionsVerifyHint = displayHints.some((hint) => trimmed.includes(hint));
  const mentionsResolutionHint = resolutionHints.some((hint) => trimmed.includes(hint));
  const verifyHistorySummary = summarizeVerificationHistoryEntries(verificationHistory);
  const mentionsVerifyHistory = verifyHistorySummary ? trimmed.includes(verifyHistorySummary) : false;
  const needsHelp =
    trimmed.length < 260
    || (!mentionsEditedFile && editedFiles.length > 0)
    || (!mentionsVerifyCommand && !!verificationCommand)
    || (!mentionsVerifySummary && !!verificationSummary)
    || (!mentionsVerifyHint && displayHints.length > 0)
    || (!mentionsResolutionHint && resolutionHints.length > 0)
    || (!mentionsVerifyHistory && verificationHistory.length > 1);
  if (!needsHelp) return finalText;
  return `${finalText.trim()}\n\n${supplement}`;
}

function maybeEnrichFinalAnswerWithFinalizationSnapshot(
  finalText: string,
  editedFiles: readonly string[],
  verificationState: VerificationLoopState,
  snapshot: FinalizationPolicySnapshot,
): string {
  const trimmed = finalText.trim();
  const supplement = snapshot.finalVerificationSummary;
  if (!supplement) return finalText;
  const mentionsEditedFile = editedFiles.some((file) => trimmed.includes(file));
  const mentionsVerifyCommand = verificationState.lastCommand ? trimmed.includes(verificationState.lastCommand) : false;
  const mentionsVerifySummary = verificationState.lastSummary ? trimmed.includes(verificationState.lastSummary) : false;
  const verificationDisplayHints = buildDisplayHintsFromSignal(
    verificationState.lastSignal,
    verificationState.lastHints,
    3,
  );
  const mentionsVerifyHint = verificationDisplayHints.some((hint) => trimmed.includes(hint));
  const mentionsResolutionHint = snapshot.recommendation.resolutionHints.some((hint) => trimmed.includes(hint));
  const verifyHistorySummary = summarizeVerificationHistoryEntries(verificationState.history);
  const mentionsVerifyHistory = verifyHistorySummary ? trimmed.includes(verifyHistorySummary) : false;
  const needsHelp =
    trimmed.length < 260
    || (!mentionsEditedFile && editedFiles.length > 0)
    || (!mentionsVerifyCommand && !!verificationState.lastCommand)
    || (!mentionsVerifySummary && !!verificationState.lastSummary)
    || (!mentionsVerifyHint && verificationDisplayHints.length > 0)
    || (!mentionsResolutionHint && snapshot.recommendation.resolutionHints.length > 0)
    || (!mentionsVerifyHistory && verificationState.history.length > 1);
  if (!needsHelp) return finalText;
  return `${finalText.trim()}\n\n${supplement}`;
}

const EMPTY_EXECUTION_SIGNAL_DETAILS: ExecutionSignalDetails = {
  fileHints: [],
  testHints: [],
  stackHints: [],
  interestingLine: null,
};

const EMPTY_LOOP_SIGNAL_SNAPSHOT: LoopSignalSnapshot = {
  primarySourceFile: null,
  primaryTestFile: null,
  stackPreview: [],
  interestingLine: null,
};

function buildLoopSignalSnapshot(
  details: ExecutionSignalDetails,
  hints: readonly string[] = [],
): LoopSignalSnapshot {
  const normalizedHints = hints
    .map((hint) => normalizeRepairCandidate(hint))
    .filter((hint): hint is string => !!hint);
  const primarySourceFile = [
    ...details.fileHints,
    ...normalizedHints,
  ]
    .map((hint) => normalizeRepairCandidate(hint))
    .find((hint): hint is string => !!hint && !looksLikeTestPath(hint))
    ?? null;
  const primaryTestFile = [
    ...details.testHints,
    ...details.fileHints.filter((hint) => looksLikeTestPath(hint)),
    ...normalizedHints.filter((hint) => looksLikeTestPath(hint)),
  ]
    .map((hint) => normalizeRepairCandidate(hint))
    .find((hint): hint is string => !!hint && looksLikeTestPath(hint))
    ?? null;
  return {
    primarySourceFile,
    primaryTestFile,
    stackPreview: details.stackHints.slice(0, 2),
    interestingLine: details.interestingLine,
  };
}

function inferInspectionRole(item: AutoNarrowedInspection): string {
  const lowerPath = item.filePath.toLowerCase();
  const lowerExcerpt = (item.excerpt ?? '').toLowerCase();

  if (lowerPath.includes('debug-window') || lowerPath.includes('window-consumer')) {
    return '디버그 워크벤치/패널 구성과 소비 지점을 정의하는 축';
  }
  if (lowerPath.includes('debug-surface') || lowerPath.includes('/display/')) {
    return '디버그 이벤트와 상태를 화면에 렌더링하는 축';
  }
  if (lowerPath.includes('call-stack')) {
    return '디버그 호출 프레임과 스택 구조를 표현하는 축';
  }
  if (
    lowerPath.endsWith('/log.ts')
    || lowerPath.includes('logger')
    || lowerPath.includes('/debug/log')
    || lowerExcerpt.includes('debugevent')
    || lowerExcerpt.includes('formatline')
  ) {
    return '로그 이벤트/트레이스를 기록하거나 포맷하는 축';
  }
  if (lowerPath.includes('tool-call-state') || lowerExcerpt.includes('tool-call lifecycle')) {
    return '툴 호출 상태와 라이프사이클을 추적하는 축';
  }
  if (lowerPath.includes('background-manager') || lowerExcerpt.includes('session lifecycle')) {
    return '세션/백그라운드 작업의 생명주기를 관리하는 축';
  }
  if (lowerPath.includes('read-state') || lowerExcerpt.includes('read-before-edit')) {
    return '편집 전 읽기 보장을 위한 상태 추적 축';
  }
  if (lowerPath.includes('/state')) {
    return '상태 전이 또는 세션 상태를 관리하는 축';
  }
  if (lowerPath.includes('/display/')) {
    return '표시/렌더링 계층';
  }
  if (lowerPath.includes('/window/')) {
    return '윈도우/패널 계층';
  }
  return '현재 요청과 관련된 구조 후보 파일';
}

function inferInspectionDetail(item: AutoNarrowedInspection): string | null {
  const lowerPath = item.filePath.toLowerCase();
  const lowerExcerpt = (item.excerpt ?? '').toLowerCase();

  if (lowerPath.includes('debug-window') || lowerPath.includes('window-consumer')) {
    return '디버그 워크벤치가 어떤 패널 키와 컬럼 구성을 노출하는지 정의합니다.';
  }
  if (lowerPath.includes('debug-surface') || lowerPath.includes('/display/')) {
    return 'DebugEvent, CallFrame, 실행 이력을 화면용 텍스트/토큰으로 조합하는 렌더링 계층입니다.';
  }
  if (lowerPath.includes('call-stack')) {
    return '디버그 이벤트를 호출 프레임과 스택 트리 구조로 모델링하는 계층입니다.';
  }
  if (
    lowerPath.endsWith('/log.ts')
    || lowerPath.includes('logger')
    || lowerPath.includes('/debug/log')
    || lowerExcerpt.includes('debugevent')
    || lowerExcerpt.includes('formatline')
  ) {
    return 'DebugEvent 정의와 로그/트레이스 기록 또는 포맷의 출발점 역할을 합니다.';
  }
  if (lowerPath.includes('tool-call-state') || lowerExcerpt.includes('tool-call lifecycle')) {
    return '툴 호출 상태 전이를 세션 단위로 추적하는 상태머신 계층입니다.';
  }
  if (lowerPath.includes('background-manager') || lowerExcerpt.includes('session lifecycle')) {
    return '세션과 백그라운드 작업의 생명주기를 관리하는 운영 계층입니다.';
  }
  if (lowerPath.includes('read-state') || lowerExcerpt.includes('read-before-edit')) {
    return '편집 전 읽기 보장을 위한 도구 상태 추적 계층입니다.';
  }
  return null;
}

function buildInspectFallbackSummary(inspections: readonly AutoNarrowedInspection[]): string {
  const items = inspections.slice(0, 3);
  const inspected = items.map((item) => {
    const role = inferInspectionRole(item);
    const detail = inferInspectionDetail(item);
    const excerpt = item.excerpt ? `\n  근거: ${item.excerpt}` : '';
    const detailLine = detail ? `\n  설명: ${detail}` : '';
    return `- ${item.filePath}\n  역할: ${role}${detailLine}${excerpt}`;
  }).join('\n');
  const roleSummary = items.length > 0
    ? `현재까지는 ${items.map(inferInspectionRole).join(' / ')} 순으로, 워크벤치 구성 → 이벤트/상태 렌더링 → 호출 스택 모델링 레이어가 핵심 축으로 보입니다.`
    : '';
  return [
    `구조 분석은 후보 파일 ${items.length}개까지 좁혀 확인했습니다.`,
    items.length > 0 ? `확인한 파일:\n${inspected}` : '',
    roleSummary,
    '현재 단계에선 추가 탐색보다 위 파일들을 중심으로 구조를 정리하는 것이 맞습니다.',
    '필요하면 다음 턴에서 이 파일들 기준으로 더 좁은 요청을 이어가면 됩니다.',
  ].filter(Boolean).join('\n\n');
}

function buildInspectActionFallback(inspections: readonly AutoNarrowedInspection[]): string {
  const items = inspections.slice(0, 3);
  const inspected = items.map((item) => {
    const role = inferInspectionRole(item);
    const detail = inferInspectionDetail(item);
    const excerpt = item.excerpt ? `\n  근거: ${item.excerpt}` : '';
    const detailLine = detail ? `\n  설명: ${detail}` : '';
    return `- ${item.filePath}\n  역할: ${role}${detailLine}${excerpt}`;
  }).join('\n');
  const nextTarget = items[0]?.filePath ?? null;
  const nextActions = nextTarget
    ? [
      `- Edit/Write 대상 우선순위: ${nextTarget}`,
      `- 검증 후보: RunShell(["bun","test"]) 또는 Bash("bun test")`,
      '- 필요하면 Lsp/AstGrep/Grep(output_mode="content"|"count") 로 좁은 구조 확인 후 수정',
    ].join('\n')
    : '- Edit/Write 대상 파일을 먼저 고르고, RunShell/Bash 로 검증하세요.';
  return [
    `구현/수정 단계는 후보 파일 ${items.length}개까지 좁혀 확인했습니다.`,
    items.length > 0 ? `확인한 파일:\n${inspected}` : '',
    '현재 단계에선 추가 files_with_matches 탐색보다, 위 파일들을 기준으로 수정과 검증 단계로 넘어가는 것이 맞습니다.',
    renderNextActionsSection(nextActions.split('\n')),
  ].filter(Boolean).join('\n\n');
}

function buildFinalAnswerRequiredFallback(
  editedFiles: readonly string[],
  verificationCommand: string | null,
  verificationSummary: string | null,
  verificationHints: readonly string[] = [],
  verificationSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
  verificationHistory: readonly VerificationHistoryEntry[] = [],
  resolutionHints: readonly string[] = [],
  verificationStillCurrent = true,
): string {
  const loopHealth = buildLoopHealthSnapshot(verificationHistory, [], verificationStillCurrent);
  const finalSummary = buildFinalVerificationSummary(
    editedFiles,
    verificationCommand,
    verificationSummary,
    verificationHints,
    verificationSignal,
    resolutionHints,
    verificationHistory,
    verificationStillCurrent,
  );
  return [
    '[FINAL ANSWER REQUIRED] 검증이 이미 성공했으므로 추가 broad search 대신 변경 요약과 검증 결과를 plain text로 정리하는 것이 맞습니다.',
    loopHealth.loopClosureSummary ? `루프 마감 상태:\n- ${loopHealth.loopClosureSummary}` : '',
    finalSummary ?? '',
    '다음 단계: 더 이상 files_with_matches 탐색을 늘리지 말고, 수정 내용과 검증 결과를 최종 답변으로 정리하세요.',
  ].filter(Boolean).join('\n\n');
}

function buildFinalAnswerRequiredFallbackFromSnapshot(
  editedFiles: readonly string[],
  verificationState: VerificationLoopState,
  snapshot: FinalizationPolicySnapshot,
): string {
  return [
    '[FINAL ANSWER REQUIRED] 검증이 이미 성공했으므로 추가 broad search 대신 변경 요약과 검증 결과를 plain text로 정리하는 것이 맞습니다.',
    snapshot.recommendation.loopClosureSummary ? `루프 마감 상태:\n- ${snapshot.recommendation.loopClosureSummary}` : '',
    snapshot.finalVerificationSummary ?? '',
    '다음 단계: 더 이상 files_with_matches 탐색을 늘리지 말고, 수정 내용과 검증 결과를 최종 답변으로 정리하세요.',
  ].filter(Boolean).join('\n\n');
}

function buildVerifyFallback(editedFiles: readonly string[], inspections: readonly AutoNarrowedInspection[]): string {
  return buildVerifyFallbackWithSummary(editedFiles, inspections, null, null);
}

function buildVerifyFallbackFromLoopState(
  editedFiles: readonly string[],
  inspections: readonly AutoNarrowedInspection[],
  executionState: ExecutionLoopState,
  verificationState: VerificationLoopState,
): string {
  return buildVerifyFallbackWithSummary(
    editedFiles,
    inspections,
    verificationState.lastCommand,
    verificationState.lastSummary,
    executionState.lastCommand,
    executionState.lastSummary,
    executionState.lastHints,
    verificationState.lastHints,
    executionState.lastDetails,
    verificationState.lastDetails,
    verificationState.history,
    verificationFreshness(verificationState),
    executionState.lastSignal,
    verificationState.lastSignal,
  );
}

function buildVerifyFallbackWithSummary(
  editedFiles: readonly string[],
  inspections: readonly AutoNarrowedInspection[],
  verificationCommand: string | null,
  verificationSummary: string | null,
  failureCommand: string | null = null,
  failureSummary: string | null = null,
  failureHints: readonly string[] = [],
  verificationHints: readonly string[] = [],
  failureDetails: ExecutionSignalDetails = EMPTY_EXECUTION_SIGNAL_DETAILS,
  verificationDetails: ExecutionSignalDetails = EMPTY_EXECUTION_SIGNAL_DETAILS,
  verificationHistory: readonly VerificationHistoryEntry[] = [],
  verificationFreshness: 'current' | 'stale' | 'unknown' | boolean = 'current',
  failureSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
  verificationSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
): string {
  const loopHealth = buildLoopHealthSnapshot(verificationHistory, [], verificationFreshness);
  const files = [...new Set(editedFiles)].slice(0, 3);
  const inspected = inspections.slice(0, 2).map((item) => item.filePath);
  const fileSection = files.length > 0
    ? `수정한 파일:\n${files.map((file) => `- ${file}`).join('\n')}`
    : '';
  const inspectedSection = inspected.length > 0
    ? `검토 근거 파일:\n${inspected.map((file) => `- ${file}`).join('\n')}`
    : '';
  const prioritizedTargets = buildPrioritizedRepairTargets(
    inspections,
    failureHints,
    failureDetails,
    failureSignal,
    verificationSignal,
  );
  const verificationSection = verificationCommand || verificationSummary
    ? [
      '최근 검증 결과:',
      ...(verificationCommand ? [`- 명령: ${verificationCommand}`] : []),
      ...(verificationSummary ? [`- 요약: ${verificationSummary}`] : []),
    ].join('\n')
    : '';
  const failureContextSection = failureCommand || failureSummary || failureHints.length > 0
    ? [
      '이번 검증이 이어진 실패 맥락:',
      ...(failureCommand ? [`- 실패 명령: ${failureCommand}`] : []),
      ...(failureSummary ? [`- 실패 요약: ${failureSummary}`] : []),
      ...(failureHints.length > 0
        ? ['- 실패에서 드러난 파일/테스트:', ...failureHints.slice(0, 3).map((hint) => `  - ${hint}`)]
        : []),
      ...(failureDetails.stackHints.length > 0
        ? ['- 실패 스택/신호:', ...failureDetails.stackHints.slice(0, 2).map((hint) => `  - ${hint}`)]
        : []),
    ].join('\n')
    : '';
  const derivedVerificationHints = verificationHints.length > 0
    ? buildDisplayHintsFromSignal(verificationSignal, verificationHints, 3)
    : verificationSummary
    ? [...verificationSummary.matchAll(/(?:^|[\s:(["'])([A-Za-z0-9_./-]+\.(?:test\.)?(?:ts|tsx|js|jsx|mjs|cjs))(?:$|[\s:)\]"'])/g)]
      .map((match) => match[1]?.trim())
      .filter((hint): hint is string => !!hint)
      .slice(0, 3)
    : [];
  const verificationHintSection = derivedVerificationHints.length > 0
    ? `최근 검증에서 언급된 파일/테스트:\n${derivedVerificationHints.map((hint) => `- ${hint}`).join('\n')}`
    : '';
  const verificationStackPreview = verificationSignal.stackPreview.length > 0
    ? verificationSignal.stackPreview
    : verificationDetails.stackHints.slice(0, 2);
  const verificationStackSection = verificationStackPreview.length > 0
    ? `최근 검증 스택/신호:\n${verificationStackPreview.map((hint) => `- ${hint}`).join('\n')}`
    : '';
  const verificationHistorySection = verificationHistory.length > 1
    ? `최근 검증 흐름:\n${verificationHistory
        .slice(-3)
        .map((entry) => `- ${entry.command} -> ${entry.ok ? 'PASS' : 'FAIL'}${entry.summary ? ` (${entry.summary})` : ''}`)
        .join('\n')}`
    : '';
  const nextActions = buildRepairActionLines(
    prioritizedTargets,
    verificationCommand,
    verificationSummary,
    derivedVerificationHints,
    verificationSignal,
    verificationHistory,
    failureHints,
    failureSignal,
    [],
    verificationFreshness,
    verificationFreshness !== 'current' && verificationFreshness !== true,
  );
  return [
    '수정 단계는 진행됐고, 이제 추가 탐색보다 검증 단계로 넘어가는 것이 맞습니다.',
    fileSection,
    inspectedSection,
    failureContextSection,
    renderPrioritizedTargetSection(prioritizedTargets),
    verificationSection,
    verificationHintSection,
    verificationStackSection,
    verificationHistorySection,
    loopHealth.executionDoomLine ? `실행 루프 상태:\n${loopHealth.executionDoomLine}` : '',
    loopHealth.loopClosureSummary ? `루프 권장 상태:\n- ${loopHealth.loopClosureSummary}` : '',
    renderNextActionsSection(nextActions, '- 검증 후 plain-text로 변경 요약과 결과를 정리'),
  ].filter(Boolean).join('\n\n');
}

function buildInspectExecutionFallback(inspections: readonly AutoNarrowedInspection[]): string {
  const items = inspections.slice(0, 3);
  const inspected = items.map((item) => {
    const role = inferInspectionRole(item);
    const detail = inferInspectionDetail(item);
    const excerpt = item.excerpt ? `\n  근거: ${item.excerpt}` : '';
    const detailLine = detail ? `\n  설명: ${detail}` : '';
    return `- ${item.filePath}\n  역할: ${role}${detailLine}${excerpt}`;
  }).join('\n');
  return [
    `디버깅 단계는 후보 파일 ${items.length}개까지 좁혀 확인했습니다.`,
    items.length > 0 ? `확인한 파일:\n${inspected}` : '',
    '현재 단계에선 추가 files_with_matches 탐색보다, 재현/검증 명령을 먼저 실행해 실제 실패 신호를 확보하는 것이 맞습니다.',
    '다음 권장 단계:',
    '- RunShell(["bun","test"]) 또는 Bash("bun test") 로 실패를 재현',
    '- 특정 스크립트가 있으면 RunShell(["bun","run","<script>"]) 또는 해당 argv 명령 사용',
    '- 실행 결과를 본 뒤 필요한 파일만 Edit/Write 로 수정하고 다시 RunShell/Bash 로 재검증',
  ].filter(Boolean).join('\n\n');
}

function buildRepairFallback(
  inspections: readonly AutoNarrowedInspection[],
  editedFiles: readonly string[],
): string {
  const items = inspections.slice(0, 2).map((item) => item.filePath);
  const edited = [...new Set(editedFiles)].slice(0, 3);
  return [
    '실행 실패 신호는 확보됐고, 이제 broad search 보다 수정 또는 재실행으로 이동하는 것이 맞습니다.',
    items.length > 0 ? `검토 근거 파일:\n${items.map((file) => `- ${file}`).join('\n')}` : '',
    edited.length > 0 ? `이미 수정한 파일:\n${edited.map((file) => `- ${file}`).join('\n')}` : '',
    '다음 권장 단계:',
    '- 아직 수정 전이면 Edit/Write 로 실패 원인 후보를 고치기',
    '- 수정했다면 RunShell/Bash 로 동일 명령을 다시 실행해 재검증',
    '- 필요하면 Read/Lsp/Grep(output_mode="content"|"count") 로 실패 지점만 좁게 확인',
  ].filter(Boolean).join('\n\n');
}

function buildExecutionFailureFallback(
  inspections: readonly AutoNarrowedInspection[],
  failingCommand: string | null,
  failureSummary: string | null = null,
  failureHints: readonly string[] = [],
  failureDetails: ExecutionSignalDetails = EMPTY_EXECUTION_SIGNAL_DETAILS,
  failureSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
  verificationHistory: readonly VerificationHistoryEntry[] = [],
  executionDoomWindow: readonly string[] = [],
  verificationStillCurrent = true,
): string {
  const items = inspections.slice(0, 2).map((item) => item.filePath);
  const prioritizedTargets = buildPrioritizedRepairTargets(
    inspections,
    failureHints,
    failureDetails,
    failureSignal,
  );
  const loopHealth = buildLoopHealthSnapshot(
    verificationHistory,
    executionDoomWindow,
    verificationStillCurrent,
  );
  const nextActions = buildRepairActionLines(
    prioritizedTargets,
    failingCommand,
    failureSummary,
    failureHints,
    EMPTY_LOOP_SIGNAL_SNAPSHOT,
    verificationHistory,
    failureHints,
    failureSignal,
    executionDoomWindow,
    verificationStillCurrent,
  );
  return [
    '실행 단계에서 실패 신호를 확인했습니다. 이제 broad search 보다 수정 또는 재실행으로 이동하는 것이 맞습니다.',
    failingCommand ? `실패를 낸 실행:\n- ${failingCommand}` : '',
    failureSummary ? `실패 요약:\n- ${failureSummary}` : '',
    failureHints.length > 0 ? `실패에서 드러난 파일/테스트:\n${failureHints.slice(0, 3).map((hint) => `- ${hint}`).join('\n')}` : '',
    (failureSignal.stackPreview.length > 0 || failureDetails.stackHints.length > 0)
      ? `실패 스택/신호:\n${(failureSignal.stackPreview.length > 0 ? failureSignal.stackPreview : failureDetails.stackHints.slice(0, 2)).map((hint) => `- ${hint}`).join('\n')}`
      : '',
    loopHealth.verifyLoopHealthLine ? `검증 루프 상태:\n${loopHealth.verifyLoopHealthLine}` : '',
    renderPrioritizedTargetSection(prioritizedTargets),
    items.length > 0 ? `검토 근거 파일:\n${items.map((file) => `- ${file}`).join('\n')}` : '',
    renderNextActionsSection(nextActions),
  ].filter(Boolean).join('\n\n');
}

function buildExecutionFailureFallbackFromLoopState(
  inspections: readonly AutoNarrowedInspection[],
  executionState: ExecutionLoopState,
  verificationState: VerificationLoopState,
): string {
  return buildExecutionFailureFallback(
    inspections,
    executionState.lastCommand,
    executionState.lastSummary,
    executionState.lastHints,
    executionState.lastDetails,
    executionState.lastSignal,
    verificationState.history,
  );
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && typeof (result as any).output === 'string') {
    return (result as any).output;
  }
  return '';
}

function detectExecutionFailure(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const typed = result as Record<string, unknown>;
  const exitCode = typeof typed.exitCode === 'number' ? typed.exitCode : null;
  if (exitCode !== null && exitCode !== 0) return true;
  const outcome = typeof typed.outcome === 'string' ? typed.outcome : null;
  return !!(outcome && outcome !== 'exit');
}

function summarizeExecutionCommand(
  name: string,
  args: Record<string, unknown>,
): string | null {
  if (name === 'RunShell') {
    const command = Array.isArray(args.command)
      ? args.command.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
    return command.length > 0 ? command.join(' ') : 'RunShell(...)';
  }
  if (name === 'Bash') {
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    return command || 'Bash(...)';
  }
  return null;
}

function summarizeExecutionResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const typed = result as Record<string, unknown>;
  const output = typeof typed.output === 'string' ? typed.output.trim() : '';
  const stdout = typeof typed.stdout === 'string' ? typed.stdout.trim() : '';
  const stderr = typeof typed.stderr === 'string' ? typed.stderr.trim() : '';
  const candidates = [stderr, stdout, output]
    .flatMap((text) => text.split('\n'))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const interesting = candidates.find((line) =>
    /(fail|failed|error|exception|trace|stack|passed|pass|ok|abort|timeout|denied|spawn)/i.test(line),
  ) ?? candidates.find((line) => line.length > 0);
  if (!interesting) return null;
  return interesting.length > 140 ? `${interesting.slice(0, 137)}...` : interesting;
}

function fingerprintExecutionFailure(
  command: string | null,
  failureSummary: string | null,
): string | null {
  const normalizedCommand = typeof command === 'string'
    ? command.replace(/\s+/g, ' ').trim().toLowerCase()
    : '';
  const normalizedSummary = typeof failureSummary === 'string'
    ? failureSummary.replace(/\s+/g, ' ').trim().toLowerCase()
    : '';
  if (!normalizedCommand && !normalizedSummary) return null;
  return [
    `exec=${normalizedCommand || 'unknown-command'}`,
    `summary=${normalizedSummary || 'unknown-summary'}`,
  ].join('|').slice(0, 280);
}

function describeExecutionFingerprint(fingerprint: string): string {
  const execMatch = fingerprint.match(/(?:^|\|)exec=([^|]+)/);
  const summaryMatch = fingerprint.match(/(?:^|\|)summary=([^|]+)/);
  const exec = execMatch?.[1]?.trim() || 'unknown-command';
  const summary = summaryMatch?.[1]?.trim() || 'unknown-summary';
  return `${exec} -> ${summary}`;
}

function extractExecutionSignalHints(result: unknown): string[] {
  const details = extractExecutionSignalDetails(result);
  const hints = new Set<string>();
  for (const hint of [...details.testHints, ...details.fileHints]) {
    hints.add(hint);
    if (hints.size >= 5) break;
  }
  if (hints.size === 0 && details.interestingLine) hints.add(details.interestingLine);
  if (hints.size === 0) {
    for (const hint of details.stackHints) {
      hints.add(hint);
      if (hints.size >= 3) break;
    }
  }
  return [...hints];
}

function extractExecutionSignalDetails(result: unknown): ExecutionSignalDetails {
  if (!result || typeof result !== 'object') return EMPTY_EXECUTION_SIGNAL_DETAILS;
  const typed = result as Record<string, unknown>;
  const text = [
    typeof typed.stderr === 'string' ? typed.stderr : '',
    typeof typed.stdout === 'string' ? typed.stdout : '',
    typeof typed.output === 'string' ? typed.output : '',
  ].filter(Boolean).join('\n');
  if (!text) return EMPTY_EXECUTION_SIGNAL_DETAILS;

  const fileHints = new Set<string>();
  const testHints = new Set<string>();
  const stackHints = new Set<string>();
  const fileRegex = /(?:^|[\s:(["'])([A-Za-z0-9_./-]+\.(?:test\.)?(?:ts|tsx|js|jsx|mjs|cjs))(?:$|[\s:)\]"'])/g;
  for (const match of text.matchAll(fileRegex)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    if (candidate.includes('/node_modules/')) continue;
    fileHints.add(candidate);
    if (candidate.includes('.test.') || candidate.includes('.spec.')) testHints.add(candidate);
    if (fileHints.size >= 5) break;
  }

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (stackHints.size < 3 && (/^\s*at\s+/i.test(line) || /:[0-9]+:[0-9]+/.test(line) || /^error:/i.test(line))) {
      stackHints.add(line.length > 160 ? `${line.slice(0, 157)}...` : line);
    }
    if (testHints.size < 3) {
      const failMatch = line.match(/^(?:FAIL|PASS)\s+(.+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs))/i);
      const candidate = failMatch?.[1]?.trim();
      if (candidate && !candidate.includes('/node_modules/')) testHints.add(candidate);
    }
  }

  const interesting = lines.find((line) => /(fail|failed|error|exception|trace|stack)/i.test(line)) ?? null;

  return {
    fileHints: [...fileHints].slice(0, 5),
    testHints: [...testHints].slice(0, 3),
    stackHints: [...stackHints].slice(0, 3),
    interestingLine: interesting ? (interesting.length > 120 ? `${interesting.slice(0, 117)}...` : interesting) : null,
  };
}

function buildExecutionDoomFallback(
  inspections: readonly AutoNarrowedInspection[],
  failingCommand: string | null,
  failureSummary: string | null = null,
  failureHints: readonly string[] = [],
  failureDetails: ExecutionSignalDetails = EMPTY_EXECUTION_SIGNAL_DETAILS,
  failureSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
  doomWindow: readonly string[] = [],
  verificationHistory: readonly VerificationHistoryEntry[] = [],
  verificationStillCurrent = true,
): string {
  const loopHealth = buildLoopHealthSnapshot(verificationHistory, doomWindow, verificationStillCurrent);
  return [
    '[EXECUTION DOOM DETECTED] 같은 실행 실패가 반복되어 추가 재실행보다 수정 또는 재검증으로 전환하는 것이 맞습니다.',
    loopHealth.executionDoomLine ?? '',
    loopHealth.loopClosureSummary ? `루프 권장 상태:\n- ${loopHealth.loopClosureSummary}` : '',
    doomWindow.length > 0
      ? `반복된 실행 실패 패턴:\n${doomWindow.slice(0, 3).map((item) => `- ${describeExecutionFingerprint(item)}`).join('\n')}`
      : '',
    buildExecutionFailureFallback(
      inspections,
      failingCommand,
      failureSummary,
      failureHints,
      failureDetails,
      failureSignal,
      verificationHistory,
      doomWindow,
      verificationStillCurrent,
    ),
  ].join('\n\n');
}

function buildExecutionDoomFallbackFromLoopState(
  inspections: readonly AutoNarrowedInspection[],
  executionState: ExecutionLoopState,
  verificationState: VerificationLoopState,
  doomWindow: readonly string[] = [],
): string {
  return buildExecutionDoomFallback(
    inspections,
    executionState.lastCommand,
    executionState.lastSummary,
    executionState.lastHints,
    executionState.lastDetails,
    executionState.lastSignal,
    doomWindow,
    verificationState.history,
    isVerificationStillCurrent(verificationState),
  );
}

function buildRepairFallbackWithFailureContext(
  inspections: readonly AutoNarrowedInspection[],
  editedFiles: readonly string[],
  failingCommand: string | null,
  failureSummary: string | null = null,
  failureHints: readonly string[] = [],
  failureDetails: ExecutionSignalDetails = EMPTY_EXECUTION_SIGNAL_DETAILS,
  verificationHistory: readonly VerificationHistoryEntry[] = [],
  verificationFreshness: 'current' | 'stale' | 'unknown' | boolean = 'current',
  failureSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
): string {
  const prioritizedTargets = buildPrioritizedRepairTargets(
    inspections,
    failureHints,
    failureDetails,
    failureSignal,
  );
  const nextActions = buildRepairActionLines(
    prioritizedTargets,
    failingCommand,
    failureSummary,
    failureHints,
    EMPTY_LOOP_SIGNAL_SNAPSHOT,
    verificationHistory,
    failureHints,
    failureSignal,
    [],
    verificationFreshness,
  );
  return [
    buildRepairFallback(inspections, editedFiles),
    failingCommand || failureSummary || failureHints.length > 0
      ? [
        '현재 repair 가 필요한 실패 맥락:',
        ...(failingCommand ? [`- 실패 명령: ${failingCommand}`] : []),
        ...(failureSummary ? [`- 실패 요약: ${failureSummary}`] : []),
        ...(failureHints.length > 0
          ? ['- 실패에서 드러난 파일/테스트:', ...failureHints.slice(0, 3).map((hint) => `  - ${hint}`)]
          : []),
        ...((failureSignal.stackPreview.length > 0 || failureDetails.stackHints.length > 0)
          ? ['- 실패 스택/신호:', ...(failureSignal.stackPreview.length > 0 ? failureSignal.stackPreview : failureDetails.stackHints.slice(0, 2)).map((hint) => `  - ${hint}`)]
          : []),
      ].join('\n')
      : '',
    renderPrioritizedTargetSection(prioritizedTargets),
    renderNextActionsSection(nextActions),
  ].filter(Boolean).join('\n\n');
}

function buildRepairFallbackFromLoopState(
  inspections: readonly AutoNarrowedInspection[],
  editedFiles: readonly string[],
  executionState: ExecutionLoopState,
  verificationState: VerificationLoopState,
): string {
  return buildRepairFallbackWithFailureContext(
    inspections,
    editedFiles,
    executionState.lastCommand,
    executionState.lastSummary,
    executionState.lastHints,
    executionState.lastDetails,
    verificationState.history,
    verificationFreshness(verificationState),
    executionState.lastSignal,
  );
}

function looksLikeCodePath(value: string): boolean {
  return /\.[tj]sx?$|\.mjs$|\.cjs$/i.test(value);
}

function looksLikeTestPath(value: string): boolean {
  return /(?:^|\/).+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(value);
}

function normalizeRepairCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!looksLikeCodePath(trimmed)) return null;
  return trimmed;
}

function buildPrioritizedRepairTargets(
  inspections: readonly AutoNarrowedInspection[],
  failureHints: readonly string[],
  failureDetails: ExecutionSignalDetails,
  failureSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
  verificationSignal: LoopSignalSnapshot = EMPTY_LOOP_SIGNAL_SNAPSHOT,
): PrioritizedRepairTarget[] {
  const scored = new Map<string, PrioritizedRepairTarget>();
  const upsert = (path: string, score: number, reason: string) => {
    const normalized = normalizeRepairCandidate(path);
    if (!normalized) return;
    const existing = scored.get(normalized);
    if (existing) {
      existing.score += score;
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      return;
    }
    scored.set(normalized, { path: normalized, score, reasons: [reason] });
  };

  for (const hint of failureDetails.fileHints) {
    upsert(hint, looksLikeTestPath(hint) ? 45 : 100, looksLikeTestPath(hint) ? '실패 테스트에서 언급됨' : '실패 파일 힌트');
  }
  for (const hint of failureDetails.testHints) {
    upsert(hint, 35, '실패 테스트 힌트');
  }
  if (failureSignal.primarySourceFile) {
    upsert(failureSignal.primarySourceFile, 130, '실패 signal primary source');
  }
  if (failureSignal.primaryTestFile) {
    upsert(failureSignal.primaryTestFile, 55, '실패 signal primary test');
  }
  for (const hint of failureHints) {
    const normalized = normalizeRepairCandidate(hint);
    if (!normalized) continue;
    upsert(normalized, looksLikeTestPath(normalized) ? 25 : 70, looksLikeTestPath(normalized) ? '실패 맥락에서 언급됨' : '실패 맥락 파일');
  }
  for (const inspected of inspections) {
    upsert(inspected.filePath, 30, '검토 근거 파일');
  }
  if (verificationSignal.primarySourceFile) {
    upsert(verificationSignal.primarySourceFile, 25, '최근 검증 signal source');
  }
  if (verificationSignal.primaryTestFile) {
    upsert(verificationSignal.primaryTestFile, 15, '최근 검증 signal test');
  }

  for (const target of scored.values()) {
    if (!looksLikeTestPath(target.path)) target.score += 10;
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 5);
}
function isNarrowingBlockedResult(result: unknown): boolean {
  const text = resultText(result).toLowerCase();
  return (
    text.includes('candidate list already exists for this turn')
    || text.includes('already have a candidate file listing')
    || text.includes('reuse current candidates')
    || text.includes('narrow the request or use prior results')
  );
}

function isAutoNarrowedReadResult(result: unknown): boolean {
  return resultText(result).includes('[AUTO-NARROWED]');
}

function parseAutoNarrowedInspection(result: unknown): AutoNarrowedInspection | null {
  const text = resultText(result);
  if (!text.includes('[AUTO-NARROWED]')) return null;
  const fileMatch = text.match(/Read\(file_path="([^"]+)"\)/);
  const filePath = fileMatch?.[1]?.trim();
  if (!filePath) return null;
  const excerptLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) =>
      /^\d+\s+/.test(line)
      && !/^(\d+\s+\/\/|\d+\s*\*)/.test(line)
      && line.length > 6,
    ) ?? null;
  const excerpt = excerptLine ? excerptLine.replace(/^\d+\s+/, '').trim() : null;
  return { filePath, excerpt };
}

function finalizeVisibleAssistantText(
  fullAcrossTurns: string,
  finalTurnText: string,
  sawToolRound: boolean,
): string {
  if (!sawToolRound) return fullAcrossTurns;
  return finalTurnText;
}

function clearVisibleAssistantTextForToolRound(
  handlers: StreamWithToolsHandlers,
  sawToolRound: boolean,
): void {
  if (!sawToolRound) {
    handlers.onText('', '');
    return;
  }
  handlers.onText('', '');
}

// Compact previews used to mirror chat-surface events into debug logs
// (debug-mode only — `if (debug.enabled)` gated at every call site).
function previewMessageContent(content: unknown, max: number): string {
  if (typeof content === 'string') {
    return content.length > max ? `${content.slice(0, max)}…` : content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'tool_result') {
        const c = b.content;
        parts.push(`[tool_result ${typeof c === 'string' ? c.slice(0, 80) : JSON.stringify(c).slice(0, 80)}]`);
      } else if (b.type === 'tool_use') parts.push(`[tool_use ${String(b.name ?? '')}]`);
    }
    const joined = parts.join('\n');
    return joined.length > max ? `${joined.slice(0, max)}…` : joined;
  }
  const s = JSON.stringify(content) ?? '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function previewToolArgs(args: Record<string, unknown> | undefined, max: number): string {
  if (!args || typeof args !== 'object') return '';
  try {
    const s = JSON.stringify(args);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return '[unserializable]';
  }
}

function previewResult(result: unknown, max: number): string {
  if (result == null) return '';
  if (typeof result === 'string') {
    return result.length > max ? `${result.slice(0, max)}…` : result;
  }
  try {
    const s = JSON.stringify(result);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return '[unserializable]';
  }
}

const EXPLORATORY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'ListDir',
  'WebSearch',
  'WebFetch',
  'GetDashboardState',
  'Lsp',
]);

const INSPECT_ACTION_TOOLS = new Set([
  'Edit',
  'Write',
  'Bash',
  'RunShell',
  'Agent',
  'UpdatePlan',
  'Plan',
  'MarkStepDone',
  'Lsp',
  'AstGrep',
  'ast_grep_search',
]);

const VERIFY_ACTION_TOOLS = new Set([
  'Edit',
  'Write',
  'RunShell',
  'Bash',
  'Agent',
  'UpdatePlan',
  'Plan',
  'MarkStepDone',
  'Read',
  'Lsp',
  'AstGrep',
  'ast_grep_search',
]);

const EXECUTION_ACTION_TOOLS = new Set([
  'RunShell',
  'Bash',
  'Agent',
  'UpdatePlan',
  'Plan',
  'MarkStepDone',
  'Read',
  'Lsp',
  'AstGrep',
  'ast_grep_search',
]);

const REPAIR_ACTION_TOOLS = new Set([
  'Edit',
  'Write',
  'RunShell',
  'Bash',
  'Agent',
  'UpdatePlan',
  'Plan',
  'MarkStepDone',
  'Read',
  'Lsp',
  'AstGrep',
  'ast_grep_search',
]);

function isExploratoryTurn(
  pendingCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): boolean {
  return pendingCalls.length > 0 && pendingCalls.every((call) => EXPLORATORY_TOOLS.has(call.name));
}

/** W6-A (2026-05-03 PM, post-PR-1396) — Search-only turn predicate. A
 *  turn is "search-only" when EVERY pending call is Grep / Glob / ListDir
 *  (no Read / Lsp / Bash / Edit). Counts toward `searchOnlyTurnStreak`
 *  for the codex-only force-Read intervention.
 *
 *  Reproducer: log/wave6-baseline/analysis-codex.jsonl — codex emitted
 *  23 calls (Grep 13 + Glob 10 + Read 0) across 5 turns, never pivoting
 *  to Read despite broad-spot blocks suggesting it. opus on the same
 *  prompt: 12 calls (Glob 4 + Grep 4 + Read 4). The streak detector
 *  catches codex BEFORE it reaches exploration-synthesis-phase. */
const SEARCH_ONLY_TOOLS = new Set(['Grep', 'Glob', 'ListDir']);
function isSearchOnlyTurn(
  pendingCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): boolean {
  return pendingCalls.length > 0 && pendingCalls.every((call) => SEARCH_ONLY_TOOLS.has(call.name));
}

/** W5-G (2026-05-03 PM++) — Content-fetch-absent turn predicate. Tool-
 *  agnostic generalization of W6-A: a turn is "no-content-read" when it
 *  has tool calls but NONE of them fetch / inspect / modify file content
 *  (no Read / Edit / Write / Lsp). Catches the codex pathology even on
 *  toolsets where W6-A's strict ['Grep','Glob','ListDir'] check misses
 *  it — most importantly the `shaped` (Bash + ListDir) and `shell-shaped`
 *  (codex-rs `shell`) toolsets where codex spams `rg --files` / `find`
 *  via Bash/shell without ever pivoting to content read.
 *
 *  Used by the W5-G early-trigger that calls tryForceSynthesisPass at
 *  turn 4 (streak ≥ 3) instead of letting the loop burn through 4-5
 *  more turns before W5-E ([SYNTHESIS IGNORED]) or W5-F (max-turns)
 *  fires the same intervention. Saves 100-130 s of latency on the
 *  analysis path while preserving substantive answer quality. */
const CONTENT_READ_TOOLS = new Set(['Read', 'Edit', 'Write', 'Lsp']);
function isNoContentReadTurn(
  pendingCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): boolean {
  return pendingCalls.length > 0 && pendingCalls.every((call) => !CONTENT_READ_TOOLS.has(call.name));
}

export type ToolLoopPendingCall = { id: string; name: string; args: Record<string, unknown> };

function isActionToolCall(
  call: ToolLoopPendingCall,
  allowedTools: ReadonlySet<string>,
): boolean {
  if (allowedTools.has(call.name)) return true;
  if (call.name !== 'Grep') return false;
  const mode = typeof call.args.output_mode === 'string' ? call.args.output_mode.trim() : '';
  return mode === 'content' || mode === 'count';
}

function isInspectActionTurn(pendingCalls: ToolLoopPendingCall[]): boolean {
  return pendingCalls.length > 0 && pendingCalls.every((call) => isActionToolCall(call, INSPECT_ACTION_TOOLS));
}

function isVerifyActionTurn(pendingCalls: ToolLoopPendingCall[]): boolean {
  return pendingCalls.length > 0 && pendingCalls.every((call) => isActionToolCall(call, VERIFY_ACTION_TOOLS));
}

function isExecutionActionTurn(pendingCalls: ToolLoopPendingCall[]): boolean {
  return pendingCalls.length > 0 && pendingCalls.every((call) => isActionToolCall(call, EXECUTION_ACTION_TOOLS));
}

function isRepairActionTurn(pendingCalls: ToolLoopPendingCall[]): boolean {
  return pendingCalls.length > 0 && pendingCalls.every((call) => isActionToolCall(call, REPAIR_ACTION_TOOLS));
}

export function getToolLoopPhaseRejectedCalls(
  phase: ToolLoopFollowupPhase | null,
  pendingCalls: ToolLoopPendingCall[],
): ToolLoopPendingCall[] {
  if (phase === 'inspect-synthesis') return pendingCalls;
  const allowedTools = phase === 'inspect-action' ? INSPECT_ACTION_TOOLS
    : phase === 'inspect-execution' ? EXECUTION_ACTION_TOOLS
    : phase === 'repair-action' ? REPAIR_ACTION_TOOLS
    : phase === 'verify-action' ? VERIFY_ACTION_TOOLS
    : null;
  return allowedTools === null ? [] : pendingCalls.filter((call) => !isActionToolCall(call, allowedTools));
}

function getExplorationSynthesisThreshold(maxTurns: number): number {
  return Math.min(EXPLORATION_SYNTHESIS_TURNS_DEFAULT, Math.max(3, maxTurns - 2));
}

/** 현대 프론티어 모델군 — exploration budget 조기 컷 면제 대상.
 *  claude(opus/sonnet)·codex(gpt-5.6)·grok 은 무제한 tool-loop + 프롬프트 규율 +
 *  mid-loop compaction 으로 발산을 막으므로 read/search 스트릭 taming 이 불필요.
 *  (gemini 는 제외 — 대표 지시 2026-07-17: grok 을 대신 포함.) */
function isFrontierExplorationFamily(modelFamily: string | undefined): boolean {
  return modelFamily === 'claude' || modelFamily === 'codex' || modelFamily === 'grok';
}

function getExplorationThreshold(
  messages: readonly LLMMessage[],
  maxTurns: number,
  modelFamily?: string,
): number {
  // ★ 프론티어 면제(대표 방침 2026-07-17 "탐색은 최대한 풀어주는 게 맞는 정책") —
  //   exploration budget 은 구형 모델이 read/search 만 반복하다 maxTurns 에 걸려 0자
  //   출력하는 stall 을 막던 taming 레거시(§7020 주석·8캡과 동일 계열). 현대 프론티어는
  //   조기 컷(4~5턴)이 오히려 자유 조사를 끊는다 → 실제 예산(maxTurns hard-stop)/
  //   compaction 만 backstop 으로 두고 스트릭 컷은 면제(∞). 레거시 provider 만 taming 유지.
  if (isFrontierExplorationFamily(modelFamily)) return Number.POSITIVE_INFINITY;
  const base = getExplorationSynthesisThreshold(maxTurns);
  return looksLikeStructuralAnalysis(messages) ? base + 1 : base;
}

/** ⛔⭐ **이 필터는 «정확 일치»이고, 그것은 «전제»에 기댄다** (🅢 132차가 반증으로 찾았다).
 *
 *  `content === CODEX_TOOL_DISCIPLINE` 이므로 ***뒤에 공백 한 칸만 붙어도 «못 거른다»***.
 *  그 전제를 지키는 것은 이 함수가 아니라 «두 자리»다:
 *    ① 주입부 — 상수를 «그대로» 싣는다(합성하지 않는다)
 *    ② 위 `TOOL_DISCIPLINE_BY_FAMILY` 주석 — *"문면을 «바이트 하나도» 안 건드린다"*
 *
 *  ⚠️ ***그 결합이 「어디에도 안 적혀」 있었다*** — 그래서 여기 적는다.
 *
 *  ✅ 그리고 그 전제는 **조용하지 않다 — 이미 «물린다»**. 실측(주입을 `+ ' '` 로 합성해 보았다):
 *    `test/grok-tool-discipline.test.ts`            8 pass 0 fail → ***6 pass 2 fail***
 *    `test/llm-exploration-synthesis-phase.test.ts` 36 pass 6 fail → ***29 pass 13 fail***
 *  ⇒ 📌 **그러니 이 필터를 「느슨하게」(trim·startsWith·정규화) 고치지 마라** —
 *     느슨해지면 ***사용자가 «그 문면을 인용한» 경우까지 분류에서 지운다***. 정확 일치가 «의도»다. */
export function selectIntentClassificationMessages(messages: readonly LLMMessage[]): readonly LLMMessage[] {
  return messages.filter((message) => !(
    message.role === 'system'
    && typeof message.content === 'string'
    && (
      message.content === CODEX_TOOL_DISCIPLINE
      || message.content === GROK_TOOL_DISCIPLINE
      || message.content === LOCAL_TOOL_DISCIPLINE
    )
  ));
}

function intentClassificationText(messages: readonly LLMMessage[]): string {
  return selectIntentClassificationMessages(messages)
    .map((message) => typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
            .map(block => block.text)
            .join('\n')
        : '')
    .join('\n')
    .toLowerCase();
}

export function looksLikeStructuralAnalysis(messages: readonly LLMMessage[]): boolean {
  const text = intentClassificationText(messages);
  return (
    text.includes('analyze')
    || text.includes('analysis')
    || text.includes('structure')
    || text.includes('architecture')
    || text.includes('구조')
    || text.includes('분석')
    || text.includes('아키텍처')
  );
}

export function looksLikeImplementationTask(messages: readonly LLMMessage[]): boolean {
  const text = intentClassificationText(messages);
  return (
    text.includes('fix')
    || text.includes('implement')
    || text.includes('implementation')
    || text.includes('edit')
    || text.includes('modify')
    || text.includes('change')
    || text.includes('patch')
    || text.includes('refactor')
    || text.includes('bug')
    || text.includes('test')
    || text.includes('verify')
    || text.includes('수정')
    || text.includes('구현')
    || text.includes('패치')
    || text.includes('버그')
    || text.includes('고쳐')
    || text.includes('변경')
    || text.includes('검증')
    || text.includes('테스트')
  );
}

export function looksLikeDebuggingTask(messages: readonly LLMMessage[]): boolean {
  const text = intentClassificationText(messages);
  return (
    text.includes('debug')
    || text.includes('debugging')
    || text.includes('diagnose')
    || text.includes('diagnostic')
    || text.includes('repro')
    || text.includes('reproduce')
    || text.includes('failing test')
    || text.includes('failure')
    || text.includes('flaky')
    || text.includes('crash')
    || text.includes('stack trace')
    || text.includes('error')
    || text.includes('디버깅')
    || text.includes('재현')
    || text.includes('오류')
    || text.includes('에러')
    || text.includes('실패')
    || text.includes('크래시')
    || text.includes('스택트레이스')
    || text.includes('안됨')
  );
}

function getInspectFollowupMode(messages: readonly LLMMessage[]): 'synthesis' | 'action' | 'execution' {
  if (!looksLikeStructuralAnalysis(messages) && looksLikeDebuggingTask(messages)) return 'execution';
  return looksLikeImplementationTask(messages) ? 'action' : 'synthesis';
}

export function getInspectBudgetThreshold(messages: readonly LLMMessage[], modelFamily?: string, codexInspectExempt?: boolean): number {
  // Tier 1(2026-07-19 → 아크4 전-family) — 아밍(config `llm.codexInspectExempt`·레거시 이름) 시
  // inspect-budget 하드월을 **전 family** 면제(옛 세대 re-read taming 회수·read-cap→explore 규율 +
  // compaction 대체). goal-loop 전-family 개방과 정합 — codex 외 claude/gemini/grok/local 자율빌드도
  // 깊은 조사가 하드월에 안 걸린다. 미아밍이면 아래 2/3 폴백(옛 동작·안전). modelFamily 는 관측/향후
  // family별 튜닝용으로 유지. codexInspectExempt 는 caller 가 config 에서 해석해 주입(순수 함수).
  void modelFamily;
  if (codexInspectExempt === true) {
    return INSPECT_BUDGET_CODEX;
  }
  if (looksLikeImplementationTask(messages)) {
    return INSPECT_BUDGET_DEFAULT;
  }
  return looksLikeStructuralAnalysis(messages)
    ? INSPECT_BUDGET_STRUCTURAL_ANALYSIS
    : INSPECT_BUDGET_DEFAULT;
}

/**
 * Stream an assistant response, handling tool_calls by dispatching them
 * through the provided callback and feeding results back to the model
 * for additional turns. Returns the final assistant text.
 *
 * Tool rounds are recorded in history as **native tool_use/tool_result
 * ContentBlock[]**:
 *   assistant: [text?, tool_use, tool_use, ...]
 *   user:      [tool_result, tool_result, ...]  (one per call, by tool_use_id)
 * Adapters translate this to Anthropic native blocks directly, and to
 * OpenAI `tool_calls` field / `{role:'tool'}` messages at the boundary.
 */

// ⛔⭐⭐ **루프가 스스로에게 하는 말은 «사람 말풍선»이 되면 안 된다.**
//
//  📏 2026-08-21 실측: 빈-턴 교정문을 `role:'user'` 로 밀었더니
//    `.elanous-test/sessions/*.jsonl` 세션 스토어에 «그대로 저장»됐고,
//    PWA 가 거기서 수화하므로 사람에게 ***파란 말풍선 = 오류처럼*** 보였다.
//    대표: *"사용자에게 오류로 보이고 UX 경험을 해친다 — 최소 노출이 안 되게"*
//  ✅ `system` 은 이미 걸러진다 — `apps/pwa/src/lib/dock-history-hydrate.ts`
//    가 `if (role === 'system') return null`, 그리고 스토어 실측 역할 분포에도 system 이 없다.
//  📌 그러니 새 필터를 만들지 말고 «이미 있는 관문»을 쓴다.
//  ⛔ 사람이 «실제로 친» 말(interjection)과 툴 결과는 여기 해당하지 않는다 — 그것은 보여야 한다.
export const LOOP_SELF_NOTE_ROLE = 'system' as const;

/** 과금 경로 — 자격 종류에서 파생(BACKLOG C6). oauth=구독 · local · apikey=API · 그 밖=모름. */
export function billingRouteForProvider(provider: string | undefined, model: string): import('./budget/llm-cost.js').BillingRoute {
  if (!provider) return 'unknown';
  const name = provider.startsWith('auto:') ? provider.slice('auto:'.length) : provider;
  // local 은 호출이 «일어났다면» 언제나 local 이다 — 주소가 env 가 아니라 config rotation 에 있어도(자격 판정은 env 만 본다).
  if (name === 'local') return 'local';
  try {
    const auth = authKindForProvider(name, model);
    return auth === 'oauth' ? 'subscription' : auth === 'local' ? 'local' : auth === 'apikey' ? 'api' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Observe usage with optional site/role metadata; a provider-name string remains supported. */
export function logAgentTurnUsage(model: string, usage: LLMUsage, providerNameOrOptions?: string | { providerName?: string; site?: string; role?: ModelRole }): void {
  try {
    const providerName = typeof providerNameOrOptions === 'string' ? providerNameOrOptions : providerNameOrOptions?.providerName;
    const site = (typeof providerNameOrOptions === 'string' ? undefined : providerNameOrOptions?.site) ?? 'agent-turn';
    const role = typeof providerNameOrOptions === 'string' ? undefined : providerNameOrOptions?.role;
    const billing = billingRouteForProvider(providerName, model);
    debug.log('llm.usage', 'llm-usage', {
      site,
      ...(role !== undefined ? { role } : {}),
      model,
      ...(usage.provider !== undefined && { provider: usage.provider }),
      // ⭐ `provider` 는 «선 어댑터»(openai/anthropic)다 — 과금 주체는 별칭 칸으로(BACKLOG B10).
      ...(providerName ? { billingProvider: providerName.replace(/^auto:/, ''), billing } : {}),
      ...(usage.inputTokens !== undefined && { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens !== undefined && { outputTokens: usage.outputTokens }),
      ...(usage.cacheReadInputTokens !== undefined && { cacheReadInputTokens: usage.cacheReadInputTokens }),
      ...(usage.cacheCreationInputTokens !== undefined && { cacheCreationInputTokens: usage.cacheCreationInputTokens }),
      ...llmUsageCostFields(model, usage, undefined, billing),
    });
  } catch { /* usage observation must not change the turn */ }
}

export async function streamLLMWithTools(
  messages: LLMMessage[],
  handlers: StreamWithToolsHandlers,
  opts: LLMOpts & { provider?: LLMProvider; missionContext?: { missionId: string; phaseId: string; onOverload?: (info: { turn: number; consecutiveFailures: number; reason: string }) => void; pollSignal?: () => { kind: 'abort' | 'pause'; reason?: string } | undefined }; contextStrategy?: import('./agent-substrate/context-strategy.js').ContextStrategy;
  } = {},
): Promise<string> {
  const provider = opts.provider ?? resolveDefaultProvider(opts.model);
  const initial = finalizeStreamingProviderModel(provider, opts.model ?? provider.defaultModel);
  let activeProvider = initial.provider;
  let activeModel = initial.model;
  const attemptedProviders = new Set<string>([activeProvider.name]);
  let blockedProviders: ProviderFallbackAttempt[] = [];
  const effectiveModel = activeModel;
  const modelFamily = getModelFamily(effectiveModel);
  debug.log('llm.router', 'streamLLMWithTools', {
    provider: provider.name,
    model: effectiveModel,
    modelFamily,
    messageCount: messages.length,
    messageRoles: summarizeRoles(messages),
    tools: opts.tools?.map(t => t.name),
    toolsAvailable: !!provider.streamChat && (opts.tools?.length ?? 0) > 0,
  }, { level: 'info' });
  if (!provider.streamChat || !opts.tools || opts.tools.length === 0) {
    // No tool support or no tools requested — delegate to plain streamLLM.
    debug.log('llm.router', 'streamLLMWithTools.fallback', {
      reason: !provider.streamChat ? 'provider-no-streamChat' : 'no-tools',
    }, { level: 'info' });
    const fallbackText = await streamLLM(messages, handlers.onText, opts);
    // Even the no-tools path emits onTurnComplete so callers can treat
    // tool and text-only turns uniformly when persisting chat history.
    handlers.onTurnComplete?.([
      { role: 'assistant', content: fallbackText },
    ]);
    return fallbackText;
  }

  const history: LLMMessage[] = [...messages];
  // codex family tool-use discipline (opencode-style per-family prompt). The
  // now-unlimited codex loop uses prompt discipline (not a turn cap) as its
  // divergence defense. Injected BEFORE `initialHistoryLen` is captured, so
  // `onTurnComplete(history.slice(initialHistoryLen))` never hands it back to
  // the caller — no per-turn duplication when the caller persists new messages.
  // Adapters fold multiple system messages, so this composes with (does not
  // mutate) the caller's persona/system prompt.
  // ⭐ 세 갈래(codex · grok · local)가 «같은 모양의 if» 였다 — 해소 지점을 하나로 모은다.
  //   대표 2026-08-14: *"claude 제외 다른 LLM 들이 공용화가 많아 보이고, 오히려 claude 일 때
  //   옵션화를 해야 하는 게 아닌지"* ⊕ `[S]` 와 합의한 축 분담(축② = 능력 술어는 `[T]` 소유).
  //   ⛔ 동작은 «바이트 하나» 안 바뀐다 — 같은 조건에 같은 문면이다(테스트가 전송분으로 문다).
  const toolDiscipline = resolveToolDiscipline(modelFamily);
  if (toolDiscipline !== null) {
    // ⛔ **상수를 «그대로» 싣는다 — 합성하지 마라.**
    //    `selectIntentClassificationMessages` 가 «정확 일치»로 이 메시지를 걸러 내므로,
    //    여기서 한 글자라도 덧붙이면 ***분류기 셋이 다시 «오염»된다***(그 함수 주석에 실측이 있다).
    history.unshift({ role: 'system', content: toolDiscipline });
  }
  // Mark the boundary so we can hand back JUST the new messages the
  // loop accumulated — assistant turns with tool_use blocks, user turns
  // with tool_result blocks, and the final assistant text. Callers that
  // persist this back into their own history preserve the tool evidence
  // across chat turns (the structural fix for "model starts search from
  // scratch on the follow-up question").
  const initialHistoryLen = history.length;
  // PLAN §4.1 (PR #762) — TurnUri identity for this stream. Honoured
  // if caller already minted one (e.g. dashboard wiring shared across
  // surfaces); otherwise we mint here so checkpoints have a stable
  // address.
  const checkpointTurnUri: TurnUri = opts.turnUri ?? mintTurnUri();
  let checkpointToolIndex = 0;
  // Family-aware budget cap. Only when opts.maxTurns is not explicitly
  // set — skills/agents with deliberate larger budgets keep them
  // (caller knows their workload). resolveFamilyMaxTurns() consults
  // user-config (llm.answerPriority + llm.maxTurns.<family> override)
  // before falling back to the family baseline constants.
  // - claude: TOOL_LOOP_MAX_TURNS_CLAUDE (24) — Opus self-regulates
  // - codex:  TOOL_LOOP_MAX_TURNS_CODEX (8)   — re-read pathology cap
  // - other:  TOOL_LOOP_MAX_TURNS_DEFAULT (6) — gemini/grok baseline
  // Returned 0 from resolver = "unlimited" (Number.POSITIVE_INFINITY
  // here so the for-loop bound check stays cheap).
  const resolved = resolveFamilyMaxTurns(modelFamily, activeProvider.name);
  const baselineForFamily =
    modelFamily === 'claude' ? TOOL_LOOP_MAX_TURNS_CLAUDE :
    modelFamily === 'codex' ? TOOL_LOOP_MAX_TURNS_CODEX :
    TOOL_LOOP_MAX_TURNS_DEFAULT;
  const familyDefaultMaxTurns = resolved === 0 ? Number.POSITIVE_INFINITY : (resolved || baselineForFamily);
  // `let` (not const) — the conditional budget-grant hook (opts.budgetGrant)
  // may extend this mid-loop when a designated multi-round tool is called.
  let maxTurns = opts.maxTurns ?? familyDefaultMaxTurns;
  const budgetGrant = opts.budgetGrant;
  // ⭐ Hydration-capable tool list (F2 gap④ · 2026-07-26). The provider tool
  // array used to be `opts.tools`, FIXED for the whole loop. That made
  // ToolSearch a dead end: it renders a `<functions>{…}</functions>` block as
  // *text*, but a provider only accepts calls for functions in its declared
  // list — so the model summoned a schema, found it still uncallable,
  // re-summoned the same tool, and gave up (실측 5회·하니스 2종).
  // Now the loop owns a growable copy: a dispatcher may hand back specs (via
  // HYDRATED_TOOLS_KEY) and they join the declared list for the REMAINING
  // turns. Dedup by name so a repeat summon is a no-op.
  const activeTools: LLMToolSpec[] = [...(opts.tools ?? [])];
  const activeToolNames = new Set(activeTools.map((t) => t.name));
  let codexInspectExemptFlag = false;
  try {
    codexInspectExemptFlag = (require('./user-config.js') as typeof import('./user-config.js')).getUserConfig().llm.codexInspectExempt === true;
  } catch { /* config unreadable — default 비-면제·hot-path 는 config 손상에 안 막힌다 */ }
  const inspectBudgetThreshold = getInspectBudgetThreshold(history, modelFamily, codexInspectExemptFlag);
  const inspectFollowupMode = getInspectFollowupMode(history);
  const explorationThresholdForTurn = getExplorationThreshold(history, maxTurns, modelFamily);
  const maxTurnsUnbounded = maxTurns === Infinity;
  const familyDefaultMaxTurnsUnbounded = familyDefaultMaxTurns === Infinity;
  const explorationUnbounded = !Number.isFinite(explorationThresholdForTurn);
  if (debug.enabled) {
    debug.log('llm.router', 'tool-loop.config', {
      modelFamily,
      maxTurns,
      maxTurnsExplicit: opts.maxTurns !== undefined,
      maxTurnsUnbounded,
      familyDefaultMaxTurns,
      familyDefaultMaxTurnsUnbounded,
      inspectBudgetThreshold,
      inspectFollowupMode,
      explorationThresholdForTurn,
      // ★ Infinity 는 JSON 직렬화 시 null 이 되므로 boolean 으로도 남긴다(관측·제1원칙).
      //   true = 프론티어 면제로 read/search 스트릭 컷 없음(대표 방침 2026-07-17).
      explorationUnbounded,
      explorationThresholdBase: EXPLORATION_SYNTHESIS_TURNS_DEFAULT,
      structuralAnalysisDetected: looksLikeStructuralAnalysis(history),
      historyLen: initialHistoryLen,
    }, { level: 'info' });
    // Mirror the chat surface into debug log: user message, every tool
    // call (with args), every tool result (truncated), and the final
    // assistant text. Lets `log/latest` reconstruct the entire ❯/⏺
    // chat thread without screen-scraping. Wraps the caller's handlers
    // so the 4 dispatch sites + 4 onText sites each get a single mirror
    // without site-by-site edits.
    const lastUserMsg = [...history].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      debug.log('chat.user-message', 'submitted', {
        preview: previewMessageContent(lastUserMsg.content, 500),
        messageCount: history.length,
        modelFamily,
      });
    }
    const original = handlers;
    const toolCallTiming = new ToolCallTiming();
    handlers = {
      ...original,
      onToolCall: (call) => {
        toolCallTiming.start(call.id);
        debug.log('chat.tool-call', call.name, {
          id: call.id,
          args: previewToolArgs(call.args, 240),
        }, { level: 'info' });
        original.onToolCall?.(call);
      },
      onToolResult: (r) => {
        const elapsedMs = toolCallTiming.consume(r.id);
        debug.log('chat.tool-result', r.name, {
          id: r.id,
          preview: previewResult(r.result, 240),
          ...(elapsedMs !== undefined ? { elapsedMs } : {}),
        });
        original.onToolResult?.(r);
      },
      onText: (delta, full) => {
        // Only mirror the FINAL emit (delta === '') to avoid streaming
        // every chunk. Final assistant text reflects what the user saw.
        if (delta === '' && full.length > 0) {
          debug.log('chat.assistant-text', 'final', {
            len: full.length,
            preview: full.length > 500 ? `${full.slice(0, 500)}…` : full,
          });
        }
        original.onText(delta, full);
      },
    };
  }
  const emitTurnComplete = (finalAssistantText?: string): void => {
    if (finalAssistantText && finalAssistantText.length > 0) {
      history.push({
        role: 'assistant',
        content: [{ type: 'text', text: finalAssistantText }],
      });
    }
    handlers.onTurnComplete?.(history.slice(initialHistoryLen));
  };
  let fullText = '';
  let sawToolRound = false;
  const agentBatchTickIntervalMs = opts.agentBatchTickIntervalMs ?? BATCH_TICK_INTERVAL_MS;

  // Empty-turn guard: smaller models (gpt-5.4-mini, haiku) sometimes
  // return a totally empty assistant turn mid-task — no text, no tool
  // calls — effectively giving up. Without this guard the loop treats
  // that as "done" and the skill exits with no useful output. Inject
  // a synthetic user reminder and retry, bounded to MAX_EMPTY_RETRIES
  // so a broken model doesn't burn the full maxTurns budget.
  const MAX_EMPTY_RETRIES = 2;
  let emptyRetries = 0;
  let exploratoryTurnStreak = 0;
  // W6-A — Search-only streak counter. Codex tendency (vs opus): runs
  // 5+ turns of pure Grep/Glob/ListDir without ever Read'ing a single
  // file, then hits exploration-synthesis-phase and force-synthesizes
  // generic content from anchor only. Lowers the bar BEFORE phase
  // rejection: when codex emits a search-only turn AND the streak is
  // already ≥ 2, the dispatcher injects a force-Read stub that names
  // candidate paths from prior tool_results and instructs codex to
  // Read instead of search. Codex-only — opus pivots to Read naturally.
  let searchOnlyTurnStreak = 0;
  // W5-G — tool-agnostic generalization of searchOnlyTurnStreak. Tracks
  // turns with tool calls but NO Read/Edit/Write/Lsp. See predicate
  // comment for the codex Bash/shell pathology this catches.
  let noContentReadTurnStreak = 0;
  let explorationRejectionCount = 0;
  let synthesisRejectionCount = 0;
  // W4-A (2026-05-03 PM) — Read-followed-by-broad-search counter. After
  // 3+ Reads have been DISPATCHED (not blocked) in this turn-loop,
  // codex's tendency to "go back to broad search" is blocked. The
  // model must either Read a specific file from prior results, run a
  // narrow code-intel followup (Lsp / AstGrep / content Grep on a
  // specific path), or synthesize. Trigger: dispatchReadCount ≥ 3 AND
  // a NEW Grep/Glob is broad (no narrow path filter). Codex-only.
  //
  // Reproducer: log/wave5-w5e/debug.jsonl — 18 calls (Read 6 + Grep 12)
  // with the model emitting wildcard Globs (`내부 문서 `*debug*``,
  // `src/**/debug*.ts`) AFTER reading 3+ files. Each broad Glob is a
  // turn waste — the file is already in context.
  let dispatchedReadCount = 0;
  let inspectSynthesisArmed = false;
  let repairActionArmed = false;
  let verifyActionArmed = false;
  let inspectRejectionCount = 0;
  let autoNarrowedReadCount = 0;
  const autoNarrowedInspections: AutoNarrowedInspection[] = [];
  // Successful Edit/Write tool paths only; shell-side changes are intentionally not inferred.
  const editedFilePaths: string[] = [];
  // Tool-call intent log across the whole loop. Captures every call the
  // model issued — including ones rejected by the synthesis-phase
  // gate — so `buildExplorationFallbackSummary` can reconstruct what
  // was attempted when the loop hard-stops without text. Sites: every
  // `handlers.onToolCall?.(call)` boundary (4 in this function).
  const toolCallHistory: Array<{ name: string; args: Record<string, unknown> }> = [];


  // Same-args dedup tracker — fix L (2026-04-25). Codex/gpt-5.4 reread
  // loop pattern: identical (tool, args) issued 6× across one turn-loop
  // (log/debug-20260425155205, 내부 문서 `_index`×6) instead of synthesizing
  // from prior tool_results. Claude Opus naturally rotates files; codex
  // does not. We block the 3rd identical call with a stub message
  // instructing the model to reuse prior tool_results or write its
  // final answer. Codex-family-only: Claude path is unaffected.
  const seenToolCallSignatures = new Map<string, number>();
  // W3-A + extension (2026-05-03) — Broad-spot dedup map. MUST live
  // outside the turn loop so the counter persists across turns. (Bug
  // 2026-05-03 PM: original placement inside turn loop reset the map
  // each turn → broad-spot never fired in cross-turn scenarios.)
  //
  // Thresholds are HIGHER than DEDUP_THRESHOLD (3) and at-or-above the
  // exploration-synthesis baseline (4-5) so broad-spot doesn't pre-empt
  // those legitimate fallback paths. Broad-spot fires when exploration
  // synthesis is suppressed (e.g., `codexInspectionStillProgressing`
  // gate) but the model keeps rotating patterns against the same spot.
  //
  // files_with_matches: 4 (matches non-structural exploration threshold)
  // content: 5 (matches structural-analysis exploration threshold +1
  // grace, since content mode is more legitimately repeatable).
  // Glob (W3-A-glob, 2026-05-03 PM): 2 — Glob is deterministic over the
  // filesystem (same args ⇒ same result within the session) so 2 is the
  // tightest sane threshold. Lower than DEDUP_THRESHOLD (3) because
  // Glob gets caught at broad-spot BEFORE generic dedup, and the pivot
  // signal we want is "stop re-globbing the same wildcard, narrow to
  // Read/Grep". Pattern-rotation against the same {path, pattern-shape}
  // is the trigger.
  const seenBroadSpots = new Map<string, number>();
  const BROAD_SPOT_THRESHOLD = 4;
  const BROAD_SPOT_CONTENT_THRESHOLD = 5;
  const BROAD_SPOT_GLOB_THRESHOLD = 2;
  // P2 (2026-05-03) — Codex-immediate-stop grace counters. Original
  // codex-immediate-stop branches (PR #768, 2026-04-25) hard-stopped on
  // the FIRST occurrence of inspect-synthesis / repair-action / inspect-
  // action phase entry for the codex family. With the maxTurns=4 cap
  // that PR landed, every turn was precious so the no-grace policy was
  // defensible. After P0 (2026-05-03) raised the codex cap to 8, there
  // is room to give codex ONE grace turn per phase: emit the soft
  // rejectionMsg via the normal stub path, let codex respond, and only
  // hard-stop if codex still issues tool calls in the same phase on the
  // following turn.
  //
  // log/latest from 2026-05-03 confirmed both codexImmediateRepairStop
  // (×2) and codexImmediateInspectActionStop (×2) firing in production
  // — with maxTurns=4 they were the right call but they also killed the
  // legitimate inspect→edit and exec→fix transitions that the user-
  // facing pipelines need.
  //
  // Grace counters decrement on first occurrence per phase; subsequent
  // occurrences in the same phase trigger the hard-stop fallback as
  // before. Forensic logging at every junction (chat.codex-stop-grace).
  let codexInspectSynthesisGrace = 1;
  let codexRepairActionGrace = 1;
  let codexInspectActionGrace = 1;
  // P3 — Doom-loop gate. Tracks the fingerprint of tool errors ACROSS
  // turns; when the same error repeats 3 times in a row we set a
  // hardStopText so the loop synthesises rather than retrying the same
  // broken dispatch forever. Window=3 mirrors opencode's
  // session/processor.ts DOOM_LOOP_THRESHOLD.
  const toolErrorDoomTracker = new DoomLoopTracker(3);
  // A (RESEARCH-autonomous-runaway-discipline-2026-07-19 R1) — the error tracker
  // above only fires on *failing* calls; identical *successful* calls (the model
  // re-reading / re-grepping the same file over and over — the grep-thrash that
  // dominated the B-integration stall) slip past it. With the codex exploration
  // streak-cut exempted to ∞ (frontier policy 2026-07-17), nothing bounds that
  // churn. Mirror gemini-cli loopDetectionService (TOOL_CALL_LOOP_THRESHOLD=5):
  // track identical successful tool calls in a sliding window and, on 5 in a
  // row, inject a one-shot converge nudge — WITHOUT capping exploration breadth,
  // so the open-exploration policy stays intact.
  const TOOL_REPEAT_WINDOW = 5;
  const toolRepeatTracker = new DoomLoopTracker(TOOL_REPEAT_WINDOW);
  const executionLoopState = createExecutionLoopState();
  // Debugging execution loop (PR #659) — tracks the last failed
  // RunShell/Bash command so repair + verify fallbacks can reference
  // it. Orthogonal to the doom tracker above: doom guards blind loops;
  // this one supplies context to the synthesise fallback.
  const verificationLoopState = createVerificationLoopState();

  // W5-E (2026-05-03 PM) — Force-synthesis attempt flag. Each
  // streamLLMWithTools invocation gets at most ONE force-synthesis
  // pass to avoid an infinite recovery loop if the model keeps
  // returning empty text. Read at the hardStopText emit site below
  // (line ~5132).
  let forceSynthesisAttempted = false;
  // Budget warning guard: sub-agents often burn their full turn budget
  // on Bash/Read/Grep research and hit maxTurns with tool_calls still
  // pending — i.e. they never write a final answer. The empty-turn
  // guard doesn't catch this because the turns aren't empty; they're
  // just wall-to-wall tool calls. Inject a synthesis reminder once,
  // after the turn threshold crosses BUDGET_WARNING_RATIO, so the
  // model has a few remaining turns to compose a text reply.
  //
  // We embed the warning in the LAST tool_result's content string
  // (rather than push a separate user message) to keep the wire-level
  // sequence legal on every provider: OpenAI requires role=tool
  // messages to IMMEDIATELY follow an assistant with tool_calls, and
  // Anthropic forbids consecutive same-role messages. Stuffing the
  // warning into the tool_result content is provider-agnostic.
  let budgetWarningInjected = false;

  // ★ agent-loop-substrate 조각1 — midloop 압축 circuit breaker(루프 로컬·3박자). 압축이 연속 임계회
  //   "발동했으나 못 줄임"(pathological — history 최소인데 임계 초과)이면 매 턴 재시도가 낭비·폭주다.
  //   breaker open 시 압축 스킵 + 관측(자기인지) + 힐 신호(관측이 후속 힐 입력). orchestrator 무관(루프 로컬).
  const { createCircuitBreaker: _makeBreaker } = require('./agent-substrate/circuit-breaker.js') as typeof import('./agent-substrate/circuit-breaker.js');
  const compactBreaker = _makeBreaker({ threshold: 3 });
  // ★ agent-loop-substrate 조각2 — pluggable context 전략(기본=2-tier compaction). 주입(opts.contextStrategy)으로
  //   read-time projection 등 교체. 문맥관리를 substrate 프리미티브로 통일(streamLLMWithTools 인라인 산재 해소).
  const { createDefaultContextStrategy: _makeContextStrategy } = require('./agent-substrate/context-strategy.js') as typeof import('./agent-substrate/context-strategy.js');
  const _contextStrategy = opts.contextStrategy ?? _makeContextStrategy();
  let loopTermination: 'budget-exhausted' | 'aborted' = 'budget-exhausted';
  let terminalTurn = maxTurns;

  for (let turn = 0; turn < maxTurns; turn++) {
    // ★ /cancel 범용화(대표 2026-07-12) — abort 신호가 오면 tool 루프를 즉시 중단한다. 이게 없으면
    //   fetch 는 abort 돼도 루프가 다음 turn 으로 계속 돌아 tool 반복(grep 폭주 등)이 멈추지 않는다.
    if (opts.signal?.aborted) {
      debug.log('llm.tools.aborted', 'user /cancel — tool loop stop', { turn });
      loopTermination = 'aborted';
      terminalTurn = turn;
      break;
    }
    // ⭐⭐⭐ `B3` — 다음 모델 요청을 «만들기 직전»에 대기 발화를 이력으로 배수한다(codex 동형).
    //   ⛔ 첫 바퀴(turn===0)는 «유예»한다 — 원래 입력이 먼저 샘플링돼야 한다(codex 의 예외 ⓐ).
    //   📌 문면은 `chat/interjection.ts` 가 소유한다 — 여기서 짓지 않는다(트리아지 리마인더 포함).
    if (turn > 0 && opts.drainPendingUserInput) {
      try {
        const pending = opts.drainPendingUserInput();
        if (pending.length > 0) {
          const { buildInterjectionMessage } = require('./chat/interjection.js') as typeof import('./chat/interjection.js');
          const message = buildInterjectionMessage(pending, 'mid-turn');
          if (message) {
            history.push({ role: 'user', content: message });
            debug.log('llm.interjection', 'drained-mid-turn', {
              turn, count: pending.length, chars: message.length,
            }, { level: 'info' });
          }
        }
      } catch (error) {
        // ⛔ 배수 실패가 턴을 죽이지 않는다 — 다만 «조용하지» 않게 남긴다.
        debug.log('llm.interjection', 'drain-failed', {
          turn, reason: error instanceof Error ? error.message : String(error),
        }, { level: 'warn' });
      }
    }
    let turnText = '';
    const pendingCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
      providerMeta?: ProviderToolMeta;
    }> = [];
    const turnStartedAt = Date.now();
    debug.log('llm.router', 'tool-loop.turn.start', {
      turn, historyLen: history.length,
    }, { level: 'info' });

    // Mid-loop context backstop — with the codex/unlimited tool-loop cap
    // removed, a long tool-heavy turn (esp. mission build) grows `history`
    // unbounded until it overflows the model context window and the provider
    // throws. ref codex / opencode bound exploration by COMPACTION, not a
    // turn counter — mirror that so removing the cap is safe. The cheap pass
    // (runCompactPipeline WITHOUT a provider) runs only Layer 1 (tool-output
    // budget) + Layer 2 (microcompact) — no LLM call, no cost — which targets
    // the tool_result bloat that dominates growth. Gated by chat.autoCompact
    // (opt-in); fail-soft so compaction never kills a turn.
    //
    // B (RESEARCH-autonomous-runaway-discipline-2026-07-19) — generalization:
    // the ∞-exploration policy (2026-07-17) removed the streak-cut betting on
    // "compaction as backstop", but the mid-loop backstop only ran the cheap
    // layers — so genuine conversation growth (not just tool bloat) had no net.
    // Now: if the cheap pass leaves usage STILL over the trigger ratio,
    // escalate to Layer 3 (LLM summarize via getDefaultCompactProvider) so an
    // autonomous run with no operator to /compact doesn't overflow and die.
    // Normal tool-bloat turns never reach the escalation → pay no LLM cost.
    if (turn > 0) {
      try {
        const { getUserConfig } = require('./user-config.js') as typeof import('./user-config.js');
        const acCfg = getUserConfig().chat?.autoCompact;
        if (acCfg?.enabled) {
          // ★ 조각1 breaker — 압축이 이미 무력 판정(open)이면 압축 워크 자체 스킵(폭주 차단·자기수복). 관측만.
          if (compactBreaker.state.open) {
            debug.log('llm.router', 'tool-loop.midloop-compact.breaker-skip', { turn, consecutiveFailures: compactBreaker.state.consecutiveFailures });
            if (opts.missionContext) debug.log('mission.walker', 'compact-breaker-skip', { ...opts.missionContext, turn, consecutiveFailures: compactBreaker.state.consecutiveFailures });
          } else {
            // ★ 조각2 — pluggable context 전략(기본=2-tier compaction·무회귀 이관). 판정+압축을 substrate 프리미티브가
            //   수행 → caller 는 splice/관측/breaker 만. 주입(opts.contextStrategy)으로 read-time projection 등 교체 가능.
            const beforeLen = history.length;
            const outcome = await _contextStrategy.compact(history, { model: effectiveModel, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}), config: acCfg });
            if (outcome.fired && outcome.reduced) {
              history.splice(0, history.length, ...outcome.messages);
              // ★ 관측(2026-07-21) — beforeTokens/afterTokens 포함(reduced 는 개수 아닌 **토큰** 감소로 판정).
              //   다음 compact-breaker 폭발 시 실제 크기 추이를 조회 가능하게(진단 seam).
              const compactData = { turn, beforeLen, afterLen: history.length, beforeTokens: outcome.beforeTokens, afterTokens: outcome.afterTokens, escalated: outcome.escalated, ratio: outcome.ratio, usedTokens: outcome.usedTokens };
              debug.log('llm.router', 'tool-loop.midloop-compact', compactData);
              // ★ C1(문맥관리 트랙) — 미션 walker 압축을 observe-gate 1급 이벤트로(missionId/phaseId 상관 복원).
              if (opts.missionContext) {
                debug.log('mission.walker', 'compact', { ...opts.missionContext, ...compactData });
                // ★ C4(문맥관리 트랙) — 압축이 파일 내용을 요약으로 축약했을 수 있으니 walker 에게 재-read 지시(경량 시스템 메시지).
                history.push({ role: 'system', content: MISSION_COMPACT_REREAD_HINT });
              }
              compactBreaker.record('success'); // ★ 조각1 — 압축 유효 → breaker 회복(연속실패 리셋)
            } else if (outcome.fired) {
              // ★ 조각1 — 압축 발동했으나 못 줄임(pathological·**토큰** 무감소) → failure 누적. 트립 시 관측(자기인지)+힐 신호.
              //   beforeTokens/afterTokens 를 남겨 "정말 못 줄인 것"인지(오판 아님) 진단 가능하게.
              debug.log('llm.router', 'tool-loop.midloop-compact.no-reduce', { turn, beforeTokens: outcome.beforeTokens, afterTokens: outcome.afterTokens, escalated: outcome.escalated });
              const brk = compactBreaker.record('failure', 'compaction-no-reduce');
              if (brk.tripped) {
                debug.log('llm.router', 'tool-loop.midloop-compact.breaker-open', { turn, consecutiveFailures: brk.state.consecutiveFailures, threshold: brk.state.threshold, beforeTokens: outcome.beforeTokens, afterTokens: outcome.afterTokens });
                if (opts.missionContext) debug.log('mission.walker', 'compact-breaker-open', { ...opts.missionContext, turn, consecutiveFailures: brk.state.consecutiveFailures, reason: 'compaction-no-reduce', beforeTokens: outcome.beforeTokens, afterTokens: outcome.afterTokens });
                // ★ 과부하 신호 배선(2026-07-21) — breaker-open(mid-turn 컨텍스트 폭발)을 walker 래퍼로 흘려
                //   자율 split/재조정 폐루프가 소비하게 한다(종전엔 debug.log 만·소비자 0). 관측/압축 로직 불변(추가만).
                opts.missionContext?.onOverload?.({ turn, consecutiveFailures: brk.state.consecutiveFailures, reason: 'compaction-no-reduce' });
              }
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        debug.log('llm.router', 'tool-loop.midloop-compact.error', { turn, error: errMsg }, { level: 'error' });
        const brk = compactBreaker.record('failure', 'compaction-error'); // ★ 조각1 — 에러도 failure 누적
        if (opts.missionContext) {
          debug.log('mission.walker', 'compact-error', { ...opts.missionContext, turn, error: errMsg }, { level: 'error' });
          if (brk.tripped) {
            debug.log('mission.walker', 'compact-breaker-open', { missionId: opts.missionContext.missionId, phaseId: opts.missionContext.phaseId, turn, consecutiveFailures: brk.state.consecutiveFailures, reason: 'compaction-error' });
            opts.missionContext.onOverload?.({ turn, consecutiveFailures: brk.state.consecutiveFailures, reason: 'compaction-error' });
          }
        }
      }
    }

    // Turn-0-only tool_choice forcing: apply opts.toolChoice on the first turn
    // (force a/some tool call), then revert to auto so the model can emit a final
    // text answer. Blanket forcing every turn would make the loop never terminate
    // (the only exit is a no-tool-call text turn — llm.ts). Providers that don't
    // read toolChoice (Anthropic/gemini) ignore it → no-op, safe when mixed.
    // `tools: activeTools` (not opts.tools) so mid-loop hydration reaches the
    // provider on the next turn. turn-0 keeps opts.toolChoice; later turns
    // revert to auto (see above).
    const buildTurnOpts = () => {
      const remainingFallbacks = opts.provider ? 0 : remainingFallbackProviderNames(attemptedProviders, opts).length;
      const base = { ...opts, model: activeModel, tools: activeTools, remainingFallbacks };
      return turn === 0 ? base : { ...base, toolChoice: undefined };
    };
    let turnOpts = buildTurnOpts();
    // reasoning-heavy family(codex/claude/gemini/grok/local)는 침묵 추론 구간이 길어 idle watchdog 를
    // family-aware 로 상향(2026-07-19 goal-exec → 아크4 전-family). fast/mini(gpt·other)만 45s 유지.
    const streamIdleTimeoutMs = usesLongReasoningIdle(modelFamily, activeProvider.name) ? STREAM_IDLE_TIMEOUT_MS_REASONING : STREAM_IDLE_TIMEOUT_MS;
    // ⚠️ hang 진단(2026-07-17) — codex SSE 스트림이 완료 신호 없이 안 끝나는 케이스 확정용.
    // consume-start 후 consume-end 가 없으면 = for-await(streamChat SSE) hang. lastEvType 로 어느
    // 이벤트 뒤에서 멈추는지(usage/text/tool_call) 특정. 무장할 상한도 남겨 실험 런을 구별한다.
    debug.log('llm.stream', 'consume-start', {
      turn,
      provider: activeProvider.name,
      model: activeModel,
      idleMs: streamIdleTimeoutMs,
      ...(modelFamily !== 'other' ? { modelFamily } : {}),
    });
    let evCount = 0;
    let lastEvType = 'none';
    // ⚠️ idle watchdog(2026-07-17) — codex SSE 가 완료 신호 없이 hang 하는 간헐 케이스 방어. 각
    // 이벤트 대기를 idle timeout 과 race — STREAM_IDLE_TIMEOUT_MS 무이벤트면 스트림 정리·탈출(받은
    // 텍스트로 진행). 35분 무한 hang → 자동 복구. 원인 규명은 consume-end 부재/idle-timeout 로그가.
    let streamIter: AsyncIterator<LLMStreamEvent> | undefined;
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let step: { idle: true } | { idle: false; r: IteratorResult<LLMStreamEvent, void> };
      try {
        if (!streamIter) {
          const finalized = finalizeStreamingProviderModel(activeProvider, activeModel);
          activeProvider = finalized.provider;
          activeModel = finalized.model;
          turnOpts = { ...turnOpts, model: activeModel };
          streamIter = activeProvider.streamChat!(history, turnOpts)[Symbol.asyncIterator]();
        }
        step = await Promise.race([
          streamIter.next().then((r) => ({ idle: false as const, r })),
          new Promise<{ idle: true }>((res) => { idleTimer = setTimeout(() => res({ idle: true }), streamIdleTimeoutMs); }),
        ]);
      } catch (err) {
        if (idleTimer) clearTimeout(idleTimer);
        if (err instanceof OverloadFailoverError && !opts.provider) {
          const switched = providerByName('grok');
          if (switched && !attemptedProviders.has(switched.name) && switched.available() && evCount === 0) {
            debug.log('llm.router', 'overload-failover', {
              turn,
              blockedProvider: activeProvider.name,
              fallbackProvider: switched.name,
              streak: err.streak,
              status: err.status,
              kind: err.kind,
            }, { level: 'warn' });
            const finalized = finalizeStreamingProviderModel(switched, switched.defaultModel);
            activeProvider = finalized.provider;
            activeModel = finalized.model;
            attemptedProviders.add(activeProvider.name);
            turnOpts = buildTurnOpts();
            streamIter = undefined;
            continue;
          }
        }
        // 명시 provider 선택만 폴백 대상이 아니다 — `streamLLM` 과 같은 계약으로
        // «원본 오류»를 그대로 올린다. 모델만 전달된 호출은 다음 provider의 기본 모델로 재시도한다.
        if (opts.provider) throw err;
        const remaining = evCount === 0
          ? remainingFallbackProviderNames(attemptedProviders, opts)
          : [];
        const verdict = decideProviderFallback({
          err,
          failedProvider: activeProvider.name,
          remainingProviders: remaining,
          attempted: blockedProviders,
        });
        blockedProviders = [...verdict.attempts];
        const fallback = verdict.action === 'advance' ? providerByName(verdict.nextProvider) : undefined;
        if (!fallback) {
          const terminal = terminalFallbackVerdict(
            verdict,
            blockedProviders,
            verdict.action === 'stop' ? verdict.reason : 'fallback candidates exhausted',
          );
          debug.log('llm.router', terminal.action === 'exhaust' ? 'provider-fallback-exhausted' : 'provider-fallback-stop', {
            blockedProviders,
            category: terminal.category,
            reason: terminal.reason,
          }, { level: 'error' });
          if (terminal.action === 'stop') throw err;
          throw new ProviderFallbackError(terminal, err);
        }
        debug.log('llm.router', 'provider-fallback', {
          turn,
          blockedProvider: activeProvider.name,
          fallbackProvider: fallback.name,
          reason: sanitizeProviderFailureReason(err instanceof Error ? err.message : String(err)),
          category: verdict.category,
          tools: activeTools.map((tool) => tool.name),
          ...(opts.model ? { modelOverrideDropped: opts.model } : {}),
        }, { level: 'warn' });
        const finalized = finalizeStreamingProviderModel(fallback, fallback.defaultModel);
        activeProvider = finalized.provider;
        activeModel = finalized.model;
        attemptedProviders.add(activeProvider.name);
        turnOpts = buildTurnOpts();
        streamIter = undefined;
        continue;
      }
      if (idleTimer) clearTimeout(idleTimer);
      if (step.idle) {
        debug.log('llm.stream', 'idle-timeout', { turn, evCount, lastEvType, idleMs: streamIdleTimeoutMs, textChars: turnText.length, pendingCalls: pendingCalls.length }, { level: 'warn' });
        try { await streamIter.return?.(undefined); } catch { /* fail-soft — 스트림 정리 실패 무시 */ }
        break;
      }
      if (step.r.done) break;
      const ev = step.r.value;
      evCount++;
      lastEvType = ev.type;
      if (ev.type === 'text') {
        turnText += ev.delta;
        fullText += ev.delta;
        handlers.onText(ev.delta, fullText);
      } else if (ev.type === 'tool_call') {
        pendingCalls.push({
          id: ev.id,
          name: ev.name,
          args: ev.args,
          ...(ev.providerMeta !== undefined ? { providerMeta: ev.providerMeta } : {}),
        });
      } else if (ev.type === 'reasoning') {
        // Forward to the optional reasoning handler. Codex Responses
        // API emits `summary_part_added` (paragraph break) +
        // `summary_delta` (incremental text). LM Studio (qwen 3.6 /
        // qwen3 thinking / gpt-oss) emits `inline_delta` from the
        // OpenAI-compat `delta.reasoning_content` field — same
        // consumer-side semantics as summary_delta, no part index.
        // Callers that don't render reasoning skip silently.
        if (ev.kind === 'summary_part_added') {
          handlers.onReasoning?.({
            kind: 'summary_part_added',
            ...(ev.summaryIndex !== undefined ? { summaryIndex: ev.summaryIndex } : {}),
          });
        } else if (ev.kind === 'summary_delta') {
          handlers.onReasoning?.({
            kind: 'summary_delta',
            delta: ev.delta,
            ...(ev.summaryIndex !== undefined ? { summaryIndex: ev.summaryIndex } : {}),
          });
        } else {
          handlers.onReasoning?.({
            kind: 'summary_delta',
            delta: ev.delta,
          });
        }
      } else if (ev.type === 'image') {
        // Y2·1 (2026-05-17) — forward Codex server-tool image result.
        // Only fires when caller opted into opts.serverTools.imageGeneration
        // and the model invoked the built-in tool. No-op when handler
        // is absent — image silently drops (consumer chose not to render).
        handlers.onImage?.({
          mediaType: ev.mediaType,
          data: ev.data,
          ...(ev.source !== undefined ? { source: ev.source } : {}),
          ...(ev.revisedPrompt !== undefined ? { revisedPrompt: ev.revisedPrompt } : {}),
        });
      } else if (ev.type === 'usage') {
        // ⭐ 주 에이전트 턴의 토큰·비용을 «게이트 없이» 남긴다(2026-09-24 실측: 이 줄이 없어 3시간 `llm.usage`
        //   18행이 전부 곁가지 두 자리였고, 하니스 런 비용의 거의 전부가 관측 밖이었다). 곁가지와 같은 모양 ·
        //   모르는 모델은 금액 대신 `cost.kind='unknown'`. runId 는 debug.log 가 붙인다. 실패해도 턴은 계속.
        logAgentTurnUsage(activeModel, ev.usage, { providerName: activeProvider.name, role: opts.usageRole });
        // Wave A1 (2026-05-04) — turn-level cache hit rate forensic.
        // Each provider's usage event carries inputTokens / outputTokens
        // / cacheReadInputTokens (when cache hit). Emit the per-turn
        // hit-rate ratio so log filters (`grep chat.cache.turn`) +
        // session-cumulative metrics module (recordUsage in callers)
        // converge — the turn line lets the user spot when a *single*
        // turn collapsed cache (e.g. system prompt edited mid-session),
        // while the session summary lets them spot drift across many
        // turns. Best-effort — never throws or blocks.
        if (debug.enabled) {
          const u = ev.usage;
          const denom = (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
          const hitRatePct = denom > 0 && (u.cacheReadInputTokens ?? 0) > 0
            ? Math.round(((u.cacheReadInputTokens ?? 0) / denom) * 100)
            : 0;
          debug.log('chat.cache.turn', 'usage', {
            provider: u.provider ?? 'unknown',
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
            cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
            hitRatePct,
          });
          // Threshold alarm — a turn that should have hit cache (input
          // > 1K tokens, presumably with system prompt) but didn't is a
          // signal that cache slot was just invalidated. Log a warn
          // event so it stands out from normal usage lines.
          if ((u.inputTokens ?? 0) > 1000 && hitRatePct < 10) {
            debug.log('chat.cache.turn', 'low-hit-rate.warn', {
              provider: u.provider ?? 'unknown',
              inputTokens: u.inputTokens ?? 0,
              hitRatePct,
              hint: 'system prompt or tool list may have just changed; check chat.cache.dim signature delta',
            }, { level: 'warn' });
          }
        }
        handlers.onUsage?.(ev.usage);
      }
    }

    // hang 진단 — for-await(SSE 스트림) 정상 종료 확정. 이 로그가 없으면 codex SSE 스트림 hang.
    debug.log('llm.stream', 'consume-end', { turn, evCount, lastEvType, textChars: turnText.length, pendingCalls: pendingCalls.length });
    const turnInfo = {
      turn,
      durationMs: Date.now() - turnStartedAt,
      textChars: turnText.length,
      pendingCalls: pendingCalls.map(c => c.name),
    };
    debug.log('llm.router', 'tool-loop.turn.end', turnInfo, { level: 'info' });
    // ★ walker turn 관측(2026-07-21·제1원칙 로그축) — 미션 walker turn 진행을 mission.walker 로 1급 각인.
    //   종전엔 turn 신호가 llm.router 에만 있어(미션 좌표 無) "walker 가 지금 몇 턴째·무슨 tool 을 부르며 도는가"를
    //   elanous logs --category mission.walker 로 조회 불가 → 라이브 705308 에서 정상 turn 진행조차 ps CPU 로만
    //   겨우 판별(hang 오판 직전). missionContext 있을 때만(일반 chat/LLM 무영향). 요약만(verbose 방지).
    //   ★조회: elanous logs --category mission.walker (event=turn). liveness(point5) last-activity 재료.
    if (opts.missionContext) debug.log('mission.walker', 'turn', { ...opts.missionContext, turn, maxTurns, toolCalls: turnInfo.pendingCalls, respChars: turnInfo.textChars, elapsedMs: turnInfo.durationMs });
    handlers.onTurnEnd?.(turnInfo);

    // ★ CW3 signal control(RFC-coordinator-walker-control-plane P4·2026-07-21·제1원칙 수신↓) — 바로 위
    //   turn 관측(방출↑)의 대칭 수신. 조율자가 중앙 State signal 채널에 쓴 mid-phase 신호를 walker 가 매 turn
    //   폴링·graceful 수신(abort/pause→지금까지 결과 반환·다음 turn 미진입). 종전엔 cancel=SIGTERM kill·pause=
    //   phase 경계뿐이라 mid-phase 양방향 채널 0(audit #59 (b)). missionContext.pollSignal 미주입 시 완전 무동작
    //   (무회귀·일반 chat/LLM 무영향). ★조회: elanous logs --category mission.walker (event=signal-received).
    if (opts.missionContext?.pollSignal) {
      const sig = opts.missionContext.pollSignal();
      if (sig && (sig.kind === 'abort' || sig.kind === 'pause')) {
        debug.log('mission.walker', 'signal-received', { missionId: opts.missionContext.missionId, phaseId: opts.missionContext.phaseId, turn, kind: sig.kind, reason: sig.reason ?? null });
        const finalText = finalizeVisibleAssistantText(fullText, turnText, sawToolRound);
        emitTurnComplete(finalText);
        return finalText;
      }
    }

    // No tool calls + non-empty text = the model gave its final answer.
    if (pendingCalls.length === 0 && turnText.length > 0) {
      const visibleText = finalizeVisibleAssistantText(fullText, turnText, sawToolRound);
      const finalization = buildFinalizationPolicySnapshot(
        autoNarrowedInspections,
        editedFilePaths,
        executionLoopState,
        verificationLoopState,
      );
      const finalText = maybeEnrichFinalAnswerWithFinalizationSnapshot(
        visibleText,
        editedFilePaths,
        verificationLoopState,
        finalization,
      );
      if (finalText !== fullText) handlers.onText('', finalText);
      emitTurnComplete(finalText);
      return finalText;
    }

    // No tool calls + empty text = model stalled. Re-prompt up to
    // MAX_EMPTY_RETRIES times. Beyond that, return an explicit
    // no-synthesis notice instead of silently ending the turn empty.
    if (pendingCalls.length === 0 && turnText.length === 0) {
      if (emptyRetries >= MAX_EMPTY_RETRIES) {
        const notice = buildNoFinalSynthesisNotice('empty-turn');
        const finalText = finalizeVisibleAssistantText(
          appendFinalSynthesisNotice(fullText, notice),
          notice,
          sawToolRound,
        );
        handlers.onText('', finalText);
        debug.log('llm.router', 'tool-loop.empty-turn.give-up', {
          turn, emptyRetries, finalTextInjected: true,
        });
        emitTurnComplete(finalText);
        return finalText;
      }
      emptyRetries++;
      debug.log('llm.router', 'tool-loop.empty-turn.retry', {
        turn, emptyRetries, remaining: MAX_EMPTY_RETRIES - emptyRetries,
      });
      history.push({
        role: LOOP_SELF_NOTE_ROLE,
        content:
          'Your previous turn produced no text and no tool calls. ' +
          'If the task is complete, emit your FINAL ANSWER as plain text now. ' +
          'If the task requires spawning sub-agents (via the Agent tool per the SKILL.md), ' +
          'make those Agent() calls now — do not stop without either producing output OR ' +
          'invoking Agent/Bash/Read/etc. to make progress.',
      });
      continue;
    }

    if (turnText.length > 0) {
      clearVisibleAssistantTextForToolRound(handlers, sawToolRound);
    }
    sawToolRound = true;
    const wasExploratoryTurn = isExploratoryTurn(pendingCalls);
    const prevExploratoryStreak = exploratoryTurnStreak;
    exploratoryTurnStreak = wasExploratoryTurn ? exploratoryTurnStreak + 1 : 0;
    // W6-A — Track search-only streak (Grep / Glob / ListDir only).
    // Increment on a search-only turn; reset to 0 the moment any other
    // tool fires (Read / Lsp / Bash / Edit). The dispatchOne layer
    // reads this counter to decide when to inject a force-Read stub.
    const wasSearchOnlyTurn = isSearchOnlyTurn(pendingCalls);
    searchOnlyTurnStreak = wasSearchOnlyTurn ? searchOnlyTurnStreak + 1 : 0;
    // W5-G — Tool-agnostic content-fetch-absent streak. Resets only when
    // codex actually fires Read/Edit/Write/Lsp; Bash(`rg --files`) /
    // shell / Grep / Glob / ListDir all count toward the streak.
    const wasNoContentReadTurn = isNoContentReadTurn(pendingCalls);
    noContentReadTurnStreak = wasNoContentReadTurn ? noContentReadTurnStreak + 1 : 0;
    if (debug.enabled && (wasExploratoryTurn || prevExploratoryStreak > 0)) {
      const willEnterExplorationSynthesis =
        wasExploratoryTurn
        && exploratoryTurnStreak >= explorationThresholdForTurn
        && prevExploratoryStreak < explorationThresholdForTurn;
      debug.log('llm.router', 'tool-loop.exploratory-streak', {
        turn,
        prevStreak: prevExploratoryStreak,
        nextStreak: exploratoryTurnStreak,
        wasExploratoryTurn,
        explorationThresholdForTurn,
        explorationUnbounded,  // ★ true = 프론티어 면제(스트릭 컷 없음·대표 방침 2026-07-17)
        willEnterExplorationSynthesis,
        pendingCallNames: pendingCalls.map(c => c.name),
        autoNarrowedReadCount,
      });
    }

    // Assistant turn: text (if any) + one tool_use block per call.
    const assistantBlocks: ContentBlock[] = [];
    if (turnText) assistantBlocks.push({ type: 'text', text: turnText });
    for (const call of pendingCalls) {
      assistantBlocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.args,
        ...(call.providerMeta !== undefined ? { providerMeta: call.providerMeta } : {}),
      });
    }
    history.push({ role: 'assistant', content: assistantBlocks });

    // Final-synthesis window: in the last FINAL_SYNTHESIS_TURNS of the
    // budget, refuse to execute tool calls. Each pending call gets a
    // stub tool_result telling the model its budget is exhausted and
    // text is the only acceptable output next turn. We observed (see
    // log/debug-20260415134119.log, Agent cid=66b7c43f) that the soft
    // budget warning is routinely ignored by gpt-5.4: the model sees
    // the notice in a tool_result but keeps making tool calls until
    // maxTurns hard-stops it, producing 0 chars of output. Hard
    // rejection forces the synthesis that soft pressure couldn't.
    const inSynthesisPhase =
      maxTurns >= BUDGET_WARNING_MIN_TURNS
      && turn >= maxTurns - FINAL_SYNTHESIS_TURNS;
    const codexInspectionStillProgressing =
      modelFamily === 'codex'
      && autoNarrowedReadCount > 0
      && autoNarrowedReadCount < inspectBudgetThreshold;
    const inExplorationSynthesisPhase =
      exploratoryTurnStreak >= explorationThresholdForTurn
      && isExploratoryTurn(pendingCalls)
      && !codexInspectionStillProgressing;
    const inInspectSynthesisPhase =
      inspectSynthesisArmed
      && inspectFollowupMode === 'synthesis'
      && pendingCalls.length > 0;
    const inInspectActionPhase =
      inspectSynthesisArmed
      && inspectFollowupMode === 'action'
      && !verifyActionArmed
      && pendingCalls.length > 0
      && !isInspectActionTurn(pendingCalls);
    const inInspectExecutionPhase =
      inspectSynthesisArmed
      && inspectFollowupMode === 'execution'
      && !repairActionArmed
      && !verifyActionArmed
      && pendingCalls.length > 0
      && !isExecutionActionTurn(pendingCalls);
    const inRepairActionPhase =
      repairActionArmed
      && !verifyActionArmed
      && pendingCalls.length > 0
      && !isRepairActionTurn(pendingCalls);
    const inVerifyActionPhase =
      verifyActionArmed
      && pendingCalls.length > 0
      && !isVerifyActionTurn(pendingCalls);
    const inInspectFollowupPhase =
      inInspectSynthesisPhase || inInspectActionPhase || inInspectExecutionPhase || inRepairActionPhase || inVerifyActionPhase;
    const inspectFollowupPhase: ToolLoopFollowupPhase | null =
      inInspectSynthesisPhase ? 'inspect-synthesis'
      : inInspectActionPhase ? 'inspect-action'
      : inInspectExecutionPhase ? 'inspect-execution'
      : inRepairActionPhase ? 'repair-action'
      : inVerifyActionPhase ? 'verify-action'
      : null;
    let hardStopText: string | null = null;
    let hardStopReason: string | null = null;
    // Deferred user note pushed AFTER the tool_result blocks land in
    // history later in this turn — keeps the assistant→tool→user wire
    // order intact. Set by the doom-loop ASK routing when the user
    // chose retry or supplied guidance.
    let postToolResultUserNote: string | null = null;

    if (inInspectFollowupPhase || inExplorationSynthesisPhase || inSynthesisPhase) {
      debug.log('llm.router', 'tool-loop.followup-phase-entered', {
        turn,
        maxTurns,
        pendingTools: pendingCalls.map(c => c.name),
        inspectFollowupMode,
        inSynthesisPhase,
        inExplorationSynthesisPhase,
        inInspectSynthesisPhase,
        inInspectActionPhase,
        inInspectExecutionPhase,
        inRepairActionPhase,
        inVerifyActionPhase,
        autoNarrowedReadCount,
        exploratoryTurnStreak,
        inspectSynthesisArmed,
        repairActionArmed,
        verifyActionArmed,
        lastExecutionCommand: executionLoopState.lastCommand,
        lastVerificationCommand: verificationLoopState.lastCommand,
      });
    }

    // User turn: dispatch all pending calls, collect results as tool_result blocks.
    // Followup action phases reject only calls outside their existing allowlist;
    // the allowed calls continue through the normal dispatch path below.
    const resultBlocks: ContentBlock[] = [];
    let callsToDispatch = pendingCalls;
    let appendedToolResultNotice: string | null = null;
    let phaseRejectionMessage: string | null = null;
    const phaseRejectedCalls = getToolLoopPhaseRejectedCalls(inspectFollowupPhase, pendingCalls);
    const phaseRejectedCallIds = new Set(phaseRejectedCalls.map((call) => call.id));
    const rejectsWholeBatch = inSynthesisPhase || inExplorationSynthesisPhase || inInspectSynthesisPhase;
    if (rejectsWholeBatch || phaseRejectedCalls.length > 0) {
      const rejectedCalls = rejectsWholeBatch ? pendingCalls : phaseRejectedCalls;
      const executedCalls = rejectsWholeBatch ? [] : pendingCalls.filter((call) => !phaseRejectedCallIds.has(call.id));
      const rejectionMsg =
        inspectFollowupPhase
          ? buildToolLoopPhaseRejectionMessage(
            inspectFollowupPhase,
            rejectedCalls.map(c => c.name),
            autoNarrowedReadCount,
            executedCalls.map(c => c.name),
          )
          : inExplorationSynthesisPhase
          ? (
            `EXPLORATION BUDGET EXHAUSTED — already spent ${exploratoryTurnStreak} consecutive turns on read/search tools ` +
            `(${pendingCalls.map(c => c.name).join(', ')}). ` +
            'Stop gathering more files and synthesize from the current findings.'
          )
          : (
        `TOOL CALL REJECTED — tool-loop budget exhausted at ${turn + 1}/${maxTurns} turns. ` +
        'Your next assistant turn must be plain text final synthesis using the information already gathered.'
          );
      phaseRejectionMessage = rejectionMsg;
      if (rejectsWholeBatch) {
        callsToDispatch = [];
        for (const call of rejectedCalls) {
          resultBlocks.push({ type: 'tool_result', tool_use_id: call.id, content: rejectionMsg });
        }
      }
      // P2 (2026-05-03) — Three predicates as before, but each now consults
      // a per-phase grace counter (initialized to 1 at the loop top).
      // First trip → grace decrement + soft rejection (model gets the
      // stub, can recover next turn). Second trip → hard-stop fallback
      // as in the original PR #768 design. Forensic events at both the
      // grace-burn and the hard-stop branches so log/latest can audit
      // exactly which path each turn took.
      const codexImmediateInspectStop = inInspectSynthesisPhase && modelFamily === 'codex';
      const codexImmediateRepairStop = inRepairActionPhase && modelFamily === 'codex';
      // codexImmediateInspectActionStop predicate (PR #768 original):
      // restricted to pure-exploration state (no edits applied AND no
      // execution attempted). When edits/execution already happened the
      // existing 2-rejection path is kept so the finalization snapshot
      // logic (`buildFinalizationPolicySnapshot` → `[FINAL ANSWER
      // REQUIRED]`) can run — that branch produces a tailored "verify
      // done, just write the answer" UX which we must not preempt.
      const codexImmediateInspectActionStop =
        inInspectActionPhase
        && modelFamily === 'codex'
        && !verifyActionArmed
        && editedFilePaths.length === 0
        && !executionLoopState.lastCommand;
      if (codexImmediateInspectStop && codexInspectSynthesisGrace <= 0) {
        debug.log('llm.router', 'tool-loop.inspect-synthesis-phase.codex-immediate-stop', {
          turn,
          maxTurns,
          autoNarrowedReadCount,
          rejectedTools: pendingCalls.map(c => c.name),
          rejectedCount: pendingCalls.length,
          graceConsumed: true,
        });
        hardStopText = buildInspectFallbackSummary(autoNarrowedInspections);
        hardStopReason = 'codex-inspect-synthesis-immediate-stop';
      } else if (codexImmediateRepairStop && codexRepairActionGrace <= 0) {
        debug.log('llm.router', 'tool-loop.repair-phase.codex-immediate-stop', {
          turn,
          maxTurns,
          rejectedTools: pendingCalls.map(c => c.name),
          rejectedCount: pendingCalls.length,
          lastFailedExecutionCommand: executionLoopState.lastCommand,
          graceConsumed: true,
        });
          hardStopText = buildExecutionFailureFallbackFromLoopState(
            autoNarrowedInspections,
            executionLoopState,
            verificationLoopState,
          );
          hardStopReason = 'codex-repair-immediate-stop';
      } else if (codexImmediateInspectActionStop && codexInspectActionGrace <= 0) {
        debug.log('llm.router', 'tool-loop.inspect-action-phase.codex-immediate-stop', {
          turn,
          maxTurns,
          autoNarrowedReadCount,
          inspectionCount: autoNarrowedInspections.length,
          rejectedTools: pendingCalls.map(c => c.name),
          rejectedCount: pendingCalls.length,
          graceConsumed: true,
        });
        hardStopText = autoNarrowedInspections.length > 0
          ? `${buildIgnoredActionNotice()}\n\n${buildInspectActionFallback(autoNarrowedInspections)}`
          : buildIgnoredActionNotice();
        hardStopReason = 'codex-inspect-action-immediate-stop';
      } else {
        // P2 — Grace burn. When a codex-immediate predicate held this
        // turn but grace > 0, decrement the per-phase counter and let
        // the dispatch fall through to the soft-rejection path (the
        // for-loop below). The model receives the rejectionMsg as a
        // tool_result and gets a chance to recover on the next turn.
        // If the predicate fires again on the next turn, the grace
        // will be 0 → hard-stop branches above will fire.
        if (codexImmediateInspectStop && codexInspectSynthesisGrace > 0) {
          codexInspectSynthesisGrace--;
          // ⛔ 위 repair-phase 와 «같은 계약» — 유예 소진은 셀프힐 사건이므로 게이트 밖.
          debug.log('llm.router', 'tool-loop.inspect-synthesis-phase.codex-grace-burned', {
            turn,
            maxTurns,
            autoNarrowedReadCount,
            graceRemaining: codexInspectSynthesisGrace,
            rejectedTools: pendingCalls.map(c => c.name),
          });
        }
        if (codexImmediateRepairStop && codexRepairActionGrace > 0) {
          codexRepairActionGrace--;
          // ⛔⭐⭐⭐ 셀프힐이 «일어난» 사건은 debug 게이트 «밖»에 둔다.
          //   CLAUDE.md 넘버원 룰: *"셀프힐 결정은 관측 관문(observe)"*.
          //   🚨 이 줄은 ***수리 유예를 한 칸 태운 사건***이다 — 즉 셀프힐 «그 자체»다.
          //   `if (debug.enabled)` 는 핫패스 게이트라 «운영에서 꺼진다» ⇒ 그 사건이 조회에 안 남는다.
          //   ⭐ 비용 없음 — 이 블록은 이미 «드문 분기»(수리 정지 ⊕ 유예 잔량>0) 안이다.
          //   🪞 같은 형태를 #12766(앵커 절단) · #12816(자식 앵커 결손)이 이미 닫았다.
          debug.log('llm.router', 'tool-loop.repair-phase.codex-grace-burned', {
            turn,
            maxTurns,
            graceRemaining: codexRepairActionGrace,
            rejectedTools: pendingCalls.map(c => c.name),
            lastFailedExecutionCommand: executionLoopState.lastCommand,
          });
        }
        if (codexImmediateInspectActionStop && codexInspectActionGrace > 0) {
          codexInspectActionGrace--;
          // ⛔ 셋째 유예 축. 셋이 «같은 형태»라 하나만 열면 조회가 또 반쪽이 된다.
          debug.log('llm.router', 'tool-loop.inspect-action-phase.codex-grace-burned', {
            turn,
            maxTurns,
            autoNarrowedReadCount,
            graceRemaining: codexInspectActionGrace,
            rejectedTools: pendingCalls.map(c => c.name),
          });
        }
      }
      const rejectionLog = inspectFollowupPhase
        ? buildToolLoopPhaseRejectionLog(inspectFollowupPhase, {
          turn,
          maxTurns,
          exploratoryTurnStreak,
          inspectSynthesisArmed,
          autoNarrowedReadCount,
          rejectedTools: rejectedCalls.map(c => c.name),
          rejectedCount: rejectedCalls.length,
        })
        : null;
      debug.log(
        'llm.router',
        rejectionLog?.event
          ?? (inExplorationSynthesisPhase
            ? 'tool-loop.exploration-synthesis-phase.tool-rejected'
            : 'tool-loop.synthesis-phase.tool-rejected'),
        rejectionLog?.payload
          ?? {
            turn,
            maxTurns,
            exploratoryTurnStreak,
            inspectSynthesisArmed,
            autoNarrowedReadCount,
            rejectedTools: pendingCalls.map(c => c.name),
            rejectedCount: pendingCalls.length,
          },
      );
      if (codexImmediateInspectStop || codexImmediateRepairStop || codexImmediateInspectActionStop) {
        inspectRejectionCount = 1;
        explorationRejectionCount = 0;
        synthesisRejectionCount = 0;
      } else if (inInspectSynthesisPhase) {
        inspectRejectionCount++;
        explorationRejectionCount = 0;
        synthesisRejectionCount = 0;
        if (modelFamily === 'codex' || inspectRejectionCount >= 2) {
          hardStopText = buildIgnoredSynthesisNotice('inspect');
        }
      } else if (inInspectActionPhase) {
        inspectRejectionCount++;
        explorationRejectionCount = 0;
        synthesisRejectionCount = 0;
        if (inspectRejectionCount >= 2) {
          const finalization = buildFinalizationPolicySnapshot(
              autoNarrowedInspections,
              editedFilePaths,
              executionLoopState,
              verificationLoopState,
            );
          if (finalization.forceFinalAnswer) {
            hardStopText = buildFinalAnswerRequiredFallbackFromSnapshot(
              editedFilePaths,
              verificationLoopState,
              finalization,
            );
          } else {
            hardStopText = autoNarrowedInspections.length > 0
              ? `${buildIgnoredActionNotice()}\n\n${buildInspectActionFallback(autoNarrowedInspections)}`
              : buildIgnoredActionNotice();
          }
        }
      } else if (inInspectExecutionPhase) {
        inspectRejectionCount++;
        explorationRejectionCount = 0;
        synthesisRejectionCount = 0;
        if (inspectRejectionCount >= 2) {
          hardStopText = autoNarrowedInspections.length > 0
            ? `${buildIgnoredExecutionNotice()}\n\n${buildInspectExecutionFallback(autoNarrowedInspections)}`
            : buildIgnoredExecutionNotice();
        }
      } else if (inRepairActionPhase) {
        inspectRejectionCount++;
        explorationRejectionCount = 0;
        synthesisRejectionCount = 0;
        if (inspectRejectionCount >= 2) {
          const finalization = buildFinalizationPolicySnapshot(
              autoNarrowedInspections,
              editedFilePaths,
              executionLoopState,
              verificationLoopState,
            );
          if (finalization.forceFinalAnswer) {
            hardStopText = buildFinalAnswerRequiredFallbackFromSnapshot(
              editedFilePaths,
              verificationLoopState,
              finalization,
            );
          } else {
            hardStopText = `${buildIgnoredActionNotice()}\n\n${buildRepairFallbackFromLoopState(
              autoNarrowedInspections,
              editedFilePaths,
              executionLoopState,
              verificationLoopState,
            )}`;
          }
        }
      } else if (inVerifyActionPhase) {
        inspectRejectionCount++;
        explorationRejectionCount = 0;
        synthesisRejectionCount = 0;
        if (inspectRejectionCount >= 2) {
          hardStopText = `${buildIgnoredVerifyNotice()}\n\n${buildVerifyFallbackFromLoopState(
            editedFilePaths,
            autoNarrowedInspections,
            executionLoopState,
            verificationLoopState,
          )}`;
        }
      } else if (inExplorationSynthesisPhase) {
        explorationRejectionCount++;
        inspectRejectionCount = 0;
        synthesisRejectionCount = 0;
        if (explorationRejectionCount >= 2) {
          const notice = buildIgnoredSynthesisNotice('exploration');
          const fallback = buildExplorationFallbackSummary(toolCallHistory);
          hardStopText = fallback ? `${notice}\n\n${fallback}` : notice;
          // ⛔ 게이트를 «걷는다» — 루프의 «자기수복 결정»이라 게이트 뒤에 두면 운영에서
          //    「그 사다리가 밟혔나」를 영영 못 잰다(30차 §5f). 빈도 = 하드스톱 1회당 1건.
          debug.log('llm.router', 'tool-loop.exploration-fallback-emitted', {
            turn,
            toolCallCount: toolCallHistory.length,
            fallbackChars: fallback.length,
            hardStopChars: hardStopText.length,
          });
        }
      } else {
        synthesisRejectionCount++;
        inspectRejectionCount = 0;
        explorationRejectionCount = 0;
        if (synthesisRejectionCount >= 2) {
          hardStopText = buildIgnoredSynthesisNotice('budget');
        }
      }
    }
    if (rejectsWholeBatch && hardStopText === null) {
      for (const call of pendingCalls) {
        handlers.onToolCall?.(call);
        toolCallHistory.push({ name: call.name, args: call.args });
        handlers.onToolResult?.({ id: call.id, name: call.name, result: phaseRejectionMessage! });
      }
    }
    if (!rejectsWholeBatch && hardStopText === null) {
      // PLAN §4.1 — Turn checkpoint capture. Fires before the actual
      // dispatch round so a `/pause` request lands BEFORE the next
      // Edit/Bash/Agent runs (and not after, which would defeat the
      // pause). Decision-boundary tools also persist a snapshot for
      // resume; cheap calls (Read/Grep/Lsp) skip the write.
      const captureResult = maybeCaptureDecision({
        turnUri: checkpointTurnUri,
        toolIndex: checkpointToolIndex,
        history,
        loop: snapshotLoopStateForCheckpoint(executionLoopState, verificationLoopState),
        pendingCalls,
      });
      if (captureResult.captured) checkpointToolIndex++;
      if (captureResult.paused) {
        const shortTurn = checkpointTurnUri.slice(-12);
        const pauseText = `[paused] checkpoint saved for turn ${shortTurn}. Resume with /resume ${shortTurn} (or /resume for the most recent).`;
        const finalText = finalizeVisibleAssistantText(
          appendFinalSynthesisNotice(fullText, pauseText),
          pauseText,
          sawToolRound,
        );
        handlers.onText('', finalText);
        debug.log('llm.router', 'tool-loop.pause', { turnUri: checkpointTurnUri, turn }, { level: 'info' });
        emitTurnComplete(finalText);
        return finalText;
      }
      if (phaseRejectedCalls.length === 0) {
        explorationRejectionCount = 0;
        synthesisRejectionCount = 0;
        inspectRejectionCount = 0;
      }
      let narrowingBlockedCount = 0;
      let autoNarrowedThisTurn = 0;
      let executionDoomDetectedThisTurn = false;
      let executionDoomWindow: string[] = [];
      const updateExecutionLoopState = (
        call: { name: string; args: Record<string, unknown> },
        result: unknown,
      ): void => {
        if (call.name !== 'RunShell' && call.name !== 'Bash') return;
        const verificationAttempt = verifyActionArmed;
        const executionCommand = summarizeExecutionCommand(call.name, call.args);
        const executionSummary = summarizeExecutionResult(result);
        const executionDetails = extractExecutionSignalDetails(result);
        const executionHints = extractExecutionSignalHints(result);
        const executionSignal = buildLoopSignalSnapshot(executionDetails, executionHints);
        if (verificationAttempt) {
          const verificationFailed = detectExecutionFailure(result);
          verifyActionArmed = verificationFailed;
          if (!verificationFailed) verificationLoopState.unknownSinceShellCommand = null;
          verificationLoopState.lastCommand = executionCommand;
          verificationLoopState.lastSummary = executionSummary;
          verificationLoopState.lastDetails = executionDetails;
          verificationLoopState.lastHints = executionHints;
          verificationLoopState.lastSignal = executionSignal;
          verificationLoopState.needsRefresh = false;
          verificationLoopState.history.push({
            command: executionCommand ?? '',
            summary: executionSummary ?? '',
            hints: executionHints,
            ok: !detectExecutionFailure(result),
          });
          if (verificationLoopState.history.length > 3) verificationLoopState.history.shift();
        } else if (
          didLastVerificationPass(verificationLoopState.history)
          && verificationFreshness(verificationLoopState) === 'current'
        ) {
          verificationLoopState.unknownSinceShellCommand = executionCommand;
          debug.log('llm.router', 'tool-loop.verification-freshness-unknown', {
            turn,
            tool: call.name,
            command: executionCommand,
          }, { level: 'info' });
        }
        if (detectExecutionFailure(result)) {
          repairActionArmed = true;
          executionLoopState.lastCommand = executionCommand;
          executionLoopState.lastSummary = executionSummary;
          executionLoopState.lastDetails = executionDetails;
          executionLoopState.lastHints = executionHints;
          executionLoopState.lastSignal = executionSignal;
          const executionFingerprint = fingerprintExecutionFailure(
            executionLoopState.lastCommand,
            executionLoopState.lastSummary,
          );
          if (executionFingerprint && executionLoopState.doomTracker.record(executionFingerprint) === 'doom') {
            executionDoomDetectedThisTurn = true;
            executionDoomWindow = executionLoopState.doomTracker
              .snapshot()
              .map((slot) => slot.fingerprint.slice(0, 120));
          }
          return;
        }
        executionLoopState.doomTracker.reset();
      };
      // Phase F5: when the model emits ≥2 Agent tool calls in one
      // turn it intends fan-out. Run them via Promise.all so workers
      // execute concurrently (one Bash per agent instead of 5 agents
      // sharing one Bash call slot). Non-Agent tools, and Agent calls
      // appearing alone in a turn, keep their original sequential
      // dispatch — parallel-dispatching independent Bash / Read
      // calls wouldn't help us and risks surprising the caller.
      //
      // Result ordering: resultBlocks MUST preserve pendingCalls
      // order for provider wire correctness (tool_call_id links it
      // back, but ordering matters to some providers). We allocate
      // a fixed-size results array indexed by original position and
      // fill it in as each dispatch resolves.
      const agentIndices = callsToDispatch
        .map((c, i) => ({ call: c, index: i }))
        .filter(x => x.call.name === 'Agent');
      // A partial phase rejection must retain the provider's call order: a
      // rejected call is completed at its original position, so Agent fan-out
      // cannot move the surrounding permitted calls ahead of it.
      const isParallelBatch = phaseRejectedCalls.length === 0 && agentIndices.length >= 2;

      type DispatchedResult = { result: unknown; isError: boolean; phaseRejected: boolean };
      const dispatchedResults: Array<DispatchedResult | null> = new Array(callsToDispatch.length).fill(null);

      // Stable arg signature — sorted keys so {a:1,b:2} and {b:2,a:1}
      // collapse to the same string. Used by the codex-family same-args
      // dedup guard below.
      //
      // W3-A (2026-05-03) — Pattern-rotation dedup. Tracked SEPARATELY
      // from the L-2 same-args dedup so existing test scenarios (which
      // rely on full-arg sig collisions to NOT happen across grep
      // variants) stay on their original path. The broad-spot counter
      // catches the new pathology: codex rotates the `pattern` field
      // every turn while hitting the same {path, glob} repeatedly
      // (observed 2026-05-03 log: 6 turns × ~3 Grep × {AGENTS.md,
      // CLAUDE.md, docs} with shifting keywords).
      //
      // W3-A extension (2026-05-03 PM) — `output_mode: 'content'` ALSO
      // tracked, with a higher threshold. Original W3-A scoped to
      // 'files_with_matches' only because content-mode is legitimately
      // repeatable (re-reading a symbol after an edit). But the 11:36
      // log showed codex bypassing the broad-spot dedup by simply
      // setting output_mode='content' on AGENTS.md/CLAUDE.md and
      // rotating the pattern — same {path, glob}, content mode, 5+
      // turns. Tracked at threshold 5 (vs 4 for files_with_matches)
      // since content lookup needs slightly more grace.
      //
      // (`seenBroadSpots`, `BROAD_SPOT_*` constants moved to the
      // streamLLMWithTools scope so the map persists across turns.)
      //
      // Scope: only Grep calls with an explicit path OR glob. Empty
      // {path, glob} (whole-repo broad search) is intentionally NOT
      // tracked here — that pattern is owned by the auto-narrow path
      // (CC narrowing converts repeated whole-repo Greps into Reads
      // automatically). If we tracked empty {path, glob} too, broad-
      // spot would intercept BEFORE auto-narrow, breaking the
      // structural-analysis flow.
      const broadSpotInfo = (
        call: { name: string; args: Record<string, unknown> },
      ): { key: string; threshold: number } | null => {
        if (call.name === 'Grep') {
          const mode = call.args.output_mode;
          const path = typeof call.args.path === 'string' ? call.args.path : '';
          const glob = typeof call.args.glob === 'string' ? call.args.glob : '';
          // Skip whole-repo broad searches — auto-narrow handles those.
          if (path.length === 0 && glob.length === 0) return null;
          if (mode === 'files_with_matches') {
            return {
              key: `Grep|broad-spot|fwm|path:${path}|glob:${glob}`,
              threshold: BROAD_SPOT_THRESHOLD,
            };
          }
          if (mode === 'content') {
            return {
              key: `Grep|broad-spot|content|path:${path}|glob:${glob}`,
              threshold: BROAD_SPOT_CONTENT_THRESHOLD,
            };
          }
          return null;
        }
        // W3-A-glob (2026-05-03 PM) — Glob broad-spot tracking. Glob is
        // deterministic over the filesystem (same args ⇒ same result
        // within the session) so threshold is 2 (block on 2nd identical
        // wildcard call). Literal-path Globs are caught earlier by
        // W5-A's literalGlobPath redirect, so this only fires on
        // wildcard patterns. Empty patterns are skipped (degenerate).
        if (call.name === 'Glob') {
          const pattern = typeof call.args.pattern === 'string' ? call.args.pattern : '';
          if (pattern.length === 0) return null;
          const path = typeof call.args.path === 'string' ? call.args.path : '';
          return {
            key: `Glob|broad-spot|pattern:${pattern}|path:${path}`,
            threshold: BROAD_SPOT_GLOB_THRESHOLD,
          };
        }
        return null;
      };
      type AnchorFileState =
        | { kind: 'absent' }
        | { kind: 'complete'; label: string }
        | { kind: 'truncated'; label: string };
      const anchorFileState = (systemMessages: LLMMessage[], filename: string): AnchorFileState => {
        const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const opening = new RegExp(`^=== (.+) \\(${escapedFilename}(?: @ [^)]+)?\\) ===$`, 'm');
        const closing = new RegExp(`^=== end ${escapedFilename}(?: @ .+)? ===$`, 'm');
        for (const message of systemMessages) {
          if (message.role !== 'system' || typeof message.content !== 'string') continue;
          const openingMatch = opening.exec(message.content);
          if (openingMatch === null || !closing.test(message.content.slice(openingMatch.index))) continue;
          const contentStart = openingMatch.index + openingMatch[0].length;
          const closingMatch = closing.exec(message.content.slice(contentStart));
          const content = message.content.slice(contentStart, contentStart + (closingMatch?.index ?? 0));
          return content.includes('…[truncated to fit anchor budget]')
            ? { kind: 'truncated', label: openingMatch[1] }
            : { kind: 'complete', label: openingMatch[1] };
        }
        return { kind: 'absent' };
      };
      const anchorStubContext = (filename: string): string => {
        const state = anchorFileState(messages, filename);
        if (state.kind === 'absent') {
          return `\`${filename}\` is not present in the system prompt.`;
        }
        if (state.kind === 'truncated') {
          return `Only a prefix of \`${filename}\` is present in the system prompt under the \`${state.label}\` anchor; the remainder is unavailable.`;
        }
        return `The full text of \`${filename}\` is present in the system prompt under the \`${state.label}\` anchor.`;
      };
      // W4-anchor (2026-05-03 PM) — Scope: codex family only. Glob anchor detection is permissive:
      // contains 'AGENTS' or 'CLAUDE' AND contains '.md'. This catches
      // `AGENTS.md`, `CLAUDE.md`, `**/AGENTS.md`, `{AGENTS,CLAUDE}.md`,
      // `AGENTS.{md,txt}`, etc. False positives (e.g. "AGENTS-helper.md")
      // are tolerable — when in doubt, redirect the model to the prompt.
      const isAnchorGrep = (
        call: { name: string; args: Record<string, unknown> },
      ): { glob: string } | null => {
        if (call.name !== 'Grep') return null;
        const glob = typeof call.args.glob === 'string' ? call.args.glob : '';
        if (glob.length === 0) return null;
        const hasAnchorName = glob.includes('AGENTS') || glob.includes('CLAUDE');
        const hasMd = glob.includes('.md');
        if (hasAnchorName && hasMd) return { glob };
        return null;
      };
      // W5-A (2026-05-03 PM) — Literal-path Glob redirect. Codex was
      // observed (log/debug-20260503123524) calling Glob with literal
      // file paths (e.g. `Glob({pattern: "src/debug-log.ts"})`) — using
      // Glob as a `stat`-style existence check before Read. This is
      // structurally wasteful: the pattern returns at most one entry
      // (the file itself) and the model's NEXT step is always Read on
      // the same path. Each literal-path Glob = ~1 wasted turn.
      //
      // Heuristic: pattern contains NO glob meta-characters (* ? [ { }
      // ! `,` `**`). If literal AND non-empty, redirect with a stub
      // telling the model to call Read directly. Path arg (cwd) is
      // ignored — literal pattern ALONE is the trigger.
      //
      // Scope: codex family only (Claude rotates patterns naturally).
      // Codex-specific guard: this branch lives inside the modelFamily
      // === 'codex' block where it's invoked.
      const GLOB_META_RE = /[*?\[\]{},!]/;
      const literalGlobPath = (
        call: { name: string; args: Record<string, unknown> },
      ): string | null => {
        if (call.name !== 'Glob') return null;
        const pattern = typeof call.args.pattern === 'string' ? call.args.pattern : '';
        if (pattern.length === 0) return null;
        if (GLOB_META_RE.test(pattern)) return null;
        return pattern;
      };
      // W5-D (2026-05-03 PM) — Anchor Read redirect. Companion to W4-
      // anchor (Grep). After W4-anchor blocked Grep on AGENTS.md /
      // CLAUDE.md, codex was observed (log after W3-A-glob, 03:48)
      // pivoting to Read on the SAME anchor files — 5× each across
      // 5 turns before generic dedup caught the 3rd. Block on the
      // first attempt for codex.
      //
      // ⛔ Do not restate the anchor's size or completeness here. This
      // comment has now gone stale twice: first it claimed the anchor is
      // "rendered verbatim … (~18KB)", then the correction hard-coded
      // both the cap and the claim that AGENTS.md overruns it — and
      // #12403 raised the cap and made it fit again the next day.
      // The budget is PROJECT_ANCHOR_MAX_CHARS (a *character* count, not
      // bytes) and whether a given file fits is a runtime fact, so
      // `anchorStubContext` reads the actual fences out of `messages`
      // instead. A guardian test keeps the repo's own candidates under
      // the cap — see test/prompt-library-universal-preamble.test.ts.
      //
      // Match: file_path's basename equals AGENTS.md or CLAUDE.md
      // (case-sensitive). Catches `AGENTS.md`, `./AGENTS.md`,
      // `/abs/path/AGENTS.md`, `subdir/CLAUDE.md`, etc. Other
      // AGENTS-prefixed files (`AGENTS-helper.md`) are NOT blocked
      // since basename match is strict.
      const isAnchorRead = (
        call: { name: string; args: Record<string, unknown> },
      ): { filePath: string } | null => {
        if (call.name !== 'Read') return null;
        const filePath = typeof call.args.file_path === 'string' ? call.args.file_path : '';
        if (filePath.length === 0) return null;
        const basename = filePath.split('/').pop() ?? '';
        if (basename === 'AGENTS.md' || basename === 'CLAUDE.md') {
          return { filePath };
        }
        return null;
      };
      const signatureOf = (call: { name: string; args: Record<string, unknown> }): string => {
        try {
          const sortedKeys = Object.keys(call.args).sort();
          const stable: Record<string, unknown> = {};
          for (const k of sortedKeys) stable[k] = call.args[k];
          return `${call.name}|${JSON.stringify(stable)}`;
        } catch {
          // Cyclic / unserializable args — fall back to name-only so
          // dedup doesn't crash the loop, and let the model retry.
          return `${call.name}|<unserializable>`;
        }
      };
      const DEDUP_THRESHOLD = 3;
      // P1 (2026-05-03) — Verify-after-edit dedup exception. When an
      // Edit/Write applies to <path>, reset every cached read-tool
      // signature for that path so the codex L-2 dedup guard does NOT
      // block the verification Read({file_path}) that should follow.
      // Without this, the implementation pipeline (find→read→edit→
      // verify) was structurally broken: the verify-Read on the same
      // path counted against the same-args dedup limit and got blocked
      // as soon as it crossed DEDUP_THRESHOLD (3 prior reads of that
      // path before the edit).
      //
      // Scope: matches signatures whose JSON serialization contains the
      // exact `"file_path":"<path>"` substring. This catches Read calls
      // for the same path regardless of offset/limit/etc., and also
      // resets sigs for tools like Lsp that take a file_path. Grep with
      // `-l` patterns or other matches that contain the path are also
      // reset, which is intentional — once the file changed, any
      // earlier exploratory result is stale anyway.
      //
      // Forensic logging: emits `tool-loop.dedup-reset-for-edit` with
      // the path + cleared-signature list so log/latest can audit which
      // entries got cleared.
      const resetReadDedupForFile = (filePath: string): void => {
        if (filePath.length === 0) return;
        const needle = `"file_path":${JSON.stringify(filePath)}`;
        const cleared: string[] = [];
        for (const sig of [...seenToolCallSignatures.keys()]) {
          if (sig.includes(needle)) {
            seenToolCallSignatures.delete(sig);
            cleared.push(sig);
          }
        }
        if (debug.enabled && cleared.length > 0) {
          debug.log('llm.router', 'tool-loop.dedup-reset-for-edit', {
            turn,
            filePath,
            clearedCount: cleared.length,
            clearedSigs: cleared,
          });
        }
      };
      const buildDedupStub = (
        call: { name: string; args: Record<string, unknown> },
        priorCount: number,
      ): string => {
        const argsPreview = (() => {
          try {
            const s = JSON.stringify(call.args);
            return s.length > 240 ? `${s.slice(0, 240)}…` : s;
          } catch {
            return '<unserializable>';
          }
        })();
        return (
          `RE-CALL BLOCKED — you already called ${call.name}(${argsPreview}) ` +
          `${priorCount} times earlier in this turn-loop and the result is in your prior tool_result blocks. ` +
          'Re-issuing the same call wastes the budget without new information. ' +
          'Either: (a) reuse the prior tool_result and write your FINAL ANSWER as plain text now, ' +
          'or (b) call a DIFFERENT tool / change the args (different file_path, offset, limit, pattern, etc.) ' +
          'to gather genuinely new evidence.'
        );
      };
      const dispatchOne = async (
        call: typeof pendingCalls[number],
      ): Promise<DispatchedResult> => {
        if (phaseRejectionMessage !== null && phaseRejectedCallIds.has(call.id)) {
          return { result: phaseRejectionMessage, isError: false, phaseRejected: true };
        }
        // Wave 6 (2026-05-04) — toolName repair + invalid-tool
        // absorption. ref/opencode `experimental_repairToolCall`
        // pattern (`session/llm.ts:317-337`). Two failure modes
        // surface here:
        //
        // 1. **case mismatch** — codex/grok occasionally emit
        //    lowercased / mixed-case names (`read` vs `Read`).
        //    Case-insensitive lookup repairs without losing the turn.
        //
        // 2. **unknown tool** — model hallucinates a name not in
        //    the catalog (`apply_patch` on non-codex, etc.). Returning
        //    a runtime dispatch error empties the turn → triggers
        //    empty-turn retry → wastes budget. Instead surface an
        //    "invalid tool" tool_result so the model self-corrects
        //    next turn (ref opencode's `InvalidTool` stub pattern).
        // ⚠️ activeTools (NOT opts.tools) — mid-loop hydration (gap④) grows the
        // declared set. Reading the frozen `opts.tools` here would reject a
        // just-summoned tool as a hallucination, which is exactly the
        // summon→re-summon→give-up loop this arc fixes.
        const knownToolNames = activeTools.map(t => t.name);
        if (knownToolNames.length > 0 && !knownToolNames.includes(call.name)) {
          const lower = call.name.toLowerCase();
          const repaired = knownToolNames.find(n => n.toLowerCase() === lower);
          if (repaired) {
            // ⛔⭐⭐⭐ 여기도 셀프힐 «사건»이다 — 모델이 «틀린 도구 이름»을 냈고 우리가 «고쳤다».
            //   ⇒ 게이트 밖. 이 값이 없으면 「어느 모델이 어떤 이름을 자주 틀리나」를 영영 못 센다.
            //   ⭐ 비용 없음 — 이 블록은 `repaired` 가 «실제로 잡혔을 때»만 돈다.
            debug.log('llm.router', 'tool-loop.tool-name.repaired', {
              turn,
              original: call.name,
              repaired,
            });
            call = { ...call, name: repaired };
          } else {
            // BACKLOG #2 — closest-match top-3 hint so the model can
            // self-recover within the same turn budget instead of
            // re-scanning the catalog. Empty when nothing is within
            // editDistance ≤ 4 (helper's default), in which case we
            // fall back to the catalog sample alone.
            const suggestions = closestMatches(call.name, knownToolNames, 3);
            if (debug.enabled) {
              debug.log('llm.router', 'tool-loop.tool-name.invalid', {
                turn,
                attempted: call.name,
                suggestions,
                available: knownToolNames.slice(0, 30),
                availableCount: knownToolNames.length,
              });
            }
            const sample = knownToolNames.slice(0, 12).join(', ');
            const didYouMean = suggestions.length > 0
              ? `Did you mean: ${suggestions.join(', ')}? `
              : '';
            const stub =
              `INVALID TOOL — "${call.name}" is not a registered tool name. ` +
              didYouMean +
              `Re-issue your call with one of the available tool names exactly ` +
              `(case-sensitive). Example available tools: ${sample}` +
              (knownToolNames.length > 12 ? `, ... (${knownToolNames.length} total).` : '.') +
              ` Do not retry the same incorrect name; pick the correct tool ` +
              `from the list, or write your final answer if no tool fits.`;
            return { result: stub, isError: true, phaseRejected: false };
          }
        }
        // Codex-family same-args dedup guard (fix L-2). Scope is
        // EXPLORATORY_TOOLS only — repeating Bash/RunShell/Edit/Write
        // is often legitimate (retry after a fix, apply-then-verify,
        // doom-detector handles failure-pattern repetition separately
        // with richer signal). Claude path bypassed because Opus 4.6
        // naturally rotates files (verified 2026-04-25T06:56
        // reproduction: docs/CAPABILITIES → PLAN → HANDOFF → ROADMAP
        // → src/code-edit/{index,apply,safety}.ts across 5 turns).
        if (modelFamily === 'codex' && EXPLORATORY_TOOLS.has(call.name)) {
          // W4-anchor — Anchor file Grep blocking. AGENTS.md / CLAUDE.md
          // are already in the system prompt; greppling them is pure
          // token waste and trains codex to ignore the in-prompt copy.
          // Block FIRST (before any counter increments) so the model's
          // every attempt gets the redirect. No threshold — anchor
          // grep is structurally redundant.
          const anchor = isAnchorGrep(call);
          if (anchor !== null) {
            if (debug.enabled) {
              debug.log('llm.router', 'tool-loop.anchor-grep-blocked', {
                turn,
                tool: call.name,
                glob: anchor.glob,
                argsPreview: (() => {
                  try {
                    const s = JSON.stringify(call.args);
                    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
                  } catch {
                    return '<unserializable>';
                  }
                })(),
              });
            }
            const stub =
              `ANCHOR GREP BLOCKED — \`${anchor.glob}\` matches an anchor-file search. ` +
              `${anchorStubContext(anchor.glob.includes('CLAUDE') ? 'CLAUDE.md' : 'AGENTS.md')} ` +
              `Move to a source file (e.g. \`src/...\`) for on-disk investigation.`;
            return { result: stub, isError: false, phaseRejected: false };
          }
          // W6-A — Search-only streak force-Read. Companion to W4-A,
          // operating BEFORE any Read happens. Codex pattern observed
          // in log/wave6-baseline/analysis-codex.jsonl: 23 calls (Grep
          // 13 + Glob 10) across 5 turns with 0 Reads, then exploration-
          // synthesis-phase + force-synthesis (generic answer from
          // anchor only). opus on the same prompt: 4 Reads naturally
          // mixed in. When a search-only call lands AND the streak is
          // ≥ 2 (i.e. this turn would make it 3+ consecutive search-
          // only turns) AND no Reads have been dispatched yet, block
          // with a stub naming the streak count and demanding Read.
          // Threshold 2 (not 3): broad-spot already gives 2 grace
          // passes; this catches the model BEFORE phase rejection
          // starts at streak 4-5 so we save 2-3 wasted turns.
          // Trigger conditions:
          //  - dispatchedReadCount === 0  (no real Read yet)
          //  - autoNarrowedReadCount === 0  (no auto-narrow Read either —
          //    that path converts a Grep into a Read-equivalent)
          //  - searchOnlyTurnStreak ≥ 3  (this turn would be the 4th
          //    consecutive search-only turn; tighter than exploration-
          //    synthesis at 4-5 so we save 1-2 wasted turns BEFORE phase
          //    rejection without colliding with the auto-narrow path)
          //  - call is in SEARCH_ONLY_TOOLS
          if (
            dispatchedReadCount === 0
            && autoNarrowedReadCount === 0
            && searchOnlyTurnStreak >= 3
            && SEARCH_ONLY_TOOLS.has(call.name)
          ) {
            if (debug.enabled) {
              debug.log('llm.router', 'tool-loop.search-only-streak-blocked', {
                turn,
                tool: call.name,
                searchOnlyTurnStreak,
                dispatchedReadCount,
                autoNarrowedReadCount,
              });
            }
            const stub =
              `SEARCH-ONLY STREAK BLOCKED — you have run ${searchOnlyTurnStreak}+ consecutive ` +
              `turns of pure ${call.name}/Grep/Glob/ListDir without a single Read. The candidate ` +
              `paths from your prior search results are already in your tool_result blocks; the ` +
              `next ${call.name} would just re-list what you have. **Pick the top 2-5 candidate ` +
              `file paths from those prior results and call \`Read({file_path: "<path>"})\` on ` +
              `each NOW.** If you genuinely cannot decide which file to read, write your final ` +
              `answer as plain text from what you've gathered so far.`;
            return { result: stub, isError: false, phaseRejected: false };
          }
          // W4-A — Post-Read broad-search blocking. After 3+ Reads have
          // been dispatched, codex's "go back to broad search" pattern
          // is structurally pointless: the inspected files are already
          // in tool_result blocks. Force the model to either Read a
          // specific file, run a narrow code-intel followup, or
          // synthesize. Triggered when the new call is a broad Glob
          // (wildcard pattern, no narrow path) or Grep (no path/glob
          // filter). Reproducer: log/wave5-w5e/debug.jsonl — 12 Greps
          // + 6 Reads with the same `**/debug*` family rotated.
          if (dispatchedReadCount >= 3) {
            const isBroadPostRead = (() => {
              if (call.name === 'Glob') {
                const pattern = typeof call.args.pattern === 'string' ? call.args.pattern : '';
                // Wildcard with `**` is the canonical broad Glob.
                return pattern.includes('**');
              }
              if (call.name === 'Grep') {
                const path = typeof call.args.path === 'string' ? call.args.path : '';
                const glob = typeof call.args.glob === 'string' ? call.args.glob : '';
                // No path AND no glob = whole-repo broad. Path = '.'
                // also counts as broad.
                return (path.length === 0 || path === '.') && glob.length === 0;
              }
              return false;
            })();
            if (isBroadPostRead) {
              if (debug.enabled) {
                debug.log('llm.router', 'tool-loop.post-read-broad-blocked', {
                  turn,
                  tool: call.name,
                  dispatchedReadCount,
                  argsPreview: (() => {
                    try {
                      const s = JSON.stringify(call.args);
                      return s.length > 200 ? `${s.slice(0, 200)}…` : s;
                    } catch {
                      return '<unserializable>';
                    }
                  })(),
                });
              }
              const stub =
                `POST-READ BROAD SEARCH BLOCKED — you have already inspected ` +
                `${dispatchedReadCount} file(s) (in your prior tool_result blocks). Broad ${call.name} ` +
                `at this point is regression behavior — the candidate paths from any new wildcard ` +
                `search would just rediscover what you already have. Your next call must be EITHER: ` +
                `(a) a narrow code-intel followup (\`Lsp\`, \`AstGrep\`, or content \`Grep\` on a specific ` +
                `path), (b) \`Read\` on a specific file from your prior search results, or (c) write your ` +
                `final answer as plain text using the files you already inspected.`;
              return { result: stub, isError: false, phaseRejected: false };
            }
          }
          // W5-D — Anchor file Read blocking. Re-reading an anchor file
          // from disk trains codex to ignore whatever IS in the prompt.
          // ⛔ 2026-08-24 — this comment used to claim the anchor is
          // "already rendered verbatim … (~18KB)". Unmeasured and false
          // (see the W4-anchor note above). What is actually present is
          // decided per-call by `anchorStubContext`, which inspects the
          // fences in `messages`. Companion to W4-anchor (Grep).
          const anchorRead = isAnchorRead(call);
          if (anchorRead !== null) {
            if (debug.enabled) {
              debug.log('llm.router', 'tool-loop.anchor-read-blocked', {
                turn,
                tool: call.name,
                filePath: anchorRead.filePath,
                argsPreview: (() => {
                  try {
                    const s = JSON.stringify(call.args);
                    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
                  } catch {
                    return '<unserializable>';
                  }
                })(),
              });
            }
            const filename = anchorRead.filePath.split('/').pop() ?? anchorRead.filePath;
            const stub =
              `ANCHOR READ BLOCKED — \`${anchorRead.filePath}\` matches an anchor-file read. ` +
              `${anchorStubContext(filename)} Move to a source file (e.g. \`src/...\`) for on-disk investigation.`;
            return { result: stub, isError: false, phaseRejected: false };
          }
          // W5-A — Literal-path Glob redirect. Codex uses Glob({pattern:
          // "src/foo.ts"}) as a stat-style existence check before Read.
          // Always wasteful: pattern returns ≤1 entry, Read on the same
          // path is the next step. Block FIRST so the model is steered
          // to Read directly instead of Glob → Read pair.
          const literalPath = literalGlobPath(call);
          if (literalPath !== null) {
            if (debug.enabled) {
              debug.log('llm.router', 'tool-loop.literal-glob-blocked', {
                turn,
                tool: call.name,
                pattern: literalPath,
                argsPreview: (() => {
                  try {
                    const s = JSON.stringify(call.args);
                    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
                  } catch {
                    return '<unserializable>';
                  }
                })(),
              });
            }
            const stub =
              `LITERAL-PATH GLOB BLOCKED — \`Glob({pattern: "${literalPath}"})\` has no glob ` +
              `meta-characters (* ? [ ] { } , !) so it can match at most one file (the literal ` +
              `path itself). Glob is for finding files by wildcard, not for checking whether ` +
              `a known path exists. Either: (a) call \`Read({file_path: "${literalPath}"})\` ` +
              `directly to read the file, or (b) call \`Glob\` with an actual wildcard pattern ` +
              `(e.g. \`src/*.ts\`, \`**/${literalPath.split('/').pop() ?? '*'}\`) if you ` +
              `intended to search a tree.`;
            return { result: stub, isError: false, phaseRejected: false };
          }
          const sig = signatureOf(call);
          const priorCount = seenToolCallSignatures.get(sig) ?? 0;
          seenToolCallSignatures.set(sig, priorCount + 1);
          if (priorCount + 1 >= DEDUP_THRESHOLD) {
            const stub = buildDedupStub(call, priorCount);
            if (debug.enabled) {
              debug.log('llm.router', 'tool-loop.dedup-blocked', {
                turn,
                tool: call.name,
                signature: sig,
                priorCount,
                threshold: DEDUP_THRESHOLD,
              });
            }
            return { result: stub, isError: false, phaseRejected: false };
          }
          // W3-A + extension — Broad-spot dedup (independent layer).
          // Both modes use threshold 3 (matches L-2 — broad-spot wins
          // when L-2 misses due to pattern rotation against same spot).
          const spotInfo = broadSpotInfo(call);
          if (spotInfo !== null) {
            const priorSpot = seenBroadSpots.get(spotInfo.key) ?? 0;
            seenBroadSpots.set(spotInfo.key, priorSpot + 1);
            if (priorSpot + 1 >= spotInfo.threshold) {
              if (debug.enabled) {
                debug.log('llm.router', 'tool-loop.broad-spot-blocked', {
                  turn,
                  tool: call.name,
                  spotKey: spotInfo.key,
                  priorSpot,
                  threshold: spotInfo.threshold,
                  outputMode: call.args.output_mode,
                  argsPreview: (() => {
                    try {
                      const s = JSON.stringify(call.args);
                      return s.length > 200 ? `${s.slice(0, 200)}…` : s;
                    } catch {
                      return '<unserializable>';
                    }
                  })(),
                });
              }
              const stub = call.name === 'Glob'
                ? (
                  `BROAD-SPOT REPEAT BLOCKED — you have already issued ${priorSpot} Glob ` +
                  `call(s) for {pattern:${call.args.pattern ?? '*'}, path:${call.args.path ?? '.'}} ` +
                  `this turn-loop. Glob is deterministic — re-running with the same args returns ` +
                  `the same paths you already have in your prior tool_result blocks. Advance to ` +
                  `**read** the top candidates with \`Read({file_path})\`, or write your final ` +
                  `answer from the file list you already gathered.`
                )
                : (() => {
                  const modeLabel = call.args.output_mode === 'content' ? 'content' : 'files_with_matches';
                  return (
                    `BROAD-SPOT REPEAT BLOCKED — you have already issued ${priorSpot} broad Grep ` +
                    `(output_mode: ${modeLabel}) calls against {path:${call.args.path ?? '.'}, ` +
                    `glob:${call.args.glob ?? '*'}} this turn-loop. Rotating the \`pattern\` field while ` +
                    `keeping the same {path, glob} is search-storm behavior. The candidate paths from ` +
                    `prior calls are already in your tool_result blocks; advance to **read** (open the ` +
                    `top 2-5 files with Read) or write your final answer.`
                  );
                })();
              return { result: stub, isError: false, phaseRejected: false };
            }
          }
        }
        let result: unknown;
        let isError = false;
        // Slow-tool watchdog — a heartbeat while this call is still in flight,
        // so a long tool (full test suite, headless build) is observable in
        // logs.db instead of looking like a between-turn freeze (§4c residual).
        const toolStartedAt = Date.now();
        let slowTicks = 0;
        // ★ walker tool 관측(2026-07-21·제1원칙 로그축) — tool 실행 시작을 mission.walker 로 각인.
        //   장시간 셸(bun test 등)은 이 start 로그가 "지금 무슨 명령을 실행 중"의 유일한 조회원(라이브 705308
        //   근본: walker tool 무관측 → hang 오판 직전). missionContext 있을 때만·argsSummary 는 compact.
        //   ★조회: elanous logs --category mission.walker (event=tool·phase=start).
        if (opts.missionContext) debug.log('mission.walker', 'tool', { ...opts.missionContext, turn, name: call.name, phase: 'start', callId: call.id, argsSummary: summarizeWalkerToolArgs(call.name, call.args) });
        const slowTimer = setInterval(() => {
          slowTicks += 1;
          debug.log('llm.tool-loop.slow-tool', 'awaiting', {
            tool: call.name, callId: call.id, turn,
            elapsedMs: Date.now() - toolStartedAt, tick: slowTicks,
          });
          // ★ liveness heartbeat(2026-07-21·제1원칙 point5) — in-flight 장시간 tool 을 mission.walker 로도
          //   심장박동. 이게 있으면 "긴 테스트"가 hang 이 아니라 진행 중임을 좌표(missionId/phaseId)와 함께
          //   조회 가능 → hang 오판 방지. 기존 compact heartbeat 와 정합(동일 mission.walker 카테고리).
          if (opts.missionContext) debug.log('mission.walker', 'tool-heartbeat', { ...opts.missionContext, turn, name: call.name, callId: call.id, elapsedMs: Date.now() - toolStartedAt, tick: slowTicks });
        }, opts.slowToolTickMs ?? SLOW_TOOL_TICK_MS);
        (slowTimer as unknown as { unref?: () => void }).unref?.();
        try {
          result = await handlers.dispatchTool(call.name, call.args, { callId: call.id, turnIndex: turn });
        } catch (err: any) {
          result = { error: err?.message || String(err) };
          isError = true;
        } finally {
          clearInterval(slowTimer);
        }
        // ⭐ Hydration absorb (F2 gap④) — a dispatcher that resolved new tool
        // schemas hands them back on the result; lift them into the declared
        // tool list so the model can actually CALL them next turn. The key is
        // stripped here, so the schemas never reach the conversation twice
        // (the rendered `<functions>` block already carries them once).
        // Generic seam: the loop knows nothing about ToolSearch.
        // ⚠️ 추출·삭제는 **항상**(에러 결과여도) — 예약키는 모델-비대상 배관이라
        // 실패했다고 대화로 새어나가면 안 된다. 활성 툴 **채택만** 성공 시로 제한한다
        // (실패한 dispatch 의 스펙을 프로바이더에 선언할 이유는 없다).
        const hydrated = takeHydratedTools(result);
        // 실패 신호는 두 가지다: dispatch 가 **throw**(isError) 하거나, 결과가
        // **에러 모양**({error: …})으로 돌아오거나. 후자는 루프의 isError 를 세우지
        // 않으므로(기존 의미론), 채택 판정에서는 별도로 본다 — 실패한 dispatch 의
        // 스펙을 프로바이더에 선언하지 않는다는 의도가 우회되지 않게.
        const resultSignalsError = !!result && typeof result === 'object'
          && typeof (result as { error?: unknown }).error === 'string';
        if (!isError && !resultSignalsError) {
          for (const spec of hydrated) {
            if (activeToolNames.has(spec.name)) continue;
            activeToolNames.add(spec.name);
            activeTools.push(spec);
            debug.log('capability.resolve', 'tool-hydrated', {
              tool: spec.name, via: call.name, turn, activeCount: activeTools.length,
            });
          }
        }
        // ★ walker tool 완료 관측(2026-07-21) — 소요/성공여부를 각인(start 와 짝). ok=false 면 tool 실패가
        //   turn 관측과 상관되어 재시도/goal-loop 진단 재료가 된다. missionContext 있을 때만.
        if (opts.missionContext) debug.log('mission.walker', 'tool', { ...opts.missionContext, turn, name: call.name, phase: 'done', callId: call.id, ms: Date.now() - toolStartedAt, ok: !isError });
        // Conditional budget grant — a designated multi-round tool (e.g.
        // driving a headless coding-agent terminal) earns extra loop turns,
        // bounded by `ceiling`, so the tight per-family cap stays the default
        // for ordinary turns and only relaxes when such work is underway.
        if (budgetGrant && maxTurns < budgetGrant.ceiling && budgetGrant.tools.includes(call.name)) {
          const before = maxTurns;
          maxTurns = Math.min(budgetGrant.ceiling, maxTurns + budgetGrant.perCall);
          if (maxTurns !== before && debug.enabled) {
            debug.log('llm.router', 'tool-loop.budget-grant', { tool: call.name, before, after: maxTurns, ceiling: budgetGrant.ceiling });
          }
        }
        // W4-A — Track Read dispatches (only successful ones; error
        // results don't count as "the file is in your context"). The
        // post-Read broad-search guard above reads this counter.
        if (call.name === 'Read' && !isError && modelFamily === 'codex') {
          dispatchedReadCount++;
        }
        return { result, isError, phaseRejected: false };
      };

      if (isParallelBatch) {
        const batchStartedAt = Date.now();
        const agentCalls = agentIndices.map(x => x.call);

        // ⭐ `#7333` — 팬아웃 관측을 «사건이 일어나는 자리»에서 낸다.
        //
        // 종전엔 배치의 유일한 기록이 `onAgentBatch*` 핸들러였고, 그 핸들러를
        // 등록하는 곳이 `src/skills/runner.ts` ***하나뿐***이었다(2026-08-24 전수).
        // 그런데 `streamLLMWithTools` 를 부르는 진입점은 열 곳이다 — TUI(session/chat.ts)
        // · core-turn · daemon-prompt-turn · agent/runner 는 배치 핸들러를 «안 넘긴다».
        // ⇒ 그 경로로 팬아웃하면 ***아무 기록도 안 남았다***. 그것이 `agent.batch` 가
        //   전 기간 0행이었던 이유의 절반이다(나머지 절반은 tick 이 간격보다 짧은 배치).
        //
        // ⛔ 렌더러 핸들러를 «대체»하지 않는다 — 화면은 그대로 두고 관측만 더한다.
        //    관측이 렌더러 등록에 «의존»하는 것이 결손이었지, 렌더러가 문제는 아니다.
        debug.log('agent.batch', 'start', {
          total: agentCalls.length,
          descriptions: agentCalls.map(c => String((c.args as any)?.description ?? '').slice(0, 60)),
          subagentTypes: agentCalls.map(c => String((c.args as any)?.subagent_type ?? 'general-purpose')),
        });

        // Run non-Agent calls sequentially FIRST so their results
        // don't land in the middle of a multi-second Promise.all
        // (keeps the ordering of user-visible events sensible).
        for (let i = 0; i < callsToDispatch.length; i++) {
          const call = callsToDispatch[i]!;
          if (call.name === 'Agent') continue;
          handlers.onToolCall?.(call);
          toolCallHistory.push({ name: call.name, args: call.args });
          const r = await dispatchOne(call);
          if (isNarrowingBlockedResult(r.result)) narrowingBlockedCount++;
          if (!r.isError && (call.name === 'Edit' || call.name === 'Write') && typeof call.args.file_path === 'string') {
            const prevVerifyArmed = verifyActionArmed;
            const prevRepairArmed = repairActionArmed;
            editedFilePaths.push(call.args.file_path);
            // P1 — Reset codex dedup counter for this path so the
            // expected verify-Read isn't blocked.
            resetReadDedupForFile(call.args.file_path);
            repairActionArmed = false;
            verifyActionArmed = true;
            verificationLoopState.needsRefresh = true;
            if (debug.enabled) {
              debug.log('llm.router', 'tool-loop.edit-applied', {
                turn,
                tool: call.name,
                file_path: call.args.file_path,
                editedFileCount: editedFilePaths.length,
                prevVerifyArmed,
                prevRepairArmed,
                nextVerifyArmed: true,
                nextRepairArmed: false,
              });
            }
          }
          updateExecutionLoopState(call, r.result);
          if (isAutoNarrowedReadResult(r.result)) {
            autoNarrowedThisTurn++;
            const inspection = parseAutoNarrowedInspection(r.result);
            if (inspection) autoNarrowedInspections.push(inspection);
          }
          handlers.onToolResult?.({ id: call.id, name: call.name, result: r.result });
          dispatchedResults[i] = r;
        }

        // Now the Agent batch.
        handlers.onAgentBatchStart?.(agentCalls);

        // Track which agents are still in-flight so the tick handler
        // can name them. Removed in each promise's resolve branch.
        const inFlight = new Set(agentCalls.map(c => c.id));
        const descriptionById = new Map(
          agentCalls.map(c => [c.id, String((c.args as any)?.description ?? '')] as const),
        );

        // Live ticker — fires every BATCH_TICK_INTERVAL_MS so the pane
        // can show a running `✻ Baked for Xs` that actually advances.
        // Only spin up if the caller registered a tick handler.
        let tickHandle: ReturnType<typeof setInterval> | null = null;
        if (handlers.onAgentBatchTick) {
          tickHandle = setInterval(() => {
            try {
              handlers.onAgentBatchTick!({
                batchElapsedMs: Date.now() - batchStartedAt,
                total: agentCalls.length,
                done: agentCalls.length - inFlight.size,
                remaining: inFlight.size,
                runningDescriptions: [...inFlight].map(id => descriptionById.get(id) ?? ''),
              });
            } catch { /* swallow — renderer bug must not sink the batch */ }
          }, agentBatchTickIntervalMs);
        }

        let doneCount = 0;
        try {
          await Promise.all(agentIndices.map(async ({ call, index }) => {
            handlers.onToolCall?.(call);
            toolCallHistory.push({ name: call.name, args: call.args });
            const startedAt = Date.now();
            const r = await dispatchOne(call);
            if (isNarrowingBlockedResult(r.result)) narrowingBlockedCount++;
            if (!r.isError && (call.name === 'Edit' || call.name === 'Write') && typeof call.args.file_path === 'string') {
              editedFilePaths.push(call.args.file_path);
              resetReadDedupForFile(call.args.file_path);  // P1 — verify-after-edit
              repairActionArmed = false;
              verifyActionArmed = true;
              verificationLoopState.needsRefresh = true;
            }
            updateExecutionLoopState(call, r.result);
            if (isAutoNarrowedReadResult(r.result)) {
              autoNarrowedThisTurn++;
              const inspection = parseAutoNarrowedInspection(r.result);
              if (inspection) autoNarrowedInspections.push(inspection);
            }
            handlers.onToolResult?.({ id: call.id, name: call.name, result: r.result });
            dispatchedResults[index] = r;
            inFlight.delete(call.id);
            doneCount++;
            handlers.onAgentComplete?.({
              id: call.id,
              description: descriptionById.get(call.id) ?? '',
              elapsedMs: Date.now() - startedAt,
              remaining: agentCalls.length - doneCount,
              batchElapsedMs: Date.now() - batchStartedAt,
            });
          }));
        } finally {
          if (tickHandle) clearInterval(tickHandle);
        }
        // 배치의 «끝»도 같은 자리에서. 시작만 남기면 「몇 개를 띄웠나」는 알아도
        // 「팬아웃이 값을 냈나」(걸린 시간)는 여전히 못 잰다 — 그 둘이 `A2` 가
        // 답 못 한 「몇 개까지 병렬이 이득인가」의 최소 재료다.
        debug.log('agent.batch', 'end', {
          total: agentCalls.length,
          batchElapsedMs: Date.now() - batchStartedAt,
        });
        handlers.onAgentBatchEnd?.({
          totalCount: agentCalls.length,
          batchElapsedMs: Date.now() - batchStartedAt,
        });
      } else {
        // P2 — Safe-parallel batch path. Read-only tools with
        // supportsParallel=true run concurrently via Promise.all; the
        // rest stay sequential. Degrades to pure sequential when
        // there are <2 safe calls, matching pre-P2 behaviour exactly.
        // Agent is excluded (handled by the Agent-batch branch above).
        const dispatchWithPostProc = async (
          call: typeof pendingCalls[number],
          index: number,
        ): Promise<void> => {
          handlers.onToolCall?.(call);
          toolCallHistory.push({ name: call.name, args: call.args });
          const r = await dispatchOne(call);
          if (isNarrowingBlockedResult(r.result)) narrowingBlockedCount++;
          if (!r.isError && (call.name === 'Edit' || call.name === 'Write') && typeof call.args.file_path === 'string') {
            const prevVerifyArmed = verifyActionArmed;
            const prevRepairArmed = repairActionArmed;
            editedFilePaths.push(call.args.file_path);
            // P1 — Reset codex dedup counter for this path so the
            // expected verify-Read isn't blocked.
            resetReadDedupForFile(call.args.file_path);
            repairActionArmed = false;
            verifyActionArmed = true;
            verificationLoopState.needsRefresh = true;
            if (debug.enabled) {
              debug.log('llm.router', 'tool-loop.edit-applied', {
                turn,
                tool: call.name,
                file_path: call.args.file_path,
                editedFileCount: editedFilePaths.length,
                prevVerifyArmed,
                prevRepairArmed,
                nextVerifyArmed: true,
                nextRepairArmed: false,
              });
            }
          }
          updateExecutionLoopState(call, r.result);
          if (isAutoNarrowedReadResult(r.result)) {
            autoNarrowedThisTurn++;
            const inspection = parseAutoNarrowedInspection(r.result);
            if (inspection) autoNarrowedInspections.push(inspection);
          }
          handlers.onToolResult?.({ id: call.id, name: call.name, result: r.result });
          dispatchedResults[index] = r;
        };
        const partition = phaseRejectedCalls.length > 0
          ? { parallelActivated: false, safeCount: 0, unsafeCount: callsToDispatch.length }
          : await dispatchWithParallelSafety(callsToDispatch, dispatchWithPostProc);
        if (phaseRejectedCalls.length > 0) {
          for (let index = 0; index < callsToDispatch.length; index++) {
            await dispatchWithPostProc(callsToDispatch[index]!, index);
          }
        }
        if (debug.enabled && partition.parallelActivated) {
          debug.log('llm.tool-loop.parallel', 'safe-batch-dispatch', {
            safeCount: partition.safeCount,
            unsafeCount: partition.unsafeCount,
            safeNames: callsToDispatch
              .filter((c) => isSafeForParallel(c.name))
              .map((c) => c.name),
          });
        }
      }

      // P3 — Doom-loop gate. Process each dispatched result in call order:
      // a successful call immediately separates failure runs, including when
      // failures and successes share one provider turn.
      let turnDoomDetected = false;
      let doomFailureDetail: string | null = null;
      let doomToolName: string | undefined;
      for (let i = 0; i < callsToDispatch.length; i += 1) {
        const r = dispatchedResults[i];
        if (!r || r.phaseRejected) continue;
        if (!r.isError) {
          toolErrorDoomTracker.reset();
          continue;
        }
        const call = callsToDispatch[i]!;
        const failureDetail = stringifyDoomFailureDetail(r.result);
        const fp = fingerprintError(r.result, call.name);
        const status = toolErrorDoomTracker.record(fp);
        if (status === 'doom') {
          turnDoomDetected = true;
          doomToolName = call.name;
          doomFailureDetail = failureDetail;
          break;
        }
      }
      // A — identical successful-call repeat detection (gemini-style; see
      // toolRepeatTracker). Successful dispatch results and non-error guard
      // stubs are recorded here; 5 identical (same tool + same args) in a row
      // → a one-shot converge nudge for the next turn. Does not hard-stop and
      // does not touch exploration budget.
      for (let i = 0; i < callsToDispatch.length; i += 1) {
        const r = dispatchedResults[i];
        if (!r || r.isError) continue;
        const call = callsToDispatch[i]!;
        const fp = `${call.name}:${JSON.stringify(call.args)}`;
        if (toolRepeatTracker.record(fp) === 'doom') {
          toolRepeatTracker.reset();
          debug.log('llm.tool-loop.repeat', 'identical-success-detected', {
            turn, tool: call.name, window: TOOL_REPEAT_WINDOW,
          });
          if (!postToolResultUserNote) {
            postToolResultUserNote =
              `You have called ${call.name} with identical arguments ${TOOL_REPEAT_WINDOW} times ` +
              'in a row without acting on the result. Stop re-reading / re-searching the same ' +
              'target — either make the concrete edit or verification this investigation was for, ' +
              'or state your conclusion in plain text. Do not repeat this call.';
          }
          break;
        }
      }
      if (turnDoomDetected && !hardStopText) {
        const retryDecision = decideRetry(new Error('tool doom loop'), {
          attempt: 0,
          doomStatus: 'doom',
        });
        const doomWindow = toolErrorDoomTracker.snapshot().map((s) => s.fingerprint.slice(0, 80));
        debug.log('llm.tool-loop.retry', 'doom-loop-detected', {
          turn, tool: doomToolName, window: doomWindow,
        }, { level: 'warn' });
        const applyAskOutcome = async (reason: DoomLoopReason, detail: string | null) => {
          const interventionClass = classifyDoomLoopIntervention({
            detail: [detail, doomFailureDetail].filter(Boolean).join('\n'), doomWindow,
          });
          const askDispatchOpts: DoomLoopRouteOpts = {
            reason, detail, doomWindow, interventionClass,
          };
          if (opts.sessionId) askDispatchOpts.sessionId = opts.sessionId;
          if (opts.signal) askDispatchOpts.signal = opts.signal;
          const outcome = await routeDoomLoopToAskUser(askDispatchOpts);
          if (outcome.kind === 'retry') {
            toolErrorDoomTracker.reset();
            postToolResultUserNote =
              'The previous tool call kept failing 3 times in a row. Retry the same approach once more — the user reset the doom-loop tracker.';
            debug.log('llm.tool-loop.retry', 'doom-loop-ask-retry', {
              turn, reason, interventionClass: outcome.interventionClass,
            });
          } else if (outcome.kind === 'guidance') {
            toolErrorDoomTracker.reset();
            postToolResultUserNote = outcome.userMessage;
            debug.log('llm.tool-loop.retry', 'doom-loop-ask-guidance', {
              turn, reason, interventionClass: outcome.interventionClass,
            });
          } else {
            hardStopText = outcome.hardStopText;
            debug.log('llm.tool-loop.retry', outcome.kind === 'fallback' ? 'doom-loop-ask-fallback' : 'doom-loop-ask-stop', {
              turn, reason, interventionClass: outcome.interventionClass, window: doomWindow,
            });
          }
        };
        if (retryDecision.action === 'auto-undo') {
          if (isPlanModeActive()) {
            await applyAskOutcome('plan-mode', retryDecision.reason);
          } else if (listSnapshots().length === 0) {
            await applyAskOutcome('no-undo-available', 'UndoTurn: no snapshots available');
          } else {
            try {
              const undoResult = await undoTurnRuntime.run({}, { surface: 'tui' });
              toolErrorDoomTracker.reset();
              repairActionArmed = true;
              verifyActionArmed = false;
              appendedToolResultNotice = buildAutoUndoRepairNotice(undoResult);
              debug.log('llm.tool-loop.retry', 'doom-loop-auto-undo-applied', {
                turn,
                restoredId: undoResult.restoredId,
                window: doomWindow,
              });
            } catch (err) {
              await applyAskOutcome('undo-failed', err instanceof Error ? err.message : String(err));
            }
          }
        } else {
          await applyAskOutcome('policy', retryDecision.reason);
        }
      }
      if (executionDoomDetectedThisTurn && !hardStopText) {
        hardStopText = buildExecutionDoomFallbackFromLoopState(
          autoNarrowedInspections,
          executionLoopState,
          verificationLoopState,
          executionDoomWindow,
        );
        debug.log('llm.tool-loop.retry', 'execution-doom-detected', {
          turn,
          command: executionLoopState.lastCommand,
          summary: executionLoopState.lastSummary,
          window: executionDoomWindow,
        });
      }

      autoNarrowedReadCount += autoNarrowedThisTurn;
      const structuralInspectFallbackReady =
        inspectFollowupMode === 'synthesis'
        && looksLikeStructuralAnalysis(history)
        && autoNarrowedInspections.length >= 2
        && narrowingBlockedCount >= 1;
      if (modelFamily === 'codex' && autoNarrowedReadCount >= inspectBudgetThreshold) {
        inspectSynthesisArmed = true;
      }
      if (structuralInspectFallbackReady) {
        hardStopText = buildInspectFallbackSummary(autoNarrowedInspections);
        hardStopReason = 'structural-inspect-fallback-ready';
      } else if (
        modelFamily === 'codex'
        && autoNarrowedThisTurn > 0
        && autoNarrowedInspections.length > 0
        && autoNarrowedReadCount >= inspectBudgetThreshold
        && inspectFollowupMode === 'synthesis'
      ) {
        hardStopText = buildInspectFallbackSummary(autoNarrowedInspections);
        hardStopReason = 'codex-inspect-budget-synthesis';
      } else if (
        modelFamily === 'codex'
        && autoNarrowedThisTurn > 0
        && autoNarrowedInspections.length > 0
        && autoNarrowedReadCount >= inspectBudgetThreshold
        && inspectFollowupMode === 'execution'
      ) {
        inspectSynthesisArmed = true;
        debug.log('llm.router', 'tool-loop.inspect-synthesis-armed', {
          turn,
          reason: 'codex-inspect-budget-execution',
          autoNarrowedReadCount,
          inspectBudgetThreshold,
          inspectionCount: autoNarrowedInspections.length,
          inspectFollowupMode,
        });
      } else if (
        narrowingBlockedCount >= 1
        && autoNarrowedInspections.length > 0
        && autoNarrowedReadCount >= inspectBudgetThreshold
        && inspectFollowupMode === 'synthesis'
      ) {
        hardStopText = buildInspectFallbackSummary(autoNarrowedInspections);
        hardStopReason = 'narrowing-blocked-inspect-synthesis';
      } else if (
        narrowingBlockedCount >= 1
        && autoNarrowedInspections.length > 0
        && autoNarrowedReadCount >= inspectBudgetThreshold
        && inspectFollowupMode === 'execution'
      ) {
        hardStopText = buildInspectExecutionFallback(autoNarrowedInspections);
        hardStopReason = 'narrowing-blocked-inspect-execution';
      } else if (
        repairActionArmed
        && narrowingBlockedCount >= 1
      ) {
        hardStopText = buildRepairFallbackFromLoopState(
          autoNarrowedInspections,
          editedFilePaths,
          executionLoopState,
          verificationLoopState,
        );
        hardStopReason = 'repair-armed-narrowing-blocked';
      } else if (
        // BB (2026-04-25, log/debug-20260425164918) — codex same-turn parallel
        // [Grep, Grep, Grep] burst trips count to 2 in turn 0 (phase='listed'
        // after first call → 2nd & 3rd blocked) → instant hard-stop at turn 0.
        // Bumping threshold to 3 lets codex absorb one batch + recover on the
        // next turn instead of dying immediately. Other families keep ≥2.
        narrowingBlockedCount >= (modelFamily === 'codex' ? 3 : 2)
      ) {
        const hasUsefulInspections = autoNarrowedInspections.length > 0;
        if (hasUsefulInspections) {
          hardStopText =
            inspectFollowupMode === 'action'
              ? buildInspectActionFallback(autoNarrowedInspections)
              : inspectFollowupMode === 'execution'
              ? buildInspectExecutionFallback(autoNarrowedInspections)
              : buildInspectFallbackSummary(autoNarrowedInspections);
          hardStopReason = `narrowing-blocked-twice-${inspectFollowupMode}`;
        } else {
          // AA (2026-04-25) — mirror Fix B at line 3974: append the
          // exploration trace + recommendation so the user gets ListDir/Grep/
          // Read summary instead of a sterile 239-char apology when the
          // narrowing block path fires without any inspected files.
          const notice = buildIgnoredSynthesisNotice('narrowing');
          const fallback = buildExplorationFallbackSummary(toolCallHistory);
          hardStopText = fallback ? `${notice}\n\n${fallback}` : notice;
          hardStopReason = 'narrowing-blocked-twice-no-inspections';
          // ⛔ 게이트를 «걷는다» — 루프의 «자기수복 결정»이라 게이트 뒤에 두면 운영에서
          //    「그 사다리가 밟혔나」를 영영 못 잰다(30차 §5f). 빈도 = 하드스톱 1회당 1건.
          debug.log('llm.router', 'tool-loop.narrowing-fallback-emitted', {
            turn,
            modelFamily,
            narrowingBlockedCount,
            toolCallCount: toolCallHistory.length,
            fallbackChars: fallback.length,
            hardStopChars: hardStopText.length,
          });
        }
      }

      // Build resultBlocks in original pendingCalls order.
      const rejectedResultById = new Map(
        resultBlocks.map((block) => [
          (block as Extract<ContentBlock, { type: 'tool_result' }>).tool_use_id,
          block,
        ]),
      );
      resultBlocks.length = 0;
      for (const call of pendingCalls) {
        const rejectedBlock = rejectedResultById.get(call.id);
        if (rejectedBlock) {
          resultBlocks.push(rejectedBlock);
          continue;
        }
        const dispatchIndex = callsToDispatch.findIndex((candidate) => candidate.id === call.id);
        const { result, isError } = dispatchedResults[dispatchIndex]!;
        const imageBearing = maybeImageBearingResult(result);
        if (imageBearing) {
          // Image-bearing tool result (Phase 1, 2026-05-05) — see
          // ToolRunResult docstring. Repackage as Anthropic-style
          // content array so vision-capable models receive the PNG
          // bytes as actual image input. Other providers collapse to
          // text-only via stringifyToolResultContent at wire time.
          resultBlocks.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: [
              { type: 'image', mediaType: imageBearing.mediaType, base64: imageBearing.dataB64 },
              { type: 'text', text: JSON.stringify(imageBearing.rest) },
            ],
            ...(isError ? { isError: true } : {}),
          });
        } else {
          resultBlocks.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
            ...(isError ? { isError: true } : {}),
          });
        }
      }
      if (appendedToolResultNotice && resultBlocks.length > 0) {
        const last = resultBlocks[resultBlocks.length - 1] as Extract<ContentBlock, { type: 'tool_result' }>;
        appendNoticeToToolResult(last, appendedToolResultNotice);
      }
    }

    // Budget warning — inject a synthesis reminder once the completed
    // turn count crosses the threshold. `turn` is 0-indexed so
    // `turn + 1` is the human-readable count of turns executed so far.
    const budgetThreshold = Math.floor(maxTurns * BUDGET_WARNING_RATIO);
    if (
      !budgetWarningInjected
      && maxTurns >= BUDGET_WARNING_MIN_TURNS
      && turn + 1 >= budgetThreshold
      && resultBlocks.length > 0
    ) {
      const remaining = Math.max(1, maxTurns - (turn + 1));
      const warning =
        '\n\n===== SYSTEM BUDGET NOTICE =====\n' +
        `You have used ${turn + 1}/${maxTurns} tool-loop turns. ` +
        'STOP calling tools for more research and write your FINAL ANSWER as plain text now. ' +
        `The remaining budget (${remaining} turn${remaining === 1 ? '' : 's'}) is for synthesis only, ` +
        'not more data fetching. If the task is impossible with what you already have, ' +
        'say so concisely with what you did find. ' +
        'Do NOT start a new round of Bash/Read/Grep/Agent calls.\n' +
        '=================================';
      const last = resultBlocks[resultBlocks.length - 1] as Extract<ContentBlock, { type: 'tool_result' }>;
      appendNoticeToToolResult(last, warning);
      budgetWarningInjected = true;
      debug.log('llm.router', 'tool-loop.budget-warning.injected', {
        turn, maxTurns, threshold: budgetThreshold, remaining,
      });
    }

    history.push({ role: 'user', content: resultBlocks });
    if (postToolResultUserNote) {
      // Appended after the tool_result user turn so the wire order is
      // assistant(tool_use) → user(tool_result) → user(intervention).
      // This is the "retry" or "guidance" branch of the doom-loop ASK
      // route — see routeDoomLoopToAskUser above.
      history.push({ role: LOOP_SELF_NOTE_ROLE, content: postToolResultUserNote });
    }
    if (hardStopText) {
      // W5-E (2026-05-03 PM) — Force-synthesis no-tools pass. Before
      // emitting the [SYNTHESIS IGNORED] / [ACTION IGNORED] / [VERIFY
      // IGNORED] fallback notice, give codex ONE chance to write the
      // synthesis with tools removed entirely. The model already has
      // the file contents in its prior tool_result blocks; the only
      // reason it kept emitting tools was the tools were available.
      // Removing them forces a text-only response.
      //
      // Scope: codex-family hard-stops only. Doom-loop / auto-undo
      // hard-stops are NOT synthesizable — they need user intervention,
      // identified by the `[ASK USER]` / `[EXECUTION DOOM DETECTED]`
      // markers. Every other codex hard-stop variant (the [...IGNORED]
      // family AND the IGNORED-less ones — `[FINAL ANSWER REQUIRED]`,
      // inspect-fallback-summary, execution-failure-fallback) IS a
      // search-loop pathology where force-synthesis lifts the brief
      // notice to substantive analysis (W5-E original intent — earlier
      // gating on `IGNORED]` was too narrow and let the budget +
      // forceFinalAnswer paths emit 200-300 char fallbacks unchanged,
      // measured in 4/5 PASS variance log/debug-20260503183812.log
      // run-2: 237 chars, hardStopReason=null defaulted to 'budget',
      // forceSynthesisAttempted=false). The notice text is kept as a
      // fallback when force-synthesis fails (model still empty / errors).
      const isUserInterventionRequired =
        hardStopText.includes('[ASK USER]')
        || hardStopText.includes('[EXECUTION DOOM DETECTED]');
      // gemini extension (2026-05-04) — gemini-3.x exhibits the same
      // function-call-only pathology that Fix W5-E was originally built
      // for: emits functionCall blocks every turn with textChars=0,
      // never reaching the natural text-only termination. Validated in
      // log/debug-20260504233443.log — 8 turns, every textChars=0,
      // forceSynthesisOutcome="skipped" (was: non-codex-family). Same
      // fix shape (no-tools synthesis with prior tool_results as
      // context) lifts the empty reply to substantive answer.
      const isForceSynthesisFamily =
        modelFamily === 'codex' || modelFamily === 'gemini';
      const shouldForceSynthesis =
        isForceSynthesisFamily
        && !isUserInterventionRequired
        && !forceSynthesisAttempted;
      let synthesizedText: string | null = null;
      if (shouldForceSynthesis) {
        forceSynthesisAttempted = true;
        synthesizedText = await tryForceSynthesisPass({
          provider,
          model: effectiveModel,
          history,
          turn,
          modelFamily,
          // Live progressive streaming — deltas emit through handlers
          // during collection so TUI shows synthesis text as it
          // generates instead of one big chunk at the end.
          streamingHandlers: handlers,
        });
      }
      const emittedText = synthesizedText ?? hardStopText;
      const finalText = finalizeVisibleAssistantText(
        appendFinalSynthesisNotice(fullText, emittedText),
        emittedText,
        sawToolRound,
      );
      // When synthesis succeeded AND finalText equals the already-
      // streamed text, skip the post-emit (would clear + replace the
      // display, causing flicker / "all-at-once" UX). When finalText
      // diverges (enrichment added) OR synthesis failed (fallback to
      // hardStopText notice), emit normally.
      if (synthesizedText === null || finalText !== synthesizedText) {
        handlers.onText('', finalText);
      }
      if (synthesizedText) {
        debug.log('llm.router', 'tool-loop.force-synthesis-pass.emitted', {
          turn,
          textLen: synthesizedText.length,
          replacedNotice: hardStopText.slice(0, 120),
        });
      } else {
        debug.log('llm.router', 'tool-loop.synthesis-ignored.hard-stop', {
          turn,
          hardStopReason: hardStopReason ?? (inExplorationSynthesisPhase ? 'exploration' : 'budget'),
          exploratoryTurnStreak,
          inspectFollowupMode,
          autoNarrowedReadCount,
          inspectSynthesisArmed,
          repairActionArmed,
          verifyActionArmed,
          lastExecutionCommand: executionLoopState.lastCommand,
          lastVerificationCommand: verificationLoopState.lastCommand,
          forceSynthesisAttempted,
          // F1 (2026-05-03 PM+++): expose WHY synthesis was skipped so
          // future regressions surface in one log line. doom/auto-undo
          // = expected gate; non-codex = expected; alreadyAttempted =
          // W5-E re-entry guard. Anything else means the gate logic
          // drifted again.
          synthesisSkipReason:
            isUserInterventionRequired ? 'user-intervention-required'
            : !isForceSynthesisFamily ? 'family-not-eligible'
            : forceSynthesisAttempted ? 'already-attempted-this-turn'
            : 'unknown',
        });
      }
      emitTurnComplete(finalText);
      return finalText;
    }

    // W5-G (2026-05-03 PM++) — Early force-synthesis trigger. After
    // the per-turn dispatch settles and history is updated, check if
    // codex/gemini has racked up 4+ consecutive turns with NO Read/
    // Edit/Write/Lsp call. That's the search-loop pathology (rg
    // --files / find / Glob / ListDir repeated; or, for gemini-3.x,
    // function-call-only with no text). Letting the loop continue
    // burns the rest of maxTurns before W5-E ([...IGNORED]) or W5-F
    // (max-turns) eventually fires the same force-synthesis. Trigger
    // it NOW with the focused history — same quality, ~100-130 s less
    // latency. Shares the forceSynthesisAttempted guard with W5-E +
    // W5-F so each streamLLMWithTools invocation gets at most one
    // synthesis attempt. Extended to gemini 2026-05-04 alongside
    // W5-E/W5-F for the same pathology shape.
    if (
      (modelFamily === 'codex' || modelFamily === 'gemini')
      && !forceSynthesisAttempted
      && noContentReadTurnStreak >= 4
    ) {
      forceSynthesisAttempted = true;
      const earlyText = await tryForceSynthesisPass({
        provider,
        model: effectiveModel,
        history,
        turn,
        modelFamily,
        streamingHandlers: handlers,
      });
      if (earlyText) {
        const finalText = finalizeVisibleAssistantText(
          appendFinalSynthesisNotice(fullText, earlyText),
          earlyText,
          sawToolRound,
        );
        // Skip post-emit when synthesis was already streamed live
        // (finalText === earlyText). Emit only when finalization
        // enriched the text (would otherwise leave display showing
        // unenriched version).
        if (finalText !== earlyText) {
          handlers.onText('', finalText);
        }
        debug.log('llm.router', 'tool-loop.force-synthesis-pass.emitted', {
          turn,
          textLen: earlyText.length,
          replacedNotice: 'W5-G early trigger',
          trigger: 'no-content-read-streak',
          noContentReadTurnStreak,
        });
        emitTurnComplete(finalText);
        return finalText;
      }
      debug.log('llm.router', 'tool-loop.force-synthesis-pass.early-failed', {
        turn,
        noContentReadTurnStreak,
      }, { level: 'error' });
    }
  }

  // The tool loop ended without a final text-only assistant answer.
  // Preserve the budget-exhaustion recovery path, while reporting cancellation
  // separately so callers do not mistake it for consumed turn budget.
  //
  if (loopTermination === 'aborted' && toolCallHistory.length === 0) {
    debug.log('llm.router', 'tool-loop.aborted-without-tools', {
      turn: terminalTurn,
      textChars: fullText.length,
    });
    emitTurnComplete(fullText);
    return fullText;
  }

  // Fix B (2026-04-25 evening): when codex exhausts the budget without
  // ever entering the exploration-synthesis phase (common with Fix T's
  // reduced 4-turn cap — phase entry and loop end coincide), the bare
  // notice was the only output → 177-char sterile fallback. Append the
  // exploration summary builder (Fix A) so users still see WHAT the
  // model attempted regardless of which terminal path fired.
  const explorationFallback = loopTermination === 'aborted'
    ? ''
    : buildExplorationFallbackSummary(toolCallHistory);
  const noticeWithFallback = loopTermination === 'aborted'
    ? '⏹️ 중단했습니다.'
    : (() => {
      const notice = buildNoFinalSynthesisNotice(loopTermination);
      return explorationFallback ? `${notice}\n\n${explorationFallback}` : notice;
    })();

  // W5-F (2026-05-03 PM++) — Extend force-synthesis to budget-exhaust
  // path. W5-E already handles the [...IGNORED] hard-stop family; this
  // mirror covers the max-turns terminal which previously emitted only
  // the notice + exploration summary (typically 200-600 chars of
  // generic fallback). For codex (gpt-5.5) the search-loop pathology
  // means the entire turn budget produces only fallback as user-facing
  // output (measured in log/wave7bc/ — 237/517/562 char ranges across
  // shaped/shell-shaped/hybrid toolsets). One no-tools synthesis with
  // the gathered tool_results as context typically lifts that to
  // 1500-3000 chars substantive answer.
  let synthesizedText: string | null = null;
  const shouldForceSynthesisOnBudget =
    loopTermination === 'budget-exhausted'
    && (modelFamily === 'codex' || modelFamily === 'gemini')
    && !forceSynthesisAttempted;
  if (shouldForceSynthesisOnBudget) {
    forceSynthesisAttempted = true;
    synthesizedText = await tryForceSynthesisPass({
      provider,
      model: effectiveModel,
      history,
      turn: maxTurns,
      modelFamily,
      streamingHandlers: handlers,
    });
  }
  const emittedText = synthesizedText ?? noticeWithFallback;
  const finalText = finalizeVisibleAssistantText(
    appendFinalSynthesisNotice(fullText, emittedText),
    emittedText,
    loopTermination === 'aborted' ? false : sawToolRound,
  );
  // Skip post-emit when synthesis was already streamed live AND
  // finalText matches synthesizedText. Emit when synthesis failed
  // (fallback notice) OR finalization enriched the text.
  if (synthesizedText === null || finalText !== synthesizedText) {
    handlers.onText('', finalText);
  }
  if (synthesizedText) {
    debug.log('llm.router', 'tool-loop.force-synthesis-pass.emitted', {
      turn: maxTurns,
      textLen: synthesizedText.length,
      replacedNotice: noticeWithFallback.slice(0, 120),
      trigger: 'budget-exhausted',
    });
  }
  debug.log('llm.router', 'tool-loop.max-turns.no-final-synthesis', {
    turn: terminalTurn,
    trigger: loopTermination,
    maxTurns,
    hadPriorText: fullText.length > emittedText.length,
    finalTextInjected: true,
    fallbackSummaryAppended: explorationFallback.length > 0,
    fallbackChars: explorationFallback.length,
    toolCallCount: toolCallHistory.length,
    inspectFollowupMode,
    autoNarrowedReadCount,
    inspectSynthesisArmed,
    repairActionArmed,
    verifyActionArmed,
    lastExecutionCommand: executionLoopState.lastCommand,
    lastVerificationCommand: verificationLoopState.lastCommand,
    forceSynthesisOutcome: synthesizedText
      ? 'synthesized'
      : shouldForceSynthesisOnBudget
        ? 'failed'
        : 'skipped',
  });
  emitTurnComplete(finalText);
  return finalText;
}

// ── User-config driven provider selection ─────────────────────────
//
// When the user has run the onboarding wizard (or edited config.json),
// we want provider choice + API key + model + baseUrl to come from
// there — not from environment variables. Env still wins when
// `llm.provider === 'auto'` (the auto-detect fallthrough below matches
// the original `getProvider()` behavior exactly).
//
// `openai-codex` is a thin OpenAI variant with a different default
// model (`gpt-5.6-terra`). The protocol is identical to OpenAI's
// /v1/chat/completions; callers wanting a self-hosted proxy set
// `baseUrl` in config.

import type { LLMConfig as UCLLMConfig, UserConfig } from './user-config.js';
import { loadTokens, readCodexMirrorTokens } from './oauth/store.js';
import { resolveCodexAccount, effectiveCodexHome } from './oauth/codex-account.js';
import { join } from 'node:path';
import {
  CODEX_API_BASE_URL, getCodexUserAgent, loadFreshCodexAuthState,
} from './oauth/codex.js';
import { extractChatGPTClaims } from './oauth/jwt.js';

// ⭐ 2026-09-23 (대표) — 운영 기본을 GPT-6 Sol 로 옮겼다(구 gpt-5.6-terra).
//   ⛔ 이 상수는 «최후 폴백»이다 — 정상 경로는 `llm-tier-map` 의 사다리를 탄다.
//   📏 구독 경로 실호출 확인(codex-cli 0.155.1 · 2026-09-23): `codex exec --model gpt-6-sol` ✅
//   ⚠️ 0.154.0 에서는 같은 계정이 400 이었다 — 클라이언트 판이 게이트였다.
export const CODEX_DEFAULT_MODEL = 'gpt-6-sol';
export const CODEX_DEFAULT_URL = 'https://api.openai.com/v1/chat/completions';

/** Build an OpenAI-compatible provider (grok / openai) using the
 *  user-config override values. Used when the user has explicitly
 *  picked one of these providers in onboarding.
 *
 *  2026-05-05 — the 'local' provider used to flow through here too,
 *  but the two-builder split (singleton + this factory) silently
 *  diverged on wire body shape (preset / spec-strip / multi-node).
 *  `makeLocalProvider` (above) is now the single source of truth for
 *  provider:'local' config; this factory stays generic for
 *  apiKey-gated OpenAI-compat brands. See 내부 문서-
 *  3.6-2026-05-05.md §11.1 for the full rationale. */
/** True when a baseUrl points at the local loopback (localhost / 127.0.0.1
 *  / ::1 / 0.0.0.0). Such a URL is only valid for the `local` provider, not
 *  for cloud brands (grok / openai) — see makeOpenAICompatProvider. */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host === '0.0.0.0'
      || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

function makeOpenAICompatProvider(
  name: string,
  defaultModel: string,
  defaultUrl: string,
  cfg: UCLLMConfig,
  wire: { model?: (model: string) => string; headers?: Record<string, string>; omitDefaultTemperature?: boolean; omitMaxTokens?: boolean; extraBody?: Record<string, unknown> } = {},
): LLMProvider {
  const resolvedUrl = (() => {
    // A `baseUrl` override is meant for a custom CLOUD gateway/proxy for the
    // brand. A LOOPBACK baseUrl (localhost / 127.0.0.1 / ::1) is never a
    // valid grok/openai endpoint — it's a stale leftover from a previous
    // `local` provider config (e.g. the user switched from an LM-Studio
    // local LLM on :1234 to grok without clearing baseUrl). Honoring it
    // would silently route grok/openai requests to the dead local port and
    // surface as "auth/provider not working" (dogfood 2026-06-08). Ignore
    // loopback baseUrl here and fall back to the canonical brand URL.
    if (cfg.baseUrl && !isLoopbackBaseUrl(cfg.baseUrl)) {
      return cfg.baseUrl.endsWith('/chat/completions')
        ? cfg.baseUrl
        : `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
    }
    if (cfg.baseUrl && isLoopbackBaseUrl(cfg.baseUrl) && debug.enabled) {
      debug.log('llm.provider', 'ignore-loopback-baseUrl', {
        provider: name, baseUrl: cfg.baseUrl, using: defaultUrl,
      });
    }
    return defaultUrl;
  })();
  const apiKey = cfg.apiKey;
  const model = cfg.model || defaultModel;
  // ⭐ grok 만 «구독 1순위» (대표 2026-08-13). makeCodexProvider 가 ChatGPT OAuth 에
  //   대해 이미 쓰는 것과 «같은 형태»다 — OAuth 가 있으면 그쪽 엔드포인트로,
  //   없을 때만 apiKey + 브랜드 기본 URL.
  //   ⛔ openai 경로는 이 분기를 «안» 탄다 — 종전과 바이트 동일(무회귀).
  //   ⚠️ 사용자가 baseUrl 을 명시로 덮었으면 그 뜻을 존중해 구독으로 가로채지 않는다.
  const grokSubscription = name === 'grok' && resolvedUrl === defaultUrl
    // ⭐ 요청 경로이므로 «접힌» 해석을 쓴다 — 만료 임박이면 여기서 갱신이 유도된다.
    ? resolveFreshGrokCredential({ model: cfg.model || defaultModel })
    : null;
  const grokSub = grokSubscription?.kind === 'subscription' ? grokSubscription : null;
  return {
    name,
    defaultModel: model,
    available: () => !!apiKey || grokSub !== null,
    async *streamChat(messages, opts = {}) {
      if (!apiKey && !grokSub) {
        throw new Error(`${name} unavailable: configure apiKey via \`elanous setup\``);
      }
      const tools = toOpenAITools(opts.tools);
      // Image-pipeline P3.5 — gate the synthetic follow-up workaround
      // on the userMessage axis for the active model + brand. `name`
      // is 'grok' or 'openai' for makeOpenAICompatProvider callers.
      // P-3 §6.9 (2026-05-07) — same lookup also gates user-message
      // image blocks in the wire.
      const activeModel = opts.model || model;
      const brand = name as Parameters<typeof isVisionCapableModel>[0];
      const followup = isVisionCapableModel(brand, activeModel, 'userMessage');
      // 구독이 있으면 «엔드포인트와 자격이 통째로» 바뀐다(cli-chat-proxy + Bearer).
      // 모델별 라우팅은 본문이 아니라 헤더로 가므로 활성 모델로 다시 만든다.
      // ⛔ 여기선 «접힌» 해석을 쓰지 않는다 — 위에서 이미 갱신을 유도했고,
      //   이 자리는 «모델별 헤더»만 다시 만드는 재해석이다(중복 유도 = 불필요한 20초 블로킹).
      const sub = grokSub ? resolveGrokCredential({ model: activeModel }) : null;
      const useSub = sub?.kind === 'subscription' ? sub : null;
      if (useSub) {
        debug.log('llm.grok', 'credential', { kind: useSub.kind, source: useSub.source, baseUrl: useSub.baseUrl, via: 'compat-provider' });
      }
      yield* streamOpenAIEvents(
        useSub ? `${useSub.baseUrl}/chat/completions` : resolvedUrl,
        useSub ? useSub.token : apiKey,
        {
          model: wire.model ? wire.model(activeModel) : activeModel,
          messages: messages.flatMap((m) => toOpenAIMessages(m, {
            acceptToolImagesViaFollowup: followup,
            acceptUserMessageImages: followup,
            ...(name === 'openrouter' ? { echoReasoningDetails: true } : {}),
          })),
          ...(() => {
            const fields = openAiCompatSamplingFields(brand, activeModel, opts.temperature ?? 0.3, opts.maxTokens ?? 2048);
            // ⛔ 2026-09-23 — OpenRouter 뒤의 추론 모델(kimi·glm·qwen …)은 기본 0.3 을 강제하면 안 된다:
            //   hermes 는 kimi 에 temperature 를 «아예» 안 보내고(게이트웨이가 thinking 1.0 / 비thinking 0.6 을 고름),
            //   openclaw 는 always-thinking(kimi-k3 등)에서 sampling 칸을 지운다. ⇒ 호출자가 «명시»할 때만 싣는다.
            if (wire.omitDefaultTemperature && opts.temperature === undefined) delete (fields as Record<string, number>).temperature;
            if (wire.omitMaxTokens) {
              delete (fields as Record<string, number>).max_tokens;
              delete (fields as Record<string, number>).max_completion_tokens;
            }
            return fields;
          })(),
          ...(tools ? { tools } : {}),
          ...(wire.extraBody ?? {}),
        },
        opts.signal,
        useSub ? useSub.headers : wire.headers,
      );
    },
    async *chat(messages, opts = {}) { yield* textOnly(this.streamChat!(messages, opts)); },
  };
}

/** 대표 2026-09-23 — OpenRouter. `makeOpenAICompatProvider` 위의 얇은 층 셋:
 *  ⑴ 키 — ⛔ `cfg.apiKey` 는 «설정된 provider» 의 키라, openrouter 가 교차 경로로 불릴 때
 *     (config=codex 등) 쓰면 남의 키를 OpenRouter 로 보낸다. 그래서 호출부가 config provider 가
 *     openrouter 일 때만 cfg 를 넘기고, 여기선 `cfg.apiKey` 가 없으면 키 캐시→env 로 간다.
 *  ⑵ wire 모델 — 카탈로그 id `openrouter/<vendor>/<model>` 에서 `openrouter/` 를 뗀다.
 *  ⑶ 귀속 헤더 `X-Title` — 선택 헤더. `HTTP-Referer` 는 저장소 URL 을 흘리므로 «안» 보낸다. */
function makeOpenRouterProvider(cfg: UCLLMConfig): LLMProvider {
  const inner = makeOpenAICompatProvider(
    'openrouter',
    OPENROUTER_MODEL,
    OPENROUTER_API_URL,
    { ...cfg, apiKey: cfg.apiKey || getOpenRouterApiKey() },
    // ⭐ BACKLOG C7 — `usage:{include:true}` 면 마지막 청크 `usage.cost` 에 «실제 청구액»이 온다(추정 아님).
    { model: openRouterWireModel, headers: { 'X-Title': 'elanous' }, omitDefaultTemperature: true, omitMaxTokens: true, extraBody: { usage: { include: true } } },
  );
  // ⛔ 2026-09-23 — OpenRouter 의 `max_tokens` 는 «추론 토큰까지» 센다. 호환 경로 기본값 2048 이면 추론 모델이
  //   본문·도구 호출에 닿기 전에 잘렸다(실측 glm-5.3: 2048 → finish=length). 오전 판은 바닥 16384 를 뒀고,
  //   결정 「codex 처럼 넉넉하게」(같은 날 저녁)로 ***아예 안 보낸다*** — codex 도 `max_output_tokens` 를 안 보낸다.
  //   📏 실측: kimi-k3·glm-5.3 둘 다 생략 시 200 · finish=stop. 쓴 만큼만 과금된다.
  return inner;
}

/** `openrouter/moonshotai/kimi-k3` → `moonshotai/kimi-k3`. 접두가 없으면 그대로. */
export function openRouterWireModel(model: string): string {
  return model.startsWith('openrouter/') ? model.slice('openrouter/'.length) : model;
}

/** Codex-specific provider. Prefers OAuth tokens from ~/.config/elanous/auth.json
 *  (refreshing them when within the 120s buffer) and falls back to the
 *  plain apiKey flow only when no tokens are on file. OAuth mode targets
 *  the ChatGPT backend at chatgpt.com/backend-api/codex; apiKey mode
 *  keeps the api.openai.com endpoint so a user with a developer API key
 *  can still bypass `elanous login`. */
function makeCodexProvider(cfg: UCLLMConfig): LLMProvider {
  const model = cfg.model || CODEX_DEFAULT_MODEL;
  // Initial token check is synchronous — we look for *presence* only and
  // resolve (with refresh) inside the async generator so we never
  // block constructor-time callers. available() returns true if EITHER
  // OAuth tokens or an apiKey is configured.
  const apiKey = cfg.apiKey;
  const hasOAuth = codexOAuthAvailable();
  // store=true wave: closure-scoped state so multi-turn callers
  // (dashboard reusing the same provider across a chat session) get
  // delta-only continuation. Single-turn callers (eval-prompt-cli
  // builds a fresh provider per prompt) start with these undefined
  // and naturally fall back to full-input mode. Not thread-safe —
  // multiple concurrent streamChat calls on the SAME provider
  // instance would race; current call sites avoid that (one stream
  // active at a time per session).
  let lastResponseId: string | undefined;
  let lastInput: ResponsesInputItem[] | undefined;
  return {
    name: 'openai-codex',
    defaultModel: model,
    available: () => hasOAuth || !!apiKey,
    async *streamChat(messages, opts = {}) {
      // Resolve auth at call-time: re-load (in case user just ran
      // `elanous login`) and refresh if the access token is within the
      // buffer window. Rotating refresh tokens get persisted back —
      // saveTokens() mirrors to ~/.codex/auth.json too, keeping the
      // official Codex CLI happy.
      // Drop a loopback baseUrl (local-LLM residue) so codex hits its
      // canonical endpoint (chatgpt.com/backend-api/codex · api.openai.com)
      // instead of the local server. A `local`→`openai-codex` rotation flip
      // can leave `baseUrl: http://localhost:1234/v1` behind (rotation
      // doesn't clear a stale top-level baseUrl); makeCodexProvider would
      // otherwise send codex requests to LM Studio → 1s "Internal error"
      // (incident 2026-07-17, TUI codex dead). Reuses the shared loopback
      // detector; remote codex-proxy overrides still pass through. Observe
      // the correction (self-cognition §1).
      const rawBase = cfg.baseUrl;
      const cfgBase = rawBase && isLoopbackBaseUrl(rawBase) ? undefined : rawBase;
      if (rawBase && !cfgBase) {
        debug.log('llm.router', 'codex.loopback-baseurl-ignored', { rawBase });
      }
      // Resolve codex auth via the shared resolver: reconciles with the
      // ~/.codex/auth.json source of truth (the official `codex` CLI rotates
      // the shared refresh token + OpenAI revokes the prior one, so elanous's
      // own copy can be stale), refreshes when expiring, and survives the
      // concurrent-refresh race (401 → re-read → retry). See
      // loadFreshCodexAuthState.
      const state = await loadFreshCodexAuthState();

      // Precedence:
      //   OAuth tokens present → Codex Responses API at chatgpt.com/
      //     backend-api/codex/responses (or cfg.baseUrl /responses override).
      //     This is the actual endpoint the official Codex CLI uses.
      //   API key only → /chat/completions at api.openai.com/v1.
      // Both on file → OAuth wins (user explicitly logged in).
      if (state) {
        const tokens = state.tokens;
        const responsesUrl = cfgBase
          ? (cfgBase.endsWith('/responses') ? cfgBase : `${cfgBase.replace(/\/$/, '')}/responses`)
          : `${CODEX_API_BASE_URL}/responses`;
        // Image-pipeline P3 (2026-05-05) — gate the function_call_output
        // ContentItem[] wire on the active model. gpt-5 family supports
        // image_url in tool results; legacy gpt-4 / non-vision routes
        // fall through to the legacy stringifyToolResultContent path.
        const codexAcceptToolImages = acceptsToolResultImage(
          'openai-codex',
          opts.model || model,
        );
        // P-3 §6.9 (2026-05-07) — user-message image axis. Same allowlist
        // as toolResult for Codex (gpt-5 family supports both); kept
        // explicit so a future axis-divergent model only flips one knob.
        const codexAcceptUserImages = isVisionCapableModel(
          'openai-codex',
          opts.model || model,
          'userMessage',
        );
        const { instructions, input } = messagesToResponsesInput(messages, {
          acceptToolImages: codexAcceptToolImages,
          acceptUserMessageImages: codexAcceptUserImages,
        });
        const tools = toCodexResponsesTools(opts.tools, opts.serverTools);
        // Codex backend rejects max_output_tokens + temperature — omit.
        // accountId comes from state.chatGPT (JWT-decoded on login +
        // refresh by saveTokens). Fall back to live-decoding the
        // current access token when the stored state predates L1 and
        // has no claims cached — this one-time migration avoids
        // forcing the user to re-login just to get the subscription
        // header in flight. Subsequent saves will populate
        // state.chatGPT for future turns.
        const accountId = state.chatGPT?.accountId
          ?? extractChatGPTClaims(tokens.accessToken)?.accountId;
        // Reasoning resolution precedence (mirrors
        // effectiveReasoningLevel):
        //   1. cfg.codexReasoning           — advanced fine-grained
        //   2. effectiveReasoningLevel(...) — explicit user level OR
        //      model-default 'medium' for reasoning-capable gpt-5
        //      family. Models that don't support reasoning return
        //      'off' here so wire body skips the field automatically.
        const effLevel = effectiveReasoningLevel(cfg, 'openai-codex', opts.model || model);
        // Per-call override(opts.reasoningEffort) wins — 리즈닝 무거운 op 가 전역 config
        // 오염 없이 high/max 요청. 없으면 기존 우선순위(cfg.codexReasoning → level).
        const reasoning = opts.reasoningEffort
          ? { effort: opts.reasoningEffort, summary: 'auto' as const }
          : (cfg.codexReasoning ?? mapReasoningLevelToCodex(effLevel, opts.model || model));
        // store=true wave: incremental continuation. When opted in
        // (default) and the current input is a strict extension of
        // last turn's input, send only the delta and thread
        // previous_response_id so the backend reconstructs prior
        // state from its stored response. On the first call OR when
        // history truncated/diverged (force-synthesis, /clear),
        // getIncrementalItems returns null and we ship the full input
        // with no previous_response_id — naturally rebasing the
        // server-side state.
        //
        // NO-GO on ChatGPT subscription endpoint: chatgpt.com/backend-
        // api/codex hard-rejects store=true with "Store must be set to
        // false". ref/codex's client.rs:887 mirrors this — `store:
        // provider.is_azure_responses_endpoint()`. So the wave only
        // helps users on api.openai.com (API-key mode) or Azure;
        // ChatGPT Plus/Pro users (the OAuth path here) MUST send
        // store=false. We auto-detect the endpoint and disable the
        // wave for ChatGPT regardless of cfg.codexStore — the
        // infrastructure stays in place for Azure/API-key paths and
        // for any future ChatGPT-side policy change.
        const endpointSupportsStore = !responsesUrl.includes('chatgpt.com/backend-api');
        const useStore = endpointSupportsStore && cfg.codexStore !== false;
        const delta = useStore ? getIncrementalItems(lastInput, input) : null;
        const wireInput = delta ?? input;
        const wirePrevId = (delta && lastResponseId) ? lastResponseId : undefined;
        yield* streamCodexResponsesEvents(responsesUrl, tokens.accessToken, {
          model: opts.model || model,
          instructions,
          input: wireInput,
          ...(tools ? { tools } : {}),
          ...(toResponsesToolChoice(opts.toolChoice) ? { tool_choice: toResponsesToolChoice(opts.toolChoice) } : {}),
          // Codex reasoning opt-in. Only the OAuth /responses path
          // honors this; the API-key /chat/completions fallback below
          // doesn't carry the equivalent fields.
          ...(reasoning ? { reasoning } : {}),
          // store=true + previous_response_id: opt in by default; user
          // can disable via llm.codexStore=false.
          store: useStore,
          ...(wirePrevId ? { previousResponseId: wirePrevId } : {}),
        }, opts.signal, {
          accountId,
          // Capture the new response id from the SSE stream so the
          // next call can thread it. If the backend skips the event
          // lastResponseId stays undefined and we fall back to full
          // input on the next turn (safe — just no token savings).
          onResponseCreated: useStore ? (id) => { lastResponseId = id; } : undefined,
          remainingFallbacks: opts.remainingFallbacks,
        });
        // Snapshot full input AFTER the stream completes so the next
        // call's delta computation uses what the backend actually has
        // stored. If the stream errors out partway, lastInput stays
        // at its prior value — next call will diverge → null delta →
        // full rebase. That's the correct fallback (no orphan state).
        if (useStore) lastInput = input;
        return;
      }

      if (!apiKey) {
        throw new Error('openai-codex unavailable: run `elanous login openai-codex` or set `llm.apiKey`');
      }
      // API-key mode: standard OpenAI /v1/chat/completions.
      const url = cfgBase
        ? (cfgBase.endsWith('/chat/completions') ? cfgBase : `${cfgBase.replace(/\/$/, '')}/chat/completions`)
        : CODEX_DEFAULT_URL;
      const tools = toOpenAITools(opts.tools);
      // Image-pipeline P3.5 — even in API-key fallback mode (Chat
      // Completions), gpt-5.x accepts image_url on user messages.
      // Brand here is 'openai' since this path uses /chat/completions
      // not /responses (the Responses path is the OAuth branch above).
      const apiKeyModel = opts.model || model;
      const apiKeyFollowup = isVisionCapableModel('openai', apiKeyModel, 'userMessage');
      yield* streamOpenAIEvents(url, apiKey, {
        model: apiKeyModel,
        messages: messages.flatMap((m) => toOpenAIMessages(m, {
          acceptToolImagesViaFollowup: apiKeyFollowup,
          acceptUserMessageImages: apiKeyFollowup,
        })),
        ...openAiTemperatureField(apiKeyModel, opts.temperature ?? 0.3),
        ...openAiOutputTokenField(apiKeyModel, opts.maxTokens ?? 2048),
        ...(tools ? { tools } : {}),
      }, opts.signal, undefined, opts.remainingFallbacks);
    },
    async *chat(messages, opts = {}) { yield* textOnly(this.streamChat!(messages, opts)); },
  };
}

function makeAnthropicProvider(cfg: UCLLMConfig): LLMProvider {
  const apiKey = cfg.apiKey;
  const model = cfg.model || ANTHROPIC_MODEL;
  return {
    name: 'anthropic',
    defaultModel: model,
    available: () => !!apiKey,
    async *streamChat(messages, opts = {}) {
      if (!apiKey) throw new Error('Anthropic unavailable: configure apiKey via `elanous setup`');
      // Mirror AnthropicProvider — prompt caching ON, all 4 slots.
      const { getDefaultCacheTTL } = await import('./config.js');
      const cache = opts.promptCache !== false;
      const ttl = opts.promptCacheTTL ?? getDefaultCacheTTL();
      const {
        toAnthropicSystemBlocks, toAnthropicToolsCached,
        applyHistoryCacheBreakpoint, applyAnchorCacheBreakpoint,
      } = await import('./prompt-cache/anthropic.js');
      const system = toAnthropicSystemBlocks(messages, { cache, ttl });
      // P-3 §6.9 — same gating as AnthropicProvider.streamChat above.
      const acceptUserImages = isVisionCapableModel('anthropic', opts.model || model, 'userMessage');
      let convo = messages
        .filter(m => m.role !== 'system')
        .map(m => toAnthropicMessage(m, { acceptUserMessageImages: acceptUserImages }));
      convo = applyAnchorCacheBreakpoint(convo, { cache, ttl });
      convo = applyHistoryCacheBreakpoint(convo, { cache, ttl });
      const tools = toAnthropicToolsCached(opts.tools, { cache, ttl });
      // Wave 2 (2026-05-04) — prompt cache forensic. Dump the
      // 4-slot signature (system / tools / history / anchor) so the
      // user can compare across calls and see WHY a break occurred.
      // Each slot's signature is its content length (cheap, no
      // hashing), enough to detect "did it change at all". When a
      // signature changes from one call to the next, the
      // corresponding cache slot was invalidated. ref/claude-code-fork
      // does richer dim-diff (`promptCacheBreakDetection.ts`) but
      // length-based signature catches 90%+ of break causes
      // (instructions edited, tool list resized, history extended).
      if (debug.enabled && cache) {
        const sigSize = (v: unknown): number => {
          if (typeof v === 'string') return v.length;
          if (Array.isArray(v)) return v.reduce((acc, item) => acc + sigSize(item), 0);
          if (v && typeof v === 'object') {
            let n = 0;
            for (const val of Object.values(v as Record<string, unknown>)) n += sigSize(val);
            return n;
          }
          return 0;
        };
        debug.log('chat.cache.dim', 'anthropic 4-slot signature', {
          ttl,
          systemSize: sigSize(system),
          toolsSize: sigSize(tools),
          historySize: sigSize(convo),
          messageCount: convo.length,
          anchorMarked: convo.length >= 4,
          historyMarked: convo.length >= 2,
        });
      }
      // Same precedence as codex: explicit user level OR model-default
      // 'medium' for reasoning-capable claude (4-family / 3.7).
      // Anthropic providers don't have a fine-grained override block
      // analogous to codexReasoning; just the level.
      const effLevel = effectiveReasoningLevel(cfg, 'anthropic', opts.model || model);
      const anthropicModel = opts.model || model;
      // Wire shape diverges by family: 4.8+ uses adaptive thinking +
      // output_config.effort; 3.7 / 4.0–4.7 use legacy enabled+budget.
      const adaptive = usesAdaptiveThinking(anthropicModel);
      const thinking = adaptive ? undefined : mapReasoningLevelToAnthropicThinking(effLevel);
      const effort = adaptive ? mapReasoningLevelToAnthropicEffort(effLevel) : undefined;
      // Extended-thinking (either shape) pins temperature to the model
      // default — non-default temperatures error out. Drop temperature
      // whenever any thinking mode is active; keep 0.3 otherwise.
      const thinkingActive = Boolean(thinking) || Boolean(effort);
      // budget path: bump max_tokens by budget*1.5 for answer headroom.
      // adaptive path: give a fixed headroom (model self-manages budget).
      const maxTokens = thinking
        ? Math.max(opts.maxTokens ?? 2048, Math.floor(thinking.budget_tokens * 1.5) + 2048)
        : effort
          ? Math.max(opts.maxTokens ?? 8192, 8192)
          : (opts.maxTokens ?? 2048);
      yield* streamAnthropicEvents(apiKey, {
        model: anthropicModel,
        messages: convo,
        ...(system !== undefined ? { system } : {}),
        max_tokens: maxTokens,
        ...(thinking ? { thinking } : {}),
        ...(effort ? { thinking: { type: 'adaptive' }, output_config: { effort } } : {}),
        ...anthropicTemperatureField(anthropicModel, thinkingActive, opts.temperature),
        ...(tools ? { tools } : {}),
      }, opts.signal, opts.remainingFallbacks);
    },
    async *chat(messages, opts = {}) { yield* textOnly(this.streamChat!(messages, opts)); },
  };
}

/** Best-effort mapping from a model id to the provider that hosts
 *  it. Used by skill-runner to decide whether to drop a cross-provider
 *  model hint when user-config has picked a different active provider.
 *  `null` = unknown / free-form (don't strip — let the provider
 *  handle or error). */
export function inferProviderFromModel(model: string | undefined): string | null {
  if (!model) return null;
  // RFC #2161 Phase 8 (2026-05-11) — registry catalog is the single
  // source of truth. Legacy alias map (`resolveModelAlias`) still runs
  // first for shortcuts that pre-date the catalog (e.g. 'haiku-3-5' →
  // 'claude-3-5-haiku-20241022'); after that, registry's prefix scan
  // covers shipping models + `_patterns.yaml` fallback for the long
  // tail (claude-/gpt-/o1-/o3-/o4-/codex-/local:/gemini-/grok-).
  //
  // The legacy if-chain has been removed — the registry yaml catalog
  // ships every prefix the chain used to handle. New providers /
  // prefixes only need a yaml entry, no source-of-truth split.
  const aliased = resolveModelAlias(model) ?? model;
  const fromRegistry = registryInferProviderFromModel(aliased);
  if (fromRegistry === null) return null;
  // Back-compat shim — `codex-*` model ids dispatch to the legacy
  // `openai-codex` adapter (Codex Responses API has different reasoning
  // options + auth path). The merge into a single `openai` adapter
  // with a `kind:'codex'` modifier is tracked separately from this
  // RFC.
  if (fromRegistry === 'openai') {
    // codex-* ids dispatch to the legacy openai-codex adapter.
    if (aliased.toLowerCase().startsWith('codex-')) return 'openai-codex';
    // gpt-5.6 codex-SUBSCRIPTION models (sol / terra / luna) are catalogued
    // with provider:'openai-codex', but the registry prefix scan only sees
    // gpt- -> openai. Honour the intelligence-map catalog provider so they
    // route to the codex SUBSCRIPTION (oauth ~/.codex/auth.json) instead of
    // the separate paid OpenAI API — and so a cross-family override never
    // hands them a non-openai key (the sk-ant -> openai 401 root cause).
    // 대표 지적(2026-07-17): luna 는 codex 구독 안에서 돌아야 한다.
    try {
      const { BUILTIN_CATALOG } = require('./intelligence-map/model-catalog.js') as typeof import('./intelligence-map/model-catalog.js');
      const entry = BUILTIN_CATALOG.models.find((m) => m.id === aliased);
      if (entry?.provider === 'openai-codex') return 'openai-codex';
    } catch {
      // catalog unavailable — fall through to the registry result.
    }
  }
  return fromRegistry;
}

/** True when `model` belongs to the same family as `provider`. Used to
 *  decide if a SKILL's `model:` frontmatter can be sent as-is through
 *  a DIFFERENT provider that the user selected in config. Cross-family
 *  mismatches get the model hint stripped — the provider falls back to
 *  its own configured default. */
export function isModelCompatible(providerName: string, model: string | undefined): boolean {
  if (!model) return true;
  const implied = inferProviderFromModel(model);
  if (implied === null) return true;  // unknown prefix — let provider handle
  // openai-codex and openai accept each other's model families (gpt-*, codex-*).
  if ((providerName === 'openai-codex' || providerName === 'openai')
      && (implied === 'openai' || implied === 'openai-codex')) return true;
  // local accepts free-form names, but a model that resolves to a
  // SPECIFIC cloud family (haiku → anthropic, gpt-5 → openai, etc) is
  // almost certainly not what the user's LM Studio / Ollama backend
  // has downloaded. Strip the hint so the local provider falls back
  // to its configured default model.
  // Caught via 2026-05-08 dogfood: pdca-cycle's `model: haiku` reached
  // LM Studio and got "Invalid model identifier 'haiku'". (The
  // `local:` prefix path explicitly opts into local routing — that
  // stays compatible.)
  if (providerName === 'local') return implied === 'local';
  return providerName === implied;
}

/** Is ANY LLM provider actually usable right now, considering both
 *  env vars AND user-config (including Codex OAuth tokens)? Dashboard
 *  and slash-command layer use this to gate LLM features — the older
 *  `listProviders().some(p => p.available)` check missed codex OAuth
 *  because the codex provider only materializes when the user explicitly
 *  picks it in config. */
export function anyProviderAvailable(userConfig?: UserConfig): boolean {
  try {
    const cfg = userConfig ?? (() => {
      const { getUserConfig } = require('./user-config.js') as typeof import('./user-config.js');
      return getUserConfig();
    })();
    if (cfg.llm.provider !== 'auto') {
      // Explicitly-configured provider — try to build it; if the
      // constructor throws (local without baseUrl, etc.) it's unavailable.
      try {
        const p = getProviderForConfig(cfg);
        return p.available();
      } catch { return false; }
    }
  } catch { /* fall through to env check */ }
  return Object.values(PROVIDERS).some(p => p.available());
}

/** 직결 배선이 없는 계열 → OpenRouter 에서 그 벤더의 대표 모델(사다리 `openrouter` 에 선 것). */
const OPENROUTER_ROUTE_FOR_WIP_PROVIDER = {
  kimi: 'openrouter/moonshotai/kimi-k3',
  qwen: 'openrouter/qwen/qwen3.8-max-0902',
  glm: 'openrouter/z-ai/glm-5.3',
} as const;

/** Top-level resolver. Honors user-config first; falls through to
 *  env-var / auto-detect when provider is 'auto'. */
export function getProviderForConfig(
  userConfig: UserConfig,
  model?: string,
): LLMProvider {
  const { provider } = userConfig.llm;
  // ⛔ 2026-09-23 — `kimi`·`qwen`·`glm` 은 union·사다리에 있지만 «직결» 배선이 없다(사다리 `wip`).
  //   종전엔 `unknown provider: kimi` 로 «아무것도» 안 말하고 죽었다. 이제 실제로 도는 길이 있다(`openrouter`).
  const direct = OPENROUTER_ROUTE_FOR_WIP_PROVIDER[provider as keyof typeof OPENROUTER_ROUTE_FOR_WIP_PROVIDER];
  if (direct) {
    throw new Error(
      `${provider} 직결 provider 는 아직 배선되지 않았다 — OpenRouter 로 쓰라: `
      + `\`elanous config set llm.provider openrouter\` · \`elanous config set llm.model ${direct}\` `
      + `(키: \`bash scripts/add-api-key.sh OPENROUTER_API_KEY\`) · 또는 \`--role-llm <role>=openrouter[/<tier>]\``,
    );
  }
  debug.log('llm.router', 'getProviderForConfig', {
    configProvider: provider,
    configModel: userConfig.llm.model,
    requestedModel: model,
  }, { level: 'info' });
  const selectedDecision = decideProviderForConfig(userConfig, model);
  const decision = finalizeProviderModelCompatibility(selectedDecision);
  const resolvedProviderName = decision.provider.startsWith('auto:')
    ? decision.provider.slice('auto:'.length)
    : decision.provider;
  if (provider === 'auto') {
    if (resolvedProviderName === 'auto') throw new NoLlmProviderAvailableError();
    if (!isKnownProviderName(resolvedProviderName)) {
      throw new Error(`unknown provider: ${resolvedProviderName}`);
    }
    return PROVIDERS[resolvedProviderName]!;
  }
  if (!isKnownProviderName(resolvedProviderName)) {
    throw new Error(`unknown provider: ${resolvedProviderName}`);
  }
  const crossFamilyModel = (model || userConfig.llm.model) && resolvedProviderName !== provider;
  if (crossFamilyModel) {
    const keyPrefix = (userConfig.llm.apiKey || '').slice(0, 7);
    const keyImplies = keyPrefix.startsWith('sk-ant')
      ? 'anthropic'
      : keyPrefix.startsWith('xai-')
        ? 'grok'
        : keyPrefix.startsWith('sk-')
          ? 'openai'
          : keyPrefix
            ? 'unknown'
            : 'none';
    const keyMismatch =
      keyImplies !== 'none' &&
      keyImplies !== resolvedProviderName &&
      !(keyImplies === 'openai' && resolvedProviderName === 'openai-codex');
    debug.log('llm.router', 'cross-family-override', {
      configProvider: provider,
      model: decision.model,
      implied: resolvedProviderName,
      keyPrefix: keyPrefix || null,
      keyImplies,
      keyMismatch,
    }, { level: 'info' });
  }
  const llm = { ...userConfig.llm, provider: resolvedProviderName, model: decision.model };
  switch (resolvedProviderName) {
    case 'grok':
      return makeOpenAICompatProvider('grok', GROK_MODEL, GROK_API_URL, llm);
    case 'openai':
      return makeOpenAICompatProvider('openai', OPENAI_MODEL, OPENAI_API_URL, llm);
    case 'openai-codex':
      return makeCodexProvider(llm);
    case 'openrouter':
      return makeOpenRouterProvider(userConfig.llm.provider === 'openrouter' ? llm : { provider: 'openrouter', model: decision.model });
    case 'anthropic':
      return makeAnthropicProvider(llm);
    case 'gemini':
      // Wave 1 (2026-05-04) — native @google/genai SDK. Previously
      // makeOpenAICompatProvider tunnel which couldn't carry
      // systemInstruction / thinkingConfig / safetySettings.
      return makeGeminiProvider(llm);
    case 'local': {
      // Local needs a baseUrl OR LOCAL_LLM_URL env. Fail fast at
      // routing time (better error than a cryptic streamChat fetch
      // crash). 2026-05-05 — the wire body / preset / multi-node /
      // spec-strip pipeline lives in `makeLocalProvider` so the
      // singleton (auto-mode) and config-routed paths share one
      // source of truth (HANDOFF §11.1 root-fix).
      if (!userConfig.llm.baseUrl && !getLocalLLMUrl()) {
        throw new Error('Local LLM unavailable: set `llm.baseUrl` via `elanous setup` or LOCAL_LLM_URL env');
      }
      return makeLocalProvider(llm);
    }
  }
  // E1 (2026-05-17) — TS2366 closure: explicit unreachable fallback.
  // The switch above covers every LLMProvider name in the union, but
  // the compiler can't prove exhaustiveness across the `'auto'` early-
  // return + switch combo. Throws so a future provider added to the
  // union without a case here fails loud at first call.
  throw new Error(`unknown provider: ${provider as string}`);
}
import { getModelFamily } from './models/prompts.js';
import type { ModelFamily } from './models/prompts.js';

/**
 * ⛔⭐ OpenAI Chat Completions 의 «출력 상한» 칸 이름은 모델 세대로 갈린다.
 *
 * `gpt-5` 이후 계열은 `max_tokens` 를 ***거부한다*** — 400 `unsupported_parameter` 를 내고
 * *"Use 'max_completion_tokens' instead"* 라고 말한다. `gpt-4o` 계열은 반대로 옛 이름만 받는다.
 *
 * 📏 2026-08-22 실측: `provider auto` 의 티어 사다리가 `gpt-5.6-*` 로 바뀐 뒤(`#11161`)
 * 3시간 만에 이 400 이 **93건** 났고 «가속»했다(20h:2 → 21h:16 → 22h:30 → 23h:45).
 * 7일 창에서 그 이전 발생은 ***0***이다. ⇒ 칸 이름을 모델로 갈라야 한다.
 *
 * ⚠️ 값을 «안 보내는» 선택은 하지 않는다 — 상한이 사라지면 비용이 조용히 는다.
 */
/**
 * ⛔⭐⭐ **브랜드마다 «칸 이름」이 다르다**(2026-09-12). `makeOpenAICompatProvider` 는 `grok` 과
 * `openai` 를 «한 경로»로 태우는데, 종전엔 둘 다 옛 칸(`max_tokens`·`temperature`)을 «생으로» 박았다.
 * ⇒ `openai` 브랜드의 새 세대(`gpt-5`+)는 그 둘을 «거부»한다 — 400 `unsupported_parameter`.
 *
 * 📏 실측 2026-09-12: `gpt-6-astra · maxTokens=2048 · api.openai.com/v1/chat/completions` 가 400 을 받았고,
 *   그 400 이 `review.done` 미실행 57건 중 ***30건***의 사유였다(무인 리뷰가 그만큼 «안 돌았다»).
 *
 * ⭐ 자는 «이미» 있었다 — `openAiOutputTokenField`·`openAiTemperatureField`. ***이 호출부가 안 물었을 뿐이다.***
 * 🪞 같은 파일의 `stripLocalLlmSpec` 이 「두 builder 중 하나만 정규화했다」로 난 사고의 처방이었다.
 *   ***같은 모양이 다시 났다*** — 그래서 이번에도 «순수 함수로 뽑아» 양쪽이 같은 자를 쓰게 한다.
 *
 * ⛔ grok 은 옛 칸을 그대로 받는다 — 바꾸지 않는다.
 */
export function openAiCompatSamplingFields(
  brand: string,
  model: string,
  temperature: number,
  maxTokens: number,
): Record<string, number> {
  return brand === 'openai'
    ? { ...openAiTemperatureField(model, temperature), ...openAiOutputTokenField(model, maxTokens) }
    : { temperature, max_tokens: maxTokens };
}

export function openAiOutputTokenField(model: string, maxTokens: number): Record<string, number> {
  return isNewGenerationOpenAiModel(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

/** `gpt-5` 이후 계열 판정 — 옛 Chat Completions 파라미터를 거부하는 세대.
 *
 *  🩸⭐⭐ **2026-09-12 — 이 자가 «늙어서» 400 이 돌아왔다.** 종전 문면은 `/^(?:gpt-5|o[1-9])/` 라
 *  ***`gpt-6` 계열을 «못 봤다»***. 그래서 `gpt-6-astra` 가 `max_tokens` 로 나갔고 400 을 받았다:
 *    `Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens'`
 *  📏 실측(2026-09-12 · 12시간 창): `review.done` 200행 중 `reviewed=false` 57, 그중 ***30***이 이 400 이다.
 *    ⊕ 요청 로그가 그것을 한 줄로 말한다 — `gpt-6-astra · maxTokens=2048 · api.openai.com/v1/chat/completions`.
 *
 *  ⇒ ⭐ **세대를 「이름 목록」으로 세지 않는다.** 번호를 «범위»로 읽어 다음 세대가 와도 안 늙게 한다.
 *    `gpt-5` 이상(두 자리 포함) ⊕ `o1`~`o9`. ⛔ `gpt-4` 이하와 로컬 모델은 종전대로 옛 칸을 쓴다.
 *
 *  🌐 **외부 그라운딩**(2026-09-12 · omni-crawl `fc-dev`) — 같은 사고가 «업스트림에도» 있었다:
 *    · `quantumnous/new-api#7211` — *"GPT-6 Astra 未命中原来的 GPT-5 前缀判断"* (똑같은 접두 판정 누락)
 *    · `genkit-ai/genkit#6320`   — *"max_tokens is sent verbatim and rejected by reasoning models"*
 *    · Azure AI docs            — `gpt-6-astra`(2026-09-03) Chat Completions ⊕ Reasoning
 *    · overchat.ai              — *"Astra does not support `temperature`, `top_p`, `top_logprobs`"*
 *      ⇒ ✅ 우리가 `temperature` 를 «생략»하는 것이 외부 사실과 «맞는다».
 *      ⚠️ `top_p`·`logprobs` 는 이 경로가 «안 보낸다»(local 프리셋 경로만 보낸다) — 그래서 조치 없음.
 *
 *  ⚖️ ⛔ **알려진 트레이드오프 — new-api 는 «반대» 결론을 냈다.** 그들은
 *    *"모든 미래 GPT 메이저를 GPT-5 로 묶으면 서로 다른 모델의 파라미터 규칙이 엮인다"* 며
 *    ***미지의 미래 메이저는 추론하지 않는다***로 갔다(명시 목록 + 날짜 스냅샷).
 *    ⇒ 우리는 «반대»를 택했다. 이유: ***목록이 늙어서 이 사고가 났기 때문***이다
 *      (이 저장소에서 실제로 리뷰 미실행 30건을 냈다). 새 규칙은 «새 관례 쪽으로» 실패한다.
 *    📌 그러므로 ***`gpt-N` 중 옛 칸을 «되찾는» 모델이 나오면 이 자가 틀린다.*** 그때는
 *      여기서 갈지 말고 «모델별 능력 선언»으로 옮긴다(new-api 가 간 길). 지금은 그 표본이 0이다. */
export function isNewGenerationOpenAiModel(model: string): boolean {
  const match = /^gpt-(\d+)/i.exec(model);
  if (match) return Number.parseInt(match[1]!, 10) >= 5;
  return /^o[1-9]/i.test(model);
}

/**
 * ⛔⭐ 같은 세대가 `temperature` 도 거부한다 — 400 `unsupported_value`,
 * *"Only the default (1) value is supported"*.
 *
 * 📏 2026-08-22 실측: `max_tokens` 를 고친 «2분 뒤»(00:13:03Z)부터 이 400 이 났고
 * 90분에 **41건**이었다. ⇒ ***한 파라미터만 고치면 다음 파라미터에서 막힌다.***
 * ⚠️ 그때 나는 「수리 뒤 400 이 0건」이라 보고했는데, 그 자가 `grep max_completion_tokens`
 * 라서 «새 400»을 못 봤다 — ***좁은 자로 「나았다」를 읽었다.***
 *
 * ⇒ 값을 «1로 보내지» 않고 ***칸을 생략***한다. 서버 기본이 1이고, 보내면 또 다른 거부를 부른다.
 */
export function openAiTemperatureField(model: string, temperature: number): Record<string, number> {
  return isNewGenerationOpenAiModel(model) ? {} : { temperature };
}
