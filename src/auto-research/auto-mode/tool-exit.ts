import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S4 P5: ExitAutoMode LLM tool ──
//
// Symmetric counterpart to EnterAutoMode. Optionally writes an
// executive summary via ResearchPlan before tearing down state.


import {
  discoverObsidianVault,
  type ObsidianVault,
} from '../obsidian-bridge.js';
import { dispatchResearchPlan } from '../tools/research-plan.js';
import {
  getAutoModeState,
  setAutoModeState,
} from './session.js';
import {
  INACTIVE_AUTO_MODE_STATE,
  type AutoModeExitReason,
  type AutoModeState,
} from './types.js';

export interface ExitAutoModeInput {
  reason?: AutoModeExitReason;
  summary?: string;
}

export interface ExitAutoModeResult {
  output: string;
  final_state?: AutoModeState;
  summary_path?: string;
}

export interface ExitAutoModeDispatchOpts {
  vault?: ObsidianVault;
}

/** Minimum evidence-summary length for a `termination_met` completion
 *  claim (§5-②/2). Short enough not to burden a genuine summary, long
 *  enough to reject an empty/token gesture. */
export const TERMINATION_MET_MIN_SUMMARY = 40;

export async function dispatchExitAutoMode(
  raw: Record<string, unknown>,
  opts: ExitAutoModeDispatchOpts = {},
): Promise<ExitAutoModeResult> {
  const current = getAutoModeState();
  if (!current.active) {
    return { output: 'ExitAutoMode failed: auto-mode is not active.' };
  }

  const reason = (typeof raw.reason === 'string' ? raw.reason : 'manual') as AutoModeExitReason;
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  let summaryPath: string | undefined;

  // §5-②/2 — a completion claim must carry evidence. `termination_met`
  // asserts the objective conditions are satisfied; require a summary
  // documenting that evidence so the model can't silently self-declare
  // done. The loop-prompt Completion Audit tells it to do exactly this.
  if (reason === 'termination_met' && summary.length < TERMINATION_MET_MIN_SUMMARY) {
    return {
      output:
        'ExitAutoMode rejected: reason="termination_met" requires a `summary` '
        + `(≥${TERMINATION_MET_MIN_SUMMARY} chars) documenting the evidence that each `
        + 'objective completion condition is satisfied — completion is treated as '
        + 'unproven without it. Provide `summary` and retry, or use reason="manual" '
        + 'to stop without a completion claim.',
    };
  }

  if (summary && current.goalSlug) {
    const vault = opts.vault ?? discoverObsidianVault();
    try {
      const res = await dispatchResearchPlan(
        { action: 'write_summary', goal_slug: current.goalSlug, summary },
        { vault },
      );
      summaryPath = `${res.goalRoot}/executive-summary.md`;
    } catch (err) {
      return {
        output: `ExitAutoMode: summary write failed (${(err as Error).message}) — state not torn down.`,
      };
    }
  }

  const finalState: AutoModeState = {
    ...current,
    active: false,
    exitReason: reason,
    exitDiagnostic: summary ? `summary written (${summary.length} chars)` : 'no summary',
  };
  setAutoModeState(finalState);
  // Full reset to INACTIVE after recording — tests/operators can read
  // finalState from this response, but subsequent getAutoModeState()
  // should report idle.
  setAutoModeState({ ...INACTIVE_AUTO_MODE_STATE });

  return {
    output:
      `ExitAutoMode: reason=${reason}; session=${current.sessionId ?? '?'}; turns=${current.turnIndex}/${current.maxTurns}.`
      + (summaryPath ? ` Summary: ${summaryPath}` : ''),
    final_state: finalState,
    ...(summaryPath ? { summary_path: summaryPath } : {}),
  };
}

// ── LLM tool spec ──────────────────────────────────────────────────────

export function buildExitAutoModeTool(): LLMToolSpec {
  return {
    name: 'ExitAutoMode',
    description:
      'Leave the autonomous research loop. `reason` records why the loop ended '
      + '(manual, termination_met, budget_tripped, max_turns, error). Claiming '
      + 'reason="termination_met" REQUIRES a `summary` documenting the evidence that '
      + 'each objective completion condition is satisfied — completion is treated as '
      + 'unproven otherwise and the call is rejected. For other reasons `summary` is '
      + 'optional; when provided it is written to executive-summary.md via ResearchPlan '
      + '(idempotent) before state is torn down.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: ['manual', 'termination_met', 'budget_tripped', 'max_turns', 'error'],
        },
        summary: { type: 'string', description: 'Optional executive summary body.' },
      },
      additionalProperties: false,
    },
  };
}
