import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path/posix';
import type { GoalType } from './goal-author.js';
import type { UserConfig } from '../user-config.js';
import ts from 'typescript';
import {
  GRAPH_SPECS,
  GRAPH_TEMPLATES,
  GRAPH_TEMPLATES_ISSUES,
  GRAPH_TEMPLATES_SOURCE,
  compileGraphTemplate,
  specToTemplate,
  templateForGoalType,
  type GraphTemplate,
  type GraphTemplateCompilation,
} from './graph-templates.js';
import { applyGraphOverlays, selectOverlays, type GraphOverlaySpec, type OverlayRejection, type OverlaySelection, type OverlayStage } from './graph-overlay-yaml.js';
import type { OverlayPatch } from './graph-overlay.js';
import type { GraphTemplateSpec } from './graph-yaml.js';

/** 2026-09-26 설정 졸업 — 그래프 권위는 항상 켬. 관측 출처는 default로 고정한다. */
export type GraphAuthoritySource = 'default';

export interface GraphAuthority {
  readonly enabled: boolean;
  readonly source: GraphAuthoritySource;
}

/** 옛 호출자의 입력은 해석하지 않는다. 권위는 항상 켜져 있다. */
export function resolveGraphAuthority(_input: {
  readonly flag?: boolean | undefined;
  readonly config?: boolean | undefined;
} = {}): GraphAuthority {
  return { enabled: true, source: 'default' };
}

export function resolveGraphAuthorityForUserConfig(
  _config?: UserConfig,
  _flag?: boolean,
): GraphAuthority {
  return { enabled: true, source: 'default' };
}

/** 이 런이 실제로 따를 템플릿. 기존 비권위 입력을 직접 주입한 호출은 구현 루프로 폴백한다. */
export function activeTemplate(goalType: GoalType | undefined, authority: GraphAuthority): GraphTemplate {
  const implementLoop = GRAPH_TEMPLATES['self-implement'] as GraphTemplate;
  if (!authority.enabled) return implementLoop;
  return templateForGoalType(goalType) ?? implementLoop;
}

/** 앞단 관측의 구현 골 정체성. implement의 활성 템플릿을 사용한다. */
export function activeImplementTemplate(): GraphTemplate {
  return activeTemplate('implement', resolveGraphAuthority({}));
}

/** 전반부 관측의 템플릿 정체성. 구현으로 확인된 골만 활성 구현 선언에 이름을 잇는다.
 * 다른 골과 아직 모르는 골은 기존 default-loop 정체성을 보존해 구현 그래프라는 거짓 사실을 남기지 않는다. */
export function frontObservationTemplate(goalType: GoalType | undefined): GraphTemplate {
  if (goalType === 'implement') return activeImplementTemplate();
  return GRAPH_TEMPLATES['default-loop'] as GraphTemplate;
}

/** 오케스트레이터의 «단계 이름» → 그 템플릿의 «노드 이름».
 *
 *  ⛔ 단계는 그대로 돌고 «이름만» 갈린다 — 그것이 이 승격이 바꾸는 전부다(§4.2a: node_id 는 템플릿마다 다르다).
 *  ⛔ 모르는 단계는 «그대로 돌려준다» — 이름을 지어내지 않는다. */
const RESEARCH_NODE_BY_STAGE: Readonly<Record<string, string>> = {
  implement: 'investigate',
  rework: 'investigate',
  review: 'judge',
};

export function nodeNameForStage(stage: string, template: GraphTemplate): string {
  if (template.graphId !== 'research-loop') return stage;
  return RESEARCH_NODE_BY_STAGE[stage] ?? stage;
}

/** ⭐ 라우터 — 「이 판에 게이트를 돌려야 하나」. RFC §4.3 ⑵: ***값은 «코드»가 낸다.*** LLM 이 못 고른다.
 *
 *  🚨 계기(2026-09-08): 승격 첫 판에서 `research-loop` 이 `gate` 를 «아예» 안 가져서,
 *    research 골이 «코드»를 만져도 시험이 안 돌 구멍이 열렸다. 그 구멍을 조건부 엣지로 닫는다.
 *
 *  ⛔ 「문서만 바뀌었나」를 «확실히 알 때만» 건너뛴다 — 못 세면 «돌린다»(fail-safe).
 *    ⇒ 변경 목록이 비었거나 못 얻었으면 `true`(돌린다)다. 「모른다」를 「없다」로 읽지 않는다. */
