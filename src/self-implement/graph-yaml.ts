import { isRecord } from '../primitives/guards.js';
import { parseGraphRunContract, type GraphRunContractSpec } from './graph-run-contract.js';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { HARNESS_CORE_KINDS, hasNodeKind } from '../graph-kinds/registry.js';
import { parseOverlayCondition } from './graph-overlay-condition.js';

/** ⭐ RFC-graph-templates-as-yaml §5 «0단계» — YAML 저작본을 읽어 실행·해시·원장용 정규형으로.
 *
 *  ⛔⭐ **던지지 않는다** — 호출자는 «언제나» 구조화 결과를 받는다
 *    (`playground-scenario/yaml-parser.ts` 의 계약을 따른다 · 재발명 0).
 *  ⛔⭐ **뿌리를 «인자»로 받는다** — `import.meta.url` 로 코드 트리에 묶지 않는다.
 *    🩸 §4.6 이 지목한 병: `mission-capabilities/registry.ts` 가 그 방식이라 `--root` 격리가 불가능하다. */
export type GraphNodeKind = typeof HARNESS_CORE_KINDS[number];

/** Opaque, namespaced extension payload. Runners hash and persist it but never interpret it. */
export type GraphExtensionMap = Readonly<Record<string, unknown>>;

export interface GraphV2Declaration {
  readonly apiVersion: 'elanous.dev/graph/v2';
  readonly sourceVersion: string;
  readonly layer: 'flow' | 'unit';
  readonly purpose: string;
  readonly cap?: string;
  readonly allow?: Readonly<Record<string, unknown>>;
  readonly packs?: readonly string[];
  readonly observe?: Readonly<Record<string, unknown>>;
  readonly sims?: readonly string[];
  readonly policy?: Readonly<Record<string, unknown>>;
  readonly loop?: { readonly stopWhen?: readonly string[]; readonly budget?: Readonly<Record<string, unknown>> };
}

export interface GraphNodeContract {
  readonly inputs: readonly string[];
  readonly tools: string;
  readonly outputs: readonly string[];
  /** Portable JSON Schema subset checked at the child call boundary. */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

export interface GraphNodeSubscription {
  readonly event: string;
  readonly match?: Readonly<Record<string, string | number | boolean | null>>;
  readonly action: 'wake' | 'invalidate' | 'reroute';
}

export interface GraphHitlOption { readonly key: string; readonly exit: string; readonly default?: boolean }

export interface GraphUnitShape {
  readonly skip?: readonly string[];
  readonly recipe?: Readonly<Record<string, string>>;
  readonly fanoutMax?: number;
}

export interface GraphUnitShapePoints {
  readonly skip?: readonly string[];
  readonly recipe?: readonly string[];
  readonly fanoutMax?: { readonly min: number; readonly max: number };
}

export interface GraphNodeSpec {
  readonly nodeId: string;
  readonly kind: GraphNodeKind | (string & {});
  readonly recipe: string;
  readonly maxVisits: number;
  /** Source-declared structural cap marker, preserved without runner interpretation. */
  readonly cap?: string;
  /** Direct prerequisite node IDs; independent nodes with one source and a common dependent are compiled to a fan-out barrier. */
  readonly needs?: readonly string[];
  /** Contract id required by a generic capability node. */
  readonly requires?: `${string}.${string}@${number}`;
  /** Named shared resources; nodes with a common lock are never dispatched together. */
  readonly resourceLocks?: readonly string[];
  /** L0 journey-stage declaration (optional for other graph templates). */
  readonly journeyStage?: string;
  readonly progress?: readonly string[];
  readonly phases?: readonly string[];
  readonly terminalStages?: readonly string[];
  /** ⭐ 「아크마다 한 번」처럼 «한 노드가 여럿 돈다」를 값으로. 없으면 한 번이다. */
  readonly fanOut?: string;
  readonly contract?: GraphNodeContract;
  /** Declarative human choice keys mapped to graph outcome exits. */
  readonly hitl?: { readonly options: readonly GraphHitlOption[] };
  /** Optional node-scoped payload, used by persisted run-local graph additions. */
  readonly input?: unknown;
  /** Structured event kinds this node is allowed to publish. */
  readonly emits?: readonly string[];
  /** Structured event subscriptions dispatched by the graph runner. */
  readonly subscribes?: readonly GraphNodeSubscription[];
  readonly call?: string;
  /** Bounded changes requested for this unit call. */
  readonly shape?: GraphUnitShape;
  /** Entry selected by this call when a unit exposes more than one entry. */
  readonly callEntry?: string;
  readonly budget?: { readonly innerSteps: number };
  /** ARG L upper bound inherited by this child graph call. */
  readonly allowance?: { readonly innerSteps: number };
  /** L1: skip this optional node when a measured state condition holds. */
  readonly skipWhen?: string;
  /** Opaque extension values and provider-facing context; both are recorded with the graph snapshot. */
  readonly ext?: GraphExtensionMap;
  readonly postconditions?: readonly string[];
  readonly context?: { readonly ext: Readonly<Record<string, GraphExtensionMap>> };
}

export interface GraphEdgeSpec {
  readonly from: string;
  /** 무조건 엣지. `on`/`map` 과 «둘 중 하나»만 쓴다. */
  readonly to?: string;
  /** 조건부 엣지 — 라우터가 읽는 «상태 키». ⛔ 값은 코드가 낸다(RFC §4.3 ⑵). */
  readonly on?: string;
  readonly map?: Readonly<Record<string, string>>;
  /** Explicit fan-out destinations keyed by outcome. Each selected branch runs concurrently and joins at `join`. */
  readonly branches?: Readonly<Record<string, readonly string[]>>;
  readonly join?: string;
  /** Failed warning branches remain visible in the join output but do not fail the barrier. */
  readonly warningBranches?: readonly string[];
  /** 심이 «주입 안 됐을 때» 내려가는 순서. `requires` 는 그 심 이름들. */
  readonly fallback?: readonly { readonly node: string; readonly requires: readonly string[]; readonly observed?: number }[];
  readonly observed?: number;
  /** L1: a measured state condition takes precedence over the default edge. */
  readonly when?: string;
  readonly ext?: GraphExtensionMap;
}

export interface GraphSupervisorSpec {
  readonly ref: `loop:${string}@${number}`;
  readonly role: 'primary' | 'observer' | 'healer';
  readonly scope: 'run' | 'template';
  readonly authority: readonly ('reroute' | 'add-node' | 'repair' | 'hitl' | 'cleanup')[];
  readonly requires: readonly string[];
}

export interface GraphTemplateSpec {
  readonly loop?: { readonly title?: string; readonly description?: string; readonly root?: string; readonly parent?: string; readonly stage?: string;
    readonly trigger?: { readonly cron?: string; readonly events?: readonly string[] }; readonly stopWhen?: string; readonly scope?: Readonly<Record<string, unknown>>;
    readonly authority?: Readonly<Record<string, unknown>>; readonly budget?: Readonly<Record<string, unknown>>; readonly ext?: GraphExtensionMap };
  readonly graphId: string;
  /** Named loop agents allowed to supervise this graph; execution binds their cards separately. */
  readonly supervisors?: readonly GraphSupervisorSpec[];
  /** Preserved v2 source declaration; execution remains through this file's legacy IR fields. */
  readonly ext?: GraphExtensionMap;
  readonly v2?: GraphV2Declaration;
  readonly version: number;
  /** Maximum number of ready fan-out nodes; omitted means legacy unbounded fan-out. */
  readonly maxParallelNodes?: number;
  readonly entryNode: string;
  readonly terminalNodes: readonly string[];
  readonly journeyStages?: readonly string[];
  /** 문서 전용 변경이면 gate 노드를 건너뛸 수 있다는 템플릿 정책. */
  readonly docsOnlyGateSkip?: boolean;
  readonly state?: readonly string[];
  /** ARG L upper bound for this graph's total executed steps. */
  readonly allowance?: { readonly innerSteps: number };
  /** ⭐ 런 계약(선택) — 이 그래프가 «기본으로» 요구하는 실행 칸 등. 발사 인자가 덮는다(graph-run-contract.ts). */
  readonly runContract?: GraphRunContractSpec;
  readonly unit?: { readonly inputs: readonly string[]; readonly outputs: readonly string[]; readonly exits: readonly string[];
    readonly entries?: readonly string[]; readonly shapePoints?: GraphUnitShapePoints };
  /** Non-executable landing policy declaration. The train executor consumes this in a later slice. */
  readonly policy?: LandUnitTrainPolicySpec;
  readonly nodes: readonly GraphNodeSpec[];
  readonly edges: readonly GraphEdgeSpec[];
}

export interface LandUnitTrainPolicySpec {
  readonly express: {
    readonly by: readonly ('queueFlag' | 'predecessorOf' | 'multiplierTier' | 'p0InCutWindow2h')[];
    readonly waitsForBatch: false;
    readonly directive: string;
  };
  readonly batch: {
    readonly min: number;
    readonly max: number;
    readonly groupBy: readonly ('area' | 'cellPrefix')[];
    readonly maxWaitMin: number;
    readonly order: readonly ('express' | 'predecessor' | 'enqueued')[];
    readonly directive: string;
  };
  readonly scenarioPrebuild: {
    readonly source: readonly ('src/ux-sim' | 'scenarios/ux-sim' | 'fake-llm' | 'fake-harness')[];
    readonly mock: 'required';
    readonly directive: string;
  };
  readonly gate: { readonly oncePerBatch: true; readonly directive: string };
  readonly land: {
    readonly perPr: 'squash';
    readonly pinnedHead: true;
    readonly ejectOnFail: true;
    readonly integrationPr: false;
    readonly directive: string;
  };
}

export interface GraphParseIssue {
  readonly path: string;
  readonly message: string;
}

export interface GraphParseResult {
  readonly template?: GraphTemplateSpec;
  readonly errors: readonly GraphParseIssue[];
  readonly warnings: readonly GraphParseIssue[];
}

/** ⚠️ YAML 함정 — `no`/`off`/`yes`/`on` 이 boolean 으로 파싱된다(Norway 문제). 노드 이름에 쓰면 조용히 깨진다. */
const YAML_TRAP_WORDS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', '~']);
export const L1_PROTECTED_ROUTE_NODES = new Set(['gate', 'regate', 'review', 'merge', 'freeze-check']);

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function validUnitValueSchema(value: unknown, depth = 0): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 8) return false;
  const schema = value as Record<string, unknown>;
  if (Object.keys(schema).some(key => !['type', 'required', 'properties', 'items', 'enum'].includes(key)) ||
      typeof schema.type !== 'string' || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)) return false;
  if (schema.required !== undefined && (schema.type !== 'object' || !Array.isArray(schema.required) ||
      !schema.required.every(key => typeof key === 'string' && key.length > 0))) return false;
  if (schema.properties !== undefined && (schema.type !== 'object' || !schema.properties ||
      typeof schema.properties !== 'object' || Array.isArray(schema.properties) ||
      !Object.values(schema.properties).every(child => validUnitValueSchema(child, depth + 1)))) return false;
  if (schema.items !== undefined && (schema.type !== 'array' || !validUnitValueSchema(schema.items, depth + 1))) return false;
  return schema.enum === undefined || (Array.isArray(schema.enum) && schema.enum.length > 0);
}

