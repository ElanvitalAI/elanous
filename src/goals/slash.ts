// /goal slash command — Plan-Mode UX P1.3.
//
// Pure decision function: takes a tokenized arg array (already split
// by the dashboard) + the current registry state, returns a structured
// outcome the dispatcher renders to chatLines. No I/O, no LLM here —
// just state-machine routing. The dispatcher (dashboard/index.ts)
// imports executeGoalSlash() which does the actual register mutation
// + judge-loop trigger.

import {
  clearGoal,
  getCurrentGoal,
  isGoalActive,
  isOverBudget,
  setBudget,
  setStatus,
  startGoal,
} from './registry.js';
import { buildGoalStatusSummary } from './continuation.js';
import {
  goalLoopActionForActiveGoal,
  isGoalLoopContinuationAction,
  type GoalLoopAction,
} from './chat-loop-bridge.js';
import type { GoalMode } from './types.js';

export type GoalSlashOutcome =
  | { kind: 'message'; lines: string[] }
  | {
      kind: 'started';
      lines: string[];
      objective: string;
      mode: GoalMode;
      goalLoopAction: GoalLoopAction['kind'];
    }
  | { kind: 'resumed'; lines: string[] }
  | { kind: 'paused'; lines: string[] }
  | { kind: 'cleared'; lines: string[]; prevId: string }
  | { kind: 'error'; lines: string[] };

export interface GoalSlashInput {
  /** Subcommand or first positional arg. Empty when user typed bare
   *  `/goal` — that maps to `status`. */
  subcommand: string;
  /** Remaining tokens after the subcommand. For `/goal <objective>`,
   *  subcommand IS the first word of the objective and `rest` carries
   *  the tail — so the executor concatenates `subcommand + ' ' + rest`
   *  when no recognized verb matches. */
  rest: string[];
  /** Default mode from user-config — used when `/goal <obj>` lacks
   *  explicit `mode`. */
  defaultMode: GoalMode;
  /** Full goals config snapshot (for /goal config + first-use tip). FU-8. */
  config?: {
    maxTurns: number;
    wallClockMaxMs: number;
    tokenBudget: number;
    judgeModel: string;
    judgeRetries: number;
    resumeOnPlanModeExit: boolean;
    modeDefault: GoalMode;
  };
}

const VERBS: ReadonlySet<string> = new Set([
  'status', 'pause', 'resume', 'clear', 'budget', 'mode', 'config', 'help', '',
]);

export function executeGoalSlash(input: GoalSlashInput): GoalSlashOutcome {
  const verb = input.subcommand.toLowerCase();

  // Bare `/goal` → status
  if (verb === '' || verb === 'status') {
    return statusOutcome();
  }

  if (verb === 'help' || verb === '?') {
    return helpOutcome();
  }

  if (verb === 'pause') {
    if (!isGoalActive()) {
      return { kind: 'error', lines: ['  /goal pause — no active goal.'] };
    }
    const r = setStatus('paused', 'user-pause');
    if (!r.ok) return { kind: 'error', lines: [`  ✗ ${r.error.message}`] };
    return { kind: 'paused', lines: [`  ⏸  Goal paused (${buildGoalStatusSummary(r.goal)})`] };
  }

  if (verb === 'resume') {
    const cur = getCurrentGoal();
    if (!cur) return { kind: 'error', lines: ['  /goal resume — no goal to resume.'] };
    if (cur.status === 'active') {
      return { kind: 'message', lines: [`  Goal already active. ${buildGoalStatusSummary(cur)}`] };
    }
    if (cur.status === 'complete') {
      return { kind: 'error', lines: ['  /goal resume — current goal is already complete. /goal clear first.'] };
    }
    if (isOverBudget()) {
      return { kind: 'error', lines: ['  /goal resume — over budget. Increase budget first.'] };
    }
    const r = setStatus('active', 'user-resume');
    if (!r.ok) return { kind: 'error', lines: [`  ✗ ${r.error.message}`] };
    return {
      kind: 'resumed',
      lines: [`  ▶  Goal set to active (${buildGoalStatusSummary(r.goal)}). Send a message to start the next turn.`],
    };
  }

  if (verb === 'clear') {
    const prev = clearGoal();
    if (!prev) return { kind: 'message', lines: ['  /goal clear — no goal to clear.'] };
    return { kind: 'cleared', lines: [`  Goal cleared (${prev.id}, status=${prev.status})`], prevId: prev.id };
  }

  if (verb === 'budget') {
    return handleBudget(input.rest);
  }

  if (verb === 'mode') {
    return handleMode(input.rest);
  }

  if (verb === 'config') {
    return handleConfig(input.config);
  }

  // Not a recognized verb — treat the entire input as a new objective.
  // `/goal <objective>` form. Reconstruct the original phrase.
  const objective = [input.subcommand, ...input.rest].join(' ').trim();
  if (!objective) {
    return { kind: 'error', lines: ['  /goal — usage: /goal <objective>  (or /goal help)'] };
  }
  const r = startGoal({ objective, mode: input.defaultMode });
  if (!r.ok) {
    return { kind: 'error', lines: [`  ✗ ${r.error.message}`] };
  }
  const lines = [
    `  🎯 Goal active — "${objective}"`,
    `  budget: ${r.goal.budget.maxTurns} turns · mode: ${r.goal.mode}`,
    `  Press Esc or type any message to preempt.`,
  ];
  // FU-8 — first-use tip when judgeModel is empty (default). Helps
  // user know they can override for cheaper / faster judge calls.
  if (input.config && !input.config.judgeModel.trim()) {
    lines.push(
      `  ⓘ  Tip: judge uses primary provider's default model. Set goals.judgeModel`,
      `      in ~/.config/elanous/config.json (or run /goal config to inspect)`,
      `      for a cheaper option (e.g. grok-4-fast / haiku-4-5 / gpt-4o-mini).`,
    );
  }
  return {
    kind: 'started',
    objective,
    mode: r.goal.mode,
    lines,
    goalLoopAction: goalLoopActionForActiveGoal(isGoalActive()),
  };
}

