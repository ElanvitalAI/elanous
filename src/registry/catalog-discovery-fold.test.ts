// 대표 2026-09-23 «카탈로그를 파생한다» — 발견 스냅숏이 카탈로그로 접히는 계약.
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldDiscoveredModels, getCatalog, reloadCatalog } from './loader.js';
import { inferProviderFromModel } from './normalize.js';
import type { DiscoverySnapshot } from './discovery/cache.js';
import type { ModelSpec, ProviderRegistration } from './types.js';
import { PROVIDER_CAPABILITIES_NONE } from './types.js';

const reg = (id: string, fold: boolean): ProviderRegistration => ({
  id, displayName: id, aliases: [], modelPrefixes: [], apiKeyEnv: '', endpointPattern: '',
  defaultStreaming: 'sse', toolCallingFormat: 'native-openai', capabilities: { ...PROVIDER_CAPABILITIES_NONE },
  builtIn: true, ...(fold ? { catalogFromDiscovery: true } : {}),
});
const meta = { source: 'auto-openrouter-api' as const, lastSeen: '2026-09-23T00:00:00Z', autoFilled: true, confidence: 'high' as const };
const snap = (models: DiscoverySnapshot['models']): DiscoverySnapshot => ({ version: 1, generatedAt: '2026-09-23T00:00:00Z', sources: [], models });
const orModel = (id: string, partial: Partial<ModelSpec> = {}) => ({ id, provider: 'openrouter', partial: { id, provider: 'openrouter', ...partial }, discoveryMeta: meta });

describe('foldDiscoveredModels', () => {
  const providers = new Map([['openrouter', reg('openrouter', true)], ['openai', reg('openai', false)]]);

  it('선언한 provider 만 접고 id 를 네임스페이스한다', () => {
    const out = foldDiscoveredModels(providers, new Map(), snap([
      orModel('moonshotai/kimi-k2.6', { displayName: 'Kimi K2.6', contextSize: 262144 }),
      { id: 'gpt-9', provider: 'openai', partial: { id: 'gpt-9' }, discoveryMeta: meta },
    ]));
    expect(out.map((m) => m.id)).toEqual(['openrouter/moonshotai/kimi-k2.6']);
    expect(out[0]).toMatchObject({ provider: 'openrouter', displayName: 'Kimi K2.6', contextSize: 262144, discoveryMeta: meta });
  });

  it('⛔ YAML 이 이긴다 — 같은 id 가 이미 있으면 접지 않는다', () => {
    const existing = new Map<string, ModelSpec>([['openrouter/z-ai/glm-5.2', { id: 'openrouter/z-ai/glm-5.2', provider: 'openrouter', displayName: 'hand' }]]);
    expect(foldDiscoveredModels(providers, existing, snap([orModel('z-ai/glm-5.2')]))).toEqual([]);
  });

  it('스냅숏이 없으면 빈 배열(=모른다) · 중복은 첫 것만 · 이미 접두면 두 번 붙이지 않는다', () => {
    expect(foldDiscoveredModels(providers, new Map(), null)).toEqual([]);
    const out = foldDiscoveredModels(providers, new Map(), snap([orModel('qwen/qwen3.8-flash', { displayName: 'A' }), orModel('qwen/qwen3.8-flash', { displayName: 'B' }), orModel('openrouter/x/y')]));
    expect(out.map((m) => [m.id, m.displayName])).toEqual([['openrouter/qwen/qwen3.8-flash', 'A'], ['openrouter/x/y', 'openrouter/x/y']]);
  });
});

