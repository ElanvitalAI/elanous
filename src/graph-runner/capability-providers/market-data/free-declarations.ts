import type { GraphCapabilityProviderDeclaration, GraphContractId } from '../../capabilities.js';
import type { MarketDataCapability, MarketDataProvider } from './contract.js';
import { createFredProvider } from './fred.js';
import { createEcosProvider } from './ecos.js';
import { createUpbitProvider } from './upbit.js';
import { createCoinGeckoProvider } from './coingecko.js';

function declare(provider: MarketDataProvider, capability: MarketDataCapability, contract: GraphContractId,
  market: 'US' | 'KR' | 'GLOBAL', latency: number): GraphCapabilityProviderDeclaration {
  return { id: `${provider.declaration.id}-${capability}`, provides: [contract], tier: 'free', latency,
    guarantees: { sourceAttribution: true },
    ...(provider.declaration.keyEnv ? { keyEnv: [provider.declaration.keyEnv] } : {}), conditions: { market },
    invoke: async (context) => {
      const input = context.nodeInput ?? context.input;
      if (!input || typeof input !== 'object' || Array.isArray(input))
        return { ok: false, outcome: 'failed', error: 'invalid_input' };
      const value = input as Record<string, unknown>;
      if (value.market !== market || typeof value.symbol !== 'string' ||
        (value.quote !== undefined && typeof value.quote !== 'string'))
        return { ok: false, outcome: 'failed', error: 'invalid_input' };
      try {
        const result = await provider.read({ requires: capability, symbol: value.symbol,
          ...(typeof value.quote === 'string' ? { quote: value.quote } : {}) });
        return { ok: true, outcome: 'ok', result, evidence: { source: provider.declaration.id } };
      } catch {
        return { ok: false, outcome: 'failed', error: 'provider_failed' };
      }
    } };
}

/** Free adapters use the #36131 contract registry for key, market, tier and latency selection. */
export function createFreeMarketDeclarations(adapters: {
  readonly fred?: MarketDataProvider; readonly ecos?: MarketDataProvider;
  readonly upbit?: MarketDataProvider; readonly coingecko?: MarketDataProvider;
} = {}): readonly GraphCapabilityProviderDeclaration[] {
  const fred = adapters.fred ?? createFredProvider();
  const ecos = adapters.ecos ?? createEcosProvider();
  const upbit = adapters.upbit ?? createUpbitProvider();
  const coingecko = adapters.coingecko ?? createCoinGeckoProvider();
  return [
    declare(fred, 'rates', 'market.rates@1', 'US', 1500),
    declare(fred, 'macro', 'market.macro@1', 'US', 1500),
    declare(ecos, 'rates', 'market.rates@1', 'KR', 1600),
    declare(ecos, 'macro', 'market.macro@1', 'KR', 1600),
    declare(ecos, 'fx', 'market.fx@1', 'KR', 1600),
    declare(upbit, 'crypto', 'market.crypto@1', 'KR', 300),
    declare(coingecko, 'crypto', 'market.crypto@1', 'GLOBAL', 500),
  ];
}
