import dagre from '@dagrejs/dagre';

/** GRAPH-EDGE-TIDY — pure layout + edge routing shared by the graph canvas editor and the read-only run-graph view.
 *  No DOM. Every coordinate is in flow space (React Flow's), node boxes are top-left + size.
 *
 *  What it fixes (대표 10-08 «멀티 간선일 때 tidy 하게»): straight lines between side handles let forward edges,
 *  back edges and same-pair parallel edges overlap, cross node bodies and pile their labels on node text.
 *   1. same (from,to) pair → ONE edge, outcomes joined «a · b»
 *   2. forward edges curve left→right; a forward edge whose straight path would cross another node detours ABOVE
 *      the row; back edges (target not after source) arc BELOW the row — each in its own lane
 *   3. labels sit on the path as pills, slid along it until they hit neither a node nor another label
 *   4. layered layout ranks by forward edges only, so a skip branch gets its own lane
 *   5. several outcomes leaving one node leave from distinct, ordered ports */

export type GraphFlowDirection = 'horizontal' | 'vertical';

export interface RouteNode { id: string; x: number; y: number; width: number; height: number }
export interface RouteEdgeInput { from: string; to: string; outcome: string }
export interface MergedEdge {
  /** Stable id `e<first index>` — the editor's selection reads the first underlying index from it. */
  id: string;
  from: string;
  to: string;
  /** Outcome names in declaration order; empty for an unconditional `to` edge. */
  outcomes: string[];
  /** Indexes into the input edge list this merged edge stands for. */
  indexes: number[];
}
export type EdgeFamily = 'pass' | 'fail' | 'rework' | 'neutral';
export type EdgeRouteKind = 'forward' | 'detour' | 'back';
export interface Point { x: number; y: number }
export interface LabelBox { x: number; y: number; width: number; height: number }
export interface RoutedEdge extends MergedEdge {
  kind: EdgeRouteKind;
  /** Lane index among edges of the same kind (0 = closest to the nodes). */
  lane: number;
  family: EdgeFamily;
  points: Point[];
  /** SVG path in flow coordinates. */
  path: string;
  /** null when the edge has no outcome. `x`,`y` = label centre. */
  label: (LabelBox & { text: string }) | null;
}

const PASS = new Set(['pass', 'ok', 'passed', 'success', 'done', 'merged', 'approved']);
const FAIL = new Set(['fail', 'failed', 'error', 'blocked', 'rejected', 'aborted']);
const REWORK = new Set(['rework', 'retry', 'changes-requested']);

/** Outcome family → colour family. Mixed families stay neutral. */
export function edgeFamily(outcomes: readonly string[]): EdgeFamily {
  if (outcomes.length === 0) return 'neutral';
  if (outcomes.every((name) => PASS.has(name))) return 'pass';
  if (outcomes.every((name) => FAIL.has(name))) return 'fail';
  if (outcomes.every((name) => REWORK.has(name))) return 'rework';
  return 'neutral';
}

/** Theme tokens (globals.css) per family — stroke and label read in dark and light themes. */
export const EDGE_FAMILY_COLOR: Record<EdgeFamily, string> = {
  pass: 'var(--chart-2, #16a34a)',
  fail: 'var(--destructive, #ef4444)',
  rework: 'var(--chart-3, #f59e0b)',
  neutral: 'var(--muted-foreground, #64748b)',
};

export function hoverFocus(
  nodeId: string | null,
  edges: readonly { id: string; from: string; to: string }[],
): { nodes: Set<string>; edges: Set<string> } | null {
  if (nodeId === null) return null;
  const nodes = new Set([nodeId]);
  const focusedEdges = new Set<string>();
  for (const edge of edges) {
    if (edge.from !== nodeId && edge.to !== nodeId) continue;
    nodes.add(edge.from === nodeId ? edge.to : edge.from);
    focusedEdges.add(edge.id);
  }
  return { nodes, edges: focusedEdges };
}

