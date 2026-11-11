import { assertCapability, finite, readJson, record } from './contract.js';
import type { MarketDataFetch, MarketDataProvider, MarketDataProviderDeclaration } from './contract.js';

export const upbitDeclaration = {
  id: 'upbit', provides: ['crypto'], tier: 'free', latency: 'realtime',
} as const satisfies MarketDataProviderDeclaration;

/** Public quotation REST endpoint needs zero credentials. */
export function createUpbitProvider(fetcher: MarketDataFetch = fetch): MarketDataProvider {
  return { declaration: upbitDeclaration, async read(request) {
    assertCapability(request, upbitDeclaration);
    if (!/^[A-Z]{3,5}-[A-Z0-9]{2,20}$/.test(request.symbol)) throw new Error('invalid_symbol');
    const data = await readJson(fetcher, `https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(request.symbol)}`);
    const row = record(Array.isArray(data) ? data[0] : undefined);
    if (row.market !== request.symbol) throw new Error('invalid_response');
    return { source: 'upbit', capability: request.requires, symbol: request.symbol,
      value: finite(row.trade_price), unit: request.symbol.split('-')[0],
      asOf: new Date(finite(row.timestamp)).toISOString(), latency: 'realtime' };
  } };
}
