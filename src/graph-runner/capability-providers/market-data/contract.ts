export const MARKET_DATA_CAPABILITIES = [
  'market.quote', 'ohlcv', 'fundamentals', 'fx', 'commodity', 'crypto',
  'rates', 'macro', 'kr-flow', 'derivatives', 'news', 'screener',
] as const;

export type MarketDataCapability = typeof MARKET_DATA_CAPABILITIES[number];
export type MarketDataTier = 'free' | 'free-key' | 'byok' | 'paid';
export type MarketDataLatency = 'realtime' | 'delayed' | 'daily';

/** Provider metadata is declared here; graph nodes request only `requires`. */
export interface MarketDataProviderDeclaration {
  readonly id: string;
  readonly provides: readonly MarketDataCapability[];
  readonly tier: MarketDataTier;
  readonly latency: MarketDataLatency;
  readonly keyEnv?: string;
}

export interface MarketDataRequest {
  readonly requires: MarketDataCapability;
  /** FRED/ECOS series code, or crypto market/coin identifier. */
  readonly symbol: string;
  /** ISO currency for CoinGecko; defaults to usd. */
  readonly quote?: string;
}

export interface MarketDataPoint {
  readonly source: string;
  readonly capability: MarketDataCapability;
  readonly symbol: string;
  readonly value: number;
  readonly unit?: string;
  readonly asOf: string;
  readonly latency: MarketDataLatency;
}

export interface MarketDataProvider {
  readonly declaration: MarketDataProviderDeclaration;
  read(request: MarketDataRequest): Promise<MarketDataPoint>;
}

export type MarketDataFetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_response');
  return value as Record<string, unknown>;
}

export function finite(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number)) throw new Error('invalid_value');
  return number;
}

export function identifier(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(value)) throw new Error('invalid_symbol');
  return value;
}

export function assertCapability(request: MarketDataRequest, declaration: MarketDataProviderDeclaration): void {
  if (!declaration.provides.includes(request.requires)) throw new Error('unsupported_capability');
  identifier(request.symbol);
}

export async function readJson(fetcher: MarketDataFetch, url: string): Promise<unknown> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error('provider_http_error');
  return response.json();
}
