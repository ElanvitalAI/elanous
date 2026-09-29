import { inspectPipelineGraph, PIPELINE_EDGES_BY_NODE, pipelineGraphVersion, PIPELINE_GRAPH_ID, type PipelineGraphDefect } from './pipeline-shape.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { GOAL_TYPES, type GoalType } from './goal-author.js';
import type { GraphRunContractSpec } from './graph-run-contract.js';
import { edgeMapOf, loadGraphTemplates, type GraphNodeContract, type GraphNodeKind, type GraphNodeSpec, type GraphTemplateSpec } from './graph-yaml.js';

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

/** ⭐⭐ RFC §5 «배선» — 선언의 «출처»가 YAML 이다(대표 지시: TypeScript 는 저장에서 빠진다).
 *
 *  ⛔ 이 상수들(IMPLEMENT_LOOP·RESEARCH_LOOP)은 «폴백»이다 — YAML 을 못 읽었을 때만 쓴다.
 *    「못 읽었다」를 조용히 「없다」로 만들지 않기 위해서다(로더가 오류를 값으로 낸다).
 *  📌 뿌리는 «인자»로 온다 — 격리(`--root`)가 되려면 이 모듈이 cwd 를 «안 봐야» 한다.
 *    그래서 기본 뿌리만 여기서 정하고, 다른 뿌리는 `loadGraphTemplatesFrom(dir)` 로 받는다. */
export function defaultGraphsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'graphs');
}

export type DiscardedGraphNodeField = Exclude<keyof GraphNodeSpec, 'nodeId' | 'kind' | 'maxVisits' | 'recipe' | 'contract'>;

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
      ...(spec.docsOnlyGateSkip !== undefined ? { docsOnlyGateSkip: spec.docsOnlyGateSkip } : {}),
      ...(spec.runContract !== undefined ? { runContract: spec.runContract } : {}),
      nodes: spec.nodes.map((n) => ({
        nodeId: n.nodeId,
        kind: n.kind,
        maxVisits: n.maxVisits,
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

/** ⭐ 원장에 실을 «그래프 신원» — ⛔ 옛 TS 상수가 아니라 «지금 도는 템플릿»을 따른다.
 *
 *  🩸 계기(2026-09-08): 승격을 켠 research 런이 `investigate` 를 밟았는데 원장의
 *    graphVersion 이 «옛 TS 해시»였다. ⇒ 걸음은 YAML 을 따르고 신원은 «안 따랐다».
 *    그러면 사후에 「어느 선언으로 돈 걸음인가」를 못 묻는다 — 조인이 거짓말한다.
 *  ⛔ graphId 는 원장의 «조인 키»라 템플릿이 선언한 값을 그대로 쓴다(바꾸면 옛 표본과 비교 불가). */
export function graphIdentityOf(template: GraphTemplate): { graphId: string; graphVersion: string } {
  return { graphId: template.graphId, graphVersion: template.version };
}
