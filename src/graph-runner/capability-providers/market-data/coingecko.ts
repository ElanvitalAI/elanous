import { assertCapability, finite, identifier, readJson, record } from './contract.js';
import type { MarketDataFetch, MarketDataProvider, MarketDataProviderDeclaration } from './contract.js';

export const coingeckoDeclaration = {
  id: 'coingecko', provides: ['crypto'], tier: 'free', latency: 'delayed',
} as const satisfies MarketDataProviderDeclaration;

/** Keyless public endpoint. Demo keys are a separate deployment choice. */
export function createCoinGeckoProvider(fetcher: MarketDataFetch = fetch): MarketDataProvider {
  return { declaration: coingeckoDeclaration, async read(request) {
    assertCapability(request, coingeckoDeclaration);
    const quote = identifier((request.quote ?? 'usd').toLowerCase());
    const params = new URLSearchParams({ ids: request.symbol, vs_currencies: quote, include_last_updated_at: 'true' });
    const data = record(await readJson(fetcher, `https://api.coingecko.com/api/v3/simple/price?${params}`));
    const coin = record(data[request.symbol]);
    return { source: 'coingecko', capability: request.requires, symbol: request.symbol,
      value: finite(coin[quote]), unit: quote.toUpperCase(),
      asOf: new Date(finite(coin.last_updated_at) * 1000).toISOString(), latency: 'delayed' };
  } };
}
