import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S3.1 P2: ResolveEscalation LLM tool ──


import {
  resolveEscalation,
  type EscalationSignal,
  type ResolveOpts,
} from '../andon.js';

export interface ResolveEscalationInput {
  agent_id: string;
  resolution?: string;
}

export interface ResolveEscalationResult {
  output: string;
  resolved: EscalationSignal | null;
  notices?: string[];
}

export async function dispatchResolveEscalation(
  input: ResolveEscalationInput,
  opts: ResolveOpts = {},
): Promise<ResolveEscalationResult> {
  if (!input.agent_id || !input.agent_id.trim()) {
    throw new Error('ResolveEscalation: agent_id is required');
  }
  const resolveOpts: ResolveOpts = { ...opts };
  if (input.resolution) resolveOpts.resolution = input.resolution;
  const resolved = resolveEscalation(input.agent_id, resolveOpts);
  if (!resolved) {
    return {
      output: `ResolveEscalation: no pending signal for '${input.agent_id}' (already resolved or never emitted).`,
      resolved: null,
    };
  }
  const notices: string[] = [];
  if (resolved.severity === 'CRITICAL' && !input.resolution) {
    notices.push('CRITICAL resolved without explicit resolution note — recommend capturing the fix in A3 Report (WriteA3 tool, future).');
  }
  return {
    output: `ResolveEscalation: [${resolved.agentId}] ${resolved.severity} cleared.`,
    resolved,
    ...(notices.length > 0 ? { notices } : {}),
  };
}

export function buildResolveEscalationTool(): LLMToolSpec {
  return {
    name: 'ResolveEscalation',
    description:
      'Clear a pending Andon escalation. This is the ONLY way to release the CRITICAL preamble — auto-TTL is '
      + 'intentionally not provided. If the signal was CRITICAL, capturing a resolution string is strongly '
      + 'recommended (and A3 Report via a future WriteA3 tool when it lands).',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The agent_id passed to the original EscalateSignal call.' },
        resolution: { type: 'string', description: 'Optional one-line description of the fix.' },
      },
      required: ['agent_id'],
      additionalProperties: false,
    },
  };
}
