import { Document, isMap, isSeq, parse as parseYaml, type YAMLMap } from 'yaml';
import type { GraphValidationResponse } from '@/nexus/client';
import {
  addRunGraphEdge,
  addRunGraphNode,
  addRunGraphToEdge,
  readRunGraphYaml,
  writeRunGraphYaml,
} from '@/lib/run-graph-yaml-edit';
import { layeredPositions } from '@/lib/graph-edge-route';
import type { RunStep } from '../../../../../src/self-implement/run-step-projection';

/** Pure model behind the custom graph canvas (CGE-EDIT). No DOM — every edit returns a new graph.
 *  YAML goes through the existing run-graph-yaml-edit helpers; the server loader stays the authority
 *  (`/v1/graphs/validate` · parseGraphTemplateYaml). The local check only catches what the editor must
 *  pin to a node before a round trip, plus duplicate ids, which the loader does not reject. */

export interface CanvasNode {
  id: string;
  kind: string;
  recipe: string;
  maxVisits: number;
  x: number;
  y: number;
  /** Loader fields the canvas does not edit (contract, progress, fan_out…) — kept as loaded. */
  extra?: Record<string, unknown>;
}

/** `outcome` empty = unconditional `to` edge; otherwise one entry of the `on: outcome` map. */
export interface CanvasEdge {
  from: string;
  to: string;
  outcome: string;
  /** Edge fields the canvas does not edit (`on` of a loaded map edge, fallback, observed) — kept as loaded. */
  extra?: Record<string, unknown>;
}

export interface CanvasGraph {
  graphId: string;
  entry: string | null;
  /** End nodes are chosen explicitly (`terminal_nodes`) — a node may end the run and still route `fail` back. */
  terminals: string[];
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Top-level loader fields the canvas does not edit (version, loop, run_contract, state…) — kept as loaded. */
  extra?: Record<string, unknown>;
}

/** Run-time facts live beside the editable YAML graph; replay never writes them into graph.extra. */
export interface CanvasRunNode {
  visit?: number;
  enteredAt?: string;
  outcome?: string;
  exitedAt?: string;
  skipped?: { reason: string; condition?: string; at: string };
}

export interface CanvasRunUnit {
  node: string;
  unit: string;
  childRunId: string;
  resolution: number;
  expanded: boolean;
}

export interface CanvasRunModel {
  graph: CanvasGraph;
  nodes: Record<string, CanvasRunNode>;
  taken: Array<Extract<RunStep, { type: 'edge-taken' }>>;
  units: CanvasRunUnit[];
  lastSeq: number;
}

/** Construct a run overlay without modifying the source graph or its saved layout. */
export function initialCanvasRunModel(graph: CanvasGraph): CanvasRunModel {
  return { graph, nodes: {}, taken: [], units: [], lastSeq: 0 };
}

/** Apply one projected step. An already-applied seq cannot roll the canvas backwards. */
export function applyCanvasRunStep(model: CanvasRunModel, step: RunStep): CanvasRunModel {
  if (step.seq <= model.lastSeq) return model;
  const { graph, nodes, taken, units } = model;
  switch (step.type) {
    case 'node-enter':
      return { ...model, lastSeq: step.seq, nodes: { ...nodes, [step.node]: { ...nodes[step.node], visit: step.visit, enteredAt: step.ts, outcome: undefined, exitedAt: undefined, skipped: undefined } } };
    case 'node-exit':
      return { ...model, lastSeq: step.seq, nodes: { ...nodes, [step.node]: { ...nodes[step.node], outcome: step.outcome, exitedAt: step.ts } } };
    case 'node-skipped':
      return { ...model, lastSeq: step.seq, nodes: { ...nodes, [step.node]: { ...nodes[step.node], skipped: { reason: step.reason, ...(step.condition ? { condition: step.condition } : {}), at: step.ts } } } };
    case 'edge-taken':
      return { ...model, lastSeq: step.seq, taken: [...taken, step] };
    case 'node-added':
      return { ...model, lastSeq: step.seq, graph: addNode(graph, { id: step.node, kind: step.kind }).graph };
    case 'edge-rerouted':
      return { ...model, lastSeq: step.seq, graph: {
        ...graph, edges: graph.edges.map((edge) => edge.from === step.from && edge.outcome === step.outcome && edge.to === step.was
          ? { ...edge, to: step.to } : edge),
      } };
    case 'unit-expanded':
      return { ...model, lastSeq: step.seq, units: [
        ...units.filter((unit) => unit.node !== step.node || unit.unit !== step.unit),
        { node: step.node, unit: step.unit, childRunId: step.childRunId, resolution: step.resolution, expanded: true },
      ] };
    case 'unit-collapsed':
      return { ...model, lastSeq: step.seq, units: units.map((unit) => unit.node === step.node
        ? { ...unit, resolution: step.resolution, expanded: false } : unit) };
  }
}

