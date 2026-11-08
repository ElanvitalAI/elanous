import type { LLMToolSpec } from '../llm/tool-spec.js';
// ExitPlanMode tool — Phase WF4.
//
// Opens a 3-way modal with the drafted plan body + three actions:
//   implement — leave plan mode, restore the prior policy, keep the
//               plan text in the LLM tool_result so the model uses it
//               directly for the next turns.
//   handoff   — WF6 plugs in /compact here; for now, save the plan
//               artifact, return a marker the caller (dashboard's
//               chat loop) knows how to act on.
//   cancel    — keep plan mode active; nothing changes.


import type { DisplayCoordinator } from '../display/coordinator.js';
import { approvalModalRouter } from '../approval-modal.js';
import { createPlanExitModal, type PlanExitChoice } from './exit-modal.js';
import { loadPlanArtifactFromPath } from './persistence.js';
import { getPlanModeState, resetPlanModeState } from './session.js';
import { setPolicy } from '../code-edit/safety.js';
import { setPlanToolPlanModeGuard } from '../code-edit/plan-tool.js';

export interface ExitPlanModeDeps {
  coordinator: DisplayCoordinator;
  termSize: () => { cols: number; rows: number };
  /** Hook the dashboard fills in when WF6 /compact lands. When
   *  omitted, the handoff path returns an instructional message and
   *  behaves like 'implement' for policy restoration. */
  onHandoff?: (planBody: string, planFilePath: string, sessionId: string) => void | Promise<void>;
}

let deps: ExitPlanModeDeps | null = null;

export function setExitPlanModeDeps(d: ExitPlanModeDeps | null): void {
  deps = d;
}

export function getExitPlanModeDeps(): ExitPlanModeDeps | null {
  return deps;
}

