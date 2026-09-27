/**
 * TaskCreate runtime — adds a single task to the graph.
 */
import type { LLMToolSpec } from '../../llm.js';
import type { ToolRuntime } from '../../tool-runtime/types.js';
import {
  createTask,
  isTaskSurface,
  type Task,
  type TaskSurface,
  type TaskPriority,
  type TaskIsolation,
  TASK_DEFAULTS,
} from '../types.js';
import { getToxRuntimeDeps } from '../runtime-deps.js';
import type { TaskGraph } from '../graph.js';
import { debug } from '../../debug/log.js';
import { taskToWorkflowEntry } from '../task-to-workflow.js';
import { TaskStore } from '../store.js';
import { decideExternalApproval, externalTaskPrompt, isExternalProvider, type ExternalTaskContext } from '../external-policy.js';
import type { WorkflowRuntimeDaemon } from '../../workflow-runtime/daemon.js';

export interface TaskCreateInput {
  title: string;
  description?: string;
  surface: unknown;
  goalSlug?: string;
  dependsOn?: string[];
  priority?: TaskPriority;
  isolation?: TaskIsolation;
  estimateMs?: number;
  estimateTokens?: number;
  estimateUsd?: number;
  scheduleText?: string;
  external?: ExternalTaskContext;
  /** The HTTP default prompt repeats title/description; it is not caller-provided content. */
  externalSurfaceDefaulted?: boolean;
  eventId?: string;
  traceId?: string;
}

export interface TaskCreateResult {
  output: string;
  taskId?: string;
  task?: Task;
  deduplicated?: boolean;
}

