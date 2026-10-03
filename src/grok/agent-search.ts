// ── Grok Agent Tools API — shared server-side search helper ──
//
// xAI RETIRED the old "live search" feature (chat/completions +
// `search_parameters`) — it now returns HTTP 410 "Live search is
// deprecated. Please switch to the Agent Tools API". This helper wraps
// the replacement: the `/v1/responses` endpoint with server-side
// `tools` (web_search / x_search). Grok runs the searches server-side
// and returns a synthesised answer plus cited source URLs.
//
//   POST https://api.x.ai/v1/responses
//   { model, input: [...messages], tools: [{type:'web_search'}, ...] }
//
// Response `output[]` is a heterogeneous list: `web_search_call` items
// carry `action.sources[]`, and the final `message` item carries
// `content[].output_text` (the answer) + `annotations[]` (url_citation).
// We flatten both into { text, citations }.
//
// One shared helper so every Grok search call-site (native web_search
// tool, registry model-crawl, intake keyword-enrich) migrates together
// and future model/endpoint changes are single-point. This is SEARCH
// only — the Grok CHAT provider (llm.ts, chat/completions, grok-4.3)
// is a separate concern and intentionally untouched.
//
// Reference: https://docs.x.ai/docs/guides/tools/overview

import { getGrokApiKey, refreshKeyFromCache } from '../config.js';
import { debug } from '../debug/log.js';

/** Agent Tools API endpoint (distinct from GROK_API_URL=chat/completions). */
export const GROK_RESPONSES_URL = 'https://api.x.ai/v1/responses';

/** Cost-effective search model — mirrors omni-crawl's default "fast"
 *  tier. ~6x cheaper input / 5x cheaper output than the grok-4.3
 *  flagship ($0.20/$0.50 vs $1.25/$2.50 per M). Search doesn't need the
 *  flagship, so we default 가성비 here and leave chat on grok-4.3.
 *  Override via GROK_SEARCH_MODEL. */
export const GROK_SEARCH_MODEL = process.env.GROK_SEARCH_MODEL || 'grok-4-1-fast-reasoning';

export type GrokSearchTool = 'web_search' | 'x_search';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GrokAgentSearchOpts {
  /** Model id. Default GROK_SEARCH_MODEL (가성비 fast). */
  model?: string;
  /** Server-side tools to enable. Default ['web_search']. Add 'x_search'
   *  to also mine X posts (Grok's differentiator). */
  tools?: GrokSearchTool[];
  /** Optional system steer prepended to the input. */
  systemPrompt?: string;
  /** Cap on the model's output budget (reasoning models spend tokens
   *  thinking — keep this generous). Default 4000. */
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  apiKey?: string;
}

export interface GrokCitation {
  url: string;
  title?: string;
}

