import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseServiceKeyEnv, serviceKeyStatus, storeServiceKeys, verifyServiceKey } from './service-keys.js';
import { buildUserConfig } from '../user-config.js';
import { importServiceKeys, renderServiceKeyStatus } from '../cli/setup-keys.js';
import { getProviderForConfig } from '../llm.js';
import { _resetKeyCacheForTests } from '../config.js';

const roots: string[] = [];
function cacheDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'service-key-setup-'));
  roots.push(path);
  return path;
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('service key setup storage boundary', () => {
  test('TimelyRouter setup imports a key only after the configured model endpoint verifies it', async () => {
    const root = cacheDir();
    const config = buildUserConfig(join(root, 'config.json'));
    config.llm = { provider: 'timelyrouter', model: 'timelyrouter/demo-model', baseUrl: 'https://timely.mock.invalid/v1' };
    const env: NodeJS.ProcessEnv = {};
    const key = 'timely-test-key';
    const requests: Array<{ url: string; auth: string | null }> = [];
    const originalFetch = globalThis.fetch;
    const previousCacheDir = process.env.ELANOUS_KEY_CACHE_DIR;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return String(input).endsWith('/models')
        ? new Response('{}', { status: 200 })
        : new Response('data: {"choices":[{"delta":{"content":"setup worked"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    try {
      const result = await importServiceKeys(parseServiceKeyEnv(`TIMELYROUTER_API_KEY=${key}`), { print: () => {} }, { config, env, cacheDir: root });
      expect(result).toEqual({ stored: ['TIMELYROUTER_API_KEY'], rejected: [], unverified: [] });
      expect(JSON.parse(readFileSync(join(root, 'timelyrouter_credential.json'), 'utf8'))).toEqual({
        version: 1, baseUrl: 'https://timely.mock.invalid/v1', apiKey: key,
      });
      process.env.ELANOUS_KEY_CACHE_DIR = root;
      _resetKeyCacheForTests();
      const text: string[] = [];
      for await (const chunk of getProviderForConfig(config).chat([{ role: 'user', content: 'hello' }])) text.push(chunk);
      expect(text).toEqual(['setup worked']);
      config.llm.baseUrl = 'https://other.mock.invalid/v1';
      const changed = getProviderForConfig(config);
      expect(changed.available()).toBe(false);
      await expect(async () => { for await (const _ of changed.chat([{ role: 'user', content: 'hello' }])) { /* consume */ } }).toThrow();
      config.llm.baseUrl = 'https://timely.mock.invalid/v1';
      expect(getProviderForConfig(config).available()).toBe(true);
      expect(requests).toEqual([
        { url: 'https://timely.mock.invalid/v1/models', auth: `Bearer ${key}` },
        { url: 'https://timely.mock.invalid/v1/chat/completions', auth: `Bearer ${key}` },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousCacheDir === undefined) delete process.env.ELANOUS_KEY_CACHE_DIR;
      else process.env.ELANOUS_KEY_CACHE_DIR = previousCacheDir;
      _resetKeyCacheForTests();
    }
  });

  test('imports only catalogued .env names and never returns values in the write result', async () => {
    const root = cacheDir();
    const secret = 'sentinel-value-never-render';
    const parsed = parseServiceKeyEnv(`# optional\nexport XAI_API_KEY="${secret}"\nOPENROUTER_API_KEY=second-value # note`);
    const env: NodeJS.ProcessEnv = {};
    expect(storeServiceKeys(parsed, { cacheDir: root, env })).toEqual({ stored: ['OPENROUTER_API_KEY', 'XAI_API_KEY'] });
    expect(env.XAI_API_KEY).toBe(secret);
    expect(readFileSync(join(root, 'xai_api_key'), 'utf8')).toBe(`${secret}\n`);
    expect(statSync(join(root, 'xai_api_key')).mode & 0o777).toBe(0o600);
    const status = await serviceKeyStatus({ env, cacheDir: root });
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(JSON.stringify({ stored: ['OPENROUTER_API_KEY', 'XAI_API_KEY'] })).not.toContain(secret);
  });

  test('skips unknown names while parsing known entries and rejects duplicate, malformed, and empty known entries', () => {
    const sentinel = 'sentinel-never-echo-this';
    const mixed = parseServiceKeyEnv(`UNLISTED_TOKEN=${sentinel}\nFDS_API_KEY=known-fake-key`);
    expect([...mixed]).toEqual([['FDS_API_KEY', 'known-fake-key']]);
    expect(mixed.skippedNames).toEqual(['UNLISTED_TOKEN']);
    expect(JSON.stringify(mixed.skippedNames)).not.toContain(sentinel);
    expect(() => parseServiceKeyEnv(`XAI_API_KEY=${sentinel}\nXAI_API_KEY=another-secret`)).toThrow('duplicate env name: XAI_API_KEY');
    expect(() => parseServiceKeyEnv(`XAI_API_KEY="${sentinel}`)).toThrow('invalid quoted value for XAI_API_KEY');
    expect(() => parseServiceKeyEnv('XAI_API_KEY=')).toThrow('empty or invalid value for XAI_API_KEY');
  });

  test('status is metadata-only and reports cache presence without returning cached values', async () => {
    const root = cacheDir();
    const sentinel = 'status-must-not-leak-this';
    storeServiceKeys(parseServiceKeyEnv(`EXA_API_KEY=${sentinel}`), { cacheDir: root, env: {} });
    const status = await serviceKeyStatus({ env: {}, cacheDir: root });
    expect(status.find(item => item.id === 'exa')).toMatchObject({ id: 'exa', configured: true, envNames: ['EXA_API_KEY'] });
    expect(JSON.stringify(status)).not.toContain(sentinel);
  });

  test('Linear reports only credential sources with a value and never returns secret contents', async () => {
    const secret = 'linear-secret-never-render';
    const envOnly = await serviceKeyStatus({ env: { LINEAR_API_KEY: 'env-secret' }, cacheDir: cacheDir(), getSecret: async () => undefined });
    expect(envOnly.find(item => item.id === 'linear')).toMatchObject({ configured: true, sources: ['LINEAR_API_KEY'] });

    const secretOnly = await serviceKeyStatus({ env: {}, cacheDir: cacheDir(), getSecret: async id => id === 'connector.linear.apiKey' ? secret : undefined });
    expect(secretOnly.find(item => item.id === 'linear')).toMatchObject({ configured: true, sources: ['connector.linear.apiKey'] });
    expect(JSON.stringify(secretOnly)).not.toContain(secret);

    const noSource = await serviceKeyStatus({ env: {}, cacheDir: cacheDir(), getSecret: async () => undefined });
    expect(noSource.find(item => item.id === 'linear')).toMatchObject({ configured: false, sources: [] });

    const failedLookup = await serviceKeyStatus({ env: {}, cacheDir: cacheDir(), getSecret: async () => { throw new Error('store unavailable'); } });
    expect(failedLookup.find(item => item.id === 'linear')).toMatchObject({ configured: false, sourceCheckFailed: true, sources: [] });
    const failedLines = await renderServiceKeyStatus({ env: {}, cacheDir: cacheDir(), getSecret: async () => { throw new Error('store unavailable'); } });
    expect(failedLines.find(line => line.startsWith('Linear API:'))).toContain('상태 확인 불가');

    const rendered = await renderServiceKeyStatus({
      env: { LINEAR_API_KEY: 'env-secret' }, cacheDir: cacheDir(),
      getSecret: async id => id === 'connector.linear.apiKey' ? secret : undefined,
    });
    const linearLine = rendered.find(line => line.startsWith('Linear API:'));
    expect(linearLine).toContain('LINEAR_API_KEY, connector.linear.apiKey');
    expect(linearLine).not.toContain('env-secret');
    expect(linearLine).not.toContain(secret);
  });

  test('stores catalogued keys without a verifier only with an explicit unverified notice', async () => {
    const root = cacheDir();
    const env: NodeJS.ProcessEnv = {};
    const output: string[] = [];
    const configPath = join(root, 'config.json');
    const result = await importServiceKeys(
      parseServiceKeyEnv('SUPADATA_API_KEY=sentinel-unverified'),
      { print: line => output.push(line) },
      { config: buildUserConfig(configPath), env, cacheDir: root },
    );
    expect(result).toEqual({ stored: ['SUPADATA_API_KEY'], rejected: [], unverified: ['SUPADATA_API_KEY'] });
    expect(env.SUPADATA_API_KEY).toBe('sentinel-unverified');
    expect(output.join('\n')).toContain('검증 없이 저장합니다');
    expect(output.join('\n')).not.toContain('sentinel-unverified');
  });

  test('injects the verifier through the actual import path using catalog service ids', async () => {
    const root = cacheDir();
    const env: NodeJS.ProcessEnv = {};
    const output: string[] = [];
    const calls: Array<{ provider: string; apiKey: string }> = [];
    const secret = 'xai-injected-verifier-secret';
    const result = await importServiceKeys(
      parseServiceKeyEnv(`XAI_API_KEY=${secret}`),
      { print: line => output.push(line) },
      {
        config: buildUserConfig(join(root, 'config.json')),
        env,
        cacheDir: root,
        verifier: async input => {
          calls.push(input);
          return { success: true, verification: 'verified' };
        },
      },
    );
    expect(calls).toEqual([{ provider: 'xai', apiKey: secret }]);
    expect(result).toEqual({ stored: ['XAI_API_KEY'], rejected: [], unverified: [] });
    expect(env.XAI_API_KEY).toBe(secret);
    expect(output.join('\n')).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test('injected external failure is reduced to a secret-free reason and does not store the key', async () => {
    const root = cacheDir();
    const env: NodeJS.ProcessEnv = {};
    const output: string[] = [];
    const secret = 'openrouter-rejected-secret';
    const result = await importServiceKeys(
      parseServiceKeyEnv(`OPENROUTER_API_KEY=${secret}`),
      { print: line => output.push(line) },
      {
        config: buildUserConfig(join(root, 'config.json')),
        env,
        cacheDir: root,
        verifier: async () => ({ success: false, reason: 'invalid', httpStatus: 401 }),
      },
    );
    expect(result).toEqual({ stored: [], rejected: ['OPENROUTER_API_KEY'], unverified: [] });
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(output.join('\n')).toContain('검증 invalid (HTTP 401)');
    expect(output.join('\n')).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test('Gemini key is sent in the authentication header, never in the request URL', async () => {
    const secret = 'gemini-key-sentinel';
    let requestedUrl = '';
    let requestHeaders: HeadersInit | undefined;
    const result = await verifyServiceKey('gemini-api', secret, {
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
        requestedUrl = String(input);
        requestHeaders = init?.headers;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ result: 'verified', httpStatus: 200 });
    expect(requestedUrl).not.toContain(secret);
    expect(requestedUrl).not.toContain('?key=');
    expect(new Headers(requestHeaders).get('x-goog-api-key')).toBe(secret);
  });

  test('TimelyRouter verifies only the configured HTTPS model endpoint without following redirects', async () => {
    const key = 'timely-test-key';
    const requests: Array<{ url: string; auth: string | null; redirect: RequestRedirect | undefined }> = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      requests.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await verifyServiceKey('timelyrouter', key, { fetchImpl })).toEqual({ result: 'unavailable' });
    expect(await verifyServiceKey('timelyrouter', key, { baseUrl: 'http://other.example/v1', fetchImpl })).toEqual({ result: 'unavailable' });
    expect(requests).toEqual([]);
    expect(await verifyServiceKey('timelyrouter', key, { baseUrl: 'https://timely.mock.invalid/v1', fetchImpl })).toEqual({ result: 'verified', httpStatus: 200 });
    expect(requests).toEqual([{ url: 'https://timely.mock.invalid/v1/models', auth: `Bearer ${key}`, redirect: 'manual' }]);
  });
});
