// ── ⭐ 소환로 e2e (F2 · RFC-observability-driven-tool-selection · 2026-07-26) ──
//
// 실전검증(격리 acpx 자연어)에서 elanous 에이전트는 SelfImplement 를 **부르지 못하고**
// PtyShell 로 `elanous self implement` CLI 를 셸아웃했다. 원인은 한 곳이 아니라 사슬 3곳:
//
//   ① tier-flip 이 defer 만 하고 ToolSearch 를 active 에 안 실었다 (감지만·주입 X)
//   ② 데몬 webterm dispatch 에 ToolSearch 라우팅이 아예 없었다
//   ③ ToolSearch 가 tool-runtime 레지스트리만 뒤져 — 데몬 툴은 등록된 적이 없어
//      배선해도 "no matches" 였다
//
// 이 파일은 **사슬 전체**를 한 번에 통과시키는 회귀망이다: webterm 스펙 → tier-flip
// 분할 → 주입된 ToolSearch → 데몬 dispatch → SelfImplement 스키마 하이드레이션.
// 한 고리라도 끊기면 여기서 잡힌다(부분 수리가 "unknown tool" 로 악화되는 것도 포함).

import { setDefaultTimeout, describe, test, expect } from 'bun:test';
import { toolSurface } from './index.js';
import { splitDeferredToolSpecs } from '../../session-runtime/tier-flip.js';
import type { DaemonToolDispatchCtx } from './types.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const ctx = (): DaemonToolDispatchCtx => ({
  cwd: process.cwd(),
  signal: new AbortController().signal,
});

/** dispatch 결과에서 렌더된 스키마 블록을 꺼낸다. */
function contentOf(result: unknown): string {
  const r = result as { content?: string };
  return typeof r?.content === 'string' ? r.content : '';
}

describe('소환로 · webterm 서피스', () => {
  test('webterm 이 ToolSearch 를 라우팅한다 (갭②)', async () => {
    const surface = toolSurface('webterm');
    const result = await surface.dispatch('ToolSearch', { query: 'select:SelfImplement' }, ctx());
    expect(contentOf(result)).toContain('<functions>');
  });

  test('레지스트리 미등록 배틀쉽도 서피스 풀로 하이드레이션된다 (갭③)', async () => {
    const surface = toolSurface('webterm');
    const result = await surface.dispatch('ToolSearch', { query: 'select:SelfImplement' }, ctx());
    const r = result as { matched?: string[]; content?: string };
    expect(r.matched).toContain('SelfImplement');
    // 이름만이 아니라 **호출 가능한 스키마**가 실려야 한다.
    expect(r.content).toContain('"feature"');
  });

  // RunDevHarness 부재는 코딩 실현체를 하나로 만드는 통합 결정의 결과다.
  test('여러 배틀쉽을 한 번에 소환할 수 있다', async () => {
    const surface = toolSurface('webterm');
    const result = await surface.dispatch(
      'ToolSearch',
      { query: 'select:SelfImplement,RunDevHarness,SolveMission' },
      ctx(),
    );
    const r = result as { matched?: string[]; unknown?: string[] };
    expect(r.matched).toEqual(['SelfImplement', 'SolveMission']);
    expect(r.unknown).toEqual(['RunDevHarness']);
  });

  test('빈 query 는 에러로 반환한다(throw 아님 — 모델이 재시도 가능)', async () => {
    const surface = toolSurface('webterm');
    const result = await surface.dispatch('ToolSearch', { query: '   ' }, ctx());
    expect((result as { error?: string }).error).toContain('query');
  });

  test('chat 서피스도 소환기를 라우팅한다(unknown tool 로 죽지 않음)', async () => {
    const surface = toolSurface('chat');
    const result = await surface.dispatch('ToolSearch', { query: 'select:Read' }, ctx());
    expect(contentOf(result)).toContain('<functions>');
  });
});

