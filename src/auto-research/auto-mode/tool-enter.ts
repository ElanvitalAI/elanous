import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── PFC-S4 P5: EnterAutoMode LLM tool ──
//
// Enters the autonomous research loop for a goal. Gates:
//   1. Goal dir must exist (ResearchPlan init creates it — DD-S4-9).
//   2. Budget must not be tripped (DD-S4-4 + DD-S2-4).
//   3. Auto-mode must not already be active.
//
// On success, builds the initial loop-prompt snapshot, seeds the
// singleton session state, and returns the rendered prompt so the
// caller can inject it into the next LLM turn.

import { existsSync, readFileSync } from 'node:fs';

import {
  discoverObsidianVault,
  type ObsidianVault,
} from '../obsidian-bridge.js';
import { resolveGoalPaths } from '../goal-paths.js';
import { loadGoalBudget } from '../budget-loader.js';
import type { BudgetSnapshot } from '../budget-meter.js';
import { ExperimentLedger } from '../experiment-ledger.js';
import {
  buildLoopPromptSnapshot,
  parseQueuePending,
  renderLoopPromptInjection,
} from '../loop-prompt.js';
import { buildAxonTerminationSnapshot } from '../../axon/termination-snapshot.js';
import type { TerminationRule } from '../termination-dsl.js';
import {
  dispatchTerminationCheck,
} from '../tools/termination-check.js';
import {
  getAutoModeState,
  setAutoModeState,
  generateAutoModeSessionId,
} from './session.js';
import {
  AUTO_MODE_DEFAULT_MAX_TURNS,
  AUTO_MODE_HARD_MAX_TURNS,
  type AutoModeState,
} from './types.js';
import { buildAndonPreamble } from '../../cft/andon.js';
import { dispatchGoalKind } from '../../conductor/dispatch.js';
import type { GoalKind } from '../../conductor/types.js';
import type { DispatchResult } from '../../conductor/dispatch.js';
import { readActiveMd, writeActiveMd, type ActiveMdRecord } from '../active-md.js';

export interface EnterAutoModeInput {
  goal_slug: string;
  max_turns?: number;
  termination_override?: TerminationRule;
  /** PFC-S2 generalization — caller can supply raw natural-language
   *  intake; when given (and no existing ACTIVE.md record), the
   *  Conductor classifies + routes. Without it, existing `research`
   *  adapter is assumed (backward compat). */
  intake?: string;
  /** Operator override — skip classification, use this goalKind. */
  goal_kind?: GoalKind;
}

export interface EnterAutoModeResult {
  output: string;
  session_id?: string;
  goal_slug?: string;
  goal_root?: string;
  goal_kind?: GoalKind;
  max_turns?: number;
  turn_index?: number;
  loop_prompt?: string;
  termination_rule_source?: 'active_md' | 'override' | 'default';
  termination_should_terminate?: boolean;
  budget?: BudgetSnapshot;
  /** Conductor dispatch result — populated when classification ran. */
  conductor?: DispatchResult;
  notices?: string[];
}

export interface EnterAutoModeDispatchOpts {
  vault?: ObsidianVault;
  now?: number;
}

