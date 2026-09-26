// ── Grok 자격 해석 — ⭐ **구독(OAuth)이 언제나 1순위, API 키는 2순위** ──
//
// 대표 지시 2026-08-13: *"엘라누스 안에서 grok 이 구독으로 도는 경우도 진행해야 합니다.
// 구독이 있는 경우 api key 는 항상 2순위로 되게 해주세요."*
//
// ⛔ **왜 이 파일이 «하나»여야 하나** — elanous 에는 grok 이 나가는 경로가 둘이다:
//   ⑴ ACP 백엔드   `grok agent stdio` (자식 바이너리가 auth.json 을 직접 읽는다)
//   ⑵ LLM 프로바이더 `streamChat` (elanous 가 Bearer 를 «직접» 실어 보낸다)
// 예전엔 ⑴만 구독을 강제(env 스크럽)하고 ⑵는 무조건 API 키였다. 규칙이 갈리면
// 「구독을 켰는데 지갑이 열리는」 사고가 난다. ⇒ 두 경로가 이 파일 하나를 읽는다.
//
// ── 🧪 실측 (2026-08-13 · 실제 HTTP 왕복) ─────────────────────────────────────
//   POST https://cli-chat-proxy.grok.com/v1/chat/completions
//     model=grok-build → ✅ 200 (473ms)  · 응답 model="grok-build"
//     model=grok-4.6   → ✅ 200 (555ms)  · 응답 model="grok-4.6-build" (프록시가 매핑)
//   GET  https://cli-chat-proxy.grok.com/v1/billing?format=credits → ✅ 200
//     currentPeriod=USAGE_PERIOD_TYPE_WEEKLY · isUnifiedBillingUser=true
//
// ⛔⭐ **헤더 하나가 README 에 «빠져 있다»** — `x-grok-client-version`.
//   없으면 **HTTP 426** `"Your Grok CLI version (none) is outdated"` 로 거절된다.
//   (실측으로 잡았다. 벤더 README `xai-grok-shell/README.md:400` 의 curl 예제만
//    따라 하면 «반드시» 426 이 난다. user-agent 로는 안 통한다 — 그것도 실측.)
//   근거 앵커: `xai-grok-shell-session-support/src/managed_mcp.rs:163`
//
// ⚠️ 이 프록시는 `docs.x.ai` 에 «없다**(전 문서 0건). 벤더 저장소 README 의
//   「Using auth.json for API Access」 절이 유일한 문서다. ⇒ 조용히 깨질 수 있으니
//   호출자는 실패를 fail-soft 로 접고 API 키 경로로 떨어질 수 있어야 한다.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 구독 프록시 베이스. ⛔ `api.x.ai` 가 «아니다** — 그쪽은 API 키(토큰 과금) 전용. */
export const GROK_SUBSCRIPTION_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
/** API 키 경로 베이스(토큰 과금). */
export const GROK_API_BASE_URL = 'https://api.x.ai/v1';

/** 프록시가 요구하는 최소 CLI 버전(실측 426 문면). 이보다 낮으면 거절된다. */
export const GROK_PROXY_MIN_CLI_VERSION = '0.1.202';
/** 설치본을 못 읽었을 때 신고할 값. ⛔ 하한을 쓰면 프록시가 하한을 «올리는» 날
 *  전부 426 이 된다 — 그래서 아래 `detectGrokCliVersion()` 이 1순위다. */
const GROK_PROXY_FALLBACK_CLI_VERSION = GROK_PROXY_MIN_CLI_VERSION;

/** 설치된 grok CLI 의 버전. ⭐ 하드코딩 하한 대신 «실제 설치본»을 신고한다.
 *
 *  왜 — 프록시가 최소 버전을 올리면 하드코딩 값은 «전부 426» 이 된다. 설치본을 읽으면
 *  사용자가 `grok update` 한 순간 저절로 따라간다.
 *
 *  ⛔ `grok --version` 을 «매 요청» 부르지 않는다 — 프로세스 수명 동안 한 번만 재고 캐시한다.
 *  ⛔ 실패는 삼킨다(하한으로) — 버전을 못 읽어서 요청이 «안 나가는» 일은 없어야 한다.
 *  실측 산출 형태: `grok 1.0.0 (3cd0d0cbcebe) [stable]` */
