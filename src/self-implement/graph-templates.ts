import { inspectPipelineGraph, PIPELINE_EDGES_BY_NODE, pipelineGraphVersion, PIPELINE_GRAPH_ID, type PipelineGraphDefect } from './pipeline-shape.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { GOAL_TYPES, type GoalType } from './goal-author.js';
import type { GraphRunContractSpec } from './graph-run-contract.js';
import { edgeMapOf, loadGraphTemplates, type GraphEdgeSpec, type GraphNodeContract, type GraphNodeKind, type GraphNodeSpec, type GraphTemplateSpec } from './graph-yaml.js';

/** ⭐ RFC §5 «3단계» — 템플릿을 «데이터»로 둔다(RFC §4.1 어휘).
 *
 *  권위 여부는 런타임 설정이 결정한다. `tools.selfImplement.graphAuthoritative`와
 *  `graph-authority-resolved` 관측으로 그 런의 해석 결과를 재라.
 *  이 선언은 한때 그림자였으나, 승격 게이트 넷이 2026-09-08에 모두 서서 대표 승인으로 승격했다.
 *  정정 이력과 게이트 근거는 `내부 문서 `RFC-graph-engineering-for-the-harness-2026-09-07``를 따른다.
 *
 *  ⛔ RFC §7 의 kind 어휘 제한은 2026-09-26 지시로 열렸다. 정의는 graph-yaml.ts 한 곳이다. */
export type { GraphNodeKind } from './graph-yaml.js';

export interface GraphTemplateNode {
  readonly nodeId: string;
  // 플러그인 kind(`<plugin>:<kind>`)가 들어오므로 스펙과 같은 넓은 형(P-T1 #21684) — 좁은 union 이면 PWA(Next) 타입 검사가 빌드를 막는다.
  readonly kind: GraphNodeSpec['kind'];
  /** 그 노드의 재방문 상한. ⛔ 지금의 rework 상한이 «여기로 올라올» 자리다(RFC §4.1). */
  readonly maxVisits: number;
  readonly journeyStage?: string;
  /** YAML recipe identifier; existing orchestrator does not execute it. */
  readonly recipe?: string;
  /** YAML이 선언한 선택 계약. 관측용이며 실행 권한을 강제하지 않는다. */
  readonly contract?: GraphNodeContract;
}

export interface GraphTemplate {
  readonly graphId: string;
  readonly version: string;
  readonly entryNode: string;
  readonly terminalNodes: readonly string[];
  readonly journeyStages?: readonly string[];
  /** YAML 템플릿이 선언한 문서 전용 변경의 gate 건너뛰기 정책. */
  readonly docsOnlyGateSkip?: boolean;
  /** 선언된 런 계약(선택) — 런 시작 때 발사 인자·부모 계약과 함께 한 번 해석된다. */
  readonly runContract?: GraphRunContractSpec;
  readonly nodes: readonly GraphTemplateNode[];
  readonly edges: Readonly<Record<string, readonly string[]>>;
}

/** 지금 «실제로 도는» 8노드 — 선언으로 옮긴 것이다. 엣지는 실물과 «같은 출처»를 쓴다(두 벌로 갈리지 않게). */
const IMPLEMENT_LOOP: GraphTemplate = {
  graphId: PIPELINE_GRAPH_ID,
  version: pipelineGraphVersion(),
  entryNode: 'implement',
  terminalNodes: ['merge'],
  nodes: [
    { nodeId: 'implement', kind: 'agent', maxVisits: 6 },
    { nodeId: 'gate', kind: 'gate', maxVisits: 8 },
    { nodeId: 'review', kind: 'judge', maxVisits: 8 },
    { nodeId: 'rework', kind: 'agent', maxVisits: 6 },
    { nodeId: 'main-sync', kind: 'git', maxVisits: 2 },
    { nodeId: 'regate', kind: 'gate', maxVisits: 2 },
    { nodeId: 'open-pr', kind: 'git', maxVisits: 1 },
    { nodeId: 'merge', kind: 'git', maxVisits: 1 },
  ],
  edges: PIPELINE_EDGES_BY_NODE as unknown as Record<string, readonly string[]>,
};

