import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S3.2 P2: EmitProcessHealth LLM tool ──
//
// Write-only feed for a named SPC series. Records the sample, reports
// the updated stats, and (by default) auto-emits an Andon escalation
// when the sample is a ≥2σ outlier. Use it to let the LLM surface
// drift in latency, answer length, retries, etc. without polling.


import {
  emitEscalation,
  type EmitOpts,
  type EscalationSeverity,
  type EscalationSignal,
} from '../andon.js';
import {
  recordSample,
  type ProcessHealthStats,
} from '../spc.js';

export interface EmitProcessHealthInput {
  series: string;
  value: number;
  auto_escalate?: boolean;
  escalate_severity?: EscalationSeverity;
  agent_id?: string;
  reason_prefix?: string;
  capacity?: number;
}

export interface EmitProcessHealthResult {
  output: string;
  series: string;
  stats: ProcessHealthStats;
  escalated?: EscalationSignal;
  notices?: string[];
}

const VALID_SEVERITY: readonly EscalationSeverity[] = ['LOW', 'MED', 'HIGH', 'CRITICAL'];

export async function dispatchEmitProcessHealth(
  input: EmitProcessHealthInput,
  opts: EmitOpts = {},
): Promise<EmitProcessHealthResult> {
  if (!input.series || !input.series.trim()) {
    throw new Error('EmitProcessHealth: series is required');
  }
  if (typeof input.value !== 'number' || !Number.isFinite(input.value)) {
    throw new Error('EmitProcessHealth: value must be a finite number');
  }
  if (input.escalate_severity && !VALID_SEVERITY.includes(input.escalate_severity)) {
    throw new Error(
      `EmitProcessHealth: invalid escalate_severity '${input.escalate_severity}'`,
    );
  }

  const sampleOpts: Parameters<typeof recordSample>[2] = {};
  if (typeof input.capacity === 'number' && input.capacity > 0) {
    sampleOpts.capacity = Math.floor(input.capacity);
  }
  const stats = recordSample(input.series, input.value, sampleOpts);

  const autoEscalate = input.auto_escalate ?? true;
  const outlier = stats.outlierZ !== undefined;

  const notices: string[] = [];
  let escalated: EscalationSignal | undefined;

  if (outlier && autoEscalate) {
    const severity = input.escalate_severity ?? 'MED';
    const agentId = input.agent_id ?? `spc:${stats.series}`;
    const prefix = input.reason_prefix ?? 'SPC outlier';
    const zFixed = stats.outlierZ!.toFixed(2);
    const meanFixed = stats.mean.toFixed(2);
    const stddevFixed = stats.stddev.toFixed(2);
    const reason =
      `${prefix} on '${stats.series}': value=${input.value} mean=${meanFixed} `
      + `stddev=${stddevFixed} z=${zFixed} (n=${stats.n})`;
    escalated = await emitEscalation(
      { agentId, severity, reason, context: stats.sign ?? '' },
      opts,
    );
  } else if (outlier && !autoEscalate) {
    notices.push('outlier detected but auto_escalate=false');
  }

  const tail =
    stats.outlierZ === undefined
      ? `n=${stats.n} mean=${stats.mean.toFixed(2)} stddev=${stats.stddev.toFixed(2)}`
      : `n=${stats.n} z=${stats.outlierZ!.toFixed(2)} ${stats.sign ?? ''}`;

  return {
    output: `EmitProcessHealth [${input.series}] value=${input.value} ${tail}`
      + (escalated ? ` · escalated ${escalated.severity}` : ''),
    series: input.series,
    stats,
    ...(escalated ? { escalated } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
}

export function buildEmitProcessHealthTool(): LLMToolSpec {
  return {
    name: 'EmitProcessHealth',
    description:
      'Record a numeric sample for a named time series (latency, answer length, retries, etc.) '
      + 'and return updated statistics. Once the series accumulates ≥5 samples, any value whose '
      + 'z-score exceeds ±2σ is flagged as an outlier; by default this auto-emits an Andon '
      + 'escalation (MED severity) so the parent LLM can react. Pass auto_escalate=false to '
      + 'record samples quietly. Series state is in-memory and resets on process restart.',
    parameters: {
      type: 'object',
      properties: {
        series: {
          type: 'string',
          description: 'Namespaced series name, e.g. "answer-length" or "tool:Bash:latency-ms".',
        },
        value: {
          type: 'number',
          description: 'Finite numeric sample. NaN/Infinity are rejected.',
        },
        auto_escalate: {
          type: 'boolean',
          description: 'When true (default), a detected outlier triggers emitEscalation(). Set false to suppress.',
        },
        escalate_severity: {
          type: 'string',
          enum: ['LOW', 'MED', 'HIGH', 'CRITICAL'],
          description: 'Severity for the auto-escalation; default "MED". Use CRITICAL to force an Andon preamble.',
        },
        agent_id: {
          type: 'string',
          description: 'Override the escalation agentId (default "spc:<series>").',
        },
        reason_prefix: {
          type: 'string',
          description: 'Override the escalation reason prefix (default "SPC outlier").',
        },
        capacity: {
          type: 'number',
          description: 'Override the ring buffer capacity (default 20). Only honoured on first record for a series.',
        },
      },
      required: ['series', 'value'],
      additionalProperties: false,
    },
  };
}
