import { parseGraphRunContract, type GraphRunContractSpec } from './graph-run-contract.js';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { HARNESS_CORE_KINDS, hasNodeKind } from '../graph-kinds/registry.js';

/** ⭐ RFC-graph-templates-as-yaml §5 «0단계» — YAML 저작본을 읽어 실행·해시·원장용 정규형으로.
 *
 *  ⛔⭐ **던지지 않는다** — 호출자는 «언제나» 구조화 결과를 받는다
 *    (`playground-scenario/yaml-parser.ts` 의 계약을 따른다 · 재발명 0).
 *  ⛔⭐ **뿌리를 «인자»로 받는다** — `import.meta.url` 로 코드 트리에 묶지 않는다.
 *    🩸 §4.6 이 지목한 병: `mission-capabilities/registry.ts` 가 그 방식이라 `--root` 격리가 불가능하다. */
export type GraphNodeKind = typeof HARNESS_CORE_KINDS[number];

export interface GraphNodeContract {
  readonly inputs: readonly string[];
  readonly tools: string;
  readonly outputs: readonly string[];
}

export interface GraphNodeSpec {
  readonly nodeId: string;
  readonly kind: GraphNodeKind | (string & {});
  readonly recipe: string;
  readonly maxVisits: number;
  readonly progress?: readonly string[];
  readonly phases?: readonly string[];
  readonly terminalStages?: readonly string[];
  /** ⭐ 「아크마다 한 번」처럼 «한 노드가 여럿 돈다」를 값으로. 없으면 한 번이다. */
  readonly fanOut?: string;
  readonly contract?: GraphNodeContract;
}

export interface GraphEdgeSpec {
  readonly from: string;
  /** 무조건 엣지. `on`/`map` 과 «둘 중 하나»만 쓴다. */
  readonly to?: string;
  /** 조건부 엣지 — 라우터가 읽는 «상태 키». ⛔ 값은 코드가 낸다(RFC §4.3 ⑵). */
  readonly on?: string;
  readonly map?: Readonly<Record<string, string>>;
  /** 심이 «주입 안 됐을 때» 내려가는 순서. `requires` 는 그 심 이름들. */
  readonly fallback?: readonly { readonly node: string; readonly requires: readonly string[]; readonly observed?: number }[];
  readonly observed?: number;
}

export interface GraphTemplateSpec {
  readonly loop?: { readonly title?: string; readonly description?: string; readonly trigger?: { readonly cron?: string; readonly events?: readonly string[] } };
  readonly graphId: string;
  readonly version: number;
  readonly entryNode: string;
  readonly terminalNodes: readonly string[];
  /** 문서 전용 변경이면 gate 노드를 건너뛸 수 있다는 템플릿 정책. */
  readonly docsOnlyGateSkip?: boolean;
  readonly state?: readonly string[];
  /** ⭐ 런 계약(선택) — 이 그래프가 «기본으로» 요구하는 실행 칸 등. 발사 인자가 덮는다(graph-run-contract.ts). */
  readonly runContract?: GraphRunContractSpec;
  readonly nodes: readonly GraphNodeSpec[];
  readonly edges: readonly GraphEdgeSpec[];
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
  const version = typeof doc.version === 'number' && Number.isInteger(doc.version) ? doc.version : undefined;
  if (version === undefined) errors.push({ path: `${label}/version`, message: 'version 이 없거나 정수가 아니다' });
  const entryNode = typeof doc.entry_node === 'string' ? doc.entry_node : undefined;
  if (entryNode === undefined) errors.push({ path: `${label}/entry_node`, message: 'entry_node 가 없거나 문자열이 아니다' });

  const terminalNodes = asArray(doc.terminal_nodes).filter((v): v is string => typeof v === 'string');
  if (terminalNodes.length === 0) errors.push({ path: `${label}/terminal_nodes`, message: 'terminal_nodes 가 비었다 — 끝날 수 없는 그래프다' });

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
    const maxVisits = n.max_visits;
    if (typeof maxVisits !== 'number' || !Number.isInteger(maxVisits) || maxVisits < 1) {
      errors.push({ path: `${at}/max_visits`, message: 'max_visits 는 1 이상의 정수여야 한다' });
      continue;
    }
    const contractRaw = n.contract as Record<string, unknown> | undefined;
    const contract: GraphNodeContract | undefined = contractRaw && typeof contractRaw === 'object'
      ? {
          inputs: asArray(contractRaw.inputs).filter((v): v is string => typeof v === 'string'),
          tools: typeof contractRaw.tools === 'string' ? contractRaw.tools : '',
          outputs: asArray(contractRaw.outputs).filter((v): v is string => typeof v === 'string'),
        }
      : undefined;
    // ⛔ 계약이 없으면 「이 노드가 무엇을 할 수 있나」를 답할 수 없다 — 경고로 남긴다(거절은 오버레이 쪽).
    if (contract === undefined) warnings.push({ path: `${at}/contract`, message: '계약(inputs·tools·outputs)이 없다 — 권한을 코드에서만 알 수 있다' });
    else if (contract.tools === '') warnings.push({ path: `${at}/contract/tools`, message: 'tools 가 비었다' });

    nodes.push({
      nodeId, kind, recipe, maxVisits,
      ...(Array.isArray(n.progress) ? { progress: n.progress.filter((v): v is string => typeof v === 'string') } : {}),
      ...(Array.isArray(n.phases) ? { phases: n.phases.filter((v): v is string => typeof v === 'string') } : {}),
      ...(Array.isArray(n.terminal_stages) ? { terminalStages: n.terminal_stages.filter((v): v is string => typeof v === 'string') } : {}),
      ...(typeof n.fan_out === 'string' ? { fanOut: n.fan_out } : {}),
      ...(contract ? { contract } : {}),
    });
  }
  if (nodes.length === 0) errors.push({ path: `${label}/nodes`, message: '노드가 하나도 없다' });

  const known = new Set(nodes.map((n) => n.nodeId));
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
    if (hasTo === hasMap) {
      errors.push({ path: at, message: 'to 와 map 중 «정확히 하나»를 써야 한다' });
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
      ...(fallback.length > 0 ? { fallback } : {}),
      ...(typeof e.observed === 'number' ? { observed: e.observed } : {}),
    });
  }

  if (entryNode !== undefined && !known.has(entryNode)) errors.push({ path: `${label}/entry_node`, message: `'${entryNode}' 는 선언된 노드가 아니다` });
  for (const t of terminalNodes) if (!known.has(t)) errors.push({ path: `${label}/terminal_nodes`, message: `'${t}' 는 선언된 노드가 아니다` });

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
      graphId: graphId!, version: version!, entryNode: entryNode!, terminalNodes, nodes, edges,
      ...(loop ? { loop } : {}),
      ...(typeof doc.docs_only_gate_skip === 'boolean' ? { docsOnlyGateSkip: doc.docs_only_gate_skip } : {}),
      ...(Array.isArray(doc.state) ? { state: doc.state.filter((v): v is string => typeof v === 'string') } : {}),
      ...(runContract.spec ? { runContract: runContract.spec } : {}),
    },
    errors, warnings,
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
    files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
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
    for (const fb of edge.fallback ?? []) push(fb.node);
  }
  return edges;
}

/** 이 템플릿이 그 노드를 «갖는가». 라우터·오버레이가 공유하는 판정. */
export function templateHasNodeId(template: GraphTemplateSpec, nodeId: string): boolean {
  return template.nodes.some((n) => n.nodeId === nodeId);
}
