// NEXUS · /v1/setup/llm-provider tests (PWA `/setup` wizard · Phase 1)
//
// 본 test 는 wire-level — getUserConfig / saveUserConfig 를 spy 로 격리하지
// 않고 임시 디렉토리에 user-config 를 점지하여 real-IO smoke 로 검증.
// Why: applyDashboardProviderSetup → saveUserConfig → reloadUserConfig 의
// round-trip 이 본 endpoint 가치의 본질이라 mock 으로 격리하면 의미 없음.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  resetElanousConfigDir,
  setElanousConfigDir,
} from '../../elanous-config-dir';
import { resetUserConfig } from '../../user-config';
import {
  handleLlmProvidersList,
  handleLlmProviderSet,
  type LlmProvidersResponse,
  type LlmProviderSetResponse,
} from './setup-llm-provider';

const TEST_DIR_PREFIX = path.join(os.tmpdir(), 'elanous-setup-llm-test-');

let testConfigDir: string;

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(TEST_DIR_PREFIX);
  setElanousConfigDir(testConfigDir);
  // user-config caches by path — bust between tests so each one sees
  // the fresh tmpdir.
  resetUserConfig();
  fs.writeFileSync(
    path.join(testConfigDir, 'config.json'),
    JSON.stringify({}),
    'utf8',
  );
});

