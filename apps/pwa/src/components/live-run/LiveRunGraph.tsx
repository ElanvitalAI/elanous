'use client';

// HARNESS-RUN-LIVE-GRAPH (0.2.21 · «하니스가 돌아가는 장면을 그래프 편집기 형태로»).
// 런 하나를 확대해서 «실제 노드·간선이 도는 장면»을 그린다 — 그래프는 «하나»다: 그 런의 그래프(YAML)가 선언한 노드를
// 전부 그리고(입구·대기열·저작·배치·착지·실패 쪽 노드가 선언되면 그것도), 원장에 사건이 없는 노드는 «기록 없음»으로 흐리게 둔다.
// 배치·간선은 편집기와 같다(`runGraphToFlow` · `graph-edge-route` 의 깔끔한 간선).
// 데이터 = GET /v1/harness/run-traversal (원장 `pipeline-node-entry` ⊕ 노드별 결과 사건) ⊕ GET /v1/graphs/<graphId>.
// 도는 런은 4초마다 다시 읽어 «라이브»로 따라가고, 끝난 런은 재생(1×·4×·16×)한다.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BaseEdge, Background, Controls, EdgeLabelRenderer, Handle, Position, ReactFlow, type EdgeProps, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '@/components/workflows/node-status.css';
import { useNexusClient } from '@/nexus/hooks/use-nexus-context';
import type { HarnessRunTraversal, RunGraphDetail } from '@/nexus/client';
import { RUN_NODE_WIDTH, runGraphToFlow, type RunGraphNodeData } from '@/lib/run-graph-flow';
import { EDGE_FAMILY_COLOR } from '@/lib/graph-edge-route';
import type { TidyEdgeData } from '@/components/workflows/TidyEdge';
import { durationLabel, kstClock, replayDelayMs, sceneAt, type LiveNodeState, type SceneEdge, type TraversalStep } from '@/lib/live-run-scene';
import { graphFromSteps, mergeWalked, runStatusLabel } from '@/lib/live-run-view';
import { aggregateGroupState, collapseGroups, GROUP_NODE_PREFIX, groupBoxes, groupNames, groupOf, isGroupNodeId, type GroupedRunGraph } from '@/components/editor/graph-groups';
import { GROUP_BOX_NODE_TYPES, type GroupBoxData } from '@/components/editor/GraphGroupBox';

const KIND_COLORS: Record<string, string> = {
  agent: '#3b82f6', gate: '#f59e0b', git: '#10b981', judge: '#a855f7',
  observe: '#06b6d4', hitl: '#f43f5e', subgraph: '#8b5cf6',
};
const STATE_RING: Record<LiveNodeState, string> = {
  pending: 'var(--border, #cbd5e1)', running: '#f59e0b', passed: 'var(--chart-2, #16a34a)', failed: 'var(--destructive, #ef4444)',
};
const STATE_WORD: Record<LiveNodeState, string> = { pending: '대기', running: '도는 중', passed: '통과', failed: '실패' };
const STATE_CLASS: Record<LiveNodeState, string> = {
  pending: 'workflow-node-status', running: 'workflow-node-status workflow-node-status-running',
  passed: 'workflow-node-status workflow-node-status-done', failed: 'workflow-node-status workflow-node-status-failed',
};
const SPEEDS = [1, 4, 16] as const;

interface LiveNodeData extends RunGraphNodeData {
  state: LiveNodeState;
  /** The run is over and never entered this node — «기록 없음», not «대기». */
  unrecorded: boolean;
  visits: number;
  focused: boolean;
}

