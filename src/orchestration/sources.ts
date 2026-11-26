// DEMO-SOURCES-VIA-SECRET (대표 11-26) — real, citable data desks for goal orchestrations (market brief).
// Every desk resolves its key through the product secret resolver (`eln secret` store first, then the catalogued
// legacy env name — the same order Firecrawl/Upstage use), calls the provider, and returns items that each carry a
// source record { provider, url, fetchedAt }. No key or a failed call → status «unavailable» with a reason; the worker
// then answers nothing and the brief states no fact from that desk. Key values are never printed, logged or put in a
// recorded URL (EODHD's token is a query parameter — the recorded endpoint drops it; errors carry status codes only).
import { grokAgentSearch, type GrokAgentSearchResult } from '../grok/agent-search.js';

export interface SourceRecord { readonly provider: string; readonly url: string; readonly fetchedAt: string; readonly title?: string }
export interface SourceItem { readonly text: string; readonly source: SourceRecord }
export interface DeskResult {
  readonly desk: string;
  readonly status: 'ok' | 'unavailable';
  /** Short label shown in the tile («via Grok search» …). */
  readonly via: string;
  readonly items: readonly SourceItem[];
  /** Why the desk (or one of its sub-sources) has no data — status codes and missing key names only. */
  readonly reason?: string;
  readonly unavailableParts?: readonly { readonly provider: string; readonly reason: string }[];
}
export type KeyLookup = (ids: readonly string[], envNames: readonly string[]) => Promise<string | undefined>;
export interface SourceDeps {
  readonly key: KeyLookup;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly grok?: (query: string, apiKey: string | undefined) => Promise<GrokAgentSearchResult>;
}
export const DESKS = ['news', 'x', 'youtube', 'market'] as const;
export type Desk = (typeof DESKS)[number];

/** Product resolver: secret store (selected backend) by id, then the catalogued env name. Never throws a value. */
export const productKeyLookup: KeyLookup = async (ids, envNames) => {
  const { getSecretAsync, selectBackendFromConfig } = await import('../nexus/config/secrets/index.js');
  try { selectBackendFromConfig(); } catch { /* file backend default */ }
  for (const id of ids) {
    try { const v = (await getSecretAsync(id))?.trim(); if (v) return v; } catch { /* store read failed → next */ }
  }
  for (const name of envNames) { const v = process.env[name]?.trim(); if (v) return v; }
  return undefined;
};
/** Secret store only (no env fallback) — used where the rule is «if its token exists in secrets». */
export const storeOnly = (lookup: KeyLookup): KeyLookup => (ids) => lookup(ids, []);

export function defaultSourceDeps(): SourceDeps {
  return {
    key: productKeyLookup, fetch: globalThis.fetch.bind(globalThis), now: () => new Date(),
    grok: (query, apiKey) => grokAgentSearch(query, { tools: ['x_search'], credentialPreference: 'api_key', ...(apiKey ? { apiKey } : {}), timeoutMs: 60_000,
      systemPrompt: 'Search X for recent posts on this topic. Summarize what traders and analysts are saying in 3-5 short bullets, each tied to a cited post.' }),
  };
}

const KEYS = {
  firecrawl: { ids: ['cred:firecrawl.api_key'], env: ['FIRECRAWL_API_KEY'] },
  brave: { ids: ['cred:brave.api_key'], env: ['BRAVE_API_KEY'] },
  apify: { ids: ['cred:apify.token', 'cred:apify.api_key', 'APIFY_TOKEN'], env: [] as string[] },
  xai: { ids: ['XAI_API_KEY', 'cred:xai.api_key'], env: ['XAI_API_KEY', 'GROK_API_KEY'] },
  supadata: { ids: ['cred:supadata.api_key', 'SUPADATA_API_KEY'], env: ['SUPADATA_API_KEY'] },
  eodhd: { ids: ['cred:eodhd.api_key'], env: ['EODHD_API_KEY'] },
  kisKey: { ids: ['cred:kis.app_key', 'KIS_APP_KEY'], env: ['KIS_APP_KEY'] },
  kisSecret: { ids: ['cred:kis.app_secret', 'KIS_APP_SECRET'], env: ['KIS_APP_SECRET'] },
  krx: { ids: ['cred:krx.api_key', 'KRX_API_KEY'], env: ['KRX_API_KEY'] },
} as const;
const key = (deps: SourceDeps, k: keyof typeof KEYS): Promise<string | undefined> => deps.key(KEYS[k].ids, KEYS[k].env);

