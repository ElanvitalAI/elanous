// grok/credential.ts 계약 — ⭐ **구독이 1순위, API 키는 2순위**.
//
// ⛔ 네트워크를 «타지 않는다» — 합성 HOME 과 합성 env 로만 판정한다.
//    실제 왕복은 2026-08-13 수동 실측으로 확인했고(문서 §7b), 그 결과가
//    이 파일의 상수 기대치(프록시 URL·필수 헤더)로 굳어 있다.

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GROK_API_BASE_URL,
  GROK_SUBSCRIPTION_BASE_URL,
  grokAuthFilePath,
  grokSubscriptionHeaders,
  isGrokUnauthorized,
  isGrokVersionRejected,
  refreshGrokSubscriptionToken,
  resolveGrokCredential,
} from './credential.js';

/** auth.json 을 «실제 형태»(<issuer>::<client_id> 키)로 심은 합성 HOME. */
function homeWithAuth(scopes: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'grok-cred-'));
  mkdirSync(join(home, '.grok'), { recursive: true });
  writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify(scopes), 'utf-8');
  return home;
}

const EMPTY_HOME = (): string => mkdtempSync(join(tmpdir(), 'grok-cred-empty-'));
const KEY_ENV = { XAI_API_KEY: 'xai-test-key' } as NodeJS.ProcessEnv;

describe('resolveGrokCredential — ⭐ 구독 1순위 / API 키 2순위', () => {
  it('구독과 API 키가 «둘 다» 있으면 구독이 이긴다', () => {
    const home = homeWithAuth({
      'https://auth.x.ai::client-uuid': { key: 'sub-token', expires_at: '2026-09-01T00:00:00Z', user_id: 'u1' },
    });
    const c = resolveGrokCredential({ home, env: KEY_ENV, model: 'grok-4.6' });
    expect(c?.kind).toBe('subscription');
    expect(c?.baseUrl).toBe(GROK_SUBSCRIPTION_BASE_URL);
    expect(c?.token).toBe('sub-token');
    expect(c?.source).toBe('auth.json');
  });

  it('구독이 없을 때만 API 키로 간다', () => {
    const c = resolveGrokCredential({ home: EMPTY_HOME(), env: KEY_ENV });
    expect(c?.kind).toBe('api_key');
    expect(c?.baseUrl).toBe(GROK_API_BASE_URL);
    expect(c?.source).toBe('XAI_API_KEY');
  });

  it('API 키 env 는 문서 관례 순서로 본다', () => {
    const home = EMPTY_HOME();
    expect(resolveGrokCredential({ home, env: { GROK_API_KEY: 'g' } as NodeJS.ProcessEnv })?.source).toBe('GROK_API_KEY');
    expect(resolveGrokCredential({ home, env: { GROK_CODE_XAI_API_KEY: 'g' } as NodeJS.ProcessEnv })?.source).toBe('GROK_CODE_XAI_API_KEY');
    // 여럿이면 앞선 이름이 이긴다
    expect(resolveGrokCredential({ home, env: { GROK_API_KEY: 'a', XAI_API_KEY: 'b' } as NodeJS.ProcessEnv })?.source).toBe('XAI_API_KEY');
  });

  it('둘 다 없으면 null (「없음」과 「API 키」를 안 섞는다)', () => {
    expect(resolveGrokCredential({ home: EMPTY_HOME(), env: {} as NodeJS.ProcessEnv })).toBeNull();
  });

  it('⛔ 만료돼도 구독을 유지한다 — refresh 는 바이너리 몫이고, 강등하면 «지갑이 열린다»', () => {
    const home = homeWithAuth({
      's::c': { key: 'stale', expires_at: '2020-01-01T00:00:00Z' },
    });
    expect(resolveGrokCredential({ home, env: KEY_ENV })?.kind).toBe('subscription');
  });

  it('skipSubscription 은 401 뒤 «명시 강등»에만 쓴다', () => {
    const home = homeWithAuth({ 's::c': { key: 'sub', expires_at: '2026-09-01T00:00:00Z' } });
    expect(resolveGrokCredential({ home, env: KEY_ENV, skipSubscription: true })?.kind).toBe('api_key');
    // 구독을 건너뛰었는데 키도 없으면 null
    expect(resolveGrokCredential({ home, env: {} as NodeJS.ProcessEnv, skipSubscription: true })).toBeNull();
  });
});

