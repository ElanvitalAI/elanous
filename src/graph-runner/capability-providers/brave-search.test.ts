import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchGraphContract, emptyGraphCapabilityRegistry, registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration } from '../capabilities.js';
import type { InProcessHandlerContext } from '../in-process-registry.js';
import { loadGraphPluginFromDir } from '../graph-manifest-loader.js';
import { runGraph } from '../runner.js';
import { parseCredentialSlotId } from '../../nexus/config/secrets/cred-slot-schema.js';
import { createBraveSearchProvider, createBraveSearchRegistry, createBraveSearchTransport, registerBraveSearchProvider } from './brave-search.js';
import { createExaSearchRegistry, createExaSearchTransport } from './exa-search.js';
import { SEARCH_WEB_CONTRACT } from './search-web-contract.js';

// Source: #37801 — approved search.web@1 result count and limit boundaries.
const SINGLE_RESULT = 1;
const ELEVEN_RESULTS = 11;
// Source: #38423 — short deadline exposes stalled lookup and body reads in actual providers.
const STALL_MS = 200;
const context = (input: unknown): InProcessHandlerContext => ({
  graphId: 'brave-search', runId: 'brave-fake', nodeId: 'search', input, outputs: {},
});

test('Brave maps attributed web results and accepts an empty web result section', async () => {
  const provider = createBraveSearchProvider(async request => {
    expect(request).toEqual({ query: 'Timely S2', limit: SINGLE_RESULT });
    return { type: 'search', web: { results: [{ title: 'Source', url: 'https://example.test/source', description: 'A <strong>useful</strong> source' }] } };
  });
  expect(await provider(context({ query: ' Timely S2 ', limit: SINGLE_RESULT }))).toMatchObject({
    ok: true, result: { provider: 'brave', results: [{ title: 'Source', url: 'https://example.test/source', snippet: 'A useful source' }] },
    evidence: { source: 'brave', count: 1 },
  });
  const empty = createBraveSearchProvider(async () => ({ type: 'search', web: null }));
  expect(await empty(context({ query: 'Timely S2' }))).toMatchObject({ ok: true, result: { results: [] } });
});

test('invalid input and response fail without leaking provider data', async () => {
  let calls = 0;
  const provider = createBraveSearchProvider(async () => { calls++; return { type: 'search', web: { results: [{ title: 'x', url: 'file:///secret', description: 'x' }] } }; });
  expect(await provider(context({ query: '' }))).toMatchObject({ ok: false, error: 'invalid_input' });
  expect(await provider(context({ query: 'x', limit: ELEVEN_RESULTS }))).toMatchObject({ ok: false, error: 'invalid_input' });
  expect(calls).toBe(0);
  expect(await provider(context({ query: 'x' }))).toMatchObject({ ok: false, error: 'invalid_response' });
  const failed = createBraveSearchProvider(async () => { throw new Error('synthetic-secret-never-forward'); });
  expect(await failed(context({ query: 'x' }))).toMatchObject({ ok: false, error: 'brave_search_failed' });
});

test('fake loopback Brave server uses slot before env and read-only env fallback when slot absent', async () => {
  const requests: Array<{ path: string; query: string | null; count: string | null; key: string | null }> = [];
  let status = 200;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const url = new URL(req.url);
    requests.push({ path: url.pathname, query: url.searchParams.get('q'), count: url.searchParams.get('count'),
      key: req.headers.get('x-subscription-token') });
    return status === 200
      ? Response.json({ type: 'search', web: { results: [{ title: 'Source', url: 'https://example.test/source', description: 'summary' }] } })
      : Response.json({ error: 'synthetic-secret-never-forward' }, { status });
  } });
  try {
    const env = { NODE_ENV: 'test', BRAVE_BASE_URL: `http://127.0.0.1:${server.port}/`, BRAVE_API_KEY: 'synthetic-env-key' };
    const slot = createBraveSearchProvider(createBraveSearchTransport({ env,
      keyLookup: async name => { expect(name).toBe('cred:brave.api_key'); return 'synthetic-slot-key'; } }));
    expect(await slot(context({ query: 'Timely S2', limit: SINGLE_RESULT }))).toMatchObject({ ok: true });
    const fallback = createBraveSearchProvider(createBraveSearchTransport({ env, keyLookup: async () => undefined }));
    expect(await fallback(context({ query: 'Timely S2', limit: SINGLE_RESULT }))).toMatchObject({ ok: true });
    expect(requests).toEqual([
      { path: '/res/v1/web/search', query: 'Timely S2', count: '1', key: 'synthetic-slot-key' },
      { path: '/res/v1/web/search', query: 'Timely S2', count: '1', key: 'synthetic-env-key' },
    ]);
    status = 503;
    expect(await fallback(context({ query: 'Timely S2' }))).toMatchObject({ ok: false, error: 'brave_search_failed' });
  } finally { server.stop(true); }
});

test('missing key and non-loopback test endpoint make no network call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({ type: 'search', web: null }); };
  const invalidUrl = createBraveSearchTransport({ env: { NODE_ENV: 'test', BRAVE_BASE_URL: 'https://api.search.brave.com/' },
    keyLookup: async () => 'synthetic', fetchImpl });
  await expect(invalidUrl({ query: 'x', limit: SINGLE_RESULT })).rejects.toThrow('invalid Brave test endpoint');
  const noKey = createBraveSearchTransport({ env: { NODE_ENV: 'test', BRAVE_BASE_URL: 'http://127.0.0.1:9/' },
    keyLookup: async () => undefined, fetchImpl });
  await expect(noKey({ query: 'x', limit: SINGLE_RESULT })).rejects.toThrow('missing Brave credential');
  expect(calls).toBe(0);
});