export function buildExitPlanModeTool(): LLMToolSpec {
  return {
    name: 'ExitPlanMode',
    description:
      'Exit plan mode. Opens a user modal with the drafted plan body and 3 actions: Implement now (keep '
      + 'this session, restore normal editing), Save + new session (persist the plan, compact context, '
      + 'fresh start for implementation), or Cancel (stay in plan mode). Call this once the plan is '
      + 'decision-complete — goal, approach, steps, risks, and test plan are all filled in. Do NOT use '
      + 'as "should I proceed?" — the text output of this tool already is the approval flow.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  };
}

export interface ExitPlanModeResult {
  output: string;
  choice?: PlanExitChoice;
  planFilePath?: string;
}

export async function dispatchExitPlanMode(
  _raw: Record<string, unknown>,
): Promise<ExitPlanModeResult> {
  const s = getPlanModeState();
  if (!s.active) {
    return { output: 'ExitPlanMode failed: plan mode is not active.' };
  }
  if (!deps) {
    return { output: 'ExitPlanMode failed: TUI deps not wired.' };
  }

  const artifact = await loadPlanArtifactFromPath(s.planFilePath);
  // Wave P3b · A6-1 — let-binding so Ctrl-E external editor can
  // refresh the cached body. The follow-up `implement` / `handoff`
  // branches read from this same variable, so an edit made inside
  // the modal flows through to the LLM tool_result and the handoff
  // payload.
  let planBody = artifact?.body ?? '(plan file could not be read)';
  const title = s.title ?? artifact?.title ?? '(untitled)';

  const { cols, rows } = deps.termSize();
  const width = Math.min(100, Math.max(50, cols - 6));
  const height = Math.min(Math.max(16, rows - 4), rows - 2);
  const bounds = {
    row: Math.max(1, Math.floor((rows - height) / 2)),
    col: Math.max(1, Math.floor((cols - width) / 2)),
    width, height,
  };

  const modal = createPlanExitModal({
    id: `plan-exit:${Date.now().toString(36)}`,
    bounds,
    title,
    planBody,
    onRequestExternalEdit: async () => {
      try {
        const { launchEditor, canLaunchEditor } = await import('../editor-launcher.js');
        if (!canLaunchEditor()) return null;
        const result = await launchEditor(s.planFilePath);
        if (!result.ok) return null;
        const fresh = await loadPlanArtifactFromPath(s.planFilePath);
        return fresh?.body ?? null;
      } catch {
        return null;
      }
    },
    onPlanBodyUpdated: (next) => { planBody = next; },
  });
  // B-3c pilot #3 (2026-04-21) — typed primitive push. The typed
  // type `'plan-exit-modal'` is pre-registered in B-3a's
  // APP_MODAL_TYPES. Coord's mounted/disposed reverse-wiring
  // (B-3b Part 2) drives upsertSurface + closeSurface, so this
  // call site no longer needs display.pushModal(surface).
  // Generalizes the B-3b/B-3c#2 pattern to a third caller
  // (plan-mode dialog) — plan-exit-modal shares the
  // approvalModalRouter with ask-user-question-modal, so their
  // typed-push migrations have the same shape. Session A turf
  // 0 touch; single-file change in src/plan-mode/.
  const primitiveHandle = deps.coordinator.modalLifecycleAPI().push(
    'plan-exit-modal',
    { idempotencyKey: 'plan-exit' },
    modal.surface,
  );
  const disposePrimitive = () => {
    if (primitiveHandle && !primitiveHandle.isDisposed()) {
      try { primitiveHandle.dispose(); } catch { /* ignore */ }
    }
  };
  const installed = approvalModalRouter.set(modal as any, disposePrimitive, 'planExit');
  if (!installed) {
    modal.dispose('cancel');
    disposePrimitive();
    return { output: 'ExitPlanMode failed: another approval/question is already open.' };
  }

  const choice = await modal.promise;

  if (choice === 'cancel') {
    return { output: 'ExitPlanMode: cancelled — plan mode is still active.' };
  }

  // implement + handoff both leave plan mode. Policy + plan-tool guard
  // restoration is common to both paths.
  const snapshotPath = s.planFilePath;
  const snapshotSession = s.sessionId;
  setPolicy(s.previousPolicy);
  setPlanToolPlanModeGuard(null);
  resetPlanModeState();

  if (choice === 'implement') {
    return {
      output:
        `ExitPlanMode: implementing now.\n\n`
        + `Plan file: ${snapshotPath}\n\n`
        + `--- PLAN BEGIN ---\n${planBody}\n--- PLAN END ---\n\n`
        + `Now start the implementation using Edit/Write against the real source files.`,
      choice,
      planFilePath: snapshotPath,
    };
  }

  if (choice === 'goal-loop') {
    // FU-6 (2026-05-05) — plan body → /goal objective handoff.
    // Converts the plan into a Ralph-loop drive: the model sees
    // "implement this plan, judge against the steps as success
    // criteria". Plan body is preserved in the chat output so the
    // model has the steps; goal registry tracks turn budget.
    const { startGoal } = await import('../goals/index.js');
    const objective = (title && title !== '(untitled)')
      ? `Implement the plan: ${title}`
      : 'Implement the plan as drafted';
    const r = startGoal({ objective, mode: 'judge' });
    if (!r.ok) {
      return {
        output:
          `ExitPlanMode: goal-loop drive aborted — ${r.error.message}\n`
          + `(Use /goal clear first, or pick Implement now / Save + new session instead.)`,
        choice,
        planFilePath: snapshotPath,
      };
    }
    return {
      output:
        `ExitPlanMode: goal-loop drive engaged.\n\n`
        + `Goal: "${objective}" (id ${r.goal.id} · budget ${r.goal.budget.maxTurns} turns)\n`
        + `Plan file: ${snapshotPath}\n\n`
        + `--- PLAN BEGIN ---\n${planBody}\n--- PLAN END ---\n\n`
        + `Implement the plan above. After each turn, the goal-judge will`
        + ` decide whether the plan is complete (verdict: done) or needs more`
        + ` work (continue/partial). The Ralph loop will auto-continue until`
        + ` done, budget is exhausted, or the user preempts (Esc / type).`,
      choice,
      planFilePath: snapshotPath,
    };
  }

  // handoff path — trigger the dashboard's /compact bridge if wired.
  try {
    if (deps.onHandoff) {
      await deps.onHandoff(planBody, snapshotPath, snapshotSession);
    }
  } catch { /* don't let a handoff hook failure stall the tool */ }

  return {
    output:
      `ExitPlanMode: plan saved for handoff.\n\n`
      + `Plan file: ${snapshotPath}\n`
      + (deps.onHandoff
        ? `Context will compact and a fresh session will take over. The next turn will be primed with the plan body.`
        : `/compact bridge not yet wired (pre-WF6). Open a new session and prime with the plan file.`),
    choice,
    planFilePath: snapshotPath,
  };
}
