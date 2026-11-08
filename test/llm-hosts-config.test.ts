// FU.A3 (2026-05-09 night) — Multi-host config hot-reload coverage.
//
// Tests the GET/PUT/DELETE `/v1/llm/hosts` endpoint + the
// in-memory override store + the priority chain (override > env >
// legacy) used by `/v1/llm/models`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  handleLlmHostsConfig,
} from '../src/nexus/api/llm-hosts-config.js';
import {
  getEffectiveHosts,
  getHostsOverride,
  setHostsOverride,
  type LlmHostConfig,
} from '../src/nexus/api/llm-hosts.js';
import { handleLlmModels } from '../src/nexus/api/llm-models.js';
import { expectMalformedJson400 } from './helpers/http-error-contract';
import { createFakeFetchDevice, type FakeFetchDevice } from '../src/ux-sim/fake-fetch.js';

type FetchFn = typeof globalThis.fetch;
let fakeFetch: FakeFetchDevice | undefined;

function installFetch(stub: FetchFn, urls: readonly string[]): void {
  fakeFetch?.restore();
  const respond = (request: { url: string; method: string; headers: Readonly<Record<string, string>>; body: string | null }) =>
    stub(request.url, {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body !== null ? { body: request.body } : {}),
    });
  fakeFetch = createFakeFetchDevice(urls.map((url) => ({ url, method: 'GET', response: respond })));
}

function expectFetchCalls(urls: readonly string[]): void {
  const actual = (fakeFetch?.calls() ?? []).map(({ method, url }) => `${method} ${url}`).sort();
  expect(actual).toEqual(urls.map((url) => `GET ${url}`).sort());
}
beforeEach(() => {
  // Reset state to clean baseline before each test (override + envs).
  setHostsOverride(null);
});
afterEach(() => {
  fakeFetch?.restore();
  fakeFetch = undefined;
  delete process.env.ELANOUS_LLM_MODELS_ENDPOINT;
  delete process.env.ELANOUS_LLM_HOSTS;
  delete process.env.ANTHROPIC_API_KEY;
  setHostsOverride(null);
});

describe('Override store · setHostsOverride / getHostsOverride', () => {
  test('initial → null', () => {
    expect(getHostsOverride()).toBe(null);
  });
  test('set + get → snapshot returned (mutation isolated)', () => {
    const hosts: LlmHostConfig[] = [
      { name: 'a', kind: 'lm-studio', endpoint: 'http://a' },
    ];
    expect(setHostsOverride(hosts)).toBe(1);
    const snap = getHostsOverride();
    expect(snap).toEqual(hosts);
    // Mutating the returned snapshot must not affect the store.
    snap!.push({ name: 'b', kind: 'lm-studio', endpoint: 'http://b' });
    expect(getHostsOverride()).toEqual(hosts);
  });
  test('clear via null → store reverts', () => {
    setHostsOverride([{ name: 'a', kind: 'lm-studio', endpoint: 'http://a' }]);
    expect(setHostsOverride(null)).toBe(0);
    expect(getHostsOverride()).toBe(null);
  });
});

describe('getEffectiveHosts · priority chain (override > env > legacy)', () => {
  test('no override / no env → legacy single-host', () => {
    const eff = getEffectiveHosts();
    expect(eff.source).toBe('legacy');
    expect(eff.hosts).toEqual([
      { name: 'local', kind: 'lm-studio', endpoint: 'http://localhost:1234' },
    ]);
  });
  test('env set → source=env', () => {
    process.env.ELANOUS_LLM_HOSTS = JSON.stringify([
      { name: 'env-host', kind: 'ollama', endpoint: 'http://localhost:11434' },
    ]);
    const eff = getEffectiveHosts();
    expect(eff.source).toBe('env');
    expect(eff.hosts[0]?.name).toBe('env-host');
  });
  test('override wins over env', () => {
    process.env.ELANOUS_LLM_HOSTS = JSON.stringify([
      { name: 'env', kind: 'lm-studio', endpoint: 'http://env' },
    ]);
    setHostsOverride([
      { name: 'override', kind: 'vllm', endpoint: 'http://override' },
    ]);
    const eff = getEffectiveHosts();
    expect(eff.source).toBe('override');
    expect(eff.hosts[0]?.name).toBe('override');
  });
  test('parseError surfaces when env malformed (no override)', () => {
    process.env.ELANOUS_LLM_HOSTS = '{not json';
    const eff = getEffectiveHosts();
    expect(eff.source).toBe('env');
    expect(eff.parseError).toMatch(/JSON parse failed/);
  });
});

