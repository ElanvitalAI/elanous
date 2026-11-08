// micro.3 (2026-05-09) — LLM model list proxy coverage.
// FU.A1 (2026-05-09 night) — multi-host fan-out coverage.
// FU.A2 (2026-05-09 night) — Anthropic kind + key handling coverage.
//
// Tests the daemon endpoint that proxies LM Studio /v1/models +
// vLLM /v1/models + Ollama /api/tags + Anthropic /v1/models for the
// PWA Showroom dropdown. Live upstreams are mocked via fetch stub.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  handleLlmModels,
  resolveLlmModelsEndpoint,
} from '../src/nexus/api/llm-models.js';
import {
  defaultHosts,
  parseLlmHostsEnv,
} from '../src/nexus/api/llm-hosts.js';
import { createFakeFetchDevice, type FakeFetchDevice } from '../src/ux-sim/fake-fetch.js';

type FetchFn = typeof globalThis.fetch;
let fakeFetch: FakeFetchDevice | undefined;

function installFetch(stub: FetchFn, urls: readonly string[]): void {
  fakeFetch?.restore();
  const respond = (request: { url: string; method: string; headers: Readonly<Record<string, string>>; body: string | null; signal: AbortSignal | null }) =>
    stub(request.url, {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body !== null ? { body: request.body } : {}),
      signal: request.signal,
    });
  fakeFetch = createFakeFetchDevice([...new Set(urls)].map((url) => ({ url, method: 'GET', response: respond })));
}

function expectFetchCalls(urls: readonly string[]): void {
  const actual = (fakeFetch?.calls() ?? []).map(({ method, url }) => `${method} ${url}`).sort();
  expect(actual).toEqual(urls.map((url) => `GET ${url}`).sort());
}
afterEach(() => {
  fakeFetch?.restore();
  fakeFetch = undefined;
  delete process.env.ELANOUS_LLM_MODELS_ENDPOINT;
  delete process.env.ELANOUS_LLM_HOSTS;
  delete process.env.ANTHROPIC_API_KEY;
});

describe('resolveLlmModelsEndpoint (legacy single-host)', () => {
  test('default = http://localhost:1234/v1', () => {
    expect(resolveLlmModelsEndpoint({})).toBe('http://localhost:1234/v1');
  });
  test('opts override > default', () => {
    expect(resolveLlmModelsEndpoint({ endpoint: 'http://192.168.0.10:1234/v1' }))
      .toBe('http://192.168.0.10:1234/v1');
  });
  test('env override > opts', () => {
    process.env.ELANOUS_LLM_MODELS_ENDPOINT = 'http://lan-host:1234/v1/';
    expect(resolveLlmModelsEndpoint({ endpoint: 'http://other:1234/v1' }))
      .toBe('http://lan-host:1234/v1');
  });
  test('trailing slash is normalised', () => {
    expect(resolveLlmModelsEndpoint({ endpoint: 'http://x/v1////' }))
      .toBe('http://x/v1');
  });
});

