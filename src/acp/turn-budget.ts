// SEAT-TURN-FULL-BUDGET (대표 11-25 16:2x «regex 가 문제를 키운다 · 상한이라도 기본값이 너무 작다») — the per-turn tool budget
// of a bridged core turn, as one pure decision the bridge and the sim device both call.
//
// S: FACT1 (#23034 · 10-03) gave MEMBER chat a 6-round fact-question budget ⊕ a «search 1–2× and answer» instruction, and
//    the quick TUI routes narrowed the tool pool — all from sentence regex (`isFactQuestion` · `classifyTuiChatIntent`).
// C: a federation seat's turn reached the same verdicts: a CEO line «지금 … 운영중인가요?» became a 6-round fact turn told
//    to stop early. The old fears stay real for members (latency of a one-line question · the old goal loop nagging after
//    a budget refusal) — CHAT-GOAL-LOOP-DEFAULT-OFF stays.
// Q: which turns may a sentence shape budget?
// A: never a seat turn (structured: the resolved seat or the seat launcher's env). A seat turn gets full tools, no fact
//    instruction, and one generous safety cap ({@link SEAT_TURN_MAX_TOOL_ROUNDS}); member chat is unchanged (the full
//    regex removal is cell TURN-BUDGET-NO-REGEX).

/**
 * The safety cap of one seat turn's tool rounds — aligned with the reference agents (~/source/ref): codex · opencode ·
 * openclaw loop until the model stops calling tools (codex-rs core/src/session/turn.rs:737
 * `needs_follow_up = model_needs_follow_up || has_pending_input`, no counter), grok-cli caps at 400, hermes at 500.
 * None shrinks the budget from the user's sentence. Runaway is the repeat guards' job, not a low cap.
 */
export const SEAT_TURN_MAX_TOOL_ROUNDS = 400;

/** The seat a seat launcher declared for this process (`COORD_ID` · `ELANOUS_TRACK`) — null for a member session. */
export function seatFromEnv(env: NodeJS.ProcessEnv): string | null {
  const value = (env.COORD_ID ?? env.ELANOUS_TRACK ?? '').trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) ? value.toUpperCase() : null;
}

export interface TurnBudgetInput {
  /** The sentence verdict (`isFactQuestion`) — consulted for member turns only. */
  readonly factShaped: boolean;
  /** Structured: this turn runs as a federation seat. */
  readonly seatTurn: boolean;
  readonly armGoalLoop: boolean;
  /** The surface profile is the multi-source research agent. */
  readonly researchAgent: boolean;
  /** The goal-loop research budget applies (harness executor only). */
  readonly goalLoopResearch: boolean;
  /** The route verdict is a quick route (not coding / read, no goal loop) — its allowlist would narrow the tools. */
  readonly quickRoute: boolean;
  readonly explicitMaxToolTurns?: number;
  /** `chat.factQuestion.maxToolTurns`. */
  readonly factMaxToolTurns: number;
  /** RESEARCH_TURN_MAX_TOOL_TURNS. */
  readonly researchMaxToolTurns: number;
}

export interface TurnBudget {
  readonly factQuestion: boolean;
  readonly narrowTools: boolean;
  /** undefined = the family default of the tool loop. */
  readonly maxToolTurns?: number;
}

export function decideTurnBudget(input: TurnBudgetInput): TurnBudget {
  const factQuestion = input.factShaped && !input.armGoalLoop && !input.seatTurn && !input.researchAgent;
  const resolved = input.explicitMaxToolTurns ?? (factQuestion ? input.factMaxToolTurns
    : input.goalLoopResearch ? input.researchMaxToolTurns
    : input.seatTurn ? SEAT_TURN_MAX_TOOL_ROUNDS : undefined);
  const maxToolTurns = input.goalLoopResearch && resolved !== undefined ? Math.min(resolved, input.researchMaxToolTurns) : resolved;
  return { factQuestion, narrowTools: input.quickRoute && !input.seatTurn, ...(maxToolTurns !== undefined ? { maxToolTurns } : {}) };
}
