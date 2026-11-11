import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { loadFreshCodexAuthState, loginWithCodex } from '../oauth/codex.js';
import { loadTokens } from '../oauth/store.js';
import { serviceKeyStatus, verifyServiceKey, type ServiceKeyVerification } from '../setup/service-keys.js';
import { importServiceKeys, runFirstRunProviderSetup } from '../cli/setup-keys.js';
import { formatCodexDeviceLoginFailure, runCodexDeviceLoginWait } from '../cli/codex-device-login-wait.js';
import type { UserConfig } from '../user-config/types.js';
import { setUserConfigOverlay } from '../user-config.js';
import { withSimClock } from './fake-clock.js';
import {
  createFakeCodexDeviceOAuth,
  startFakeOpenAiCompatibleApi,
  type FakeOpenAiApiMode,
} from './service-key-setup.js';

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const isolatedRoots: string[] = [];
beforeEach(() => setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, codexTokenOwnerHost: 'mshq' }, hq: { ...config.hq, hostName: 'mshq' } })));
afterEach(() => {
  setUserConfigOverlay(null);
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
      const status = (await serviceKeyStatus({ env: {}, cacheDir })).find(row => row.id === 'openai-api');
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

test('first-run API-key choice never calls the actual OAuth module entrypoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'ux-oauth-entrypoint-spy-'));
  try {
    const repoRoot = join(import.meta.dir, '../..');
    const child = Bun.spawnSync([process.execPath, '--eval', [
      "import { spyOn } from 'bun:test';",
      "const oauth = await import('./src/oauth/codex.ts');",
      'let networkCalls = 0;',
      'let verifierCalls = 0;',
      "globalThis.fetch = (async () => { networkCalls += 1; throw new Error('network disabled'); }) as typeof fetch;",
      'const oauthSpy = spyOn(oauth, \'loginWithCodex\').mockImplementation(async () => undefined as never);',
      'await oauth.loginWithCodex();',
      "if (oauthSpy.mock.calls.length !== 1) throw new Error('OAuth spy positive control failed');",
      'oauthSpy.mockClear();',
      "const { runFirstRunProviderSetup } = await import('./src/cli/setup-keys.ts');",
      "const env: Record<string, string | undefined> = {};",
      "const result = await runFirstRunProviderSetup({ ask: async prompt => prompt === '선택: ' ? '3' : '1', askSecret: async prompt => prompt.includes('EXA_API_KEY') ? 'synthetic-exa-key' : '', print: () => {} }, {",
      "  config: { llm: { provider: 'openai' } }, env, cacheDir: process.env.HOME + '/cache',",
      '  loginWithCodex: oauth.loginWithCodex, verifier: async input => { verifierCalls += 1; if (input.provider !== \'exa\' || input.apiKey !== \'synthetic-exa-key\') throw new Error(\'unexpected verifier input\'); return { success: true, verification: \'verified\' }; },',
      '});',
      "if (result !== null) throw new Error(`non-LLM Exa key setup unexpectedly selected a default LLM provider: ${String(result)}`);",
      "if (verifierCalls !== 1 || env.EXA_API_KEY !== 'synthetic-exa-key') throw new Error('successful API-key verification/storage path was not exercised');",
      "if (oauthSpy.mock.calls.length !== 0) throw new Error(`OAuth entrypoint calls: ${oauthSpy.mock.calls.length}`);",
      "if (networkCalls !== 0) throw new Error(`network calls: ${networkCalls}`);",
      "process.stdout.write('api-key-setup=verified-exa no-default-llm oauth-entrypoint-calls=0 network-calls=0\\n');",
    ].join('\n')], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        XDG_CONFIG_HOME: join(root, 'xdg'),
        ELANOUS_SUPPRESS_XDG_WARNING: '1',
        CODEX_HOME: join(root, 'codex'),
      },
      timeout: 10_000,
    });
    const stdout = Buffer.from(child.stdout).toString('utf8');
    const stderr = Buffer.from(child.stderr).toString('utf8');
    expect(child.exitCode, `child stdout:\n${stdout}\nchild stderr:\n${stderr}`).toBe(0);
    expect(stdout).toContain('api-key-setup=verified-exa no-default-llm oauth-entrypoint-calls=0 network-calls=0');
    expect(stderr).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('synthetic canary inputs never reach the key verifier or emitted output', async () => {
  const allowedSecret = 'synthetic-allowed-api-key';
  const canary = 'synthetic-canary-provider-url-secret';
  const verifierInputs: Array<{ provider: string; apiKey: string }> = [];
  const printed: string[] = [];
  const consoleOutput: string[] = [];
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const cacheDir = mkdtempSync(join(tmpdir(), 'ux-service-key-canary-'));
  isolatedRoots.push(cacheDir);
  const originalFetch = globalThis.fetch;
  const originalConsoleMethods = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    trace: console.trace,
  };
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const expectNoCanaryOutput = () => {
    expect(printed.join('\n')).not.toContain(canary);
    expect(consoleOutput.join('\n')).not.toContain(canary);
    expect(stdoutChunks.join('')).not.toContain(canary);
    expect(stderrChunks.join('')).not.toContain(canary);
  };
  const captureWrite = (chunks: string[]) => (chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): true => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8'));
    const done = typeof encoding === 'function' ? encoding : callback;
    done?.(null);
    return true;
  };
  for (const method of Object.keys(originalConsoleMethods) as Array<keyof typeof originalConsoleMethods>) {
    console[method] = (...args: unknown[]) => { consoleOutput.push(format(...args)); };
  }
  process.stdout.write = captureWrite(stdoutChunks) as typeof process.stdout.write;
  process.stderr.write = captureWrite(stderrChunks) as typeof process.stderr.write;
  let outboundRequests = 0;
  // OAuth observation is scoped to the actual dependency-injection seam. The
  // fetch spy below independently catches any network-backed OAuth entrypoint.
  let injectedOAuthHookCalls = 0;
  globalThis.fetch = (async () => {
    outboundRequests += 1;
    throw new Error('network access forbidden in synthetic canary test');
  }) as unknown as typeof fetch;
  try {
    console.log({ canary });
    expect(consoleOutput.join('\n')).toContain(canary);
    expect(() => expectNoCanaryOutput()).toThrow();
    consoleOutput.length = 0;

    process.stdout.write(canary.slice(0, 12));
    process.stdout.write(canary.slice(12));
    expect(stdoutChunks.join('')).toContain(canary);
    expect(() => expectNoCanaryOutput()).toThrow();
    stdoutChunks.length = 0;

    process.stderr.write(canary);
    expect(stderrChunks.join('')).toContain(canary);
    expect(() => expectNoCanaryOutput()).toThrow();
    stderrChunks.length = 0;

    const imported = await importServiceKeys(
      new Map([
        ['OPENAI_API_KEY', allowedSecret],
        ['CANARY_PROVIDER_URL', canary],
      ]),
      { print: message => printed.push(message) },
      {
        config: { llm: { provider: 'openai' } } as unknown as UserConfig,
        env: { CANARY_PROVIDER_URL: canary },
        cacheDir,
        verifier: async input => {
          verifierInputs.push(input);
          return { success: true, verification: 'verified' };
        },
        loginWithCodex: async () => {
          injectedOAuthHookCalls += 1;
          throw new Error('OAuth must not be invoked by key import');
        },
      },
    );

    expect(verifierInputs).toEqual([{ provider: 'openai-api', apiKey: allowedSecret }]);
    expect(imported.stored).toEqual(['OPENAI_API_KEY']);
    expect(imported.rejected).toEqual(['CANARY_PROVIDER_URL']);
    expect(imported.unverified).toEqual([]);
    expect(JSON.stringify(verifierInputs)).not.toContain(canary);
    expect(JSON.stringify(imported)).not.toContain(canary);
    expectNoCanaryOutput();
    expect(outboundRequests).toBe(0);
    expect(injectedOAuthHookCalls).toBe(0);

    const firstRunSecret = 'synthetic-first-run-exa-key';
    const firstRunVerifierInputs: Array<{ provider: string; apiKey: string }> = [];
    const firstRunCacheDir = mkdtempSync(join(tmpdir(), 'ux-service-key-first-run-'));
    isolatedRoots.push(firstRunCacheDir);
    await runFirstRunProviderSetup({
      ask: async prompt => prompt === '선택: ' ? '3' : '',
      askSecret: async prompt => prompt.includes('EXA_API_KEY') ? firstRunSecret : '',
      print: message => printed.push(message),
    }, {
      config: { llm: { provider: 'openai' } } as unknown as UserConfig,
      env: { CANARY_PROVIDER_URL: canary },
      cacheDir: firstRunCacheDir,
      verifier: async input => {
        firstRunVerifierInputs.push(input);
        return { success: true, verification: 'verified' };
      },
      loginWithCodex: async () => {
        injectedOAuthHookCalls += 1;
        throw new Error('OAuth must not be invoked by API-key setup');
      },
    });
    expect(firstRunVerifierInputs).toEqual([{ provider: 'exa', apiKey: firstRunSecret }]);
    expect(injectedOAuthHookCalls).toBe(0);
    expect(outboundRequests).toBe(0);
    expectNoCanaryOutput();

    let oauthHookPositiveControl = 0;
    const oauthControl = await runFirstRunProviderSetup({
      ask: async () => '1',
      print: () => {},
    }, {
      config: { llm: { provider: 'openai' } } as unknown as UserConfig,
      loginWithCodex: async () => {
        oauthHookPositiveControl += 1;
        throw new Error('synthetic positive control');
      },
    });
    expect(oauthHookPositiveControl).toBe(1);
    expect(oauthControl).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    Object.assign(console, originalConsoleMethods);
  }
  console.log(`[service-key-canary] verifier-calls=${verifierInputs.length} canary-forwarded=0 canary-output=0 outbound-requests=${outboundRequests} injected-oauth-hook-calls=${injectedOAuthHookCalls}`);
});

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
  setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, codexTokenOwnerHost: 'mshq' }, hq: { ...config.hq, hostName: 'mshq' } }));
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

