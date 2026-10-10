// ── MCP OAuth (RFC 9728 + RFC 8414 + RFC 7591 + PKCE) ──
//
// 401 이 준 resource_metadata / scope 를 따라가 자격을 얻고, 전역 자격
// 파일(oauth/store.ts `authStorePath()`)에 issuer 열쇠로 저장한 뒤 Bearer 로
// 다시 실어 보내는 «잇는» 모듈. 주소를 코드에 박지 않는다 — 호스트는
// 전부 그 401 안내에서 그때 얻는다.
//
// 브라우저 승인은 호출자(aside/CLI)의 책임이다. 브라우저를 쓸 수 없고
// 인가 서버가 RFC 8628 을 광고할 때는 장치 코드로 자격을 얻는다.
// 경계: 새 CLI 하위 명령은 더하지 않는다.

import { join } from 'node:path';
import { generatePkcePair } from '../oauth/pkce.js';
import {
  authStorePath,
  expiresAtFromSeconds,
  isExpiringSoon,
  loadTokens,
  saveTokens,
  type OAuthTokens,
  type ProviderAuthState,
} from '../oauth/store.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { debug } from '../debug/log.js';

const REFRESH_BUFFER_MS = 120_000;
const AUTH_MODE = 'mcp-oauth';
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1/oauth/callback';
const CLIENT_NAME = 'elanous-agent';

export type McpOAuthErrorCode =
  | 'discovery'
  /** RFC 8414 §3.3 — the metadata `issuer` disagreed with the identifier we
   *  fetched it from, or RFC 9728 `resource` disagreed with the MCP URL. */
  | 'identity-mismatch'
  | 's256-unsupported'
  | 'registration'
  | 'device'
  | 'state-mismatch'
  | 'token'
  | 'refresh';

export class McpOAuthError extends Error {
  readonly code: McpOAuthErrorCode;
  constructor(code: McpOAuthErrorCode, message: string) {
    super(message);
    this.name = 'McpOAuthError';
    this.code = code;
  }
}

export type McpOAuthFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: RequestRedirect;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface ProtectedResourceMetadata {
  resource?: string;
  authorizationServers: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint?: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  codeChallengeMethodsSupported: string[];
}

export interface ClientRegistration {
  clientId: string;
  clientSecret?: string;
  /** 동적 등록 때 쓴 redirect_uri. 옛 등록에는 없다. */
  redirectUri?: string;
  /** Registered now but not stored yet: the store still holds another client's tokens, so this registration is
   *  committed only with its own tokens (exchangeAuthorizationCode). A cancelled login leaves the store as it was. */
  pending?: boolean;
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  issuer: string;
  clientId: string;
  /** Set when the client registration is pending (see ClientRegistration.pending); in memory only. */
  pendingRegistration?: { clientSecret?: string };
  scope?: string;
  resource?: string;
}

export interface AuthorizationCallback {
  code: string;
  state: string;
}

export type AuthorizeHandler = (
  request: AuthorizationRequest,
) => Promise<AuthorizationCallback>;

export interface McpOAuthRuntimeOpts {
  fetch?: McpOAuthFetch;
  redirectUri?: string;
  storePath?: string;
  /** ⛔⭐⭐ The MCP endpoint these credentials are «for».
   *
   *  401 을 낸 서버가 `resource_metadata` 주소를 «고른다». 그 주소가 가리키는
   *  문서의 `resource` 를 안 견주면, 악의적 MCP 서버가 ***남의 자원을 가리키는
   *  메타데이터***를 내밀어 그 자원용 Bearer 를 자기에게 받아낼 수 있다
   *  (confused deputy). ⇒ 이 값이 있으면 결속을 «강제»한다. */
  resourceUrl?: string;
}

export interface AcquireAccessTokenOpts extends McpOAuthRuntimeOpts {
  resourceMetadataUrl: string;
  scope?: string;
  authorize: AuthorizeHandler;
}

/** Prepared OAuth authorization boundary for interactive callers.
 * Discovery, issuer-keyed registration reuse, and PKCE construction remain here;
 * callers only provide the human callback and may exchange it later. */
export interface McpOAuthAuthorization {
  metadata: AuthorizationServerMetadata;
  request: AuthorizationRequest;
}

export interface PrepareMcpOAuthAuthorizationOpts extends McpOAuthRuntimeOpts {
  resourceMetadataUrl: string;
  scope?: string;
  /** 저장된 등록의 포트를 못 열었을 때 새 client_id 로 다시 등록한다. */
  forceReregister?: boolean;
}

