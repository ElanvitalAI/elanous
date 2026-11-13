// ── MCP OAuth unit tests ──
//
// Hosts come from the 401 challenge (RFC 5737 documentation addresses).
// No provider host names.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  acquireAccessToken,
  authorizationServerMetadataUrl,
  buildAuthorizationRequest,
  discoverAuthorizationServer,
  discoverMcpOAuth,
  discoverProtectedResource,
  ensureClientRegistration,
  getValidAccessToken,
  loadStoredAccessToken,
  loadStoredRegistration,
  mcpOAuthStorePath,
  McpOAuthError,
  refreshStoredAccessToken,
  verifyAuthorizationCallback,
  type AuthorizationServerMetadata,
  type McpOAuthFetch,
} from '../src/mcp/mcp-oauth';
import { authStorePath, loadTokens, saveTokens } from '../src/oauth/store';

const RESOURCE_META = 'https://192.0.2.10/.well-known/oauth-protected-resource';
const AS = 'https://192.0.2.20';
const ISSUER = 'https://192.0.2.20';
const AUTHORIZE = 'https://192.0.2.20/authorize';
const TOKEN = 'https://192.0.2.20/token';
const REGISTER = 'https://192.0.2.20/register';
const AS_META = 'https://192.0.2.20/.well-known/oauth-authorization-server';

function jsonRes(status: number, body: unknown): Awaited<ReturnType<McpOAuthFetch>> {
  return {
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
  };
}

function asMetadata(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: AUTHORIZE,
    token_endpoint: TOKEN,
    registration_endpoint: REGISTER,
    code_challenge_methods_supported: ['S256'],
    ...extra,
  };
}

interface Recorded {
  method: string;
  url: string;
  body?: string;
}

function makeOauthFetch(opts: {
  methods?: string[];
  register?: (body: string) => { client_id: string; client_secret?: string };
  token?: (body: string) => Record<string, unknown> | { status: number; body: unknown };
}): { fetch: McpOAuthFetch; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const methods = opts.methods ?? ['S256'];
  const fetch: McpOAuthFetch = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    recorded.push({ method, url, body: init?.body });
    if (url === RESOURCE_META) {
      return jsonRes(200, { resource: 'https://192.0.2.10/mcp', authorization_servers: [AS] });
    }
    if (url === AS_META) {
      return jsonRes(200, asMetadata({ code_challenge_methods_supported: methods }));
    }
    if (url === REGISTER && method === 'POST') {
      const out = opts.register
        ? opts.register(init?.body ?? '')
        : { client_id: 'client-1' };
      return jsonRes(201, out);
    }
    if (url === TOKEN && method === 'POST') {
      const out = opts.token
        ? opts.token(init?.body ?? '')
        : {
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'mcp:tools',
          };
      if ('status' in out && typeof (out as { status: unknown }).status === 'number') {
        const failed = out as { status: number; body: unknown };
        return jsonRes(failed.status, failed.body);
      }
      return jsonRes(200, out);
    }
    throw new Error(`unexpected oauth url ${method} ${url}`);
  };
  return { fetch, recorded };
}

let storeDir: string;
let storePath: string;
let prevStateDir: string | undefined;
let prevXdg: string | undefined;
let universeDir: string;

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), 'mcp-oauth-'));
  storePath = join(storeDir, 'auth.json');
  universeDir = mkdtempSync(join(tmpdir(), 'mcp-oauth-universe-'));
  prevStateDir = process.env.ELANOUS_STATE_DIR;
  prevXdg = process.env.XDG_CONFIG_HOME;
  // XDG is unrelated to the selected config/auth universe.
  process.env.XDG_CONFIG_HOME = storeDir;
  process.env.ELANOUS_STATE_DIR = universeDir;
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = prevStateDir;
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(storeDir, { recursive: true, force: true });
  rmSync(universeDir, { recursive: true, force: true });
});