export function mergeParallelEdges(edges: readonly RouteEdgeInput[]): MergedEdge[] {
  const byPair = new Map<string, MergedEdge>();
  edges.forEach((edge, index) => {
    const key = `${edge.from}\u0000${edge.to}`;
    const found = byPair.get(key);
    if (found) {
      found.indexes.push(index);
      if (edge.outcome && !found.outcomes.includes(edge.outcome)) found.outcomes.push(edge.outcome);
    } else {
      byPair.set(key, { id: `e${index}`, from: edge.from, to: edge.to, outcomes: edge.outcome ? [edge.outcome] : [], indexes: [index] });
    }
  });
  return [...byPair.values()];
}

export function edgeLabelText(outcomes: readonly string[], rename: (outcome: string) => string = (name) => name): string | null {
  return outcomes.length ? outcomes.map(rename).join(' · ') : null;
}

const LABEL_CHAR = 7.2;
const LABEL_PAD = 14;
const LABEL_H = 20;
export function labelSize(text: string): { width: number; height: number } {
  let units = 0;
  for (const char of text) units += char.charCodeAt(0) > 0x2e80 ? 1.7 : 1; // Hangul/CJK glyphs are ~1.7× wider
  return { width: Math.ceil(units * LABEL_CHAR + LABEL_PAD), height: LABEL_H };
}

/** Back edges by DFS from the entry (then any unvisited node, in order): an edge into a node still on the stack.
 *  Returned as `from\u0000to` keys. Used to rank by forward edges only. */
export function dfsBackEdges(nodeIds: readonly string[], edges: readonly { from: string; to: string }[], entry?: string | null): Set<string> {
  const out = new Map<string, string[]>();
  for (const edge of edges) out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const visit = (start: string) => {
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const targets = out.get(top.id) ?? [];
      if (top.next >= targets.length) { state.set(top.id, 2); stack.pop(); continue; }
      const to = targets[top.next++]!;
      const seen = state.get(to);
      if (seen === 1) back.add(`${top.id}\u0000${to}`);
      else if (seen === undefined && nodeIds.includes(to)) { state.set(to, 1); stack.push({ id: to, next: 0 }); }
    }
  };
  const order = entry && nodeIds.includes(entry) ? [entry, ...nodeIds.filter((id) => id !== entry)] : [...nodeIds];
  for (const id of order) if (!state.has(id)) visit(id);
  return back;
}

/** Layered (dagre) placement ranked by forward edges only. Returns top-left positions. The gap between ranks grows
 *  with the widest forward label so a label fits between the columns it connects. */
export function layeredPositions(
  nodes: ReadonlyArray<{ id: string; width: number; height: number }>,
  edges: readonly RouteEdgeInput[],
  options: {
    entry?: string | null; flow?: GraphFlowDirection; rename?: (outcome: string) => string; margin?: number;
    /** Room along the reading direction (flow px at the zoom you want to keep). A longer chain wraps onto the next
     *  line — the line-to-line edge is routed through the gap like a back edge. Omit = one line. */
    lineLength?: number;
  } = {},
): Map<string, Point> {
  const flow = options.flow ?? 'horizontal';
  const ids = nodes.map((node) => node.id);
  const known = new Set(ids);
  const merged = mergeParallelEdges(edges.filter((edge) => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to));
  const back = dfsBackEdges(ids, merged, options.entry);
  const forward = merged.filter((edge) => !back.has(`${edge.from}\u0000${edge.to}`));
  const widest = Math.max(0, ...forward.map((edge) => {
    const text = edgeLabelText(edge.outcomes, options.rename);
    return text ? labelSize(text)[flow === 'horizontal' ? 'width' : 'height'] : 0;
  }));
  const layout = new dagre.graphlib.Graph();
  layout.setDefaultEdgeLabel(() => ({}));
  layout.setGraph({
    rankdir: flow === 'horizontal' ? 'LR' : 'TB',
    ranksep: Math.max(flow === 'horizontal' ? 80 : 70, widest + 28),
    nodesep: flow === 'horizontal' ? 70 : 60,
    marginx: options.margin ?? 40, marginy: options.margin ?? 40,
  });
  for (const node of nodes) layout.setNode(node.id, { width: node.width, height: node.height });
  for (const edge of forward) layout.setEdge(edge.from, edge.to);
  dagre.layout(layout);
  const positions = new Map<string, Point>();
  for (const node of nodes) {
    const placed = layout.node(node.id) as { x: number; y: number } | undefined;
    positions.set(node.id, placed ? { x: Math.round(placed.x - node.width / 2), y: Math.round(placed.y - node.height / 2) } : { x: 0, y: 0 });
  }
  if (options.lineLength !== undefined) wrapLines(nodes, positions, flow, options.lineLength, back.size, options.margin ?? 40);
  return positions;
}

