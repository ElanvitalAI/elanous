import { getSecretAsync, selectBackendFromConfig } from '../../nexus/config/secrets/index.js';
import {
  emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityProvider, type GraphCapabilityRegistry,
} from '../capabilities.js';
import { SEARCH_WEB_CONTRACT } from './search-web-contract.js';
import { readSearchJson, runSearchWithDeadline } from './search-web-deadline.js';

const BRAVE_SLOT = 'cred:brave.api_key';
// Source: #37801 — the shared search.web@1 contract limits result count to 1..10.
const MAX_RESULTS = 10;
// Source: https://api-dashboard.search.brave.com/api-reference/web/search/get — Brave caps queries at 600 characters.
const MAX_QUERY_LENGTH = 600;
const MAX_RESPONSE_BYTES = 1_000_000;

interface BraveRequest { query: string; limit: number }
export type BraveSearchTransport = (request: BraveRequest, signal?: AbortSignal) => Promise<unknown>;
export interface BraveSearchTransportOptions {
  keyLookup?: (slot: string) => Promise<string | undefined>;
  fetchImpl?: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}

function endpoint(env: Readonly<Record<string, string | undefined>>): URL {
  if (env.NODE_ENV !== 'test' || !env.BRAVE_BASE_URL) return new URL('https://api.search.brave.com/res/v1/web/search');
  const url = new URL(env.BRAVE_BASE_URL);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('invalid Brave test endpoint');
  }
  return new URL('/res/v1/web/search', url);
}

/** Read the typed slot first; the environment fallback is read-only and never imported. */
export function createBraveSearchTransport(options: BraveSearchTransportOptions = {}): BraveSearchTransport {
  const lookup = options.keyLookup ?? (async (slot: string) => { selectBackendFromConfig(); return getSecretAsync(slot); });
  return async ({ query, limit }, signal) => runSearchWithDeadline(async (scope) => {
    scope.throwIfAborted();
    const env = options.env ?? process.env;
    const url = endpoint(env);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));
    url.searchParams.set('result_filter', 'web');
    const stored = await lookup(BRAVE_SLOT);
    scope.throwIfAborted();
    const key = stored === undefined ? env.BRAVE_API_KEY?.trim() : stored.trim();
    if (!key) throw new Error('missing Brave credential');
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET', redirect: 'error', signal: scope,
      headers: { accept: 'application/json', 'x-subscription-token': key },
    });
    scope.throwIfAborted();
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('Brave search failed'); }
    return readSearchJson(response, scope, MAX_RESPONSE_BYTES);
  }, signal, options.timeoutMs);
}

function request(input: unknown): BraveRequest | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const query = typeof value.query === 'string' ? value.query.trim() : '';
  const limit = value.limit === undefined ? MAX_RESULTS : value.limit;
  if (!query || query.length > MAX_QUERY_LENGTH || query.split(/\s+/).length > 75
    || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RESULTS) return undefined;
  return { query, limit: limit as number };
}

function results(value: unknown, limit: number): Array<{ title: string; url: string; snippet: string }> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const response = value as Record<string, unknown>;
  if (response.type !== 'search') return undefined;
  if (response.web === undefined || response.web === null) return [];
  if (typeof response.web !== 'object' || Array.isArray(response.web)) return undefined;
  const rows = (response.web as Record<string, unknown>).results;
  if (!Array.isArray(rows) || rows.length > limit) return undefined;
  const output: Array<{ title: string; url: string; snippet: string }> = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
    const item = row as Record<string, unknown>;
    if (typeof item.title !== 'string' || !item.title.trim() || typeof item.url !== 'string') return undefined;
    let url: URL;
    try { url = new URL(item.url); } catch { return undefined; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    const description = item.description === null ? '' : item.description;
    if (typeof description !== 'string') return undefined;
    output.push({ title: item.title.slice(0, 300), url: url.href,
      snippet: description.replace(/<[^>]*>/g, '').slice(0, 1_200) });
  }
  return output;
}

/** Provider and HTTP errors never forward query, key, response body, or backend detail. */
export function createBraveSearchProvider(transport: BraveSearchTransport = createBraveSearchTransport()): GraphCapabilityProvider {
  return async (context) => {
    const parsed = request(context.nodeInput === undefined ? context.input : context.nodeInput);
    if (!parsed) return { ok: false, outcome: 'failed', error: 'invalid_input' };
    try {
      const found = results(await transport(parsed, context.signal), parsed.limit);
      if (!found) return { ok: false, outcome: 'failed', error: 'invalid_response' };
      return { ok: true, outcome: 'done', result: { provider: 'brave', results: found },
        evidence: { source: 'brave', count: found.length } };
    } catch { return { ok: false, outcome: 'failed', error: 'brave_search_failed' }; }
  };
}

export function registerBraveSearchProvider(registry: GraphCapabilityRegistry,
  transport: BraveSearchTransport = createBraveSearchTransport()): GraphCapabilityRegistry {
  return registerGraphCapabilityProviderDeclaration(registry, {
    id: 'brave-search', provides: ['search.web@1'], tier: 'byok', secretRefs: [BRAVE_SLOT],
    invoke: createBraveSearchProvider(transport),
  });
}

export function createBraveSearchRegistry(transport: BraveSearchTransport = createBraveSearchTransport()): GraphCapabilityRegistry {
  return registerBraveSearchProvider(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), SEARCH_WEB_CONTRACT), transport);
}
