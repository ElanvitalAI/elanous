'use client';

// Trace 그래프(RFC v6 §4) — d3 힘 배치 ⊕ 줌·팬 ⊕ 드래그(고정·두 번 클릭 해제) ⊕ 호버 1-hop 강조 ⊕ 클릭 선택 ⊕ 더블클릭 한 층 내려가기.
// «화려함은 주의를 옮기는 데만»(§1 ③): 입자·글로우 없음 · 선택·호버 경로만 밝고 나머지는 18% 로 가라앉는다 · 전환 250ms.
// 포커스 줌(2026-10-01 대표 «런을 고르면 해상도가 바뀌며 포커스»): 선택 = 그 노드로 부드럽게 확대 · 선택 해제 = 전체로 · 층 전환 = 멀리서 다가오듯 맞춤.
// 톤은 v5 와 같은 남색·인디고·파스텔. ⛔ 마운트 뒤에만 d3 를 붙인다(정적 export 하이드레이션).

import { useEffect, useMemo, useRef, useState } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { select } from 'd3-selection';
import { zoom, zoomIdentity } from 'd3-zoom';
import { drag } from 'd3-drag';
import type { TraceEdge, TraceNode } from '@/lib/trace-model';

const STATUS_COLOR: Record<string, string> = {
  running: '#818cf8', landed: '#4ade80', blocked: '#fb7185', quiet: '#64748b', ok: '#4ade80', bad: '#fb7185', info: '#c7d2fe',
};
const KIND_COLOR: Record<TraceNode['kind'], string> = { universe: '#67e8f9', run: '#818cf8', stage: '#c7d2fe', decision: '#f0abfc' };
const DECISION_COLOR: Record<string, string> = { PLAN: '#38bdf8', ROUTE: '#a78bfa', VERIFY: '#fbbf24', HEAL: '#34d399', ESCALATE: '#fb7185', SHIP: '#4ade80' };

type SimNode = TraceNode & SimulationNodeDatum;
type SimLink = SimulationLinkDatum<SimNode> & { kind: TraceEdge['kind'] };

export function nodeColor(n: Pick<TraceNode, 'kind' | 'status' | 'label'>): string {
  if (n.kind === 'decision') return DECISION_COLOR[n.label] ?? KIND_COLOR.decision;
  return (n.status && STATUS_COLOR[n.status]) || KIND_COLOR[n.kind];
}

export function nodeRadius(n: Pick<TraceNode, 'kind' | 'weight'>): number {
  const base = n.kind === 'universe' ? 14 : n.kind === 'run' ? 7 : n.kind === 'stage' ? 9 : 5;
  return base + Math.min(10, Math.sqrt(n.weight) * (n.kind === 'universe' ? 2.5 : 1.2));
}

/** 그래프 구조 서명 — 노드 id·종류·상태·무게 ⊕ 간선. 같으면 다시 배치하지 않는다. */
export function graphSignature(nodes: readonly TraceNode[], edges: readonly TraceEdge[]): string {
  return `${nodes.map((n) => `${n.id}:${n.kind}:${n.status ?? ''}:${n.weight}`).join('|')}#${edges.map((e) => `${e.source}>${e.target}:${e.kind}`).join('|')}`;
}

/** 노드 전부(⊕ 반지름 · 오른쪽 이름 자리 90px)가 들어오는 줌 변환. 너무 크게 키우지 않는다(최대 1.5). */
export function fitTransform(nodes: ReadonlyArray<{ x: number; y: number; r: number }>, width: number, height: number, pad = 24): { x: number; y: number; k: number } {
  if (nodes.length === 0 || width <= 0 || height <= 0) return { x: 0, y: 0, k: 1 };
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r);
    x1 = Math.max(x1, n.x + n.r + 90); y1 = Math.max(y1, n.y + n.r);
  }
  const k = Math.max(0.2, Math.min(1.5, (width - pad * 2) / Math.max(1, x1 - x0), (height - pad * 2) / Math.max(1, y1 - y0)));
  return { x: (width - (x1 - x0) * k) / 2 - x0 * k, y: (height - (y1 - y0) * k) / 2 - y0 * k, k };
}