test('Brave env fallback requires confirmed slot absence; lookup error and blank slot fail closed', async () => {
  let calls = 0;
  const common = { env: { NODE_ENV: 'test', BRAVE_BASE_URL: 'http://127.0.0.1:9/', BRAVE_API_KEY: 'synthetic-env-key' },
    fetchImpl: async () => { calls++; return Response.json({ type: 'search', web: null }); } };
  const lookupError = createBraveSearchProvider(createBraveSearchTransport({ ...common,
    keyLookup: async () => { throw new Error('synthetic-backend-secret'); } }));
  const blankSlot = createBraveSearchProvider(createBraveSearchTransport({ ...common,
    keyLookup: async () => '' }));
  expect(await lookupError(context({ query: 'Timely S2' }))).toMatchObject({ ok: false, error: 'brave_search_failed' });
  expect(await blankSlot(context({ query: 'Timely S2' }))).toMatchObject({ ok: false, error: 'brave_search_failed' });
  expect(calls).toBe(0);
});

test('actual Brave provider bounds a stalled credential lookup before HTTP', async () => {
  let fetchCalls = 0;
  const provider = createBraveSearchProvider(createBraveSearchTransport({
    env: { NODE_ENV: 'test', BRAVE_BASE_URL: 'http://127.0.0.1:9/' }, timeoutMs: STALL_MS,
    keyLookup: async () => new Promise<string | undefined>(() => {}),
    fetchImpl: async () => { fetchCalls++; return Response.json({ type: 'search', web: null }); },
  }));
  expect(await provider(context({ query: 'Timely S2' }))).toMatchObject({ ok: false, error: 'brave_search_failed' });
  expect(fetchCalls).toBe(0);
});

test('actual Brave provider bounds a stalled loopback response body', async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    requests++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"search","web":{"results":['));
    } }), { headers: { 'content-type': 'application/json' } });
  } });
  try {
    const provider = createBraveSearchProvider(createBraveSearchTransport({
      env: { NODE_ENV: 'test', BRAVE_BASE_URL: `http://127.0.0.1:${server.port}/` }, timeoutMs: STALL_MS,
      keyLookup: async () => 'synthetic-brave-key',
    }));
    expect(await provider(context({ query: 'Timely S2' }))).toMatchObject({ ok: false, error: 'brave_search_failed' });
    expect(requests).toBe(1);
  } finally { server.stop(true); }
});

test('Brave declaration uses the shared contract and typed slot', () => {
  const registry = createBraveSearchRegistry(async () => ({ type: 'search', web: null }));
  expect(registry.providers[0]).toMatchObject({ id: 'brave-search', provides: ['search.web@1'], tier: 'byok', secretRefs: ['cred:brave.api_key'] });
  expect(parseCredentialSlotId('cred:brave.api_key')).toEqual({ service: 'brave', field: 'api_key' });
});

test('Brave is the next search provider when Exa fails closed', async () => {
  const exaFirst = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), SEARCH_WEB_CONTRACT), {
    id: 'fake-exa', provides: ['search.web@1'], tier: 'byok',
    invoke: async () => ({ ok: false, outcome: 'failed', error: 'missing-key' }),
  });
  const registry = registerBraveSearchProvider(exaFirst, async () => ({ type: 'search', web: null }));
  const result = await dispatchGraphContract('search.web@1', context({ query: 'Timely S2' }), registry);
  expect(result).toMatchObject({ ok: true, result: { provider: 'brave', results: [] } });
});

test('actual Exa and Brave registrations dispatch Brave after missing Exa key and Exa HTTP failure', async () => {
  let exaCalls = 0;
  let braveCalls = 0;
  const braveTransport = createBraveSearchTransport({
    env: { NODE_ENV: 'test', BRAVE_BASE_URL: 'http://127.0.0.1:9/' },
    keyLookup: async () => 'synthetic-brave-key',
    fetchImpl: async () => { braveCalls++; return Response.json({ type: 'search', web: null }); },
  });
  const run = async (exaKey: string | undefined) => {
    const exaTransport = createExaSearchTransport({
      env: { NODE_ENV: 'test', EXA_BASE_URL: 'http://127.0.0.1:9/' },
      keyLookup: async () => exaKey,
      fetchImpl: async () => { exaCalls++; return Response.json({ error: 'fake-503' }, { status: 503 }); },
    });
    const registry = registerBraveSearchProvider(createExaSearchRegistry(exaTransport), braveTransport);
    return dispatchGraphContract('search.web@1', context({ query: 'Timely S2' }), registry);
  };
  expect(await run(undefined)).toMatchObject({ ok: true, result: { provider: 'brave', results: [] } });
  expect(exaCalls).toBe(0);
  expect(await run('synthetic-exa-key')).toMatchObject({ ok: true, result: { provider: 'brave', results: [] } });
  expect(exaCalls).toBe(1);
  expect(braveCalls).toBe(2);
});

test('declared Brave plugin graph executes with isolated state and no provider network call', async () => {
  const loaded = loadGraphPluginFromDir(join(import.meta.dir, '../../../plugins/brave-search'));
  expect(Object.keys(loaded.graphs)).toEqual(['brave-search']);
  const root = mkdtempSync(join(tmpdir(), 'brave-search-graph-'));
  try {
    const state = await runGraph(loaded.graphs['brave-search']!.file, { input: { query: 'Timely S2' }, quiet: true,
      deps: { root, capabilityProviders: createBraveSearchRegistry(async () => ({ type: 'search', web: null })) } });
    expect(state.status, JSON.stringify(state)).toBe('done');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
