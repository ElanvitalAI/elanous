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
      setupWhenNoProvider: setupConfig => runFirstRunProviderSetup(io, { config: setupConfig, env, cacheDir }),
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
      setupWhenNoProvider: setupConfig => runFirstRunProviderSetup(io, { config: setupConfig }),
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
      setupWhenNoProvider: setupConfig => runFirstRunProviderSetup({ ...io, ask: async () => '' }, { config: setupConfig }),
      print: line => output.push(line),
    });
    expect(skipResult).toEqual({ outcome: 'ready', inputs: 1 });
    expect(buildUserConfig(skipPath).onboarding.ready).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
