import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { WebSearchHit, WebSearchProvider, WebSearchQuery, WebSearchResult } from './provider.js';

const EXA_SEARCH_API = 'https://api.exa.ai/search';

export interface ExaWebSearchDeps {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  getEnv?: (name: string) => string | undefined;
  readFile?: (path: string) => string;
  homeDir?: () => string;
}

interface ExaResult {
  url?: unknown;
  title?: unknown;
  highlights?: unknown;
  text?: unknown;
  score?: unknown;
  publishedDate?: unknown;
}

function resolveExaApiKey(deps: ExaWebSearchDeps): string {
  const fromEnvironment = deps.getEnv ? deps.getEnv('EXA_API_KEY') : process.env.EXA_API_KEY;
  if (fromEnvironment?.trim()) return fromEnvironment.trim();
  try {
    const path = `${(deps.homeDir ?? homedir)()}/.cache/exa_api_key`;
    return (deps.readFile ?? ((file) => readFileSync(file, 'utf8')))(path).trim();
  } catch {
    return '';
  }
}

export function buildExaWebSearchProvider(deps: ExaWebSearchDeps = {}): WebSearchProvider {
  return {
    id: 'exa',
    displayName: 'Exa',
    available: () => resolveExaApiKey(deps).length > 0,
    async search(query: WebSearchQuery, signal?: AbortSignal): Promise<WebSearchResult> {
      const apiKey = resolveExaApiKey(deps);
      if (!apiKey) throw new Error('Exa API key not configured');
      const limit = Math.max(1, Math.min(query.limit ?? 5, 20));
      let response: Response;
      try {
        response = await (deps.fetch ?? fetch)(EXA_SEARCH_API, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: query.query,
            numResults: limit,
            contents: { highlights: { maxCharacters: 500 } },
          }),
          signal,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message.split(apiKey).join('[redacted]'));
      }
      if (!response.ok) throw new Error(`Exa search HTTP ${response.status}`);
      const payload = await response.json() as { results?: ExaResult[] };
      const hits: WebSearchHit[] = (Array.isArray(payload.results) ? payload.results : [])
        .map((result) => ({
          url: String(result.url ?? ''),
          title: String(result.title ?? result.url ?? '(untitled)'),
          snippet: Array.isArray(result.highlights)
            ? result.highlights.filter((value): value is string => typeof value === 'string').join('\n')
            : String(result.text ?? ''),
          ...(typeof result.score === 'number' ? { score: result.score } : {}),
          ...(typeof result.publishedDate === 'string' && !Number.isNaN(Date.parse(result.publishedDate))
            ? { publishedAt: Date.parse(result.publishedDate) }
            : {}),
        }))
        .filter((hit) => hit.url);
      return { hits, providerName: 'exa', durationMs: 0 };
    },
  };
}