/** ⛔⭐⭐ MCP 자격은 «우주를 따라가지 않는다» — 격리 매뉴얼 §6 의 전역 사용자 자산이다.
 *
 *  종전(2026-08-20 ~)엔 `effectiveInstanceRoot()/auth.json` 에 썼다. 그래서 작업 트리
 *  TUI(격리 우주)에서 한 로그인은 `.elanous-test/auth.json` 에 갇혀 운영 데몬이 못 봤고,
 *  `config sync-test` 사본끼리는 회전형 refresh token 이 서로를 폐기했다(2026-09-26 실측:
 *  자격 파일 셋에 MCP 발급자가 흩어져 있었다). ⇒ codex 로그인과 «같은» 파일을 쓴다. */
export function mcpOAuthStorePath(): string {
  return authStorePath();
}

/** 옛 자리 — 우주 아래 자격 파일. «입양»의 읽기 원천일 뿐 다시 쓰지 않는다. */
function legacyUniverseStorePath(): string {
  return join(effectiveInstanceRoot(), 'auth.json');
}

function storePath(opts?: { storePath?: string }): string {
  return opts?.storePath ?? mcpOAuthStorePath();
}

/** 발급자 기록을 읽는다. 기본 자리에 없고 옛 우주 자리에 MCP 기록이 있으면 «더하기만» 한다.
 *  ⛔ 기본 자리에 이미 있으면 절대 덮지 않는다(회전된 새 토큰을 옛 값으로 되돌리게 된다). */
function loadIssuerState(
  issuer: string,
  opts?: { storePath?: string },
): ProviderAuthState | null {
  const path = storePath(opts);
  const current = loadTokens(issuer, path);
  if (current || opts?.storePath) return current;
  const legacy = legacyUniverseStorePath();
  if (legacy === path) return null;
  const stranded = loadTokens(issuer, legacy);
  if (!stranded || stranded.authMode !== AUTH_MODE) return null;
  saveTokens(
    issuer,
    stranded.tokens,
    {
      authMode: AUTH_MODE,
      ...(stranded.accountUuid ? { accountUuid: stranded.accountUuid } : {}),
      ...(stranded.organizationUuid ? { organizationUuid: stranded.organizationUuid } : {}),
      ...(stranded.redirectUri ? { redirectUri: stranded.redirectUri } : {}),
      mirrorCodex: false,
    },
    path,
  );
  debug.log('mcp.oauth', 'legacy-credential-adopted', { issuer, from: legacy, to: path });
  return loadTokens(issuer, path);
}

function fetchImpl(opts?: { fetch?: McpOAuthFetch }): McpOAuthFetch {
  return opts?.fetch ?? ((url, init) => fetch(url, init));
}

