import { debug } from '../../debug/log.js';
import type { DispatchContext, SurfaceAdapter } from '../surface-registry.js';
import { createExecution, type Task, type TaskExecution } from '../types.js';
import type { DaemonToolDispatchCtx } from '../../boot/daemon-tools/types.js';
import { createSubagentAdapter, type SubagentCallable } from './subagent.js';
import { externalTaskFingerprint } from '../external-fingerprint.js';
import { approvedExternalTaskPrompt } from '../external-policy.js';
import { finalize, type IdeaApprovalGh } from './idea-approval-pr.js';

const RUN_OUTCOME_INSTRUCTION = '\n\nOn the final line of your response, report the outcome as JSON: {"outcome":"done"} only if the requested work is done; otherwise {"outcome":"not-done"}.';

function reportedDone(output: string | undefined): boolean {
  const lastLine = output?.trim().split(/\r?\n/).at(-1);
  if (!lastLine) return false;
  try {
    const result: unknown = JSON.parse(lastLine);
    return !!result && typeof result === 'object' && !Array.isArray(result)
      && (result as Record<string, unknown>).outcome === 'done';
  } catch {
    return false;
  }
}

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
  ideaApprovalPr?: { finalize: (input: { prUrl: string; task: Task; runId?: string; ok: boolean }) => ReturnType<typeof finalize> };
  gh?: IdeaApprovalGh;
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
      if (task.approval?.state === 'approved' && task.approval.approvedBy === 'manual'
          && task.approval.fingerprint !== externalTaskFingerprint(task)) {
        const exec = createExecution(task, { now: now() });
        const reason = 'approved external task content changed since approval';
        const end = now();
        debug.log('tox.external-exec', 'run-finished', { taskId: task.id, lane, ok: false, reason });
        activeIntake.delete(task.id);
        return {
          executionId: exec.id,
          promise: Promise.resolve({
            ...exec, endedAt: end, durationMs: end - exec.startedAt,
            status: 'failed' as const, error: { code: 'APPROVAL_FINGERPRINT_CHANGED', message: reason },
          }),
        };
      }
      // Manually approved ⊕ fingerprint matched (checked above): rebuild from the approved fields — the stored
      // surface prompt is only used for unapproved/auto tasks, which keep the untrusted-reference wrapping.
      const approvedPrompt = task.approval?.state === 'approved' && task.approval.approvedBy === 'manual' && task.generatedBy?.kind === 'external'
        ? approvedExternalTaskPrompt({ provider: task.generatedBy.provider, ref: task.generatedBy.ref }, task.title, task.description ?? '')
        : undefined;
      const prompt = approvedPrompt ?? surface.prompt;
      // The execution record carries the prompt that actually ran, not the stored one it replaced.
      const ranSurface = { ...surface, prompt };
      debug.log('tox.external-exec', 'prompt-selected', { taskId: task.id, lane, source: approvedPrompt ? 'approved' : 'stored' });
      if (lane === 'dev') {
        const exec = createExecution({ ...task, surface: ranSurface }, { now: now() });
        const promise: Promise<TaskExecution> = (async () => {
          try {
            const raw = await opts.dispatch({ feature: task.title }, {
              cwd: opts.cwd, signal: ctx.signal ?? new AbortController().signal, userText: prompt, autoMerge: !isIntake(task),
            });
            const result = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
            const runId = typeof result.runId === 'string' ? result.runId : undefined;
            const prUrl = typeof result.prUrl === 'string' ? result.prUrl : undefined;
            const ok = result.ok === true;
            let finalizeError: string | undefined;
            if (isIntake(task)) {
              if (ok && !prUrl) {
                finalizeError = 'idea-pr-finalize: successful intake run returned no PR URL';
              } else if (prUrl) {
                try {
                  if (ok && !opts.ideaApprovalPr && !opts.gh) throw new Error('gh executor not configured');
                  const finalized = await (opts.ideaApprovalPr?.finalize({ prUrl, task, runId, ok })
                    ?? finalize({ prUrl, task, runId, ok, gh: opts.gh! }));
                  if (ok) {
                    if (!finalized.ready || !finalized.labeled) throw new Error('PR not ready and labeled for approval');
                    debug.log('tox.external-exec', 'idea-pr-finalized', { taskId: task.id, ...finalized });
                  }
                } catch (error) {
                  finalizeError = `idea-pr-finalize: ${error instanceof Error ? error.message : String(error)}`;
                }
              }
            }
            const output = JSON.stringify({ runId, prUrl, ok });
            const reason = typeof result.error === 'string' ? result.error
              : typeof result.detail === 'string' ? result.detail : 'self-implement did not succeed';
            const end = now();
            return {
              ...exec, endedAt: end, durationMs: end - exec.startedAt,
              status: ctx.signal?.aborted ? 'cancelled' : ok ? 'completed' : 'failed',
              output,
              ...(ok && finalizeError ? { reviewRequired: true } : {}),
              ...(runId ? { surfaceAddress: `self-impl:${runId}` } : {}),
              ...(ctx.signal?.aborted
                ? { error: { code: 'ABORTED', message: 'cancelled by caller' } }
                : !ok ? { error: { code: 'SELF_IMPL_FAILED', message: finalizeError ? `${reason}; ${finalizeError}` : reason } }
                : finalizeError ? { error: { code: 'IDEA_PR_FINALIZE_FAILED', message: finalizeError } } : {}),
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
        surface: { kind: 'subagent', definitionName: 'general-purpose', prompt: prompt + RUN_OUTCOME_INSTRUCTION },
      };
      const result = await run(delegated, ctx);
      return {
        ...result,
        promise: result.promise.then((exec) => {
          const reason = exec.status === 'failed'
            ? exec.output?.slice(0, 500) || exec.error?.message || 'subagent failed'
            : undefined;
          const completed: TaskExecution = {
            ...exec, surface: ranSurface,
            ...(exec.status === 'completed' && !reportedDone(exec.output)
              ? { reviewRequired: true } : {}),
            ...(reason ? { error: { code: exec.error?.code ?? 'SUBAGENT_FAILED', message: reason } } : {}),
          };
          debug.log('tox.external-exec', 'run-finished', {
            taskId: task.id, lane, ok: completed.status === 'completed' && !completed.reviewRequired,
            ...(completed.reviewRequired ? { reason: 'final-line done outcome absent; execution requires review' } : {}),
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
