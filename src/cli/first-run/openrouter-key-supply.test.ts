import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig } from '../../user-config.js';
import { loginWithCodex } from '../../oauth/codex.js';
import { runFirstRunProviderSetup } from '../setup-keys.js';
import { openRouterKeySuffix, openRouterPkce, registerOpenRouterByPhone, scanOpenRouterKeyCandidates } from './openrouter-key-supply.js';

test('short OpenRouter key candidates never reveal their entire value', () => {
  expect(openRouterKeySuffix('abcd')).toBe('••••');
  expect(openRouterKeySuffix('abcde')).toBe('bcde');
});

test('OpenRouter first run offers only final four from env and fake .env, then imports confirmed candidate once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'or-key-supply-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home); mkdirSync(project);
  writeFileSync(join(project, '.env'), 'OPENROUTER_API_KEY=dotenv-secret-9876\n');
  const env = { OPENROUTER_API_KEY: 'environment-secret-1234' };
  const configPath = join(root, 'config.json');
  const options = { config: buildUserConfig(configPath), env, homeDir: home, cwd: project, configPath, loginWithCodex,
    readOpenRouterSecret: async () => undefined,
    verifier: async () => ({ success: true as const, verification: 'verified' as const }),
    saveCredentialSlotBatch: async (values: Readonly<Record<string, string>>) => { saved.push(values); } };
  const saved: Array<Readonly<Record<string, string>>> = [];
  const output: string[] = [];
  const answers = ['2', 'n', 'y', '1'];
  try {
    const found = scanOpenRouterKeyCandidates(options);
    expect(found.map(row => row.lastFour)).toEqual(['1234', '9876']);
    const result = await runFirstRunProviderSetup({ ask: async () => answers.shift() ?? '', print: line => output.push(line) }, options);
    expect(result).toMatchObject({ provider: 'openrouter' });
    expect(saved).toEqual([{ 'cred:openrouter.api_key': 'dotenv-secret-9876' }]);
    expect(output.join('\n')).toContain('끝 4자리 9876');
    expect(output.join('\n')).not.toContain('dotenv-secret-9876');
    expect(output.join('\n')).not.toContain('environment-secret-1234');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('headless OpenRouter PKCE exchanges one-use code with S256 and never prints returned key', async () => {
  const output: string[] = [];
  const key = 'oauth-secret-never-print';
  const secretPrompts: string[] = [];
  const result = await openRouterPkce({ ask: async () => { throw new Error('code must use hidden input'); },
    askSecret: async prompt => { secretPrompts.push(prompt); return 'one-use-code'; }, print: line => output.push(line) }, {
    headless: true,
    fetch: (async (url, init) => {
      expect(url).toBe('https://openrouter.ai/api/v1/auth/keys');
      const body = JSON.parse(String(init?.body));
      expect(body.code).toBe('one-use-code');
      expect(body.code_challenge_method).toBe('S256');
      const authorize = new URL(output[0]!.slice('OpenRouter 로그인: '.length));
      expect(authorize.searchParams.get('callback_url')).toBeNull();
      expect(authorize.searchParams.get('code_challenge'))
        .toBe(createHash('sha256').update(body.code_verifier).digest('base64url'));
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
      return Response.json({ key });
    }) as typeof fetch,
  });
  expect(result).toBe(key);
  expect(secretPrompts).toHaveLength(1);
  expect(output.join('\n')).toContain('승인 화면에 표시된 일회용 코드');
  expect(output.join('\n')).not.toContain(key);
});

test('OpenRouter first run offers OAuth then phone QR before hidden paste and saves OAuth to canonical slot', async () => {
  const output: string[] = [];
  const saved: Array<Readonly<Record<string, string>>> = [];
  const answers = ['2', '1', '1'];
  let oauthCalls = 0;
  const result = await runFirstRunProviderSetup({ ask: async () => answers.shift() ?? '', print: line => output.push(line) }, {
    config: buildUserConfig(), env: {}, homeDir: '/nonexistent-home-for-openrouter-test', cwd: '/nonexistent-project-for-openrouter-test',
    configPath: '/nonexistent-config-for-openrouter-test', loginWithCodex,
    readOpenRouterSecret: async () => undefined,
    openRouterPkce: async () => { oauthCalls++; return 'oauth-secret-never-print'; },
    verifier: async () => ({ success: true, verification: 'verified' }),
    saveCredentialSlotBatch: async values => { saved.push(values); },
  });
  expect(oauthCalls).toBe(1);
  expect(result).toMatchObject({ provider: 'openrouter' });
  expect(saved).toEqual([{ 'cred:openrouter.api_key': 'oauth-secret-never-print' }]);
  expect(output.join('\n')).toContain('1 브라우저 OAuth 로그인 (권장) · 2 폰 QR/PWA 등록 · 3 숨김 붙여넣기');
  expect(output.join('\n')).not.toContain('oauth-secret-never-print');
});

test('choosing the existing Nexus key overrides a stale env key', async () => {
  const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: 'rejected-env-key' };
  const answers = ['2', 'y', '1'];
  const result = await runFirstRunProviderSetup({ ask: async () => answers.shift() ?? '', print: () => {} }, {
    config: buildUserConfig(), env, homeDir: '/nonexistent-home-for-openrouter-test', cwd: '/nonexistent-project-for-openrouter-test',
    configPath: '/nonexistent-config-for-openrouter-test', loginWithCodex,
    readOpenRouterSecret: async () => 'chosen-nexus-key',
  });
  expect(result).toMatchObject({ provider: 'openrouter' });
  expect(env.OPENROUTER_API_KEY).toBe('chosen-nexus-key');
});

