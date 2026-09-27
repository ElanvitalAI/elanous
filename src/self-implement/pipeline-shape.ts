import { createHash } from 'node:crypto';
import type { SelfImplementStage } from './run-status-mapping.js';

export type PipelineNodeId =
  | 'implement'
  | 'gate'
  | 'review'
  | 'rework'
  | 'main-sync'
  | 'regate'
  | 'open-pr'
  | 'merge';

/** Each pipeline node's possible terminal stages. Nodes without a terminal exit use an empty array. */
export const TERMINAL_STAGES_BY_NODE = {
  implement: ['aborted', 'timed-out', 'soft-stopped'],
  gate: [],
  review: ['review-blocked'],
  rework: ['gate-failed', 'review-blocked'],
  'main-sync': ['merge-conflict'],
  regate: ['gate-failed'],
  'open-pr': ['pr-declined', 'pr-opened', 'worktree-completed'],
  merge: ['merged', 'pr-opened', 'merge-ready'],
} as const satisfies Record<PipelineNodeId, readonly SelfImplementStage[]>;

type DeclaredTerminalStage = (typeof TERMINAL_STAGES_BY_NODE)[PipelineNodeId][number];
type Assert<T extends true> = T;
type _EverySelfImplementStageIsDeclared = Assert<
  Exclude<SelfImplementStage, DeclaredTerminalStage> extends never ? true : false
>;

const PIPELINE_NODES = Object.keys(TERMINAL_STAGES_BY_NODE) as PipelineNodeId[];

/** Directed control-flow declaration. Rework deliberately returns to implement. */
export const PIPELINE_EDGES_BY_NODE = {
  implement: ['gate'],
  gate: ['review', 'rework', 'main-sync', 'open-pr'],
  review: ['rework', 'main-sync', 'open-pr'],
  rework: ['implement'],
  'main-sync': ['regate', 'open-pr'],
  regate: ['open-pr'],
  'open-pr': ['merge'],
  merge: [],
} as const satisfies Record<PipelineNodeId, readonly PipelineNodeId[]>;

/** ⭐ 그래프 «신원» — RFC §5 0단계. 원장의 모든 파이프라인 줄이 이 둘을 달아 「어느 선언으로 걸었나」를 답한다.
 *  ⛔ 이것 없이는 「선언을 바꿔서 나아졌나」를 «원리상» 못 잰다(RFC §5 가 0단계를 1순위로 둔 이유).
 *
 *  🅣 확정 스키마: `graphVersion` 은 «수동 버전이 아니라 선언 내용의 해시»다.
 *  ⛔ «파일»을 읽어 해시하지 않는다 — 주석·서식이 바뀌어도 판이 달라져 「선언이 바뀌었나」를 못 답한다.
 *  ✅ «선언된 구조»(노드·엣지·종결 stage)를 정규 직렬화해 해시한다 — 뜻이 바뀔 때만 값이 바뀐다. */
export const PIPELINE_GRAPH_ID = 'self-implement' as const;

/** 정규 직렬화 — 키 순서를 «정렬»해 선언 순서가 바뀌어도 같은 판이 나오게 한다. */
function canonicalGraphDeclaration(): string {
  const sorted = (o: Record<string, readonly string[]>): Record<string, readonly string[]> =>
    Object.fromEntries(Object.keys(o).sort().map((k) => [k, [...o[k]!].sort()]));
  return JSON.stringify({
    id: PIPELINE_GRAPH_ID,
    edges: sorted(PIPELINE_EDGES_BY_NODE as unknown as Record<string, readonly string[]>),
    terminals: sorted(TERMINAL_STAGES_BY_NODE as unknown as Record<string, readonly string[]>),
  });
}

let cachedGraphVersion: string | undefined;
/** 선언 내용 해시(16자리). ⛔ 「없음」을 빈 문자열로 내지 않는다 — 계산은 항상 성공한다(순수 함수). */
export function pipelineGraphVersion(): string {
  if (cachedGraphVersion === undefined) {
    cachedGraphVersion = createHash('sha256').update(canonicalGraphDeclaration()).digest('hex').slice(0, 16);
  }
  return cachedGraphVersion;
}

