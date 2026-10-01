// ── OpenAI Codex OAuth (RFC 8628 device-code flow) ──
//
// Codex uses the OAuth 2.0 Device Authorization Grant — the same flow
// the official Codex CLI ships. Implementation borrowed directly from
// hermes-agent's hermes_cli/auth.py `_codex_device_code_login()`. Three
// HTTP endpoints:
//
//   POST auth.openai.com/api/accounts/deviceauth/usercode
//     → { user_code, device_auth_id, interval }
//   POST auth.openai.com/api/accounts/deviceauth/token
//     → 200 { authorization_code, code_verifier, expires_in }    (ready)
//     → 403/404                                                    (wait)
//   POST auth.openai.com/oauth/token                 (exchange + refresh)
//     grant_type=authorization_code | refresh_token
//
// The device flow has no localhost callback: the user opens
// https://auth.openai.com/codex/device in ANY browser (their phone works),
// types the short user_code, and the CLI polls the token endpoint until
// the server flips to 200.
//
// Refresh tokens are SINGLE-USE — the server rotates them on every
// refresh call, so we always persist both access+refresh after every
// round trip, and the oauth-store layer mirrors them to ~/.codex so
// the official CLI stays in sync.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { resolveCodexAccount, effectiveCodexHome, type CodexAccountResolution } from './codex-account.js';
import { resolveCodexAccountForRun } from './codex-account-store.js';
import { authStorePath } from './store.js';
import { platform, release, arch } from 'node:os';
import {
  saveTokens, loadTokens, expiresAtFromSeconds,
  isExpiringSoon, reconcileCodexTokensFromMirror,
  type OAuthTokens, type ProviderAuthState,
} from './store.js';

export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_DEVICE_USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
export const CODEX_DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_DEVICE_LOGIN_URL = 'https://auth.openai.com/codex/device';
export const CODEX_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
export const CODEX_API_BASE_URL = 'https://chatgpt.com/backend-api/codex';

/** Refresh expiry buffer — mirror hermes's 120s. */
export const CODEX_REFRESH_BUFFER_MS = 120 * 1000;
const DEFAULT_MAX_WAIT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;

// ── Codex client User-Agent (model-gating header) ─────────────────────
//
// OpenAI's Codex Responses backend gates model access (e.g. `gpt-5.5`) on
// the Codex client VERSION, which it parses from the `User-Agent` header the
// official CLI sends:
//
//   codex_cli_rs/<version> (<os> <os_ver>; <arch>) <terminal>
//
// (ref: codex-rs/login/src/auth/default_client.rs `get_codex_user_agent`).
// elanous's Responses provider historically sent only the `originator` header
// with NO User-Agent, so the backend treated elanous as an unknown/old Codex
// and rejected newer models with "The '<model>' model requires a newer
// version of Codex. Please upgrade to the latest app or CLI" — even though
// the user's own `codex` binary supports them (verified: `codex --yolo`
// runs gpt-5.5 on the same machine where elanous's Responses path 400s).
//
// We advertise the version of the ACTUAL `codex` binary on PATH (the same
// one the codex-app-server backend spawns), so elanous tracks the user's
// upgrades automatically. Detection is memoized; when no `codex` is found we
// fall back to a recent known-good constant.
const CODEX_ORIGINATOR = 'codex_cli_rs';
/** Last-resort version when no `codex` binary is on PATH. Bump as OpenAI
 *  raises the version floor for new models. */
const FALLBACK_CODEX_VERSION = '0.137.0';

