import { randomUUID } from 'node:crypto';
import { debug } from '../../debug/log.js';
import { dispatchTaskCreate } from '../../task-orchestrator/runtimes/create.js';
import { getToxRuntimeDeps } from '../../task-orchestrator/runtime-deps.js';
import { TaskStore } from '../../task-orchestrator/store.js';
import { isExternalProvider } from '../../task-orchestrator/external-policy.js';
import { externalTaskFingerprint } from '../../task-orchestrator/external-fingerprint.js';
import { isTaskSurface, TASK_DEFAULTS, type TaskPriority } from '../../task-orchestrator/types.js';
import { jsonResponse } from './http-server.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { matchIngestAuthorization } from './ingest-token.js';

function trace(req: Request): string {
  return req.headers.get('x-elanous-trace-id')?.trim() || randomUUID();
}

function badRequest(reason: string, traceId: string): Response {
  debug.log('tox.external', 'rejected', { traceId, reason });
  return jsonResponse({ error: 'bad_request', reason }, 400);
}

export async function handleTaskCreatePost(req: Request, opts: MetaApiOpts): Promise<Response> {
  if (!checkAuth(req, opts)
    && !(req.method === 'POST' && new URL(req.url).pathname === '/v1/tasks' && matchIngestAuthorization(req) !== null)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const traceId = trace(req);
  let raw: unknown;
  try { raw = await req.json(); }
  catch { return badRequest('invalid JSON body', traceId); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return badRequest('body must be an object', traceId);
  const body = raw as Record<string, unknown>;
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > TASK_DEFAULTS.titleMaxLen) {
    return badRequest(`title must be a non-empty string of at most ${TASK_DEFAULTS.titleMaxLen} chars`, traceId);
  }
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > TASK_DEFAULTS.descriptionMaxLen)) {
    return badRequest(`description must be a string of at most ${TASK_DEFAULTS.descriptionMaxLen} chars`, traceId);
  }
  if (body.priority !== undefined && !['low', 'medium', 'high', 'urgent'].includes(body.priority as string)) {
    return badRequest('priority must be low | medium | high | urgent', traceId);
  }
  if (body.priority === 'urgent') return badRequest('urgent requires acceptance checks or criteria', traceId);
  if (body.eventId !== undefined && typeof body.eventId !== 'string') return badRequest('eventId must be a string', traceId);
  // This entrance is the external one (RFC A2 · 🅢 M1·S2): everything that comes in here
  // is someone else's input and waits for approval. Owner-made tasks use TaskCreate in-process.
  if (body.external === undefined) return badRequest('external is required on this entrance', traceId);
  let external: Parameters<typeof dispatchTaskCreate>[0]['external'];
  if (body.external !== undefined) {
    if (!body.external || typeof body.external !== 'object' || Array.isArray(body.external)) return badRequest('external must be an object', traceId);
    const value = body.external as Record<string, unknown>;
    if (!isExternalProvider(value.provider)) return badRequest('external.provider is invalid', traceId);
    if (typeof value.ref !== 'string' || !value.ref.trim()) return badRequest('external.ref is required', traceId);
    for (const field of ['url', 'project', 'team', 'assignee']) {
      if (value[field] !== undefined && typeof value[field] !== 'string') return badRequest(`external.${field} must be a string`, traceId);
    }
    external = {
      provider: value.provider,
      ref: value.ref,
      ...(typeof value.url === 'string' ? { url: value.url } : {}),
      ...(typeof value.project === 'string' ? { project: value.project } : {}),
      ...(typeof value.team === 'string' ? { team: value.team } : {}),
      ...(typeof value.assignee === 'string' ? { assignee: value.assignee } : {}),
    };
  }
  if (body.surface !== undefined && !isTaskSurface(body.surface)) return badRequest('surface must be a valid TaskSurface', traceId);
  if (external && body.surface !== undefined) {
    const requestedSurface = body.surface as Record<string, unknown>;
    if (requestedSurface.kind !== 'llm-direct') return badRequest('external tasks require llm-direct surface', traceId);
    if (requestedSurface.model !== undefined || requestedSurface.systemPrompt !== undefined) {
      return badRequest('external tasks cannot set model or systemPrompt', traceId);
    }
  }
  const surface = body.surface ?? { kind: 'llm-direct', prompt: `${body.title}${body.description ? `\n${body.description}` : ''}` };
  try {
    const result = await dispatchTaskCreate({
      title: body.title,
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      priority: body.priority as TaskPriority | undefined,
      surface,
      external,
      externalSurfaceDefaulted: body.surface === undefined,
      traceId,
      ...(typeof body.eventId === 'string' ? { eventId: body.eventId } : {}),
    });
    if (!result.taskId) {
      if (result.output.startsWith('TaskCreate:')) return badRequest(result.output, traceId);
      return jsonResponse({ error: 'task_create_failed', reason: result.output }, 503);
    }
    return jsonResponse({ taskId: result.taskId, deduplicated: result.deduplicated ?? false }, result.deduplicated ? 200 : 201);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err), traceId);
  }
}

export function handleTaskApprovePost(req: Request, taskId: string, opts: MetaApiOpts): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const traceId = trace(req);
  const graph = getToxRuntimeDeps().getGraph();
  if (!graph) return jsonResponse({ error: 'tox-not-initialized' }, 503);
  const store = getToxRuntimeDeps().getStore?.() as TaskStore | null | undefined;
  let ownedStore: TaskStore | null = null;
  try {
    ownedStore = store ? null : new TaskStore();
    const db = (store ?? ownedStore)!;
    const task = graph.getTask(taskId) ?? db.getTask(taskId);
    if (!task) return jsonResponse({ error: 'not_found' }, 404);
    if (task.generatedBy?.kind !== 'external' || task.status !== 'backlog' || task.approval?.state !== 'pending') {
      debug.log('tox.external', 'rejected', { traceId, taskId, reason: 'not_pending_approval', provider: task.generatedBy?.kind === 'external' ? task.generatedBy.provider : undefined, ref: task.generatedBy?.kind === 'external' ? task.generatedBy.ref : undefined, approval: task.approval });
      return jsonResponse({ error: 'conflict', reason: 'task is not pending external approval' }, 409);
    }
    const now = Date.now();
    const updated = { ...task, status: 'ready' as const,
      approval: { state: 'approved' as const, approvedBy: 'manual' as const, approvedAt: now,
        fingerprint: externalTaskFingerprint(task) }, updatedAt: now };
    const graphPrevious = graph.getTask(taskId);
    let changedTask: typeof task | undefined;
    try {
      db.transaction(() => {
        db.saveTask(updated);
        if (graphPrevious) changedTask = graph.updateTask(taskId, { status: updated.status, approval: updated.approval });
        else { graph.addTask(updated); changedTask = updated; }
      });
    } catch (err) {
      if (graph.getTask(taskId) !== graphPrevious
        && (!changedTask || graph.getTask(taskId) === changedTask)) graph.restoreTask(taskId, graphPrevious);
      throw err;
    }
    debug.log('tox.external', 'approved', { traceId, provider: task.generatedBy.provider, ref: task.generatedBy.ref, taskId, approval: updated.approval });
    return jsonResponse({ taskId, status: updated.status, approval: updated.approval }, 200);
  } catch (err) {
    debug.log('tox.external', 'rejected', { traceId, taskId, reason: err instanceof Error ? err.message : String(err) });
    return jsonResponse({ error: 'approval_failed' }, 503);
  } finally {
    ownedStore?.close();
  }
}