const DOCUMENT_ONLY_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.rst']);
const TEST_CONSUMED_DOCUMENT_PREFIXES = [
  '.rules/', // test/rules-contract.test.ts consumes repository rules as contract input.
  'docs/goals/', // src/self-implement/goal-file-lint.test.ts reads every docs/goals document.
  'docs/design/craft/', // src/design/craft-vendor.test.ts verifies vendored craft documents.
  'docs/mission-requests/', // test/mission-blueprints/req-v1-10a9d92906d400c4.test.ts reads its request document.
  'DESIGN.md', // src/design/craft-vendor.test.ts reads root DESIGN.md alongside craft declarations.
] as const;

function isTestConsumedDocument(file: string): boolean {
  return TEST_CONSUMED_DOCUMENT_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export interface TestDocumentCoverageAudit {
  readonly uncoveredPaths: readonly string[];
  readonly violationCount: number;
}

function isReadFileCall(node: ts.CallExpression): boolean {
  return ts.isIdentifier(node.expression) && /^readFile(?:Sync)?$/.test(node.expression.text);
}

function staticString(node: ts.Expression, bindings: ReadonlyMap<string, string>): string | undefined {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^(?:join|resolve)$/.test(node.expression.text)) {
    const parts = node.arguments.map((argument) => staticString(argument, bindings));
    const firstKnown = parts.findIndex((part) => part !== undefined);
    if (firstKnown < 0 || parts.slice(firstKnown).some((part) => part === undefined)) return undefined;
    const value = normalize(join(...parts.slice(firstKnown) as string[]));
    const repositoryPath = value.match(/(?:^|\/)(docs\/.*|\.rules\/.*|DESIGN\.md)$/)?.[1];
    return repositoryPath ?? value;
  }
  return ts.isIdentifier(node) ? bindings.get(node.text) : undefined;
}

function documentReads(source: string, path: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const paths = new Set<string>();
  const visit = (node: ts.Node, bindings: ReadonlyMap<string, string>): void => {
    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      const scope = new Map(bindings);
      for (const statement of node.statements) visit(statement, scope);
      return;
    }
    if (ts.isVariableStatement(node)) {
      const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of node.declarationList.declarations) {
        if (declaration.initializer !== undefined) visit(declaration.initializer, bindings);
        if (isConst && ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          const value = staticString(declaration.initializer, bindings);
          if (value !== undefined && bindings instanceof Map) bindings.set(declaration.name.text, value);
        }
      }
      return;
    }
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      const scope = new Map(bindings);
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) scope.delete(parameter.name.text);
      }
      if (node.body !== undefined) visit(node.body, scope);
      return;
    }
    if (ts.isCallExpression(node) && isReadFileCall(node) && node.arguments[0] !== undefined) {
      const value = staticString(node.arguments[0], bindings);
      if (value !== undefined && /\.(?:md|markdown|txt|rst)$/i.test(value)) paths.add(value);
    }
    ts.forEachChild(node, (child) => visit(child, bindings));
  };
  visit(file, new Map());
  return [...paths];
}

/** 저장소의 `test/` 및 `src/` 아래 Bun 시험 소스를 모아 감사의 실제 호출자로 쓴다. */
export function repositoryTestSources(cwd: string, readFile: (path: string) => string = (path) => readFileSync(path, 'utf8')): Record<string, string> {
  const sources: Record<string, string> = {};
  const walk = (relative: string): void => {
    const absolute = join(cwd, relative);
    for (const entry of readdirSync(absolute)) {
      const child = join(relative, entry);
      const childAbsolute = join(cwd, child);
      if (statSync(childAbsolute).isDirectory()) walk(child);
      else if (/\.test\.tsx?$/.test(entry)) sources[child] = readFile(childAbsolute);
    }
  };
  for (const root of ['test', 'src']) walk(root);
  return sources;
}

/** 시험 소스가 실행 중 읽는 정적 문서 경로를 접두사 범위와 대조한다. 자동으로 목록을 고치지 않는다. */
export function auditTestConsumedDocumentCoverage(
  testSources: Readonly<Record<string, string>>,
  coveredPrefixes: readonly string[] = TEST_CONSUMED_DOCUMENT_PREFIXES,
): TestDocumentCoverageAudit {
  const consumed = new Set<string>();
  for (const [path, source] of Object.entries(testSources)) {
    for (const documentPath of documentReads(source, path)) consumed.add(documentPath);
  }
  const uncoveredPaths = [...consumed].filter((path) => !coveredPrefixes.some((prefix) => path.startsWith(prefix))).sort();
  return { uncoveredPaths, violationCount: uncoveredPaths.length };
}