/** ⛔ 던지지 않는다. 못 읽은 것은 `errors` 로, 읽었지만 의심스러운 것은 `warnings` 로 낸다. */
export function parseGraphTemplateYaml(source: string, label = '<inline>'): GraphParseResult {
  const errors: GraphParseIssue[] = [];
  const warnings: GraphParseIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    return { errors: [{ path: label, message: `YAML 파싱 실패: ${error instanceof Error ? error.message : String(error)}` }], warnings };
  }
  if (raw === null || typeof raw !== 'object') {
    return { errors: [{ path: label, message: 'YAML 최상위가 맵이 아니다' }], warnings };
  }
  const doc = raw as Record<string, unknown>;

  const graphId = typeof doc.graph_id === 'string' ? doc.graph_id : undefined;
  if (graphId === undefined) errors.push({ path: `${label}/graph_id`, message: 'graph_id 가 없거나 문자열이 아니다' });
  const supervisors: GraphSupervisorSpec[] = [];
  if (doc.supervisors !== undefined) {
    if (!Array.isArray(doc.supervisors) || doc.supervisors.length === 0) {
      errors.push({ path: `${label}/supervisors`, message: 'supervisors 는 비어 있지 않은 목록이어야 한다' });
    } else {
      const refs = new Set<string>();
      let primaryCount = 0;
      for (const [index, value] of doc.supervisors.entries()) {
        const at = `${label}/supervisors/${index}`;
        if (!isRecord(value) || Object.keys(value).some(key => !['ref', 'role', 'scope', 'authority', 'requires'].includes(key))) {
          errors.push({ path: at, message: '감독자는 ref·role·scope·authority·requires 만 가진 맵이어야 한다' });
          continue;
        }
        if (typeof value.ref !== 'string' || !/^loop:[a-z][a-z0-9-]*@[1-9]\d*$/.test(value.ref))
          errors.push({ path: `${at}/ref`, message: 'ref 는 loop:<id>@<positive version> 이어야 한다' });
        if (value.role !== 'primary' && value.role !== 'observer' && value.role !== 'healer')
          errors.push({ path: `${at}/role`, message: 'role 은 primary|observer|healer 이어야 한다' });
        if (value.scope !== undefined && value.scope !== 'run' && value.scope !== 'template')
          errors.push({ path: `${at}/scope`, message: 'scope 는 run|template 이어야 한다' });
        const authorities = ['reroute', 'add-node', 'repair', 'hitl', 'cleanup'];
        if (!Array.isArray(value.authority) || value.authority.length === 0 ||
            value.authority.some(item => typeof item !== 'string' || !authorities.includes(item)) ||
            new Set(value.authority).size !== value.authority.length)
          errors.push({ path: `${at}/authority`, message: 'authority 는 중복 없는 허용 동사 목록이어야 한다' });
        if (value.requires !== undefined && (!Array.isArray(value.requires) ||
            value.requires.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9.-]*\/[a-z][a-z0-9-]*$/.test(item)) ||
            new Set(value.requires).size !== value.requires.length))
          errors.push({ path: `${at}/requires`, message: 'requires 는 중복 없는 이름공간 확장 목록이어야 한다' });
        if (typeof value.ref === 'string') {
          if (refs.has(value.ref)) errors.push({ path: `${at}/ref`, message: '감독자 ref 는 중복될 수 없다' });
          refs.add(value.ref);
        }
        if (value.role === 'primary') primaryCount++;
        if (typeof value.ref === 'string' && /^loop:[a-z][a-z0-9-]*@[1-9]\d*$/.test(value.ref) &&
            (value.role === 'primary' || value.role === 'observer' || value.role === 'healer') &&
            (value.scope === undefined || value.scope === 'run' || value.scope === 'template') &&
            Array.isArray(value.authority) && value.authority.length > 0 &&
            value.authority.every(item => authorities.includes(item)) &&
            (value.requires === undefined || Array.isArray(value.requires)))
          supervisors.push({ ref: value.ref as GraphSupervisorSpec['ref'], role: value.role,
            scope: (value.scope ?? 'run') as GraphSupervisorSpec['scope'],
            authority: value.authority as GraphSupervisorSpec['authority'], requires: (value.requires ?? []) as string[] });
      }
      if (primaryCount !== 1) errors.push({ path: `${label}/supervisors`, message: '감독자 목록에는 primary 가 정확히 하나여야 한다' });
    }
  }
  const policy = graphId === 'land' ? parseLandUnitTrainPolicy(doc.policy, `${label}/policy`, errors) : undefined;
  if (graphId === 'land' && doc.policy === undefined) errors.push({ path: `${label}/policy`, message: 'land 유닛에는 착지 열차 policy 가 필요하다' });
  const version = typeof doc.version === 'number' && Number.isInteger(doc.version) ? doc.version : undefined;
  if (version === undefined) errors.push({ path: `${label}/version`, message: 'version 이 없거나 정수가 아니다' });
  const entryNode = typeof doc.entry_node === 'string' ? doc.entry_node : undefined;
  if (entryNode === undefined) errors.push({ path: `${label}/entry_node`, message: 'entry_node 가 없거나 문자열이 아니다' });
  const maxParallelNodes = doc.max_parallel_nodes === undefined ? undefined
    : Number.isSafeInteger(doc.max_parallel_nodes) && (doc.max_parallel_nodes as number) > 0 ? doc.max_parallel_nodes as number : undefined;
  if (doc.max_parallel_nodes !== undefined && maxParallelNodes === undefined)
    errors.push({ path: `${label}/max_parallel_nodes`, message: 'max_parallel_nodes 는 1 이상의 안전한 정수여야 한다' });

  const terminalNodes = asArray(doc.terminal_nodes).filter((v): v is string => typeof v === 'string');
  if (terminalNodes.length === 0) errors.push({ path: `${label}/terminal_nodes`, message: 'terminal_nodes 가 비었다 — 끝날 수 없는 그래프다' });
  let allowance: GraphTemplateSpec['allowance'];
  if (doc.allowance !== undefined) {
    const value = doc.allowance as Record<string, unknown> | undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.inner_steps) ||
        (value.inner_steps as number) < 1 || Object.keys(value).some(key => key !== 'inner_steps'))
      errors.push({ path: `${label}/allowance/inner_steps`, message: 'inner_steps 는 1 이상의 안전한 정수여야 한다' });
    else allowance = { innerSteps: value.inner_steps as number };
  }

  const journeyStages = doc.journey_stages;
  if (journeyStages !== undefined && (!Array.isArray(journeyStages) || journeyStages.length === 0
    || !journeyStages.every((stage) => typeof stage === 'string' && stage.trim())
    || new Set(journeyStages).size !== journeyStages.length)) {
    errors.push({ path: `${label}/journey_stages`, message: 'journey_stages 는 중복 없는 비어 있지 않은 문자열 목록이어야 한다' });
  }
  const nodes: GraphNodeSpec[] = [];
  for (const [index, entry] of asArray(doc.nodes).entries()) {
    const at = `${label}/nodes/${index}`;
    if (entry === null || typeof entry !== 'object') { errors.push({ path: at, message: '노드가 맵이 아니다' }); continue; }
    const n = entry as Record<string, unknown>;
    const nodeId = n.node_id;
    if (typeof nodeId !== 'string') {
      // ⚠️ Norway 문제 — `node_id: no` 는 boolean false 로 파싱된다.
      errors.push({ path: `${at}/node_id`, message: typeof nodeId === 'boolean' ? 'node_id 가 boolean 으로 파싱됐다(YAML Norway 문제 — 따옴표로 감싸라)' : 'node_id 가 없거나 문자열이 아니다' });
      continue;
    }
    if (YAML_TRAP_WORDS.has(nodeId.toLowerCase())) warnings.push({ path: `${at}/node_id`, message: `'${nodeId}' 는 YAML 이 다른 값으로 읽을 수 있는 낱말이다` });
    const kind = n.kind;
    if (typeof kind !== 'string' || !hasNodeKind('harness', kind)) {
      errors.push({ path: `${at}/kind`, message: `kind 는 ${HARNESS_CORE_KINDS.join('|')} 또는 등록된 플러그인 종류여야 한다 (받은 값: ${JSON.stringify(kind)})` });
      continue;
    }
    const recipe = n.recipe;
    if (typeof recipe !== 'string') { errors.push({ path: `${at}/recipe`, message: 'recipe 가 없다 — 이 노드가 «무엇으로» 도는지 모른다' }); continue; }
    if (n.requires !== undefined && (typeof n.requires !== 'string' || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*@[1-9]\d*$/.test(n.requires)))
      errors.push({ path: `${at}/requires`, message: 'requires 는 <namespace>.<contract>@<positive version> 이어야 한다' });
    const maxVisits = n.max_visits;
    if (typeof maxVisits !== 'number' || !Number.isInteger(maxVisits) || maxVisits < 1) {
      errors.push({ path: `${at}/max_visits`, message: 'max_visits 는 1 이상의 정수여야 한다' });
      continue;
    }
    let needs: string[] | undefined;
    if (n.needs !== undefined) {
      if (!Array.isArray(n.needs) || !n.needs.every((dependency) => typeof dependency === 'string' && dependency.trim()) ||
          new Set(n.needs as string[]).size !== n.needs.length || (n.needs as string[]).includes(nodeId)) {
        errors.push({ path: `${at}/needs`, message: 'needs 는 자기 자신·중복·빈 값을 포함하지 않는 노드 id 목록이어야 한다' });
      } else needs = n.needs as string[];
    }
    let resourceLocks: string[] | undefined;
    if (n.resource_locks !== undefined) {
      if (!Array.isArray(n.resource_locks) || !n.resource_locks.every((lock) => typeof lock === 'string' && lock.trim()) ||
          new Set(n.resource_locks as string[]).size !== n.resource_locks.length) {
        errors.push({ path: `${at}/resource_locks`, message: 'resource_locks 는 중복 없는 비어 있지 않은 문자열 목록이어야 한다' });
      } else resourceLocks = n.resource_locks as string[];
    }
    if (n.journey_stage !== undefined && (typeof n.journey_stage !== 'string' || !n.journey_stage.trim()
      || (Array.isArray(journeyStages) && !journeyStages.includes(n.journey_stage)))) {
      errors.push({ path: `${at}/journey_stage`, message: typeof n.journey_stage === 'string' && n.journey_stage.trim()
        ? `journey_stage '${n.journey_stage}' 가 journey_stages 목록에 없다`
        : 'journey_stage 는 비어 있지 않은 문자열이어야 한다' });
      continue;
    }
    if (n.skip_when !== undefined) {
      if (typeof n.skip_when !== 'string' || !parseOverlayCondition(n.skip_when).ok)
        errors.push({ path: `${at}/skip_when`, message: 'skip_when 은 오버레이 조건 한 개(key op literal)여야 한다' });
      if (L1_PROTECTED_ROUTE_NODES.has(nodeId) || kind === 'gate' || terminalNodes.includes(nodeId))
        errors.push({ path: `${at}/skip_when`, message: `'${nodeId}' 는 필수 검증·착지·종결 노드라 건너뛸 수 없다` });
    }
    const contractRaw = n.contract as Record<string, unknown> | undefined;
    const contract: GraphNodeContract | undefined = contractRaw && typeof contractRaw === 'object'
      ? {
          inputs: asArray(contractRaw.inputs).filter((v): v is string => typeof v === 'string'),
          tools: typeof contractRaw.tools === 'string' ? contractRaw.tools : '',
          outputs: asArray(contractRaw.outputs).filter((v): v is string => typeof v === 'string'),
          ...(validUnitValueSchema(contractRaw.input_schema) ? { inputSchema: contractRaw.input_schema } : {}),
          ...(validUnitValueSchema(contractRaw.output_schema) ? { outputSchema: contractRaw.output_schema } : {}),
        }
      : undefined;
    let emits: string[] | undefined;
    if (n.emits !== undefined) {
      if (!Array.isArray(n.emits) || !n.emits.every((event) => typeof event === 'string' && event.trim()) ||
          new Set(n.emits).size !== n.emits.length) {
        errors.push({ path: `${at}/emits`, message: 'emits 는 중복 없는 비어 있지 않은 문자열 목록이어야 한다' });
      } else emits = n.emits as string[];
    }
    let subscribes: GraphNodeSubscription[] | undefined;
    if (n.subscribes !== undefined) {
      if (!Array.isArray(n.subscribes)) {
        errors.push({ path: `${at}/subscribes`, message: 'subscribes 는 구독 선언 목록이어야 한다' });
      } else {
        subscribes = [];
        for (const [subscriptionIndex, raw] of n.subscribes.entries()) {
          const subscriptionPath = `${at}/subscribes/${subscriptionIndex}`;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            errors.push({ path: subscriptionPath, message: '구독 선언은 맵이어야 한다' });
            continue;
          }
          const item = raw as Record<string, unknown>;
          const allowed = new Set(['event', 'match', 'action']);
          if (Object.keys(item).some((key) => !allowed.has(key)))
            errors.push({ path: subscriptionPath, message: '구독 선언에는 event·match·action만 허용된다' });
          if (typeof item.event !== 'string' || !item.event.trim())
            errors.push({ path: `${subscriptionPath}/event`, message: 'event 는 비어 있지 않은 문자열이어야 한다' });
          if (item.action !== 'wake' && item.action !== 'invalidate' && item.action !== 'reroute')
            errors.push({ path: `${subscriptionPath}/action`, message: 'action 은 wake|invalidate|reroute 중 하나여야 한다' });
          let match: Record<string, string | number | boolean | null> | undefined;
          if (item.match !== undefined) {
            if (!item.match || typeof item.match !== 'object' || Array.isArray(item.match)) {
              errors.push({ path: `${subscriptionPath}/match`, message: 'match 는 스칼라 값 맵이어야 한다' });
            } else {
              const entries = Object.entries(item.match as Record<string, unknown>);
              if (entries.some(([key, value]) => !key.trim() || !(value === null || ['string', 'number', 'boolean'].includes(typeof value))))
                errors.push({ path: `${subscriptionPath}/match`, message: 'match 키는 비어 있을 수 없고 값은 문자열·수·불리언·null이어야 한다' });
              else match = Object.fromEntries(entries) as Record<string, string | number | boolean | null>;
            }
          }
          if (typeof item.event === 'string' && item.event.trim() &&
              (item.action === 'wake' || item.action === 'invalidate' || item.action === 'reroute') &&
              (item.match === undefined || match !== undefined)) {
            subscribes.push({ event: item.event, action: item.action, ...(match === undefined ? {} : { match }) });
          }
        }
      }
    }
    let hitl: GraphNodeSpec['hitl'];
    if (n.hitl !== undefined) {
      const declaration = n.hitl && typeof n.hitl === 'object' && !Array.isArray(n.hitl) ? n.hitl as Record<string, unknown> : undefined;
      if (!declaration || Object.keys(declaration).some(key => key !== 'options') || !Array.isArray(declaration.options) || declaration.options.length === 0) {
        errors.push({ path: `${at}/hitl`, message: 'hitl 은 options 를 가진 맵이어야 한다' });
      } else {
        const options: GraphHitlOption[] = [];
        const keys = new Set<string>();
        let defaults = 0;
        for (const [optionIndex, rawOption] of declaration.options.entries()) {
          const optionPath = `${at}/hitl/options/${optionIndex}`;
          const option = rawOption && typeof rawOption === 'object' && !Array.isArray(rawOption) ? rawOption as Record<string, unknown> : undefined;
          if (!option || Object.keys(option).some(key => !['key', 'exit', 'default'].includes(key)) ||
              typeof option.key !== 'string' || !option.key.trim() || typeof option.exit !== 'string' || !option.exit.trim() ||
              (option.default !== undefined && typeof option.default !== 'boolean')) {
            errors.push({ path: optionPath, message: 'HITL 선택지는 key·exit 문자열과 선택적 boolean default 만 허용한다' });
            continue;
          }
          if (keys.has(option.key)) errors.push({ path: `${optionPath}/key`, message: 'HITL key 는 중복될 수 없다' });
          keys.add(option.key);
          if (option.default === true) defaults++;
          options.push({ key: option.key, exit: option.exit, ...(option.default === true ? { default: true } : {}) });
        }
        if (defaults > 1) errors.push({ path: `${at}/hitl/options`, message: 'HITL 기본 선택지는 하나만 허용한다' });
        if (options.length === declaration.options.length) hitl = { options };
      }
      if (kind !== 'hitl') errors.push({ path: `${at}/hitl`, message: 'hitl 선언은 kind: hitl 에서만 허용된다' });
    }
    // A subgraph node becomes a unit call only when it names `call:`; without it the node keeps the
    // pre-unit meaning (catalog role / recipe node), so existing declarations stay valid.
    let call: string | undefined;
    let shape: GraphUnitShape | undefined;
    if (kind === 'subgraph' && n.call !== undefined) {
      if (typeof n.call === 'string') call = n.call;
      else if (n.call && typeof n.call === 'object' && !Array.isArray(n.call)) {
        const declaration = n.call as Record<string, unknown>;
        if (Object.keys(declaration).some(key => !['unit', 'shape'].includes(key)))
          errors.push({ path: `${at}/call`, message: 'call 맵은 unit·shape 만 허용한다' });
        if (typeof declaration.unit === 'string') call = declaration.unit;
        else errors.push({ path: `${at}/call/unit`, message: 'unit 은 id@정수판 또는 id@^주판이어야 한다' });
        if (declaration.shape !== undefined) {
          const rawShape = declaration.shape && typeof declaration.shape === 'object' && !Array.isArray(declaration.shape)
            ? declaration.shape as Record<string, unknown> : undefined;
          if (!rawShape || Object.keys(rawShape).some(key => !['skip', 'recipe', 'fanout_max'].includes(key))) {
            errors.push({ path: `${at}/call/shape`, message: 'shape 는 skip·recipe·fanout_max 만 허용하는 맵이어야 한다' });
          } else {
            const parsedShape: { skip?: string[]; recipe?: Record<string, string>; fanoutMax?: number } = {};
            if (rawShape.skip !== undefined) {
              if (!Array.isArray(rawShape.skip) || !rawShape.skip.every(value => typeof value === 'string' && value.trim()) ||
                  new Set(rawShape.skip).size !== rawShape.skip.length)
                errors.push({ path: `${at}/call/shape/skip`, message: 'skip 은 중복 없는 노드 id 목록이어야 한다' });
              else parsedShape.skip = rawShape.skip as string[];
            }
            if (rawShape.recipe !== undefined) {
              const replacements = rawShape.recipe && typeof rawShape.recipe === 'object' && !Array.isArray(rawShape.recipe)
                ? rawShape.recipe as Record<string, unknown> : undefined;
              if (!replacements || Object.entries(replacements).some(([node, value]) => !node.trim() || typeof value !== 'string' || !value.trim()))
                errors.push({ path: `${at}/call/shape/recipe`, message: 'recipe 는 노드 id 에 비어 있지 않은 recipe 를 대응하는 맵이어야 한다' });
              else parsedShape.recipe = Object.fromEntries(Object.entries(replacements) as [string, string][]);
            }
            if (rawShape.fanout_max !== undefined) {
              if (!Number.isSafeInteger(rawShape.fanout_max) || (rawShape.fanout_max as number) < 1)
                errors.push({ path: `${at}/call/shape/fanout_max`, message: 'fanout_max 는 1 이상의 안전한 정수여야 한다' });
              else parsedShape.fanoutMax = rawShape.fanout_max as number;
            }
            if (Object.keys(rawShape).length === 0) errors.push({ path: `${at}/call/shape`, message: 'shape 요청이 비었다' });
            if (Object.keys(parsedShape).length > 0) shape = parsedShape;
          }
        }
      } else errors.push({ path: `${at}/call`, message: 'call 은 unit id 문자열 또는 { unit, shape } 맵이어야 한다' });
    }
    if (kind === 'subgraph' && (n.call !== undefined || n.budget !== undefined || n.allowance !== undefined || n.call_entry !== undefined)) {
      if (!call || !/^[A-Za-z0-9][A-Za-z0-9._-]*@(?:\^?[1-9]\d*)$/.test(call))
        errors.push({ path: `${at}/call`, message: 'call 은 id@정수판 또는 id@^주판이어야 한다' });
      const budget = n.budget as Record<string, unknown> | undefined;
      if (!budget || typeof budget !== 'object' || Array.isArray(budget) ||
          !Number.isSafeInteger(budget.inner_steps) || (budget.inner_steps as number) < 1 || Object.keys(budget).some(key => key !== 'inner_steps'))
        errors.push({ path: `${at}/budget/inner_steps`, message: 'inner_steps 는 1 이상의 안전한 정수여야 한다' });
      if (n.allowance !== undefined) {
        const childAllowance = n.allowance as Record<string, unknown> | undefined;
        if (!childAllowance || typeof childAllowance !== 'object' || Array.isArray(childAllowance) ||
            !Number.isSafeInteger(childAllowance.inner_steps) || (childAllowance.inner_steps as number) < 1 ||
            Object.keys(childAllowance).some(key => key !== 'inner_steps'))
          errors.push({ path: `${at}/allowance/inner_steps`, message: 'inner_steps 는 1 이상의 안전한 정수여야 한다' });
      }
      if (!contractRaw || !Array.isArray(contractRaw.inputs) || !contractRaw.inputs.every(v => typeof v === 'string') ||
          !Array.isArray(contractRaw.outputs) || !contractRaw.outputs.every(v => typeof v === 'string'))
        errors.push({ path: `${at}/contract`, message: 'subgraph 에는 inputs·outputs 계약이 필요하다' });
      for (const field of ['input_schema', 'output_schema'] as const) {
        if (contractRaw?.[field] !== undefined && (!validUnitValueSchema(contractRaw[field]) ||
          (contractRaw[field] as Record<string, unknown>).type !== 'object'))
          errors.push({ path: `${at}/contract/${field}`, message: 'unit 값 계약은 object JSON Schema subset 이어야 한다' });
      }
      if (recipe !== 'none') errors.push({ path: `${at}/recipe`, message: 'subgraph 는 recipe 를 실행하지 않는다' });
      if (n.call_entry !== undefined && (typeof n.call_entry !== 'string' || !n.call_entry.trim()))
        errors.push({ path: `${at}/call_entry`, message: 'call_entry 는 비어 있지 않은 노드 id 여야 한다' });
    } else if (kind !== 'subgraph' && (n.call !== undefined || n.budget !== undefined || n.allowance !== undefined || n.call_entry !== undefined)) {
      errors.push({ path: at, message: 'call·call_entry·budget·allowance 은 subgraph 전용이다' });
    }
    // ⛔ 계약이 없으면 「이 노드가 무엇을 할 수 있나」를 답할 수 없다 — 경고로 남긴다(거절은 오버레이 쪽).
    if (contract === undefined) warnings.push({ path: `${at}/contract`, message: '계약(inputs·tools·outputs)이 없다 — 권한을 코드에서만 알 수 있다' });
    else if (contract.tools === '') warnings.push({ path: `${at}/contract/tools`, message: 'tools 가 비었다' });

    nodes.push({
      nodeId, kind, recipe, maxVisits,
      ...(typeof n.requires === 'string' ? { requires: n.requires as `${string}.${string}@${number}` } : {}),
      ...(needs === undefined ? {} : { needs }),
      ...(resourceLocks === undefined ? {} : { resourceLocks }),
      ...(typeof n.journey_stage === 'string' ? { journeyStage: n.journey_stage } : {}),
      ...(Array.isArray(n.progress) ? { progress: n.progress.filter((v): v is string => typeof v === 'string') } : {}),
      ...(Array.isArray(n.phases) ? { phases: n.phases.filter((v): v is string => typeof v === 'string') } : {}),
      ...(Array.isArray(n.terminal_stages) ? { terminalStages: n.terminal_stages.filter((v): v is string => typeof v === 'string') } : {}),
      ...(typeof n.fan_out === 'string' ? { fanOut: n.fan_out } : {}),
      ...(contract ? { contract } : {}),
      ...(hitl ? { hitl } : {}),
      ...(Object.hasOwn(n, 'input') ? { input: n.input } : {}),
      ...(emits === undefined ? {} : { emits }),
      ...(subscribes === undefined ? {} : { subscribes }),
      ...(kind === 'subgraph' && call ? { call } : {}),
      ...(kind === 'subgraph' && shape ? { shape } : {}),
      ...(kind === 'subgraph' && typeof n.call_entry === 'string' ? { callEntry: n.call_entry } : {}),
      ...(kind === 'subgraph' && n.budget && typeof n.budget === 'object' && !Array.isArray(n.budget) &&
        typeof (n.budget as Record<string, unknown>).inner_steps === 'number'
        ? { budget: { innerSteps: (n.budget as { inner_steps: number }).inner_steps } } : {}),
      ...(kind === 'subgraph' && n.allowance && typeof n.allowance === 'object' && !Array.isArray(n.allowance) &&
        typeof (n.allowance as Record<string, unknown>).inner_steps === 'number'
        ? { allowance: { innerSteps: (n.allowance as { inner_steps: number }).inner_steps } } : {}),
      ...(typeof n.skip_when === 'string' ? { skipWhen: n.skip_when } : {}),
    });
  }
  if (nodes.length === 0) errors.push({ path: `${label}/nodes`, message: '노드가 하나도 없다' });

  const known = new Set(nodes.map((n) => n.nodeId));
  for (const node of nodes) for (const dependency of node.needs ?? []) {
    if (!known.has(dependency)) errors.push({ path: `${label}/nodes/${node.nodeId}/needs`, message: `'${dependency}' 는 선언된 노드가 아니다` });
  }
  const dependencyVisiting = new Set<string>();
  const dependencyVisited = new Set<string>();
  const visitDependency = (nodeId: string): void => {
    if (dependencyVisited.has(nodeId)) return;
    if (dependencyVisiting.has(nodeId)) {
      errors.push({ path: `${label}/nodes/${nodeId}/needs`, message: 'needs 의존성 그래프에 순환이 있다' });
      return;
    }
    dependencyVisiting.add(nodeId);
    for (const dependency of nodes.find((node) => node.nodeId === nodeId)?.needs ?? []) {
      if (known.has(dependency)) visitDependency(dependency);
    }
    dependencyVisiting.delete(nodeId);
    dependencyVisited.add(nodeId);
  };
  for (const node of nodes) visitDependency(node.nodeId);
  const edges: GraphEdgeSpec[] = [];
  for (const [index, entry] of asArray(doc.edges).entries()) {
    const at = `${label}/edges/${index}`;
    if (entry === null || typeof entry !== 'object') { errors.push({ path: at, message: '엣지가 맵이 아니다' }); continue; }
    const e = entry as Record<string, unknown>;
    const from = e.from;
    if (typeof from !== 'string') { errors.push({ path: `${at}/from`, message: 'from 이 없거나 문자열이 아니다' }); continue; }
    if (!known.has(from)) { errors.push({ path: `${at}/from`, message: `'${from}' 은 선언된 노드가 아니다` }); continue; }
    const hasTo = typeof e.to === 'string';
    const hasMap = e.map !== null && typeof e.map === 'object';
    const hasExplicitBranches = e.branches !== null && typeof e.branches === 'object' && !Array.isArray(e.branches);
    const mappedTargets = hasMap ? Object.values(e.map as Record<string, unknown>).filter((value): value is string => typeof value === 'string') : [];
    const needsBranches = nodes.filter((node) => node.needs?.includes(from) && !mappedTargets.includes(node.nodeId));
    const needsJoins = needsBranches.length >= 2
      ? nodes.filter((node) => node.needs?.length === needsBranches.length &&
        needsBranches.every((branch) => node.needs?.includes(branch.nodeId))) : [];
    let derivedBranches: Record<string, string[]> | undefined;
    let derivedJoin: string | undefined;
    if (!hasExplicitBranches && needsBranches.length >= 2) {
      if (needsJoins.length !== 1) {
        errors.push({ path: `${at}/from`, message: `needs 가 병렬 노드 ${needsBranches.map((node) => node.nodeId).join(', ')} 를 선언했지만 공통 join needs 를 가진 노드가 정확히 하나여야 한다` });
      } else {
        derivedJoin = needsJoins[0]!.nodeId;
        const branchOutcomes = ['ok', 'fail', 'error'].filter((outcome) => !(hasMap && Object.hasOwn(e.map as object, outcome)));
        if (branchOutcomes.length) derivedBranches = Object.fromEntries(branchOutcomes.map((outcome) =>
          [outcome, needsBranches.map((node) => node.nodeId)]));
      }
    }
    const branchDeclaration: Record<string, unknown> | undefined = hasExplicitBranches
      ? e.branches as Record<string, unknown> : derivedBranches;
    const joinId = typeof e.join === 'string' ? e.join : derivedJoin;
    const hasBranches = branchDeclaration !== undefined;
    if (e.when !== undefined && (typeof e.when !== 'string' || !parseOverlayCondition(e.when).ok))
      errors.push({ path: `${at}/when`, message: 'when 은 오버레이 조건 한 개(key op literal)여야 한다' });
    if (e.when !== undefined && (L1_PROTECTED_ROUTE_NODES.has(from) || nodes.some(node => node.nodeId === from && node.kind === 'gate') || terminalNodes.includes(from)))
      errors.push({ path: `${at}/when`, message: `'${from}' 의 필수 검증·착지 결과는 when 간선으로 덮을 수 없다` });
    if (e.when !== undefined && (!hasTo || hasMap || e.on !== undefined))
      errors.push({ path: `${at}/when`, message: 'when 은 to 간선에서만 쓴다' });
    if (!hasTo && !hasMap && !hasBranches) {
      errors.push({ path: at, message: 'to 또는 map/branches 조합을 써야 한다' });
      continue;
    }
    if (hasTo && (hasMap || hasBranches)) {
      errors.push({ path: at, message: 'to 는 map·branches 와 함께 쓸 수 없다' });
      continue;
    }
    const map: Record<string, string> = {};
    if (hasMap) {
      for (const [key, value] of Object.entries(e.map as Record<string, unknown>)) {
        if (typeof value !== 'string') { errors.push({ path: `${at}/map/${key}`, message: '목적지가 문자열이 아니다' }); continue; }
        if (!known.has(value)) { errors.push({ path: `${at}/map/${key}`, message: `'${value}' 는 선언된 노드가 아니다` }); continue; }
        map[key] = value;
      }
      if (typeof e.on !== 'string') errors.push({ path: `${at}/on`, message: 'map 을 쓰면 on(라우터가 읽는 상태 키)이 필요하다' });
    }
    let branches: Record<string, readonly string[]> | undefined;
    let warningBranches: readonly string[] | undefined;
    if (hasBranches) {
      branches = {};
      for (const [outcome, destinations] of Object.entries(branchDeclaration!)) {
        if (!Array.isArray(destinations) || destinations.length < 2 || !destinations.every((value) => typeof value === 'string')) {
          errors.push({ path: `${at}/branches/${outcome}`, message: 'branches 목적지는 두 개 이상의 노드 id 목록이어야 한다' });
          continue;
        }
        if (new Set(destinations).size !== destinations.length)
          errors.push({ path: `${at}/branches/${outcome}`, message: 'branches 목적지는 중복될 수 없다' });
        for (const [index, destination] of destinations.entries()) {
          if (!known.has(destination)) errors.push({ path: `${at}/branches/${outcome}/${index}`, message: `'${destination}' 는 선언된 노드가 아니다` });
        }
        branches[outcome] = destinations as string[];
      }
      if (typeof e.on !== 'string' || typeof joinId !== 'string' || !known.has(joinId))
        errors.push({ path: at, message: 'branches 에는 on 과 선언된 join 노드가 필요하다' });
      if (e.fallback !== undefined || e.when !== undefined) errors.push({ path: at, message: 'branches 는 fallback·when 과 함께 쓸 수 없다' });
      if (hasMap && Object.keys(map).some((outcome) => Object.hasOwn(branchDeclaration!, outcome)))
        errors.push({ path: `${at}/branches`, message: 'map 과 branches 의 outcome 키는 겹칠 수 없다' });
      if (e.warning_branches !== undefined) {
        if (!Array.isArray(e.warning_branches) || e.warning_branches.some((branch) => typeof branch !== 'string' || !branch.trim()) ||
            new Set(e.warning_branches).size !== e.warning_branches.length ||
            e.warning_branches.some((branch) => !Object.values(branches!).some((destinations) => destinations.includes(branch as string)))) {
          errors.push({ path: `${at}/warning_branches`, message: 'warning_branches 는 중복 없는 branches 목적지 목록이어야 한다' });
        } else warningBranches = e.warning_branches as string[];
      }
    }
    if (hasTo && !known.has(e.to as string)) { errors.push({ path: `${at}/to`, message: `'${String(e.to)}' 는 선언된 노드가 아니다` }); continue; }

    const fallback = asArray(e.fallback).flatMap((f, fi) => {
      if (f === null || typeof f !== 'object') { errors.push({ path: `${at}/fallback/${fi}`, message: '폴백이 맵이 아니다' }); return []; }
      const fb = f as Record<string, unknown>;
      if (typeof fb.node !== 'string' || !known.has(fb.node)) { errors.push({ path: `${at}/fallback/${fi}/node`, message: '폴백 목적지가 선언된 노드가 아니다' }); return []; }
      return [{
        node: fb.node,
        requires: asArray(fb.requires).filter((v): v is string => typeof v === 'string'),
        ...(typeof fb.observed === 'number' ? { observed: fb.observed } : {}),
      }];
    });

    edges.push({
      from,
      ...(hasTo ? { to: e.to as string } : {}),
      ...(hasMap ? { on: String(e.on), map } : {}),
      ...(branches ? { on: String(e.on), branches, join: String(joinId), ...(warningBranches ? { warningBranches } : {}) } : {}),
      ...(fallback.length > 0 ? { fallback } : {}),
      ...(typeof e.observed === 'number' ? { observed: e.observed } : {}),
      ...(typeof e.when === 'string' ? { when: e.when } : {}),
    });
  }
  for (const node of nodes) {
    if (node.skipWhen === undefined) continue;
    const outgoing = edges.filter(edge => edge.from === node.nodeId);
    if (outgoing.length !== 1 || outgoing[0]?.to === undefined || outgoing[0]?.when !== undefined ||
        (outgoing[0]?.fallback?.length ?? 0) > 0)
      errors.push({ path: `${label}/nodes/${node.nodeId}/skip_when`, message: 'skip_when 노드에는 분기 없는 무조건 to 후속 간선 하나만 필요하다' });
  }
  for (const edge of edges) {
    if (edge.when === undefined) continue;
    if (!edges.some(candidate => candidate.from === edge.from && candidate.when === undefined))
      errors.push({ path: `${label}/edges/${edge.from}/when`, message: 'when 간선에는 모호·미관측 때 탈 무조건 기본 간선이 필요하다' });
  }
  for (const node of nodes) for (const dependency of node.needs ?? []) {
    if (!known.has(dependency)) continue;
    const direct = edges.some((edge) => edge.from === dependency &&
      (edge.to === node.nodeId || Object.values(edge.branches ?? {}).some((destinations) => destinations.includes(node.nodeId))));
    const joined = edges.some((edge) => edge.join === node.nodeId &&
      Object.values(edge.branches ?? {}).some((destinations) => destinations.includes(dependency)));
    if (!direct && !joined) errors.push({ path: `${label}/nodes/${node.nodeId}/needs`,
      message: `'${dependency}' 선행 조건이 실행 엣지 또는 병렬 합류에 연결되지 않았다` });
  }
  const fanOutDestinations = new Map<string, string>();
  const fanOutJoins = new Map<string, string>();
  for (const edge of edges) {
    if (!edge.branches || !edge.join) continue;
    const sourceNode = nodes.find(node => node.nodeId === edge.from);
    if (sourceNode && sourceNode.maxVisits !== 1) errors.push({ path: `${label}/edges/${edge.from}/branches`, message: 'fan-out 출발 노드는 재방문할 수 없어 max_visits: 1 이어야 한다' });
    if (fanOutJoins.has(edge.join) && fanOutJoins.get(edge.join) !== edge.from) errors.push({ path: `${label}/edges/${edge.from}/join`, message: 'join 노드는 하나의 fan-out barrier만 소유할 수 있다' });
    fanOutJoins.set(edge.join, edge.from);
    if (edge.join === edge.from || Object.values(edge.branches).some((branches) => branches.includes(edge.join!)))
      errors.push({ path: `${label}/edges/${edge.from}/join`, message: 'join 노드는 fan-out source나 branch 목적지일 수 없다' });
    for (const branch of new Set(Object.values(edge.branches).flat())) {
      if (fanOutDestinations.has(branch) && fanOutDestinations.get(branch) !== edge.from) errors.push({ path: `${label}/edges/${edge.from}/branches`, message: `branch '${branch}' 는 하나의 fan-out source 에서만 실행할 수 있다` });
      fanOutDestinations.set(branch, edge.from);
      if (edges.some(candidate => candidate.from === branch)) errors.push({ path: `${label}/edges/${edge.from}/branches`, message: `branch '${branch}' 는 단일 노드만 지원하며 후속 간선은 허용되지 않는다` });
    }
    const joinEdge = edges.find((candidate) => candidate.from === edge.join && candidate.on === 'outcome');
    if (!joinEdge?.map || !Object.hasOwn(joinEdge.map, 'ok') || !Object.hasOwn(joinEdge.map, 'fail'))
      errors.push({ path: `${label}/edges/${edge.join}`, message: 'fan-out join 은 ok·fail 출구를 모두 선언해야 한다' });
  }

  if (entryNode !== undefined && !known.has(entryNode)) errors.push({ path: `${label}/entry_node`, message: `'${entryNode}' 는 선언된 노드가 아니다` });
  for (const t of terminalNodes) if (!known.has(t)) errors.push({ path: `${label}/terminal_nodes`, message: `'${t}' 는 선언된 노드가 아니다` });

  let unit: GraphTemplateSpec['unit'];
  if (doc.unit !== undefined) {
    const rawUnit = doc.unit as Record<string, unknown>;
    if (!rawUnit || typeof rawUnit !== 'object' || Array.isArray(rawUnit) ||
        Object.keys(rawUnit).some(key => !['inputs', 'outputs', 'exits', 'entries', 'shape_points'].includes(key)) ||
        !['inputs', 'outputs', 'exits'].every(key => Array.isArray(rawUnit[key]) &&
          (rawUnit[key] as unknown[]).every(v => typeof v === 'string' && v.length > 0) &&
          new Set(rawUnit[key] as string[]).size === (rawUnit[key] as string[]).length) ||
        !(rawUnit.exits as string[]).length ||
        (rawUnit.exits as string[]).some(exit => !terminalNodes.includes(exit)) ||
        terminalNodes.some(exit => !(rawUnit.exits as string[]).includes(exit)) ||
        (rawUnit.entries !== undefined && (!Array.isArray(rawUnit.entries) || !(rawUnit.entries as unknown[]).every(v => typeof v === 'string' && v.length > 0 && known.has(v)) ||
          new Set(rawUnit.entries as string[]).size !== (rawUnit.entries as string[]).length || !(rawUnit.entries as string[]).includes(entryNode!)))) {
      errors.push({ path: `${label}/unit`, message: 'unit 의 inputs·outputs·exits 및 terminal_nodes 가 일치해야 한다' });
    } else {
      let shapePoints: GraphUnitShapePoints | undefined;
      if (rawUnit.shape_points !== undefined) {
        const rawPoints = rawUnit.shape_points && typeof rawUnit.shape_points === 'object' && !Array.isArray(rawUnit.shape_points)
          ? rawUnit.shape_points as Record<string, unknown> : undefined;
        if (!rawPoints || Object.keys(rawPoints).some(key => !['skip', 'recipe', 'fanout_max'].includes(key))) {
          errors.push({ path: `${label}/unit/shape_points`, message: 'shape_points 는 skip·recipe·fanout_max 만 허용하는 맵이어야 한다' });
        } else {
          const points: { skip?: string[]; recipe?: string[]; fanoutMax?: { min: number; max: number } } = {};
          for (const key of ['skip', 'recipe'] as const) {
            const rawIds = rawPoints[key];
            if (rawIds === undefined) continue;
            if (!Array.isArray(rawIds) || rawIds.length === 0 || !rawIds.every(value => typeof value === 'string' && value.trim()) ||
                new Set(rawIds).size !== rawIds.length) {
              errors.push({ path: `${label}/unit/shape_points/${key}`, message: `${key} 는 중복 없는 비어 있지 않은 노드 id 목록이어야 한다` });
              continue;
            }
            const ids = rawIds as string[];
            points[key] = ids;
            for (const id of ids) {
              const node = nodes.find(candidate => candidate.nodeId === id);
              if (!node) errors.push({ path: `${label}/unit/shape_points/${key}`, message: `'${id}' 는 선언된 노드가 아니다` });
              else if (key === 'skip') {
                const incoming = edges.filter(edge => edge.to === id || Object.values(edge.map ?? {}).includes(id));
                const outgoing = edges.filter(edge => edge.from === id);
                if (id === entryNode || (rawUnit.entries as string[] | undefined)?.includes(id) || terminalNodes.includes(id) || node.kind === 'gate' || node.kind === 'hitl' || node.kind === 'subgraph' ||
                    incoming.length !== 1 || incoming.some(edge => edge.branches || edge.fallback || edge.when) ||
                    outgoing.length !== 1 || typeof outgoing[0]?.to !== 'string' || outgoing[0]?.branches || outgoing[0]?.fallback || outgoing[0]?.when)
                  errors.push({ path: `${label}/unit/shape_points/skip`, message: `'${id}' 는 entry·terminal·필수 노드이거나 단일 우회 경로가 없다` });
              } else if (terminalNodes.includes(id) || node.kind === 'gate' || node.kind === 'hitl' || node.kind === 'subgraph') {
                errors.push({ path: `${label}/unit/shape_points/recipe`, message: `'${id}' 는 실행 recipe 를 교체할 수 없는 노드다` });
              }
            }
          }
          if (rawPoints.fanout_max !== undefined) {
            const range = rawPoints.fanout_max && typeof rawPoints.fanout_max === 'object' && !Array.isArray(rawPoints.fanout_max)
              ? rawPoints.fanout_max as Record<string, unknown> : undefined;
            if (!range || Object.keys(range).some(key => !['min', 'max'].includes(key)) ||
                !Number.isSafeInteger(range.min) || !Number.isSafeInteger(range.max) ||
                (range.min as number) < 1 || (range.max as number) < (range.min as number)) {
              errors.push({ path: `${label}/unit/shape_points/fanout_max`, message: 'fanout_max 은 1 이상의 정수 min·max 범위여야 한다' });
            } else points.fanoutMax = { min: range.min as number, max: range.max as number };
          }
          if (Object.keys(rawPoints).length === 0) errors.push({ path: `${label}/unit/shape_points`, message: '허용 성형 지점이 비었다' });
          if (Object.keys(points).length > 0) shapePoints = points;
        }
      }
      unit = { inputs: rawUnit.inputs as string[], outputs: rawUnit.outputs as string[], exits: rawUnit.exits as string[],
        ...(rawUnit.entries === undefined ? {} : { entries: rawUnit.entries as string[] }),
        ...(shapePoints ? { shapePoints } : {}) };
    }
  }
  const runContract = parseGraphRunContract(doc.run_contract);
  if (runContract.error) errors.push({ path: `${label}/run_contract`, message: runContract.error });
  let loop: GraphTemplateSpec['loop'];
  if (doc.loop !== undefined) {
    const l = doc.loop;
    if (!l || typeof l !== 'object' || Array.isArray(l)) errors.push({ path: `${label}/loop`, message: 'loop 는 맵이어야 한다' });
    else {
      const obj = l as Record<string, unknown>;
      const t = obj.trigger;
      if (obj.title !== undefined && typeof obj.title !== 'string') errors.push({ path: `${label}/loop/title`, message: 'title 은 문자열이어야 한다' });
      if (obj.description !== undefined && typeof obj.description !== 'string') errors.push({ path: `${label}/loop/description`, message: 'description 은 문자열이어야 한다' });
      if (t !== undefined && (!t || typeof t !== 'object' || Array.isArray(t))) errors.push({ path: `${label}/loop/trigger`, message: 'trigger 는 맵이어야 한다' });
      const trigger = t && typeof t === 'object' && !Array.isArray(t) ? t as Record<string, unknown> : null;
      if (trigger?.cron !== undefined && typeof trigger.cron !== 'string') errors.push({ path: `${label}/loop/trigger/cron`, message: 'cron 은 문자열이어야 한다' });
      if (trigger?.events !== undefined && (!Array.isArray(trigger.events) || !trigger.events.every(e => typeof e === 'string'))) errors.push({ path: `${label}/loop/trigger/events`, message: 'events 는 문자열 배열이어야 한다' });
      loop = {
        ...(typeof obj.title === 'string' ? { title: obj.title } : {}),
        ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
        ...(trigger ? { trigger: { ...(typeof trigger.cron === 'string' ? { cron: trigger.cron } : {}),
          ...(Array.isArray(trigger.events) ? { events: trigger.events as string[] } : {}) } } : {}),
      };
    }
  }
  if (errors.length > 0) return { errors, warnings };
  return {
    template: {
      graphId: graphId!, version: version!, ...(maxParallelNodes === undefined ? {} : { maxParallelNodes }), entryNode: entryNode!, terminalNodes, nodes, edges,
      ...(doc.supervisors === undefined ? {} : { supervisors }),
      ...(unit ? { unit } : {}),
      ...(policy ? { policy } : {}),
      ...(Array.isArray(journeyStages) ? { journeyStages: journeyStages as string[] } : {}),
      ...(loop ? { loop } : {}),
      ...(typeof doc.docs_only_gate_skip === 'boolean' ? { docsOnlyGateSkip: doc.docs_only_gate_skip } : {}),
      ...(Array.isArray(doc.state) ? { state: doc.state.filter((v): v is string => typeof v === 'string') } : {}),
      ...(allowance ? { allowance } : {}),
      ...(runContract.spec ? { runContract: runContract.spec } : {}),
    },
    errors, warnings,
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isEnumList<T extends string>(value: unknown, allowed: readonly T[], expected: readonly T[]): value is T[] {
  return Array.isArray(value) && value.every((item): item is T => typeof item === 'string' && allowed.includes(item as T))
    && value.length === expected.length && expected.every((item, index) => value[index] === item);
}

function isDirectiveText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const entry = value.replace(/[\p{P}\p{S}\s]/gu, '');
  return entry.length > 0;
}

