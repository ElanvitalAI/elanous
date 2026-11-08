import type { LLMToolSpec } from '../../llm/tool-spec.js';
/**
 * TaskGet runtime — detailed single-task fetch.
 */

import type { ToolRuntime } from '../../tool-runtime/types.js';
import type { Task } from '../types.js';
import { getToxRuntimeDeps } from '../runtime-deps.js';

export interface TaskGetInput {
  taskId: string;
}

export interface TaskGetResult {
  output: string;
  task?: Task;
}

function formatTask(t: Task): string {
  const deps = t.dependsOn.length > 0 ? `\n  depsOn: ${t.dependsOn.join(', ')}` : '';
  const ntoes = t.notes.length > 0 ? `\n  notes: ${t.notes.slice(-3).join(' | ')}` : '';
  return [
    `Task ${t.id} "${t.title}"`,
    `  status: ${t.status}  version: ${t.version}  attempt: ${t.attempt}`,
    `  surface: ${t.surface.kind}  priority: ${t.priority}  isolation: ${t.isolation}`,
    t.goalSlug ? `  goal: ${t.goalSlug}` : '',
    t.description ? `  description: ${t.description.slice(0, 200)}` : '',
    deps,
    ntoes,
  ]
    .filter((l) => l.length > 0)
    .join('\n');
}

export async function dispatchTaskGet(input: TaskGetInput): Promise<TaskGetResult> {
  const graph = getToxRuntimeDeps().getGraph();
  if (!graph) return { output: 'TOX not initialized — graph unavailable' };
  if (!input.taskId) return { output: 'TaskGet: taskId is required' };
  const t = graph.getTask(input.taskId);
  if (!t) return { output: `TaskGet: '${input.taskId}' not found` };
  return { output: formatTask(t), task: t };
}

export function buildTaskGetTool(): LLMToolSpec {
  return {
    name: 'TaskGet',
    description:
      'Fetch a TOX task by id with full detail (status, surface, deps, recent notes).',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  };
}

export const taskGetRuntime: ToolRuntime<TaskGetInput, TaskGetResult> = {
  id: 'task_get',
  spec: buildTaskGetTool(),
  async run(req) {
    return dispatchTaskGet(req);
  },
};