export async function dispatchTaskCreate(
  input: TaskCreateInput,
): Promise<TaskCreateResult> {
  const graph = getToxRuntimeDeps().getGraph();
  if (!graph) return { output: 'TOX not initialized — graph unavailable' };
  if (!input.title || input.title.trim().length === 0) {
    return { output: 'TaskCreate: title is required' };
  }
  if (!isTaskSurface(input.surface)) {
    return { output: 'TaskCreate: surface must be a valid TaskSurface tagged union' };
  }
  if (input.external) {
    if (!isExternalProvider(input.external.provider)) return { output: 'TaskCreate: external.provider is invalid' };
    if (!input.external.ref?.trim()) return { output: 'TaskCreate: external.ref is required' };
    if (input.surface.kind !== 'llm-direct') {
      return { output: 'TaskCreate: external tasks require llm-direct surface' };
    }
    if (input.surface.model !== undefined || input.surface.systemPrompt !== undefined) {
      return { output: 'TaskCreate: external tasks cannot set model or systemPrompt' };
    }
    return createExternalTask(input, graph);
  }

  const task = createTask({
    title: input.title,
    description: input.description,
    surface: input.surface as TaskSurface,
    goalSlug: input.goalSlug,
    dependsOn: input.dependsOn,
    priority: input.priority,
    isolation: input.isolation,
    estimateMs: input.estimateMs,
    estimateTokens: input.estimateTokens,
    estimateUsd: input.estimateUsd,
    scheduleText: input.scheduleText?.trim() || undefined,
    status: input.scheduleText?.trim() ? 'scheduled' : undefined,
    generatedBy: { kind: 'user' },
  });
  let scheduleDeferred: string | null = null;
  try {
    graph.addTask(task);
    if (task.scheduleText) {
      // V2.2-7 (2026-05-11) — TOX→workflow-runtime direct wire. The
      // legacy `scheduler-bridge.ts` + `src/scheduler/jobs.ts` path was
      // retired; the daemon's schedule source now owns recurring TOX
      // tasks. When the daemon is not wired yet (standalone TOX · CLI
      // before NEXUS boots) we still create the task and persist the
      // scheduleText so a follow-up registration can pick it up — the
      // user just sees a "(deferred)" hint in the output. The same
      // graceful path covers helper-rejected shapes (V2.2-7 v1 throws
      // on one-shot durations and ISO timestamps).
      // Deterministic workflow name even when registration is deferred,
      // so the task's `schedulerJobId` is set up-front and a future
      // backfill (NEXUS boot · V2.2-7 v2 one-shot support) can find +
      // register the entry without renaming.
      const pendingWorkflowName = `tox-task-${task.id}`;
      graph.updateTask(task.id, { schedulerJobId: pendingWorkflowName });

      const daemon = getToxRuntimeDeps().getWorkflowDaemon?.() as WorkflowRuntimeDaemon | null;
      if (daemon) {
        try {
          const entry = taskToWorkflowEntry(task, task.scheduleText);
          daemon.registerWorkflow(entry);
        } catch (err) {
          // V2.2-7 v1 scope rejection (one-shot · ISO timestamp) — task
          // stays scheduled with scheduleText preserved so a future
          // V2.2-7 v2 backfill can register it without losing intent.
          scheduleDeferred = err instanceof Error ? err.message : String(err);
        }
      } else {
        scheduleDeferred = 'workflow-runtime daemon not yet wired';
      }
    }
  } catch (err) {
    return {
      output: `TaskCreate failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!task.scheduleText) graph.promoteReady();
  const scheduleSuffix = task.scheduleText
    ? ` · scheduled via ${task.scheduleText}${scheduleDeferred ? ' (deferred — ' + scheduleDeferred + ')' : ''}`
    : '';
  return {
    output: `TaskCreate: ${task.id} "${task.title}" [${task.surface.kind}] added${scheduleSuffix}`,
    taskId: task.id,
    task: graph.getTask(task.id),
  };
}

const externalCreateLocks = new Map<string, Promise<void>>();

async function createExternalTask(input: TaskCreateInput, graph: TaskGraph): Promise<TaskCreateResult> {
  const external = input.external!;
  const key = JSON.stringify([external.provider, external.ref]);
  const previous = externalCreateLocks.get(key);
  let release!: () => void;
  const finished = new Promise<void>((resolve) => { release = resolve; });
  externalCreateLocks.set(key, finished);
  if (previous) await previous;
  try {
    return createExternalTaskLocked(input, graph);
  } finally {
    if (externalCreateLocks.get(key) === finished) externalCreateLocks.delete(key);
    release();
  }
}

function createExternalTaskLocked(input: TaskCreateInput, graph: TaskGraph): TaskCreateResult {
  const external = input.external!;
  if (input.title.length > TASK_DEFAULTS.titleMaxLen || (input.description?.length ?? 0) > TASK_DEFAULTS.descriptionMaxLen || input.priority === 'urgent') {
    return { output: 'TaskCreate: invalid external task title, description or unchecked urgent priority' };
  }
  const store = getToxRuntimeDeps().getStore?.() as TaskStore | null | undefined;
  let ownedStore: TaskStore | null = null;
  try {
    ownedStore = store ? null : new TaskStore();
    const db = (store ?? ownedStore)!;
    const surface: TaskSurface = {
      kind: 'llm-direct',
      prompt: externalTaskPrompt(external, input.title, input.description ?? '',
        input.externalSurfaceDefaulted ? undefined : (input.surface as Extract<TaskSurface, { kind: 'llm-direct' }>).prompt),
    };
    // Keep lookup and persistence in one transaction; restore the graph if
    // commit fails, without deleting another request's external identity.
    let graphBefore: Task | undefined;
    let changedId: string | undefined;
    let changedTask: Task | undefined;
    let result: TaskCreateResult;
    try {
      result = db.transaction((): TaskCreateResult => {
        const existing = db.findTaskByExternalRef(external.provider, external.ref)
          ?? graph.listAll().find((task) => task.generatedBy?.kind === 'external'
            && task.generatedBy.provider === external.provider && task.generatedBy.ref === external.ref);
        if (existing) {
          const graphPrevious = graph.getTask(existing.id);
          const current = graphPrevious ?? existing;
          const content = { title: input.title, description: input.description ?? '', priority: input.priority ?? current.priority, surface };
          const contentChanged = content.title !== current.title || content.description !== (current.description ?? '')
            || content.priority !== current.priority || JSON.stringify(content.surface) !== JSON.stringify(current.surface);
          // Approval covers the content and the rule match at that moment. For work that has not
          // started, re-decide: an autoRun match now → ready · a person's approval of unchanged
          // content stands · anything else waits for a person again (🅢 M1).
          let approvalPatch: Partial<Task> = {};
          if (current.status === 'backlog' || current.status === 'ready') {
            const redecided = decideExternalApproval(external);
            const approval = redecided.state === 'auto' ? redecided
              : current.approval?.state === 'approved' && !contentChanged ? current.approval
              : { state: 'pending' as const };
            approvalPatch = { approval, status: approval.state === 'pending' ? 'backlog' : 'ready' };
          }
          // The source link travels with the item: a moved/renamed issue keeps its ref but not its URL.
          const generatedBy = current.generatedBy?.kind === 'external' && external.url !== undefined && external.url !== current.generatedBy.url
            ? { ...current.generatedBy, url: external.url } : undefined;
          const patch: Partial<Task> = { ...content, ...approvalPatch, ...(generatedBy ? { generatedBy } : {}) };
          const updated = { ...current, ...patch, updatedAt: Date.now() };
          db.saveTask(updated);
          graphBefore = graphPrevious;
          changedId = existing.id;
          if (graphPrevious) changedTask = graph.updateTask(existing.id, patch);
          else { graph.addTask(updated); changedTask = updated; }
          return { output: `TaskCreate: ${updated.id} deduplicated`, taskId: updated.id, task: updated, deduplicated: true };
        }
        const approval = decideExternalApproval(external);
        const task = createTask({
          title: input.title,
          description: input.description,
          surface,
          priority: input.priority,
          generatedBy: { kind: 'external', provider: external.provider, ref: external.ref, url: external.url },
          approval,
          status: approval.state === 'auto' ? 'ready' : 'backlog',
        });
        db.saveTask(task);
        changedId = task.id;
        graph.addTask(task);
        changedTask = task;
        return { output: `TaskCreate: ${task.id} created`, taskId: task.id, task, deduplicated: false };
      });
    } catch (err) {
      if (changedId && graph.getTask(changedId) !== graphBefore
        && (!changedTask || graph.getTask(changedId) === changedTask)) graph.restoreTask(changedId, graphBefore);
      throw err;
    }
    debug.log('tox.external', result.deduplicated ? 'deduplicated' : 'created', {
      provider: external.provider, ref: external.ref, taskId: result.taskId, approval: result.task?.approval,
      eventId: input.eventId, traceId: input.traceId,
    });
    return result;
  } catch (err) {
    return { output: `TaskCreate failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    ownedStore?.close();
  }
}

export function buildTaskCreateTool(): LLMToolSpec {
  return {
    name: 'TaskCreate',
    description:
      'Create a single TOX task and add it to the orchestrator graph. Use when you need ' +
      'to queue work directly (without LLM decomposition). For complex objectives use ' +
      'TaskDecompose + TaskDecomposeApply.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Imperative title, ≤80 chars.' },
        description: { type: 'string' },
        surface: {
          type: 'object',
          description:
            'TaskSurface tagged union (kind + kind-specific fields). See TaskSurfaceKind.',
        },
        goalSlug: { type: 'string' },
        dependsOn: { type: 'array', items: { type: 'string' } },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        isolation: { type: 'string', enum: ['shared', 'worktree'] },
        estimateMs: { type: 'number' },
        estimateTokens: { type: 'number' },
        estimateUsd: { type: 'number' },
        scheduleText: { type: 'string' },
      },
      required: ['title', 'surface'],
      additionalProperties: false,
    },
  };
}

export const taskCreateRuntime: ToolRuntime<TaskCreateInput, TaskCreateResult> = {
  id: 'task_create',
  spec: buildTaskCreateTool(),
  async run(req) {
    return dispatchTaskCreate(req);
  },
};
