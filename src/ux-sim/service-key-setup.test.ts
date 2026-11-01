import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFreshCodexAuthState, loginWithCodex } from '../oauth/codex.js';
import { loadTokens } from '../oauth/store.js';
import { serviceKeyStatus, verifyServiceKey, type ServiceKeyVerification } from '../setup/service-keys.js';
import { importServiceKeys } from '../cli/setup-keys.js';
import type { UserConfig } from '../user-config.js';
import {
  createFakeCodexDeviceOAuth,
  startFakeOpenAiCompatibleApi,
  type FakeOpenAiApiMode,
} from './service-key-setup.js';

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const isolatedRoots: string[] = [];
afterEach(() => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  for (const root of isolatedRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function useIsolatedAuthStore(): string {
  const root = mkdtempSync(join(tmpdir(), 'ux-fake-codex-oauth-'));
  isolatedRoots.push(root);
  process.env.XDG_CONFIG_HOME = root;
  return root;
}

function trackOutboundFetch(): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
  return {
    urls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

function filesContaining(dir: string, needle: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => readFileSync(join(dir, name), 'utf8').includes(needle));
}

test('first-run key verifier uses the configured OpenAI-compatible endpoint and classifies server outcomes safely', async () => {
  const cases: Array<[FakeOpenAiApiMode, ServiceKeyVerification]> = [
    ['ok', 'verified'],
    ['unauthorized', 'invalid'],
    ['rate-limited', 'rate-limited'],
    ['disconnect', 'unavailable'],
    ['slow', 'unavailable'],
  ];
  for (const [mode, result] of cases) {
    const server = await startFakeOpenAiCompatibleApi(mode);
    try {
      const secret = `sentinel-${mode}-key-value`;
      const verification = await verifyServiceKey('openai-api', secret, {
        baseUrl: server.baseUrl,
        timeoutMs: 100,
      });
      expect(verification.result).toBe(result);
      expect(server.requests()).toBe(1);
      expect(JSON.stringify(verification)).not.toContain(secret);
      console.log(
        `[service-key-classification] mode=${mode} classification=${verification.result} requests=${server.requests()} sentinel-in-result=${JSON.stringify(verification).includes(secret)}`,
      );
    } finally { await server.close(); }
  }
});

test('first-run key import persists only verified keys and never exposes the secret or an external endpoint', async () => {
  const modes: Array<{
    mode: FakeOpenAiApiMode;
    outcome: 'stored' | 'rejected';
    reason?: 'invalid' | 'rate-limited' | 'unavailable';
  }> = [
    { mode: 'ok', outcome: 'stored' },
    { mode: 'unauthorized', outcome: 'rejected', reason: 'invalid' },
    { mode: 'rate-limited', outcome: 'rejected', reason: 'rate-limited' },
    { mode: 'disconnect', outcome: 'rejected', reason: 'unavailable' },
    { mode: 'slow', outcome: 'rejected', reason: 'unavailable' },
  ];
  for (const { mode, outcome, reason } of modes) {
    // verifyServiceKey defaults to a 5s timeout; importServiceKeys does not override it,
    // so 'slow' must lag past that bound to classify as unavailable.
    const server = await startFakeOpenAiCompatibleApi(mode, mode === 'slow' ? 6_000 : undefined);
    const outbound = trackOutboundFetch();
    try {
      const secret = `sentinel-${mode}-key-value`;
      const env: NodeJS.ProcessEnv = { ...process.env };
      const cacheDir = mkdtempSync(join(tmpdir(), 'ux-service-key-import-'));
      isolatedRoots.push(cacheDir);
      const config = {
        llm: { provider: 'openai', rotation: [{ provider: 'openai', baseUrl: server.baseUrl }] },
      } as unknown as UserConfig;
      const printed: string[] = [];
      const imported = await importServiceKeys(new Map([['OPENAI_API_KEY', secret]]), {
        print: message => printed.push(message),
      }, { config, env, cacheDir });
      const storedVisible = imported.stored.includes('OPENAI_API_KEY');
      expect(storedVisible).toBe(outcome === 'stored');
      if (outcome === 'stored') {
        expect(imported.rejected).toEqual([]);
      } else {
        expect(imported.stored).toEqual([]);
        expect(imported.rejected).toEqual(['OPENAI_API_KEY']);
        expect(printed.some(line => line.includes(`검증 ${reason}`))).toBe(true);
      }
      // Fresh isolated cache must agree with the import verdict.
      const status = serviceKeyStatus({ env: {}, cacheDir }).find(row => row.id === 'openai-api');
      expect(status?.configured).toBe(outcome === 'stored');
      if (outcome === 'stored') {
        const persisted = readFileSync(join(cacheDir, 'openai_api_key'), 'utf8').trim();
        expect(persisted).toBe(secret);
      } else {
        expect(existsSync(join(cacheDir, 'openai_api_key'))).toBe(false);
      }
      // Exactly one request, served locally by the fake API.
      expect(server.requests()).toBe(1);
      // Neither the serialized result nor the printed output may leak the sentinel.
      expect(JSON.stringify(imported)).not.toContain(secret);
      expect(printed.join('\n')).not.toContain(secret);
      expect(JSON.stringify(status)).not.toContain(secret);
      // On-disk cache: a rejected key must leave no file holding the sentinel;
      // a verified key holds it only in its own cache entry.
      const sentinelFiles = filesContaining(cacheDir, secret);
      if (outcome === 'stored') {
        expect(sentinelFiles).toContain('openai_api_key');
      } else {
        expect(sentinelFiles).toEqual([]);
      }
      // No external provider endpoint is part of the import: the verification
      // call is observed (so the check cannot pass vacuously) and every
      // observed outbound URL stays on the local fake API.
      expect(outbound.urls.length).toBeGreaterThan(0);
      for (const url of outbound.urls) {
        expect(url.startsWith(server.baseUrl)).toBe(true);
      }
      console.log(
        `[service-key-import] mode=${mode} expected=${outcome} stored=${imported.stored.join(',') || '-'} rejected=${imported.rejected.join(',') || '-'} fresh-cache-configured=${status?.configured} persisted-file=${existsSync(join(cacheDir, 'openai_api_key'))} requests=${server.requests()} sentinel-in-result=${JSON.stringify(imported).includes(secret)} sentinel-in-output=${printed.join('\n').includes(secret)} sentinel-files=${sentinelFiles.join(',') || 'none'} outbound-urls=${outbound.urls.length} external-urls=${outbound.urls.filter(u => !u.startsWith(server.baseUrl)).length}`,
      );
    } finally {
      outbound.restore();
      await server.close();
    }
  }
}, 30_000);

test('fake device OAuth completes production login and refreshes an expired access token without exposing secrets', async () => {
  const root = useIsolatedAuthStore();
  const oauth = createFakeCodexDeviceOAuth();
  const progress: unknown[] = [];
  const saved = await loginWithCodex({
    fetchImpl: oauth.fetchImpl,
    sleepImpl: async () => {},
    maxWaitMs: 2_000,
    pollIntervalMs: 0,
    mirrorCodex: false,
    onProgress: event => progress.push(event),
  });

  expect(saved.tokens.accessToken).toBe('fake-initial-access-token');
  expect(loadTokens('openai-codex')?.tokens.refreshToken).toBe('fake-initial-refresh-token');
  const refreshed = await loadFreshCodexAuthState({ fetchImpl: oauth.fetchImpl, mirrorCodex: false });
  expect(refreshed?.tokens).toMatchObject({
    accessToken: 'fake-refreshed-access-token',
    refreshToken: 'fake-rotated-refresh-token',
  });
  expect(oauth.requests().map(({ endpoint, grantType }) => [endpoint, grantType])).toEqual([
    ['device-code', undefined],
    ['device-poll', undefined],
    ['device-poll', undefined],
    ['token', 'authorization_code'],
    ['token', 'refresh_token'],
  ]);
  const visible = JSON.stringify(progress);
  for (const secret of [
    'fake-authorization-code', 'fake-code-verifier',
    'fake-initial-access-token', 'fake-initial-refresh-token',
    'fake-refreshed-access-token', 'fake-rotated-refresh-token',
  ]) expect(visible).not.toContain(secret);
  const persisted = readFileSync(join(root, 'elanous', 'auth.json'), 'utf8');
  expect(persisted).not.toContain('fake-authorization-code');
  expect(persisted).not.toContain('fake-code-verifier');
});

test('fake device OAuth rejects user denial and expired device codes without saving tokens', async () => {
  useIsolatedAuthStore();
  for (const [mode, error] of [
    ['denied', 'access_denied'],
    ['expired-code', 'expired_token'],
  ] as const) {
    const oauth = createFakeCodexDeviceOAuth(mode);
    await expect(loginWithCodex({
      fetchImpl: oauth.fetchImpl,
      sleepImpl: async () => {},
      maxWaitMs: 2_000,
      pollIntervalMs: 0,
      mirrorCodex: false,
    })).rejects.toThrow(error);
    expect(loadTokens('openai-codex')).toBeNull();
    expect(oauth.requests().map(({ endpoint }) => endpoint)).toEqual(['device-code', 'device-poll']);
    expect(JSON.stringify(oauth.requests())).not.toContain('fake-');
  }
});
