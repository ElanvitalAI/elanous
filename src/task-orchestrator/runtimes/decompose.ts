import type { LLMToolSpec } from '../../llm/tool-spec.js';
/**
 * TaskDecompose + TaskDecomposeApply runtimes — LLM-driven split +
 * user-approval apply.
 */

import type { ToolRuntime } from '../../tool-runtime/types.js';
import type { TaskSurfaceKind } from '../types.js';
import type {
  DecomposeInput,
  DecomposeResult,
} from '../generator.js';
import { createTask } from '../types.js';
import {
  getToxRuntimeDeps,
  storePendingDecompose,
  takePendingDecompose,
} from '../runtime-deps.js';

// ─────────────────────── TaskDecompose ───────────────────────────

export interface TaskDecomposeInput {
  objective: string;
  goalSlug?: string;
  maxTasks?: number;
  preferredSurfaces?: TaskSurfaceKind[];
  allowedSurfaces?: TaskSurfaceKind[];
  budgetUsdRemaining?: number;
}

export interface TaskDecomposeToolResult {
  output: string;
  applyToken?: string;
  proposedCount?: number;
  rationale?: string;
  requiresApproval?: boolean;
  approvalReasons?: string[];
  estimatedTotalUsd?: number;
  proposal?: DecomposeResult['proposal'];
}