describe('RFC 9728 / RFC 8414 discovery', () => {
  test('reads protected resource then authorization server and builds S256 authorize URL with state', async () => {
    const { fetch, recorded } = makeOauthFetch({});
    const { resource, metadata } = await discoverMcpOAuth(RESOURCE_META, { fetch, storePath });
    expect(resource.authorizationServers[0]).toBe(AS);
    expect(metadata.issuer).toBe(ISSUER);
    expect(metadata.authorizationEndpoint).toBe(AUTHORIZE);
    expect(metadata.tokenEndpoint).toBe(TOKEN);
    expect(recorded.map((r) => r.url)).toEqual([RESOURCE_META, AS_META]);

    const registration = await ensureClientRegistration(metadata, { fetch, storePath });
    const request = buildAuthorizationRequest(metadata, registration, { scope: 'mcp:tools' });
    const url = new URL(request.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('scope')).toBe('mcp:tools');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  test('rejects empty authorization_servers and missing required fields', async () => {
    const fetch: McpOAuthFetch = async (url) => {
      if (url === RESOURCE_META) return jsonRes(200, { authorization_servers: [] });
      if (url === AS_META) return jsonRes(200, { issuer: ISSUER });
      throw new Error(url);
    };
    await expect(discoverProtectedResource(RESOURCE_META, { fetch })).rejects.toMatchObject({
      code: 'discovery',
    });
    await expect(discoverAuthorizationServer(AS, { fetch })).rejects.toMatchObject({
      code: 'discovery',
    });
  });

  test('authorizationServerMetadataUrl is derived from the discovered server, not a baked host', () => {
    expect(authorizationServerMetadataUrl(AS)).toBe(AS_META);
    expect(authorizationServerMetadataUrl(`${AS}/tenant`)).toBe(`${AS_META}/tenant`);
  });
});

describe('S256 support', () => {
  test('does not assemble an authorize URL when S256 is absent', async () => {
    const { fetch } = makeOauthFetch({ methods: ['plain'] });
    const { metadata } = await discoverMcpOAuth(RESOURCE_META, { fetch, storePath });
    const registration = { clientId: 'client-1' };
    expect(() => buildAuthorizationRequest(metadata, registration)).toThrow(McpOAuthError);
    try {
      buildAuthorizationRequest(metadata, registration);
      throw new Error('expected failure');
    } catch (err) {
      expect(err).toBeInstanceOf(McpOAuthError);
      expect((err as McpOAuthError).code).toBe('s256-unsupported');
      expect((err as McpOAuthError).message).toMatch(/S256/);
    }
  });
});

describe('RFC 7591 dynamic registration', () => {
  test('registers once, persists client_id, and reuses it for the same issuer', async () => {
    let registrations = 0;
    const { fetch, recorded } = makeOauthFetch({
      register: () => {
        registrations += 1;
        return { client_id: 'dyn-client' };
      },
    });
    const { metadata } = await discoverMcpOAuth(RESOURCE_META, { fetch, storePath });
    const first = await ensureClientRegistration(metadata, { fetch, storePath });
    const second = await ensureClientRegistration(metadata, { fetch, storePath });
    expect(first.clientId).toBe('dyn-client');
    expect(second.clientId).toBe('dyn-client');
    expect(registrations).toBe(1);
    expect(recorded.filter((r) => r.url === REGISTER)).toHaveLength(1);
    expect(loadStoredRegistration(ISSUER, { storePath })?.clientId).toBe('dyn-client');
  });

  test('two servers sharing an issuer share the stored registration', async () => {
    const { fetch } = makeOauthFetch({
      register: () => ({ client_id: 'shared-client' }),
    });
    const { metadata } = await discoverMcpOAuth(RESOURCE_META, { fetch, storePath });
    await ensureClientRegistration(metadata, { fetch, storePath });
    const other: AuthorizationServerMetadata = { ...metadata };
    const reused = await ensureClientRegistration(other, { fetch, storePath });
    expect(reused.clientId).toBe('shared-client');
  });
});

describe('credential store follows the selected universe', () => {
  test('credential file uses the selected universe rather than XDG', () => {
    const path = mcpOAuthStorePath();
    expect(path).toBe(authStorePath());
    expect(path).toBe(join(universeDir, 'auth.json'));
    expect(path.startsWith(resolve(storeDir))).toBe(false);
    expect(path).not.toBe(join(homedir(), '.elanous', 'auth.json'));
  });

  test('a credential in another universe is not adopted', () => {
    const legacy = join(storeDir, 'elanous', 'auth.json');
    saveTokens(
      ISSUER,
      { accessToken: 'stranded-access', refreshToken: 'stranded-refresh', expiresAt: Date.now() + 3600_000 },
      { authMode: 'mcp-oauth', accountUuid: 'stranded-client', mirrorCodex: false },
      legacy,
    );
    expect(loadStoredAccessToken(ISSUER)).toBeNull();
    expect(loadTokens(ISSUER, mcpOAuthStorePath())).toBeNull();
    // Selecting that universe exposes its own credential without copying it.
    process.env.ELANOUS_STATE_DIR = join(storeDir, 'elanous');
    expect(loadStoredAccessToken(ISSUER)).toBe('stranded-access');
    expect(loadStoredRegistration(ISSUER)?.clientId).toBe('stranded-client');
  });

  test('another universe never overwrites the selected credential', () => {
    saveTokens(
      ISSUER,
      { accessToken: 'global-access', refreshToken: 'global-refresh', expiresAt: Date.now() + 3600_000 },
      { authMode: 'mcp-oauth', mirrorCodex: false },
      mcpOAuthStorePath(),
    );
    saveTokens(
      ISSUER,
      { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() + 3600_000 },
      { authMode: 'mcp-oauth', mirrorCodex: false },
      join(storeDir, 'elanous', 'auth.json'),
    );
    expect(loadStoredAccessToken(ISSUER)).toBe('global-access');
    expect(loadTokens(ISSUER, mcpOAuthStorePath())?.tokens.refreshToken).toBe('global-refresh');
  });

  test('non-MCP records in another universe are not adopted', () => {
    saveTokens(
      ISSUER,
      { accessToken: 'other-mode', refreshToken: '', expiresAt: Date.now() + 3600_000 },
      { authMode: 'chatgpt', mirrorCodex: false },
      join(storeDir, 'elanous', 'auth.json'),
    );
    expect(loadStoredAccessToken(ISSUER)).toBeNull();
    expect(loadTokens(ISSUER, mcpOAuthStorePath())).toBeNull();
  });

  test('isolated instance roots do not share credentials', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'mcp-oauth-b-'));
    const otherPath = join(otherDir, 'auth.json');
    try {
      const { fetch } = makeOauthFetch({
        register: () => ({ client_id: 'a-client' }),
      });
      const { metadata } = await discoverMcpOAuth(RESOURCE_META, { fetch, storePath });
      await ensureClientRegistration(metadata, { fetch, storePath });
      expect(loadStoredRegistration(ISSUER, { storePath: otherPath })).toBeNull();
      expect(loadStoredRegistration(ISSUER, { storePath })?.clientId).toBe('a-client');
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

describe('authorization callback and code exchange', () => {
  test('rejects mismatched callback state', () => {
    const request = buildAuthorizationRequest(
      {
        issuer: ISSUER,
        authorizationEndpoint: AUTHORIZE,
        tokenEndpoint: TOKEN,
        codeChallengeMethodsSupported: ['S256'],
      },
      { clientId: 'c' },
    );
    expect(() => verifyAuthorizationCallback(request, { code: 'abc', state: 'nope' })).toThrow(
      /state/,
    );
    try {
      verifyAuthorizationCallback(request, { code: 'abc', state: 'nope' });
    } catch (err) {
      expect((err as McpOAuthError).code).toBe('state-mismatch');
    }
  });

  test('exchanges code with PKCE verifier and persists access/refresh tokens', async () => {
    const { fetch, recorded } = makeOauthFetch({});
    const tokens = await acquireAccessToken({
      resourceMetadataUrl: RESOURCE_META,
      scope: 'mcp:tools',
      fetch,
      storePath,
      authorize: async (request) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        return { code: 'auth-code', state: request.state };
      },
    });
    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.issuer).toBe(ISSUER);
    const stored = loadTokens(ISSUER, storePath);
    expect(stored?.tokens.accessToken).toBe('access-1');
    expect(stored?.tokens.refreshToken).toBe('refresh-1');
    expect(stored?.accountUuid).toBe('client-1');
    const tokenPost = recorded.find((r) => r.url === TOKEN);
    expect(tokenPost?.body).toContain('grant_type=authorization_code');
    expect(tokenPost?.body).toContain('code=auth-code');
    expect(tokenPost?.body).toContain('code_verifier=');
  });
});

describe('token lifecycle', () => {
  test('expiring access token refreshes once with refresh_token grant and stores the new access token', async () => {
    saveTokens(
      ISSUER,
      {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() + 1_000,
        tokenType: 'Bearer',
      },
      { authMode: 'mcp-oauth', accountUuid: 'client-1', mirrorCodex: false },
      storePath,
    );
    const { fetch, recorded } = makeOauthFetch({
      token: (body) => {
        expect(body).toContain('grant_type=refresh_token');
        expect(body).toContain('refresh_token=old-refresh');
        return {
          access_token: 'new-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        };
      },
    });
    const access = await getValidAccessToken(ISSUER, { fetch, storePath, tokenEndpoint: TOKEN });
    expect(access).toBe('new-access');
    expect(recorded.filter((r) => r.url === TOKEN)).toHaveLength(1);
    const stored = loadTokens(ISSUER, storePath)!;
    expect(stored.tokens.accessToken).toBe('new-access');
    expect(stored.tokens.refreshToken).toBe('rotated-refresh');
  });

  test('omitted refresh_token on rotation is retained', async () => {
    saveTokens(
      ISSUER,
      {
        accessToken: 'old-access',
        refreshToken: 'keep-me',
        expiresAt: Date.now() - 1,
        tokenType: 'Bearer',
      },
      { authMode: 'mcp-oauth', accountUuid: 'client-1', mirrorCodex: false },
      storePath,
    );
    const { fetch } = makeOauthFetch({
      token: () => ({ access_token: 'new-access', expires_in: 3600, token_type: 'Bearer' }),
    });
    await refreshStoredAccessToken({ issuer: ISSUER, tokenEndpoint: TOKEN }, { fetch, storePath });
    expect(loadTokens(ISSUER, storePath)!.tokens.refreshToken).toBe('keep-me');
  });

  test('invalid_grant refresh failure is a reasoned OAuth error and does not delete credentials', async () => {
    saveTokens(
      ISSUER,
      {
        accessToken: 'old-access',
        refreshToken: 'dead-refresh',
        expiresAt: Date.now() - 1,
        tokenType: 'Bearer',
      },
      { authMode: 'mcp-oauth', accountUuid: 'client-1', mirrorCodex: false },
      storePath,
    );
    const { fetch } = makeOauthFetch({
      token: () => ({ status: 400, body: { error: 'invalid_grant' } }),
    });
    await expect(
      refreshStoredAccessToken({ issuer: ISSUER, tokenEndpoint: TOKEN }, { fetch, storePath }),
    ).rejects.toMatchObject({ code: 'refresh' });
    expect(loadStoredAccessToken(ISSUER, { storePath })).toBe('old-access');
  });
});

// ── 리뷰 must-fix 회귀 (라운드 0 지적 · 사람이 인수해 메움) ──
//
// 넷 다 «없으면 조용히 통과하던» 자리다. 그래서 각 시험은 고친 줄을 되돌리면
// 반드시 깨지도록 «관측 대상»을 직접 센다(요청 수 · 오류 코드 · 저장된 값).

describe('must-fix 회귀 — 신원 결속과 갱신 경쟁', () => {
  test('⭐ RFC 8414 — issuer 가 물어본 인가서버와 다르면 거부한다', async () => {
    const fetch: McpOAuthFetch = async (url) => {
      if (url === AS_META) {
        // 남의 issuer 를 자칭한다. 이 이름이 «저장 열쇠»라 통과하면 남의 슬롯을 쓴다.
        return jsonRes(200, asMetadata({ issuer: 'https://192.0.2.99' }));
      }
      throw new Error(`unexpected ${url}`);
    };
    await expect(
      discoverAuthorizationServer(AS, { fetch }),
    ).rejects.toMatchObject({ code: 'identity-mismatch' });
  });

  test('⭐ 끝 슬래시만 다른 issuer 는 «같은» 식별자로 받는다', async () => {
    const fetch: McpOAuthFetch = async (url) => {
      if (url === AS_META) return jsonRes(200, asMetadata({ issuer: `${ISSUER}/` }));
      throw new Error(`unexpected ${url}`);
    };
    const meta = await discoverAuthorizationServer(AS, { fetch });
    expect(meta.issuer).toBe(`${ISSUER}/`);
  });

  test('⭐⭐ RFC 9728 — resource 가 내가 붙은 MCP 주소가 아니면 거부한다', async () => {
    const fetch: McpOAuthFetch = async (url) => {
      if (url === RESOURCE_META) {
        // 악성 서버가 «남의» 자원을 가리킨다 → 그 자원용 Bearer 를 받아가려는 시도.
        return jsonRes(200, {
          resource: 'https://192.0.2.77/mcp',
          authorization_servers: [AS],
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    await expect(
      discoverProtectedResource(RESOURCE_META, {
        fetch,
        resourceUrl: 'https://192.0.2.10/mcp',
      }),
    ).rejects.toMatchObject({ code: 'identity-mismatch' });
  });

  test('⭐ resource 가 «없으면» 결속을 요구할 때 거부한다', async () => {
    const fetch: McpOAuthFetch = async (url) => {
      if (url === RESOURCE_META) return jsonRes(200, { authorization_servers: [AS] });
      throw new Error(`unexpected ${url}`);
    };
    await expect(
      discoverProtectedResource(RESOURCE_META, {
        fetch,
        resourceUrl: 'https://192.0.2.10/mcp',
      }),
    ).rejects.toMatchObject({ code: 'identity-mismatch' });
  });

  test('⭐ resourceUrl 을 안 주면 종전대로 통과한다(옛 호출자 보호)', async () => {
    const { fetch } = makeOauthFetch({});
    const resource = await discoverProtectedResource(RESOURCE_META, { fetch });
    expect(resource.authorizationServers[0]).toBe(AS);
  });

  test('⭐⭐⭐ 동시 갱신은 «한 번»만 나간다 — 회전 토큰이 유실되지 않는다', async () => {
    saveTokens(
      ISSUER,
      {
        accessToken: 'old-access',
        refreshToken: 'rotating-1',
        expiresAt: Date.now() - 1,
        tokenType: 'Bearer',
      },
      { authMode: 'mcp-oauth', accountUuid: 'client-1', mirrorCodex: false },
      storePath,
    );
    let tokenPosts = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const fetch: McpOAuthFetch = async (url, init) => {
      if (url === TOKEN && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        tokenPosts += 1;
        // 단일-use 토큰: 두 번째 호출은 이미 폐기됐다고 답한다.
        if (tokenPosts > 1) return jsonRes(400, { error: 'invalid_grant' });
        await gate;
        return jsonRes(200, {
          access_token: 'access-2',
          refresh_token: 'rotating-2',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const both = Promise.all([
      refreshStoredAccessToken({ issuer: ISSUER, tokenEndpoint: TOKEN }, { fetch, storePath }),
      refreshStoredAccessToken({ issuer: ISSUER, tokenEndpoint: TOKEN }, { fetch, storePath }),
    ]);
    release!();
    const [a, b] = await both;
    expect(tokenPosts).toBe(1);            // ⛔ 이 줄이 single-flight 를 «직접» 센다
    expect(a.accessToken).toBe('access-2');
    expect(b.accessToken).toBe('access-2');
    expect(loadTokens(ISSUER, storePath)?.tokens.refreshToken).toBe('rotating-2');
  });

  test('⭐ 갱신이 «끝난 뒤»에는 다시 나갈 수 있다(캐시가 아니다)', async () => {
    saveTokens(
      ISSUER,
      {
        accessToken: 'old-access',
        refreshToken: 'rotating-1',
        expiresAt: Date.now() - 1,
        tokenType: 'Bearer',
      },
      { authMode: 'mcp-oauth', accountUuid: 'client-1', mirrorCodex: false },
      storePath,
    );
    let tokenPosts = 0;
    const fetch: McpOAuthFetch = async (url, init) => {
      if (url === TOKEN && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        tokenPosts += 1;
        return jsonRes(200, {
          access_token: `access-${tokenPosts}`,
          refresh_token: `rotating-${tokenPosts + 1}`,
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    await refreshStoredAccessToken({ issuer: ISSUER, tokenEndpoint: TOKEN }, { fetch, storePath });
    await refreshStoredAccessToken({ issuer: ISSUER, tokenEndpoint: TOKEN }, { fetch, storePath });
    expect(tokenPosts).toBe(2);
  });
});
