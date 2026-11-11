import { runArgStockSimulation } from './arg-stock-sim.js';
import { createFreeMarketDeclarations } from './free-declarations.js';
import { createTossDeclarations } from './toss.js';
import { createFinnhubDeclarations } from './finnhub.js';
import { createKisDeclarations } from './kis.js';
import { createEodhdDeclarations } from './eodhd.js';
import { createTwelveDataDeclarations, createFdsDeclarations, createYahooDeclarations } from './omni-sources.js';
import { createPykrxDeclarations } from './kr-daily-sources.js';
import { createKrxDeclarations } from './krx.js';
import type { StockFetch } from './stock-common.js';

const fixtureStocks = {
  '005930': { quote: 72000, open: 71000, high: 73000, low: 70000, volume: 125000, foreign: 1500, institution: -300 },
  '000660': { quote: 180000, open: 182000, high: 184000, low: 178000, volume: 86000, foreign: -900, institution: 400 },
} as const;

/** All landed providers participate in contract selection; every endpoint is synthetic. */
export async function runArgStockAllProvidersSimulation() {
  const providerCalls: Record<string, number> = { tossToken: 0, tossQuote: 0, tossOhlcv: 0, kisToken: 0, kisFlow: 0 };
  const lookupSecret = async (id: string): Promise<string | undefined> => ({
    'cred:toss.client_id': 'fixture-id', 'cred:toss.client_secret': 'fixture-secret',
    'cred:kis.app_key': 'fixture-app', 'cred:kis.app_secret': 'fixture-secret',
  } as Record<string, string>)[id];
  const unavailableSecret = async () => undefined;
  const unexpectedFetch: StockFetch = async () => { throw new Error('unexpected_market_endpoint'); };
  const now = () => new Date('2026-11-09T08:00:00Z');
  let token: { token: string; expiresAt: number } | undefined;
  const tossFetch: StockFetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.host !== 'openapi.tossinvest.com') throw new Error('unexpected_market_host');
    if (parsed.pathname === '/oauth2/token') {
      providerCalls.tossToken++;
      return { ok: true, json: async () => ({ access_token: 'fixture-token', expires_in: 3600 }) };
    }
    const symbol = parsed.searchParams.get('symbols') ?? parsed.searchParams.get('symbol');
    const stock = symbol && fixtureStocks[symbol as keyof typeof fixtureStocks];
    if (!stock) throw new Error('unexpected_market_symbol');
    if (parsed.pathname === '/api/v1/prices') {
      providerCalls.tossQuote++;
      return { ok: true, json: async () => ({ result: [{ symbol, timestamp: '2026-11-09T15:30:00+09:00',
        lastPrice: String(stock.quote), currency: 'KRW' }] }) };
    }
    if (parsed.pathname === '/api/v1/candles') {
      providerCalls.tossOhlcv++;
      return { ok: true, json: async () => ({ result: { candles: [{ timestamp: '2026-11-09T00:00:00+09:00',
        openPrice: String(stock.open), highPrice: String(stock.high), lowPrice: String(stock.low),
        closePrice: String(stock.quote), volume: String(stock.volume) }], nextBefore: null } }) };
    }
    throw new Error('unexpected_market_endpoint');
  };
  const kisFetch: StockFetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.host !== 'openapi.koreainvestment.com:9443') throw new Error('unexpected_market_host');
    if (parsed.pathname === '/oauth2/tokenP') {
      providerCalls.kisToken++;
      return { ok: true, json: async () => ({ access_token: 'fixture-token', expires_in: 3600 }) };
    }
    const symbol = parsed.searchParams.get('FID_INPUT_ISCD');
    const stock = symbol && fixtureStocks[symbol as keyof typeof fixtureStocks];
    if (!stock || parsed.pathname !== '/uapi/domestic-stock/v1/quotations/inquire-investor')
      throw new Error('unexpected_market_endpoint');
    providerCalls.kisFlow++;
    return { ok: true, json: async () => ({ rt_cd: '0', output: [{ stck_bsop_date: '20261109',
      frgn_ntby_qty: String(stock.foreign), orgn_ntby_qty: String(stock.institution) }] }) };
  };
  const providers = [
    ...createFreeMarketDeclarations(),
    ...createTossDeclarations({ fetcher: tossFetch, lookupSecret, now,
      tokenCache: { get: () => token, set: (value, expiresAt) => { token = { token: value, expiresAt }; } } }),
    ...createFinnhubDeclarations({ fetcher: unexpectedFetch, lookupSecret: unavailableSecret }),
    ...createKisDeclarations({ fetcher: kisFetch, lookupSecret, now, mode: 'real' }),
    ...createEodhdDeclarations({ fetcher: unexpectedFetch, lookupSecret: unavailableSecret }),
    ...createTwelveDataDeclarations({ fetcher: unexpectedFetch, lookupSecret: unavailableSecret }),
    ...createFdsDeclarations({ fetcher: unexpectedFetch, lookupSecret: unavailableSecret }),
    ...createYahooDeclarations({ fetcher: unexpectedFetch }),
    ...createKrxDeclarations({ fetcher: unexpectedFetch, lookupSecret: unavailableSecret }),
    ...createPykrxDeclarations({ available: () => false,
      readDaily: async () => { throw new Error('unexpected_market_endpoint'); } }),
  ];
  return runArgStockSimulation({ providers, providerCalls });
}

if (import.meta.main) console.log(JSON.stringify(await runArgStockAllProvidersSimulation(), null, 2));