/** 원장에 싣는 그래프 신원 — 관측 자리마다 이 하나를 펼친다(두 곳에서 따로 만들지 않는다). */
export function pipelineGraphIdentity(): { graphId: string; graphVersion: string } {
  return { graphId: PIPELINE_GRAPH_ID, graphVersion: pipelineGraphVersion() };
}

/** ⭐ RFC §5 «2단계» — 위상 검사 셋. ⛔ TypeScript 가 «원리상» 못 하는 것들이라 런타임 순수 함수로 둔다
 *  (RFC §4: *"이 RFC 가 정작 원하는 셋(도달 불가 · 미정의 목적지 · 종료 불가 순환)은 TS 가 원리적으로 못 한다"*).
 *  ⛔ 셋은 «서로 다른 사유»여야 한다 — 한 사유로 접히면 「무엇이 깨졌나」를 못 가른다. */
export type PipelineGraphDefect =
  | { kind: 'unreachable-node'; node: string }
  | { kind: 'undefined-destination'; from: string; to: string }
  | { kind: 'inescapable-cycle'; nodes: readonly string[] };

/** 종결 노드 = 나가는 엣지가 «없는» 노드. 이 그래프에서는 `merge` 하나다. */
function terminalNodesOf(edges: Readonly<Record<string, readonly string[]>>): Set<string> {
  return new Set(Object.keys(edges).filter((n) => (edges[n] ?? []).length === 0));
}

function reachableFrom(edges: Readonly<Record<string, readonly string[]>>, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of edges[node] ?? []) if (!seen.has(next)) stack.push(next);
  }
  return seen;
}

/** 그래프의 위상 결함을 «전부» 낸다. ⛔ 첫 결함에서 멈추지 않는다 — 셋이 동시에 있을 수 있다.
 *  @param entry 진입 노드. 도달 불가 판정의 기준이다. */
export function inspectPipelineGraph(
  edges: Readonly<Record<string, readonly string[]>> = PIPELINE_EDGES_BY_NODE as unknown as Record<string, readonly string[]>,
  entry = 'implement',
): PipelineGraphDefect[] {
  const nodes = new Set(Object.keys(edges));
  const defects: PipelineGraphDefect[] = [];

  // ⑵ 미정의 목적지 — 선언에 «없는» 노드로 가는 엣지
  for (const from of nodes) {
    for (const to of edges[from] ?? []) {
      if (!nodes.has(to)) defects.push({ kind: 'undefined-destination', from, to });
    }
  }

  // ⑴ 도달 불가 — 진입에서 못 닿는 노드
  const reachable = reachableFrom(edges, entry);
  for (const node of [...nodes].sort()) {
    if (!reachable.has(node)) defects.push({ kind: 'unreachable-node', node });
  }

  // ⑶ 종료 불가 순환 — 그 노드에서 어떤 «종결 노드»에도 못 닿는다
  //   ⛔ 「순환이 있나」가 아니다. implement→gate→rework→implement 은 «정상»이다(merge 로 나갈 수 있다).
  const terminals = terminalNodesOf(edges);
  const trapped = [...nodes].filter((n) => {
    if (!reachable.has(n)) return false;                       // 도달 불가는 ⑴ 이 이미 말했다
    const out = reachableFrom(edges, n);
    return ![...out].some((m) => terminals.has(m));
  }).sort();
  if (trapped.length > 0) defects.push({ kind: 'inescapable-cycle', nodes: trapped });

  return defects;
}

export type PipelineTraversalClassification =
  | 'legal-terminal-match'
  | 'legal-terminal-mismatch'
  | 'undeclared-transition'
  | 'empty';

