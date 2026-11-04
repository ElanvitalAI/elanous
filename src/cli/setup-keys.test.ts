import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTokens } from '../oauth/store.js';
import { loginWithCodex } from '../oauth/codex.js';
import { runFirstRun } from '../onboarding/first-run.js';
import { buildUserConfig } from '../user-config.js';
import {
  FIRST_RUN_PROVIDER_SETUP_MENU_HEADING,
  FIRST_RUN_PROVIDER_SETUP_MENU_MAX_MISSES,
  runFirstRunProviderSetup,
  type SetupKeysIO,
} from './setup-keys.js';
import { startFakeOpenAiCompatibleApi } from '../ux-sim/service-key-setup.js';
import { withSimClock } from '../ux-sim/fake-clock.js';

test('first-run no-provider flow reaches ready through the production Codex OAuth fetch seam', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-keys-oauth-'));
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  process.env.CODEX_HOME = join(root, 'codex');
  const paths: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    paths.push(url);
    if (url.endsWith('/deviceauth/usercode')) return Response.json({ user_code: 'ABCD-1234', device_auth_id: 'device-fixture', interval: 0 });
    if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'auth-fixture', code_verifier: 'verifier-fixture' });
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'sentinel-access-token', refresh_token: 'sentinel-refresh-token', expires_in: 3600 });
    throw new Error(`unexpected OAuth endpoint ${url}`);
  }) as unknown as typeof fetch;
  const output: string[] = [];
  const io: SetupKeysIO = { ask: async () => '1', askSecret: async () => '', print: line => output.push(line) };
  try {
    const configPath = join(root, 'config.json');
    const result = await runFirstRun({
      path: configPath,
      config: buildUserConfig(configPath),
      isTTY: true,
      detectProviders: async () => [],
      setupWhenNoProvider: config => runFirstRunProviderSetup(io, {
        config,
        loginWithCodex: options => loginWithCodex({
          ...options,
          fetchImpl,
          sleepImpl: async () => {},
          pollIntervalMs: 0,
          maxWaitMs: 1000,
          mirrorCodex: false,
        }),
      }),
      print: line => output.push(line),
    });
    expect(result).toEqual({ outcome: 'ready', provider: 'openai-codex', inputs: 1 });
    expect(buildUserConfig(configPath).onboarding.ready).toBe(true);
    expect(loadTokens('openai-codex')?.tokens.accessToken).toBe('sentinel-access-token');
    expect(paths.map(path => new URL(path).pathname)).toEqual([
      '/api/accounts/deviceauth/usercode', '/api/accounts/deviceauth/token', '/oauth/token',
    ]);
    expect(output.join('\n')).toContain('Codex 로그인 완료');
    expect(output.join('\n')).not.toContain('sentinel-access-token');
    expect(output.join('\n')).not.toContain('sentinel-refresh-token');
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('first-run API-key setup selects the detected provider and keeps the key out of config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-keys-api-'));
  const fake = await startFakeOpenAiCompatibleApi('ok');
  const env: NodeJS.ProcessEnv = { HOME: root };
  const cacheDir = join(root, '.cache');
  const output: string[] = [];
  let selectingProvider = false;
  const io: SetupKeysIO = {
    ask: async prompt => {
      if (prompt.startsWith('선택:')) return '2';
      if (prompt.startsWith('기본 공급자 번호')) { selectingProvider = true; return '1'; }
      return '';
    },
    askSecret: async prompt => prompt.includes('XAI_API_KEY') ? 'api-key-sentinel' : '',
    print: line => output.push(line),
  };
  try {
    const configPath = join(root, 'config.json');
    const config = buildUserConfig(configPath);
    config.llm.rotation = [{ provider: 'grok', baseUrl: fake.baseUrl }];
    const result = await runFirstRun({
      path: configPath,
      config,
      env,
      isTTY: true,
      detectProviders: async () => [],
      setupWhenNoProvider: setupConfig => runFirstRunProviderSetup(io, { config: setupConfig, env, cacheDir, loginWithCodex }),
      print: line => output.push(line),
    });
    expect(result).toEqual({ outcome: 'ready', provider: 'grok', inputs: 1 });
    expect(selectingProvider).toBe(true);
    expect(env.XAI_API_KEY).toBe('api-key-sentinel');
    expect(fake.requests()).toBe(1);
    expect(buildUserConfig(configPath).llm.apiKey).toBeUndefined();
    expect(output.join('\n')).not.toContain('api-key-sentinel');
  } finally {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('first-run setup menu re-asks parser misses, then asks for setup without recording ready; blank Enter still skips', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-keys-menu-misses-'));
  const output: string[] = [];
  const answers = ['4', '1e0', '１'];
  const io: SetupKeysIO = {
    ask: async () => answers.shift() ?? '',
    askSecret: async () => '',
    print: line => output.push(line),
  };
  try {
    const configPath = join(root, 'misses.json');
    const config = buildUserConfig(configPath);
    const result = await runFirstRun({
      path: configPath,
      config,
      isTTY: true,
      detectProviders: async () => [],
      setupWhenNoProvider: setupConfig => runFirstRunProviderSetup(io, { config: setupConfig, loginWithCodex }),
      print: line => output.push(line),
    });
    expect(result).toEqual({ outcome: 'needs-llm', inputs: 1 });
    expect(output.filter(line => line === FIRST_RUN_PROVIDER_SETUP_MENU_HEADING)).toHaveLength(FIRST_RUN_PROVIDER_SETUP_MENU_MAX_MISSES);
    expect(output.some(line => line.includes('eln setup llm'))).toBe(true);
    expect(output).not.toContain('LLM 없이 첫 화면을 엽니다. LLM 기능은 사용할 수 없습니다. 다시 설정: `elanous setup keys` 또는 `elanous login openai-codex`.');
    expect(config.onboarding.ready).toBeUndefined();

    const skipPath = join(root, 'skip.json');
    const skipConfig = buildUserConfig(skipPath);
    const skipResult = await runFirstRun({
      path: skipPath,
      config: skipConfig,
      isTTY: true,
      detectProviders: async () => [],
      setupWhenNoProvider: setupConfig => runFirstRunProviderSetup({ ...io, ask: async () => '' }, { config: setupConfig, loginWithCodex }),
      print: line => output.push(line),
    });
    expect(skipResult).toEqual({ outcome: 'ready', inputs: 1 });
    expect(buildUserConfig(skipPath).onboarding.ready).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('production first-run shows fake-clock headless progress and aborts the real OAuth poll', async () => {
  const root = mkdtempSync(join(tmpdir(), 'headless-login-cancel-'));
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  process.env.CODEX_HOME = join(root, 'codex');
  const printed: string[] = [];
  const updates: string[] = [];
  let interrupt: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  let pollStarted = false;
  let pollAborted = false;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.endsWith('/deviceauth/usercode')) {
      await new Promise<void>(resolve => setTimeout(resolve, 1_100));
      return Response.json({ user_code: 'ABCD-1234', device_auth_id: 'device-fixture', interval: 0 });
    }
    if (url.endsWith('/deviceauth/token')) {
      pollStarted = true;
      return new Promise<Response>((_resolve, reject) => {
        const pollSignal = init?.signal;
        if (pollSignal?.aborted) {
          pollAborted = true;
          reject(pollSignal.reason ?? new DOMException('Aborted', 'AbortError'));
          return;
        }
        pollSignal?.addEventListener('abort', () => {
          pollAborted = true;
          reject(pollSignal.reason ?? new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    }
    throw new Error('unexpected OAuth endpoint');
  }) as unknown as typeof fetch;
  const io: SetupKeysIO = {
    ask: async () => '1',
    print: (line: string) => printed.push(line),
    updateLine: (line: string) => updates.push(line),
    finishLine: () => {},
    onInterrupt: (handler: () => void) => { interrupt = handler; return () => { interrupt = undefined; }; },
  };
  try {
    const configPath = join(root, 'config.json');
    await withSimClock(Date.parse('2026-11-02T00:00:00Z'), async clock => {
      const resultPromise = runFirstRun({
        path: configPath,
        config: buildUserConfig(configPath),
        isTTY: true,
        detectProviders: async () => [],
        setupWhenNoProvider: config => runFirstRunProviderSetup(io, {
          config,
          isHeadless: () => true,
          loginWithCodex: options => {
            signal = options?.signal;
            return loginWithCodex({
              ...options,
              fetchImpl,
              pollIntervalMs: 1_000,
              maxWaitMs: 10_000,
              mirrorCodex: false,
            });
          },
        }),
        print: line => printed.push(line),
      });
      for (let turn = 0; turn < 8 && !signal; turn++) await Promise.resolve();
      expect(updates).toEqual([]);
      expect(printed.some(line => line.includes('ABCD-1234'))).toBe(false);
      clock.tick(1_100);
      for (let turn = 0; turn < 8 && updates.length === 0; turn++) await Promise.resolve();
      expect(updates.length).toBeGreaterThan(0);
      expect(updates[0]).toContain('0초');
      expect(updates[0]).toContain('Ctrl-C');
      expect(printed.filter(line => line.includes('ABCD-1234'))).toHaveLength(1);
      clock.tick(1_000);
      for (let turn = 0; turn < 8 && !pollStarted; turn++) await Promise.resolve();
      expect(pollStarted).toBe(true);
      expect(updates.at(-1)).toContain('1초');
      interrupt?.();
      const result = await resultPromise;
      expect(result.outcome).toBe('ready');
      expect(signal?.aborted).toBe(true);
      expect(pollAborted).toBe(true);
      expect(buildUserConfig(configPath).onboarding.ready).toBeUndefined();
      expect(printed.some(line => line.includes('Codex 로그인을 건너뛰었습니다'))).toBe(true);
      expect(printed.some(line => line.includes('elanous login openai-codex'))).toBe(true);
      expect(printed.some(line => line.includes('완료하지 못했습니다'))).toBe(false);
      expect(clock.pendingTimers()).toBe(0);
    });
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
    rmSync(root, { recursive: true, force: true });
  }
});


test('headless setup stops refreshing elapsed wait when token exchange begins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'headless-login-exchange-'));
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  process.env.CODEX_HOME = join(root, 'codex');
  const updates: string[] = [];
  let interrupt: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  type LoginProgress = NonNullable<NonNullable<Parameters<typeof loginWithCodex>[0]>['onProgress']>;
  let reportProgress: LoginProgress | undefined;
  const io: SetupKeysIO = {
    ask: async () => '1',
    print: () => {},
    updateLine: line => updates.push(line),
    finishLine: () => {},
    onInterrupt: handler => { interrupt = handler; return () => { interrupt = undefined; }; },
  };
  try {
    await withSimClock(Date.parse('2026-11-02T00:00:00Z'), async clock => {
      const resultPromise = runFirstRunProviderSetup(io, {
        config: buildUserConfig(join(root, 'config.json')),
        isHeadless: () => true,
        loginWithCodex: async options => {
          signal = options?.signal;
          reportProgress = options?.onProgress;
          reportProgress?.({ type: 'user_code', userCode: 'ABCD-1234', loginUrl: 'https://auth.openai.com/codex/device' });
          reportProgress?.({ type: 'polling', pollAttempt: 1 });
          return new Promise(resolve => {
            if (signal?.aborted) return resolve({} as never);
            signal?.addEventListener('abort', () => resolve({} as never), { once: true });
          });
        },
      });
      for (let turn = 0; turn < 8 && updates.length < 2; turn++) await Promise.resolve();
      expect(updates[0]).toContain('0초');
      expect(updates[0]).toContain('Ctrl-C');
      clock.tick(1_000);
      expect(updates.at(-1)).toContain('1초');
      const beforeExchange = updates.length;
      reportProgress?.({ type: 'exchanging' });
      expect(updates.length).toBe(beforeExchange + 1);
      expect(updates.at(-1)).toContain('로그인 확인 중');
      const afterExchange = updates.length;
      clock.tick(2_000);
      expect(updates).toHaveLength(afterExchange);
      expect(clock.pendingTimers()).toBe(0);
      interrupt?.();
      expect(await resultPromise).toBeNull();
      expect(signal?.aborted).toBe(true);
    });
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
    rmSync(root, { recursive: true, force: true });
  }
});