test('headless Codex device login cancellation during a delayed token exchange never saves tokens', async () => {
  useIsolatedAuthStore();
  const oauth = createFakeCodexDeviceOAuth('exchange-in-flight');
  const printed: string[] = [];
  const updates: string[] = [];
  let interrupt: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const io = {
    print: (line: string) => printed.push(line),
    updateLine: (line: string) => updates.push(line),
    finishLine: () => {},
    onInterrupt: (handler: () => void) => { interrupt = handler; return () => { interrupt = undefined; }; },
  };

  await withSimClock(Date.parse('2026-11-04T00:00:00Z'), async clock => {
    let loginSettled = false;
    const resultPromise = runCodexDeviceLoginWait(options => {
      signal = options.signal;
      return loginWithCodex({
        ...options,
        fetchImpl: oauth.fetchImpl,
        pollIntervalMs: 1_000,
        maxWaitMs: 10_000,
        mirrorCodex: false,
      }).finally(() => { loginSettled = true; });
    }, io, { headless: true });

    for (let turn = 0; turn < 20 && !printed.some(line => line.startsWith('코드: ')); turn++) await Promise.resolve();
    expect(printed.some(line => line.startsWith('코드: '))).toBe(true);
    expect(updates[0]).toContain('0초');
    expect(updates[0]).toContain('Ctrl-C 취소');
    clock.tick(1_100);
    await oauth.exchangeStarted;
    expect(updates.some(line => line.includes('Codex 로그인 확인 중'))).toBe(true);

    interrupt?.();
    expect(signal?.aborted).toBe(true);
    oauth.releaseExchange();
    expect(await resultPromise).toEqual({ kind: 'cancelled' });
    for (let turn = 0; turn < 20 && !loginSettled; turn++) await Promise.resolve();
    expect(loginSettled).toBe(true);
    expect(oauth.requests().map(request => request.endpoint)).toEqual(['device-code', 'device-poll', 'token']);
    expect(loadTokens('openai-codex')).toBeNull();
    expect(updates.every(line => !line.includes('.'))).toBe(true);
    expect(clock.pendingTimers()).toBe(0);
  });
});