/** 둘째 템플릿 — `research` 골이 지금 헛도는 칸(RFC §4.2).
 *
 *  🚨⭐ **초판 정정(2026-09-08 · 승격을 «시도하자» 드러났다)**: RFC §4.2 는 이 템플릿을
 *    *"`investigate → judge → document` (gate·merge 없음)"* 이라 적었다. ⛔ **`merge` 를 뺀 것이 틀렸다** —
 *    이 저장소에서 연구 골의 «산출»은 문서이고, 문서는 **PR 로 착지해야 남는다**.
 *    `merge` 가 없으면 자식이 쓴 문서가 워크트리와 함께 사라진다.
 *  ✅ 반면 **`gate` 를 뺀 것은 옳다** — 문서만 바뀐 판에서 변경 파일 범위 게이트는 «돌 시험이 없다».
 *    그것이 `implement-loop` 과의 «관측 가능한» 차이이고, 승격 성공의 판정선이다. */
const RESEARCH_LOOP: GraphTemplate = {
  graphId: 'research-loop',
  version: '3',
  entryNode: 'investigate',
  terminalNodes: ['merge'],
  nodes: [
    { nodeId: 'investigate', kind: 'agent', maxVisits: 4 },
    // ⛔ 조건부다 — 문서만 바뀐 판에서는 «안 들른다». 그 갈림은 코드가 낸다(라우터).
    { nodeId: 'gate', kind: 'gate', maxVisits: 4 },
    { nodeId: 'judge', kind: 'judge', maxVisits: 4 },
    { nodeId: 'open-pr', kind: 'git', maxVisits: 1 },
    { nodeId: 'merge', kind: 'git', maxVisits: 1 },
  ],
  edges: {
    // ⛔⭐ `gate` 로 가는 «조건부» 엣지 — RFC §4.3 ⑵ 의 라우터(값은 «코드»가 낸다 · LLM 이 못 고른다).
    //   🚨 이것이 없으면 research 골이 «코드»를 만져도 시험이 안 돈다(2026-09-08 승격 때 열린 구멍).
    //   ⇒ 조건: 변경 파일에 «코드»가 있나. 없으면 곧장 judge (문서만 바뀐 판엔 돌 시험이 없다).
    investigate: ['gate', 'judge'],
    gate: ['judge', 'investigate'],
    judge: ['investigate', 'open-pr'],   // 되돌아가는 칸이 rework 에 해당한다
    'open-pr': ['merge'],
    merge: [],
  },
};

/** ⭐ SELFIMPL-NODE-SEAMS-BACK — 한 NodeContext 가 저작→구현으로 흐르는 다섯 입력 칸.
 *
 *  ⛔ 이 다섯은 «부품의 계약»이다 — units/<stage>/<stage>.yaml 의 unit.inputs 와 글자 그대로 같아야 한다
 *    (flattenGraphUnits 가 호출 노드의 contract 와 unit.inputs 를 «길이·원소» 둘 다로 대조한다). */
export const NODE_CONTEXT_INPUTS = ['goal', 'context', 'feedback', 'budget', 'checkpoint'] as const;

/** 등록 부품의 이름 — 요구가 이름으로 든 다섯 단계(구현·gate·리뷰·git·착지). */
export type ImplementStageUnitId = 'implement' | 'gate' | 'review' | 'git' | 'landing';

export interface ImplementStageUnitExit {
  /** unit.exits 의 이름 — flattenGraphUnits 가 호출 간선 map 의 키와 «정확히» 대조한다. */
  readonly exit: string;
  /** 그 출구가 향하는 «파이프라인 노드» — PIPELINE_EDGES_BY_NODE 의 목적지에서만 고른다. */
  readonly to: string;
}

