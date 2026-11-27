// ── Wave 4 · CompactProvider — model-agnostic Layer 3 contract ──────
//
// All provider plugins implement this interface so the pipeline can
// call `summarize(messages, …)` without caring whether the active
// model is Anthropic, OpenAI, Codex, Gemini, Kimi, Qwen, or GLM.
// `getDefaultCompactProvider()` wraps the existing `streamLLM`
// (Phase WF6 path) and threads `summarizerModelHint` from
// BUILTIN_CATALOG so big-thinking models hand off summarization to
// their cheaper sibling (Codex pattern: gpt-4o → gpt-4o-mini · Claude:
// opus → haiku · Gemini: pro → flash · Kimi: K2.6 → K2.5 · GLM: 5.1 →
// 4.7-flash).

import type { ContentBlock, LLMMessage } from '../llm.js';
import { streamLLM } from '../llm.js';
import { debug } from '../debug/log.js';
import { BUILTIN_CATALOG } from '../intelligence-map/model-catalog.js';
import {
  boundedCompactTranscript,
  getCompactSystemPrompt,
  stripCompactScratchpad,
} from './summarize.js';

export interface CompactSummarizeArgs {
  messages: readonly LLMMessage[];
  /** Number of trailing turns to keep verbatim after the summary.
   *  Default 4 (Gemini's split-point heuristic — recent turns hold
   *  context the model needs to continue). */
  preserveLastN?: number;
  /** ★ 핵심 앵커 보존(2026-07-21) — 맨 앞 N개 앵커(페이즈 프롬프트/WM/premise)를
   *  요약 트랜스크립트에서도 제외한다(원문은 pipeline 이 verbatim 유지). 요약이
   *  앵커를 중복 뭉개지 않도록. Default 0 = 기존 동작(앵커 포함 요약). */
  preserveFirst?: number;
  /** Maximum tokens the summary itself may consume. Hard ceiling so
   *  Layer 3 doesn't blow the new context budget. */
  maxOutputTokens?: number;
  /** Optional user `/compact <hint>` text — forwarded to the
   *  summarizer system prompt as a focus directive. */
  hint?: string;
  /** Active model id — drives summarizerModelHint lookup + (when
   *  hint absent) the fallback model. */
  activeModelId?: string;
  /** Override the summarizer model — wins over catalog hint. */
  summarizerModel?: string;
  /** Timeout — Layer 3 fails open (returns null) when exceeded so
   *  the fallback (Layer 5: truncateProportional) runs. */
  timeoutMs?: number;
}

export interface CompactSummarizeResult {
  summary: string;
  /** Which model actually ran the summary — surfaced in /compact
   *  status line so the user knows hint was honored. */
  modelUsed?: string;
  /** Number of source messages summarized (excluding system + the
   *  preserveLastN tail). */
  sourceMessageCount: number;
  /** The effective start of the preserved tail after retaining complete
   *  tool_use/tool_result pairs. */
  preservedTailFrom?: number;
}