/** Replay all shared steps in seq order, including the last one (not timestamp or arrival order). */
export function applyCanvasRunSteps(graph: CanvasGraph, steps: readonly RunStep[]): CanvasRunModel {
  return [...steps].sort((a, b) => a.seq - b.seq).reduce(applyCanvasRunStep, initialCanvasRunModel(graph));
}

export interface CanvasIssue {
  message: string;
  nodeId?: string;
  edgeIndex?: number;
  source: 'local' | 'server';
}

export const GRAPH_ID_PATTERN = /^[a-z0-9-]+$/;
/** Names the graph store keeps for itself (the save API answers 400 reserved-id). */
export const RESERVED_GRAPH_IDS: readonly string[] = ['recipes', 'overlay', 'overlays'];
/** Outcome names offered for edge labels (the graph runner routes on these). */
export const OUTCOME_SUGGESTIONS = ['ok', 'rework', 'fail'] as const;

/** Default recipe: the graph runner reads `cmd:<node_id>` from recipes.yaml. */
export function defaultRecipe(nodeId: string): string {
  return `cmd:${nodeId}`;
}
export const OUTCOME_ON = 'outcome';

export function emptyGraph(graphId = 'my-graph'): CanvasGraph {
  return { graphId, entry: null, terminals: [], nodes: [], edges: [] };
}

