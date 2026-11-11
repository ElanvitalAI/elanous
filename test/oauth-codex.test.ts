// ── OpenAI Codex device-code OAuth tests ──
//
// fetch is fully stubbed. No sleeps — sleepImpl is a no-op in tests so
// the poll loop turns instantly.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loginWithCodex, requestDeviceCode, pollDeviceCode, exchangeDeviceAuthCode,
  refreshCodexTokens, getCodexAccessToken, loadFreshCodexAuthState,
  getCodexUserAgent, resetCodexUserAgentCacheForTesting,
  CODEX_DEVICE_USERCODE_URL, CODEX_DEVICE_TOKEN_URL, CODEX_OAUTH_TOKEN_URL,
} from '../src/oauth/codex';
import { loadTokens } from '../src/oauth/store';
import { installCodexOwnerTestWorld } from './fixtures/codex-owner-test-world.js';

type Call = { url: string; body: any; contentType?: string };

function makeFetch(responder: (call: Call) => { status: number; json: any }): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: any = async (url: string, init: any) => {
    const ct = (init?.headers?.['Content-Type']) || '';
    const rawBody = init?.body as string | undefined;
    let body: any = rawBody;
    if (ct === 'application/json' && rawBody) {
      try { body = JSON.parse(rawBody); } catch { /* keep raw */ }
    } else if (ct === 'application/x-www-form-urlencoded' && rawBody) {
      const p = new URLSearchParams(rawBody);
      body = Object.fromEntries(p.entries());
    }
    const call: Call = { url, body, contentType: ct };
    calls.push(call);
    const { status, json } = responder(call);
    return { status, json: async () => json } as any;
  };
  return { fetchImpl, calls };
}

