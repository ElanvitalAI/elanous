// ── RunShell ToolRuntime ──
//
// Wraps dispatchRunShell (src/skill-tool-shell.ts) in the ToolRuntime
// shape. Follows the established pattern: ctx.signal flows into the
// dispatcher so dashboard Esc aborts in-flight commands; the
// approval-cache + audit-log live inside shell-primitive so every
// surface (skill-runner, dashboard, MCP later) shares the same state.
//
// Track H — dashboard-surface default sandbox policy:
//   • When a RunShell call originates on the dashboard surface and
//     the LLM doesn't explicitly set `sandbox`, we default to 'auto'.
//     On macOS that wraps via sandbox-exec; other platforms soft-
//     fall through.
//   • Skill surface keeps the caller's explicit choice (which
//     currently defaults to 'off' in the dispatcher). Skills often
//     run trusted developer scripts where sandbox would break fs
//     writes outside cwd — don't change that default.

import {
  buildRunShellTool,
  dispatchRunShell,
  type RunShellDispatchResult,
} from '../skills/tools/shell.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';

export const runShellRuntime: ToolRuntime<Record<string, unknown>, RunShellDispatchResult> = {
  id: 'run_shell',
  spec: buildRunShellTool(),
  async run(req, ctx: ToolRuntimeContext): Promise<RunShellDispatchResult> {
    const effectiveReq =
      ctx.surface === 'dashboard' && req.sandbox === undefined
        ? { ...req, sandbox: 'auto' }
        : req;
    return dispatchRunShell(effectiveReq, {
      signal: ctx.signal,
      availableToolNames: ctx.agentHostTools?.map(tool => tool.name),
    });
  },
};
