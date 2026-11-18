// NODE-INNER-PROGRESS (ASK-GRAPH-LIVE-SIDETAB-1117 «추가» 2·4): what a long node is doing inside, read only from the
// run's event ledger (node-start/end · node-progress · node-heartbeat). No file mtimes, no guesses: an empty ledger
// renders «정보 없음».
import type { GraphEvent } from '../graph-runner/graph-events.js';
import { NODE_HEARTBEAT_EVENT, NODE_PROGRESS_EVENT } from '../graph-runner/node-progress.js';

export type NodeLiveness = 'active' | 'slow' | 'stalled';
// 출처: ASK-GRAPH-LIVE-SIDETAB-1117 «추가» 2) — ● 활동 ≤5분 · ◐ 느림 5~25분 · ✕ 멎음 >25분 무사건.
export const NODE_LIVENESS_ACTIVE_MS = 5 * 60_000;
export const NODE_LIVENESS_STALLED_MS = 25 * 60_000;
export const NO_LEDGER_TEXT = '정보 없음';

export function nodeLiveness(quietMs: number): NodeLiveness {
  if (quietMs <= NODE_LIVENESS_ACTIVE_MS) return 'active';
  return quietMs <= NODE_LIVENESS_STALLED_MS ? 'slow' : 'stalled';
}

const MARK: Record<NodeLiveness, string> = { active: '●', slow: '◐', stalled: '✕' };
const LABEL: Record<NodeLiveness, string> = { active: '살아 있음', slow: '느림', stalled: '멎음' };

export type NodeChainStatus = 'done' | 'failed' | 'running' | 'pending';
/** What one running node is doing; parallel branches each get their own. */
export interface ActiveNodeLiveness {
  readonly nodeId: string;
  readonly round?: number;
  /** Failed-test counts of the previous and current round, when the node reported them. */
  readonly previousFail?: number;
  readonly fail?: number;
  readonly phase?: string;
  readonly target?: string;
  readonly lastRepairCallAtMs?: number;
  readonly quietMs: number;
  readonly liveness: NodeLiveness;
  readonly roundAverageMs?: number;
  readonly roundElapsedMs?: number;
}
export interface NodeLivenessSummary extends Partial<Omit<ActiveNodeLiveness, 'nodeId' | 'quietMs' | 'liveness'>> {
  readonly runId: string;
  readonly elapsedMs: number;
  readonly chain: ReadonlyArray<{ readonly nodeId: string; readonly status: NodeChainStatus }>;
  /** Every running node, the quietest first. The single-node fields below repeat the first one. */
  readonly activeNodes: readonly ActiveNodeLiveness[];
  readonly activeNodeId?: string;
  /** The quietest running node's quiet time; with no running node, the run's. */
  readonly quietMs: number;
  readonly liveness: NodeLiveness;
}

const at = (event: GraphEvent): number => Date.parse(event.emittedAt);
// The runner writes 'ok' | 'fail'; providers also say 'failed' / 'error'. Anything not plainly successful is not ✓.
const SUCCESS_OUTCOMES = new Set(['ok', 'done', 'success', 'succeeded', 'passed']);
const endStatus = (outcome: unknown): NodeChainStatus =>
  outcome === undefined || (typeof outcome === 'string' && SUCCESS_OUTCOMES.has(outcome)) ? 'done' : 'failed';
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function activeNode(nodeId: string, started: number, lastActivity: number, progress: readonly GraphEvent[],
  nowMs: number): ActiveNodeLiveness {
  const roundStarts = new Map<number, number>();
  const roundFail = new Map<number, number>();
  let round: number | undefined; let phase: string | undefined; let target: string | undefined;
  let lastRepairCallAtMs: number | undefined;
  for (const event of progress) {
    const data = event.data ?? {};
    const eventRound = num(data.round);
    if (eventRound !== undefined) {
      if (!roundStarts.has(eventRound)) roundStarts.set(eventRound, at(event));
      round = eventRound;
    }
    const result = data.result as { fail?: unknown } | undefined;
    if (eventRound !== undefined && num(result?.fail) !== undefined) roundFail.set(eventRound, result!.fail as number);
    phase = typeof data.phase === 'string' ? data.phase : phase;
    target = data.phase === 'repair' && typeof data.target === 'string' ? data.target : data.phase === 'repair' ? target : undefined;
    const callAt = typeof data.llmCallAt === 'string' ? Date.parse(data.llmCallAt) : Number.NaN;
    if (Number.isFinite(callAt)) lastRepairCallAtMs = callAt;
  }
  const rounds = [...roundStarts.entries()].sort((a, b) => a[0] - b[0]);
  const durations = rounds.slice(1).map(([, start], index) => start - rounds[index]![1]);
  const fails = [...roundFail.entries()].sort((a, b) => a[0] - b[0]).map(([, fail]) => fail);
  const quietMs = Math.max(0, nowMs - lastActivity);
  return {
    nodeId,
    ...(round === undefined ? {} : { round }),
    ...(fails.length > 1 ? { previousFail: fails[fails.length - 2] } : {}),
    ...(fails.length ? { fail: fails[fails.length - 1] } : {}),
    ...(phase === undefined ? {} : { phase }),
    ...(target === undefined ? {} : { target }),
    ...(lastRepairCallAtMs === undefined ? {} : { lastRepairCallAtMs }),
    quietMs, liveness: nodeLiveness(quietMs),
    ...(durations.length ? { roundAverageMs: durations.reduce((sum, value) => sum + value, 0) / durations.length } : {}),
    roundElapsedMs: Math.max(0, nowMs - (rounds.length ? rounds[rounds.length - 1]![1] : started)),
  };
}

