// Plan-mode toggle action — Plan-Mode UX P1.4.
//
// Tiny isolated module that the dashboard's Shift+Tab keybinding
// handler delegates to. Keeping the logic out of dashboard/index.ts
// (~11k LOC) means we can unit-test the decision branches without
// dragging the full dashboard into bun-test.
//
// State branches:
//   - plan inactive → dispatchEnterPlanMode + chat hint
//   - plan active   → chat hint + suggest /plan exit / ExitPlanMode
//                     (3-way modal needs surface deps the toggle
//                     handler doesn't have — kept simple here)
//   - streaming or modal-active → no-op (caller's `when` clause guards)

import { debug } from '../debug/log.js';
import { dispatchEnterPlanMode, getPlanModeState } from '../plan-mode/index.js';
import { isGoalActive, setStatus as setGoalStatus } from '../goals/index.js';

export type PlanToggleOutcome =
  | { kind: 'entered'; lines: string[]; sessionId: string; planFilePath: string }
  | { kind: 'already-active'; lines: string[]; sessionId: string }
  | { kind: 'failed'; lines: string[]; reason: string };

/** Synchronous decision — caller awaits when outcome.kind === 'entered'
 *  for the dispatch result.
 *
 *  Returns a Promise to keep the contract uniform regardless of branch.
 *  The caller (dashboard keybinding handler) pushes lines into chat
 *  and triggers a redraw. */
export async function togglePlanModeAction(opts: {
  initialTitle?: string;
} = {}): Promise<PlanToggleOutcome> {
  const state = getPlanModeState();

  if (state.active) {
    debug.log('plan-mode', 'toggle.already-active', { sessionId: state.sessionId });
    return {
      kind: 'already-active',
      sessionId: state.sessionId,
      lines: [
        `  📋 Plan mode active (session ${state.sessionId}, phase=${state.phase}).`,
        '  Use "/plan exit" or ask the assistant to call ExitPlanMode for the 3-way modal.',
      ],
    };
  }

  // Plan-mode UX D5 (PLAN doc) — pause active goal on plan-mode entry
  // (Codex pattern). Always on (CONFIG-ALWAYS-TRUE-OUT 11-05 removed goals.pauseOnPlanModeEnter).
  if (isGoalActive()) {
    setGoalStatus('paused', 'plan-mode-enter');
    debug.log('plan-mode', 'toggle.goal-paused', { reason: 'plan-mode-enter' });
  }

  try {
    const r = await dispatchEnterPlanMode(
      opts.initialTitle ? { initialTitle: opts.initialTitle } : {},
    );
    const planFilePath = r.planFilePath ?? '';
    const sessionId = r.sessionId ?? '';
    debug.log('plan-mode', 'toggle.entered', { sessionId, hasInitialTitle: !!opts.initialTitle });
    return {
      kind: 'entered',
      sessionId,
      planFilePath,
      lines: [
        `  📋 Plan mode entered (session ${sessionId}).`,
        `  Plan file: ${planFilePath}`,
        '  Use Read / Grep / AskUserQuestion to explore. Edit only the plan file.',
        '  When ready, call ExitPlanMode for the 3-way modal (Implement / New session / Cancel).',
      ],
    };
  } catch (err) {
    const message = (err as Error).message;
    debug.log('plan-mode', 'toggle.failed', { message }, { level: 'error' });
    return {
      kind: 'failed',
      reason: message,
      lines: [`  ✗ Plan mode entry failed: ${message}`],
    };
  }
}
