import {
  buildAgentTool,
  dispatchAgent,
  type AgentToolResult,
} from '../skills/tools/agent.js';
import type { ToolRuntime } from './types.js';

export const agentRuntime: ToolRuntime<Record<string, unknown>, AgentToolResult> = {
  id: 'agent',
  spec: buildAgentTool(),
  async run(req, ctx) {
    return await dispatchAgent(req, {
      ...(ctx.agentCwd ? { cwd: ctx.agentCwd } : {}),
      hostTools: ctx.agentHostTools,
      dispatchTool: ctx.agentDispatchTool,
      buildChildToolCatalog: ctx.buildChildToolCatalog,
      signal: ctx.signal,
    });
  },
};