describe('parseLlmHostsEnv', () => {
  test('undefined / empty → default single-host', () => {
    expect(parseLlmHostsEnv(undefined)).toEqual({ hosts: defaultHosts() });
    expect(parseLlmHostsEnv('')).toEqual({ hosts: defaultHosts() });
    expect(parseLlmHostsEnv('   ')).toEqual({ hosts: defaultHosts() });
  });
  test('valid array → parsed hosts (trailing /v1 stripped)', () => {
    const raw = JSON.stringify([
      { name: 'local', kind: 'lm-studio', endpoint: 'http://localhost:1234' },
      { name: 'lan', kind: 'vllm', endpoint: 'http://192.168.0.10:8000/v1/' },
      { name: 'ollama', kind: 'ollama', endpoint: 'http://localhost:11434/' },
    ]);
    const out = parseLlmHostsEnv(raw);
    expect(out.parseError).toBeUndefined();
    expect(out.hosts).toEqual([
      { name: 'local', kind: 'lm-studio', endpoint: 'http://localhost:1234' },
      { name: 'lan', kind: 'vllm', endpoint: 'http://192.168.0.10:8000' },
      { name: 'ollama', kind: 'ollama', endpoint: 'http://localhost:11434' },
    ]);
  });
  test('malformed JSON → fallback + parseError', () => {
    const out = parseLlmHostsEnv('{not json');
    expect(out.parseError).toMatch(/JSON parse failed/);
    expect(out.hosts).toEqual(defaultHosts());
  });
  test('non-array → fallback + parseError', () => {
    const out = parseLlmHostsEnv('{"name":"x"}');
    expect(out.parseError).toMatch(/must be a JSON array/);
    expect(out.hosts).toEqual(defaultHosts());
  });
  test('unknown kind → entry skipped + partial parseError', () => {
    const raw = JSON.stringify([
      { name: 'a', kind: 'lm-studio', endpoint: 'http://a' },
      { name: 'b', kind: 'mystery', endpoint: 'http://b' },
    ]);
    const out = parseLlmHostsEnv(raw);
    expect(out.parseError).toMatch(/unknown kind/);
    expect(out.hosts.map((h) => h.name)).toEqual(['a']);
  });
  test('all entries invalid → fallback + parseError', () => {
    const raw = JSON.stringify([
      { name: '', kind: 'lm-studio', endpoint: 'http://a' },
      { kind: 'lm-studio', endpoint: 'http://b' },
    ]);
    const out = parseLlmHostsEnv(raw);
    expect(out.parseError).toMatch(/no valid hosts/);
    expect(out.hosts).toEqual(defaultHosts());
  });
  test('anthropic kind → accepted (FU.A2)', () => {
    const raw = JSON.stringify([
      { name: 'cloud', kind: 'anthropic-openai-wrap', endpoint: 'https://api.anthropic.com' },
    ]);
    const out = parseLlmHostsEnv(raw);
    expect(out.parseError).toBeUndefined();
    expect(out.hosts).toEqual([
      { name: 'cloud', kind: 'anthropic-openai-wrap', endpoint: 'https://api.anthropic.com' },
    ]);
  });
  test('anthropic with apiKey → key preserved on config (FU.A2)', () => {
    const raw = JSON.stringify([
      {
        name: 'cloud',
        kind: 'anthropic-openai-wrap',
        endpoint: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test-123',
      },
    ]);
    const out = parseLlmHostsEnv(raw);
    expect(out.hosts[0]).toEqual({
      name: 'cloud',
      kind: 'anthropic-openai-wrap',
      endpoint: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test-123',
    });
  });
  test('empty apiKey string → omitted from config (no leaking empty string)', () => {
    const raw = JSON.stringify([
      { name: 'cloud', kind: 'anthropic-openai-wrap', endpoint: 'https://api.anthropic.com', apiKey: '' },
    ]);
    const out = parseLlmHostsEnv(raw);
    expect(out.hosts[0]).not.toHaveProperty('apiKey');
  });
});

