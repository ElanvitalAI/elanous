import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S3.7 P1: WriteA3 LLM tool ──


import { renderA3, type A3Input, type A3Report } from '../a3.js';

export interface WriteA3Input extends A3Input {}

export interface WriteA3Result {
  output: string;
  markdown: string;
  frontmatter: Record<string, unknown>;
  placeholderCount: number;
  rel_path?: string;
  wrote?: boolean;
  notices?: string[];
}

export async function dispatchWriteA3(input: WriteA3Input): Promise<WriteA3Result> {
  const report: A3Report = renderA3(input);

  // Note: actual KnowledgeWrite 호출은 caller responsibility (vault
  // access + overwrite policy 결정). Adapter pattern matches coding/
  // refactor adapters — tool produces content, caller persists.
  return {
    output:
      `WriteA3 [${report.title}] by ${report.owner} · `
      + `${report.markdown.split('\n').length} lines · `
      + `placeholders=${report.placeholderCount}`,
    markdown: report.markdown,
    frontmatter: report.frontmatter,
    placeholderCount: report.placeholderCount,
    ...(input.rel_path ? { rel_path: input.rel_path, wrote: false } : {}),
    ...(report.notices ? { notices: [...report.notices] } : {}),
  };
}

export function buildWriteA3Tool(): LLMToolSpec {
  return {
    name: 'WriteA3',
    description:
      'Assemble a Toyota-style A3 problem-solving report (1-page, 9-box layout: '
      + 'Background / Current State / Goal / Root Cause Analysis / Countermeasures / '
      + 'Implementation Plan / Follow-up). Returns markdown + KnowledgeWrite-ready '
      + 'frontmatter (kind=a3). Missing sections become _TBD_ placeholders — tool '
      + 'emits notice when 3+ are unfilled so the LLM is encouraged to fill them '
      + '(A3\'s discipline). Chain with RootCauseAnalyze / IshikawaAnalyze output '
      + 'for the analysis section. Provide rel_path to signal future persistence; '
      + 'the caller owns the actual KnowledgeWrite invocation.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short document title (what this A3 is about).' },
        problem: { type: 'string', description: '1-sentence problem statement (required).' },
        background: { type: 'string', description: 'Optional — context, history, how we got here.' },
        current: { type: 'string', description: 'Optional — current state w/ metrics or data snapshot.' },
        goal: { type: 'string', description: 'Optional — target state + success metric.' },
        analysis: { type: 'string', description: 'Optional — RCA summary (often 5-Why or Fishbone body).' },
        countermeasures: {
          type: 'array',
          minItems: 1,
          items: { type: 'string' },
          description: 'Proposed actions (required, at least one).',
        },
        plan: { type: 'string', description: 'Optional — who / when / how.' },
        followup: { type: 'string', description: 'Optional — verification + escalation.' },
        owner: { type: 'string', description: 'Person/team accountable for the A3 (required).' },
        rel_path: {
          type: 'string',
          description: 'Optional — vault-relative path if caller will persist via KnowledgeWrite (tool does not write itself).',
        },
      },
      required: ['title', 'problem', 'owner', 'countermeasures'],
      additionalProperties: false,
    },
  };
}