function LiveNode({ data }: NodeProps) {
  const node = data as LiveNodeData;
  return (
    <div data-testid={`live-node-${node.label}`} data-state={node.state}
      className={`relative rounded-lg border-2 bg-surface px-3 py-2 shadow-sm transition-opacity duration-300 ${STATE_CLASS[node.state]} ${node.state === 'pending' ? node.unrecorded ? 'opacity-35' : 'opacity-60' : ''}`}
      style={{ width: RUN_NODE_WIDTH, height: node.height, borderColor: STATE_RING[node.state], borderLeft: `5px solid ${KIND_COLORS[node.kind] ?? '#64748b'}`, outline: node.focused ? '2px solid var(--accent, #8b5cf6)' : undefined, outlineOffset: 3 }}>
      <Handle id="in" type="target" position={Position.Left} className="!pointer-events-none !opacity-0" />
      <div className="flex items-center gap-1 text-[11px] text-text-tertiary">
        <span>{node.kind === 'subgraph' ? '묶음 · 눌러서 펼치기' : node.kind}</span>
        {node.entry && <span className="rounded bg-success/15 px-1 text-success">시작</span>}
        {node.terminal && <span className="rounded bg-accent/15 px-1 text-accent">끝</span>}
        <span className="ml-auto font-medium" style={{ color: STATE_RING[node.state] }}>{node.unrecorded ? '기록 없음' : STATE_WORD[node.state]}</span>
      </div>
      <div className="truncate font-mono text-sm font-semibold text-text-primary">{isGroupNodeId(node.label) ? `▣ ${node.label.slice(GROUP_NODE_PREFIX.length)}` : node.label}</div>
      <div className="truncate text-[11px] text-text-tertiary" title={node.recipe}>{node.recipe} · 최대 {node.maxVisits}회</div>
      {node.visits > 1 && (
        <span data-testid={`visit-badge-${node.label}`} className="absolute -right-2 -top-2 rounded-full bg-amber-500 px-1.5 text-xs font-bold text-white shadow">×{node.visits}</span>
      )}
      <Handle id="out" type="source" position={Position.Right} className="!pointer-events-none !opacity-0" />
    </div>
  );
}

interface LiveEdgeData extends TidyEdgeData {
  taken: boolean;
  active: boolean;
  tokenKey: string;
  tokenMs: number;
}

