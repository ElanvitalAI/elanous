import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S3.6 P3: ParetoAnalyze (80/20) LLM tool ──


import {
  computePareto,
  renderPareto,
  type ParetoItem,
  type ParetoReport,
} from '../rca.js';

export interface ParetoAnalyzeInput {
  title: string;
  items: readonly ParetoItem[];
  threshold?: number;
}

export interface ParetoAnalyzeResult {
  output: string;
  report: ParetoReport;
  notices?: string[];
}

export async function dispatchParetoAnalyze(
  input: ParetoAnalyzeInput,
): Promise<ParetoAnalyzeResult> {
  const threshold = input.threshold ?? 0.8;
  const report = computePareto(input.title, input.items, threshold);

  const notices: string[] = [];
  if (report.topN === 1 && report.ranked.length > 1) {
    notices.push(
      `Extreme concentration: 1 item (${report.ranked[0].label}) covers ${(report.topShare * 100).toFixed(0)}% — `
      + 'consider fixing this single cause first.',
    );
  }
  if (report.topN === report.ranked.length) {
    notices.push(
      'No Pareto effect — distribution is flat. 80/20 simplification does not apply; '
      + 'consider grouping items more coarsely or using FMEA / Fishbone instead.',
    );
  }

  return {
    output: renderPareto(report),
    report,
    ...(notices.length > 0 ? { notices } : {}),
  };
}

export function buildParetoAnalyzeTool(): LLMToolSpec {
  return {
    name: 'ParetoAnalyze',
    description:
      'Compute the Pareto (80/20) cumulative distribution of a list of {label, count} '
      + 'items. Sorts descending, accumulates percent, and marks items that fall inside '
      + 'the top band (default 80% cumulative). Useful for prioritizing which few causes '
      + 'to fix first when problems are heavy-tailed. Returns ranked items + topN/tailN + '
      + 'topShare + notices (e.g. extreme concentration or flat distribution).',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What is being ranked, e.g. "tool error causes last 7 days".' },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              count: { type: 'number', minimum: 0, description: 'Non-negative occurrence count.' },
            },
            required: ['label', 'count'],
            additionalProperties: false,
          },
        },
        threshold: {
          type: 'number',
          minimum: 0.01,
          maximum: 0.99,
          description: 'Cumulative share that defines the "top" band (default 0.8).',
        },
      },
      required: ['title', 'items'],
      additionalProperties: false,
    },
  };
}
