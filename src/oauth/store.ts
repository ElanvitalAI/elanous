// ── OAuth token storage ──
//
// Tokens for every OAuth-capable provider live in a single keyed file:
//   ~/.config/elanous/auth.json
//     {
//       "version": 1,
//       "providers": {
//         "openai-codex": { tokens: {...}, lastRefresh: "...", authMode: "chatgpt" },
//         "anthropic":    { tokens: {...}, lastRefresh: "...", accountEmail: "..." }
//       }
//     }
//
// File permissions are clamped to 0o600 on every write. We keep
// tokens separate from the main config.json so `elanous setup`
// re-runs don't accidentally rewrite credentials — and because
// auth.json's lifecycle (written by `elanous login`, read on every API
// call) has different churn than settings.
//
// For OpenAI Codex specifically, refresh tokens are SINGLE-USE — the
// server rotates them on every refresh. If we don't also mirror the
// new tokens back to ~/.codex/auth.json (the location the official
// Codex CLI reads), the CLI's next refresh fires with the
// already-consumed refresh_token and the user gets
// `refresh_token_reused`. So writeTokens('openai-codex', ...) also
// does a best-effort write-back to $CODEX_HOME/auth.json. hermes's
// dual-write pattern, direct port.

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, renameSync,
  chmodSync, realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { extractChatGPTClaims, decodeJWTPayload, type ChatGPTClaims } from './jwt.js';
import { debug } from '../debug/log.js';
import { isCodexStoreKey } from './codex-account.js';
import { migrateLegacyXdgFile } from '../storage/legacy-elanous-dir-migrate.js';

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** OpenID token issued with the initial Codex authorization-code exchange.
   *  The official Codex CLI requires it to open a newly created ChatGPT auth.json. */
  idToken?: string;
  /** Milliseconds since epoch; populated from `expires_in * 1000 + Date.now()`
   *  at exchange/refresh time. Null means we don't track expiry for this
   *  provider (rare — most OAuth tokens expire). */
  expiresAt: number | null;
  /** Space-separated scopes, as returned by the server. */
  scope?: string;
  tokenType?: string;
}

export type CodexMirrorResult = 'written' | 'not-created-missing-cli-fields' | 'write-failed';

export interface ProviderAuthState {
  tokens: OAuthTokens;
  /** ISO timestamp of the most recent refresh. Hermes uses this for
   *  UX and telemetry; we mirror it for Codex dual-write. */
  lastRefresh: string;
  /** Free-form mode tag so a provider can distinguish auth variants
   *  (Codex: 'chatgpt' vs 'apikey'; Anthropic: 'claudeai' vs 'console'). */
  authMode?: string;
  /** Email / account uuid / org uuid — optional metadata captured at
   *  login for UI purposes. */
  accountEmail?: string;
  accountUuid?: string;
  organizationUuid?: string;
  /** MCP 동적 등록 때 쓴 redirect_uri. 선택 칸 — 없으면 옛 등록이다. */
  redirectUri?: string;
  /** ⭐⭐ 이 계정의 공식 CLI 홈(= 미러 대상). ⛔ 이것이 «토큰과 함께» 저장되는 이유:
   *  미러 대상을 «주변 env/config»로 정하면, 저장하는 키와 미러 가는 홈이 «갈릴 수 있다»
   *  (2026-08-05 1R must-fix — `saveTokens('openai-codex:team')` 이 기본 홈을 오염시켰다).
   *  ⇒ 미러는 «그 기록이 말하는 홈»으로만 간다. 없으면 기본 계정 규칙(CODEX_HOME || ~/.codex). */
  codexHome?: string;
  /** ChatGPT-specific claims decoded from the access-token JWT.
   *  Populated automatically on saveTokens('openai-codex', ...) when
   *  the token's payload carries them (OAuth mode). The Codex
   *  Responses fetch path reads `accountId` to emit the required
   *  `chatgpt-account-id` header — without it, chatgpt.com/backend-api
   *  can't route the request to the user's Plus/Pro subscription. */
  chatGPT?: ChatGPTClaims;
  /** Result of this save's best-effort official Codex CLI mirror attempt.
   *  This runtime-only field lets the login surface avoid claiming a mirror
   *  was created when the CLI-required first-login fields were unavailable. */
  codexMirrorResult?: CodexMirrorResult;
}

