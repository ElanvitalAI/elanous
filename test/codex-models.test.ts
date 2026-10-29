// ── Codex model catalog tests ──

import { describe, test, expect } from 'bun:test';
import {
  CODEX_MODELS, defaultCodexModel, findCodexModel,
  tierBadge, renderModelEntry, renderAllModels,
} from '../src/codex/models';
import { CODEX_DEFAULT_MODEL } from '../src/llm';

describe('codex model catalog', () => {
  test('has exactly 10 curated entries', () => {
    // #1450 added the gpt-5.5 flagship entry, growing the curated catalog
    // from 5 → 6. 2026-09-09 added gpt-6-astra (2026-09-03 release) and
    // gpt-5.6-terra (elanous's actual default driver): 6 → 8.
    // 2026-09-23: ***죽은 둘을 빼고 GPT-6 둘을 넣었다*** — 순증 0 이라 8 그대로다.
    //   뺀 것: `gpt-5-codex-mini` · `codex-mini-latest` — ***API 에도 구독 카탈로그에도 없었다***
    //          (라이브 대조: `bun scripts/check-codex-picker-models.ts`).
    //   넣은 것: `gpt-6-sol`(운영 기본) · `gpt-6-luna`.
    // 2026-10-28: GPT-6.1 Terra/Sol add two current Codex models, growing 8 → 10.
    // ⛔ 이 수는 「8이어야 한다」가 아니라 ***「피커는 «고를 수 있는 만큼»만 담는다」***는 규율의
    //    대리 지표다 — 늘릴 땐 이 줄이 빨개져서 「왜 늘렸나」를 적게 된다.
    expect(CODEX_MODELS.length).toBe(10);
  });

  test('the recommended entry is the model elanous actually defaults to', () => {
    // ⛔ 이 표의 recommended 는 「가장 센 것」이 아니라 「기본으로 골라도 되는 것」이다.
    //    2026-09-09 이전에는 두 세대 전 gpt-5.5 가 앉아 있었다.
    //
    // ⭐⭐ 2026-09-23 — 종전엔 이 줄이 `'gpt-5.6-terra'` 를 «박고» 있었다. ***이름은
    //   「elanous 가 실제로 쓰는 기본값인가」인데 본문은 «그날의 값»을 물었다.*** 그래서
    //   기본값이 의도대로 움직이자(대표 → gpt-6-sol) 이름이 맞는데도 빨개졌다.
    //   ⇒ ***이름대로 «파생»시킨다.*** 기본값을 어디로 옮기든 이 줄은 같은 뜻을 유지한다.
    expect(defaultCodexModel().id).toBe(CODEX_DEFAULT_MODEL);
  });

  test('⛔ 자가 «무는지» — 기본값 상수가 실재하고 피커 안에 있다', () => {
    // 위 시험은 «둘 다 비어 있어도» 통과할 수 있다(둘 다 ''). 그 구멍을 막는다.
    expect(CODEX_DEFAULT_MODEL.length).toBeGreaterThan(0);
    expect(CODEX_MODELS.map((m) => m.id)).toContain(CODEX_DEFAULT_MODEL);
  });

  test('exactly one entry is flagged recommended', () => {
    const rec = CODEX_MODELS.filter(m => m.recommended);
    expect(rec.length).toBe(1);
  });

  test('every entry has id / label / tier / description', () => {
    for (const m of CODEX_MODELS) {
      expect(m.id.length).toBeGreaterThan(0);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(10);
      expect(['flagship', 'balanced', 'cheap', 'specialist', 'legacy']).toContain(m.tier);
    }
  });

  test('ids are unique', () => {
    const ids = CODEX_MODELS.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('defaultCodexModel returns the recommended entry', () => {
    const d = defaultCodexModel();
    expect(d.recommended).toBe(true);
  });

  test('findCodexModel lookup', () => {
    expect(findCodexModel('gpt-5.4-mini')?.tier).toBe('balanced');
    expect(findCodexModel('nonexistent-model-id')).toBeUndefined();
  });

  test('renderModelEntry includes id / tier / description', () => {
    const entry = renderModelEntry(CODEX_MODELS[0], 1);
    expect(entry).toContain('1)');
    expect(entry).toContain(CODEX_MODELS[0].id);
    expect(entry).toContain(CODEX_MODELS[0].description.slice(0, 20));
  });

  test('renderAllModels contains every label', () => {
    const out = renderAllModels();
    for (const m of CODEX_MODELS) expect(out).toContain(m.label);
  });

  test('tierBadge returns visible symbol per tier', () => {
    expect(tierBadge('flagship')).toContain('flagship');
    expect(tierBadge('balanced')).toContain('balanced');
    expect(tierBadge('cheap')).toContain('cheap');
  });
});