export type GateRoutingReason =
  | 'template-has-gate'          // gate 노드가 있고 문서 전용 건너뛰기 정책이 적용되지 않는다 ⇒ 돈다
  | 'template-has-no-gate'       // 이 그래프에 gate 노드가 없다 ⇒ 안 돈다
  | 'code-changed'               // research-loop 인데 코드가 바뀌었다 ⇒ 돈다
  | 'documents-only'             // research-loop ⊕ 문서만 ⇒ 안 돈다
  | 'changed-files-empty'        // 변경 목록은 얻었지만 비었다 ⇒ 돈다(fail-safe)
  | 'changed-files-unknown';     // ⛔ 못 셌다 ⇒ 돈다(fail-safe)

export function routeGate(
  template: GraphTemplate,
  changedFiles: readonly string[] | undefined,
): { readonly runsGate: boolean; readonly reason: GateRoutingReason } {
  if (!templateHasNode(template, 'gate')) return { runsGate: false, reason: 'template-has-no-gate' };
  // ⛔⭐ 이름은 «파서가 아는 것»이다 — `graph-yaml.ts:201` 이 `docs_only_gate_skip` 을 읽어
  //   `docsOnlyGateSkip` 으로 싣고, `graph-templates.ts:126` 이 컴파일까지 나른다.
  //   🩸 #16678 이 여기서 `template.gatePolicy` 를 읽었다 — 그 이름은 «어느 타입에도 없다».
  //   그래서 tsc 2 · 시험 5 가 main 에서 빨갰고, research-loop 의 건너뛰기가 통째로 사라졌다.
  if (template.docsOnlyGateSkip !== true) return { runsGate: true, reason: 'template-has-gate' };
  if (changedFiles === undefined) return { runsGate: true, reason: 'changed-files-unknown' };
  if (changedFiles.length === 0) return { runsGate: true, reason: 'changed-files-empty' };
  const codeChanged = changedFiles.some((file) => {
    if (isTestConsumedDocument(file)) return true;
    const dot = file.lastIndexOf('.');
    return dot < 0 || !DOCUMENT_ONLY_EXTENSIONS.has(file.slice(dot).toLowerCase());
  });
  return codeChanged
    ? { runsGate: true, reason: 'code-changed' }
    : { runsGate: false, reason: 'documents-only' };
}

/** 이 템플릿이 그 단계를 «갖는가». 안 가지면 그 단계는 돌지 않는다.
 *  📌 research-loop 이 `gate`·`regate` 를 안 갖는 것이 승격의 «관측 가능한» 차이다
 *    (문서만 바뀐 판에는 변경 파일 범위 게이트가 돌 시험이 없다). */
export function templateHasNode(template: GraphTemplate, nodeId: string): boolean {
  return template.nodes.some((node) => node.nodeId === nodeId);
}

/** 컴파일 전 선언에서 실행 템플릿으로 내려오지 않는 노드 필드를 요약한다. */
export function discardedNodeFieldsSummary(spec: GraphTemplateSpec): GraphTemplateCompilation['discardedNodeFields'] {
  return compileGraphTemplate(spec).discardedNodeFields;
}

/** 원장 한 줄의 가독성을 지키면서 진단 가능한 이슈 표본을 남기는 최대 개수다. */
export const GRAPH_TEMPLATE_ISSUES_DISPLAY_LIMIT = 20;

type GraphTemplateIssue = { readonly path: string; readonly message: string };

/** 이슈 원본의 사용 가능 여부, 보이는 모집단, 절단 여부를 분리한다. 빈 배열은 «이슈 없음»이다. */
export function graphTemplateIssuesObservation(issues: readonly GraphTemplateIssue[] | undefined): {
  graphTemplatesIssues: readonly GraphTemplateIssue[] | null;
  graphTemplatesIssuesTruncated: boolean;
} {
  if (issues === undefined) return { graphTemplatesIssues: null, graphTemplatesIssuesTruncated: false };
  return {
    graphTemplatesIssues: issues.slice(0, GRAPH_TEMPLATE_ISSUES_DISPLAY_LIMIT),
    graphTemplatesIssuesTruncated: issues.length > GRAPH_TEMPLATE_ISSUES_DISPLAY_LIMIT,
  };
}