class SourceError extends Error {}
const clip = (s: unknown, n = 280): string => String(s ?? '').replace(/\s+/gu, ' ').trim().slice(0, n);
async function getJson(deps: SourceDeps, label: string, url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<unknown> {
  let res: Response;
  try { res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' }); }
  catch (error) { throw new SourceError(`${label} request failed (${error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network'})`); }
  if (!res.ok) throw new SourceError(`${label} HTTP ${res.status}`);
  try { return await res.json(); } catch { throw new SourceError(`${label} returned non-JSON`); }
}
const why = (error: unknown): string => error instanceof SourceError ? error.message : 'unexpected error';
const unavailable = (desk: string, via: string, reason: string): DeskResult => ({ desk, status: 'unavailable', via, items: [], reason });

// ── news: Firecrawl search → Brave news ───────────────────────────────────────────────────────────────────────────
export async function newsDesk(query: string, deps: SourceDeps, limit = 6): Promise<DeskResult> {
  const tried: string[] = [];
  const fc = await key(deps, 'firecrawl');
  if (fc) {
    try {
      const at = deps.now().toISOString();
      const j = await getJson(deps, 'Firecrawl search', 'https://api.firecrawl.dev/v1/search', { method: 'POST',
        headers: { Authorization: `Bearer ${fc}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, limit, tbs: 'qdr:d' }) }) as { data?: Array<Record<string, unknown>> };
      const items = (j.data ?? []).filter((d) => typeof d.url === 'string' && d.url).slice(0, limit)
        .map((d) => ({ text: `${clip(d.title, 160)} — ${clip(d.description ?? d.snippet)}`, source: { provider: 'Firecrawl search', url: String(d.url), fetchedAt: at, title: clip(d.title, 160) } }));
      if (items.length) return { desk: 'news', status: 'ok', via: 'via Firecrawl search', items };
      tried.push('Firecrawl: no results');
    } catch (error) { tried.push(why(error)); }
  } else tried.push('Firecrawl key not set');
  const br = await key(deps, 'brave');
  if (br) {
    try {
      const at = deps.now().toISOString();
      const j = await getJson(deps, 'Brave news', `https://api.search.brave.com/res/v1/news/search?${new URLSearchParams({ q: query, count: String(limit), freshness: 'pd' })}`,
        { headers: { Accept: 'application/json', 'X-Subscription-Token': br } }) as { results?: Array<Record<string, unknown>> };
      const items = (j.results ?? []).filter((d) => typeof d.url === 'string' && d.url).slice(0, limit)
        .map((d) => ({ text: `${clip(d.title, 160)} — ${clip(d.description)}${d.age ? ` (${clip(d.age, 30)})` : ''}`, source: { provider: 'Brave news search', url: String(d.url), fetchedAt: at, title: clip(d.title, 160) } }));
      if (items.length) return { desk: 'news', status: 'ok', via: 'via Brave news search', items };
      tried.push('Brave: no results');
    } catch (error) { tried.push(why(error)); }
  } else tried.push('Brave key not set');
  return unavailable('news', 'news search', tried.join('; '));
}

// ── X: Apify tweet scraper (token in secrets) → Grok search ──────────────────────────────────────────────────────
export async function xDesk(query: string, deps: SourceDeps, limit = 8): Promise<DeskResult> {
  const tried: string[] = [];
  const apify = await storeOnly(deps.key)(KEYS.apify.ids, []);
  if (apify) {
    try {
      const at = deps.now().toISOString();
      const j = await getJson(deps, 'Apify tweet-scraper', 'https://api.apify.com/v2/acts/apidojo~tweet-scraper/run-sync-get-dataset-items', { method: 'POST',
        headers: { Authorization: `Bearer ${apify}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ searchTerms: [query], maxItems: limit, sort: 'Latest' }) }, 90_000) as Array<Record<string, unknown>>;
      const items = (Array.isArray(j) ? j : []).filter((t) => typeof t.url === 'string' && t.url).slice(0, limit)
        .map((t) => ({ text: `@${clip((t.author as Record<string, unknown> | undefined)?.userName, 40)}: ${clip(t.text)}`, source: { provider: 'Apify tweet-scraper (X)', url: String(t.url), fetchedAt: at } }));
      if (items.length) return { desk: 'x', status: 'ok', via: 'via Apify tweet scraper', items };
      tried.push('Apify: no tweets');
    } catch (error) { tried.push(why(error)); }
  }
  if (!deps.grok) return unavailable('x', 'via Grok search', [...tried, 'Grok search not wired'].join('; '));
  const xai = await key(deps, 'xai');
  const at = deps.now().toISOString();
  let r: GrokAgentSearchResult;
  try { r = await deps.grok(query, xai); } catch { r = { ok: false, status: 0, text: '', citations: [], error: 'threw' }; }
  if (!r.ok) return unavailable('x', 'via Grok search', [...tried, `Grok search failed (${r.error === 'missing-api-key' ? 'xAI key not set' : r.status ? `HTTP ${r.status}` : 'no response'})`].join('; '));
  const xUrls = new Set(r.xSearchSources ?? []);
  const cites = [...r.citations.filter((c) => xUrls.has(c.url) || /(^|\.)(x|twitter)\.com\//u.test(c.url)), ...r.citations.filter((c) => !(xUrls.has(c.url) || /(^|\.)(x|twitter)\.com\//u.test(c.url)))].slice(0, limit);
  if (!cites.length) return unavailable('x', 'via Grok search', [...tried, 'Grok search returned no cited posts'].join('; '));
  // Grok's synthesis is a summary of the cited posts; it stays tied to those URLs (no uncited claim).
  const items: SourceItem[] = [{ text: `Grok search summary of the cited posts: ${clip(r.text, 1200)}`, source: { provider: 'Grok search (xAI x_search)', url: cites[0]!.url, fetchedAt: at } },
    ...cites.map((c) => ({ text: `cited post: ${clip(c.title ?? c.url, 160)}`, source: { provider: 'Grok search (xAI x_search)', url: c.url, fetchedAt: at } }))];
  return { desk: 'x', status: 'ok', via: 'via Grok search', items };
}

// ── YouTube: Supadata search + transcript ─────────────────────────────────────────────────────────────────────────
export async function youtubeDesk(query: string, deps: SourceDeps, limit = 3): Promise<DeskResult> {
  const k = await key(deps, 'supadata');
  if (!k) return unavailable('youtube', 'via Supadata', 'Supadata key not set');
  const headers = { 'x-api-key': k };
  let videos: Array<{ id: string; title: string; channel: string }>;
  try {
    const j = await getJson(deps, 'Supadata YouTube search', `https://api.supadata.ai/v1/youtube/search?${new URLSearchParams({ query, type: 'video', uploadDate: 'week', limit: String(limit + 2) })}`, { headers }) as { results?: Array<Record<string, unknown>> };
    videos = (j.results ?? []).map((v) => ({ id: String(v.id ?? ''), title: clip(v.title, 160), channel: clip((v.channel as Record<string, unknown> | undefined)?.name ?? v.channelTitle, 60) })).filter((v) => /^[\w-]{6,20}$/u.test(v.id));
  } catch (error) { return unavailable('youtube', 'via Supadata', why(error)); }
  if (!videos.length) return unavailable('youtube', 'via Supadata', 'Supadata search: no videos');
  const items: SourceItem[] = [];
  const parts: { provider: string; reason: string }[] = [];
  for (const v of videos.slice(0, limit)) {
    const url = `https://www.youtube.com/watch?v=${v.id}`;
    try {
      const at = deps.now().toISOString();
      const t = await getJson(deps, 'Supadata transcript', `https://api.supadata.ai/v1/youtube/transcript?${new URLSearchParams({ url, text: 'true' })}`, { headers }, 30_000) as { content?: unknown };
      const text = typeof t.content === 'string' ? t.content : '';
      if (!text.trim()) { parts.push({ provider: `Supadata transcript ${v.id}`, reason: 'empty transcript' }); continue; }
      items.push({ text: `«${v.title}» (${v.channel || 'YouTube'}) — transcript excerpt: ${clip(text, 900)}`, source: { provider: 'Supadata (YouTube transcript)', url, fetchedAt: at, title: v.title } });
    } catch (error) { parts.push({ provider: `Supadata transcript ${v.id}`, reason: why(error) }); }
  }
  if (!items.length) return { ...unavailable('youtube', 'via Supadata', parts.map((p) => p.reason).join('; ') || 'no transcripts'), unavailableParts: parts };
  return { desk: 'youtube', status: 'ok', via: 'via Supadata', items, ...(parts.length ? { unavailableParts: parts } : {}) };
}

// ── market: EODHD quotes + KIS investor flows + KRX KOSPI daily ──────────────────────────────────────────────────
export const MARKET_SYMBOLS = ['KS11.INDX', 'KQ11.INDX', '005930.KO', '000660.KO', 'USDKRW.FOREX'] as const;
export const FLOW_TICKERS = ['005930', '000660'] as const;
const KIS_BASE = 'https://openapi.koreainvestment.com:9443';
const kstDate = (d: Date, minusDays = 0): string => new Date(d.getTime() + 9 * 3_600_000 - minusDays * 86_400_000).toISOString().slice(0, 10).replace(/-/gu, '');

export async function marketDesk(deps: SourceDeps): Promise<DeskResult> {
  const items: SourceItem[] = [];
  const parts: { provider: string; reason: string }[] = [];
  // EODHD real-time (delayed) quotes. The recorded URL is the endpoint without the token.
  const eod = await key(deps, 'eodhd');
  if (!eod) parts.push({ provider: 'EODHD', reason: 'EODHD key not set' });
  else {
    for (const s of MARKET_SYMBOLS) {
      const endpoint = `https://eodhd.com/api/real-time/${s}`;
      try {
        const at = deps.now().toISOString();
        const q = await getJson(deps, `EODHD ${s}`, `${endpoint}?${new URLSearchParams({ api_token: eod, fmt: 'json' })}`) as Record<string, unknown>;
        const close = Number(q.close);
        if (!Number.isFinite(close)) { parts.push({ provider: `EODHD ${s}`, reason: 'no close in response' }); continue; }
        const ts = Number(q.timestamp);
        items.push({ text: `${s}: close ${close}${Number.isFinite(Number(q.change_p)) ? ` (${Number(q.change_p) >= 0 ? '+' : ''}${Number(q.change_p).toFixed(2)}%)` : ''}${Number.isFinite(ts) && ts > 0 ? ` as of ${new Date(ts * 1000).toISOString()}` : ''}`,
          source: { provider: 'EODHD real-time quote', url: endpoint, fetchedAt: at } });
      } catch (error) { parts.push({ provider: `EODHD ${s}`, reason: why(error) }); }
    }
  }
  // KIS investor flows (foreign / institution / individual net buys, daily).
  const [appkey, appsecret] = [await key(deps, 'kisKey'), await key(deps, 'kisSecret')];
  if (!appkey || !appsecret) parts.push({ provider: 'KIS', reason: 'KIS app key/secret not set' });
  else {
    let token: string | undefined;
    try {
      const t = await getJson(deps, 'KIS token', `${KIS_BASE}/oauth2/tokenP`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', appkey, appsecret }) }) as { access_token?: unknown };
      token = typeof t.access_token === 'string' && t.access_token ? t.access_token : undefined;
      if (!token) parts.push({ provider: 'KIS', reason: 'KIS token response had no token' });
    } catch (error) { parts.push({ provider: 'KIS', reason: why(error) }); }
    if (token) {
      for (const tk of FLOW_TICKERS) {
        const endpoint = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${tk}`;
        try {
          const at = deps.now().toISOString();
          const j = await getJson(deps, `KIS investor ${tk}`, endpoint, { headers: { authorization: `Bearer ${token}`, appkey, appsecret, tr_id: 'FHKST01010900', custtype: 'P' } }) as { rt_cd?: unknown; output?: Array<Record<string, unknown>> };
          const row = (j.output ?? []).find((r) => String(r.frgn_ntby_qty ?? '').trim() !== '');
          if (String(j.rt_cd ?? '0') !== '0' || !row) { parts.push({ provider: `KIS investor ${tk}`, reason: 'no flow rows' }); continue; }
          items.push({ text: `${tk} investor net buy (shares) on ${clip(row.stck_bsop_date, 8)}: foreign ${row.frgn_ntby_qty} · institution ${row.orgn_ntby_qty} · individual ${row.prsn_ntby_qty}${row.stck_clpr ? ` · close ${row.stck_clpr}` : ''}`,
            source: { provider: 'KIS Open API (investor trend)', url: endpoint, fetchedAt: at } });
        } catch (error) { parts.push({ provider: `KIS investor ${tk}`, reason: why(error) }); }
      }
    }
  }
  // KRX KOSPI series daily (latest published trading day within a week).
  const krx = await key(deps, 'krx');
  if (!krx) parts.push({ provider: 'KRX', reason: 'KRX key not set' });
  else {
    let found = false;
    let lastReason = 'no KOSPI row in the last 7 days';
    for (let back = 1; back <= 7 && !found; back++) {
      const basDd = kstDate(deps.now(), back);
      const endpoint = `https://data-dbg.krx.co.kr/svc/apis/idx/kospi_dd_trd.json?basDd=${basDd}`;
      try {
        const at = deps.now().toISOString();
        const j = await getJson(deps, 'KRX kospi_dd_trd', endpoint, { headers: { AUTH_KEY: krx } }) as { OutBlock_1?: Array<Record<string, unknown>> };
        const row = (j.OutBlock_1 ?? []).find((r) => String(r.IDX_NM ?? '').trim() === '코스피') ?? (j.OutBlock_1 ?? [])[0];
        if (!row) continue;
        found = true;
        items.push({ text: `KRX ${clip(row.IDX_NM, 30)} ${clip(row.BAS_DD, 8)}: close ${row.CLSPRC_IDX} (${row.FLUC_RT}%) · trading value ${row.ACC_TRDVAL}`, source: { provider: 'KRX Data Marketplace (kospi_dd_trd)', url: endpoint, fetchedAt: at } });
      } catch (error) { lastReason = why(error); if (/HTTP 40[13]/u.test(lastReason)) break; }
    }
    if (!found) parts.push({ provider: 'KRX', reason: lastReason });
  }
  if (!items.length) return { desk: 'market', status: 'unavailable', via: 'via EODHD · KIS · KRX', items: [], reason: parts.map((p) => `${p.provider}: ${p.reason}`).join('; '), unavailableParts: parts };
  return { desk: 'market', status: 'ok', via: 'via EODHD · KIS · KRX', items, ...(parts.length ? { unavailableParts: parts } : {}) };
}

export async function fetchDesk(desk: Desk, query: string, deps: SourceDeps = defaultSourceDeps()): Promise<DeskResult> {
  switch (desk) {
    case 'news': return newsDesk(query, deps);
    case 'x': return xDesk(query, deps);
    case 'youtube': return youtubeDesk(query, deps);
    case 'market': return marketDesk(deps);
  }
}

/** What the worker sees (and its tile shows): each item numbered with its URL; the rule «only these facts». */
export function renderDesk(r: DeskResult): string {
  if (r.status === 'unavailable') return `${r.desk.toUpperCase()} · ${r.via} · source unavailable — ${r.reason ?? 'no data'}`;
  const lines = [`${r.desk.toUpperCase()} · ${r.via} · ${r.items.length} item(s)`,
    'Use only these items. Every fact you state must cite its item URL. Do not add facts that are not here.', ''];
  r.items.forEach((it, i) => lines.push(`[${i + 1}] ${it.text}`, `    source: ${it.source.provider} · ${it.source.url} · fetched ${it.source.fetchedAt}`));
  for (const p of r.unavailableParts ?? []) lines.push(`(${p.provider}: source unavailable — ${p.reason})`);
  return lines.join('\n');
}

export function parseDeskResult(text: string): DeskResult | undefined {
  try {
    const v = JSON.parse(text) as DeskResult;
    if (!v || typeof v.desk !== 'string' || (v.status !== 'ok' && v.status !== 'unavailable') || !Array.isArray(v.items)) return undefined;
    return v;
  } catch { return undefined; }
}

/** The «출처» section (Korean labels — the brief is Korean end to end; titles/URLs as fetched): every fetched source record the run used (deduped by URL), then the desks with no source. */
export function sourcesSection(desks: readonly { readonly workerId: string; readonly result: DeskResult; readonly used: boolean }[]): string {
  if (!desks.length) return '';
  const seen = new Set<string>();
  const lines: string[] = ['## 출처'];
  let n = 0;
  for (const d of desks) {
    if (!d.used || d.result.status !== 'ok') continue;
    for (const it of d.result.items) {
      if (seen.has(it.source.url)) continue;
      seen.add(it.source.url);
      lines.push(`${++n}. ${it.source.provider}${it.source.title ? ` — ${it.source.title}` : ''} · ${it.source.url} · ${it.source.fetchedAt}`);
    }
  }
  if (n === 0) lines.push('(사용한 출처 없음)');
  const gaps = desks.flatMap((d) => d.result.status !== 'ok' || !d.used
    ? [`- ${d.workerId} (${d.result.via}): 출처 확보 실패 — ${d.result.reason ?? 'worker failed'} · 이 데스크의 내용은 싣지 않음`]
    : (d.result.unavailableParts ?? []).map((p) => `- ${d.workerId} · ${p.provider}: 출처 확보 실패 — ${p.reason}`));
  if (gaps.length) lines.push('', '### 출처 없음', ...gaps);
  return lines.join('\n');
}

/** The brief without its «출처» section — what the voice node speaks (URLs are not read aloud). */
export function withoutSources(result: string): string {
  const i = result.indexOf('\n## 출처\n');
  return i < 0 ? result : result.slice(0, i).trimEnd();
}
