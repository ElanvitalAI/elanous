import { join } from 'node:path';
import { findWorkflow } from '../discovery.js';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { interpolate } from '../variables.js';
import type { NodeExecContext, NodeOutput, RunWorkflowOpts, SubworkflowNode, WorkflowDeps } from '../types.js';

/** Execute a named workflow as one node, retaining the full child result map. */
export async function executeSubworkflowNode(
  node: SubworkflowNode,
  ctx: NodeExecContext,
  deps: WorkflowDeps,
  parent: RunWorkflowOpts,
  childRunId: string,
): Promise<NodeOutput> {
  const startedAt = Date.now();
  const stack = [...(parent.workflowStack ?? []), parent.workflow.name];
  const failure = (error: string): NodeOutput => ({
    ok: false, output: '', error, durationMs: Date.now() - startedAt, childRunId,
  });
  if (stack.includes(node.workflow)) return failure(`subworkflow cycle: ${[...stack, node.workflow].join(' -> ')}`);
  const maxDepth = parent.maxSubworkflowDepth ?? 5;
  if (stack.length > maxDepth) return failure(`subworkflow depth exceeds ${maxDepth}`);

  try {
    const child = findWorkflow(node.workflow)?.definition;
    if (!child) return failure(`subworkflow '${node.workflow}' not found`);
    const inputs = Object.fromEntries(Object.entries(node.inputs).map(([name, expression]) => [
      name, interpolate(expression, ctx).text,
    ]));
    const { runWorkflowToCompletion } = await import('../executor.js');
    const result = await runWorkflowToCompletion({
      workflow: child,
      arguments: JSON.stringify(inputs),
      runId: childRunId,
      workflowStack: stack,
      maxSubworkflowDepth: parent.maxSubworkflowDepth,
      mode: 'full',
      ignorePins: true,
      ...(parent.artifactsDir !== undefined ? { artifactsDir: `${parent.artifactsDir}/${childRunId}` } : {}),
      ...(parent.runDir !== undefined ? { runDir: `${parent.runDir}/children/${childRunId}` } : {}),
      ...(parent.runDir === undefined && parent.artifactsDir === undefined
        ? { runDir: join(process.env.ELANOUS_WORKFLOWS_RUNS_DIR?.trim() || join(elanousStateRoot(), 'workflows-runs'), childRunId) } : {}),
      ...(parent.persistRun !== undefined ? { persistRun: parent.persistRun } : {}),
      ...(parent.signal !== undefined ? { signal: parent.signal } : {}),
      ...(parent.screen !== undefined ? { screen: parent.screen } : {}),
      ...(parent.onTokenChunk !== undefined ? { onTokenChunk: parent.onTokenChunk } : {}),
    }, deps);
    const failedNode = Object.entries(result.outputs).find(([, output]) => !output.ok);
    if (!result.ok || failedNode) {
      const error = result.events.find(event => event.type === 'workflow_failed');
      const message = error?.type === 'workflow_failed' ? error.error
        : failedNode ? `node '${failedNode[0]}' failed: ${failedNode[1].error ?? '(no error message)'}`
          : 'subworkflow failed';
      return { ...failure(message), output: result.outputs };
    }
    return { ok: true, output: result.outputs, durationMs: Date.now() - startedAt, childRunId };
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }
}
