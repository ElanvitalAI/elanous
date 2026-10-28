import { debug } from '../debug/log.js';
import { GRAPH_SPECS } from '../self-implement/graph-templates.js';
import { applyGraphOverlays, defaultOverlaysDir, loadGraphOverlays, selectOverlays, type GraphOverlaySpec } from '../self-implement/graph-overlay-yaml.js';
import { L1_PROTECTED_ROUTE_NODES, type GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import { evaluateOverlayCondition } from '../self-implement/graph-overlay-condition.js';
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
  readonly via?: 'outcome' | 'when';
  readonly condition?: string;
  readonly ambiguousConditions?: readonly string[];
  readonly unobservedConditions?: readonly string[];
  readonly skippedNode?: string;
  readonly skipCondition?: string;
  readonly skippedNodes?: readonly { readonly node: string; readonly condition: string }[];
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
  const outgoing = (spec?.edges ?? []).filter(edge => edge.from === from);
  const protectedFrom = L1_PROTECTED_ROUTE_NODES.has(from) || spec?.nodes.some(node => node.nodeId === from && node.kind === 'gate') ||
    spec?.terminalNodes.includes(from);
  const conditions = outgoing.filter(edge => edge.when !== undefined && !protectedFrom).map(edge => ({ edge, verdict: evaluateOverlayCondition(edge.when, state) }));
  const matching = conditions.filter(({ verdict }) => verdict.kind === 'applies').map(({ edge }) => edge);
  const unobservedConditions = conditions.filter(({ verdict }) => verdict.kind === 'key-absent').map(({ edge }) => edge.when!);
  if (matching.length === 1 && unobservedConditions.length === 0 && matching[0]!.to !== undefined) {
    route = { from, on: null, label, to: matching[0]!.to!, source: 'graph', overlays: applied,
      via: 'when', condition: matching[0]!.when };
  } else {
    const mapped = outgoing.find(edge => edge.when === undefined && edge.map !== undefined && Object.hasOwn(edge.map, label));
    const defaultEdge = mapped ?? outgoing.find(edge => edge.when === undefined && edge.to !== undefined);
    if (defaultEdge?.map !== undefined) route = { from, on: defaultEdge.on ?? null, label,
      to: defaultEdge.map[label]!, source: 'graph', overlays: applied, via: 'outcome' };
    else if (defaultEdge?.to !== undefined) route = { from, on: null, label,
      to: defaultEdge.to, source: 'graph', overlays: applied, via: 'outcome' };
    if (matching.length > 1) route = { ...route, ambiguousConditions: matching.map(edge => edge.when!) };
    if (unobservedConditions.length > 0) route = { ...route, unobservedConditions };
  }
  // A skipped optional node needs one unambiguous unconditional successor. Otherwise retain
  // the ordinary route; neither a missing observation nor a branching node is a skip proof.
  if (route.to && spec) {
    const skipped: { node: string; condition: string }[] = [];
    const visited = new Set<string>();
    while (route.to && !visited.has(route.to)) {
      visited.add(route.to);
      const next = spec.nodes.find(node => node.nodeId === route.to);
      if (!next?.skipWhen || next.kind === 'gate' ||
          L1_PROTECTED_ROUTE_NODES.has(next.nodeId) ||
          spec.terminalNodes.includes(next.nodeId) ||
          evaluateOverlayCondition(next.skipWhen, state).kind !== 'applies') break;
      const successors = spec.edges.filter(edge => edge.from === next.nodeId);
      if (successors.length !== 1 || successors[0]?.to === undefined ||
          successors[0]?.when !== undefined || (successors[0]?.fallback?.length ?? 0) > 0 ||
          visited.has(successors[0].to)) break;
      skipped.push({ node: next.nodeId, condition: next.skipWhen });
      route = { ...route, to: successors[0]!.to! };
    }
    if (skipped.length > 0) route = { ...route, skippedNode: skipped[0]!.node,
      skipCondition: skipped[0]!.condition, skippedNodes: skipped };
  }
  return route;
}

/** 간선 행에 덧붙이는 조인·근거 칸.
 *  `moveId` 는 next-move 결정 순간 한 번 만든 값(HARNESS-FULL-GRAPH-NEXTMOVE · 여기서 만들지 않는다).
 *  그 밖의 칸은 그 간선에 결속할 근거(예: 착지 거부 원문·cardId · LAND-REFUSAL-EDGES) — 간선 칸(from·to·taken…)을 덮지 못한다. */
export interface JourneyEdgeFields {
  readonly moveId?: string;
  readonly runId?: string;
  readonly card?: string;
  readonly pr?: number;
  readonly head?: string;
  readonly [key: string]: unknown;
}

/** 실제로 탄 간선을 남긴다 — `taken` 은 실제 다음 노드(그래프 답과 다르면 `honored: false` · 그 이유를 `reason` 에). */
export function recordJourneyEdge(route: JourneyRoute, taken: string, reason?: string, data: JourneyEdgeFields = {}): void {
  try {
    if (route.ambiguousConditions?.length) debug.log('self-implement', 'edge-ambiguous', {
      graphId: 'self-implement', from: route.from, conditions: route.ambiguousConditions,
      fallback: taken, ...journeyJoinFields(),
    });
    if (route.unobservedConditions?.length) debug.log('self-implement', 'edge-unobserved', {
      graphId: 'self-implement', from: route.from, conditions: route.unobservedConditions,
      fallback: taken, ...journeyJoinFields(),
    });
    if (route.to === taken) for (const skipped of route.skippedNodes ?? []) debug.log('self-implement', 'node-skipped', {
      graphId: 'self-implement', node: skipped.node, reason: 'condition', condition: skipped.condition,
      ...journeyJoinFields(),
    });
    // Evidence never overrides an edge field: the later spread wins. Explicit repair join keys win over ambient context.
    const { reason: _reservedReason, journeyKey: _reservedJourney, queueLaunchId: _reservedLaunch,
      runId, card, pr, head, moveId, ...evidence } = data ?? {};
    debug.log('self-implement', 'graph-edge-taken', {
      ...evidence, graphId: 'self-implement', ...route, taken, honored: route.to === null || route.to === taken,
      ...(reason === undefined ? {} : { reason }), ...journeyJoinFields(),
      ...(runId === undefined ? {} : { runId }), ...(card === undefined ? {} : { card }),
      ...(pr === undefined ? {} : { pr }), ...(head === undefined ? {} : { head }),
      ...(moveId === undefined ? {} : { moveId }),
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

/** 병합 직전 동결 검사의 «승인 요구» — 동결이 아닌(open) 병합을 그래프가 hold 로 보내면 true.
 *  ⛔ 그래프가 답을 못 내면(code-default) false — 오늘의 입장 판정 그대로. 동결·선점(frozen·taken)은 이미 코드가 정했다. */
export function freezeCheckHolds(label: 'open' | 'frozen' | 'taken', route: Pick<JourneyRoute, 'source' | 'to'>): boolean {
  return label === 'open' && route.source === 'graph' && route.to === 'hold';
}
