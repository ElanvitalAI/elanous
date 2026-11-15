import { expect, test } from 'bun:test';
import { ProviderModelCache, runLocalProviderCommand } from './local-provider-command.js';
import { getUserConfig, setUserConfigOverlay } from '../user-config.js';
import { clearSessionProvider, getSessionProvider } from './session-provider.js';
import { backupConfigPath, reloadUserConfig, userConfigPath } from '../user-config.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

test('provider models load on first open, then use the session cache and last good remote list', async () => {
  const cache = new ProviderModelCache();
  const signal = new AbortController().signal;
  const url = 'http://127.0.0.1:1234/v1/models';
  let calls = 0;
  const remote = async (): Promise<Response> => {
    calls++;
    return Response.json({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] });
  };

  const first = await cache.models('openai-codex', url, undefined, signal, false, remote);
  expect(first).toEqual({ ids: ['model-a', 'model-b'], source: 'remote' });
  expect(calls).toBe(1);

  const reused = await cache.models('openai-codex', url, undefined, signal, false, remote);
  expect(reused).toEqual({ ids: ['model-a', 'model-b'], source: 'cache' });
  expect(calls).toBe(1);

  const neverResponds = (): Promise<Response> => new Promise(() => {});
  const fallback = await cache.models('openai-codex', url, undefined, signal, true, neverResponds, 10);
  expect(fallback.ids).toEqual(['model-a', 'model-b']);
  expect(fallback.source).toBe('cache');
  expect(fallback.note).toContain('timed out');
});

test('a first remote timeout falls back to local catalog models', async () => {
  const cache = new ProviderModelCache();
  const neverResponds = (): Promise<Response> => new Promise(() => {});
  const result = await cache.models(
    'openai-codex', 'http://127.0.0.1:1234/v1/models', undefined,
    new AbortController().signal, false, neverResponds, 10,
  );
  expect(result.source).toBe('local');
  expect(result.note).toContain('timed out');
  expect(result.ids.length).toBeGreaterThan(0);
});

test('Esc cancellation settles a stalled remote lookup before its deadline', async () => {
  const cache = new ProviderModelCache();
  const controller = new AbortController();
  const started = Date.now();
  const pending = cache.models(
    'openai-codex', 'http://127.0.0.1:1234/v1/models', undefined,
    controller.signal, false, () => new Promise(() => {}), 2_000,
  );
  controller.abort();
  await expect(pending).rejects.toThrow('provider lookup cancelled');
  expect(Date.now() - started).toBeLessThan(500);
});

test('malformed remote data never replaces the last good result', async () => {
  const cache = new ProviderModelCache();
  const signal = new AbortController().signal;
  const url = 'http://127.0.0.1:1234/v1/models';
  await cache.models('openai-codex', url, undefined, signal, false,
    async () => Response.json({ data: [{ id: 'good' }] }));
  const result = await cache.models('openai-codex', url, undefined, signal, true,
    async () => Response.json({ data: [{ id: 'bad-mix' }, { nope: 'id' }] }));
  expect(result).toMatchObject({ ids: ['good'], source: 'cache' });
  expect(result.note).toContain('malformed');
});

test('remote cache follows provider and API key changes at the same URL', async () => {
  const cache = new ProviderModelCache();
  const signal = new AbortController().signal;
  const url = 'http://127.0.0.1:1234/v1/models';
  let calls = 0;
  const remote = async (): Promise<Response> => Response.json({ data: [{ id: `model-${++calls}` }] });
  await cache.models('openai-codex', url, 'key-a', signal, false, remote);
  const changedKey = await cache.models('openai-codex', url, 'key-b', signal, false, remote);
  const changedProvider = await cache.models('openrouter', url, 'key-b', signal, false, remote);
  expect(changedKey).toMatchObject({ ids: ['model-2'], source: 'remote' });
  expect(changedProvider).toMatchObject({ ids: ['model-3'], source: 'remote' });
  expect(calls).toBe(3);
});

test('a cancelled command emits no local or cached model list', async () => {
  const controller = new AbortController();
  controller.abort();
  const lines: string[] = [];
  await expect(runLocalProviderCommand('models openai-codex', controller.signal, (line) => lines.push(line)))
    .rejects.toThrow('provider lookup cancelled');
  expect(lines).toEqual([]);
  const cache = new ProviderModelCache();
  await expect(cache.models('openai-codex', undefined, undefined, controller.signal))
    .rejects.toThrow('provider lookup cancelled');
});