// ── 안전 불변식: 노출된 스키마는 이 서피스에서 dispatch 가능해야 한다 ──
// 서피스 spec 풀은 **권위적 allowlist** 다. 전역 tool-runtime 레지스트리로
// fallback 하면 (a) 이 서피스가 `unknown tool` 로 답할 스키마를 모델에 쥐여주고
// (b) nest-cap 이 카탈로그에서 뺀 자식-spawn 툴이 ToolSearch 로 되살아난다
// — cap 은 서피스 카탈로그를 자르지 레지스트리를 자르지 않기 때문.
describe('소환로 · 서피스 풀 = 권위적 allowlist', () => {
  test('풀 밖 툴은 소환되지 않는다(레지스트리 fallback 누수 차단)', async () => {
    const surface = toolSurface('webterm');
    const exposed = new Set(surface.specs.map((s) => s.name));
    // webterm 이 노출하지 않는 대시보드 전용 툴 — 레지스트리에 있든 없든 불가.
    const result = await surface.dispatch(
      'ToolSearch',
      { query: 'select:MoveSurface,ResizeSurface,LayoutSave' },
      ctx(),
    );
    const r = result as { matched?: string[]; unknown?: string[] };
    for (const name of r.matched ?? []) expect(exposed.has(name)).toBe(true);
    expect(r.unknown).toEqual(['MoveSurface', 'ResizeSurface', 'LayoutSave']);
  });

  test('소환 결과는 언제나 서피스 노출 집합의 부분집합이다', async () => {
    const surface = toolSurface('webterm');
    const exposed = new Set(surface.specs.map((s) => s.name));
    // 넓은 키워드로 최대한 긁어도 풀 밖으로 새지 않아야 한다.
    const result = await surface.dispatch('ToolSearch', { query: 'tool', max_results: 25 }, ctx());
    for (const name of (result as { matched?: string[] }).matched ?? []) {
      expect(exposed.has(name)).toBe(true);
    }
  });

  test('nest-cap 으로 제외된 자식-spawn 툴은 소환도 불가 (카탈로그=소환원 단일출처)', async () => {
    // cap 은 부팅 env 로 고정되므로 서브프로세스에서 재현한다.
    const probe = `
      import { toolSurface } from ${JSON.stringify(`${import.meta.dir}/index.ts`)};
      const surface = toolSurface('webterm');
      const exposed = surface.specs.map((s) => s.name);
      const res = await surface.dispatch(
        'ToolSearch',
        { query: 'select:SelfImplement,RunDevHarness,SolveMission' },
        { cwd: process.cwd(), signal: new AbortController().signal },
      );
      console.log(JSON.stringify({ exposed, matched: res.matched, unknown: res.unknown }));
    `;
    const proc = Bun.spawnSync({
      cmd: ['bun', '-e', probe],
      // depth 99 는 config(substrate.maxNestDepth)/env 어느 상한이든 초과.
      env: { ...process.env, ELANOUS_NEST_DEPTH: '99' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = proc.stdout.toString().trim().split('\n').pop() ?? '';
    const parsed = JSON.parse(out) as { exposed: string[]; matched: string[]; unknown: string[] };
    // cap 도달 → 카탈로그에서 빠졌고,
    expect(parsed.exposed).not.toContain('SelfImplement');
    // → 소환도 불가해야 한다(레지스트리 우회 금지).
    expect(parsed.matched).toEqual([]);
    expect(parsed.unknown).toEqual(['SelfImplement', 'RunDevHarness', 'SolveMission']);
  });
});

describe('소환로 · 사슬 e2e (tier-flip → dispatch)', () => {
  // ⭐ 2026-08-11 73차 — RunDevHarness 를 `SelfOrchestrate` 모양(defaultEnabled ⊕ shouldDefer)으로
  //   모델 표면에 되돌렸다. ⇒ webterm 에서도 «이름 슬롯»으로 서고 스키마는 ToolSearch 가 수화한다.
  //   ⛔ 종전엔 카탈로그에서 «내려져» 있어(#7476) 이 서피스에서 그냥 active 였다 — 그 상태를 못 박고 있었다.
  //   📄 왜 되돌렸나 = FINDING-dev-harness-is-not-dead-it-is-switched-off-2026-08-11.
  test('webterm 스펙을 tier-flip 에 태우면 SelfImplement 는 active 이고 하니스·SolveMission 은 defer 된다', () => {
    const surface = toolSurface('webterm');
    const split = splitDeferredToolSpecs(surface.specs);
    const activeNames = split.active.map((s) => s.name);
    const deferredNames = split.deferred.map((d) => d.name);
    expect(activeNames).toContain('SelfImplement');
    expect(activeNames).not.toContain('RunDevHarness');
    expect(deferredNames).not.toContain('SelfImplement');
    expect(deferredNames).not.toContain('RunDevHarness');
    expect(deferredNames).toContain('SolveMission');
    expect(activeNames).toContain('ToolSearch');
    expect(split.unhydratable).toEqual([]);
  });

  test('주입된 ToolSearch 로 defer 된 이름을 전부 되찾을 수 있다 (광고=소환가능 불변식)', async () => {
    const surface = toolSurface('webterm');
    const split = splitDeferredToolSpecs(surface.specs);
    expect(split.deferred.length).toBeGreaterThan(0);

    // 안내 블록이 광고하는 모든 이름은 실제로 소환 가능해야 한다. 하나라도
    // unknown 이면 모델은 "없는 툴"로 판단하고 셸아웃으로 폴백한다.
    const query = `select:${split.deferred.map((d) => d.name).join(',')}`;
    const result = await surface.dispatch(
      'ToolSearch',
      { query, max_results: split.deferred.length },
      ctx(),
    );
    const r = result as { matched?: string[]; unknown?: string[] };
    expect(r.unknown).toEqual([]);
    expect(r.matched).toEqual(split.deferred.map((d) => d.name));
  });
});
