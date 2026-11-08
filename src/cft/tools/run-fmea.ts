import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S3.4 P1: RunFMEA LLM tool ──


import {
  buildReport,
  renderTopTable,
  type FMEAReport,
  type FMEARow,
} from '../fmea.js';

export interface RunFMEAInput {
  system: string;
  items: readonly FMEARow[];
  top_n?: number;
}

export interface RunFMEAResult {
  output: string;
  report: FMEAReport;
  notices?: string[];
}

export async function dispatchRunFMEA(input: RunFMEAInput): Promise<RunFMEAResult> {
  if (!input.system || !input.system.trim()) {
    throw new Error('RunFMEA: system is required');
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('RunFMEA: items must be a non-empty array');
  }
  const topN = input.top_n ?? 3;
  const report = buildReport(input.system, input.items, topN);

  const notices: string[] = [];
  if (report.summary.critical_count > 0) {
    notices.push(
      `${report.summary.critical_count} critical (RPN≥300) item(s) — consider EscalateSignal HIGH/CRITICAL.`,
    );
  }
  if (report.summary.high_count >= 3) {
    notices.push(`${report.summary.high_count} high-risk items — countermeasures recommended this sprint.`);
  }

  return {
    output: renderTopTable(report),
    report,
    ...(notices.length > 0 ? { notices } : {}),
  };
}

export function buildRunFMEATool(): LLMToolSpec {
  return {
    name: 'RunFMEA',
    description:
      'Run a Failure Mode & Effects Analysis over a list of failure scenarios. For each row you '
      + 'supply {mode, effect, cause, severity, occurrence, detection} (each factor 1-10), the tool '
      + 'computes RPN = severity × occurrence × detection and classifies risk '
      + '(low<50, medium<125, high<300, critical≥300). Returns ranked items + top-N + summary. '
      + 'Deterministic — parent LLM identifies the failure modes; this tool only does the math. '
      + 'Pair with EscalateSignal when critical_count>0 or KnowledgeWrite kind=note for archival.',
    parameters: {
      type: 'object',
      properties: {
        system: {
          type: 'string',
          description: 'Name of the system/feature under analysis, e.g. "Slack handler v1.2".',
        },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              mode: { type: 'string', description: 'The failure mode — how it fails.' },
              effect: { type: 'string', description: 'Consequence of the failure.' },
              cause: { type: 'string', description: 'Root / direct cause.' },
              severity: { type: 'integer', minimum: 1, maximum: 10, description: '1 (trivial) .. 10 (catastrophic).' },
              occurrence: { type: 'integer', minimum: 1, maximum: 10, description: '1 (rare) .. 10 (near-certain).' },
              detection: { type: 'integer', minimum: 1, maximum: 10, description: '1 (auto-detected) .. 10 (invisible).' },
              recommended_action: { type: 'string', description: 'Optional countermeasure note.' },
            },
            required: ['mode', 'effect', 'cause', 'severity', 'occurrence', 'detection'],
            additionalProperties: false,
          },
        },
        top_n: {
          type: 'integer',
          minimum: 1,
          description: 'How many top-ranked items to highlight (default 3).',
        },
      },
      required: ['system', 'items'],
      additionalProperties: false,
    },
  };
}
