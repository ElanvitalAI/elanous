// ── AgentStop ToolRuntime adapter (ROADMAP-agent-surface-deferred-tools W1.2) ──
//
// Mutating but read-light — sends abort signal to a task in the
// shared agent registry. No approver wiring; cancellation of the
// caller's own spawned children is treated as trusted (mirrors how
// agent_list and agent_output are unguarded).

import {
  buildAgentStopTool,
  dispatchAgentStop,
  type AgentStopParams,
  type AgentStopResult,
} from '../agent/agent-stop-tool.js';
import type { ToolRuntime } from './types.js';

export const agentStopRuntime: ToolRuntime<Partial<AgentStopParams>, AgentStopResult> = {
  id: 'agent_stop',
  spec: buildAgentStopTool(),
  async run(req, ctx) { return dispatchAgentStop(req, { requester: ctx.parentSessionId ?? ctx.sessionId }); },
};
