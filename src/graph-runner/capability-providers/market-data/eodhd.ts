import type { GraphCapabilityProviderDeclaration } from '../../capabilities.js';
import { dateRange, failed, isoDate, number, object, positive, responseJson, stockInput } from './stock-common.js';
import type { StockFetch } from './stock-common.js';
import { marketSecretLookup, requiredMarketSecret } from './market-secrets.js';
import type { MarketSecretLookup } from './market-secrets.js';

export interface EodhdOptions { readonly fetcher?: StockFetch; readonly lookupSecret?: MarketSecretLookup }

/** EODHD delayed quote and end-of-day bars. Tokens stay in the request, never in results or errors. */
export function createEodhdDeclarations(options: EodhdOptions = {}): readonly GraphCapabilityProviderDeclaration[] {
  const fetcher = options.fetcher ?? fetch;
  const lookup = options.lookupSecret ?? marketSecretLookup;
  const key = () => requiredMarketSecret('cred:eodhd.api_key', lookup);
  const common = { tier: 'byok', latency: 900, secretRefs: ['cred:eodhd.api_key'],
    available: async () => Boolean((await key())?.trim()), guarantees: { sourceAttribution: true } } as const;
  function request(context: Parameters<GraphCapabilityProviderDeclaration['invoke']>[0], market: 'US' | 'KR') {
    const input = stockInput(context, market);
    return { ...input, ticker: `${input.symbol}.${market === 'US' ? 'US' : 'KO'}` };
  }
  return (['US', 'KR'] as const).flatMap((market) => [
    { ...common, id: `eodhd-${market.toLowerCase()}-quote`, provides: ['market.quote@1'], conditions: { market },
      invoke: async (context) => {
        try {
          const input = request(context, market);
          const params = new URLSearchParams({ api_token: await key(), fmt: 'json' });
          const data = await responseJson(fetcher, `https://eodhd.com/api/real-time/${encodeURIComponent(input.ticker)}?${params}`);
          if (data.code !== input.ticker) throw new Error('invalid_response');
          const asOf = new Date(number(data.timestamp) * 1000).toISOString();
          return { ok: true, outcome: 'ok', result: { source: 'eodhd', market, symbol: input.symbol,
            price: positive(data.close), currency: market === 'US' ? 'USD' : 'KRW', asOf },
            evidence: { source: 'eodhd', timing: 'delayed' } };
        } catch (error) { return failed(error); }
      } },
    { ...common, id: `eodhd-${market.toLowerCase()}-ohlcv`, provides: ['market.ohlcv@1'], conditions: { market },
      invoke: async (context) => {
        try {
          const input = request(context, market);
          const { from, to } = dateRange(input);
          const params = new URLSearchParams({ api_token: await key(), fmt: 'json', period: 'd', order: 'a', from, to });
          const response = await fetcher(`https://eodhd.com/api/eod/${encodeURIComponent(input.ticker)}?${params}`);
          if (!response.ok) throw new Error('provider_http_error');
          const data: unknown = await response.json();
          if (!Array.isArray(data) || !data.length) throw new Error('invalid_response');
          const bars = data.map((raw) => {
            const row = object(raw);
            if (!isoDate(row.date) || row.date < from || row.date > to) throw new Error('invalid_response');
            return { date: row.date, open: number(row.open), high: number(row.high), low: number(row.low),
              close: number(row.close), volume: number(row.volume) };
          });
          if (new Set(bars.map((bar) => bar.date)).size !== bars.length) throw new Error('invalid_response');
          return { ok: true, outcome: 'ok', result: { source: 'eodhd', market, symbol: input.symbol, bars },
            evidence: { source: 'eodhd', timing: 'end-of-day' } };
        } catch (error) { return failed(error); }
      } },
  ] as GraphCapabilityProviderDeclaration[]);
}
