import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { join } from 'node:path';
import { parseGraphTemplateYaml, type GraphExtensionMap, type GraphNodeSpec, type GraphTemplateSpec, type GraphV2Declaration } from '../self-implement/graph-yaml.js';
import { graphVersionHash } from '../self-implement/graph-yaml.js';
import { HARNESS_CORE_KINDS } from '../graph-kinds/registry.js';
import { resolveGraphUnit } from '../self-implement/graph-unit-resolver.js';

export interface GraphV2Issue { readonly path: string; readonly message: string }
export interface LowerGraphV2Options { readonly label?: string; readonly bundleExt?: GraphExtensionMap; readonly sourceNamespace?: string }
export interface GraphV2ExtensionLedger { readonly bundle?: GraphExtensionMap; readonly graph?: GraphExtensionMap;
  readonly nodes: Readonly<Record<string, GraphExtensionMap>>;
  readonly edges: readonly { readonly index: number; readonly from: string; readonly ext?: GraphExtensionMap }[];
  readonly loop?: GraphExtensionMap; readonly policy?: GraphExtensionMap }
export interface LowerGraphV2Result { readonly template?: GraphTemplateSpec; readonly errors: readonly GraphV2Issue[];
  readonly warnings: readonly GraphV2Issue[]; readonly bundleExt?: GraphExtensionMap;
  readonly ledgerExtensions?: { readonly graphHash: string; readonly ext: GraphV2ExtensionLedger } }

export type GraphV2LoopStopWhenVerdict = 'stop' | 'continue' | 'unknown';
type GraphV2Condition = { path: string[]; op?: string; value?: string | number | boolean };
function parseGraphV2StopCondition(source: string): GraphV2Condition | undefined {
  const match = /^\s*([a-z_][a-z0-9_-]*(?:\.[a-z_][a-z0-9_-]*)*)(?:\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?|true|false|[a-z_][a-z0-9_-]*))?\s*$/i.exec(source);
  if (!match) return undefined;
  const path = match[1]!.split('.');
  if (!match[2]) return { path };
  const raw = match[3]!;
  const value = raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
  return { path, op: match[2], value };
}
function readPath(root: unknown, path: readonly string[]): { found: boolean; value?: unknown } {
  let current = root;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return { found: false };
    current = (current as Record<string, unknown>)[key];
  }
  return current === undefined ? { found: false } : { found: true, value: current };
}
/** Evaluate stop_when after a run against its result envelope and the loop ledger; this does not stop the current run. */
export function evaluateGraphV2LoopStopWhen(
  conditions: readonly string[],
  resultEnvelope: Readonly<Record<string, unknown>>,
  ledger: Readonly<Record<string, unknown>>,
): GraphV2LoopStopWhenVerdict {
  let unknown = false;
  for (const source of conditions) {
    const condition = parseGraphV2StopCondition(source);
    if (!condition) { unknown = true; continue; }
    const root = { result: resultEnvelope, budget: ledger };
    const read = readPath(root, condition.path);
    if (!read.found) { unknown = true; continue; }
    if (!condition.op) {
      if (read.value === true) return 'stop';
      if (read.value !== false) unknown = true;
      continue;
    }
    const actual = read.value;
    const expected = condition.value;
    let matched: boolean | undefined;
    if (typeof expected === 'number' && typeof actual === 'number' && Number.isFinite(actual)) {
      matched = condition.op === '>=' ? actual >= expected : condition.op === '>' ? actual > expected
        : condition.op === '<=' ? actual <= expected : condition.op === '<' ? actual < expected
        : condition.op === '==' ? actual === expected : condition.op === '!=' ? actual !== expected : undefined;
    } else if (condition.op === '==' || condition.op === '!=') {
      matched = condition.op === '==' ? actual === expected : actual !== expected;
    }
    if (matched === true) return 'stop';
    if (matched === undefined) unknown = true;
  }
  return unknown ? 'unknown' : 'continue';
}

