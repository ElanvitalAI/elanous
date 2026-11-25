import {
  buildAgentTool,
  dispatchAgent,
  type AgentToolResult,
} from '../skills/tools/agent.js';
import { guardedAgentSpawn } from '../skills/tools/agent-spawn-guard.js';
import type { ToolRuntime } from './types.js';

export const agentRuntime: ToolRuntime<Record<string, unknown>, AgentToolResult> = {
  id: 'agent',
  spec: buildAgentTool(),
  async run(req, ctx) {
    return await guardedAgentSpawn(req, () => dispatchAgent(req, {
      ...(ctx.parentSessionId ? { parentSessionId: ctx.parentSessionId } : {}),
      ...(ctx.agentCwd ? { cwd: ctx.agentCwd } : {}),
      hostTools: ctx.agentHostTools,
      dispatchTool: ctx.agentDispatchTool,
      buildChildToolCatalog: ctx.buildChildToolCatalog,
      inheritGeneralPurposeToolCatalog: ctx.inheritGeneralPurposeToolCatalog,
      signal: ctx.signal,
    }), undefined, undefined, ctx.parentSessionId ?? '');
  },
};
