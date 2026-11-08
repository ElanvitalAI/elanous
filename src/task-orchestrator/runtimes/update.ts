import type { LLMToolSpec } from '../../llm/tool-spec.js';
/**
 * TaskUpdate runtime — partial patch with status / priority / notes.
 */

import type { ToolRuntime } from '../../tool-runtime/types.js';
import type { Task, TaskStatus, TaskPriority } from '../types.js';
import { isTaskStatus } from '../types.js';
import { getToxRuntimeDeps } from '../runtime-deps.js';
import { foldVerificationNudge } from '../verification-nudge.js';

export interface TaskUpdateInput {
  taskId: string;
  patch?: {
    status?: string;
    priority?: TaskPriority;
    notes?: string[];
    /** One-line note to append to the existing notes array. */
    appendNote?: string;
  };
}

export interface TaskUpdateResult {
  output: string;
  task?: Task;
  /** ROADMAP-agent-surface-deferred-tools-2026-05-13 Wave 4 W4.3 —
   *  populated when this update crossed the verification-nudge
   *  threshold (3 consecutive completions w/o a review). Caller
   *  surfaces the message to the LLM as a system-reminder. */
  verificationNudge?: string;
}

export async function dispatchTaskUpdate(
  input: TaskUpdateInput,
): Promise<TaskUpdateResult> {
  const graph = getToxRuntimeDeps().getGraph();
  if (!graph) return { output: 'TOX not initialized — graph unavailable' };
  if (!input.taskId) return { output: 'TaskUpdate: taskId is required' };
  const current = graph.getTask(input.taskId);
  if (!current) return { output: `TaskUpdate: '${input.taskId}' not found` };

  const patch = input.patch ?? {};
  const changes: Partial<Task> = {};
  if (patch.status !== undefined) {
    if (!isTaskStatus(patch.status)) {
      return { output: `TaskUpdate: invalid status '${patch.status}'` };
    }
    changes.status = patch.status as TaskStatus;
  }
  if (patch.priority !== undefined) changes.priority = patch.priority;
  if (patch.notes !== undefined) changes.notes = [...patch.notes];
  if (patch.appendNote !== undefined) {
    changes.notes = [...current.notes, patch.appendNote];
  }

  try {
    const next = graph.updateTask(input.taskId, changes);
    // Wave 4 W4.3 — fold status transition into the verification-nudge
    // counter. The nudge string (when threshold crossed) rides on the
    // result so the chat layer can prepend it as a system-reminder.
    const nudge = foldVerificationNudge({
      nextStatus: next.status,
      ...(patch.appendNote ? { note: patch.appendNote } : {}),
    });
    return {
      output: nudge.shouldNudge
        ? `TaskUpdate: ${next.id} → status=${next.status}, priority=${next.priority}\n${nudge.nudgeMessage}`
        : `TaskUpdate: ${next.id} → status=${next.status}, priority=${next.priority}`,
      task: next,
      ...(nudge.shouldNudge ? { verificationNudge: nudge.nudgeMessage } : {}),
    };
  } catch (err) {
    return {
      output: `TaskUpdate failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function buildTaskUpdateTool(): LLMToolSpec {
  return {
    name: 'TaskUpdate',
    description:
      'Update a TOX task in place. Status transitions are validated; invalid transitions ' +
      'surface as error output (no throw). Use appendNote to add a single learning line.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
            notes: { type: 'array', items: { type: 'string' } },
            appendNote: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  };
}

export const taskUpdateRuntime: ToolRuntime<TaskUpdateInput, TaskUpdateResult> = {
  id: 'task_update',
  spec: buildTaskUpdateTool(),
  async run(req) {
    return dispatchTaskUpdate(req);
  },
};