/** Next free id like `agent-1`; plugin kinds (`p:kind`) use their short name. */
export function nextNodeId(graph: CanvasGraph, kind: string): string {
  const base = (kind.split(':').pop() ?? 'node').replace(/[^A-Za-z0-9_-]/g, '-') || 'node';
  const taken = new Set(graph.nodes.map((node) => node.id));
  for (let n = 1; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export type CanvasFlow = 'horizontal' | 'vertical';

/** Tap-to-add placement so plan→build→review→done reads as one line: left to right (five per row) on a
 *  wide canvas, top to bottom on a phone-width one. */
export function nextNodePosition(graph: CanvasGraph, flow: CanvasFlow = 'horizontal'): { x: number; y: number } {
  const n = graph.nodes.length;
  if (flow === 'vertical') return { x: 40, y: 40 + n * 130 };
  return { x: 40 + (n % 5) * 240, y: 40 + Math.floor(n / 5) * 180 };
}

/** A back edge (rework/loop) points against the reading direction; the canvas routes it around the side. */
export function isBackEdge(graph: CanvasGraph, edge: CanvasEdge, flow: CanvasFlow = 'horizontal'): boolean {
  const from = graph.nodes.find((node) => node.id === edge.from);
  const to = graph.nodes.find((node) => node.id === edge.to);
  if (!from || !to) return false;
  return flow === 'vertical' ? to.y <= from.y : to.x <= from.x;
}

export function addNode(
  graph: CanvasGraph,
  input: { kind: string; id?: string; recipe?: string; maxVisits?: number; x?: number; y?: number; flow?: CanvasFlow },
): { graph: CanvasGraph; id: string } {
  const id = input.id ?? nextNodeId(graph, input.kind);
  if (graph.nodes.some((node) => node.id === id)) throw new Error(`이미 있는 노드 id 입니다: ${id}`);
  const at = input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : nextNodePosition(graph, input.flow);
  const node: CanvasNode = { id, kind: input.kind, recipe: input.recipe ?? defaultRecipe(id), maxVisits: input.maxVisits ?? 1, ...at };
  return { graph: { ...graph, entry: graph.entry ?? id, nodes: [...graph.nodes, node] }, id };
}

export function moveNode(graph: CanvasGraph, id: string, x: number, y: number): CanvasGraph {
  return { ...graph, nodes: graph.nodes.map((node) => node.id === id ? { ...node, x, y } : node) };
}

export function connect(graph: CanvasGraph, from: string, to: string, outcome = ''): CanvasGraph {
  const trimmed = outcome.trim();
  if (from === to) throw new Error('같은 노드끼리는 연결할 수 없습니다');
  if (graph.edges.some((edge) => edge.from === from && edge.to === to && edge.outcome === trimmed)) return graph;
  return { ...graph, edges: [...graph.edges, { from, to, outcome: trimmed }] };
}

/** Label for a newly drawn edge: `ok` unless the source already routes by plain `to` edges. */
export function defaultOutcome(graph: CanvasGraph, from: string): string {
  const out = graph.edges.filter((edge) => edge.from === from);
  if (out.some((edge) => !edge.outcome)) return '';
  return OUTCOME_SUGGESTIONS.find((name) => !out.some((edge) => edge.outcome === name)) ?? '';
}

export function updateEdge(graph: CanvasGraph, index: number, patch: Partial<CanvasEdge>): CanvasGraph {
  return {
    ...graph,
    edges: graph.edges.map((edge, i) => {
      if (i !== index) return edge;
      const outcome = (patch.outcome ?? edge.outcome).trim();
      // A loaded edge's kept fields belong to its old form (plain vs outcome map) — drop them when the form changes.
      const { extra, ...rest } = { ...edge, ...patch, outcome };
      return extra && Boolean(outcome) === Boolean(edge.outcome) ? { ...rest, extra } : rest;
    }),
  };
}

export function removeEdge(graph: CanvasGraph, index: number): CanvasGraph {
  return { ...graph, edges: graph.edges.filter((_, i) => i !== index) };
}

/** Rename carries edges and the entry along. */
export function updateNode(graph: CanvasGraph, id: string, patch: Partial<Omit<CanvasNode, 'x' | 'y'>>): CanvasGraph {
  const nextId = patch.id?.trim();
  if (nextId !== undefined && nextId !== id) {
    if (!nextId) throw new Error('노드 id 는 비울 수 없습니다');
    if (graph.nodes.some((node) => node.id === nextId)) throw new Error(`이미 있는 노드 id 입니다: ${nextId}`);
  }
  const rename = (value: string) => (nextId && value === id ? nextId : value);
  return {
    ...graph,
    entry: graph.entry === null ? null : rename(graph.entry),
    terminals: graph.terminals.map(rename),
    nodes: graph.nodes.map((node) => {
      if (node.id !== id) return node;
      // A recipe still at its default follows the rename (`cmd:old` → `cmd:new`).
      const recipe = patch.recipe ?? (nextId && node.recipe === defaultRecipe(id) ? defaultRecipe(nextId) : node.recipe);
      return { ...node, ...patch, id: nextId || id, recipe };
    }),
    edges: graph.edges.map((edge) => ({ ...edge, from: rename(edge.from), to: rename(edge.to) })),
  };
}

export function removeNode(graph: CanvasGraph, id: string): CanvasGraph {
  const nodes = graph.nodes.filter((node) => node.id !== id);
  return {
    ...graph,
    entry: graph.entry === id ? (nodes[0]?.id ?? null) : graph.entry,
    terminals: graph.terminals.filter((terminal) => terminal !== id),
    nodes,
    edges: graph.edges.filter((edge) => edge.from !== id && edge.to !== id),
  };
}

export function setEntry(graph: CanvasGraph, id: string): CanvasGraph {
  return graph.nodes.some((node) => node.id === id) ? { ...graph, entry: id } : graph;
}

export function setGraphId(graph: CanvasGraph, graphId: string): CanvasGraph {
  return { ...graph, graphId: graphId.trim() };
}

export function setTerminal(graph: CanvasGraph, id: string, terminal: boolean): CanvasGraph {
  if (!graph.nodes.some((node) => node.id === id)) return graph;
  const rest = graph.terminals.filter((entry) => entry !== id);
  return { ...graph, terminals: terminal ? [...rest, id] : rest };
}

/** Declared end nodes, in the order they were marked — the loader needs at least one. */
export function terminalNodes(graph: CanvasGraph): string[] {
  const known = new Set(graph.nodes.map((node) => node.id));
  return graph.terminals.filter((id) => known.has(id));
}

/** The `fail` route of a node (the outcome map entry the run-graph editor already uses). */
export function failTarget(graph: CanvasGraph, from: string): string | null {
  return graph.edges.find((edge) => edge.from === from && edge.outcome === 'fail')?.to ?? null;
}

/** Same conversion as setRunGraphFailTarget: a lone plain `to` edge becomes the `ok` outcome next to `fail`. */
export function setFailTarget(graph: CanvasGraph, from: string, target: string | null): CanvasGraph {
  if (target === from) throw new Error('실패 경로를 자기 자신으로 둘 수 없습니다');
  const edges = graph.edges
    .filter((edge) => !(edge.from === from && edge.outcome === 'fail'))
    .map((edge) => (target !== null && edge.from === from && !edge.outcome ? { ...edge, outcome: 'ok' } : edge));
  return { ...graph, edges: target === null ? edges : [...edges, { from, to: target, outcome: 'fail' }] };
}

/** Serialize through the shared yaml-edit helpers (same shapes the harness loader reads). */
export function toYaml(graph: CanvasGraph): string {
  const skeleton = new Document({
    graph_id: graph.graphId,
    version: typeof graph.extra?.version === 'number' ? graph.extra.version : 1,
    ...(graph.entry ? { entry_node: graph.entry } : {}),
    terminal_nodes: terminalNodes(graph),
  }).toString();
  const doc = readRunGraphYaml(skeleton);
  for (const node of graph.nodes) {
    addRunGraphNode(doc, { nodeId: node.id, kind: node.kind, recipe: node.recipe, maxVisits: node.maxVisits });
  }
  for (const edge of graph.edges) {
    if (edge.outcome) addRunGraphEdge(doc, { from: edge.from, outcome: edge.outcome, to: edge.to });
    else addRunGraphToEdge(doc, edge.from, edge.to);
  }
  // Fields the canvas does not edit go back on the same node/edge/root they were loaded from.
  for (const [key, value] of Object.entries(graph.extra ?? {})) if (!doc.has(key)) doc.set(key, doc.createNode(value));
  const nodeSeq = doc.get('nodes');
  graph.nodes.forEach((node, index) => {
    const map = isSeq(nodeSeq) ? nodeSeq.items[index] : undefined;
    if (isMap(map)) for (const [key, value] of Object.entries(node.extra ?? {})) if (!map.has(key)) map.set(key, doc.createNode(value));
  });
  const edgeSeq = doc.get('edges');
  const edgeMaps = isSeq(edgeSeq) ? edgeSeq.items.filter((item): item is YAMLMap => isMap(item)) : [];
  for (const edge of graph.edges) {
    const map = edgeMaps.find((item) => item.get('from') === edge.from && (edge.outcome ? item.has('map') : item.get('to') === edge.to));
    if (!map) continue;
    for (const [key, value] of Object.entries(edge.extra ?? {})) if (key === 'on' || !map.has(key)) map.set(key, doc.createNode(value));
  }
  return writeRunGraphYaml(doc);
}

/** Editor-side check. `kinds` = the palette vocabulary; omit to skip the kind check. */
export function validateGraph(graph: CanvasGraph, kinds?: readonly string[]): { ok: boolean; issues: CanvasIssue[] } {
  const issues: CanvasIssue[] = [];
  const push = (message: string, at: { nodeId?: string; edgeIndex?: number } = {}) => issues.push({ message, source: 'local', ...at });
  if (!GRAPH_ID_PATTERN.test(graph.graphId)) push('그래프 id 는 영문 소문자·숫자·- 만 쓸 수 있습니다');
  if (RESERVED_GRAPH_IDS.includes(graph.graphId)) push(`«${graph.graphId}» 는 예약된 그래프 id 입니다`);
  if (graph.nodes.length === 0) push('노드가 하나도 없습니다');
  const seen = new Map<string, number>();
  for (const node of graph.nodes) seen.set(node.id, (seen.get(node.id) ?? 0) + 1);
  for (const node of graph.nodes) {
    if (!node.id.trim() || /\s/.test(node.id)) push('노드 id 는 비우거나 공백을 넣을 수 없습니다', { nodeId: node.id });
    if ((seen.get(node.id) ?? 0) > 1) push(`노드 id «${node.id}» 가 겹칩니다`, { nodeId: node.id });
    if (kinds && !kinds.includes(node.kind)) push(`팔레트에 없는 kind 입니다: ${node.kind}`, { nodeId: node.id });
    if (!node.recipe.trim()) push('recipe 가 비었습니다', { nodeId: node.id });
    if (!Number.isInteger(node.maxVisits) || node.maxVisits < 1) push('max_visits 는 1 이상의 정수여야 합니다', { nodeId: node.id });
  }
  const known = new Set(graph.nodes.map((node) => node.id));
  graph.edges.forEach((edge, index) => {
    if (!known.has(edge.from)) push(`간선 출발 «${edge.from}» 은 없는 노드입니다`, { edgeIndex: index });
    if (!known.has(edge.to)) push(`간선 도착 «${edge.to}» 은 없는 노드입니다`, { edgeIndex: index, ...(known.has(edge.from) ? { nodeId: edge.from } : {}) });
  });
  for (const id of known) {
    const out = graph.edges.filter((edge) => edge.from === id);
    const plain = out.filter((edge) => !edge.outcome);
    if (plain.length > 1) push('조건 없는 간선은 노드마다 하나만 둘 수 있습니다 — 결과 이름을 붙이세요', { nodeId: id });
    if (plain.length > 0 && plain.length < out.length) push('조건 없는 간선과 결과 간선을 섞을 수 없습니다', { nodeId: id });
    const outcomes = out.filter((edge) => edge.outcome).map((edge) => edge.outcome);
    if (new Set(outcomes).size < outcomes.length) push('같은 결과 이름의 간선이 둘 이상입니다', { nodeId: id });
  }
  if (graph.nodes.length > 0) {
    if (!graph.entry || !known.has(graph.entry)) push('시작 노드를 정하세요');
    if (terminalNodes(graph).length === 0) push('끝 노드가 없습니다 — 노드를 골라 «끝 노드» 로 표시하세요');
  }
  return { ok: issues.length === 0, issues };
}

/** Attach loader errors (`<label>/nodes/<i>/…`, `<label>/edges/<i>/…`) to the node they name. */
export function mapServerIssues(yamlText: string, response: Pick<GraphValidationResponse, 'errors'>): CanvasIssue[] {
  let doc: { nodes?: Array<{ node_id?: unknown }>; edges?: Array<{ from?: unknown }> } = {};
  try { doc = (parseYaml(yamlText) ?? {}) as typeof doc; } catch { /* the server already reported the parse error */ }
  return response.errors.map((error) => {
    const node = /\/nodes\/(\d+)/.exec(error.path ?? '');
    const edge = /\/edges\/(\d+)/.exec(error.path ?? '');
    const id = node ? doc.nodes?.[Number(node[1])]?.node_id : edge ? doc.edges?.[Number(edge[1])]?.from : undefined;
    return { message: error.message, source: 'server' as const, ...(typeof id === 'string' ? { nodeId: id } : {}) };
  });
}

/** Load an existing graph (core or mine) onto the canvas. Positions follow the edge order from the entry. */
export function fromYaml(text: string): CanvasGraph {
  const raw = parseYaml(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new Error('그래프 YAML 최상위가 맵이 아닙니다');
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).flatMap((entry): CanvasNode[] => {
    const n = entry as Record<string, unknown> | null;
    if (!n || typeof n.node_id !== 'string') return [];
    return [{
      id: n.node_id,
      kind: typeof n.kind === 'string' ? n.kind : '',
      recipe: typeof n.recipe === 'string' ? n.recipe : '',
      maxVisits: typeof n.max_visits === 'number' ? n.max_visits : 1,
      x: 0, y: 0,
      ...extrasOf(n, ['node_id', 'kind', 'recipe', 'max_visits']),
    }];
  });
  const edges = (Array.isArray(raw.edges) ? raw.edges : []).flatMap((entry): CanvasEdge[] => {
    const e = entry as Record<string, unknown> | null;
    if (!e || typeof e.from !== 'string') return [];
    if (typeof e.to === 'string') return [{ from: e.from, to: e.to, outcome: '', ...extrasOf(e, ['from', 'to']) }];
    if (e.map && typeof e.map === 'object') {
      return Object.entries(e.map as Record<string, unknown>)
        .filter((pair): pair is [string, string] => typeof pair[1] === 'string')
        .map(([outcome, to]) => ({ from: e.from as string, to, outcome, ...extrasOf(e, ['from', 'map', ...(e.on === OUTCOME_ON ? ['on'] : [])]) }));
    }
    return [];
  });
  const entry = typeof raw.entry_node === 'string' ? raw.entry_node : nodes[0]?.id ?? null;
  // GRAPH-EDGE-TIDY — layered layout ranked by forward edges only (a skip branch gets its own lane).
  placeNodes(nodes, edges, entry, 'horizontal');
  const known = new Set(nodes.map((node) => node.id));
  const terminals = (Array.isArray(raw.terminal_nodes) ? raw.terminal_nodes : []).filter((id): id is string => typeof id === 'string' && known.has(id));
  return {
    graphId: typeof raw.graph_id === 'string' ? raw.graph_id : 'my-graph', entry, terminals, nodes, edges,
    ...extrasOf(raw, ['graph_id', 'entry_node', 'terminal_nodes', 'nodes', 'edges']),
  };
}

/** Card box the canvas lays out and routes with (GraphCanvasEditor fixes the card width to this). */
export const CANVAS_NODE_SIZE = { width: 180, height: 72 } as const;
/** Edge label text on the canvas — `fail` reads as «실패 시». */
export function canvasOutcomeLabel(outcome: string): string {
  return outcome === 'fail' ? '실패 시' : outcome;
}

function placeNodes(nodes: CanvasNode[], edges: readonly CanvasEdge[], entry: string | null, flow: CanvasFlow, lineLength?: number): void {
  const positions = layeredPositions(nodes.map((node) => ({ id: node.id, ...CANVAS_NODE_SIZE })), edges,
    { entry, flow, rename: canvasOutcomeLabel, ...(lineLength !== undefined ? { lineLength } : {}) });
  for (const node of nodes) {
    const at = positions.get(node.id);
    if (at) { node.x = at.x; node.y = at.y; }
  }
}

/** Re-run the layered layout (the canvas calls it on load, on a width change and after each wizard turn until a
 *  card is dragged). `lineLength` = flow px available along the reading direction at the zoom the canvas keeps; a
 *  longer chain wraps onto the next line instead of shrinking. */
export function autoLayoutToFit(graph: CanvasGraph, flow: CanvasFlow, lineLength: number | undefined): CanvasGraph {
  const nodes = graph.nodes.map((node) => ({ ...node }));
  placeNodes(nodes, graph.edges, graph.entry, flow, lineLength);
  return { ...graph, nodes };
}

/** One-line layered layout (no wrap) — kept for callers that do not know the canvas size. */
export function autoLayout(graph: CanvasGraph, flow: CanvasFlow = 'horizontal'): CanvasGraph {
  return autoLayoutToFit(graph, flow, undefined);
}

function extrasOf(source: Record<string, unknown>, known: readonly string[]): { extra?: Record<string, unknown> } {
  const extra = Object.fromEntries(Object.entries(source).filter(([key]) => !known.includes(key)));
  return Object.keys(extra).length > 0 ? { extra } : {};
}
