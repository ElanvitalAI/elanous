import type { LLMToolSpec } from '../llm/tool-spec.js';
// EnterPlanMode tool — Phase WF4.
//
// Flips Elanous into plan mode: save previous code-edit policy, init
// a plan artifact, publish the session transition. Does NOT require
// any parameters — optional initialTitle just lets the artifact
// frontmatter start with something more descriptive than "(untitled)".


import { getPolicy, setPolicy } from '../code-edit/safety.js';
import type { ApprovalPolicy } from '../code-edit/types.js';
import { setPlanToolPlanModeGuard } from '../code-edit/plan-tool.js';
import { getPlanModeState, setPlanModeState, generatePlanSessionId } from './session.js';
import { initPlanArtifact } from './persistence.js';
import { INACTIVE_PLAN_MODE_STATE } from './types.js';
import { getUserConfig } from '../user-config.js';
import { enterWorktreeRuntime } from '../tool-runtime/git-worktree-runtimes.js';
import { debug } from '../debug/log.js';

export function buildEnterPlanModeTool(): LLMToolSpec {
  return {
    name: 'EnterPlanMode',
    description:
      'Enter plan mode — a read-only planning phase. Only the plan file is writable; Edit / Write on any '
      + 'other path are refused. Use this proactively when the user asks for a non-trivial task, when '
      + 'multiple approaches are plausible, or when requirements are vague. Once in plan mode: explore '
      + 'the codebase with Read/Grep, use AskUserQuestion to clarify intent, draft the plan by editing '
      + 'the plan file, then call ExitPlanMode to hand off. Do NOT use plan mode for trivial single-step '
      + 'requests — just do them.',
    parameters: {
      type: 'object',
      properties: {
        initialTitle: {
          type: 'string',
          description: 'Short title for the plan artifact frontmatter — usually the user\'s original ask in one line.',
        },
      },
      additionalProperties: false,
    },
  };
}

export interface EnterPlanModeResult {
  output: string;
  planFilePath?: string;
  sessionId?: string;
  /** Coding Pipeline P4 followup — present when `plan.autoWorktree`
   *  is enabled and the auto-flip succeeded. Tells the LLM (and tests)
   *  that subsequent Read/Edit/Write resolve against this dir. */
  worktreePath?: string;
  worktreeBranch?: string;
}

export async function dispatchEnterPlanMode(
  raw: Record<string, unknown>,
): Promise<EnterPlanModeResult> {
  if (getPlanModeState().active) {
    return { output: 'EnterPlanMode failed: plan mode is already active — call ExitPlanMode first.' };
  }
  const initialTitle = typeof raw.initialTitle === 'string' && raw.initialTitle.trim()
    ? raw.initialTitle.trim()
    : '(untitled)';
  const sessionId = generatePlanSessionId();
  const planFilePath = await initPlanArtifact({ sessionId, title: initialTitle });

  const previousPolicy: ApprovalPolicy = getPolicy();
  // Unsupervised while in plan mode — the write gate is the real
  // control; code-edit approvals would double-prompt the user on
  // every edit against the plan file.
  setPolicy({ mode: 'unsupervised' });

  setPlanModeState({
    ...INACTIVE_PLAN_MODE_STATE,
    active: true,
    sessionId,
    startedAt: Date.now(),
    phase: 'explore',
    planFilePath,
    previousPolicy,
    title: initialTitle,
  });

  // Block update_plan while plan mode is active (Codex's rule —
  // spec-draft vs progress-checklist are distinct phases).
  setPlanToolPlanModeGuard(() =>
    'plan mode is active — update_plan is a progress checklist for execution phase, not spec drafting. '
    + 'Write the plan into the plan file via Edit instead.');

  // Coding Pipeline P4 followup — auto-create a worktree so plan-mode
  // exploration is staged on its own branch + dir. Opt-in via
  // user-config `plan.autoWorktree`. Failure to enter worktree is NOT
  // fatal — plan mode still proceeds in place; we attach a notice line
  // so the LLM sees what happened.
  let worktreeNote = '';
  let worktreePath: string | undefined;
  let worktreeBranch: string | undefined;
  try {
    if (getUserConfig().plan.autoWorktree === true) {
      // The runtime synthesises a `session/<timestamp>-<slug>` branch
      // when autoBranch=true; pass the plan title as topic.
      const r = await enterWorktreeRuntime.run(
        { autoBranch: true, topic: initialTitle === '(untitled)' ? 'plan' : initialTitle },
        { surface: 'tui' },
      );
      worktreePath = r.path;
      worktreeBranch = r.branch;
      worktreeNote = `\nAuto worktree → ${r.path} (branch ${r.branch})`;
      debug.log('plan.autoWorktree', 'success', {
        sessionId,
        path: r.path,
        branch: r.branch,
      });
    }
  } catch (err) {
    worktreeNote = `\nAuto worktree skipped: ${err instanceof Error ? err.message : String(err)}`;
    debug.log('plan.autoWorktree', 'failure', {
      sessionId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    output:
      `EnterPlanMode: session ${sessionId}\n`
      + `Plan file: ${planFilePath}${worktreeNote}\n`
      + `Workflow: Explore (Read/Grep) → Intent (AskUserQuestion) → Design (Edit the plan file) → ExitPlanMode`,
    planFilePath,
    sessionId,
    ...(worktreePath ? { worktreePath, worktreeBranch } : {}),
  };
}
