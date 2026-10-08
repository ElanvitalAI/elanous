// CGE-RUN — 편집기 «데모 실행»: 내 그래프를 범용 실행기로 돌리고(POST /v1/graphs/<id>/run) 노드별 상태를 읽는다(GET …/runs/<runId>).
// 운영자 전용 길이다 — 403 이면 화면이 «운영자만 실행할 수 있다»고 말한다.
import { NexusApiError, type NexusClient } from '@/nexus/client';
import type { NodeRunStatus, NodeStatusEntry } from '@/components/workflows/run-status-helpers';

export interface GraphRunNode { nodeId: string; ok: boolean; executed: boolean; startedAt?: string; endedAt?: string; error?: string }
export interface GraphRun {
  graphId: string; runId: string;
  status: 'starting' | 'running' | 'done' | 'failed' | 'budget-exceeded' | 'awaiting-approval';
  startedAt?: string; finishedAt?: string; path: string[]; nodes: GraphRunNode[];
  currentNode?: { nodeId: string; startedAt: string }; error?: string;
}

export type StartResult =
  | { kind: 'started'; runId: string }
  | { kind: 'not-runnable'; issues: string[] }
  | { kind: 'forbidden' }
  | { kind: 'error'; status: number; message: string };

export type GraphRunClient = Pick<NexusClient, 'startRunGraphRun' | 'getRunGraphRun'>;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function startGraphRun(client: GraphRunClient, graphId: string): Promise<StartResult> {
  try {
    const body = await client.startRunGraphRun(graphId);
    return typeof body?.runId === 'string' ? { kind: 'started', runId: body.runId } : { kind: 'error', status: 0, message: '런 id 가 없다' };
  } catch (error) {
    if (!(error instanceof NexusApiError)) return { kind: 'error', status: 0, message: '데몬에 닿지 못했다' };
    const body: unknown = error.body;
    if (error.status === 403) return { kind: 'forbidden' };
    if (error.status === 422 && record(body) && Array.isArray(body.issues)) {
      return { kind: 'not-runnable', issues: body.issues.filter((issue): issue is string => typeof issue === 'string') };
    }
    const message = record(body) && typeof body.reason === 'string' ? body.reason : record(body) && typeof body.error === 'string' ? body.error : '';
    return { kind: 'error', status: error.status, message };
  }
}

function runOf(value: unknown): GraphRun | null {
  if (!record(value) || typeof value.runId !== 'string' || typeof value.status !== 'string' || !Array.isArray(value.path) || !Array.isArray(value.nodes)) return null;
  return value as unknown as GraphRun;
}

export async function getGraphRun(client: GraphRunClient, graphId: string, runId: string): Promise<GraphRun | null> {
  try { return runOf(await client.getRunGraphRun(graphId, runId)); } catch { return null; }
}

/** 폴링을 멈추는 상태 — 승인 대기도 데모 실행에선 사람 손 없이 안 풀리므로 멈춘다. */
export const RUN_FINISHED = new Set<GraphRun['status']>(['done', 'failed', 'budget-exceeded', 'awaiting-approval']);

/** 노드별 상태 — 워크플로 캔버스와 같은 꼴(run-status-helpers)이라 같은 색을 쓴다. 한 노드를 여러 번 지났으면 마지막 기록이 이긴다. */
export function graphRunNodeStatuses(run: GraphRun): Record<string, NodeStatusEntry> {
  const out: Record<string, NodeStatusEntry> = {};
  for (const node of run.nodes) {
    const durationMs = node.startedAt && node.endedAt ? Math.max(0, Date.parse(node.endedAt) - Date.parse(node.startedAt)) : undefined;
    const status: NodeRunStatus = node.ok ? 'done' : 'failed';
    out[node.nodeId] = { status, ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}), ...(node.error ? { error: node.error } : {}) };
  }
  if (run.currentNode && !RUN_FINISHED.has(run.status)) out[run.currentNode.nodeId] = { status: 'running' };
  if (run.status === 'awaiting-approval' && run.currentNode) out[run.currentNode.nodeId] = { status: 'awaiting_approval' };
  return out;
}

/** 한 줄 요약 — «데모 실행 · 도는 중 build · 지난 노드 3» / «데모 실행 · 성공 · 거친 노드 6(다시 지남 2)». */
export function graphRunLine(run: GraphRun): string {
  const visits = run.path.length;
  const again = visits - new Set(run.path).size;
  switch (run.status) {
    case 'starting': return '데모 실행 · 시작하는 중';
    case 'running': return `데모 실행 · 도는 중${run.currentNode ? ` ${run.currentNode.nodeId}` : ''} · 지난 노드 ${run.nodes.length}`;
    case 'done': return `데모 실행 · 성공 · 거친 노드 ${visits}${again ? `(다시 지남 ${again})` : ''}`;
    case 'budget-exceeded': return `데모 실행 · 방문 한도 초과${run.path.at(-1) ? ` ${run.path.at(-1)}` : ''} — max_visits 를 늘려 저장하고 다시 실행`;
    case 'awaiting-approval': return `데모 실행 · 승인 대기${run.currentNode ? ` ${run.currentNode.nodeId}` : ''}`;
    default: {
      const failed = [...run.nodes].reverse().find((node) => !node.ok);
      return `데모 실행 · 실패${failed ? ` ${failed.nodeId}` : ''}${run.error ? ` — ${run.error}` : failed?.error ? ` — ${failed.error}` : ''}`;
    }
  }
}
