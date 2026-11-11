import type { CrawlResult } from '../../skills/omni-crawl/src/types.js';

/** KAIST URL scraps declare the required capability; provider names stay in the registry. */
export interface UrlScrap { url: string }
export interface ExtractedScrap { url: string; title: string; excerpt: string; content: string; provider: string }
export function extractedScrapFromResult(url: string, provider: string, result: CrawlResult): ExtractedScrap {
  const item = result.items.find(candidate => typeof candidate.text === 'string' && candidate.text.trim().length > 0);
  if (!item) throw new Error(`extract.structured@1 returned no content from ${provider}`);
  const content = item.text.trim().slice(0, 100_000);
  return { url, title: String(item.metadata?.title || new URL(url).hostname).slice(0, 200), excerpt: content.slice(0, 300), content, provider };
}