export interface AuthStore {
  version: number;
  providers: Record<string, ProviderAuthState>;
}

const STORE_VERSION = 1;

// FU2 (PLAN-config-unification-elanous-root-2026-05-10 closing follow-up):
//   moved from ~/.config/elanous/auth.json → ~/.elanous/auth.json. First
//   call migrates legacy XDG file with `.bak` rename · 0o600 preserved.
//   XDG_CONFIG_HOME explicit honors legacy path (Phase 6 deprecation).
export function authStorePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, 'elanous', 'auth.json');
  migrateLegacyXdgFile('auth.json', 0o600);
  return join(homedir(), '.elanous', 'auth.json');
}

/** 기본 계정의 홈 — 종전 규칙 그대로. ⛔ 이름 계정은 «자기 기록»의 codexHome 을 쓴다. */
export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const envHome = env.CODEX_HOME?.trim();
  return envHome && envHome.length > 0 ? envHome : join(homedir(), '.codex');
}

function codexAuthPath(): string {
  return join(defaultCodexHome(), 'auth.json');
}

function readStore(path: string = authStorePath()): AuthStore {
  if (!existsSync(path)) return { version: STORE_VERSION, providers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return { version: STORE_VERSION, providers: {} };
    return {
      version: typeof parsed.version === 'number' ? parsed.version : STORE_VERSION,
      providers: (parsed.providers && typeof parsed.providers === 'object')
        ? parsed.providers as Record<string, ProviderAuthState>
        : {},
    };
  } catch {
    return { version: STORE_VERSION, providers: {} };
  }
}

function writeStore(store: AuthStore, path: string = authStorePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

// ── Public API ───────────────────────────────────────────────────────

export function loadTokens(provider: string, path: string = authStorePath()): ProviderAuthState | null {
  const store = readStore(path);
  return store.providers[provider] ?? null;
}

/** Decode a JWT's `exp` claim into epoch-ms (or null when absent/bad). */
function jwtExpMs(token: string): number | null {
  const payload = decodeJWTPayload(token);
  const exp = payload?.exp;
  return typeof exp === 'number' ? exp * 1000 : null;
}

/**
 * Reconcile elanous's canonical Codex tokens with the ~/.codex/auth.json
 * mirror, adopting whichever store holds the FRESHER access token.
 *
 * Codex OAuth tokens live in TWO files: elanous's canonical store
 * (~/.elanous/auth.json) AND ~/.codex/auth.json (shared with the official
 * `codex` CLI; elanous mirrors rotating tokens there via mirrorCodexAuth).
 * OpenAI rotates the refresh token on every use and REVOKES the prior one.
 * So when the official CLI refreshes — updating ONLY ~/.codex/auth.json —
 * elanous's canonical copy goes stale and its stored refresh token gets
 * revoked server-side. Every later elanous refresh then 401s, hard-failing
 * Codex turns with an opaque "Internal error".
 *
 * Observed 2026-06-08: elanous store frozen at 2026-05-03 (access token
 * expired 2026-05-13) while ~/.codex held a valid token refreshed
 * 2026-06-04 → `codex refresh failed: status=401` on every iPad chat turn.
 *
 * Selection shares this read-only parser with reconciliation, without
 * persisting a credential or contacting an auth server.
 */
export function readCodexMirrorTokens(mirrorPath: string = codexAuthPath()): OAuthTokens | null {
  try {
    const mirror = JSON.parse(readFileSync(mirrorPath, 'utf-8')) as { tokens?: Record<string, unknown> };
    const access = mirror?.tokens?.access_token;
    const refresh = mirror?.tokens?.refresh_token;
    if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh) return null;
    const expiresAt = jwtExpMs(access);
    if (expiresAt === null) return null;
    return { accessToken: access, refreshToken: refresh, expiresAt };
  } catch {
    return null;
  }
}