let cachedCodexVersion: string | null = null;
function detectCodexVersion(): string {
  if (cachedCodexVersion) return cachedCodexVersion;
  try {
    // Same binary the codex-app-server backend spawns (`codex` on PATH).
    const out = execFileSync('codex', ['--version'], {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const m = out.match(/(\d+\.\d+\.\d+)/);
    if (m) {
      cachedCodexVersion = m[1];
      return cachedCodexVersion;
    }
  } catch {
    /* `codex` not on PATH (API-key-only host etc.) — use the fallback. */
  }
  cachedCodexVersion = FALLBACK_CODEX_VERSION;
  return cachedCodexVersion;
}

let cachedCodexUserAgent: string | null = null;
/** Codex-style User-Agent the OpenAI backend parses for model gating.
 *  Mirrors codex-rs `get_codex_user_agent`'s prefix. Memoized. */
export function getCodexUserAgent(): string {
  if (cachedCodexUserAgent) return cachedCodexUserAgent;
  const osType = platform() === 'darwin' ? 'Mac OS'
    : platform() === 'win32' ? 'Windows'
    : platform() === 'linux' ? 'Linux'
    : platform();
  cachedCodexUserAgent =
    `${CODEX_ORIGINATOR}/${detectCodexVersion()} (${osType} ${release()}; ${arch()})`;
  return cachedCodexUserAgent;
}

/** Test seam — clear memoized version/User-Agent. */
export function resetCodexUserAgentCacheForTesting(): void {
  cachedCodexVersion = null;
  cachedCodexUserAgent = null;
}

// ── HTTP shapes ──────────────────────────────────────────────────────

interface UserCodeResponse {
  user_code: string;
  device_auth_id: string;
  interval?: number;
  expires_in?: number;
  verification_uri_complete?: string;
  verification_uri?: string;
}

interface PollSuccessResponse {
  authorization_code: string;
  code_verifier: string;
  expires_in?: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export interface CodexLoginProgress {
  type: 'user_code' | 'polling' | 'exchanging' | 'saved';
  userCode?: string;
  loginUrl?: string;
  /** Poll attempt number (1-indexed) for 'polling' events. */
  pollAttempt?: number;
}

export interface CodexLoginOpts {
  fetchImpl?: typeof fetch;
  /** Sleep fn — tests inject a pass-through / fast stub. Default uses setTimeout. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Observer for stage transitions (user_code shown, polling, etc.). */
  onProgress?: (p: CodexLoginProgress) => void;
  /** Override polling cap (ms). */
  maxWaitMs?: number;
  /** Override initial poll interval (ms). Server's `interval` still wins when larger. */
  pollIntervalMs?: number;
  /** For tests — skip the Codex CLI dual-write. */
  mirrorCodex?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────

async function postJson<T>(fetchImpl: typeof fetch, url: string, body: Record<string, unknown>): Promise<{ status: number; body: T | null }> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: T | null = null;
  try { parsed = await res.json() as T; } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

async function postForm<T>(fetchImpl: typeof fetch, url: string, fields: Record<string, string>): Promise<{ status: number; body: T | null }> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.append(k, v);
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  });
  let parsed: T | null = null;
  try { parsed = await res.json() as T; } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Primitives (exported for tests + custom flows) ───────────────────

export async function requestDeviceCode(opts: { fetchImpl?: typeof fetch } = {}): Promise<UserCodeResponse> {
  const f = opts.fetchImpl ?? fetch;
  const { status, body } = await postJson<UserCodeResponse>(f, CODEX_DEVICE_USERCODE_URL, {
    client_id: CODEX_OAUTH_CLIENT_ID,
  });
  if (status !== 200 || !body || !body.device_auth_id || !body.user_code) {
    throw new Error(`codex deviceauth/usercode failed: status=${status}`);
  }
  return body;
}

/** Poll the device-code endpoint once. Returns null when the server
 *  says "not ready" (403/404) and the caller should keep polling. */
export async function pollDeviceCode(
  deviceAuthId: string,
  userCode: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<PollSuccessResponse | null> {
  const f = opts.fetchImpl ?? fetch;
  const { status, body } = await postJson<PollSuccessResponse>(f, CODEX_DEVICE_TOKEN_URL, {
    device_auth_id: deviceAuthId,
    user_code: userCode,
  });
  if (status === 200 && body && body.authorization_code && body.code_verifier) return body;
  // 403 / 404 mean "pending" per hermes's observed behaviour; any
  // other unexpected code is an error.
  if (status === 403 || status === 404) return null;
  // Some deployments return 400 with { error: 'authorization_pending' } —
  // tolerate as pending.
  const err = (body as any)?.error;
  if (err === 'authorization_pending' || err === 'slow_down') return null;
  throw new Error(`codex deviceauth poll failed: status=${status} error=${err ?? 'n/a'}`);
}

export async function exchangeDeviceAuthCode(
  authorizationCode: string,
  codeVerifier: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<TokenResponse> {
  const f = opts.fetchImpl ?? fetch;
  const { status, body } = await postForm<TokenResponse>(f, CODEX_OAUTH_TOKEN_URL, {
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: CODEX_REDIRECT_URI,
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  if (status !== 200 || !body || !body.access_token || !body.refresh_token) {
    throw new Error(`codex oauth/token exchange failed: status=${status}`);
  }
  return body;
}

export async function refreshCodexTokens(
  refreshToken: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<TokenResponse> {
  const f = opts.fetchImpl ?? fetch;
  const { status, body } = await postForm<TokenResponse>(f, CODEX_OAUTH_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
  });
  if (status !== 200 || !body || !body.access_token || !body.refresh_token) {
    throw new Error(`codex refresh failed: status=${status}`);
  }
  return body;
}

// ── Orchestrator ─────────────────────────────────────────────────────

/** Run the full device-code flow: request user_code → poll until the
 *  user completes login → exchange auth code → persist tokens.
 *  Returns the final ProviderAuthState. Throws on timeout, cancellation,
 *  or any non-recoverable HTTP error. */
export async function loginWithCodex(opts: CodexLoginOpts = {}): Promise<ProviderAuthState> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const maxWait = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const reportedInterval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const onProgress = opts.onProgress ?? (() => {});

  // 1) Request user_code.
  const userCode = await requestDeviceCode({ fetchImpl });
  const serverInterval = typeof userCode.interval === 'number' ? userCode.interval * 1000 : 0;
  const pollInterval = Math.max(reportedInterval, serverInterval || 0);
  onProgress({ type: 'user_code', userCode: userCode.user_code,
    loginUrl: userCode.verification_uri_complete || userCode.verification_uri || CODEX_DEVICE_LOGIN_URL });

  // 2) Poll until ready or timeout.
  const startedAt = Date.now();
  let pollResp: PollSuccessResponse | null = null;
  let attempt = 0;
  while (Date.now() - startedAt < maxWait) {
    attempt++;
    await sleep(pollInterval);
    onProgress({ type: 'polling', pollAttempt: attempt });
    pollResp = await pollDeviceCode(userCode.device_auth_id, userCode.user_code, { fetchImpl });
    if (pollResp) break;
  }
  if (!pollResp) {
    throw new Error(`codex login timed out after ${Math.round((Date.now() - startedAt) / 1000)}s — user did not complete sign-in`);
  }

  // 3) Exchange auth code + verifier.
  onProgress({ type: 'exchanging' });
  const tokenResp = await exchangeDeviceAuthCode(pollResp.authorization_code, pollResp.code_verifier, { fetchImpl });

  // 4) Persist.
  const tokens: OAuthTokens = {
    accessToken: tokenResp.access_token,
    refreshToken: tokenResp.refresh_token,
    ...(tokenResp.id_token ? { idToken: tokenResp.id_token } : {}),
    expiresAt: expiresAtFromSeconds(tokenResp.expires_in),
    scope: tokenResp.scope,
    tokenType: tokenResp.token_type ?? 'Bearer',
  };
  const state = saveTokens('openai-codex', tokens, {
    authMode: 'chatgpt',
    mirrorCodex: opts.mirrorCodex,
  });
  onProgress({ type: 'saved' });
  return state;
}

/**
 * Codex auth resolver — the SINGLE entry every codex token consumer should
 * use. Treats `~/.codex/auth.json` (shared with the official `codex` CLI) as
 * a co-equal source of truth rather than a one-way mirror:
 *
 *   1. Reconcile with the `~/.codex` mirror → adopt whichever store holds the
 *      fresher access token. The official CLI may have rotated tokens since
 *      elanous last wrote, so elanous's own copy can be stale (and its refresh
 *      token already revoked).
 *   2. Within validity → return as-is (no refresh).
 *   3. Otherwise refresh; rotating tokens persist to BOTH stores (saveTokens
 *      mirrors to `~/.codex`).
 *   4. If the refresh is REJECTED — the other consumer rotated our refresh
 *      token out from under us between (1) and now, the concurrent-refresh
 *      race — reconcile ONCE more and use the freshest token on file. Only
 *      when BOTH stores are dead do we surface an actionable re-login error.
 *
 * Returns null when no codex tokens exist. `apikey`-mode states with no
 * expiry pass straight through (no OAuth refresh).
 */
/** 이 계정의 미러 경로. ⛔ 기본 계정만 종전 규칙(CODEX_HOME || ~/.codex)이고,
 *  이름 계정은 «기록에 저장된 홈»만 쓴다. 모르면 undefined — 어느 미러도 안 본다.
 *  ⭐ 홈 판정 자체는 `effectiveCodexHome()` «하나»가 낸다 — 표면(`account list`)이 같은 자를 쓴다(4R must-fix). */
function codexMirrorPathFor(
  account: CodexAccountResolution,
  stored: { codexHome?: string } | null,
): string | undefined {
  const { home } = effectiveCodexHome(account, stored);
  return home ? join(home, 'auth.json') : undefined;
}

/** 자격 갱신 경로의 관측 — ⛔ **토큰·리프레시 토큰은 «절대» 싣지 않는다**(이름·판정·수명만).
 *
 *  ⛔⭐ 왜 이것이 필요한가 (2026-08-18 실측): 이 파일의 갱신 경로에 관측이 «0건»이었다.
 *  코드로는 「배선됐다」를 말할 수 있는데 ***「돌았나 · 성공했나 · 몇 번 갱신했나」를 못 쟀다.***
 *  107차 codex 유료 크레딧 사건이 늦게 잡힌 것과 같은 축이다 — 과금 경로가 바뀌는 사건은 «항상» 남긴다.
 *  ⚠️ deferred require — oauth ↔ debug 모듈 경계를 보존한다(이 파일의 다른 관용구와 동형). */
export type CodexAuthObserver = (event: string, data: Record<string, unknown>) => void;

/** ⛔⭐ 테스트 심 — 3라운드 리뷰 must-fix: 관측을 «넣었는데 무는 테스트가 없었다».
 *  이 저장소가 반복해서 당한 병(형태만 있고 실행 경로에 없다)이라 주입 가능하게 연다.
 *  ⚠️ 기본은 종전과 «같다»(debug.log). 심은 테스트만 준다. */
let codexAuthObserver: CodexAuthObserver | null = null;

export function _setCodexAuthObserverForTesting(observer: CodexAuthObserver | null): void {
  codexAuthObserver = observer;
}

/** 관측 이벤트 «고정 어휘» — 테스트가 이 목록으로 분기 커버를 잰다. */
export const CODEX_AUTH_EVENTS = [
  'no-credential', 'fresh', 'refresh-start', 'refreshed',
  'refresh-lost-race-recovered', 'refresh-failed-relogin-required', 'refresh-failed-using-stale',
] as const;

function observeCodexAuth(event: string, data: Record<string, unknown>): void {
  const payload = { provider: 'openai-codex', ...data };
  if (codexAuthObserver) { codexAuthObserver(event, payload); return; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { debug } = require('../debug/log.js') as typeof import('../debug/log.js');
    debug.log('llm.oauth-refresh', event, payload);
  } catch { /* fail-open — 관측 실패가 인증을 막지 않는다 */ }
}

/** 실패를 «분류»한다 — ⛔⭐ 원문(예외 메시지·응답 본문)은 «싣지 않는다».
 *
 *  🪞 1라운드에 나는 정규식으로 «지우고» 실었다가 2라운드 리뷰에 잡혔다. 그 지적이 옳다:
 *  ***휴리스틱 정화는 「토큰 절대 미포함」을 «보장»하지 못한다*** — 짧거나 특수문자를 낀 토큰이
 *  그물을 빠져나간다. ⇒ 「지우고 싣는다」가 아니라 ***「애초에 안 싣는다」***로 간다.
 *  ⚠️ 디버깅 손실은 인정한다 — 대신 «어느 종류의 실패인가»와 «길이»는 남아 재현 방향을 준다.
 *  ⛔ 새 분류를 더할 때도 «원문 조각을 넣지 마라». 이 함수의 산출은 고정 어휘여야 한다. */
export type CodexAuthErrorKind = 'network' | 'unauthorized' | 'rate-limited' | 'server' | 'timeout' | 'other';

/** 관측에 실을 수 있는 예외 «클래스» 어휘 — ⛔ whitelist 다.
 *  🪞 3라운드 리뷰 must-fix: `err.constructor.name` 을 그대로 실으면 의존성·사용자가 만든
 *  클래스명이 «자유 문자열»로 새어 나간다. ⇒ 아는 이름만 통과시키고 나머지는 'Other' 로 접는다. */
const KNOWN_ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'EvalError', 'URIError', 'AggregateError', 'DOMException', 'AbortError',
]);

export function classifyAuthError(err: unknown): { errorKind: CodexAuthErrorKind; errorName: string; messageLength: number } {
  const rawName = err instanceof Error ? err.constructor.name : typeof err;
  // ⛔ 모르는 이름은 «내보내지 않는다» — 고정 어휘만 나간다.
  const errorName = KNOWN_ERROR_NAMES.has(rawName) || ['string', 'number', 'object', 'undefined', 'boolean', 'symbol', 'function', 'bigint'].includes(rawName)
    ? rawName : 'Other';
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  // ⛔ 아래 판정은 «원문을 읽되 원문을 내보내지 않는다» — 산출은 고정 어휘뿐이다.
  const errorKind: CodexAuthErrorKind =
    /\b(401|403|invalid_grant|unauthorized|forbidden)\b/.test(lower) ? 'unauthorized'
    : /\b(429|rate.?limit|too many requests)\b/.test(lower) ? 'rate-limited'
    : /\b(5\d\d|internal server|bad gateway|service unavailable)\b/.test(lower) ? 'server'
    : /\b(timeout|timed out|etimedout|abort)\b/.test(lower) ? 'timeout'
    : /\b(econnrefused|enotfound|econnreset|network|fetch failed|dns)\b/.test(lower) ? 'network'
    : 'other';
  return { errorKind, errorName, messageLength: raw.length };
}

/** 남은 수명(초). ⛔ 모르면 0 이 아니라 null — 「안 쟀다」와 「만료됐다」는 다른 값이다. */
function remainingSeconds(state: ProviderAuthState | null): number | null {
  const exp = state?.tokens.expiresAt;
  if (exp == null) return null;
  return Math.round((exp - Date.now()) / 1000);
}

export async function loadFreshCodexAuthState(
  opts: { fetchImpl?: typeof fetch; mirrorCodex?: boolean } = {},
): Promise<ProviderAuthState | null> {
  // ⭐ 어느 «계정»의 토큰인가 — 기본 계정이면 종전과 동일한 키(`openai-codex`)다.
  //   ⛔ 이름 계정이면 그 계정의 스토어 키와 «그 계정의 홈» 미러를 쓴다(A 가 B 를 덮지 않게).
  // ⭐⭐ 그리고 «리밋에 걸렸으면 다른 계정으로 넘긴다»(S4 · 대표 결정).
  //   ⛔ 사람이 명시한 계정은 안 넘긴다 · 「모른다」로도 안 넘긴다 — 판정은 순수 함수가 한다.
  // ⛔⭐ 설정을 «여기서 다시 읽지 않는다» — 해석기 안에 한 자리만 둔다(리뷰 must-fix).
  //   호출자마다 읽으면 「설정 읽기는 한 자리」라는 배선을 호출자가 스스로 깬다.
  const account = resolveCodexAccountForRun();
  const stored = loadTokens(account.storeKey);
  // ⛔⭐⭐⭐ 읽기(reconcile) 방향도 «그 계정의 홈»으로만 본다(2R must-fix).
  //   종전엔 기본 미러 경로를 봐서, 이름 계정이 «계정 A 의 미러»를 읽어 정본을 오염시킬 수 있었다.
  //   ⇒ 쓰기만 고치고 읽기를 안 고치면 같은 사고가 «반대 방향»으로 난다.
  const mirrorPath = codexMirrorPathFor(account, stored);
  //   ⛔⭐ 그리고 «채택 결과를 어디에 적나»도 그 계정이다(3R must-fix) — 경로만 계정별로 고르고
  //     영속 키를 기본으로 두면, team 의 미러가 신선할 때 «기본 계정의 정본»이 덮인다.
  const state = mirrorPath
    ? reconcileCodexTokensFromMirror(stored, authStorePath(), mirrorPath, account.storeKey)
    : stored;   // ⛔ 이름 계정인데 홈을 모르면 «어느 미러도» 안 읽는다
  if (!state) {
    observeCodexAuth('no-credential', { storeKey: account.storeKey, mirrorPath: mirrorPath ?? null });
    return null;
  }
  if (!isExpiringSoon(state, CODEX_REFRESH_BUFFER_MS)) {
    // ⛔ 「갱신 안 함」도 남긴다 — 안 남기면 「안 돌았다」와 「필요 없었다」가 «같은 침묵»이 된다.
    observeCodexAuth('fresh', {
      storeKey: account.storeKey, remainingSeconds: remainingSeconds(state), refreshed: false,
    });
    return state;
  }
  observeCodexAuth('refresh-start', {
    storeKey: account.storeKey, remainingSeconds: remainingSeconds(state),
    mirrorPath: mirrorPath ?? null, bufferMs: CODEX_REFRESH_BUFFER_MS,
  });
  try {
    const fresh = await refreshCodexTokens(state.tokens.refreshToken, { fetchImpl: opts.fetchImpl });
    const updated: OAuthTokens = {
      accessToken: fresh.access_token,
      refreshToken: fresh.refresh_token,
      expiresAt: expiresAtFromSeconds(fresh.expires_in),
      scope: fresh.scope ?? state.tokens.scope,
      tokenType: fresh.token_type ?? state.tokens.tokenType ?? 'Bearer',
    };
    const saved = saveTokens(account.storeKey, updated, {
      authMode: state.authMode,
      ...(opts.mirrorCodex === undefined ? {} : { mirrorCodex: opts.mirrorCodex }),
    });
    observeCodexAuth('refreshed', {
      storeKey: account.storeKey, refreshed: true,
      remainingSeconds: remainingSeconds(saved),
      // ⭐ refresh_token 이 «회전»했나 — 이 값이 미러 다툼 사고의 첫 신호다.
      refreshTokenRotated: updated.refreshToken !== state.tokens.refreshToken,
      mirrorRequested: opts.mirrorCodex !== false,
    });
    return saved;
  } catch (err) {
    // Concurrent-refresh race: re-read both stores — the official codex CLI
    // (or another elanous turn) may have just refreshed, leaving a LIVE token
    // on file even though OUR refresh token got revoked.
    const reconciled = mirrorPath
      ? reconcileCodexTokensFromMirror(loadTokens(account.storeKey), authStorePath(), mirrorPath, account.storeKey)
      : loadTokens(account.storeKey);
    if (reconciled && !isExpiringSoon(reconciled, 0)) {
      // ⭐ 「내 갱신은 졌지만 남이 이미 갱신해 뒀다」 — 경합의 «정상» 결말이라 실패로 세지 않는다.
      observeCodexAuth('refresh-lost-race-recovered', {
        storeKey: account.storeKey, refreshed: false,
        remainingSeconds: remainingSeconds(reconciled),
        ...classifyAuthError(err),
      });
      return reconciled;
    }
    // Both stores dead → genuine re-login needed.
    if (isExpiringSoon(state, 0)) {
      observeCodexAuth('refresh-failed-relogin-required', {
        storeKey: account.storeKey, refreshed: false,
        ...classifyAuthError(err),
      });
      throw new Error(
        'OpenAI Codex sign-in expired and token refresh was rejected '
        + `(${err instanceof Error ? err.message : String(err)}). The refresh `
        + 'token was likely rotated by the official `codex` CLI. Re-run '
        + '`elanous login openai-codex` to re-authenticate.',
      );
    }
    // Access token still valid for its last buffer window — proceed with it.
    observeCodexAuth('refresh-failed-using-stale', {
      storeKey: account.storeKey, refreshed: false,
      remainingSeconds: remainingSeconds(reconciled ?? state),
      ...classifyAuthError(err),
    });
    return reconciled ?? state;
  }
}

/** Load + refresh if expiring soon, return a usable OAuthTokens.
 *  Returns null when no tokens are on file. Throws on refresh failure
 *  (caller decides whether to re-prompt `elanous login`).
 *
 *  Thin wrapper over `loadFreshCodexAuthState` (the canonical resolver) so
 *  every consumer follows the shared `~/.codex` source of truth + the
 *  concurrent-refresh race protection. */
export async function getCodexAccessToken(
  opts: { fetchImpl?: typeof fetch; mirrorCodex?: boolean } = {},
): Promise<OAuthTokens | null> {
  const state = await loadFreshCodexAuthState(opts);
  return state ? state.tokens : null;
}
