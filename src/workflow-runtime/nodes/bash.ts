// Archon-port T2.1 (2026-05-08) — bash node executor.
//
// Runs a shell heredoc via injected `runBash` (default: child_process
// spawn /bin/bash -c '...'). Captures stdout — that becomes the node's
// `output`. Stderr is preserved on the result for debugging but not
// piped into `output` (Archon convention — bash node output ≡ stdout).

import type { BashNode, NodeExecContext, NodeOutput, WorkflowDeps } from '../types.js';
import { interpolate } from '../variables.js';

export async function executeBashNode(
  node: BashNode,
  ctx: NodeExecContext,
  deps: WorkflowDeps,
): Promise<NodeOutput> {
  const startedAt = Date.now();
  const interpolated = interpolate(node.bash, {
    arguments: ctx.arguments,
    artifactsDir: ctx.artifactsDir,
    outputs: ctx.outputs,
  });
  try {
    const r = await deps.runBash(interpolated.text, {
      timeoutMs: node.idle_timeout,
      signal: ctx.signal,
      cwd: process.cwd(),
      ...(ctx.env ? { env: ctx.env } : {}),
    });
    if (r.exitCode !== 0) {
      return {
        ok: false,
        output: r.stdout, // surface partial output for $node.output access
        error: `bash exit ${r.exitCode}${r.stderr ? `: ${r.stderr.slice(0, 500)}` : ''}`,
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      ok: true,
      output: r.stdout,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      output: '',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}
