import type { LLMToolSpec } from '../src/llm/tool-spec.js';
// ── Tier flip primitive tests (Coding Pipeline P1 followup) ──
//
// Exercises splitDeferredToolSpecs + buildDeferredToolsPromptBlock.
// We pass an explicit catalog override so the test is independent of
// which native runtime entries currently carry shouldDefer flags.

import { describe, expect, test } from 'bun:test';

import {
  splitDeferredToolSpecs,
  buildDeferredToolsPromptBlock,
  applyDeferredTools,
} from '../src/session-runtime/tier-flip.js';

import type { NativeToolCatalogEntry } from '../src/native-tool-catalog.js';

function makeSpec(name: string): LLMToolSpec {
  return {
    name,
    description: `${name} description`,
    parameters: {
      type: 'object',
      properties: { q: { type: 'string', description: 'arg' } },
      required: ['q'],
    },
  };
}

function makeCatalogEntry(opts: {
  id: string;
  displayName?: string;
  aliases?: string[];
  alwaysLoad?: boolean;
  shouldDefer?: boolean;
  promptSummary?: string;
  intentScope?: NativeToolCatalogEntry['intentScope'];
}): NativeToolCatalogEntry {
  return {
    id: opts.id,
    aliases: opts.aliases ?? [],
    displayName: opts.displayName ?? opts.id,
    description: `${opts.id} description`,
    promptSummary: opts.promptSummary ?? `\`${opts.id}\` summary`,
    surface: ['skill', 'dashboard'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    alwaysLoad: opts.alwaysLoad,
    shouldDefer: opts.shouldDefer,
    ...(opts.intentScope ? { intentScope: opts.intentScope } : {}),
  };
}

describe('splitDeferredToolSpecs', () => {
  test('empty input → empty output', () => {
    const result = splitDeferredToolSpecs([], []);
    expect(result.active).toEqual([]);
    expect(result.deferred).toEqual([]);
  });

  test('default (no opt-in) → all active, none deferred', () => {
    const catalog = [
      makeCatalogEntry({ id: 'A' }),
      makeCatalogEntry({ id: 'B' }),
    ];
    const specs = [makeSpec('A'), makeSpec('B')];
    const result = splitDeferredToolSpecs(specs, catalog);
    expect(result.active.map((s) => s.name)).toEqual(['A', 'B']);
    expect(result.deferred).toEqual([]);
  });

  test('alwaysLoad=false + shouldDefer=true → moves to deferred', () => {
    const catalog = [
      makeCatalogEntry({ id: 'Read' }),
      makeCatalogEntry({
        id: 'CftPdca',
        alwaysLoad: false,
        shouldDefer: true,
        promptSummary: '`CftPdca` (PDCA cycle runner)',
      }),
    ];
    const specs = [makeSpec('Read'), makeSpec('CftPdca')];
    const result = splitDeferredToolSpecs(specs, catalog);
    // 소환기 불변식(F2) — defer 가 생기면 ToolSearch 가 active 에 따라붙는다.
    expect(result.active.map((s) => s.name)).toEqual(['Read', 'ToolSearch']);
    expect(result.toolSearchInjected).toBe(true);
    expect(result.unhydratable).toEqual([]);
    expect(result.deferred).toEqual([
      { name: 'CftPdca', summary: '`CftPdca` (PDCA cycle runner)' },
    ]);
  });

  // ── P3 웜 intent-preload (RFC §4) ──────────────────────────────────
  // deferred 툴이라도 turn intent 가 그 스코프를 활성화했으면 active 로
  // 선주입(un-defer)해 ToolSearch 왕복을 없앤다.
  test('P3 — 웜-preload 스코프 매칭 시 deferred 툴이 active 로 승격', () => {
    const catalog = [
      makeCatalogEntry({ id: 'Read' }),
      makeCatalogEntry({
        id: 'Screenshot', alwaysLoad: false, shouldDefer: true, intentScope: 'capture',
      }),
    ];
    const specs = [makeSpec('Read'), makeSpec('Screenshot')];
    const result = splitDeferredToolSpecs(specs, catalog, new Set(['capture']));
    expect(result.active.map((s) => s.name)).toEqual(['Read', 'Screenshot']);
    expect(result.deferred).toEqual([]);
    expect(result.warmPreloaded).toEqual(['Screenshot']);
  });

  test('P3 — 스코프 미매칭이면 deferred 유지(P4 콜드 폴백)', () => {
    const catalog = [
      makeCatalogEntry({
        id: 'Screenshot', alwaysLoad: false, shouldDefer: true, intentScope: 'capture',
      }),
    ];
    const specs = [makeSpec('Screenshot')];
    // browse 스코프만 활성 → capture 툴은 deferred 유지
    const result = splitDeferredToolSpecs(specs, catalog, new Set(['browse']));
    // active 는 소환기 하나뿐 — 스코프 미매칭 툴은 deferred 유지(P4 콜드 폴백).
    expect(result.active.map((s) => s.name)).toEqual(['ToolSearch']);
    expect(result.deferred.map((d) => d.name)).toEqual(['Screenshot']);
    expect(result.warmPreloaded).toEqual([]);
  });

  test('P3 — 웜-preload 스코프 없으면 기존 동작(전부 deferred)', () => {
    const catalog = [
      makeCatalogEntry({
        id: 'Screenshot', alwaysLoad: false, shouldDefer: true, intentScope: 'capture',
      }),
    ];
    const result = splitDeferredToolSpecs([makeSpec('Screenshot')], catalog);
    expect(result.deferred.map((d) => d.name)).toEqual(['Screenshot']);
    expect(result.warmPreloaded).toEqual([]);
  });

  test('shouldDefer=true alone (no alwaysLoad=false) stays active', () => {
    // Both flags must be set explicitly — backwards-compatible default.
    const catalog = [makeCatalogEntry({ id: 'X', shouldDefer: true })];
    const result = splitDeferredToolSpecs([makeSpec('X')], catalog);
    expect(result.active.map((s) => s.name)).toEqual(['X']);
    expect(result.deferred).toEqual([]);
  });

  test('alwaysLoad=false alone (no shouldDefer) stays active', () => {
    const catalog = [makeCatalogEntry({ id: 'X', alwaysLoad: false })];
    const result = splitDeferredToolSpecs([makeSpec('X')], catalog);
    expect(result.active.map((s) => s.name)).toEqual(['X']);
    expect(result.deferred).toEqual([]);
  });

  test('spec name not in catalog stays active (never withhold unknown)', () => {
    const result = splitDeferredToolSpecs([makeSpec('Mystery')], []);
    expect(result.active.map((s) => s.name)).toEqual(['Mystery']);
    expect(result.deferred).toEqual([]);
  });

  test('alias resolves to deferred entry', () => {
    const catalog = [
      makeCatalogEntry({
        id: 'cft_pdca',
        displayName: 'CftPdca',
        aliases: ['pdca'],
        alwaysLoad: false,
        shouldDefer: true,
      }),
    ];
    const result = splitDeferredToolSpecs([makeSpec('pdca')], catalog);
    expect(result.active.map((s) => s.name)).toEqual(['ToolSearch']);
    expect(result.deferred.map((d) => d.name)).toEqual(['CftPdca']);
  });

  test('duplicate deferred entries deduped by displayName', () => {
    const catalog = [
      makeCatalogEntry({
        id: 'cft_pdca',
        displayName: 'CftPdca',
        aliases: ['pdca'],
        alwaysLoad: false,
        shouldDefer: true,
      }),
    ];
    const result = splitDeferredToolSpecs(
      [makeSpec('CftPdca'), makeSpec('pdca')],
      catalog,
    );
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0]!.name).toBe('CftPdca');
  });

  test('case-insensitive name match', () => {
    const catalog = [
      makeCatalogEntry({
        id: 'CftPdca',
        alwaysLoad: false,
        shouldDefer: true,
      }),
    ];
    const result = splitDeferredToolSpecs([makeSpec('cftpdca')], catalog);
    expect(result.deferred.map((d) => d.name)).toEqual(['CftPdca']);
  });
});