export function renderGoalSlashOutcomeLines(outcome: GoalSlashOutcome): string[] {
  if (outcome.kind !== 'started' || !isGoalLoopContinuationAction(outcome.goalLoopAction)) {
    return outcome.lines;
  }
  return [
    ...outcome.lines,
    `  ⓘ  Automatic continuation is armed; each completed assistant turn continues only when the active goal judge returns ${outcome.goalLoopAction}.`,
  ];
}

function handleConfig(cfg: GoalSlashInput['config']): GoalSlashOutcome {
  if (!cfg) {
    return {
      kind: 'message',
      lines: ['  /goal config — config snapshot unavailable in this surface.'],
    };
  }
  const wallSec = Math.round(cfg.wallClockMaxMs / 1000);
  return {
    kind: 'message',
    lines: [
      '  /goal config — current goals.* settings',
      '',
      `    maxTurns:             ${cfg.maxTurns}`,
      `    wallClockMaxMs:       ${cfg.wallClockMaxMs} (${wallSec}s)`,
      `    tokenBudget:          ${cfg.tokenBudget.toLocaleString()}${cfg.tokenBudget === 0 ? '  (no cap)' : ''}`,
      `    judgeModel:           ${cfg.judgeModel || '(primary provider default)'}`,
      `    judgeRetries:         ${cfg.judgeRetries}`,
      `    resumeOnPlanModeExit: ${cfg.resumeOnPlanModeExit}`,
      `    modeDefault:          ${cfg.modeDefault}`,
      '',
      '  Edit ~/.config/elanous/config.json under "goals" to override.',
    ],
  };
}

function statusOutcome(): GoalSlashOutcome {
  const cur = getCurrentGoal();
  if (!cur) {
    return { kind: 'message', lines: ['  No active goal. /goal <objective> to start.'] };
  }
  const lines = [
    `  ${buildGoalStatusSummary(cur)}`,
    `  objective: "${cur.objective}"`,
    `  id: ${cur.id} · mode: ${cur.mode}`,
  ];
  if (cur.lastSummary) lines.push(`  last judge: "${cur.lastSummary}"`);
  if (cur.linkedTaskId) lines.push(`  linked task: ${cur.linkedTaskId}`);
  if (isOverBudget()) lines.push('  ⚠ over budget — loop will not auto-continue.');
  return { kind: 'message', lines };
}