function requireHttpUrl(value: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new McpOAuthError('discovery', `${what} is not a URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new McpOAuthError('discovery', `${what} must be an http(s) URL`);
  }
  return parsed;
}

function parseJsonObject(
  text: string,
  what: string,
  code: McpOAuthErrorCode = 'discovery',
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new McpOAuthError(code, `${what} is not JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new McpOAuthError(code, `${what} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function getJson(
  url: string,
  fetchFn: McpOAuthFetch,
  what: string,
): Promise<Record<string, unknown>> {
  let res: Awaited<ReturnType<McpOAuthFetch>>;
  try {
    res = await fetchFn(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    throw new McpOAuthError(
      'discovery',
      `${what} request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new McpOAuthError('discovery', `${what} returned HTTP ${res.status}`);
  }
  return parseJsonObject(text, what);
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringList(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

/** Compare two OAuth identifiers (issuer / resource) for RFC-level identity.
 *
 *  ⛔⭐ **문자열 비교로는 안 된다** — `https://as.example.com` 과
 *  `https://as.example.com/` 는 «같은» 식별자인데 `===` 는 다르다고 말한다.
 *  ⇒ origin ⊕ 끝 슬래시를 벗긴 경로로만 견준다. 그 밖(질의·조각)이 붙어 있으면
 *  식별자가 아니므로 «다르다»로 읽는다. */
function normalizeOAuthIdentifier(raw: string): { origin: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.search || u.hash) return null;
  return { origin: u.origin, path: u.pathname.replace(/\/+$/, '') };
}

function sameOAuthIdentifier(a: string, b: string): boolean {
  const left = normalizeOAuthIdentifier(a);
  const right = normalizeOAuthIdentifier(b);
  return left !== null && right !== null && left.origin === right.origin && left.path === right.path;
}

/** 자원 식별자가 이 MCP 엔드포인트를 «덮는가».
 *
 *  ⛔⭐⭐ 왜 정확 일치만으로는 안 되나 (2026-09-10 실측):
 *    Topview 의 protected resource metadata 는 `resource: "https://mcp.topview.ai"` 를 내는데
 *    MCP 엔드포인트는 `https://mcp.topview.ai/mcp` 다. ***오리진을 자원 식별자로 쓰는 것은
 *    생태계에서 흔하다*** — 정확 일치만 보면 그런 서버에 «영영 못 붙는다».
 *
 *  ⭐ 그런데 완화가 «보안 성질»을 깨면 안 된다. 원래 검사가 막던 것은
 *    ***악성 서버가 「남의 자원 문서」를 가리켜 그 자원용 Bearer 를 가로채는 것***이다.
 *    ⇒ 그래서 넓히는 축은 **경로**뿐이고 **오리진은 여전히 «정확히» 같아야 한다.**
 *
 *  ⛔ 그리고 경로는 «세그먼트 경계»로만 덮는다 — 문자열 접두로 보면
 *    `https://x/mcp` 가 `https://x/mcp-evil` 을 덮어 버린다.
 */
function resourceCoversEndpoint(resource: string, endpoint: string): boolean {
  const res = normalizeOAuthIdentifier(resource);
  const ep = normalizeOAuthIdentifier(endpoint);
  if (res === null || ep === null) return false;
  if (res.origin !== ep.origin) return false;      // ⛔ 오리진은 «정확 일치»만
  if (res.path === ep.path) return true;
  if (res.path === '') return true;                 // 오리진이 곧 자원 (Topview 형태)
  return ep.path.startsWith(`${res.path}/`);        // ⛔ 세그먼트 경계로만
}

/** RFC 8414 well-known metadata URL for an authorization-server identifier. */
export function authorizationServerMetadataUrl(authorizationServer: string): string {
  const url = requireHttpUrl(authorizationServer, 'authorization_servers entry');
  const suffix = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${url.origin}/.well-known/oauth-authorization-server${suffix}`;
}

export async function discoverProtectedResource(
  resourceMetadataUrl: string,
  opts: McpOAuthRuntimeOpts = {},
): Promise<ProtectedResourceMetadata> {
  requireHttpUrl(resourceMetadataUrl, 'resource_metadata');
  const body = await getJson(
    resourceMetadataUrl,
    fetchImpl(opts),
    'protected resource metadata',
  );
  const authorizationServers = stringList(body, 'authorization_servers');
  if (authorizationServers.length === 0) {
    throw new McpOAuthError(
      'discovery',
      'protected resource metadata has no authorization_servers',
    );
  }
  requireHttpUrl(authorizationServers[0]!, 'authorization_servers[0]');
  const resource = stringField(body, 'resource');
  // ⛔⭐⭐⭐ RFC 9728 — 이 문서가 «내가 붙은 그 자원»의 것인지 견준다.
  //    ⚠️ 401 을 낸 쪽이 `resource_metadata` 주소를 고르므로, 이 검사가 없으면
  //    악성 서버가 남의 자원 문서를 가리켜 ***그 자원용 Bearer 를 자기가 받아간다***.
  //    ⛔ 「문서를 못 읽었다」가 아니라 「읽었는데 남의 것이다」를 «구분해서» 막는다.
  if (opts.resourceUrl) {
    if (!resource) {
      throw new McpOAuthError(
        'identity-mismatch',
        'protected resource metadata has no `resource` to bind against the MCP endpoint',
      );
    }
    if (!resourceCoversEndpoint(resource, opts.resourceUrl)) {
      throw new McpOAuthError(
        'identity-mismatch',
        `protected resource metadata describes ${resource}, which does not cover the MCP endpoint ${opts.resourceUrl}`,
      );
    }
  }
  return {
    ...(resource ? { resource } : {}),
    authorizationServers,
  };
}

export async function discoverAuthorizationServer(
  authorizationServer: string,
  opts: McpOAuthRuntimeOpts = {},
): Promise<AuthorizationServerMetadata> {
  const metadataUrl = authorizationServerMetadataUrl(authorizationServer);
  const body = await getJson(
    metadataUrl,
    fetchImpl(opts),
    'authorization server metadata',
  );
  const issuer = stringField(body, 'issuer');
  const authorizationEndpoint = stringField(body, 'authorization_endpoint');
  const tokenEndpoint = stringField(body, 'token_endpoint');
  if (!issuer || !tokenEndpoint || (!authorizationEndpoint && !stringField(body, 'device_authorization_endpoint'))) {
    throw new McpOAuthError(
      'discovery',
      'authorization server metadata is missing issuer, authorization_endpoint, or token_endpoint',
    );
  }
  requireHttpUrl(issuer, 'issuer');
  if (authorizationEndpoint) requireHttpUrl(authorizationEndpoint, 'authorization_endpoint');
  requireHttpUrl(tokenEndpoint, 'token_endpoint');
  // ⛔⭐⭐ RFC 8414 §3.3 — 돌려받은 `issuer` 는 «우리가 물어본» 인가서버
  //    식별자와 «같아야» 한다. 안 대조하면 metadata 를 쥔 쪽이 남의 issuer 를
  //    자칭할 수 있고, 그 이름이 «저장 열쇠»라서 ***다른 issuer 슬롯의 등록·토큰을
  //    끌어 쓰거나 그 슬롯에 덮어쓴다***. 열쇠가 곧 신원인 설계라 이 검사가 그 신원의 유일한 관문이다.
  if (!sameOAuthIdentifier(issuer, authorizationServer)) {
    throw new McpOAuthError(
      'identity-mismatch',
      `authorization server metadata issuer (${issuer}) does not match the identifier it was fetched from (${authorizationServer})`,
    );
  }
  const registrationEndpoint = stringField(body, 'registration_endpoint');
  if (registrationEndpoint) requireHttpUrl(registrationEndpoint, 'registration_endpoint');
  const deviceAuthorizationEndpoint = stringField(body, 'device_authorization_endpoint');
  if (deviceAuthorizationEndpoint) requireHttpUrl(deviceAuthorizationEndpoint, 'device_authorization_endpoint');
  return {
    issuer,
    ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
    tokenEndpoint,
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    ...(deviceAuthorizationEndpoint ? { deviceAuthorizationEndpoint } : {}),
    codeChallengeMethodsSupported: stringList(body, 'code_challenge_methods_supported'),
  };
}

export async function discoverMcpOAuth(
  resourceMetadataUrl: string,
  opts: McpOAuthRuntimeOpts = {},
): Promise<{ resource: ProtectedResourceMetadata; metadata: AuthorizationServerMetadata }> {
  const resource = await discoverProtectedResource(resourceMetadataUrl, opts);
  const metadata = await discoverAuthorizationServer(resource.authorizationServers[0]!, opts);
  return { resource, metadata };
}

function registrationFromState(state: ProviderAuthState | null): ClientRegistration | null {
  const clientId = state?.accountUuid?.trim();
  if (!state || !clientId) return null;
  const clientSecret = state.organizationUuid?.trim();
  const redirectUri = state.redirectUri?.trim();
  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    ...(redirectUri ? { redirectUri } : {}),
  };
}

function persistRegistration(
  issuer: string,
  registration: ClientRegistration,
  path: string,
  tokens?: OAuthTokens,
): void {
  const existing = loadTokens(issuer, path);
  saveTokens(
    issuer,
    tokens ?? existing?.tokens ?? { accessToken: '', refreshToken: '', expiresAt: null },
    {
      authMode: AUTH_MODE,
      accountUuid: registration.clientId,
      ...(registration.clientSecret
        ? { organizationUuid: registration.clientSecret }
        : existing?.organizationUuid
          ? { organizationUuid: existing.organizationUuid }
          : {}),
      ...(registration.redirectUri ? { redirectUri: registration.redirectUri } : {}),
      mirrorCodex: false,
    },
    path,
  );
}

/** 루프백 redirect_uri 의 TCP 포트. 없거나 기본 포트(생략)면 null. */
export function loopbackRedirectPort(redirectUri: string | undefined): number | null {
  if (!redirectUri?.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== '[::1]') {
    return null;
  }
  if (!parsed.port) return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

export function loadStoredRegistration(
  issuer: string,
  opts: McpOAuthRuntimeOpts = {},
): ClientRegistration | null {
  return registrationFromState(loadIssuerState(issuer, opts));
}

export async function ensureClientRegistration(
  metadata: AuthorizationServerMetadata,
  opts: McpOAuthRuntimeOpts & { forceReregister?: boolean; deviceCode?: boolean } = {},
): Promise<ClientRegistration> {
  const path = storePath(opts);
  if (!opts.forceReregister) {
    const stored = loadStoredRegistration(metadata.issuer, { storePath: path });
    // Browser registrations require a bound loopback URI. Device authorization reuses a client without one
    // (a prior device client — its stored refresh token stays paired with it), or any client when it cannot register.
    if (stored && opts.deviceCode && (!stored.redirectUri || !metadata.registrationEndpoint)) return stored;
    if (stored?.redirectUri && !opts.deviceCode) return stored;
  }
  if (!metadata.registrationEndpoint) {
    throw new McpOAuthError(
      'registration',
      'no stored client registration and authorization server has no registration_endpoint',
    );
  }
  const redirectUri = opts.redirectUri ?? DEFAULT_REDIRECT_URI;
  let res: Awaited<ReturnType<McpOAuthFetch>>;
  try {
    res = await fetchImpl(opts)(metadata.registrationEndpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        ...(opts.deviceCode ? {} : { redirect_uris: [redirectUri] }),
        grant_types: opts.deviceCode ? ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'] : ['authorization_code', 'refresh_token'],
        response_types: opts.deviceCode ? [] : ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      }),
    });
  } catch (err) {
    throw new McpOAuthError(
      'registration',
      `dynamic registration request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new McpOAuthError('registration', `dynamic registration returned HTTP ${res.status}`);
  }
  const body = parseJsonObject(text, 'dynamic registration response');
  const clientId = stringField(body, 'client_id');
  if (!clientId) {
    throw new McpOAuthError('registration', 'dynamic registration response is missing client_id');
  }
  const clientSecret = stringField(body, 'client_secret');
  const registration: ClientRegistration = {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    ...(opts.deviceCode ? {} : { redirectUri }),
  };
  // A device client is stored only with its first tokens (authorizeMcpDevice): until a device login succeeds,
  // the stored registration and the refresh token paired with it stay as they were.
  if (opts.deviceCode) return registration;
  // A browser registration over another client's live tokens (e.g. after a device login) waits for its own
  // tokens: storing it now would orphan the stored refresh token if this approval is cancelled or fails.
  const existing = loadTokens(metadata.issuer, path);
  if (existing?.tokens.refreshToken && existing.accountUuid && existing.accountUuid !== clientId) return { ...registration, pending: true };
  persistRegistration(metadata.issuer, registration, path);
  return registration;
}

function supportsS256(metadata: AuthorizationServerMetadata): boolean {
  return metadata.codeChallengeMethodsSupported.some(
    (method) => method.toUpperCase() === 'S256',
  );
}

export function buildAuthorizationRequest(
  metadata: AuthorizationServerMetadata,
  registration: ClientRegistration,
  opts: {
    scope?: string;
    resource?: string;
    redirectUri?: string;
  } = {},
): AuthorizationRequest {
  if (!supportsS256(metadata)) {
    throw new McpOAuthError(
      's256-unsupported',
      'authorization server does not advertise code_challenge_methods_supported=S256',
    );
  }
  if (!metadata.authorizationEndpoint) throw new McpOAuthError('discovery', 'authorization server has no authorization_endpoint for browser login');
  const pkce = generatePkcePair();
  const redirectUri = opts.redirectUri ?? DEFAULT_REDIRECT_URI;
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', registration.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', pkce.state);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  const scope = opts.scope?.trim();
  if (scope) url.searchParams.set('scope', scope);
  if (opts.resource) url.searchParams.set('resource', opts.resource);
  return {
    url: url.toString(),
    state: pkce.state,
    codeVerifier: pkce.verifier,
    redirectUri,
    issuer: metadata.issuer,
    clientId: registration.clientId,
    ...(registration.pending ? { pendingRegistration: registration.clientSecret ? { clientSecret: registration.clientSecret } : {} } : {}),
    ...(scope ? { scope } : {}),
    ...(opts.resource ? { resource: opts.resource } : {}),
  };
}