/** Wrap a long rank chain onto lines (left to right on every line, next line below). Ranks keep their order and
 *  their offsets across the line; the gap between lines leaves room for the back-edge lanes routed through it. */
function wrapLines(
  nodes: ReadonlyArray<{ id: string; width: number; height: number }>, positions: Map<string, Point>,
  flow: GraphFlowDirection, lineLength: number, backEdges: number, margin: number,
): void {
  const vertical = flow === 'vertical';
  const main = (p: Point) => (vertical ? p.y : p.x);
  const cross = (p: Point) => (vertical ? p.x : p.y);
  const size = (node: { width: number; height: number }) => (vertical ? node.height : node.width);
  const crossSize = (node: { width: number; height: number }) => (vertical ? node.width : node.height);
  // Ranks = clusters of nodes that start at the same main-axis coordinate (dagre lines a rank up on its centre).
  const starts = [...new Set(nodes.map((node) => main(positions.get(node.id)!) + size(node) / 2))].sort((a, b) => a - b);
  const rankOf = new Map<string, number>();
  const ranks: number[] = [];
  for (const centre of starts) if (!ranks.length || centre - ranks[ranks.length - 1]! > 4) ranks.push(centre);
  for (const node of nodes) {
    const centre = main(positions.get(node.id)!) + size(node) / 2;
    rankOf.set(node.id, ranks.findIndex((r) => Math.abs(r - centre) <= 4 || r > centre));
  }
  if (ranks.length < 2) return;
  const pitch = (ranks[ranks.length - 1]! - ranks[0]!) / (ranks.length - 1);
  const widest = Math.max(...nodes.map(size));
  const perLine = Math.max(2, Math.floor((lineLength - 2 * margin - widest) / pitch) + 1);
  if (ranks.length <= perLine) return;
  const top = Math.min(...nodes.map((node) => cross(positions.get(node.id)!)));
  const bottom = Math.max(...nodes.map((node) => cross(positions.get(node.id)!) + crossSize(node)));
  const lineGap = Math.max(BAND_REACH + 40, LANE_GAP * 2 + LANE_STEP * (backEdges + 1));
  const lineStride = bottom - top + lineGap;
  for (const node of nodes) {
    const at = positions.get(node.id)!;
    const rank = Math.max(0, rankOf.get(node.id)!);
    const line = Math.floor(rank / perLine);
    const shift = (rank - (rank % perLine)) * pitch;
    const next = vertical ? { x: at.x + line * lineStride, y: at.y - shift } : { x: at.x - shift, y: at.y + line * lineStride };
    positions.set(node.id, { x: Math.round(next.x), y: Math.round(next.y) });
  }
}

// ── routing ───────────────────────────────────────────────────────────────────────────────────────────────────
// Work in a «frame» where the reading direction is +x. Vertical flow swaps x/y on the way in and out.

interface Box { x: number; y: number; w: number; h: number }
const toFrame = (vertical: boolean) => (node: RouteNode): Box & { id: string } =>
  vertical ? { id: node.id, x: node.y, y: node.x, w: node.height, h: node.width } : { id: node.id, x: node.x, y: node.y, w: node.width, h: node.height };
const fromFrame = (vertical: boolean) => (point: Point): Point => (vertical ? { x: point.y, y: point.x } : point);

const STUB = 18;       // straight run out of a port before turning
const LANE_GAP = 24;   // first lane distance from the nodes
const LANE_STEP = 26;  // distance between lanes (label pill is 20 tall)
/** Cards closer than this across the reading direction belong to one line (dagre's node gap is 60–70). */
const BAND_REACH = 80;
const CLEAR = 8;       // inflation when testing whether a line hits a node

