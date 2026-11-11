import type { CrawlResult, CrawlItem } from '../../skills/omni-crawl/src/types.js';

interface RedditPost {
  title?: unknown;
  selftext?: unknown;
  permalink?: unknown;
  author?: unknown;
  score?: unknown;
  created_utc?: unknown;
}

/** Keyless public JSON endpoint. HTTP errors propagate so the contract can fall back to DDG or BYOK. */
export async function searchRedditPublicPosts(query: string, options: { limit?: number; fetchFn?: typeof fetch } = {}): Promise<CrawlResult> {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
  const url = new URL('https://www.reddit.com/search.json');
  url.searchParams.set('q', query);
  url.searchParams.set('sort', 'new');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('raw_json', '1');
  const response = await (options.fetchFn ?? fetch)(url, {
    headers: { accept: 'application/json', 'user-agent': 'ElanousCrawl/1.0 (public research; contact via github.com/ElanvitalAI/elanous)' },
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`reddit public JSON HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const children = payload && typeof payload === 'object' && 'data' in payload
    && payload.data && typeof payload.data === 'object' && 'children' in payload.data
    && Array.isArray(payload.data.children) ? payload.data.children : [];
  const items: CrawlItem[] = [];
  for (const child of children) {
    const post = child && typeof child === 'object' && 'data' in child ? child.data as RedditPost : null;
    if (!post || typeof post.title !== 'string' || typeof post.permalink !== 'string'
      || !/^\/r\/[A-Za-z0-9_]+\/comments\/[A-Za-z0-9]+\//.test(post.permalink)) continue;
    const body = typeof post.selftext === 'string' ? post.selftext : '';
    const date = typeof post.created_utc === 'number' && Number.isFinite(post.created_utc) && post.created_utc >= 0 && post.created_utc <= 8.64e12
      ? new Date(post.created_utc * 1000).toISOString() : undefined;
    items.push({ engine: 'reddit-json', query, url: `https://www.reddit.com${post.permalink}`,
      text: [post.title, body].filter(Boolean).join('\n\n').slice(0, 2_000),
      ...(typeof post.author === 'string' ? { author: post.author } : {}),
      ...(typeof post.score === 'number' && Number.isFinite(post.score) ? { likes: post.score } : {}),
      ...(date ? { date } : {}), metadata: { title: post.title } });
  }
  return { engine: 'reddit-json', query, items, totalItems: items.length, costNote: 'reddit public JSON 무료' };
}