function focusFields(node: ActiveNodeLiveness): Omit<NodeLivenessSummary, 'runId' | 'elapsedMs' | 'chain' | 'activeNodes' | 'quietMs' | 'liveness'> {
  const { nodeId, quietMs, liveness, ...detail } = node;
  void quietMs; void liveness;
  return { activeNodeId: nodeId, ...detail };
}

/** undefined = nothing to show (no ledger events); the renderers then print «정보 없음». */
export function summarizeNodeLiveness(events: readonly GraphEvent[], nowMs: number,
  stages: readonly string[] = []): NodeLivenessSummary | undefined {
  if (!events.length) return undefined;
  const status = new Map<string, NodeChainStatus>(stages.map(stage => [stage, 'pending']));
  // Parallel branches run at once: each running node keeps its own start, activity and progress.
  const running = new Map<string, { started: number; lastActivity: number; progress: GraphEvent[] }>();
  let runActivity = at(events[0]!);
  for (const event of events) {
    const nodeId = event.source.nodeId;
    if (!nodeId) continue;
    if (event.type === 'node-start') {
      status.set(nodeId, 'running');
      running.set(nodeId, { started: at(event), lastActivity: at(event), progress: [] });
      runActivity = at(event);
    } else if (event.type === 'node-end') {
      status.set(nodeId, endStatus(event.data?.outcome));
      running.delete(nodeId);
      runActivity = at(event);
    } else if (event.type !== NODE_HEARTBEAT_EVENT) {
      // Every node event but the runner's heartbeat is activity; only node-progress carries round/phase detail.
      const node = running.get(nodeId);
      if (!node) continue;
      node.lastActivity = at(event);
      if (event.type === NODE_PROGRESS_EVENT) node.progress.push(event);
      runActivity = Math.max(runActivity, at(event));
    }
  }
  const activeNodes = [...running].map(([nodeId, node]) => activeNode(nodeId, node.started, node.lastActivity, node.progress, nowMs))
    .sort((a, b) => b.quietMs - a.quietMs);
  const focus = activeNodes[0];
  const quietMs = focus?.quietMs ?? Math.max(0, nowMs - runActivity);
  return {
    runId: events[0]!.runId,
    elapsedMs: Math.max(0, nowMs - at(events[0]!)),
    chain: [...status].map(([nodeId, value]) => ({ nodeId, status: value })),
    activeNodes,
    ...(focus ? focusFields(focus) : {}),
    quietMs, liveness: nodeLiveness(quietMs),
  };
}

const minutes = (ms: number): number => Math.floor(ms / 60_000);
function compact(ms: number): string {
  const total = minutes(ms);
  return total >= 60 ? `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}m` : `${total}m`;
}

const CHAIN_MARK: Record<NodeChainStatus, string> = { done: '✓', failed: '✕', running: '◐', pending: '○' };

function livenessDetail(summary: NodeLivenessSummary, nowMs: number): string {
  if (summary.liveness === 'stalled') return `${minutes(summary.quietMs)}분 무사건`;
  return summary.lastRepairCallAtMs === undefined ? `마지막 활동 ${minutes(summary.quietMs)}분 전`
    : `마지막 수리 호출 ${minutes(Math.max(0, nowMs - summary.lastRepairCallAtMs))}분 전`;
}

function failText(summary: Pick<ActiveNodeLiveness, 'fail' | 'previousFail'>): string | undefined {
  if (summary.fail === undefined) return undefined;
  return summary.previousFail === undefined ? `실패 시험 ${summary.fail}` : `실패 시험 ${summary.previousFail} → ${summary.fail}`;
}

