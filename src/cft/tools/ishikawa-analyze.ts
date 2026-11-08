import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S3.6 P2: IshikawaAnalyze (Fishbone 6M) LLM tool ──


import {
  buildFishbone,
  FISHBONE_CATEGORIES,
  renderFishbone,
  type FishboneCategories,
  type FishboneReport,
} from '../rca.js';

export interface IshikawaAnalyzeInput {
  problem: string;
  categories: Partial<FishboneCategories>;
}

export interface IshikawaAnalyzeResult {
  output: string;
  report: FishboneReport;
  notices?: string[];
}

export async function dispatchIshikawaAnalyze(
  input: IshikawaAnalyzeInput,
): Promise<IshikawaAnalyzeResult> {
  const report = buildFishbone(input.problem, input.categories);
  return {
    output: renderFishbone(report),
    report,
    ...(report.notices ? { notices: [...report.notices] } : {}),
  };
}

export function buildIshikawaAnalyzeTool(): LLMToolSpec {
  return {
    name: 'IshikawaAnalyze',
    description:
      'Build an Ishikawa / fishbone diagram organizing causes into the 6M categories '
      + '(manpower, machine, material, method, measurement, environment). You (the parent '
      + 'LLM) provide the causes per category; tool structures them + identifies the '
      + 'dominant category + flags empty ones. Useful for *lateral* exploration when '
      + '5-Why gives a single vertical chain. Categories are independently optional — '
      + 'at least one cause total required.',
    parameters: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'Problem at the fish head.' },
        categories: {
          type: 'object',
          description: `Map of 6M category → list of causes. Categories: ${FISHBONE_CATEGORIES.join(', ')}.`,
          properties: Object.fromEntries(
            FISHBONE_CATEGORIES.map((c) => [
              c,
              { type: 'array', items: { type: 'string' } },
            ]),
          ),
          additionalProperties: false,
        },
      },
      required: ['problem', 'categories'],
      additionalProperties: false,
    },
  };
}