function toolResultIds(message: LLMMessage): string[] {
  if (!Array.isArray(message.content)) return [];
  return (message.content as ContentBlock[])
    .filter((block): block is Extract<ContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')
    .map((block) => block.tool_use_id);
}

function toolUseIds(message: LLMMessage): string[] {
  if (!Array.isArray(message.content)) return [];
  return (message.content as ContentBlock[])
    .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
    .map((block) => block.id);
}

function adjustedToolPairBoundary(messages: readonly LLMMessage[], boundary: number): {
  boundary: number;
  orphanIds: string[];
} {
  let adjusted = boundary;
  const orphanIds = new Set<string>();

  while (adjusted > 0) {
    const resultIds = new Set(messages.slice(adjusted).flatMap(toolResultIds));
    const preservedUseIds = new Set(messages.slice(adjusted).flatMap(toolUseIds));
    const missingUseIds = [...resultIds].filter((id) => !preservedUseIds.has(id));
    if (missingUseIds.length === 0) break;

    const pairedUseIndices = messages
      .slice(0, adjusted)
      .flatMap((message, index) => toolUseIds(message).some((id) => missingUseIds.includes(id)) ? [index] : []);
    if (pairedUseIndices.length === 0) break;

    missingUseIds.forEach((id) => orphanIds.add(id));
    adjusted = Math.min(...pairedUseIndices);
  }

  return { boundary: adjusted, orphanIds: [...orphanIds] };
}

export interface CompactProvider {
  /** Returns null on timeout/failure; pipeline falls back to
   *  truncateProportional. Throws only on developer errors
   *  (unimplemented branch, malformed args). */
  summarize(args: CompactSummarizeArgs): Promise<CompactSummarizeResult | null>;
  /** Active model's catalog contextWindow — consulted by Wave 5
   *  auto-compact gating. */
  getContextWindow(modelId: string): number;
  /** Default 0.5 (Gemini) unless overridden by provider — the ratio
   *  of contextWindow above which auto-compact fires. */
  getAutoCompactThreshold(modelId: string): number;
}

/** Resolve the model the summarizer should run on: the active model itself
 *  (SELF-SUMMARIZE), unless the caller passes an explicit `override`.
 *
 *  codex-faithful — ref/codex `core/src/compact.rs:241` runs compaction on the
 *  session's own `model_client`, never a downshifted light model (its only model
 *  switch is a previous→current VERSION fallback, `compact_model_fallback.rs`).
 *  The model that understands the conversation summarizes it best. The old
 *  per-family / catalog-`summarizerModelHint` downshift was a cost optimization
 *  that (a) hurt summary fidelity and (b) for codex routed to gpt-4o-mini — a
 *  model the Codex backend 400s → Layer 3 silently null → compaction never fired
 *  (regression found 2026-07-19 via `session compact --force`). Removed. */
/** 카탈로그에 «없는» 모델에 쓰는 컨텍스트 창 폴백.
 *  ⛔ 시험이 이 값을 «다시 적지» 않도록 export 한다 — 두 곳에 같은 매직 넘버를 두면
 *     한쪽만 바뀌었을 때 시험이 「구현이 틀렸다」가 아니라 「자기가 늙었다」로 빨개진다
 *     (🅕 30차 · 무인 리뷰 `#13071` 지적). */
export const COMPACT_UNKNOWN_MODEL_CONTEXT_WINDOW = 32_000;

export function resolveSummarizerModel(
  activeModelId?: string,
  override?: string,
): string | undefined {
  return override ?? activeModelId;
}

/** Factory — the single CompactProvider monad-agent ships. Plugins
 *  can supply alternative implementations (test injection, custom
 *  prompts) through this same interface. */
export function getDefaultCompactProvider(): CompactProvider {
  return {
    async summarize(args: CompactSummarizeArgs): Promise<CompactSummarizeResult | null> {
      const preserveLastN = args.preserveLastN ?? 4;
      const preserveFirst = Math.max(0, args.preserveFirst ?? 0);
      const requestedBoundary = Math.max(0, args.messages.length - preserveLastN);
      const { boundary: sliceUntil, orphanIds } = adjustedToolPairBoundary(args.messages, requestedBoundary);
      if (sliceUntil !== requestedBoundary) {
        debug.log('compact', 'tool-pair-boundary-shift', {
          from: requestedBoundary,
          to: sliceUntil,
          orphanIds,
        });
      }
      // ★ 앵커 보존 — 맨 앞 preserveFirst 개는 요약 대상에서 제외(원문 유지).
      const sliceFrom = Math.min(preserveFirst, sliceUntil);
      const slice = args.messages.slice(sliceFrom, sliceUntil);
      const sourceMessageCount = slice.filter((m) => m.role !== 'system').length;
      if (sourceMessageCount === 0) return null;

      const transcript = boundedCompactTranscript(slice);
      const systemPrompt = args.hint
        ? `${getCompactSystemPrompt()}\n\nFocus directive: ${args.hint}`
        : getCompactSystemPrompt();
      const req: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Transcript to summarise:\n\n${transcript}` },
      ];
      const summarizerModel = resolveSummarizerModel(args.activeModelId, args.summarizerModel);
      const timeoutMs = args.timeoutMs ?? 45_000;

      try {
        const text = await Promise.race([
          streamLLM(req, () => { /* silent */ }, summarizerModel ? { model: summarizerModel } : {}),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('summarize timeout')), timeoutMs),
          ),
        ]);
        const summary = stripCompactScratchpad(text);
        if (!summary.trim()) return null;
        return {
          summary,
          ...(summarizerModel ? { modelUsed: summarizerModel } : {}),
          sourceMessageCount,
          ...(sliceUntil !== requestedBoundary ? { preservedTailFrom: sliceUntil } : {}),
        };
      } catch {
        return null;
      }
    },
    getContextWindow(modelId: string): number {
      const entry = BUILTIN_CATALOG.models.find((m) => m.id === modelId);
      return entry?.contextWindow ?? COMPACT_UNKNOWN_MODEL_CONTEXT_WINDOW;
    },
    getAutoCompactThreshold(modelId: string): number {
      const entry = BUILTIN_CATALOG.models.find((m) => m.id === modelId);
      const ctx = entry?.contextWindow ?? COMPACT_UNKNOWN_MODEL_CONTEXT_WINDOW;
      const reserved = entry?.reservedOutputTokens ?? 0;
      // Default: 50% of input budget. Aligns with Gemini default;
      // Claude uses ctx-13K which is roughly equivalent for 200K
      // models but more conservative for 1M models — 50% wins on
      // generality.
      return Math.max(1, Math.floor((ctx - reserved) * 0.5));
    },
  };
}
