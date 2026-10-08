import { NexusApiError, type GraphWizardRequest, type GraphWizardResponse, type GraphWizardSteps } from '@/nexus/client';
import { fromYaml, type CanvasGraph } from './graph-canvas-model';

/** GRAPH-WIZARD — «말로 만들기» chat. Pure helpers: the request, the reply shape, and how a reply lands
 *  on the canvas (stable node ids keep their positions; what is new is reported for a brief highlight). */

export type WizardClient = { graphWizard(body: GraphWizardRequest, opts?: { signal?: AbortSignal }): Promise<GraphWizardResponse> };

export type WizardTurn = { role: 'user' | 'assistant'; text: string };

export const WIZARD_EXAMPLES: readonly string[] = [
  '매일 아침 AI 뉴스 요약해서 텔레그램으로',
  'PR 리뷰하고 문제 없으면 머지',
  '조사해서 표로 정리하고 내가 승인하면 게시',
];

/** How many past turns go with each request (contract: «the last ~10»). */
export const WIZARD_HISTORY_TURNS = 10;

export const WIZARD_UNSUPPORTED = '이 Daemon 이 아직 그래프 마법사를 지원하지 않습니다 — 서버 업데이트 후 다시 시도하세요';

export type WizardOutcome =
  | { kind: 'draft'; ok: boolean; yaml: string; graph: CanvasGraph | null; parseError?: string; base?: string; attempts?: number; summary?: string; issues: string[]; labels?: Record<string, string>; baseReason?: string; steps?: GraphWizardSteps }
  | { kind: 'empty' }
  | { kind: 'unsupported' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

export function issueText(issue: unknown): string {
  if (typeof issue === 'string') return issue;
  if (issue && typeof issue === 'object') {
    const entry = issue as { message?: unknown; path?: unknown; nodeId?: unknown };
    const where = typeof entry.nodeId === 'string' ? entry.nodeId : typeof entry.path === 'string' ? entry.path : '';
    const message = typeof entry.message === 'string' ? entry.message : JSON.stringify(issue);
    return where ? `${where}: ${message}` : message;
  }
  return String(issue);
}

export function wizardRequest(prompt: string, currentYaml: string | null, turns: readonly WizardTurn[]): GraphWizardRequest {
  return {
    prompt: prompt.trim(),
    kind: 'harness',
    ...(currentYaml ? { currentYaml } : {}),
    ...(turns.length ? { history: turns.slice(-WIZARD_HISTORY_TURNS).map((turn) => ({ role: turn.role, text: turn.text })) } : {}),
  };
}

/** One wizard turn. Never throws: every way it can end is a value the chat can render. */
export async function askWizard(client: WizardClient, body: GraphWizardRequest, signal?: AbortSignal): Promise<WizardOutcome> {
  if (!body.prompt.trim()) return { kind: 'empty' };
  try {
    const reply = await client.graphWizard(body, signal ? { signal } : undefined);
    return draftOf(reply);
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return { kind: 'cancelled' };
    if (error instanceof NexusApiError) {
      if (error.status === 404 || error.status === 405) return { kind: 'unsupported' };
      if (error.status === 422 && error.body && typeof error.body === 'object' && 'ok' in error.body) return draftOf(error.body as GraphWizardResponse);
      const body = (error.body ?? {}) as { error?: string; reason?: string };
      if (error.status === 400 && (!body.reason || body.reason === 'prompt required')) return { kind: 'empty' };
      if (error.status === 400) return { kind: 'error', message: `요청을 받지 않았습니다 — ${body.reason}` };
      return { kind: 'error', message: body.reason ?? (body.error ? `${body.error} (${error.status})` : `요청 실패 (${error.status})`) };
    }
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

function draftOf(reply: GraphWizardResponse): WizardOutcome {
  const issues = (reply.issues ?? []).map(issueText);
  const yaml = typeof reply.yaml === 'string' ? reply.yaml : '';
  let graph: CanvasGraph | null = null;
  let parseError: string | undefined;
  if (yaml.trim()) {
    try { graph = fromYaml(yaml); } catch (error) { parseError = error instanceof Error ? error.message : String(error); }
    if (graph && graph.nodes.length === 0) { graph = null; parseError = '초안에 노드가 없습니다'; }
  } else {
    parseError = '응답에 YAML 이 없습니다';
  }
  return {
    kind: 'draft', ok: reply.ok === true && issues.length === 0, yaml, graph, issues,
    ...(parseError ? { parseError } : {}),
    ...(reply.base ? { base: reply.base } : {}),
    ...(typeof reply.attempts === 'number' ? { attempts: reply.attempts } : {}),
    ...(reply.summary ? { summary: reply.summary } : {}),
    ...(reply.labels && typeof reply.labels === 'object' ? { labels: stringMap(reply.labels) } : {}),
    ...(reply.steps && typeof reply.steps === 'object' && !Array.isArray(reply.steps) ? { steps: reply.steps } : {}),
    ...(typeof reply.baseReason === 'string' && reply.baseReason.trim() ? { baseReason: reply.baseReason.trim() } : {}),
  };
}

function stringMap(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== ''));
}

/** «기반: <template> — 이유 …» — only when the daemon said why (v2). */
export function baseReasonLine(outcome: { base?: string; baseReason?: string }): string | null {
  if (!outcome.baseReason) return null;
  return outcome.base ? `기반: ${outcome.base} — 이유 ${outcome.baseReason}` : `기반 선택 이유: ${outcome.baseReason}`;
}

export type WizardDiff = { nodes: string[]; edges: string[] };

export function edgeKey(edge: { from: string; to: string; outcome: string }): string {
  return `${edge.from}->${edge.to}:${edge.outcome}`;
}

/** True when the user dragged a node since the wizard last laid the canvas out (or the canvas was not the
 *  wizard's to begin with — a stored graph opened for editing keeps its hand layout). */
export function userMovedNodes(lastApplied: CanvasGraph | null, current: CanvasGraph | null): boolean {
  if (!current || current.nodes.length === 0) return false;
  if (!lastApplied) return true;
  const laid = new Map(lastApplied.nodes.map((node) => [node.id, node]));
  return current.nodes.some((node) => {
    const was = laid.get(node.id);
    return !was || was.x !== node.x || was.y !== node.y;
  });
}

/** Lay the wizard's graph over the current canvas. While the canvas is still the wizard's own layout the whole
 *  graph is laid out afresh (so a node inserted mid-chain lands in line); once the user has moved nodes, ids
 *  that survive keep where the user put them and only new nodes take the fresh layout. Returns what is new. */
export function mergeWizardGraph(previous: CanvasGraph | null, next: CanvasGraph, opts: { keepPositions?: boolean } = {}): { graph: CanvasGraph; added: WizardDiff } {
  const keep = opts.keepPositions ?? true;
  const before = new Map((previous?.nodes ?? []).map((node) => [node.id, node]));
  const nodes = next.nodes.map((node) => {
    const kept = keep ? before.get(node.id) : undefined;
    return kept ? { ...node, x: kept.x, y: kept.y } : node;
  });
  const oldEdges = new Set((previous?.edges ?? []).map(edgeKey));
  return {
    graph: { ...next, nodes },
    added: {
      nodes: next.nodes.filter((node) => !before.has(node.id)).map((node) => node.id),
      edges: next.edges.filter((edge) => !oldEdges.has(edgeKey(edge))).map(edgeKey),
    },
  };
}

/** The assistant bubble's status line. */
export function draftStatusLine(outcome: Extract<WizardOutcome, { kind: 'draft' }>): string {
  const base = outcome.base ? ` · 기반 템플릿 ${outcome.base}` : '';
  const tries = outcome.attempts !== undefined ? `(시도 ${outcome.attempts})` : '';
  if (outcome.ok) return `초안${base} · 검증 통과${tries}`;
  return `초안${base} · 검증 실패 ${outcome.issues.length}건${tries}`;
}

/** What the wait line says while the wizard works (estimated from elapsed time — the API does not stream). */
export function wizardPhase(elapsedSeconds: number): string {
  if (elapsedSeconds < 4) return '요청을 읽는 중…';
  if (elapsedSeconds < 12) return '노드 구성 중…';
  if (elapsedSeconds < 22) return '간선 잇는 중…';
  return '검증하고 고치는 중…';
}
