'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type EdgeTypes, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { LoopRow } from '@/components/loops/loop-status';
import { activityEdgeKey, activityNodes, activityTraceTarget, cardPathEdges, EDGE_HIGHLIGHT_MS, FIXED_NODES, isGhostLaunch, isRoundTrip, journeyEdges, journeyParam, journeyStages, KIND_WORDS, nearDetail, PACKET_SHAPES, RUNS_NODE, SEAT_NAMES, zoomTier, type ActivityEdge, type ActivityNode, type NearDetail, type NodeDetailSource } from './loop-activity-map';
import { toPublicText } from './public-text';
import { PacketEdge, PACKET_MS, type PacketData } from './PacketEdge';
import { NODE_STATE } from '@/components/ops/ReleaseFlow';

const TONE: Record<LoopRow['verdict'], string> = {
  '살아 있음': 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  '늦음': 'bg-red-500/15 text-red-300 ring-red-500/30',
  '실패': 'bg-red-500/15 text-red-300 ring-red-500/30',
  '꺼짐': 'bg-slate-700 text-slate-300 ring-slate-500',
  '판정 불가': 'bg-slate-700 text-slate-300 ring-slate-500',
};
const KINDS = KIND_WORDS;
/** 꾸러미는 강조(1.5초)보다 길게 산다 — 왕복이 두 배 걸린다. */
export const PACKET_WINDOW_MS = PACKET_MS * 2 + 200;

