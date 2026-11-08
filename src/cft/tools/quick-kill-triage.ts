import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S3.9 P1: QuickKillTriage LLM tool ──


import {
  renderQuickKill,
  triageQuickKill,
  type QuickKillInput,
  type QuickKillReport,
} from '../quick-kill.js';

export interface QuickKillTriageInput extends QuickKillInput {}

export interface QuickKillTriageResult {
  output: string;
  report: QuickKillReport;
  notices?: string[];
}

export async function dispatchQuickKillTriage(
  input: QuickKillTriageInput,
): Promise<QuickKillTriageResult> {
  const report = triageQuickKill(input);
  return {
    output: renderQuickKill(report),
    report,
    ...(report.notices ? { notices: [...report.notices] } : {}),
  };
}

export function buildQuickKillTriageTool(): LLMToolSpec {
  return {
    name: 'QuickKillTriage',
    description:
      'Stage-Gate / Lean-Startup style Go/Hold/Kill triage. Supply 3 numeric factors (0-10): '
      + 'evidence_confidence (how clear results are) · remaining_runway (time+budget left) · '
      + 'pivot_cost (how expensive a change would be) + current_signal (positive/neutral/negative). '
      + 'Returns decision + transparent score + rationale + next_step. Heuristic is simple so '
      + 'you can override when confidence < 0.5 (tool emits notice). Pair with RunPDCA (kill → '
      + 'abort decision) or EscalateSignal (for stakeholder call).',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'What is being triaged (experiment, project, feature).' },
        evidence_confidence: {
          type: 'number',
          minimum: 0,
          maximum: 10,
          description: '0 (totally unclear) .. 10 (definitive evidence).',
        },
        remaining_runway: {
          type: 'number',
          minimum: 0,
          maximum: 10,
          description: '0 (out of time/budget) .. 10 (ample).',
        },
        pivot_cost: {
          type: 'number',
          minimum: 0,
          maximum: 10,
          description: '0 (trivial) .. 10 (prohibitively expensive).',
        },
        current_signal: {
          type: 'string',
          enum: ['positive', 'neutral', 'negative'],
          description: 'Directional signal of early results.',
        },
      },
      required: ['subject', 'evidence_confidence', 'remaining_runway', 'pivot_cost', 'current_signal'],
      additionalProperties: false,
    },
  };
}
