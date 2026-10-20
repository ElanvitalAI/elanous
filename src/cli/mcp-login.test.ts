import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistDiscoveredIssuer, runMcpLogin } from './mcp-login.js';
import { loadTokens } from '../oauth/store.js';
import type { McpOAuthFetch } from '../mcp/mcp-oauth.js';
import { McpClient } from '../mcp/client.js';
import { reloadUserConfig, saveUserConfig } from '../user-config.js';

// 🔴 이 파일이 무는 사고 (2026-09-10 실물):
//
//   `elanous mcp login krea` 가 `✓ credentials saved for 'krea' (https://www.krea.ai)`
//   를 «찍고 exit 0» 했는데, 데몬의 krea 도구 수는 0 이었다. 자격증명 저장소는
//   issuer 를 키로 쓰지만 데몬은 그 issuer 를 오직 config 의
//   `mcp.servers[].oauthIssuer` 에서만 얻고, 로그인은 그 칸을 «안 적었다».
//   사람이 config.json 을 손으로 고쳐야만 이어졌다.
//
// ⛔ 그래서 이 시험은 「함수가 true 를 내나」가 아니라 ***「디스크의 config.json
//    파일에 그 두 줄이 실제로 남나」***를 묻는다 — 그것이 데몬이 읽는 자리다.

function seedConfig(servers: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-login-persist-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ mcp: { servers } }, null, 2));
  return path;
}

/** 테스트가 끝나면 캐시를 운영 경로로 되돌린다 — 이 파일이 다음 파일의
 *  config 를 오염시키지 않게. */
function restoreConfigCache(): void {
  reloadUserConfig();
}

describe('persistDiscoveredIssuer', () => {
  test('발견한 issuer/tokenEndpoint 가 디스크 config.json 에 실제로 남는다', () => {
    const path = seedConfig([{ id: 'krea', transport: 'http', url: 'https://api.krea.ai/mcp', enabled: true }]);
    const result = persistDiscoveredIssuer({
      serverId: 'krea',
      issuer: 'https://www.krea.ai',
      tokenEndpoint: 'https://www.krea.ai/auth/v1/oauth/token',
      configPath: path,
    });
    restoreConfigCache();
    expect(result.error).toBeUndefined();
    expect(result.written).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { mcp: { servers: Record<string, unknown>[] } };
    const row = onDisk.mcp.servers.find((s) => s.id === 'krea');
    expect(row?.oauthIssuer).toBe('https://www.krea.ai');
    expect(row?.oauthTokenEndpoint).toBe('https://www.krea.ai/auth/v1/oauth/token');
  });

  test('같은 값이면 다시 쓰지 않는다 (written=false · 오류 아님)', () => {
    const path = seedConfig([{ id: 'krea', transport: 'http', url: 'https://api.krea.ai/mcp', enabled: true, oauthIssuer: 'https://www.krea.ai' }]);
    const result = persistDiscoveredIssuer({ serverId: 'krea', issuer: 'https://www.krea.ai', configPath: path });
    restoreConfigCache();
    expect(result.written).toBe(false);
    expect(result.error).toBeUndefined();
  });

  test('config 에 없는 서버 id 면 이름을 댄 오류를 낸다 (조용히 0 으로 접지 않는다)', () => {
    const path = seedConfig([{ id: 'higgsfield', transport: 'http', url: 'https://x/mcp', enabled: true }]);
    const result = persistDiscoveredIssuer({ serverId: 'krea', issuer: 'https://www.krea.ai', configPath: path });
    restoreConfigCache();
    expect(result.written).toBe(false);
    expect(result.error).toContain('krea');
  });

  // ⭐⭐ 이 시험이 진짜 반증이다 — 되쓰기는 `saveUserConfig` 를 통과해야 하고,
  //     그 함수는 typed 섹션을 raw 에서 «지운다». mcp 가 그 목록에 «들어가면»
  //     이 두 줄이 저장에서 조용히 사라진다. 그때 이 시험이 빨개진다.
  test('saveUserConfig 라운드트립이 oauthIssuer 를 삼키지 않는다', () => {
    const path = seedConfig([{ id: 'krea', transport: 'http', url: 'https://api.krea.ai/mcp', enabled: true, oauthIssuer: 'https://www.krea.ai' }]);
    const cfg = reloadUserConfig(path);
    saveUserConfig(cfg, path);
    restoreConfigCache();
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { mcp?: { servers?: Record<string, unknown>[] } };
    const row = onDisk.mcp?.servers?.find((s) => s.id === 'krea');
    expect(row?.oauthIssuer).toBe('https://www.krea.ai');
  });
});

const issuer = 'https://auth.example';
const mcpUrl = 'https://mcp.example/mcp';
const json = (body: object, status = 200, headers: Record<string, string> = {}) => ({
  status, headers: { get: (key: string) => headers[key.toLowerCase()] ?? null }, text: async () => JSON.stringify(body),
});