export interface GrokAgentSearchResult {
  ok: boolean;
  /** HTTP status (0 when the request never left — no key / network throw). */
  status: number;
  /** The synthesised answer text (may embed inline [n] citation markers). */
  text: string;
  /** Deduped source URLs, in first-seen order (annotations first, then
   *  raw search_call sources). */
  citations: GrokCitation[];
  /** URLs supplied by an actual x_search_call (not merely web citations). */
  xSearchSources?: string[];
  /** Set when ok=false — a short diagnostic ('missing-api-key',
   *  'grok responses 4xx: …', 'threw: …'). */
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 45_000;

/** Run a server-side Grok search via the Agent Tools API. Never throws —
 *  failures come back as { ok:false, error }. */
export async function grokAgentSearch(
  query: string,
  opts: GrokAgentSearchOpts = {},
): Promise<GrokAgentSearchResult> {
  const apiKey = opts.apiKey ?? getGrokApiKey();
  if (!apiKey) return { ok: false, status: 0, text: '', citations: [], error: 'missing-api-key' };

  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const model = opts.model ?? GROK_SEARCH_MODEL;
  const tools = (opts.tools ?? ['web_search']).map(t => ({ type: t }));

  const input: Array<{ role: string; content: string }> = [];
  if (opts.systemPrompt) input.push({ role: 'system', content: opts.systemPrompt });
  input.push({ role: 'user', content: query });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetchImpl(GROK_RESPONSES_URL, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        input,
        tools,
        max_output_tokens: opts.maxOutputTokens ?? 4000,
      }),
    });
  } catch (err) {
    return { ok: false, status: 0, text: '', citations: [], error: `threw: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    // ⛔⭐⭐ **2안 — 인증 거절이면 「내 키가 낡았나」를 그 자리에서 가른다**(대표 2026-08-06).
    //   실측: 403 본문은 *"team … used all available credits or reached its monthly spending limit"*
    //   이라 **돈 문제로만 읽힌다**. 그런데 진짜 원인은 ***이 프로세스가 «다른 팀»의 낡은 키를
    //   들고 있던 것***이었다(셸 env = 소진된 팀 · 캐시 파일 = 살아 있는 팀 · 후자는 200).
    //   ⇒ 캐시를 다시 읽어 **바뀌었을 때만** 사유를 그렇게 적는다. 안 바뀌었으면 진짜 크레딧 문제다.
    //   ⛔ 여기서 **재시도하지 않는다** — 이 함수는 타임아웃·AbortController 를 이미 쥐고 있고,
    //     조용한 재시도는 그 예산을 두 배로 쓴다. 판정에 필요한 것은 «사유»이지 재시도가 아니다.
    if (res.status === 401 || res.status === 403) {
      const stale = refreshKeyFromCache('XAI_API_KEY');
      const why = stale
        ? '이 프로세스의 XAI_API_KEY 가 낡았다(캐시와 다름) — 다음 호출은 갱신된 키로 나간다'
        : '키는 캐시와 같다 — 낡은 env 가 아니라 팀 크레딧/한도 문제다';
      debug.log('grok.agent-search', 'auth-rejected', { status: res.status, staleKey: stale, why });
      return { ok: false, status: res.status, text: '', citations: [], error: `grok responses ${res.status}: ${why} · ${bodyText.slice(0, 160)}` };
    }
    return { ok: false, status: res.status, text: '', citations: [], error: `grok responses ${res.status}: ${bodyText.slice(0, 200)}` };
  }

  const body = await res.json().catch(() => null) as { output?: unknown[] } | null;
  return parseResponsesOutput(body);
}

/** Flatten the `/v1/responses` output[] into { text, citations }.
 *  Exported for unit tests. */
export function parseResponsesOutput(body: { output?: unknown[] } | null): GrokAgentSearchResult {
  const output = Array.isArray(body?.output) ? body!.output! : [];
  let text = '';
  const citations: GrokCitation[] = [];
  const xSearchSources = new Set<string>();
  const seen = new Set<string>();
  const addCite = (url?: unknown, title?: unknown): void => {
    if (typeof url !== 'string' || !url || seen.has(url)) return;
    seen.add(url);
    // Grok annotation titles are often just the citation index ("1","2") —
    // drop those so callers fall back to the URL for a label.
    const label = typeof title === 'string' && title && !/^\d+$/.test(title) ? title : undefined;
    citations.push(label ? { url, title: label } : { url });
  };

  // 1) message → answer text + inline url_citation annotations.
  for (const item of output as Array<Record<string, unknown>>) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content as Array<Record<string, unknown>>) {
        if (c?.type === 'output_text' && typeof c.text === 'string') {
          text += c.text;
          for (const a of (Array.isArray(c.annotations) ? c.annotations : []) as Array<Record<string, unknown>>) {
            if (a?.type === 'url_citation') addCite(a.url, a.title);
          }
        }
      }
    }
  }
  // 2) augment with every search_call's raw sources (dedup handles overlap).
  for (const item of output as Array<Record<string, unknown>>) {
    if ((item?.type === 'web_search_call' || item?.type === 'x_search_call')) {
      const action = item.action as Record<string, unknown> | undefined;
      const sources = Array.isArray(action?.sources) ? action!.sources as Array<Record<string, unknown>> : [];
      for (const s of sources) {
        addCite(s?.url, s?.title);
        if (item.type === 'x_search_call' && typeof s?.url === 'string') xSearchSources.add(s.url);
      }
    }
  }

  return { ok: true, status: 200, text: text.trim(), citations, xSearchSources: [...xSearchSources] };
}