test('rejecting an env key and choosing phone registration activates the registered key', async () => {
  const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: 'rejected-env-key' };
  const answers = ['2', 'n', '2', '1'];
  let registered = false;
  const result = await runFirstRunProviderSetup({ ask: async () => answers.shift() ?? '', print: () => {} }, {
    config: buildUserConfig(), env, homeDir: '/nonexistent-home-for-openrouter-test', cwd: '/nonexistent-project-for-openrouter-test',
    configPath: '/nonexistent-config-for-openrouter-test', loginWithCodex,
    readOpenRouterSecret: async () => registered ? 'chosen-phone-key' : undefined,
    registerOpenRouterByPhone: async () => { registered = true; return true; },
  });
  expect(result).toMatchObject({ provider: 'openrouter' });
  expect(env.OPENROUTER_API_KEY).toBe('chosen-phone-key');
});

test('declining an env key and skipping supply leaves no rejected key active', async () => {
  const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: 'rejected-env-key' };
  const answers = ['2', 'n', ''];
  const result = await runFirstRunProviderSetup({ ask: async () => answers.shift() ?? '', print: () => {} }, {
    config: buildUserConfig(), env, homeDir: '/nonexistent-home-for-openrouter-test', cwd: '/nonexistent-project-for-openrouter-test',
    configPath: '/nonexistent-config-for-openrouter-test', loginWithCodex,
    readOpenRouterSecret: async () => undefined,
  });
  expect(result).toEqual({ kind: 'needs-llm' });
  expect(env.OPENROUTER_API_KEY).toBeUndefined();
});

test('phone QR completion uses the registered Nexus slot without a second credential write', async () => {
  const answers = ['2', '2', '1'];
  let phoneCalls = 0;
  let writes = 0;
  let registered = false;
  const result = await runFirstRunProviderSetup({ ask: async () => answers.shift() ?? '', print: () => {} }, {
    config: buildUserConfig(), env: {}, homeDir: '/nonexistent-home-for-openrouter-test', cwd: '/nonexistent-project-for-openrouter-test',
    configPath: '/nonexistent-config-for-openrouter-test', loginWithCodex,
    readOpenRouterSecret: async () => registered ? 'registered-phone-key' : undefined,
    registerOpenRouterByPhone: async () => { phoneCalls++; registered = true; return true; },
    saveCredentialSlot: async () => { writes++; },
  });
  expect(result).toMatchObject({ provider: 'openrouter' });
  expect(phoneCalls).toBe(1);
  expect(writes).toBe(0);
});