/** 원장에 실을 칸. ⛔ 「무엇을 따랐나」와 「어디서 왔나」와 선언 손실을 함께 싣는다. */
export function graphAuthorityFields(authority: GraphAuthority, template: GraphTemplate): {
  graphAuthoritative: boolean;
  graphAuthoritativeSource: GraphAuthoritySource;
  activeGraphId: string;
  graphTemplatesSource: 'yaml' | 'builtin-fallback' | null;
  graphTemplatesIssueCount: number | null;
  /** `null` means graph template issues were unavailable; an empty array means the loader found no issues. */
  graphTemplatesIssues: readonly GraphTemplateIssue[] | null;
  graphTemplatesIssuesTruncated: boolean;
  /** `null` means the declaration for `activeGraphId` was unavailable; an empty array means it was found with no discarded fields. */
  discardedNodeFields: GraphTemplateCompilation['discardedNodeFields'] | null;
} {
  const spec = GRAPH_SPECS[template.graphId];
  const issues = graphTemplateIssuesObservation(GRAPH_TEMPLATES_ISSUES);
  return {
    graphAuthoritative: authority.enabled,
    graphAuthoritativeSource: authority.source,
    activeGraphId: template.graphId,
    graphTemplatesSource: GRAPH_TEMPLATES_SOURCE ?? null,
    graphTemplatesIssueCount: GRAPH_TEMPLATES_ISSUES?.length ?? null,
    ...issues,
    discardedNodeFields: spec === undefined ? null : discardedNodeFieldsSummary(spec),
  };
}

/** ⭐ 대표 지시 ② «변형» — 「최초 결정 시 해당 템플릿 «변형»을 한다」.
 *
 *  🩸 계기: 3단계가 오버레이 «기계»를 지었는데 `selectOverlays` 를 ***아무도 안 불렀다***.
 *    ⇒ 「지었다」와 「돈다」가 또 갈려 있었다(전반부 노드와 같은 병).
 *
 *  ⛔⭐ 오버레이는 **컴파일 «전» spec** 에 얹힌다 — 컴파일된 템플릿은 결과 «라벨»을
 *    목적지 목록으로 접어 버려서 패치 포인터가 가리킬 자리가 «없다».
 *  ⛔ **선택을 «전부» 낸다** — 얹힌 것만 내면 「왜 안 얹혔나」를 못 묻는다
 *    (`wrong-stage` · `does-not-apply` · `key-absent` · `unparseable` 이 서로 다른 처방이다).
 *  ⛔ **거절은 조용하지 않다** — 패치가 안 물면 `rejections` 로 나오고 «기준 선언»이 그대로 산다. */
/** 오버레이 조건이 «읽을 수 있는» 상태 키. ⛔ 여기 없는 키는 원장에 값이 안 실린다.
 *  🔑 그래서 «떨어뜨리되 말은 한다» — 아래 `stateExtraKeys` 가 그 이름을 남긴다. */
export const OVERLAY_STATE_KEYS = ['attempts', 'goal_id'] as const;

/** `graph-overlay-decision` 원장에 «판정에 실제로 쓴» 상태를 싣는다.
 *  ⛔ `hasOwn` 으로 복사한다 — 그래야 「없음」과 「false」와 「0」이 원장에서 «다른 값»이다.
 *  ⛔⭐ 목록 밖 키는 값을 «안» 싣지만 ***조용히 버리지 않는다*** — `stateExtraKeys` 로 이름을 남긴다.
 *     🩸 이 골이 생긴 이유가 「원장이 판정의 입력을 안 남겨서 손으로 재현하다 오판했다」이므로,
 *        여기서 «조용히» 떨어뜨리면 같은 병을 한 층 아래에서 다시 짓는 것이다. */
export function overlayDecisionObservation<T extends Readonly<Record<string, unknown>>>(input: T & {
  readonly state: Readonly<Record<string, unknown>>;
}): T & { readonly state: Readonly<Record<string, unknown>>; readonly stateExtraKeys?: readonly string[] } {
  const state: Record<string, unknown> = {};
  for (const key of OVERLAY_STATE_KEYS) {
    if (Object.hasOwn(input.state, key)) state[key] = input.state[key];
  }
  const extra = Object.keys(input.state).filter((key) => !(OVERLAY_STATE_KEYS as readonly string[]).includes(key)).sort();
  return { ...input, state, ...(extra.length > 0 ? { stateExtraKeys: extra } : {}) };
}