let root: string;
let restoreCodexWorld: (() => void) | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oauth-codex-'));
  process.env.XDG_CONFIG_HOME = root;
  process.env.CODEX_HOME = join(root, 'codex-home');
  restoreCodexWorld = installCodexOwnerTestWorld(root);
});
afterEach(() => {
  restoreCodexWorld?.();
  restoreCodexWorld = undefined;
  rmSync(root, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CODEX_HOME;
  delete process.env.ELANOUS_CODEX_ACCOUNT;
  delete process.env.ELANOUS_CODEX_ACCOUNT_HOME;
});

// ⛔⭐⭐⭐ 6R should-fix — 계정별 배선(storeKey · 미러 경로 · refresh 저장 방향)을 «실제 진입점»으로
//   한 번도 안 몰아 봤다. 단위 테스트가 조각을 각각 물어도 ***그 조각이 실행 경로에 있는지***는
//   구조적으로 못 답한다. 여기서 loadFreshCodexAuthState() 를 이름 계정으로 직접 돌린다.
describe('loadFreshCodexAuthState — 이름 계정으로 «진입점»을 직접 돈다 (통합)', () => {
  const jwtOf = (expSec: number, tag: string): string => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none' })}.${b64({ exp: expSec, tag })}.sig`;
  };
  const nowSec = () => Math.floor(Date.now() / 1000);

  async function seed(): Promise<{ teamHome: string }> {
    const { saveTokens } = await import('../src/oauth/store');
    const teamHome = join(root, 'team-home');
    mkdirSync(teamHome, { recursive: true });
    mkdirSync(join(root, 'codex-home'), { recursive: true });
    // 기본 계정 — 신선하다. ⛔ 이 값이 «안 바뀌는 것»이 이 테스트의 절반이다
    saveTokens('openai-codex', {
      accessToken: jwtOf(nowSec() + 7 * 24 * 3600, 'A'), refreshToken: 'A-R', expiresAt: Date.now() + 7 * 864e5,
    }, { authMode: 'chatgpt', mirrorCodex: false });
    // team 계정 — 정본은 낡았고, 그 홈의 미러가 신선하다(공식 CLI 가 갱신한 상황)
    saveTokens('openai-codex:team', {
      accessToken: jwtOf(nowSec() - 3600, 'OLD'), refreshToken: 'OLD-R', expiresAt: Date.now() - 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false, codexHome: teamHome });
    writeFileSync(join(teamHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: jwtOf(nowSec() + 7 * 24 * 3600, 'TEAM'), refresh_token: 'TEAM-R' },
    }) + '\n');
    // 기본 홈의 미러도 신선하게 둔다 — ⛔ 이름 계정이 «이것을» 읽으면 안 된다
    writeFileSync(join(root, 'codex-home', 'auth.json'), JSON.stringify({
      tokens: { access_token: jwtOf(nowSec() + 30 * 24 * 3600, 'DEFAULT'), refresh_token: 'DEFAULT-R' },
    }) + '\n');
    process.env.ELANOUS_CODEX_ACCOUNT = 'team';
    process.env.ELANOUS_CODEX_ACCOUNT_HOME = teamHome;
    return { teamHome };
  }

  test('⛔ 이름 계정은 «자기 홈»의 미러를 읽고, 채택 결과를 «자기 키»에만 적는다', async () => {
    await seed();
    let refreshed = false;
    const { fetchImpl } = makeFetch(() => { refreshed = true; return { status: 500, json: {} }; });

    const state = await loadFreshCodexAuthState({ fetchImpl, mirrorCodex: false });
    expect(state?.tokens.refreshToken).toBe('TEAM-R');   // ✅ team 홈을 읽었다 (DEFAULT-R 아님)
    expect(refreshed).toBe(false);                        // 죽은 토큰으로 갱신을 안 쐈다

    // ⭐ 영속 방향 — team 만 갱신되고 기본 계정은 «한 바이트도» 안 바뀐다
    expect(loadTokens('openai-codex:team')?.tokens.refreshToken).toBe('TEAM-R');
    expect(loadTokens('openai-codex')?.tokens.refreshToken).toBe('A-R');
  });

  test('⛔ 갱신이 돌 때도 저장은 «이름 키»로 가고 미러는 «그 계정의 홈»으로 간다', async () => {
    const { teamHome } = await seed();
    // team 정본을 「만료 임박」으로 두되 미러는 더 낡게 — reconcile 이 안 이기고 refresh 가 돌게 한다
    const { saveTokens } = await import('../src/oauth/store');
    saveTokens('openai-codex:team', {
      accessToken: jwtOf(nowSec() + 30, 'SOON'), refreshToken: 'SOON-R', expiresAt: Date.now() + 30_000,
    }, { authMode: 'chatgpt', mirrorCodex: false, codexHome: teamHome });
    writeFileSync(join(teamHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: jwtOf(nowSec() - 7200, 'STALE'), refresh_token: 'STALE-R' },
    }) + '\n');

    const { fetchImpl, calls } = makeFetch((c) => c.url === CODEX_OAUTH_TOKEN_URL
      ? { status: 200, json: { access_token: 'new-A', refresh_token: 'new-R', expires_in: 3600 } }
      : { status: 500, json: {} });
    const state = await loadFreshCodexAuthState({ fetchImpl });

    expect(calls[0].body.refresh_token).toBe('SOON-R');            // team 의 토큰으로 갱신했다
    expect(state?.tokens.accessToken).toBe('new-A');
    expect(loadTokens('openai-codex:team')?.tokens.accessToken).toBe('new-A');
    expect(loadTokens('openai-codex')?.tokens.refreshToken).toBe('A-R');   // ⛔ 기본 계정 무접촉
    // ⭐ 미러는 team 의 홈으로 갔고, 기본 홈은 안 건드려졌다
    expect(JSON.parse(require('node:fs').readFileSync(join(teamHome, 'auth.json'), 'utf8')).tokens.access_token).toBe('new-A');
    expect(JSON.parse(require('node:fs').readFileSync(join(root, 'codex-home', 'auth.json'), 'utf8')).tokens.refresh_token).toBe('DEFAULT-R');
  });
});

describe('requestDeviceCode', () => {
  test('posts client_id, returns user_code', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      json: { user_code: 'ABCD-1234', device_auth_id: 'devauth-xyz', interval: 5 },
    }));
    const res = await requestDeviceCode({ fetchImpl });
    expect(res.user_code).toBe('ABCD-1234');
    expect(calls[0].url).toBe(CODEX_DEVICE_USERCODE_URL);
    expect(calls[0].body.client_id).toBeDefined();
  });

  test('non-200 → throws', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 500, json: { error: 'server' } }));
    expect(requestDeviceCode({ fetchImpl })).rejects.toThrow(/usercode failed/);
  });
});

