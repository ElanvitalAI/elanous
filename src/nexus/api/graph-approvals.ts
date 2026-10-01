import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { decideGraphApproval, lastJsonObject, type GraphRunState } from '../../graph-runner/runner.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import { jsonResponse } from './json-response.js';
import { applyFeedEdit, feedFolderFor, isFeedPreviewMessage, mediaContentType, readFeedDraft, resolveFeedMedia, writeFeedDraft, type FeedDraft } from './graph-approvals-feed.js';

export const GRAPH_APPROVALS_PATH = '/v1/graph-approvals';
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface GraphApprovalItem {
  graphId: string;
  runId: string;
  nodeId: string;
  message: string;
  since: string;
  path: string[];
  recent: Array<{ nodeId: string; ok: boolean; outcome?: string; summary?: string }>;
  /** EV10d — present only for a `{"kind":"feed-preview"}` approval whose run folder holds a valid draft. */
  feed?: Omit<FeedDraft, 'folder'>;
}

/** One decision this daemon applied through `POST /v1/graph-approvals/:graphId/:runId`. */
interface GraphApprovalDecided {
  graphId: string;
  runId: string;
  nodeId: string;
  decision: 'approved' | 'rejected';
  decidedAt: string;
}

export const GRAPH_DECISION_RING_CAPACITY = 100;
export const GRAPH_DECISION_RING_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Recent decisions, in memory. The undecided list drops a run the moment it is decided, so
 * another device (Fold ↔ iPhone) could only see «gone» — this ring lets it say «승인됨/거절됨».
 * ⚠️ In-memory: a daemon restart forgets it, and a decision made outside this process
 * (`elanous graph approve` CLI) is not recorded — clients keep a «decided elsewhere» fallback.
 */
export function createGraphDecisionRing(opts: { capacity?: number; maxAgeMs?: number; now?: () => number } = {}) {
  const capacity = opts.capacity ?? GRAPH_DECISION_RING_CAPACITY;
  const maxAgeMs = opts.maxAgeMs ?? GRAPH_DECISION_RING_MAX_AGE_MS;
  const now = opts.now ?? Date.now;
  let entries: Array<{ atMs: number; record: GraphApprovalDecided }> = [];
  const prune = () => {
    const cutoff = now() - maxAgeMs;
    entries = entries.filter((entry) => entry.atMs > cutoff).slice(-capacity);
  };
  return {
    record(decision: Omit<GraphApprovalDecided, 'decidedAt'>): void {
      const atMs = now();
      entries.push({ atMs, record: { ...decision, decidedAt: new Date(atMs).toISOString() } });
      prune();
    },
    /** Newest first, pruned by age and capacity. */
    list(): GraphApprovalDecided[] {
      prune();
      return entries.map((entry) => entry.record).reverse();
    },
  };
}

export type GraphDecisionRing = ReturnType<typeof createGraphDecisionRing>;

const defaultDecisionRing = createGraphDecisionRing();

interface GraphApprovalsDeps {
  /** Injected in tests; production shares one per-process ring. */
  decisions?: GraphDecisionRing;
  authorize?: (request: Request) => boolean;
  /** Credential the request carries, checked independently of same-origin (`bearerCredential`).
   * A decision needs a bearer token: same-origin alone is not trusted because behind
   * `tailscale serve` every tailnet peer (Pod included) arrives from loopback. */
  authReason?: (request: Request) => string | undefined;
  root?: string;
  /** Config dir whose `field/<slug>` folders may hold feed drafts (EV10d). */
  configDir?: string;
}

const DECISION_AUTH_REASONS = new Set(['bearer-match', 'temp-token', 'noauth']);

function validSegment(value: string): boolean {
  return SEGMENT.test(value) && value !== '.' && value !== '..';
}

