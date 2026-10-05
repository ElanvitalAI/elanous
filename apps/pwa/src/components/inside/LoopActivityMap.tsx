'use client';

import { useMemo } from 'react';
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { LoopRow } from '@/components/loops/loop-status';
import { activityEdgeKey, activityNodes, activityTraceTarget, EDGE_HIGHLIGHT_MS, SEAT_NAMES, type ActivityEdge, type ActivityNode } from './loop-activity-map';
import { toPublicText } from './public-text';

const TONE: Record<LoopRow['verdict'], string> = {
  '살아 있음': 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  '늦음': 'bg-red-500/15 text-red-300 ring-red-500/30',
  '실패': 'bg-red-500/15 text-red-300 ring-red-500/30',
  '꺼짐': 'bg-slate-700 text-slate-300 ring-slate-500',
  '판정 불가': 'bg-slate-700 text-slate-300 ring-slate-500',
};
const KINDS: Record<ActivityEdge['kind'], string> = { request: '요청', decision: '결정', report: '보고', card: '카드', run: '런' };

type MapData = { label: string; type: ActivityNode['type']; verdict?: LoopRow['verdict'] };
function MapNode({ data }: NodeProps<Node<MapData>>) {
  return <div className="relative flex flex-col items-center gap-1 text-center text-white">
    <Handle type="target" position={Position.Left} className="!border-sky-400 !bg-sky-400" />
    <div className={`flex items-center justify-center rounded-full border-2 border-sky-400 bg-[#173556] px-2 font-bold ${data.type === 'seat' ? 'h-[90px] w-[90px] text-lg' : 'h-[64px] w-[64px] text-xs'}`}>
      <span className="line-clamp-2 break-all">{toPublicText(data.label)}</span>
    </div>
    {data.verdict && <span data-loop-verdict={data.verdict} className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${TONE[data.verdict]}`}>{data.verdict}</span>}
    <Handle type="source" position={Position.Right} className="!border-sky-400 !bg-sky-400" />
  </div>;
}
const NODE_TYPES: NodeTypes = { activity: MapNode };

export function LoopActivityMap({ rows, edges, seenAt, now, state, seatIds }: {
  rows: readonly LoopRow[];
  edges: readonly ActivityEdge[];
  seenAt: Readonly<Record<string, number>>;
  now: number;
  state: 'loading' | 'ready' | 'error';
  seatIds?: readonly string[];
}) {
  const nodes = useMemo(() => activityNodes(rows, edges, seatIds), [rows, edges, seatIds]);
  const groups = useMemo(() => {
    const seats = nodes.filter(node => node.type === 'seat');
    const owners = [...seats.map(seat => seat.id), '미지정'];
    return owners.map((owner, column) => ({ owner, column,
      nodes: [...(owner === '미지정' ? [] : seats.filter(seat => seat.id === owner)), ...nodes.filter(node => node.type === 'loop' && node.owner === owner)],
    })).filter(group => group.nodes.length > 0);
  }, [nodes]);
  const nodeKeys = new Map(nodes.map((node, index) => [node.id, `node-${index}`]));
  const flowNodes: Node<MapData>[] = groups.flatMap(({ column, nodes: group }) => group.map((node, index) => ({
    id: nodeKeys.get(node.id)!, type: 'activity', position: { x: column * 220, y: index * 138 },
    data: { label: node.label, type: node.type, verdict: node.verdict },
  })));
  const others = nodes.filter(node => node.type === 'other');
  others.forEach((node, index) => flowNodes.push({ id: nodeKeys.get(node.id)!, type: 'activity', position: { x: index * 180, y: Math.max(...groups.map(g => g.nodes.length), 1) * 138 + 40 }, data: { label: node.label, type: node.type } }));
  const flowEdges: Edge[] = edges.filter(edge => nodeKeys.has(edge.from) && nodeKeys.has(edge.to)).map((edge, index) => {
    const fresh = now - (seenAt[activityEdgeKey(edge)] ?? 0) < EDGE_HIGHLIGHT_MS;
    return { id: `edge-${index}`, source: nodeKeys.get(edge.from)!, target: nodeKeys.get(edge.to)!, label: KINDS[edge.kind],
      data: { edge }, animated: false, focusable: true, interactionWidth: 24,
      style: { stroke: fresh ? '#7dd3fc' : '#7492a8', strokeWidth: fresh ? 4 : 2, opacity: fresh ? 1 : 0.55,
        transition: 'stroke 1.5s ease, stroke-width 1.5s ease, opacity 1.5s ease' },
      labelStyle: { fill: fresh ? '#e0f2fe' : '#a8b7c7', fontSize: 12 },
    };
  });
  return <section aria-label="루프 활동 지도" className="min-w-0 space-y-3">
    <p className="text-sm text-slate-300">자리(큰 원) · 루프(작은 원) · 최근 60분 실제 사건. 노드나 간선을 누르면 Trace로 이동합니다.</p>
    {state === 'error' && <p role="alert" className="text-red-300">지도 원천을 읽지 못했습니다. 이전 지도가 보이면 현재 데이터가 아닙니다. 데몬 연결을 확인하세요.</p>}
    {state === 'loading' && <p role="status">지도를 읽는 중…</p>}
    <div className="h-[440px] min-w-0 w-full overflow-hidden rounded-2xl border border-slate-600 bg-[#10243b]" aria-label="자리와 루프 관계도">
      <ReactFlow key={state === 'loading' ? 'loading' : 'loaded'} nodes={flowNodes} edges={flowEdges} nodeTypes={NODE_TYPES} fitView minZoom={0.25} maxZoom={1.5}
        nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
        onNodeClick={(_event, node) => { const target = nodes.find(item => nodeKeys.get(item.id) === node.id); if (target) window.location.assign(activityTraceTarget(target.id)); }}
        onEdgeClick={(_event, item) => { const edge = item.data?.edge as ActivityEdge | undefined; if (edge) window.location.assign(activityTraceTarget(edge.to, edge)); }}>
        <Background color="#355470" /><Controls showInteractive={false} />
      </ReactFlow>
    </div>
    <div aria-label="지도 목록" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {groups.map(group => <section key={group.owner} className="min-w-0 rounded-xl border border-slate-600 p-3">
        <h3 className="mb-2 font-semibold">{SEAT_NAMES[group.owner] ?? toPublicText(group.owner)}</h3>
        <ul className="space-y-2">{group.nodes.map(node => <li key={node.id}>
          <button type="button" onClick={() => window.location.assign(activityTraceTarget(node.id))} className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-slate-600 px-2 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-sky-400">
            <span aria-hidden="true" className={`shrink-0 rounded-full border border-sky-400 bg-[#173556] ${node.type === 'seat' ? 'h-8 w-8' : 'h-5 w-5'}`} />
            <span className="min-w-0 break-words">{toPublicText(node.label)}</span>
            {node.verdict && <span data-loop-verdict={node.verdict} className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-xs ring-1 ${TONE[node.verdict]}`}>{node.verdict}</span>}
          </button>
        </li>)}</ul>
      </section>)}
    </div>
    <ul aria-label="최근 간선 사건" className="space-y-2">{edges.map((edge, index) => <li key={`edge-${index}`}>
      <button type="button" onClick={() => window.location.assign(activityTraceTarget(edge.to, edge))}
        className={`block w-full min-w-0 break-words rounded-lg border border-slate-600 px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-sky-400 ${now - (seenAt[activityEdgeKey(edge)] ?? 0) < EDGE_HIGHLIGHT_MS ? 'bg-sky-500/20 text-sky-100 transition-colors duration-[1500ms] motion-reduce:transition-none' : 'bg-slate-800/50 text-slate-300'}`}>
        {toPublicText(nodes.find(n => n.id === edge.from)?.label ?? '출발')} → {toPublicText(nodes.find(n => n.id === edge.to)?.label ?? '도착')} · {KINDS[edge.kind]} · <time dateTime={edge.at}>{new Date(edge.at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })}</time>
      </button>
    </li>)}</ul>
    {state === 'ready' && edges.length === 0 && <p role="status" className="text-slate-300">최근 사건이 없습니다.</p>}
  </section>;
}