export function decideTemplate(input: {
  readonly goalType: GoalType | undefined;
  readonly authority: GraphAuthority;
  readonly overlays: readonly GraphOverlaySpec[];
  readonly state: Readonly<Record<string, unknown>>;
  /** ⛔ 단계를 «인자»로 받는다 — ② 변형은 `launch`, ③ 다이나믹은 `runtime` 이고
   *  둘을 섞으면 「최초 결정」이 구현 중 오버레이를 삼킨다. 호출부가 «명시»한다. */
  readonly stage: OverlayStage;
  /** ⛔ spec 출처를 «인자»로 받는다 — 모듈 전역을 읽으면 시험이 실물을 못 갈아 끼운다. */
  readonly specs?: Readonly<Record<string, GraphTemplateSpec>>;
}): {
  readonly template: GraphTemplate;
  readonly selections: readonly OverlaySelection[];
  readonly rejections: readonly OverlayRejection[];
  readonly appliedIds: readonly string[];
  readonly appliedPatches: readonly OverlayPatch[];
} {
  const base = activeTemplate(input.goalType, input.authority);
  if (!input.authority.enabled) return { template: base, selections: [], rejections: [], appliedIds: [], appliedPatches: [] };
  // ⛔ 「최초 결정」은 launch 단계다 — `runtime` 오버레이는 여기서 «후보가 아니다»(③ 다이나믹의 몫).
  const { applied, selections } = selectOverlays(input.overlays, {
    graphId: base.graphId, stage: input.stage, state: input.state,
  });
  if (applied.length === 0) return { template: base, selections, rejections: [], appliedIds: [], appliedPatches: [] };
  const spec = (input.specs ?? GRAPH_SPECS)[base.graphId];
  // ⛔ spec 을 못 얻으면 «변형하지 않는다» — 얹은 척하지 않는다(내장 폴백으로 돌 때가 그렇다).
  if (spec === undefined) return { template: base, selections, rejections: [], appliedIds: [], appliedPatches: [] };
  const result = applyGraphOverlays(spec, applied);
  // ⛔ 전부 아니면 전무다 — 하나라도 거절되면 «기준 선언»으로 돈다(반쯤 얹힌 그래프를 만들지 않는다).
  return result.ok
    ? { template: specToTemplate(result.template), selections, rejections: [], appliedIds: result.overlayIds, appliedPatches: result.patches }
    : { template: base, selections, rejections: result.rejections, appliedIds: [], appliedPatches: [] };
}

/** ⭐ RFC §5 — 노드 «방문 예산»(`max_visits`)을 실행이 «읽게» 한다.
 *
 *  🩸 계기(2026-09-08): `maxVisits` 를 «읽는» 실행 코드가 `src/` 에 «하나도 없었다» —
 *    선언·파싱뿐이라 오버레이가 그 값을 바꿔도 ***관측 가능한 차이를 못 냈다***(사다리 ④).
 *  ⛔ **강제하지 않는다 — 「얼마나 물지」를 «먼저» 재야 한다.**
 *    예산부터 걸면 런이 조용히 죽고, 그때 「원래 그랬나」를 물을 자료가 없다.
 *  ⛔ 되돌림 간선(heal → plan·author·decompose)은 이 예산이 «서고 난 뒤»에 연다 —
 *    예산 없이 되돌리면 무한 루프다. 순서가 뒤바뀌면 안 된다. */
export interface VisitBudgetReading {
  readonly node: string;
  readonly visits: number;
  readonly maxVisits: number;
  /** ⛔ 「넘었다」이지 「막았다」가 아니다 — 이 판은 관측만 한다. */
  readonly exceeded: boolean;
}

/** 걸어온 노드 배열에서 «지금 이 노드»의 예산 판독을 만든다.
 *  ⛔ 선언에 없는 노드는 `null` — 예산을 «지어내지» 않는다(모르는 것은 모른다고 낸다). */
export function visitBudgetOf(
  template: GraphTemplate,
  traversedNodes: readonly string[],
  node: string,
): VisitBudgetReading | null {
  // ⛔ 「이번 진입까지」를 센다 — 진입 «전» 배열이 오므로 +1 이 이번 방문이다.
  return visitBudgetOfVisits(template, node, traversedNodes.filter((n) => n === node).length + 1);
}

/** ⭐ 계수를 직접 받는 판독 — 방문 배열을 보관하지 않는 호출자(전반부)를 위한 진입점.
 *  기존 `visitBudgetOf` 와 «같은 판독»을 내되, 매 방문마다 배열을 만들지 않는다. */
export function visitBudgetOfVisits(
  template: GraphTemplate,
  node: string,
  visits: number,
): VisitBudgetReading | null {
  const declared = template.nodes.find((n) => n.nodeId === node);
  if (declared === undefined) return null;
  return { node, visits, maxVisits: declared.maxVisits, exceeded: visits > declared.maxVisits };
}
