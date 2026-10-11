// ⭐⭐⭐ 2026-09-23 신설 — ***사다리가 약속한 provider 가 실제로 «생성되나».***
//
// 🩸 계기: `kimi` · `qwen` · `glm` 이 티어 사다리에 «다섯 칸씩» 있고 `status: 'shipping'` 이라
//   말하는데, 실제로 고르면 ***`unknown provider: kimi` 를 던진다.***
//   🔑 `llm.ts` 의 provider 생성 switch 에 case 가 «없고», 그 switch 끝의 exhaustiveness 폴백이
//     이 일을 ***예언한 주석***을 달고 있었다:
//       *"Throws so a future provider added to the union without a case here fails loud at first call."*
//     ⇒ union 에만 더해졌고 분기는 안 왔다. ***그리고 아무 자도 그것을 안 물었다.***
//
// ⛔⭐ 이 자가 판정하는 것은 ***`status` 필드의 «자기 정의»***다:
//     *"`shipping` = wired on this provider today · `wip` = pulls a fallback"*
//   ⇒ ⑴ `shipping` 이면 ***반드시 생성된다*** (한 방향만 — `wip` 은 약속을 안 한다)
//     ⑵ `wip` 이 실패하더라도 그 문면은 ***「무엇을 하라」를 말해야 한다***
//        (`local` 은 *"set `llm.baseUrl` via `elanous setup`"* 이라 말한다 ↔
//         `kimi` 는 *"unknown provider"* 라 «아무것도» 말하지 않는다)
//
// ⛔ 「셋을 구현하라」도 「union 에서 지우라」도 ***이 자의 주장이 아니다.*** 이 자는 «드러내기»만 한다.
import { afterAll, beforeAll, describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LLM_TIER_MAP_BY_PROVIDER, TIER_PROVIDERS } from './llm-tier-map.js';
import { MODEL_TIERS } from './types.js';

function tierStatuses(provider: (typeof TIER_PROVIDERS)[number]): Set<string> {
  const map = LLM_TIER_MAP_BY_PROVIDER[provider];
  return new Set(MODEL_TIERS.map((tier) => map[tier].status));
}

async function constructionOutcome(provider: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const llm = await import('../llm.js');
  const uc = await import('../user-config.js');
  const base = uc.getUserConfig();
  try {
    llm.getProviderForConfig({ ...base, llm: { ...base.llm, provider, model: undefined } } as never);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

describe('provider 배선 계약 — 사다리가 약속한 것이 «생성되나» (2026-09-23)', () => {
  it('⛔ `TIER_PROVIDERS` 가 사다리 키와 «같은 집합»이다 — 빠지면 아래 판정이 그 provider 를 «안 누른다»', () => {
    expect([...TIER_PROVIDERS].map(String).sort()).toEqual(Object.keys(LLM_TIER_MAP_BY_PROVIDER).sort());
  });

  it('⛔ 자가 «무는지» — 사다리에 provider 가 충분히 있고 status 가 한 값으로 접히지 않았다', () => {
    expect(TIER_PROVIDERS.length).toBeGreaterThan(5);
    const all = new Set(TIER_PROVIDERS.flatMap((p) => [...tierStatuses(p)]));
    expect(all.size).toBeGreaterThan(1);   // shipping 만 있으면 아래 판정이 공허해진다
  });

  it('⭐ `shipping` 이라 말하는 provider 는 «반드시» 생성된다', async () => {
    const broken: string[] = [];
    for (const provider of TIER_PROVIDERS) {
      if (!tierStatuses(provider).has('shipping')) continue;
      const outcome = await constructionOutcome(provider);
      if (!outcome.ok) broken.push(`${provider}: ${outcome.message}`);
    }
    // ⛔ 여기엔 「알려진 예외」를 두지 않는다 — `shipping` 이 곧 「된다」는 약속이기 때문이다.
    //    못 되는 것이 있으면 «코드»가 아니라 그 provider 의 `status` 를 고쳐라.
    expect(broken).toEqual([]);
  });

  it('⭐ `wip` 이 실패하면 «무엇을 하라»를 말해야 한다 — 지금 셋은 안 말한다(드러냄)', async () => {
    const silent: string[] = [];
    const guided: string[] = [];
    for (const provider of TIER_PROVIDERS) {
      const statuses = tierStatuses(provider);
      if (statuses.has('shipping') || !statuses.has('wip')) continue;
      const outcome = await constructionOutcome(provider);
      if (outcome.ok) continue;                       // 되면 그것도 좋다
      if (/unknown provider/i.test(outcome.message)) silent.push(provider);
      else guided.push(provider);
    }
    // 📏 2026-09-23 닫음 — `kimi`·`qwen`·`glm` 은 이제 «OpenRouter 로 쓰라»를 말한다(직결은 여전히 wip).
    //   ⛔ 다시 «말없이» 죽는 wip provider 가 생기면 여기서 이름으로 뜬다.
    expect(silent.sort()).toEqual([]);
    // ⊕ 그리고 «말하는» 쪽이 적어도 하나는 있어야 이 판정이 공허하지 않다.
    //   `local` 은 *"set `llm.baseUrl` via `elanous setup`"* 이라 말한다.
    expect(guided.length).toBeGreaterThan(0);
  });
});

describe('wip 계열의 안내가 «실제로 도는 길»을 가리킨다 (2026-09-23)', () => {
  // ⛔ ZAI-CODING-PLAN-PROVIDER(10-11) — `glm` 은 `ZAI_API_KEY` 가 있으면 «직결로 선다». 이 판정은 «키 없음» 전제를
  //   이름으로 세운다(키 캐시는 파일이라 env 만 지우면 안 된다 · `_resetKeyCacheForTests` 머리말).
  const savedEnv = { cacheDir: process.env.ELANOUS_KEY_CACHE_DIR, zai: process.env.ZAI_API_KEY };
  let emptyCacheDir = '';
  beforeAll(async () => {
    emptyCacheDir = mkdtempSync(join(tmpdir(), 'wip-guide-nokey-'));
    process.env.ELANOUS_KEY_CACHE_DIR = emptyCacheDir;
    delete process.env.ZAI_API_KEY;
    (await import('../config.js'))._resetKeyCacheForTests();
  });
  afterAll(async () => {
    if (savedEnv.cacheDir === undefined) delete process.env.ELANOUS_KEY_CACHE_DIR; else process.env.ELANOUS_KEY_CACHE_DIR = savedEnv.cacheDir;
    if (savedEnv.zai === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = savedEnv.zai;
    rmSync(emptyCacheDir, { recursive: true, force: true });
    (await import('../config.js'))._resetKeyCacheForTests();
  });
  it('kimi·qwen·glm 의 안내 속 모델은 openrouter 사다리에 선 모델이다', async () => {
    const shippingOpenRouter = new Set(MODEL_TIERS.map((t) => LLM_TIER_MAP_BY_PROVIDER.openrouter[t].model));
    for (const provider of ['kimi', 'qwen', 'glm']) {
      const outcome = await constructionOutcome(provider);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      const named = /llm\.model (openrouter\/\S+)`/.exec(outcome.message)?.[1];
      expect(named && shippingOpenRouter.has(named)).toBe(true);
    }
  });
});