/** Reconcile elanous's Codex tokens with the CLI mirror, adopting only a
 * strictly fresher access token and persisting its rotated refresh token. */
export function reconcileCodexTokensFromMirror(
  state: ProviderAuthState | null,
  elanousPath: string = authStorePath(),
  mirrorPath: string = codexAuthPath(),
  /** ⛔⭐⭐⭐ 채택 결과를 «어느 계정»에 영속하나 (3R must-fix).
   *  호출자는 계정별 미러 경로를 넘기는데 영속 키가 `openai-codex` 로 못 박혀 있었다
   *  ⇒ 이름 계정의 미러가 더 신선하면 «기본 계정의 정본»을 그 토큰으로 덮었다.
   *  ⛔ 그것은 이 PR 이 닫으려던 사고(A 가 B 를 덮는다)의 «셋째 방향»이다.
   *  기본값은 종전 키 — 기본 계정 호출자의 동작을 한 바이트도 안 바꾼다. */
  storeKey: string = 'openai-codex',
): ProviderAuthState | null {
  const mirror = readCodexMirrorTokens(mirrorPath);
  if (!mirror || mirror.expiresAt === null) return state;
  const mirrorExp = mirror.expiresAt;
  // elanous's freshness = its access-token exp (fall back to stored
  // expiresAt, then -∞ when there is no usable token at all).
  const elanousExp = state
    ? (jwtExpMs(state.tokens.accessToken) ?? state.tokens.expiresAt ?? Number.NEGATIVE_INFINITY)
    : Number.NEGATIVE_INFINITY;
  // Mirror only wins when STRICTLY fresher — avoids ping-pong when both
  // hold the same token (elanous just mirrored to it).
  if (mirrorExp <= elanousExp) return state;

  const tokens: OAuthTokens = {
    accessToken: mirror.accessToken,
    refreshToken: mirror.refreshToken,
    expiresAt: mirrorExp,
    ...(state?.tokens.scope ? { scope: state.tokens.scope } : {}),
    tokenType: state?.tokens.tokenType ?? 'Bearer',
  };
  // Persist adoption so the next refresh uses the LIVE refresh token
  // instead of the revoked one. authMode stays 'chatgpt' (the only OAuth
  // mode that writes ~/.codex).
  // ⛔⭐ 영속은 «읽은 그 계정»으로 간다 — 미러 경로와 저장 키가 갈리면 안 된다(3R must-fix).
  //   ⊕ 홈도 그 기록의 것을 그대로 들고 간다: 이름 계정이 codexHome 을 잃으면
  //     그 다음 미러가 «기본 홈»으로 새거나(기본 키였다면) 아예 안 간다.
  return saveTokens(storeKey, tokens, {
    authMode: state?.authMode ?? 'chatgpt',
    ...(state?.codexHome ? { codexHome: state.codexHome } : {}),
  }, elanousPath);
}

export interface WriteTokensOpts {
  authMode?: string;
  accountEmail?: string;
  accountUuid?: string;
  organizationUuid?: string;
  /** MCP 동적 등록 때 쓴 redirect_uri. 생략하면 기존 값을 유지한다. */
  redirectUri?: string;
  /** ⭐⭐ 이 계정의 공식 CLI 홈(= 미러 대상). ⛔ 이것이 «토큰과 함께» 저장되는 이유:
   *  미러 대상을 «주변 env/config»로 정하면, 저장하는 키와 미러 가는 홈이 «갈릴 수 있다»
   *  (2026-08-05 1R must-fix — `saveTokens('openai-codex:team')` 이 기본 홈을 오염시켰다).
   *  ⇒ 미러는 «그 기록이 말하는 홈»으로만 간다. 없으면 기본 계정 규칙(CODEX_HOME || ~/.codex). */
  codexHome?: string;
  /** Default true for 'openai-codex'. Set false to skip the ~/.codex
   *  mirror (e.g. in tests that shouldn't touch the user's home). */
  mirrorCodex?: boolean;
  /** Explicit ChatGPT claims override. Normally left undefined — for
   *  'openai-codex' with OAuth tokens, saveTokens auto-decodes the
   *  access-token JWT so every refresh site picks up fresh claims
   *  without threading them through. Pass this only when you already
   *  hold a decoded snapshot (tests, or a custom token source). */
  chatGPT?: ChatGPTClaims | null;
}