function readRun(root: string, graphId: string, runId: string): GraphRunState | null {
  if (!validSegment(graphId) || !validSegment(runId)) return null;
  try {
    const state = JSON.parse(readFileSync(join(root, 'graph-runs', graphId, `${runId}.json`), 'utf8')) as GraphRunState;
    return state.graphId === graphId && state.runId === runId ? state : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function undecided(state: GraphRunState, root: string): boolean {
  return state.status === 'awaiting-approval' && !!state.pending && !state.pending.decision
    && Array.isArray(state.path) && !existsSync(join(root, 'graph-runs', state.graphId, `${state.runId}.json.${state.path.length}.decision.json`));
}

function feedFor(state: GraphRunState, configDir: string): Omit<FeedDraft, 'folder'> | undefined {
  if (!isFeedPreviewMessage(state.pending?.message ?? '')) return undefined;
  const folder = feedFolderFor(state, configDir);
  const draft = folder ? readFeedDraft(folder) : null;
  if (!draft) return undefined;
  const { folder: _folder, ...rest } = draft;
  return rest;
}

function list(root: string, configDir: string): GraphApprovalItem[] {
  const dir = join(root, 'graph-runs');
  let graphs: Dirent[];
  try { graphs = readdirSync(dir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const items: GraphApprovalItem[] = [];
  for (const graph of graphs) {
    if (!graph.isDirectory() || !validSegment(graph.name)) continue;
    for (const file of readdirSync(join(dir, graph.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json') || file.name.endsWith('.decision.json')) continue;
      const runId = file.name.slice(0, -5);
      const state = readRun(root, graph.name, runId);
      if (!state || !undecided(state, root) || !Array.isArray(state.nodes)) continue;
      const pending = state.pending!;
      const feed = feedFor(state, configDir);
      items.push({
        graphId: state.graphId, runId: state.runId, nodeId: pending.nodeId, message: pending.message,
        since: pending.since, path: state.path,
        recent: state.nodes.slice(-5).map((node) => {
          const output = lastJsonObject(node.output);
          return {
            nodeId: node.nodeId, ok: node.ok,
            ...(typeof output?.outcome === 'string' ? { outcome: output.outcome } : {}),
            ...(typeof output?.summary === 'string' ? { summary: output.summary } : {}),
          };
        }),
        ...(feed ? { feed } : {}),
      });
    }
  }
  return items.sort((a, b) => b.since.localeCompare(a.since));
}

export async function handleGraphApprovals(req: Request, deps: GraphApprovalsDeps = {}): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const sub = /^\/v1\/graph-approvals\/([^/]+)\/([^/]+)\/(feed-draft|media)$/.exec(pathname);
  const match = /^\/v1\/graph-approvals\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (pathname !== GRAPH_APPROVALS_PATH && !match && !sub) return jsonResponse({ error: 'not-found' }, 404);
  if (!deps.authorize?.(req)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (sub) return handleFeed(req, url, sub[1]!, sub[2]!, sub[3] as 'feed-draft' | 'media', deps);
  if (pathname === GRAPH_APPROVALS_PATH) {
    if (req.method !== 'GET') return jsonResponse({ error: 'method-not-allowed' }, 405);
    // ⭐ `items` is unchanged; `decided` is additive (newest first) for other devices' cards.
    return jsonResponse({ items: list(deps.root ?? effectiveInstanceRoot(), deps.configDir ?? getElanousConfigDir()), decided: (deps.decisions ?? defaultDecisionRing).list() });
  }
  if (req.method !== 'POST') return jsonResponse({ error: 'method-not-allowed' }, 405);
  const authReason = deps.authReason?.(req);
  if (!authReason || !DECISION_AUTH_REASONS.has(authReason)) {
    debug.log('approvals.graph', 'refused', { reason: 'pairing-required', auth: authReason ?? null });
    return jsonResponse({ error: 'pairing-required' }, 403);
  }
  let graphId: string;
  let runId: string;
  try { graphId = decodeURIComponent(match![1]!); runId = decodeURIComponent(match![2]!); }
  catch { return jsonResponse({ error: 'not-found' }, 404); }
  if (!validSegment(graphId) || !validSegment(runId)) return jsonResponse({ error: 'not-found' }, 404);
  let body: unknown;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'bad_request' }, 400); }
  const decision = body && typeof body === 'object' && !Array.isArray(body) && 'decision' in body ? body.decision : undefined;
  if (decision !== 'approved' && decision !== 'rejected') return jsonResponse({ error: 'bad_request' }, 400);
  const root = deps.root ?? effectiveInstanceRoot();
  const state = readRun(root, graphId, runId);
  if (!state) return jsonResponse({ error: 'not-found' }, 404);
  if (!undecided(state, root)) return jsonResponse({ error: 'already-decided' }, 409);
  const nodeId = state.pending!.nodeId;
  try {
    decideGraphApproval(graphId, runId, decision, `pwa:${authReason}`, root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return jsonResponse({ error: 'not-found' }, 404);
    if (error instanceof Error && error.message.startsWith('run is not awaiting an undecided approval:')) return jsonResponse({ error: 'already-decided' }, 409);
    throw error;
  }
  (deps.decisions ?? defaultDecisionRing).record({ graphId, runId, nodeId, decision });
  debug.log('approvals.graph', 'decided', { graphId, runId, nodeId, decision, by: `pwa:${authReason}` });
  return jsonResponse({ graphId, runId, decision });
}

/** EV10d — `PUT …/:graphId/:runId/feed-draft` (사람 수정 저장) · `GET …/:graphId/:runId/media?path=` (초안 미디어). */
async function handleFeed(req: Request, url: URL, rawGraphId: string, rawRunId: string, kind: 'feed-draft' | 'media', deps: GraphApprovalsDeps): Promise<Response> {
  let graphId: string;
  let runId: string;
  try { graphId = decodeURIComponent(rawGraphId); runId = decodeURIComponent(rawRunId); }
  catch { return jsonResponse({ error: 'not-found' }, 404); }
  if (!validSegment(graphId) || !validSegment(runId)) return jsonResponse({ error: 'not-found' }, 404);
  const root = deps.root ?? effectiveInstanceRoot();
  const state = readRun(root, graphId, runId);
  const folder = state && isFeedPreviewMessage(state.pending?.message ?? '') ? feedFolderFor(state, deps.configDir ?? getElanousConfigDir()) : null;
  if (!state || !folder) {
    debug.log('approvals.feed', 'refused', { graphId, reason: 'not-feed' });
    return jsonResponse({ error: 'not-found' }, 404);
  }
  if (kind === 'media') {
    if (req.method !== 'GET') return jsonResponse({ error: 'method-not-allowed' }, 405);
    const file = resolveFeedMedia(folder, url.searchParams.get('path') ?? '');
    if (!file) {
      debug.log('approvals.feed', 'refused', { graphId, reason: 'media-path' });
      return jsonResponse({ error: 'not-found' }, 404);
    }
    debug.log('approvals.feed', 'media-served', { graphId });
    return new Response(Bun.file(file), { headers: { 'content-type': mediaContentType(file), 'cache-control': 'private, max-age=60' } });
  }
  if (req.method !== 'PUT') return jsonResponse({ error: 'method-not-allowed' }, 405);
  const authReason = deps.authReason?.(req);
  if (!authReason || !DECISION_AUTH_REASONS.has(authReason)) {
    debug.log('approvals.feed', 'refused', { graphId, reason: 'pairing-required' });
    return jsonResponse({ error: 'pairing-required' }, 403);
  }
  if (!undecided(state, root)) return jsonResponse({ error: 'already-decided' }, 409);
  const current = readFeedDraft(folder);
  if (!current) return jsonResponse({ error: 'not-found' }, 404);
  let body: unknown;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'bad_request' }, 400); }
  const result = applyFeedEdit(current, body);
  if (!result.ok) {
    debug.log('approvals.feed', 'refused', { graphId, reason: result.error });
    return jsonResponse({ error: result.error }, 400);
  }
  writeFeedDraft(folder, result.draft);
  debug.log('approvals.feed', 'draft-saved', { graphId, revision: result.draft.revision });
  const { folder: _folder, ...feed } = result.draft;
  return jsonResponse({ graphId, runId, feed });
}
