import { randomUUID } from 'node:crypto';
import { debug } from '../debug/log.js';
import { GRAPH_SPECS, GRAPH_TEMPLATES, GRAPH_TEMPLATES_SOURCE, pipelineNodeEntryPayload, templateForGoalType, type GraphTemplate } from '../self-implement/graph-templates.js';
import type { GoalType } from '../self-implement/goal-author.js';

/** ⭐ HARNESS-FULL-GRAPH (0.2.21 · 대표 10-08) — 하니스 «여정» 전 단계를 그래프 노드로 선언·관측한다.
 *
 *  🩸 계기: `내부 문서 `TECH-harness-map-2026-10-06`` 차트의 단계 중 «입구·대기열·발사 관문·배치·Pod 입장·
 *    이미지 동기화·자격 선갱신·동결 검사·보류·회수·실패 쪽(결과 해석·수확·heal·다음 한 수)»이
 *    그래프 밖의 «맨 코드»였다. 공개 문서는 「그래프 선언이 모든 걸음을 대조한다」고 말한다 — 거짓이 되지 않게.
 *
 *  ⛔ 이 모듈은 «관측»이다(1단계) — 흐름을 바꾸지 않는다. 진입은 기존 노드와 «같은 사건»
 *    (`self-implement` / `pipeline-node-entry` · 같은 `pipelineNodeEntryPayload`)으로 남겨
 *    그래프 권위의 declared/undeclared 판정과 원장 질의가 이 노드들을 «같은 자»로 본다.
 *    출구는 `pipeline-node-exit`(결과 `outcome` 포함)로 남긴다.
 *  ⛔ fail-soft — 관측이 발사·착지를 죽이지 않는다.
 *
 *  🔗 조인(런 id 가 없는 앞단): 입구에서 `ELANOUS_JOURNEY_KEY` 를 한 번 만들어 환경에 싣는다.
 *    자식 프로세스는 그 값을 물려받고, 오케스트레이터의 모든 파이프라인 관측에도 `journeyKey` 가 실린다.
 *    ⇒ `journeyKey` 로 「runId 없이 남은 앞단 걸음」과 「runId 가 있는 후반 걸음」을 한 질의로 묶는다.
 *    대기열을 거친 발사는 부모·자식 프로세스가 다르다 — 그 자리는 `queueLaunchId`(=`ELANOUS_HARNESS_QUEUE_LAUNCH`)가 잇는다.
 *    설계 = 내부 문서 `RFC-harness-full-journey-as-graph-2026-10-08` §4. */

/** 여정 노드 — ⛔ id 는 원장의 조인 키이자 라이브 그래프 화면(HARNESS-RUN-LIVE-GRAPH)의 키다. 바꾸지 마라. */
export const JOURNEY_NODE_IDS = [
  'intake',
  'queue',
  'launch-gate',
  'dispatch',
  'pool-admit',
  'image-sync',
  'credential-refresh',
  'freeze-check',
  'hold',
  'cleanup',
  'result-parse',
  'salvage',
  'heal',
  'next-move',
  'stopped',
] as const;
export type JourneyNodeId = typeof JOURNEY_NODE_IDS[number];

export const JOURNEY_KEY_ENV = 'ELANOUS_JOURNEY_KEY';
const QUEUE_LAUNCH_ENV = 'ELANOUS_HARNESS_QUEUE_LAUNCH';
const RUN_ID_ENV = 'ELANOUS_RUN_ID';

/** 이 여정의 조인 키 — 없으면 만들어 환경에 싣는다(자식이 물려받는다). */
export function ensureJourneyKey(env: NodeJS.ProcessEnv = process.env): string {
  const existing = env[JOURNEY_KEY_ENV]?.trim();
  if (existing) return existing;
  const key = `jrn-${randomUUID()}`;
  env[JOURNEY_KEY_ENV] = key;
  return key;
}

/** 관측 자리마다 펼치는 조인 칸(있는 것만). */
export function journeyJoinFields(env: NodeJS.ProcessEnv = process.env): { journeyKey?: string; queueLaunchId?: string } {
  const journeyKey = env[JOURNEY_KEY_ENV]?.trim();
  const queueLaunchId = env[QUEUE_LAUNCH_ENV]?.trim();
  return {
    ...(journeyKey ? { journeyKey } : {}),
    ...(queueLaunchId ? { queueLaunchId } : {}),
  };
}

/** 여정 노드를 선언한 템플릿 — 골 종류의 템플릿이 그 노드를 선언하면 그것, 아니면 구현 루프. */
export function journeyTemplate(node: string, goalType?: GoalType | null): GraphTemplate {
  const own = goalType ? templateForGoalType(goalType) : null;
  if (own && own.nodes.some((n) => n.nodeId === node)) return own;
  return GRAPH_TEMPLATES['self-implement'] as GraphTemplate;
}