export interface ImplementStageUnitSeam {
  readonly stage: ImplementStageUnitId;
  /** `id@version` — createGraphUnitResolver 규약 그대로. */
  readonly call: string;
  /** 그 부품이 소유한 파이프라인 노드(PIPELINE_EDGES_BY_NODE 의 키). */
  readonly nodes: readonly string[];
  /** 이 부품에서 처음 밟는 노드(= 호출 노드의 call_entry). */
  readonly entry: string;
  /** 합성 호출되는 단계만 계약을 갖는다; landing은 종결 노드라 호출 계약이 없다. */
  readonly outputs?: readonly string[];
  readonly exits?: readonly ImplementStageUnitExit[];
}

/** ⛔ 출처는 «둘»이다 — kind 는 IMPLEMENT_LOOP, edges 는 PIPELINE_EDGES_BY_NODE. 여기서 새 어휘를 만들지 않는다.
 *
 *  📌 착지(landing) 부품은 합성 그래프에서 «평범한 merge 노드»로 남는다: flattenGraphUnits 는 호출 노드마다
 *    나가는 outcome map 을 요구하는데 종결 노드(merge)에는 나가는 간선이 없다 — 즉 «종결 노드는 호출일 수 없다».
 *    그래서 landing 은 등록·해석·단독 평탄화(계약 검증)로 생산 경로를 지나고, 합성 그래프의 종결은 merge 가 맡는다. */
export const IMPLEMENT_STAGE_UNITS: readonly ImplementStageUnitSeam[] = [
  { stage: 'implement', call: 'implement@1', nodes: ['implement'], entry: 'implement',
    outputs: ['diff', 'evidence', 'result'],
    exits: [{ exit: 'done', to: 'gate' }, { exit: 'rework', to: 'gate' }, { exit: 'failed', to: 'gate' }] },
  { stage: 'gate', call: 'gate@1', nodes: ['gate'], entry: 'gate',
    outputs: ['gate-verdict', 'evidence'],
    exits: [{ exit: 'pass', to: 'review' }, { exit: 'fail', to: 'rework' },
      { exit: 'sync', to: 'main-sync' }, { exit: 'open', to: 'open-pr' }] },
  { stage: 'review', call: 'review@1', nodes: ['review'], entry: 'review',
    outputs: ['verdict', 'must-fix', 'evidence'],
    exits: [{ exit: 'pass', to: 'main-sync' }, { exit: 'fail', to: 'rework' },
      { exit: 'sync', to: 'main-sync' }, { exit: 'open', to: 'open-pr' }] },
  { stage: 'git', call: 'git@1', nodes: ['main-sync', 'open-pr'], entry: 'main-sync',
    outputs: ['commit', 'pr-number', 'evidence'],
    exits: [{ exit: 'to-regate', to: 'regate' }, { exit: 'to-open-pr', to: 'open-pr' },
      { exit: 'to-merge', to: 'merge' }] },
  { stage: 'landing', call: 'landing@1', nodes: ['merge'], entry: 'merge',
    // 합성 그래프의 merge는 종결 노드라 landing 부품의 종료 매핑을 만들지 않는다.
  },
];

/** 그 그래프가 «부품으로 떼어 놓은» 단계 목록 — self-implement 밖의 그래프는 빈 배열(동작 불변). */
export function stageUnitSeamsForGraph(graphId: string): readonly ImplementStageUnitSeam[] {
  return graphId === PIPELINE_GRAPH_ID ? IMPLEMENT_STAGE_UNITS : [];
}

/** 파이프라인 노드의 kind — IMPLEMENT_LOOP 과 «같은 출처»에서 읽는다(두 벌로 갈리지 않게). */
export function pipelineNodeKind(nodeId: string): string | undefined {
  return IMPLEMENT_LOOP.nodes.find((node) => node.nodeId === nodeId)?.kind;
}

