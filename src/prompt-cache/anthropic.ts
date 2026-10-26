// Anthropic prompt-caching helpers — pure transforms, no fetch.
//
// Exports:
//   • toAnthropicSystemBlocks       — role='system' → ContentBlock[]
//                                     with cache_control at tail.
//   • toAnthropicToolsCached        — tool array whose last entry
//                                     carries cache_control.
//   • applyHistoryCacheBreakpoint   — marks the second-to-last
//                                     message's tail block with
//                                     cache_control → slides forward
//                                     each turn, building a cascading
//                                     prefix cache for dialogue
//                                     history.
//   • parseAnthropicUsage           — SSE event → LLMUsage or null.
//   • formatUsageLine               — 1-liner for debug log.
//
// Everything cache-related is opt-in via `{ cache: boolean }`; ttl is
// '5m' (default) or '1h' via `{ ttl: '1h' }`. Anthropic silently
// accepts these fields on the 2023-06-01 wire version — prompt
// caching went GA without a version bump.

import type { LLMMessage, LLMToolSpec } from '../llm.js';
import { assertNoTopLevelToolSchemaCombinators } from '../llm-tool-schema.js';
import {
  cacheControlFor,
  type CacheControl,
  type CacheTTL,
  type LLMUsage,
  type AnthropicUsage,
} from './types.js';

// ── Re-export for consumers that don't want to chase two modules ──
export type { AnthropicUsage, LLMUsage, CacheControl, CacheTTL } from './types.js';
export { EPHEMERAL_CACHE, EPHEMERAL_CACHE_1H, cacheControlFor } from './types.js';

// ── System blocks ──────────────────────────────────────────────────

/** A text content-block accepted by Anthropic's `system` top-level
 *  field. cache_control is optional — present only on the tail block
 *  when caching is enabled. */
export interface AnthropicSystemTextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

export interface CacheOpts {
  cache: boolean;
  /** '5m' (default) or '1h' (extended tier). */
  ttl?: CacheTTL;
}

/** Collapse all role='system' messages into a single text buffer
 *  (images dropped — Anthropic rejects images in system blocks).
 *  Returns:
 *   • `undefined` when no system content exists (body omits `system`)
 *   • `string`    when `cache: false` — preserves legacy wire format
 *   • `[AnthropicSystemTextBlock]` when `cache: true` — exactly one
 *     block carrying cache_control so the whole system prompt is the
 *     cacheable prefix. */
export function toAnthropicSystemBlocks(
  messages: LLMMessage[],
  opts: CacheOpts,
): undefined | string | AnthropicSystemTextBlock[] {
  const parts: string[] = [];
  for (const m of messages.filter(x => x.role === 'system')) {
    if (typeof m.content === 'string') {
      if (m.content) parts.push(m.content);
    } else {
      for (const b of m.content) {
        if (b.type === 'text' && b.text) parts.push(b.text);
      }
    }
  }
  if (parts.length === 0) return undefined;
  const joined = parts.join('\n\n');
  if (!opts.cache) return joined;
  return [{ type: 'text', text: joined, cache_control: cacheControlFor(opts.ttl) }];
}

// ── Tools ──────────────────────────────────────────────────────────

/** Anthropic tool wire shape. `cache_control` is optional — only the
 *  tail tool carries it when caching is enabled. */
export interface AnthropicToolBlock {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
}

/** Translate LLMToolSpec[] → Anthropic wire tools. When `cache: true`
 *  the final tool gets a cache_control marker; since Anthropic caches
 *  up to and including the last marker, the entire tool array becomes
 *  a cacheable prefix. Returns `undefined` for missing / empty input
 *  so the caller can `...(tools ? { tools } : {})` as before. */
export function toAnthropicToolsCached(
  tools: LLMToolSpec[] | undefined,
  opts: CacheOpts,
): AnthropicToolBlock[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  assertNoTopLevelToolSchemaCombinators(tools);
  // ⭐ Anthropic 은 tool name UNIQUE 를 강제(400 "Tool names must be unique.")한다.
  //   OpenAI/codex 는 중복을 조용히 관대 처리 → 하니스가 codex 위주로 개발되며 중복 tool spec
  //   (예: goal-loop 이 카탈로그에 이미 있는 spec 을 append)이 claude 에서만 400 으로 터졌다.
  //   name 기준 dedup(첫 항목 유지)로 provider 무관하게 안전화. (2026-07-19 비-codex 파이프라인 점검)
  const seen = new Set<string>();
  const uniqueTools = tools.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
  const lastIdx = uniqueTools.length - 1;
  return uniqueTools.map((t, i) => {
    const base: AnthropicToolBlock = {
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    };
    if (opts.cache && i === lastIdx) base.cache_control = cacheControlFor(opts.ttl);
    return base;
  });
}

// ── Message-level breakpoints (history + anchor) ───────────────────

/** Shared helper — attach cache_control to the tail content block of
 *  `messages[targetIdx]`. Returns a NEW messages array when a marker
 *  was added, or the original reference when the target is not a
 *  valid anchoring point (empty content, out-of-range index, or the
 *  target already carries cache_control at the tail — idempotence so
 *  anchor+history never double-mark the same block). */
