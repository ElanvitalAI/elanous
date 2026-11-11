import {
  emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityRegistry, type GraphContractId,
} from '../graph-runner/capabilities.js';
import { CRAWL_CONTRACTS, CRAWL_PROVIDERS, crawlResultUsable, type CrawlContract, type CrawlContext, type CrawlProvider } from './contracts.js';
import { extractedScrapFromResult } from './scrap-extract.js';

const EXTRACT_OUTPUT = { type: 'object', required: ['url', 'title', 'excerpt', 'content', 'provider'],
  properties: { url: { type: 'string' }, title: { type: 'string' }, excerpt: { type: 'string' }, content: { type: 'string' }, provider: { type: 'string' } } } as const;
const CRAWL_OUTPUT = { type: 'object', required: ['engine', 'query', 'items', 'totalItems'],
  properties: { engine: { type: 'string' }, query: { type: 'string' }, items: { type: 'array' }, totalItems: { type: 'number' } } } as const;

function graphInput(input: unknown, contract: CrawlContract): { query: string; context: CrawlContext } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const query = contract === 'extract.structured@1' || contract === 'scrape.url@1' || contract === 'crawl.site@1'
    ? value.url : value.query;
  if (typeof query !== 'string' || !query.trim()) return null;
  return { query, context: {
    ...(typeof value.limit === 'number' && Number.isSafeInteger(value.limit) && value.limit > 0 ? { limit: value.limit } : {}),
    ...(value.socialSite === 'x' || value.socialSite === 'reddit' ? { socialSite: value.socialSite } : {}),
  } };
}

/** One declaration per supplier and contract. The core treats keyEnv names as alternatives. */
export function createCrawlGraphRegistry(providers: readonly CrawlProvider[] = CRAWL_PROVIDERS): GraphCapabilityRegistry {
  let registry = emptyGraphCapabilityRegistry();
  for (const id of CRAWL_CONTRACTS) registry = registerGraphCapabilityContract(registry, {
    id, input: { type: 'object' }, output: id === 'extract.structured@1' ? EXTRACT_OUTPUT : CRAWL_OUTPUT,
    guarantees: { sourceAttribution: true },
  });
  for (const provider of providers) for (const contract of provider.provides) {
    // Core dispatch owns provider fallback. Each declaration invokes only its own adapter.
      registry = registerGraphCapabilityProviderDeclaration(registry, {
        id: `${provider.id}-${contract.replace(/[.@]/g, '-')}`,
        provides: [contract as GraphContractId], tier: provider.tier, latency: provider.latency,
        keyEnv: provider.keyEnv, ...(provider.conditions ? { conditions: provider.conditions } : {}),
        guarantees: { sourceAttribution: true },
        invoke: async ({ input, nodeInput }) => {
          const request = {
            ...(input && typeof input === 'object' && !Array.isArray(input) ? input : {}),
            ...(nodeInput && typeof nodeInput === 'object' && !Array.isArray(nodeInput) ? nodeInput : {}),
          };
          const parsed = graphInput(request, contract);
          if (!parsed) return { ok: false, outcome: 'failed', error: 'invalid-input' };
          try {
            if (!provider.available()) throw new Error('provider unavailable');
            const output = await provider.run(parsed.query, parsed.context, contract);
            if (!crawlResultUsable(contract, output)) return { ok: false, outcome: 'failed', error: 'empty' };
            if (contract === 'extract.structured@1') {
              const url = new URL(parsed.query);
              if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid URL');
              const extracted = extractedScrapFromResult(url.href, provider.id, output);
              return { ok: true, outcome: 'done', result: extracted, evidence: { provider: extracted.provider, source: extracted.url } };
            }
            const source = output.items.find(item => item.url)?.url ?? output.annotations?.[0];
            if (!source) return { ok: false, outcome: 'failed', error: 'unattributed' };
            return { ok: true, outcome: 'done', result: output, evidence: { provider: provider.id, source } };
          } catch {
            return { ok: false, outcome: 'failed', error: 'provider-error' };
          }
        },
      });
  }
  return registry;
}