let cachedCliVersion: string | null | undefined;
export function detectGrokCliVersion(
  deps: { readonly exec?: () => string; readonly force?: boolean } = {},
): string {
  if (!deps.force && cachedCliVersion !== undefined) {
    return cachedCliVersion ?? GROK_PROXY_FALLBACK_CLI_VERSION;
  }
  try {
    const raw = deps.exec
      ? deps.exec()
      : (() => {
        const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
        return execFileSync('grok', ['--version'], { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
      })();
    // 첫 «점 두 개짜리» 수를 고른다 — 커밋 해시·[stable] 같은 꼬리를 안 문다.
    const m = /(\d+\.\d+\.\d+)/.exec(String(raw));
    cachedCliVersion = m ? m[1]! : null;
  } catch {
    cachedCliVersion = null;
  }
  return cachedCliVersion ?? GROK_PROXY_FALLBACK_CLI_VERSION;
}

/** ⛔ 테스트 심 — 캐시를 푼다. */
export function _resetGrokCliVersionCacheForTesting(): void {
  cachedCliVersion = undefined;
}

export type GrokCredentialKind = 'subscription' | 'api_key';

export interface GrokCredential {
  kind: GrokCredentialKind;
  /** 요청 베이스 URL (엔드포인트 경로는 호출자가 잇는다). */
  baseUrl: string;
  /** Bearer 값. ⛔ 로그·관측에 실지 마라. */
  token: string;
  /** 이 자격에 «반드시» 붙어야 하는 헤더(Authorization 제외). */
  headers: Record<string, string>;
  /** 관측용 — 값이 아니라 «출처»만. */
  source: string;
}

interface GrokAuthScope {
  key?: unknown;
  expires_at?: unknown;
  user_id?: unknown;
}

export function grokAuthFilePath(home: string = homedir()): string {
  return join(home, '.grok', 'auth.json');
}

/** auth.json 에서 «가장 늦게 만료되는» 스코프의 토큰을 고른다.
 *
 *  ⛔ 최상위가 flat 이 «아니다» — `"<issuer>::<client_id>"` 로 키가 잡힌다(다계정).
 *  ⚠️ 벤더 README 의 jq 예제(`."https://accounts.x.ai/sign-in".key`)는 판본에 따라
 *     키가 다르다(실측: 이 기계는 `https://auth.x.ai::<uuid>`). 그래서 «훑는다». */
function readSubscriptionToken(
  path: string,
): { token: string; expiresAt: string | null; userId: string | null } | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  let best: { token: string; expiresAt: string | null; userId: string | null; ms: number } | null = null;
  for (const scope of Object.values(parsed as Record<string, unknown>)) {
    if (!scope || typeof scope !== 'object') continue;
    const s = scope as GrokAuthScope;
    if (typeof s.key !== 'string' || s.key.length === 0) continue;
    const expiresAt = typeof s.expires_at === 'string' ? s.expires_at : null;
    const ms = expiresAt ? Date.parse(expiresAt) : Number.NEGATIVE_INFINITY;
    const cand = {
      token: s.key,
      expiresAt,
      userId: typeof s.user_id === 'string' ? s.user_id : null,
      ms: Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms,
    };
    if (best === null || cand.ms > best.ms) best = cand;
  }
  return best ? { token: best.token, expiresAt: best.expiresAt, userId: best.userId } : null;
}

/** 호스트 발급 문이 응답에 실을 access. user id 는 반환하지 않는다. */
export function readGrokSubscriptionAccess(
  home?: string,
): { key: string; expiresAt: string | null } | null {
  const sub = readSubscriptionToken(grokAuthFilePath(home));
  if (!sub) return null;
  return { key: sub.token, expiresAt: sub.expiresAt };
}

/** 프록시 필수 헤더. ⛔ `x-grok-client-version` 을 빼면 426 이다(실측). */
export function grokSubscriptionHeaders(opts: {
  model?: string;
  userId?: string | null;
  cliVersion?: string;
} = {}): Record<string, string> {
  const headers: Record<string, string> = {
    // 인증 미들웨어에 «CLI 세션 토큰»으로 검증하라고 알린다.
    'X-XAI-Token-Auth': 'xai-grok-cli',
    // ⛔ 이것이 빠지면 HTTP 426. README 에 없다.
    //   ⭐ 설치본 버전을 신고한다 — 프록시가 하한을 올려도 `grok update` 하면 따라간다.
    'x-grok-client-version': opts.cliVersion ?? detectGrokCliVersion(),
  };
  // 프록시는 «본문이 아니라 이 헤더»로 백엔드를 고른다(README 표).
  if (opts.model) headers['x-grok-model-override'] = opts.model;
  if (opts.userId) headers['x-userid'] = opts.userId;
  return headers;
}

/** Pod 가 호스트에 새 access 를 묻는 창. 이 안이면 URL 이 있을 때만 다시 받는다. */
export const POD_CREDENTIAL_REFRESH_WINDOW_MS = 15 * 60 * 1000;
export const POD_CREDENTIAL_URL_ENV = 'ELANOUS_POD_CREDENTIAL_URL';
export const POD_CREDENTIAL_TOKEN_ENV = 'ELANOUS_POD_CREDENTIAL_TOKEN';

interface PodCredentialRefresh {
  readonly ok: boolean;
  readonly reason: 'refreshed' | 'not-expiring' | 'no-env' | 'request-failed' | 'bad-body' | 'write-failed';
}

function observePodCredentialRefresh(ok: boolean, reason: PodCredentialRefresh['reason']): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { debug } = require('../debug/log.js') as typeof import('../debug/log.js');
    debug.log('llm.grok', 'pod-credential-refresh', { ok, reason });
  } catch { /* fail-open — 관측이 자격 해석을 막지 않는다 */ }
}

