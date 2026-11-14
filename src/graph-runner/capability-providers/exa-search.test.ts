import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InProcessHandlerContext } from '../in-process-registry.js';
import { createExaSearchProvider, createExaSearchRegistry, createExaSearchTransport } from './exa-search.js';
import { dispatchGraphContract, graphContractValueMatches, registerGraphCapabilityProviderDeclaration } from '../capabilities.js';
import { loadGraphPluginFromDir } from '../graph-manifest-loader.js';
import { runGraph } from '../runner.js';
import { parseCredentialSlotId } from '../../nexus/config/secrets/cred-slot-schema.js';
import { SEARCH_WEB_CONTRACT } from './search-web-contract.js';

// Source: #37801 — approved search.web@1 result count and limit boundaries.
const SINGLE_RESULT = 1;
const TWO_RESULTS = 2;
const ELEVEN_RESULTS = 11;

// Source: #38423 — short deadline exposes stalled lookup and body reads in actual providers.
const STALL_MS = 200;
const context = (input: unknown): InProcessHandlerContext => ({
  graphId: 'exa-search', runId: 'exa-fake', nodeId: 'search', input, outputs: {},
});

test('Exa maps search results to the shared shape with source attribution', async () => {
  const provider = createExaSearchProvider(async (request) => {
    expect(request).toEqual({ query: '규정 개정', limit: TWO_RESULTS });
    return { results: [{ title: '공지', url: 'https://example.test/notice', highlights: ['요약'], publishedDate: '2026-11-14T00:00:00Z' }] };
  });
  expect(await provider(context({ query: '  규정 개정  ', limit: TWO_RESULTS }))).toMatchObject({
    ok: true, outcome: 'done', result: { provider: 'exa', results: [{
      title: '공지', url: 'https://example.test/notice', snippet: '요약', publishedAt: '2026-11-14T00:00:00Z',
    }] }, evidence: { source: 'exa', count: 1 },
  });
});

test('invalid input and response fail without touching transport or exposing provider content', async () => {
  let calls = 0;
  const provider = createExaSearchProvider(async () => { calls++; return { results: [{ title: 'x', url: 'file:///private/key' }] }; });
  expect(await provider(context({ query: '' }))).toMatchObject({ ok: false, error: 'invalid_input' });
  expect(await provider(context({ query: 'x', limit: ELEVEN_RESULTS }))).toMatchObject({ ok: false, error: 'invalid_input' });
  expect(calls).toBe(0);
  expect(await provider(context({ query: 'x' }))).toMatchObject({ ok: false, error: 'invalid_response' });
  const failed = createExaSearchProvider(async () => { throw new Error('synthetic-secret-or-query'); });
  expect(await failed(context({ query: 'x' }))).toMatchObject({ ok: false, error: 'exa_search_failed' });
});

test('fake loopback Exa server receives synthetic credential and request; 503 is a sanitized failure', async () => {
  const requests: Array<{ path: string; key: string | null; body: unknown }> = [];
  let status = 200;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    requests.push({ path: new URL(req.url).pathname, key: req.headers.get('x-api-key'), body: await req.json() });
    return status === 200
      ? Response.json({ results: [{ title: 'source', url: 'https://example.test/source', summary: 'summary' }] })
      : Response.json({ error: 'synthetic-secret-never-forward' }, { status });
  } });
  try {
    const transport = createExaSearchTransport({ env: { NODE_ENV: 'test', EXA_BASE_URL: `http://127.0.0.1:${server.port}/` },
      keyLookup: async slot => { expect(slot).toBe('cred:exa.api_key'); return 'synthetic-exa-key'; } });
    const provider = createExaSearchProvider(transport);
    expect(await provider(context({ query: 'Timely S2', limit: SINGLE_RESULT }))).toMatchObject({
      ok: true, result: { results: [{ title: 'source', snippet: 'summary' }] },
    });
    expect(requests).toEqual([{ path: '/search', key: 'synthetic-exa-key', body: {
      query: 'Timely S2', numResults: 1, type: 'auto', contents: { highlights: true },
    } }]);
    status = 503;
    expect(await provider(context({ query: 'Timely S2' }))).toMatchObject({ ok: false, error: 'exa_search_failed' });
  } finally { server.stop(true); }
});