test('phone registration QR uses the live Nexus tailnet address and one scoped link', async () => {
  const output: string[] = [];
  let qrUrl = '';
  let revoked = '';
  const registered = await registerOpenRouterByPhone({ ask: async () => '', print: line => output.push(line) }, {
    config: buildUserConfig(), loginWithCodex,
    resolvePwa: () => ({ status: 'registered', loopback: 'http://127.0.0.1:3000/app/',
      url: 'https://nexus.example.ts.net/app/', source: 'tailnet' }),
    issueLink: slot => { expect(slot).toBe('cred:openrouter.api_key'); return { token: 'scoped-token', expiresAt: '2030-01-01T00:00:00Z' }; },
    revokeLink: token => { revoked = token; return true; },
    renderQr: link => { qrUrl = link; return '[QR pixels]'; },
    registrationComplete: token => token === 'scoped-token',
    initializeCredentialBackend: () => {},
    listCredentialSlots: async () => [{ id: 'cred:openrouter.api_key', service: 'openrouter', label: 'OpenRouter',
      field: 'api_key', setupUrl: 'https://openrouter.ai/keys', present: true }],
  });
  expect(registered).toBe(true);
  expect(qrUrl).toBe('https://nexus.example.ts.net/app/credentials/register/claim/#t=scoped-token');
  expect(revoked).toBe('scoped-token');
  expect(output.join('\n')).toContain('[QR pixels]');
});

test('phone QR rejects an already-present slot when this link never completed registration', async () => {
  const output: string[] = [];
  const registered = await registerOpenRouterByPhone({ ask: async () => '', print: line => output.push(line) }, {
    config: buildUserConfig(), loginWithCodex,
    resolvePwa: () => ({ status: 'registered', loopback: 'http://127.0.0.1:3000/app/',
      url: 'https://nexus.example.ts.net/app/', source: 'tailnet' }),
    issueLink: () => ({ token: 'unused-link', expiresAt: '2030-01-01T00:00:00Z' }),
    revokeLink: () => true,
    renderQr: () => '[QR pixels]',
    registrationComplete: () => false,
    initializeCredentialBackend: () => {},
    listCredentialSlots: async () => [{ id: 'cred:openrouter.api_key', service: 'openrouter', label: 'OpenRouter',
      field: 'api_key', setupUrl: 'https://openrouter.ai/keys', present: true }],
  });
  expect(registered).toBe(false);
});

test('loopback OpenRouter PKCE rejects wrong state and exchanges only the matching callback', async () => {
  const key = 'loopback-private-key';
  let exchanges = 0;
  const output: string[] = [];
  const result = await openRouterPkce({ ask: async () => '', print: line => output.push(line) }, {
    headless: false,
    openBrowser: async authorization => {
      const url = new URL(authorization);
      const callback = new URL(url.searchParams.get('callback_url')!);
      callback.searchParams.set('state', 'wrong-state');
      callback.searchParams.set('code', 'forged-code');
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set('state', url.searchParams.get('state')!);
      callback.searchParams.set('code', 'valid-code');
      expect((await fetch(callback)).status).toBe(200);
      return true;
    },
    fetch: (async (_url, init) => {
      exchanges++;
      expect(JSON.parse(String(init?.body)).code).toBe('valid-code');
      return Response.json({ key });
    }) as typeof fetch,
  });
  expect(result).toBe(key);
  expect(exchanges).toBe(1);
  expect(output.join('\n')).not.toContain(key);
});
