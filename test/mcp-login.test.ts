import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { runMcpLogin } from '../src/cli/mcp-login.js';
import {
  loadStoredRegistration,
  mcpOAuthStorePath,
  type McpOAuthFetch,
} from '../src/mcp/mcp-oauth.js';
import { loadTokens, saveTokens } from '../src/oauth/store.js';
import { debug } from '../src/debug/log.js';

const ENDPOINT = 'https://mcp.example.test/mcp';
const RESOURCE = 'https://auth.example.test/resource';
const ISSUER = 'https://auth.example.test';
const AUTHORIZE = 'https://auth.example.test/authorize';
const TOKEN = 'https://auth.example.test/token';
const REGISTER = 'https://auth.example.test/register';
const dirs: string[] = [];
const prevStateDir = process.env.ELANOUS_STATE_DIR;
const prevXdg = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (prevStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = prevStateDir;
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
});

function isolated(): void {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-login-'));
  dirs.push(dir);
  // ⛔ MCP 자격은 전역 자격 파일(authStorePath)에 간다 — XDG 로 tmp 에 못 박는다.
  process.env.XDG_CONFIG_HOME = join(dir, 'config');
  process.env.ELANOUS_STATE_DIR = join(dir, 'universe');
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function oauthFetch(counts: { register: number; token: number }): McpOAuthFetch {
  return async (url, init) => {
    if (url === ENDPOINT) return new Response('', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${RESOURCE}", scope="mcp:tools"` } });
    if (url === RESOURCE) return json(200, { resource: ENDPOINT, authorization_servers: [ISSUER] });
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) return json(200, { issuer: ISSUER, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN, registration_endpoint: REGISTER, code_challenge_methods_supported: ['S256'] });
    if (url === REGISTER) { counts.register += 1; return json(201, { client_id: 'client-id', client_secret: 'client-secret' }); }
    if (url === TOKEN) { counts.token += 1; return json(200, { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 }); }
    throw new Error(`unexpected ${url} ${init?.method ?? 'GET'}`);
  };
}

function config(servers: unknown[]) {
  return () => ({ mcp: { servers: servers as never[] } });
}

function out() {
  const logs: string[] = []; const errors: string[] = [];
  return { logs, errors, sink: { log: (line: string) => logs.push(line), error: (line: string) => errors.push(line) } };
}

describe('runMcpLogin', () => {
  test('unknown and stdio servers fail before any network request', async () => {
    let calls = 0;
    const missing = await runMcpLogin({ serverId: 'missing', out: out().sink, readConfigFn: config([]), fetch: async () => { calls += 1; return json(500, {}); } });
    const stdio = await runMcpLogin({ serverId: 'local', out: out().sink, readConfigFn: config([{ id: 'local', transport: 'stdio', command: ['x'] }]), fetch: async () => { calls += 1; return json(500, {}); } });
    expect(missing.exitCode).toBe(1); expect(stdio.exitCode).toBe(1); expect(calls).toBe(0);
  });

  test('loopback bind errors reject before the MCP request', async () => {
    let calls = 0;
    const result = await runMcpLogin({
      serverId: 'remote',
      out: out().sink,
      readConfigFn: config([{ id: 'remote', transport: 'http', url: ENDPOINT }]),
      fetch: async () => { calls += 1; return json(500, {}); },
      createListener: (handler) => {
        const server = createServer(handler);
        server.listen = ((..._args: unknown[]) => {
          queueMicrotask(() => server.emit('error', new Error('port already in use')));
          return server;
        }) as typeof server.listen;
        return server;
      },
    });
    expect(result.exitCode).toBe(1);
    expect(calls).toBe(0);
  });

  test('401-derived metadata builds S256 state and redirect, browser failure falls back, then saves without secrets in output', async () => {
    isolated();
    const counts = { register: 0, token: 0 }; const captured = out();
    let authorizationUrl = '';
    const result = await runMcpLogin({
      serverId: 'remote', out: captured.sink, readConfigFn: config([{ id: 'remote', transport: 'http', url: ENDPOINT }]), fetch: oauthFetch(counts),
      browserEnv: {}, browserPlatform: 'darwin',
      openBrowser: async (url) => {
        authorizationUrl = url;
        const state = new URL(url).searchParams.get('state')!;
        const redirect = new URL(url).searchParams.get('redirect_uri')!;
        await fetch(`${redirect}?code=code-1&state=${encodeURIComponent(state)}`);
        throw new Error('no browser');
      },
    });
    expect(result.exitCode).toBe(0); expect(counts).toEqual({ register: 1, token: 1 });
    const params = new URL(authorizationUrl).searchParams;
    expect(params.get('code_challenge_method')).toBe('S256'); expect(params.get('state')).toBeTruthy(); expect(params.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    expect(captured.errors.join('\n')).toContain('manually');
    expect([...captured.logs, ...captured.errors].join('\n')).not.toContain('access-secret');
    expect([...captured.logs, ...captured.errors].join('\n')).not.toContain('refresh-secret');
    expect([...captured.logs, ...captured.errors].join('\n')).not.toContain('client-secret');
    // ⛔⭐⭐ 「저장했다」를 «호출 횟수»로 세지 않는다 — 저장소를 «다시 읽어» 단언한다.
    //    리뷰 must-fix: 이 시험의 이름이 "saves" 인데 그 주장을 검증하는 줄이 없었다.
    //    ⊕ 열쇠가 «발급자 식별자»라는 계약도 여기서 같이 물린다.
    const stored = loadTokens(ISSUER, mcpOAuthStorePath());
    expect(stored?.tokens.accessToken).toBe('access-secret');
    expect(stored?.tokens.refreshToken).toBe('refresh-secret');
    expect(stored?.authMode).toBe('mcp-oauth');
    // ⛔ 저장 위치는 «우주 밖» 전역 자격 파일이다(격리 매뉴얼 §6).
    expect(mcpOAuthStorePath().startsWith(process.env.XDG_CONFIG_HOME!)).toBe(true);
    expect(mcpOAuthStorePath().startsWith(process.env.ELANOUS_STATE_DIR!)).toBe(false);
  });

  test('SSH Mac and displayless Linux keep authorization URL but never call opener; local Mac calls it once', async () => {
    for (const [env, platform, why] of [
      [{ SSH_CONNECTION: 'x' }, 'darwin', '원격(ssh)'],
      [{}, 'linux', '화면(디스플레이)이 없는 세션'],
      [{}, 'darwin', null],
    ] as const) {
      isolated();
      const captured = out();
      const opened: string[] = [];
      const result = await runMcpLogin({
        serverId: 'remote', out: captured.sink,
        readConfigFn: config([{ id: 'remote', transport: 'http', url: ENDPOINT }]),
        fetch: oauthFetch({ register: 0, token: 0 }), timeoutMs: 10,
        browserEnv: env, browserPlatform: platform,
        openBrowser: async url => { opened.push(url); },
      });
      expect(result.exitCode).toBe(1);
      expect(captured.logs.join('\n')).toContain(AUTHORIZE);
      expect(opened).toHaveLength(why ? 0 : 1);
      if (why) {
        expect(captured.logs.join('\n')).toContain(why);
        const event = debug.events(20).filter(e => e.category === 'browser.open').at(-1);
        expect(event?.event).toBe('skipped');
        expect(event?.data).toMatchObject({ reason: platform === 'darwin' ? 'ssh' : 'no-display' });
      }
    }
  });

  test('⭐⭐ 기대 state 가 정해지기 «전»에 도착한 콜백도 유실되지 않는다', async () => {
    isolated();
    const captured = out();
    // ⛔ 경합을 «진짜로» 만든다. `wait()` 는 인가 요청 조립 «뒤»에 불리므로,
    //    그 조립 «중»인 동적 등록 시점에 콜백을 쏘면 기대 state 가 아직 없다.
    //    등록 요청 본문에 redirect_uris 가 실려 오므로 그 주소를 여기서 얻는다.
    //    ⚠️ state 는 아직 세상에 없다 — 그래서 «틀린» state 를 쏘고, 그 값이
    //    나중에 대조돼 «실패»로 끝나는 것이 옳은 동작이다(성공으로 뭉개지면 안 된다).
    let earlyFired = false;
    const fetchSeam: McpOAuthFetch = async (url, init) => {
      if (url === ENDPOINT) return new Response('', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${RESOURCE}", scope="mcp:tools"` } });
      if (url === RESOURCE) return json(200, { resource: ENDPOINT, authorization_servers: [ISSUER] });
      if (url === `${ISSUER}/.well-known/oauth-authorization-server`) return json(200, { issuer: ISSUER, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN, registration_endpoint: REGISTER, code_challenge_methods_supported: ['S256'] });
      if (url === REGISTER) {
        const redirect = (JSON.parse(init?.body ?? '{}') as { redirect_uris?: string[] }).redirect_uris?.[0];
        if (redirect) { earlyFired = true; await fetch(`${redirect}?code=code-1&state=stale-state`); }
        return json(201, { client_id: 'client-id', client_secret: 'client-secret' });
      }
      if (url === TOKEN) return json(200, { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 });
      throw new Error(`unexpected ${url}`);
    };
    const result = await runMcpLogin({
      serverId: 'remote', out: captured.sink,
      readConfigFn: config([{ id: 'remote', transport: 'http', url: ENDPOINT }]),
      fetch: fetchSeam,
      browserEnv: {}, browserPlatform: 'darwin',
      openBrowser: async () => undefined,
      timeoutMs: 2000,
    });
    expect(earlyFired).toBe(true);
    // ⛔ 담아 두지 않으면 그 요청은 유실되어 «타임아웃» 문면으로 끝난다.
    //    담아 두면 나중에 대조되어 «state 불일치»로 끝난다 — 그 갈림을 여기서 센다.
    expect(result.exitCode).toBe(1);
    expect(captured.errors.join('\n')).toContain('state does not match');
    expect(captured.errors.join('\n')).not.toContain('timed out');
  });

  test('state mismatch, OAuth callback error, and timeout fail and close the loopback listener', async () => {
    for (const mode of ['mismatch', 'oauth-error', 'timeout'] as const) {
      isolated();
      const counts = { register: 0, token: 0 }; let redirect = '';
      const result = await runMcpLogin({
        serverId: 'remote', timeoutMs: 15, out: out().sink, readConfigFn: config([{ id: 'remote', transport: 'http', url: ENDPOINT }]), fetch: oauthFetch(counts),
        browserEnv: {}, browserPlatform: 'darwin',
      openBrowser: async (url) => {
          redirect = new URL(url).searchParams.get('redirect_uri')!;
          if (mode === 'mismatch') await fetch(`${redirect}?code=x&state=wrong`);
          if (mode === 'oauth-error') await fetch(`${redirect}?error=access_denied`);
        },
      });
      expect(result.exitCode).toBe(1); expect(counts.token).toBe(0);
      if (redirect) await expect(fetch(redirect)).rejects.toBeDefined();
    }
  });
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function strictAuthServer(): Promise<{
  base: string;
  close: () => Promise<void>;
  authorizeRedirects: string[];
  authorizeStatuses: number[];
  registrations: number;
}> {
  const registered = new Map<string, string>();
  const authorizeRedirects: string[] = [];
  const authorizeStatuses: number[] = [];
  let registrations = 0;
  let clients = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        code_challenge_methods_supported: ['S256'],
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      registrations += 1;
      const body = JSON.parse(await readBody(req)) as { redirect_uris?: string[] };
      const redirect = body.redirect_uris?.[0] ?? '';
      clients += 1;
      const clientId = `client-${clients}`;
      registered.set(clientId, redirect);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ client_id: clientId }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      const clientId = url.searchParams.get('client_id') ?? '';
      authorizeRedirects.push(redirect);
      const allowed = registered.get(clientId);
      if (!allowed || redirect !== allowed) {
        authorizeStatuses.push(400);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid redirect_uri' }));
        return;
      }
      authorizeStatuses.push(302);
      const target = new URL(redirect);
      target.searchParams.set('code', 'auth-code');
      target.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: target.toString() });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600, token_type: 'Bearer' }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/mcp') {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('auth server has no port');
  return {
    base: `http://127.0.0.1:${address.port}`,
    authorizeRedirects,
    authorizeStatuses,
    get registrations() { return registrations; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const passthrough: McpOAuthFetch = (url, init) => fetch(url, init);

async function finishBrowser(url: string, seen?: string[]): Promise<void> {
  if (seen) seen.push(new URL(url).searchParams.get('redirect_uri') ?? '');
  const authorize = await fetch(url, { redirect: 'manual' });
  const location = authorize.headers.get('location');
  if (!location) throw new Error(`authorize HTTP ${authorize.status}`);
  await fetch(location);
}

describe('strict redirect_uri login', () => {
  test('두 번째 로그인도 첫 등록 redirect_uri 로 인가된다', async () => {
    isolated();
    const auth = await strictAuthServer();
    try {
      const seen: string[] = [];
      const login = () => runMcpLogin({
        serverId: 'strict',
        readConfigFn: config([{ id: 'strict', transport: 'http', url: `${auth.base}/mcp`, enabled: true }]),
        fetch: passthrough,
        persistDiscoveryFn: () => ({ written: false }),
        browserEnv: {}, browserPlatform: 'darwin',
      openBrowser: (url) => finishBrowser(url, seen),
      });
      const first = await login();
      const second = await login();
      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(auth.authorizeStatuses).toEqual([302, 302]);
      expect(auth.authorizeRedirects[1]).toBe(auth.authorizeRedirects[0]);
      expect(seen[1]).toBe(seen[0]);
      expect(auth.registrations).toBe(1);
    } finally {
      await auth.close();
    }
  });

  test('등록된 포트를 다른 소켓이 잡고 있으면 다시 동적 등록한다', async () => {
    isolated();
    const auth = await strictAuthServer();
    const holder = createServer((_req, res) => { res.end(); });
    try {
      const first = await runMcpLogin({
        serverId: 'strict',
        readConfigFn: config([{ id: 'strict', transport: 'http', url: `${auth.base}/mcp`, enabled: true }]),
        fetch: passthrough,
        persistDiscoveryFn: () => ({ written: false }),
        browserEnv: {}, browserPlatform: 'darwin',
      openBrowser: (url) => finishBrowser(url),
      });
      expect(first.exitCode).toBe(0);
      const stored = loadStoredRegistration(auth.base);
      const port = Number(new URL(stored?.redirectUri ?? 'http://127.0.0.1').port);
      await new Promise<void>((resolve, reject) => {
        holder.once('error', reject);
        holder.listen(port, '127.0.0.1', () => resolve());
      });
      const before = auth.registrations;
      const second = await runMcpLogin({
        serverId: 'strict',
        readConfigFn: config([{ id: 'strict', transport: 'http', url: `${auth.base}/mcp`, enabled: true }]),
        fetch: passthrough,
        persistDiscoveryFn: () => ({ written: false }),
        browserEnv: {}, browserPlatform: 'darwin',
      openBrowser: (url) => finishBrowser(url),
      });
      const again = loadStoredRegistration(auth.base);
      expect(second.exitCode).toBe(0);
      expect(auth.registrations).toBe(before + 1);
      expect(again?.clientId).not.toBe(stored?.clientId);
      expect(again?.redirectUri).not.toBe(stored?.redirectUri);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
      await auth.close();
    }
  });

  test('redirect_uri 기록이 없는 옛 등록은 첫 로그인에서 다시 등록한다', async () => {
    isolated();
    const auth = await strictAuthServer();
    try {
      saveTokens(auth.base, { accessToken: '', refreshToken: '', expiresAt: null }, {
        authMode: 'mcp-oauth',
        accountUuid: 'legacy-client',
        mirrorCodex: false,
      }, mcpOAuthStorePath());
      const result = await runMcpLogin({
        serverId: 'strict',
        readConfigFn: config([{ id: 'strict', transport: 'http', url: `${auth.base}/mcp`, enabled: true }]),
        fetch: passthrough,
        persistDiscoveryFn: () => ({ written: false }),
        browserEnv: {}, browserPlatform: 'darwin',
      openBrowser: (url) => finishBrowser(url),
      });
      const stored = loadStoredRegistration(auth.base);
      expect(result.exitCode).toBe(0);
      expect(auth.registrations).toBe(1);
      expect(stored?.clientId).not.toBe('legacy-client');
      expect(stored?.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    } finally {
      await auth.close();
    }
  });
});