/** auth.json 의 access 만 갈아 끼운다. refresh·계정 id 는 건드리지 않고, 실패하면 원본 바이트를 남긴다. */
function rewriteAuthAccessKey(path: string, key: string, expiresAt: string): boolean {
  let original: string;
  try { original = readFileSync(path, 'utf-8'); } catch { return false; }
  let parsed: unknown;
  try { parsed = JSON.parse(original); } catch { return false; }
  if (!parsed || typeof parsed !== 'object') return false;
  const record = parsed as Record<string, unknown>;
  let target: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const [name, scope] of Object.entries(record)) {
    if (!scope || typeof scope !== 'object') continue;
    const s = scope as GrokAuthScope;
    if (typeof s.key !== 'string' || s.key.length === 0) continue;
    const ms = typeof s.expires_at === 'string' ? Date.parse(s.expires_at) : Number.NEGATIVE_INFINITY;
    const finite = Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
    if (target === null || finite > bestMs) { target = name; bestMs = finite; }
  }
  if (target === null) return false;
  const scope = record[target];
  if (!scope || typeof scope !== 'object') return false;
  const next = { ...(scope as Record<string, unknown>), key, expires_at: expiresAt };
  const body = JSON.stringify({ ...record, [target]: next });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, body, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
    return true;
  } catch {
    try { writeFileSync(path, original, { encoding: 'utf-8', mode: 0o600 }); } catch { /* 원본이 그대로면 충분 */ }
    return false;
  }
}

/**
 * Pod 안에서만 — 두 env 가 있고 access 가 15분 안이면 호스트에 새 key 를 받아 auth.json 을 0600 으로 다시 쓴다.
 * env 가 없거나, 창 밖이거나, 요청이 실패하면 기존 바이트를 유지한다. refresh 는 보내지도 저장하지도 않는다.
 */
