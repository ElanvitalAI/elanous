import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadFreshCodexAuthState,
  classifyAuthError,
  CODEX_AUTH_EVENTS,
  _setCodexAuthObserverForTesting,
} from './codex.js';
import { authStorePath } from './store.js';

// ⛔⭐ 관측을 «넣었는데 무는 테스트가 없었다»를 고치는 파일 (리뷰 3·4라운드 must-fix).
//
// 🪞 4라운드 지적이 아팠다: 초판은 `covered` Set 을 «내가 손으로» 적어 통과시키는 Goodhart 였고,
//   *"못 탄다"* 고 적은 갈래 둘도 사실은 fetchImpl 로 «탈 수 있었다».
//   ⇒ 이제 ⓐ 모든 갈래를 «실제로» 태우고 ⓑ 커버 판정을 «관측된 이벤트에서 유도»한다(손으로 안 적는다).

const ACCESS = 'SECRET-ACCESS-abc123';
const REFRESH = 'SECRET-REFRESH-xyz789';

const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
/** ⛔⭐ 커버 판정을 «손으로 적지 않는다» — 4라운드 리뷰가 그 Goodhart 를 잡았다.
 *  각 테스트가 «실제로 관측한» 이벤트를 여기 누적하고, 마지막 테스트가 미커버를 «계산»한다. */
const observedEvents = new Set<string>();
let home: string;
let savedXdg: string | undefined;
let savedCodexHome: string | undefined;
let savedRemoteAccessOnly: string | undefined;

function setStore(state: unknown): void {
  const path = authStorePath();
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, providers: state ? { 'openai-codex': state } : {} }));
}

/** 공식 codex CLI 가 쓰는 미러(~/.codex/auth.json) — 경합 복구 갈래를 «만들어» 태운다. */
function setMirror(tokens: { access_token: string; refresh_token: string; expiresAtMs: number }): void {
  const dir = join(home, '.codex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    tokens: { access_token: tokens.access_token, refresh_token: tokens.refresh_token },
    last_refresh: new Date(tokens.expiresAtMs - 3_600_000).toISOString(),
  }));
}

const state = (expiresInMs: number) => ({
  tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() + expiresInMs },
  lastRefresh: new Date().toISOString(),
});