function parseLandUnitTrainPolicy(
  value: unknown,
  path: string,
  errors: GraphParseIssue[],
): LandUnitTrainPolicySpec | undefined {
  if (value === undefined) return undefined;
  const fail = (suffix: string, message: string): void => { errors.push({ path: `${path}${suffix}`, message }); };
  if (!isRecord(value) || !exactKeys(value, ['express', 'batch', 'scenarioPrebuild', 'gate', 'land'])) {
    fail('', 'policy 는 express·batch·scenarioPrebuild·gate·land 만 가진 맵이어야 한다');
    return undefined;
  }
  const express = value.express;
  const batch = value.batch;
  const scenarioPrebuild = value.scenarioPrebuild;
  const gate = value.gate;
  const land = value.land;
  const field = (name: string, raw: unknown, keys: readonly string[]): Record<string, unknown> | undefined => {
    if (!isRecord(raw) || !exactKeys(raw, keys)) {
      fail(`/${name}`, `${name} 필드는 ${keys.join('·')} 키만 가진 맵이어야 한다`);
      return undefined;
    }
    if (!isDirectiveText(raw.directive))
      fail(`/${name}/directive`, 'directive 는 구두점만으로 된 값이 아닌 비어 있지 않은 문자열이어야 한다');
    return raw;
  };
  const e = field('express', express, ['by', 'waitsForBatch', 'directive']);
  const b = field('batch', batch, ['min', 'max', 'groupBy', 'maxWaitMin', 'order', 'directive']);
  const s = field('scenarioPrebuild', scenarioPrebuild, ['source', 'mock', 'directive']);
  const g = field('gate', gate, ['oncePerBatch', 'directive']);
  const l = field('land', land, ['perPr', 'pinnedHead', 'ejectOnFail', 'integrationPr', 'directive']);

  if (e && !isEnumList(e.by, ['queueFlag', 'predecessorOf', 'multiplierTier', 'p0InCutWindow2h'], ['queueFlag', 'predecessorOf', 'multiplierTier', 'p0InCutWindow2h']))
    fail('/express/by', 'by 는 queueFlag·predecessorOf·multiplierTier·p0InCutWindow2h 를 각각 한 번 포함해야 한다');
  if (e && e.waitsForBatch !== false) fail('/express/waitsForBatch', 'express 는 waitsForBatch: false 여야 한다');
  if (b) {
    if (!Number.isSafeInteger(b.min) || b.min !== 2) fail('/batch/min', 'min 은 정확히 2여야 한다');
    if (!Number.isSafeInteger(b.max) || b.max !== 4) fail('/batch/max', 'max 는 정확히 4여야 한다');
    if (Number.isSafeInteger(b.min) && Number.isSafeInteger(b.max) && (b.min as number) > (b.max as number)) fail('/batch', 'min 은 max 이하여야 한다');
    if (!isEnumList(b.groupBy, ['area', 'cellPrefix'], ['area', 'cellPrefix'])) fail('/batch/groupBy', 'groupBy 는 area·cellPrefix 를 각각 한 번 포함해야 한다');
    if (!Number.isSafeInteger(b.maxWaitMin) || (b.maxWaitMin as number) !== 30) fail('/batch/maxWaitMin', 'maxWaitMin 은 30 정수여야 한다');
    if (!Array.isArray(b.order) || b.order.length !== 3 || b.order.some((item, index) => item !== ['express', 'predecessor', 'enqueued'][index]))
      fail('/batch/order', 'order 는 express·predecessor·enqueued 순이어야 한다');
  }
  if (s && !isEnumList(s.source, ['src/ux-sim', 'scenarios/ux-sim', 'fake-llm', 'fake-harness'], ['src/ux-sim', 'scenarios/ux-sim', 'fake-llm', 'fake-harness']))
    fail('/scenarioPrebuild/source', 'source 는 UX sim·fake LLM·fake harness 네 경로를 각각 한 번 포함해야 한다');
  if (s && s.mock !== 'required') fail('/scenarioPrebuild/mock', 'mock 은 required 여야 한다');
  if (g && g.oncePerBatch !== true) fail('/gate/oncePerBatch', 'oncePerBatch 는 true 여야 한다');
  if (l) {
    if (l.perPr !== 'squash') fail('/land/perPr', 'perPr 은 squash 여야 한다');
    if (l.pinnedHead !== true) fail('/land/pinnedHead', 'pinnedHead 는 true 여야 한다');
    if (l.ejectOnFail !== true) fail('/land/ejectOnFail', 'ejectOnFail 은 true 여야 한다');
    if (l.integrationPr !== false) fail('/land/integrationPr', 'integrationPr 는 false 여야 한다');
  }
  if (!e || !b || !s || !g || !l || errors.some((error) => error.path.startsWith(`${path}/`))) return undefined;
  return {
    express: { by: e.by as LandUnitTrainPolicySpec['express']['by'], waitsForBatch: false, directive: e.directive as string },
    batch: { min: b.min as number, max: b.max as number, groupBy: b.groupBy as LandUnitTrainPolicySpec['batch']['groupBy'], maxWaitMin: b.maxWaitMin as number,
      order: b.order as LandUnitTrainPolicySpec['batch']['order'], directive: b.directive as string },
    scenarioPrebuild: { source: s.source as LandUnitTrainPolicySpec['scenarioPrebuild']['source'], mock: 'required', directive: s.directive as string },
    gate: { oncePerBatch: true, directive: g.directive as string },
    land: { perPr: 'squash', pinnedHead: true, ejectOnFail: true, integrationPr: false, directive: l.directive as string },
  };
}

