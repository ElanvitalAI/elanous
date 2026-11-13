import { ensureMarketIndex, listMarkets, type MarketFetchOptions } from './market-fetch.js';
import type { MarketplaceIndex } from '../../market/signed-index.js';

export interface AvailableMarketPlugin {
  market: string;
  plugin: MarketplaceIndex['plugins'][number];
}

/** Read every configured public index, including the built-in market, before returning a list. */
export async function listAvailableMarketPlugins(opts: MarketFetchOptions = {}): Promise<AvailableMarketPlugin[]> {
  const markets = listMarkets(opts);
  const indices = await Promise.all(markets.map(market => ensureMarketIndex(market.name, opts)));
  return indices.flatMap(({ market, index }) => index.plugins.map(plugin => ({ market: market.name, plugin })));
}
