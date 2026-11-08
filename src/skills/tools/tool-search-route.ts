import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── 소환기 라우팅 헬퍼 (F2 · RFC-observability-driven-tool-selection · 2026-07-26) ──
//
// tier-flip 이 무언가를 defer 하면 ToolSearch 를 active 에 **주입**한다. 그러면
// 그 스펙 목록을 소비하는 서피스는 반드시 ToolSearch 를 **라우팅**해야 한다 —
// 안 하면 모델이 소환을 시도하는 순간 "unknown tool" 로 죽는다(=주입 전보다 악화).
//
// 라우팅은 서피스마다 한 줄이면 되지만 그 한 줄이 서피스마다 흩어지면 새 소비자가
// 조용히 빠뜨린다(실제로 daemon webterm 과 telegram 이 둘 다 빠져 있었다). 그래서
// 단일 구현을 여기 두고 각 서피스는 이걸 호출한다 — 라우팅 불변식의 단일 출처.
//
// 사용처(= deferred 를 만드는 서피스):
//   - `boot/daemon-tools/index.ts` (chat · webterm/ACP)
//   - `agent/monad-agent-turn.ts` (telegram · discord)
//   - 대시보드는 tool-runtime 레지스트리에 `toolSearchRuntime` 이 등록돼 있어 자동.

import { dispatchToolSearch } from './tool-search.js';
import { TOOL_SEARCH_NAME } from './tool-search-spec.js';
import { debug } from '../../debug/log.js';


export { TOOL_SEARCH_NAME };

/** 이 이름이 소환기인가. 각 서피스 dispatch 의 첫 분기. */
export function isToolSearchCall(name: string): boolean {
  return name === TOOL_SEARCH_NAME;
}

/**
 * 소환기 dispatch. `surfaceSpecs` 는 **이 서피스가 실제로 라우팅할 수 있는 전부**
 * (권위적 allowlist) — 전역 레지스트리로 새지 않는다. nest-cap 으로 카탈로그에서
 * 빠진 자식-spawn 툴은 `surfaceSpecs` 에도 없으므로 자동으로 소환 대상에서 빠진다.
 *
 * throw 하지 않고 `{error}` 를 돌려준다 — 모델이 질의를 고쳐 재시도할 수 있어야 한다.
 */
export function routeToolSearch(
  args: Record<string, unknown>,
  surfaceSpecs: readonly LLMToolSpec[],
  meta: { surface: string },
): unknown {
  const query = typeof args.query === 'string' ? args.query : '';
  if (!query.trim()) return { error: 'ToolSearch: `query` is required' };
  const result = dispatchToolSearch(
    {
      query,
      ...(typeof args.max_results === 'number' ? { max_results: args.max_results } : {}),
    },
    { specs: surfaceSpecs },
  );
  debug.log('capability.resolve', 'tool-search', {
    surface: meta.surface,
    query: query.slice(0, 120),
    matched: result.matched,
    unknown: result.unknown,
    poolSize: surfaceSpecs.length,
  });
  return result;
}