/** 정규 JSON — 「같은 그래프인가」를 답하는 유일한 형식. ⛔ 키를 «정렬»해 직렬화 순서를 없앤다. */
export function canonicalGraphJson(template: GraphTemplateSpec): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sort(v)]));
    }
    return value;
  };
  return JSON.stringify(sort(template));
}

/** 그래프 판 — 정규 JSON 의 sha256 앞 16자. ⛔ 선언이 바뀌면 «반드시» 바뀐다. */
export function graphVersionHash(template: GraphTemplateSpec): string {
  return createHash('sha256').update(canonicalGraphJson(template)).digest('hex').slice(0, 16);
}

export interface GraphLoadResult {
  readonly templates: Readonly<Record<string, GraphTemplateSpec>>;
  readonly errors: readonly GraphParseIssue[];
  readonly warnings: readonly GraphParseIssue[];
  /** ⛔ 읽으려 «시도한» 파일 수 — 「0개 읽었다」와 「디렉토리가 없다」를 가른다. */
  readonly scannedFiles: number;
}

/** ⛔⭐ 뿌리를 «인자»로 받는다 — 격리(`--root`)가 되려면 이 함수가 cwd·코드 위치를 «안 봐야» 한다. */
export function loadGraphTemplates(dir: string): GraphLoadResult {
  const errors: GraphParseIssue[] = [];
  const warnings: GraphParseIssue[] = [];
  const templates: Record<string, GraphTemplateSpec> = {};
  let files: string[];
  try {
    // recipes are command catalogs consumed by the runner, not graph templates.
    files = readdirSync(dir).filter((f) => (f.endsWith('.yaml') || f.endsWith('.yml')) && f !== 'recipes.yaml' && f !== 'recipes.yml').sort();
  } catch (error) {
    return { templates, errors: [{ path: dir, message: `그래프 디렉토리를 못 읽었다: ${error instanceof Error ? error.message : String(error)}` }], warnings, scannedFiles: 0 };
  }
  for (const file of files) {
    const full = join(dir, file);
    let source: string;
    try { source = readFileSync(full, 'utf8'); }
    catch (error) { errors.push({ path: full, message: `읽기 실패: ${error instanceof Error ? error.message : String(error)}` }); continue; }
    const result = parseGraphTemplateYaml(source, file);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    if (!result.template) continue;
    if (templates[result.template.graphId]) {
      errors.push({ path: file, message: `graph_id '${result.template.graphId}' 가 중복이다` });
      continue;
    }
    templates[result.template.graphId] = result.template;
  }
  return { templates, errors, warnings, scannedFiles: files.length };
}

