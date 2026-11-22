/**
 * FU8 follow-up #3 (2026-05-12) — xAI Grok Live Search keyword
 * crawl adapter.
 *
 * Implements the external-crawl leg that PR #3 (FU-I7b.2) parked
 * behind the transparent `nullCrawlKeyword` shim until an adapter
 * was chosen explicitly. User decision (EoS #11): start with Grok's
 * native Live Search (no extra CLI · API key already configured if
 * the user has a grok provider). The adapter sits *below* the KGS
 * BM25 lookup in the precedence chain — KGS hit returns cached
 * knowledge; KGS miss falls through here.
 *
 * Request shape (migrated 2026-07-05 — xAI retired live-search
 * [HTTP 410]; now the Agent Tools API at
 * https://docs.x.ai/docs/guides/tools/overview):
 *
 *   POST https://api.x.ai/v1/responses
 *   {
 *     "model": GROK_SEARCH_MODEL (grok-4.20, 가성비 · 2M context),
 *     "input": [...messages],
 *     "tools": [{ "type": "web_search" }]
 *   }
 *
 * Response `output[]` carries web_search_call items (action.sources[])
 * and a final message item (content[].output_text + url_citation
 * annotations). The shared `parseResponsesOutput` flattens both into
 * { text, citations }.
 *
 * The adapter returns the synthesised `content` as the
 * `KeywordCrawlCallable.summary`, with the citations stringified
 * into the `raw` field for the I2 enrichment audit trail.
 *
 * Degradation (best-effort · the I2 loop never throws):
 *   - Missing API key  → `{ summary: 'grok live-search not
 *     configured ...' }` so the dogfood gap stays visible.
 *   - HTTP 4xx / 5xx   → `{ summary: 'grok live-search failed (status
 *     <n>) — <keyword>' }`.
 *   - Timeout / abort  → fallback summary; the upstream signal
 *     captures the abort via the passed-in `signal`.
 *
 * Reference-pattern emit (mirrors keyword-crawl-kgs):
 *   - Signal bus: `intake.keyword_crawl.grok_<ok|fail>` (`info`
 *     tier on success · `threshold` tier on configuration /
 *     transport failures so dashboards highlight them).
 *   - User-intent log: `system.intake.keyword_crawl_grok_<ok|fail>`.
 *
 * Cross-ref:
 *   src/intake-plane/keyword-crawl-kgs.ts (KGS-first adapter that
 *     consumes this one as its fallback)
 *   src/intake-plane/enrich-plugins.ts (BuildEnrichPluginsOptions
 *     `externalKeywordCrawl?` wires us in)
 *   src/config.ts (GROK_API_URL · GROK_MODEL · getGrokApiKey)
 *   내부 문서 `FEATURE-fu8-cascade-2026-05-12` (§ FU8
 *     follow-ups landed)
 */

import { getGrokApiKey } from '../config.js';
import { logUnmeteredRow } from '../llm/ledgered-call.js';
import {
  GROK_RESPONSES_URL,
  GROK_SEARCH_MODEL,
  parseResponsesOutput,
} from '../grok/agent-search.js';
import { signalBus } from '../signal-bus/index.js';
import { userIntentLogger } from '../user-intent/index.js';
import type { KeywordCrawlCallable } from './enrich.js';

/** Minimal `fetch`-compatible signature so tests can inject a stub
 *  without dragging the full DOM fetch typing in. Production wires
 *  `globalThis.fetch`. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}>;

export interface GrokKeywordCrawlOptions {
  /** Inject for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: FetchLike;
  /** Override the API key resolver (tests). Defaults to
   *  `getGrokApiKey()` which reads `XAI_API_KEY` / `GROK_API_KEY`. */
  apiKey?: () => string | undefined;
  /** Override the model (e.g. for a cheaper search-grade model).
   *  Defaults to `GROK_SEARCH_MODEL` (가성비). */
  model?: string;
  /** Hard cap on Grok-returned search results bundled into the
   *  prompt. Capped because the response gets stitched into a
   *  task enrichment summary that ultimately flows into another
   *  LLM's context. */
  maxSearchResults?: number;
  /** Hard cap on the summary bytes returned to the I2 loop. */
  summaryBytes?: number;
  /** Network timeout (ms). 0/undefined → 15s. */
  timeoutMs?: number;
  /** Test seam — override the signal-bus singleton. */
  bus?: ReturnType<typeof signalBus>;
  /** Test seam — override the user-intent logger singleton. */
  intent?: ReturnType<typeof userIntentLogger>;
}

const DEFAULT_MAX_SEARCH_RESULTS = 5;
const DEFAULT_SUMMARY_BYTES = 1200;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Build a `KeywordCrawlCallable` that consults Grok server-side search
 *  (Agent Tools API). Designed to be passed as `fallback` to
 *  `buildKgsKeywordCrawlCallable({ kgsStore, fallback })`. */