async function maybeRefreshPodCredential(opts: {
  env: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const url = opts.env[POD_CREDENTIAL_URL_ENV];
  const token = opts.env[POD_CREDENTIAL_TOKEN_ENV];
  if (!url || !token) return;
  const path = grokAuthFilePath(opts.home);
  const sub = readSubscriptionToken(path);
  if (!sub?.expiresAt) {
    observePodCredentialRefresh(false, 'not-expiring');
    return;
  }
  const ms = Date.parse(sub.expiresAt);
  if (!Number.isFinite(ms) || (opts.now ?? Date.now)() + POD_CREDENTIAL_REFRESH_WINDOW_MS < ms) {
    observePodCredentialRefresh(false, 'not-expiring');
    return;
  }
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    observePodCredentialRefresh(false, 'request-failed');
    return;
  }
  if (!res.ok) {
    observePodCredentialRefresh(false, 'request-failed');
    return;
  }
  let body: unknown;
  try { body = await res.json(); } catch {
    observePodCredentialRefresh(false, 'bad-body');
    return;
  }
  const key = body && typeof body === 'object' ? (body as { key?: unknown }).key : undefined;
  const expiresAt = body && typeof body === 'object' ? (body as { expires_at?: unknown }).expires_at : undefined;
  if (typeof key !== 'string' || key.length === 0 || typeof expiresAt !== 'string' || expiresAt.length === 0) {
    observePodCredentialRefresh(false, 'bad-body');
    return;
  }
  if (!rewriteAuthAccessKey(path, key, expiresAt)) {
    observePodCredentialRefresh(false, 'write-failed');
    return;
  }
  observePodCredentialRefresh(true, 'refreshed');
}

/** ⭐ 단일 규칙 — 구독이 있으면 구독, 없을 때만 API 키.
 *
 *  ⛔ 만료를 여기서 «막지 않는다** — access token 이 지나도 refresh_token 이
 *  살아 있으면 grok 바이너리가 갱신한다. 만료를 불가용으로 접으면 멀쩡한 구독을
 *  API 키로 떨어뜨려 «지갑이 열린다**. 401 이 실제로 나면 호출자가 강등한다. */
function readGrokCredential(opts: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  model?: string;
  cliVersion?: string;
  /** 구독을 «건너뛴다** — 401 을 맞은 뒤 호출자가 강등할 때만 쓴다. */
  skipSubscription?: boolean;
} = {}): GrokCredential | null {
  const env = opts.env ?? process.env;

  if (opts.skipSubscription !== true) {
    const sub = readSubscriptionToken(grokAuthFilePath(opts.home));
    if (sub) {
      return {
        kind: 'subscription',
        baseUrl: GROK_SUBSCRIPTION_BASE_URL,
        token: sub.token,
        headers: grokSubscriptionHeaders({
          ...(opts.model ? { model: opts.model } : {}),
          userId: sub.userId,
          ...(opts.cliVersion ? { cliVersion: opts.cliVersion } : {}),
        }),
        source: 'auth.json',
      };
    }
  }

  // 2순위 — API 키(토큰 과금). 이름 순서는 xAI 문서 관례를 따른다.
  for (const name of ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY'] as const) {
    const value = env[name];
    if (value && value.length > 0) {
      return { kind: 'api_key', baseUrl: GROK_API_BASE_URL, token: value, headers: {}, source: name };
    }
  }
  return null;
}