// ── ⭐ 소환기 불변식 (F2 · RFC-observability-driven-tool-selection · 2026-07-26) ──
// "배틀쉽을 defer 하면 소환기도 쥐여준다." 종전엔 소환기 부재를 `unhydratable` 로
// 감지만 해서, 안내 블록이 **부를 수 없는 툴 이름**을 광고했고 모델은 셸아웃으로
// 폴백했다(격리 acpx 실전검증에서 SelfImplement→`elanous self implement` 셸아웃).
describe('splitDeferredToolSpecs · 소환기 불변식', () => {
  const deferredCatalog = [
    makeCatalogEntry({ id: 'Battleship', alwaysLoad: false, shouldDefer: true }),
  ];

  test('defer 가 생기면 ToolSearch 를 active 에 주입한다', () => {
    const result = splitDeferredToolSpecs([makeSpec('Battleship')], deferredCatalog);
    const toolSearch = result.active.find((s) => s.name === 'ToolSearch');
    expect(toolSearch).toBeDefined();
    // 스키마까지 실려야 프로바이더가 호출 가능(이름만으론 못 부른다).
    expect(toolSearch?.parameters).toBeDefined();
    expect(result.toolSearchInjected).toBe(true);
  });

  test('deferred 가 없으면 주입하지 않는다(불필요한 툴 노출 금지)', () => {
    const result = splitDeferredToolSpecs(
      [makeSpec('Read')],
      [makeCatalogEntry({ id: 'Read' })],
    );
    expect(result.active.map((s) => s.name)).toEqual(['Read']);
    expect(result.toolSearchInjected).toBe(false);
  });

  test('호출부가 이미 ToolSearch 를 실었으면 중복 주입하지 않는다', () => {
    const result = splitDeferredToolSpecs(
      [makeSpec('Battleship'), makeSpec('ToolSearch')],
      deferredCatalog,
    );
    expect(result.active.filter((s) => s.name === 'ToolSearch')).toHaveLength(1);
    expect(result.toolSearchInjected).toBe(false);
  });

  test('unhydratable 은 이제 항상 비어야 한다(회귀 센티널)', () => {
    const result = splitDeferredToolSpecs([makeSpec('Battleship')], deferredCatalog);
    expect(result.unhydratable).toEqual([]);
  });

  test('warm-preload 로 전부 승격되면 defer 가 없으니 주입도 없다', () => {
    const catalog = [
      makeCatalogEntry({
        id: 'Screenshot', alwaysLoad: false, shouldDefer: true, intentScope: 'capture',
      }),
    ];
    const result = splitDeferredToolSpecs([makeSpec('Screenshot')], catalog, new Set(['capture']));
    expect(result.active.map((s) => s.name)).toEqual(['Screenshot']);
    expect(result.toolSearchInjected).toBe(false);
  });

  test('applyDeferredTools 도 소환기를 실어 보낸다(엔드투엔드 seam)', () => {
    const { messages, tools, stats } = applyDeferredTools(
      [{ role: 'system', content: 'base' }, { role: 'user', content: 'hi' }],
      [makeSpec('Battleship')],
      { catalog: deferredCatalog },
    );
    expect(tools.map((s) => s.name)).toContain('ToolSearch');
    expect(stats.toolSearchInjected).toBe(true);
    expect(stats.unhydratableCount).toBe(0);
    // 안내 블록이 붙어야 모델이 이름을 안다.
    expect(JSON.stringify(messages)).toContain('Battleship');
  });
});

describe('buildDeferredToolsPromptBlock', () => {
  test('empty list → empty string', () => {
    expect(buildDeferredToolsPromptBlock([])).toBe('');
  });

  test('non-empty list renders header + bullets + ToolSearch hint', () => {
    const block = buildDeferredToolsPromptBlock([
      { name: 'Foo', summary: '`Foo` (foo summary)' },
      { name: 'Bar', summary: '`Bar` (bar summary)' },
    ]);
    expect(block).toContain('## Deferred tools');
    expect(block).toContain('- Foo — `Foo` (foo summary)');
    expect(block).toContain('- Bar — `Bar` (bar summary)');
    expect(block).toContain('ToolSearch');
    expect(block).toContain('select:<name>');
    expect(block).toMatch(/2 tools/);
  });

  test('single entry uses correct count', () => {
    const block = buildDeferredToolsPromptBlock([
      { name: 'Solo', summary: '`Solo` (alone)' },
    ]);
    expect(block).toMatch(/1 tools/);
    expect(block).toContain('- Solo — `Solo` (alone)');
  });
});