test('headless Codex cancellation during a delayed device approval never starts token exchange', async () => {
  useIsolatedAuthStore();
  const oauth = createFakeCodexDeviceOAuth('poll-in-flight');
  const printed: string[] = [];
  let interrupt: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const resultPromise = runCodexDeviceLoginWait(options => {
    signal = options.signal;
    return loginWithCodex({ ...options, fetchImpl: oauth.fetchImpl, sleepImpl: async () => {}, pollIntervalMs: 0, mirrorCodex: false });
  }, {
    print: line => printed.push(line),
    onInterrupt: handler => { interrupt = handler; return () => { interrupt = undefined; }; },
  }, { headless: true });

  await oauth.pollStarted;
  interrupt?.();
  expect(signal?.aborted).toBe(true);
  oauth.releasePoll();
  expect(await resultPromise).toEqual({ kind: 'cancelled' });
  expect(oauth.requests().map(request => request.endpoint)).toEqual(['device-code', 'device-poll']);
  expect(loadTokens('openai-codex')).toBeNull();
  expect(printed.filter(line => line.includes('대기 중'))).toHaveLength(1);
});

test('headless device-flow failures are not formatted as offline or browser-launch failures', async () => {
  const result = await runCodexDeviceLoginWait(async () => { throw new TypeError('fetch failed'); }, {
    print: () => {},
  }, { headless: true });
  expect(result.kind).toBe('failed');
  if (result.kind !== 'failed') return;
  const message = formatCodexDeviceLoginFailure(result.error);
  expect(message).toContain('fetch failed');
  expect(message.toLowerCase()).not.toContain('offline');
  expect(message.toLowerCase()).not.toContain('browser');
});

test('non-TTY headless login prints elapsed updates every ten seconds without polling dots', async () => {
  const printed: string[] = [];
  let interrupt: (() => void) | undefined;
  await withSimClock(Date.parse('2026-11-04T00:00:00Z'), async clock => {
    const resultPromise = runCodexDeviceLoginWait(async options => {
      options.onProgress?.({ type: 'user_code', userCode: 'synthetic-fixture', loginUrl: 'https://example.invalid/device' });
      return new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('synthetic cancellation')), { once: true });
      });
    }, {
      print: line => printed.push(line),
      onInterrupt: handler => { interrupt = handler; return () => { interrupt = undefined; }; },
    }, { headless: true });
    for (let turn = 0; turn < 20 && !printed.some(line => line.includes('0초')); turn++) await Promise.resolve();
    clock.tick(10_000);
    for (let turn = 0; turn < 20 && !printed.some(line => line.includes('10초')); turn++) await Promise.resolve();
    expect(printed.some(line => line.includes('0초'))).toBe(true);
    expect(printed.some(line => line.includes('10초'))).toBe(true);
    expect(printed.filter(line => line.includes('대기 중'))).toHaveLength(2);
    expect(printed.every(line => !/\.{2,}/.test(line))).toBe(true);
    interrupt?.();
    expect(await resultPromise).toEqual({ kind: 'cancelled' });
    expect(clock.pendingTimers()).toBe(0);
  });
});