afterEach(() => {
  resetElanousConfigDir();
  resetUserConfig();
  try { fs.rmSync(testConfigDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeGet(pathname: string): Request {
  return new Request(`http://localhost${pathname}`, { method: 'GET' });
}

function makePost(pathname: string, body: unknown): Request {
  return new Request(`http://localhost${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('GET /v1/setup/llm-providers', () => {
  test('returns the full provider catalog', async () => {
    const res = handleLlmProvidersList(makeGet('/v1/setup/llm-providers'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as LlmProvidersResponse;
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.length).toBeGreaterThan(5); // catalog has 10 entries
    const names = body.providers.map((p) => p.provider);
    expect(names).toContain('anthropic');
    expect(names).toContain('openai');
    expect(names).toContain('gemini');
    expect(names).toContain('auto');
    expect(names).toContain('local');
  });

  test('flags recommended providers correctly', async () => {
    const res = handleLlmProvidersList(makeGet('/v1/setup/llm-providers'));
    const body = (await res.json()) as LlmProvidersResponse;
    const anthropic = body.providers.find((p) => p.provider === 'anthropic');
    expect(anthropic?.recommended).toBe(true);
    const kimi = body.providers.find((p) => p.provider === 'kimi');
    expect(kimi?.recommended).toBe(false);
  });

  test('echoes the active provider', async () => {
    const res = handleLlmProvidersList(makeGet('/v1/setup/llm-providers'));
    const body = (await res.json()) as LlmProvidersResponse;
    expect(typeof body.activeProvider).toBe('string');
  });

  test('rejects non-GET', async () => {
    const res = handleLlmProvidersList(
      new Request('http://localhost/v1/setup/llm-providers', { method: 'DELETE' }),
    );
    expect(res.status).toBe(405);
  });

  test('handles OPTIONS preflight', () => {
    const res = handleLlmProvidersList(
      new Request('http://localhost/v1/setup/llm-providers', { method: 'OPTIONS' }),
    );
    expect(res.status).toBe(204);
  });
});

describe('POST /v1/setup/llm-provider — apiKey flow', () => {
  test('persists apiKey provider to user-config', async () => {
    const res = await handleLlmProviderSet(
      makePost('/v1/setup/llm-provider', {
        provider: 'anthropic',
        apiKey: 'sk-ant-test-1234567890',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as LlmProviderSetResponse;
    expect(body.ok).toBe(true);
    expect(body.active.provider).toBe('anthropic');

    // The next list call should report hasSavedKey for anthropic.
    const listRes = handleLlmProvidersList(makeGet('/v1/setup/llm-providers'));
    const list = (await listRes.json()) as LlmProvidersResponse;
    const anth = list.providers.find((p) => p.provider === 'anthropic');
    expect(anth?.hasSavedKey).toBe(true);
    expect(list.activeProvider).toBe('anthropic');
  });

  test('rejects empty apiKey for apiKey-flow provider', async () => {
    const res = await handleLlmProviderSet(
      makePost('/v1/setup/llm-provider', { provider: 'anthropic', apiKey: '   ' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('apiKey-required');
  });

  test('trims apiKey before save', async () => {
    const res = await handleLlmProviderSet(
      makePost('/v1/setup/llm-provider', {
        provider: 'gemini',
        apiKey: '  AIzaSyTestKey1234  ',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as LlmProviderSetResponse;
    expect(body.active.provider).toBe('gemini');
  });
});

describe('POST /v1/setup/llm-provider — auto flow', () => {
  test('persists auto provider without apiKey', async () => {
    const res = await handleLlmProviderSet(
      makePost('/v1/setup/llm-provider', { provider: 'auto' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as LlmProviderSetResponse;
    expect(body.ok).toBe(true);
    // saveUserConfig/sparseUserConfig omit generated defaults when no raw key
    // was present. Auto still round-trips through the isolated config reader.
    expect(body.active.provider).toBe('auto');
    const cfgRaw = fs.readFileSync(
      path.join(testConfigDir, 'config.json'),
      'utf8',
    );
    const cfgObj = JSON.parse(cfgRaw) as { llm?: { provider?: string } };
    expect(cfgObj.llm?.provider).toBeUndefined();
    const list = await handleLlmProvidersList(makeGet('/v1/setup/llm-providers')).json() as LlmProvidersResponse;
    expect(list.activeProvider).toBe('auto');
  });

  test('switching to auto preserves explicit intent and clears prior active credentials', async () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      llm: { provider: 'anthropic', apiKey: 'synthetic-prior-key', baseUrl: 'http://fixture.invalid', model: 'fixture-model' },
    }));
    resetUserConfig();
    const res = await handleLlmProviderSet(makePost('/v1/setup/llm-provider', { provider: 'auto' }));
    expect(res.status).toBe(200);
    const saved = JSON.parse(fs.readFileSync(path.join(testConfigDir, 'config.json'), 'utf8')) as {
      llm?: { provider?: string; apiKey?: string; baseUrl?: string; model?: string };
    };
    // sparseUserConfig retains explicit raw keys, including a provider selected earlier.
    expect(saved.llm?.provider).toBe('auto');
    expect(saved.llm?.apiKey).toBeUndefined();
    expect(saved.llm?.baseUrl).toBeUndefined();
    expect(saved.llm?.model).toBeUndefined();
    const list = await handleLlmProvidersList(makeGet('/v1/setup/llm-providers')).json() as LlmProvidersResponse;
    expect(list.activeProvider).toBe('auto');
    expect(list.providers.some(provider => provider.hasSavedKey)).toBe(false);
  });
});

describe('POST /v1/setup/llm-provider — codex/local flow', () => {
  test('codex flow returns 422 with TUI hint', async () => {
    const res = await handleLlmProviderSet(
      makePost('/v1/setup/llm-provider', { provider: 'openai-codex' }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; flow: string; hint: string };
    expect(body.error).toBe('flow-not-supported-in-pwa');
    expect(body.flow).toBe('codex');
    expect(body.hint).toContain('elanous setup llm');
  });

  test('local flow returns 422 with probe hint', async () => {
    const res = await handleLlmProviderSet(
      makePost('/v1/setup/llm-provider', { provider: 'local' }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; flow: string };
    expect(body.error).toBe('flow-not-supported-in-pwa');
    expect(body.flow).toBe('local');
  });
});

describe('POST /v1/setup/llm-provider — error cases', () => {
  test('rejects unknown provider', async () => {
    const res = await handleLlmProviderSet(
      makePost('/v1/setup/llm-provider', { provider: 'made-up-llm', apiKey: 'x' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; provider: string };
    expect(body.error).toBe('unknown-provider');
    expect(body.provider).toBe('made-up-llm');
  });

  test('rejects missing provider field', async () => {
    const res = await handleLlmProviderSet(
      makePost('/v1/setup/llm-provider', { apiKey: 'x' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('provider-required');
  });

  test('rejects invalid JSON body', async () => {
    const res = await handleLlmProviderSet(
      makePost('/v1/setup/llm-provider', '{not json'),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid-json');
  });

  test('rejects non-POST methods', async () => {
    const res = await handleLlmProviderSet(
      new Request('http://localhost/v1/setup/llm-provider', { method: 'PUT' }),
    );
    expect(res.status).toBe(405);
  });

  test('handles OPTIONS preflight', async () => {
    const res = await handleLlmProviderSet(
      new Request('http://localhost/v1/setup/llm-provider', { method: 'OPTIONS' }),
    );
    expect(res.status).toBe(204);
  });
});
