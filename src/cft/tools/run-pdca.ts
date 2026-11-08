import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S3.8 P1: RunPDCA LLM tool ──


import {
  PDCA_PHASES,
  renderPdcaPhase,
  runPdcaPhase,
  type PdcaPhase,
  type PdcaPhaseReport,
  type PdcaDecision,
} from '../pdca.js';

export interface RunPDCAInput {
  subject: string;
  phase: PdcaPhase;
  activities?: readonly string[];
  decision?: PdcaDecision;
}

export interface RunPDCAResult {
  output: string;
  report: PdcaPhaseReport;
  notices?: string[];
}

export async function dispatchRunPDCA(input: RunPDCAInput): Promise<RunPDCAResult> {
  const report = runPdcaPhase(input);
  return {
    output: renderPdcaPhase(report),
    report,
    ...(report.notices ? { notices: [...report.notices] } : {}),
  };
}

export function buildRunPDCATool(): LLMToolSpec {
  return {
    name: 'RunPDCA',
    description:
      'Advance one phase of a Deming PDCA (Plan-Do-Check-Act) improvement cycle. You supply '
      + 'subject + current phase + activities list; tool checks required-activity coverage '
      + '(fuzzy substring, case-insensitive) and returns checklist + progress + next phase. '
      + 'Smaller than DMAIC — meant for Kaizen-style rapid iteration. At the act phase, pass '
      + 'decision=\'standardize\'|\'adjust\'|\'abort\' to close the cycle; cycleComplete=true '
      + 'signals caller can archive (WriteA3) and start a new cycle. Typical workflow: 4 '
      + 'sequential calls per cycle, multiple cycles per initiative.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'What this PDCA cycle addresses.' },
        phase: { type: 'string', enum: [...PDCA_PHASES], description: 'Current phase.' },
        activities: {
          type: 'array',
          items: { type: 'string' },
          description:
            'What you did this phase. Fuzzy-matched against required activities '
            + '(plan: hypothesis/metric/duration · do: pilot scope/owner · check: '
            + 'result/vs hypothesis · act: decision/next cycle).',
        },
        decision: {
          type: 'string',
          enum: ['standardize', 'adjust', 'abort'],
          description:
            'Act-phase only. standardize = keep the change · adjust = partial + iterate · '
            + 'abort = revert. Cycle is marked complete only when act + decision both supplied.',
        },
      },
      required: ['subject', 'phase'],
      additionalProperties: false,
    },
  };
}