describe('pollDeviceCode', () => {
  test('200 with authorization_code → returns payload', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 200,
      json: { authorization_code: 'auth-999', code_verifier: 'verifier-abc' },
    }));
    const res = await pollDeviceCode('dev1', 'UC', { fetchImpl });
    expect(res?.authorization_code).toBe('auth-999');
  });

  test('403 → null (pending)', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 403, json: {} }));
    expect(await pollDeviceCode('d', 'u', { fetchImpl })).toBeNull();
  });

  test('400 with authorization_pending → null', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 400, json: { error: 'authorization_pending' } }));
    expect(await pollDeviceCode('d', 'u', { fetchImpl })).toBeNull();
  });

  test('unexpected error → throws', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 500, json: { error: 'oops' } }));
    expect(pollDeviceCode('d', 'u', { fetchImpl })).rejects.toThrow(/poll failed/);
  });
});

describe('exchangeDeviceAuthCode', () => {
  test('posts form-encoded, returns tokens', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      json: { access_token: 'A', refresh_token: 'R', id_token: 'ID', expires_in: 3600, token_type: 'Bearer' },
    }));
    const res = await exchangeDeviceAuthCode('auth-code', 'verifier', { fetchImpl });
    expect(res.access_token).toBe('A');
    expect(res.id_token).toBe('ID');
    expect(calls[0].url).toBe(CODEX_OAUTH_TOKEN_URL);
    expect(calls[0].body.grant_type).toBe('authorization_code');
    expect(calls[0].body.code).toBe('auth-code');
    expect(calls[0].body.code_verifier).toBe('verifier');
    expect(calls[0].contentType).toBe('application/x-www-form-urlencoded');
  });

  test('missing tokens → throws', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 200, json: { access_token: 'A' /* no refresh */ } }));
    expect(exchangeDeviceAuthCode('c', 'v', { fetchImpl })).rejects.toThrow(/exchange failed/);
  });
});

describe('refreshCodexTokens', () => {
  test('posts refresh grant, returns rotated tokens', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      json: { access_token: 'NEW-A', refresh_token: 'NEW-R', expires_in: 3600 },
    }));
    const res = await refreshCodexTokens('OLD-R', { fetchImpl });
    expect(res.access_token).toBe('NEW-A');
    expect(res.refresh_token).toBe('NEW-R');
    expect(calls[0].body.grant_type).toBe('refresh_token');
    expect(calls[0].body.refresh_token).toBe('OLD-R');
  });
});

describe('loginWithCodex (full flow)', () => {
  test('user_code → polling (3 pending, 1 ready) → exchange → saved', async () => {
    let call = 0;
    const { fetchImpl } = makeFetch((c) => {
      call++;
      if (c.url === CODEX_DEVICE_USERCODE_URL) {
        return { status: 200, json: { user_code: 'UC-123', device_auth_id: 'dev1' } };
      }
      if (c.url === CODEX_DEVICE_TOKEN_URL) {
        if (call < 5) return { status: 403, json: {} };
        return { status: 200, json: { authorization_code: 'ac-xx', code_verifier: 'cv-yy' } };
      }
      if (c.url === CODEX_OAUTH_TOKEN_URL) {
        const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: 'account-123' })).toString('base64url');
        return { status: 200, json: { access_token: 'A', refresh_token: 'R', id_token: `header.${payload}.signature`, expires_in: 3600, token_type: 'Bearer' } };
      }
      return { status: 500, json: {} };
    });

    const events: string[] = [];
    const state = await loginWithCodex({
      fetchImpl,
      sleepImpl: async () => { /* zero-sleep */ },
      onProgress: (p) => events.push(p.type),
      pollIntervalMs: 1,
    });
    expect(state.tokens.accessToken).toBe('A');
    expect(state.tokens.refreshToken).toBe('R');
    expect(state.tokens.idToken).toMatch(/^header\..+\.signature$/);
    expect(state.codexMirrorResult).toBe('written');
    expect(JSON.parse(require('node:fs').readFileSync(join(process.env.CODEX_HOME!, 'auth.json'), 'utf8'))).toMatchObject({
      OPENAI_API_KEY: null,
      auth_mode: 'chatgpt',
      tokens: { account_id: 'account-123', id_token: state.tokens.idToken },
    });
    expect(state.tokens.expiresAt).not.toBeNull();
    expect(state.authMode).toBe('chatgpt');
    expect(events).toContain('user_code');
    expect(events).toContain('polling');
    expect(events).toContain('exchanging');
    expect(events).toContain('saved');

    // Verify persistence
    const reloaded = loadTokens('openai-codex');
    expect(reloaded?.tokens.accessToken).toBe('A');
  });

  test('AbortSignal cancels the pending device-code wait before another poll', async () => {
    const { fetchImpl, calls } = makeFetch(call => call.url === CODEX_DEVICE_USERCODE_URL
      ? { status: 200, json: { user_code: 'ABCD-1234', device_auth_id: 'abort-fixture', interval: 1 } }
      : { status: 403, json: {} });
    const controller = new AbortController();
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const login = loginWithCodex({
      fetchImpl, signal: controller.signal, maxWaitMs: 60_000,
      sleepImpl: async () => { started(); return new Promise<void>(() => {}); },
      mirrorCodex: false,
    });
    await waiting;
    controller.abort();
    await expect(login).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(1);
  });

  test('timeout → throws when polling never resolves', async () => {
    const { fetchImpl } = makeFetch((c) => {
      if (c.url === CODEX_DEVICE_USERCODE_URL) return { status: 200, json: { user_code: 'X', device_auth_id: 'd' } };
      if (c.url === CODEX_DEVICE_TOKEN_URL) return { status: 403, json: {} };
      return { status: 500, json: {} };
    });
    await expect(loginWithCodex({
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
      maxWaitMs: 5,  // effectively one-shot
    })).rejects.toThrow(/timed out/);
  });
});

