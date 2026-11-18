// R6 Task 5 · §6.1 LLM-judge — local model adapter (2026-05-09).
//
// Calls LM Studio's OpenAI-compatible /v1/chat/completions endpoint
// for a single classification turn. Default endpoint is the user's
// local LM Studio (`http://localhost:1234`); the daemon-side caller
// passes the resolved endpoint URL.
//
// Model selection (HANDOFF §6.2):
// - primary: `google/gemma-4-e4b` (8B / 4.5B effective · ~50-80ms on
//   M5 Max 128GB · MLX 4bit · classification over-spec)
// - fallback: `gemma-4-26b-a4b-it` (already loaded · slower but
//   widely available in the user's existing rotation pool)
//
// The judge is timeout-bounded (default 200ms wall-clock) so a slow
// local model never blocks dispatch — the caller's keyword classifier
// already produced a baseline answer; this call just refines it.

import { llmNetworkFetch } from '../../session-runtime/llm-call-gateway.js';
import { buildJudgePromptMessages, parseJudgeReply, type RoleLabel } from './prompt-template.js';

export interface LocalJudgeOpts {
  /** OpenAI-compatible base URL (no trailing slash). Defaults to
   *  `http://localhost:1234/v1` for LM Studio. */
  endpoint?: string;
  /** Model id as known by the host. */
  model: string;
  /** Optional bearer token (LM Studio defaults to none; not all hosts
   *  do). Forwarded as `Authorization: Bearer <token>`. */
  token?: string;
  /** Hard wall-clock cap in ms. Default 200. */
  timeoutMs?: number;
  /** AbortController hook — caller may cancel earlier. */
  signal?: AbortSignal;
}

export interface LocalJudgeResult {
  ok: true;
  role: RoleLabel;
  /** Wall-clock ms. */
  latencyMs: number;
  /** Raw text returned by the model — kept around so the caller can
   *  log unexpected outputs without retrying. */
  rawReply: string;
}

export interface LocalJudgeFailure {
  ok: false;
  /** `timeout` = exceeded `timeoutMs` · `network` = fetch threw ·
   *  `parse` = reply unparseable · `http` = non-2xx status. */
  reason: 'timeout' | 'network' | 'parse' | 'http';
  detail?: string;
  latencyMs: number;
}

const DEFAULT_ENDPOINT = 'http://localhost:1234/v1';
// 200ms was the original HANDOFF estimate based on classification-only
// non-reasoning models. Verification on the actual deployed
// gemma-4-e4b (LM Studio MLX 4-bit) showed reasoning traces of
// 150-200 tokens, putting end-to-end latency at ~2.5-3s warm. We
// raise the default to 3500ms so the LLM tier actually answers in
// the common case; the dispatch path is async so the user-perceived
// cost is the dispatch decision, not key input. Callers that wire a
// non-reasoning model can shrink this back via `timeoutMs` opts /
// `ELANOUS_SHOWROOM_ROLE_JUDGE_TIMEOUT_MS` env.
// Verified envelope on M5 Max 128GB · gemma-4-e4b warm latency
// (reasoning + answer @ 1024 tokens) lands at 4-7s; non-reasoning
// 3B models land at 200-500ms. We set the default to 8000ms so
// reasoning models actually answer instead of always falling back
// to broadcast; non-reasoning hosts pay no cost (they reply early).
const DEFAULT_TIMEOUT_MS = 8000;

const DEFAULT_MAX_TOKENS = 1024;

function resolveMaxTokens(): number {
  const env = process.env.ELANOUS_SHOWROOM_ROLE_JUDGE_MAX_TOKENS;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_TOKENS;
}

/** Run one classification turn against the local model. Returns a
 *  discriminated result so callers can branch without exception
 *  handling. Pure transport + parse — no policy decision (the hybrid
 *  composer in `index.ts` chooses keyword vs LLM). */
export async function classifyWithLocalLlm(
  userPrompt: string,
  opts: LocalJudgeOpts,
): Promise<LocalJudgeResult | LocalJudgeFailure> {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const ac = new AbortController();
  // Forward outer signal — abort early if the caller times out first.
  if (opts.signal) {
    if (opts.signal.aborted) {
      ac.abort();
    } else {
      opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const messages = buildJudgePromptMessages({ userPrompt });
  // NOTE on response_format: LM Studio's OpenAI-compat surface
  // (≥ 0.21) only accepts `{type:'text'}` or `{type:'json_schema'}`
  // — passing `{type:'json_object'}` results in HTTP 400. The
  // prompt template already constrains the model to a single JSON
  // object via system + few-shot, and `parseJudgeReply` is
  // tolerant of fence/whitespace/leading punctuation, so omitting
  // the hint is the safer default. Callers that target the OpenAI
  // public API (which DOES support 'json_object') can re-add the
  // option in a future variant.
  const body = JSON.stringify({
    model: opts.model,
    messages,
    temperature: 0,
    // FU.1 (2026-05-09 · self-verify follow-up): live deployment shows
    // every modern small/mid model in LM Studio is reasoning-enabled
    // (gemma-4-e4b · qwen3.5-9b-mlx · glm-4.7-flash all populate
    // `reasoning_content` even when the prompt forbids it). Reasoning
    // traces consume 150-800 tokens before the visible answer, so a
    // tight max_tokens cap silently drops the answer. 1024 is enough
    // for "think then emit a 12-char JSON object" across every model
    // we tested. Non-reasoning models (Llama-3.2-3B-Instruct,
    // Qwen2.5-3B-Instruct, Phi-3.5-mini) end well before this cap and
    // pay no cost. Hosts that want a tighter cap can override via
    // `ELANOUS_SHOWROOM_ROLE_JUDGE_MAX_TOKENS`.
    max_tokens: resolveMaxTokens(),
    stream: false,
  });
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    const res = await llmNetworkFetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body,
      signal: ac.signal,
    }, { provider: 'local-llm', model: opts.model, role: 'aux', requestedBy: 'showroom.role-judge' });
    clearTimeout(timer);
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, reason: 'http', detail: detail.slice(0, 200), latencyMs };
    }
    const json = (await res.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> }
      | null;
    // Reasoning-enabled hosts (LM Studio's gemma-4-e4b / qwen3.5
    // line) populate `reasoning_content` with the thinking trace and
    // leave `content` blank when the trace stops at a token cap. We
    // try the canonical content first, then fall back to scanning
    // the reasoning trace for the final JSON object.
    const choice = json?.choices?.[0]?.message;
    const rawReply = choice?.content && choice.content.length > 0
      ? choice.content
      : (choice?.reasoning_content ?? '');
    const role = parseJudgeReply(rawReply);
    if (!role) {
      return {
        ok: false,
        reason: 'parse',
        detail: rawReply.slice(0, 200),
        latencyMs,
      };
    }
    return { ok: true, role, latencyMs, rawReply };
  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Date.now() - startedAt;
    const aborted = (err as { name?: string } | null)?.name === 'AbortError';
    return {
      ok: false,
      reason: aborted ? 'timeout' : 'network',
      detail: err instanceof Error ? err.message : String(err),
      latencyMs,
    };
  }
}
