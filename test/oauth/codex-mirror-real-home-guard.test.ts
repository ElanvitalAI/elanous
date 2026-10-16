// ⛔⭐⭐⭐⭐ 2026-08-05 인시던트의 회귀 — **테스트가 사람의 진짜 codex 로그인을 덮었다.**
//
// 무엇이 있었나
//   테스트가 `saveTokens('openai-codex', …)` 를 «미러를 끄지 않고» 불렀고,
//   그 파일의 beforeEach 가 자를 결정론으로 만들려고 `CODEX_HOME` 을 «삭제»해서
//   미러 기본값이 사용자의 실제 `~/.codex/auth.json` 이 됐다.
//   실측 피해: access_token = {"alg":"none"}…"sig" · refresh_token = "d-r"
//   ⇒ 공식 codex CLI 와 `elanous provider codex usage` 가 «둘 다» 401.
//
// ⛔⭐⭐ **이 파일은 실홈을 대상으로 `saveTokens` 를 «부르지 않는다»** (리뷰 should-fix).
//   종전 판은 그렇게 했는데, ***러너 판정이 깨지는 순간 그 테스트가 인시던트를 «재연»한다.***
//   ⇒ 가드 함수를 «직접» 부른다. 실홈 경로는 «문자열로만» 지나가고 어떤 쓰기도 안 일어난다.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveTokens, assertMirrorTargetIsSafeUnderTest, isUnderTestRunner, resolveMirrorGuardPath,
} from '../../src/oauth/store';

let root: string;
let priorCodexHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-guard-'));
  priorCodexHome = process.env.CODEX_HOME;
});
afterEach(() => {
  if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = priorCodexHome;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const tokens = (a: string) => {
  const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: 'test-account' })).toString('base64url');
  return { accessToken: a, refreshToken: `${a}-r`, idToken: `header.${payload}.signature`, expiresAt: null };
};
const REAL_HOME_AUTH = join(homedir(), '.codex', 'auth.json');

/** 이 환경에서 심볼릭 링크를 만들 수 있나 — 못 만들면 그 축은 «건너뛴 것으로 표시»된다. */
const CAN_SYMLINK = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'symlink-probe-'));
  try { symlinkSync(probe, join(probe, 'l')); return true; } catch { return false; }
  finally { try { rmSync(probe, { recursive: true, force: true }); } catch { /* best-effort */ } }
})();

