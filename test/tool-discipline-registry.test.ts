// 능력 술어 판 — 모델군 → 툴 규율 «해소 지점 하나».
//
// 대표 2026-08-14: *"claude 제외 다른 LLM 들이 공용화가 많아 보이고, 오히려 claude 일 때
//                 옵션화를 해야 하는 게 아닌지 의문이 드네요?"*
// 📏 그 물음에 실측으로 답하면: family 전용 분기는 codex 24 · gemini 6 · claude 5 · grok 4 · local 2 이고,
//    claude 5곳 중 「진짜 claude 전용」은 하나뿐이다(나머지는 「거의 전부」를 나열한 포함 목록).
//    ⇒ 분기 수는 「특수성」이 아니라 «측정량»의 지표다.
// ⇒ [S] 와 합의한 축 분담: 축①(family 를 «누가 정하나») = [S] · 축②(그 군이 «무슨 능력»을 받나) = [T].
//    이 파일은 축② 다.

import { describe, test, expect } from 'bun:test';
import { resolveToolDiscipline, CODEX_TOOL_DISCIPLINE, GROK_TOOL_DISCIPLINE, OPEN_WEIGHT_TOOL_DISCIPLINE } from '../src/llm';
import type { ModelFamily } from '../src/models/prompts';

// ⛔⭐ 무인 리뷰 must-fix(#9079) — 초판은 `as const` 배열에 `satisfies readonly ModelFamily[]` 를
//   걸었는데, 그건 ***원소가 «유효한지»만 보고 «전수인지»는 안 본다***. 군이 하나 늘어도
//   이 배열이 낡은 채로 컴파일되고, 그러면 아래 「모든 군」 테스트가 «거짓말»이 된다.
//   ⇒ 키 완전성을 강제하는 형태로 바꾼다: `Record<ModelFamily, 1>` 은 빠진 키를 컴파일 에러로,
//     `satisfies` 는 «없는 키»를 컴파일 에러로 만든다. 양쪽이 막힌다.
const FAMILY_KEYS = {
  claude: 1, gpt: 1, codex: 1, grok: 1, gemini: 1, local: 1, 'open-weight': 1, other: 1,
} satisfies Record<ModelFamily, 1>;
const ALL_FAMILIES = Object.keys(FAMILY_KEYS) as readonly ModelFamily[];

describe('resolveToolDiscipline — 군마다 «칸»이 있다(분기가 아니라)', () => {
  test('규율이 있는 군은 그 문면을 그대로 돌려준다', () => {
    expect(resolveToolDiscipline('codex')).toBe(CODEX_TOOL_DISCIPLINE);
    expect(resolveToolDiscipline('grok')).toBe(GROK_TOOL_DISCIPLINE);
    expect(resolveToolDiscipline('local')).toContain('[local tool-use discipline]');
    expect(resolveToolDiscipline('open-weight')).toBe(OPEN_WEIGHT_TOOL_DISCIPLINE);
    expect(OPEN_WEIGHT_TOOL_DISCIPLINE).toContain('[open-weight tool-use discipline]');
  });

  // ⛔ 「아직 안 쟀다」이지 「필요 없다」가 아니다. 이 단언은 «현재 상태»를 못 박을 뿐이고,
  //    누가 재서 규율을 붙이면 이 줄을 «의식적으로» 고치게 된다.
  test('아직 규율이 없는 군은 null 이다 — 조용한 기본값이 아니라 «명시된» 없음', () => {
    for (const family of ['claude', 'gemini', 'gpt', 'other'] as const) {
      expect(resolveToolDiscipline(family)).toBeNull();
    }
  });

  test('모든 군이 «값을 갖는다» — 빠진 칸이 없다', () => {
    for (const family of ALL_FAMILIES) {
      const v = resolveToolDiscipline(family);
      expect(v === null || (typeof v === 'string' && v.length > 0)).toBe(true);
    }
  });

  // ⛔ 술어의 «입력»은 여전히 family 다 — 그 값이 틀리게 만들어지면 이 층은 못 구한다.
  //    ([S] 지적 · 축① 이 그쪽 몫인 이유). 그 사실을 테스트로 남겨 다음 사람이 오해하지 않게 한다.
  test('모르는 군 · undefined 는 null 이다 — 이 층은 「군을 옳게 정하는 일」을 «대신하지 못한다»', () => {
    expect(resolveToolDiscipline(undefined)).toBeNull();
    expect(resolveToolDiscipline('')).toBeNull();
    expect(resolveToolDiscipline('lmstudio-community/gemma-4-26b-a4b-it')).toBeNull();
  });

  // ⛔⭐ 무인 리뷰 must-fix(#9079) — 입력이 string 이라 Object.prototype 의 키가 올 수 있다.
  //   own-property 로 안 막으면 «함수»가 돌아와 system 메시지 본문으로 주입된다.
  //   ⇒ 「없는 것」이 「그럴듯한 값」으로 나오는 오늘의 그 형태다.
  test('Object.prototype 의 키를 줘도 null 이다 — 상속 프로퍼티가 «내용»으로 새지 않는다', () => {
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const v = resolveToolDiscipline(key);
      expect(v).toBeNull();
      expect(typeof v).not.toBe('function');
    }
  });
});