export interface JourneyObservation {
  readonly provenance: string;
  readonly outcome?: string;
  readonly runId?: string;
  readonly goalType?: GoalType | null;
  readonly data?: Readonly<Record<string, unknown>>;
}

function emit(entry: boolean, node: JourneyNodeId, o: JourneyObservation): void {
  try {
    const template = journeyTemplate(node, o.goalType);
    const runId = o.runId ?? process.env[RUN_ID_ENV]?.trim();
    const fields = {
      node,
      round: 0,
      phase: 'journey',
      provenance: o.provenance,
      ...(o.outcome === undefined ? {} : { outcome: o.outcome }),
      ...(runId ? { runId } : {}),
      ...(o.goalType ? { goalType: o.goalType } : {}),
      ...journeyJoinFields(),
      ...o.data,
      graphTemplatesSource: GRAPH_TEMPLATES_SOURCE,
    };
    // ⛔ 진입은 «공용 payload» 를 그 호출 안에서 펼친다 — 우회 가드(graph-templates.ts)가 행 단위로 문다.
    if (entry) debug.log('self-implement', 'pipeline-node-entry', { ...pipelineNodeEntryPayload(template, node), ...fields });
    else debug.log('self-implement', 'pipeline-node-exit', { ...pipelineNodeEntryPayload(template, node), ...fields });
  } catch { /* 관측은 fail-soft */ }
}

/** 노드 진입. */
export function enterJourneyNode(node: JourneyNodeId, o: JourneyObservation): void {
  emit(true, node, o);
}

/** 노드 출구 — `outcome` 이 그 노드에서 나간 간선의 라벨(YAML `map` 키)이다.
 *  ⭐ 그 라벨이 선언에서 종결 노드 `stopped` 로 가면 `stopped` 진입도 남긴다 — 거절·포기 런이 «선언된 종결점»에서 끝난다.
 *  `outcome: 'error'` = 노드 안 작업이 예외를 던졌다(예외는 호출자에게 그대로 간다). */
export function exitJourneyNode(node: JourneyNodeId, o: JourneyObservation & { readonly outcome: string }): void {
  emit(false, node, o);
  if (node !== 'stopped' && journeyEdgeTarget(node, o.outcome) === 'stopped') {
    const { outcome: _outcome, ...rest } = o;
    emit(true, 'stopped', { ...rest, provenance: `${node}:${o.outcome}` });
  }
}

/** 선언(기준 YAML)에서 `from` 의 `label` 간선이 가는 노드. 없으면 undefined. */
export function journeyEdgeTarget(from: string, label: string): string | undefined {
  try {
    for (const edge of GRAPH_SPECS['self-implement']?.edges ?? []) {
      if (edge.from === from && edge.map !== undefined && Object.hasOwn(edge.map, label)) return edge.map[label];
    }
  } catch { /* 관측 보조 — 실패해도 출구는 이미 남았다 */ }
  return undefined;
}

/** 노드 안 작업을 감싼다 — 예외면 출구 `error` 를 남기고 다시 던진다(진입 뒤 출구가 빠지지 않게). */
export function withJourneyNode<T>(node: JourneyNodeId, o: JourneyObservation, work: () => Promise<T>): Promise<T> {
  const onError = (error: unknown): void => {
    exitJourneyNode(node, { ...o, outcome: 'error', data: { ...o.data, error: error instanceof Error ? error.message : String(error) } });
  };
  let pending: Promise<T>;
  try { pending = work(); }
  catch (error) { onError(error); throw error; }
  // ⛔ 같은 약속을 «그대로» 돌려준다 — async/await 로 감싸면 마이크로태스크가 늘어 호출자의 순서가 밀린다
  //   (2판에서 self-implement-pod 시험이 그 차이를 잡았다). 관측은 곁가지(.then)로만 붙인다.
  pending.then(undefined, onError);
  return pending;
}

/** 동기 판. */
export function withJourneyNodeSync<T>(node: JourneyNodeId, o: JourneyObservation, work: () => T): T {
  try { return work(); }
  catch (error) {
    exitJourneyNode(node, { ...o, outcome: 'error', data: { ...o.data, error: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

/** 진입·출구를 한 번에 — 판정만 하는 노드(대기 없는 관문)용. */
export function passJourneyNode(node: JourneyNodeId, o: JourneyObservation & { readonly outcome: string }): void {
  enterJourneyNode(node, o);
  exitJourneyNode(node, o);
}