export function buildGrokLiveSearchKeywordCallable(
  opts: GrokKeywordCrawlOptions = {},
): KeywordCrawlCallable {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const apiKeyFn = opts.apiKey ?? getGrokApiKey;
  const model = opts.model ?? GROK_SEARCH_MODEL;
  const maxResults = opts.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
  const summaryCap = opts.summaryBytes ?? DEFAULT_SUMMARY_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bus = opts.bus ?? signalBus();
  const intent = opts.intent ?? userIntentLogger();

  return async (args) => {
    const keyword = args.keyword.trim();
    if (!keyword) return { summary: 'grok live-search: empty keyword' };

    const apiKey = apiKeyFn();
    if (!apiKey) {
      emitFail(bus, intent, keyword, 'missing-api-key');
      return {
        summary:
          `grok live-search not configured · '${keyword}' · `
          + 'set XAI_API_KEY (or GROK_API_KEY) to enable external crawl.',
      };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onParentAbort = (): void => ctrl.abort();
    args.signal?.addEventListener('abort', onParentAbort);

    let logged = false; // 요청당 정확히 1행 — 기록 후 catch 재기록 금지 (JUD-B mustFix)
    try {
      const res = await fetchFn(GROK_RESPONSES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: [
            {
              role: 'system',
              content:
                '당신은 elanous intake enrich plugin 입니다. 키워드 한 개에 대해 최신 web 정보를 종합한 200자 이내 한국어 요약을 만들어 주세요. '
                + '구체적 출처는 본문 안에 (제목 — 도메인) 형식으로 1-2개 인용하세요.',
            },
            { role: 'user', content: `키워드: '${keyword}'` },
          ],
          tools: [{ type: 'web_search' }],
          max_output_tokens: 4000,
        }),
        signal: ctrl.signal,
      });
      // LLM-CALL-COST-LEDGER — 요청 실제 발사 뒤 1행. 조기 return(빈 키워드·키 없음)엔 행 없음.
      logUnmeteredRow(model, { providerName: 'grok', site: 'keyword-crawl-grok' });
      logged = true;

      if (!res.ok) {
        emitFail(bus, intent, keyword, `http-${res.status}`);
        return {
          summary: `grok search failed (HTTP ${res.status} ${res.statusText}) — '${keyword}'`,
        };
      }
      // Agent Tools API `/v1/responses` — parse via the shared flattener
      // (output[] → answer text + cited sources). maxResults caps the
      // citations stitched into the enrichment summary.
      const body = (await res.json()) as { output?: unknown[] } | null;
      const parsed = parseResponsesOutput(body);
      const text = parsed.text;
      if (!text) {
        emitFail(bus, intent, keyword, 'empty-response');
        return { summary: `grok search returned empty body — '${keyword}'` };
      }
      const summary = text.slice(0, summaryCap);
      const citations = parsed.citations
        .slice(0, maxResults)
        .map((c) => `${c.title ?? '(untitled)'} — ${c.url}`);
      emitOk(bus, intent, keyword, citations.length);
      return citations.length > 0
        ? { summary, raw: citations.join('\n') }
        : { summary };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!logged) logUnmeteredRow(model, { providerName: 'grok', site: 'keyword-crawl-grok', missingReason: 'provider-call-failed' });
      emitFail(bus, intent, keyword, `threw:${message}`);
      return { summary: `grok live-search threw: ${message} — '${keyword}'` };
    } finally {
      clearTimeout(timer);
      args.signal?.removeEventListener('abort', onParentAbort);
    }
  };
}

// ──────────────────── Reference 3-sink emit ─────────────────────────

function emitOk(
  bus: ReturnType<typeof signalBus>,
  intent: ReturnType<typeof userIntentLogger>,
  keyword: string,
  citationCount: number,
): void {
  try {
    bus.emit({
      source: 'intake.keyword_crawl.grok_ok',
      tier: 'info',
      message: `grok live-search · '${keyword}' · ${citationCount} citations`,
      payload: { keyword, citationCount },
    });
  } catch { /* best-effort */ }
  try {
    intent.emit({
      surface: 'tui',
      intent: {
        layer: 'system',
        kind: 'system.intake.keyword_crawl_grok_ok',
        target: { kind: 'chip', id: keyword },
        value: { citationCount },
      },
    });
  } catch { /* best-effort */ }
}

function emitFail(
  bus: ReturnType<typeof signalBus>,
  intent: ReturnType<typeof userIntentLogger>,
  keyword: string,
  reason: string,
): void {
  try {
    bus.emit({
      source: 'intake.keyword_crawl.grok_fail',
      // Configuration + transport failures escalate to `threshold`
      // so a dashboard / Patcher subscriber sees the gap loudly.
      tier: 'threshold',
      message: `grok live-search fail · '${keyword}' · ${reason}`,
      payload: { keyword, reason },
    });
  } catch { /* best-effort */ }
  try {
    intent.emit({
      surface: 'tui',
      intent: {
        layer: 'system',
        kind: 'system.intake.keyword_crawl_grok_fail',
        target: { kind: 'chip', id: keyword },
        value: { reason },
      },
    });
  } catch { /* best-effort */ }
}