export function saveTokens(
  provider: string,
  tokens: OAuthTokens,
  opts: WriteTokensOpts = {},
  path: string = authStorePath(),
): ProviderAuthState {
  const store = readStore(path);
  const existing = store.providers[provider];
  // ChatGPT claims live on the JWT access token the OpenAI OAuth
  // server hands us. Auto-extract on every save for 'openai-codex' so
  // every refresh rotation keeps them fresh. An explicit override
  // wins; an explicit null clears; undefined falls through to decode
  // → existing (so API-key mode with no JWT keeps previous claims
  // rather than blanking them).
  const autoClaims = provider === 'openai-codex' && opts.chatGPT === undefined
    ? extractChatGPTClaims(tokens.accessToken)
    : null;
  const chatGPT: ChatGPTClaims | undefined =
    opts.chatGPT === null ? undefined
    : opts.chatGPT ?? autoClaims ?? existing?.chatGPT;
  const state: ProviderAuthState = {
    tokens,
    lastRefresh: new Date().toISOString(),
    authMode: opts.authMode ?? existing?.authMode,
    accountEmail: opts.accountEmail ?? existing?.accountEmail,
    accountUuid: opts.accountUuid ?? existing?.accountUuid,
    organizationUuid: opts.organizationUuid ?? existing?.organizationUuid,
    redirectUri: opts.redirectUri ?? existing?.redirectUri,
    codexHome: opts.codexHome ?? existing?.codexHome,
    ...(chatGPT ? { chatGPT } : {}),
  };
  store.providers[provider] = state;
  writeStore(store, path);

  // ⛔⭐⭐⭐ 미러 대상은 «저장하는 그 기록»이 정한다 — 주변 env/config 를 «안 읽는다».
  //   1R must-fix: 종전엔 현재 환경의 계정 해석으로 골라서, `openai-codex:team` 을 저장하는데
  //   미러가 «기본 홈»으로 가 그 파일을 오염시킬 수 있었다. 저장 키와 미러 홈이 갈리면 안 된다.
  //   ⇒ 이름 계정은 반드시 `codexHome` 을 들고 있고, 없으면 «기본 계정만» 종전 규칙을 쓴다.
  if (isCodexStoreKey(provider) && opts.mirrorCodex !== false) {
    const home = state.codexHome
      ?? (provider === 'openai-codex' ? defaultCodexHome(process.env) : undefined);
    if (home) {
      // loginWithCodex → saveTokens reaches the Codex CLI mirror on each token save.
      state.codexMirrorResult = mirrorCodexAuth(tokens, state.lastRefresh, join(home, 'auth.json'));
    }
    // ⛔ 이름 계정인데 홈을 모르면 «미러하지 않는다» — 모르는 곳에 토큰을 쓰지 않는다
  }

  return state;
}

export function deleteTokens(provider: string, path: string = authStorePath()): boolean {
  const store = readStore(path);
  if (!(provider in store.providers)) return false;
  delete store.providers[provider];
  writeStore(store, path);
  return true;
}

export function listProviders(path: string = authStorePath()): string[] {
  return Object.keys(readStore(path).providers).sort();
}

// ── Codex CLI mirror ─────────────────────────────────────────────────