const failingFetch = (async () => { throw new Error('네트워크 없음'); }) as unknown as typeof fetch;
const okFetch = (async () => new Response(JSON.stringify({
  access_token: 'NEW-ACCESS', refresh_token: 'NEW-REFRESH', expires_in: 3600, token_type: 'Bearer',
}), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

beforeEach(() => {
  seen.length = 0;
  home = mkdtempSync(join(tmpdir(), 'codex-obs-'));
  savedXdg = process.env.XDG_CONFIG_HOME;
  savedCodexHome = process.env.CODEX_HOME;
  savedRemoteAccessOnly = process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  process.env.CODEX_HOME = join(home, '.codex');
  _setCodexAuthObserverForTesting((event, data) => { seen.push({ event, data }); observedEvents.add(event); });
});

afterEach(() => {
  _setCodexAuthObserverForTesting(null);
  // ⛔ 원래 값을 «복원»한다 — 지우면 실행 환경·병렬 테스트를 오염시킨다(리뷰 should-fix).
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodexHome;
  if (savedRemoteAccessOnly === undefined) delete process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY; else process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = savedRemoteAccessOnly;
  rmSync(home, { recursive: true, force: true });
});

const events = () => seen.map((s) => s.event);
/** ⛔ 토큰 비노출은 «갈래마다» 확인한다 — 한 갈래만 보면 나머지가 새도 모른다. */
function expectNoSecrets(): void {
  const dump = JSON.stringify(seen);
  expect(dump).not.toContain('SECRET-ACCESS');
  expect(dump).not.toContain('SECRET-REFRESH');
  expect(dump).not.toContain('NEW-ACCESS');
  expect(dump).not.toContain('NEW-REFRESH');
  expect(seen.length).toBeGreaterThan(0);   // ⛔ 「안 실렸다」가 「아무것도 안 났다」면 무의미
}

describe('codex 갱신 관측 — 일곱 갈래를 «실제로 태워» 문다', () => {
  test('① no-credential', async () => {
    setStore(null);
    expect(await loadFreshCodexAuthState()).toBeNull();
    expect(events()).toContain('no-credential');
    expectNoSecrets();
  });

  test('② fresh — 갱신 «불필요»도 남긴다', async () => {
    setStore(state(86_400_000));
    await loadFreshCodexAuthState();
    const e = seen.find((s) => s.event === 'fresh');
    expect(e?.data.refreshed).toBe(false);
    expect(typeof e?.data.remainingSeconds).toBe('number');
    expectNoSecrets();
  });

  test('remote access-only host refuses refresh before a network call', async () => {
    setStore(state(1_000));
    process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = '1';
    let calls = 0;
    const fetchImpl = (async () => { calls++; throw new Error('network must not be called'); }) as unknown as typeof fetch;
    expect(await loadFreshCodexAuthState({ fetchImpl })).toBeNull();
    expect(calls).toBe(0);
    expect(events()).not.toContain('refresh-start');
    expect(events()).toContain('no-credential');
  });

  test('③④ refresh-start → refreshed (성공) ⊕ 회전 여부를 값으로', async () => {
    setStore(state(1_000));
    await loadFreshCodexAuthState({ fetchImpl: okFetch, mirrorCodex: false });
    expect(events()).toContain('refresh-start');
    const done = seen.find((s) => s.event === 'refreshed');
    expect(done?.data.refreshed).toBe(true);
    expect(done?.data.refreshTokenRotated).toBe(true);   // REFRESH → NEW-REFRESH
    expectNoSecrets();
  });

  // 🪞 초판은 이 갈래를 «미러» 때문이라 적었는데 실측이 아니었다 — reconcile 은 미러 access_token 이
  //   «JWT 일 때만» 채택한다(jwtExpMs).
  // ⭐ 5라운드 리뷰 should-fix: 「아직 안 만료된 것을 다시 읽었다」는 «경합이 아니다».
  //   ⇒ 진짜 경합을 만든다 — 내 갱신이 도는 «동안» 다른 writer(공식 CLI·다른 턴)가 스토어를 «새로»
  //     갱신하고, 내 refresh_token 은 폐기돼 실패한다. 그 뒤 재읽기가 «남이 넣은 신선한» 토큰을 본다.
  test('⑤ refresh-lost-race-recovered — 갱신 «중»에 다른 writer 가 새 토큰을 넣는다', async () => {
    setStore(state(-60_000));   // 내 것은 «이미 죽었다» — 재읽기가 없으면 재로그인 갈래로 간다
    const racingFetch = (async () => {
      // ⬅️ 「다른 writer」가 그 사이 스토어를 갱신했다.
      setStore({
        tokens: { accessToken: 'OTHER-WRITER-ACCESS', refreshToken: 'OTHER-WRITER-REFRESH', expiresAt: Date.now() + 86_400_000 },
        lastRefresh: new Date().toISOString(),
      });
      throw new Error('refresh_token_reused');   // 내 refresh_token 은 이미 소비됐다
    }) as unknown as typeof fetch;
    await loadFreshCodexAuthState({ fetchImpl: racingFetch }).catch(() => undefined);
    expect(events()).toContain('refresh-lost-race-recovered');
    // ⛔ 「죽었는데 살아났다」가 이 갈래의 뜻이다 — 재로그인 갈래로 «안» 갔음을 못 박는다.
    expect(events()).not.toContain('refresh-failed-relogin-required');
    expectNoSecrets();
  });

  test('⑥ refresh-failed-relogin-required — «이미» 만료 ⊕ 미러도 없음', async () => {
    setStore(state(-60_000));   // 이미 지났다
    await expect(loadFreshCodexAuthState({ fetchImpl: failingFetch })).rejects.toThrow();
    expect(events()).toContain('refresh-failed-relogin-required');
    expectNoSecrets();
  });

  // ⭐ 5라운드 리뷰 should-fix — 「못 만든다」고 적었던 갈래를 리뷰어 힌트로 «태웠다».
  //   조건: reconciled 는 만료인데 state 는 아니다. ⇒ 갱신이 도는 «동안» 스토어가 만료본으로 바뀌면
  //   재읽기(reconciled)가 만료본을 보고, 원래 state 는 아직 버퍼 창 안이라 살아 있다.
  //   🪞 4라운드에 나는 이것을 「이 단위에서는 만들 수 없다」고 적었다 — «틀렸다».
  test('⑦ refresh-failed-using-stale — 재읽기가 «만료본»을 보고 원래 것으로 진행한다', async () => {
    setStore(state(60_000));    // 버퍼 안이지만 아직 «안» 죽었다
    const spoilingFetch = (async () => {
      setStore(state(-60_000)); // ⬅️ 갱신 도는 사이 스토어가 «만료본»으로 바뀐다
      throw new Error('네트워크 없음');
    }) as unknown as typeof fetch;
    await loadFreshCodexAuthState({ fetchImpl: spoilingFetch }).catch(() => undefined);
    expect(events()).toContain('refresh-failed-using-stale');
    expectNoSecrets();
  });

  // ⛔⭐ 커버를 «계산»한다 — 손으로 적으면 4라운드가 잡은 Goodhart 가 다시 난다.
  //   ⚠️ 이 테스트는 «래칫»이다: 커버가 늘면 계속 통과하고, 이미 덮은 갈래가 «퇴화»하면 실패한다.
  test('⛔ 미커버 갈래는 «계산해서» 드러낸다 — 손으로 covered 를 적지 않는다', () => {
    const uncovered = CODEX_AUTH_EVENTS.filter((e) => !observedEvents.has(e));
    // 구조적으로 좁은 창 하나만 남아야 한다:
    //   `refresh-failed-using-stale` 은 «reconciled 는 만료인데 state 는 아닌» 경우인데,
    //   reconcile 은 «더 신선한» 미러만 채택하므로 그 조합을 자연스럽게 못 만든다.
    //   ⇒ 「안 태웠다」가 아니라 ***「이 단위에서는 만들 수 없다」***이며, 그 사실을 값으로 남긴다.
    // ⭐ 5라운드에 마지막 갈래까지 태웠다 ⇒ 미커버가 «없어야» 한다. 래칫을 «조인다».
    expect(uncovered).toEqual([]);
    expect(observedEvents.size).toBe(CODEX_AUTH_EVENTS.length);
  });

  test('모든 관측이 provider 를 달고 이벤트가 «고정 어휘» 안에 있다', async () => {
    setStore(state(1_000));
    await loadFreshCodexAuthState({ fetchImpl: okFetch, mirrorCodex: false });
    for (const s of seen) {
      expect(s.data.provider).toBe('openai-codex');
      expect(CODEX_AUTH_EVENTS as readonly string[]).toContain(s.event);
    }
  });
});

describe('errorName 이 «고정 어휘»다', () => {
  test('모르는 클래스명은 Other 로 접는다', () => {
    class Leaky extends Error {}
    Object.defineProperty(Leaky, 'name', { value: 'sk-secret-classname' });
    const out = classifyAuthError(new Leaky('x'));
    expect(out.errorName).toBe('Other');
    expect(JSON.stringify(out)).not.toContain('sk-secret');
  });

  test('아는 클래스명은 그대로 통과한다', () => {
    expect(classifyAuthError(new TypeError('x')).errorName).toBe('TypeError');
  });
});
