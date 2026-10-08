import type { LoopRow } from '@/components/loops/loop-status';
import { loopCronVerdict } from '../../../../../src/loops/verdict';
import { toPublicText } from './public-text';

export interface ActivityEdge {
  at: string;
  kind: 'request' | 'decision' | 'report' | 'card' | 'run' | 'hand' | 'launch' | 'move';
  from: string;
  to: string;
  ref: string;
  /** hand 간선만 — 서버 `src/nexus/api/loop-edges.ts` 의 그림자/실발사 구분. */
  mode?: 'shadow' | 'live';
  /** hand 간선만 — live 넘김이 발사로 이어지지 못한 끊긴 간선. */
  broken?: true;
  cell?: string;
  move?: string;
  tick?: string;
  /** launch 간선만 — 서버가 그 카드에 묶은 런 원장 runId. */
  run?: string;
}

export interface ActivityNode {
  id: string;
  label: string;
  type: 'seat' | 'loop' | 'other' | 'hub';
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
export const GHOST_LAUNCH_AFTER_MS = 10 * 60 * 1000;

/** 발사 뒤 10분이 지나도 런 원장이 없으면 유령. 런 원장 = 서버가 묶은 `run`(launch 간선 ref 는 카드 id, run 간선 ref 는 runId 라
 *  ref 만으로는 둘이 안 만난다) 또는 같은 ref 의 run 간선. 원천 간선은 변경하지 않는다. */
export function isGhostLaunch(edge: ActivityEdge, edges: readonly ActivityEdge[], now: number): boolean {
  if (edge.kind !== 'launch' || (typeof edge.run === 'string' && edge.run !== '')) return false;
  const at = Date.parse(edge.at);
  return Number.isFinite(at) && now - at >= GHOST_LAUNCH_AFTER_MS
    && !edges.some(other => other.kind === 'run' && other.ref === edge.ref);
}
export const SEAT_NAMES: Record<string, string> = { OP: 'COO', MK: 'CMO', TC: 'CTO', UX: 'CXO' };
const SEATS = ['OP', 'MK', 'TC', 'UX'];
/** 서버 LoopEdge.kind 와 같은 목록 — 여기 없는 kind 는 소리 없이 버려진다(LOOP-INTERACT 조각 C 가 hand·launch·move 를 더함). */
export const EDGE_KINDS = ['request', 'decision', 'report', 'card', 'run', 'hand', 'launch', 'move'] as const;
const KINDS = new Set<string>(EDGE_KINDS);
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
export const ORCHESTRATOR_NODE = 'loop:orchestrator';
export const TASK_AGENT_NODE = 'agent:task-agent';
export const RUNS_NODE = 'hub:runs';
/** 고정 노드(자리 넷 밖) — 간선이 없어도 늘 같은 자리에 선다. 조율 → TASK-AGENT → 런 묶음 → 발행 순, 수호자는 옆. */
export const FIXED_NODES: ReadonlyArray<{ id: string; label: string }> = [
  { id: ORCHESTRATOR_NODE, label: '조율' },
  { id: TASK_AGENT_NODE, label: 'TASK-AGENT' },
  { id: RUNS_NODE, label: '런 묶음' },
  { id: 'loop:release-loop', label: '발행 루프' },
  { id: 'loop:guardian', label: '수호자' },
];

export function isValidRef(id: string | null | undefined): id is string {
  return typeof id === 'string' && ID.test(id);
}

/**
 * 데모 여정 id — `?journey=<id>` 우선, 아니면 `?demo=<id>`.
 * ⚠️ /inside 의 `?demo=1|0` 은 이미 «데모 모드 켜기/끄기»다(InsidePage · INSIDE1a) — 그 두 값은 여정 id 로 읽지 않는다.
 */
export function journeyParam(search: { get(name: string): string | null } | null | undefined): string | null {
  const journey = search?.get('journey') ?? null;
  if (isValidRef(journey)) return journey;
  const demo = search?.get('demo') ?? null;
  return isValidRef(demo) && demo !== '0' && demo !== '1' ? demo : null;
}

export function activityEdges(value: unknown, now: number): ActivityEdge[] {
  return edgesWithin(value, now, true);
}

/** `?ref=` 여정 응답용 — 60분 창 밖의 앞 단계도 남긴다(미래 시각만 버림). */
export function journeyResponseEdges(value: unknown, now: number): ActivityEdge[] {
  return edgesWithin(value, now, false);
}

function edgesWithin(value: unknown, now: number, window: boolean): ActivityEdge[] {
  const entries = value && typeof value === 'object' && 'edges' in value ? value.edges : null;
  if (!Array.isArray(entries)) throw new Error('간선 조회 실패');
  return entries.filter((edge): edge is ActivityEdge => {
    if (!edge || typeof edge !== 'object' || !KINDS.has(edge.kind) || typeof edge.at !== 'string'
      || typeof edge.from !== 'string' || typeof edge.to !== 'string' || typeof edge.ref !== 'string') return false;
    const at = Date.parse(edge.at);
    return Number.isFinite(at) && at <= now && (!window || at >= now - ACTIVITY_WINDOW_MS);
  });
}

export function activityNodes(rows: readonly LoopRow[], edges: readonly ActivityEdge[], seatIds: readonly string[] = SEATS): ActivityNode[] {
  const nodes = new Map<string, ActivityNode>();
  for (const seat of seatIds) nodes.set(seat, { id: seat, type: 'seat', label: SEAT_NAMES[seat] ?? toPublicText(seat) });
  for (const fixed of FIXED_NODES) nodes.set(fixed.id, { id: fixed.id, type: 'hub', label: fixed.label });
  const owners = new Set(seatIds);
  const loopLabels = new Set<string>();
  for (const row of rows) {
    const owner = owners.has(row.owner) ? row.owner : '미지정';
    const key = row.id;
    const label = toPublicText(row.name);
    const uniqueLabel = loopLabels.has(label) ? `${label} · ${toPublicText(row.id)}` : label;
    loopLabels.add(label);
    const fixed = nodes.get(key);
    // 고정 노드인 루프(조율·발행·수호자)는 자리를 지키고 판정만 얹는다.
    nodes.set(key, fixed?.type === 'hub' ? { ...fixed, owner, verdict: row.verdict } : { id: key, type: 'loop', label: uniqueLabel, owner, verdict: row.verdict });
  }
  for (const edge of edges) {
    for (const id of [edge.from, edge.to]) {
      if (nodes.has(id)) continue;
      const [prefix, name] = id.split(':', 2);
      if (prefix === 'loop' && name && ID.test(name)) {
        nodes.set(id, { id, type: 'other', label: name.startsWith('run-') ? `런 · ${toPublicText(name)}` : `칸 · ${toPublicText(name)}` });
      } else if (prefix === 'card' || prefix === 'surface') {
        nodes.set(id, { id, type: 'other', label: prefix === 'card' ? '카드' : `입구 · ${toPublicText(name ?? '')}` });
      } else if (prefix === 'agent' && name && ID.test(name)) {
        nodes.set(id, { id, type: 'other', label: `에이전트 · ${toPublicText(name)}` });
      } else if (prefix === 'pr' && name && /^\d{1,9}$/.test(name)) {
        nodes.set(id, { id, type: 'other', label: `PR #${name}` });
      } else if ((prefix === 'release' || prefix === 'landed') && name && ID.test(name)) {
        nodes.set(id, { id, type: 'other', label: `${prefix === 'release' ? '발행' : '착지'} · ${toPublicText(name)}` });
      } else if (owners.has(id)) {
        nodes.set(id, { id, type: 'seat', label: SEAT_NAMES[id] ?? toPublicText(id) });
      }
    }
  }
  return [...nodes.values()];
}

export function activityTraceTarget(id: string, edge?: ActivityEdge): string {
  if (edge && (edge.kind === 'hand' || edge.kind === 'launch' || edge.kind === 'move') && ID.test(edge.ref)) return `/trace?q=${encodeURIComponent(edge.ref)}`;
  if (id.startsWith('pr:') && /^\d{1,9}$/.test(id.slice(3)) && !edge) return `/trace?q=${encodeURIComponent(id.slice(3))}`;
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

/** 데모 여정 다섯 단계 — 틱(넘김) → TASK-AGENT(발사) → 런 → PR → 착지/green 제안. */
export const JOURNEY_STAGES = [
  { key: 'tick', label: '틱 · 넘김' },
  { key: 'agent', label: 'TASK-AGENT · 발사' },
  { key: 'run', label: '런' },
  { key: 'pr', label: 'PR' },
  { key: 'land', label: '착지 · green 제안' },
] as const;
export type JourneyStageKey = typeof JOURNEY_STAGES[number]['key'];

/** 여정 id 의 별칭 — 오케스트레이터 넘김은 ref 가 TASK-AGENT 카드 id 이고 소원(wish)은 `cell`(`<wish>-<n>`)에만 있다.
 *  그 넘김의 TA 카드 ref 를 같은 여정으로 본다(서버 #24723 고리와 짝 · 10-07 리허설 2-c 실측: 띠가 «1 지금 · 4 끝남»으로 어긋남). */
export function journeyAliases(edges: readonly ActivityEdge[], id: string): ReadonlySet<string> {
  const ids = new Set([id]);
  for (const edge of edges) if (edge.kind === 'hand' && edge.cell !== undefined && (edge.cell === id || edge.cell.startsWith(`${id}-`))) ids.add(edge.ref);
  return ids;
}

export function journeyStageOf(edge: ActivityEdge, id: string, aliases: ReadonlySet<string> = new Set([id])): JourneyStageKey | null {
  const mine = edge.ref === id || aliases.has(edge.ref);
  if (edge.kind === 'hand') return mine && edge.mode !== 'shadow' ? 'tick' : null;
  if (edge.kind === 'launch') return mine ? 'agent' : null;
  if (edge.kind === 'move') return mine && edge.move === 'green-proposal' ? 'land' : null;
  if (edge.kind === 'run') return edge.to.startsWith('pr:') ? 'pr' : edge.to.startsWith('loop:') ? 'run' : null;
  if (edge.kind === 'card') return edge.to.startsWith('landed:') ? 'land' : null;
  return null;
}

/**
 * 한 카드·체크리스트 칸의 여정(cardPathEdges 확장) — 입력은 `GET /v1/loops/edges?ref=<id>&mode=live` 응답이다.
 * 서버가 카드↔런 연결(runId→goalId→feature)로 이미 거른 집합이므로 런·PR 간선은 ref(=runId)를 다시 묻지 않는다.
 * 그림자(shadow) 넘김은 데모 띠에 안 싣는다(live 만). 시각 순 · 같은 시각이면 단계 순.
 */
export function journeyEdges(edges: readonly ActivityEdge[], id: string): ActivityEdge[] {
  const aliases = journeyAliases(edges, id);
  const rank = (edge: ActivityEdge) => JOURNEY_STAGES.findIndex(stage => stage.key === journeyStageOf(edge, id, aliases));
  const card = cardPathEdges(edges, id);
  const rest = edges.filter(edge => edge.kind !== 'card' || edge.ref !== id).filter(edge => journeyStageOf(edge, id, aliases) !== null);
  return [...card, ...rest].sort((a, b) => a.at.localeCompare(b.at) || rank(a) - rank(b));
}

export type JourneyState = 'done' | 'failed' | 'current' | 'pending';
/** 단계마다 ReleaseFlow NODE_STATE 자리(✓ ✗ ● ○) — 첫 빈 단계가 «지금», 끊긴 넘김은 «실패».
 *  사건이 하나도 없는 여정은 시작도 안 했으니 «지금» 없이 전부 «남음»(JOURNEY-EMPTY-STATE). */
export function journeyStages(edges: readonly ActivityEdge[], id: string): Array<{ key: JourneyStageKey; label: string; state: JourneyState; edge?: ActivityEdge }> {
  const path = journeyEdges(edges, id);
  const aliases = journeyAliases(edges, id);
  let currentTaken = path.length === 0;
  // 뒷단계가 끝났으면 사건이 안 잡힌 앞단계도 지나간 것이다(PR 이 있으면 런은 있었다) — «3 남음 · 4 끝남» 모순 금지.
  const lastDone = JOURNEY_STAGES.reduce((last, stage, index) =>
    path.some(edge => journeyStageOf(edge, id, aliases) === stage.key && !edge.broken) ? index : last, -1);
  return JOURNEY_STAGES.map((stage, index) => {
    const hits = path.filter(edge => journeyStageOf(edge, id, aliases) === stage.key);
    const ok = hits.find(edge => !edge.broken);
    if (ok) return { key: stage.key, label: stage.label, state: 'done' as const, edge: ok };
    if (hits.length === 0 && index < lastDone) return { key: stage.key, label: stage.label, state: 'done' as const };
    if (hits.length > 0) { currentTaken = true; return { key: stage.key, label: stage.label, state: 'failed' as const, edge: hits[0] }; }
    if (!currentTaken) { currentTaken = true; return { key: stage.key, label: stage.label, state: 'current' as const }; }
    return { key: stage.key, label: stage.label, state: 'pending' as const };
  });
}

/** 2단 줌 — 0.8 미만 far(루프·간선만) · 이상 near(노드 안 지금 일·최근 행동·런·대기). */
export const NEAR_ZOOM = 0.8;
export function zoomTier(zoom: number): 'far' | 'near' {
  return zoom < NEAR_ZOOM ? 'far' : 'near';
}

export const KIND_WORDS: Record<ActivityEdge['kind'], string> = {
  request: '요청', decision: '결정', report: '보고', card: '카드', run: '런', hand: '넘김', launch: '발사', move: '판단',
};

export interface NodeDetailSource { now?: string; running?: number | '못 읽음'; waiting?: number | '못 읽음' }
export interface NearDetail { now: string | null; recent: string[]; running: number | '못 읽음' | null; waiting: number | '못 읽음' | null }

/** near 노드 안쪽 — 이미 LoopAgentsScene 이 읽은 자리·런 데이터 ⊕ 그 노드에 닿은 최근 간선 다섯(새 것 먼저). */
export function nearDetail(id: string, edges: readonly ActivityEdge[], source: NodeDetailSource | undefined, labelOf: (id: string) => string, now?: number): NearDetail {
  const recent = edges.filter(edge => edge.from === id || edge.to === id)
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5)
    .map(edge => `${now !== undefined && isGhostLaunch(edge, edges, now) ? '발사 · 유령' : KIND_WORDS[edge.kind]} ${edge.from === id ? '→' : '←'} ${toPublicText(labelOf(edge.from === id ? edge.to : edge.from))}`);
  return { now: source?.now ? toPublicText(source.now) : null, recent, running: source?.running ?? null, waiting: source?.waiting ?? null };
}

/** 꾸러미 모양 — 색만으로 가르지 않는다. */
export const PACKET_SHAPES: Record<ActivityEdge['kind'], string> = {
  request: '●', decision: '◆', report: '■', hand: '▲', launch: '★', move: '⬟', card: '◇', run: '▶',
};

/** request ↔ report/decision 이 같은 ref 로 거꾸로 오가면 왕복 꾸러미. */
export function isRoundTrip(edge: ActivityEdge, edges: readonly ActivityEdge[]): boolean {
  const pair = edge.kind === 'request' ? ['report', 'decision'] : edge.kind === 'report' || edge.kind === 'decision' ? ['request'] : [];
  return pair.length > 0 && edges.some(other => pair.includes(other.kind) && other.ref === edge.ref && other.from === edge.to && other.to === edge.from);
}