function loginFixture(device: boolean) {
  const storePath = join(mkdtempSync(join(tmpdir(), 'mcp-login-')), 'auth.json');
  const calls: Array<{ url: string; body: string }> = [];
  const fetch: McpOAuthFetch = async (url, init) => {
    calls.push({ url, body: init?.body ?? '' });
    if (url === mcpUrl) return json({}, 401, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example/meta", scope="read"' });
    if (url === 'https://mcp.example/meta') return json({ resource: mcpUrl, authorization_servers: [issuer] });
    if (url === `${issuer}/.well-known/oauth-authorization-server`) return json({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`, code_challenge_methods_supported: ['S256'],
      ...(device ? { device_authorization_endpoint: `${issuer}/device` } : {}),
    });
    if (url === `${issuer}/register`) return json({ client_id: 'client' });
    if (url === `${issuer}/device`) return json({ device_code: 'device-secret', user_code: 'ABCD', verification_uri: `${issuer}/verify`, expires_in: 30, interval: 1 });
    if (url === `${issuer}/token`) return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    throw new Error(`unexpected URL ${url}`);
  };
  const lines: string[] = [];
  const persist: Array<{ issuer: string; tokenEndpoint?: string }> = [];
  return { fetch, calls, lines, persist, storePath, opts: {
    serverId: 'demo', fetch, storePath, browserEnv: { SSH_TTY: '1' }, browserPlatform: 'linux' as const,
    readConfigFn: () => ({ mcp: { servers: [{ id: 'demo', transport: 'http' as const, url: mcpUrl }] } }),
    out: { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) },
    persistDiscoveryFn: (value: { issuer: string; tokenEndpoint?: string }) => { persist.push(value); return { written: true }; },
  } };
}

test('local HTTP OAuth round trip: login, reuse, cancel, and MCP Bearer', async () => {
  const storePath = join(mkdtempSync(join(tmpdir(), 'mcp-login-http-')), 'auth.json');
  const requests: Array<{ phase: string; method: string; path: string; body: string; authorization?: string }> = [];
  let phase = 'first';
  let deny = false;
  let registrations = 0;
  let exchanges = 0;
  let base = '';
  const server = createServer(async (req, res) => {
    const path = req.url ?? '/';
    const body = await (async () => {
      let text = '';
      for await (const chunk of req) text += chunk.toString();
      return text;
    })();
    requests.push({ phase, method: req.method ?? '', path, body,
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
    const reply = (status: number, value: object, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    if (path === '/mcp') {
      if (req.headers.authorization !== `Bearer access-${exchanges}`) {
        reply(401, {}, { 'www-authenticate': `Bearer resource_metadata="${base}/meta", scope="read"` });
      } else {
        const rpc = JSON.parse(body) as { id?: number; method: string };
        if (rpc.method === 'notifications/initialized') { res.writeHead(202); res.end(); }
        else reply(200, { jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'local', version: '1' } }
          : { tools: [] } });
      }
    } else if (path === '/meta') reply(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    else if (path === '/.well-known/oauth-authorization-server') reply(200, {
      issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`, code_challenge_methods_supported: ['S256'],
    });
    else if (path === '/register') {
      const registration = JSON.parse(body) as { redirect_uris: string[] };
      expect(registration.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
      reply(201, { client_id: `client-${++registrations}` });
    } else if (path.startsWith('/authorize?')) {
      const url = new URL(path, base);
      const redirect = new URL(url.searchParams.get('redirect_uri')!);
      redirect.searchParams.set('state', url.searchParams.get('state')!);
      if (deny) redirect.searchParams.set('error', 'access_denied');
      else redirect.searchParams.set('code', `code-${exchanges + 1}`);
      res.writeHead(302, { location: redirect.toString() }); res.end();
    } else if (path === '/token') {
      const params = new URLSearchParams(body);
      const authorize = [...requests].reverse().find((entry) => entry.phase === phase && entry.path.startsWith('/authorize?'));
      const challenge = new URL(authorize!.path, base).searchParams.get('code_challenge');
      const actual = createHash('sha256').update(params.get('code_verifier')!).digest('base64url');
      if (params.get('grant_type') !== 'authorization_code' || challenge !== actual ||
          params.get('code') !== `code-${exchanges + 1}`) reply(400, { error: 'invalid_grant' });
      else reply(200, { access_token: `access-${++exchanges}`, refresh_token: `refresh-${exchanges}`, expires_in: 3600 });
    } else reply(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP listener has no port');
  base = `http://127.0.0.1:${address.port}`;
  const configPath = seedConfig([{ id: 'local', transport: 'http', url: `${base}/mcp`, enabled: true }]);
  const lines: string[] = [];
  const login = () => runMcpLogin({ serverId: 'local', storePath,
    readConfigFn: () => ({ mcp: { servers: [{ id: 'local', transport: 'http', url: `${base}/mcp` }] } }),
    persistDiscoveryFn: (input) => persistDiscoveredIssuer({ ...input, configPath }),
    browserEnv: { DISPLAY: ':1' }, browserPlatform: 'linux',
    approveBrowser: async (url) => { const response = await fetch(url); expect(response.status).toBe(deny ? 400 : 200); },
    out: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
  });
  try {
    const before = fs.existsSync(storePath) ? readFileSync(storePath, 'utf8') : null;
    expect(before).toBeNull();
    expect((await login()).exitCode).toBe(0);
    const first = readFileSync(storePath, 'utf8');
    expect(loadTokens(base, storePath)).toMatchObject({ accountUuid: 'client-1', tokens: { accessToken: 'access-1', refreshToken: 'refresh-1' } });
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { mcp: { servers: Array<{ oauthIssuer: string; oauthTokenEndpoint: string }> } };
    expect(config.mcp.servers[0]).toMatchObject({ oauthIssuer: base, oauthTokenEndpoint: `${base}/token` });
    phase = 'repeat';
    expect((await login()).exitCode).toBe(0);
    const repeated = readFileSync(storePath, 'utf8');
    expect(registrations).toBe(1);
    expect(repeated).not.toBe(first);
    expect(loadTokens(base, storePath)).toMatchObject({ accountUuid: 'client-1', tokens: { accessToken: 'access-2', refreshToken: 'refresh-2' } });
    phase = 'cancel'; deny = true;
    expect((await login()).exitCode).toBe(1);
    const cancelled = readFileSync(storePath, 'utf8');
    expect(cancelled).toBe(repeated);
    expect(exchanges).toBe(2);
    expect(requests.filter((entry) => entry.phase === 'first').map((entry) => entry.path.split('?')[0])).toEqual([
      '/mcp', '/meta', '/.well-known/oauth-authorization-server', '/meta',
      '/.well-known/oauth-authorization-server', '/meta', '/.well-known/oauth-authorization-server',
      '/register', '/authorize', '/token',
    ]);
    expect(requests.filter((entry) => entry.path === '/register')).toHaveLength(1);
    expect(requests.filter((entry) => entry.path === '/token')).toHaveLength(2);
    expect(requests.filter((entry) => entry.phase === 'cancel' && entry.path.startsWith('/authorize?'))).toHaveLength(1);
    phase = 'client';
    const client = new McpClient({ id: 'local', url: `${base}/mcp`, oauthIssuer: config.mcp.servers[0]!.oauthIssuer,
      oauthTokenEndpoint: config.mcp.servers[0]!.oauthTokenEndpoint, oauthStorePath: storePath, reconnectBackoffMs: [] });
    try {
      await client.start();
      expect(await client.listTools()).toEqual([]);
      expect(client.bearerSource).toEqual({ kind: 'oauth', issuer: base });
    } finally { await client.dispose(); }
    expect(requests.filter((entry) => entry.phase === 'client' && entry.path === '/mcp').every((entry) => entry.authorization === 'Bearer access-2')).toBe(true);
    expect(requests.filter((entry) => entry.phase === 'client' && entry.path === '/mcp')).toHaveLength(3);
    expect(readFileSync(storePath, 'utf8')).toBe(cancelled);
    console.log('HTTP-OAUTH-ROUNDTRIP ' + JSON.stringify({ requests: requests.map((entry) => ({
      phase: entry.phase, method: entry.method, path: entry.path.split('?')[0],
      hasBody: entry.body.length > 0, hasBearer: entry.authorization?.startsWith('Bearer ') ?? false,
    })), credentials: {
      beforeAbsent: before === null, firstStored: first.length > 0,
      repeatedRotated: repeated !== first, cancelPreserved: cancelled === repeated,
    }, config: { issuerPersisted: config.mcp.servers[0]!.oauthIssuer === base,
      tokenEndpointPersisted: config.mcp.servers[0]!.oauthTokenEndpoint === `${base}/token` },
    exitCodes: [0, 0, 1], cliLineCount: lines.length }));
  } finally {
    restoreConfigCache();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('runMcpLogin browser and device integration', () => {
  test('headless 401 → advertised device flow → stored token and config without browser callback', async () => {
    const f = loginFixture(true);
    let now = 0;
    const result = await runMcpLogin({ ...f.opts, deviceNow: () => now, deviceSleep: async (ms) => { now += ms; },
      openBrowser: async () => { throw new Error('browser must not open'); } });
    expect(result.exitCode).toBe(0);
    expect(f.lines).toContain('Device code: ABCD');
    expect(f.calls.some((call) => call.url === `${issuer}/device`)).toBe(true);
    const registration = f.calls.find((call) => call.url === `${issuer}/register`);
    const registered = JSON.parse(registration?.body ?? '{}') as Record<string, unknown>;
    expect(registered.grant_types).toEqual(['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']);
    expect(registered.response_types).toEqual([]);
    expect(registered.redirect_uris).toBeUndefined();
    expect(f.persist[0]?.issuer).toBe(issuer);
    expect(loadTokens(issuer, f.storePath)?.tokens.accessToken).toBe('access');
  });

  test('device registration succeeds against a server enforcing grant and response type consistency', async () => {
    const f = loginFixture(true);
    const strictFetch: McpOAuthFetch = async (url, init) => {
      if (url === `${issuer}/register`) {
        const request = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
        if (!Array.isArray(request.response_types) || request.response_types.length !== 0 ||
            !Array.isArray(request.grant_types) || request.grant_types.includes('authorization_code')) {
          return json({ error: 'invalid_client_metadata' }, 400);
        }
      }
      return f.fetch(url, init);
    };
    let now = 0;
    const result = await runMcpLogin({ ...f.opts, fetch: strictFetch,
      deviceNow: () => now, deviceSleep: async (ms) => { now += ms; } });
    expect(result.exitCode).toBe(0);
    expect(loadTokens(issuer, f.storePath)?.tokens.accessToken).toBe('access');
  });

  test('device-only authorization server without browser endpoint still grants a headless login', async () => {
    const f = loginFixture(true);
    const fetch: McpOAuthFetch = async (url, init) => {
      if (url === `${issuer}/.well-known/oauth-authorization-server`) return json({
        issuer, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`,
        device_authorization_endpoint: `${issuer}/device`,
      });
      return f.fetch(url, init);
    };
    let now = 0;
    const result = await runMcpLogin({ ...f.opts, fetch,
      deviceNow: () => now, deviceSleep: async (ms) => { now += ms; } });
    expect(result.exitCode).toBe(0);
    expect(loadTokens(issuer, f.storePath)?.tokens.accessToken).toBe('access');
  });

  test('device-only authorization server selects device flow with DISPLAY and no SSH', async () => {
    const f = loginFixture(true);
    let listener: Server | undefined;
    const fetchDeviceOnly: McpOAuthFetch = async (url, init) => {
      if (url === `${issuer}/.well-known/oauth-authorization-server`) return json({
        issuer, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`,
        device_authorization_endpoint: `${issuer}/device`,
      });
      if (url === `${issuer}/device`) expect(listener?.listening).toBe(false);
      return f.fetch(url, init);
    };
    let now = 0;
    let browserCalls = 0;
    const result = await runMcpLogin({ ...f.opts, fetch: fetchDeviceOnly,
      browserEnv: { DISPLAY: ':1' }, deviceNow: () => now,
      deviceSleep: async (ms) => { now += ms; },
      createListener: (handler) => { listener = createServer(handler); return listener; },
      approveBrowser: async () => { browserCalls++; throw new Error('browser must not approve'); },
      openBrowser: async () => { browserCalls++; throw new Error('browser must not open'); },
    });
    expect(result.exitCode).toBe(0);
    expect(listener?.listening).toBe(false);
    expect(browserCalls).toBe(0);
    expect(f.calls.some((call) => call.url === `${issuer}/device`)).toBe(true);
    expect(f.calls.some((call) => call.url === `${issuer}/token` && call.body.includes('grant_type=authorization_code'))).toBe(false);
    expect(f.persist[0]?.issuer).toBe(issuer);
    expect(loadTokens(issuer, f.storePath)?.tokens.accessToken).toBe('access');
  });

  test('browser path leaves state verification and token storage intact', async () => {
    const f = loginFixture(false);
    let approved = false;
    const result = await runMcpLogin({ ...f.opts, browserEnv: { DISPLAY: ':1' },
      approveBrowser: async (url) => {
        approved = true;
        const auth = new URL(url);
        const redirect = auth.searchParams.get('redirect_uri')!;
        const state = auth.searchParams.get('state')!;
        await fetch(`${redirect}?code=browser-code&state=${encodeURIComponent(state)}`);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(approved).toBe(true);
    const registered = JSON.parse(f.calls.find((call) => call.url === `${issuer}/register`)?.body ?? '{}') as Record<string, unknown>;
    expect(registered.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(registered.response_types).toEqual(['code']);
    expect(f.calls.find((call) => call.url === `${issuer}/token`)?.body).toContain('grant_type=authorization_code');
    expect(f.persist[0]?.issuer).toBe(issuer);
    expect(loadTokens(issuer, f.storePath)?.tokens.accessToken).toBe('access');
  });

  test('browser path stays preferred on desktop when device flow is also advertised', async () => {
    const f = loginFixture(true);
    let approved = false;
    const result = await runMcpLogin({ ...f.opts, browserEnv: { DISPLAY: ':1' },
      approveBrowser: async (url) => {
        approved = true;
        const auth = new URL(url);
        await fetch(`${auth.searchParams.get('redirect_uri')}?code=browser-code&state=${encodeURIComponent(auth.searchParams.get('state')!)}`);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(approved).toBe(true);
    expect(f.calls.some((call) => call.url === `${issuer}/device`)).toBe(false);
    expect(f.calls.find((call) => call.url === `${issuer}/token`)?.body).toContain('grant_type=authorization_code');
    expect(loadTokens(issuer, f.storePath)?.tokens.accessToken).toBe('access');
  });

  test('aside failure retains default browser fallback and rejects mismatched state', async () => {
    const f = loginFixture(false);
    const result = await runMcpLogin({ ...f.opts, browserEnv: { DISPLAY: ':1' },
      approveBrowser: async () => { throw new Error('aside unavailable'); },
      openBrowser: async (url) => {
        const auth = new URL(url);
        await fetch(`${auth.searchParams.get('redirect_uri')}?code=bad&state=wrong`);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(f.lines.join(' ')).toContain('state does not match');
    expect(f.calls.some((call) => call.url === `${issuer}/token`)).toBe(false);
    expect(f.persist).toHaveLength(0);
  });
});

describe('runMcpLogin registration reuse and the real aside path', () => {
  test('a second device login reuses the stored device client (its refresh token stays paired)', async () => {
    const f = loginFixture(true);
    let now = 0;
    const device = { ...f.opts, deviceNow: () => now, deviceSleep: async (ms: number) => { now += ms; } };
    expect((await runMcpLogin(device)).exitCode).toBe(0);
    expect((await runMcpLogin(device)).exitCode).toBe(0);
    expect(f.calls.filter((call) => call.url === `${issuer}/register`)).toHaveLength(1);
    expect(loadTokens(issuer, f.storePath)?.accountUuid).toBe('client');
    expect(loadTokens(issuer, f.storePath)?.redirectUri).toBeUndefined();
  });

  test('a reused client the server rejects for the device grant gets exactly one fresh device registration', async () => {
    const f = loginFixture(true);
    let now = 0;
    const device = { ...f.opts, deviceNow: () => now, deviceSleep: async (ms: number) => { now += ms; } };
    expect((await runMcpLogin(device)).exitCode).toBe(0);
    let registers = 0;
    const rejecting: McpOAuthFetch = async (url, init) => {
      if (url === `${issuer}/register`) { registers++; return json({ client_id: 'client-2' }); }
      if (url === `${issuer}/device` && (init?.body ?? '').includes('client_id=client&')) return json({ error: 'unauthorized_client' }, 400);
      return f.fetch(url, init);
    };
    expect((await runMcpLogin({ ...device, fetch: rejecting })).exitCode).toBe(0);
    expect(registers).toBe(1);
    expect(loadTokens(issuer, f.storePath)?.accountUuid).toBe('client-2');
  });

  test('aside exiting cleanly without an approval callback falls back to the browser', async () => {
    const f = loginFixture(false);
    let opened = 0;
    const result = await runMcpLogin({ ...f.opts, browserEnv: { DISPLAY: ':1' }, asideCallbackGraceMs: 50,
      approveBrowser: async () => { /* aside exited 0 but nobody approved */ },
      openBrowser: async (url) => {
        opened++;
        const auth = new URL(url);
        await fetch(`${auth.searchParams.get('redirect_uri')}?code=browser-code&state=${encodeURIComponent(auth.searchParams.get('state')!)}`);
      } });
    expect(result.exitCode).toBe(0);
    expect(opened).toBe(1);
    expect(loadTokens(issuer, f.storePath)?.tokens.accessToken).toBe('access');
  });

  test('aside/browser callback timeout falls back to an advertised device code and commits only the device client with its tokens', async () => {
    const f = loginFixture(true);
    let registers = 0;
    const fetchDevice: McpOAuthFetch = async (url, init) => {
      if (url === `${issuer}/register`) return json({ client_id: ++registers === 1 ? 'browser-client' : 'device-client' });
      return f.fetch(url, init);
    };
    let now = 0;
    const result = await runMcpLogin({ ...f.opts, fetch: fetchDevice, browserEnv: { DISPLAY: ':1' },
      deviceNow: () => now, deviceSleep: async (ms) => { now += ms; },
      approveBrowser: async () => { /* no callback */ },
      openBrowser: async () => { /* no callback */ },
      timeoutMs: 50, asideCallbackGraceMs: 10,
    });
    expect(result.exitCode).toBe(0);
    expect(registers).toBe(2);
    expect(f.lines.join(' ')).toContain('trying device code');
    expect(f.lines).toContain('Device code: ABCD');
    expect(f.calls.some((call) => call.url === `${issuer}/device`)).toBe(true);
    const stored = loadTokens(issuer, f.storePath)!;
    expect(stored.accountUuid).toBe('device-client');
    expect(stored.redirectUri).toBeUndefined();
    expect(stored.tokens.refreshToken).toBe('refresh');
  });

  test('explicit browser denial does not start a device login or replace a stored registration', async () => {
    const f = loginFixture(true);
    let now = 0;
    expect((await runMcpLogin({ ...f.opts, deviceNow: () => now, deviceSleep: async (ms) => { now += ms; } })).exitCode).toBe(0);
    const before = loadTokens(issuer, f.storePath)!;
    const result = await runMcpLogin({ ...f.opts, browserEnv: { DISPLAY: ':1' },
      approveBrowser: async (url) => {
        await fetch(`${new URL(url).searchParams.get('redirect_uri')}?error=access_denied`);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(f.calls.filter((call) => call.url === `${issuer}/device`)).toHaveLength(1);
    const after = loadTokens(issuer, f.storePath)!;
    expect(after.accountUuid).toBe(before.accountUuid);
    expect(after.tokens.refreshToken).toBe(before.tokens.refreshToken);
  });

  test('device → browser: a cancelled browser approval keeps the device client and its refresh token; success commits the new client', async () => {
    const f = loginFixture(true);
    let now = 0;
    expect((await runMcpLogin({ ...f.opts, deviceNow: () => now, deviceSleep: async (ms) => { now += ms; } })).exitCode).toBe(0);
    const device = loadTokens(issuer, f.storePath)!;
    expect(device.redirectUri).toBeUndefined();
    let registers = 0;
    const browserFetch: McpOAuthFetch = async (url, init) => {
      if (url === `${issuer}/register`) { registers++; return json({ client_id: `browser-client-${registers}` }); }
      if (url === `${issuer}/token`) return json({ access_token: 'browser-access', refresh_token: 'browser-refresh', expires_in: 3600 });
      return f.fetch(url, init);
    };
    // Approval cancelled: the callback carries a wrong state.
    const cancelled = await runMcpLogin({ ...f.opts, fetch: browserFetch, browserEnv: { DISPLAY: ':1' },
      approveBrowser: async (url) => { await fetch(`${new URL(url).searchParams.get('redirect_uri')}?code=x&state=wrong`); } });
    expect(cancelled.exitCode).toBe(1);
    const kept = loadTokens(issuer, f.storePath)!;
    expect(kept.accountUuid).toBe(device.accountUuid);
    expect(kept.tokens.refreshToken).toBe(device.tokens.refreshToken);
    expect(kept.redirectUri).toBeUndefined();
    const approved = await runMcpLogin({ ...f.opts, fetch: browserFetch, browserEnv: { DISPLAY: ':1' },
      approveBrowser: async (url) => {
        const auth = new URL(url);
        await fetch(`${auth.searchParams.get('redirect_uri')}?code=c&state=${encodeURIComponent(auth.searchParams.get('state')!)}`);
      } });
    expect(approved.exitCode).toBe(0);
    const committed = loadTokens(issuer, f.storePath)!;
    expect(committed.accountUuid).toMatch(/^browser-client-/);
    expect(committed.redirectUri).toBeDefined();
    expect(committed.tokens.refreshToken).toBe('browser-refresh');
  });

  test('first device login: token temp is private under umask 022', async () => {
    const f = loginFixture(true);
    let now = 0;
    const modes: number[] = [];
    const originalRename = fs.renameSync;
    const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === `${f.storePath}.tmp`) modes.push(fs.statSync(from).mode & 0o777);
      return originalRename(from, to);
    });
    const umask = process.umask(0o022);
    try {
      expect((await runMcpLogin({ ...f.opts, deviceNow: () => now,
        deviceSleep: async (ms) => { now += ms; } })).exitCode).toBe(0);
      expect(modes).toEqual([0o600]);
      expect(loadTokens(issuer, f.storePath)?.tokens.accessToken).toBe('access');
    } finally {
      rename.mockRestore();
      process.umask(umask);
    }
  });

  test('first browser login: registration temp is private under umask 022', async () => {
    const f = loginFixture(false);
    const modes: number[] = [];
    const originalRename = fs.renameSync;
    const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === `${f.storePath}.tmp`) modes.push(fs.statSync(from).mode & 0o777);
      return originalRename(from, to);
    });
    const umask = process.umask(0o022);
    try {
      expect((await runMcpLogin({ ...f.opts, browserEnv: { DISPLAY: ':1' }, approveBrowser: async (url) => {
        const auth = new URL(url);
        await fetch(`${auth.searchParams.get('redirect_uri')}?code=browser-code&state=${encodeURIComponent(auth.searchParams.get('state')!)}`);
      } })).exitCode).toBe(0);
      expect(modes).toEqual([0o600, 0o600]);
      expect(loadTokens(issuer, f.storePath)?.tokens.accessToken).toBe('access');
    } finally {
      rename.mockRestore();
      process.umask(umask);
    }
  });

  test('browser → device: token temp writes stay private under umask 022', async () => {
    const f = loginFixture(true);
    expect((await runMcpLogin({ ...f.opts, browserEnv: { DISPLAY: ':1' }, approveBrowser: async (url) => {
      const auth = new URL(url);
      await fetch(`${auth.searchParams.get('redirect_uri')}?code=browser-code&state=${encodeURIComponent(auth.searchParams.get('state')!)}`);
    } })).exitCode).toBe(0);
    let now = 0;
    const modes: number[] = [];
    const originalRename = fs.renameSync;
    const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === f.storePath && from !== `${f.storePath}.tmp`) modes.push(fs.statSync(from).mode & 0o777);
      return originalRename(from, to);
    });
    const umask = process.umask(0o022);
    try {
      expect((await runMcpLogin({ ...f.opts, deviceNow: () => now,
        deviceSleep: async (ms) => { now += ms; },
        fetch: async (url, init) => url === `${issuer}/register`
          ? json({ client_id: 'device-client' }) : f.fetch(url, init),
      })).exitCode).toBe(0);
      expect(modes).toEqual([0o600]);
      expect(statSync(f.storePath).mode & 0o777).toBe(0o600);
      expect(loadTokens(issuer, f.storePath)?.accountUuid).toBe('device-client');
      expect(loadTokens(issuer, f.storePath)?.redirectUri).toBeUndefined();
    } finally {
      rename.mockRestore();
      process.umask(umask);
    }
  });

  test('stored browser client switches to device after aside timeout without carrying browser registration', async () => {
    const f = loginFixture(true);
    const browserFetch: McpOAuthFetch = async (url, init) => url === `${issuer}/register`
      ? json({ client_id: 'browser-client', client_secret: 'browser-secret' }) : f.fetch(url, init);
    expect((await runMcpLogin({ ...f.opts, fetch: browserFetch, browserEnv: { DISPLAY: ':1' },
      approveBrowser: async (url) => {
        const auth = new URL(url);
        await fetch(`${auth.searchParams.get('redirect_uri')}?code=browser-code&state=${encodeURIComponent(auth.searchParams.get('state')!)}`);
      },
    })).exitCode).toBe(0);
    const before = loadTokens(issuer, f.storePath)!;
    expect(before).toMatchObject({ accountUuid: 'browser-client', organizationUuid: 'browser-secret', tokens: { refreshToken: 'refresh' } });
    expect(before.redirectUri).toBeDefined();
    let deviceRegistrations = 0;
    let now = 0;
    const result = await runMcpLogin({ ...f.opts, browserEnv: { DISPLAY: ':1' },
      fetch: async (url, init) => {
        if (url === `${issuer}/register`) { deviceRegistrations++; return json({ client_id: 'device-client' }); }
        if (url === `${issuer}/token`) return json({ access_token: 'device-access', refresh_token: 'device-refresh', expires_in: 3600 });
        return f.fetch(url, init);
      },
      approveBrowser: async () => {}, openBrowser: async () => {}, timeoutMs: 50, asideCallbackGraceMs: 5,
      deviceNow: () => now, deviceSleep: async (ms) => { now += ms; },
    });
    expect(result.exitCode).toBe(0);
    expect(deviceRegistrations).toBe(1);
    expect(f.lines.join(' ')).toContain('trying device code');
    expect(f.lines).toContain('Device code: ABCD');
    const after = loadTokens(issuer, f.storePath)!;
    expect(after.accountUuid).toBe('device-client');
    expect(after.tokens.accessToken).toBe('device-access');
    expect(after.tokens.refreshToken).toBe('device-refresh');
    expect(after.redirectUri).toBeUndefined();
    expect(after.organizationUuid).toBeUndefined();
  });

  test('stored browser client survives aside timeout and denied device code without adopting a pending device client', async () => {
    const f = loginFixture(true);
    const browserFetch: McpOAuthFetch = async (url, init) => url === `${issuer}/register`
      ? json({ client_id: 'browser-client', client_secret: 'browser-secret' }) : f.fetch(url, init);
    expect((await runMcpLogin({ ...f.opts, fetch: browserFetch, browserEnv: { DISPLAY: ':1' },
      approveBrowser: async (url) => {
        const auth = new URL(url);
        await fetch(`${auth.searchParams.get('redirect_uri')}?code=browser-code&state=${encodeURIComponent(auth.searchParams.get('state')!)}`);
      },
    })).exitCode).toBe(0);
    const before = readFileSync(f.storePath, 'utf8');
    let deviceRegistrations = 0;
    let now = 0;
    const result = await runMcpLogin({ ...f.opts, browserEnv: { DISPLAY: ':1' },
      fetch: async (url, init) => {
        if (url === `${issuer}/register`) { deviceRegistrations++; return json({ client_id: 'device-client' }); }
        if (url === `${issuer}/token` && new URLSearchParams(init?.body).get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
          return json({ error: 'access_denied' }, 400);
        }
        return f.fetch(url, init);
      },
      approveBrowser: async () => {}, openBrowser: async () => {}, timeoutMs: 50, asideCallbackGraceMs: 5,
      deviceNow: () => now, deviceSleep: async (ms) => { now += ms; },
    });
    expect(result.exitCode).toBe(1);
    expect(deviceRegistrations).toBe(1);
    expect(f.lines.join(' ')).toContain('trying device code');
    expect(readFileSync(f.storePath, 'utf8')).toBe(before);
  });

  test('browser → device: stale 0644 temp is not reused and token write starts on a private file', async () => {
    const f = loginFixture(true);
    expect((await runMcpLogin({ ...f.opts, browserEnv: { DISPLAY: ':1' }, approveBrowser: async (url) => {
      const auth = new URL(url);
      await fetch(`${auth.searchParams.get('redirect_uri')}?code=browser-code&state=${encodeURIComponent(auth.searchParams.get('state')!)}`);
    } })).exitCode).toBe(0);
    const stale = `${f.storePath}.tmp`;
    writeFileSync(stale, 'interrupted write');
    chmodSync(stale, 0o644);
    const modesAtWrite: number[] = [];
    const originalWrite = fs.writeFileSync;
    const write = spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (typeof file === 'number' && typeof data === 'string' && data.includes('device-refresh')) {
        modesAtWrite.push(fs.fstatSync(file).mode & 0o777);
        expect(fs.readFileSync(stale, 'utf8')).toBe('interrupted write');
        expect(fs.statSync(stale).mode & 0o777).toBe(0o644);
      }
      return originalWrite(file, data, options);
    });
    let now = 0;
    try {
      expect((await runMcpLogin({ ...f.opts, deviceNow: () => now,
        deviceSleep: async (ms) => { now += ms; },
        fetch: async (url, init) => {
          if (url === `${issuer}/register`) return json({ client_id: 'device-client' });
          if (url === `${issuer}/token`) return json({ access_token: 'device-access', refresh_token: 'device-refresh', expires_in: 3600 });
          return f.fetch(url, init);
        },
      })).exitCode).toBe(0);
      expect(modesAtWrite).toEqual([0o600]);
      expect(loadTokens(issuer, f.storePath)).toMatchObject({ accountUuid: 'device-client', tokens: { refreshToken: 'device-refresh' } });
      expect(readFileSync(stale, 'utf8')).toBe('interrupted write');
    } finally {
      write.mockRestore();
    }
  });

  test('browser → device: failed atomic replacement preserves the old registration and token together', async () => {
    const f = loginFixture(true);
    const browserFetch: McpOAuthFetch = async (url, init) => url === `${issuer}/register`
      ? json({ client_id: 'browser-client', client_secret: 'browser-secret' }) : f.fetch(url, init);
    expect((await runMcpLogin({ ...f.opts, fetch: browserFetch, browserEnv: { DISPLAY: ':1' },
      approveBrowser: async (url) => {
        const auth = new URL(url);
        await fetch(`${auth.searchParams.get('redirect_uri')}?code=browser-code&state=${encodeURIComponent(auth.searchParams.get('state')!)}`);
      },
    })).exitCode).toBe(0);
    const before = readFileSync(f.storePath, 'utf8');
    expect(loadTokens(issuer, f.storePath)).toMatchObject({
      accountUuid: 'browser-client', organizationUuid: 'browser-secret',
      tokens: { refreshToken: 'refresh' },
    });
    let now = 0;
    const device = { ...f.opts, deviceNow: () => now, deviceSleep: async (ms: number) => { now += ms; },
      fetch: (async (url: string, init?: Parameters<McpOAuthFetch>[1]) => {
        if (url === `${issuer}/register`) return json({ client_id: 'device-client' });
        if (url === `${issuer}/token`) return json({ access_token: 'device-access', refresh_token: 'device-refresh', expires_in: 3600 });
        return f.fetch(url, init);
      }) satisfies McpOAuthFetch };
    const originalRename = fs.renameSync;
    let attempted = 0;
    const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === f.storePath && from !== `${f.storePath}.tmp`) {
        attempted++;
        throw new Error('injected rename failure');
      }
      return originalRename(from, to);
    });
    try {
      expect((await runMcpLogin(device)).exitCode).toBe(1);
    } finally {
      rename.mockRestore();
    }
    expect(attempted).toBe(1);
    expect(readFileSync(f.storePath, 'utf8')).toBe(before);
    expect(fs.existsSync(`${f.storePath}.tmp`)).toBe(false);
    expect((await runMcpLogin(device)).exitCode).toBe(0);
    const after = loadTokens(issuer, f.storePath)!;
    expect(after.accountUuid).toBe('device-client');
    expect(after.tokens.accessToken).toBe('device-access');
    expect(after.tokens.refreshToken).toBe('device-refresh');
    expect(after.redirectUri).toBeUndefined();
    expect(after.organizationUuid).toBeUndefined();
  });

  test('browser → device: a successful device login replaces the browser client without carrying its redirect URI', async () => {
    const f = loginFixture(true);
    const browser = await runMcpLogin({ ...f.opts, browserEnv: { DISPLAY: ':1' }, approveBrowser: async (url) => {
      const auth = new URL(url);
      await fetch(`${auth.searchParams.get('redirect_uri')}?code=browser-code&state=${encodeURIComponent(auth.searchParams.get('state')!)}`);
    } });
    expect(browser.exitCode).toBe(0);
    expect(loadTokens(issuer, f.storePath)?.redirectUri).toBeDefined();
    let now = 0;
    let deviceRegistrations = 0;
    const deviceFetch: McpOAuthFetch = async (url, init) => {
      if (url === `${issuer}/register`) { deviceRegistrations++; return json({ client_id: 'device-client' }); }
      return f.fetch(url, init);
    };
    expect((await runMcpLogin({ ...f.opts, fetch: deviceFetch,
      deviceNow: () => now, deviceSleep: async (ms) => { now += ms; } })).exitCode).toBe(0);
    expect(deviceRegistrations).toBe(1);
    const stored = loadTokens(issuer, f.storePath)!;
    expect(stored.accountUuid).toBe('device-client');
    expect(stored.redirectUri).toBeUndefined();
    expect(stored.tokens.refreshToken).toBe('refresh');
  });

  test('a failed device login leaves the stored browser registration and its refresh token untouched', async () => {
    const f = loginFixture(true);
    const browser = await runMcpLogin({ ...f.opts, browserEnv: { DISPLAY: ':1' }, approveBrowser: async (url) => {
      const auth = new URL(url);
      await fetch(`${auth.searchParams.get('redirect_uri')}?code=browser-code&state=${encodeURIComponent(auth.searchParams.get('state')!)}`);
    } });
    expect(browser.exitCode).toBe(0);
    const before = loadTokens(issuer, f.storePath)!;
    expect(before.redirectUri).toBeDefined();
    let registers = 0;
    const denying: McpOAuthFetch = async (url, init) => {
      if (url === `${issuer}/register`) { registers++; return json({ client_id: 'device-client' }); }
      if (url === `${issuer}/token` && (init?.body ?? '').includes('device_code')) return json({ error: 'access_denied' }, 400);
      return f.fetch(url, init);
    };
    let now = 0;
    const result = await runMcpLogin({ ...f.opts, fetch: denying, deviceNow: () => now, deviceSleep: async (ms) => { now += ms; } });
    expect(result.exitCode).toBe(1);
    expect(registers).toBe(1);
    const after = loadTokens(issuer, f.storePath)!;
    expect(after.accountUuid).toBe(before.accountUuid);
    expect(after.redirectUri).toBe(before.redirectUri);
    expect(after.tokens.refreshToken).toBe(before.tokens.refreshToken);
  });

  test('without injected approval, `aside exec` receives the authorization URL; only the state-checked callback stores tokens', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'mcp-login-aside-'));
    const record = join(bin, 'argv.json');
    // A recording `aside`: it logs its argv, then plays the provider page — approve with the state from the URL.
    writeFileSync(join(bin, 'aside'), `#!/usr/bin/env bun
const args = process.argv.slice(2);
require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(args));
const url = new URL(/https?:\\/\\/\\S+?(?=\\.\\s|\\s|$)/.exec(args.at(-1))[0]);
await fetch(url.searchParams.get('redirect_uri') + '?code=aside-code&state=' + encodeURIComponent(url.searchParams.get('state')));
`);
    chmodSync(join(bin, 'aside'), 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ''}`;
    try {
      const f = loginFixture(false);
      const result = await runMcpLogin({ ...f.opts, browserEnv: { DISPLAY: ':1' } });
      expect(result.exitCode).toBe(0);
      const argv = JSON.parse(readFileSync(record, 'utf8')) as string[];
      expect(argv.slice(0, 1)).toEqual(['exec']);
      expect(argv.at(-1)).toContain(`${issuer}/authorize?`);
      expect(f.calls.find((call) => call.url === `${issuer}/token`)?.body).toContain('code=aside-code');
      expect(loadTokens(issuer, f.storePath)?.tokens.accessToken).toBe('access');
    } finally { process.env.PATH = previous; }
  }, 120_000);
});
