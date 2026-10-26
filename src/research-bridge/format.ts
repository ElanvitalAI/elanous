// PLAN §4.4 · Phase 1.4 — Research result formatters.
//
// Two surfaces:
//   - formatResearchPrefill — the `<context>` block injected into
//     the next user input; the LLM treats it as cited material.
//   - formatResearchSummary — short status banner the slash mirrors
//     into the chat pane so the user sees what was archived.

import type { ExternalResearchResult } from './types.js';
import type { ResearchOutputRouteDecision } from '../research/output-router.js';

const PREFILL_OUTPUT_CAP = 6000;

export function formatResearchSummary(r: ExternalResearchResult): string {
  const status = r.ok ? '✓' : '⚠';
  const seconds = (r.durationMs / 1000).toFixed(1);
  const len = r.output.length;
  const head = `${status} /research ${r.skill}: "${r.topic}" — ${seconds}s · ${len} chars`;
  if (r.error) return `${head}  (error: ${r.error.slice(0, 120)})`;
  return head;
}

// TODO(AXIS-FANOUT): pass the route from the production caller when that upstream interface lands.
// Keeping it optional preserves the existing prefill byte-for-byte until then.
export function formatResearchPrefill(r: ExternalResearchResult, route?: ResearchOutputRouteDecision): string {
  const truncated = r.output.length > PREFILL_OUTPUT_CAP;
  const body = truncated ? r.output.slice(0, PREFILL_OUTPUT_CAP) + '\n\n…(truncated — see archive)' : r.output;
  const lines: string[] = [];
  lines.push('<external-research>');
  lines.push(`  <topic>${r.topic}</topic>`);
  lines.push(`  <skill>${r.skill}</skill>`);
  if (route) {
    lines.push(`  <output_format>${route.format}</output_format>`);
    lines.push(`  <question_weight source="${route.weightSource}">${route.weight}</question_weight>`);
    lines.push(`  <output_route_observation>${JSON.stringify(route.observation)}</output_route_observation>`);
    if (route.skillCallPlan) {
      lines.push(`  <output_skill>${route.skillCallPlan.skill}</output_skill>`);
      lines.push('  <output_skill_args>');
      lines.push(route.skillCallPlan.args);
      lines.push('  </output_skill_args>');
    }
    if (route.fallbackReason) lines.push(`  <output_route_fallback>${route.fallbackReason}</output_route_fallback>`);
  }
  lines.push(`  <duration_ms>${r.durationMs}</duration_ms>`);
  lines.push(`  <ok>${r.ok}</ok>`);
  lines.push(`  <output>`);
  lines.push(body);
  lines.push(`  </output>`);
  lines.push('</external-research>');
  lines.push('');
  lines.push('Use the research above as cited context. Continue with: ');
  return lines.join('\n');
}