describe('auth.json 읽기 — ⛔ flat 이 아니고, 판본마다 키가 다르다', () => {
  it('스코프가 여럿이면 «가장 늦게 만료되는» 것을 고른다', () => {
    const home = homeWithAuth({
      'https://auth.x.ai::old': { key: 'old-token', expires_at: '2026-08-01T00:00:00Z' },
      'https://auth.x.ai::new': { key: 'new-token', expires_at: '2026-12-01T00:00:00Z' },
    });
    expect(resolveGrokCredential({ home, env: {} as NodeJS.ProcessEnv })?.token).toBe('new-token');
  });

  it('README 판본 키(accounts.x.ai/sign-in)도 «훑어서» 잡는다', () => {
    // 벤더 README 의 jq 예제가 쓰는 키. 이 기계의 실제 키와 다르다 — 그래서 훑는다.
    const home = homeWithAuth({ 'https://accounts.x.ai/sign-in': { key: 'readme-shape', expires_at: '2026-12-01T00:00:00Z' } });
    expect(resolveGrokCredential({ home, env: {} as NodeJS.ProcessEnv })?.token).toBe('readme-shape');
  });

  it('expires_at 이 없어도 key 만 있으면 쓴다', () => {
    const home = homeWithAuth({ 's::c': { key: 'no-expiry' } });
    expect(resolveGrokCredential({ home, env: {} as NodeJS.ProcessEnv })?.token).toBe('no-expiry');
  });

  it('깨진 JSON · key 없는 스코프 · 비-객체는 구독으로 안 친다', () => {
    const broken = mkdtempSync(join(tmpdir(), 'grok-cred-broken-'));
    mkdirSync(join(broken, '.grok'), { recursive: true });
    writeFileSync(join(broken, '.grok', 'auth.json'), '{ not json', 'utf-8');
    expect(resolveGrokCredential({ home: broken, env: KEY_ENV })?.kind).toBe('api_key');

    const noKey = homeWithAuth({ 's::c': { expires_at: '2026-12-01T00:00:00Z' } });
    expect(resolveGrokCredential({ home: noKey, env: KEY_ENV })?.kind).toBe('api_key');

    const notObj = homeWithAuth({ 's::c': 'plain-string' });
    expect(resolveGrokCredential({ home: notObj, env: KEY_ENV })?.kind).toBe('api_key');
  });

  it('경로는 <home>/.grok/auth.json', () => {
    expect(grokAuthFilePath('/tmp/fake')).toBe(join('/tmp/fake', '.grok', 'auth.json'));
  });
});

describe('필수 헤더 — ⛔ x-grok-client-version 이 빠지면 실측 HTTP 426', () => {
  it('세 헤더가 «항상» 붙는다', () => {
    const h = grokSubscriptionHeaders({ model: 'grok-4.6', userId: 'u1' });
    expect(h['X-XAI-Token-Auth']).toBe('xai-grok-cli');
    expect(h['x-grok-client-version']).toBeTruthy();   // ← 426 방어
    expect(h['x-grok-model-override']).toBe('grok-4.6');
    expect(h['x-userid']).toBe('u1');
  });

  it('model/userId 가 없으면 그 헤더는 «안» 붙는다', () => {
    const h = grokSubscriptionHeaders({});
    expect(h['x-grok-model-override']).toBeUndefined();
    expect(h['x-userid']).toBeUndefined();
    expect(h['x-grok-client-version']).toBeTruthy();   // 이건 조건부가 아니다
  });

  it('해석기가 낸 자격에도 필수 헤더가 실려 있다 (배선 회귀 방어)', () => {
    const home = homeWithAuth({ 's::c': { key: 'k', expires_at: '2026-12-01T00:00:00Z', user_id: 'u9' } });
    const c = resolveGrokCredential({ home, env: {} as NodeJS.ProcessEnv, model: 'grok-build' });
    expect(c?.headers['x-grok-client-version']).toBeTruthy();
    expect(c?.headers['x-grok-model-override']).toBe('grok-build');
  });

  it('API 키 자격에는 프록시 헤더가 «없다» (엔드포인트가 다르다)', () => {
    const c = resolveGrokCredential({ home: EMPTY_HOME(), env: KEY_ENV, model: 'grok-4.6' });
    expect(c?.headers).toEqual({});
  });
});

describe('실패 분류', () => {
  it('401/403 = 구독 토큰이 죽었다', () => {
    expect(isGrokUnauthorized(401)).toBe(true);
    expect(isGrokUnauthorized(403)).toBe(true);
    expect(isGrokUnauthorized(429)).toBe(false);
    expect(isGrokUnauthorized(200)).toBe(false);
  });

  it('426 = CLI 버전 거절 (실측 문면도 문다)', () => {
    expect(isGrokVersionRejected(426)).toBe(true);
    expect(isGrokVersionRejected(400, 'Your Grok CLI version (none) is outdated. Please update…')).toBe(true);
    expect(isGrokVersionRejected(400, 'bad request')).toBe(false);
  });
});