/** 이웃 — 호버·선택한 노드와 한 칸으로 이어진 것들. */
export function neighbors(edges: readonly TraceEdge[], id: string | null): Set<string> {
  const out = new Set<string>();
  if (!id) return out;
  out.add(id);
  for (const e of edges) {
    if (e.source === id) out.add(e.target);
    if (e.target === id) out.add(e.source);
  }
  return out;
}

export type ZoomT = { x: number; y: number; k: number };

/** 한 노드를 화면 가운데에 배율 k 로 놓는 줌 변환. */
export function focusTransform(p: { x: number; y: number }, width: number, height: number, k: number): ZoomT {
  return { x: width / 2 - p.x * k, y: height / 2 - p.y * k, k };
}

/** 두 줌 변환 사이 t(0~1) — 화면 가운데가 보는 «세계 점»은 곧게, 배율은 기하로 옮긴다(확대·축소가 한쪽으로 쏠리지 않는다). */
export function lerpTransform(a: ZoomT, b: ZoomT, t: number, width: number, height: number): ZoomT {
  const ca = { x: (width / 2 - a.x) / a.k, y: (height / 2 - a.y) / a.k };
  const cb = { x: (width / 2 - b.x) / b.k, y: (height / 2 - b.y) / b.k };
  const k = a.k * Math.pow(b.k / a.k, t);
  const cx = ca.x + (cb.x - ca.x) * t; const cy = ca.y + (cb.y - ca.y) * t;
  return { x: width / 2 - cx * k, y: height / 2 - cy * k, k };
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** 선택 포커스 배율 — 전체 맞춤보다 2.4배 · 1.2~3.5 사이(작은 그래프는 과하게 키우지 않는다). */
export function focusScale(fitK: number): number {
  return Math.max(1.2, Math.min(3.5, fitK * 2.4));
}

export function TraceGraph({ nodes, edges, selected, onSelect, onDrill, height = 560 }: {
  nodes: TraceNode[];
  edges: TraceEdge[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onDrill: (node: TraceNode) => void;
  height?: number;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const focus = hover ?? selected;
  const lit = useMemo(() => neighbors(edges, focus), [edges, focus]);
  const litRef = useRef(lit);
  litRef.current = lit;
  const cbRef = useRef({ onSelect, onDrill, setHover });
  cbRef.current = { onSelect, onDrill, setHover };
  // 줌 상태 — 배치 effect 가 채우고, 선택 effect 가 읽어 포커스로 옮긴다.
  const animateRef = useRef<((from: ZoomT, to: ZoomT, ms: number) => void) | null>(null);
  const zoomRef = useRef<{ apply: (t: ZoomT) => void; cur: ZoomT; fit: ZoomT | null; width: number; nodes: SimNode[]; raf: number } | null>(null);

  // ⛔ 배치는 «구조»가 바뀔 때만 다시 한다 — Trace 는 로그를 5초마다 새로 받아 nodes 배열이 매번 새것이라,
  //    종전엔 5초마다 그래프가 처음부터 다시 퍼졌다(튀고 · 첫 화면 맞춤이 들쭉날쭉 · 09-28 실측).
  const sig = graphSignature(nodes, edges);
  const dataRef = useRef({ nodes, edges });
  dataRef.current = { nodes, edges };
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof window === 'undefined') return;
    const { nodes, edges } = dataRef.current;
    const width = svg.clientWidth || 800;
    const root = select(svg);
    root.selectAll('*').remove();
    const g = root.append('g');
    const simNodes: SimNode[] = nodes.map((n) => ({ ...n }));
    const byId = new Map(simNodes.map((n) => [n.id, n]));
    const simLinks: SimLink[] = edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ source: e.source, target: e.target, kind: e.kind }));
    const link = g.append('g').attr('stroke-linecap', 'round').selectAll('line').data(simLinks).join('line')
      .attr('stroke', (d) => (d.kind === 'parent' ? '#f0abfc' : d.kind === 'decides' ? '#a78bfa' : '#6366f1'))
      .attr('stroke-width', (d) => (d.kind === 'parent' ? 1.6 : 1))
      .attr('stroke-dasharray', (d) => (d.kind === 'parent' ? '4 3' : null))
      .attr('data-trace-edge', (d) => `${(d.source as string)}>${(d.target as string)}`);
    const node = g.append('g').selectAll<SVGGElement, SimNode>('g').data(simNodes).join('g')
      .attr('data-trace-node', (d) => d.id)
      .style('cursor', 'pointer')
      .on('mouseenter', (_e, d) => cbRef.current.setHover(d.id))
      .on('mouseleave', () => cbRef.current.setHover(null))
      .on('click', (e, d) => { e.stopPropagation(); cbRef.current.onSelect(d.id); })
      .on('dblclick', (e, d) => {
        e.stopPropagation();
        // 고정한 노드를 두 번 누르면 풀고, 아니면 한 층 내려간다.
        if (d.fx != null) { d.fx = null; d.fy = null; sim.alpha(0.3).restart(); return; }
        cbRef.current.onDrill(d);
      });
    node.append('circle')
      .attr('r', (d) => nodeRadius(d))
      .attr('fill', (d) => nodeColor(d))
      .attr('fill-opacity', 0.9)
      .attr('stroke', '#0f172a').attr('stroke-width', 1.5);
    node.append('text')
      .text((d) => (d.kind === 'decision' ? '' : d.label))
      .attr('x', (d) => nodeRadius(d) + 4).attr('y', 3)
      .attr('fill', '#e2e8f0').attr('font-size', (d) => (d.kind === 'universe' ? 14 : 12))
      .attr('font-family', 'ui-monospace, SFMono-Regular, monospace')
      .style('pointer-events', 'none');
    node.append('title').text((d) => `${d.kind} · ${d.label}${d.status ? ` · ${d.status}` : ''}`);
    const sim = forceSimulation<SimNode>(simNodes)
      .force('link', forceLink<SimNode, SimLink>(simLinks).id((d) => d.id).distance((l) => (l.kind === 'contains' ? 70 : l.kind === 'decides' ? 40 : 60)).strength(0.7))
      .force('charge', forceManyBody<SimNode>().strength((d) => (d.kind === 'universe' ? -420 : -90)))
      .force('collide', forceCollide<SimNode>().radius((d) => nodeRadius(d) + 3))
      .force('center', forceCenter(width / 2, height / 2))
      .on('tick', () => {
        link.attr('x1', (d) => (d.source as SimNode).x ?? 0).attr('y1', (d) => (d.source as SimNode).y ?? 0)
          .attr('x2', (d) => (d.target as SimNode).x ?? 0).attr('y2', (d) => (d.target as SimNode).y ?? 0);
        node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
      });
    // ⚠️ d3-drag·d3-zoom 의 타입이 품은 d3-selection 판이 우리 것과 달라 `call` 인자 형이 안 맞는다 — 동작은 같다(형만 넘긴다).
    const dragBehavior = drag<SVGGElement, SimNode>()
      .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e) => { if (!e.active) sim.alphaTarget(0); });
    node.call(dragBehavior as never);
    // 사람이 줌·팬을 한 번이라도 하면 자동 맞춤을 멈춘다(보던 자리를 뺏지 않는다).
    let userMoved = false;
    const z = zoom<SVGSVGElement, unknown>().scaleExtent([0.2, 6]).on('zoom', (e) => {
      if (e.sourceEvent) userMoved = true;
      g.attr('transform', e.transform.toString());
      if (zoomRef.current) zoomRef.current.cur = { x: e.transform.x, y: e.transform.y, k: e.transform.k };
    });
    root.call(z as never).on('dblclick.zoom', null).on('click', () => cbRef.current.onSelect(null));
    const apply = (t: ZoomT) => { root.call(z.transform as never, zoomIdentity.translate(t.x, t.y).scale(t.k)); };
    if (zoomRef.current) cancelAnimationFrame(zoomRef.current.raf);
    zoomRef.current = { apply, cur: { x: 0, y: 0, k: 1 }, fit: null, width, nodes: simNodes, raf: 0 };
    apply({ x: 0, y: 0, k: 1 });
    // 첫 화면 맞춤 — 런이 70 개로 늘자 힘 배치가 화면 밖까지 퍼져 첫 화면에 노드 일부가 안 보였다(09-28 실측).
    //   배치가 가라앉으면 모든 노드(⊕ 이름 여백)가 들어오게 한 번 맞춘다.
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animate = (from: ZoomT, to: ZoomT, ms: number) => {
      const zr = zoomRef.current;
      if (!zr) return;
      cancelAnimationFrame(zr.raf);
      if (reduce || ms <= 0) { apply(to); return; }
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / ms);
        apply(lerpTransform(from, to, easeInOutCubic(t), width, height));
        if (t < 1 && zoomRef.current === zr) zr.raf = requestAnimationFrame(step);
      };
      zr.raf = requestAnimationFrame(step);
    };
    animateRef.current = animate;
    const fit = () => {
      if (userMoved || simNodes.length === 0) return;
      const t = fitTransform(simNodes.map((n) => ({ x: n.x ?? 0, y: n.y ?? 0, r: nodeRadius(n) })), width, height);
      if (zoomRef.current) zoomRef.current.fit = t;
      // 층 전환 = 멀리서 다가오듯 — 맞춤의 절반 배율(같은 중심)에서 맞춤으로 700ms.
      const from = focusTransform({ x: (width / 2 - t.x) / t.k, y: (height / 2 - t.y) / t.k }, width, height, t.k * 0.5);
      animate(from, t, 700);
    };
    // 배치가 거의 가라앉을 때(alpha < 0.05) 한 번 맞춘다 — 이르면(펼쳐지는 중) 너무 크게 키운다(09-28 실측: 1.2초 맞춤이 1440 에서 41 → 16).
    let fitted = false;
    sim.on('tick.fit', () => { if (!fitted && sim.alpha() < 0.05) { fitted = true; fit(); } });
    sim.on('end.fit', () => { if (!fitted) { fitted = true; fit(); } });
    return () => { sim.stop(); if (zoomRef.current) cancelAnimationFrame(zoomRef.current.raf); };
  }, [sig, height]);

  // 포커스 줌 — 선택하면 그 노드를 가운데로 확대(650ms), 선택을 풀면 전체 맞춤으로(550ms). 호버는 줌하지 않는다.
  const hadSelection = useRef(false);
  useEffect(() => {
    const zr = zoomRef.current; const animate = animateRef.current;
    if (!zr || !animate) return;
    const svg = svgRef.current;
    const width = svg?.clientWidth || zr.width;
    if (selected) {
      const n = zr.nodes.find((d) => d.id === selected);
      if (!n || n.x == null || n.y == null) return;
      hadSelection.current = true;
      animate(zr.cur, focusTransform({ x: n.x, y: n.y }, width, height, focusScale(zr.fit?.k ?? zr.cur.k)), 650);
    } else if (hadSelection.current && zr.fit) {
      hadSelection.current = false;
      animate(zr.cur, zr.fit, 550);
    }
  }, [selected, height, sig]);

  // 강조 — 선택·호버의 1-hop 만 밝게, 나머지는 가라앉는다(250ms).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const root = select(svg);
    const on = lit.size > 0;
    root.selectAll<SVGGElement, SimNode>('g[data-trace-node]')
      .style('transition', 'opacity 250ms')
      .style('opacity', (d) => (!on || lit.has(d.id) ? 1 : 0.18))
      .select('circle').attr('stroke', (d) => (d.id === selected ? '#f8fafc' : '#0f172a')).attr('stroke-width', (d) => (d.id === selected ? 3 : 1.5));
    root.selectAll<SVGLineElement, SimLink>('line')
      .style('transition', 'opacity 250ms')
      .style('opacity', (d) => {
        const s = typeof d.source === 'string' ? d.source : (d.source as SimNode).id;
        const t = typeof d.target === 'string' ? d.target : (d.target as SimNode).id;
        return !on || (lit.has(s) && lit.has(t)) ? 0.7 : 0.08;
      });
  }, [lit, selected, nodes, edges]);

  return (
    <svg
      ref={svgRef}
      className="w-full rounded-lg bg-[radial-gradient(ellipse_at_center,rgba(79,70,229,.18),rgba(2,6,23,.96)_70%)]"
      style={{ height }}
      role="img"
      aria-label="Trace 그래프 — 클릭 선택 · 더블클릭 한 층 내려가기 · 휠 줌 · 끌어 고정"
      data-trace-graph
    />
  );
}
