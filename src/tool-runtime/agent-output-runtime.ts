// ── AgentOutput ToolRuntime adapter (ROADMAP-agent-surface-deferred-tools W1.1) ──
//
// Read-only. No approver, no sandbox. Mirrors agent-list-runtimes.ts.

import {
  buildAgentOutputTool,
  dispatchAgentOutput,
  type AgentOutputParams,
  type AgentOutputResult,
} from '../agent/agent-output-tool.js';
import type { ToolRuntime } from './types.js';

export const agentOutputRuntime: ToolRuntime<Partial<AgentOutputParams>, AgentOutputResult> = {
  id: 'agent_output',
  spec: buildAgentOutputTool(),
  async run(req, ctx) { return dispatchAgentOutput(req, { signal: ctx.signal }); },
};