describe('로더 통합 — 실제 builtin 카탈로그 위에서', () => {
  const saved = process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
  afterEach(() => {
    if (saved === undefined) delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT; else process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = saved;
    reloadCatalog();
  });

  it('⛔ 시험 런타임은 경로를 «명시»하지 않으면 접지 않는다(기계마다 다른 카탈로그 방지)', () => {
    delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
    const cat = reloadCatalog();
    // 2026-10-11 CATALOG-DEEPSEEK-FLASH: 손 YAML(`catalog/models/openrouter/`)은 폴드가 아니다 — 접힌 레코드만 0 이어야 한다.
    const orModels = [...cat.models.values()].filter((m) => m.provider === 'openrouter');
    expect(orModels.filter((m) => m.discoveryMeta?.source !== 'manual')).toEqual([]);
    expect(orModels.map((m) => m.id).sort()).toEqual([
      'openrouter/deepseek/deepseek-v4-pro-0813',
      'openrouter/deepseek/deepseek-v4.1-flash',
      'openrouter/z-ai/glm-5.3-flash',
    ]);
    expect(cat.providers.get('openrouter')?.catalogFromDiscovery).toBe(true);
  });

  it('openrouter provider 의 capabilities.effortControl 은 false 다 — OpenRouter 경로는 추론 effort 를 wire 로 싣지 않는다(§9 실측)', () => {
    delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
    const cat = reloadCatalog();
    expect(cat.providers.get('openrouter')?.capabilities.effortControl).toBe(false);
  });

  it('경로를 주면 접히고, 접힌 id 는 openrouter 로 추론된다 — 기존 `anthropic/` 판정은 안 바뀐다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'or-fold-'));
    const path = join(dir, 'snap.json');
    writeFileSync(path, JSON.stringify(snap([orModel('anthropic/claude-x'), orModel('moonshotai/kimi-k2.6')])));
    process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = path;
    reloadCatalog();
    expect(getCatalog().models.get('openrouter/moonshotai/kimi-k2.6')?.provider).toBe('openrouter');
    expect(inferProviderFromModel('openrouter/anthropic/claude-x')).toBe('openrouter');
    expect(inferProviderFromModel('anthropic/claude-x')).toBe('anthropic');
  });
});

describe('defaultModelFor — 발견 파생 provider 는 «최신 출시»를 기본으로 내지 않는다', () => {
  it('폴드가 있어도 null · 대조군 anthropic 은 값이 있다', async () => {
    const { defaultModelFor } = await import('./resolver.js');
    const dir = mkdtempSync(join(tmpdir(), 'or-default-'));
    const path = join(dir, 'snap.json');
    writeFileSync(path, JSON.stringify(snap([orModel('vendor/newest', { releaseDate: '2099-01-01' })])));
    const saved = process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
    process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = path;
    try {
      const cat = reloadCatalog();
      expect(cat.models.get('openrouter/vendor/newest')).toBeDefined();
      expect(defaultModelFor('openrouter', cat)).toBeNull();
      expect(defaultModelFor('anthropic', cat)).not.toBeNull();
    } finally {
      if (saved === undefined) delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT; else process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = saved;
      reloadCatalog();
    }
  });
});

// 2026-10-11 CATALOG-DEEPSEEK-FLASH — 손 레코드의 실측값(OpenRouter /endpoints · 실제로 도는 상류 엔드포인트)이
//   스냅숏이 있어도 폴드에 덮이지 않는다(YAML 이 이긴다). 값이 바뀌면 YAML 머리말의 출처를 다시 재고 여기를 고친다.
describe('openrouter 손 레코드 — 실측값이 폴드에 안 덮인다', () => {
  it('창·출력·단가·기본 effort', () => {
    const dir = mkdtempSync(join(tmpdir(), 'or-hand-'));
    const path = join(dir, 'snap.json');
    writeFileSync(path, JSON.stringify(snap([orModel('deepseek/deepseek-v4.1-flash', { contextSize: 1, outputMaxTokens: 1, displayName: 'folded' })])));
    const saved = process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
    process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = path;
    try {
      const cat = reloadCatalog();
      const pick = (id: string) => {
        const m = cat.models.get(id);
        return m && { contextSize: m.contextSize, outputMaxTokens: m.outputMaxTokens, pricing: m.pricing, reasoning: m.reasoning, source: m.discoveryMeta?.source };
      };
      expect(pick('openrouter/deepseek/deepseek-v4-pro-0813')).toEqual({ contextSize: 1024000, outputMaxTokens: 384000, pricing: { inputPerMTok: 1.32, outputPerMTok: 3.96, cachedInputPerMTok: 0.044 }, reasoning: 'high', source: 'manual' });
      expect(pick('openrouter/deepseek/deepseek-v4.1-flash')).toEqual({ contextSize: 1048576, outputMaxTokens: 131072, pricing: { inputPerMTok: 0.2, outputPerMTok: 0.6, cachedInputPerMTok: 0.006 }, reasoning: 'medium', source: 'manual' });
      expect(pick('openrouter/z-ai/glm-5.3-flash')).toEqual({ contextSize: 1048576, outputMaxTokens: 131072, pricing: { inputPerMTok: 0.15, outputPerMTok: 0.5, cachedInputPerMTok: 0.03 }, reasoning: 'medium', source: 'manual' });
      // ⛔ OP 결정 — 0423 Preview 와 그 별칭은 손 레코드가 없다.
      expect(cat.models.get('openrouter/deepseek/deepseek-v4-pro')).toBeUndefined();
      expect(cat.models.get('openrouter/~deepseek/deepseek-pro-latest')).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT; else process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = saved;
      reloadCatalog();
    }
  });
});