describe('handleLlmHostsConfig · auth + method', () => {
  test('OPTIONS → 204 + CORS preflight', async () => {
    const res = await handleLlmHostsConfig(new Request('http://x/v1/llm/hosts', { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
  });
  test('checkAuth=false → 401', async () => {
    const res = await handleLlmHostsConfig(
      new Request('http://x/v1/llm/hosts'),
      { checkAuth: () => false },
    );
    expect(res.status).toBe(401);
  });
  test('POST → 405', async () => {
    const res = await handleLlmHostsConfig(
      new Request('http://x/v1/llm/hosts', { method: 'POST', body: '[]' }),
    );
    expect(res.status).toBe(405);
  });
});

describe('handleLlmHostsConfig · GET', () => {
  test('legacy default → source=legacy + 1 host (apiKey absent)', async () => {
    const res = await handleLlmHostsConfig(new Request('http://x/v1/llm/hosts'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean; source: string; count: number;
      hosts: Array<{ name: string; kind: string; endpoint: string; apiKey?: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.source).toBe('legacy');
    expect(body.count).toBe(1);
    expect(body.hosts[0]?.name).toBe('local');
    expect(body.hosts[0]).not.toHaveProperty('apiKey');
  });
  test('apiKey is redacted in response (never echoes value)', async () => {
    setHostsOverride([{
      name: 'cloud',
      kind: 'anthropic-openai-wrap',
      endpoint: 'https://api.anthropic.com',
      apiKey: 'sk-ant-secret-do-not-leak',
    }]);
    const res = await handleLlmHostsConfig(new Request('http://x/v1/llm/hosts'));
    const body = (await res.json()) as { hosts: Array<{ apiKey?: string }> };
    expect(body.hosts[0]?.apiKey).toBe('[redacted]');
    // Full body string must not contain the secret either.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('sk-ant-secret');
  });
  test('source=env when ELANOUS_LLM_HOSTS set', async () => {
    process.env.ELANOUS_LLM_HOSTS = JSON.stringify([
      { name: 'env', kind: 'lm-studio', endpoint: 'http://env' },
    ]);
    const res = await handleLlmHostsConfig(new Request('http://x/v1/llm/hosts'));
    const body = (await res.json()) as { source: string };
    expect(body.source).toBe('env');
  });
  test('parseError flows through to GET response', async () => {
    process.env.ELANOUS_LLM_HOSTS = '{not json';
    const res = await handleLlmHostsConfig(new Request('http://x/v1/llm/hosts'));
    const body = (await res.json()) as { parseError?: string };
    expect(body.parseError).toMatch(/JSON parse failed/);
  });
});

describe('handleLlmHostsConfig · PUT', () => {
  test('valid body → override set + 200', async () => {
    const newHosts = [
      { name: 'a', kind: 'lm-studio', endpoint: 'http://a' },
      { name: 'b', kind: 'ollama', endpoint: 'http://b' },
    ];
    const res = await handleLlmHostsConfig(
      new Request('http://x/v1/llm/hosts', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(newHosts),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; source: string; count: number };
    expect(body.ok).toBe(true);
    expect(body.source).toBe('override');
    expect(body.count).toBe(2);
    // Verify the store actually got mutated.
    expect(getHostsOverride()).toEqual([
      { name: 'a', kind: 'lm-studio', endpoint: 'http://a' },
      { name: 'b', kind: 'ollama', endpoint: 'http://b' },
    ]);
  });
  test('invalid JSON body → 400', async () => {
    const res = await handleLlmHostsConfig(
      new Request('http://x/v1/llm/hosts', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );
    await expectMalformedJson400(res, 'invalid-json');
  });
  test('non-array body → 400', async () => {
    const res = await handleLlmHostsConfig(
      new Request('http://x/v1/llm/hosts', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'oops' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid-body');
  });
  test('empty array → 400 no-valid-hosts (avoid silent default)', async () => {
    const res = await handleLlmHostsConfig(
      new Request('http://x/v1/llm/hosts', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([]),
      }),
    );
    // Empty array → parseError + parsed.hosts is the legacy default
    // → matches the "no valid hosts" guard.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('no-valid-hosts');
  });
  test('apiKey in PUT body persists in store but is redacted in response', async () => {
    const res = await handleLlmHostsConfig(
      new Request('http://x/v1/llm/hosts', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{
          name: 'cloud',
          kind: 'anthropic',
          endpoint: 'https://api.anthropic.com',
          apiKey: 'sk-ant-real',
        }]),
      }),
    );
    const body = (await res.json()) as {
      hosts: Array<{ apiKey?: string }>;
    };
    expect(body.hosts[0]?.apiKey).toBe('[redacted]');
    // Store keeps the real key for the dispatcher.
    expect(getHostsOverride()![0]?.apiKey).toBe('sk-ant-real');
  });
  test('PUT auth failure → 401 + override unchanged', async () => {
    setHostsOverride([{ name: 'pre', kind: 'lm-studio', endpoint: 'http://pre' }]);
    const res = await handleLlmHostsConfig(
      new Request('http://x/v1/llm/hosts', {
        method: 'PUT',
        body: JSON.stringify([{ name: 'new', kind: 'vllm', endpoint: 'http://new' }]),
      }),
      { checkAuth: () => false },
    );
    expect(res.status).toBe(401);
    expect(getHostsOverride()![0]?.name).toBe('pre');
  });
});

describe('handleLlmHostsConfig · DELETE', () => {
  test('clear override → revert to env / legacy', async () => {
    setHostsOverride([{ name: 'temp', kind: 'lm-studio', endpoint: 'http://temp' }]);
    const res = await handleLlmHostsConfig(
      new Request('http://x/v1/llm/hosts', { method: 'DELETE' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; cleared: boolean; source: string };
    expect(body.cleared).toBe(true);
    expect(body.source).toBe('legacy'); // no env set
    expect(getHostsOverride()).toBe(null);
  });
  test('clear when env present → reverts to env (not legacy)', async () => {
    process.env.ELANOUS_LLM_HOSTS = JSON.stringify([
      { name: 'env', kind: 'lm-studio', endpoint: 'http://env' },
    ]);
    setHostsOverride([{ name: 'temp', kind: 'lm-studio', endpoint: 'http://temp' }]);
    const res = await handleLlmHostsConfig(
      new Request('http://x/v1/llm/hosts', { method: 'DELETE' }),
    );
    const body = (await res.json()) as { source: string; hosts: Array<{ name: string }> };
    expect(body.source).toBe('env');
    expect(body.hosts[0]?.name).toBe('env');
  });
  test('DELETE auth failure → 401 + override unchanged', async () => {
    setHostsOverride([{ name: 'pre', kind: 'lm-studio', endpoint: 'http://pre' }]);
    const res = await handleLlmHostsConfig(
      new Request('http://x/v1/llm/hosts', { method: 'DELETE' }),
      { checkAuth: () => false },
    );
    expect(res.status).toBe(401);
    expect(getHostsOverride()![0]?.name).toBe('pre');
  });
});

describe('Integration · /v1/llm/models honours override', () => {
  test('override → models endpoint uses override hosts', async () => {
    setHostsOverride([{
      name: 'override-host',
      kind: 'lm-studio',
      endpoint: 'http://override-host',
    }]);
    const stub = ((input: unknown) => {
      const url = String(input);
      if (url === 'http://override-host/v1/models') {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: 'override-model' }],
        }), { status: 200 }));
      }
      return Promise.reject(new Error(`unstubbed: ${url}`));
    }) as unknown as FetchFn;
    installFetch(stub, ['http://override-host/v1/models']);

    const res = await handleLlmModels(new Request('http://x/v1/llm/models'));
    const body = (await res.json()) as {
      hosts: Array<{ name: string }>;
      models: Array<{ id: string; host: string }>;
    };
    expect(body.hosts[0]?.name).toBe('override-host');
    expect(body.models[0]?.id).toBe('override-model');
    expectFetchCalls(['http://override-host/v1/models']);
  });

  test('override > env → env hosts ignored while override active', async () => {
    process.env.ELANOUS_LLM_HOSTS = JSON.stringify([
      { name: 'env-host', kind: 'lm-studio', endpoint: 'http://env-host' },
    ]);
    setHostsOverride([{
      name: 'override-host',
      kind: 'lm-studio',
      endpoint: 'http://override-host',
    }]);
    const stub = ((input: unknown) => {
      const url = String(input);
      if (url === 'http://override-host/v1/models') {
        return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      }
      // env-host should NOT be hit
      if (url === 'http://env-host/v1/models') {
        return Promise.reject(new Error('env-host should not be called'));
      }
      return Promise.reject(new Error(`unstubbed: ${url}`));
    }) as unknown as FetchFn;
    installFetch(stub, ['http://override-host/v1/models']);

    const res = await handleLlmModels(new Request('http://x/v1/llm/models'));
    const body = (await res.json()) as { hosts: Array<{ name: string }> };
    expect(body.hosts[0]?.name).toBe('override-host');
    expectFetchCalls(['http://override-host/v1/models']);
  });

  test('clear override → /v1/llm/models reverts to env', async () => {
    process.env.ELANOUS_LLM_HOSTS = JSON.stringify([
      { name: 'env-host', kind: 'lm-studio', endpoint: 'http://env-host' },
    ]);
    setHostsOverride([{ name: 'temp', kind: 'lm-studio', endpoint: 'http://temp' }]);
    setHostsOverride(null); // clear
    const stub = ((input: unknown) => {
      const url = String(input);
      if (url === 'http://env-host/v1/models') {
        return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      }
      return Promise.reject(new Error(`unstubbed: ${url}`));
    }) as unknown as FetchFn;
    installFetch(stub, ['http://env-host/v1/models']);

    const res = await handleLlmModels(new Request('http://x/v1/llm/models'));
    const body = (await res.json()) as { hosts: Array<{ name: string }> };
    expect(body.hosts[0]?.name).toBe('env-host');
    expectFetchCalls(['http://env-host/v1/models']);
  });
});
