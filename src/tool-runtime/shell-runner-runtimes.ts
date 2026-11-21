// ── ShellList / ShellPoll / ShellKill ToolRuntimes (NT-C1b-2) ──
//
// Thin wrappers around the dispatchers in skill-tool-shell-runner.ts.
// All three consume the currently-registered ShellRegistry singleton
// (getShellRegistry()), so the dashboard boot path that calls
// initShellRegistry() + setShellRunnerDeps() is the only wiring
// needed to light them up on skill + dashboard surfaces.

import {
  buildShellListTool,
  buildShellPollTool,
  buildShellKillTool,
  dispatchShellList,
  dispatchShellPoll,
  dispatchShellKill,
} from '../skills/tools/shell-runner.js';
import { getShellRegistry } from '../shell-runner/registry.js';
import type { ToolRuntime } from './types.js';

export const shellListRuntime: ToolRuntime<Record<string, unknown>, { output: string }> = {
  id: 'shell_list',
  spec: buildShellListTool(),
  async run(req) {
    return dispatchShellList(req, getShellRegistry());
  },
};

export const shellPollRuntime: ToolRuntime<Record<string, unknown>, { output: string }> = {
  id: 'shell_poll',
  spec: buildShellPollTool(),
  async run(req) {
    return dispatchShellPoll(req, getShellRegistry());
  },
};

export const shellKillRuntime: ToolRuntime<Record<string, unknown>, { output: string }> = {
  id: 'shell_kill',
  spec: buildShellKillTool(),
  async run(req, ctx) {
    return dispatchShellKill(req, getShellRegistry(), ctx.sessionId ?? ctx.parentSessionId);
  },
};

export const ALL_SHELL_RUNNER_RUNTIMES: ToolRuntime<any, any>[] = [
  shellListRuntime,
  shellPollRuntime,
  shellKillRuntime,
];
