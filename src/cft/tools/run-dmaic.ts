import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S3.7 P2: RunDMAIC LLM tool ──


import {
  DMAIC_PHASES,
  renderDmaicPhase,
  runDmaicPhase,
  type DmaicPhase,
  type DmaicPhaseReport,
} from '../dmaic.js';

export interface RunDMAICInput {
  problem: string;
  phase: DmaicPhase;
  activities?: readonly string[];
}

export interface RunDMAICResult {
  output: string;
  report: DmaicPhaseReport;
  notices?: string[];
}

export async function dispatchRunDMAIC(input: RunDMAICInput): Promise<RunDMAICResult> {
  const report = runDmaicPhase(input);
  return {
    output: renderDmaicPhase(report),
    report,
    ...(report.notices ? { notices: [...report.notices] } : {}),
  };
}

export function buildRunDMAICTool(): LLMToolSpec {
  return {
    name: 'RunDMAIC',
    description:
      'Advance one phase of a Six Sigma DMAIC cycle (Define / Measure / Analyze / '
      + 'Improve / Control). You supply the problem + current phase + list of activities '
      + 'you completed. Tool checks required activities per phase (substring match, '
      + 'case-insensitive), returns a checklist with [x] / [ ] markers, progress %, '
      + 'and suggests next phase. Typical workflow: 5 sequential calls, one per phase. '
      + 'Pair with WriteA3 to archive the cycle.',
    parameters: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'Problem being addressed across the DMAIC cycle.' },
        phase: {
          type: 'string',
          enum: [...DMAIC_PHASES],
          description: 'Current phase — tool expects sequential calls one per phase.',
        },
        activities: {
          type: 'array',
          items: { type: 'string' },
          description:
            'What you (the LLM) did in this phase. Each required activity is fuzzy-matched '
            + '(substring) against this list — e.g. "set SMART goal: latency < 500ms" covers '
            + 'the define-phase "goal" requirement.',
        },
      },
      required: ['problem', 'phase'],
      additionalProperties: false,
    },
  };
}