const UNIT_CALL_CONTRACT = (outputs: readonly string[]): GraphNodeContract => ({
  inputs: [...NODE_CONTEXT_INPUTS],
  tools: 'none',
  outputs: [...outputs],
});

/** ⭐ 부품 호출로 «재조립한» self-implement 선언 — 실행 그래프가 아니라 «정적 검증용 합성»이다.
 *
 *  ⛔ 실행 그래프(graphs/implement-loop.yaml)는 건드리지 않는다(보존 계약: 도는 동작 불변).
 *    이 spec 은 flattenGraphUnits 의 정적 검증(entry/exit 매핑·inputs/outputs 계약·이름 충돌·순환/깊이≤3)을
 *    «실제 등록 부품»에 걸어, 부품 분해가 기존 kind+edges 를 그대로 재현함을 값으로 낸다. */
export function implementLoopUnitSpec(): GraphTemplateSpec {
  const call = (seam: ImplementStageUnitSeam, callEntry?: string): GraphNodeSpec => ({
    nodeId: callEntry ?? seam.entry,
    kind: 'subgraph',
    recipe: 'none',
    maxVisits: 1,
    call: seam.call,
    ...(callEntry === undefined ? {} : { callEntry }),
    contract: UNIT_CALL_CONTRACT(seam.outputs ?? []),
  });
  const seamOf = (stage: ImplementStageUnitId): ImplementStageUnitSeam =>
    IMPLEMENT_STAGE_UNITS.find((seam) => seam.stage === stage)!;
  const outcome = (stage: ImplementStageUnitId, from: string): GraphEdgeSpec => ({
    from,
    on: 'outcome',
    map: Object.fromEntries((seamOf(stage).exits ?? []).map(({ exit, to }) => [exit, to])),
  });
  const nodes: GraphNodeSpec[] = [
    call(seamOf('implement')),
    call(seamOf('gate')),
    call(seamOf('review')),
    call(seamOf('git'), 'main-sync'),
    call(seamOf('git'), 'open-pr'),
    { nodeId: 'rework', kind: pipelineNodeKind('rework')!, recipe: 'none', maxVisits: 6 },
    { nodeId: 'regate', kind: pipelineNodeKind('regate')!, recipe: 'none', maxVisits: 2 },
    { nodeId: 'merge', kind: pipelineNodeKind('merge')!, recipe: 'none', maxVisits: 1 },
  ];
  const edges: GraphEdgeSpec[] = [
    outcome('implement', 'implement'),
    outcome('gate', 'gate'),
    outcome('review', 'review'),
    outcome('git', 'main-sync'),
    outcome('git', 'open-pr'),
    { from: 'rework', to: 'implement' },
    { from: 'regate', to: 'open-pr' },
  ];
  return {
    graphId: PIPELINE_GRAPH_ID,
    version: 1,
    entryNode: 'implement',
    terminalNodes: ['merge'],
    nodes,
    edges,
  };
}

export interface ImplementLoopUnitEquivalence {
  /** 파이프라인 노드마다 «합성 그래프의 kind» 가 IMPLEMENT_LOOP 과 다른 것. */
  readonly kindMismatches: readonly { node: string; expected: string; actual: string | undefined }[];
  /** PIPELINE_EDGES_BY_NODE 에 있는데 평탄화 결과에 «없는» 간선. */
  readonly missingEdges: readonly string[];
  /** 평탄화 결과에 있는데 PIPELINE_EDGES_BY_NODE 에 «없는» 간선 — 0 이어야 동작 불변이다. */
  readonly extraEdges: readonly string[];
}

/** flattenGraphUnits 는 호출 노드의 자식을 `${callNodeId}__${nodeId}` 로 접두한다 — 그 접두를 벗겨 되돌린다. */
export function normalizeFlattenedNodeId(nodeId: string): string {
  const at = nodeId.lastIndexOf('__');
  return at < 0 ? nodeId : nodeId.slice(at + 2);
}