test('test URL override refuses non-loopback destination and missing credential makes no call', async () => {
  let calls = 0;
  const transport = createExaSearchTransport({ env: { NODE_ENV: 'test', EXA_BASE_URL: 'https://api.exa.ai/' },
    keyLookup: async () => 'synthetic', fetchImpl: async () => { calls++; return Response.json({ results: [] }); } });
  await expect(transport({ query: 'x', limit: SINGLE_RESULT })).rejects.toThrow('invalid Exa test endpoint');
  const noKey = createExaSearchTransport({ env: { NODE_ENV: 'test', EXA_BASE_URL: 'http://127.0.0.1:9/' },
    keyLookup: async () => undefined, fetchImpl: async () => { calls++; return Response.json({ results: [] }); } });
  await expect(noKey({ query: 'x', limit: SINGLE_RESULT })).rejects.toThrow('missing Exa credential');
  expect(calls).toBe(0);
});

test('actual Exa provider bounds a stalled credential lookup before any HTTP call', async () => {
  let fetchCalls = 0;
  const provider = createExaSearchProvider(createExaSearchTransport({
    env: { NODE_ENV: 'test', EXA_BASE_URL: 'http://127.0.0.1:9/' }, timeoutMs: STALL_MS,
    keyLookup: async () => new Promise<string | undefined>(() => {}),
    fetchImpl: async () => { fetchCalls++; return Response.json({ results: [] }); },
  }));
  expect(await provider(context({ query: 'Timely S2' }))).toMatchObject({ ok: false, error: 'exa_search_failed' });
  expect(fetchCalls).toBe(0);
});

test('actual Exa provider bounds a stalled loopback response body', async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    requests++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"results":['));
    } }), { headers: { 'content-type': 'application/json' } });
  } });
  try {
    const provider = createExaSearchProvider(createExaSearchTransport({
      env: { NODE_ENV: 'test', EXA_BASE_URL: `http://127.0.0.1:${server.port}/` }, timeoutMs: STALL_MS,
      keyLookup: async () => 'synthetic-exa-key',
    }));
    expect(await provider(context({ query: 'Timely S2' }))).toMatchObject({ ok: false, error: 'exa_search_failed' });
    expect(requests).toBe(1);
  } finally { server.stop(true); }
});

test('Exa declaration binds only the shared contract and typed credential slot', () => {
  const registry = createExaSearchRegistry(async () => ({ results: [] }));
  expect(registry.providers[0]).toMatchObject({ id: 'exa-search', provides: ['search.web@1'], tier: 'byok', secretRefs: ['cred:exa.api_key'] });
  expect(parseCredentialSlotId('cred:exa.api_key')).toEqual({ service: 'exa', field: 'api_key' });
  expect(graphContractValueMatches(SEARCH_WEB_CONTRACT.output, { provider: 'exa', results: [] })).toBe(true);
  expect(graphContractValueMatches(SEARCH_WEB_CONTRACT.output, { provider: 'exa', results: [{ title: 'x' }] })).toBe(false);
});

test('failed Exa attempt allows the graph dispatcher to use another declared search provider', async () => {
  const registry = registerGraphCapabilityProviderDeclaration(
    createExaSearchRegistry(async () => { throw new Error('fake 503'); }), {
      id: 'fake-fallback', provides: ['search.web@1'], tier: 'byok',
      invoke: async () => ({ ok: true, outcome: 'done', result: { provider: 'fake-fallback', results: [] } }),
    });
  const result = await dispatchGraphContract('search.web@1', context({ query: 'Timely S2' }), registry);
  expect(result).toMatchObject({ ok: true, result: { provider: 'fake-fallback', results: [] } });
});

test('declared Exa plugin graph executes the shared search capability in an isolated state root', async () => {
  const loaded = loadGraphPluginFromDir(join(import.meta.dir, '../../../plugins/exa-search'));
  expect(Object.keys(loaded.graphs)).toEqual(['exa-search']);
  const root = mkdtempSync(join(tmpdir(), 'exa-search-graph-'));
  try {
    const state = await runGraph(loaded.graphs['exa-search']!.file, {
      input: { query: 'Timely S2', limit: SINGLE_RESULT }, quiet: true,
      deps: { root, capabilityProviders: createExaSearchRegistry(async () => ({
        results: [{ title: 'source', url: 'https://example.test/source', highlights: ['summary'] }],
      })) },
    });
    expect(state.status, JSON.stringify(state)).toBe('done');
    const raw = state.nodes.find(node => node.nodeId === 'search')?.output;
    if (typeof raw !== 'string') throw new Error('missing search output');
    expect(JSON.parse(raw)).toMatchObject({ result: { provider: 'exa', results: [{ snippet: 'summary' }] } });
    const noLimit = await runGraph(loaded.graphs['exa-search']!.file, {
      runId: 'exa-no-limit', input: { query: 'Timely S2' }, quiet: true,
      deps: { root, capabilityProviders: createExaSearchRegistry(async () => ({ results: [] })) },
    });
    expect(noLimit.status, JSON.stringify(noLimit)).toBe('done');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
