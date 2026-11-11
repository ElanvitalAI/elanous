import { expect, test } from 'bun:test';
import { createNexusClient, NexusApiError } from './client';

test('plugin credential GET and PUT encode the plugin path and preserve the API contract', async () => {
  const calls: Array<{ url: string; method: string; body?: string; authorization?: string }> = [];
  const client = createNexusClient({ baseUrl: 'https://example.test/', token: 'owner', fetchImpl: (async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? '', body: init?.body as string | undefined,
      authorization: new Headers(init?.headers).get('authorization') ?? undefined });
    return Response.json(init?.method === 'PUT' ? { set: ['API_KEY'] } : { fields: [{ name: 'API_KEY', env: 'PLUGIN_KEY', set: false }] });
  }) as typeof fetch });
  expect(await client.getPluginCredentials('plugin/name')).toEqual({ fields: [{ name: 'API_KEY', env: 'PLUGIN_KEY', set: false }] });
  expect(await client.putPluginCredentials('plugin/name', { API_KEY: 'secret' })).toEqual({ set: ['API_KEY'] });
  expect(calls).toEqual([
    { url: 'https://example.test/v1/plugins/plugin%2Fname/credentials', method: 'GET', authorization: 'Bearer owner' },
    { url: 'https://example.test/v1/plugins/plugin%2Fname/credentials', method: 'PUT', body: '{"fields":{"API_KEY":"secret"}}', authorization: 'Bearer owner' },
  ]);
});

test('plugin credential client preserves HTTP error status for callers', async () => {
  for (const status of [401, 404, 400]) {
    const client = createNexusClient({ baseUrl: 'https://example.test', fetchImpl: (async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ error: 'refused' }, { status })) as typeof fetch });
    try {
      await client.getPluginCredentials('plugin');
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(NexusApiError);
      expect((error as NexusApiError).status).toBe(status);
    }
  }
});

test('OpenRouter import flow sends only the selected candidate id and receives masked metadata', async () => {
  const calls: Array<{ url: string; method: string; body?: string; authorization?: string }> = [];
  const client = createNexusClient({ baseUrl: 'https://example.test', token: 'owner', fetchImpl: (async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? '', body: init?.body as string | undefined,
      authorization: new Headers(init?.headers).get('authorization') ?? undefined });
    return init?.method === 'POST'
      ? Response.json({ saved: true, verification: 'verified', lastFour: '2345' })
      : Response.json({ candidates: [{ id: 'opaque-candidate', name: 'OPENROUTER_API_KEY', source: 'process environment', lastFour: '2345' }] });
  }) as typeof fetch });
  expect((await client.listOpenRouterImportCandidates()).candidates[0]?.lastFour).toBe('2345');
  expect(await client.importOpenRouterCandidate('opaque-candidate')).toEqual({ saved: true, verification: 'verified', lastFour: '2345' });
  expect(calls).toEqual([
    { url: 'https://example.test/v1/credentials/openrouter/import', method: 'GET', authorization: 'Bearer owner' },
    { url: 'https://example.test/v1/credentials/openrouter/import', method: 'POST', body: '{"id":"opaque-candidate"}', authorization: 'Bearer owner' },
  ]);
});