/** Same pre-routed path as the editor's tidy edge; taken edges light up, untaken dim, the active one carries a token. */
function LiveEdge({ id, data, markerEnd }: EdgeProps) {
  const edge = data as LiveEdgeData | undefined;
  if (!edge?.route) return null;
  const { route } = edge;
  const color = EDGE_FAMILY_COLOR[route.family];
  const dashed = route.kind === 'back';
  return (
    <>
      <BaseEdge id={id} path={route.path} markerEnd={markerEnd}
        style={{ stroke: color, strokeWidth: edge.active ? 4 : edge.taken ? 3 : 1.5, opacity: edge.active || edge.taken ? 1 : 0.22, transition: 'opacity 300ms, stroke-width 300ms', ...(dashed ? { strokeDasharray: '6 4' } : {}) }} />
      {edge.active && (
        <g key={edge.tokenKey} data-testid={`edge-token-${route.from}-${route.to}`}>
          <circle r={7} fill={color} opacity={0.25}>
            <animateMotion dur={`${edge.tokenMs}ms`} fill="freeze" path={route.path} />
          </circle>
          <circle r={4.5} fill={color} stroke="var(--background, #fff)" strokeWidth={1.5}>
            <animateMotion dur={`${edge.tokenMs}ms`} fill="freeze" path={route.path} />
          </circle>
        </g>
      )}
      {route.label && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan pointer-events-none absolute whitespace-nowrap rounded-full border px-1.5 font-mono text-[11px] leading-4"
            style={{
              transform: `translate(-50%, -50%) translate(${route.label.x}px, ${route.label.y}px)`, width: route.label.width, textAlign: 'center',
              borderColor: color, color, background: 'var(--background, #fff)', opacity: edge.active || edge.taken ? 1 : 0.35,
              fontWeight: edge.active ? 700 : 500,
            }}>
            {route.label.text}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const NODE_TYPES = { live: LiveNode, ...GROUP_BOX_NODE_TYPES };
const EDGE_TYPES = { live: LiveEdge };
export function LiveRunGraph({ runId, initialFolded = false }: { runId: string; /** `?units=folded` — start with every unit folded. */ initialFolded?: boolean }) {
  const client = useNexusClient();
  const traversal = useQuery({
    queryKey: ['harness-run-traversal', runId],
    queryFn: () => client.getHarnessRunTraversal(runId),
    refetchInterval: (query) => (query.state.data as HarnessRunTraversal | undefined)?.status === 'running' ? 4000 : false,
  });
  const run = traversal.data;
  const graphQuery = useQuery({
    queryKey: ['run-graph', run?.graphId],
    queryFn: () => client.getRunGraph(run!.graphId!),
    enabled: Boolean(run?.graphId),
    retry: false,
    staleTime: 60_000,
  });
  const steps: TraversalStep[] = useMemo(() => run?.steps ?? [], [run]);
  const graph: RunGraphDetail | null = useMemo(() => {
    if (!run) return null;
    const real = graphQuery.data;
    // 선언된 그래프를 그리고, 런이 선언 밖 노드를 밟았으면 그것만 더한다(선언 노드는 지우지 않는다).
    // 그래프 정의를 못 읽었을 때만 «밟은 길»로 세운다(지어내지 않는다).
    if (real) return mergeWalked(real, steps);
    if (graphQuery.isLoading && run.graphId) return null;
    return graphFromSteps(run.graphId ?? run.runId, steps);
  }, [run, graphQuery.data, graphQuery.isLoading, steps]);
  // 묶음: 접은 묶음은 노드 하나로, 펼친 묶음은 이름 붙은 상자로. 기본 = 통합 보기(전부 펼침).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const units = useMemo(() => graph ? groupNames(graph as GroupedRunGraph) : [], [graph]);
  const unitOf = useMemo(() => graph ? groupOf(graph as GroupedRunGraph) : new Map<string, string>(), [graph]);
  const foldApplied = useRef(false);
  useEffect(() => {
    if (!initialFolded || foldApplied.current || units.length === 0) return;
    foldApplied.current = true;
    setCollapsed(new Set(units));
  }, [initialFolded, units]);
  const view = useMemo(() => graph ? collapseGroups(graph as GroupedRunGraph, collapsed) : null, [graph, collapsed]);
  const flow = useMemo(() => view ? runGraphToFlow(view.graph) : null, [view]);
  // 장면은 «그려진» 노드 위에서 돈다 — 접힌 묶음 안의 노드 방문은 그 묶음 노드의 방문이다.
  const viewSteps: TraversalStep[] = useMemo(() => view ? steps.map((step) => ({ ...step, node: view.resolve(step.node) })) : steps, [view, steps]);
  const sceneEdges: SceneEdge[] = useMemo(() => flow?.edges.map((edge) => ({
    id: edge.id, from: edge.source, to: edge.target, outcomes: (edge.data as unknown as TidyEdgeData).route.outcomes,
  })) ?? [], [flow]);

  const live = run?.status === 'running';
  const [mode, setMode] = useState<'live' | 'replay' | null>(null);
  const effectiveMode = mode ?? (live ? 'live' : 'replay');
  const [cursor, setCursor] = useState(-1);
  const [entering, setEntering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(4);
  const [focus, setFocus] = useState<string | null>(null);
  // 카메라 따라가기 — 그래프가 넓으면 전체 맞춤은 글자가 작아진다. 재생·라이브 중엔 지금 노드로 다가가 따라간다.
  const [follow, setFollow] = useState(true);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const canvasRef = useRef<HTMLElement | null>(null);
  // onInit 뒤에 카메라 따라가기를 다시 걸기 위한 신호(첫 이동이 인스턴스 준비 전에 지나가지 않게).
  const [flowReady, setFlowReady] = useState(0);
  const started = useRef(false);

  // 처음 열면: 라이브 런은 마지막 노드에, 끝난 런은 처음부터 자동 재생.
  useEffect(() => {
    if (!run || started.current || steps.length === 0) return;
    started.current = true;
    if (run.status === 'running') { setCursor(steps.length - 1); setEntering(steps.at(-1)!.outcome === null); }
    else { setCursor(0); setEntering(true); setPlaying(true); }
  }, [run, steps]);

  // 라이브 따라가기 — 새 노드가 원장에 들어오면 커서가 따라간다.
  useEffect(() => {
    if (effectiveMode !== 'live' || steps.length === 0) return;
    setCursor(steps.length - 1);
    setEntering(steps.at(-1)!.outcome === null);
  }, [effectiveMode, steps]);

  // 재생 — 노드가 «들어가며 빛나고» 절반 뒤 결과 색으로 가라앉고, 다음 노드로 토큰이 간다.
  useEffect(() => {
    if (effectiveMode !== 'replay' || !playing || steps.length === 0) return;
    const delay = replayDelayMs(steps, cursor, speed);
    const settle = window.setTimeout(() => setEntering(false), delay / 2);
    const advance = window.setTimeout(() => {
      if (cursor >= steps.length - 1) { setPlaying(false); return; }
      setCursor((value) => value + 1);
      setEntering(true);
    }, delay);
    return () => { window.clearTimeout(settle); window.clearTimeout(advance); };
  }, [effectiveMode, playing, cursor, speed, steps]);

  const visited = useMemo(() => new Set(viewSteps.map((step) => step.node)), [viewSteps]);
  const scene = useMemo(() => sceneAt(flow?.nodes.map((node) => node.id) ?? [], sceneEdges, viewSteps, cursor, entering), [flow, sceneEdges, viewSteps, cursor, entering]);
  const toggleUnit = useCallback((group: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  }), []);
  const tokenMs = effectiveMode === 'replay' ? Math.max(250, replayDelayMs(steps, Math.max(0, cursor - 1), speed) * 0.6) : 1200;
  const nodes = useMemo(() => {
    if (!flow) return [];
    const cards = flow.nodes.map((node) => ({
      ...node, type: 'live', zIndex: 1,
      data: {
        ...node.data, state: scene.nodeState[node.id] ?? 'pending', visits: scene.visits[node.id] ?? 0, focused: focus === node.id,
        unrecorded: !live && !visited.has(node.id),
      } satisfies LiveNodeData,
    }));
    const boxes = groupBoxes(flow.nodes.map((node) => ({ id: node.id, position: node.position, width: RUN_NODE_WIDTH, height: node.data.height })), unitOf)
      .map((box) => ({
        id: box.id, type: 'groupBox', position: { x: box.x, y: box.y }, zIndex: 0, selectable: false, draggable: false, focusable: false,
        data: {
          group: box.group, memberCount: box.members.length, width: box.width, height: box.height, onCollapse: toggleUnit,
          state: aggregateGroupState(box.members.map((id) => scene.nodeState[id] ?? 'pending')),
          unrecorded: !live && box.members.every((id) => !visited.has(id)),
        } satisfies GroupBoxData,
      }));
    return [...boxes, ...cards];
  }, [flow, scene, focus, live, visited, unitOf, toggleUnit]);
  const edges = useMemo(() => flow?.edges.map((edge) => ({
    ...edge, type: 'live',
    data: { ...(edge.data as unknown as TidyEdgeData), taken: scene.takenEdges.has(edge.id), active: scene.activeEdge === edge.id, tokenKey: `${edge.id}:${scene.cursor}`, tokenMs } satisfies LiveEdgeData,
  })) ?? [], [flow, scene, tokenMs]);

  const zoomTo = useCallback((nodeId: string | null) => {
    setFocus(nodeId);
    const instance = flowRef.current;
    if (!instance) return;
    if (nodeId) void instance.fitView({ nodes: [{ id: nodeId }], duration: 600, maxZoom: 1.4, padding: 0.6 });
    else void instance.fitView({ duration: 600, padding: 0.08, minZoom: 0.5 });
  }, []);

  const followNode = viewSteps[cursor]?.node ?? null;
  useEffect(() => {
    if (!follow || focus || !followNode || !flow) return;
    const node = flow.nodes.find((candidate) => candidate.id === followNode);
    const instance = flowRef.current;
    if (!node || !instance) return;
    // 폭에 맞춘 배율 — 1440 이면 1, 390 이면 0.78(카드 글자 ≥11px · 노드 두 개 남짓).
    const width = canvasRef.current?.clientWidth ?? 1000;
    const zoom = Math.min(1, Math.max(0.78, width / 900));
    void instance.setCenter(node.position.x + RUN_NODE_WIDTH / 2, node.position.y + node.data.height / 2, { zoom, duration: 400 });
  }, [follow, focus, followNode, flow, flowReady]);

  // 재생이 끝나면 한 발 물러나 «밟은 길 전체»를 보여 준다.
  const finished = effectiveMode === 'replay' && !playing && steps.length > 0 && cursor === steps.length - 1;
  useEffect(() => {
    // 좁은 화면(폰)은 물러나면 글자가 띠처럼 작아진다 — 마지막 노드에 머문다.
    if (!finished || !follow || focus || (canvasRef.current?.clientWidth ?? 1000) < 700) return;
    // 밟은 노드만 맞춘다(최소 배율 0.5 — 글자가 띠처럼 작아지지 않게).
    const timer = window.setTimeout(() => void flowRef.current?.fitView({ nodes: [...visited].map((id) => ({ id })), duration: 800, padding: 0.08, minZoom: 0.5 }), 1200);
    return () => window.clearTimeout(timer);
  }, [finished, follow, focus, visited]);

  const seek = (index: number) => {
    setMode('replay'); setPlaying(false); setCursor(index); setEntering(false);
  };

  if (traversal.isLoading) return <p className="p-4 text-sm text-text-tertiary">런 원장을 읽는 중…</p>;
  if (traversal.isError || !run) return <p role="alert" className="p-4 text-sm text-error">이 런의 원장을 읽지 못했습니다 ({runId}).</p>;

  const focusVisits = focus ? steps.map((step, index) => ({ step, index })).filter(({ step }) => (view?.resolve(step.node) ?? step.node) === focus) : [];
  const current = cursor >= 0 ? steps[cursor] : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${live ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : run.status === 'completed' ? 'bg-success/15 text-success' : 'bg-error/15 text-error'}`}>
          {runStatusLabel(run.status)}
        </span>
        <h2 className="order-first min-w-0 basis-full truncate text-sm font-semibold text-text-primary sm:order-none sm:basis-0 sm:flex-1" title={run.title ?? undefined}>{run.title ?? run.runId}</h2>
        {run.prNumber !== null && <span className="text-xs text-text-secondary">PR #{run.prNumber}</span>}
        <span className="font-mono text-[11px] text-text-tertiary">{run.runId.slice(0, 12)} · {run.graphId ?? '그래프 모름'}{run.substrate ? ` · ${run.substrate}` : ''}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div role="group" aria-label="보기" className="flex overflow-hidden rounded border border-border">
          <button type="button" disabled={!live} onClick={() => { setMode('live'); setPlaying(false); }}
            className={`px-2 py-1 ${effectiveMode === 'live' ? 'bg-primary text-primary-foreground' : ''} disabled:opacity-40`}>● 라이브</button>
          <button type="button" onClick={() => { setMode('replay'); }}
            className={`px-2 py-1 ${effectiveMode === 'replay' ? 'bg-primary text-primary-foreground' : ''}`}>리플레이</button>
        </div>
        {effectiveMode === 'replay' && (
          <>
            <button type="button" aria-label={playing ? '일시정지' : '재생'} onClick={() => {
              if (!playing && cursor >= steps.length - 1) { setCursor(0); setEntering(true); }
              setPlaying(!playing);
            }} className="rounded border border-border px-2.5 py-1 font-semibold">{playing ? '⏸ 일시정지' : '▶ 재생'}</button>
            <button type="button" onClick={() => { setCursor(0); setEntering(true); setPlaying(false); }} className="rounded border border-border px-2 py-1">처음</button>
            <div role="group" aria-label="속도" className="flex overflow-hidden rounded border border-border">
              {SPEEDS.map((value) => (
                <button key={value} type="button" onClick={() => setSpeed(value)} aria-pressed={speed === value}
                  className={`px-2 py-1 ${speed === value ? 'bg-accent/20 font-semibold text-text-primary' : 'text-text-secondary'}`}>{value}×</button>
              ))}
            </div>
            <input type="range" aria-label="재생 위치" min={0} max={Math.max(0, steps.length - 1)} value={Math.max(0, cursor)}
              onChange={(event) => seek(Number(event.target.value))} className="min-w-[120px] flex-1" />
          </>
        )}
        <span className="text-text-tertiary">{Math.max(0, cursor + 1)}/{steps.length} 단계{current ? ` · ${current.node} ×${current.visit}` : ''}</span>
        <button type="button" onClick={() => { setFollow(false); zoomTo(null); }} className="rounded border border-border px-2 py-1">전체 보기</button>
        <button type="button" aria-pressed={follow} onClick={() => { setFollow(!follow); setFocus(null); }}
          className={`rounded border px-2 py-1 ${follow ? 'border-primary text-primary' : 'border-border'}`}>카메라 따라가기</button>
        {units.length > 0 && (
          <button type="button" data-testid="toggle-units" onClick={() => { setFocus(null); setCollapsed(collapsed.size === units.length ? new Set() : new Set(units)); }}
            className="rounded border border-border px-2 py-1">{collapsed.size === units.length ? '묶음 펼치기 (통합 보기)' : '묶음 접기'}</button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <section ref={canvasRef} aria-label="실행 그래프" className="relative h-[60dvh] min-h-[340px] min-w-0 overflow-hidden rounded-lg border border-border bg-surface lg:h-[calc(100dvh-230px)] lg:min-h-[520px] lg:flex-1">
          {steps.length === 0 && <p className="absolute left-3 top-3 z-10 text-xs text-text-tertiary">아직 노드에 들어가지 않았습니다(원장에 `pipeline-node-entry` 없음).</p>}
          {flow && (
            <ReactFlow key={`${graph?.id ?? 'graph'}:${[...collapsed].sort().join(',')}`} nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
              onInit={(instance) => { flowRef.current = instance as unknown as ReactFlowInstance; setFlowReady((value) => value + 1); }}
              onNodeClick={(_event, node) => {
                if (node.type === 'groupBox') return;
                if (isGroupNodeId(node.id)) {
                  // 접힌 묶음을 누르면 그 묶음을 펼치고 그 안으로 들어간다.
                  const group = (node.data as { group?: string }).group ?? node.id.slice('group:'.length);
                  toggleUnit(group);
                  setFocus(null);
                  window.setTimeout(() => void flowRef.current?.fitView({ nodes: [{ id: `box:${group}` }], duration: 600, maxZoom: 1.4, padding: 0.2 }), 80);
                  return;
                }
                zoomTo(focus === node.id ? null : node.id);
              }}
              onPaneClick={() => { if (focus) zoomTo(null); }}
              fitView fitViewOptions={{ padding: 0.08, minZoom: 0.5 }} minZoom={0.2} maxZoom={2}
              nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} edgesFocusable={false} deleteKeyCode={null}
              proOptions={{ hideAttribution: true }} className="!bg-surface">
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
          {focus && (
            <div data-testid="node-detail" className="absolute bottom-3 left-3 right-3 z-10 max-h-[45%] overflow-y-auto rounded-lg border border-border bg-background/95 p-3 text-xs shadow-lg backdrop-blur sm:right-auto sm:w-[320px]">
              <div className="mb-1 flex items-center gap-2">
                <span className="font-mono text-sm font-semibold text-text-primary">{focus}</span>
                <span className="text-text-tertiary">방문 {focusVisits.length}회</span>
                <button type="button" onClick={() => zoomTo(null)} className="ml-auto rounded border border-border px-1.5">닫기</button>
              </div>
              {focusVisits.length === 0 && <p className="text-text-tertiary">{live ? '아직 이 노드에 들어가지 않았습니다.' : '기록 없음 — 이 런의 원장에 이 노드의 사건이 없습니다.'}</p>}
              <ul className="space-y-1">
                {focusVisits.map(({ step, index }) => (
                  <li key={index}>
                    <button type="button" onClick={() => seek(index)} className="w-full rounded px-1 py-0.5 text-left hover:bg-surface-elevated">
                      <span className="font-mono text-text-secondary">{kstClock(step.at)}</span>{' '}
                      <span className="font-semibold">×{step.visit}</span>{' '}
                      <span className={step.outcome === 'fail' ? 'text-error' : step.outcome === null ? 'text-amber-500' : 'text-success'}>{step.outcome ?? '도는 중'}</span>{' '}
                      <span className="text-text-tertiary">{durationLabel(step.durationMs)}</span>
                      {step.detail && <span className="block text-text-secondary">{step.detail}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <aside aria-label="실행 타임라인" className="max-h-[420px] overflow-y-auto rounded-lg border border-border bg-surface lg:max-h-[calc(100dvh-230px)] lg:w-[340px] lg:shrink-0">
          <h3 className="sticky top-0 border-b border-border bg-surface px-3 py-2 text-xs font-semibold">타임라인 (KST)</h3>
          <ol>
            {steps.map((step, index) => {
              const future = index > cursor;
              const now = index === cursor;
              return (
                <li key={index}>
                  <button type="button" onClick={() => { seek(index); zoomTo(view?.resolve(step.node) ?? step.node); }} data-testid={`timeline-step-${index}`}
                    className={`grid w-full grid-cols-[64px_1fr_auto] items-baseline gap-x-2 border-b border-border/60 px-3 py-1.5 text-left text-xs transition-opacity ${future ? 'opacity-35' : ''} ${now ? 'bg-accent/10' : 'hover:bg-surface-elevated'}`}>
                    <span className="font-mono text-text-tertiary">{kstClock(step.at)}</span>
                    <span className="font-mono font-semibold text-text-primary">{step.node}{step.visit > 1 ? ` ×${step.visit}` : ''}</span>
                    <span className={step.outcome === 'fail' ? 'text-error' : step.outcome === null ? 'text-amber-500' : 'text-success'}>
                      {step.outcome === null ? '도는 중' : step.outcome === 'fail' ? '실패' : '통과'}
                    </span>
                    <span className="text-[11px] text-text-tertiary">{durationLabel(step.durationMs)}</span>
                    <span className="col-span-2 truncate text-[11px] text-text-secondary" title={step.detail ?? undefined}>{step.detail ?? ''}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>
      </div>
    </div>
  );
}
