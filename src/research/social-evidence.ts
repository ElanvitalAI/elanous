import type { ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';
import { debug } from '../debug/log.js';

/**
 * g6 SOCIAL-AXIS — X·Reddit opinion as its own research prepass step. The web axes hard-exclude Grok (axis-fanout keeps
 * Grok out of the generic web route) and the three background fanout workers that do call Grok return after the turn has
 * already settled (`completeCount: 0`), so X·Reddit evidence depended on whether Firecrawl happened to return an x.com /
 * reddit.com hit (g4b 1/2 publishers · g5 0/2). The plan model now names a social query by meaning (route.socialQuery);
 * this step sends it through the research OmniSearch path (Grok concurrently with the Exa/Firecrawl fallback) once per
 * platform, beside the web axes and market-data — it never replaces them.
 */
export const SOCIAL_PLATFORMS = [
  { id: 'x', label: 'X', domains: ['x.com', 'twitter.com'] },
  { id: 'reddit', label: 'Reddit', domains: ['reddit.com'] },
] as const;
export const SOCIAL_HITS_PER_PLATFORM = 5;
export const SOCIAL_SNIPPET_CHARS = 400;
export const SOCIAL_POST_BODY_CHARS = 1_200;

export interface SocialHit { url: string; title: string; snippet: string; engine?: string; publishedAt?: number }
export type SocialSearch = (args: { query: string; allow_domains: string[]; limit: number }, signal?: AbortSignal)
  => Promise<{ hits: SocialHit[]; error?: string }>;

export interface SocialEvidenceDeps {
  search?: SocialSearch;
  fetchPost?: (url: string, signal?: AbortSignal) => Promise<{ url: string; body: string }>;
  /** Publish each verified platform's search excerpts before the other platform or optional X fetch settles. */
  onPlatformEvidence?: (evidence: ResearchEvidenceEnvelope[], platform: 'x' | 'reddit') => void;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface SocialEvidence {
  evidence: ResearchEvidenceEnvelope[];
  section: string;
  platforms: { id: string; hits: number; error?: string }[];
}

async function defaultSocialSearch(args: { query: string; allow_domains: string[]; limit: number }, signal?: AbortSignal) {
  const { dispatchResearchOmniSearch } = await import('../skills/tools/omni-search.js');
  const hits: SocialHit[] = [];
  const result = await dispatchResearchOmniSearch({ ...args, merge: 'interleave' }, {
    ...(signal ? { signal } : {}),
    onSource: (hit) => { hits.push({ url: hit.url, title: hit.title, snippet: hit.snippet, engine: hit.engine,
      ...(hit.publishedAt !== undefined ? { publishedAt: hit.publishedAt } : {}) }); },
  });
  const errors = Object.entries(result.metadata.perEngine).filter(([, value]) => value.error).map(([id]) => id);
  return { hits, ...(hits.length === 0 && errors.length ? { error: `no hits (${errors.join(', ')} failed)` } : {}) };
}

function hostMatches(url: string, domains: readonly string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

async function defaultPostFetch(url: string, signal?: AbortSignal): Promise<{ url: string; body: string }> {
  const { dispatchWebFetch } = await import('../skills/tools/webfetch.js');
  const deadline = AbortSignal.timeout(2_500);
  const result = await dispatchWebFetch({ url, prompt: 'Read the public post body.' },
    { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  return { url: result.url, body: result.output };
}

export async function socialEvidence(query: string, questionId: string, deps: SocialEvidenceDeps = {}): Promise<SocialEvidence> {
  const search = deps.search ?? defaultSocialSearch;
  const observedAt = (deps.now ?? (() => new Date()))().toISOString();
  const startedAt = Date.now();
  const envelopeForHit = (platform: typeof SOCIAL_PLATFORMS[number], hit: SocialHit, fullPost?: { url: string; body: string }): ResearchEvidenceEnvelope => {
    const sourceUrl = fullPost?.url ?? hit.url;
    const content = fullPost
      ? Array.from(`본문: ${fullPost.body}`.replace(/\s+/g, ' ').trim()).slice(0, SOCIAL_POST_BODY_CHARS).join('')
      : Array.from(`검색 발췌: ${hit.title} — ${hit.snippet}`.replace(/\s+/g, ' ').trim()).slice(0, SOCIAL_SNIPPET_CHARS).join('');
    const published = hit.publishedAt !== undefined && Number.isFinite(hit.publishedAt) && hit.publishedAt > 0
      ? new Date(hit.publishedAt).toISOString() : undefined;
    return {
      questionId, sourceKind: `social-search:${platform.id}${hit.engine ? `:${hit.engine}` : ''}`, source: sourceUrl, observedAt,
      ...(published ? { publishedAt: published } : {}),
      content, outcome: fullPost || hit.snippet ? 'complete' : 'partial',
      truncated: fullPost ? Array.from(fullPost.body).length > SOCIAL_POST_BODY_CHARS : true,
    };
  };
  const settled = await Promise.all(SOCIAL_PLATFORMS.map(async (platform) => {
    try {
      const result = await search({ query, allow_domains: [...platform.domains], limit: SOCIAL_HITS_PER_PLATFORM }, deps.signal);
      // Keep only the platform's own pages: a web fallback may ignore the domain filter.
      const seen = new Set<string>();
      const hits = result.hits.filter((hit) => hostMatches(hit.url, platform.domains) && !seen.has(hit.url) && seen.add(hit.url))
        .slice(0, SOCIAL_HITS_PER_PLATFORM);
      if (hits.length > 0) {
        try { deps.onPlatformEvidence?.(hits.map(hit => envelopeForHit(platform, hit)), platform.id); }
        catch { /* observation must not discard the completed platform */ }
      }
      return { platform, hits, ...(hits.length === 0 ? { error: result.error ?? 'no hits' } : {}) };
    } catch (error) {
      return { platform, hits: [] as SocialHit[], error: error instanceof Error ? error.message : String(error) };
    }
  }));
  // Fetch one X post body. Search hits are snippets, and a fetched body is cited only when its final URL stays on X.
  const x = settled.find((entry) => entry.platform.id === 'x');
  let fetchedPost: { url: string; body: string } | undefined;
  if (x?.hits[0] && (deps.fetchPost || !deps.search)) {
    try {
      const fetched = await (deps.fetchPost ?? defaultPostFetch)(x.hits[0].url, deps.signal);
      if (hostMatches(fetched.url, x.platform.domains) && fetched.body.trim()) {
        fetchedPost = fetched;
        debug.log('research.social', 'post-fetched', { platform: 'x', chars: Array.from(fetched.body).length });
      } else debug.log('research.social', 'post-unavailable', { platform: 'x', reason: 'redirect-or-empty' });
    } catch {
      debug.log('research.social', 'post-unavailable', { platform: 'x', reason: 'fetch-failed' });
    }
  }
  const evidence: ResearchEvidenceEnvelope[] = [];
  const lines: string[] = [];
  for (const { platform, hits, error } of settled) {
    lines.push(`### ${platform.label}`);
    if (hits.length === 0) lines.push(`- ${platform.label} 검색 결과 없음 (${error ?? 'no hits'})`);
    for (const hit of hits) {
      const fullPost = platform.id === 'x' && hit === hits[0] ? fetchedPost?.body : undefined;
      const envelope = envelopeForHit(platform, hit, fullPost ? fetchedPost : undefined);
      evidence.push(envelope);
      lines.push(`- ${envelope.source}${envelope.publishedAt ? ` · published ${envelope.publishedAt.slice(0, 10)}` : ''}: ${envelope.content}`);
    }
  }
  const platforms = settled.map(({ platform, hits, error }) => ({ id: platform.id, hits: hits.length, ...(error ? { error } : {}) }));
  debug.log('research.social', 'complete', {
    platforms: platforms.map(({ id, hits }) => ({ id, hits })), durationMs: Date.now() - startedAt,
  });
  const section = [
    '## Social sentiment (X · Reddit)',
    '여론 표본이다 — 게시물 링크를 출처로 붙이고, 표본의 대표성 한계를 적는다. 시세·수급 수치의 근거로 쓰지 않는다.',
    ...lines,
  ].join('\n');
  return { evidence, section, platforms };
}