/** YAML 선언에서 «위상 검사가 읽는» 엣지 맵을 만든다 — map ⊕ fallback 을 «합쳐서».
 *  ⛔ 합치는 이유: 위상은 「갈 수 «있나»」를 묻지 「이 배선에서 «가나»」를 묻지 않는다.
 *    폴백을 빼면 「종료에 못 간다」는 거짓 결함이 난다. */
export function edgeMapOf(template: GraphTemplateSpec): Record<string, string[]> {
  const edges: Record<string, string[]> = Object.fromEntries(template.nodes.map((n) => [n.nodeId, [] as string[]]));
  for (const edge of template.edges) {
    const targets = edges[edge.from] ?? (edges[edge.from] = []);
    const push = (t: string) => { if (!targets.includes(t)) targets.push(t); };
    if (edge.to) push(edge.to);
    for (const t of Object.values(edge.map ?? {})) push(t);
    for (const destinations of Object.values(edge.branches ?? {})) for (const destination of destinations) {
      push(destination);
      if (edge.join) {
        const branchTargets = edges[destination] ?? (edges[destination] = []);
        if (!branchTargets.includes(edge.join)) branchTargets.push(edge.join);
      }
    }
    for (const fb of edge.fallback ?? []) push(fb.node);
  }
  return edges;
}

/** 이 템플릿이 그 노드를 «갖는가». 라우터·오버레이가 공유하는 판정. */
export function templateHasNodeId(template: GraphTemplateSpec, nodeId: string): boolean {
  return template.nodes.some((n) => n.nodeId === nodeId);
}
