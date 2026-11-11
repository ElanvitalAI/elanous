import type { GraphCapabilityProviderDeclaration } from '../../capabilities.js';
import { dateRange, failed, isoDate, number, object, positive, responseJson, stockInput } from './stock-common.js';
import type { StockFetch } from './stock-common.js';
import { marketSecretLookup, requiredMarketSecret } from './market-secrets.js';
import type { MarketSecretLookup } from './market-secrets.js';

type Options = { readonly fetcher?: StockFetch; readonly lookupSecret?: MarketSecretLookup; readonly now?: () => Date };
const source = (id: string) => ({ source: id, market: 'US' as const, currency: 'USD' });
const barsFrom = (rows: unknown[], from: string, to: string, dateKey: string) => rows.map((raw) => {
  const row = object(raw);
  const date = String(row[dateKey] ?? '').slice(0, 10);
  if (!isoDate(date) || date < from || date > to) throw new Error('invalid_response');
  return { date, open: number(row.open), high: number(row.high), low: number(row.low),
    close: number(row.close), volume: number(row.volume) };
});

/** US quote and intraday series. The original omni-market skill uses these two public API paths. */
export function createTwelveDataDeclarations(options: Options = {}): readonly GraphCapabilityProviderDeclaration[] {
  const fetcher = options.fetcher ?? fetch;
  const lookup = options.lookupSecret ?? marketSecretLookup;
  const key = () => requiredMarketSecret('cred:twelvedata.api_key', lookup);
  const common = { tier: 'byok', latency: 800, secretRefs: ['cred:twelvedata.api_key'],
    available: async () => Boolean((await lookup('cred:twelvedata.api_key'))?.trim()),
    conditions: { market: 'US' }, guarantees: { sourceAttribution: true } } as const;
  const get = async (path: string, params: Record<string, string>) => {
    const url = new URL(`https://api.twelvedata.com/${path}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    url.searchParams.set('apikey', await key());
    const data = await responseJson(fetcher, url.toString());
    if (data.status === 'error' || typeof data.code === 'number' && data.code >= 400) throw new Error('provider_failed');
    return data;
  };
  return [
    { ...common, id: 'twelvedata-us-quote', provides: ['market.quote@1'], invoke: async (context) => {
      try {
        const { symbol } = stockInput(context, 'US');
        const data = await get('quote', { symbol });
        if (data.symbol !== symbol) throw new Error('invalid_response');
        const asOf = new Date(number(data.timestamp) * 1000).toISOString();
        return { ok: true, outcome: 'ok', result: { ...source('twelvedata'), symbol, price: positive(data.close), asOf },
          evidence: { source: 'twelvedata' } };
      } catch (error) { return failed(error); }
    } },
    { ...common, id: 'twelvedata-us-intraday', provides: ['market.intraday@1'], invoke: async (context) => {
      try {
        const input = stockInput(context, 'US');
        const { from, to } = dateRange(input);
        const data = await get('time_series', { symbol: input.symbol, interval: '5min', start_date: from, end_date: to, outputsize: '5000' });
        if (object(data.meta).symbol !== input.symbol || !Array.isArray(data.values)) throw new Error('invalid_response');
        const bars = data.values.map((raw) => { const row = object(raw); const datetime = String(row.datetime);
          if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(datetime) || datetime.slice(0, 10) < from || datetime.slice(0, 10) > to)
            throw new Error('invalid_response');
          return { datetime, open: number(row.open), high: number(row.high), low: number(row.low),
            close: number(row.close), volume: number(row.volume) }; });
        return { ok: true, outcome: 'ok', result: { source: 'twelvedata', market: 'US', symbol: input.symbol, bars: bars.reverse() },
          evidence: { source: 'twelvedata' } };
      } catch (error) { return failed(error); }
    } },
  ];
}

/** Financial Datasets US snapshot and daily prices; app key is read only from eln secret. */
export function createFdsDeclarations(options: Options = {}): readonly GraphCapabilityProviderDeclaration[] {
  const fetcher = options.fetcher ?? fetch;
  const lookup = options.lookupSecret ?? marketSecretLookup;
  const now = options.now ?? (() => new Date());
  const key = () => requiredMarketSecret('cred:fds.api_key', lookup);
  const common = { tier: 'byok', latency: 900, secretRefs: ['cred:fds.api_key'],
    available: async () => Boolean((await lookup('cred:fds.api_key'))?.trim()),
    conditions: { market: 'US' }, guarantees: { sourceAttribution: true } } as const;
  const get = async (path: string, params: Record<string, string>) => {
    const url = new URL(`https://api.financialdatasets.ai${path}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return responseJson(fetcher, url.toString(), { headers: { 'X-API-KEY': await key() } });
  };
  return [
    { ...common, id: 'fds-us-quote', provides: ['market.quote@1'], invoke: async (context) => {
      try { const { symbol } = stockInput(context, 'US'); const data = await get('/prices/snapshot', { ticker: symbol });
        const snapshot = object(data.snapshot);
        return { ok: true, outcome: 'ok', result: { ...source('fds'), symbol,
          price: positive(snapshot.close ?? snapshot.price), asOf: now().toISOString() },
          evidence: { source: 'fds', timestampKind: 'observed-at' } };
      } catch (error) { return failed(error); }
    } },
    { ...common, id: 'fds-us-ohlcv', provides: ['market.ohlcv@1'], invoke: async (context) => {
      try { const input = stockInput(context, 'US'); const { from, to } = dateRange(input);
        const data = await get('/prices', { ticker: input.symbol, start_date: from, end_date: to, interval: 'day' });
        if (!Array.isArray(data.prices)) throw new Error('invalid_response');
        const bars = barsFrom(data.prices, from, to, 'time');
        return { ok: true, outcome: 'ok', result: { source: 'fds', market: 'US', symbol: input.symbol, bars },
          evidence: { source: 'fds' } };
      } catch (error) { return failed(error); }
    } },
    { ...common, id: 'fds-us-fundamentals', provides: ['market.fundamentals@1'], invoke: async (context) => {
      try { const { symbol } = stockInput(context, 'US');
        const data = await get('/company/facts', { ticker: symbol });
        const facts = object(data.company_facts);
        if (facts.ticker !== symbol) throw new Error('invalid_response');
        return { ok: true, outcome: 'ok', result: { source: 'fds', market: 'US', symbol, facts },
          evidence: { source: 'fds' } };
      } catch (error) { return failed(error); }
    } },
  ];
}

/** Yahoo public chart for index and continuous-futures symbols only. */
export function createYahooDeclarations(options: Pick<Options, 'fetcher'> = {}): readonly GraphCapabilityProviderDeclaration[] {
  const fetcher = options.fetcher ?? fetch;
  const common = { tier: 'free', latency: 800, available: () => true,
    guarantees: { sourceAttribution: true } } as const;
  const target = (context: Parameters<GraphCapabilityProviderDeclaration['invoke']>[0]) => {
    const input = object(context.nodeInput ?? context.input);
    const symbol = input.symbol;
    if (typeof symbol !== 'string' || !/^(?:\^[A-Z0-9]{1,12}|[A-Z0-9]{1,12}\.INDX|[A-Z0-9]{1,12}(?:\.FUT|=F))$/.test(symbol)) throw new Error('invalid_input');
    return symbol.endsWith('.INDX') ? `^${symbol.slice(0, -5)}` : symbol.endsWith('.FUT') ? `${symbol.slice(0, -4)}=F` : symbol;
  };
  return [{ ...common, id: 'yahoo-index-futures', provides: ['market.index@1', 'kr.derivatives.futures@1'],
    invoke: async (context) => {
      try {
        const symbol = target(context);
        const data = await responseJson(fetcher, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const chart = object(data.chart);
        const result = object((chart.result as unknown[])[0]);
        const meta = object(result.meta);
        if (meta.symbol !== symbol) throw new Error('invalid_response');
        const price = positive(meta.regularMarketPrice);
        const asOf = new Date(number(meta.regularMarketTime) * 1000).toISOString();
        return { ok: true, outcome: 'ok', result: { source: 'yahoo', symbol, price, asOf },
          evidence: { source: 'yahoo', terms: 'public-chart' } };
      } catch (error) { return failed(error); }
    } }];
}
