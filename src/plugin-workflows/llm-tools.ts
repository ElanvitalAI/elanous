import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── PX-4 P5: WorkflowRun / WorkflowList / WorkflowStatus LLM tools ──
//
// Three tools cover the 3 verbs the LLM needs on a workflow:
//   WorkflowRun    — fire off an execution (writes state + handoff
//                    files under .elanous/workflows/...)
//   WorkflowList   — enumerate registered workflows (id + steps
//                    summary). Read-only.
//   WorkflowStatus — inspect a specific run by runId. Read-only.
//
// Registration side lives in a simple in-memory map so the LLM tools
// can list workflows without owning the plugin-host's pluginEntry
// graph. plugin-host (below) populates this at activate.


import { globalWorkflowRunner } from './global-runner.js';
import type {
  SkillWorkflow,
  WorkflowRunState,
} from './types.js';

// ── Workflow definition registry ───────────────────────────────────────

interface RegisteredWorkflow {
  pluginId: string;
  def: SkillWorkflow;
}

const workflowDefinitions = new Map<string, RegisteredWorkflow>();

export function registerWorkflowDefinition(pluginId: string, def: SkillWorkflow): () => void {
  const key = `${pluginId}:${def.id}`;
  workflowDefinitions.set(key, { pluginId, def });
  return () => { workflowDefinitions.delete(key); };
}

export function listRegisteredWorkflows(): readonly RegisteredWorkflow[] {
  return [...workflowDefinitions.values()];
}

function findWorkflow(id: string): RegisteredWorkflow | undefined {
  // Accept both 'id' and 'pluginId:id' for convenience.
  if (id.includes(':')) return workflowDefinitions.get(id);
  for (const reg of workflowDefinitions.values()) {
    if (reg.def.id === id) return reg;
  }
  return undefined;
}

/** Test seam. */
export function clearWorkflowDefinitions(): void {
  workflowDefinitions.clear();
}

// ── WorkflowRun ────────────────────────────────────────────────────────

export interface WorkflowRunArgs {
  id: string;
  args?: Record<string, unknown>;
}

export interface WorkflowRunResult extends Record<string, unknown> {
  output: string;
  runId: string;
  state: WorkflowRunState;
}

export function buildWorkflowRunTool(): LLMToolSpec {
  return {
    name: 'WorkflowRun',
    description:
      'Execute a registered skill workflow by id. Steps run sequentially; each step can hand off ' +
      'its output file to the next via contributes.workflows[].steps[].handoff. Returns the final ' +
      'run state once every step resolves (or the run aborts on error).',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Workflow id (plain) or "pluginId:workflowId" when disambiguating across plugins.',
        },
        args: {
          type: 'object',
          description:
            'Initial arguments merged into every step\'s args (low-precedence; per-step args override). ' +
            'Used to seed the first step with caller-supplied context.',
          additionalProperties: true,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };
}

export async function dispatchWorkflowRun(
  args: Record<string, unknown>,
): Promise<WorkflowRunResult> {
  const id = typeof args.id === 'string' ? args.id : '';
  if (!id) throw new Error('WorkflowRun requires "id"');
  const reg = findWorkflow(id);
  if (!reg) throw new Error(`no workflow registered with id '${id}'`);
  const runner = globalWorkflowRunner();
  const state = await runner.run(reg.def, {
    args: args.args && typeof args.args === 'object'
      ? args.args as Record<string, unknown>
      : undefined,
  });
  return {
    output: `workflow '${reg.def.id}' run ${state.runId} → ${state.status}`,
    runId: state.runId,
    state,
  };
}

// ── WorkflowList ───────────────────────────────────────────────────────

export interface WorkflowListResult extends Record<string, unknown> {
  output: string;
  workflows: Array<{
    pluginId: string;
    id: string;
    name: string;
    steps: number;
    triggers?: string[];
  }>;
}

export function buildWorkflowListTool(): LLMToolSpec {
  return {
    name: 'WorkflowList',
    description:
      'List all registered skill workflows + their step counts. Read-only. ' +
      'Use before WorkflowRun to discover what\'s available this session.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  };
}

export function dispatchWorkflowList(): WorkflowListResult {
  const rows = listRegisteredWorkflows().map(r => ({
    pluginId: r.pluginId,
    id: r.def.id,
    name: r.def.name,
    steps: r.def.steps.length,
    ...(r.def.triggers ? { triggers: r.def.triggers } : {}),
  }));
  const output = rows.length === 0
    ? 'No skill workflows registered.'
    : rows.map(r => `- ${r.pluginId}:${r.id} (${r.steps} steps) — ${r.name}`).join('\n');
  return { output, workflows: rows };
}

// ── WorkflowStatus ─────────────────────────────────────────────────────

export interface WorkflowStatusArgs {
  runId: string;
}

export interface WorkflowStatusResult extends Record<string, unknown> {
  output: string;
  state: WorkflowRunState | null;
}

export function buildWorkflowStatusTool(): LLMToolSpec {
  return {
    name: 'WorkflowStatus',
    description:
      'Fetch the live state of a workflow run by runId (the id WorkflowRun returned). ' +
      'Returns the per-step status array + overall status.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id returned by WorkflowRun.' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  };
}

export async function dispatchWorkflowStatus(
  args: Record<string, unknown>,
): Promise<WorkflowStatusResult> {
  const runId = typeof args.runId === 'string' ? args.runId : '';
  if (!runId) throw new Error('WorkflowStatus requires "runId"');
  const state = await globalWorkflowRunner().status(runId);
  return {
    output: state
      ? `workflow '${state.workflowId}' run ${runId} → ${state.status} (step ${state.currentStep + 1}/${state.steps.length})`
      : `no run with id '${runId}'`,
    state,
  };
}