export interface ResolveGrokCredentialOpts {
  env?: NodeJS.ProcessEnv;
  home?: string;
  model?: string;
  cliVersion?: string;
  /** 구독을 «건너뛴다** — 401 을 맞은 뒤 호출자가 강등할 때만 쓴다. */
  skipSubscription?: boolean;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * 자격 해석.
 * 두 Pod env 가 없으면 동기 `GrokCredential | null` — 종전 호출이 받는 값과 같다.
 * 둘 다 있으면 Promise. access 가 15분 안일 때만 호스트 URL 의 새 key 로 auth.json 을
 * 0600(tmp→rename) 다시 쓴 뒤 읽는다. 창 밖·실패는 파일을 그대로 두고 옛 키를 resolve 한다.
 * 호스트 프로세스는 두 env 를 갖지 않으므로 이 오버로드의 Promise 갈래를 타지 않는다.
 */
export function resolveGrokCredential(opts: ResolveGrokCredentialOpts & {
  env: NodeJS.ProcessEnv & Record<typeof POD_CREDENTIAL_URL_ENV, string> & Record<typeof POD_CREDENTIAL_TOKEN_ENV, string>;
}): Promise<GrokCredential | null>;
export function resolveGrokCredential(opts?: ResolveGrokCredentialOpts): GrokCredential | null;
export function resolveGrokCredential(opts: ResolveGrokCredentialOpts = {}): GrokCredential | null | Promise<GrokCredential | null> {
  const env = opts.env ?? process.env;
  if (opts.skipSubscription === true || !env[POD_CREDENTIAL_URL_ENV] || !env[POD_CREDENTIAL_TOKEN_ENV]) {
    return readGrokCredential(opts);
  }
  return maybeRefreshPodCredential({
    env,
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  }).then(() => readGrokCredential(opts));
}

/** 갱신 유도 결과. ⛔ 「갱신됐다」와 «안 됐다»와 «못 했다»를 다른 값으로. */
export type GrokRefreshOutcome = 'refreshed' | 'unchanged' | 'failed' | 'no-credential';

/** 토큰의 만료 시각만 뽑는다(비교용). ⛔ 토큰 값은 안 낸다. */
function readExpiresAt(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    let latest: string | null = null;
    for (const scope of Object.values(parsed as Record<string, unknown>)) {
      if (!scope || typeof scope !== 'object') continue;
      const raw = (scope as GrokAuthScope).expires_at;
      if (typeof raw === 'string' && (latest === null || raw > latest)) latest = raw;
    }
    return latest;
  } catch {
    return null;
  }
}

/**
 * ⭐⭐⭐ **만료된 구독 토큰을 «갱신»시킨다 — 재로그인 없이.**
 *
 * 왜 이것이 있나 (2026-08-14 실측):
 *   access token 수명은 **6시간**이다. 그런데 `refresh_token` 은 세션 수명(벤더 README: 7일)
 *   동안 살아 있고, ***인증이 필요한 grok 명령을 «한 번» 돌리면 바이너리가 조용히 갱신한다***.
 *   ```
 *   🧪 grok models → rc=0 · auth.json mtime 갱신 · expires_at 이 다시 +6시간 · fresh=true
 *   ```
 *   ⛔ **이것이 없으면 401 에서 곧바로 API 키로 강등하고, 그러면 «구독이 멀쩡한데 유료
 *   토큰으로 샌다»**. 이 파일이 스스로 적어 둔 「만료를 불가용으로 접으면 지갑이 열린다」를
 *   401 경로에서 그대로 어기는 것이 된다.
 *
 * ⛔ 규율:
 *   · **읽기 전용 명령**을 쓴다(`grok models`) — 쿼터를 태우는 추론을 돌리지 않는다.
 *     (`grok inspect` 는 auth 를 «안» 건드린다 — 실측으로 골랐다.)
 *   · 갱신 «여부»를 `expires_at` 변화로 확인한다 — rc=0 만 믿지 않는다.
 *   · 실패는 값으로 낸다(던지지 않는다). 갱신 못 해서 요청이 «안» 나가면 안 된다.
 *   · 호출자는 이것을 **정확히 1회**만 부른다(루프 가드는 호출자 몫).
 */
