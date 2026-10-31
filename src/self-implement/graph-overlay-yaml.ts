import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import { inspectPipelineGraph, type PipelineGraphDefect } from './pipeline-shape.js';
import { edgeMapOf, type GraphParseIssue, type GraphTemplateSpec } from './graph-yaml.js';
import { evaluateOverlayCondition } from './graph-overlay-condition.js';
import type { OverlayPatch } from './graph-overlay.js';

/** ⭐ RFC §5 «3단계» — 오버레이(변형)를 YAML 로 읽고 JSON Patch 로 얹는다.
 *
 *  ⛔⭐ 층이 «둘»이고 각 층이 «언제» 얹히는지가 다르다(graphs/overlays/README.md):
 *    `launch`  최초 결정 시   ·  `runtime`  구현 «중»
 *  ⛔ 얹을 때 «반드시» 셋을 한다:
 *    ⑴ 얹은 «결과»에 위상 검사를 다시 건다 — 노드 집합이 그대로여도 도달 가능성은 바뀐다
 *    ⑵ 계약이 빠진 노드를 «거부»한다 — 권한 없는 노드가 조용히 들어오는 것을 막는다
 *    ⑶ 무엇을 얹었는지를 «값»으로 낸다 — 사후에 「왜 이 걸음인가」를 답하려면 필요하다 */
/** `heal` = 멈춤 갈래 사다리 전용 — `stop-autoheal.ts` 만 고른다. 실행기의 launch·runtime 선택에는 «안» 잡힌다. */
export type OverlayStage = 'launch' | 'runtime' | 'heal';

export interface OverlayPatchOp {
  readonly op: 'add' | 'replace' | 'remove';
  readonly path: string;
  readonly value?: unknown;
}

export interface GraphOverlaySpec {
  readonly overlayId: string;
  readonly target: string;
  readonly stage: OverlayStage;
  /** ⛔ 조건도 «값»이다 — 사람이 판단해 얹는 경로를 두지 않는다. */
  readonly appliesWhen: string;
  readonly patch: readonly OverlayPatchOp[];
  /** Stop-reason vocabulary lives with heal declarations, not in TypeScript tables. */
  readonly reasonMap?: Readonly<Record<string, string>>;
}

export interface OverlayParseResult {
  /** 첫 오버레이 — 한 파일에 하나만 둔 기존 선언의 읽기 자리. */
  readonly overlay?: GraphOverlaySpec;
  /** 파일이 선언한 오버레이 전부. `---` 로 문서를 나누면 한 파일에 여럿이다. 오류가 하나라도 있으면 비어 있다. */
  readonly overlays: readonly GraphOverlaySpec[];
  readonly errors: readonly GraphParseIssue[];
}

const STAGES = new Set<OverlayStage>(['launch', 'runtime', 'heal']);
const OPS = new Set(['add', 'replace', 'remove']);

/** ⛔ 던지지 않는다 — 파서 계약은 `graph-yaml.ts` 와 같다.
 *  한 파일 = 문서 하나가 기본이다. `---` 로 나눈 여러 문서는 문서마다 오버레이 하나로 읽는다
 *  (오류 경로는 `<label>#<문서 번호>`). 문서가 하나면 읽는 법도 오류 문면도 예전과 같다. */
