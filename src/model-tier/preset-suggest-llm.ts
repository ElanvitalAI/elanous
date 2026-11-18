// M2-4 v2 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 3) —
// LLM-backed preset suggester. Graduates the M2-4 heuristic so phrases
// that don't match any keyword (e.g. "I'm prepping a deposition for
// next Tuesday") still classify correctly · prerequisite for M3-3
// (chat surface NL tier switch).
//
// Architecture:
//   - Pure orchestrator — accepts a `runLlm` callback the caller
//     wires to whichever provider (local LM Studio for CLI, the
//     active tier LLM for M3-3 chat hook, mocks for tests).
//   - Prompt template lists all 5 presets + matching guidance; the
//     model is constrained to emit JSON `{"preset","confidence","matchedKeywords"}`.
//   - On parse / network / timeout failure, gracefully degrades to
//     the heuristic so the suggester always returns *something*.
//
// Reference: PLAN §3.3 (preset catalog) + §3.5 (NL tier switch · M3-3
// dependency).

import { llmNetworkFetch } from '../session-runtime/llm-call-gateway.js';
import {
  PRESETS,
  type PresetId,
} from './preset-catalog.js';
import {
  suggestPresetForText,
  type PresetSuggestion,
} from './preset-suggest.js';

export type LlmMessageRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmMessageRole;
  content: string;
}

/** Caller-supplied LLM invoker. Receives the rendered system + user
 *  messages, must return the raw assistant text. Throws on transport
 *  errors. Keeps the suggester provider-agnostic so the same code
 *  serves the CLI (--llm) and the chat surface (M3-3 NL switch).
 *
 *  Implementations: see `createLocalLlmPresetRunner` for the LM Studio
 *  variant used by the CLI; M3-3 will wire `resolveLlmTier` + active
 *  provider call site. */
export type LlmRunner = (messages: readonly LlmMessage[]) => Promise<string>;

/** Tag the suggestion with where it came from so the CLI / chat UX
 *  can show "heuristic" vs "LLM" provenance. */
export type SuggestionSource = 'heuristic' | 'llm' | 'fallback';

export interface LlmPresetSuggestion extends PresetSuggestion {
  source: SuggestionSource;
  /** Diagnostic only — populated when `source = 'llm'`. */
  rawReply?: string;
}

const VALID_PRESETS = new Set<string>(Object.keys(PRESETS));

export function buildPresetSuggestMessages(text: string): LlmMessage[] {
  const presetLines = Object.values(PRESETS)
    .map((p) => `- ${p.id}: ${p.label} — ${p.description}`)
    .join('\n');
  return [
    {
      role: 'system',
      content: [
        'You classify a short snippet of user intent into exactly one of these 5 use-case presets:',
        presetLines,
        '',
        'Respond with ONE JSON object on a single line. Schema:',
        '  {"preset": "<id>", "confidence": <0..1 float>, "matchedKeywords": ["w1", "w2"]}',
        'Rules:',
        '  - "preset" MUST be one of: casual_chat, meeting, medical_dictation, live_caption, sleep_mode.',
        '  - "confidence" reflects how clearly the snippet fits the preset (0 = unsure, 1 = unambiguous).',
        '  - "matchedKeywords" lists the literal words/phrases from the snippet that drove the choice. Empty array is allowed.',
        '  - Output ONLY the JSON object. No preamble, no commentary, no fences.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: text,
    },
  ];
}

/** Extract the first JSON object from a raw LLM reply. Tolerates
 *  Markdown code fences and leading commentary — small models often
 *  prefix the answer with "Sure!" before the JSON. */
export function parsePresetSuggestReply(raw: string): LlmPresetSuggestion | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // Strip code fences.
  const stripped = raw.replace(/```(?:json)?/g, '').trim();
  // Find the first `{` ... `}` span. Greedy match because some models
  // emit prose before the JSON.
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  const candidate = stripped.slice(firstBrace, lastBrace + 1);
  let parsed: unknown;
  try { parsed = JSON.parse(candidate); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.preset !== 'string' || !VALID_PRESETS.has(r.preset)) return null;
  const confidence = typeof r.confidence === 'number' && Number.isFinite(r.confidence)
    ? Math.max(0, Math.min(1, r.confidence))
    : 0.5;
  const matched: string[] = Array.isArray(r.matchedKeywords)
    ? r.matchedKeywords.filter((w): w is string => typeof w === 'string')
    : [];
  return {
    preset: r.preset as PresetId,
    confidence,
    matchedKeywords: matched,
    source: 'llm',
  };
}

export interface SuggestPresetLlmOpts {
  /** Hard wall-clock cap (ms) before we fall back to the heuristic.
   *  Default 5000ms — generous enough for reasoning models in the
   *  CLI path, short enough that an offline LLM can't stall the
   *  chat surface. */
  timeoutMs?: number;
}

/** Run the LLM-backed suggester · fall back to the heuristic on any
 *  failure mode. Always returns a `LlmPresetSuggestion` so callers
 *  don't have to handle null. */
export async function suggestPresetForTextLLM(
  text: string,
  runLlm: LlmRunner,
  opts: SuggestPresetLlmOpts = {},
): Promise<LlmPresetSuggestion> {
  const heuristic: LlmPresetSuggestion = {
    ...suggestPresetForText(text),
    source: 'heuristic',
  };
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ...heuristic, source: 'fallback' };
  }
  const timeoutMs = opts.timeoutMs ?? 5000;
  let raw: string;
  try {
    raw = await withTimeout(runLlm(buildPresetSuggestMessages(text)), timeoutMs);
  } catch {
    return { ...heuristic, source: 'fallback' };
  }
  const parsed = parsePresetSuggestReply(raw);
  if (!parsed) {
    return { ...heuristic, source: 'fallback' };
  }
  return { ...parsed, rawReply: raw };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => reject(new Error('preset-suggest-llm timeout')), ms);
    promise.then(
      (v) => { clearTimeout(handle); resolve(v); },
      (e: unknown) => { clearTimeout(handle); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

// ── Local LLM runner (LM Studio compatible) ─────────────────────────

export interface LocalLlmRunnerOpts {
  /** OpenAI-compatible base URL (no trailing slash). Defaults to
   *  `http://localhost:1234/v1` — same as role-judge for parity. */
  endpoint?: string;
  /** Model id as known by the host. Required. */
  model: string;
  token?: string;
  /** Forwarded as fetch signal so callers can cancel. */
  signal?: AbortSignal;
}

const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:1234/v1';

/** Build a runner that calls a local OpenAI-compatible host (LM Studio
 *  / Ollama / vLLM). Used by the CLI `--llm` path so the suggester can
 *  hit an offline model without a cloud round-trip. */
export function createLocalLlmPresetRunner(opts: LocalLlmRunnerOpts): LlmRunner {
  const endpoint = opts.endpoint ?? DEFAULT_LOCAL_ENDPOINT;
  return async (messages) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await llmNetworkFetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: opts.model,
        messages,
        temperature: 0,
        max_tokens: 256,
        stream: false,
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }, { provider: 'local-llm', model: opts.model, role: 'aux', requestedBy: 'model-tier.preset-suggest' });
    if (!res.ok) throw new Error(`local-llm ${res.status}`);
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    const choice = json.choices?.[0]?.message;
    return choice?.content?.length ? choice.content : (choice?.reasoning_content ?? '');
  };
}
