import { debug } from '../../debug/log.js';
import type { DispatchContext, SurfaceAdapter } from '../surface-registry.js';
import { createExecution, type Task, type TaskExecution } from '../types.js';
import type { DaemonToolDispatchCtx } from '../../boot/daemon-tools/types.js';
import { createSubagentAdapter, type SubagentCallable } from './subagent.js';

export function triageExternalTask(task: Task): 'dev' | 'run' {
  if (/\[dev\]/i.test(task.title)) return 'dev';
  return 'run';
}

export type ExternalDevDispatch = (
  args: Record<string, unknown>,
  ctx: DaemonToolDispatchCtx & { autoMerge?: boolean },
) => Promise<unknown>;

export function createExternalExecAdapter(opts: {
  dispatch: ExternalDevDispatch;
  cwd: string;
  subagent: SubagentCallable;
  now?: () => number;
}): SurfaceAdapter {
  const now = opts.now ?? Date.now;
  const run = createSubagentAdapter({ callable: opts.subagent, now: opts.now });
  const activeIntake = new Set<string>();
  const isIntake = (task: Task) => task.generatedBy?.kind === 'external' && String(task.generatedBy.provider) === 'intake';

  const adapter: SurfaceAdapter = async (task: Task, ctx: DispatchContext) => {
    if (task.surface.kind !== 'llm-direct') {
      throw new Error(`external-exec adapter received wrong kind: ${task.surface.kind}`);
    }
    const surface = task.surface;
    const lane = triageExternalTask(task);
    debug.log('tox.external-exec', 'triaged', {
      taskId: task.id, lane, priority: task.priority,
      provider: task.generatedBy?.kind === 'external' ? task.generatedBy.provider : undefined,
    });
    if (isIntake(task)) activeIntake.add(task.id);
    try {
      if (lane === 'dev') {
        const exec = createExecution(task, { now: now() });
        const promise: Promise<TaskExecution> = (async () => {
          try {
            const raw = await opts.dispatch({ feature: task.title }, {
              cwd: opts.cwd, signal: ctx.signal ?? new AbortController().signal, userText: surface.prompt, autoMerge: true,
            });
            const result = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
            const runId = typeof result.runId === 'string' ? result.runId : undefined;
            const prUrl = typeof result.prUrl === 'string' ? result.prUrl : undefined;
            const ok = result.ok === true;
            const output = JSON.stringify({ runId, prUrl, ok });
            const reason = typeof result.error === 'string' ? result.error
              : typeof result.detail === 'string' ? result.detail : 'self-implement did not succeed';
            const end = now();
            return {
              ...exec, endedAt: end, durationMs: end - exec.startedAt,
              status: ctx.signal?.aborted ? 'cancelled' : ok ? 'completed' : 'failed',
              output,
              ...(runId ? { surfaceAddress: `self-impl:${runId}` } : {}),
              ...(ctx.signal?.aborted
                ? { error: { code: 'ABORTED', message: 'cancelled by caller' } }
                : !ok ? { error: { code: 'SELF_IMPL_FAILED', message: reason } } : {}),
            };
          } catch (error) {
            const end = now();
            return {
              ...exec, endedAt: end, durationMs: end - exec.startedAt,
              status: ctx.signal?.aborted ? 'cancelled' : 'failed',
              error: { code: ctx.signal?.aborted ? 'ABORTED' : 'SELF_IMPL_FAILED', message: error instanceof Error ? error.message : String(error) },
            };
          }
        })();
        return {
          executionId: exec.id,
          promise: promise.then((result) => {
            debug.log('tox.external-exec', 'run-finished', {
              taskId: task.id, lane, ok: result.status === 'completed',
              ...(result.error ? { reason: result.error.message } : {}),
            });
            return result;
          }).finally(() => { activeIntake.delete(task.id); }),
        };
      }
      const delegated: Task = {
        ...task,
        surface: { kind: 'subagent', definitionName: 'general-purpose', prompt: surface.prompt },
      };
      const result = await run(delegated, ctx);
      return {
        ...result,
        promise: result.promise.then((exec) => {
          const emptyOutput = exec.status === 'completed' && !exec.output?.trim();
          const reason = emptyOutput ? 'subagent returned empty output'
            : exec.status === 'failed'
              ? exec.output?.slice(0, 500) || exec.error?.message || 'subagent failed'
              : undefined;
          const completed: TaskExecution = {
            ...exec, surface: task.surface,
            ...(emptyOutput ? { status: 'failed' } : {}),
            ...(reason ? { error: { code: emptyOutput ? 'SUBAGENT_EMPTY_OUTPUT' : exec.error?.code ?? 'SUBAGENT_FAILED', message: reason } } : {}),
          };
          debug.log('tox.external-exec', 'run-finished', {
            taskId: task.id, lane, ok: completed.status === 'completed',
            ...(completed.error ? { reason: completed.error.message } : {}),
          });
          return completed;
        }).finally(() => { activeIntake.delete(task.id); }),
      };
    } catch (error) {
      activeIntake.delete(task.id);
      throw error;
    }
  };
  adapter.deferReason = (task) => isIntake(task) && activeIntake.size > 0
    ? 'intake-sequential' : undefined;
  return adapter;
}
