import type { LoopRow } from '@/components/loops/loop-status';
import { loopCronVerdict } from '../../../../../src/loops/verdict';
import { toPublicText } from './public-text';

export interface ActivityEdge {
  at: string;
  kind: 'request' | 'decision' | 'report' | 'card' | 'run';
  from: string;
  to: string;
  ref: string;
}

export interface ActivityNode {
  id: string;
  label: string;
  type: 'seat' | 'loop' | 'other';
  verdict?: LoopRow['verdict'];
  owner?: string;
}

export interface LoopOwner {
  id: string;
  title: string;
  owner: string | null;
  enabled: boolean;
  lastRun: { at: string; status: string } | null;
  jobs: string[];
}

const VERDICTS: Record<ReturnType<typeof loopCronVerdict>, LoopRow['verdict']> = {
  alive: '살아 있음', late: '늦음', failed: '실패', off: '꺼짐',
};

export function applyLoopOwners(rows: readonly LoopRow[], owners: readonly LoopOwner[], now: number): LoopRow[] {
  const byJob = new Map(owners.flatMap(loop => loop.jobs.map(job => [job, loop.owner] as const)));
  const byLoop = new Map(owners.map(loop => [loop.id, loop.owner] as const));
  const updated = rows.map(row => ({ ...row, owner: (row.id.startsWith('schedule:')
    ? byJob.get(row.id.slice(9)) : byLoop.get(row.id.slice(5))) ?? '미지정' }));
  for (const loop of owners) {
    if (updated.some(row => row.id === `loop:${loop.id}`)) continue;
    const verdict = loopCronVerdict({ enabled: loop.enabled, lastRunAt: loop.lastRun?.at ?? null,
      lastStatus: loop.lastRun?.status.toLowerCase() ?? null, intervalMs: null }, now);
    updated.push({ id: `loop:${loop.id}`, name: toPublicText(loop.title), layer: '그래프', owner: loop.owner ?? '미지정',
      mode: '등록', lastRun: loop.lastRun?.at ?? null, verdict: verdict === 'alive' && !loop.lastRun ? '판정 불가' : VERDICTS[verdict] });
  }
  return updated;
}

export const ACTIVITY_WINDOW_MS = 60 * 60 * 1000;
export const EDGE_HIGHLIGHT_MS = 1_500;
export const SEAT_NAMES: Record<string, string> = { OP: 'COO', MK: 'CMO', TC: 'CTO', UX: 'CXO' };
const SEATS = ['OP', 'MK', 'TC', 'UX'];
const KINDS = new Set(['request', 'decision', 'report', 'card', 'run']);
const ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function activityEdges(value: unknown, now: number): ActivityEdge[] {
  const entries = value && typeof value === 'object' && 'edges' in value ? value.edges : null;
  if (!Array.isArray(entries)) throw new Error('간선 조회 실패');
  return entries.filter((edge): edge is ActivityEdge => {
    if (!edge || typeof edge !== 'object' || !KINDS.has(edge.kind) || typeof edge.at !== 'string'
      || typeof edge.from !== 'string' || typeof edge.to !== 'string' || typeof edge.ref !== 'string') return false;
    const at = Date.parse(edge.at);
    return Number.isFinite(at) && at <= now && at >= now - ACTIVITY_WINDOW_MS;
  });
}

export function activityNodes(rows: readonly LoopRow[], edges: readonly ActivityEdge[], seatIds: readonly string[] = SEATS): ActivityNode[] {
  const nodes = new Map<string, ActivityNode>();
  for (const seat of seatIds) nodes.set(seat, { id: seat, type: 'seat', label: SEAT_NAMES[seat] ?? toPublicText(seat) });
  const owners = new Set(seatIds);
  const loopLabels = new Set<string>();
  for (const row of rows) {
    const owner = owners.has(row.owner) ? row.owner : '미지정';
    const key = row.id;
    const label = toPublicText(row.name);
    const uniqueLabel = loopLabels.has(label) ? `${label} · ${toPublicText(row.id)}` : label;
    loopLabels.add(label);
    nodes.set(key, { id: key, type: 'loop', label: uniqueLabel, owner, verdict: row.verdict });
  }
  for (const edge of edges) {
    for (const id of [edge.from, edge.to]) {
      if (nodes.has(id)) continue;
      const [prefix, name] = id.split(':', 2);
      if (prefix === 'loop' && name && ID.test(name)) {
        nodes.set(id, { id, type: 'other', label: name.startsWith('run-') ? `런 · ${toPublicText(name)}` : `칸 · ${toPublicText(name)}` });
      } else if (prefix === 'card' || prefix === 'surface') {
        nodes.set(id, { id, type: 'other', label: prefix === 'card' ? '카드' : `입구 · ${toPublicText(name ?? '')}` });
      } else if (owners.has(id)) {
        nodes.set(id, { id, type: 'seat', label: SEAT_NAMES[id] ?? toPublicText(id) });
      }
    }
  }
  return [...nodes.values()];
}

export function activityTraceTarget(id: string, edge?: ActivityEdge): string {
  const target = edge?.kind === 'run' ? edge.ref : id;
  if (edge?.kind === 'card' && ID.test(edge.ref)) return `/trace?q=${encodeURIComponent(edge.ref)}`;
  if (target.startsWith('loop:') && ID.test(target.slice(5))) {
    const loop = target.slice(5);
    return loop.startsWith('run-') ? `/trace?level=L2&run=${encodeURIComponent(loop)}` : `/trace?q=${encodeURIComponent(loop)}`;
  }
  if (target.startsWith('schedule:') && ID.test(target.slice(9))) return `/trace?q=${encodeURIComponent(target.slice(9))}`;
  if (target.startsWith('card:') && ID.test(target.slice(5))) return `/trace?q=${encodeURIComponent(target.slice(5))}`;
  if (edge?.kind === 'run' && ID.test(target)) return `/trace?level=L2&run=${encodeURIComponent(target)}`;
  return '/trace';
}

export function cardPathEdges(edges: readonly ActivityEdge[], cardId: string): ActivityEdge[] {
  const order = (from: string) => from.startsWith('surface:') ? 0 : from.startsWith('card:') ? 1 : from.startsWith('loop:') ? 2 : 3;
  return edges.filter(edge => edge.kind === 'card' && edge.ref === cardId)
    .sort((a, b) => a.at.localeCompare(b.at) || order(a.from) - order(b.from));
}

export function activityEdgeKey(edge: ActivityEdge): string {
  return JSON.stringify([edge.at, edge.kind, edge.from, edge.to, edge.ref]);
}

export function newlySeenEdges(previous: Readonly<Record<string, number>> | null, edges: readonly ActivityEdge[], receivedAt: number): Record<string, number> {
  return Object.fromEntries(edges.map((edge) => {
    const key = activityEdgeKey(edge);
    return [key, previous?.[key] ?? (previous === null ? receivedAt - EDGE_HIGHLIGHT_MS : receivedAt)];
  }));
}
