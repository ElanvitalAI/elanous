/** Apify tweet-scraper — absorbed from apify-x-asset-sentiment (Python → TypeScript) */

import type { CrawlResult, CrawlItem } from './types.js';

const ENDPOINT = 'https://api.apify.com/v2/acts/apidojo~tweet-scraper/run-sync-get-dataset-items';

export interface ApifySearchOpts {
  query: string;
  minFavs?: number;
  maxItems?: number;
  sort?: 'Latest' | 'Top';
  lang?: string;
  noDefaultFilters?: boolean;
}

function buildSearchTerms(query: string, lang: string, addDefaults: boolean): string {
  if (!addDefaults) return query;
  const hasLang = query.includes('lang:');
  const suffix = hasLang ? '-filter:replies -filter:retweets' : `lang:${lang} -filter:replies -filter:retweets`;
  return `${query} ${suffix}`.trim();
}

let missingApifyReported = false;

export function apifyAvailable(): boolean {
  if (process.env.APIFY_TOKEN) return true;
  if (!missingApifyReported) {
    missingApifyReported = true;
    console.error('Apify 없음 — X 트윗 벌크 수집 빠짐 · APIFY_TOKEN 설정하면 벌크 검색 켜짐');
  }
  return false;
}

export async function searchApifyTweets(opts: ApifySearchOpts): Promise<CrawlResult> {
  if (!apifyAvailable()) return { engine: 'apify', query: opts.query, items: [], totalItems: 0 };
  const token = process.env.APIFY_TOKEN!;
  const url = `${ENDPOINT}?token=${token}`;

  const lang = opts.lang || 'en';
  const searchTerm = buildSearchTerms(opts.query, lang, !(opts.noDefaultFilters));

  const payload = {
    searchTerms: [searchTerm],
    minimumFavorites: opts.minFavs ?? 30,
    maxItems: opts.maxItems ?? 100,
    sort: opts.sort || 'Latest',
    tweetLanguage: lang,
  };

  console.log(`  [apify] 검색: "${opts.query}" (minFavs=${payload.minimumFavorites}, max=${payload.maxItems})`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Apify API error: ${res.status} ${await res.text().catch(() => '')}`);
  const data: any[] = await res.json();

  const items: CrawlItem[] = data.map((it: any) => {
    const user = it.user || {};
    return {
      engine: 'apify',
      query: opts.query,
      url: it.url || it.tweetUrl || '',
      author: `@${user.username || user.screenName || '?'}`,
      text: (it.text || '').replace(/\n/g, ' ').trim(),
      likes: it.likeCount ?? it.favoriteCount ?? 0,
      date: it.createdAt ? String(it.createdAt).slice(0, 10) : undefined,
      metadata: { retweetCount: it.retweetCount, replyCount: it.replyCount },
    };
  }).sort((a: CrawlItem, b: CrawlItem) => (b.likes || 0) - (a.likes || 0));

  console.log(`  [apify] ${items.length}개 트윗 수집`);
  return { engine: 'apify', query: opts.query, items, totalItems: items.length };
}
