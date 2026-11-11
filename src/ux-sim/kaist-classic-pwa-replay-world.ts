import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { asRecord } from '../primitives/guards.js';

export type KaistReplayScene = 2 | 3 | 5 | 6;

export interface KaistClassicPtyScene {
  runId: string;
  scene: number;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

export interface KaistClassicPtyReceipt {
  owner: string;
  graph: string;
  status: string;
  scenes: Record<string, KaistClassicPtyScene>;
  graphPath?: string[];
  boardCard: Record<string, unknown>;
  attachment: Record<string, unknown>;
  graphRun?: { graphId: string; runId: string; status: string; path: string[] };
}

export interface KaistPwaReplayEnvelope {
  schemaVersion: 1;
  source: Record<string, unknown>;
  receipt: KaistClassicPtyReceipt;
}

const RECEIPT_PATH = resolve(import.meta.dir, 'fixtures/kaist-classic-pty-receipt.json');
const BUILD_GRAPH_PATH = resolve(import.meta.dir, '../../plugins/absorb/graph/absorb-build.yaml');

export function loadKaistClassicPtyReceipt(path = process.env.KAIST_CLASSIC_PTY_RECEIPT_PATH?.trim()
  ? resolve(process.env.KAIST_CLASSIC_PTY_RECEIPT_PATH.trim()) : RECEIPT_PATH): KaistPwaReplayEnvelope {
  const envelope = JSON.parse(readFileSync(path, 'utf8')) as KaistPwaReplayEnvelope;
  validateKaistClassicPtyReceipt(envelope);
  return envelope;
}

function containsOrderedNodes(path: readonly string[], required: readonly string[]): boolean {
  let next = 0;
  for (const node of path) if (node === required[next]) next++;
  return next === required.length;
}

export function validateKaistClassicPtyReceipt(envelope: KaistPwaReplayEnvelope): void {
  const receipt = envelope?.receipt;
  if (envelope?.schemaVersion !== 1 || !receipt || receipt.graph !== 'absorb-build' || receipt.status !== 'done'
    || !receipt.owner || !receipt.scenes || !receipt.boardCard || !receipt.attachment) {
    throw new Error('KAIST replay requires a completed classic PTY absorb-build receipt');
  }
  for (const scene of [2, 3, 5, 6]) {
    const entry = receipt.scenes[String(scene)];
    if (!entry || entry.scene !== scene || typeof entry.runId !== 'string' || !entry.input || !entry.output) {
      throw new Error(`KAIST classic PTY receipt is missing scene ${scene}`);
    }
  }
  if (receipt.scenes['2']!.runId !== receipt.scenes['3']!.runId) {
    throw new Error('briefing scenes 2 and 3 must preserve their shared classic PTY runId');
  }
  if (receipt.scenes['5']!.runId !== receipt.scenes['6']!.runId) {
    throw new Error('build scenes 5 and 6 must preserve their shared classic PTY runId');
  }
  if (receipt.scenes['5']!.runId !== receipt.graphRun?.runId || receipt.graphRun?.graphId !== receipt.graph) {
    throw new Error('scene 5 must identify the graph run recorded by the classic PTY');
  }
  const completedPath = ['lookup-suggestion', 'build', 'simulate', 'approve-publish'];
  const firstPublishIndex = receipt.graphPath?.indexOf('publish') ?? -1;
  if (!Array.isArray(receipt.graphPath) || !Array.isArray(receipt.graphRun?.path)
    || receipt.graphPath.at(-1) !== 'done' || receipt.graphRun.path.at(-1) !== 'done'
    || JSON.stringify(receipt.graphPath) !== JSON.stringify(receipt.graphRun.path)
    || firstPublishIndex < 0
    || !containsOrderedNodes(receipt.graphPath.slice(0, firstPublishIndex), completedPath)) {
    throw new Error('classic PTY receipt must record the ordered absorb-build path through done');
  }
  const sceneAttachment = asRecord(receipt.scenes['5']!.output.attachment, { fallback: 'empty' });
  if (receipt.boardCard.id !== receipt.scenes['6']!.output.boardCardId
    || receipt.attachment.id !== sceneAttachment.id
    || receipt.attachment.sha256 !== sceneAttachment.sha256) {
    throw new Error('KAIST board card or attachment does not match the classic PTY receipt');
  }
}

export interface KaistPwaReplayWorld {
  readonly receipt: KaistClassicPtyReceipt;
  readonly owner: string;
  readonly appSlug: string;
  readonly unsupportedApiPaths: string[];
  readonly approvalPosts: Array<{ path: string; hasMemberCookie: boolean }>;
  readonly graphApprovalPosts: Array<{ path: string; decision: string; hasMemberCookie: boolean }>;
  setScene(scene: KaistReplayScene): void;
  handleApi(request: Request): Promise<Response>;
  graphInstanceView(): Record<string, unknown>;
}

/**
 * Serves the PWA's existing member/briefing/board/graph API contracts from one
 * fixed classic-PTY receipt. All unknown API calls are tracked and fail closed.
 */
export function createKaistPwaReplayWorld(envelope = loadKaistClassicPtyReceipt(), demo?: {
  gcpApproval?: { graphId: string; runId: string; nodeId: string; message: string };
  boardAttachments?: Array<{ kind: 'diagram' | 'diagram-source' | 'pdf' | 'html'; title: string; url: string; mime: string; sha256: string; producedBy: string }>;
}): KaistPwaReplayWorld {
  validateKaistClassicPtyReceipt(envelope);
  const receipt = envelope.receipt;
  const owner = receipt.owner;
  let scene: KaistReplayScene = 2;
  const unsupportedApiPaths: string[] = [];
  const approvalPosts: Array<{ path: string; hasMemberCookie: boolean }> = [];
  const graphApprovalPosts: Array<{ path: string; decision: string; hasMemberCookie: boolean }> = [];
  const suggestion = asRecord(receipt.scenes['4']?.output.suggestion, { fallback: 'empty' });
  const appSlug = typeof suggestion.appId === 'string' ? suggestion.appId : 'kaist-fake-app';
  const briefing = asRecord(receipt.scenes['3']?.output.briefing, { fallback: 'empty' });
  const attachment = asRecord(receipt.attachment, { fallback: 'empty' });
  const artifactPaths = Array.isArray(attachment.files) ? attachment.files.filter((entry): entry is string => typeof entry === 'string') : [];
  const resultUrl = typeof receipt.scenes['6']?.output.resultUrl === 'string' ? receipt.scenes['6'].output.resultUrl : undefined;
  const cardTitle = typeof receipt.boardCard.title === 'string' ? receipt.boardCard.title
    : typeof suggestion.ask === 'string' ? suggestion.ask : 'KAIST graph build';
  const sourceScrapIds = Array.isArray(suggestion.evidenceScrapIds) ? suggestion.evidenceScrapIds : [];
  const rawBriefingTopics = Array.isArray(briefing.topics) ? briefing.topics : [];
  const briefingTopics = rawBriefingTopics.map((topic) => {
    const row = asRecord(topic, { fallback: 'empty' });
    return {
      title: typeof row.title === 'string' ? row.title : 'KAIST lecture materials',
      summary: typeof row.summary === 'string' ? row.summary : 'KAIST lecture materials',
      scrapIds: Array.isArray(row.sourceScrapIds) ? row.sourceScrapIds : sourceScrapIds,
    };
  });
  const boardCard = (released: boolean) => ({
    id: String(receipt.boardCard.id), memberId: owner, title: cardTitle,
    state: released ? 'deployed' : 'proposed',
    summary: released ? 'absorb-build simulation passed and published' : String(suggestion.ask ?? cardTitle),
    runId: receipt.scenes[released ? '6' : '3']!.runId,
    ...(released && resultUrl ? { resultUrl } : {}),
    ...(released && demo?.boardAttachments ? { attachments: demo.boardAttachments } :
    released && resultUrl && artifactPaths.length ? { attachments: artifactPaths.map((path) => ({
      kind: 'html', title: path.replace(/^\//, ''), url: new URL(path.replace(/^\//, ''), resultUrl).toString(),
      mime: 'text/html', sha256: String(attachment.sha256 ?? ''), producedBy: receipt.graph,
    })) } : {}),
    updatedAt: '2026-11-11T00:32:15.000Z',
  });

  return {
    receipt, owner, appSlug, unsupportedApiPaths, approvalPosts, graphApprovalPosts,
    setScene(value) { scene = value; },
    async handleApi(request) {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/v1/debug-logs/batch') {
        try { await request.json(); } catch { /* Empty browser beacon is still a local discarded observation. */ }
        return Response.json({ accepted: true, count: 0, scope: 'test-world-discarded' });
      }
      if (request.method === 'POST' && url.pathname === `/v1/board/${receipt.boardCard.id}/approve` && scene === 3) {
        const hasMemberCookie = request.headers.get('cookie')?.includes('app-session=fake-kaist-member') ?? false;
        approvalPosts.push({ path: url.pathname, hasMemberCookie });
        if (!hasMemberCookie || approvalPosts.length !== 1) return Response.json({ error: 'invalid-kaist-approval' }, { status: 409 });
        return Response.json({ dispatch: { acceptanceId: receipt.graphRun!.runId } });
      }
      if (request.method === 'POST' && demo?.gcpApproval && scene === 5
        && url.pathname === `/v1/graph-approvals/${encodeURIComponent(demo.gcpApproval.graphId)}/${encodeURIComponent(demo.gcpApproval.runId)}`) {
        const hasMemberCookie = request.headers.get('cookie')?.includes('app-session=fake-kaist-member') ?? false;
        const body = await request.json().catch(() => null) as { decision?: unknown } | null;
        const decision = String(body?.decision ?? '');
        graphApprovalPosts.push({ path: url.pathname, decision, hasMemberCookie });
        if (!hasMemberCookie || decision !== 'approved' || graphApprovalPosts.length !== 1) {
          return Response.json({ error: 'invalid-gcp-test-approval' }, { status: 409 });
        }
        return Response.json({ graphId: demo.gcpApproval.graphId, runId: demo.gcpApproval.runId, decision });
      }
      if (request.method !== 'GET') {
        unsupportedApiPaths.push(`${request.method} ${url.pathname}`);
        return Response.json({ error: 'kaist-replay-read-only' }, { status: 405 });
      }
      if (url.pathname === '/v1/members') return Response.json({ member: { id: owner }, appSlot: { appSlug } });
      if (url.pathname === '/v1/members/owner') return Response.json({ memberId: owner, appSlug });
      if (url.pathname === '/v1/board') return Response.json({ cards: [boardCard(scene === 6)] });
      if (url.pathname === '/v1/graph-approvals' && demo?.gcpApproval && scene === 5) {
        return Response.json({ items: graphApprovalPosts.length ? [] : [{ ...demo.gcpApproval,
          since: '2026-11-10T08:09:42.170Z', path: ['detect', 'design', 'deliverables'], recent: [] }] });
      }
      if (url.pathname === '/v1/briefings') return Response.json({ briefings: [{
        id: String(briefing.id ?? 'brief-kaist-1'), memberId: owner, day: String(briefing.day ?? '2026-11-09'),
        topics: briefingTopics, todos: [], suggestionIds: [String(suggestion.id ?? 'suggestion-2026-11-09-1')],
        createdAt: '2026-11-11T00:32:15.000Z',
      }] });
      if (url.pathname === '/v1/graph-instance-view') {
        const view = this.graphInstanceView();
        if (url.searchParams.get('source') !== 'graph'
          || url.searchParams.get('runId') !== receipt.graphRun?.runId
          || url.searchParams.get('graphId') !== receipt.graph) {
          return Response.json({ error: 'graph-instance-mismatch' }, { status: 404 });
        }
        return Response.json(view);
      }
      if (url.pathname === '/v1/events') return new Response(null, { status: 204 });
      if (url.pathname.startsWith('/v1/config/switches/')) return Response.json({
        switch: { id: url.pathname.slice('/v1/config/switches/'.length), value: 'catppuccin-mocha' },
      });
      if (url.pathname === '/v1/logs') return Response.json({ ok: true, logs: [], count: 0, ts: '2026-11-11T00:32:15.000Z' });
      // Chat shell reads optional, unrelated panel state; empty deterministic
      // shapes keep it local while owner/board data still comes from the receipt.
      const emptyShapes: Record<string, unknown> = {
        '/v1/me': { member: { id: owner }, appSlot: { appSlug } },
        '/v1/skills/problems': { problems: [] }, '/v1/projects': { projects: [] },
        '/v1/sessions/store': { sessions: [] }, '/v1/setup/llm-providers': { providers: [] },
        '/v1/ops/seats': { seats: [] }, '/v1/graph-approvals': { items: [] },
        '/v1/decisions': { decisions: [] }, '/v1/seat-requests': { seats: [], items: [] },
        '/v1/budget/status': {}, '/v1/voice/cost': {}, '/v1/terminals': { terminals: [] },
      };
      const shape = emptyShapes[url.pathname];
      if (shape !== undefined) return Response.json(shape);
      if (url.pathname.startsWith('/v1/sessions/store/')) return Response.json({ session: null });
      if (url.pathname === '/v1/chat/events' || url.pathname === '/v1/acp') return new Response(null, { status: 204 });
      unsupportedApiPaths.push(`${request.method} ${url.pathname}`);
      return Response.json({ error: 'unmodeled-kaist-replay-api' }, { status: 501 });
    },
    graphInstanceView() {
      if (!existsSync(BUILD_GRAPH_PATH)) throw new Error(`absorb-build graph missing: ${BUILD_GRAPH_PATH}`);
      const document = asRecord(parseYaml(readFileSync(BUILD_GRAPH_PATH, 'utf8')), { fallback: 'empty' });
      const graph = asRecord(document.graph, { fallback: 'empty' });
      const nodes = Array.isArray(document.nodes) ? document.nodes.map((value) => asRecord(value, { fallback: 'empty' })) : [];
      const edges = Array.isArray(document.edges) ? document.edges.map((value) => asRecord(value, { fallback: 'empty' })) : [];
      const runPath = receipt.graphRun?.path ?? [];
      if (!runPath.length || receipt.graphRun?.status !== 'done') throw new Error('classic PTY graph-run path is missing or not complete');
      const taken = new Set(runPath.slice(1).map((id, index) => `${runPath[index]}->${id}`));
      const title = typeof suggestion.ask === 'string' ? suggestion.ask : 'absorb-build';
      return {
        schemaVersion: 1,
        instance: { source: 'graph', runId: receipt.graphRun.runId, graphId: receipt.graph,
          title, observedAt: String(envelope.source.observedAt ?? '2026-11-11T00:32:15.000Z'), state: 'done' },
        nodes: nodes.filter((node) => runPath.includes(String(node.id))).map((node) => ({
          id: String(node.id), label: String(node.id), role: String(node.type ?? 'graph node'), state: 'done',
        })),
        edges: edges.filter((edge) => runPath.includes(String(edge.from)) && runPath.includes(String(edge.to))).map((edge, index) => ({
          id: `${String(edge.from)}-${String(edge.to)}-${index}`, from: String(edge.from), to: String(edge.to),
          kind: 'flow', state: taken.has(`${String(edge.from)}->${String(edge.to)}`) ? 'taken' : 'planned',
        })),
        progress: { completed: runPath.length, total: runPath.length, activeNodeIds: [], label: '완료' },
        logs: [], statusLine: `${String(graph.id ?? receipt.graph)} · ${receipt.graphRun.runId} · 완료`, readState: 'ok',
      };
    },
  };
}