describe('⓪ 러너 판정 — 이것이 거짓이면 가드는 «영영 안 도는 장식»이다', () => {
  test('bun test 안에서 참이다', () => {
    expect(isUnderTestRunner()).toBe(true);
  });
  test('러너 밖(env 없음)에서는 거짓이다 — 프로덕션 무영향', () => {
    expect(isUnderTestRunner({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('① 가드 — 실홈이 대상이면 «던진다» (쓰기는 일어나지 않는다)', () => {
  test('⛔ 실홈 경로를 그대로 주면 던진다', () => {
    expect(() => assertMirrorTargetIsSafeUnderTest(REAL_HOME_AUTH)).toThrow(/실제 ~\/\.codex\/auth\.json/);
  });

  // ⛔⭐ 링크를 못 만드는 환경에서 «조용히 통과»하면, 이 축이 «안 돌았는데» 초록으로 보인다
  //   (리뷰 should-fix — 「0을 읽기 전에」와 같은 형태다). ⇒ 러너가 «건너뛴 것»으로 «표시»하게 한다.
  test.skipIf(!CAN_SYMLINK)('⛔ «심볼릭 링크»로 우회해도 던진다 — 문자열 비교로는 통과했다(리뷰 must-fix)', () => {
    // <tmp>/link → ~/.codex  ⇒ <tmp>/link/auth.json 은 «실체로» 같은 파일이다
    const link = join(root, 'link');
    symlinkSync(join(homedir(), '.codex'), link);
    expect(() => assertMirrorTargetIsSafeUnderTest(join(link, 'auth.json'))).toThrow(/실제 ~\/\.codex/);
  });

  test.skipIf(!CAN_SYMLINK)('⛔ 없는 대상 디렉터리로 향한 링크도 문자열 대상까지 풀어 비교한다', () => {
    const future = join(root, 'future-codex-home');
    const link = join(root, 'dangling');
    symlinkSync(future, link);
    expect(resolveMirrorGuardPath(join(link, 'auth.json'))).toBe(resolveMirrorGuardPath(join(future, 'auth.json')));
  });

  test('✅ 임시 경로는 통과한다 — 가드가 정당한 테스트를 막지 않는다', () => {
    expect(() => assertMirrorTargetIsSafeUnderTest(join(root, 'codex-home', 'auth.json'))).not.toThrow();
  });
});

describe('② 배선 — saveTokens 가 그 가드를 «실제로» 거친다', () => {
  test('⛔ CODEX_HOME 을 지운 뒤 codex 토큰을 저장하면 던진다 (인시던트의 정확한 형태)', () => {
    // ⚠️ 여기서도 실물은 안 건드려진다 — 가드가 «쓰기 전»에 던지는 것이 계약이고,
    //   그 계약을 위 ①이 쓰기 없이 이미 잠갔다. 여기서는 「배선이 됐나」만 본다.
    delete process.env.CODEX_HOME;
    expect(() => saveTokens('openai-codex', tokens('FIXTURE'), {}, join(root, 'auth.json')))
      .toThrow(/실제 ~\/\.codex\/auth\.json/);
  });

  test('⛔ 이름 계정이 «기록된 홈»으로 가는 경우도 실홈이면 막힌다', () => {
    expect(() => saveTokens('openai-codex:evil', tokens('X'), { codexHome: join(homedir(), '.codex') }, join(root, 'auth.json')))
      .toThrow(/실제 ~\/\.codex\/auth\.json/);
  });

  test('✅ CODEX_HOME 을 임시 경로로 «세우면» 정상 통과한다', () => {
    const home = join(root, 'codex-home');
    mkdirSync(home, { recursive: true });
    process.env.CODEX_HOME = home;
    saveTokens('openai-codex', tokens('OK'), {}, join(root, 'auth.json'));
    expect(JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')).tokens.access_token).toBe('OK');
  });

  test('✅ mirrorCodex:false 는 애초에 미러를 안 쓴다', () => {
    delete process.env.CODEX_HOME;
    expect(() => saveTokens('openai-codex', tokens('NOMIRROR'), { mirrorCodex: false }, join(root, 'auth.json')))
      .not.toThrow();
  });
});

// ⭐ 3층 — 미러 쓰기가 «관측»으로 남는다. ⛔ 그리고 그 관측에 «토큰 값이 없다».
describe('③ 관측 — 남기되, 토큰은 안 흘린다', () => {
  async function captureMirrorLogs(run: () => void): Promise<Array<{ cat: string; event: string; data: unknown }>> {
    const { debug } = await import('../../src/debug/log');
    const seen: Array<{ cat: string; event: string; data: unknown }> = [];
    const original = debug.log;
    (debug as { log: unknown }).log = ((cat: string, event: string, data?: unknown) => {
      if (cat === 'oauth.codex-mirror') seen.push({ cat, event, data });
    }) as typeof debug.log;
    try { run(); } finally { (debug as { log: unknown }).log = original; }
    return seen;
  }

  test('성공을 남기고, 그 안에 토큰 값이 «없다»', async () => {
    const home = join(root, 'observed-home');
    mkdirSync(home, { recursive: true });
    process.env.CODEX_HOME = home;
    const seen = await captureMirrorLogs(() => {
      saveTokens('openai-codex', tokens('SECRET-ACCESS'), {}, join(root, 'auth.json'));
    });
    expect(seen.some((s) => s.event === 'wrote')).toBe(true);
    const dump = JSON.stringify(seen);
    expect(dump).not.toContain('SECRET-ACCESS');       // ⛔ access token
    expect(dump).not.toContain('SECRET-ACCESS-r');     // ⛔ refresh token
  });

  test('실패도 «남기고», 예외 메시지를 통째로 싣지 않는다 (종류·코드만)', async () => {
    // 홈 자리에 «파일»을 놓으면 mkdirSync 가 ENOTDIR 로 깨진다 — 실패 경로를 실물로 만든다
    const blocked = join(root, 'blocked');
    require('node:fs').writeFileSync(blocked, 'not a directory');
    process.env.CODEX_HOME = join(blocked, 'inner');
    const seen = await captureMirrorLogs(() => {
      saveTokens('openai-codex', tokens('SECRET2'), {}, join(root, 'auth.json'));
    });
    const failed = seen.find((s) => s.event === 'write-failed');
    expect(failed).toBeTruthy();
    const data = failed!.data as Record<string, unknown>;
    expect(typeof data.errorName).toBe('string');
    expect('message' in data).toBe(false);             // ⛔ 통제되지 않은 메시지를 안 싣는다
    expect(JSON.stringify(seen)).not.toContain('SECRET2');
  });
});