/** ⭐ 판정선: 평탄화 결과가 기존 kind+edges 와 «같은가»를 세 방향으로 낸다. */
export function implementLoopUnitEquivalence(flattened: GraphTemplateSpec): ImplementLoopUnitEquivalence {
  const kindMismatches: { node: string; expected: string; actual: string | undefined }[] = [];
  const actualKinds = new Map<string, string>();
  for (const node of flattened.nodes) actualKinds.set(normalizeFlattenedNodeId(node.nodeId), node.kind);
  for (const nodeId of Object.keys(PIPELINE_EDGES_BY_NODE)) {
    const expected = pipelineNodeKind(nodeId);
    const actual = actualKinds.get(nodeId);
    if (expected !== undefined && actual !== expected) kindMismatches.push({ node: nodeId, expected, actual });
  }
  const edgesOf = (map: Readonly<Record<string, readonly string[]>>): Set<string> =>
    new Set(Object.entries(map).flatMap(([from, targets]) => targets.map((to) => `${from}->${to}`)));
  const normalizedFlattened = Object.fromEntries(
    Object.entries(edgeMapOf(flattened)).map(([from, targets]) => [normalizeFlattenedNodeId(from), targets.map(normalizeFlattenedNodeId)]),
  );
  const actual = edgesOf(normalizedFlattened);
  const expected = edgesOf(PIPELINE_EDGES_BY_NODE as unknown as Record<string, readonly string[]>);
  return {
    kindMismatches,
    missingEdges: [...expected].filter((edge) => !actual.has(edge)).sort(),
    extraEdges: [...actual].filter((edge) => !expected.has(edge)).sort(),
  };
}

/** ⭐⭐ RFC §5 «배선» — 선언의 «출처»가 YAML 이다(대표 지시: TypeScript 는 저장에서 빠진다).
 *
 *  ⛔ 이 상수들(IMPLEMENT_LOOP·RESEARCH_LOOP)은 «폴백»이다 — YAML 을 못 읽었을 때만 쓴다.
 *    「못 읽었다」를 조용히 「없다」로 만들지 않기 위해서다(로더가 오류를 값으로 낸다).
 *  📌 뿌리는 «인자»로 온다 — 격리(`--root`)가 되려면 이 모듈이 cwd 를 «안 봐야» 한다.
 *    그래서 기본 뿌리만 여기서 정하고, 다른 뿌리는 `loadGraphTemplatesFrom(dir)` 로 받는다. */
export function defaultGraphsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'graphs');
}

export type DiscardedGraphNodeField = Exclude<keyof GraphNodeSpec, 'nodeId' | 'kind' | 'maxVisits' | 'journeyStage' | 'recipe' | 'contract'>;

export interface GraphTemplateCompilation {
  readonly template: GraphTemplate;
  readonly discardedNodeFields: readonly {
    readonly nodeId: string;
    readonly fields: readonly DiscardedGraphNodeField[];
  }[];
}

const DISCARDED_NODE_FIELDS: readonly DiscardedGraphNodeField[] = [
  'progress',
  'phases',
  'terminalStages',
  'fanOut',
];

/** Compiles a YAML graph spec and reports node fields not represented by GraphTemplateNode. */
export function compileGraphTemplate(spec: GraphTemplateSpec): GraphTemplateCompilation {
  return {
    template: {
      graphId: spec.graphId,
      version: String(spec.version),
      entryNode: spec.entryNode,
      terminalNodes: spec.terminalNodes,
      ...(spec.journeyStages === undefined ? {} : { journeyStages: spec.journeyStages }),
      ...(spec.docsOnlyGateSkip !== undefined ? { docsOnlyGateSkip: spec.docsOnlyGateSkip } : {}),
      ...(spec.runContract !== undefined ? { runContract: spec.runContract } : {}),
      nodes: spec.nodes.map((n) => ({
        nodeId: n.nodeId,
        kind: n.kind,
        maxVisits: n.maxVisits,
        ...(n.journeyStage === undefined ? {} : { journeyStage: n.journeyStage }),
        ...(n.recipe === undefined ? {} : { recipe: n.recipe }),
        ...(n.contract === undefined ? {} : { contract: n.contract }),
      })),
      edges: edgeMapOf(spec),
    },
    discardedNodeFields: spec.nodes.map((node) => ({
      nodeId: node.nodeId,
      fields: DISCARDED_NODE_FIELDS.filter((field) => node[field] !== undefined),
    })),
  };
}

