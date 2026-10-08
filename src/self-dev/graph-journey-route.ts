import { debug } from '../debug/log.js';
import { GRAPH_SPECS } from '../self-implement/graph-templates.js';
import { applyGraphOverlays, defaultOverlaysDir, loadGraphOverlays, selectOverlays, type GraphOverlaySpec } from '../self-implement/graph-overlay-yaml.js';
import type { GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import { journeyJoinFields } from './graph-journey-nodes.js';

/** ⭐ HARNESS-FULL-GRAPH 2판 — 「다음 노드」를 코드가 아니라 «그래프»가 정한다.
 *
 *  대표 10-08: *«그래프에 따라 실제 경로가 바뀌어야 한다. 기본은 풀세트, 환경 셋업·운영 방법에 따라 일부만 걷거나 생략.»*
 *  ⇒ 코드는 «상태 값»(queue=queued|direct · substrate=local|pod · freeze=open|frozen …)만 낸다.
 *    그 값으로 «어느 간선을 타나»는 YAML 의 `on:`/`map:`(⊕ `stage: launch` 오버레이)이 정한다.
 *  ⛔ 기본 YAML 은 오늘 코드와 «같은 길»을 낸다 — 시험이 그 동치를 문다(graph-journey-route.test.ts).
 *  ⛔ 그래프가 답을 못 내면(간선 없음·로드 실패) 코드 기본으로 간다 — 그 사실을 `source: 'code-default'` 로 남긴다.
 *  🔎 관측: `self-implement` / `graph-edge-taken` { from, on, label, to, source, overlays } */

export interface JourneyRoute {
  readonly from: string;
  readonly on: string | null;
  readonly label: string;
  /** 그래프가 고른 다음 노드. 못 고르면 null. */
  readonly to: string | null;
  readonly source: 'graph' | 'code-default';
  readonly overlays: readonly string[];
}

/** ⛔ 캐시하지 않는다 — 여러 런을 처리하는 프로세스(데몬·대기열 tick)가 다음 발사에서 오버레이 변경을 봐야 한다.
 *  여정 판정은 발사당 몇 번뿐이라 디렉터리 한 번 읽기가 싸다. */
let overlaysForTesting: readonly GraphOverlaySpec[] | undefined;
function launchOverlays(): readonly GraphOverlaySpec[] {
  if (overlaysForTesting !== undefined) return overlaysForTesting;
  try { return loadGraphOverlays(defaultOverlaysDir()).overlays; }
  catch { return []; }
}

/** 시험 전용 — 오버레이 묶음을 고정한다(undefined 면 디스크에서 읽는다). */
export function setJourneyOverlaysForTesting(overlays: readonly GraphOverlaySpec[] | undefined): void {
  overlaysForTesting = overlays;
}

/** 상태 값으로 고른 «이 런의 여정 선언» — 기준 YAML ⊕ 조건이 맞는 launch 오버레이. */
export function journeySpec(
  state: Readonly<Record<string, unknown>>,
  base: GraphTemplateSpec | undefined = GRAPH_SPECS['self-implement'],
  overlays: readonly GraphOverlaySpec[] = launchOverlays(),
): { readonly spec: GraphTemplateSpec | undefined; readonly applied: readonly string[] } {
  if (base === undefined) return { spec: undefined, applied: [] };
  try {
    const { applied } = selectOverlays(overlays, { graphId: base.graphId, stage: 'launch', state });
    if (applied.length === 0) return { spec: base, applied: [] };
    const result = applyGraphOverlays(base, applied);
    // ⛔ 거절된 오버레이는 길을 바꾸지 않는다 — 기준 선언으로 간다.
    return result.ok ? { spec: result.template, applied: result.overlayIds } : { spec: base, applied: [] };
  } catch {
    return { spec: base, applied: [] };
  }
}

/** `from` 노드에서 `label` 로 나가는 다음 노드를 그래프에서 «읽는다»(기록하지 않는다).
 *  ⛔ 판독과 기록을 가른다 — 실제로 탄 간선은 전제 검사·실제 단계 경계 «뒤»에 `recordJourneyEdge` 로 남긴다. */
export function readJourneyEdge(
  from: string,
  label: string,
  state: Readonly<Record<string, unknown>> = {},
  deps: { readonly base?: GraphTemplateSpec; readonly overlays?: readonly GraphOverlaySpec[] } = {},
): JourneyRoute {
  const { spec, applied } = journeySpec(state, deps.base ?? GRAPH_SPECS['self-implement'], deps.overlays ?? launchOverlays());
  let route: JourneyRoute = { from, on: null, label, to: null, source: 'code-default', overlays: applied };
  for (const edge of spec?.edges ?? []) {
    if (edge.from !== from) continue;
    if (edge.map !== undefined && Object.hasOwn(edge.map, label)) {
      route = { from, on: edge.on ?? null, label, to: edge.map[label]!, source: 'graph', overlays: applied };
      break;
    }
  }
  return route;
}

/** 실제로 탄 간선을 남긴다 — `taken` 은 실제 다음 노드(그래프 답과 다르면 `honored: false` · 그 이유를 `reason` 에). */
export function recordJourneyEdge(route: JourneyRoute, taken: string, reason?: string): void {
  try {
    debug.log('self-implement', 'graph-edge-taken', {
      graphId: 'self-implement', ...route, taken, honored: route.to === null || route.to === taken,
      ...(reason === undefined ? {} : { reason }), ...journeyJoinFields(),
    });
  } catch { /* 관측은 fail-soft */ }
}

/** 판독 ⊕ 그 자리에서 기록 — 판독 자리가 곧 실제 단계 경계일 때만 쓴다. */
export function routeJourneyEdge(
  from: string,
  label: string,
  state: Readonly<Record<string, unknown>> = {},
  deps: { readonly base?: GraphTemplateSpec; readonly overlays?: readonly GraphOverlaySpec[] } = {},
): JourneyRoute {
  const route = readJourneyEdge(from, label, state, deps);
  recordJourneyEdge(route, route.to ?? label);
  return route;
}

/** 입구의 대기열 갈래 — 그래프가 고른 다음 노드로 정한다. 그래프가 답을 못 내면 코드 라벨을 따른다.
 *  ⛔ `eligible`(자리 있음 · 대기열 자식 아님 · --no-queue 아님)은 그래프가 못 넘는 전제다. */
export function intakeTakesQueue(label: 'queued' | 'direct', route: Pick<JourneyRoute, 'source' | 'to'>, eligible: boolean): boolean {
  const graphQueues = route.source === 'graph' ? route.to === 'queue' : label === 'queued';
  return graphQueues && eligible;
}