export function verifyAuthorizationCallback(
  request: AuthorizationRequest,
  callback: AuthorizationCallback,
): string {
  if (!callback.state || callback.state !== request.state) {
    throw new McpOAuthError('state-mismatch', 'authorization callback state does not match');
  }
  const code = callback.code?.trim();
  if (!code) {
    throw new McpOAuthError('token', 'authorization callback is missing code');
  }
  return code;
}

function formBody(fields: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) params.set(key, value);
  }
  return params.toString();
}

function oauthErrorPayload(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    if (typeof parsed?.error === 'string' && parsed.error.trim()) {
      const description =
        typeof parsed.error_description === 'string' && parsed.error_description.trim()
          ? `: ${parsed.error_description.trim()}`
          : '';
      return `${parsed.error.trim()}${description}`;
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

async function postToken(
  tokenEndpoint: string,
  fields: Record<string, string | undefined>,
  fetchFn: McpOAuthFetch,
  code: 'token' | 'refresh',
): Promise<OAuthTokens> {
  let res: Awaited<ReturnType<McpOAuthFetch>>;
  try {
    res = await fetchFn(tokenEndpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: formBody(fields),
    });
  } catch (err) {
    throw new McpOAuthError(
      code,
      `token endpoint request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    const payload = oauthErrorPayload(text);
    throw new McpOAuthError(
      code,
      payload
        ? `token endpoint returned HTTP ${res.status} (${payload})`
        : `token endpoint returned HTTP ${res.status}`,
    );
  }
  const body = parseJsonObject(text, 'token response', code);
  const accessToken = stringField(body, 'access_token');
  if (!accessToken) {
    throw new McpOAuthError(code, 'token response is missing access_token');
  }
  const refreshToken = stringField(body, 'refresh_token') ?? '';
  const scope = stringField(body, 'scope');
  const tokenType = stringField(body, 'token_type') ?? 'Bearer';
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresAtFromSeconds(body.expires_in),
    ...(scope ? { scope } : {}),
    tokenType,
  };
}

function persistTokens(
  issuer: string,
  tokens: OAuthTokens,
  registration: ClientRegistration | null,
  path: string,
): void {
  const existing = loadTokens(issuer, path);
  const clientId = registration?.clientId ?? existing?.accountUuid;
  const clientSecret = registration?.clientSecret ?? existing?.organizationUuid;
  saveTokens(
    issuer,
    tokens,
    {
      authMode: AUTH_MODE,
      ...(clientId ? { accountUuid: clientId } : {}),
      ...(clientSecret ? { organizationUuid: clientSecret } : {}),
      // A loopback URI belongs to the client that registered it — never carry it onto a different (device) client.
      ...(existing?.redirectUri && (!registration || registration.clientId === existing.accountUuid) ? { redirectUri: existing.redirectUri } : {}),
      mirrorCodex: false,
    },
    path,
  );
}

export interface McpDeviceAuthorization {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
}

/** RFC 8628: only an advertised endpoint enables the fallback; tokens use the same issuer store. */
export async function authorizeMcpDevice(
  metadata: AuthorizationServerMetadata,
  registration: ClientRegistration,
  opts: McpOAuthRuntimeOpts & {
    scope?: string;
    resource?: string;
    onDeviceCode: (code: McpDeviceAuthorization) => Promise<void> | void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<OAuthTokens> {
  const endpoint = metadata.deviceAuthorizationEndpoint;
  if (!endpoint) throw new McpOAuthError('device', 'authorization server does not advertise device_authorization_endpoint');
  const fetchFn = fetchImpl(opts);
  const post = async (url: string, fields: Record<string, string | undefined>) => {
    let response: Awaited<ReturnType<McpOAuthFetch>>;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody(fields),
      });
    } catch (error) {
      throw new McpOAuthError('device', `device authorization request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    return { status: response.status, body: parseJsonObject(text, 'device authorization response', 'device') };
  };
  const started = await post(endpoint, {
    client_id: registration.clientId,
    client_secret: registration.clientSecret,
    scope: opts.scope,
    resource: opts.resource,
  });
  const deviceCode = stringField(started.body, 'device_code');
  const userCode = stringField(started.body, 'user_code');
  const verificationUri = stringField(started.body, 'verification_uri');
  if (started.status < 200 || started.status >= 300 || !deviceCode || !userCode || !verificationUri) {
    const error = stringField(started.body, 'error');
    throw new McpOAuthError('device', `device authorization returned HTTP ${started.status}${error ? ` (${error})` : ''} or missing required fields`);
  }
  requireHttpUrl(verificationUri, 'verification_uri');
  const verificationUriComplete = stringField(started.body, 'verification_uri_complete');
  if (verificationUriComplete) requireHttpUrl(verificationUriComplete, 'verification_uri_complete');
  const seconds = started.body.expires_in;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new McpOAuthError('device', 'device authorization response has invalid expires_in');
  }
  const now = opts.now ?? Date.now;
  const deadline = now() + Math.min(seconds * 1000, 15 * 60_000);
  let interval = typeof started.body.interval === 'number' && Number.isFinite(started.body.interval) && started.body.interval > 0
    ? Math.max(1000, started.body.interval * 1000) : 5000;
  await opts.onDeviceCode({ userCode, verificationUri, ...(verificationUriComplete ? { verificationUriComplete } : {}) });
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let attempts = 0;
  while (now() < deadline) {
    if (++attempts > Math.ceil(Math.min(seconds, 900)) + 1) throw new McpOAuthError('device', 'device authorization polling limit exceeded');
    await sleep(Math.min(interval, deadline - now()));
    if (now() >= deadline) break;
    const polled = await post(metadata.tokenEndpoint, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: registration.clientId,
      client_secret: registration.clientSecret,
      resource: opts.resource,
    });
    if (polled.status >= 200 && polled.status < 300) {
      const accessToken = stringField(polled.body, 'access_token');
      if (!accessToken) throw new McpOAuthError('token', 'device token response is missing access_token');
      const tokens: OAuthTokens = {
        accessToken,
        refreshToken: stringField(polled.body, 'refresh_token') ?? '',
        expiresAt: expiresAtFromSeconds(polled.body.expires_in),
        tokenType: stringField(polled.body, 'token_type') ?? 'Bearer',
        ...(stringField(polled.body, 'scope') ? { scope: stringField(polled.body, 'scope') } : {}),
      };
      persistTokens(metadata.issuer, tokens, registration, storePath(opts));
      return tokens;
    }
    const error = stringField(polled.body, 'error');
    if (error === 'slow_down') interval += 5000;
    else if (error !== 'authorization_pending') throw new McpOAuthError('device', `device token request returned HTTP ${polled.status} (${error ?? 'unknown'})`);
  }
  throw new McpOAuthError('device', 'device authorization expired before approval');
}

