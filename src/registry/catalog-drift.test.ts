import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'bun:test';
import { reloadCatalog } from './loader.js';
import { activeCatalogModelIds, auditDerivedPins, auditFamilyAliasFreshness, catalogModelFacts, findPinDrift, type PinRef } from './catalog-derive.js';
import { LLM_TIER_MAP_BY_PROVIDER, TIER_PROVIDERS } from '../model-tier/llm-tier-map.js';
import { MODEL_TIERS } from '../model-tier/types.js';
import { listModelAliases, resolveModelAlias } from '../intelligence-map/model-alias.js';
import { resolveRoleLlm } from '../user-config.js';
import { auditRoutingDrift, summarizeRoutingDrift } from './llm-routing-drift.js';
import { resolveImplementationChildModel } from '../self-dev/dev-cli.js';

describe('catalog drift — 파생 핀이 catalog SSoT 와 정합(2026-07-15)', () => {
  it('catalog active id + familyShortcut 로드(grok-4.5 SSoT 반영)', () => {
    reloadCatalog();
    const ids = activeCatalogModelIds();
    expect(ids.has('grok-4.5')).toBe(true);   // SSoT 갱신 반영
    expect(ids.has('grok')).toBe(true);         // familyShortcut → grok-4.5
    expect(ids.has('grok-3-mini')).toBe(false); // stale 미등재
  });

  it('GROK tier-map 이 catalog 와 정합 — grok-3 stale 재발 방지', () => {
    reloadCatalog();
    const pins: PinRef[] = Object.entries(LLM_TIER_MAP_BY_PROVIDER.grok)
      .map(([tier, spec]) => ({ source: 'llm-tier-map:grok', key: tier, model: spec.model }));
    expect(findPinDrift(pins)).toEqual([]);
  });

  // ⭐⭐ 2026-09-23 — 종전엔 `expected = ['gpt-5.6-luna','gpt-5.6-sol','gpt-5.6-terra']` 를 «박았다».
  //   대표 지시로 사다리가 GPT-6 으로 «의도대로» 옮기자 빨개졌고, ***이름이 틀린 게 아니라
  //   자가 «그날의 값»을 물고 있었다.*** ⊕ 레코드 모양도 `lastSeen:'2026-08-19'`·`confidence:'low'` 를
  //   박고 있었는데, ***공식 문서로 그라운딩한 새 모델에 「low」를 강요하는 것은 거짓말을 시키는 것***이다.
  //   ⇒ 이 자가 «지키려던 것»만 남긴다:
  //     ⑴ 사다리가 가리키는 모델은 catalog 에 ***있다***(drift 0)
  //     ⑵ 그 레코드는 ***sparse 여도 된다***(가격·컨텍스트가 없어도 통과) — 요구가 아니라 «허용»
  //     ⑶ review 역할은 그 사다리의 «제 칸»을 받는다 (모델 이름을 박지 않는다)
  it('CODEX tier 모델이 catalog 에 «있다» — sparse 레코드도 허용한다', () => {
    const catalog = reloadCatalog();
    const map = LLM_TIER_MAP_BY_PROVIDER['openai-codex'];
    const pins: PinRef[] = Object.entries(map)
      .map(([tier, spec]) => ({ source: 'llm-tier-map:openai-codex', key: tier, model: spec.model }));
    const ids = [...new Set(pins.map((pin) => pin.model))].sort();

    // ⛔ 자가 «무는지» — 사다리가 비었거나 한 값으로 접히면 아래 판정이 공허해진다.
    expect(ids.length).toBeGreaterThan(1);
    expect(findPinDrift(pins)).toEqual([]);

    for (const id of ids) {
      const model = catalog.models.get(id);
      expect(model).toBeDefined();
      expect(model).toMatchObject({ id, provider: 'openai' });
      // ⑵ sparse «허용» — 있어도 되고 없어도 된다. 「없어야 한다」로 읽지 않는다.
      expect(['string', 'undefined']).toContain(typeof model?.family);
    }

    // ⑶ review 역할은 사다리에서 «파생»된 값을 받는다 (대표 2026-09-23: loaded → best).
    const resolved = resolveRoleLlm('review', { config: { llm: { provider: 'openai-codex' } } as never });
    expect(resolved).toMatchObject({ provider: 'openai-codex', tier: 'best' });
    expect(resolved.model).toBe(map.best.model);
  });

  // ⭐⭐⭐ 2026-09-23 신설 — ***자가 「두 provider」만 보고 있었다.***
  //
  // 🩸 위의 GROK·CODEX 두 칸은 사다리 9 provider 중 «둘»이다. 나머지 일곱은 ***아무도 안 봤다.***
  //   전수로 재니 ***네 provider 가 카탈로그에 «통째로» 없었다*** — 모델 레코드도,
  //   provider 기술자(`catalog/providers/*.yaml`)도, 접두 패턴(`_patterns.yaml`)도 없다.
  //
  // ⛔⭐ ***「0 이어야 한다」로 쓰지 않는다.*** 지금 비어 있으므로 그 자는 즉시 빨강이고,
  //   초록으로 만들려면 「네 provider 를 그라운딩한다」는 별개의 큰 판이 선행한다.
  //   ⇒ ***목록을 «박는다».*** 수가 아니라 목록인 이유:
  //     ⑴ 새 모델이 «그라운딩 없이» 사다리에 들어오면 빨강 — 이게 본래 목적이다
  //     ⑵ 구멍이 «닫히면»도 빨강 — 그때 「무엇을 닫았나」를 적게 만든다(의도된 마찰)
  //   ⚠️ 이 자는 「개선을 벌하는」 모양처럼 보이지만, 벌하는 것이 아니라 ***기록을 강제***한다.
  //     (같은 판의 `unknown` 승인 목록과 같은 규율이다.)
  it('사다리 «전» provider 가 카탈로그에 닿는지 — 못 닿는 곳을 이름으로 적는다', () => {
    const catalog = reloadCatalog();
    const gaps: Record<string, string[]> = {};
    for (const provider of TIER_PROVIDERS) {
      const map = LLM_TIER_MAP_BY_PROVIDER[provider];
      const ids = [...new Set(MODEL_TIERS.map((tier) => map[tier].model))].sort();
      const missing = ids.filter((id) => !catalog.models.get(id) && !catalogModelFacts(id));
      if (missing.length > 0) gaps[provider] = missing;
    }

    // ⛔ 자가 «무는지» — 사다리가 비면 gaps 도 비고 이 시험은 아무 말도 안 한다.
    expect(TIER_PROVIDERS.length).toBeGreaterThan(5);

    // ⭐ openrouter 는 «구멍이 아니라 설계»다 — 카탈로그를 발견 스냅숏 «폴드»가 채우고(`loader.ts`
    //   foldDiscoveredModels), 시험 런타임은 경로를 명시하지 않으면 스냅숏을 안 읽는다. 그래서 여기선
    //   사다리 «전부»가 빈다. ⛔ 오늘의 모델명을 박지 않고 «사다리 전부»로 파생한다. 닿는지는 아래 시험이 누른다.
    const { openrouter: derivedOnly, ...hand } = gaps;
    expect(derivedOnly).toEqual([...new Set(MODEL_TIERS.map((tier) => LLM_TIER_MAP_BY_PROVIDER.openrouter[tier].model))].sort());

    // 📏 2026-09-23 실측. ⚠️ 닫으면 이 목록을 줄이고 «무엇을 그라운딩했는지» 적어라.
    expect(hand).toEqual({
      // `local:` 접두는 `catalog/models/local/_patterns.yaml` 이 있는데도 `catalogModelFacts` 가
      // 못 푼다 — 로컬 모델은 런타임(LM Studio) 발견이라 정적 레코드를 «일부러» 안 둔 설계로 보인다.
      // 🔲 그 읽기가 맞는지 ***안 쟀다***. 맞다면 이 줄은 「가짜 구멍」이고, 자에서 빼는 게 옳다.
      local: ['local:qwen3.8-27b-mlx'],
      // ⛔ 아래 셋은 ***provider 기술자조차 없다***(`catalog/providers/` 에 5개뿐: anthropic·gemini·
      //   grok·local·openai). 사다리는 이들을 가리키는데 카탈로그는 이들을 «모른다».
      //   ⇒ 「그라운딩된 사실」이 하나도 없으므로 가격·컨텍스트·effort 상한을 «아무도 모른다».
      // 📏 2026-09-25: 사다리를 최신 세대 이름으로 옮겼다(OpenRouter 목록 실측) — 기술자가 없는 사실은 그대로다.
      kimi: ['kimi-k3'],
      qwen: ['qwen3.8-27b', 'qwen3.8-flash', 'qwen3.8-max'],
      glm: ['glm-5.3', 'glm-5.3-flash'],
      // 📏 2026-10-11 (BEDROCK-PROVIDER #25966): Bedrock 와이어 id(`anthropic.` 접두)는 카탈로그 레코드가 없다 —
      //   가격·창은 1st-party `claude-*-5-5` 레코드와 «같은 모델»이지만 Bedrock 단가는 파트너 책정이라 비용 표는 범위 밖.
      //   사다리 status 는 `wip`(실호출 전). 레코드를 더하면 이 줄을 지운다.
      bedrock: ['anthropic.claude-haiku-5-5', 'anthropic.claude-opus-5-5', 'anthropic.claude-sonnet-5-5'],
    });

    // ⭐ 그리고 ***닿는 쪽은 「전부」 닿아야 한다*** — 이 줄이 본래 목적(회귀 방어)이다.
    for (const provider of ['anthropic', 'openai', 'openai-codex', 'gemini', 'grok'] as const) {
      expect(gaps[provider]).toBeUndefined();
    }
  });

  it('openrouter 사다리는 발견 스냅숏이 있으면 «전부» 카탈로그에 닿는다 — 폴드 id 규약과 사다리가 맞물린다', () => {
    const ladder = [...new Set(MODEL_TIERS.map((tier) => LLM_TIER_MAP_BY_PROVIDER.openrouter[tier].model))];
    const dir = mkdtempSync(join(tmpdir(), 'drift-or-'));
    const path = join(dir, 'snap.json');
    const meta = { source: 'auto-openrouter-api', lastSeen: '2026-09-23T00:00:00Z', autoFilled: true, confidence: 'high' };
    // 발견 소스가 내는 «원 id»(접두 없음)로 적는다 — 접두는 폴드가 붙인다.
    const models = ladder.map((id) => { const raw = id.replace(/^openrouter\//, ''); return { id: raw, provider: 'openrouter', partial: { id: raw, provider: 'openrouter' }, discoveryMeta: meta }; });
    writeFileSync(path, JSON.stringify({ version: 1, generatedAt: '2026-09-23T00:00:00Z', sources: [], models }));
    const saved = process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
    process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = path;
    try {
      const catalog = reloadCatalog();
      expect(ladder.filter((id) => !catalog.models.get(id))).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT; else process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = saved;
      reloadCatalog();
    }
  });

  it('선택 alias 가 catalog 와 정합하고 낡은 세대를 최신 ID로 해석', () => {
    const catalog = reloadCatalog();
    const a = listModelAliases();
    const pins: PinRef[] = (['grok', 'grok-fast', 'opus', 'sonnet', 'haiku', 'haiku-3-5', 'flash'] as const)
      .filter((k) => a[k])
      .map((k) => ({ source: 'alias', key: k, model: a[k]! }));
    expect(resolveModelAlias('haiku-3-5')).toBe('claude-haiku-4-5');
    expect(resolveModelAlias('flash')).toBe('gemini-3.8-flash');
    expect(catalog.models.get('gemini-3.7-flash')).toMatchObject({
      id: 'gemini-3.7-flash',
      provider: 'gemini',
      family: 'gemini-3',
      discoveryMeta: {
        source: 'manual',
        lastSeen: '2026-08-19',
        autoFilled: false,
        confidence: 'low',
      },
    });
    expect(catalogModelFacts('gemini-3.7-flash')?.contextSize).toBeUndefined();
    expect(catalogModelFacts('gemini-3.7-flash')?.pricing).toBeUndefined();
    expect(findPinDrift(pins)).toEqual([]);
  });

  it('실행 역할 tier alias 는 기존 대상을 유지', () => {
    expect(resolveModelAlias('haiku')).toBe('claude-haiku-4-5');
    expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-5');
    expect(resolveModelAlias('opus')).toBe('claude-opus-5-5');   // 대표 2026-09-25 「모델별 최신으로」
  });

  it('catalogModelFacts — 라우터가 pricing/context 를 SSoT 서 읽음', () => {
    reloadCatalog();
    const f = catalogModelFacts('grok-4.5');
    expect(f?.pricing?.outputPerMTok).toBe(6.0);
    // ⛔ 2026-08-18 정정: grok-4.5 는 500k 다(omni-crawl grok-web ⊕ docs.x.ai 대조).
    //    2_000_000 은 4.5 이전 세대 값이 남아 있던 것.
    expect(f?.contextSize).toBe(500_000);
    expect(catalogModelFacts('grok-3-mini')).toBeNull(); // 미등재
  });

  it('gpt-6 sol·luna·astra 는 창·출력 상한을 SSoT 에 싣는다 (MODEL-ROUTING-MATRIX 10-10)', () => {
    // 📏 출처: OpenAI 모델 문서(09-23) ⊕ OpenRouter /api/v1/models 실호출(10-10) — luna 의 출력 상한만 OpenRouter 하나다.
    //   비어 있으면 resolver 의 minContextSize 판정이 `contextSize ?? 0` 으로 읽어 이 모델을 떨군다.
    const catalog = reloadCatalog();
    for (const id of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra']) {
      expect(catalogModelFacts(id)?.contextSize).toBe(1_050_000);
      expect(catalog.models.get(id)?.outputMaxTokens).toBe(128_000);
    }
  });

  it('claude 5.5 세대 ⊕ sonnet-5 정정 ⊕ opus-5-5 출력 — 창 1M · 출력 128K (Anthropic 공식 10-10)', () => {
    const catalog = reloadCatalog();
    for (const id of ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-5-5']) {
      expect(catalogModelFacts(id)?.contextSize).toBe(1_000_000);
      expect(catalog.models.get(id)?.outputMaxTokens).toBe(128_000);
    }
    expect(catalogModelFacts('claude-sonnet-5-5')?.pricing).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(catalogModelFacts('claude-haiku-5-5')?.pricing).toMatchObject({ inputPerMTok: 0.1, outputPerMTok: 0.5 });
    // 맨몸 별칭은 옮기지 않았다 — 옮기는 것은 라우팅 변경이라 별개 결정이다.
    expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-5');
    expect(resolveModelAlias('haiku')).toBe('claude-haiku-4-5');
  });

  it('--child-llm-model 이 claude 5.5 세대를 해석한다 (점·하이픈 둘 다) · 없는 판은 여전히 거부', () => {
    // 🩸 UX 10-10 17:36 실측: `--child-llm-model claude-haiku-5.5` → «알 수 없음 · 후보: … claude-haiku-4-5 · claude-sonnet-5».
    expect(resolveImplementationChildModel('anthropic', 'claude-haiku-5.5').resolvedId).toBe('claude-haiku-5-5');
    expect(resolveImplementationChildModel('anthropic', 'claude-haiku-5-5').resolvedId).toBe('claude-haiku-5-5');
    expect(resolveImplementationChildModel('anthropic', 'claude-sonnet-5.5').resolvedId).toBe('claude-sonnet-5-5');
    expect(resolveImplementationChildModel('anthropic', 'claude-sonnet-5-5').resolvedId).toBe('claude-sonnet-5-5');
    // 대조군 — 해석기가 «무엇이든 통과»시키지 않는지.
    expect(() => resolveImplementationChildModel('anthropic', 'claude-haiku-9-9')).toThrow('--child-llm-model 알 수 없음');
  });

  it('family alias 최신성은 기존 pin 감사 결과에 비차단 값으로 연결되고 실제 별칭을 엄격히 판정한다', () => {
    const aliases = listModelAliases();
    const pins = Object.entries(aliases).map(([key, model]) => ({ source: 'alias', key, model }));
    const before = findPinDrift(pins);
    const audited = auditDerivedPins(pins);
    const freshness = audited.map((pin) => pin.familyAliasFreshness).filter((result): result is NonNullable<typeof result> => Boolean(result));
    const unversioned = freshness.filter((result) => result.status !== 'excluded-versioned');
    const stale = freshness.filter((result) => result.status === 'stale');
    const unknown = freshness.filter((result) => result.status.startsWith('unknown-'));

    expect(audited.map((pin) => pin.status)).toEqual(auditDerivedPins(pins).map((pin) => pin.status));
    expect(freshness).toHaveLength(Object.keys(aliases).length);
    expect(unversioned).not.toHaveLength(0);
    // Catalog/alias data is intentionally out of scope: this narrow, named advisory is the current approved
    // migration target. Any new stale alias or changed target fails with its alias/current/recommended values.
    expect(stale).toEqual([
      // ✅ 2026-09-25: 유일한 항목이던 `opus`(claude-opus-4-8 → 최신)를 옮겼다(대표 「모델별 최신으로」) — 이제 낡은 별칭 0.
    ]);
    const routingAudit = auditRoutingDrift();
    expect(routingAudit.pinDrift).toEqual([]);
    expect(routingAudit.familyAliasFreshness.filter((result) => result.status === 'stale')).toEqual(stale);
    // Sparse catalog records and preview-only `pro` are explicitly approved by name; additions or status
    // changes fail rather than disappearing as an unexamined unknown.
    //
    // ⭐⭐ 2026-09-23 — ***일곱 → 넷.*** 셋(`terra`·`sol`·`luna`)을 «승인 목록에서 빼지 않고 «없앴다»».
    //   🩸 그 셋은 「승인된 unknown」으로 «두 달 가까이» 앉아 있었는데, 원인이 둘 다 고칠 수 있는
    //     것이었다 — ⑴ YAML 에 `releaseDate` 가 없었다 ⑵ 세대(`family: gpt-6`)만 있고
    //     «제품»(`familyShortcut`)이 없어 같은 날 나온 형제끼리 「최신」이 갈리지 않았다.
    //   ⇒ 코드 주석이 이미 처방을 적어 뒀다 — *"familyShortcut distinguishes products sharing a
    //     catalog generation family"*. ***읽고 쓰기만 하면 됐다.***
    //   ⊕ `grok` 도 같은 방식으로 닫았다(플래그십 라인에 `familyShortcut: grok`).
    //
    // 🔲 남은 넷이 «왜» 남았나 — 승인이 아니라 ***「아직 못 잰 것」***으로 읽어라:
    //   flash      gemini 가족에 출시일 없는 레코드가 있다 (gemini 축 — 안 쟀다)
    //   pro·gemini-pro  preview 전용이라 «후보가 없다» — 이것은 «사실»이고 고칠 대상이 아니다
    //   grok-fast  `family: grok-4` 에 출시일 없는 `grok-build-0.1`(다른 제품)이 섞여 있다.
    //              ⛔ 그 제품에 단축을 주면 4.20 과 4.20-non-reasoning 이 «같은 날»이라
    //                 ambiguous 로 «옮겨갈 뿐»이다 — 진짜 답은 `grok-build-0.1` 의 출시일이고
    //                 그것을 ***1차 출처로 안 쟀다***. 추측해 적지 않는다.
    expect(unknown).toEqual([
      // 📏 2026-09-25: flash → 3.8 · flash-lite 신설. 새 YAML 둘엔 출시일을 넣었지만 «가족 전원»(3.7·3.5·3·2.5·3.1-lite)이 날짜가 없어 여전히 「모름」이다.
      { alias: 'flash', currentModel: 'gemini-3.8-flash', status: 'unknown-missing-release-date' },
      { alias: 'flash-lite', currentModel: 'gemini-3.5-flash-lite', status: 'unknown-missing-release-date' },
      { alias: 'pro', currentModel: 'gemini-3.1-pro-preview', status: 'unknown-no-candidate' },
      { alias: 'gemini-pro', currentModel: 'gemini-3.1-pro-preview', status: 'unknown-no-candidate' },
      { alias: 'grok-fast', currentModel: 'grok-4.20-non-reasoning', status: 'unknown-missing-release-date' },
    ]);
    // ⛔ 이 자가 «개선을 벌하지» 않는지 — 목록이 «줄어드는» 것은 좋은 일이고, 줄면 위 줄이 빨개진다.
    //    그래서 「수」가 아니라 「목록」을 박는다: 줄었을 때 ***무엇이 닫혔는지 적게*** 만드는 것이 의도다.
    //    ⚠️ 늘어나는 것(새 모델이 날짜 없이 들어오는 것)도 같은 줄이 잡는다 — 그쪽이 본래 목적이다.
    expect(findPinDrift(pins)).toEqual(before);
  });

  it('실제 라우팅 감사 진입점은 기존 drift와 독립된 필드로 current·stale·unknown 별칭을 노출한다', () => {
    const deps = {
      aliases: { current: 'alpha-2', stale: 'alpha-1', unknown: 'beta-1', missing: 'missing-1' },
      tierMap: {} as never,
      missionDefaults: {},
      modelCatalog: [],
      activeIds: new Set(['alpha-1', 'alpha-2', 'beta-1']),
      catalogHas: () => false,
      familyAliasFreshness: [
        { alias: 'current', currentModel: 'alpha-2', recommendedModel: 'alpha-2', status: 'current' as const },
        { alias: 'stale', currentModel: 'alpha-1', recommendedModel: 'alpha-2', status: 'stale' as const },
        { alias: 'unknown', currentModel: 'beta-1', status: 'unknown-missing-release-date' as const },
      ],
    };
    const audit = auditRoutingDrift(deps);

    expect(audit).toEqual({
      pinDrift: [{ source: 'model-alias', key: 'missing', model: 'missing-1', status: 'missing' }],
      familyAliasFreshness: deps.familyAliasFreshness,
    });
    expect(summarizeRoutingDrift(deps)).toContain('family alias stale [stale] "alpha-1" → "alpha-2"');
  });

  it('family alias 최신성은 alias 키와 대상 모델이 모두 일치하는 핀에만 합성한다', () => {
    const aliases = listModelAliases();
    const alias = 'opus';
    const canonicalModel = aliases[alias]!;
    const mismatchedModel = canonicalModel === 'claude-opus-5' ? 'claude-opus-4-8' : 'claude-opus-5';
    const audited = auditDerivedPins([
      { source: 'alias', key: alias, model: canonicalModel },
      { source: 'other', key: alias, model: mismatchedModel },
    ]);

    expect(audited[0]!.familyAliasFreshness).toMatchObject({ alias, currentModel: canonicalModel });
    expect(audited[1]!.familyAliasFreshness).toBeUndefined();
  });

  it('family alias 최신성은 newest·stale·versioned·unknown 및 production 경계를 이름으로 분류한다', () => {
    const models = [
      { id: 'alpha-1', provider: 'p', family: 'alpha', displayName: 'Alpha 1', releaseDate: '2026-01-01' },
      { id: 'alpha-2', provider: 'p', family: 'alpha', displayName: 'Alpha 2', releaseDate: '2026-02-01' },
      { id: 'alpha-3-preview', provider: 'p', family: 'alpha', displayName: 'Alpha 3 Preview', releaseDate: '2026-03-01' },
      { id: 'alpha-4', provider: 'p', family: 'alpha', displayName: 'Alpha 4', releaseDate: '2026-04-01', deprecated: '2026-04-02' },
      { id: 'beta-1', provider: 'p', family: 'beta', displayName: 'Beta 1' },
      { id: 'beta-2', provider: 'p', family: 'beta', displayName: 'Beta 2', releaseDate: '2026-02-01' },
      { id: 'gamma-1', provider: 'p', family: 'gamma', displayName: 'Gamma 1', releaseDate: '2026-02-01' },
      { id: 'gamma-2', provider: 'p', family: 'gamma', displayName: 'Gamma 2', releaseDate: '2026-02-01' },
      { id: 'retired-1', provider: 'p', family: 'retired', displayName: 'Retired 1', releaseDate: '2026-01-01', deprecated: '2026-02-01' },
    ];
    const result = auditFamilyAliasFreshness({ alpha: 'alpha-1', alphaLatest: 'alpha-2', 'alpha-1': 'alpha-1', beta: 'beta-2', gamma: 'gamma-1', retired: 'retired-1', unknown: 'missing' }, models);

    expect(result).toEqual([
      { alias: 'alpha', currentModel: 'alpha-1', recommendedModel: 'alpha-2', status: 'stale' },
      { alias: 'alphaLatest', currentModel: 'alpha-2', recommendedModel: 'alpha-2', status: 'current' },
      { alias: 'alpha-1', currentModel: 'alpha-1', status: 'excluded-versioned' },
      { alias: 'beta', currentModel: 'beta-2', status: 'unknown-missing-release-date' },
      { alias: 'gamma', currentModel: 'gamma-1', status: 'unknown-ambiguous-latest' },
      { alias: 'retired', currentModel: 'retired-1', status: 'unknown-no-candidate' },
      { alias: 'unknown', currentModel: 'missing', status: 'unknown-missing-target' },
    ]);
  });

  it('drift 감지 동작 — 없는 모델은 missing 으로 잡힘', () => {
    reloadCatalog();
    const drift = findPinDrift([{ source: 't', model: 'grok-9-imaginary' }]);
    expect(drift).toEqual([{ source: 't', model: 'grok-9-imaginary', status: 'missing' }]);
  });
});