/** ⭐ RFC §5 «0a» — 「걸음의 끝이 왜 결과와 다른가」의 «닫힌» 사유(🅣 확정 어휘).
 *  ⛔ 자유 문자열이 아니다 — 다섯 중 하나다. 그래야 「사유 붙은 수 / 총수 = 1」을 셀 수 있다.
 *    observed                        걸음의 끝이 결과 노드다
 *    result-ahead-of-instrumentation 결과가 «한 칸 앞»이다 — 선언상 이어지는데 계측이 먼저 멎었다
 *    result-absent                   결과 노드를 걸음에서 «못 잇는다»(또는 결과 자체를 못 얻었다)
 *    walk-empty                      걸음이 «없다» — 아무 말도 못 한다
 *    error                           검사 자체가 실패했다(호출부가 붙인다 · 순수 함수는 안 낸다)
 *  🩸 이 어휘가 없던 동안 `unclassifiable` 하나가 «두 원인»(결과 미상 ⊕ 검사 예외)을 덮었다. */
export type PipelineTerminalResolution =
  | 'observed'
  | 'result-ahead-of-instrumentation'
  | 'result-absent'
  | 'walk-empty'
  | 'error';

export interface PipelineTraversalCheck {
  classification: PipelineTraversalClassification;
  /** ⭐ 0a — 분류와 «독립»이다. 분류는 「걸음이 선언을 지켰나」, 이것은 「끝이 결과와 왜 다른가」를 답한다. */
  terminalResolution: PipelineTerminalResolution;
  observedNodes: readonly PipelineNodeId[];
  terminalNode: PipelineNodeId;
  fromNode?: PipelineNodeId;
  toNode?: PipelineNodeId;
}

/** Classifies an observed node walk without influencing pipeline execution. */
export function checkPipelineTraversal(
  observedNodes: readonly PipelineNodeId[],
  terminalNode: PipelineNodeId,
): PipelineTraversalCheck {
  if (observedNodes.length === 0) {
    return { classification: 'empty', terminalResolution: 'walk-empty', observedNodes, terminalNode };
  }
  // ⭐ 0a — 끝이 결과와 다를 때 «선언»에 물어 「한 칸 앞인가」를 가른다.
  //   🅣 실측: `terminalNode ← result.node` 와 `traversedNodes ← onNodeEntry` 가 «다른 시점»에 정해져
  //   계측이 마지막 한 걸음을 못 싣는 판이 있었다. 그것을 「결과가 없다」와 같은 값으로 두면 처방이 갈리지 않는다.
  const lastNode = observedNodes[observedNodes.length - 1]!;
  const terminalResolution: PipelineTerminalResolution = lastNode === terminalNode
    ? 'observed'
    : PIPELINE_EDGES_BY_NODE[lastNode].includes(terminalNode as never)
      ? 'result-ahead-of-instrumentation'
      : 'result-absent';

  for (let index = 1; index < observedNodes.length; index += 1) {
    const fromNode = observedNodes[index - 1]!;
    const toNode = observedNodes[index]!;
    if (!PIPELINE_EDGES_BY_NODE[fromNode].includes(toNode as never)) {
      return { classification: 'undeclared-transition', terminalResolution, observedNodes, terminalNode, fromNode, toNode };
    }
  }

  return terminalResolution === 'observed'
    ? { classification: 'legal-terminal-match', terminalResolution, observedNodes, terminalNode }
    : { classification: 'legal-terminal-mismatch', terminalResolution, observedNodes, terminalNode };
}

/** Returns every pipeline node that can produce the supplied terminal stage. */
export function nodesForStage(stage: string): readonly PipelineNodeId[] {
  return PIPELINE_NODES.filter((node) =>
    (TERMINAL_STAGES_BY_NODE[node] as readonly string[]).includes(stage),
  );
}

/** Stages whose terminal vocabulary alone cannot identify one pipeline node. */
export const AMBIGUOUS_STAGES: ReadonlySet<SelfImplementStage> = new Set(
  PIPELINE_NODES.flatMap((node) => TERMINAL_STAGES_BY_NODE[node])
    .filter((stage, index, stages) => stages.indexOf(stage) === index)
    .filter((stage) => nodesForStage(stage).length > 1),
);
