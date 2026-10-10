// 결정 2026-09-23 — 하니스 자식 LLM 으로 openrouter 를 고를 수 있다(네 번째 «손 목록» 누락이었다).
//   ⭐ 오늘의 모델명을 박지 않고 openrouter 사다리에서 파생한다.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { __resetCatalogForTests } from '../src/registry/loader';
import { buildChildLlmSelection } from '../src/self-dev/dev-cli';
import { tierModel } from '../src/llm/model-defaults';
import { LLM_TIER_MAP_BY_PROVIDER } from '../src/model-tier/llm-tier-map';
import { MODEL_TIERS } from '../src/model-tier/types';
import { providerEnvKey } from '../src/llm/provider-credentials';

const none = () => undefined;

describe('--child-llm-provider openrouter', () => {
  test('provider 만 주면 사다리의 자식 기본 티어 모델로 채워진다', () => {
    const sel = buildChildLlmSelection({ childLlmProvider: 'openrouter' }, none);
    expect(sel?.provider).toBe('openrouter');
    const ladder = MODEL_TIERS.map((t) => LLM_TIER_MAP_BY_PROVIDER.openrouter[t].model);
    expect(ladder).toContain(sel!.model);
  });

  test('사다리의 모든 모델을 받는다', () => {
    for (const t of MODEL_TIERS) {
      const model = tierModel(t, 'openrouter' as never);
      expect(buildChildLlmSelection({ childLlmProvider: 'openrouter', childLlmModel: model }, none)?.model).toBe(model);
    }
  });

  test('⛔ 모르는 모델(카탈로그에도 사다리에도 없음)은 후보를 대며 거부한다 — 접두 없는 id 도 거부', () => {
    // #25820 이후 시험 우주(NODE_ENV=test ∧ 스냅숏 env 없음)는 `openrouter/<v>/<m>` 꼴을 통과시킨다.
    //   이 시험은 «운영 거부 경로»를 재야 하므로 스냅숏을 «명시»해(없는 파일 = 빈 스냅숏) 그 탈출구를 끈다.
    const prev = process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
    process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = join(tmpdir(), `child-llm-or-empty-snapshot-${process.pid}.json`);
    __resetCatalogForTests();
    try {
      expect(() => buildChildLlmSelection({ childLlmProvider: 'openrouter', childLlmModel: 'openrouter/nope/x' }, none)).toThrow(/후보: openrouter\//);
      expect(() => buildChildLlmSelection({ childLlmProvider: 'openrouter', childLlmModel: 'moonshotai/kimi-k3' }, none)).toThrow(/알 수 없음/);
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
      else process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = prev;
      __resetCatalogForTests();
    }
  });

  test('자식 키 릴레이 표가 openrouter 키 이름을 안다', () => {
    expect(providerEnvKey('openrouter')).toBe('OPENROUTER_API_KEY');
  });
});
