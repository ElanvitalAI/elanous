import type { GraphCapabilityProviderDeclaration } from '../../capabilities.js';
import { dateRange, failed, number, positive, responseJson, stockInput } from './stock-common.js';
import type { StockFetch } from './stock-common.js';
import { marketSecretLookup, requiredMarketSecret } from './market-secrets.js';
import type { MarketSecretLookup } from './market-secrets.js';

export interface FinnhubOptions { readonly fetcher?: StockFetch; readonly apiKey?: string; readonly lookupSecret?: MarketSecretLookup }

/** Separate declarations keep contract identity at the registry boundary. */
export function createFinnhubDeclarations(options: FinnhubOptions = {}): readonly GraphCapabilityProviderDeclaration[] {
  const fetcher = options.fetcher ?? fetch;
  const lookup = options.lookupSecret ?? marketSecretLookup;
  const key = () => options.apiKey !== undefined ? Promise.resolve(options.apiKey) : requiredMarketSecret('cred:finnhub.api_key', lookup);
  const common = { tier: 'free', latency: 1000, secretRefs: ['cred:finnhub.api_key'],
    available: async () => Boolean((await key())?.trim()), conditions: { market: 'US' },
    guarantees: { sourceAttribution: true } } as const;
  return [
    { ...common, id: 'finnhub-us-quote', provides: ['market.quote@1'], invoke: async (context) => {
      try {
        const { symbol } = stockInput(context, 'US');
        const params = new URLSearchParams({ symbol, token: await key() });
        const data = await responseJson(fetcher, `https://finnhub.io/api/v1/quote?${params}`);
        return { ok: true, outcome: 'ok', result: { source: 'finnhub', market: 'US', symbol,
          price: positive(data.c), currency: 'USD', asOf: new Date(number(data.t) * 1000).toISOString() },
          evidence: { source: 'finnhub' } };
      } catch (error) { return failed(error); }
    } },
    { ...common, id: 'finnhub-us-ohlcv', provides: ['market.ohlcv@1'], invoke: async (context) => {
      try {
        const input = stockInput(context, 'US');
        const { from, to } = dateRange(input);
        const params = new URLSearchParams({ symbol: input.symbol, resolution: 'D',
          from: String(Date.parse(`${from}T00:00:00Z`) / 1000),
          to: String(Date.parse(`${to}T23:59:59Z`) / 1000), token: await key() });
        const data = await responseJson(fetcher, `https://finnhub.io/api/v1/stock/candle?${params}`);
        const times = data.t;
        if (data.s !== 'ok' || !Array.isArray(times) || ![data.o, data.h, data.l, data.c, data.v]
          .every((values) => Array.isArray(values) && values.length === times.length)) throw new Error('invalid_response');
        const bars = times.map((time, index) => ({ date: new Date(number(time) * 1000).toISOString().slice(0, 10),
          open: number((data.o as unknown[])[index]), high: number((data.h as unknown[])[index]),
          low: number((data.l as unknown[])[index]), close: number((data.c as unknown[])[index]),
          volume: number((data.v as unknown[])[index]) }));
        if (!bars.length) throw new Error('invalid_response');
        return { ok: true, outcome: 'ok', result: { source: 'finnhub', market: 'US', symbol: input.symbol, bars },
          evidence: { source: 'finnhub' } };
      } catch (error) { return failed(error); }
    } },
  ];
}