/**
 * ⛔⭐⭐⭐⭐ **테스트가 사람의 «진짜» 로그인을 덮는 것을 큰소리로 막는다** (2026-08-05 인시던트).
 *
 * 무엇이 있었나: 테스트가 `saveTokens('openai-codex', …)` 를 «미러를 끄지 않고» 불렀고,
 * 그 테스트의 `beforeEach` 가 자를 결정론으로 만들려고 `CODEX_HOME` 을 «삭제»해서
 * 미러 기본값이 사용자의 실제 `~/.codex/auth.json` 이 됐다. 픽스처 토큰
 * (`{"alg":"none"}…"sig"` · refresh `"d-r"`)이 실물을 덮어 공식 codex CLI 가 401 로 죽었다.
 *
 * ⛔ **왜 preload(1층)만으로 안 되나**: 그 preload 는 `CODEX_HOME` «미설정»일 때만 채운다.
 *   위 사고는 테스트가 그 값을 «지운» 경우이고, 그러면 preload 는 이미 지나간 뒤다.
 *   ⇒ 이 가드가 그 경로를 무는 «유일한» 층이다.
 *
 * ⛔ **왜 조용히 건너뛰지 않고 던지나**: `mirrorCodexAuth` 는 성공도 실패도 조용하다.
 *   조용히 건너뛰면 「이 테스트가 무엇을 하려 했는지」가 영영 안 보인다. 시끄러운 쪽이
 *   테스트에서만 발동하고, 고치는 법이 메시지에 있다.
 *
 * ⛔ 프로덕션에는 «아무 영향도 없다» — 테스트 러너 밖에서는 즉시 반환한다.
 */
/** 두 경로가 «실체로» 같은 파일인가. ⛔ 문자열 비교로는 심볼릭 링크가 가드를 통과한다
 *  (`CODEX_HOME` 이 `~/.codex` 로 가는 링크면 resolve() 결과가 다르다 · 리뷰 must-fix).
 *  ⚠️ 파일이 아직 없을 수 있으므로 «부모까지» 실체화하고 이름을 붙인다. */
function sameRealFile(a: string, b: string): boolean {
  const norm = (p: string): string => {
    try { return realpathSync(p); } catch { /* 아직 없다 — 부모로 내려간다 */ }
    try { return join(realpathSync(dirname(p)), basename(p)); } catch { return resolve(p); }
  };
  return norm(a) === norm(b);
}

/** ⛔ 테스트 러너 판정 — 이 값이 «거짓»이면 가드는 영영 안 도는 장식이 된다.
 *  그래서 테스트가 이 함수의 반환을 직접 문다(가드 테스트 참조). */
export function isUnderTestRunner(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.BUN_TEST || env.ELANOUS_TEST_RUNNER) || env.NODE_ENV === 'test';
}

/** ⛔ 테스트 심 — 가드를 «실물에 쓰지 않고» 검증할 수 있게 내보낸다.
 *  ⭐ 리뷰 should-fix: 종전 회귀 테스트는 실홈을 대상으로 `saveTokens` 를 «실제로» 불렀다.
 *    러너 판정이 깨지는 순간 ***그 테스트가 인시던트를 재연한다.*** 그래서 주입 지점을 연다. */
export function assertMirrorTargetIsSafeUnderTest(mirrorPath: string): void {
  if (!isUnderTestRunner()) return;
  const realHome = join(homedir(), '.codex', 'auth.json');
  if (!sameRealFile(mirrorPath, realHome)) return;
  throw new Error(
    '⛔ 테스트가 실제 ~/.codex/auth.json 을 덮으려 했다 — 사람의 codex 로그인이 깨진다.\n'
    + '   고치는 법 둘 중 하나: ① saveTokens(..., { mirrorCodex: false }) '
    + '② 그 테스트에서 process.env.CODEX_HOME 을 임시 디렉터리로 세운다.\n'
    + '   ⚠️ beforeEach 에서 CODEX_HOME 을 «지우면» 기본값이 실홈이 된다 — 지우지 말고 임시 경로로 «세워라».',
  );
}

/** Write-back to ~/.codex/auth.json to keep the official Codex CLI
 *  in sync with rotating refresh tokens. Merges with the existing
 *  file content if present so we don't clobber keys Codex CLI may
 *  have added (e.g. account info). Errors never propagate — the main
 *  elanous store is canonical; the mirror is a UX nicety — but they are no
 *  longer SILENT: every attempt (success or failure) leaves an observation
 *  under `oauth.codex-mirror`. ⛔ The 2026-08-05 incident had to be traced by
 *  guessing from the file's `last_refresh` FORMAT, which is deduction, not
 *  observation. Token values are never logged — path + error kind only. */