/** Sidetab (wide) frame. */
export function renderNodeLivenessWide(summary: NodeLivenessSummary | undefined, kind: string, nowMs: number): string[] {
  if (!summary) return [`⎇ ${kind} · ${NO_LEDGER_TEXT}`];
  const lines = [`⎇ ${kind} · ${summary.runId.slice(0, 8)} · ${compact(summary.elapsedMs)}           `
    + `${MARK[summary.liveness]} ${LABEL[summary.liveness]} (${livenessDetail(summary, nowMs)})`];
  if (summary.chain.length) lines.push('  ' + summary.chain.map(item => `${CHAIN_MARK[item.status]} ${item.nodeId}`).join(' ─ '));
  const parallel = summary.activeNodes.length > 1;
  for (const node of summary.activeNodes) {
    lines.push(`  ${[node.nodeId, node.round === undefined ? undefined : `라운드 ${node.round}`, failText(node),
      parallel ? `${MARK[node.liveness]} ${LABEL[node.liveness]}` : undefined].filter(Boolean).join(' · ')}`);
    if (node.phase === 'repair' && node.target) lines.push(`    ↳ 수리 중  ${node.target}`);
    else if (node.phase === 'verify') lines.push('    ↳ 검증 중');
    if (node.roundElapsedMs !== undefined)
      lines.push(`    ↳ ${node.roundAverageMs === undefined ? '' : `라운드 평균 ${minutes(node.roundAverageMs)}분 · `}이번 라운드 ${minutes(node.roundElapsedMs)}분째`);
  }
  return lines;
}

/** The quietest running node, with `+N` for the other parallel nodes. */
function focusLabel(summary: NodeLivenessSummary): string | undefined {
  if (summary.activeNodeId === undefined) return undefined;
  const others = summary.activeNodes.length - 1;
  return `${summary.activeNodeId}${summary.round === undefined ? '' : ` r${summary.round}`}${others > 0 ? ` +${others}` : ''}`;
}

/** Narrow terminal / progress row: one line. */
export function renderNodeLivenessNarrow(summary: NodeLivenessSummary | undefined, kind: string): string {
  if (!summary) return `⎇ ${kind} · ${NO_LEDGER_TEXT}`;
  return [`⎇ ${kind}`, focusLabel(summary),
  summary.fail === undefined ? undefined : `fail ${summary.fail}`,
  `${MARK[summary.liveness]} ${compact(summary.quietMs)}`].filter(Boolean).join(' · ');
}

/** Progress row with the node chain (`⎇ app-build · ✓ files ─ ◐ verify-repair ─ ○ publish · r3 · fail 1 · ● 5m`);
 *  the narrow one-line form when it does not fit `columns`. */
export function renderNodeLivenessProgressRow(summary: NodeLivenessSummary | undefined, kind: string, columns: number): string {
  const narrow = renderNodeLivenessNarrow(summary, kind);
  if (!summary?.chain.length) return narrow;
  const wide = [`⎇ ${kind}`, summary.chain.map(item => `${CHAIN_MARK[item.status]} ${item.nodeId}`).join(' ─ '),
    summary.round === undefined ? undefined : `r${summary.round}`,
    summary.fail === undefined ? undefined : `fail ${summary.fail}`,
    `${MARK[summary.liveness]} ${compact(summary.quietMs)}`].filter(Boolean).join(' · ');
  return [...wide].length <= columns ? wide : narrow;
}

/** Default TUI tool-activity row (no sidetab needed): `⏺ app_build · verify-repair r6 · 실패 시험 1 · ● 5분 전 수리 호출 · 1h45m`. */
export function renderNodeLivenessToolRow(summary: NodeLivenessSummary | undefined, tool: string, nowMs: number,
  glyph = '⏺'): string[] {
  if (!summary) return [`${glyph} ${tool} · ${NO_LEDGER_TEXT}`];
  const when = summary.liveness !== 'stalled' && summary.lastRepairCallAtMs !== undefined
    ? `${minutes(Math.max(0, nowMs - summary.lastRepairCallAtMs))}분 전 수리 호출` : livenessDetail(summary, nowMs);
  const lines = [[`${glyph} ${tool}`, focusLabel(summary),
  summary.fail === undefined ? undefined : `실패 시험 ${summary.fail}`,
  `${MARK[summary.liveness]} ${when}`, compact(summary.elapsedMs)].filter(Boolean).join(' · ')];
  if (summary.phase === 'repair' && summary.target) lines.push(`  ↳ 수리 중 ${summary.target}`);
  return lines;
}
