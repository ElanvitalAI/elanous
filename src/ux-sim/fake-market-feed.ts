// Source: RFC-adaptive-graph-runner-stock-arg §3 requires fixed quote/news samples; this is an explicit synthetic snapshot identity.
export const FAKE_MARKET_FEED_SNAPSHOT = 'sim-market-feed-2026-11-09-v1';
// Source: RFC §3 asks for deterministic fixed quotes; these decimal strings are synthetic fixture values, not market observations.
const FIXED_QUOTE_PRICE = '101.25';
// Source: RFC §3 asks for deterministic fixed quotes; these decimal strings are synthetic fixture values, not market observations.
const FIXED_QUOTE_CHANGE_PERCENT = '0.40';
// Source: RFC §3 needs repeatable map-run snapshots; this is synthetic fixed-time metadata.
const FIXED_NEWS_PUBLISHED_AT = '2026-11-09T00:00:00.000Z';

export const FAKE_MARKET_ASSET_CLASSES = ['equity', 'bond', 'crypto', 'commodity'] as const;
export const FAKE_MARKET_REGIONS = ['KR', 'US', 'EU'] as const;
export const FAKE_MARKET_SECTORS = ['technology', 'financials', 'energy'] as const;

export type FakeMarketAssetClass = typeof FAKE_MARKET_ASSET_CLASSES[number];
export type FakeMarketRegion = typeof FAKE_MARKET_REGIONS[number];
export type FakeMarketSector = typeof FAKE_MARKET_SECTORS[number];
export type FakeMarketCoordinates = Readonly<{
  assetClass: FakeMarketAssetClass;
  region: FakeMarketRegion;
  sector: FakeMarketSector;
}>;

export interface FakeMarketQuote {
  readonly instrument: string;
  /** Decimal string avoids floating-point rounding in the fixture. */
  readonly price: string;
  readonly changePercent: string;
  readonly status: 'delayed-simulated';
}

export interface FakeMarketNews {
  readonly id: string;
  readonly headline: string;
  readonly source: string;
  readonly publishedAt: string;
}

export interface FakeMarketCell {
  readonly id: string;
  readonly assetClass: FakeMarketAssetClass;
  readonly region: FakeMarketRegion;
  readonly sector: FakeMarketSector;
  readonly quote: FakeMarketQuote;
  readonly news: FakeMarketNews;
}

export interface FakeMarketSample {
  readonly quote: FakeMarketQuote;
  readonly news: FakeMarketNews;
}

function cellId(assetClass: FakeMarketAssetClass, region: FakeMarketRegion, sector: FakeMarketSector): string {
  return `${assetClass}:${region}:${sector}`;
}

function makeCell(
  assetClass: FakeMarketAssetClass,
  region: FakeMarketRegion,
  sector: FakeMarketSector,
): FakeMarketCell {
  const id = cellId(assetClass, region, sector);
  return {
    id,
    assetClass,
    region,
    sector,
    quote: {
      instrument: `${region}-${assetClass}-${sector}`,
      price: FIXED_QUOTE_PRICE,
      changePercent: FIXED_QUOTE_CHANGE_PERCENT,
      status: 'delayed-simulated',
    },
    news: {
      id: `news:${id}`,
      headline: `Synthetic ${sector} market note for ${region} ${assetClass}`,
      source: 'sim://fake-market-feed/news',
      publishedAt: FIXED_NEWS_PUBLISHED_AT,
    },
  };
}

/** Return a fresh deterministic quote/news row for every configured map cell. */
export function createFakeMarketFeed(): readonly FakeMarketCell[] {
  return listFakeMarketCoordinates().map(({ assetClass, region, sector }) => makeCell(assetClass, region, sector));
}

/** List planned map coordinates without materializing any quote or news sample. */
export function listFakeMarketCoordinates(): readonly FakeMarketCoordinates[] {
  return FAKE_MARKET_ASSET_CLASSES.flatMap((assetClass) => FAKE_MARKET_REGIONS.flatMap((region) =>
    FAKE_MARKET_SECTORS.map((sector) => ({ assetClass, region, sector }))));
}

/** Read one cell by its stable coordinates; unknown combinations fail closed. */
export function readFakeMarketCell(
  coordinates: FakeMarketCoordinates,
): FakeMarketCell {
  if (!FAKE_MARKET_ASSET_CLASSES.includes(coordinates.assetClass)
    || !FAKE_MARKET_REGIONS.includes(coordinates.region)
    || !FAKE_MARKET_SECTORS.includes(coordinates.sector)) throw new Error('fake-market-feed: unknown map cell');
  return makeCell(coordinates.assetClass, coordinates.region, coordinates.sector);
}

/** Compare a reused row with the exact deterministic sample encoded by this snapshot and coordinate. */
export function fakeMarketSampleMatches(coordinates: FakeMarketCoordinates, sample: FakeMarketSample): boolean {
  const id = `${coordinates.assetClass}:${coordinates.region}:${coordinates.sector}`;
  return sample.quote.instrument === `${coordinates.region}-${coordinates.assetClass}-${coordinates.sector}`
    && sample.quote.price === FIXED_QUOTE_PRICE
    && sample.quote.changePercent === FIXED_QUOTE_CHANGE_PERCENT
    && sample.quote.status === 'delayed-simulated'
    && sample.news.id === `news:${id}`
    && sample.news.headline === `Synthetic ${coordinates.sector} market note for ${coordinates.region} ${coordinates.assetClass}`
    && sample.news.source === 'sim://fake-market-feed/news'
    && sample.news.publishedAt === FIXED_NEWS_PUBLISHED_AT;
}
