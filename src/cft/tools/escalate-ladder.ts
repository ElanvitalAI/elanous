import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S3.10 P1: EscalateLadder LLM tool ──


import {
  escalateLadder,
  renderEscalateLadder,
  SEVERITY_INITIAL_TIER,
  TIER_RECIPIENTS,
  TIER_SLA_MINUTES,
  type EscalateLadderInput,
  type EscalateLadderReport,
} from '../escalation-ladder.js';

export interface EscalateLadderToolInput extends EscalateLadderInput {}

export interface EscalateLadderToolResult {
  output: string;
  report: EscalateLadderReport;
  notices?: string[];
}

export async function dispatchEscalateLadder(
  input: EscalateLadderToolInput,
): Promise<EscalateLadderToolResult> {
  const report = escalateLadder(input);
  return {
    output: renderEscalateLadder(report),
    report,
    ...(report.notices ? { notices: [...report.notices] } : {}),
  };
}

export function buildEscalateLadderTool(): LLMToolSpec {
  return {
    name: 'EscalateLadder',
    description:
      'Decide the next tier in the escalation ladder for an incident. 4 tiers: '
      + '1=peer (SLA 15m) · 2=lead (60m) · 3=manager (4h) · 4=director (24h). '
      + 'Initial tier is picked by severity (LOW/MED→1 · HIGH→2 · CRITICAL→3); '
      + 'advance when minutes_since_start ≥ current tier SLA. CRITICAL cannot '
      + 'deescalate below tier 3 (safety guard). Returns next_tier + recipient_role '
      + '+ should_escalate flag + rationale. This is routing logic only — caller '
      + 'owns notification dispatch via AXON HitlRouter / Telegram / Discord.',
    parameters: {
      type: 'object',
      properties: {
        incident_id: { type: 'string', description: 'Stable incident identifier.' },
        severity: {
          type: 'string',
          enum: ['LOW', 'MED', 'HIGH', 'CRITICAL'],
          description: 'Incident severity — selects initial tier and guards deescalation.',
        },
        minutes_since_start: {
          type: 'number',
          minimum: 0,
          description: 'Elapsed time since incident began (compared to current tier SLA).',
        },
        current_tier: {
          type: 'integer',
          enum: [1, 2, 3, 4],
          description: 'Last tier notified. Omit for first notification.',
        },
      },
      required: ['incident_id', 'severity', 'minutes_since_start'],
      additionalProperties: false,
    },
  };
}

// Re-export constants for LLM introspection / docs.
export { SEVERITY_INITIAL_TIER, TIER_RECIPIENTS, TIER_SLA_MINUTES };
