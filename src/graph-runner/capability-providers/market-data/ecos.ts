import { assertCapability, finite, readJson, record } from './contract.js';
import type { MarketDataFetch, MarketDataProvider, MarketDataProviderDeclaration } from './contract.js';

export const ecosDeclaration = {
  id: 'ecos', provides: ['macro', 'rates', 'fx'], tier: 'free-key', latency: 'daily', keyEnv: 'ECOS_API_KEY',
} as const satisfies MarketDataProviderDeclaration;

/** A series symbol is `STAT_CODE.ITEM_CODE1`; optional items can be added later. */
export function createEcosProvider(fetcher: MarketDataFetch = fetch, key = process.env.ECOS_API_KEY): MarketDataProvider {
  return { declaration: ecosDeclaration, async read(request) {
    assertCapability(request, ecosDeclaration);
    if (!key?.trim()) throw new Error('key_required');
    const parts = request.symbol.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('invalid_symbol');
    const [statCode, itemCode] = parts;
    const year = new Date().getUTCFullYear();
    const rows: Record<string, unknown>[] = [];
    let totalCount: number | undefined;
    let complete = false;
    const pageSize = 1000;
    for (let page = 0; page < 10; page += 1) {
      const start = page * pageSize + 1;
      const url = `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(key)}/json/kr/${start}/${start + pageSize - 1}/${statCode}/M/${year - 1}01/${year}12/${itemCode}`;
      const data = record(await readJson(fetcher, url));
      const result = record(data.StatisticSearch);
      if (!Array.isArray(result.row)) throw new Error('invalid_response');
      rows.push(...result.row.map(record));
      if (result.list_total_count !== undefined) totalCount = finite(result.list_total_count);
      if (totalCount !== undefined ? rows.length >= totalCount : result.row.length < pageSize) { complete = true; break; }
    }
    if (!complete || !rows.length || (totalCount !== undefined && rows.length < totalCount)) throw new Error('invalid_response');
    const latest = rows.sort((a, b) => String(b.TIME).localeCompare(String(a.TIME)))[0]!;
    if (typeof latest.TIME !== 'string' || !/^\d{4,8}$/.test(latest.TIME)) throw new Error('invalid_response');
    return { source: 'ecos', capability: request.requires, symbol: request.symbol,
      value: finite(latest.DATA_VALUE), unit: typeof latest.UNIT_NAME === 'string' ? latest.UNIT_NAME : undefined,
      asOf: String(latest.TIME), latency: 'daily' };
  } };
}
