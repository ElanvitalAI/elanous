import type { GraphCapabilityProviderDeclaration } from '../../capabilities.js';
import { dateRange, failed, number, object, positive, responseJson, stockInput } from './stock-common.js';
import type { StockFetch } from './stock-common.js';
import { marketSecretLookup, requiredMarketSecret } from './market-secrets.js';
import type { MarketSecretLookup } from './market-secrets.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  let token: string | undefined;
  let tokenExpiresAt = 0;
  async function accessToken(appKey: string, appSecret: string): Promise<string> {
    if (token && now().getTime() < tokenExpiresAt) return token;
    const payload = await responseJson(fetcher, `${base}/oauth2/tokenP`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }) });
    if (typeof payload.access_token !== 'string' || !payload.access_token) throw new Error('invalid_response');
    token = payload.access_token;
    tokenExpiresAt = now().getTime() + Math.max(0, number(payload.expires_in ?? 3600) - 60) * 1000;
    return token;
  }
  async function quotation(path: string, trId: string, params: URLSearchParams): Promise<Record<string, unknown>> {
    const { appKey, appSecret } = await credentials();
    const bearer = await accessToken(appKey, appSecret);
    const data = await responseJson(fetcher, `${base}${path}?${params}`, {
      headers: { authorization: `Bearer ${bearer}`, appkey: appKey, appsecret: appSecret, tr_id: trId,
        'content-type': 'application/json' },
    });
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
