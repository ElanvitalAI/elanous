import { assertCapability, finite, readJson, record } from './contract.js';
import type { MarketDataFetch, MarketDataProvider, MarketDataProviderDeclaration } from './contract.js';

export const fredDeclaration = {
  id: 'fred', provides: ['rates', 'macro'], tier: 'free-key', latency: 'daily', keyEnv: 'FRED_API_KEY',
} as const satisfies MarketDataProviderDeclaration;

/** FRED v1 observations. Free registration key is mandatory even for public series. */
export function createFredProvider(fetcher: MarketDataFetch = fetch, key = process.env.FRED_API_KEY): MarketDataProvider {
  return { declaration: fredDeclaration, async read(request) {
    assertCapability(request, fredDeclaration);
    if (!key?.trim()) throw new Error('key_required');
    const params = new URLSearchParams({ series_id: request.symbol, api_key: key, file_type: 'json', sort_order: 'desc', limit: '1000' });
    const data = record(await readJson(fetcher, `https://api.stlouisfed.org/fred/series/observations?${params}`));
    if (!Array.isArray(data.observations)) throw new Error('invalid_response');
    let latest: Record<string, unknown> | undefined;
    for (const observation of data.observations) {
      const row = record(observation);
      if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) throw new Error('invalid_response');
      if (row.value === '.' || row.value === '' || (typeof row.value === 'string' && !row.value.trim())) continue;
      latest = row;
      break;
    }
    if (!latest) throw new Error('invalid_value');
    return { source: 'fred', capability: request.requires, symbol: request.symbol,
      value: finite(latest.value), asOf: String(latest.date), latency: 'daily' };
  } };
}
