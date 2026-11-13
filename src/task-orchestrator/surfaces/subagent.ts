/**
 * `surface.kind === 'subagent'` adapter.
 *
 * Spawns a subagent via an injected callable (production wires
 * `src/agent/registry.ts` + `src/agent/runner.ts`). The callable
 * returns `{address, done}` — the adapter records the address
 * immediately and awaits `done` for final status + tokens/cost.
 *
 * Model precedence: `surface.model` → `ctx.modelHint` → callable
 * default.
 *
 * Output is tailed to 4 KB (matches llm-direct / skill / terminal).
 */
import {
  createExecution,
  type Task,
  type TaskExecution,
} from '../types.js';
import type { DispatchContext, DispatchResult } from '../surface-registry.js';

export interface SubagentCallable {
  (input: {
    definitionName: string;
    prompt: string;
    model?: string;
    providerName?: string;
    signal?: AbortSignal;
  }): Promise<{
    address: string;
    done: Promise<{
      status: 'completed' | 'failed' | 'cancelled';
      output: string;
      tokenUsage?: { input: number; output: number };
      costUsd?: number;
      modelId?: string;
      durationMs: number;
    }>;
  }>;
}

export interface SubagentAdapterOptions {
  callable: SubagentCallable;
  now?: () => number;
}

export function createSubagentAdapter(opts: SubagentAdapterOptions) {
  const now = opts.now ?? Date.now;

  return async function dispatchSubagent(
    task: Task,
    ctx: DispatchContext,
  ): Promise<DispatchResult> {
    if (task.surface.kind !== 'subagent') {
      throw new Error(`subagent adapter received wrong kind: ${task.surface.kind}`);
    }
    const surface = task.surface;
    const model = surface.model ?? ctx.modelHint;
    const exec = createExecution(task, { now: now(), modelId: model });

    let address: string | undefined;
    let donePromise:
      | Promise<{
          status: 'completed' | 'failed' | 'cancelled';
          output: string;
          tokenUsage?: { input: number; output: number };
          costUsd?: number;
          modelId?: string;
          durationMs: number;
        }>
      | null = null;
    let spawnError: unknown = null;
    try {
      const res = await opts.callable({
        definitionName: surface.definitionName,
        prompt: surface.prompt,
        model,
        providerName: ctx.providerName,
        signal: ctx.signal,
      });
      address = res.address;
      donePromise = res.done;
    } catch (err) {
      spawnError = err;
    }

    const promise = (async (): Promise<TaskExecution> => {
      if (spawnError) {
        const end = now();
        const aborted = ctx.signal?.aborted;
        return {
          ...exec,
          endedAt: end,
          durationMs: end - exec.startedAt,
          status: aborted ? 'cancelled' : 'failed',
          error: aborted
            ? { code: 'ABORTED', message: 'cancelled by caller' }
            : {
                code: 'SUBAGENT_SPAWN_FAILED',
                message: spawnError instanceof Error ? spawnError.message : String(spawnError),
              },
          surfaceAddress: address,
          modelId: model,
        };
      }
      try {
        const r = await donePromise!;
        const end = now();
        if (r.status === 'cancelled' || ctx.signal?.aborted) {
          return {
            ...exec,
            endedAt: end,
            durationMs: r.durationMs,
            status: 'cancelled',
            error: { code: 'ABORTED', message: 'cancelled by caller' },
            output: r.output.slice(-4096),
            surfaceAddress: address,
            modelId: r.modelId ?? model,
          };
        }
        return {
          ...exec,
          endedAt: end,
          durationMs: r.durationMs,
          status: r.status,
          output: r.output.slice(-4096),
          error:
            r.status === 'failed'
              ? { code: 'SUBAGENT_FAILED', message: 'subagent reported failure' }
              : undefined,
          tokenUsage: r.tokenUsage,
          costUsd: r.costUsd,
          modelId: r.modelId ?? model,
          surfaceAddress: address,
        };
      } catch (err) {
        const end = now();
        const aborted = ctx.signal?.aborted;
        return {
          ...exec,
          endedAt: end,
          durationMs: end - exec.startedAt,
          status: aborted ? 'cancelled' : 'failed',
          error: aborted
            ? { code: 'ABORTED', message: 'cancelled by caller' }
            : {
                code: 'SUBAGENT_DONE_FAILED',
                message: err instanceof Error ? err.message : String(err),
              },
          surfaceAddress: address,
          modelId: model,
        };
      }
    })();

    return { executionId: exec.id, surfaceAddress: address, promise };
  };
}