test('an invalid configured base URL shows local models with a failure note', async () => {
  setUserConfigOverlay((cfg) => ({ ...cfg, llm: { ...cfg.llm, baseUrl: 'not-a-url' } }));
  try {
    const lines: string[] = [];
    await runLocalProviderCommand('models', new AbortController().signal, (line) => { lines.push(line); });
    expect(lines[0]).toContain('local');
    expect(lines[0]).toContain('invalid base URL');
    expect(lines.length).toBeGreaterThan(1);
  } finally {
    setUserConfigOverlay(null);
  }
});

test('a whitespace-only remote model ID is malformed', async () => {
  const cache = new ProviderModelCache();
  const result = await cache.models('openai-codex', 'http://127.0.0.1:1234/v1/models', undefined,
    new AbortController().signal, false,
    async () => Response.json({ data: [{ id: '  ' }] }));
  expect(result.source).toBe('local');
  expect(result.note).toContain('malformed');
});

test('prototype names are never accepted as providers', async () => {
  const signal = new AbortController().signal;
  for (const name of ['toString', 'constructor']) {
    await expect(runLocalProviderCommand(`models ${name}`, signal, () => {}))
      .rejects.toThrow(`알 수 없는 provider: ${name}`);
    await expect(runLocalProviderCommand(`use ${name}`, signal, () => {}))
      .rejects.toThrow('사용법');
  }
});

test('provider use changes only the addressed session; global mode requires a second confirmation flag', async () => {
  const before = getUserConfig().llm.provider;
  const lines: string[] = [];
  try {
    await runLocalProviderCommand('use grok grok-4.7', new AbortController().signal, (line) => lines.push(line), 'session-grok');
    expect(getSessionProvider('session-grok')).toEqual({ provider: 'grok', model: 'grok-4.7' });
    expect(getSessionProvider('session-codex')).toBeUndefined();
    expect(getUserConfig().llm.provider).toBe(before);
    expect(lines.at(-1)).toContain('이 세션');
    await expect(runLocalProviderCommand('use grok --global', new AbortController().signal, () => {}, 'session-grok'))
      .rejects.toThrow('--global --yes');
    expect(getUserConfig().llm.provider).toBe(before);
  } finally {
    clearSessionProvider('session-grok');
  }
});

test('confirmed global switch backs up the old key and publishes a key-free new provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-session-provider-'));
  setElanousConfigDir(root);
  try {
    const path = userConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ llm: { provider: 'openai-codex', model: 'gpt-6.1-terra',
      apiKey: 'old-provider-key', baseUrl: 'https://old.example.invalid/v1' }, customField: 'kept' }));
    reloadUserConfig();
    await runLocalProviderCommand('use grok grok-4.7 --global --yes', new AbortController().signal, () => {}, 'global-test-session');
    const published = JSON.parse(readFileSync(path, 'utf8'));
    const backup = JSON.parse(readFileSync(backupConfigPath(path), 'utf8'));
    expect(published).toMatchObject({ customField: 'kept', llm: { provider: 'grok', model: 'grok-4.7' } });
    expect(published.llm.apiKey).toBeUndefined();
    expect(published.llm.baseUrl).toBeUndefined();
    expect(backup.llm).toMatchObject({ provider: 'openai-codex', apiKey: 'old-provider-key',
      baseUrl: 'https://old.example.invalid/v1' });
    expect(existsSync(path)).toBe(true);
    expect(getUserConfig().llm.provider).toBe('grok');
  } finally {
    resetElanousConfigDir();
    reloadUserConfig();
    rmSync(root, { recursive: true, force: true });
  }
});

test('first global switch creates absent config, while malformed existing config fails closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-first-provider-'));
  setElanousConfigDir(root);
  try {
    const path = userConfigPath();
    expect(existsSync(path)).toBe(false);
    await runLocalProviderCommand('use grok --global --yes', new AbortController().signal, () => {}, 'first-session');
    expect(JSON.parse(readFileSync(path, 'utf8')).llm.provider).toBe('grok');
    expect(existsSync(backupConfigPath(path))).toBe(false);
    writeFileSync(path, '{not-json');
    await expect(runLocalProviderCommand('use openai-codex --global --yes', new AbortController().signal, () => {}, 'first-session'))
      .rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{not-json');
    expect(existsSync(backupConfigPath(path))).toBe(false);
  } finally {
    resetElanousConfigDir();
    reloadUserConfig();
    rmSync(root, { recursive: true, force: true });
  }
});
