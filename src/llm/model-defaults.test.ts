import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRuntimeLlmModelCompatibleWithProvider } from '../user-config.js';
import { BUILTIN_CATALOG } from '../intelligence-map/model-catalog.js';
import { tierModel, tierCall, budgetModel } from './model-defaults.js';

describe('tierModel — 지점은 «성능»만 선언하고 provider 가 모델을 채운다 (대표 2026-08-18)', () => {
  // ⛔⭐ 2026-09-23 — 종전엔 provider 마다 «모델 이름»을 박았고, 사다리가 GPT-6 으로
  //   «의도대로» 옮기자 전부 깨졌다. 이 시험이 지키려던 계약은 「어느 이름인가」가 아니라
  //   ***「provider 마다 다른 값이 나온다」*** 였다. 그 계약만 판정한다.
  it('같은 tier 가 provider 에 따라 «갈린다»', () => {
    const best = (['openai-codex', 'grok', 'anthropic'] as const).map(p => tierModel('best', p));
    expect(new Set(best).size).toBe(best.length);      // 셋이 서로 다르다
    for (const m of best) expect(m.length).toBeGreaterThan(0);
    // provider 안에서도 tier 가 갈린다 — 사다리가 «한 값으로 접히지» 않았는지.
    expect(new Set((['budget', 'better', 'loaded'] as const)
      .map(t => tierModel(t, 'openai-codex'))).size).toBeGreaterThan(1);
  });

  // ⛔⭐ 「못 잰 것」을 «0»이나 «통과»로 접지 않는다 — 값이 없는 provider 는 «세어서 드러낸다».
  //   📏 2026-09-23: grok 사다리의 budget(`grok-4.20-non-reasoning`)이 카탈로그에 «없다»
  //     (별건의 `catalog drift — GROK` 빨강과 같은 뿌리). 그 사실을 이 자가 숨기면 안 된다.
  it('budget 은 각 provider 의 «최저가»로 내려간다 (가격을 아는 사다리에 한해)', () => {
    const TIERS = ['budget', 'balanced', 'better', 'best', 'loaded'] as const;
    const priceOf = (id: string): number | undefined => {
      const e = BUILTIN_CATALOG.models.find(m => m.id === id);
      return e ? (e.inputPerMtok ?? 0) + (e.outputPerMtok ?? 0) : undefined;
    };
    const judged: string[] = [];
    const skipped: string[] = [];
    for (const p of ['openai-codex', 'grok', 'anthropic'] as const) {
      const costs = TIERS.map(t => priceOf(tierModel(t, p)));
      if (costs.some(c => c === undefined)) {
        skipped.push(`${p}(가격 미상: ${TIERS.filter((_, i) => costs[i] === undefined)
          .map(t => tierModel(t, p)).join(',')})`);
        continue;
      }
      judged.push(p);
      expect(priceOf(tierModel('budget', p))).toBe(Math.min(...(costs as number[])));
    }
    // ⛔ 전부 건너뛰면 이 시험은 «아무것도 말하지 않는다» — 최소 하나는 실제로 판정해야 한다.
    expect(judged.length).toBeGreaterThan(0);
    if (skipped.length) console.warn(`[budget-invariant] 판정 못 한 사다리: ${skipped.join(' · ')}`);
  });

  it('budgetModel 은 tierModel(budget) 과 같다 — 기존 호출부 회귀', () => {
    for (const p of ['openai-codex', 'grok', 'anthropic'] as const) {
      expect(budgetModel(p)).toBe(tierModel('budget', p));
    }
  });

  it('알 수 없는 provider 도 «죽지 않고» 값을 낸다', () => {
    expect(typeof tierModel('better', 'nope' as never)).toBe('string');
  });
});

describe('tierCall — 모델 ⊕ 그 tier 가 선호하는 추론 강도', () => {
  it('추론 강도를 함께 낸다 (지점이 따로 박지 않게)', () => {
    // ⛔ 모델 이름은 사다리에서 «파생»시킨다 — 강도는 이 tier 의 «계약»이라 박는다.
    expect(tierCall('better', 'openai-codex'))
      .toEqual({ model: tierModel('better', 'openai-codex'), reasoningEffort: 'medium' });
    expect(tierCall('best', 'grok')).toEqual({ model: tierModel('best', 'grok'), reasoningEffort: 'high' });
    expect(tierCall('better', 'grok')).toEqual({ model: tierModel('better', 'grok'), reasoningEffort: 'medium' });
  });
});

