'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Background, Controls, Handle, Position, ReactFlow,
  type Connection, type Edge, type Node, type NodeChange, type NodeProps, type NodeTypes, type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '@/components/workflows/node-status.css';
import type { GraphKindEntry, NexusClient } from '@/nexus/client';
import type { NodeRunStatus } from '@/components/workflows/run-status-helpers';
import { nodeStatusClass } from '@/components/workflows/node-status-class';
import {
  OUTCOME_SUGGESTIONS, addNode, connect, defaultOutcome, emptyGraph, isBackEdge, failTarget, fromYaml, mapServerIssues, moveNode, removeEdge, removeNode, setEntry, setFailTarget,
  setGraphId, setTerminal, terminalNodes, toYaml, updateEdge, updateNode, validateGraph,
  type CanvasFlow, type CanvasGraph, type CanvasIssue,
} from './graph-canvas-model';
import { saveCanvasGraph } from './graph-canvas-save';

/** What a toolbar extension (e.g. CGE-RUN's «실행») reads from the canvas. */
export interface GraphCanvasContext {
  graphId: string;
  yaml: string;
  /** Local check passed and, when a server check ran on this exact YAML, it passed too. */
  valid: boolean;
  /** The current YAML is what was last saved under `graphId`. */
  saved: boolean;
  graph: CanvasGraph;
}

const KIND_MIME = 'application/x-elanous-graph-kind';
const KIND_COLORS: Record<string, string> = {
  agent: '#3b82f6', gate: '#f59e0b', git: '#10b981', judge: '#a855f7',
  observe: '#06b6d4', hitl: '#f43f5e', subgraph: '#8b5cf6',
};

interface CanvasNodeData extends Record<string, unknown> {
  id: string;
  kind: string;
  recipe: string;
  entry: boolean;
  terminal: boolean;
  issueCount: number;
  flow: CanvasFlow;
  /** CGE-RUN — the node's state in the current demo run (absent when nothing ran). */
  runStatus?: NodeRunStatus;
}

/** Run state stays on the card as colour AND a word: the shared CSS only flashes «done» once, so without this a finished
 *  run left the canvas looking untouched (live check 10-07 22:3x). */
export const RUN_STATUS_LOOK: Record<NodeRunStatus, { word: string; ring: string; chip: string }> = {
  running: { word: '● 도는 중', ring: '#3b82f6', chip: 'bg-blue-500/15 text-blue-400' },
  done: { word: '✓ 끝', ring: '#10b981', chip: 'bg-emerald-500/15 text-emerald-400' },
  failed: { word: '✗ 실패', ring: '#ef4444', chip: 'bg-red-500/15 text-red-400' },
  skipped: { word: '– 건너뜀', ring: '#6b7280', chip: 'bg-muted text-muted-foreground' },
  awaiting_approval: { word: '⏸ 승인 대기', ring: '#f59e0b', chip: 'bg-amber-500/15 text-amber-400' },
};

export function CanvasNodeCard({ data, selected }: NodeProps) {
  const node = data as CanvasNodeData;
  const vertical = node.flow === 'vertical';
  const run = node.runStatus ? RUN_STATUS_LOOK[node.runStatus] : undefined;
  return (
    <div data-testid={`canvas-node-${node.id}`} data-run-status={node.runStatus}
      className={`min-w-[170px] rounded-lg border bg-background px-3 py-2 shadow-sm ${node.issueCount ? 'border-red-500' : selected ? 'border-primary' : 'border-border'}`}
      style={{ borderLeft: `4px solid ${KIND_COLORS[node.kind] ?? '#64748b'}`, ...(run ? { boxShadow: `0 0 0 2px ${run.ring}` } : {}) }}>
      <Handle id="in" type="target" position={vertical ? Position.Top : Position.Left} className="!h-3 !w-3" />
      {/* Back edges (review → build) leave and enter on the side, so a loop never crosses the forward path. */}
      <Handle id="back-in" type="target" position={vertical ? Position.Right : Position.Bottom} className="!h-2 !w-2 !opacity-60" style={vertical ? { top: '30%' } : { left: '30%' }} />
      <Handle id="back-out" type="source" position={vertical ? Position.Right : Position.Bottom} className="!h-2 !w-2 !opacity-60" style={vertical ? { top: '70%' } : { left: '70%' }} />
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <span>{node.kind}</span>
        {node.entry && <span className="rounded bg-emerald-500/15 px-1 text-emerald-500">시작</span>}
        {node.terminal && <span className="rounded bg-sky-500/15 px-1 text-sky-500">끝</span>}
        {node.issueCount > 0 && <span className="rounded bg-red-500/15 px-1 text-red-500">오류 {node.issueCount}</span>}
        {run && <span className={`rounded px-1 font-semibold ${run.chip}`}>{run.word}</span>}
      </div>
      <div className="font-mono text-sm font-semibold text-foreground">{node.id}</div>
      <div className="max-w-[150px] truncate text-[10px] text-muted-foreground" title={node.recipe}>{node.recipe}</div>
      <Handle id="out" type="source" position={vertical ? Position.Bottom : Position.Right} className="!h-3 !w-3" />
    </div>
  );
}

