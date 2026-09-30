import { debug } from '../debug/log.js';
import type { WebSearchHit, WebSearchProvider } from './provider.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function unwrapDdgUrl(href: string): string {
  try {
    const u = href.startsWith('//') ? new URL('https:' + href) : new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return uddg;
    return href.startsWith('//') ? 'https:' + href : href;
  } catch { return href; }
}

export function buildFreeWebSearchProvider(deps: { fetch?: typeof fetch } = {}): WebSearchProvider {
  return {
    id: 'ddg-free',
    displayName: 'DuckDuckGo (keyless)',
    available: () => true,
    search: async (q, signal) => {
      const startedAt = Date.now();
      const limit = Number.isFinite(q.limit) ? Math.max(1, Math.min(20, Math.floor(q.limit!))) : 5;
      let status: number | undefined;
      try {
        const response = await (deps.fetch ?? fetch)('https://html.duckduckgo.com/html/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
          body: new URLSearchParams({ q: q.query }).toString(),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        });
        status = response.status;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;
        const blockRe = /<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>/g;
        const links = [...html.matchAll(linkRe)];
        const blocks = [...html.matchAll(blockRe)].map(match => match.index);
        const hits: WebSearchHit[] = [];
        for (let i = 0; i < links.length && hits.length < limit; i++) {
          const link = links[i];
          const nextLink = links[i + 1]?.index ?? html.length;
          const nextBlock = blocks.find(position => position > link.index);
          const end = Math.min(nextLink, nextBlock ?? html.length);
          const snippet = html.slice(link.index + link[0].length, end).match(snipRe);
          const url = unwrapDdgUrl(link[1]);
          const title = stripTags(link[2]);
          if (url && title) hits.push({ url, title, snippet: snippet ? stripTags(snippet[1]) : '' });
        }
        if (hits.length === 0) throw new Error('No DuckDuckGo results parsed');
        const durationMs = Date.now() - startedAt;
        debug.log('web-search.free', 'search', { hits: hits.length, durationMs, status, queryLength: q.query.length });
        return { hits, providerName: 'ddg-free', durationMs };
      } catch (err) {
        debug.log('web-search.free', 'failed', {
          ...(status !== undefined && status >= 400 ? { status } : { reason: signal?.aborted ? 'aborted' : 'request-or-parse-failed' }),
          queryLength: q.query.length,
          durationMs: Date.now() - startedAt,
        });
        throw err;
      }
    },
  };
}
