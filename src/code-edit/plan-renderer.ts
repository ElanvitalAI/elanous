// update_plan ✔/▶/○ board renderer — Phase WF2.
//
// Dashboard subscribes to subscribePlanUpdate and pushes the
// rendered rows into chatLines on every state change. Stateless
// pure function — state comes in via argument.
//
// IDX-6 Phase 6 migration (2026-04-19) — glyphs route through
// theme-icons so ELANOUS_ASCII_ICONS=1 and preset-specific IconTokens
// overrides apply automatically. `noColor` path still uses the raw
// glyph string (no ANSI prefix) so logs / test snapshots stay clean.

import { C } from '../tui.js';
import { icon } from '../theme/icons.js';
import type { PlanState, PlanStep } from './plan-tool.js';

export interface PlanRenderOptions {
  noColor?: boolean;
}

export function renderPlanBoard(state: PlanState, opts: PlanRenderOptions = {}): string[] {
  if (state.steps.length === 0) return [];
  const no = opts.noColor === true;
  const rows: string[] = [];

  const title = no
    ? `●  Plan${state.lastExplanation ? ` — ${state.lastExplanation}` : ''}`
    : `${C.accent('●')}  ${C.bold('Plan')}${state.lastExplanation ? C.muted(` — ${state.lastExplanation}`) : ''}`;
  rows.push(title);

  const numW = String(state.steps.length).length;
  for (let i = 0; i < state.steps.length; i++) {
    const step = state.steps[i]!;
    const idx = String(i + 1).padStart(numW, ' ');
    const glyph = glyphFor(step.status, no);
    const stepText = truncate(step.step, 80);
    const body = no ? stepText : colourFor(step.status)(stepText);
    rows.push(`  ${glyph} ${idx}. ${body}`);
  }
  return rows;
}

function glyphFor(status: PlanStep['status'], noColor: boolean): string {
  // IDX-6 Phase 6 — route through theme-icons. Each status maps to
  // the closest IconTokens slot:
  //   completed   → 'done'     (✅ default, [v] ASCII)
  //   in_progress → 'running'  (▶  default, [>] ASCII)
  //   pending     → 'backlog'  (⚪ default, [ ] ASCII)
  const glyph =
    status === 'completed' ? icon('done')
    : status === 'in_progress' ? icon('running')
    : status === 'blocked' ? icon('error')
    : status === 'waiting' ? icon('warning')
    : icon('backlog');
  if (noColor) return glyph;
  return colourFor(status)(glyph);
}

function colourFor(status: PlanStep['status']) {
  return status === 'completed' ? C.success
    : status === 'in_progress' ? C.accent
    : status === 'blocked' ? C.error
    : status === 'waiting' ? C.warning
    : C.muted;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}
