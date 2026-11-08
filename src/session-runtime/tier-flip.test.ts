import type { LLMToolSpec } from '../llm/tool-spec.js';
import { describe, expect, test } from 'bun:test';

import { splitDeferredToolSpecs } from './tier-flip.js';

import { isNativeToolModelExposed, nativeToolCatalog, type NativeToolCatalogEntry } from '../native-tool-catalog.js';

function spec(name: string): LLMToolSpec {
  return {
    name,
    description: `${name} description`,
    parameters: { type: 'object', properties: {}, required: [] },
  };
}

function catalogEntry(id: string, deferred = false): NativeToolCatalogEntry {
  return {
    id,
    kind: 'other',
    aliases: [],
    displayName: id,
    description: `${id} description`,
    promptSummary: `\`${id}\` summary`,
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    alwaysLoad: deferred ? false : undefined,
    shouldDefer: deferred || undefined,
  };
}

describe('splitDeferredToolSpecs unhydratable capabilities', () => {
  // ⭐ F2 (2026-07-26) — 이 케이스는 종전에 `unhydratable: ['DeferredA','DeferredB']`
  //   를 기대했다. 즉 "부를 수 없는 툴을 광고하는 상태"를 정상으로 못박고 있었고,
  //   그 상태가 실전에서 CLI 셸아웃 폴백을 낳았다. 이제 소환기를 주입해 해소한다.
  test('deferred tools without ToolSearch get one injected (summoner invariant)', () => {
    const result = splitDeferredToolSpecs(
      [spec('Read'), spec('DeferredA'), spec('DeferredB')],
      [catalogEntry('Read'), catalogEntry('DeferredA', true), catalogEntry('DeferredB', true)],
    );

    expect(result.toolSearchInjected).toBe(true);
    expect(result.active.map((s) => s.name)).toContain('ToolSearch');
    expect(result.unhydratable).toEqual([]);
  });

  test('deferred tools with ToolSearch active are hydratable', () => {
    const result = splitDeferredToolSpecs(
      [spec('ToolSearch'), spec('DeferredA')],
      [catalogEntry('ToolSearch'), catalogEntry('DeferredA', true)],
    );

    expect(result.unhydratable).toEqual([]);
  });

  test('no deferred tools are never unhydratable', () => {
    const result = splitDeferredToolSpecs([spec('Read')], [catalogEntry('Read')]);

    expect(result.unhydratable).toEqual([]);
  });

  test('SelfImplement 는 active 이고 기본 비활성 RunDevHarness 는 모델 표면과 deferred 이름 슬롯에 없다', () => {
    const selfImplement = nativeToolCatalog.find((entry) => entry.id === 'self_implement');
    const runDevHarness = nativeToolCatalog.find((entry) => entry.id === 'run_dev_harness');
    const modelEnabledSpecs = [spec('SelfImplement'), spec('RunDevHarness'), spec('SolveMission')]
      .filter((tool) => nativeToolCatalog.find((entry) => entry.aliases.includes(tool.name))?.defaultEnabled);
    const result = splitDeferredToolSpecs(modelEnabledSpecs, nativeToolCatalog);
    const activeNames = result.active.map((entry) => entry.name);
    const deferredNames = result.deferred.map((entry) => entry.name);
    const deferredHarness = result.deferred.find((entry) => entry.name === 'RunDevHarness');

    expect(selfImplement?.defaultEnabled).toBe(true);
    expect(runDevHarness).toMatchObject({ defaultEnabled: false, alwaysLoad: false, shouldDefer: true });
    // ⛔ toolSearchable 이 false 로 «되돌아오면» 노출이 다시 죽는다 — 그 조합을 못 박는다.
    expect(runDevHarness?.toolSearchable).not.toBe(false);
    expect(runDevHarness?.promptSummary).toContain('개발');
    for (const stage of ['planner', 'executor', 'reviewer', 'deployer']) {
      expect(runDevHarness?.promptSummary.toLowerCase()).toContain(stage);
    }
    // Coding-realizer unification 결정으로 하니스 실행 도구가 기본 비활성이어서 세 표면 모두에서 빠진다.
    expect(deferredHarness).toBeUndefined();
    expect(isNativeToolModelExposed(runDevHarness!)).toBe(false);
    expect(activeNames).toContain('SelfImplement');
    expect(activeNames).not.toContain('RunDevHarness');
    expect(deferredNames).not.toContain('RunDevHarness');
  });
});
