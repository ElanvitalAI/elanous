// ── AgentOutput LLM tool (ROADMAP-agent-surface-deferred-tools Wave 1 · W1.1) ──
//
// Reads the final result of an AgentTask owned by the global agent
// registry. Pairs with `Agent(run_in_background=true)` (Wave 1 · W1.3
// AgentSpawn) — the LLM kicks off a background spawn, gets back a
// taskId, then later calls AgentOutput to retrieve the answer.
//
// Modes:
//   block=false (default): non-blocking peek. Returns retrievalStatus
//     'not_ready' when the task is still pending/running, else the
//     terminal result. Cheap — no listener wired.
//   block=true: wait up to timeoutMs for terminal state via the
//     registry's onTaskDone listener. Returns retrievalStatus
//     'timeout' if the wait elapses, else the terminal result.
//
// Reference parity: Claude Code's TaskOutput (block + timeout + final
// extractTextContent). elanous differs in that the registry is the
// single source — ACP background-manager is a separate layer that
// AgentOutput intentionally does NOT touch (ACP sessions exposed via
// AcpSessionJoin instead).
//
// Read-only. No approver, no sandbox, no network.

import type { LLMToolSpec } from '../llm.js';
import { debug } from '../debug/log.js';
import { globalAgentRegistry } from './registry.js';
import type { AgentRegistry } from './registry.js';
import type { AgentTask, AgentState } from './types.js';

export const DEFAULT_AGENT_OUTPUT_TIMEOUT_MS = 30_000;
/** Hard cap on text payload returned to the LLM. Aligns with Claude Code's
 *  TaskOutput 8MB ceiling — keeps the tool result from blowing the
 *  context window when an agent emitted megabytes of streamed text. */
export const AGENT_OUTPUT_TEXT_CAP_BYTES = 8 * 1024 * 1024;

export type AgentOutputRetrievalStatus =
  | 'success'      // task reached terminal state, result available
  | 'not_ready'    // still pending/running, block=false
  | 'timeout'      // block=true, timeout elapsed before terminal
  | 'interrupted'  // caller stopped waiting; the background task remains active
  | 'not_found';   // no task with that id in the registry

export interface AgentOutputParams {
  taskId: string;
  block?: boolean;
  timeoutMs?: number;
}

export interface AgentOutputResult extends Record<string, unknown> {
  /** Propagated through the LLM tool loop so terminal worker failures count as tool errors. */
  isError?: true;
  /** Ambient one-liner the LLM renders ("done · 412 chars" / "still
   *  running · waited 30000ms" / "not found"). */
  output: string;
  retrievalStatus: AgentOutputRetrievalStatus;
  taskId: string;
  state?: AgentState;
  label?: string;
  text?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  /** Elapsed wall-clock time from task start until a timeout response.
   *  Omitted when the task start time is unavailable. */
  taskElapsedMs?: number;
  /** True when the text payload was truncated to AGENT_OUTPUT_TEXT_CAP_BYTES.
   *  Lets the LLM know it should call again with a narrower scope (e.g.
   *  via AgentSend) rather than assume it has the full answer. */
  truncated?: boolean;
}

