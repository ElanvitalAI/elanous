import type { LLMToolSpec } from '../../llm/tool-spec.js';
/**
 * TaskList runtime — filtered graph enumeration.
 */

import type { ToolRuntime } from '../../tool-runtime/types.js';
import type { Task, TaskStatus, TaskSurfaceKind } from '../types.js';
import { isTaskStatus, isTaskSurfaceKind } from '../types.js';
import { getToxRuntimeDeps } from '../runtime-deps.js';

export interface TaskListInput {
  status?: string;
  goalSlug?: string;
  surface?: string;
  limit?: number;
}

export interface TaskListResult {
  output: string;
  tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    surface: TaskSurfaceKind;
    priority: string;
    goalSlug?: string;
  }>;
  total: number;
}

function summary(t: Task): TaskListResult['tasks'][number] {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    surface: t.surface.kind,
    priority: t.priority,
    goalSlug: t.goalSlug,
  };
}

export async function dispatchTaskList(input: TaskListInput): Promise<TaskListResult> {
  const graph = getToxRuntimeDeps().getGraph();
  if (!graph) {
    return { output: 'TOX not initialized — graph unavailable', tasks: [], total: 0 };
  }

  const statusFilter = input.status && isTaskStatus(input.status) ? input.status : undefined;
  const surfaceFilter =
    input.surface && isTaskSurfaceKind(input.surface) ? input.surface : undefined;
  const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : 50;

  let src: Task[] = input.goalSlug ? graph.listByGoal(input.goalSlug) : graph.listAll();
  if (statusFilter) src = src.filter((t) => t.status === statusFilter);
  if (surfaceFilter) src = src.filter((t) => t.surface.kind === surfaceFilter);

  const total = src.length;
  const tasks = src.slice(0, limit).map(summary);
  const header = `TaskList: ${total} match${total === 1 ? '' : 'es'}` +
    (total > limit ? ` (showing ${limit})` : '');
  const lines = tasks.map(
    (t) => `  - ${t.id} [${t.status}/${t.surface}/${t.priority}] ${t.title}`,
  );
  return {
    output: [header, ...lines].join('\n'),
    tasks,
    total,
  };
}

export function buildTaskListTool(): LLMToolSpec {
  return {
    name: 'TaskList',
    description:
      'List TOX tasks with optional filters. Returns id/title/status/surface/priority ' +
      'summaries for discovery + follow-up TaskGet calls.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status (backlog / blocked / ready / running / review / done / ...).',
        },
        goalSlug: { type: 'string' },
        surface: {
          type: 'string',
          description:
            'Filter by TaskSurfaceKind (terminal-pane / vw-slot / subagent / skill / chat-prompt / cron / llm-direct).',
        },
        limit: { type: 'number', description: 'Default 50.' },
      },
      additionalProperties: false,
    },
  };
}

export const taskListRuntime: ToolRuntime<TaskListInput, TaskListResult> = {
  id: 'task_list',
  spec: buildTaskListTool(),
  async run(req) {
    return dispatchTaskList(req);
  },
};