describe('handleLlmModels · auth + method', () => {
  test('OPTIONS → 204 + CORS preflight headers', async () => {
    const res = await handleLlmModels(new Request('http://x/v1/llm/models', { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });
  test('POST → 405', async () => {
    const res = await handleLlmModels(new Request('http://x/v1/llm/models', { method: 'POST' }));
    expect(res.status).toBe(405);
  });
  test('checkAuth=false → 401', async () => {
    const res = await handleLlmModels(
      new Request('http://x/v1/llm/models'),
      { checkAuth: () => false },
    );
    expect(res.status).toBe(401);
  });
});

describe('handleLlmModels · single-host (legacy default)', () => {
  test('happy path → models sorted, embeddings last, ids forwarded', async () => {
    const stub = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'qwen3.5-9b-mlx', object: 'model', owned_by: 'organization_owner' },
            { id: 'text-embedding-nomic-embed-text-v1.5', object: 'model', owned_by: 'organization_owner' },
            { id: 'gemma-4-26b-a4b-it', object: 'model', owned_by: 'organization_owner' },
            { id: 'google/gemma-4-e4b', object: 'model' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as FetchFn;
    installFetch(stub, ['http://localhost:1234/v1/models']);
    const res = await handleLlmModels(new Request('http://x/v1/llm/models'));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const json = (await res.json()) as {
      ok: boolean; count: number;
      models: Array<{ id: string; ownedBy?: string; host: string; hostKind: string }>;
      endpoint: string;
      hosts: Array<{ name: string; kind: string; endpoint: string; count: number }>;
    };
    expect(json.ok).toBe(true);
    expect(json.count).toBe(4);
    expect(json.models.map((m) => m.id)).toEqual([
      'gemma-4-26b-a4b-it',
      'google/gemma-4-e4b',
      'qwen3.5-9b-mlx',
      'text-embedding-nomic-embed-text-v1.5',
    ]);
    // Every model carries host annotations now.
    expect(new Set(json.models.map((m) => m.host))).toEqual(new Set(['local']));
    expect(new Set(json.models.map((m) => m.hostKind))).toEqual(new Set(['lm-studio']));
    expect(json.endpoint).toBe('http://localhost:1234/v1');
    expect(json.hosts).toEqual([
      { name: 'local', kind: 'lm-studio', endpoint: 'http://localhost:1234', count: 4 },
    ]);
    expectFetchCalls(['http://localhost:1234/v1/models']);
  });

  test('upstream non-2xx → ok=false + per-host error (PWA surfaces in UI)', async () => {
    const stub = (async () =>
      new Response('lm studio not reachable', { status: 503 })) as unknown as FetchFn;
    installFetch(stub, ['http://localhost:1234/v1/models']);
    const res = await handleLlmModels(new Request('http://x/v1/llm/models'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      error?: string;
      models: unknown[];
      hosts: Array<{ error?: string; count: number }>;
    };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/upstream-http-503/);
    expect(json.hosts[0]?.error).toMatch(/upstream-http-503/);
    expect(json.hosts[0]?.count).toBe(0);
    expect(json.models).toEqual([]);
    expectFetchCalls(['http://localhost:1234/v1/models']);
  });

  test('network error → ok=false + upstream-network', async () => {
    const stub = (async () => { throw new Error('econnrefused'); }) as unknown as FetchFn;
    installFetch(stub, ['http://localhost:1234/v1/models']);
    const res = await handleLlmModels(new Request('http://x/v1/llm/models'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; error?: string; models: unknown[] };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/upstream-network/);
    expect(json.models).toEqual([]);
    expectFetchCalls(['http://localhost:1234/v1/models']);
  });

  test('AbortError → upstream-timeout when the request signal aborts', async () => {
    let observedSignal: AbortSignal | null | undefined;
    const stub = (async (_input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init?.signal;
      const abort = () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (!init?.signal) {
        reject(new Error('request signal was not provided'));
        return;
      }
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
    })) as unknown as FetchFn;
    installFetch(stub, ['http://localhost:1234/v1/models']);
    const res = await handleLlmModels(
      new Request('http://x/v1/llm/models'),
      { timeoutMs: 10 },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe('upstream-timeout');
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
    expectFetchCalls(['http://localhost:1234/v1/models']);
  });

  test('malformed upstream JSON → empty list, ok=true (no crash)', async () => {
    const stub = (async () =>
      new Response('not json', { status: 200 })) as unknown as FetchFn;
    installFetch(stub, ['http://localhost:1234/v1/models']);
    const res = await handleLlmModels(new Request('http://x/v1/llm/models'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; count: number; models: unknown[] };
    expect(json.ok).toBe(true);
    expect(json.count).toBe(0);
    expect(json.models).toEqual([]);
    expectFetchCalls(['http://localhost:1234/v1/models']);
  });
});

describe('handleLlmModels · multi-host fan-out', () => {
  test('lm-studio + vllm + ollama in parallel → merged + grouped', async () => {
    const stub = ((input: unknown) => {
      const url = String(input);
      // LM Studio · OpenAI compat
      if (url === 'http://lm/v1/models') {
        return Promise.resolve(new Response(JSON.stringify({
          data: [
            { id: 'gemma-4-26b-a4b-it', owned_by: 'organization_owner' },
            { id: 'qwen3.5-9b-mlx' },
          ],
        }), { status: 200 }));
      }
      // vLLM · OpenAI compat
      if (url === 'http://vllm/v1/models') {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: 'meta-llama/Llama-3.1-70B-Instruct' }],
        }), { status: 200 }));
      }
      // Ollama · /api/tags
      if (url === 'http://oll/api/tags') {
        return Promise.resolve(new Response(JSON.stringify({
          models: [
            { name: 'llama3.2:latest', model: 'llama3.2:latest' },
            { name: 'mistral:7b' },
          ],
        }), { status: 200 }));
      }
      return Promise.reject(new Error(`unstubbed: ${url}`));
    }) as unknown as FetchFn;
    installFetch(stub, ['http://lm/v1/models', 'http://vllm/v1/models', 'http://oll/api/tags']);

    const res = await handleLlmModels(new Request('http://x/v1/llm/models'), {
      hosts: [
        { name: 'lm', kind: 'lm-studio', endpoint: 'http://lm' },
        { name: 'vllm', kind: 'vllm', endpoint: 'http://vllm' },
        { name: 'oll', kind: 'ollama', endpoint: 'http://oll' },
      ],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean; count: number;
      models: Array<{ id: string; host: string; hostKind: string }>;
      hosts: Array<{ name: string; kind: string; endpoint: string; count: number; error?: string }>;
    };
    expect(json.ok).toBe(true);
    expect(json.count).toBe(5);
    // Sorted alphabetically across all hosts.
    expect(json.models.map((m) => m.id)).toEqual([
      'gemma-4-26b-a4b-it',
      'llama3.2:latest',
      'meta-llama/Llama-3.1-70B-Instruct',
      'mistral:7b',
      'qwen3.5-9b-mlx',
    ]);
    // Host annotations preserved per model.
    const byId = new Map(json.models.map((m) => [m.id, m]));
    expect(byId.get('gemma-4-26b-a4b-it')?.host).toBe('lm');
    expect(byId.get('gemma-4-26b-a4b-it')?.hostKind).toBe('lm-studio');
    expect(byId.get('llama3.2:latest')?.host).toBe('oll');
    expect(byId.get('llama3.2:latest')?.hostKind).toBe('ollama');
    expect(byId.get('meta-llama/Llama-3.1-70B-Instruct')?.hostKind).toBe('vllm');
    // hosts[] mirrors the per-host shape.
    expect(json.hosts).toEqual([
      { name: 'lm', kind: 'lm-studio', endpoint: 'http://lm', count: 2 },
      { name: 'vllm', kind: 'vllm', endpoint: 'http://vllm', count: 1 },
      { name: 'oll', kind: 'ollama', endpoint: 'http://oll', count: 2 },
    ]);
    expectFetchCalls(['http://lm/v1/models', 'http://vllm/v1/models', 'http://oll/api/tags']);
  });

  test('partial failure → ok=true (some hosts succeeded), failed host has per-host error', async () => {
    const stub = ((input: unknown) => {
      const url = String(input);
      if (url === 'http://ok/v1/models') {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: 'good-model' }],
        }), { status: 200 }));
      }
      // Reject the other host with a network error.
      return Promise.reject(new Error('econnrefused'));
    }) as unknown as FetchFn;
    installFetch(stub, ['http://ok/v1/models', 'http://bad/v1/models']);

    const res = await handleLlmModels(new Request('http://x/v1/llm/models'), {
      hosts: [
        { name: 'ok', kind: 'lm-studio', endpoint: 'http://ok' },
        { name: 'bad', kind: 'lm-studio', endpoint: 'http://bad' },
      ],
    });
    const json = (await res.json()) as {
      ok: boolean; error?: string; count: number;
      models: Array<{ id: string; host: string }>;
      hosts: Array<{ name: string; count: number; error?: string }>;
    };
    expect(json.ok).toBe(true); // some host succeeded
    expect(json.error).toBeUndefined();
    expect(json.count).toBe(1);
    expect(json.models[0]?.id).toBe('good-model');
    expect(json.hosts.find((h) => h.name === 'ok')?.error).toBeUndefined();
    expect(json.hosts.find((h) => h.name === 'bad')?.error).toMatch(/upstream-network/);
    expectFetchCalls(['http://ok/v1/models', 'http://bad/v1/models']);
  });

  test('all hosts fail → ok=false + top-level error', async () => {
    const stub = (async () => { throw new Error('econnrefused'); }) as unknown as FetchFn;
    installFetch(stub, ['http://a/v1/models', 'http://b/api/tags']);

    const res = await handleLlmModels(new Request('http://x/v1/llm/models'), {
      hosts: [
        { name: 'a', kind: 'lm-studio', endpoint: 'http://a' },
        { name: 'b', kind: 'ollama', endpoint: 'http://b' },
      ],
    });
    const json = (await res.json()) as { ok: boolean; error?: string; hosts: unknown[] };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/upstream-network/);
    expect(json.hosts).toHaveLength(2);
    expectFetchCalls(['http://a/v1/models', 'http://b/api/tags']);
  });

  test('ollama without name field → falls back to model field', async () => {
    const stub = (async () =>
      new Response(JSON.stringify({
        models: [
          { model: 'llama3.2:latest' }, // no `name` field, only `model`
          { name: '' }, // both empty → skipped
          { name: 'mistral:7b' },
        ],
      }), { status: 200 })) as unknown as FetchFn;
    installFetch(stub, ['http://oll/api/tags']);

    const res = await handleLlmModels(new Request('http://x/v1/llm/models'), {
      hosts: [{ name: 'oll', kind: 'ollama', endpoint: 'http://oll' }],
    });
    const json = (await res.json()) as {
      models: Array<{ id: string }>;
      count: number;
    };
    expect(json.count).toBe(2);
    expect(json.models.map((m) => m.id).sort()).toEqual([
      'llama3.2:latest',
      'mistral:7b',
    ]);
    expectFetchCalls(['http://oll/api/tags']);
  });

  test('ELANOUS_LLM_HOSTS env → drives host config', async () => {
    process.env.ELANOUS_LLM_HOSTS = JSON.stringify([
      { name: 'env-host', kind: 'lm-studio', endpoint: 'http://envhost' },
    ]);
    const stub = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'env-model' }] }), { status: 200 })) as unknown as FetchFn;
    installFetch(stub, ['http://envhost/v1/models']);

    const res = await handleLlmModels(new Request('http://x/v1/llm/models'));
    const json = (await res.json()) as {
      hosts: Array<{ name: string; endpoint: string }>;
      models: Array<{ id: string; host: string }>;
    };
    expect(json.hosts[0]?.name).toBe('env-host');
    expect(json.hosts[0]?.endpoint).toBe('http://envhost');
    expect(json.models[0]?.host).toBe('env-host');
    expectFetchCalls(['http://envhost/v1/models']);
  });

  test('malformed ELANOUS_LLM_HOSTS → fallback + configWarning', async () => {
    process.env.ELANOUS_LLM_HOSTS = '{not json';
    const stub = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'fallback-model' }] }), { status: 200 })) as unknown as FetchFn;
    installFetch(stub, ['http://localhost:1234/v1/models']);

    const res = await handleLlmModels(new Request('http://x/v1/llm/models'));
    const json = (await res.json()) as {
      ok: boolean;
      configWarning?: string;
      hosts: Array<{ name: string }>;
    };
    expect(json.ok).toBe(true);
    expect(json.configWarning).toMatch(/JSON parse failed/);
    expect(json.hosts[0]?.name).toBe('local'); // default host
    expectFetchCalls(['http://localhost:1234/v1/models']);
  });
});