describe('getCodexAccessToken', () => {
  test('null when no tokens stored', async () => {
    expect(await getCodexAccessToken()).toBeNull();
  });

  test('returns stored tokens when not expiring', async () => {
    const { fetchImpl } = makeFetch((c) => {
      if (c.url === CODEX_DEVICE_USERCODE_URL) return { status: 200, json: { user_code: 'X', device_auth_id: 'd' } };
      if (c.url === CODEX_DEVICE_TOKEN_URL) return { status: 200, json: { authorization_code: 'ac', code_verifier: 'cv' } };
      return { status: 200, json: { access_token: 'A', refresh_token: 'R', expires_in: 3600 } };
    });
    await loginWithCodex({ fetchImpl, sleepImpl: async () => {}, pollIntervalMs: 1, mirrorCodex: false });
    const tokens = await getCodexAccessToken();
    expect(tokens?.accessToken).toBe('A');
  });

  test('refreshes when within buffer window', async () => {
    // Save expired tokens directly via saveTokens instead of the full login flow.
    const { saveTokens } = await import('../src/oauth/store');
    saveTokens('openai-codex', {
      accessToken: 'stale-A',
      refreshToken: 'stale-R',
      expiresAt: Date.now() + 60_000,  // 60s — well within 120s buffer
    }, { authMode: 'chatgpt', mirrorCodex: false });

    const { fetchImpl, calls } = makeFetch((c) => {
      if (c.url === CODEX_OAUTH_TOKEN_URL) {
        return { status: 200, json: { access_token: 'fresh-A', refresh_token: 'fresh-R', expires_in: 3600 } };
      }
      return { status: 500, json: {} };
    });
    const tokens = await getCodexAccessToken({ fetchImpl, mirrorCodex: false });
    expect(tokens?.accessToken).toBe('fresh-A');
    expect(tokens?.refreshToken).toBe('fresh-R');
    expect(calls.length).toBe(1);
    expect(calls[0].body.grant_type).toBe('refresh_token');
    expect(calls[0].body.refresh_token).toBe('stale-R');

    // And persistence was updated
    const reloaded = loadTokens('openai-codex');
    expect(reloaded?.tokens.accessToken).toBe('fresh-A');
  });
});

