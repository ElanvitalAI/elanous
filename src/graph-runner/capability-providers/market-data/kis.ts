import type { GraphCapabilityProviderDeclaration } from '../../capabilities.js';
import { dateRange, failed, number, object, positive, responseJson, stockInput } from './stock-common.js';
import type { StockFetch } from './stock-common.js';
import { marketSecretLookup, requiredMarketSecret } from './market-secrets.js';
import type { MarketSecretLookup } from './market-secrets.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getElanousConfigDir } from '../../../elanous-config-dir.js';

function configuredKisMode(): 'real' | 'vts' {
  try {
    const data: unknown = JSON.parse(readFileSync(join(getElanousConfigDir(), 'market-data.json'), 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data) &&
      (data as { kis?: { mode?: unknown } }).kis?.mode === 'vts') return 'vts';
  } catch { /* no migrated mode */ }
  return 'real';
}

export interface KisOptions {
  readonly fetcher?: StockFetch;
  readonly appKey?: string;
  readonly appSecret?: string;
  readonly lookupSecret?: MarketSecretLookup;
  readonly now?: () => Date;
  /** Configuration, not a credential. Use `vts` for the KIS mock-trading host. */
  readonly mode?: 'real' | 'vts';
  /** Wait before the single retry of a KIS per-second rate-limit answer (default 1.1 s; tests pass 0). */
  readonly rateLimitRetryMs?: number;
}

/** KIS «초당 거래건수 초과» message code (structured field, not message text). */
const KIS_RATE_LIMIT_CODE = 'EGW00201';
const KIS_RATE_LIMIT_RETRY_MS = 1_100;
type KisTokenEntry = { token?: string; expiresAt: number; pending?: Promise<string> };
/** Access tokens per fetcher → host·app key, process-wide (memory only, never logged or persisted). Production shares the
 * global fetch, so the cache outlives the per-turn registry; a test's own fetcher gets its own cache. */
const KIS_TOKENS = new WeakMap<object, Map<string, KisTokenEntry>>();
function kisTokenCache(fetcher: object): Map<string, KisTokenEntry> {
  let cache = KIS_TOKENS.get(fetcher);
  if (!cache) KIS_TOKENS.set(fetcher, cache = new Map());
  return cache;
}

