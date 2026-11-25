// ── AgentSend ToolRuntime adapter (AGENT-STEER) ──
// Same trust model as AgentStop: the caller corrects only its own spawned children.

import { buildAgentSendTool, dispatchAgentSend, type AgentSendResult } from '../agent/agent-send-tool.js';
import type { ToolRuntime } from './types.js';

export const agentSendRuntime: ToolRuntime<Record<string, unknown>, AgentSendResult> = {
  id: 'agent_send',
  spec: buildAgentSendTool(),
  async run(req, ctx) {
    const requester = ctx.parentSessionId ?? ctx.sessionId;
    return dispatchAgentSend(req, requester ? { requester } : {});
  },
};