export async function dispatchEnterAutoMode(
  raw: Record<string, unknown>,
  opts: EnterAutoModeDispatchOpts = {},
): Promise<EnterAutoModeResult> {
  const notices: string[] = [];

  if (getAutoModeState().active) {
    return { output: 'EnterAutoMode failed: auto-mode is already active — call ExitAutoMode first.', notices };
  }

  const goalSlug = typeof raw.goal_slug === 'string' ? raw.goal_slug : undefined;
  if (!goalSlug) {
    return { output: 'EnterAutoMode failed: goal_slug is required.' };
  }

  const vault = opts.vault ?? discoverObsidianVault();
  const paths = resolveGoalPaths(vault, goalSlug);

  if (!existsSync(paths.goalRoot) || !existsSync(paths.active)) {
    return {
      output: `EnterAutoMode failed: goal '${goalSlug}' not initialised — call ResearchPlan with action='init' first.`,
    };
  }

  // Budget gate.
  const meter = loadGoalBudget(paths.budgetFile);
  const snap = meter.snapshot();
  if (snap.tripped.length > 0) {
    return {
      output: `EnterAutoMode failed: budget tripped on axes ${snap.tripped.join(', ')} — reset or raise caps first.`,
      budget: snap,
    };
  }

  // max_turns clamp.
  let maxTurns = AUTO_MODE_DEFAULT_MAX_TURNS;
  if (typeof raw.max_turns === 'number' && Number.isFinite(raw.max_turns)) {
    maxTurns = Math.max(1, Math.floor(raw.max_turns));
  }
  if (maxTurns > AUTO_MODE_HARD_MAX_TURNS) {
    notices.push(`max_turns ${maxTurns} clamped to ${AUTO_MODE_HARD_MAX_TURNS}`);
    maxTurns = AUTO_MODE_HARD_MAX_TURNS;
  }

  // Resolve termination rule via TerminationCheck tool so sourcing
  // logic stays in one place.
  const terminationInput: Parameters<typeof dispatchTerminationCheck>[0] = {
    goal_slug: goalSlug,
  };
  if (raw.termination_override && typeof raw.termination_override === 'object') {
    terminationInput.rule_override = raw.termination_override as TerminationRule;
  }
  let termination;
  try {
    termination = await dispatchTerminationCheck(terminationInput, { vault });
  } catch (err) {
    return { output: `EnterAutoMode failed: termination rule invalid — ${(err as Error).message}` };
  }

  // PFC-S2 generalization — classify intake when supplied, otherwise
  // honour existing ACTIVE.md record, otherwise default to 'research'
  // (backward compat: existing goals without ACTIVE.md keep shipping).
  let goalKind: GoalKind = 'research';
  let conductorResult: DispatchResult | undefined;
  let goalKindBlock: string | undefined;

  const existingActiveMd: ActiveMdRecord | null = readActiveMd(paths.goalRoot);
  const intakeRaw = typeof raw.intake === 'string' ? raw.intake : undefined;
  const forcedKind = typeof raw.goal_kind === 'string'
    ? (raw.goal_kind as GoalKind)
    : undefined;

  if (forcedKind) {
    goalKind = forcedKind;
    notices.push(`goal_kind overridden by caller: ${goalKind}`);
  } else if (intakeRaw) {
    // New classification — intake provided.
    conductorResult = await dispatchGoalKind({
      goalSlug,
      intake: { raw: intakeRaw, channel: 'chat' },
    });
    goalKind = conductorResult.classify.kind;
    goalKindBlock =
      `goalKind: **${goalKind}** `
      + `(classifier: ${conductorResult.classify.classifier}, `
      + `confidence: ${conductorResult.classify.confidence.toFixed(2)})\n`
      + `adapter: \`${conductorResult.adapter.adapter}\` `
      + `(status: ${conductorResult.adapter.status})`
      + (conductorResult.adapter.hint ? `\n\nHint: ${conductorResult.adapter.hint}` : '');

    // Persist ACTIVE.md (overwrites — this is the fresh classification).
    const record: ActiveMdRecord = {
      goalSlug,
      goalKind,
      intake: { raw: intakeRaw, channel: 'chat', requestedAt: opts.now ?? Date.now() },
      classifier: conductorResult.classify.classifier,
      confidence: conductorResult.classify.confidence,
      classifiedAt: opts.now ?? Date.now(),
      routedAdapter: conductorResult.adapter.adapter,
      ...(conductorResult.adapter.pendingTracks
        ? { pendingTracks: conductorResult.adapter.pendingTracks }
        : {}),
    };
    try { writeActiveMd(paths.goalRoot, record); }
    catch { notices.push('failed to write ACTIVE.md (continuing)'); }
  } else if (existingActiveMd) {
    goalKind = existingActiveMd.goalKind;
    goalKindBlock =
      `goalKind: **${goalKind}** (restored from ACTIVE.md, `
      + `classifier: ${existingActiveMd.classifier}, `
      + `confidence: ${existingActiveMd.confidence.toFixed(2)})`;
  }
  // else — default 'research'; no goalKindBlock so loop-prompt stays lean.

  // Build initial loop-prompt snapshot.
  const ledger = new ExperimentLedger(paths.goalRoot);
  const andonPreamble = buildAndonPreamble();

  // AXON F2 — compose the turn-level axonTermination snapshot.
  // At EnterAutoMode entry the "last turn" factors (stopReason /
  // pending tool calls / idempotent hashes) aren't observable yet,
  // but the structural factors (goal termination, budget, clarifying
  // questions, AnnounceCompletion) are. The detector treats missing
  // inputs as "unsatisfied", so the kickoff snapshot is conservative
  // and subsequent loop ticks can refine as per-turn data accrues.
  // paths.queue is absolute — read directly to sidestep the vault-
  // relative indirection in loop-prompt's own parser call. Missing
  // file ⇒ no pending questions (treated as "answered" for factor 4).
  let queueRaw = '';
  try { queueRaw = readFileSync(paths.queue, 'utf-8'); }
  catch { /* no queue yet — clarifyingAnswered=true */ }
  const pendingQuestions = parseQueuePending(queueRaw);
  const axonTermination = buildAxonTerminationSnapshot({
    goalSlug,
    goalTerminationMet: termination.should_terminate,
    budgetExhausted: snap.tripped.length > 0,
    clarifyingQuestionsAnswered: pendingQuestions.length === 0,
  });

  const loopSnap = await buildLoopPromptSnapshot({
    vault,
    goalSlug,
    goalRoot: paths.goalRoot,
    budget: meter,
    ledger,
    termination: termination.rule,
    ...(andonPreamble ? { andonPreamble } : {}),
    ...(goalKindBlock ? { goalKindBlock } : {}),
    axonTermination,
  });
  const rendered = renderLoopPromptInjection(loopSnap);

  // Seed session state.
  const sessionId = generateAutoModeSessionId();
  const nextState: AutoModeState = {
    active: true,
    sessionId,
    goalSlug,
    goalKind,
    startedAt: opts.now ?? Date.now(),
    maxTurns,
    turnIndex: 0,
    phase: 'kickoff',
    terminationRule: termination.rule,
    lastKickoffRendered: rendered,
  };
  setAutoModeState(nextState);

  return {
    output:
      `EnterAutoMode: session ${sessionId} on goal '${goalSlug}' — up to ${maxTurns} turns.\n`
      + `Termination rule source: ${termination.rule_source} (should_terminate=${termination.should_terminate}).\n`
      + `Budget: ${Object.keys(snap.remaining).length === 0 ? '(unlimited)' : snap.tripped.length + ' tripped, ' + snap.warning.length + ' warning'}.`,
    session_id: sessionId,
    goal_slug: goalSlug,
    goal_root: paths.goalRoot,
    goal_kind: goalKind,
    max_turns: maxTurns,
    turn_index: 0,
    loop_prompt: rendered,
    termination_rule_source: termination.rule_source,
    termination_should_terminate: termination.should_terminate,
    budget: snap,
    ...(conductorResult ? { conductor: conductorResult } : {}),
    notices: notices.length > 0 ? notices : undefined,
  };
}