function mirrorCodexAuth(tokens: OAuthTokens, lastRefresh: string, mirrorPath: string = codexAuthPath()): CodexMirrorResult {
  assertMirrorTargetIsSafeUnderTest(mirrorPath);
  try {
    const path = mirrorPath;
    const hasBase = existsSync(path);
    let existing: Record<string, unknown> = {};
    if (hasBase) {
      try { existing = JSON.parse(readFileSync(path, 'utf-8')); } catch { /* fall through */ }
      if (!existing || typeof existing !== 'object') existing = {};
    }

    // Measured 2026-09-17 against the native Codex CLI: its authorization-code
    // exchange requires `id_token`, and its first-login auth.json derives
    // `tokens.account_id` from that token's `chatgpt_account_id` claim. The
    // device-code response therefore supports branch A: loginWithCodex retains
    // id_token. Refresh responses do not promise it, so without a base file we
    // must not create a CLI-rejected partial mirror.
    const idTokenClaims = tokens.idToken ? decodeJWTPayload(tokens.idToken) : null;
    const accountId = idTokenClaims?.chatgpt_account_id;
    const canCreateUsableMirror = typeof tokens.idToken === 'string'
      && tokens.idToken.length > 0
      && typeof accountId === 'string'
      && accountId.length > 0;
    if (!hasBase && !canCreateUsableMirror) {
      debug.log('oauth.codex-mirror', 'not-created-missing-cli-fields', { path });
      return 'not-created-missing-cli-fields';
    }

    mkdirSync(dirname(path), { recursive: true });
    const priorTokens = (existing.tokens && typeof existing.tokens === 'object')
      ? existing.tokens as Record<string, unknown> : {};
    existing.tokens = {
      ...priorTokens,
      ...(hasBase ? {} : { id_token: tokens.idToken, account_id: accountId }),
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
    };
    if (!hasBase) {
      existing.OPENAI_API_KEY = null;
      existing.auth_mode = 'chatgpt';
    }
    existing.last_refresh = lastRefresh;
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    renameSync(tmp, path);
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    // ⭐ 성공도 «남긴다» — 2026-08-05 인시던트에서 「누가 이 파일을 언제 썼나」를
    //   파일의 last_refresh 포맷으로 «역추적»해야 했다. 그건 관측이 아니라 추리다.
    //   ⛔ 토큰 값은 안 남긴다(R-LLM2) — 경로와 시각만.
    debug.log('oauth.codex-mirror', 'wrote', { path });
    return 'written';
  } catch (error) {
    /* Codex CLI may not be installed; the canonical store is authoritative.
       ⛔ 그러나 «조용히» 삼키지는 않는다 — 실패가 안 보이면 미러가 낡는 것도 안 보인다. */
    // ⛔⭐ 예외 «메시지»는 안 싣는다 — JSON 파싱 실패 등은 메시지에 파일 내용 조각을 담을 수 있고,
    //   그 파일이 «토큰 파일»이다(리뷰 must-fix). 종류·코드만 구조화해 남긴다.
    debug.log('oauth.codex-mirror', 'write-failed', {
      path: mirrorPath,
      errorName: error instanceof Error ? error.name : typeof error,
      code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined,
    }, { level: 'warn' });
    return 'write-failed';
  }
}

// ── Expiry helpers ───────────────────────────────────────────────────

/** Returns true when the token is within `bufferMs` of expiring (or
 *  already expired). A null expiresAt means "no known expiry" → false. */
export function isExpiringSoon(state: ProviderAuthState, bufferMs: number): boolean {
  const exp = state.tokens.expiresAt;
  if (exp == null) return false;
  return Date.now() + bufferMs >= exp;
}

/** Derive expiresAt from the server's `expires_in` (seconds). Accepts
 *  undefined / null / non-numeric → null. */
export function expiresAtFromSeconds(expiresIn: unknown): number | null {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) return null;
  return Date.now() + expiresIn * 1000;
}