const NODE_TYPES: NodeTypes = { canvas: CanvasNodeCard };
/** Back/failure routes are dashed and tinted so a loop reads apart from the forward path. */
const EDGE_TONES: Record<string, string> = { fail: '#ef4444', rework: '#f59e0b' };

type Selection = { type: 'node'; id: string } | { type: 'edge'; index: number } | null;
/** Result of the explicit «검증» (or of a save) for one exact YAML text. */
type Check = { yaml: string; issues: CanvasIssue[]; server: boolean; from?: 'save' } | null;

export function GraphCanvasEditor({
  palette,
  client,
  initialGraph,
  initialSaved,
  nodeStatus,
  renderActions,
  onChange,
  onSaved,
}: {
  palette: GraphKindEntry[];
  client: NexusClient | null;
  initialGraph?: CanvasGraph;
  /** True when `initialGraph` is already stored as «mine» (save then updates instead of creating). */
  initialSaved?: boolean;
  /** Per-node run progress (CGE-RUN) — painted with the shared node-status classes. */
  nodeStatus?: Record<string, NodeRunStatus>;
  renderActions?: (context: GraphCanvasContext) => ReactNode;
  onChange?: (context: GraphCanvasContext) => void;
  /** Called after a successful create/update so lists elsewhere can refresh. */
  onSaved?: (graphId: string) => void;
}) {
  const [graph, setGraph] = useState<CanvasGraph>(() => initialGraph ?? emptyGraph(''));
  const [selection, setSelection] = useState<Selection>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [check, setCheck] = useState<Check>(null);
  const [busy, setBusy] = useState<'validate' | 'save' | 'load' | null>(null);
  /** What the server holds for this editor session — decides create (POST) vs update (PUT). */
  const [saved, setSaved] = useState<{ id: string; yaml: string; version?: number } | null>(
    () => (initialSaved && initialGraph ? { id: initialGraph.graphId, yaml: toYaml(initialGraph) } : null));
  const [notice, setNotice] = useState<string | null>(null);
  const [graphs, setGraphs] = useState<Array<{ id: string; source: string }>>([]);
  const [linkTarget, setLinkTarget] = useState('');
  const [linkOutcome, setLinkOutcome] = useState<string | null>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // Phone-width canvas lays the graph top to bottom; the measured width decides, not the device.
  const [flow, setFlow] = useState<CanvasFlow>('horizontal');
  useEffect(() => {
    const element = canvasRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setFlow((entry?.contentRect.width ?? 1000) < 640 ? 'vertical' : 'horizontal'));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const kinds = useMemo(() => palette.map((entry) => entry.kind), [palette]);
  const yaml = useMemo(() => toYaml(graph), [graph]);
  const local = useMemo(() => validateGraph(graph, kinds), [graph, kinds]);
  const current = check?.yaml === yaml ? check : null;
  const serverIssues = current?.server ? current.issues : [];
  const issues = [...local.issues, ...serverIssues];
  const context: GraphCanvasContext = {
    graphId: graph.graphId, yaml, graph,
    valid: local.ok && serverIssues.length === 0,
    saved: saved?.id === graph.graphId && saved.yaml === yaml,
  };
  const contextRef = useRef(context);
  contextRef.current = context;
  useEffect(() => { onChange?.(contextRef.current); }, [onChange, yaml, context.valid, context.saved]);

  useEffect(() => {
    if (!client) return;
    let live = true;
    client.getRunGraphs().then((list) => { if (live) setGraphs(list.graphs); }).catch(() => { /* the load menu just stays empty */ });
    return () => { live = false; };
  }, [client, saved]);

  const edit = useCallback((change: (current: CanvasGraph) => CanvasGraph) => {
    setGraph((current) => {
      try {
        const next = change(current);
        setEditError(null);
        return next;
      } catch (error) {
        setEditError(error instanceof Error ? error.message : String(error));
        return current;
      }
    });
  }, []);

  const fitSoon = useCallback(() => {
    requestAnimationFrame(() => flowRef.current?.fitView({ padding: 0.25, maxZoom: 1.1, duration: 200 }));
  }, []);

  function addKind(kind: string, at?: { x: number; y: number }) {
    let added: string | null = null;
    edit((current) => {
      const result = addNode(current, { kind, flow, ...(at ?? {}) });
      added = result.id;
      return result.graph;
    });
    if (added) setSelection({ type: 'node', id: added });
    if (!at) fitSoon();
  }

  const nodeIssueCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) if (issue.nodeId) counts.set(issue.nodeId, (counts.get(issue.nodeId) ?? 0) + 1);
    return counts;
  }, [issues]);
  const ends = useMemo(() => new Set(terminalNodes(graph)), [graph]);
  const flowNodes: Node[] = graph.nodes.map((node) => ({
    id: node.id,
    type: 'canvas',
    position: { x: node.x, y: node.y },
    selected: selection?.type === 'node' && selection.id === node.id,
    className: nodeStatus ? nodeStatusClass(nodeStatus[node.id]) : undefined,
    data: { id: node.id, kind: node.kind, recipe: node.recipe, entry: graph.entry === node.id, terminal: ends.has(node.id), issueCount: nodeIssueCount.get(node.id) ?? 0, flow,
      ...(nodeStatus?.[node.id] ? { runStatus: nodeStatus[node.id] } : {}) } satisfies CanvasNodeData,
  }));
  const flowEdges: Edge[] = graph.edges.map((edge, index) => {
    const back = isBackEdge(graph, edge, flow);
    return {
    id: `e${index}`,
    source: edge.from,
    target: edge.to,
    sourceHandle: back ? 'back-out' : 'out',
    targetHandle: back ? 'back-in' : 'in',
    ...(back ? { type: 'smoothstep', pathOptions: { offset: 40 } } : {}),
    selected: selection?.type === 'edge' && selection.index === index,
    animated: nodeStatus?.[edge.from] === 'done' && nodeStatus?.[edge.to] === 'running',
    style: { strokeWidth: 2, ...(EDGE_TONES[edge.outcome] ? { stroke: EDGE_TONES[edge.outcome], strokeDasharray: '6 4' } : {}) },
    labelStyle: EDGE_TONES[edge.outcome] ? { fill: EDGE_TONES[edge.outcome], fontWeight: 600 } : undefined,
    label: edge.outcome === 'fail' ? '실패 시' : edge.outcome || undefined,
    };
  });

  function onNodesChange(changes: NodeChange[]) {
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        const { id, position } = change;
        edit((current) => moveNode(current, id, position.x, position.y));
      }
    }
  }

  /** «검증» — never saves. Local check first; when it passes, the server loader (`/v1/graphs/validate`) decides. */
  async function runCheck() {
    setNotice(null);
    const checking = yaml;
    if (!local.ok || !client) { setCheck({ yaml: checking, issues: local.issues, server: false }); return; }
    setBusy('validate');
    try {
      const response = await client.validateGraph('harness', checking);
      setCheck({ yaml: checking, issues: response.ok && response.errors.length === 0 ? [] : mapServerIssues(checking, response), server: true });
    } catch (error) {
      setCheck({ yaml: checking, issues: [{ source: 'server', message: `검증 요청 실패: ${error instanceof Error ? error.message : String(error)}` }], server: true });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!client || !local.ok) { void runCheck(); return; }
    setBusy('save');
    setNotice(null);
    const savingYaml = yaml;
    const savingId = graph.graphId;
    try {
      const result = await saveCanvasGraph(client, savingId, savingYaml, saved?.id === savingId ? 'update' : 'create');
      if (result.ok) {
        setSaved({ id: savingId, yaml: savingYaml, ...(result.version !== undefined ? { version: result.version } : {}) });
        setNotice(`«${savingId}» 를 ${result.created ? '새로 ' : ''}저장했습니다${result.version !== undefined ? ` (v${result.version})` : ''}`);
        onSaved?.(savingId);
      } else {
        setCheck({ yaml: savingYaml, issues: result.issues, server: true, from: 'save' });
      }
    } finally {
      setBusy(null);
    }
  }

  async function load(id: string) {
    if (!client || !id) return;
    setBusy('load');
    try {
      const loaded = await client.getRunGraphYaml(id);
      const next = fromYaml(loaded.yaml);
      setGraph(next);
      setSelection(null);
      setCheck(null);
      setSaved(loaded.source === 'mine' ? { id: loaded.id, yaml: toYaml(next) } : null);
      setNotice(loaded.source === 'mine' ? `«${id}» 를 불러왔습니다` : `«${id}» 는 기본 제공 그래프입니다 — id 를 바꿔 내 그래프로 저장하세요`);
      fitSoon();
    } catch (error) {
      setEditError(`불러오기 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }

  const selectedNode = selection?.type === 'node' ? graph.nodes.find((node) => node.id === selection.id) ?? null : null;
  const selectedEdge = selection?.type === 'edge' ? graph.edges[selection.index] ?? null : null;
  const graphIssues = issues.filter((issue) => !issue.nodeId);
  const checkLine = busy === 'validate' ? null : current;
  const idRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (!graph.graphId) idRef.current?.focus(); }, [graph.graphId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-graph-id={graph.graphId} aria-label="그래프 만들기">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <label className="flex items-center gap-1 text-muted-foreground">그래프 id
          <input ref={idRef} aria-label="그래프 id" value={graph.graphId} spellCheck={false} placeholder="예: my-graph" autoCapitalize="off" autoCorrect="off"
            onChange={(event) => edit((current) => setGraphId(current, event.target.value))}
            className="w-36 rounded border border-border bg-background px-2 py-1 font-mono text-foreground" />
        </label>
        <button type="button" onClick={() => { setGraph(emptyGraph('')); setSelection(null); setCheck(null); setSaved(null); setNotice(null); setEditError(null); }}
          className="rounded border border-border px-2 py-1">새 그래프</button>
        {client && (
          <select aria-label="그래프 불러오기" value="" disabled={busy !== null} onChange={(event) => { void load(event.target.value); }}
            className="max-w-[10rem] rounded border border-border bg-background px-1 py-1">
            <option value="">불러오기…</option>
            {graphs.map((entry) => <option key={entry.id} value={entry.id}>{entry.id}{entry.source === 'mine' ? ' · 내 그래프' : ''}</option>)}
          </select>
        )}
        <span className="text-muted-foreground">{context.saved ? `저장됨${saved?.version !== undefined ? ` · v${saved.version}` : ''}` : saved?.id === graph.graphId ? '저장 안 된 변경' : '아직 저장 안 함'}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => { void runCheck(); }} disabled={busy !== null}
            title={client ? '저장하지 않고 서버의 그래프 로더로 검증합니다' : 'Daemon 연결이 없어 로컬 검사만 합니다'}
            className="rounded border border-border px-3 py-1 disabled:opacity-50">{busy === 'validate' ? '검증 중…' : '검증'}</button>
          <button type="button" onClick={() => { void save(); }} disabled={!client || busy !== null || context.saved}
            className="rounded bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50">{busy === 'save' ? '저장 중…' : '저장'}</button>
          {renderActions?.(context)}
        </div>
      </div>
      {checkLine && (checkLine.issues.length === 0 ? (
        <p role="status" data-testid="graph-check-line" className="border-b border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-500">
          ✓ 검증 통과{checkLine.server ? '' : ' (로컬 검사 — Daemon 연결 없음)'}
        </p>
      ) : (
        <div role="alert" data-testid="graph-check-line" className="border-b border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm text-red-500">
          <p className="font-medium">✗ {checkLine.from === 'save' ? '저장 실패' : '검증 실패'} {checkLine.issues.length}건</p>
          <ul className="mt-0.5 list-disc pl-5 text-xs">
            {checkLine.issues.map((issue, index) => <li key={index}>{issue.nodeId ? <span className="font-mono">{issue.nodeId}: </span> : null}{issue.message}</li>)}
          </ul>
        </div>
      ))}
      {(editError || notice) && (
        <p role={editError ? 'alert' : 'status'} className={`border-b border-border px-3 py-1 text-xs ${editError ? 'text-red-500' : 'text-emerald-500'}`}>{editError ?? notice}</p>
      )}
      <datalist id="graph-canvas-outcomes">{OUTCOME_SUGGESTIONS.map((name) => <option key={name} value={name} />)}</datalist>
      <div className="flex min-h-0 flex-1 flex-col min-[900px]:flex-row">
        <aside aria-label="노드 팔레트" className="shrink-0 border-b border-border p-2 min-[900px]:w-44 min-[900px]:overflow-y-auto min-[900px]:border-b-0 min-[900px]:border-r">
          <p className="mb-1 text-[11px] text-muted-foreground"><span className="min-[900px]:hidden">눌러서 추가</span><span className="hidden min-[900px]:inline">끌어 놓거나 눌러서 추가</span></p>
          <ul className="flex gap-1 overflow-x-auto min-[900px]:flex-col min-[900px]:overflow-visible">
            {palette.map((entry) => (
              <li key={`${entry.plugin ?? 'core'}:${entry.kind}`} className="shrink-0">
                <button type="button" draggable title={entry.description || entry.kind}
                  aria-label={`${entry.kind} 노드 추가`}
                  onDragStart={(event) => { event.dataTransfer.setData(KIND_MIME, entry.kind); event.dataTransfer.effectAllowed = 'copy'; }}
                  onClick={() => addKind(entry.kind)}
                  className="flex w-full items-center gap-1 rounded border border-border bg-background px-2 py-1.5 text-left text-xs hover:bg-muted"
                  style={{ borderLeft: `4px solid ${KIND_COLORS[entry.kind] ?? '#64748b'}` }}>
                  <span aria-hidden>＋</span>{entry.kind}
                  {entry.plugin && <small className="rounded bg-accent/15 px-1 text-accent">{entry.plugin}</small>}
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <section ref={canvasRef} aria-label="그래프 캔버스" className="relative h-[56vh] min-h-[300px] shrink-0 bg-background min-[900px]:h-auto min-[900px]:flex-1"
          onDragOver={(event) => {
            if (Array.from(event.dataTransfer.types).includes(KIND_MIME)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
          }}
          onDrop={(event) => {
            const kind = event.dataTransfer.getData(KIND_MIME);
            if (!kind || !kinds.includes(kind)) return;
            event.preventDefault();
            const at = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 40, y: 40 };
            addKind(kind, { x: at.x - 85, y: at.y - 30 });
          }}>
          {graph.nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
              빈 캔버스입니다. 팔레트에서 노드를 끌어 놓거나 눌러서 추가하세요.
            </div>
          )}
          <ReactFlow nodes={flowNodes} edges={flowEdges} nodeTypes={NODE_TYPES}
            onInit={(instance) => { flowRef.current = instance; }}
            onNodesChange={onNodesChange}
            onConnect={(connection: Connection) => {
              if (connection.source && connection.target) edit((current) => connect(current, connection.source, connection.target, defaultOutcome(current, connection.source)));
            }}
            onNodeClick={(_event, node) => setSelection({ type: 'node', id: node.id })}
            onEdgeClick={(_event, edge) => setSelection({ type: 'edge', index: Number(edge.id.slice(1)) })}
            onPaneClick={() => setSelection(null)}
            deleteKeyCode={null} fitView fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
            minZoom={0.3} maxZoom={1.5} className="!bg-background">
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </section>
        <aside aria-label="속성" className="shrink-0 overflow-y-auto border-t border-border p-3 text-xs min-[900px]:w-72 min-[900px]:border-l min-[900px]:border-t-0">
          {selectedNode ? (
            <NodePanel key={selectedNode.id} graph={graph} nodeId={selectedNode.id} palette={palette}
              issues={issues.filter((issue) => issue.nodeId === selectedNode.id)}
              linkTarget={linkTarget} linkOutcome={linkOutcome} setLinkTarget={setLinkTarget} setLinkOutcome={setLinkOutcome}
              onEdit={edit}
              onRenamed={(id) => setSelection({ type: 'node', id })}
              onRemoved={() => setSelection(null)} />
          ) : selectedEdge && selection?.type === 'edge' ? (
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold">간선 <span className="font-mono">{selectedEdge.from} → {selectedEdge.to}</span></h2>
              <label className="flex flex-col gap-1 text-muted-foreground">결과 이름 (비우면 조건 없이 이어짐)
                <input aria-label="간선 결과" list="graph-canvas-outcomes" value={selectedEdge.outcome} placeholder="예: pass · fail"
                  onChange={(event) => edit((current) => updateEdge(current, selection.index, { outcome: event.target.value }))}
                  className="rounded border border-border bg-background px-2 py-1 font-mono text-foreground" />
              </label>
              <button type="button" onClick={() => { edit((current) => removeEdge(current, selection.index)); setSelection(null); }}
                className="self-start rounded border border-red-500 px-2 py-1 text-red-500">간선 삭제</button>
            </div>
          ) : (
            <div className="flex flex-col gap-2 text-muted-foreground">
              <h2 className="text-sm font-semibold text-foreground">속성</h2>
              <p>노드를 누르면 id·kind·recipe 를 고칠 수 있습니다. 노드 오른쪽 점을 다른 노드로 끌거나, 노드를 고른 뒤 «다음 노드 연결» 로 간선을 잇습니다.</p>
              <p>노드 {graph.nodes.length} · 간선 {graph.edges.length}{graph.entry ? ` · 시작 ${graph.entry}` : ''}</p>
            </div>
          )}
          {graphIssues.length > 0 && (
            <ul aria-label="그래프 오류" className="mt-3 flex flex-col gap-1 border-t border-border pt-2">
              {graphIssues.map((issue, index) => <li key={index} className="text-red-500">{issue.message}</li>)}
            </ul>
          )}
          <details className="mt-3 border-t border-border pt-2">
            <summary className="cursor-pointer text-muted-foreground">YAML 보기</summary>
            <pre aria-label="그래프 YAML" className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-[11px] text-foreground">{yaml}</pre>
          </details>
        </aside>
      </div>
    </div>
  );
}

function NodePanel({
  graph, nodeId, palette, issues, linkTarget, linkOutcome, setLinkTarget, setLinkOutcome, onEdit, onRenamed, onRemoved,
}: {
  graph: CanvasGraph;
  nodeId: string;
  palette: GraphKindEntry[];
  issues: CanvasIssue[];
  linkTarget: string;
  linkOutcome: string | null;
  setLinkTarget: (value: string) => void;
  setLinkOutcome: (value: string | null) => void;
  onEdit: (change: (current: CanvasGraph) => CanvasGraph) => void;
  onRenamed: (id: string) => void;
  onRemoved: () => void;
}) {
  const node = graph.nodes.find((entry) => entry.id === nodeId)!;
  const [draftId, setDraftId] = useState(node.id);
  const [renameError, setRenameError] = useState<string | null>(null);
  const targets = graph.nodes.filter((entry) => entry.id !== nodeId).map((entry) => entry.id);
  const target = targets.includes(linkTarget) ? linkTarget : (targets[0] ?? '');
  const outcome = linkOutcome ?? defaultOutcome(graph, nodeId);
  const kindEntry = palette.find((entry) => entry.kind === node.kind);
  const outgoing = graph.edges.map((edge, index) => ({ edge, index })).filter(({ edge }) => edge.from === nodeId);

  function commitRename() {
    const next = draftId.trim();
    if (next === node.id) return;
    try {
      updateNode(graph, node.id, { id: next });
      onEdit((current) => updateNode(current, node.id, { id: next }));
      setRenameError(null);
      onRenamed(next);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">노드 <span className="font-mono">{node.id}</span></h2>
      <label className="flex flex-col gap-1 text-muted-foreground">id
        <input aria-label="노드 id" value={draftId} spellCheck={false}
          onChange={(event) => setDraftId(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => { if (event.key === 'Enter') commitRename(); }}
          className="rounded border border-border bg-background px-2 py-1 font-mono text-foreground" />
      </label>
      {renameError && <p role="alert" className="text-red-500">{renameError}</p>}
      <label className="flex flex-col gap-1 text-muted-foreground">kind
        <select aria-label="노드 kind" value={node.kind} onChange={(event) => onEdit((current) => updateNode(current, nodeId, { kind: event.target.value }))}
          className="rounded border border-border bg-background px-1 py-1 text-foreground">
          {!kindEntry && <option value={node.kind}>{node.kind} (팔레트에 없음)</option>}
          {palette.map((entry) => <option key={`${entry.plugin ?? 'core'}:${entry.kind}`} value={entry.kind}>{entry.kind}{entry.plugin ? ` · ${entry.plugin}` : ''}</option>)}
        </select>
      </label>
      {kindEntry?.description && <p className="text-[11px] text-muted-foreground">{kindEntry.description}</p>}
      <label className="flex flex-col gap-1 text-muted-foreground">recipe
        <input aria-label="recipe" value={node.recipe} spellCheck={false}
          onChange={(event) => onEdit((current) => updateNode(current, nodeId, { recipe: event.target.value }))}
          className="rounded border border-border bg-background px-2 py-1 font-mono text-foreground" />
      </label>
      <label className="flex flex-col gap-1 text-muted-foreground">최대 방문 (max_visits)
        <input aria-label="max_visits" type="number" min={1} step={1} value={node.maxVisits}
          onChange={(event) => onEdit((current) => updateNode(current, nodeId, { maxVisits: Number(event.target.value) }))}
          className="w-24 rounded border border-border bg-background px-2 py-1 text-foreground" />
      </label>
      <label className="flex items-center gap-2 text-foreground">
        <input type="checkbox" aria-label="끝 노드" checked={graph.terminals.includes(nodeId)}
          onChange={(event) => onEdit((current) => setTerminal(current, nodeId, event.target.checked))} />
        끝 노드 (여기서 실행이 끝남)
      </label>
      <div className="flex flex-wrap gap-2">
        {graph.entry === nodeId
          ? <span className="rounded bg-emerald-500/15 px-2 py-1 text-emerald-500">시작 노드</span>
          : <button type="button" onClick={() => onEdit((current) => setEntry(current, nodeId))} className="rounded border border-border px-2 py-1">시작 노드로</button>}
        <button type="button" onClick={() => { onEdit((current) => removeNode(current, nodeId)); onRemoved(); }}
          className="rounded border border-red-500 px-2 py-1 text-red-500">노드 삭제</button>
      </div>
      <label className="flex flex-col gap-1 border-t border-border pt-2 text-muted-foreground">실패 시 다음 노드
        <select aria-label="실패 시 다음 노드" value={failTarget(graph, nodeId) ?? ''}
          onChange={(event) => onEdit((current) => setFailTarget(current, nodeId, event.target.value || null))}
          className="rounded border border-border bg-background px-1 py-1 font-mono text-foreground">
          <option value="">선택 안 함</option>
          {targets.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </label>
      <fieldset className="mt-1 flex flex-col gap-1 border-t border-border pt-2">
        <legend className="text-muted-foreground">다음 노드 연결</legend>
        {targets.length === 0 ? <p className="text-muted-foreground">이을 다른 노드가 없습니다.</p> : (
          <div className="flex flex-wrap items-center gap-1">
            <select aria-label="연결할 노드" value={target} onChange={(event) => setLinkTarget(event.target.value)}
              className="rounded border border-border bg-background px-1 py-1 font-mono text-foreground">
              {targets.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
            <input aria-label="연결 결과" list="graph-canvas-outcomes" value={outcome} placeholder="결과(비우면 조건 없음)" onChange={(event) => setLinkOutcome(event.target.value)}
              className="w-24 rounded border border-border bg-background px-2 py-1 font-mono text-foreground" />
            <button type="button" onClick={() => { onEdit((current) => connect(current, nodeId, target, outcome)); setLinkOutcome(null); }}
              className="rounded border border-border px-2 py-1">연결</button>
          </div>
        )}
        {outgoing.length > 0 && (
          <ul className="flex flex-col gap-1">
            {outgoing.map(({ edge, index }) => (
              <li key={index} className="flex items-center gap-2 font-mono">
                <span>→ {edge.to}{edge.outcome ? ` (${edge.outcome})` : ''}</span>
                <button type="button" aria-label={`${edge.to} 간선 삭제`} onClick={() => onEdit((current) => removeEdge(current, index))}
                  className="rounded px-1 text-red-500 hover:bg-red-500/10">삭제</button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {issues.length > 0 && (
        <ul aria-label="노드 오류" className="flex flex-col gap-1 border-t border-border pt-2">
          {issues.map((issue, index) => <li key={index} className="text-red-500">{issue.message}</li>)}
        </ul>
      )}
    </div>
  );
}
