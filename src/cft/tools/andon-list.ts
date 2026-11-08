import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S3.1 P2: AndonList LLM tool ──


import {
  buildAndonListResult,
  buildAndonPreamble,
  type AndonListResult,
  type EscalationSeverity,
} from '../andon.js';

export interface AndonListInput {
  severity_filter?: EscalationSeverity;
}

export interface AndonListToolResult extends AndonListResult {
  preamble: string | null;
  format: string;
  /** Canonical ToolRunResult field — the LLM-facing rendered string.
   *  Mirrors `format`; present so this result conforms to the shared
   *  `{ output: string }` dispatch contract like the sibling Andon tools. */
  output: string;
}

export async function dispatchAndonList(
  input: AndonListInput = {},
): Promise<AndonListToolResult> {
  const filter = input.severity_filter ? { severity: input.severity_filter } : undefined;
  const base = buildAndonListResult(filter);
  const preamble = buildAndonPreamble();

  const lines: string[] = [];
  lines.push(
    `🔴 ${base.criticalCount} · 🟠 ${base.highCount} · 🟡 ${base.medCount} · 🔵 ${base.lowCount}`,
  );
  if (base.pending.length === 0) {
    lines.push('(no pending escalations)');
  } else {
    for (const s of base.pending.slice(0, 10)) {
      const suffix = s.context ? ` — ${s.context}` : '';
      lines.push(`  [${s.severity}] [${s.agentId}] ${s.reason}${suffix}`);
    }
    if (base.pending.length > 10) {
      lines.push(`  … and ${base.pending.length - 10} more`);
    }
  }

  const rendered = lines.join('\n');
  return {
    ...base,
    preamble,
    format: rendered,
    output: rendered,
  };
}

export function buildAndonListTool(): LLMToolSpec {
  return {
    name: 'AndonList',
    description:
      'Read the current list of pending Andon escalations (by severity) plus the CRITICAL preamble text. '
      + 'Use this any time you need to check whether the loop has outstanding issues — especially before '
      + 'declaring research complete or closing auto-mode.',
    parameters: {
      type: 'object',
      properties: {
        severity_filter: {
          type: 'string',
          enum: ['LOW', 'MED', 'HIGH', 'CRITICAL'],
          description: 'Optional — only return entries matching this severity.',
        },
      },
      additionalProperties: false,
    },
  };
}
