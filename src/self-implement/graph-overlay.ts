import { inspectPipelineGraph, type PipelineGraphDefect } from './pipeline-shape.js';
import type { GraphTemplate, GraphTemplateNode } from './graph-templates.js';

/** ⭐ RFC §5 «4단계» — 상황 오버레이.
 *
 *  RFC §4.3 ⑴ 은 오버레이를 ***"노드 추가 금지 · `max_visits`·라우트 목적지만 조정"*** 으로 좁히고,
 *  그 이유를 ***"그래프 «구조»는 안 바뀌므로 정적 검사가 계속 성립한다"*** 라고 적었다.
 *
 *  ⛔⭐ 그 문장은 «절반만» 참이다 — 노드 «집합»은 안 바뀌지만 **도달 가능성은 바뀐다**.
 *    라우트 목적지 하나만 돌려도 종료 노드가 고립되거나 빠져나갈 수 없는 순환이 생긴다.
 *    ⇒ 그래서 이 모듈은 「구조가 안 바뀌니 검사가 성립한다」에 «기대지 않고»,
 *      오버레이를 얹은 «결과 그래프»에 2단계 검사를 ***다시 건다***. */
export interface GraphOverlay {
  readonly overlayId: string;
  /** 노드별 재방문 상한 조정. ⛔ 없는 노드를 대면 거절한다. */
  readonly maxVisits?: Readonly<Record<string, number>>;
  /** 라우트 목적지 조정 — `from` 의 목적지 목록을 통째로 갈아 끼운다. ⛔ 없는 노드는 거절한다. */
  readonly routes?: Readonly<Record<string, readonly string[]>>;
}

export type OverlayRejection =
  | { kind: 'unknown-node'; overlayId: string; node: string; field: 'maxVisits' | 'routes' }
  | { kind: 'unknown-destination'; overlayId: string; from: string; to: string }
  | { kind: 'non-positive-max-visits'; overlayId: string; node: string; value: number }
  | { kind: 'breaks-graph'; overlayId: string; defects: readonly PipelineGraphDefect[] };

export type OverlayPatch =
  | { readonly overlayId: string; readonly field: 'maxVisits'; readonly node: string; readonly before: number; readonly after: number }
  | { readonly overlayId: string; readonly field: 'routes'; readonly node: string; readonly before: readonly string[]; readonly after: readonly string[] }
  | { readonly overlayId: string; readonly field: 'node-added'; readonly node: string; readonly kind: string; readonly maxVisits: number }
  | { readonly overlayId: string; readonly field: 'edge-rerouted'; readonly from: string; readonly outcome: string; readonly was: string; readonly to: string };

export type OverlayResult =
  | { ok: true; template: GraphTemplate; patches: readonly OverlayPatch[] }
  | { ok: false; rejections: readonly OverlayRejection[] };

/** 오버레이를 얹는다. ⛔ 노드를 «더하지도 빼지도» 않는다 — 그것이 이 축의 계약이다.
 *  ⛔ 결과 그래프가 2단계 위상 검사를 통과하지 못하면 «거절»한다(구조 불변만으로는 안전이 안 나온다). */
export function applyOverlay(template: GraphTemplate, overlay: GraphOverlay): OverlayResult {
  const known = new Set(template.nodes.map((n) => n.nodeId));
  const rejections: OverlayRejection[] = [];

  for (const [node, value] of Object.entries(overlay.maxVisits ?? {})) {
    if (!known.has(node)) rejections.push({ kind: 'unknown-node', overlayId: overlay.overlayId, node, field: 'maxVisits' });
    else if (!Number.isInteger(value) || value < 1) rejections.push({ kind: 'non-positive-max-visits', overlayId: overlay.overlayId, node, value });
  }
  for (const [from, destinations] of Object.entries(overlay.routes ?? {})) {
    if (!known.has(from)) { rejections.push({ kind: 'unknown-node', overlayId: overlay.overlayId, node: from, field: 'routes' }); continue; }
    for (const to of destinations) {
      if (!known.has(to)) rejections.push({ kind: 'unknown-destination', overlayId: overlay.overlayId, from, to });
    }
  }
  if (rejections.length > 0) return { ok: false, rejections };

  const patches: OverlayPatch[] = [];
  const nodes: GraphTemplateNode[] = template.nodes.map((n) => {
    const after = overlay.maxVisits?.[n.nodeId];
    if (after === undefined) return n;
    if (n.maxVisits !== after) patches.push({ overlayId: overlay.overlayId, field: 'maxVisits', node: n.nodeId, before: n.maxVisits, after });
    return { ...n, maxVisits: after };
  });
  const edges: Record<string, readonly string[]> = { ...template.edges };
  for (const [from, destinations] of Object.entries(overlay.routes ?? {})) {
    const before = template.edges[from] ?? [];
    const after = [...destinations];
    if (before.length !== after.length || before.some((destination, index) => destination !== after[index])) {
      patches.push({ overlayId: overlay.overlayId, field: 'routes', node: from, before, after });
    }
    edges[from] = after;
  }

  // ⛔⭐ 여기가 이 모듈의 요지 — 「구조가 안 바뀌었으니 괜찮다」로 넘어가지 «않는다».
  const defects = inspectPipelineGraph(edges, template.entryNode);
  if (defects.length > 0) return { ok: false, rejections: [{ kind: 'breaks-graph', overlayId: overlay.overlayId, defects }] };

  return { ok: true, template: { ...template, nodes, edges, version: `${template.version}+${overlay.overlayId}` }, patches };
}

/** 오버레이가 노드 «집합»을 안 바꿨나 — RFC 가 약속한 그 불변식을 값으로 답한다. */
export function overlayPreservesNodeSet(before: GraphTemplate, after: GraphTemplate): boolean {
  const a = before.nodes.map((n) => n.nodeId).sort();
  const b = after.nodes.map((n) => n.nodeId).sort();
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
