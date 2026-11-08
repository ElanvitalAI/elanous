import type { LLMToolSpec } from '../../llm/tool-spec.js';
/**
 * TaskDispatch runtime — run a single dispatch tick.
 */

import type { ToolRuntime } from '../../tool-runtime/types.js';
import { getToxRuntimeDeps } from '../runtime-deps.js';

export interface TaskDispatchInput {
  /** When true, also call graph.promoteReady() first. Default true. */
  promote?: boolean;
}

export interface TaskDispatchResult {
  output: string;
  dispatched?: Array<{ taskId: string; executionId: string; surfaceAddress?: string }>;
  deferred?: Array<{ taskId: string; reason: string }>;
}

export async function dispatchTaskDispatch(
  input: TaskDispatchInput = {},
): Promise<TaskDispatchResult> {
  const deps = getToxRuntimeDeps();
  const graph = deps.getGraph();
  const dispatcher = deps.getDispatcher();
  if (!graph || !dispatcher) {
    return { output: 'TOX not initialized — graph or dispatcher unavailable' };
  }
  if (input.promote !== false) graph.promoteReady();
  const res = dispatcher.tick();
  const dispatched = res.dispatched.map((d) => ({
    taskId: d.taskId,
    executionId: d.executionId,
    surfaceAddress: d.surfaceAddress,
  }));
  const deferred = res.deferred.map((d) => ({
    taskId: d.taskId,
    reason: d.reason,
  }));
  const header = `TaskDispatch: ${dispatched.length} started, ${deferred.length} deferred`;
  const dLines = dispatched.map(
    (d) => `  ▶ ${d.taskId} → exec ${d.executionId}${d.surfaceAddress ? ' @ ' + d.surfaceAddress : ''}`,
  );
  const xLines = deferred.map((d) => `  ⏸ ${d.taskId} (${d.reason})`);
  return {
    output: [header, ...dLines, ...xLines].join('\n'),
    dispatched,
    deferred,
  };
}

export function buildTaskDispatchTool(): LLMToolSpec {
  return {
    name: 'TaskDispatch',
    description:
      'Trigger a single dispatch tick — promote ready tasks + hand each to its surface ' +
      'adapter (up to per-surface concurrency cap). Use when you added tasks manually and ' +
      'want them to start without waiting for the feedback loop.',
    parameters: {
      type: 'object',
      properties: {
        promote: { type: 'boolean', description: 'Run promoteReady() first. Default true.' },
      },
      additionalProperties: false,
    },
  };
}

export const taskDispatchRuntime: ToolRuntime<TaskDispatchInput, TaskDispatchResult> = {
  id: 'task_dispatch',
  spec: buildTaskDispatchTool(),
  async run(req) {
    return dispatchTaskDispatch(req);
  },
};
