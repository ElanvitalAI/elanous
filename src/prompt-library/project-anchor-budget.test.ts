import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { debug } from '../debug/log.js';
import { loadProjectAnchorWithMeta, PROJECT_ANCHOR_MAX_CHARS, resetUniversalPreambleCache, setGlobalAnchorPathForTest } from './universal-preamble.js';

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * ⛔⭐⭐ 상설 PLAN §6 「새로 열린 것」 ① — ***여유는 «공유»다.***
 *
 * `AGENTS.md` 가 커지면 같은 예산을 쓰는 `DESIGN.md` 가 «조용히» 잘린다.
 * 📏 2026-08-25 실측: 그 사실을 «읽는 자»가 이 모듈 밖에 ***0***이었다
 *    ⇒ 잘려도 아무 일이 안 일어나고, 자식은 「디자인이 없는 저장소」로 읽는다.
 *
 * 🩹 그래서 이 파일이 그 «읽는 자»다. ⛔ 수를 여기 박지 않는다 — 상한은 코드가 canonical 이다.
 */
describe('프로젝트 앵커 예산 — 이 저장소가 상한 «안»에 있나', () => {
  // 저장소 앵커만 잰다 — 사용자 전역 ~/.elanous/AGENTS.md 는 이 저장소의 예산이 아니다.
  beforeAll(() => setGlobalAnchorPathForTest(null));
  afterAll(() => setGlobalAnchorPathForTest(undefined));
  it('앵커 파일이 하나도 «잘리지» 않는다', () => {
    resetUniversalPreambleCache();
    const result = loadProjectAnchorWithMeta(REPO_ROOT);
    const truncated = result.files.filter((file) => file.truncated).map((file) => file.filename);
    // ⛔ 여유가 얼마 남았는지를 실패 문면에 «같이» 낸다 — 「잘렸다」만으론 얼마나 줄일지 모른다.
    expect({ truncated, totalChars: result.totalChars, cap: PROJECT_ANCHOR_MAX_CHARS })
      .toEqual({ truncated: [], totalChars: result.totalChars, cap: PROJECT_ANCHOR_MAX_CHARS });
  });

  it('예산이 차서 «통째로 빠진» 파일이 없다', () => {
    resetUniversalPreambleCache();
    const result = loadProjectAnchorWithMeta(REPO_ROOT);
    const dropped = result.skipped.filter((file) => file.reason === 'budget-exhausted').map((file) => file.filename);
    expect(dropped).toEqual([]);
  });

  // ⛔⭐ 「없다」와 「못 읽었다」를 가른다 — 앵커가 «아예 안 잡히면» 위 둘은 공짜로 통과한다.
  //   그건 「상한 안에 있다」가 아니라 ***「측정 불가」***다.
  it('앵커를 실제로 «읽었다» — 위 둘이 공짜로 통과하는 것을 막는다', () => {
    resetUniversalPreambleCache();
    const result = loadProjectAnchorWithMeta(REPO_ROOT);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.totalChars).toBeGreaterThan(0);
  });

  // ⛔⭐⭐ 관측이 `if (debug.enabled)` 뒤에 있으면 ***운영에서 꺼진다***(핫패스 게이트).
  //   절단은 드물고 결과가 크니 ***항상*** 남겨야 한다. 그 계약을 기계가 문다.
  it('절단 관측이 «조건부»가 아니다 — debug 가 꺼져 있어도 남는다', () => {
    const source = require('node:fs').readFileSync(new URL('./universal-preamble.ts', import.meta.url), 'utf8') as string;
    const helper = source.slice(source.indexOf('function observeProjectAnchorLoss'));
    const body = helper.slice(0, helper.indexOf('\n}\n') + 3);
    expect(body).toContain("debug.log('chat.project-anchor', 'budget-loss'");
    expect(body).not.toContain('debug.enabled');
    // 그리고 그 자를 «부르는» 자리가 debug.enabled 블록 «밖»이어야 한다.
    expect(source).toContain('observeProjectAnchorLoss(cwd, result);\n      if (debug.enabled) {');
  });

  it('관측 이름이 실제로 등록된 카테고리다', () => {
    expect(typeof debug.log).toBe('function');
  });
});
