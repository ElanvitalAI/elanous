import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── AgentStop LLM tool (ROADMAP-agent-surface-deferred-tools Wave 1 · W1.2) ──
//
// Sends an abort signal to a live AgentTask owned by the global agent
// registry. Pairs with `Agent(run_in_background=true)` (W1.3 AgentSpawn)
// and `AgentOutput` (W1.1) — kick off, observe, cancel.
//
// Semantic distinction vs TOX TaskKill: this stops an *AgentTask*
// (ephemeral, in-process spawn), NOT a TOX persistent Task. They live
// on different graphs; mixing them up wipes work.
//
// Mechanic: `registry.abort(id)` triggers the task's AbortController.
// The runner's catch handler flips state to 'aborted' once the
// in-flight provider fetch unwinds — so right after AgentStop returns,
// the task may still report state='running' for a tick. Callers that
// need to wait for the terminal flip should chain into
// `AgentOutput(taskId, block:true)`.
//
// Mutating. supportsParallel=false — cancelling the same task
// concurrently is meaningless; cancelling unrelated tasks is fine via
// separate calls.


import { debug } from '../debug/log.js';
import { globalAgentRegistry } from './registry.js';
import type { AgentRegistry } from './registry.js';
import type { AgentState } from './types.js';

export type AgentStopStatus =
  | 'success'           // abort signal delivered to a live task
  | 'already_terminal'  // task already done/error/aborted
  | 'not_found';        // no task with that id

export interface AgentStopParams {
  taskId: string;
  /** Caller's free-form rationale. Echoed in the result for the LLM's
   *  log; not stored on the task (no field for it). */
  reason?: string;
  /** ROADMAP-agent-surface-deferred-tools-2026-05-13 Wave 3 W3.4 —
   *  also abort every live descendant whose `parentTaskId` chains
   *  back to `taskId`. Default false (single-task abort). Used when
   *  the LLM wants to tear down a sub-tree spawned by an Agent
   *  call with `run_in_background=true`. */
  cascade?: boolean;
}

export interface AgentStopResult extends Record<string, unknown> {
  /** Ambient one-liner for the LLM. */
  output: string;
  stopStatus: AgentStopStatus;
  taskId: string;
  /** State at the moment of the call. After 'success' the task is
   *  still draining; expect a brief window where state is 'running'
   *  before the runner flips to 'aborted'. */
  state?: AgentState;
  label?: string;
  reason?: string;
  /** Wave 3 W3.4 — count of descendant tasks that were signalled
   *  alongside the target. Present only when `cascade: true` was
   *  passed. Zero when the target had no live children. */
  descendantsAborted?: number;
}

export function buildAgentStopTool(): LLMToolSpec {
  return {
    name: 'AgentStop',
    description:
      "Send an abort signal to a live background AgentTask by id. Returns immediately after dispatching the signal — the task's runner flips state to 'aborted' shortly after. Distinct from TOX TaskKill (that targets persistent TOX tasks). Use AgentOutput(block:true) after if you need to wait for the terminal flip.",
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description:
            'The agent task id returned by a prior Agent spawn (UUID format).',
        },
        reason: {
          type: 'string',
          description:
            "Optional free-form rationale ('user cancelled', 'replaced by retry', etc). Echoed in the result — not persisted on the task.",
        },
        cascade: {
          type: 'boolean',
          description:
            'When true, also abort every live descendant task whose parentTaskId chains back to this taskId. Returns descendantsAborted in the result. Default false (single-task abort).',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  };
}

function isTerminal(state: AgentState): boolean {
  return state === 'done' || state === 'error' || state === 'aborted';
}

export interface DispatchAgentStopDeps {
  registry?: AgentRegistry;
}

export async function dispatchAgentStop(
  raw: Partial<AgentStopParams> = {},
  deps: DispatchAgentStopDeps = {},
): Promise<AgentStopResult> {
  const taskId = typeof raw.taskId === 'string' ? raw.taskId : '';
  const reason = typeof raw.reason === 'string' ? raw.reason : undefined;
  const cascade = raw.cascade === true;
  const registry = deps.registry ?? globalAgentRegistry;
  const record = (result: AgentStopResult): AgentStopResult => {
    debug.log('agent.stop', 'dispatch', {
      taskId: result.taskId,
      stopStatus: result.stopStatus,
      abortSignalSent: result.stopStatus === 'success',
      ...(result.state !== undefined ? { state: result.state } : {}),
      ...(cascade ? { cascade } : {}),
      ...(result.descendantsAborted !== undefined
        ? { descendantsAborted: result.descendantsAborted }
        : {}),
    });
    return result;
  };

  if (!taskId) {
    return record({
      output: 'AgentStop: missing taskId',
      stopStatus: 'not_found',
      taskId: '',
      ...(reason ? { reason } : {}),
    });
  }

  const task = registry.get(taskId);
  if (!task) {
    return record({
      output: 'AgentStop: task not found',
      stopStatus: 'not_found',
      taskId,
      ...(reason ? { reason } : {}),
    });
  }

  const stateAtCall = task.state;
  if (isTerminal(stateAtCall)) {
    return record({
      output: `AgentStop: already terminal (${stateAtCall})`,
      stopStatus: 'already_terminal',
      taskId,
      state: stateAtCall,
      ...(task.label ? { label: task.label } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  let descendantsAborted = 0;
  if (cascade) {
    const result = registry.abortCascade(taskId);
    descendantsAborted = result.descendants;
  } else {
    registry.abort(taskId);
  }

  const tail = cascade
    ? ` · cascade=${descendantsAborted} descendant${descendantsAborted === 1 ? '' : 's'}`
    : '';
  return record({
    output: `AgentStop: abort signal sent · task draining (${stateAtCall})${tail}`,
    stopStatus: 'success',
    taskId,
    state: stateAtCall,
    ...(task.label ? { label: task.label } : {}),
    ...(reason ? { reason } : {}),
    ...(cascade ? { descendantsAborted } : {}),
  });
}
