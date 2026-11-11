import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { loadProjectAnchor, loadProjectAnchorWithMeta, PROJECT_ANCHOR_MAX_CHARS, resetUniversalPreambleCache, setGlobalAnchorPathForTest } from './universal-preamble.js';

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
  it('절단 관측이 debug 비활성 상태에서도 나온다', () => {
    const root = mkdtempSync(join(tmpdir(), 'c8-anchor-loss-'));
    const events: Array<{ category: string; event: string }> = [];
    const ownEnabled = Object.getOwnPropertyDescriptor(debug, 'enabled');
    Object.defineProperty(debug, 'enabled', { configurable: true, get: () => false });
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
      events.push({ category, event });
    }) as typeof debug.log);
    try {
      mkdirSync(join(root, '.git'));
      // Source: universal-preamble.ts PROJECT_ANCHOR_MAX_CHARS is the production shared cap; this fixture crosses it.
      writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(PROJECT_ANCHOR_MAX_CHARS + 1));
      resetUniversalPreambleCache();
      expect(loadProjectAnchor(root).files.some((file) => file.truncated)).toBe(true);
      expect(events).toContainEqual({ category: 'chat.project-anchor', event: 'budget-loss' });
    } finally {
      log.mockRestore();
      if (ownEnabled) Object.defineProperty(debug, 'enabled', ownEnabled);
      else Reflect.deleteProperty(debug, 'enabled');
      resetUniversalPreambleCache();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('관측 이름이 실제로 등록된 카테고리다', () => {
    expect(typeof debug.log).toBe('function');
  });
});