/** Read-only KIS quotation endpoints. The user's app key and secret never enter graph input or result. */
export function createKisDeclarations(options: KisOptions = {}): readonly GraphCapabilityProviderDeclaration[] {
  const fetcher = options.fetcher ?? fetch;
  const lookup = options.lookupSecret ?? marketSecretLookup;
  async function credentials(): Promise<{ appKey: string; appSecret: string }> {
    const appKey = options.appKey !== undefined ? options.appKey : await requiredMarketSecret('cred:kis.app_key', lookup);
    const appSecret = options.appSecret !== undefined ? options.appSecret : await requiredMarketSecret('cred:kis.app_secret', lookup);
    if (!appKey.trim() || !appSecret.trim()) throw new Error('key_required');
    return { appKey, appSecret };
  }
  const now = options.now ?? (() => new Date());
  const base = (options.mode ?? configuredKisMode()) === 'vts'
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  // g6 KIS-BURST: the registry is rebuilt per research turn and a Korean basket fires ~9 KIS calls in the same tick. Each
  // used to issue its OWN token request (g5 demo: 4/9 calls failed in 61–65 ms → «수급 조회 불가»). One in-flight token
  // request is shared per key·host, and a cached token outlives the per-turn registry.
  async function accessToken(appKey: string, appSecret: string): Promise<string> {
    // A rotated secret owns a different token even if the public app key and host stay the same.
    const key = `${base}\u0000${appKey}\u0000${createHash('sha256').update(appSecret).digest('hex')}`;
    const tokens = kisTokenCache(fetcher);
    const cached = tokens.get(key);
    if (cached?.token && now().getTime() < cached.expiresAt) return cached.token;
    if (cached?.pending) return cached.pending;
    const pending = (async () => {
      const payload = await responseJson(fetcher, `${base}/oauth2/tokenP`, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }) });
      if (typeof payload.access_token !== 'string' || !payload.access_token) throw new Error('invalid_response');
      tokens.set(key, { token: payload.access_token,
        expiresAt: now().getTime() + Math.max(0, number(payload.expires_in ?? 3600) - 60) * 1000 });
      return payload.access_token;
    })();
    tokens.set(key, { expiresAt: 0, pending });
    try { return await pending; }
    catch (error) { if (tokens.get(key)?.pending === pending) tokens.delete(key); throw error; }
  }
  async function quotation(path: string, trId: string, params: URLSearchParams): Promise<Record<string, unknown>> {
    const { appKey, appSecret } = await credentials();
    const bearer = await accessToken(appKey, appSecret);
    const call = () => responseJson(fetcher, `${base}${path}?${params}`, { redirect: 'error',
      headers: { authorization: `Bearer ${bearer}`, appkey: appKey, appsecret: appSecret, tr_id: trId,
        'content-type': 'application/json' },
    });
    let data = await call();
    // KIS answers a per-second burst with rt_cd≠0 and msg_cd EGW00201; that call is retried once after a short wait.
    if (data.rt_cd !== '0' && data.msg_cd === KIS_RATE_LIMIT_CODE) {
      await new Promise((resolve) => setTimeout(resolve, options.rateLimitRetryMs ?? KIS_RATE_LIMIT_RETRY_MS));
      data = await call();
    }
    if (data.rt_cd !== '0') throw new Error('provider_failed');
    return data;
  }
  const common = { tier: 'free', latency: 1200, secretRefs: ['cred:kis.app_key', 'cred:kis.app_secret'],
    available: async () => { try { await credentials(); return true; } catch { return false; } }, conditions: { market: 'KR' },
    guarantees: { sourceAttribution: true } } as const;
  return [
    { ...common, id: 'kis-kr-quote', provides: ['market.quote@1'], invoke: async (context) => {
      try {
        const { symbol } = stockInput(context, 'KR');
        const params = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: symbol });
        const data = await quotation('/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', params);
        return { ok: true, outcome: 'ok', result: { source: 'kis', market: 'KR', symbol,
          price: positive(object(data.output).stck_prpr), currency: 'KRW', asOf: now().toISOString() },
          evidence: { source: 'kis', timestampKind: 'observed-at' } };
      } catch (error) { return failed(error); }
    } },
    { ...common, id: 'kis-kr-ohlcv', provides: ['market.ohlcv@1'], invoke: async (context) => {
      try {
        const input = stockInput(context, 'KR');
        const { from, to } = dateRange(input);
        // KIS returns at most 100 daily bars per call. A 100-calendar-day window cannot exceed that cap.
        if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 > 99)
          throw new Error('invalid_input');
        const params = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: input.symbol,
          FID_INPUT_DATE_1: from.replaceAll('-', ''), FID_INPUT_DATE_2: to.replaceAll('-', ''),
          FID_PERIOD_DIV_CODE: 'D', FID_ORG_ADJ_PRC: '0' });
        const data = await quotation('/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', 'FHKST03010100', params);
        if (!Array.isArray(data.output2) || !data.output2.length) throw new Error('invalid_response');
        const bars = data.output2.map((value) => {
          const row = object(value);
          if (typeof row.stck_bsop_date !== 'string' || !/^\d{8}$/.test(row.stck_bsop_date)) throw new Error('invalid_response');
          return { date: `${row.stck_bsop_date.slice(0, 4)}-${row.stck_bsop_date.slice(4, 6)}-${row.stck_bsop_date.slice(6)}`,
            open: number(row.stck_oprc), high: number(row.stck_hgpr), low: number(row.stck_lwpr),
            close: number(row.stck_clpr), volume: number(row.acml_vol) };
        });
        return { ok: true, outcome: 'ok', result: { source: 'kis', market: 'KR', symbol: input.symbol, bars },
          evidence: { source: 'kis' } };
      } catch (error) { return failed(error); }
    } },
    { ...common, id: 'kis-kr-flow', provides: ['market.kr-flow@1'], invoke: async (context) => {
      try {
        const { symbol } = stockInput(context, 'KR');
        const params = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: symbol });
        const data = await quotation('/uapi/domestic-stock/v1/quotations/inquire-investor', 'FHKST01010900', params);
        if (!Array.isArray(data.output) || !data.output.length) throw new Error('invalid_response');
        const rows = data.output.map(object).sort((a, b) => String(b.stck_bsop_date).localeCompare(String(a.stck_bsop_date)));
        const latest = rows[0]!;
        if (typeof latest.stck_bsop_date !== 'string' || !/^\d{8}$/.test(latest.stck_bsop_date)) throw new Error('invalid_response');
        const asOf = `${latest.stck_bsop_date.slice(0, 4)}-${latest.stck_bsop_date.slice(4, 6)}-${latest.stck_bsop_date.slice(6)}`;
        return { ok: true, outcome: 'ok', result: { source: 'kis', market: 'KR', symbol, asOf,
          foreignNetVolume: number(latest.frgn_ntby_qty), institutionNetVolume: number(latest.orgn_ntby_qty) },
          evidence: { source: 'kis', timing: 'end-of-day' } };
      } catch (error) { return failed(error); }
    } },
  ];
}
