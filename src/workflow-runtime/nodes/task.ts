// `task` node — create a TOX task from a workflow run (RFC external tasks §A8 · X5b).
// A signed webhook → task node carries the provider's item into TOX with its origin;
// approval (pending unless `tox.external.autoRun` matches) is decided by TOX, not here.

import { debug } from '../../debug/log.js';
import type { NodeExecContext, NodeOutput, TaskNode, WorkflowDeps, WorkflowTaskRequest, WorkflowTaskResult } from '../types.js';
import { interpolate } from '../variables.js';

async function createInProcess(req: WorkflowTaskRequest): Promise<WorkflowTaskResult> {
  const { dispatchTaskCreate } = await import('../../task-orchestrator/runtimes/create.js');
  const { isExternalProvider } = await import('../../task-orchestrator/external-policy.js');
  if (!isExternalProvider(req.external.provider)) return { error: `external.provider is invalid: ${req.external.provider}` };
  const result = await dispatchTaskCreate({
    title: req.title,
    ...(req.description ? { description: req.description } : {}),
    ...(req.priority ? { priority: req.priority } : {}),
    // Same default as POST /v1/tasks — the prompt only repeats title/description.
    surface: { kind: 'llm-direct', prompt: `${req.title}${req.description ? `\n${req.description}` : ''}` },
    externalSurfaceDefaulted: true,
    external: { ...req.external, provider: req.external.provider },
    ...(req.eventId ? { eventId: req.eventId } : {}),
  });
  return result.taskId
    ? { taskId: result.taskId, deduplicated: result.deduplicated ?? false }
    : { error: result.output };
}

export async function executeTaskNode(node: TaskNode, ctx: NodeExecContext, deps: WorkflowDeps): Promise<NodeOutput> {
  const startedAt = Date.now();
  const fill = (expr: string | undefined): string | undefined => {
    if (expr === undefined) return undefined;
    const text = interpolate(expr, { arguments: ctx.arguments, artifactsDir: ctx.artifactsDir, outputs: ctx.outputs }).text.trim();
    return text === '' ? undefined : text;
  };
  const fail = (error: string): NodeOutput => ({ ok: false, output: '', error, durationMs: Date.now() - startedAt });
  try {
    const spec = node.task;
    const title = fill(spec.title);
    const provider = fill(spec.external.provider);
    const ref = fill(spec.external.ref);
    if (!title) return fail('task.title resolved to an empty string');
    if (!provider || !ref) return fail('task.external.provider and task.external.ref must resolve to non-empty strings');
    const priority = fill(spec.priority);
    if (priority !== undefined && priority !== 'low' && priority !== 'medium' && priority !== 'high') {
      return fail(`task.priority must resolve to low | medium | high (got '${priority}')`);
    }
    const external: WorkflowTaskRequest['external'] = { provider, ref };
    for (const key of ['url', 'project', 'team', 'assignee'] as const) {
      const value = fill(spec.external[key]);
      if (value !== undefined) external[key] = value;
    }
    const description = fill(spec.description);
    const eventId = fill(spec.eventId);
    const req: WorkflowTaskRequest = {
      title,
      external,
      ...(description ? { description } : {}),
      ...(priority ? { priority } : {}),
      ...(eventId ? { eventId } : {}),
    };
    const result = await (deps.createTask ?? createInProcess)(req);
    debug.log('workflow.task-node', result.taskId ? 'created' : 'refused', {
      nodeId: node.id, provider, ref, taskId: result.taskId, deduplicated: result.deduplicated ?? false, ...(result.error ? { error: result.error } : {}),
    });
    if (!result.taskId) return fail(result.error ?? 'task was not created');
    return {
      ok: true,
      output: { taskId: result.taskId, deduplicated: result.deduplicated ?? false },
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