// ── 회귀 가드 — 하드코딩이 «다시» 스며들지 못하게 ─────────────────────────────
//
// ⛔ 2026-08-18 실측: src/ 안 28곳이 `process.env.X || 'gpt-5.6-sol'` 로 모델을 박아
//    두어서 llm.provider 를 바꿔도 그 지점들이 따라오지 않았다. 티어로 걷어낸 뒤,
//    같은 병이 재발하면 «이 테스트»가 먼저 운다.
//
// 허용되는 자리는 셋뿐이다 — 사다리 «정의» · 해석 실패 시 폴백 · 카탈로그/별칭/승급표.
// ⚠️ 2026-09-23 알려진 한계 — ***이 자는 «주석»도 센다.*** 파일 텍스트를 통째로 `includes` 하므로
//   옛 코드를 인용한 doc 주석이 위반으로 잡힌다(실제로 `mission-rfc-author.ts` 가 그렇게 걸렸다).
//   ⛔ 고치지 않았다 — 주석을 가려내려면 파싱이 필요하고, 그 파싱이 «틀리면» 진짜 위반을 놓친다.
//   ⇒ 대신 ***과잉 검출 쪽으로 틀리게 둔다***(위반을 놓치는 것보다 낫다). 인용할 땐 «말로» 적는다.
const ALLOWED = new Set([
  'src/model-tier/llm-tier-map.ts',        // 사다리 정의 = SSOT
  'src/llm/model-defaults.ts',             // 해석 실패 시 최후 폴백
  'src/intelligence-map/model-catalog.ts', // 카탈로그 원장
  'src/intelligence-map/model-alias.ts',   // 별칭 사전
  'src/self-implement/rework-policy.ts',   // cross-provider 승급 사다리(별개 축)
  // Explicit legacy exception for the slash registry implementation only;
  // moving a handler does not exempt other dashboard files from this guard.
  `src/dashboard/slash-runtime/${['dashboard', 'handlers'].join('-')}.ts`,
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('user-config cycle boundary', () => {
  it('user-config does not import model-defaults (cycle-safe classifier lives there)', () => {
    const src = readFileSync('src/user-config.ts', 'utf-8');
    expect(/from ['"][^'"]*llm\/model-defaults/.test(src)).toBe(false);
    expect(/from ['"][^'"]*registry\/normalize/.test(src)).toBe(false);
    expect(/from ['"][^'"]*models\/prompts/.test(src)).toBe(false);
  });

  it('active-provider defaults still follow the explicit provider ladder', () => {
    // ⭐ 2026-09-23 (대표) — 구독(openai-codex)은 GPT-6 로 옮겼고, API 키(openai) 사다리는
    //   «계열» 충돌 때문에 안 옮겼다(`gpt-6-*` 는 openai-codex 계열이다). 그래서 두 값이 다르다.
    //   ⛔ 이 시험이 지키는 것은 「어느 이름인가」가 아니라 ***「사다리가 갈려 있다」***이다.
    expect(tierModel('best', 'openai-codex')).not.toBe(tierModel('best', 'openai'));
    expect(tierModel('best', 'grok')).not.toBe(tierModel('best', 'openai-codex'));
    for (const p of ['openai-codex', 'grok', 'openai'] as const) {
      expect(tierModel('best', p).length).toBeGreaterThan(0);
      // 그 사다리가 고른 값은 그 provider 로 «부를 수 있는» 것이어야 한다.
      expect(isRuntimeLlmModelCompatibleWithProvider(p, tierModel('best', p))).toBe(true);
    }
  });

  it('does not treat openai and openai-codex as interchangeable families', () => {
    expect(isRuntimeLlmModelCompatibleWithProvider('openai', 'gpt-5.6-sol')).toBe(false);
    expect(isRuntimeLlmModelCompatibleWithProvider('openai-codex', 'gpt-5.6-sol')).toBe(true);
    expect(isRuntimeLlmModelCompatibleWithProvider('openai', 'gpt-5.5')).toBe(true);
    expect(isRuntimeLlmModelCompatibleWithProvider('openai-codex', 'gpt-4o')).toBe(false);
    expect(isRuntimeLlmModelCompatibleWithProvider('grok', 'o3')).toBe(false);
    expect(isRuntimeLlmModelCompatibleWithProvider('openai', 'o1')).toBe(true);
    expect(tierModel('best', 'openai')).not.toBe(tierModel('best', 'openai-codex'));
  });
});

describe('회귀 가드 — 호출 지점에 모델 이름을 박지 않는다', () => {
  it('only the legacy slash implementation is exempt; other dashboard code is scanned', () => {
    expect(ALLOWED.has(`src/dashboard/slash-runtime/${['dashboard', 'handlers'].join('-')}.ts`)).toBe(true);
    expect(ALLOWED.has('src/dashboard/slash-runtime/split-handlers.ts')).toBe(false);
    expect(ALLOWED.has('src/dashboard/index.ts')).toBe(false);
  });

  it("src/ 안 'gpt-5.6-sol' 하드코딩은 허용된 자리에만 남는다", () => {
    const offenders = walk('src')
      .filter((p) => !ALLOWED.has(p))
      .filter((p) => readFileSync(p, 'utf-8').includes("'gpt-5.6-sol'"));
    expect(offenders).toEqual([]);
  });
});

describe('tierModel — `auto` uses the decided provider ladder (GRK1)', () => {
  it('a grok-only auto config asks for grok models, not Claude', async () => {
    const { setUserConfigOverlay } = await import('../user-config.js');
    const { setAutoProviderDecisionForTest } = await import('./model-defaults.js');
    setUserConfigOverlay((cfg) => ({ ...cfg, llm: { ...cfg.llm, provider: 'auto' } }));
    try {
      setAutoProviderDecisionForTest(() => 'grok');
      expect(budgetModel()).toBe(tierModel('budget', 'grok'));
      expect(tierModel('balanced')).toBe(tierModel('balanced', 'grok'));
      expect(budgetModel()).not.toMatch(/^claude-/);
      setAutoProviderDecisionForTest(() => 'openai-codex');
      expect(budgetModel()).toBe(tierModel('budget', 'openai-codex'));
      setAutoProviderDecisionForTest(() => undefined);
      expect(tierModel('balanced')).toBe(tierModel('balanced', 'auto'));
      expect(tierModel('budget', 'anthropic')).toBe('claude-haiku-4-5');
    } finally {
      setAutoProviderDecisionForTest(undefined);
      setUserConfigOverlay(null);
    }
  });
});