export function refreshGrokSubscriptionToken(
  opts: {
    home?: string;
    grokPath?: string;
    timeoutMs?: number;
    /** ⛔ 테스트 심 — 실 바이너리 없이 계약을 문다. */
    execImpl?: (cmd: string, args: string[], timeoutMs: number) => void;
  } = {},
): GrokRefreshOutcome {
  const path = grokAuthFilePath(opts.home);
  const before = readExpiresAt(path);
  if (before === null && !existsSync(path)) return 'no-credential';

  try {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    if (opts.execImpl) {
      opts.execImpl(opts.grokPath ?? 'grok', ['models'], timeoutMs);
    } else {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      execFileSync(opts.grokPath ?? 'grok', ['models'], {
        timeout: timeoutMs,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    }
  } catch {
    return 'failed';
  }

  const after = readExpiresAt(path);
  // ⛔ 「돌았다」가 아니라 「만료가 «앞으로» 갔다」를 본다.
  return after !== null && after !== before ? 'refreshed' : 'unchanged';
}

// ── ⭐ 「접힌」 자격 해석 — 호출자가 «기억할 것»을 0 으로 ────────────────────────
//
// ⛔⭐ 왜 이 층이 있나 (대표 지시 2026-08-18 · 호출자 전수로 확인):
//   `resolveGrokCredential` 은 «만료를 안 본다» — 읽으면 그대로 준다. 갱신은 401 을 맞은 «뒤»
//   호출자가 «명시적으로» 부르는 구조였고(이 파일 원 주석: *"루프 가드는 호출자 몫"*),
//   그 대가가 호출자 전수에 그대로 나왔다:
//     ✅ llm.ts:3043~   401 감지 ⊕ 갱신 ⊕ 재시도 ⊕ API 키 강등  — «완전»
//     ⚠️ llm.ts:9740 · llm.ts:9762 · provider-summary.ts · codex-account-store.ts
//        → resolveGrokCredential «만» 부른다 ⇒ ***만료 토큰을 그대로 쓴다***
//   ⇒ 📏 1/5 만 복구된다. 「호출자가 기억해야 하는 것」은 «반드시» 잊힌다(이 저장소의 F38).
//
// ✅ 그래서 codex 의 형태를 따른다 — `loadFreshCodexAuthState` 처럼 ***자격 획득 «안»에 갱신을 접는다.***
//   ⛔ 다만 갱신 «방식»은 이 파일 것을 그대로 쓴다(더 안전하다): 직접 OIDC 를 치지 않고
//   `grok models` 를 유도해 ***CLI 가 스스로 갱신***하게 한다 ⇒ refresh_token 회전 다툼이 원천 없다.

/** 만료 임박 여유 — 이 안이면 갱신을 유도한다. */
const GROK_REFRESH_BUFFER_MS = 120_000;

/** ⛔ 갱신 유도는 «비싸다»(execFileSync · 블로킹). 그래서 재시도 간격을 둔다 —
 *  원 주석이 «호출자 몫»이라 한 루프 가드를 «여기에» 접는다. */
const GROK_REFRESH_COOLDOWN_MS = 60_000;

/** 갱신 유도 최대 대기 — ⛔ 기본값(20초)은 요청 경로에서 너무 길다. 갱신은 실패해도
 *  기존 자격으로 진행하므로 «짧게 끊고 넘어가는» 편이 낫다(무인 리뷰 must-fix 완화). */
const GROK_REFRESH_TIMEOUT_MS = 8_000;

/** ⛔⭐ 쿨다운은 «자격 파일 경로별»이다 — 모듈 전역 하나로 두면 서로 다른 home(테스트 격리·
 *  다중 계정)의 갱신까지 60초간 «같이» 막힌다(무인 리뷰 must-fix). 키는 grokAuthFilePath 결과다. */
const lastGrokRefreshAttemptMsByPath = new Map<string, number>();

/** 테스트 전용 — 쿨다운을 지운다(경로를 주면 그 하나만). */
export function _resetGrokRefreshCooldownForTesting(path?: string): void {
  if (path === undefined) lastGrokRefreshAttemptMsByPath.clear();
  else lastGrokRefreshAttemptMsByPath.delete(path);
}

/** 구독 토큰이 만료(임박)인가. ⛔ 모르면 «만료로 단정하지 않는다» — 모름을 「죽었다」로 읽으면
 *  멀쩡한 자격에 20초 블로킹 갱신을 매번 건다. */
export function isGrokSubscriptionExpiring(
  opts: { home?: string; bufferMs?: number; now?: () => number } = {},
): boolean {
  // ⛔⭐ ***`readExpiresAt` 을 쓰면 안 된다*** — 그것은 «모든» scope 중 최댓값을 고르고
  //   `key` 유무를 «안 본다». 그러면 key 없는 항목이 더 늦은 만료를 가질 때
  //   ***「이 토큰의 만료」가 아니라 「아무 항목의 만료」***를 재게 되어, 실제 쓰는 토큰이
  //   죽었는데도 「여유 있다」로 읽는다. ⇒ «실제로 쓸 토큰»의 만료를 본다(같은 선택 규칙).
  const raw = readSubscriptionToken(grokAuthFilePath(opts.home))?.expiresAt ?? null;
  if (raw === null) return false;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return false;
  return (opts.now ?? Date.now)() + (opts.bufferMs ?? GROK_REFRESH_BUFFER_MS) >= ms;
}

/** 갱신 경로의 관측 — ⛔ 토큰은 «절대» 싣지 않는다(판정·결과·출처만). */
function observeGrokAuth(event: string, data: Record<string, unknown>): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { debug } = require('../debug/log.js') as typeof import('../debug/log.js');
    debug.log('llm.oauth-refresh', event, { provider: 'grok', ...data });
  } catch { /* fail-open */ }
}