type MapData = { label: string; type: ActivityNode['type']; verdict?: LoopRow['verdict']; detail?: NearDetail };
function MapNode({ data }: NodeProps<Node<MapData>>) {
  const big = data.type === 'seat' || data.type === 'hub';
  return <div className="relative flex flex-col items-center gap-1 text-center text-white">
    <Handle type="target" position={Position.Left} className="!border-sky-400 !bg-sky-400" />
    <div className={`flex items-center justify-center rounded-full border-2 border-sky-400 bg-[#173556] px-2 font-bold ${big ? 'h-[90px] w-[90px] text-lg' : 'h-[64px] w-[64px] text-xs'}`}>
      <span className="line-clamp-2 break-all">{toPublicText(data.label)}</span>
    </div>
    {data.verdict && <span data-loop-verdict={data.verdict} className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${TONE[data.verdict]}`}>{data.verdict}</span>}
    {data.detail && <NodeDetail detail={data.detail} />}
    <Handle type="source" position={Position.Right} className="!border-sky-400 !bg-sky-400" />
  </div>;
}

/** near 줌의 노드 안쪽 — 지금 일 · 최근 행동(≤5) · 도는 런 · 대기. 못 읽은 칸은 «못 읽음», 없는 칸은 안 그린다. */
export function NodeDetail({ detail }: { detail: NearDetail }) {
  return <div data-near-detail="" className="w-[180px] space-y-1 rounded-lg border border-slate-600 bg-[#10243b]/95 p-2 text-left text-[10px] font-normal text-slate-200">
    {detail.now !== null && <p className="break-words"><span className="text-slate-400">지금 </span>{detail.now}</p>}
    {(detail.running !== null || detail.waiting !== null) && <p className="flex gap-2">
      {detail.running !== null && <span>도는 런 {detail.running}</span>}
      {detail.waiting !== null && <span>대기 {detail.waiting}</span>}
    </p>}
    {detail.recent.length > 0 ? <ol aria-label="최근 행동" className="space-y-0.5">{detail.recent.map((line, index) => <li key={index} className="break-words">{line}</li>)}</ol>
      : <p className="text-slate-400">최근 행동 없음</p>}
  </div>;
}
const NODE_TYPES: NodeTypes = { activity: MapNode };
const EDGE_TYPES: EdgeTypes = { packet: PacketEdge };
const STAGE_DOT: Record<keyof typeof NODE_STATE, string> = {
  done: 'border-emerald-500/60 bg-emerald-500/15', failed: 'border-red-500/60 bg-red-500/15',
  current: 'border-sky-300 bg-sky-500/20', pending: 'border-dashed border-slate-500 bg-slate-800/40',
};

function prefersReducedMotion(): boolean {
  try { return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
}

function handStyle(edge: ActivityEdge): 'broken' | 'shadow' | 'live' | null {
  return edge.kind === 'hand' ? edge.broken ? 'broken' : edge.mode === 'shadow' ? 'shadow' : 'live' : null;
}
function edgeWord(edge: ActivityEdge, ghost: boolean, now: number): string {
  if (ghost) return `${KINDS.launch} · 유령 · 런 원장 없음 ${Math.floor((now - Date.parse(edge.at)) / 60_000)}분`;
  const hand = handStyle(edge);
  return hand === 'broken' ? `${KINDS.hand} · 끊김 ✕` : hand === 'shadow' ? `${KINDS.hand} · 그림자` : KINDS[edge.kind];
}

/** 고정 노드 자리 — 자리 넷의 열 위 한 줄(조율 → TASK-AGENT → 런 묶음 → 발행 · 수호자). */
const FIXED_ROW_Y = -170;

export function LoopActivityMap({ rows, edges, seenAt, now, state, seatIds, details }: {
  rows: readonly LoopRow[];
  edges: readonly ActivityEdge[];
  seenAt: Readonly<Record<string, number>>;
  now: number;
  state: 'loading' | 'ready' | 'error' | 'unauthorized';
  seatIds?: readonly string[];
  /** near 줌 노드 안쪽 — LoopAgentsScene 이 이미 읽은 자리·런 데이터(노드 id → 칸). */
  details?: Readonly<Record<string, NodeDetailSource>>;
}) {
  const search = useSearchParams();
  const cardFromAddress = search.get('card');
  const demo = journeyParam(search);
  const [zoom, setZoom] = useState(1);
  const tier = zoomTier(zoom);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    setReduced(prefersReducedMotion());
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches);
    query.addEventListener?.('change', change);
    return () => query.removeEventListener?.('change', change);
  }, []);
  const stages = useMemo(() => demo === null ? [] : journeyStages(edges, demo), [edges, demo]);
  const journeyKeys = useMemo(() => new Set(demo === null ? [] : journeyEdges(edges, demo).map(activityEdgeKey)), [edges, demo]);
  const [selectedCard, setSelectedCard] = useState<string | null>(cardFromAddress);
  useEffect(() => { setSelectedCard(cardFromAddress); }, [cardFromAddress]);
  const cards = useMemo(() => [...new Set(edges.filter(edge => edge.kind === 'card').map(edge => edge.ref))].sort(), [edges]);
  const pathEdges = useMemo(() => selectedCard === null ? [] : cardPathEdges(edges, selectedCard), [edges, selectedCard]);
  const pathKeys = new Set(pathEdges.map(activityEdgeKey));
  // 카드를 고르면 그 경로, 아니면 데모 여정을 밝힌다(둘 다 없으면 평시).
  const focusKeys = selectedCard !== null ? pathKeys : demo !== null ? journeyKeys : null;
  const selectCard = (id: string | null) => {
    setSelectedCard(id);
    const url = new URL(window.location.href);
    if (id === null) url.searchParams.delete('card');
    else url.searchParams.set('card', id);
    window.history.replaceState(window.history.state, '', url.toString());
  };
  const nodes = useMemo(() => activityNodes(rows, edges, seatIds), [rows, edges, seatIds]);
  const groups = useMemo(() => {
    const seats = nodes.filter(node => node.type === 'seat');
    const owners = [...seats.map(seat => seat.id), '미지정'];
    return owners.map((owner, column) => ({ owner, column,
      nodes: [...(owner === '미지정' ? [] : seats.filter(seat => seat.id === owner)), ...nodes.filter(node => node.type === 'loop' && node.owner === owner)],
    })).filter(group => group.nodes.length > 0);
  }, [nodes]);
  const nodeKeys = new Map(nodes.map((node, index) => [node.id, `node-${index}`]));
  const labelOf = (id: string) => nodes.find(n => n.id === id)?.label ?? '알 수 없음';
  const runCount = new Set(edges.filter(edge => edge.kind === 'run' && edge.to.startsWith('loop:')).map(edge => edge.to)).size;
  const detailOf = (id: string): NearDetail | undefined => {
    if (tier !== 'near') return undefined;
    const detail = nearDetail(id, edges, id === RUNS_NODE ? { running: runCount, ...details?.[id] } : details?.[id], labelOf, now);
    // 보일 것이 하나도 없는 노드엔 상자를 안 붙인다(빈 상자가 이웃 노드를 덮는다).
    return detail.now === null && detail.running === null && detail.waiting === null && detail.recent.length === 0 ? undefined : detail;
  };
  const groupStarts = groups.map((_, index) => groups.slice(0, index).reduce((width, group) => width + Math.ceil(group.nodes.length / 8), 0));
  const flowNodes: Node<MapData>[] = groups.flatMap(({ nodes: group }, groupIndex) => group.map((node, index) => ({
    id: nodeKeys.get(node.id)!, type: 'activity', position: { x: (groupStarts[groupIndex]! + Math.floor(index / 8)) * 220, y: (index % 8) * 138 },
    data: { label: node.label, type: node.type, verdict: node.verdict, detail: detailOf(node.id) },
  })));
  FIXED_NODES.forEach((fixed, index) => {
    const node = nodes.find(item => item.id === fixed.id);
    if (node) flowNodes.push({ id: nodeKeys.get(node.id)!, type: 'activity', position: { x: index * 220, y: FIXED_ROW_Y },
      data: { label: node.label, type: node.type, verdict: node.verdict, detail: detailOf(node.id) } });
  });
  const others = nodes.filter(node => node.type === 'other');
  others.forEach((node, index) => flowNodes.push({ id: nodeKeys.get(node.id)!, type: 'activity', position: { x: Math.floor(index / 8) * 180, y: Math.max(...groups.map(g => Math.min(g.nodes.length, 8)), 1) * 138 + 40 + (index % 8) * 138 }, data: { label: node.label, type: node.type, detail: detailOf(node.id) } }));
  const flowEdges: Edge<PacketData & { edge: ActivityEdge }>[] = edges.filter(edge => nodeKeys.has(edge.from) && nodeKeys.has(edge.to)).map((edge, index) => {
    const key = activityEdgeKey(edge);
    const age = now - (seenAt[key] ?? 0);
    const fresh = age < EDGE_HIGHLIGHT_MS;
    const picked = focusKeys !== null && focusKeys.has(key);
    const dim = focusKeys !== null && !picked;
    // 넘김: 그림자 = 흐린 점선 · 실발사 = 실선 · 끊김 = 붉은 짧은 점선 ⊕ 문면 «끊김»(색만으로 가르지 않는다).
    const hand = handStyle(edge);
    const ghost = isGhostLaunch(edge, edges, now);
    const label = edgeWord(edge, ghost, now);
    const baseOpacity = hand === 'shadow' ? 0.35 : 0.55;
    const packet = !ghost && !reduced && age < PACKET_WINDOW_MS
      ? { key, shape: PACKET_SHAPES[edge.kind], word: KINDS[edge.kind], roundTrip: isRoundTrip(edge, edges) } : null;
    return { id: `edge-${index}`, type: 'packet', source: nodeKeys.get(edge.from)!, target: nodeKeys.get(edge.to)!, label,
      data: { edge, packet, hand }, animated: false, focusable: true, interactionWidth: 24,
      style: { stroke: ghost || hand === 'broken' ? '#fca5a5' : picked || (!dim && fresh) ? '#7dd3fc' : '#7492a8', strokeWidth: picked || (!dim && fresh) ? 4 : 2,
        opacity: dim ? 0.16 : picked || fresh ? 1 : baseOpacity,
        ...(ghost || hand === 'broken' ? { strokeDasharray: '2 7' } : hand === 'shadow' ? { strokeDasharray: '6 5' } : {}),
        transition: 'stroke 1.5s ease, stroke-width 1.5s ease, opacity 1.5s ease' },
      labelStyle: { fill: dim ? '#7492a8' : ghost || hand === 'broken' ? '#fecaca' : picked || fresh ? '#e0f2fe' : '#a8b7c7', fontSize: 12, opacity: dim ? 0.4 : 1 },
    };
  });
  return <section aria-label="루프 활동 지도" className="min-w-0 space-y-3">
    <p className="text-sm text-slate-300">자리(큰 원) · 루프(작은 원) · 최근 60분 실제 사건. 노드나 간선을 누르면 Trace로 이동합니다.</p>
    <p className="text-xs text-slate-400">꾸러미 모양 · 요청 ● 결정 ◆ 보고 ■ 넘김 ▲ 발사 ★ 판단 ⬟ · 넘김 실선 = 실발사 · 점선 = 그림자 · ✕ = 끊김 · 유령 = 발사 뒤 10분간 같은 ref 런 간선 없음 · 확대하면 노드 안 지금 일이 보입니다.</p>
    {demo !== null && <section aria-label="데모 여정" className="rounded-xl border border-sky-500/50 bg-[#173556] p-3">
      <h3 className="font-semibold">여정 · {toPublicText(demo)}</h3>
      {state === 'ready' && journeyKeys.size === 0 && <p role="status" className="mt-1 text-sm text-slate-300">아직 사건 없음 — 틱이 이 카드를 집으면 1단계부터 채워집니다</p>}
      <ol className="mt-2 flex min-w-0 flex-wrap items-stretch gap-2 text-sm">{stages.map((stage, index) => <li key={stage.key} data-journey-state={stage.state}
        className={`flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 ${STAGE_DOT[stage.state]}`}>
        <span aria-hidden="true">{NODE_STATE[stage.state].mark}</span>
        <span className="min-w-0 break-words">{index + 1}. {stage.label} · {NODE_STATE[stage.state].word}</span>
        {stage.edge && <time className="text-xs text-slate-300" dateTime={stage.edge.at}>{new Date(stage.edge.at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })}</time>}
      </li>)}</ol>
    </section>}
    <div role="group" aria-label="데모 카드 선택" className="flex flex-wrap items-center gap-2 text-sm">
      <span>카드 경로</span>
      {cards.map(id => <button key={id} type="button" aria-pressed={selectedCard === id} onClick={() => selectCard(id)}
        className="min-h-11 rounded-lg border border-slate-500 px-3 py-2 aria-pressed:border-sky-300 aria-pressed:bg-sky-800 focus-visible:outline-2 focus-visible:outline-sky-400">{toPublicText(id)}</button>)}
      {selectedCard !== null && <button type="button" onClick={() => selectCard(null)} className="min-h-11 rounded-lg border border-slate-500 px-3 py-2 focus-visible:outline-2 focus-visible:outline-sky-400">전체 보기</button>}
    </div>
    {selectedCard !== null && <section aria-label="선택 카드 흐름" className="rounded-xl border border-sky-500/50 bg-[#173556] p-3">
      <h3 className="font-semibold">요구 한 줄 → 회신 · 카드 {toPublicText(selectedCard)}</h3>
      {state === 'ready' && pathEdges.length === 0 && <p role="status">이 카드는 아직 흐른 사건이 없음</p>}
      {pathEdges.length > 0 && <ol className="mt-2 space-y-2">{pathEdges.map((edge, index) => <li key={`${activityEdgeKey(edge)}-${index}`} className="break-words text-sm">
        {index + 1}. {toPublicText(nodes.find(n => n.id === edge.from)?.label ?? '출발')} → {edge.to.startsWith('surface:') ? `회신 · ${toPublicText(edge.to.slice('surface:'.length))}` : toPublicText(nodes.find(n => n.id === edge.to)?.label ?? '도착')}
        {' · '}<time dateTime={edge.at}>{new Date(edge.at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })}</time>
      </li>)}</ol>}
    </section>}
    {state === 'error' && <p role="alert" className="text-red-300">지도 원천을 읽지 못했습니다. 이전 지도가 보이면 현재 데이터가 아닙니다. 데몬 연결을 확인하세요.</p>}
    {state === 'unauthorized' && <p role="alert" className="text-red-300">지도 원천에 접근 권한이 없습니다 — 토큰으로 다시 붙으세요</p>}
    {state === 'loading' && <p role="status">지도를 읽는 중…</p>}
    <div className="h-[440px] min-w-0 w-full overflow-hidden rounded-2xl border border-slate-600 bg-[#10243b]" aria-label="자리와 루프 관계도">
      <ReactFlow key={state === 'loading' ? 'loading' : 'loaded'} nodes={flowNodes} edges={flowEdges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} fitView minZoom={0.25} maxZoom={2.5}
        onInit={(instance) => setZoom(instance.getZoom())} onMove={(_event, viewport) => setZoom(viewport.zoom)}
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
        className={`block w-full min-w-0 break-words rounded-lg border border-slate-600 px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-sky-400 ${selectedCard !== null ? pathKeys.has(activityEdgeKey(edge)) ? 'border-sky-300 bg-sky-500/30 text-sky-100' : 'bg-slate-800/30 text-slate-400 opacity-40' : now - (seenAt[activityEdgeKey(edge)] ?? 0) < EDGE_HIGHLIGHT_MS ? 'bg-sky-500/20 text-sky-100 transition-colors duration-[1500ms] motion-reduce:transition-none' : 'bg-slate-800/50 text-slate-300'}`}>
        {toPublicText(nodes.find(n => n.id === edge.from)?.label ?? '출발')} → {toPublicText(nodes.find(n => n.id === edge.to)?.label ?? '도착')} · {edgeWord(edge, isGhostLaunch(edge, edges, now), now)} · <time dateTime={edge.at}>{new Date(edge.at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })}</time>
      </button>
    </li>)}</ul>
    {state === 'ready' && edges.length === 0 && <p role="status" className="text-slate-300">최근 사건이 없습니다.</p>}
  </section>;
}