describe('loadFreshCodexAuthState — ~/.codex as shared SoT + concurrent-refresh race', () => {
  function jwt(expSec: number): string {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none' })}.${b64({ exp: expSec })}.sig`;
  }
  const nowSec = () => Math.floor(Date.now() / 1000);
  function writeMirror(accessExpSec: number, refresh: string): void {
    const dir = join(root, 'codex-home');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({
      tokens: { access_token: jwt(accessExpSec), refresh_token: refresh },
      last_refresh: new Date().toISOString(),
    }) + '\n');
  }
  async function saveElanous(accessExpSec: number, refresh: string, expiresAt: number): Promise<void> {
    const { saveTokens } = await import('../src/oauth/store');
    saveTokens('openai-codex', {
      accessToken: jwt(accessExpSec), refreshToken: refresh, expiresAt, tokenType: 'Bearer',
    }, { authMode: 'chatgpt', mirrorCodex: false });
  }

  test('adopts the fresher ~/.codex token WITHOUT refreshing (reconcile-first)', async () => {
    await saveElanous(nowSec() - 3600, 'dead-R', Date.now() - 3600_000); // elanous stale
    writeMirror(nowSec() + 7 * 24 * 3600, 'live-R');                   // mirror fresh (CLI refreshed)
    let called = false;
    const { fetchImpl } = makeFetch(() => { called = true; return { status: 500, json: {} }; });
    const state = await loadFreshCodexAuthState({ fetchImpl, mirrorCodex: false });
    expect(state?.tokens.refreshToken).toBe('live-R');
    expect(called).toBe(false); // no doomed refresh against the dead token
  });

  test('refreshes when expiring and no fresher mirror', async () => {
    await saveElanous(nowSec() + 60, 'cur-R', Date.now() + 60_000);      // within 120s buffer
    const { fetchImpl, calls } = makeFetch((c) =>
      c.url === CODEX_OAUTH_TOKEN_URL
        ? { status: 200, json: { access_token: 'fresh-A', refresh_token: 'fresh-R', expires_in: 3600 } }
        : { status: 500, json: {} });
    const state = await loadFreshCodexAuthState({ fetchImpl, mirrorCodex: false });
    expect(state?.tokens.accessToken).toBe('fresh-A');
    expect(calls[0].body.refresh_token).toBe('cur-R');
  });

  test('concurrent race: our refresh 401s while the CLI rotates the mirror → adopt mirror (no throw)', async () => {
    await saveElanous(nowSec() + 30, 'mine-R', Date.now() + 30_000);     // elanous expiring, fresher than initial mirror
    writeMirror(nowSec() - 100, 'old-mirror-R');                       // mirror initially stale
    const { fetchImpl } = makeFetch((c) => {
      if (c.url === CODEX_OAUTH_TOKEN_URL) {
        // The official codex CLI refreshes concurrently → fresh mirror …
        writeMirror(nowSec() + 7 * 24 * 3600, 'cli-fresh-R');
        // … then OUR (now-revoked) refresh token is rejected.
        return { status: 401, json: { error: 'invalid_grant' } };
      }
      return { status: 500, json: {} };
    });
    const state = await loadFreshCodexAuthState({ fetchImpl, mirrorCodex: false });
    expect(state?.tokens.refreshToken).toBe('cli-fresh-R');
  });

  test('both stores dead → throws actionable re-login error', async () => {
    await saveElanous(nowSec() - 10, 'dead-R', Date.now() - 10_000);     // elanous expired, no mirror
    const { fetchImpl } = makeFetch((c) =>
      c.url === CODEX_OAUTH_TOKEN_URL
        ? { status: 401, json: { error: 'invalid_grant' } }
        : { status: 500, json: {} });
    await expect(loadFreshCodexAuthState({ fetchImpl, mirrorCodex: false }))
      .rejects.toThrow(/elanous login openai-codex/);
  });
});

describe('getCodexUserAgent — model-gating header (regression for gpt-5.5 400)', () => {
  beforeEach(() => resetCodexUserAgentCacheForTesting());
  afterEach(() => resetCodexUserAgentCacheForTesting());

  test('matches the codex_cli_rs/<version> (<os>; <arch>) shape', () => {
    const ua = getCodexUserAgent();
    // Prefix the OpenAI backend parses for the Codex client version. The
    // version is the real `codex` binary on PATH, or the fallback constant.
    expect(ua).toMatch(/^codex_cli_rs\/\d+\.\d+\.\d+ \(.+; .+\)$/);
    expect(ua.startsWith('codex_cli_rs/')).toBe(true);
  });

  test('is memoized (stable within a process, reset clears)', () => {
    const a = getCodexUserAgent();
    const b = getCodexUserAgent();
    expect(b).toBe(a);
    resetCodexUserAgentCacheForTesting();
    const c = getCodexUserAgent();
    expect(c).toBe(a); // same environment → same string, just recomputed
  });
});
