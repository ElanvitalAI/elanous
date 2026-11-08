import type { LLMToolSpec } from '../../llm/tool-spec.js';
/**
 * TaskKill runtime — cancel a task (+ optional downstream cascade).
 */

import type { ToolRuntime } from '../../tool-runtime/types.js';
import type { Task } from '../types.js';
import { isTerminalStatus } from '../types.js';
import { getToxRuntimeDeps } from '../runtime-deps.js';

export interface TaskKillInput {
  taskId: string;
  cascade?: boolean;
}

export interface TaskKillResult {
  output: string;
  cancelled?: string[];
  skipped?: Array<{ taskId: string; reason: string }>;
}

export async function dispatchTaskKill(input: TaskKillInput): Promise<TaskKillResult> {
  const deps = getToxRuntimeDeps();
  const graph = deps.getGraph();
  const dispatcher = deps.getDispatcher();
  if (!graph) return { output: 'TOX not initialized — graph unavailable' };
  if (!input.taskId) return { output: 'TaskKill: taskId is required' };
  const root = graph.getTask(input.taskId);
  if (!root) return { output: `TaskKill: '${input.taskId}' not found` };

  const targets: Task[] = input.cascade ? graph.subtree(input.taskId) : [root];
  const cancelled: string[] = [];
  const skipped: Array<{ taskId: string; reason: string }> = [];
  for (const t of targets) {
    if (isTerminalStatus(t.status)) {
      skipped.push({ taskId: t.id, reason: `already ${t.status}` });
      continue;
    }
    // Ask dispatcher to kill running work — idempotent when not running.
    dispatcher?.kill(t.id, input.cascade ? 'cascade' : 'user');
    try {
      graph.updateTask(t.id, { status: 'cancelled' });
      cancelled.push(t.id);
    } catch (err) {
      skipped.push({
        taskId: t.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const header = `TaskKill: ${cancelled.length} cancelled` +
    (skipped.length > 0 ? `, ${skipped.length} skipped` : '') +
    (input.cascade ? ' (cascade)' : '');
  const cLines = cancelled.map((id) => `  ✕ ${id}`);
  const sLines = skipped.map((s) => `  · ${s.taskId} (${s.reason})`);
  return {
    output: [header, ...cLines, ...sLines].join('\n'),
    cancelled,
    skipped,
  };
}

export function buildTaskKillTool(): LLMToolSpec {
  return {
    name: 'TaskKill',
    description:
      'Cancel a TOX task. When cascade=true, cancel all downstream dependents too (graph.subtree). ' +
      'Terminal tasks (done/cancelled/superseded) are skipped. Running tasks receive AbortSignal.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        cascade: { type: 'boolean' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  };
}

export const taskKillRuntime: ToolRuntime<TaskKillInput, TaskKillResult> = {
  id: 'task_kill',
  spec: buildTaskKillTool(),
  async run(req) {
    return dispatchTaskKill(req);
  },
};
