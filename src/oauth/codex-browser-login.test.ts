import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { browserLaunchCommand, loginWithCodexBrowser } from './codex-browser-login.js';
import { CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_TOKEN_URL } from './codex.js';
import { loadTokens } from './store.js';

let root: string;
let previousXdg: string | undefined;
let previousCodexHome: string | undefined;
beforeEach(() => {
  previousXdg = process.env.XDG_CONFIG_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  root = mkdtempSync(join(tmpdir(), 'codex-browser-'));
  process.env.XDG_CONFIG_HOME = root;
  process.env.CODEX_HOME = join(root, 'codex');
});
afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(root, { recursive: true, force: true });
});

const jwt = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

test('Windows browser launcher hands the complete OAuth URL to the URL handler without cmd parsing', () => {
  const url = 'https://auth.openai.com/oauth/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=long%25value';
  expect(browserLaunchCommand(url, 'win32')).toEqual({
    command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url],
  });
});

test('default launcher handles the callback while xdg-open is still running', async () => {
  if (process.platform !== 'linux') return;
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const openedFile = join(root, 'opened');
  const launcher = join(bin, 'xdg-open');
  writeFileSync(launcher, `#!/bin/sh\nprintf '%s' "$1" > '${openedFile}'\nsleep 4\n`);
  chmodSync(launcher, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  try {
    const startedAt = Date.now();
    const run = loginWithCodexBrowser({
      preferredPort: 0, timeoutMs: 2_500,
      fetchImpl: (async () => new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R' }), { status: 200 })) as unknown as typeof fetch,
    });
    let openedUrl: string | undefined;
    for (let i = 0; i < 100 && !openedUrl; i++) {
      if (existsSync(openedFile)) openedUrl = readFileSync(openedFile, 'utf8');
      else await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(openedUrl).toBeTruthy();
    const auth = new URL(openedUrl!);
    const redirect = auth.searchParams.get('redirect_uri')!;
    expect((await fetch(`${redirect}?code=c&state=${auth.searchParams.get('state')}`)).status).toBe(200);
    expect((await run).tokens.accessToken).toBe('A');
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('a launcher that exits non-zero right away fails fast instead of waiting for the callback timeout', async () => {
  if (process.platform === 'win32') return;
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const name of ['xdg-open', 'open']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 3\n');
    chmodSync(join(bin, name), 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  try {
    const startedAt = Date.now();
    await expect(loginWithCodexBrowser({
      preferredPort: 0, timeoutMs: 30_000,
      fetchImpl: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
    })).rejects.toThrow('browser-unavailable');
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('PKCE browser callback exchanges code, saves device-flow-shaped tokens and displays success', async () => {
  let visit!: (url: string) => void;
  const opened = new Promise<string>((resolve) => { visit = resolve; });
  let form: URLSearchParams | undefined;
  const run = loginWithCodexBrowser({
    preferredPort: 0,
    openBrowser: (url) => { visit(url); return true; },
    fetchImpl: (async (url: string, init?: RequestInit) => {
      expect(url).toBe(CODEX_OAUTH_TOKEN_URL);
      form = new URLSearchParams(init?.body as string);
      return new Response(JSON.stringify({
        access_token: 'access-secret', refresh_token: 'refresh-secret',
        id_token: jwt({ chatgpt_account_id: 'acct-1' }), expires_in: 3600,
        token_type: 'Bearer', scope: 'openid profile email offline_access',
      }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const auth = new URL(await opened);
  const redirect = new URL(auth.searchParams.get('redirect_uri')!);
  expect(auth.origin + auth.pathname).toBe('https://auth.openai.com/oauth/authorize');
  expect(auth.searchParams.get('client_id')).toBe(CODEX_OAUTH_CLIENT_ID);
  expect(auth.searchParams.get('response_type')).toBe('code');
  expect(auth.searchParams.get('scope')).toBe('openid profile email offline_access');
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  expect(auth.searchParams.get('originator')).toBe('codex_cli_rs');
  expect(auth.searchParams.get('id_token_add_organizations')).toBe('true');
  expect(auth.searchParams.get('codex_cli_simplified_flow')).toBe('true');
  expect(redirect.hostname).toBe('localhost');
  expect(redirect.pathname).toBe('/auth/callback');
  const response = await fetch(`${redirect}?code=authorization-secret&state=${auth.searchParams.get('state')}`);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('로그인됨 — 터미널로 돌아가세요');
  const saved = await run;
  expect(form?.get('code')).toBe('authorization-secret');
  expect(form?.get('redirect_uri')).toBe(redirect.toString());
  expect(form?.get('client_id')).toBe(CODEX_OAUTH_CLIENT_ID);
  expect(form?.get('grant_type')).toBe('authorization_code');
  expect(auth.searchParams.get('code_challenge')).toBe(createHash('sha256').update(form!.get('code_verifier')!).digest('base64url'));
  expect(saved.authMode).toBe('chatgpt');
  expect(readFileSync(join(root, 'elanous', 'auth.json'), 'utf8')).not.toContain('authorization-secret');
  expect(readFileSync(join(root, 'elanous', 'auth.json'), 'utf8')).not.toContain(form!.get('code_verifier')!);
  expect(loadTokens('openai-codex')?.tokens).toMatchObject({
    accessToken: 'access-secret', refreshToken: 'refresh-secret',
    idToken: jwt({ chatgpt_account_id: 'acct-1' }), tokenType: 'Bearer',
    scope: 'openid profile email offline_access',
  });
});

test('wrong state is rejected without exchange or token storage; correct state may still finish', async () => {
  let visit!: (url: string) => void;
  const opened = new Promise<string>(resolve => { visit = resolve; });
  let exchanges = 0;
  const run = loginWithCodexBrowser({
    preferredPort: 0, openBrowser: url => { visit(url); return true; },
    fetchImpl: (async () => { exchanges++; return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R' }), { status: 200 }); }) as unknown as typeof fetch,
  });
  const auth = new URL(await opened);
  const redirect = auth.searchParams.get('redirect_uri')!;
  const wrong = await fetch(`${redirect}?code=secret&state=wrong`);
  expect(wrong.status).toBe(400);
  expect(exchanges).toBe(0);
  expect(loadTokens('openai-codex')).toBeNull();
  expect((await fetch(`${redirect}?code=secret&state=${auth.searchParams.get('state')}`)).status).toBe(200);
  await run;
  expect(exchanges).toBe(1);
});

test('occupied default port uses an available loopback port', async () => {
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(1455, '127.0.0.1', resolve));
  try {
    let visit!: (url: string) => void;
    const opened = new Promise<string>(resolve => { visit = resolve; });
    const run = loginWithCodexBrowser({
      openBrowser: url => { visit(url); return true; },
      fetchImpl: (async () => new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R' }), { status: 200 })) as unknown as typeof fetch,
    });
    const auth = new URL(await opened);
    const redirect = auth.searchParams.get('redirect_uri')!;
    expect(new URL(redirect).port).not.toBe('1455');
    expect((await fetch(`${redirect}?code=c&state=${auth.searchParams.get('state')}`)).status).toBe(200);
    await run;
  } finally { blocker.close(); }
});

test('browser failure and timeout fail cleanly without tokens', async () => {
  await expect(loginWithCodexBrowser({ preferredPort: 0, openBrowser: () => false })).rejects.toThrow('browser-unavailable');
  await expect(loginWithCodexBrowser({ preferredPort: 0, openBrowser: () => true, timeoutMs: 10 })).rejects.toThrow('timeout');
  expect(loadTokens('openai-codex')).toBeNull();
});