export interface ResolveFreshGrokOpts {
  env?: NodeJS.ProcessEnv;
  home?: string;
  model?: string;
  cliVersion?: string;
  skipSubscription?: boolean;
  /** ⛔ 테스트 심 — 실 바이너리 없이 계약을 문다. */
  execImpl?: (cmd: string, args: string[], timeoutMs: number) => void;
  now?: () => number;
}

/**
 * ★ 자격을 «지금 쓸 수 있는 상태»로 해석한다 — 만료 임박이면 갱신을 «유도한 뒤» 다시 읽는다.
 *
 * ⛔ 호출자는 만료·갱신·쿨다운을 «몰라도 된다». 그것이 이 층의 존재 이유다.
 * ⚠️ 갱신에 실패해도 «있는 자격»을 그대로 돌려준다 — 요청이 안 나가는 것이 더 나쁘고,
 *    401 안전망(`llm.ts` 의 강등 경로)이 뒤에 남아 있다.
 */
export function resolveFreshGrokCredential(opts: ResolveFreshGrokOpts = {}): GrokCredential | null {
  const { execImpl, now, ...resolveOpts } = opts;
  const cred = readGrokCredential(resolveOpts);
  // API 키는 만료 개념이 없다 · 자격이 없으면 갱신할 것도 없다.
  if (!cred || cred.kind !== 'subscription') return cred;

  if (!isGrokSubscriptionExpiring({ ...(opts.home ? { home: opts.home } : {}), ...(now ? { now } : {}) })) {
    return cred;
  }

  const clock = now ?? Date.now;
  const authPath = grokAuthFilePath(opts.home);
  const last = lastGrokRefreshAttemptMsByPath.get(authPath);
  const sinceLast = last === undefined ? Number.POSITIVE_INFINITY : clock() - last;
  if (sinceLast < GROK_REFRESH_COOLDOWN_MS) {
    // ⛔ 「쿨다운으로 안 했다」도 남긴다 — 안 남기면 「안 돌았다」와 「막혔다」가 같은 침묵이 된다.
    observeGrokAuth('refresh-skipped-cooldown', { sinceLastMs: sinceLast, cooldownMs: GROK_REFRESH_COOLDOWN_MS });
    return cred;
  }
  // ⛔ 상한을 둔다 — 임시 home 이 반복 공급되는 장기 프로세스에서 Map 이 무한히 자란다(리뷰 should-fix).
  //   자격 파일 경로는 실사용에서 «몇 개»뿐이라 넉넉한 상한이면 충분하고, 넘치면 가장 오래된 것부터 버린다.
  if (lastGrokRefreshAttemptMsByPath.size >= 64) {
    const oldest = [...lastGrokRefreshAttemptMsByPath.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) lastGrokRefreshAttemptMsByPath.delete(oldest[0]);
  }
  lastGrokRefreshAttemptMsByPath.set(authPath, clock());

  observeGrokAuth('refresh-start', { reason: 'expiring', bufferMs: GROK_REFRESH_BUFFER_MS });
  // ⚠️ 이 호출은 «동기 블로킹»이다(execFileSync). 근본 수리(async/single-flight)는 별건이고,
  //   여기서는 ⓐ 만료 임박일 때만 ⓑ 경로별 쿨다운 1회 ⓒ 타임아웃을 줄여 «최악 대기»를 깎는다.
  //   ⭐ 그리고 «얼마나 막았는지»를 값으로 남긴다 — 안 남기면 이 대가가 영영 안 보인다.
  const startedAt = clock();
  const outcome = refreshGrokSubscriptionToken({
    timeoutMs: GROK_REFRESH_TIMEOUT_MS,
    ...(opts.home ? { home: opts.home } : {}),
    ...(execImpl ? { execImpl } : {}),
  });
  observeGrokAuth('refresh-result', {
    outcome, refreshed: outcome === 'refreshed',
    blockedMs: clock() - startedAt, timeoutMs: GROK_REFRESH_TIMEOUT_MS,
  });
  // ⛔ 「돌았다」가 아니라 「값이 변했다」로 판정한다 — refreshGrokSubscriptionToken 의 계약 그대로.
  if (outcome === 'refreshed') return readGrokCredential(resolveOpts);

  // ⛔⭐⭐ 갱신이 실패해도 ***구독을 유지한다*** — 여기서 API 키로 강등하지 «않는다».
  //
  // 🚨⭐⭐ ***무인 리뷰가 이 자리에서 라운드마다 «반대로» 판정했다*** (2026-08-18 · 같은 PR):
  //   1R "강등하라"  →  2R "강등은 대표 지시 위반이니 되돌려라"  →  5R "강등하도록 복원하라"
  //   ⇒ 리뷰 판정이 «시간축에서» 갈렸다. 그러므로 갈림을 정하는 것은 리뷰가 아니라 ***대표 지시***다:
  //     · 이 파일 머리말 (2026-08-13): "구독이 있는 경우 api key 는 «항상» 2순위로 되게 해주세요"
  //     · 2026-08-18:                  "구독이 있는 경우 항상 구독이 사용되게 해주세요"
  //   ⛔ 그래서 5R must-fix 를 «따르지 않는다». 이것은 미완이 아니라 «지시를 따른 결정»이다.
  //   📌 이 자리를 바꾸려면 리뷰 판정이 아니라 «대표 지시가 바뀌어야» 한다.
  //
  //   🪞 1라운드에 나는 강등을 넣었다가 2라운드 리뷰에 잡혔다. 그 지적이 옳다:
  //   이 파일 머리말의 대표 지시(2026-08-13)가 ***"구독이 있는 경우 api key 는 «항상» 2순위"***이고,
  //   2026-08-18 지시도 ***"구독이 있는 경우 항상 구독이 사용되게"***다.
  //   ⇒ 「갱신에 실패했다」는 「구독이 없다」가 «아니다». 자동 강등은 사용자 동의 없이 지갑을 연다.
  //   ✅ 실제로 죽었는지는 401 이 «말해 준다» — 강등은 그 신호를 본 호출자(llm.ts:3092~)의 몫이다.
  //   ⚠️ 401 안전망이 «없는» 호출 지점이 남아 있다는 사실은 별건으로 추적한다(PR 본문 §한계).
  observeGrokAuth('kept-subscription-after-failed-refresh', {
    outcome, note: 'subscription-first-by-directive', downgraded: false,
  });
  return cred;
}

/** 401/403 을 「구독 토큰이 죽었다」로 읽어야 하나. 호출자의 강등 판정용. */
export function isGrokUnauthorized(status: number): boolean {
  return status === 401 || status === 403;
}

/** 프록시가 「CLI 가 낡았다」로 거절했나(HTTP 426). 실측 문면 기반. */
export function isGrokVersionRejected(status: number, body?: string): boolean {
  if (status === 426) return true;
  return typeof body === 'string' && /grok cli version .* is outdated/i.test(body);
}