describe('handleLlmModels · anthropic kind (FU.A2)', () => {
  test('happy path → models forwarded with hostKind=anthropic + display_name as ownedBy', async () => {
    let capturedKey: string | undefined;
    let capturedVersion: string | undefined;
    const stub = ((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.anthropic.com/v1/models') {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        capturedKey = headers['x-api-key'];
        capturedVersion = headers['anthropic-version'];
        return Promise.resolve(new Response(JSON.stringify({
          data: [
            { id: 'claude-opus-4-5', type: 'model', display_name: 'Claude Opus 4.5' },
            { id: 'claude-sonnet-4-5', type: 'model', display_name: 'Claude Sonnet 4.5' },
            { id: 'claude-haiku-4-5', type: 'model', display_name: 'Claude Haiku 4.5' },
          ],
        }), { status: 200 }));
      }
      return Promise.reject(new Error(`unstubbed: ${url}`));
    }) as unknown as FetchFn;
    installFetch(stub, ['https://api.anthropic.com/v1/models']);

    const res = await handleLlmModels(new Request('http://x/v1/llm/models'), {
      hosts: [{
        name: 'anthropic',
        kind: 'anthropic-openai-wrap',
        endpoint: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test-key',
      }],
    });
    const json = (await res.json()) as {
      ok: boolean; count: number;
      models: Array<{ id: string; host: string; hostKind: string; ownedBy?: string }>;
      hosts: Array<{ name: string; kind: string; count: number; error?: string }>;
    };
    expect(json.ok).toBe(true);
    expect(json.count).toBe(3);
    // x-api-key + anthropic-version sent.
    expect(capturedKey).toBe('sk-ant-test-key');
    expect(capturedVersion).toBe('2023-06-01');
    // display_name surfaced as ownedBy.
    const opus = json.models.find((m) => m.id === 'claude-opus-4-5');
    expect(opus?.hostKind).toBe('anthropic-openai-wrap');
    expect(opus?.ownedBy).toBe('Claude Opus 4.5');
    expectFetchCalls(['https://api.anthropic.com/v1/models']);
  });

  test('missing key (no host.apiKey + no env) → per-host error="missing-api-key"', async () => {
    const stub = (() => Promise.reject(new Error('should not fetch'))) as unknown as FetchFn;
    installFetch(stub, ['https://api.anthropic.com/v1/models']);

    const res = await handleLlmModels(new Request('http://x/v1/llm/models'), {
      hosts: [{
        name: 'anthropic',
        kind: 'anthropic-openai-wrap',
        endpoint: 'https://api.anthropic.com',
      }],
    });
    const json = (await res.json()) as {
      ok: boolean;
      hosts: Array<{ name: string; error?: string }>;
    };
    // No models fetched — host failed, so ok=false (only host failed).
    expect(json.ok).toBe(false);
    expect(json.hosts[0]?.error).toMatch(/missing-api-key/);
    expectFetchCalls([]);
  });

  test('ANTHROPIC_API_KEY env fallback → used when host.apiKey absent', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-fallback';
    let capturedKey: string | undefined;
    const stub = ((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('anthropic.com')) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        capturedKey = headers['x-api-key'];
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: 'claude-opus-4-5' }],
        }), { status: 200 }));
      }
      return Promise.reject(new Error(`unstubbed: ${url}`));
    }) as unknown as FetchFn;
    installFetch(stub, ['https://api.anthropic.com/v1/models']);

    const res = await handleLlmModels(new Request('http://x/v1/llm/models'), {
      hosts: [{ name: 'anthropic', kind: 'anthropic-openai-wrap', endpoint: 'https://api.anthropic.com' }],
    });
    const json = (await res.json()) as { ok: boolean; count: number };
    expect(json.ok).toBe(true);
    expect(json.count).toBe(1);
    expect(capturedKey).toBe('sk-ant-env-fallback');
    expectFetchCalls(['https://api.anthropic.com/v1/models']);
  });

  test('host.apiKey wins over env (per-host override)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-loser';
    let capturedKey: string | undefined;
    const stub = ((_input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      capturedKey = headers['x-api-key'];
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }) as unknown as FetchFn;
    installFetch(stub, ['https://api.anthropic.com/v1/models']);

    await handleLlmModels(new Request('http://x/v1/llm/models'), {
      hosts: [{
        name: 'anthropic',
        kind: 'anthropic-openai-wrap',
        endpoint: 'https://api.anthropic.com',
        apiKey: 'sk-ant-host-winner',
      }],
    });
    expect(capturedKey).toBe('sk-ant-host-winner');
    expectFetchCalls(['https://api.anthropic.com/v1/models']);
  });

  test('upstream 401 → generic upstream-auth-401 (no key leak)', async () => {
    const stub = (async () =>
      new Response('{"error":"invalid x-api-key"}', { status: 401 })) as unknown as FetchFn;
    installFetch(stub, ['https://api.anthropic.com/v1/models']);

    const res = await handleLlmModels(new Request('http://x/v1/llm/models'), {
      hosts: [{
        name: 'anthropic',
        kind: 'anthropic-openai-wrap',
        endpoint: 'https://api.anthropic.com',
        apiKey: 'sk-ant-bad-key',
      }],
    });
    const json = (await res.json()) as { hosts: Array<{ error?: string }> };
    // Generic auth code only — no upstream body, no key.
    expect(json.hosts[0]?.error).toBe('upstream-auth-401');
    expect(json.hosts[0]?.error).not.toContain('sk-ant');
    expect(json.hosts[0]?.error).not.toContain('invalid');
    expectFetchCalls(['https://api.anthropic.com/v1/models']);
  });

  test('mixed lm-studio + anthropic in parallel → merged with hostKind tags', async () => {
    const stub = ((input: unknown) => {
      const url = String(input);
      if (url === 'http://lm/v1/models') {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: 'gemma-4-26b-a4b-it' }],
        }), { status: 200 }));
      }
      if (url === 'https://api.anthropic.com/v1/models') {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5' }],
        }), { status: 200 }));
      }
      return Promise.reject(new Error(`unstubbed: ${url}`));
    }) as unknown as FetchFn;
    installFetch(stub, ['http://lm/v1/models', 'https://api.anthropic.com/v1/models']);

    const res = await handleLlmModels(new Request('http://x/v1/llm/models'), {
      hosts: [
        { name: 'lm', kind: 'lm-studio', endpoint: 'http://lm' },
        {
          name: 'cloud',
          kind: 'anthropic-openai-wrap',
          endpoint: 'https://api.anthropic.com',
          apiKey: 'sk-ant-test',
        },
      ],
    });
    const json = (await res.json()) as {
      ok: boolean; count: number;
      models: Array<{ id: string; host: string; hostKind: string }>;
    };
    expect(json.ok).toBe(true);
    expect(json.count).toBe(2);
    const byId = new Map(json.models.map((m) => [m.id, m]));
    expect(byId.get('gemma-4-26b-a4b-it')?.hostKind).toBe('lm-studio');
    expect(byId.get('claude-opus-4-5')?.hostKind).toBe('anthropic-openai-wrap');
    expectFetchCalls(['http://lm/v1/models', 'https://api.anthropic.com/v1/models']);
  });
});