function attachCacheMarkerAt<T extends { role: string; content: unknown }>(
  messages: T[],
  targetIdx: number,
  ttl: CacheTTL | undefined,
): T[] {
  if (targetIdx < 0 || targetIdx >= messages.length) return messages;
  const target = messages[targetIdx]!;

  // Normalize content to block array so we can attach cache_control.
  let blocks: Array<Record<string, unknown>>;
  if (typeof target.content === 'string') {
    if (!target.content) return messages;      // empty content — skip
    blocks = [{ type: 'text', text: target.content }];
  } else if (Array.isArray(target.content) && target.content.length > 0) {
    blocks = (target.content as Array<Record<string, unknown>>).slice();
  } else {
    return messages;                           // unexpected shape — skip
  }

  const lastIdx = blocks.length - 1;
  const tail = blocks[lastIdx]!;
  // Idempotence — if the tail already has cache_control (e.g. the
  // history pass just marked the same message that the anchor pass
  // is about to), skip so we don't clobber the existing marker's ttl
  // or produce a redundant shallow clone.
  if (tail['cache_control'] !== undefined) return messages;

  const newTail = { ...tail, cache_control: cacheControlFor(ttl) };
  blocks[lastIdx] = newTail;

  // Clone enclosing array + target so caller's input stays untouched.
  const out = messages.slice();
  out[targetIdx] = { ...target, content: blocks } as T;
  return out;
}

/** Attach `cache_control` to the tail content block of the message at
 *  `messages[messages.length - 2]`. Rationale: the last message is
 *  the current user turn (always new, unrecoverable as cache); the
 *  one before it is the highest-indexed stable message. Marking its
 *  tail cascades each turn — prior turn's cache is read, a new
 *  (longer) prefix is written. No-op when fewer than 2 messages.
 *
 *  Input shape: any array of `{role, content}` objects where content
 *  is `string` or an array of block objects. We keep the parameter
 *  permissive (`unknown` content) because `toAnthropicMessage`
 *  returns that shape and narrowing it here would ripple through
 *  the caller. Non-conforming messages (empty content, unexpected
 *  types) are returned untouched. */
export function applyHistoryCacheBreakpoint<T extends { role: string; content: unknown }>(
  messages: T[],
  opts: CacheOpts & { minMessages?: number },
): T[] {
  if (!opts.cache) return messages;
  const min = opts.minMessages ?? 2;
  if (messages.length < min) return messages;
  return attachCacheMarkerAt(messages, messages.length - 2, opts.ttl);
}

/** Attach `cache_control` to the tail content block of `messages[0]`
 *  — the ANCHOR slot. Intended for long dialogues where the first
 *  message (initial user question / attachment) rarely changes, so
 *  the stable anchor keeps cache alive even as the HB breakpoint
 *  slides forward. Default activation threshold is 4 messages so
 *  short dialogues (where HB alone suffices) don't burn an extra
 *  marker. When the dialogue is too short the anchor would land on
 *  the same message as HB — `attachCacheMarkerAt` is idempotent so
 *  double-calling is safe, but we gate on `minMessages` for clarity
 *  in metrics too. */
export function applyAnchorCacheBreakpoint<T extends { role: string; content: unknown }>(
  messages: T[],
  opts: CacheOpts & { minMessages?: number },
): T[] {
  if (!opts.cache) return messages;
  const min = opts.minMessages ?? 4;
  if (messages.length < min) return messages;
  return attachCacheMarkerAt(messages, 0, opts.ttl);
}

// ── Usage parsing ──────────────────────────────────────────────────

/** Pick LLMUsage out of a single SSE event payload. Returns null
 *  when no usage fields are present. Handles both shapes:
 *
 *   message_start: parsed.message.usage = {
 *     input_tokens, cache_creation_input_tokens, cache_read_input_tokens
 *   }
 *   message_delta: parsed.usage = {
 *     output_tokens, cache_creation_input_tokens, cache_read_input_tokens
 *   }
 *
 *  Missing fields stay `undefined` in the normalized object. */
export function parseAnthropicUsage(event: unknown): LLMUsage | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as { type?: string; message?: { usage?: unknown }; usage?: unknown };
  const raw =
    e.type === 'message_start' ? e.message?.usage :
    e.type === 'message_delta' ? e.usage :
    null;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  const out: LLMUsage = { provider: 'anthropic' };
  if (typeof r.input_tokens === 'number') out.inputTokens = r.input_tokens;
  if (typeof r.output_tokens === 'number') out.outputTokens = r.output_tokens;
  if (typeof r.cache_creation_input_tokens === 'number') {
    out.cacheCreationInputTokens = r.cache_creation_input_tokens;
  }
  if (typeof r.cache_read_input_tokens === 'number') {
    out.cacheReadInputTokens = r.cache_read_input_tokens;
  }
  // Need at least one counter besides provider for the event to be
  // useful — callers treat null as "skip this event".
  const keys = Object.keys(out).filter(k => k !== 'provider');
  return keys.length === 0 ? null : out;
}

// ── Formatting for debug logs ──────────────────────────────────────

/** Human-readable one-liner used by the dashboard log surface.
 *  Example: `cache: read=1024 create=0 in=140 out=320 (hit 88%)`. */
export function formatUsageLine(u: LLMUsage): string {
  const read = u.cacheReadInputTokens ?? 0;
  const create = u.cacheCreationInputTokens ?? 0;
  const input = u.inputTokens ?? 0;
  const out = u.outputTokens ?? 0;
  // Hit ratio = cache-reads / (reads + creates + first-turn input).
  // Intentionally excludes output tokens so the number reflects the
  // prompt side only. Undefined when we have no prompt-side tokens.
  const denom = read + create + input;
  const hit = denom > 0 ? Math.round((read / denom) * 100) : null;
  const hitStr = hit === null ? '' : ` (hit ${hit}%)`;
  return `cache: read=${read} create=${create} in=${input} out=${out}${hitStr}`;
}