export async function dispatchTaskDecompose(
  input: TaskDecomposeInput,
): Promise<TaskDecomposeToolResult> {
  const deps = getToxRuntimeDeps();
  const generator = deps.getGenerator();
  if (!generator) return { output: 'TOX not initialized — generator unavailable' };
  if (!input.objective || input.objective.trim().length === 0) {
    return { output: 'TaskDecompose: objective is required' };
  }
  const gInput: DecomposeInput = {
    objective: input.objective,
    context: input.goalSlug ? { goalSlug: input.goalSlug } : undefined,
    constraints: {
      maxTasks: input.maxTasks,
      preferredSurfaces: input.preferredSurfaces,
      allowedSurfaces: input.allowedSurfaces,
      budgetUsdRemaining: input.budgetUsdRemaining,
    },
  };
  let result: DecomposeResult;
  try {
    result = await generator.decompose(gInput);
  } catch (err) {
    return {
      output: `TaskDecompose failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  storePendingDecompose(result.applyToken, {
    result,
    goalSlug: input.goalSlug,
    objective: input.objective,
  });
  const header = result.requiresApproval
    ? `TaskDecompose: ${result.proposal.tasks.length} task(s) proposed — REQUIRES APPROVAL`
    : `TaskDecompose: ${result.proposal.tasks.length} task(s) proposed — apply with TaskDecomposeApply("${result.applyToken}")`;
  const reasonLines = result.approvalReasons.length > 0
    ? `\n  approval reasons:\n    - ${result.approvalReasons.join('\n    - ')}`
    : '';
  const bullets = result.proposal.tasks
    .map((t) => `  ${t.index}. [${t.surface.kind}] ${t.title}`)
    .join('\n');
  return {
    output: [header, `  rationale: ${result.proposal.rationale}`, reasonLines, bullets]
      .filter((l) => l.length > 0)
      .join('\n'),
    applyToken: result.applyToken,
    proposedCount: result.proposal.tasks.length,
    rationale: result.proposal.rationale,
    requiresApproval: result.requiresApproval,
    approvalReasons: result.approvalReasons,
    estimatedTotalUsd: result.estimatedTotalUsd,
    proposal: result.proposal,
  };
}

export function buildTaskDecomposeTool(): LLMToolSpec {
  return {
    name: 'TaskDecompose',
    description:
      'Ask the generator to break down an objective into 3-7 proposed tasks. Returns an ' +
      'applyToken; call TaskDecomposeApply to commit. When requiresApproval=true, ' +
      'present the proposal + reasons to the user before applying.',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string' },
        goalSlug: { type: 'string' },
        maxTasks: { type: 'number' },
        preferredSurfaces: { type: 'array', items: { type: 'string' } },
        allowedSurfaces: { type: 'array', items: { type: 'string' } },
        budgetUsdRemaining: { type: 'number' },
      },
      required: ['objective'],
      additionalProperties: false,
    },
  };
}

export const taskDecomposeRuntime: ToolRuntime<
  TaskDecomposeInput,
  TaskDecomposeToolResult
> = {
  id: 'task_decompose',
  spec: buildTaskDecomposeTool(),
  async run(req) {
    return dispatchTaskDecompose(req);
  },
};

// ─────────────────────── TaskDecomposeApply ───────────────────────

export interface TaskDecomposeApplyInput {
  applyToken: string;
  /** When true, apply even if `requiresApproval` was set (user approved). */
  force?: boolean;
}

export interface TaskDecomposeApplyResult {
  output: string;
  taskIds?: string[];
}

export async function dispatchTaskDecomposeApply(
  input: TaskDecomposeApplyInput,
): Promise<TaskDecomposeApplyResult> {
  const deps = getToxRuntimeDeps();
  const graph = deps.getGraph();
  if (!graph) return { output: 'TOX not initialized — graph unavailable' };
  if (!input.applyToken) return { output: 'TaskDecomposeApply: applyToken is required' };

  const entry = takePendingDecompose(input.applyToken);
  if (!entry) {
    return {
      output: `TaskDecomposeApply: token '${input.applyToken}' not found or expired (30 min TTL)`,
    };
  }
  const result = entry.result as DecomposeResult;
  if (result.requiresApproval && !input.force) {
    // Put back for re-use.
    storePendingDecompose(input.applyToken, entry);
    return {
      output: `TaskDecomposeApply: proposal requires approval — reasons: ${result.approvalReasons.join(
        '; ',
      )}. Pass {force:true} to apply anyway.`,
    };
  }
  const idxToId = new Map<number, string>();
  const taskIds: string[] = [];
  try {
    for (const p of result.proposal.tasks) {
      const deps2 = (p.dependsOn ?? [])
        .map((i) => idxToId.get(i))
        .filter((v): v is string => !!v);
      const task = createTask({
        title: p.title,
        description: p.description,
        surface: p.surface,
        goalSlug: entry.goalSlug,
        dependsOn: deps2,
        priority: p.priority,
        isolation: p.isolation,
        estimateMs: p.estimateMs,
        estimateTokens: p.estimateTokens,
        estimateUsd: p.estimateUsd,
        timeoutMs: p.timeoutMs,
        acceptance: p.acceptance,
        generatedBy: { kind: 'llm' },
      });
      graph.addTask(task);
      idxToId.set(p.index, task.id);
      taskIds.push(task.id);
    }
    graph.promoteReady();
  } catch (err) {
    return {
      output: `TaskDecomposeApply failed partway: ${err instanceof Error ? err.message : String(err)} (${taskIds.length}/${result.proposal.tasks.length} added)`,
      taskIds,
    };
  }
  return {
    output: `TaskDecomposeApply: ${taskIds.length} task(s) added — ${taskIds.join(', ')}`,
    taskIds,
  };
}

export function buildTaskDecomposeApplyTool(): LLMToolSpec {
  return {
    name: 'TaskDecomposeApply',
    description:
      'Commit a previously-proposed TaskDecompose result (applyToken) to the graph. ' +
      'If the proposal was flagged requiresApproval, pass force:true after user agreement.',
    parameters: {
      type: 'object',
      properties: {
        applyToken: { type: 'string' },
        force: { type: 'boolean' },
      },
      required: ['applyToken'],
      additionalProperties: false,
    },
  };
}

export const taskDecomposeApplyRuntime: ToolRuntime<
  TaskDecomposeApplyInput,
  TaskDecomposeApplyResult
> = {
  id: 'task_decompose_apply',
  spec: buildTaskDecomposeApplyTool(),
  async run(req) {
    return dispatchTaskDecomposeApply(req);
  },
};