export function buildAgentOutputTool(): LLMToolSpec {
  return {
    name: 'AgentOutput',
    description:
      "Retrieve the final result of a background AgentTask by id. Pairs with Agent(run_in_background=true). When `block` is true, waits up to `timeoutMs` for terminal state; when false (default), returns immediately with retrievalStatus='not_ready' if still running. After a timeout, call again with the same taskId to continue waiting.",
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description:
            'The agent task id returned by a prior Agent spawn (UUID format). Use AgentList or the spawn return value to obtain it.',
        },
        block: {
          type: 'boolean',
          description:
            'When true, wait up to timeoutMs for terminal state. When false (default), return immediately even if the task is still running.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Wait limit when block=true. The default is for short checks; background children commonly take longer, so use a value larger than the default when waiting for them. Ignored when block=false.',
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

function clipText(text: string | undefined): { text?: string; truncated?: boolean } {
  if (text === undefined) return {};
  if (text.length <= AGENT_OUTPUT_TEXT_CAP_BYTES) return { text };
  return {
    text: text.slice(0, AGENT_OUTPUT_TEXT_CAP_BYTES),
    truncated: true,
  };
}

function describeStatus(
  status: AgentOutputRetrievalStatus,
  task: AgentTask | undefined,
  waitedMs?: number,
  taskElapsedMs?: number,
): string {
  switch (status) {
    case 'not_found':
      return `AgentOutput: task not found`;
    case 'not_ready':
      return `AgentOutput: ${task?.state ?? 'running'} · not ready (block=false)`;
    case 'timeout': {
      const elapsed = taskElapsedMs === undefined
        ? 'task elapsed unavailable (start time unavailable)'
        : `task elapsed ${taskElapsedMs}ms`;
      return `AgentOutput: timeout after ${waitedMs ?? 0}ms · ${elapsed} · still ${task?.state ?? 'running'} · call again with the same taskId to continue waiting`;
    }
    case 'interrupted':
      return `AgentOutput: wait interrupted · still ${task?.state ?? 'running'} · call again with the same taskId to continue waiting`;
    case 'success': {
      if (!task) return 'AgentOutput: success';
      if (task.state === 'done') {
        const len = task.result?.length ?? 0;
        return `AgentOutput: done · ${len} chars`;
      }
      if (task.state === 'aborted') return 'AgentOutput: aborted';
      return `AgentOutput: ${task.state}${task.error ? ` · ${task.error}` : ''}`;
    }
  }
}

function snapshot(
  task: AgentTask,
  retrievalStatus: AgentOutputRetrievalStatus,
  waitedMs?: number,
  taskElapsedMs?: number,
): AgentOutputResult {
  const { text, truncated } = clipText(task.result);
  const startedAt = task.startedAt;
  const finishedAt = task.finishedAt;
  const durationMs =
    startedAt !== undefined && finishedAt !== undefined
      ? finishedAt - startedAt
      : undefined;
  const result: AgentOutputResult = {
    output: describeStatus(retrievalStatus, task, waitedMs, taskElapsedMs),
    retrievalStatus,
    taskId: task.id,
    state: task.state,
  };
  if (retrievalStatus === 'success' && task.state === 'error') result.isError = true;
  if (task.label !== undefined) result.label = task.label;
  if (text !== undefined) result.text = text;
  if (truncated) result.truncated = true;
  if (task.error !== undefined) result.error = task.error;
  if (startedAt !== undefined) result.startedAt = startedAt;
  if (finishedAt !== undefined) result.finishedAt = finishedAt;
  if (durationMs !== undefined) result.durationMs = durationMs;
  if (taskElapsedMs !== undefined) result.taskElapsedMs = taskElapsedMs;
  return result;
}

export interface DispatchAgentOutputDeps {
  registry?: AgentRegistry;
  /** Stop waiting for this result without cancelling the background task. */
  signal?: AbortSignal;
  /** Test seam — defaults to setTimeout. */
  setTimer?: (cb: () => void, ms: number) => { dispose: () => void };
  /** Test seam — defaults to Date.now. */
  now?: () => number;
}

export async function dispatchAgentOutput(
  raw: Partial<AgentOutputParams> = {},
  deps: DispatchAgentOutputDeps = {},
): Promise<AgentOutputResult> {
  const taskId = typeof raw.taskId === 'string' ? raw.taskId : '';
  const block = raw.block === true;
  const timeoutMs =
    typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0
      ? raw.timeoutMs
      : DEFAULT_AGENT_OUTPUT_TIMEOUT_MS;
  const registry = deps.registry ?? globalAgentRegistry;
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((cb, ms) => {
      const handle = setTimeout(cb, ms);
      return { dispose: () => clearTimeout(handle) };
    });
  const record = (result: AgentOutputResult): AgentOutputResult => {
    debug.log('agent.output', 'retrieve', {
      taskId: result.taskId,
      retrievalStatus: result.retrievalStatus,
      ...(result.state !== undefined ? { state: result.state } : {}),
      ...(result.taskElapsedMs !== undefined ? { taskElapsedMs: result.taskElapsedMs } : {}),
    });
    return result;
  };

  if (!taskId) {
    return record({
      output: 'AgentOutput: missing taskId',
      retrievalStatus: 'not_found',
      taskId: '',
    });
  }

  const task = registry.get(taskId);
  if (!task) {
    return record({
      output: describeStatus('not_found', undefined),
      retrievalStatus: 'not_found',
      taskId,
    });
  }

  if (isTerminal(task.state)) {
    return record(snapshot(task, 'success'));
  }

  if (!block) {
    return record(snapshot(task, 'not_ready'));
  }

  const startWait = now();
  const interrupted = (): AgentOutputResult => {
    const current = registry.get(taskId) ?? task;
    const taskElapsedMs = current.startedAt === undefined ? undefined : now() - current.startedAt;
    return record(snapshot(current, 'interrupted', undefined, taskElapsedMs));
  };
  if (deps.signal?.aborted) return interrupted();
  return new Promise<AgentOutputResult>((resolve) => {
    let settled = false;
    const signal = deps.signal;
    let subscription: { dispose(): void } | undefined;
    let timer: { dispose(): void } | undefined;
    const cleanup = () => {
      subscription?.dispose();
      timer?.dispose();
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (result: AgentOutputResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => finish(interrupted());
    subscription = registry.onTaskDone((t) => {
      if (settled) return;
      if (t.id !== taskId) return;
      finish(record(snapshot(t, 'success')));
    });
    timer = setTimer(() => {
      if (settled) return;
      const timedOutAt = now();
      const waited = timedOutAt - startWait;
      const current = registry.get(taskId);
      if (current && isTerminal(current.state)) {
        // race · terminal between listener-fire and timer-fire is rare
        // but possible if the listener queue was full · return success.
        finish(record(snapshot(current, 'success')));
        return;
      }
      const timedOutTask = current ?? task;
      const taskElapsedMs = timedOutTask.startedAt === undefined
        ? undefined
        : timedOutAt - timedOutTask.startedAt;
      finish(record(snapshot(timedOutTask, 'timeout', waited, taskElapsedMs)));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