/** Backward-compatible template-only view for existing callers. */
export function specToTemplate(spec: GraphTemplateSpec): GraphTemplate {
  return compileGraphTemplate(spec).template;
}

/** ⛔ 「읽었나」와 「무엇을 읽었나」를 «둘 다» 낸다 — 조용히 폴백하지 않는다. */
export function loadGraphTemplatesFrom(dir: string): {
  readonly templates: Readonly<Record<string, GraphTemplate>>;
  readonly source: 'yaml' | 'builtin-fallback';
  readonly issues: readonly { path: string; message: string }[];
} {
  const loaded = loadGraphTemplates(dir);
  if (loaded.errors.length > 0 || Object.keys(loaded.templates).length === 0) {
    return { templates: BUILTIN_TEMPLATES, source: 'builtin-fallback', issues: loaded.errors };
  }
  const templates = Object.fromEntries(
    Object.entries(loaded.templates).map(([id, spec]) => [id, specToTemplate(spec)]),
  );
  return { templates, source: 'yaml', issues: loaded.warnings };
}

const BUILTIN_TEMPLATES: Readonly<Record<string, GraphTemplate>> = {
  [IMPLEMENT_LOOP.graphId]: IMPLEMENT_LOOP,
  [RESEARCH_LOOP.graphId]: RESEARCH_LOOP,
};

/** ⭐ 실행이 쓰는 선언 — YAML 이 «출처»이고, 못 읽으면 내장 폴백이다(그 사실을 `GRAPH_TEMPLATES_SOURCE` 가 말한다). */
const LOADED = loadGraphTemplatesFrom(defaultGraphsDir());
/** ⛔⭐ 컴파일 «전» 선언 — 오버레이는 spec 에 얹히고(그 뒤 컴파일), 컴파일된 템플릿엔 못 얹는다
 *  (컴파일이 결과 «라벨»을 목적지 목록으로 접어 버려 패치 포인터가 가리킬 자리가 사라진다). */
export const GRAPH_SPECS: Readonly<Record<string, GraphTemplateSpec>> = loadGraphTemplates(defaultGraphsDir()).templates;
export const GRAPH_TEMPLATES: Readonly<Record<string, GraphTemplate>> = LOADED.templates;
/** ⛔ 「YAML 로 돌고 있나」를 «값»으로 — 원장·시험이 이것을 읽는다. */
export const GRAPH_TEMPLATES_SOURCE: 'yaml' | 'builtin-fallback' = LOADED.source;
export const GRAPH_TEMPLATES_ISSUES: readonly { path: string; message: string }[] = LOADED.issues;

/** A node's relationship to the graph declaration identified by graphId. */
type GraphNodeDeclarationStatus = 'declared' | 'undeclared' | 'unknown-graph';

/** The orchestrator stages whose resolved template nodes must be declared. */
export const ORCHESTRATOR_STAGES = ['implement', 'gate', 'review', 'rework'] as const;

export interface OrchestratorStageCompatibility {
  readonly stage: typeof ORCHESTRATOR_STAGES[number];
  readonly nodeName: string;
  readonly declarationStatus: GraphNodeDeclarationStatus;
}

/**
 * Inspects whether each orchestrator stage resolves to a node declared by template.
 * The resolver is injected so graph-templates does not import graph-authority, which already imports this module.
 */
