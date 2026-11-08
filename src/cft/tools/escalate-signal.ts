import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S3.1 P2: EscalateSignal LLM tool ──


import {
  emitEscalation,
  type EmitOpts,
  type EscalationSeverity,
  type EscalationSignal,
} from '../andon.js';

export interface EscalateSignalInput {
  agent_id: string;
  severity: EscalationSeverity;
  reason: string;
  context?: string;
}

export interface EscalateSignalResult {
  output: string;
  signal: EscalationSignal;
  notices?: string[];
}

export async function dispatchEscalateSignal(
  input: EscalateSignalInput,
  opts: EmitOpts = {},
): Promise<EscalateSignalResult> {
  const signal = await emitEscalation(
    {
      agentId: input.agent_id,
      severity: input.severity,
      reason: input.reason,
      ...(input.context ? { context: input.context } : {}),
    },
    opts,
  );

  const notices: string[] = [];
  if (signal.severity === 'CRITICAL') {
    notices.push('CRITICAL — next turn will be gated by buildAndonPreamble until ResolveEscalation is called.');
  }
  if (signal.incidentPath) {
    notices.push(`incident artifact written: ${signal.incidentPath}`);
  }

  return {
    output: `EscalateSignal: [${signal.agentId}] ${signal.severity} — ${signal.reason}`,
    signal,
    ...(notices.length > 0 ? { notices } : {}),
  };
}

export function buildEscalateSignalTool(): LLMToolSpec {
  return {
    name: 'EscalateSignal',
    description:
      'Raise an Andon escalation — declare that something is wrong and the parent LLM should pause normal '
      + 'work until it acknowledges + resolves the issue. CRITICAL severity injects a preamble into the next '
      + 'turn\'s system prompt that the LLM cannot ignore; it also writes an Obsidian incident artifact. '
      + 'Use sparingly — reserve CRITICAL for data-source mismatches, budget breaches, or contradictory '
      + 'results that would invalidate downstream work. Call ResolveEscalation when the issue is addressed.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'Free-form id of the actor raising this signal — subagent name, tool name, or operator label.',
        },
        severity: {
          type: 'string',
          enum: ['LOW', 'MED', 'HIGH', 'CRITICAL'],
        },
        reason: { type: 'string', description: 'One-line summary of what went wrong.' },
        context: { type: 'string', description: 'Optional additional detail (logs, ids, links).' },
      },
      required: ['agent_id', 'severity', 'reason'],
      additionalProperties: false,
    },
  };
}
