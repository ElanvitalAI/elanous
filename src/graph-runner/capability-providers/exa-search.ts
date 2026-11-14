import { getSecretAsync, selectBackendFromConfig } from '../../nexus/config/secrets/index.js';
import type { GraphCapabilityProvider, GraphCapabilityRegistry } from '../capabilities.js';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration } from '../capabilities.js';
import { SEARCH_WEB_CONTRACT } from './search-web-contract.js';
import { readSearchJson, runSearchWithDeadline } from './search-web-deadline.js';

const EXA_SLOT = 'cred:exa.api_key';
const MAX_RESULTS = 10;
const MAX_QUERY_LENGTH = 1_000;
const MAX_RESPONSE_BYTES = 1_000_000;

interface SearchWebResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface ExaSearchRequest { query: string; limit: number }
export type ExaSearchTransport = (request: ExaSearchRequest, signal?: AbortSignal) => Promise<unknown>;
export interface ExaSearchTransportOptions {
  keyLookup?: (slot: string) => Promise<string | undefined>;
  fetchImpl?: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}

function endpoint(env: Readonly<Record<string, string | undefined>>): string {
  if (env.NODE_ENV !== 'test' || !env.EXA_BASE_URL) return 'https://api.exa.ai/search';
  const url = new URL(env.EXA_BASE_URL);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('invalid Exa test endpoint');
  }
  return `${url.origin}/search`;
}

/** Network access stays on Exa's documented Search endpoint; tests may select loopback only. */
export function createExaSearchTransport(options: ExaSearchTransportOptions = {}): ExaSearchTransport {
  const lookup = options.keyLookup ?? (async (slot: string) => { selectBackendFromConfig(); return getSecretAsync(slot); });
  return async ({ query, limit }, signal) => runSearchWithDeadline(async (scope) => {
    scope.throwIfAborted();
    const env = options.env ?? process.env;
    const url = endpoint(env);
    const key = (await lookup(EXA_SLOT))?.trim();
    scope.throwIfAborted();
    if (!key) throw new Error('missing Exa credential');
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'POST', redirect: 'error', signal: scope,
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ query, numResults: limit, type: 'auto', contents: { highlights: true } }),
    });
    scope.throwIfAborted();
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('Exa search failed'); }
    return readSearchJson(response, scope, MAX_RESPONSE_BYTES);
  }, signal, options.timeoutMs);
}

function request(input: unknown): ExaSearchRequest | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const query = typeof value.query === 'string' ? value.query.trim() : '';
  const limit = value.limit === undefined ? MAX_RESULTS : value.limit;
  if (!query || query.length > MAX_QUERY_LENGTH || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RESULTS) return undefined;
  return { query, limit: limit as number };
}

function results(value: unknown, limit: number): SearchWebResult[] | undefined {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { results?: unknown }).results)) return undefined;
  const rows = (value as { results: unknown[] }).results;
  if (rows.length > limit) return undefined;
  const output: SearchWebResult[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
    const item = row as Record<string, unknown>;
    if (typeof item.title !== 'string' || !item.title.trim() || typeof item.url !== 'string') return undefined;
    let url: URL;
    try { url = new URL(item.url); } catch { return undefined; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    const snippet = Array.isArray(item.highlights) && typeof item.highlights[0] === 'string'
      ? item.highlights[0] : typeof item.summary === 'string' ? item.summary : typeof item.text === 'string' ? item.text : '';
    const result: SearchWebResult = { title: item.title.slice(0, 300), url: url.href, snippet: snippet.slice(0, 1_200) };
    if (typeof item.publishedDate === 'string' && !Number.isNaN(Date.parse(item.publishedDate))) result.publishedAt = item.publishedDate;
    output.push(result);
  }
  return output;
}

/** Errors are stable and contain no response body, query, or key. */
export function createExaSearchProvider(transport: ExaSearchTransport = createExaSearchTransport()): GraphCapabilityProvider {
  return async (context) => {
    const parsed = request(context.nodeInput === undefined ? context.input : context.nodeInput);
    if (!parsed) return { ok: false, outcome: 'failed', error: 'invalid_input' };
    try {
      const found = results(await transport(parsed, context.signal), parsed.limit);
      if (!found) return { ok: false, outcome: 'failed', error: 'invalid_response' };
      return { ok: true, outcome: 'done', result: { results: found, provider: 'exa' },
        evidence: { source: 'exa', count: found.length } };
    } catch { return { ok: false, outcome: 'failed', error: 'exa_search_failed' }; }
  };
}

/** The shared search.web@1 contract must already be registered by the composed registry. */
export function registerExaSearchProvider(registry: GraphCapabilityRegistry,
  transport: ExaSearchTransport = createExaSearchTransport()): GraphCapabilityRegistry {
  return registerGraphCapabilityProviderDeclaration(registry, {
    id: 'exa-search', provides: ['search.web@1'], tier: 'byok', secretRefs: [EXA_SLOT],
    invoke: createExaSearchProvider(transport),
  });
}

/** Manifest factory for the Exa search graph. */
export function createExaSearchRegistry(transport: ExaSearchTransport = createExaSearchTransport()): GraphCapabilityRegistry {
  return registerExaSearchProvider(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), SEARCH_WEB_CONTRACT), transport);
}