const VERBS = new Set(['research', 'watch', 'decide', 'make', 'execute', 'remember', 'verify']);
function inferredUnitStepLimit(call: string): number | undefined {
  try {
    const unit = resolveGraphUnit(call, join(process.cwd(), 'graph-v2-lower.yaml'));
    if (unit.template.allowance?.innerSteps) return unit.template.allowance.innerSteps;
    const upperBound = unit.template.nodes.reduce((sum, node) => sum + node.maxVisits *
      (node.kind === 'subgraph' ? (node.budget?.innerSteps ?? 1) : 1), 0);
    return Number.isSafeInteger(upperBound) && upperBound > 0 ? upperBound : undefined;
  } catch { return undefined; }
}
const CAPABILITIES = new Set(['store', 'extract', 'stt', 'ocr', 'market-data', 'notify', 'app-publish', 'cloud-resource', 'llm-judge']);
function inferredCapabilityContract(type: string | undefined, withPayload: Record<string, unknown> | undefined): string | undefined {
  if (type === 'store') {
    const operation = withPayload?.op;
    if (operation === 'get' || operation === 'list' || operation === 'query' || operation === 'read') return 'store.read@1';
    if (operation === 'create' || operation === 'upsert' || operation === 'append' || operation === 'write') return 'store.write@1';
  }
  if (type === 'extract') return 'extract.item@1';
  if (type === 'notify') return 'notify.channel@1';
  if (type === 'app-publish') return 'app-publish.action@1';
  return undefined;
}
const EXT_KEY = /^[a-z][a-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BLOCKED_EXT_SEGMENTS = ['cap', 'hitl', 'allow', 'gate', 'code', 'script', 'binary', 'buffer', 'base64', 'bytes', 'executable', 'command'];
function isBlockedExtKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['cap', 'hitl', 'allow', 'gate'].some(segment => normalized.includes(segment))) return true;
  if (BLOCKED_EXT_SEGMENTS.slice(4).some(segment => normalized === segment || normalized.startsWith(segment))) return true;
  return ['skip', 'disable', 'bypass', 'override', 'no'].some(prefix => {
    const tail = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : '';
    return tail.length > 0 && BLOCKED_EXT_SEGMENTS.slice(0, 4).some(segment => tail.includes(segment));
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function isJsonData(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return !(value.startsWith('#!') || value.includes('<script') || value.includes('=>') || value.includes('function') || value.includes('import ') || value.includes('export ') || value.includes('require(') || value.includes('eval(') || value.includes('exec(') || value.includes('process.') || value.includes('console.') || value.includes('child_process') || value.includes('const ') || value.includes('let ') || value.includes('var ') || value.startsWith('echo ') || value.startsWith('curl ') || value.startsWith('wget ') || value.startsWith('rm ') || value.startsWith('bash ') || value.startsWith('sh ') || value.startsWith('node ') || value.startsWith('bun ') || value.startsWith('python') || value.includes('\\n'));
  if (Array.isArray(value)) return value.every(item => isJsonData(item, depth + 1));
  const object = record(value);
  if (!object || ![Object.prototype, null].includes(Object.getPrototypeOf(object))) return false;
  return Object.entries(object).every(([key, item]) =>
    !isBlockedExtKey(key) && isJsonData(item, depth + 1));
}
function parseExt(value: unknown, path: string, errors: GraphV2Issue[]): GraphExtensionMap | undefined {
  if (value === undefined) return undefined;
  const ext = record(value);
  if (!ext) { errors.push({ path, message: 'ext 는 이름공간 맵이어야 한다' }); return undefined; }
  for (const [key, payload] of Object.entries(ext)) {
    if (!EXT_KEY.test(key)) errors.push({ path: `${path}/${key}`, message: 'ext 키는 <출처>.<이름> 이름공간이 필요하다' });
    const segments = key.split('.').slice(1);
    if (segments.some(isBlockedExtKey))
      errors.push({ path: `${path}/${key}`, message: 'ext 에서 cap·hitl·allow·gate 우회 또는 실행 코드 키는 금지된다' });
    if (!isJsonData(payload)) errors.push({ path: `${path}/${key}`, message: 'ext 값은 실행 코드·바이너리 없는 유한 JSON 데이터여야 한다' });
  }
  return { ...ext };
}
function list(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0) ? value as string[] : undefined;
}
function stringMap(value: unknown): Record<string, string> | undefined {
  const map = record(value);
  if (!map || !Object.values(map).every(item => typeof item === 'string')) return undefined;
  return map as Record<string, string>;
}
function mergeContextExt(bundle: GraphExtensionMap | undefined, graph: GraphExtensionMap | undefined, node: GraphExtensionMap | undefined,
  edges: GraphExtensionMap | undefined, loop: GraphExtensionMap | undefined, policy: GraphExtensionMap | undefined) {
  return { ...(bundle ? { bundle } : {}), ...(graph ? { graph } : {}), ...(node ? { node } : {}),
    ...(edges ? { edges } : {}), ...(loop ? { loop } : {}), ...(policy ? { policy } : {}) };
}
function mergeProviderContext(value: unknown, extensions: Readonly<Record<string, GraphExtensionMap>>, path: string, errors: GraphV2Issue[]): unknown {
  const context = record(value) ?? (value === undefined ? {} : { value });
  const existingExt = record(context.ext);
  if (context.ext !== undefined && !existingExt) {
    errors.push({ path: `${path}/ext`, message: 'provider context.ext 는 이름공간 맵이어야 한다' });
    return context;
  }
  const merged: Record<string, unknown> = { ...(existingExt ?? {}) };
  for (const [scope, values] of Object.entries(extensions)) {
    const prior = record(merged[scope]);
    if (merged[scope] !== undefined && !prior) {
      errors.push({ path: `${path}/ext/${scope}`, message: 'provider context 확장 범위가 맵이 아니다' });
      continue;
    }
    const next: Record<string, unknown> = { ...(prior ?? {}) };
    for (const [key, payload] of Object.entries(values)) {
      if (Object.hasOwn(next, key) && JSON.stringify(next[key]) !== JSON.stringify(payload)) {
        errors.push({ path: `${path}/ext/${scope}/${key}`, message: 'provider context 확장 충돌 — 원본 값을 덮어쓰지 않는다' });
        continue;
      }
      next[key] = payload;
    }
    merged[scope] = next;
  }
  return Object.keys(merged).length ? { ...context, ext: merged } : context;
}

/** Retain source fields that have no v2 mapping under one namespaced, lossless payload. */
export function namespaceUnmappedExtensions(value: unknown, sourceNamespace: string, mappedKeys: readonly string[]): GraphExtensionMap {
  const source = record(value);
  if (!source || !/^[a-z][a-z0-9-]*$/.test(sourceNamespace)) return {};
  const mapped = new Set(mappedKeys);
  const unmapped = Object.fromEntries(Object.entries(source).filter(([key]) => !mapped.has(key)));
  return Object.keys(unmapped).length ? { [`${sourceNamespace}.unmapped`]: unmapped } : {};
}
function combineExt(path: string, errors: GraphV2Issue[], ...maps: (GraphExtensionMap | undefined)[]): GraphExtensionMap | undefined {
  const result: Record<string, unknown> = {};
  for (const map of maps) for (const [key, value] of Object.entries(map ?? {})) {
    if (Object.hasOwn(result, key)) { errors.push({ path: `${path}/${key}`, message: 'ext 키 충돌 — 원본 값을 덮어쓰지 않는다' }); continue; }
    result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Parse v2 authoring syntax and lower its P0 surface into the existing graph runner IR. */
interface StaticMapSpec { readonly nodeId: string; readonly over: string; readonly as: string; readonly maxParallel: number; readonly partial?: string }

function lowerStaticMaps(template: GraphTemplateSpec, specs: readonly StaticMapSpec[], errors: GraphV2Issue[], label: string): GraphTemplateSpec {
  let nodes = [...template.nodes];
  let edges = [...template.edges];
  let entryNode = template.entryNode;
  for (const spec of specs) {
    const index = nodes.findIndex(node => node.nodeId === spec.nodeId);
    const source = nodes[index];
    if (!source) { errors.push({ path: label + '/nodes/' + spec.nodeId + '/map', message: '정적 map 원본 노드를 찾을 수 없다' }); continue; }
    const forkId = spec.nodeId + '__map_fork';
    const branchIds = Array.from({ length: spec.maxParallel }, (_unused, slot) => spec.nodeId + '__map_' + slot);
    const reserved = new Set([forkId, ...branchIds]);
    if (nodes.some(node => reserved.has(node.nodeId))) {
      errors.push({ path: label + '/nodes/' + spec.nodeId + '/map', message: '정적 map 합성 노드 id 가 기존 노드와 충돌한다' });
      continue;
    }
    const rawInput = record(source.input) ?? {};
    if (Object.hasOwn(rawInput, '__graphV2MapItem')) { errors.push({ path: label + '/nodes/' + spec.nodeId + '/with/__graphV2MapItem', message: '정적 map 예약 키를 덮어써 안전 거부한다' }); continue; }
    const { map: _sourceMap, ...inputWithoutMap } = rawInput;
    const branchNodes: GraphNodeSpec[] = branchIds.map((nodeId, slot) => ({
      ...source, nodeId,
      input: { ...inputWithoutMap, __graphV2MapItem: { over: spec.over, as: spec.as, index: slot, maxParallel: spec.maxParallel, ...(spec.partial ? { partial: spec.partial } : {}) } },
    }));
    const joinNode: GraphNodeSpec = { nodeId: spec.nodeId, kind: 'gate', recipe: 'none', maxVisits: source.maxVisits,
      input: { __graphV2MapJoin: { branchIds } } };
    const forkNode: GraphNodeSpec = { nodeId: forkId, kind: 'gate', recipe: 'none', maxVisits: source.maxVisits };
    nodes.splice(index, 1, joinNode, forkNode, ...branchNodes);
    if (entryNode === spec.nodeId) entryNode = forkId;
    const redirect = (target: string): string => target === spec.nodeId ? forkId : target;
    edges = edges.map(edge => ({
      ...edge,
      ...(edge.to === undefined ? {} : { to: redirect(edge.to) }),
      ...(edge.map === undefined ? {} : { map: Object.fromEntries(Object.entries(edge.map).map(([outcome, target]) => [outcome, redirect(target)])) }),
      ...(edge.branches === undefined ? {} : { branches: Object.fromEntries(Object.entries(edge.branches).map(([outcome, targets]) => [outcome, targets.map(redirect)])) }),
    }));
    edges.push({ from: forkId, on: 'outcome', branches: { ok: branchIds }, join: spec.nodeId });
  }
  return { ...template, entryNode, nodes, edges };
}

export function lowerGraphV2(source: string, options: LowerGraphV2Options = {}): LowerGraphV2Result {
  const label = options.label ?? '<graph-v2>';
  const errors: GraphV2Issue[] = [];
  const warnings: GraphV2Issue[] = [];
  let raw: unknown;
  try { raw = parseYaml(source); }
  catch (error) { return { errors: [{ path: label, message: `YAML 파싱 실패: ${error instanceof Error ? error.message : String(error)}` }], warnings }; }
  const doc = record(raw);
  if (!doc) return { errors: [{ path: label, message: 'graph v2 최상위가 맵이 아니다' }], warnings };
  if (doc.apiVersion !== 'elanous.dev/graph/v2') errors.push({ path: `${label}/apiVersion`, message: 'apiVersion 은 elanous.dev/graph/v2 여야 한다' });
  const head = record(doc.graph);
  if (!head || typeof head.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(head.id))
    errors.push({ path: `${label}/graph/id`, message: 'graph.id 는 유효한 그래프 id 여야 한다' });
  const semver = typeof head?.version === 'string' ? head.version : '';
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(semver))
    errors.push({ path: `${label}/graph/version`, message: 'graph.version 은 semver 여야 한다' });
  if (head?.layer !== 'flow' && head?.layer !== 'unit') errors.push({ path: `${label}/graph/layer`, message: 'graph.layer 는 flow|unit 이어야 한다' });
  if (typeof head?.purpose !== 'string' || !head.purpose.trim()) errors.push({ path: `${label}/graph/purpose`, message: 'graph.purpose 가 필요하다' });
  const sourceNamespace = options.sourceNamespace ?? 'elanous';
  if (!/^[a-z][a-z0-9-]*$/.test(sourceNamespace)) errors.push({ path: `${label}/sourceNamespace`, message: 'sourceNamespace 는 소문자 이름공간이어야 한다' });
  const graphExt = parseExt(combineExt(`${label}/graph/ext`, errors, parseExt(head?.ext, `${label}/graph/ext`, errors),
    namespaceUnmappedExtensions(head, sourceNamespace, ['id', 'version', 'layer', 'purpose', 'ext'])), `${label}/graph/ext`, errors);
  const docBundleExt = parseExt(doc.ext, `${label}/ext`, errors);
  const bundleExt = parseExt(combineExt(`${label}/bundle/ext`, errors, parseExt(options.bundleExt, `${label}/bundle/ext`, errors), docBundleExt,
    namespaceUnmappedExtensions(doc, sourceNamespace, ['apiVersion', 'graph', 'cap', 'loop', 'entry', 'nodes', 'edges', 'terminal', 'policy', 'allow', 'observe', 'packs', 'sims', 'ext'])), `${label}/bundle/ext`, errors);
  const loopRaw = record(doc.loop);
  if (doc.loop !== undefined && !loopRaw) errors.push({ path: `${label}/loop`, message: 'loop 는 맵이어야 한다' });
  for (const key of ['root', 'parent', 'stage']) if (loopRaw?.[key] !== undefined && typeof loopRaw[key] !== 'string')
    errors.push({ path: `${label}/loop/${key}`, message: `${key} 는 문자열이어야 한다` });
  for (const key of ['scope', 'authority', 'budget', 'trigger']) if (loopRaw?.[key] !== undefined && !record(loopRaw[key]))
    errors.push({ path: `${label}/loop/${key}`, message: `${key} 는 맵이어야 한다` });
  const loopBudget = record(loopRaw?.budget);
  if (loopBudget && Object.keys(loopBudget).some(key => !['runs_per_day', 'llm_calls', 'wall'].includes(key)))
    errors.push({ path: `${label}/loop/budget`, message: 'loop budget 은 runs_per_day·llm_calls 양의 정수와 wall 시간량만 허용한다(inner_steps 는 유닛 call 전용)' });
  for (const key of ['runs_per_day', 'llm_calls'] as const) {
    const value = loopBudget?.[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1))
      errors.push({ path: `${label}/loop/budget/${key}`, message: `${key} 는 1 이상의 안전한 정수여야 한다` });
  }
  if (loopBudget?.wall !== undefined && (typeof loopBudget.wall !== 'string' || !/^\d+(?:ms|s|m|h|d)$/.test(loopBudget.wall)))
    errors.push({ path: `${label}/loop/budget/wall`, message: 'wall 은 양의 시간량 문자열이어야 한다' });
  const stopWhen = loopRaw?.stop_when === undefined ? undefined
    : typeof loopRaw.stop_when === 'string' ? [loopRaw.stop_when]
    : Array.isArray(loopRaw.stop_when) && loopRaw.stop_when.every(item => typeof item === 'string') ? loopRaw.stop_when as string[] : undefined;
  if (loopRaw?.stop_when !== undefined && (!stopWhen || stopWhen.length === 0 || stopWhen.some(condition => !parseGraphV2StopCondition(condition))))
    errors.push({ path: `${label}/loop/stop_when`, message: 'stop_when 은 result/budget 경로의 불리언 또는 비교식 목록이어야 한다' });
  const loopAuthority = record(loopRaw?.authority);
  if (loopAuthority && Object.keys(loopAuthority).length > 0)
    errors.push({ path: `${label}/loop/authority`, message: 'loop authority cap·hitl 은 실행 경계에서 강제되지 않아 안전 거부한다' });
  const loopExt = parseExt(combineExt(`${label}/loop/ext`, errors, parseExt(loopRaw?.ext, `${label}/loop/ext`, errors),
    namespaceUnmappedExtensions(loopRaw, sourceNamespace, ['root', 'parent', 'stage', 'trigger', 'scope', 'authority', 'budget', 'stop_when', 'ext'])), `${label}/loop/ext`, errors);
  if (doc.cap !== undefined && !['L0', 'L1', 'L2', 'L3'].includes(String(doc.cap)))
    errors.push({ path: `${label}/cap`, message: 'cap 은 L0·L1·L2·L3 중 하나여야 한다' });
  if (doc.cap !== undefined) errors.push({ path: `${label}/cap`, message: 'cap 실행 상한은 runGraph IR 에서 강제되지 않아 안전 거부한다' });
  const allowRaw = record(doc.allow);
  if (doc.allow !== undefined) errors.push({ path: `${label}/allow`, message: 'allow 정책은 runGraph IR 에서 강제되지 않아 안전 거부한다' });
  if (doc.allow !== undefined && !allowRaw) errors.push({ path: `${label}/allow`, message: 'allow 는 맵이어야 한다' });
  if (allowRaw && Object.entries(allowRaw).some(([key, value]) => !['skills', 'recipes', 'mcp'].includes(key) || !list(value)))
    errors.push({ path: `${label}/allow`, message: 'allow 는 skills·recipes·mcp 문자열 목록만 허용한다' });
  if (doc.packs !== undefined && !list(doc.packs)) errors.push({ path: `${label}/packs`, message: 'packs 는 문자열 목록이어야 한다' });
  if (doc.sims !== undefined && !list(doc.sims)) errors.push({ path: `${label}/sims`, message: 'sims 는 문자열 목록이어야 한다' });
  if (doc.observe !== undefined && !record(doc.observe)) errors.push({ path: `${label}/observe`, message: 'observe 는 맵이어야 한다' });
  const policyRaw = record(doc.policy);
  if (doc.policy !== undefined && !policyRaw) errors.push({ path: label + '/policy', message: 'policy 는 맵이어야 한다' });
  const policyExt = parseExt(policyRaw?.ext, label + '/policy/ext', errors);
  const policyHitl = list(policyRaw?.hitl);
  if (policyRaw?.hitl !== undefined && (!policyHitl || new Set(policyHitl).size !== policyHitl.length))
    errors.push({ path: label + '/policy/hitl', message: 'policy.hitl 은 중복 없는 문자열 목록이어야 한다' });
  if (policyRaw && Object.keys(policyRaw).some(key => !['ext', 'hitl'].includes(key)))
    errors.push({ path: label + '/policy', message: '미지원 policy 선언은 실행 경계에서 강제되지 않아 안전 거부한다' });
  const nodesRaw = Array.isArray(doc.nodes) ? doc.nodes : undefined;
  if (!nodesRaw || nodesRaw.length === 0) errors.push({ path: `${label}/nodes`, message: 'nodes 는 비어 있지 않은 목록이어야 한다' });
  const entry = typeof doc.entry === 'string' ? doc.entry : undefined;
  if (!entry) errors.push({ path: `${label}/entry`, message: 'entry 가 필요하다' });
  const terminal = list(doc.terminal) ?? [];
  const v1Nodes: Record<string, unknown>[] = [];
  const nodeExtById = new Map<string, GraphExtensionMap | undefined>();
  const nodePostById = new Map<string, readonly string[] | undefined>();
  const maxParallel: number[] = [];
  const staticMapSpecs: Array<{ nodeId: string; over: string; as: string; maxParallel: number; partial?: string }> = [];
  const seenNodeIds = new Set<string>();
  for (const [index, value] of (nodesRaw ?? []).entries()) {
    const path = `${label}/nodes/${index}`;
    const node = record(value);
    if (!node || typeof node.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(node.id)) {
      errors.push({ path: `${path}/id`, message: 'node.id 는 유효한 id 여야 한다' }); continue;
    }
    const ext = parseExt(combineExt(`${path}/ext`, errors, parseExt(node.ext, `${path}/ext`, errors),
      namespaceUnmappedExtensions(node, sourceNamespace, ['id', 'type', 'call', 'call_entry', 'cap', 'requires', 'skill', 'uses', 'with', 'packs', 'map', 'post', 'contract', 'budget', 'max_visits', 'hitl', 'secrets', 'ext'])), `${path}/ext`, errors);
    nodeExtById.set(node.id, ext);
    const map = record(node.map);
    if (node.map !== undefined && (!map || Object.keys(map).some(key => !['over', 'as', 'max_parallel', 'partial'].includes(key)) ||
      typeof map.over !== 'string' || typeof map.as !== 'string' || !Number.isSafeInteger(map.max_parallel) ||
      (map.max_parallel as number) < 2 || (map.max_parallel as number) > 32 ||
      (map.partial !== undefined && map.partial !== 'accept-with-gaps')))
      errors.push({ path: path + '/map', message: 'P0 map 은 이전 노드 result.items·as·2..32 정적 max_parallel·선택적 accept-with-gaps 만 지원한다' });
    if (node.call !== undefined && typeof node.call !== 'string') errors.push({ path: `${path}/call`, message: 'call 은 문자열이어야 한다' });
    if (node.call_entry !== undefined && (typeof node.call_entry !== 'string' || !node.call_entry.trim()))
      errors.push({ path: `${path}/call_entry`, message: 'call_entry 는 비어 있지 않은 노드 id 여야 한다' });
    if (node.skill !== undefined && (typeof node.skill !== 'string' || !node.skill.trim())) errors.push({ path: `${path}/skill`, message: 'skill 은 비어 있지 않은 문자열이어야 한다' });
    const nodeBudget = record(node.budget);
    if (node.budget !== undefined && (!nodeBudget || Object.keys(nodeBudget).some(key => key !== 'inner_steps') ||
      !Number.isSafeInteger(nodeBudget.inner_steps) || (nodeBudget.inner_steps as number) < 1))
      errors.push({ path: `${path}/budget`, message: 'budget 은 1 이상의 inner_steps 만 가져야 한다' });
    if (node.max_visits !== undefined && (!Number.isSafeInteger(node.max_visits) || (node.max_visits as number) < 1))
      errors.push({ path: `${path}/max_visits`, message: 'max_visits 는 1 이상의 안전한 정수여야 한다' });
    const post = node.post === undefined ? undefined : list(node.post);
    if (node.post !== undefined && !post) errors.push({ path: `${path}/post`, message: 'post 는 비어 있지 않은 조건 문자열 목록이어야 한다' });
    nodePostById.set(node.id, post);
    const withPayload = record(node.with);
    if (node.with !== undefined && !withPayload) errors.push({ path: `${path}/with`, message: 'with 는 맵이어야 한다' });
    let requires = typeof node.requires === 'string' && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*@[1-9]\d*$/.test(node.requires) ? node.requires : undefined;
    if (node.requires !== undefined && requires === undefined) errors.push({ path: `${path}/requires`, message: 'requires 는 <namespace>.<contract>@<positive version> 이어야 한다' });
    const uses = node.uses === undefined ? undefined : list(node.uses);
    if (node.uses !== undefined && !uses) errors.push({ path: `${path}/uses`, message: 'uses 는 문자열 목록이어야 한다' });
    const packs = node.packs === undefined ? undefined : list(node.packs);
    if (node.packs !== undefined && !packs) errors.push({ path: `${path}/packs`, message: 'packs 는 문자열 목록이어야 한다' });
    if (node.cap !== undefined && !['L0', 'L1', 'L2', 'L3'].includes(String(node.cap)))
      errors.push({ path: `${path}/cap`, message: 'node.cap 은 L0·L1·L2·L3 중 하나여야 한다' });
    if (node.cap !== undefined) errors.push({ path: `${path}/cap`, message: 'node.cap 실행 상한은 runGraph IR 에서 강제되지 않아 안전 거부한다' });
    const type = typeof node.type === 'string' ? node.type : undefined;
    if (requires === undefined && node.requires === undefined) requires = inferredCapabilityContract(type, withPayload);
    if (map && typeof map.over === 'string' && typeof map.as === 'string' && Number.isSafeInteger(map.max_parallel)) {
      const source = map.over.match(/^\$([A-Za-z0-9][A-Za-z0-9._-]*)\.result\.items$/);
      if (!source || !seenNodeIds.has(source[1]!)) errors.push({ path: path + '/map/over', message: 'map.over 는 앞선 노드의 $<node>.result.items 여야 한다' });
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(map.as)) errors.push({ path: path + '/map/as', message: 'map.as 는 유효한 식별자여야 한다' });
    }
    const hitlDeclaration = record(node.hitl);
    if (node.hitl !== undefined && (!hitlDeclaration || !Array.isArray(hitlDeclaration.options)))
      errors.push({ path: `${path}/hitl`, message: 'hitl 은 options 목록이 필요하다' });
    if (node.hitl !== undefined && type !== 'hitl') errors.push({ path: `${path}/hitl`, message: 'hitl 옵션은 type: hitl 에서만 허용된다' });
    if (type === 'hitl') {
      const options = Array.isArray(hitlDeclaration?.options) ? hitlDeclaration.options.map(record) : [];
      const defaults = options.filter(option => option?.default === true).length;
      if (options.length !== 2 || defaults !== 1)
        errors.push({ path: `${path}/hitl/options`, message: '현재 러너 HITL 은 선택지 2개와 정확히 하나의 default:true 가 필요하다' });
      else if (options.find(option => option?.default === true)?.key !== 'N'
        || options.some(option => option?.key === 'y' && option.default === true)
        || !options.some(option => option?.key === 'y' && option.default !== true))
        errors.push({ path: `${path}/hitl/options`, message: '현재 HITL 계약은 y 승인과 기본 N 거절만 지원한다' });
    }
    const call = typeof node.call === 'string' ? node.call : undefined;
    const isVerb = type !== undefined && VERBS.has(type);
    const isCapability = type !== undefined && CAPABILITIES.has(type);
    let kind: string;
    let recipe: string;
    let loweredCall = call;
    if (isCapability && call !== undefined) errors.push({ path: path + '/call', message: 'capability 노드는 call을 가질 수 없다' });
    if (isCapability && requires === undefined)
      errors.push({ path: `${path}/requires`, message: 'capability 노드는 계약 id requires 를 선언하거나 알려진 계약으로 추론 가능해야 한다' });
    if (call !== undefined || isVerb) { kind = 'subgraph'; recipe = 'none'; loweredCall ??= `verb-${type}@^1`; }
    else if (isCapability) { kind = 'capability'; recipe = 'none'; }
    else if (type && (HARNESS_CORE_KINDS as readonly string[]).includes(type)) { kind = type; recipe = 'none'; }
    else { errors.push({ path: `${path}/type`, message: `type 을 낮출 수 없다: ${String(type)}` }); continue; }
    if (map) {
      if (!isCapability) errors.push({ path: path + '/map', message: 'P0 정적 map 은 capability 노드에서만 허용된다' });
      if (typeof map.over === 'string' && typeof map.as === 'string' && Number.isSafeInteger(map.max_parallel)) {
        staticMapSpecs.push({ nodeId: node.id, over: map.over, as: map.as, maxParallel: map.max_parallel as number, ...(typeof map.partial === 'string' ? { partial: map.partial } : {}) });
        maxParallel.push(map.max_parallel as number);
      }
    }
    const mappedWithKeys = ['type', 'skill', 'uses', 'packs', 'map', 'post', 'hitl'];
    for (const key of mappedWithKeys) if (node[key] !== undefined && withPayload && Object.hasOwn(withPayload, key))
      errors.push({ path: `${path}/with/` + key, message: 'with.' + key + ' 와 node.' + key + ' 가 충돌해 안전 거부한다' });
    const v1Input: Record<string, unknown> = { ...(withPayload ?? {}),
      ...(type ? { type } : {}), ...(typeof node.skill === 'string' ? { skill: node.skill } : {}),
      ...(uses ? { uses } : {}), ...(packs ? { packs } : {}),
      ...(map ? { map: { over: map.over, as: map.as, max_parallel: map.max_parallel, ...(map.partial === undefined ? {} : { partial: map.partial }) } } : {}),
      ...(post ? { post } : {}),
      ...(withPayload?.context === undefined && !bundleExt && !graphExt && !ext && !loopExt && !policyExt
        ? {} : { context: mergeProviderContext(withPayload?.context, mergeContextExt(bundleExt, graphExt, ext, undefined, loopExt, policyExt), `${path}/with/context`, errors) }),
    };
    const maxVisits = Number.isSafeInteger(node.max_visits) && (node.max_visits as number) >= 1 ? node.max_visits as number : 1;
    const callStepLimit = loweredCall ? (nodeBudget?.inner_steps as number | undefined) ?? inferredUnitStepLimit(loweredCall) : undefined;
    if (loweredCall && callStepLimit === undefined) errors.push({ path: `${path}/budget/inner_steps`, message: '해결할 수 없는 unit call 은 v2 budget.inner_steps 를 명시해야 한다' });
    const contract = record(node.contract);
    if (node.contract !== undefined && !contract) errors.push({ path: `${path}/contract`, message: 'contract 는 맵이어야 한다' });
    v1Nodes.push({ node_id: node.id, kind, recipe, max_visits: maxVisits, ...(requires ? { requires } : {}),
      ...(typeof node.call_entry === 'string' ? { call_entry: node.call_entry } : {}),
      ...(node.hitl === undefined ? {} : { hitl: node.hitl }),
      ...(node.secrets === undefined ? {} : { secrets: node.secrets }),
      ...(loweredCall ? { call: loweredCall, budget: { inner_steps: callStepLimit ?? 1 },
        contract: contract ?? { inputs: ['ask', 'context', 'prior'], tools: 'read-only', outputs: ['result', 'evidence'] } } : {}),
      ...(isCapability ? { contract: contract ?? { inputs: ['input', 'nodeInput', 'outputs'], tools: 'read-only', outputs: ['result', 'evidence'] } } : {}),
      input: v1Input });
    seenNodeIds.add(node.id);
  }
  const nodeIds = new Set(v1Nodes.map(node => node.node_id as string));
  for (const id of terminal) if (!nodeIds.has(id)) v1Nodes.push({ node_id: id, kind: id === 'failed' ? 'observe' : 'gate', recipe: 'none', max_visits: 1 });
  const edgeValues = Array.isArray(doc.edges) ? doc.edges : undefined;
  if (!edgeValues || edgeValues.length === 0) errors.push({ path: `${label}/edges`, message: 'edges 는 비어 있지 않은 목록이어야 한다' });
  const edgeExtByIndex: Array<GraphExtensionMap | undefined> = [];
  const v1Edges: Record<string, unknown>[] = [];
  for (const [index, value] of (edgeValues ?? []).entries()) {
    const path = `${label}/edges/${index}`; const edge = record(value);
    if (!edge || typeof edge.from !== 'string') { errors.push({ path, message: 'edge.from 이 필요하다' }); continue; }
    const ext = parseExt(combineExt(`${path}/ext`, errors, parseExt(edge.ext, `${path}/ext`, errors),
      namespaceUnmappedExtensions(edge, sourceNamespace, ['from', 'to', 'on', 'map', 'ext'])), `${path}/ext`, errors);
    edgeExtByIndex.push(ext);
    if (typeof edge.to === 'string') v1Edges.push({ from: edge.from, to: edge.to });
    else {
      const map = stringMap(edge.map);
      if (!map) errors.push({ path: `${path}/map`, message: 'edge.map 은 문자열 목적지 맵이어야 한다' });
      else v1Edges.push({ from: edge.from, on: typeof edge.on === 'string' ? edge.on : 'outcome', map });
    }
  }
  const hitlNodeIds = (nodesRaw ?? []).flatMap(value => { const node = record(value); return node?.type === 'hitl' && typeof node.id === 'string' ? [node.id] : []; });
  if (policyRaw?.hitl !== undefined && policyHitl && (policyHitl.length !== hitlNodeIds.length ||
      hitlNodeIds.some(id => !policyHitl.includes(id)) || policyHitl.some(id => !hitlNodeIds.includes(id))))
    errors.push({ path: label + '/policy/hitl', message: 'policy.hitl 과 type: hitl 노드 목록은 정확히 같아야 한다' });
  if (errors.length) return { errors, warnings, ...(bundleExt ? { bundleExt } : {}) };
  for (const [index, value] of (nodesRaw ?? []).entries()) {
    const sourceNode = record(value);
    if (sourceNode?.type !== 'hitl' || !record(sourceNode.hitl)) continue;
    const rawOptions = (sourceNode.hitl as Record<string, unknown>).options;
    const exits = (Array.isArray(rawOptions) ? rawOptions.map(option => record(option)?.exit).filter((exit): exit is string => typeof exit === 'string') : []).sort();
    const nodeId = typeof sourceNode.id === 'string' ? sourceNode.id : '';
    const edge = (edgeValues ?? []).map(record).find(candidate => candidate?.from === nodeId && candidate.on === 'outcome');
    const edgeMap = stringMap(edge?.map);
    if (!edgeMap || JSON.stringify(Object.keys(edgeMap).sort()) !== JSON.stringify(exits))
      errors.push({ path: `${label}/nodes/${index}/hitl/options`, message: 'HITL 선택지 exit 는 outcome 간선 map 출구와 정확히 같아야 한다' });
  }
  if (errors.length) return { errors, warnings, ...(bundleExt ? { bundleExt } : {}) };
  const version = Number.parseInt(semver, 10);
  const legacySource = stringifyYaml({ graph_id: head!.id, version, entry_node: entry, terminal_nodes: terminal,
    ...(maxParallel.length ? { max_parallel_nodes: Math.max(...maxParallel) } : {}), ...(loopRaw?.trigger ? { loop: { trigger: loopRaw.trigger } } : {}), nodes: v1Nodes, edges: v1Edges });
  const parsed = parseGraphTemplateYaml(legacySource, label);
  errors.push(...parsed.errors); warnings.push(...parsed.warnings);
  if (!parsed.template || errors.length) return { errors, warnings, ...(bundleExt ? { bundleExt } : {}) };
  const base = parsed.template;
  for (const node of base.nodes.filter(candidate => candidate.kind === 'subgraph' && candidate.call)) {
    try {
      const unit = resolveGraphUnit(node.call!, join(process.cwd(), 'graph-v2-lower.yaml'));
      const edge = base.edges.find(candidate => candidate.from === node.nodeId && candidate.on === 'outcome');
      const expectedExits = [...(unit.template.unit?.exits ?? [])].sort();
      const mappedExits = Object.keys(edge?.map ?? {}).sort();
      if (!edge?.map || JSON.stringify(expectedExits) !== JSON.stringify(mappedExits))
        errors.push({ path: label + '/nodes/' + node.nodeId + '/exit-map', message: 'unit exits(done/rework/needs-human/failed 등)는 부모 outcome map에 모두 명시해야 한다' });
    } catch { /* unresolved calls require an explicit budget; their exit contract is checked by the runtime resolver */ }
  }
  if (errors.length) return { errors, warnings, ...(bundleExt ? { bundleExt } : {}) };
  const declaration: GraphV2Declaration = { apiVersion: 'elanous.dev/graph/v2', sourceVersion: semver,
    layer: head!.layer as 'flow' | 'unit', purpose: head!.purpose as string,
    ...(typeof doc.cap === 'string' ? { cap: doc.cap } : {}), ...(allowRaw ? { allow: allowRaw } : {}),
    ...(list(doc.packs) ? { packs: list(doc.packs)! } : {}), ...(record(doc.observe) ? { observe: record(doc.observe)! } : {}),
    ...(list(doc.sims) ? { sims: list(doc.sims)! } : {}),
    ...(policyRaw ? { policy: { ...policyRaw, ...(policyExt ? { ext: policyExt } : {}) } } : {}),
    ...(loopRaw && (stopWhen || loopBudget) ? { loop: { ...(stopWhen ? { stopWhen } : {}), ...(loopBudget ? { budget: loopBudget } : {}) } } : {}),
  };
  const sourceTemplate: GraphTemplateSpec = { ...base, ...(graphExt ? { ext: graphExt } : {}), v2: declaration,
    ...(loopRaw ? { loop: { ...(base.loop ?? {}),
      ...(typeof loopRaw.root === 'string' ? { root: loopRaw.root } : {}), ...(typeof loopRaw.parent === 'string' ? { parent: loopRaw.parent } : {}),
      ...(typeof loopRaw.stage === 'string' ? { stage: loopRaw.stage } : {}),
      ...(record(loopRaw.scope) ? { scope: record(loopRaw.scope)! } : {}),
      ...(record(loopRaw.authority) ? { authority: record(loopRaw.authority)! } : {}),
      ...(record(loopRaw.budget) ? { budget: record(loopRaw.budget)! } : {}), ...(loopExt ? { ext: loopExt } : {}),
    } } : {}),
    nodes: base.nodes.map((node, index): GraphNodeSpec => {
      const original = v1Nodes[index];
      const ext = nodeExtById.get(node.nodeId);
      const v2Input = record(original?.input);
      const incomingExt = Object.fromEntries(base.edges.flatMap((edge, edgeIndex) => {
        const reaches = edge.to === node.nodeId || Object.values(edge.map ?? {}).includes(node.nodeId)
          || Object.values(edge.branches ?? {}).some(destinations => destinations.includes(node.nodeId));
        return reaches && edgeExtByIndex[edgeIndex] ? [[`edge-${edgeIndex}`, edgeExtByIndex[edgeIndex]!]] : [];
      }));
      const edgeScope = Object.keys(incomingExt).length ? incomingExt as GraphExtensionMap : undefined;
      return { ...node, ...(typeof record(nodesRaw?.[index])?.cap === 'string' ? { cap: record(nodesRaw?.[index])!.cap as string } : {}), ...(ext ? { ext } : {}), ...(nodePostById.get(node.nodeId) ? { postconditions: nodePostById.get(node.nodeId) } : {}),
        ...(v2Input ? { input: { ...v2Input, ...(v2Input.context === undefined && !bundleExt && !graphExt && !ext && !edgeScope && !loopExt && !policyExt
          ? {} : { context: mergeProviderContext(v2Input.context, mergeContextExt(bundleExt, graphExt, ext, edgeScope, loopExt, policyExt), `${label}/nodes/${index}/context`, errors) }) } } : {}),
        ...(ext || graphExt || bundleExt || edgeScope || loopExt || policyExt ? { context: { ext: mergeContextExt(bundleExt, graphExt, ext, edgeScope, loopExt, policyExt) } } : {}) };
    }),
    edges: base.edges.map((edge, index) => ({ ...edge, ...(edgeExtByIndex[index] ? { ext: edgeExtByIndex[index] } : {}) })),
  };
  if (errors.length) return { errors, warnings, ...(bundleExt ? { bundleExt } : {}) };
  const template = lowerStaticMaps(sourceTemplate, staticMapSpecs, errors, label);
  if (errors.length) return { errors, warnings, ...(bundleExt ? { bundleExt } : {}) };
  const ledgerExtensions: NonNullable<LowerGraphV2Result['ledgerExtensions']> = { graphHash: graphVersionHash(template), ext: {
    ...(bundleExt ? { bundle: bundleExt } : {}), ...(graphExt ? { graph: graphExt } : {}),
    nodes: Object.fromEntries([...nodeExtById].filter((entry): entry is [string, GraphExtensionMap] => entry[1] !== undefined).map(([id, ext]) => [id, ext])),
    edges: base.edges.map((edge, index) => ({ index, from: edge.from, ...(edgeExtByIndex[index] ? { ext: edgeExtByIndex[index] } : {}) })),
    ...(loopExt ? { loop: loopExt } : {}), ...(policyExt ? { policy: policyExt } : {}),
  } };
  return { template, errors, warnings, ...(bundleExt ? { bundleExt } : {}), ledgerExtensions };
}
