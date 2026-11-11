import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { GraphCapabilityProviderDeclaration } from '../../capabilities.js';
import { dateRange, failed, isoDate, number, object, positive, responseJson, stockInput } from './stock-common.js';
import type { StockFetch } from './stock-common.js';
import { marketSecretLookup, requiredMarketSecret } from './market-secrets.js';
import type { MarketSecretLookup } from './market-secrets.js';

interface TokenCache { get(): { token: string; expiresAt: number } | undefined; set(token: string, expiresAt: number): void }
const cachePath = '/tmp/toss_token_cache.json';
const sharedTokenCache: TokenCache = {
  get() {
    try {
      if (!existsSync(cachePath)) return undefined;
      const data = JSON.parse(readFileSync(cachePath, 'utf8')) as { token?: unknown; expires_at?: unknown };
      return typeof data.token === 'string' && typeof data.expires_at === 'number'
        ? { token: data.token, expiresAt: data.expires_at * 1000 } : undefined;
    } catch { return undefined; }
  },
  set(token, expiresAt) {
    const temp = `${cachePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ token, expires_at: expiresAt / 1000 }), { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, cachePath);
      chmodSync(cachePath, 0o600);
    } catch { /* Cache failure does not expose or invalidate the response. */ }
  },
};

export interface TossOptions {
  readonly fetcher?: StockFetch;
  readonly lookupSecret?: MarketSecretLookup;
  readonly tokenCache?: TokenCache;
  readonly now?: () => Date;
}

/** Toss market-data endpoints require OAuth but no account header or order privilege. */
export function createTossDeclarations(options: TossOptions = {}): readonly GraphCapabilityProviderDeclaration[] {
  const fetcher = options.fetcher ?? fetch;
  const lookup = options.lookupSecret ?? marketSecretLookup;
  const cache = options.tokenCache ?? sharedTokenCache;
  const now = options.now ?? (() => new Date());
  const base = 'https://openapi.tossinvest.com';
  async function credentials() {
    const [clientId, clientSecret] = await Promise.all([
      requiredMarketSecret('cred:toss.client_id', lookup), requiredMarketSecret('cred:toss.client_secret', lookup),
    ]);
    return { clientId, clientSecret };
  }
  async function token(): Promise<string> {
    const cached = cache.get();
    if (cached && cached.expiresAt > now().getTime() + 30_000) return cached.token;
    const { clientId, clientSecret } = await credentials();
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    const data = await responseJson(fetcher, `${base}/oauth2/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (typeof data.access_token !== 'string' || !data.access_token.trim()) throw new Error('invalid_response');
    const expiresAt = now().getTime() + Math.max(0, number(data.expires_in ?? 3600) - 60) * 1000;
    cache.set(data.access_token, expiresAt);
    return data.access_token;
  }
  async function get(path: string, params: URLSearchParams): Promise<Record<string, unknown>> {
    return responseJson(fetcher, `${base}${path}?${params}`, { headers: { authorization: `Bearer ${await token()}` } });
  }
  const common = { tier: 'free', latency: 250, secretRefs: ['cred:toss.client_id', 'cred:toss.client_secret'],
    available: async () => { try { await credentials(); return true; } catch { return false; } },
    guarantees: { sourceAttribution: true } } as const;
  return (['US', 'KR'] as const).flatMap((market) => [
    { ...common, id: `toss-${market.toLowerCase()}-quote`, provides: ['market.quote@1'], conditions: { market },
      invoke: async (context) => {
        try {
          const { symbol } = stockInput(context, market);
          const data = await get('/api/v1/prices', new URLSearchParams({ symbols: symbol }));
          if (!Array.isArray(data.result) || data.result.length !== 1) throw new Error('invalid_response');
          const row = object(data.result[0]);
          if (row.symbol !== symbol || typeof row.timestamp !== 'string' || Number.isNaN(Date.parse(row.timestamp)))
            throw new Error('invalid_response');
          const currency = market === 'US' ? 'USD' : 'KRW';
          if (row.currency !== currency) throw new Error('invalid_response');
          return { ok: true, outcome: 'ok', result: { source: 'toss', market, symbol,
            price: positive(row.lastPrice), currency, asOf: new Date(row.timestamp).toISOString() },
            evidence: { source: 'toss' } };
        } catch (error) { return failed(error); }
      } },
    { ...common, id: `toss-${market.toLowerCase()}-ohlcv`, provides: ['market.ohlcv@1'], conditions: { market },
      invoke: async (context) => {
        try {
          const input = stockInput(context, market);
          const { from, to } = dateRange(input);
          const bars: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> = [];
          let before = `${to}T23:59:59Z`;
          const seen = new Set<string>();
          let complete = false;
          for (let page = 0; page < 10 && !complete; page++) {
            const data = await get('/api/v1/candles', new URLSearchParams({ symbol: input.symbol,
              interval: '1d', count: '200', before, adjusted: 'false' }));
            const result = object(data.result);
            if (!Array.isArray(result.candles)) throw new Error('invalid_response');
            const rows = result.candles.map(object);
            for (const row of rows) {
              if (typeof row.timestamp !== 'string' || !isoDate(row.timestamp.slice(0, 10))) throw new Error('invalid_response');
              const date = row.timestamp.slice(0, 10);
              if (date < from) { complete = true; break; }
              if (date > to || seen.has(date)) continue;
              seen.add(date);
              bars.push({ date, open: number(row.openPrice), high: number(row.highPrice),
                low: number(row.lowPrice), close: number(row.closePrice), volume: number(row.volume) });
            }
            const oldest = rows.at(-1)?.timestamp;
            if (rows.length === 0 || (typeof oldest === 'string' && oldest.slice(0, 10) <= from)) complete = true;
            if (!complete) {
              if (typeof result.nextBefore !== 'string' || !result.nextBefore || result.nextBefore === before)
                throw new Error('incomplete_response');
              before = result.nextBefore;
            }
          }
          if (!complete || !bars.length) throw new Error('incomplete_response');
          bars.sort((a, b) => a.date.localeCompare(b.date));
          return { ok: true, outcome: 'ok', result: { source: 'toss', market, symbol: input.symbol, bars },
            evidence: { source: 'toss' } };
        } catch (error) { return failed(error); }
      } },
  ] as GraphCapabilityProviderDeclaration[]);
}