export function parseGraphOverlayYaml(source: string, label = '<inline>'): OverlayParseResult {
  let raw: unknown;
  try { raw = parseYaml(source); }
  catch (error) {
    const documents = parseAllDocuments(source);
    if (documents.length > 1 && documents.every((document) => document.errors.length === 0)) {
      return overlaysFromDocuments(documents.map((document) => document.toJS() as unknown), label);
    }
    return { overlays: [], errors: [{ path: label, message: `YAML 파싱 실패: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const parsed = overlayFromRaw(raw, label);
  return { ...(parsed.overlay ? { overlay: parsed.overlay } : {}), overlays: parsed.overlay ? [parsed.overlay] : [], errors: parsed.errors };
}

function overlaysFromDocuments(raws: readonly unknown[], label: string): OverlayParseResult {
  const errors: GraphParseIssue[] = [];
  const overlays: GraphOverlaySpec[] = [];
  for (const [index, raw] of raws.entries()) {
    const parsed = overlayFromRaw(raw, `${label}#${index}`);
    errors.push(...parsed.errors);
    if (parsed.overlay) overlays.push(parsed.overlay);
  }
  const seen = new Set<string>();
  for (const overlay of overlays) {
    if (seen.has(overlay.overlayId)) errors.push({ path: `${label}/overlay_id`, message: `overlay_id '${overlay.overlayId}' 가 한 파일에서 중복이다` });
    seen.add(overlay.overlayId);
  }
  if (errors.length > 0) return { overlays: [], errors };
  return { overlay: overlays[0]!, overlays, errors };
}

function overlayFromRaw(raw: unknown, label: string): { overlay?: GraphOverlaySpec; errors: GraphParseIssue[] } {
  const errors: GraphParseIssue[] = [];
  if (raw === null || typeof raw !== 'object') return { errors: [{ path: label, message: 'YAML 최상위가 맵이 아니다' }] };
  const doc = raw as Record<string, unknown>;

  const overlayId = typeof doc.overlay_id === 'string' ? doc.overlay_id : undefined;
  if (!overlayId) errors.push({ path: `${label}/overlay_id`, message: 'overlay_id 가 없거나 문자열이 아니다' });
  const target = typeof doc.target === 'string' ? doc.target : undefined;
  if (!target) errors.push({ path: `${label}/target`, message: 'target(어느 그래프에 얹나)이 없다' });
  const stage = typeof doc.stage === 'string' && STAGES.has(doc.stage as OverlayStage) ? doc.stage as OverlayStage : undefined;
  if (!stage) errors.push({ path: `${label}/stage`, message: `stage 는 ${[...STAGES].join('|')} 중 하나여야 한다` });
  const appliesWhen = typeof doc.applies_when === 'string' ? doc.applies_when : undefined;
  if (!appliesWhen) errors.push({ path: `${label}/applies_when`, message: 'applies_when 이 없거나 문자열이 아니다' });

  const patch: OverlayPatchOp[] = [];
  const reasonMapRaw = doc.reason_map;
  const reasonMap = reasonMapRaw && typeof reasonMapRaw === 'object' && !Array.isArray(reasonMapRaw)
    ? Object.fromEntries(Object.entries(reasonMapRaw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined;
  const rawPatch = Array.isArray(doc.patch) ? doc.patch : [];
  if (rawPatch.length === 0) errors.push({ path: `${label}/patch`, message: 'patch 가 비었다 — 아무것도 안 바꾸는 오버레이다' });
  for (const [index, entry] of rawPatch.entries()) {
    const at = `${label}/patch/${index}`;
    if (entry === null || typeof entry !== 'object') { errors.push({ path: at, message: 'patch 항목이 맵이 아니다' }); continue; }
    const p = entry as Record<string, unknown>;
    if (typeof p.op !== 'string' || !OPS.has(p.op)) { errors.push({ path: `${at}/op`, message: `op 은 ${[...OPS].join('|')} 중 하나여야 한다` }); continue; }
    if (typeof p.path !== 'string' || !p.path.startsWith('/')) { errors.push({ path: `${at}/path`, message: 'path 는 «/» 로 시작하는 JSON Pointer 여야 한다' }); continue; }
    if (p.op !== 'remove' && !('value' in p)) { errors.push({ path: `${at}/value`, message: `op=${p.op} 에는 value 가 필요하다` }); continue; }
    patch.push({ op: p.op as OverlayPatchOp['op'], path: p.path, ...(p.op === 'remove' ? {} : { value: p.value }) });
  }

  if (errors.length > 0) return { errors };
  return {
    overlay: {
      overlayId: overlayId!, target: target!, stage: stage!, appliesWhen: appliesWhen!, patch,
      ...(reasonMap && Object.keys(reasonMap).length ? { reasonMap } : {}),
    },
    errors,
  };
}

export type OverlayRejection =
  | { kind: 'unknown-target'; overlayId: string; target: string }
  | { kind: 'bad-pointer'; overlayId: string; path: string }
  /** ⛔ replace·remove 가 «없는 키»를 가리켰다 — 조용히 새 키를 만들지 않는다. */
  | { kind: 'no-such-key'; overlayId: string; path: string; key: string }
  | { kind: 'node-without-contract'; overlayId: string; nodeId: string }
  | { kind: 'breaks-graph'; overlayId: string; defects: readonly PipelineGraphDefect[] };

export type OverlayApplyResult =
  | { ok: true; template: GraphTemplateSpec; overlayIds: readonly string[]; patches: readonly OverlayPatch[] }
  | { ok: false; rejections: readonly OverlayRejection[] };

/** JSON Pointer 한 칸을 따라간다. `-` 는 배열 «끝에 더하기»다(RFC 6902). */
function resolvePointer(root: unknown, path: string): { parent: unknown; key: string } | null {
  const parts = path.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts.length === 0) return null;
  let node: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(node)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return null;
      node = node[index];
    } else if (node !== null && typeof node === 'object') {
      node = (node as Record<string, unknown>)[part];
    } else return null;
    if (node === undefined) return null;
  }
  return { parent: node, key: parts[parts.length - 1]! };
}

/** 오버레이를 얹는다. ⛔ 얹은 «결과»에 위상 검사를 다시 걸고, 계약 없는 노드를 거절한다. */
export function applyGraphOverlays(
  template: GraphTemplateSpec,
  overlays: readonly GraphOverlaySpec[],
): OverlayApplyResult {
  const rejections: OverlayRejection[] = [];
  // ⛔ 깊은 사본 — 원본을 안 만진다(오버레이가 실패해도 기준 선언이 살아 있어야 한다).
  const next = JSON.parse(JSON.stringify(template)) as GraphTemplateSpec;
  const applied: string[] = [];
  const patches: OverlayPatch[] = [];

  for (const overlay of overlays) {
    if (overlay.target !== template.graphId) {
      rejections.push({ kind: 'unknown-target', overlayId: overlay.overlayId, target: overlay.target });
      continue;
    }
    const beforeNodes = new Map(next.nodes.map((node) => [node.nodeId, node]));
    const beforeVisits = new Map(next.nodes.map((node) => [node.nodeId, node.maxVisits]));
    const beforeRoutes = graphRouteMap(next);
    const beforeEdgeMap = edgeMapOf(next);
    for (const op of overlay.patch) {
      const resolved = resolvePointer(next, op.path);
      if (!resolved) { rejections.push({ kind: 'bad-pointer', overlayId: overlay.overlayId, path: op.path }); continue; }
      const { parent, key } = resolved;
      if (Array.isArray(parent)) {
        if (op.op === 'add') { if (key === '-') parent.push(op.value); else parent.splice(Number(key), 0, op.value); }
        else if (op.op === 'replace') { const i = Number(key); if (Number.isInteger(i) && i < parent.length) parent[i] = op.value; else rejections.push({ kind: 'bad-pointer', overlayId: overlay.overlayId, path: op.path }); }
        else { const i = Number(key); if (Number.isInteger(i) && i < parent.length) parent.splice(i, 1); else rejections.push({ kind: 'bad-pointer', overlayId: overlay.overlayId, path: op.path }); }
      } else if (parent !== null && typeof parent === 'object') {
        const bag = parent as Record<string, unknown>;
        // 🚨⛔ `replace`·`remove` 는 «있는 키»에만 먹는다 — 없는 키에 쓰면 «조용히 새 키»가 생겨
        //   「얹었다」와 「먹었다」가 갈리지 않는다.
        //   🩸 2026-09-08 실측: 오버레이가 `/nodes/5/max_visits` 를 썼는데 파싱된 스펙은
        //     `maxVisits`(camelCase)라 아무것도 안 바뀌고 «ok» 가 나왔다.
        if (op.op !== 'add' && !(key in bag)) {
          rejections.push({ kind: 'no-such-key', overlayId: overlay.overlayId, path: op.path, key });
          continue;
        }
        if (op.op === 'remove') delete bag[key]; else bag[key] = op.value;
      } else rejections.push({ kind: 'bad-pointer', overlayId: overlay.overlayId, path: op.path });
    }
    for (const node of next.nodes) {
      if (beforeNodes.has(node.nodeId)) continue;
      patches.push({ overlayId: overlay.overlayId, field: 'node-added', node: node.nodeId, kind: node.kind, maxVisits: node.maxVisits });
    }
    const afterRoutes = graphRouteMap(next);
    for (const [key, route] of afterRoutes) {
      const before = beforeRoutes.get(key);
      if (before && before.to !== route.to) {
        patches.push({ overlayId: overlay.overlayId, field: 'edge-rerouted', from: route.from, outcome: route.outcome, was: before.to, to: route.to });
      }
    }
    for (const node of next.nodes) {
      const before = beforeVisits.get(node.nodeId);
      if (before !== undefined && before !== node.maxVisits) {
        patches.push({ overlayId: overlay.overlayId, field: 'maxVisits', node: node.nodeId, before, after: node.maxVisits });
      }
    }
    const afterEdgeMap = edgeMapOf(next);
    for (const node of Object.keys(beforeEdgeMap)) {
      const before = beforeEdgeMap[node] ?? [];
      const after = afterEdgeMap[node] ?? [];
      if (before.length !== after.length || before.some((destination, index) => destination !== after[index])) {
        patches.push({ overlayId: overlay.overlayId, field: 'routes', node, before, after });
      }
    }
    applied.push(overlay.overlayId);
  }

  // ⑵ 계약 없는 실행 노드를 거부한다. 기존 종결 gate 와 여정 선언은
  // 원본 그대로일 때만 예외로 보존한다. 오버레이가 바꾼 노드에는 계약이 필요하다.
  for (const node of next.nodes) {
    const original = template.nodes.find((candidate) => candidate.nodeId === node.nodeId);
    // 기존 무계약 여정 선언은 노드와 그 출입 간선·종결 지위가 모두 그대로일 때만 보존한다.
    // 새 경로가 실행 권한 없는 노드를 노출하면 계약 검사를 다시 건다.
    const touchesNode = (edge: GraphTemplateSpec['edges'][number]) => edge.from === node.nodeId
      || edge.to === node.nodeId
      || Object.values(edge.map ?? {}).includes(node.nodeId)
      || (edge.fallback ?? []).some((fallback) => fallback.node === node.nodeId);
    const untouchedJourneyDeclaration = original?.journeyStage !== undefined
      && original.contract === undefined
      && JSON.stringify(node) === JSON.stringify(original)
      && JSON.stringify(next.edges.filter(touchesNode)) === JSON.stringify(template.edges.filter(touchesNode))
      && next.terminalNodes.includes(node.nodeId) === template.terminalNodes.includes(node.nodeId);
    const existingTerminalGate = original?.kind === 'gate' && original.recipe === 'none'
      && original.contract === undefined
      && JSON.stringify(node) === JSON.stringify(original)
      && template.terminalNodes.includes(node.nodeId)
      && next.terminalNodes.includes(node.nodeId)
      && !template.edges.some((edge) => edge.from === node.nodeId)
      && !next.edges.some((edge) => edge.from === node.nodeId);
    const contract = node.contract;
    const validContract = contract != null && Array.isArray(contract.inputs)
      && contract.inputs.every((input) => typeof input === 'string')
      && typeof contract.tools === 'string' && contract.tools.trim() !== ''
      && Array.isArray(contract.outputs)
      && contract.outputs.every((output) => typeof output === 'string');
    if (!untouchedJourneyDeclaration && !existingTerminalGate && !validContract) {
      rejections.push({ kind: 'node-without-contract', overlayId: applied.join(',') || '<none>', nodeId: node.nodeId });
    }
  }
  // ⑴ 얹은 «결과»에 위상 검사를 다시 건다.
  const defects = inspectPipelineGraph(edgeMapOf(next), next.entryNode);
  if (defects.length > 0) rejections.push({ kind: 'breaks-graph', overlayId: applied.join(',') || '<none>', defects });

  if (rejections.length > 0) return { ok: false, rejections };
  return { ok: true, template: next, overlayIds: applied, patches };
}

/** Keep outcome names while comparing route changes; the compiled edge map deliberately drops them. */
function graphRouteMap(template: GraphTemplateSpec): Map<string, { from: string; outcome: string; to: string }> {
  const routes = new Map<string, { from: string; outcome: string; to: string }>();
  for (const [index, edge] of template.edges.entries()) {
    if (edge.to) routes.set(`${edge.from}\u0000direct\u0000${index}`, { from: edge.from, outcome: '', to: edge.to });
    for (const [outcome, to] of Object.entries(edge.map ?? {})) {
      routes.set(`${edge.from}\u0000${edge.on ?? 'outcome'}\u0000${outcome}`, { from: edge.from, outcome, to });
    }
  }
  return routes;
}

export interface OverlayLoadResult {
  readonly overlays: readonly GraphOverlaySpec[];
  readonly errors: readonly GraphParseIssue[];
  readonly scannedFiles: number;
}

/** ⛔⭐ 뿌리를 «인자»로 받는다 — 그래프 로더와 같은 계약. */
export function loadGraphOverlays(dir: string): OverlayLoadResult {
  const errors: GraphParseIssue[] = [];
  const overlays: GraphOverlaySpec[] = [];
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort(); }
  catch (error) { return { overlays, errors: [{ path: dir, message: `오버레이 디렉토리를 못 읽었다: ${error instanceof Error ? error.message : String(error)}` }], scannedFiles: 0 }; }
  for (const file of files) {
    let source: string;
    try { source = readFileSync(join(dir, file), 'utf8'); }
    catch (error) { errors.push({ path: file, message: `읽기 실패: ${error instanceof Error ? error.message : String(error)}` }); continue; }
    const result = parseGraphOverlayYaml(source, file);
    errors.push(...result.errors);
    overlays.push(...result.overlays);
  }
  return { overlays, errors, scannedFiles: files.length };
}

/** ⭐ RFC §5 «4단계» — 이 상태에서 «어느» 오버레이가 얹히나. ⛔ 판정을 «값»으로 낸다.
 *
 *  🔑 「안 얹혔다」의 이유가 다섯이고 처방이 «전부 다르다»:
 *    `target-mismatch` 다른 그래프의 선언 · `does-not-apply` 조건이 거짓 — 정상
 *    `key-absent` 상태에 그 키가 «없다» — 계측 결손 · `unparseable` 조건을 못 읽었다 — 오버레이 결함
 *    `wrong-stage` 지금 얹을 때가 아니다 */
export interface OverlaySelection {
  readonly overlayId: string;
  readonly verdict: 'applies' | 'does-not-apply' | 'key-absent' | 'unparseable' | 'wrong-stage' | 'target-mismatch';
  readonly detail?: string;
}

export function selectOverlays(
  overlays: readonly GraphOverlaySpec[],
  input: { readonly graphId: string; readonly stage: OverlayStage; readonly state: Readonly<Record<string, unknown>> },
): { readonly applied: readonly GraphOverlaySpec[]; readonly selections: readonly OverlaySelection[] } {
  const selections: OverlaySelection[] = [];
  const applied: GraphOverlaySpec[] = [];
  for (const overlay of overlays) {
    if (overlay.target !== input.graphId) {
      selections.push({ overlayId: overlay.overlayId, verdict: 'target-mismatch', detail: overlay.target });
      continue;
    }
    if (overlay.stage !== input.stage) {
      selections.push({ overlayId: overlay.overlayId, verdict: 'wrong-stage', detail: overlay.stage });
      continue;
    }
    const verdict = evaluateOverlayCondition(overlay.appliesWhen, input.state);
    if (verdict.kind === 'applies') { applied.push(overlay); selections.push({ overlayId: overlay.overlayId, verdict: 'applies' }); }
    else if (verdict.kind === 'does-not-apply') selections.push({ overlayId: overlay.overlayId, verdict: 'does-not-apply' });
    else if (verdict.kind === 'key-absent') selections.push({ overlayId: overlay.overlayId, verdict: 'key-absent', detail: verdict.key });
    else selections.push({ overlayId: overlay.overlayId, verdict: 'unparseable', detail: verdict.source });
  }
  return { applied, selections };
}

/** 기본 오버레이 뿌리. ⛔ `defaultGraphsDir` 와 «같은 규율» — 다른 뿌리는 `loadGraphOverlays(dir)` 로 받는다
 *  (이 모듈이 cwd 를 보면 격리가 깨진다). */
export function defaultOverlaysDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'graphs', 'overlays');
}