export async function exchangeAuthorizationCode(
  metadata: AuthorizationServerMetadata,
  request: AuthorizationRequest,
  callback: AuthorizationCallback,
  opts: McpOAuthRuntimeOpts = {},
): Promise<OAuthTokens> {
  const code = verifyAuthorizationCallback(request, callback);
  const path = storePath(opts);
  const pending = request.pendingRegistration;
  const registration: ClientRegistration | null = pending
    ? { clientId: request.clientId, ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}), redirectUri: request.redirectUri }
    : loadStoredRegistration(metadata.issuer, { storePath: path });
  const tokens = await postToken(
    metadata.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: request.redirectUri,
      client_id: request.clientId,
      code_verifier: request.codeVerifier,
      ...(registration?.clientSecret ? { client_secret: registration.clientSecret } : {}),
      ...(request.resource ? { resource: request.resource } : {}),
    },
    fetchImpl(opts),
    'token',
  );
  // A pending registration is committed together with the tokens it just earned.
  if (pending) persistRegistration(metadata.issuer, registration!, path, tokens);
  else persistTokens(
    metadata.issuer,
    tokens,
    registration ?? { clientId: request.clientId },
    path,
  );
  return tokens;
}

/** In-flight refreshes, keyed by «issuer ⊕ 저장 파일». ⛔ 열쇠에 경로가 «같이»
 *  들어가는 이유: 호출자가 `storePath` 로 다른 파일을 줄 수 있으므로 issuer 만으로
 *  묶으면 서로 다른 파일의 갱신이 서로를 기다린다. */