export function inspectOrchestratorStageCompatibility(
  template: GraphTemplate,
  resolveNodeName: (stage: typeof ORCHESTRATOR_STAGES[number], template: GraphTemplate) => string,
): readonly OrchestratorStageCompatibility[] {
  return ORCHESTRATOR_STAGES.map((stage) => {
    const nodeName = resolveNodeName(stage, template);
    const declarationStatus = template.nodes.some((node) => node.nodeId === nodeName)
      ? 'declared'
      : 'undeclared';
    return { stage, nodeName, declarationStatus };
  });
}

/**
 * Classifies whether nodeId is declared by graphId without inferring a declaration for an unknown graph.
 */
export function graphNodeDeclarationStatus(graphId: string, nodeId: string): GraphNodeDeclarationStatus {
  const template = GRAPH_TEMPLATES[graphId];
  if (template === undefined) return 'unknown-graph';
  return template.nodes.some((node) => node.nodeId === nodeId) ? 'declared' : 'undeclared';
}

/** Shared `pipeline-node-entry` payload fields. Both front-half and orchestrator observations
 * retain their caller-specific fields while this function owns declaration classification. */
export function pipelineNodeEntryPayload(
  graphTemplate: Pick<GraphTemplate, 'graphId' | 'version' | 'nodes'>,
  node: string,
): {
  readonly graphId: string;
  readonly graphVersion: string;
  readonly nodeDeclarationStatus: GraphNodeDeclarationStatus;
  readonly nodeContract?: GraphNodeContract;
} {
  const nodeContract = graphTemplate.nodes.find(({ nodeId }) => nodeId === node)?.contract;
  return {
    graphId: graphTemplate.graphId,
    graphVersion: graphTemplate.version,
    nodeDeclarationStatus: graphNodeDeclarationStatus(graphTemplate.graphId, node),
    ...(nodeContract === undefined ? {} : { nodeContract }),
  };
}

function stringLiteralValue(node: ts.Expression): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function isPipelineNodeEntryArguments(args: readonly ts.Expression[]): boolean {
  return args.some((argument) => stringLiteralValue(argument) === 'pipeline-node-entry');
}

function callUsesPipelineNodeEntryPayload(call: ts.CallExpression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'pipelineNodeEntryPayload') found = true;
    ts.forEachChild(node, visit);
  };
  call.arguments.forEach(visit);
  return found;
}