// ── LLM tool spec ──────────────────────────────────────────────────────

export function buildEnterAutoModeTool(): LLMToolSpec {
  return {
    name: 'EnterAutoMode',
    description:
      'Enter autonomous research mode for a goal. The parent LLM will be driven turn-by-turn with the loop '
      + 'prompt (plan + open questions + wins + budget + NOW + termination) injected until the termination '
      + 'rule is met, the budget trips, or max_turns is reached. Call ResearchPlan action="init" before this '
      + 'to create the goal dir. Use ExitAutoMode to leave early. Runaway defence: max_turns hard-capped '
      + 'at 100; budget tripping refuses entry.',
    parameters: {
      type: 'object',
      properties: {
        goal_slug: { type: 'string', description: 'Goal directory slug (previously initialised).' },
        max_turns: { type: 'integer', description: 'Turn cap (default 20, max 100).' },
        termination_override: {
          type: 'object',
          description: 'Optional TerminationRule AST — overrides ACTIVE.md rule for this session.',
          additionalProperties: true,
        },
        intake: {
          type: 'string',
          description:
            'PFC-S2 generalization — natural-language business requirement. '
            + 'When provided and no ACTIVE.md exists yet, the Conductor classifies + routes the intake. '
            + 'Writes ACTIVE.md with classifier provenance. Omit for backward-compat (defaults to research).',
        },
        goal_kind: {
          type: 'string',
          enum: ['research', 'coding', 'analysis', 'monitoring', 'refactor'],
          description:
            'Operator override — skip classification and set goalKind directly. '
            + 'Useful when the intake is ambiguous or the user wants to force a specific adapter.',
        },
      },
      required: ['goal_slug'],
      additionalProperties: false,
    },
  };
}