function handleBudget(rest: string[]): GoalSlashOutcome {
  const cur = getCurrentGoal();
  if (!cur) return { kind: 'error', lines: ['  /goal budget — no active goal.'] };
  if (rest.length === 0) {
    return {
      kind: 'message',
      lines: [
        `  budget: ${cur.budget.maxTurns} turns · ${cur.budget.tokenBudget.toLocaleString()} tokens · ${Math.round(cur.budget.wallClockMaxMs / 1000)}s wall`,
        `  /goal budget <N>           — set turn budget`,
        `  /goal budget tokens=<N>    — set token budget (0 = no cap)`,
        `  /goal budget wall=<N>s     — set wall-clock budget in seconds`,
      ],
    };
  }
  if (rest.length > 1) {
    return { kind: 'error', lines: ['  ✗ /goal budget accepts exactly one value.'] };
  }
  const arg = rest[0]!;
  // Allow `tokens=200000` form
  if (arg.startsWith('tokens=')) {
    const n = parseInt(arg.slice('tokens='.length), 10);
    if (!Number.isFinite(n) || n < 0) return { kind: 'error', lines: [`  ✗ invalid token budget: ${arg}`] };
    const r = setBudget({ tokenBudget: n });
    if (!r.ok) return { kind: 'error', lines: [`  ✗ ${r.error.message}`] };
    return { kind: 'message', lines: [`  budget tokens → ${n.toLocaleString()}`] };
  }
  // Allow `wall=3600s` form; budget display uses seconds for wall-clock.
  if (arg.startsWith('wall=')) {
    const value = arg.slice('wall='.length);
    const match = /^(\d+)s$/.exec(value);
    const seconds = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
      return { kind: 'error', lines: [`  ✗ invalid wall-clock budget: ${arg}`] };
    }
    const r = setBudget({ wallClockMaxMs: seconds * 1000 });
    if (!r.ok) return { kind: 'error', lines: [`  ✗ ${r.error.message}`] };
    return { kind: 'message', lines: [`  budget wall-clock → ${seconds}s`] };
  }
  // Plain number → maxTurns
  const n = parseInt(arg, 10);
  if (!Number.isFinite(n) || n < 1) return { kind: 'error', lines: [`  ✗ invalid turn budget: ${arg}`] };
  const r = setBudget({ maxTurns: n });
  if (!r.ok) return { kind: 'error', lines: [`  ✗ ${r.error.message}`] };
  return { kind: 'message', lines: [`  budget turns → ${n}`] };
}

function handleMode(rest: string[]): GoalSlashOutcome {
  if (rest.length === 0) {
    const cur = getCurrentGoal();
    if (!cur) return { kind: 'error', lines: ['  /goal mode — no active goal. Specify mode in /goal <obj> or set goals.modeDefault.'] };
    return { kind: 'message', lines: [`  mode: ${cur.mode}  (judge | spec)`] };
  }
  const next = rest[0]!.toLowerCase();
  if (next !== 'judge' && next !== 'spec') {
    return { kind: 'error', lines: [`  /goal mode — must be 'judge' or 'spec', got: ${next}`] };
  }
  if (next === 'spec') {
    return {
      kind: 'message',
      lines: [
        '  Mode B (spec / Ouroboros) — deferred to P3 follow-up.',
        '  Currently only Mode A (judge / Ralph loop) is shipped.',
        '  See docs/archive/2026-05/ROADMAP-plan-mode-ux-goal-ralph-2026-05-05.md',
      ],
    };
  }
  // Mode change requires recreating the goal — for P1, just message.
  // P3 will add a true mode-switch transition.
  return { kind: 'message', lines: [`  mode: ${next}  (already default — change persists for next /goal start)`] };
}

function helpOutcome(): GoalSlashOutcome {
  return {
    kind: 'message',
    lines: [
      '  /goal — persistent cross-turn goal (Ralph loop / Plan-Mode UX P1)',
      '',
      '  /goal <objective>           start + drive auto-loop',
      '  /goal                       show status (alias /goal status)',
      '  /goal pause                 stop auto-continuation',
      '  /goal resume                resume after pause',
      '  /goal clear                 drop current goal',
      '  /goal budget <N>            set turn budget (also: tokens=<N>, wall=<N>s)',
      '  /goal mode <judge|spec>     mode hint (spec = P3 deferred)',
      '  /goal config                show current goals.* settings',
      '',
      '  Esc or any user input preempts the loop.',
      '  See: docs/research/RESEARCH-plan-mode-goal-ralph-loop-2026-05-05.md',
    ],
  };
}

// Shared with the catalog list known verbs (used by tests + help).
export const KNOWN_VERBS = VERBS;
