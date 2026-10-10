import { describe, it, expect } from 'bun:test';
import {
  familyPromptCoverage,
  allFamilyPromptCoverage,
  familiesWithNeitherLayer,
  FAMILY_PROBE_MODEL_IDS,
  type FamilyPromptCoverage,
  type CoverageProbeOptions,
} from './family-prompt-coverage.js';
import { getModelFamily } from '../models/prompts.js';
import { buildUniversalPreamble } from './universal-preamble.js';

// ⛔ 앵커 파일(AGENTS.md/CLAUDE.md)을 읽는 cwd 를 «고정»한다 — 계열만 바뀌어야 차이가 계열 탓이다.
//   존재하지 않는 경로를 주어 앵커를 «양쪽 다» 비운다(대조군이 피측정군과 같은 조건).
const PROBE: CoverageProbeOptions = { cwd: '/nonexistent-family-coverage-probe', enabledTools: [] };

describe('family prompt coverage — 자가 «무엇을 재는지»부터 고정한다', () => {
  it('프로브 id 가 «의도한 계열»로 판정된다 (아니면 이 자는 다른 계열을 잰다)', () => {
    for (const [family, modelId] of Object.entries(FAMILY_PROBE_MODEL_IDS)) {
      expect(getModelFamily(modelId)).toBe(family as ReturnType<typeof getModelFamily>);
    }
  });

  it('전 계열을 «빠짐없이» 잰다 — 계열이 늘면 이 수가 어긋나 눈에 띈다', () => {
    const coverage: FamilyPromptCoverage[] = allFamilyPromptCoverage(PROBE);
    expect(coverage.map(c => c.family).sort()).toEqual(
      ['claude', 'codex', 'gemini', 'gpt', 'grok', 'local', 'open-weight'],
    );
  });

  it('⭐ addendum 유무는 «실제 preamble 산출»에서 온다 — 손으로 적은 목록이 아니다', () => {
    // ⛔ 자기확증 금지(리뷰 should-fix) — 자가 낸 값을 다시 자에게 물으면 «측정 방식»을 못 검증한다.
    //   ⇒ 자를 «거치지 않고» preamble 을 직접 두 번 돌려, 그 대조가 자의 값과 일치하는지 본다.
    const baseline = buildUniversalPreamble({ cwd: PROBE.cwd!, enabledTools: [] })
      .map(m => String(m.content)).join('\n');
    for (const c of allFamilyPromptCoverage(PROBE)) {
      const withFamily = buildUniversalPreamble({
        cwd: PROBE.cwd!, enabledTools: [], modelFamily: c.family,
      }).map(m => String(m.content)).join('\n');
      // 자가 true 라 했으면 실제로 달라야 하고, false 라 했으면 실제로 같아야 한다.
      expect(withFamily !== baseline).toBe(c.hasFamilyAddendum);
    }
  });
});

describe('2026-08-18 기준선 — ⛔ 「통과」가 목표가 아니라 «값이 변하면 보이게» 하는 것이 목표다', () => {
  // ⛔ 이 기준선을 「옳은 상태」로 읽지 마라. 이것은 «그날의 값»이다.
  //   grok 에 전용 variant 나 addendum 이 생기면 이 테스트가 실패하고,
  //   그때 이 표를 «다시 재서» 고친다. 그것이 이 테스트의 용도다.
  //
  // 📏 이력 — ⭐ 이 자는 «실제로» 값의 변화를 잡았다:
  //   2026-08-18 21:5x  grok { chat:false, addendum:false } · familiesWithNeitherLayer() === ['grok']
  //   2026-08-18 22:2x  `#10110`(grok family addendum) 착지 ⇒ 이 테스트가 «2 fail» 로 울었다
  //                     ⇒ grok.addendum: false → true · familiesWithNeitherLayer(): ['grok'] → []
  //   2026-08-18 22:1x  grok 전용 chat variant 착지 ⇒ grok.chat: false → true
    //                     · missing-chat: ['gemini', 'grok'] → ['gemini']
    //   2026-08-18 22:2x  gemini 전용 chat variant 착지 ⇒ gemini.chat: false → true
    //                     · missing-chat: ['gemini'] → []
    //   2026-09-13      `gpt6-family-addendum` 착지 ⇒ 이 자가 «1 fail» 로 울었다
  //                     ⇒ gpt.addendum: false → ***true***
  //                     🩸 계기: `gpt-6-astra` 가 `gpt` 계열로 떨어지는데 그 칸에 addendum 이 «없어서»
  //                        어떤 행동 규율도 못 받고 있었다(인계 §36·§37 의 「멈춤」). 공식 GPT-6 가이드를 옮겨 채웠다
  //   ⛔ 그때 한 일은 「테스트를 고친 것」이 아니라 ***「값을 다시 재서 기준선을 옮긴 것」***이다.
  const BASELINE: Record<string, { chat: boolean; addendum: boolean }> = {
    claude: { chat: true, addendum: true },
    codex: { chat: true, addendum: true },
    gpt: { chat: true, addendum: true },
    gemini: { chat: true, addendum: true },
    grok: { chat: true, addendum: true },
    local: { chat: true, addendum: false },
    'open-weight': { chat: false, addendum: false },
  };

  for (const [family, expected] of Object.entries(BASELINE)) {
    it(`${family}: chat=${expected.chat} addendum=${expected.addendum}`, () => {
      const c: FamilyPromptCoverage = familyPromptCoverage(
        family as keyof typeof FAMILY_PROBE_MODEL_IDS,
        PROBE,
      );
      expect(c.hasDedicatedChatVariant).toBe(expected.chat);
      expect(c.hasFamilyAddendum).toBe(expected.addendum);
    });
  }

  it('⭐ 두 층이 «모두» 빈 계열 — 측정된 open-weight', () => {
    // 두 층만 센다. 도구 규율은 이 커버리지 자의 측정 대상이 아니다.
    expect(familiesWithNeitherLayer(PROBE)).toEqual(['open-weight']);
  });

  it('📏 chat variant 가 빈 계열 — 측정된 open-weight', () => {
    const missingChat = allFamilyPromptCoverage(PROBE)
      .filter(c => !c.hasDedicatedChatVariant)
      .map(c => c.family)
      .sort();
    expect(missingChat).toEqual(['open-weight']);
  });
});