const inFlightRefreshes = new Map<string, Promise<OAuthTokens>>();

export async function refreshStoredAccessToken(
  metadata: Pick<AuthorizationServerMetadata, 'issuer' | 'tokenEndpoint'>,
  opts: McpOAuthRuntimeOpts = {},
): Promise<OAuthTokens> {
  // ⛔⭐⭐ refresh token 은 «한 번 쓰면 도는» 값이다(rotation). 동시 요청 둘이
  //    각자 갱신하면 ***뒤늦은 쪽이 이미 폐기된 토큰을 내밀어 실패하고, 그 사이
  //    저장소의 새 토큰을 옛 값으로 덮어써 자격을 통째로 잃는다.***
  //    ⇒ issuer 별로 «한 번만» 날리고 나머지는 그 결과를 같이 받는다.
  const key = `${metadata.issuer}\n${storePath(opts)}`;
  const running = inFlightRefreshes.get(key);
  if (running) return running;
  const started = refreshStoredAccessTokenUncoalesced(metadata, opts).finally(() => {
    inFlightRefreshes.delete(key);
  });
  inFlightRefreshes.set(key, started);
  return started;
}

async function refreshStoredAccessTokenUncoalesced(
  metadata: Pick<AuthorizationServerMetadata, 'issuer' | 'tokenEndpoint'>,
  opts: McpOAuthRuntimeOpts = {},
): Promise<OAuthTokens> {
  const path = storePath(opts);
  const existing = loadIssuerState(metadata.issuer, opts);
  const refreshToken = existing?.tokens.refreshToken?.trim();
  if (!existing || !refreshToken) {
    throw new McpOAuthError('refresh', 'no refresh_token is stored for this issuer');
  }
  const registration = registrationFromState(existing);
  const tokens = await postToken(
    metadata.tokenEndpoint,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      ...(registration?.clientId ? { client_id: registration.clientId } : {}),
      ...(registration?.clientSecret ? { client_secret: registration.clientSecret } : {}),
    },
    fetchImpl(opts),
    'refresh',
  );
  const retained: OAuthTokens = {
    ...tokens,
    refreshToken: tokens.refreshToken || existing.tokens.refreshToken,
    scope: tokens.scope ?? existing.tokens.scope,
    tokenType: tokens.tokenType ?? existing.tokens.tokenType ?? 'Bearer',
  };
  persistTokens(metadata.issuer, retained, registration, path);
  return retained;
}