describe('refreshGrokSubscriptionToken — ⭐ 강등보다 «앞»에 오는 칸', () => {
  it('만료가 «앞으로» 가면 refreshed', () => {
    const home = homeWithAuth({ 's::c': { key: 'k', expires_at: '2026-01-01T00:00:00Z' } });
    const outcome = refreshGrokSubscriptionToken({
      home,
      // 실 바이너리 대신: 호출되면 파일의 만료를 미래로 민다(= 바이너리가 갱신한 셈).
      execImpl: () => {
        writeFileSync(join(home, '.grok', 'auth.json'),
          JSON.stringify({ 's::c': { key: 'k2', expires_at: '2026-12-31T00:00:00Z' } }), 'utf-8');
      },
    });
    expect(outcome).toBe('refreshed');
  });

  it('⛔ rc=0 만 믿지 않는다 — 만료가 «그대로»면 unchanged', () => {
    const home = homeWithAuth({ 's::c': { key: 'k', expires_at: '2026-01-01T00:00:00Z' } });
    expect(refreshGrokSubscriptionToken({ home, execImpl: () => { /* 성공했지만 아무것도 안 바뀜 */ } }))
      .toBe('unchanged');
  });

  it('명령이 던지면 failed (⛔ 밖으로 안 던진다)', () => {
    const home = homeWithAuth({ 's::c': { key: 'k', expires_at: '2026-01-01T00:00:00Z' } });
    expect(refreshGrokSubscriptionToken({
      home, execImpl: () => { throw new Error('grok: not found'); },
    })).toBe('failed');
  });

  it('자격 파일이 아예 없으면 no-credential (「없음」과 「실패」를 가른다)', () => {
    expect(refreshGrokSubscriptionToken({ home: EMPTY_HOME(), execImpl: () => { /* noop */ } }))
      .toBe('no-credential');
  });

  it('Pod env + 만료 10분 전 access 는 중계의 새 key 로 0600 다시 쓰기를 하고, 500 이면 옛 key 를 유지한다', async () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    const soon = new Date(now + 10 * 60 * 1000).toISOString();
    const home = homeWithAuth({
      's::c': { key: 'old-access', expires_at: soon, refresh_token: 'do-not-send', user_id: 'acct-1' },
    });
    const seenAuth: string[] = [];
    const ok = Bun.serve({
      port: 0,
      async fetch(req) {
        seenAuth.push(req.headers.get('authorization') ?? '');
        return Response.json({ key: 'new-access', expires_at: '2026-09-26T18:00:00.000Z' });
      },
    });
    try {
      const env = {
        ELANOUS_POD_CREDENTIAL_URL: ok.url.href,
        ELANOUS_POD_CREDENTIAL_TOKEN: 'pod-token',
      } as NodeJS.ProcessEnv;
      const cred = await resolveGrokCredential({ home, env, now: () => now });
      expect(cred?.token).toBe('new-access');
      expect(seenAuth).toEqual(['Bearer pod-token']);
      const path = join(home, '.grok', 'auth.json');
      const mode = (await import('node:fs')).statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
      const written = JSON.parse((await import('node:fs')).readFileSync(path, 'utf-8')) as {
        's::c': { key: string; refresh_token: string };
      };
      expect(written['s::c'].key).toBe('new-access');
      expect(written['s::c'].refresh_token).toBe('do-not-send');
    } finally {
      ok.stop(true);
    }

    const stale = homeWithAuth({
      's::c': { key: 'keep-me', expires_at: soon, refresh_token: 'stay' },
    });
    const bad = Bun.serve({
      port: 0,
      fetch() { return new Response('no', { status: 500 }); },
    });
    try {
      const cred = await resolveGrokCredential({
        home: stale,
        env: {
          ELANOUS_POD_CREDENTIAL_URL: bad.url.href,
          ELANOUS_POD_CREDENTIAL_TOKEN: 'pod-token',
        } as NodeJS.ProcessEnv,
        now: () => now,
      });
      expect(cred?.token).toBe('keep-me');
      const body = JSON.parse((await import('node:fs')).readFileSync(join(stale, '.grok', 'auth.json'), 'utf-8')) as {
        's::c': { key: string };
      };
      expect(body['s::c'].key).toBe('keep-me');
    } finally {
      bad.stop(true);
    }
  });

  it('⛔ 읽기 전용 명령을 쓴다 — 쿼터를 태우는 추론이 아니다', () => {
    let seen: string[] = [];
    const home = homeWithAuth({ 's::c': { key: 'k', expires_at: '2026-01-01T00:00:00Z' } });
    refreshGrokSubscriptionToken({ home, execImpl: (_cmd, args) => { seen = args; } });
    expect(seen).toEqual(['models']);
  });
});