function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
  // Liang–Barsky clip against the inflated box.
  const x0 = box.x - CLEAR, x1 = box.x + box.w + CLEAR, y0 = box.y - CLEAR, y1 = box.y + box.h + CLEAR;
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const checks: Array<[number, number]> = [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]];
  for (const [p, q] of checks) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

function cubic(a: Point, c1: Point, c2: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

/** Orthogonal polyline → path with rounded corners. */
function roundedPath(points: Point[], radius = 10): string {
  if (points.length < 2) return '';
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!, at = points[i]!, next = points[i + 1]!;
    const inLen = Math.hypot(at.x - prev.x, at.y - prev.y), outLen = Math.hypot(next.x - at.x, next.y - at.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r <= 0.5) { d += ` L ${at.x} ${at.y}`; continue; }
    const p1 = { x: at.x - ((at.x - prev.x) / inLen) * r, y: at.y - ((at.y - prev.y) / inLen) * r };
    const p2 = { x: at.x + ((next.x - at.x) / outLen) * r, y: at.y + ((next.y - at.y) / outLen) * r };
    d += ` L ${p1.x} ${p1.y} Q ${at.x} ${at.y} ${p2.x} ${p2.y}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L ${last.x} ${last.y}`;
}

function overlap(a: LabelBox, b: LabelBox, pad = 3): number {
  const w = Math.min(a.x + a.width / 2, b.x + b.width / 2) - Math.max(a.x - a.width / 2, b.x - b.width / 2) + pad;
  const h = Math.min(a.y + a.height / 2, b.y + b.height / 2) - Math.max(a.y - a.height / 2, b.y - b.height / 2) + pad;
  return w > 0 && h > 0 ? w * h : 0;
}

/** The cards a lane has to clear: the ends, every card between them across the reading direction, and cards that
 *  touch that band (within a lane gap). A card on another line (separated by a wider gap) is not in the band, so a
 *  back edge runs in the gap right under its own line. An edge that drops to a later line runs in the gap above
 *  the target's line. */
function bandOf(boxes: Box[], s: Box, t: Box, kind: 'back' | 'detour'): Box[] {
  const down = kind === 'back' && t.y >= s.y + s.h;
  let lo = down ? s.y : Math.min(s.y, t.y);
  let hi = down ? s.y + s.h : Math.max(s.y + s.h, t.y + t.h);
  const band = new Set<Box>([s, t].filter((box) => !down || box === s));
  for (let grew = true; grew;) {
    grew = false;
    for (const box of boxes) {
      if (band.has(box) || (down && box.y >= t.y)) continue;
      if (box.y < hi + BAND_REACH && box.y + box.h > lo - BAND_REACH) {
        band.add(box); lo = Math.min(lo, box.y); hi = Math.max(hi, box.y + box.h); grew = true;
      }
    }
  }
  return [...band];
}

/** Route merged edges between placed nodes. Edges whose ends are unknown or equal are skipped. */
export function routeEdges(
  nodes: readonly RouteNode[],
  edges: readonly MergedEdge[],
  options: { flow?: GraphFlowDirection; rename?: (outcome: string) => string } = {},
): RoutedEdge[] {
  const vertical = options.flow === 'vertical';
  const frame = nodes.map(toFrame(vertical));
  const byId = new Map(frame.map((box) => [box.id, box]));
  const out = fromFrame(vertical);
  type Work = MergedEdge & { kind: EdgeRouteKind; s: Box & { id: string }; t: Box & { id: string }; lane: number; laneY: number; lo: number; hi: number };
  const work: Work[] = [];
  for (const edge of edges) {
    const s = byId.get(edge.from), t = byId.get(edge.to);
    if (!s || !t || s === t) continue;
    const isBack = t.x + 1 <= s.x || (t.x < s.x + s.w && t.x + t.w > s.x); // target not after source (overlapping columns count)
    let kind: EdgeRouteKind = isBack ? 'back' : 'forward';
    if (!isBack) {
      // Test the curve that will actually be drawn (sampled), not the chord between the ends.
      const a = { x: s.x + s.w, y: s.y + s.h / 2 }, b = { x: t.x, y: t.y + t.h / 2 };
      const dx = Math.max(30, (b.x - a.x) / 2);
      const curve = Array.from({ length: 17 }, (_, i) => cubic(a, { x: a.x + dx, y: a.y }, { x: b.x - dx, y: b.y }, b, i / 16));
      const hits = (box: Box) => curve.some((point, i) => i > 0 && segmentHitsBox(curve[i - 1]!, point, box));
      if (frame.some((box) => box !== s && box !== t && hits(box))) kind = 'detour';
    }
    const lo = Math.min(s.x, t.x), hi = Math.max(s.x + s.w, t.x + t.w);
    work.push({ ...edge, kind, s, t, lane: 0, laneY: 0, lo, hi });
  }

  // Lanes: shortest span first (inner lane), an edge moves out while it overlaps one already in that lane.
  for (const kind of ['back', 'detour'] as const) {
    const list = work.filter((edge) => edge.kind === kind).sort((a, b) => (a.hi - a.lo) - (b.hi - b.lo) || a.indexes[0]! - b.indexes[0]!);
    const placed: Work[] = [];
    for (const edge of list) {
      let lane = 0;
      while (placed.some((other) => other.lane === lane && other.lo < edge.hi + STUB && edge.lo < other.hi + STUB)) lane++;
      edge.lane = lane;
      placed.push(edge);
      const covered = bandOf(frame.filter((box) => box.x < edge.hi && box.x + box.w > edge.lo), edge.s, edge.t, kind);
      edge.laneY = kind === 'back'
        ? Math.max(...covered.map((box) => box.y + box.h)) + LANE_GAP + lane * LANE_STEP
        : Math.min(...covered.map((box) => box.y)) - LANE_GAP - lane * LANE_STEP;
    }
  }

  // Ports. Every edge leaves the source's output side and enters the target's input side (the handles stay
  // meaningful). Ports fan along that side, ordered by where the edge heads next — detours (above) on top, plain
  // forward edges by the other end's position, back edges (below) at the bottom, outer lanes outermost — so lines
  // never cross at a node.
  const sidePort = new Map<string, number>(); // `${id}|${s|t}|${edgeId}` → cross-axis offset
  const crossOf = (edge: Work, end: 's' | 't') => edge.kind === 'forward' ? (end === 's' ? edge.t.y + edge.t.h / 2 : edge.s.y + edge.s.h / 2) : edge.laneY;
  for (const box of frame) {
    for (const end of ['s', 't'] as const) {
      const side = work.filter((edge) => edge[end] === box).sort((a, b) => crossOf(a, end) - crossOf(b, end));
      side.forEach((edge, index) => sidePort.set(`${box.id}|${end}|${edge.id}`, box.y + (box.h * (index + 1)) / (side.length + 1)));
    }
  }

  const routed: Array<RoutedEdge & { candidates: Point[] }> = work.map((edge) => {
    const { s, t } = edge;
    let points: Point[];
    let path: string | undefined;
    let candidates: Point[];
    if (edge.kind === 'back') {
      // Out of the source's output side, down to its lane below the row, back along it, up into the target's input
      // side. The turn-out distance grows with the lane so the vertical runs of nested loops stay apart.
      const sy = sidePort.get(`${s.id}|s|${edge.id}`)!, ty = sidePort.get(`${t.id}|t|${edge.id}`)!;
      const turn = STUB + edge.lane * 8;
      const sx = s.x + s.w + turn, tx = t.x - turn;
      points = [{ x: s.x + s.w, y: sy }, { x: sx, y: sy }, { x: sx, y: edge.laneY }, { x: tx, y: edge.laneY }, { x: tx, y: ty }, { x: t.x, y: ty }];
      candidates = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9].map((f) => ({ x: sx + (tx - sx) * f, y: edge.laneY }));
    } else {
      const sy = sidePort.get(`${s.id}|s|${edge.id}`)!, ty = sidePort.get(`${t.id}|t|${edge.id}`)!;
      const a = { x: s.x + s.w, y: sy }, b = { x: t.x, y: ty };
      if (edge.kind === 'detour') {
        points = [a, { x: a.x + STUB, y: sy }, { x: a.x + STUB, y: edge.laneY }, { x: b.x - STUB, y: edge.laneY }, { x: b.x - STUB, y: ty }, b];
        candidates = [0.5, 0.35, 0.65, 0.2, 0.8].map((f) => ({ x: a.x + STUB + (b.x - a.x - 2 * STUB) * f, y: edge.laneY }));
      } else {
        const dx = Math.max(30, (b.x - a.x) / 2);
        const c1 = { x: a.x + dx, y: a.y }, c2 = { x: b.x - dx, y: b.y };
        points = Array.from({ length: 17 }, (_, i) => cubic(a, c1, c2, b, i / 16));
        candidates = [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78].map((f) => cubic(a, c1, c2, b, f));
        const real = [a, c1, c2, b].map(out);
        path = `M ${real[0]!.x} ${real[0]!.y} C ${real[1]!.x} ${real[1]!.y}, ${real[2]!.x} ${real[2]!.y}, ${real[3]!.x} ${real[3]!.y}`;
      }
    }
    const realPoints = points.map(out);
    path ??= roundedPath(realPoints);
    const finalPath: string = path;
    const text = edgeLabelText(edge.outcomes, options.rename);
    return {
      id: edge.id, from: edge.from, to: edge.to, outcomes: edge.outcomes, indexes: edge.indexes,
      kind: edge.kind, lane: edge.lane, family: edgeFamily(edge.outcomes), points: realPoints, path: finalPath,
      label: text ? { text, x: 0, y: 0, ...labelSize(text) } : null,
      candidates: candidates.map(out),
    };
  });

  // Labels: forward ones first (they have the least room), then the lanes. First candidate that overlaps nothing
  // wins; otherwise the least-overlapping one.
  const nodeBoxes: LabelBox[] = nodes.map((node) => ({ x: node.x + node.width / 2, y: node.y + node.height / 2, width: node.width, height: node.height }));
  const taken: LabelBox[] = [];
  const order = [...routed].sort((a, b) => (a.kind === 'forward' ? 0 : 1) - (b.kind === 'forward' ? 0 : 1));
  for (const edge of order) {
    if (!edge.label) continue;
    let best: { box: LabelBox; cost: number } | null = null;
    // Along the path first; when cards sit closer than the pill is wide (a user drag), step the pill off the path
    // across the reading direction until it clears every card and label.
    const step = (vertical ? edge.label.width : edge.label.height) + 6;
    const shifted = [1, -1, 2, -2, 3, -3, 4, -4, 6, -6].flatMap((k) => edge.candidates.slice(0, 3).map((at) =>
      vertical ? { x: at.x + k * step, y: at.y } : { x: at.x, y: at.y + k * step }));
    for (const at of [...edge.candidates, ...shifted]) {
      const box = { x: Math.round(at.x), y: Math.round(at.y), width: edge.label.width, height: edge.label.height };
      const cost = nodeBoxes.reduce((sum, node) => sum + overlap(box, node, 2) * 4, 0) + taken.reduce((sum, other) => sum + overlap(box, other), 0);
      if (!best || cost < best.cost) best = { box, cost };
      if (cost === 0) break;
    }
    Object.assign(edge.label, { x: best!.box.x, y: best!.box.y });
    taken.push(best!.box);
  }
  return routed.map(({ candidates: _candidates, ...edge }) => edge);
}

/** Total overlap area between labels, and between labels and nodes — 0 means tidy. Exposed for tests/diagnostics. */
export function labelCollisions(nodes: readonly RouteNode[], routed: readonly RoutedEdge[]): { labelLabel: number; labelNode: number } {
  const labels = routed.flatMap((edge) => edge.label ? [edge.label] : []);
  let labelLabel = 0, labelNode = 0;
  labels.forEach((a, i) => labels.slice(i + 1).forEach((b) => { labelLabel += overlap(a, b, 0); }));
  for (const label of labels) for (const node of nodes) labelNode += overlap(label, { x: node.x + node.width / 2, y: node.y + node.height / 2, width: node.width, height: node.height }, 0);
  return { labelLabel, labelNode };
}
