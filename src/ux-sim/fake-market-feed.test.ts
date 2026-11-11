import { expect, test } from 'bun:test';
import {
  createFakeMarketFeed,
  FAKE_MARKET_ASSET_CLASSES,
  FAKE_MARKET_FEED_SNAPSHOT,
  FAKE_MARKET_REGIONS,
  FAKE_MARKET_SECTORS,
  readFakeMarketCell,
} from './fake-market-feed.js';

test('fake-market-feed emits a deterministic quote and news sample for every map coordinate', () => {
  const first = createFakeMarketFeed();
  const replay = createFakeMarketFeed();
  const expectedCoordinates = FAKE_MARKET_ASSET_CLASSES.flatMap((assetClass) => FAKE_MARKET_REGIONS.flatMap((region) =>
    FAKE_MARKET_SECTORS.map((sector) => `${assetClass}:${region}:${sector}`))).sort();

  // Source: RFC §3 requires a stable snapshot identity for deterministic map-run replay.
  expect(FAKE_MARKET_FEED_SNAPSHOT).toBe('sim-market-feed-2026-11-09-v1');
  expect(first).toEqual(replay);
  expect(first.map(({ id }) => id).sort()).toEqual(expectedCoordinates);
  expect(new Set(first.map(({ id }) => id)).size).toBe(first.length);
  expect(first.every(({ quote, news }) => quote.status === 'delayed-simulated'
    && Boolean(quote.instrument) && Boolean(quote.price) && Boolean(quote.changePercent)
    && Boolean(news.id) && Boolean(news.headline) && news.source.startsWith('sim://'))).toBe(true);
});

test('fake-market-feed returns a coordinate cell and rejects coordinates outside the fixed fixture', () => {
  expect(readFakeMarketCell({ assetClass: 'equity', region: 'KR', sector: 'technology' })).toMatchObject({
    id: 'equity:KR:technology',
    quote: { instrument: 'KR-equity-technology', status: 'delayed-simulated' },
    news: { id: 'news:equity:KR:technology', source: 'sim://fake-market-feed/news' },
  });
  expect(() => readFakeMarketCell({ assetClass: 'equity', region: 'APAC' as never, sector: 'technology' })).toThrow(
    'fake-market-feed: unknown map cell',
  );
});