export function loadStoredAccessToken(
  issuer: string,
  opts: McpOAuthRuntimeOpts = {},
): string | null {
  const access = loadIssuerState(issuer, opts)?.tokens.accessToken?.trim();
  return access ? access : null;
}

export async function getValidAccessToken(
  issuer: string,
  opts: McpOAuthRuntimeOpts & { tokenEndpoint?: string } = {},
): Promise<string | null> {
  const path = storePath(opts);
  const existing = loadIssuerState(issuer, opts);
  const access = existing?.tokens.accessToken?.trim();
  if (!existing || !access) return null;
  if (!isExpiringSoon(existing, REFRESH_BUFFER_MS)) return access;
  const tokenEndpoint = opts.tokenEndpoint;
  if (!tokenEndpoint || !existing.tokens.refreshToken?.trim()) return access;
  try {
    const refreshed = await refreshStoredAccessToken(
      { issuer, tokenEndpoint },
      { ...opts, storePath: path },
    );
    return refreshed.accessToken;
  } catch {
    return access;
  }
}

export async function prepareMcpOAuthAuthorization(
  opts: PrepareMcpOAuthAuthorizationOpts,
): Promise<McpOAuthAuthorization> {
  const { resource, metadata } = await discoverMcpOAuth(opts.resourceMetadataUrl, opts);
  const registration = await ensureClientRegistration(metadata, {
    ...opts,
    ...(opts.forceReregister ? { forceReregister: true } : {}),
  });
  const request = buildAuthorizationRequest(metadata, registration, {
    scope: opts.scope,
    resource: resource.resource,
    redirectUri: opts.redirectUri,
  });
  return { metadata, request };
}

