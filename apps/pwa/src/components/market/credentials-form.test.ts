import { expect, test } from 'bun:test';
import { createNexusClient, NexusApiError } from '../../nexus/client';
import { credentialFields, credentialsPutBody } from './credentials-form';

test('status maps only names, environment names and saved flags, never values', () => {
  const status = { fields: [{ name: 'API_KEY', env: 'PLUGIN_API_KEY', set: true }, { name: 'TOKEN', env: 'PLUGIN_TOKEN', set: false }] };
  expect(credentialFields(status)).toEqual(status.fields);
  expect(credentialFields({ fields: [] })).toEqual([]);
});

test('blank entries are omitted, values are preserved and explicit removal uses null', () => {
  expect(credentialsPutBody({ API_KEY: '  secret  ', TOKEN: '   ', UNUSED: '' }, ['OLD']))
    .toEqual({ fields: { API_KEY: '  secret  ', OLD: null } });
  expect(credentialsPutBody({ API_KEY: 'new' }, ['API_KEY'])).toEqual({ fields: { API_KEY: null } });
  expect(credentialsPutBody({ EMPTY: '' })).toEqual({ fields: {} });
});

test('client GET and PUT use encoded plugin path and contract body without echoing credentials', async () => {
  const calls: Array<{ url: string; method: string; body?: string; authorization?: string }> = [];
  const client = createNexusClient({ baseUrl: 'https://example.test/', token: 'owner', fetchImpl: (async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? '', body: init?.body as string | undefined,
      authorization: new Headers(init?.headers).get('authorization') ?? undefined });
    return Response.json(init?.method === 'PUT' ? { set: ['API_KEY'] } : { fields: [{ name: 'API_KEY', env: 'PLUGIN_KEY', set: false }] });
  }) as typeof fetch });
  expect(await client.getPluginCredentials('plugin/name')).toEqual({ fields: [{ name: 'API_KEY', env: 'PLUGIN_KEY', set: false }] });
  expect(await client.putPluginCredentials('plugin/name', credentialsPutBody({ API_KEY: 'secret', SKIP: '' }).fields)).toEqual({ set: ['API_KEY'] });
  expect(calls).toEqual([
    { url: 'https://example.test/v1/plugins/plugin%2Fname/credentials', method: 'GET', authorization: 'Bearer owner' },
    { url: 'https://example.test/v1/plugins/plugin%2Fname/credentials', method: 'PUT', body: '{"fields":{"API_KEY":"secret"}}', authorization: 'Bearer owner' },
  ]);
});

test('client preserves HTTP errors so the form can distinguish 401, 404 and 400', async () => {
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
