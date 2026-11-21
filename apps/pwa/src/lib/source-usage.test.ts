import { expect, test } from 'bun:test';
import { addSourceUsage } from './source-usage';

test('counts only delivered research hits and successful market results', () => {
  let usage = { firecrawl: 0, grok: 0, market: 0 };
  usage = addSourceUsage(usage, 'OmniSearch', true, { metadata: { perEngine: {
    firecrawl: { hits: 2 }, grok: { hits: 1 }, exa: { hits: 4 },
  } } });
  usage = addSourceUsage(usage, 'finance_quote', true, { source: 'eodhd', price: 12 });
  usage = addSourceUsage(usage, 'finance_kr_flow', true, { report: '수급', symbol: '005930' });
  expect(usage).toEqual({ firecrawl: 2, grok: 1, market: 2 });
  expect(addSourceUsage(usage, 'WebSearch', true, { providerName: 'firecrawl', numHits: 3 }))
    .toEqual({ firecrawl: 5, grok: 1, market: 2 });
  expect(addSourceUsage(usage, 'finance_quote', true, { source: 'none', price: null })).toEqual(usage);
  expect(addSourceUsage(usage, 'OmniSearch', false, { metadata: { perEngine: { firecrawl: { hits: 9 } } } })).toEqual(usage);
  expect(addSourceUsage(usage, 'OmniSearch', true, { metadata: { perEngine: { firecrawl: { hits: '9' }, grok: { hits: -1 } } } })).toEqual(usage);
});