export async function acquireAccessToken(
  opts: AcquireAccessTokenOpts,
): Promise<{ accessToken: string; issuer: string }> {
  const authorization = await prepareMcpOAuthAuthorization(opts);
  const callback = await opts.authorize(authorization.request);
  const tokens = await exchangeAuthorizationCode(
    authorization.metadata,
    authorization.request,
    callback,
    opts,
  );
  return { accessToken: tokens.accessToken, issuer: authorization.metadata.issuer };
}

export interface RecoverAccessTokenOpts extends McpOAuthRuntimeOpts {
  resourceMetadataUrl?: string;
  scope?: string;
  issuer?: string;
  tokenEndpoint?: string;
  hadBearer: boolean;
  authorize?: AuthorizeHandler;
}

/**
 * 401 recovery for the MCP HTTP client.
 *
 *  • no metadata and no known issuer → cannot recover
 *  • credentials were sent → refresh once (never a full re-authorize)
 *  • credentials were not sent → reuse a stored token, or run the
 *    authorization-code flow when an AuthorizeHandler is provided
 */
export async function recoverAccessToken(
  opts: RecoverAccessTokenOpts,
): Promise<{ accessToken: string; issuer: string; tokenEndpoint?: string } | null> {
  let issuer = opts.issuer;
  let tokenEndpoint = opts.tokenEndpoint;
  let metadata: AuthorizationServerMetadata | undefined;
  let resource: ProtectedResourceMetadata | undefined;

  if (opts.resourceMetadataUrl) {
    const discovered = await discoverMcpOAuth(opts.resourceMetadataUrl, opts);
    resource = discovered.resource;
    metadata = discovered.metadata;
    issuer = metadata.issuer;
    tokenEndpoint = metadata.tokenEndpoint;
  }
  if (!issuer) return null;

  if (opts.hadBearer) {
    if (!tokenEndpoint) return null;
    const refreshed = await refreshStoredAccessToken(
      { issuer, tokenEndpoint },
      opts,
    );
    return { accessToken: refreshed.accessToken, issuer, tokenEndpoint };
  }

  const existing = await getValidAccessToken(issuer, { ...opts, tokenEndpoint });
  if (existing) return { accessToken: existing, issuer, tokenEndpoint };

  if (!opts.authorize || !metadata) return null;
  const registration = await ensureClientRegistration(metadata, opts);
  const request = buildAuthorizationRequest(metadata, registration, {
    scope: opts.scope,
    resource: resource?.resource,
    redirectUri: opts.redirectUri,
  });
  const callback = await opts.authorize(request);
  const tokens = await exchangeAuthorizationCode(metadata, request, callback, opts);
  return { accessToken: tokens.accessToken, issuer, tokenEndpoint };
}
