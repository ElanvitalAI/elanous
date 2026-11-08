import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S3.6 P1: RootCauseAnalyze (5-Why) LLM tool ──


import {
  buildWhyChain,
  renderWhyChain,
  type WhyChain,
} from '../rca.js';

export interface RootCauseAnalyzeInput {
  problem: string;
  whys: readonly string[];
}

export interface RootCauseAnalyzeResult {
  output: string;
  chain: WhyChain;
  notices?: string[];
}

export async function dispatchRootCauseAnalyze(
  input: RootCauseAnalyzeInput,
): Promise<RootCauseAnalyzeResult> {
  const chain = buildWhyChain(input.problem, input.whys);
  return {
    output: renderWhyChain(chain),
    chain,
    ...(chain.notices ? { notices: [...chain.notices] } : {}),
  };
}

export function buildRootCauseAnalyzeTool(): LLMToolSpec {
  return {
    name: 'RootCauseAnalyze',
    description:
      'Package a 5-Why iterative root-cause analysis. You (the parent LLM) ask "why?" '
      + '5 times — each answer feeding the next question — and pass the answers as an '
      + 'ordered array. Tool validates depth (3-8, ideal 5) and returns the chain + '
      + 'root cause (deepest why). Pair with IshikawaAnalyze for a fuller picture, or '
      + 'WriteA3 to embed into an A3 report.',
    parameters: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'The problem statement to trace.' },
        whys: {
          type: 'array',
          minItems: 3,
          maxItems: 8,
          items: { type: 'string' },
          description: 'Ordered answers to successive "why?" questions. 5 is canonical Toyota depth.',
        },
      },
      required: ['problem', 'whys'],
      additionalProperties: false,
    },
  };
}
