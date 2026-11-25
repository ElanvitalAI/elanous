import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── AgentSend LLM tool (AGENT-STEER) ──
//
// The parent's live correction channel to its own subagents (see agent-steer.ts): a running agent sees the
// body at its next tool-loop iteration; a finished one resumes with its full prior context plus the body.

import { globalAgentRegistry, type AgentRegistry } from './registry.js';
import { sendToAgent, type AgentSendMode } from './agent-steer.js';

export interface AgentSendResult extends Record<string, unknown> {
  output: string;
  ok: boolean;
  delivered?: 'steer' | 'resume';
  taskId?: string;
  name?: string;
  corrections?: number;
  known?: string[];
}

export function buildAgentSendTool(): LLMToolSpec {
  return {
    name: 'AgentSend',
    description:
      'Send a follow-up instruction or correction to one of your subagents (started with Agent). ' +
      'Running agent: the message joins its conversation before its next model request (no restart, context kept). ' +
      'Finished agent: it resumes with its full prior context plus this message; collect the new result with AgentOutput(taskId, block:true). ' +
      'The latest instruction wins. Prefer this over stopping and re-spawning when the goal changes.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Agent name (the Agent call\'s name/description), or its taskId / unique id prefix (≥4 chars).' },
        body: { type: 'string', description: 'The correction or follow-up instruction.' },
        mode: { type: 'string', enum: ['steer', 'resume'], description: 'Optional. Default: steer when running, resume when finished.' },
      },
      required: ['to', 'body'],
      additionalProperties: false,
    },
  };
}

export function dispatchAgentSend(
  args: Record<string, unknown>,
  deps: { registry?: AgentRegistry; requester?: string } = {},
): AgentSendResult {
  const to = typeof args.to === 'string' ? args.to : '';
  const body = typeof args.body === 'string' ? args.body : '';
  const mode: AgentSendMode | undefined = args.mode === 'steer' || args.mode === 'resume' ? args.mode : undefined;
  const outcome = sendToAgent(deps.registry ?? globalAgentRegistry, {
    to, body, ...(mode ? { mode } : {}),
    from: deps.requester ?? 'parent',
    ...(deps.requester ? { ownerSessionId: deps.requester } : {}),
  });
  if (!outcome.ok) return { output: outcome.error, ok: false, known: outcome.known, isError: true };
  const output = outcome.delivered === 'steer'
    ? `✉ correction queued for '${outcome.name}' (taskId=${outcome.taskId}) — it sees it before its next model request · ${outcome.corrections} correction(s) so far`
    : `↻ '${outcome.name}' resumed with full prior context (taskId=${outcome.taskId}) — collect with AgentOutput(taskId, block:true)`;
  return { output, ok: true, delivered: outcome.delivered, taskId: outcome.taskId, name: outcome.name, corrections: outcome.corrections };
}