/** Reports each direct `pipeline-node-entry` construction that does not use the shared payload on that call. */
export function directPipelineNodeEntryConstructionViolations(
  sources: Readonly<Record<string, string>>,
): readonly string[] {
  return Object.entries(sources).flatMap(([path, source]) => {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const violations: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isPipelineNodeEntryArguments(node.arguments) && !callUsesPipelineNodeEntryPayload(node)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
        violations.push(`${path}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return violations;
  }).sort();
}

/** Reads every TypeScript source beneath sourceDir so the bypass guard covers new production locations. */
export function pipelineNodeEntryConstructionViolationsInSourceTree(sourceDir: string): readonly string[] {
  const sources: Record<string, string> = {};
  const collect = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile() && path.endsWith('.ts') && !path.endsWith('.test.ts')) {
        sources[path] = readFileSync(path, 'utf8');
      }
    }
  };
  collect(sourceDir);
  return directPipelineNodeEntryConstructionViolations(sources);
}

/** 골 종류 → 템플릿. ⛔ «아직 템플릿이 없는» 종류는 `null` 이다 — 있는 척하지 않는다.
 *  📌 `document`·`operate` 는 RFC §4.2 가 이름만 두고 «안 지었다». 그 상태를 값으로 낸다. */
export function templateForGoalType(goalType: GoalType | undefined): GraphTemplate | null {
  // ⛔⭐ 반드시 `GRAPH_TEMPLATES`(=YAML 출처)를 «지난다» — 내장 상수를 직접 돌려주면
  //   YAML 을 읽어 놓고도 실행 경로가 «옛것»이 된다. 🩸 2026-09-08 에 실제로 그랬다:
  //   YAML 은 research-loop v5(7노드)인데 이 함수가 v3(5노드)를 냈다.
  // ⛔⭐ 골 종류 «넷»을 다 덮는다. 빠진 종류는 `?? implementLoop` 로 접혀
  //   ***원장에 「구현 루프」라는 «틀린 이름»으로 남는다***(2026-09-10 실측으로 확인).
  //   🔎 반증: goalTypesWithoutTemplate() 가 빈 배열인가.
  const byGoalType: Readonly<Record<string, string>> = {
    implement: 'self-implement',
    research: 'research-loop',
    document: 'document-loop',
    operate: 'operate-loop',
  };
  const graphId = goalType === undefined ? undefined : byGoalType[goalType];
  return graphId === undefined ? null : (GRAPH_TEMPLATES[graphId] ?? null);
}

/** 템플릿이 «없는» 골 종류 — 「안 지었다」를 세는 자리(부재를 값으로). */
export function goalTypesWithoutTemplate(): readonly GoalType[] {
  return GOAL_TYPES.filter((t) => templateForGoalType(t) === null);
}

/** 모든 템플릿에 2단계 위상 검사를 건다. ⛔ 분모가 0이면 부르는 쪽이 «unmeasured» 로 읽어야 한다. */
export function inspectAllTemplates(): Array<{ graphId: string; defects: PipelineGraphDefect[] }> {
  return Object.values(GRAPH_TEMPLATES)
    .map((t) => ({ graphId: t.graphId, defects: inspectPipelineGraph(t.edges, t.entryNode) }));
}

/** L0 ratios are distinct: stages represented by nodes, and nodes accounted for by this run. */
export function measureL0Coverage(
  template: GraphTemplate,
  enteredNodes: Iterable<string>,
  skippedNodes: Iterable<string>,
): {
  declarationCoverage: number | null;
  traversalCoverage: number | null;
  declaredStageCount: number;
  listedStageCount: number;
  accountedNodeCount: number;
  declaredNodeCount: number;
} {
  const stages = template.journeyStages ?? [];
  const declaredStages = new Set(template.nodes.map((node) => node.journeyStage).filter((stage): stage is string => stage !== undefined && stages.includes(stage)));
  const accounted = new Set([...enteredNodes, ...skippedNodes]);
  const declaredNodeCount = template.nodes.length;
  const accountedNodeCount = template.nodes.filter((node) => accounted.has(node.nodeId)).length;
  return {
    declarationCoverage: stages.length ? declaredStages.size / stages.length : null,
    traversalCoverage: declaredNodeCount ? accountedNodeCount / declaredNodeCount : null,
    declaredStageCount: declaredStages.size,
    listedStageCount: stages.length,
    accountedNodeCount,
    declaredNodeCount,
  };
}

/** ⭐ 원장에 실을 «그래프 신원» — ⛔ 옛 TS 상수가 아니라 «지금 도는 템플릿»을 따른다.
 *
 *  🩸 계기(2026-09-08): 승격을 켠 research 런이 `investigate` 를 밟았는데 원장의
 *    graphVersion 이 «옛 TS 해시»였다. ⇒ 걸음은 YAML 을 따르고 신원은 «안 따랐다».
 *    그러면 사후에 「어느 선언으로 돈 걸음인가」를 못 묻는다 — 조인이 거짓말한다.
 *  ⛔ graphId 는 원장의 «조인 키»라 템플릿이 선언한 값을 그대로 쓴다(바꾸면 옛 표본과 비교 불가). */
export function graphIdentityOf(template: GraphTemplate): { graphId: string; graphVersion: string } {
  return { graphId: template.graphId, graphVersion: template.version };
}
