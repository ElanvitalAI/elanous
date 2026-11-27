// ── SEAT-CONTEXT-BUDGET-WINDOW — window-relative turn input cap + human-preserving trim ──
//
// Root cause (harness ablation 11-26): the turn input cap was a flat 24k (DEFAULT_TOKEN_BUDGET) while the
// OP seat's fixed system prefix alone is ~25k tokens. trimToBudget then kept only the last two rows, so
// the seat answered the current CEO line with zero history (ablation B 0/5 → previous turn restored 5/5).
//
// The cap is now measured ON TOP of the fixed prefix: cap = prefix + history allowance, where the
// allowance is (model window × 0.85 − prefix − reserved output), clamped to [floor, ceiling]. The prefix
// can therefore never starve history. Under pressure the trim keeps, verbatim: every system row, the
// anchor, the last N human turns (from.kind === 'human') and the assistant replies paired with them,
// and the latest turn. Only then are the oldest paired replies given up; human turns are never dropped.

/** Share of the model context window a single request may use. */
export const WINDOW_INPUT_RATIO = 0.85;
/** Configured ceiling for the history share (cost guard: prompt cache keeps the prefix cheap, history is not). */
export const HISTORY_CEILING_TOKENS = 48_000;
/** Floor for the history share — small-window models still keep the recent conversation. */
export const HISTORY_FLOOR_TOKENS = 8_000;
/** History share when the model window is unknown (the old flat budget, now on top of the prefix). */
export const HISTORY_UNKNOWN_WINDOW_TOKENS = 24_000;
/** Human turns kept verbatim under any pressure. */
export const KEEP_HUMAN_TURNS = 6;

export interface TurnInputCap {
  cap: number;
  prefixTokens: number;
  historyAllowance: number;
  window: number | null;
}

export function resolveTurnInputCap(input: {
  window: number | null | undefined;
  prefixTokens: number;
  outputTokens?: number;
  ceiling?: number;
  floor?: number;
}): TurnInputCap {
  const ceiling = input.ceiling ?? HISTORY_CEILING_TOKENS;
  const floor = Math.min(input.floor ?? HISTORY_FLOOR_TOKENS, ceiling);
  const prefixTokens = Math.max(0, Math.ceil(input.prefixTokens));
  const window = input.window && input.window > 0 ? input.window : null;
  let historyAllowance: number;
  if (window === null) {
    historyAllowance = Math.max(floor, Math.min(ceiling, HISTORY_UNKNOWN_WINDOW_TOKENS));
  } else {
    // The floor never lifts the request past the real window: prefix + history + output reserve ≤ window
    // (Terra r1). With no room left the allowance is 0 and the trim reports overBudget → the turn stops.
    const room = Math.floor(window * WINDOW_INPUT_RATIO) - (input.outputTokens ?? 0) - prefixTokens;
    const hardRoom = Math.max(0, window - (input.outputTokens ?? 0) - prefixTokens);
    historyAllowance = Math.min(hardRoom, Math.max(floor, Math.min(ceiling, room)));
  }
  return { cap: prefixTokens + historyAllowance, prefixTokens, historyAllowance, window };
}

/** Window-relative turn-start compaction trigger: record ≥ 50% of the history share, or the measured
 *  input ≥ 85% of the cap. */
export function shouldCompactForWindow(historyTokens: number, fullInputTokens: number, cap: TurnInputCap): boolean {
  return historyTokens >= cap.historyAllowance * 0.5 || fullInputTokens >= cap.cap * 0.85;
}

/** A stored row that came from a human: from.kind === 'human', or a legacy user row with no `from` that is
 *  not a tool result. */
export function isHumanSourceRow(row: { role: string; from?: { kind?: string } | null; toolResult?: unknown; toolCallId?: string }): boolean {
  if (row.role !== 'user') return false;
  if (row.from) return row.from.kind === 'human';
  return row.toolResult === undefined && row.toolCallId === undefined;
}

interface WireLike { role: string; content: string | unknown[]; cacheVolatile?: boolean }

export interface HumanPreservingTrim<T> {
  kept: T[];
  dropped: number;
  used: number;
  keptHumanTurns: number;
  overBudget: boolean;
}

/**
 * Trim the assembled wire to `capTokens`. `isHuman(i)` marks wire rows that came from a human
 * (from.kind === 'human'). Order of sacrifice: (1) oldest unprotected rows, (2) oldest assistant replies
 * paired with kept human turns. System rows, the anchor (first user row), the last `keepHumans` human
 * rows and the latest turn (last user row onward) are never dropped.
 */
export function trimKeepingRecentHumans<T extends WireLike>(
  wire: T[],
  capTokens: number,
  measure: (messages: T[]) => number,
  isHuman: (index: number) => boolean,
  keepHumans: number = KEEP_HUMAN_TURNS,
): HumanPreservingTrim<T> {
  const firstUser = wire.findIndex(m => m.role === 'user');
  let lastUser = -1;
  for (let i = wire.length - 1; i >= 0 && lastUser < 0; i--) if (wire[i]!.role === 'user') lastUser = i;
  const humanIdx: number[] = [];
  for (let i = wire.length - 1; i >= 0 && humanIdx.length < keepHumans; i--) if (wire[i]!.role === 'user' && isHuman(i)) humanIdx.push(i);
  const keptHumans = new Set(humanIdx);
  const paired = new Set<number>();
  for (const h of keptHumans) {
    for (let j = h + 1; j < wire.length && wire[j]!.role !== 'user'; j++) {
      if (wire[j]!.role === 'assistant') { paired.add(j); break; }
    }
  }
  const hard = (i: number) => wire[i]!.role === 'system' || i === firstUser || keptHumans.has(i) || (lastUser >= 0 && i >= lastUser);
  const removed = new Set<number>();
  const current = () => wire.filter((_, i) => !removed.has(i));
  let used = measure(wire);
  for (let i = 0; i < wire.length && used > capTokens; i++) {
    if (hard(i) || paired.has(i)) continue;
    removed.add(i);
    used = measure(current());
  }
  for (let i = 0; i < wire.length && used > capTokens; i++) {
    if (hard(i) || !paired.has(i)) continue;
    removed.add(i);
    used = measure(current());
  }
  let keptHumanTurns = 0;
  for (let i = 0; i < wire.length; i++) if (!removed.has(i) && wire[i]!.role === 'user' && isHuman(i)) keptHumanTurns++;
  return { kept: current(), dropped: removed.size, used, keptHumanTurns, overBudget: used > capTokens };
}

/**
 * TURN-BUDGET-FLOOR (11-26 23:3x · OP lost 13 turns in 60 min to `session.compact over-budget`): inside one long turn the
 * rows after its user message — tool calls and their results — are all protected, so a busy turn outgrows the cap and
 * the next round dies. This stubs the tool results of the current turn except the last `keepLast` (each stub keeps its
 * size and first line, so the model knows something was there and can re-run the tool). Pure; the wire order is kept.
 */
export function stubTurnToolPayloads<T extends WireLike>(wire: readonly T[], keepLast: number, minChars = 400): { wire: T[]; stubbed: number } {
  let lastUser = -1;
  for (let i = wire.length - 1; i >= 0 && lastUser < 0; i--) if (wire[i]!.role === 'user') lastUser = i;
  const tools: number[] = [];
  for (let i = lastUser + 1; i < wire.length; i++) if (wire[i]!.role === 'tool' && typeof wire[i]!.content === 'string') tools.push(i);
  const stubAt = new Set(tools.slice(0, Math.max(0, tools.length - keepLast)));
  let stubbed = 0;
  const out = wire.map((m, i) => {
    if (!stubAt.has(i) || (m.content as string).length <= minChars) return m;
    const text = m.content as string;
    stubbed++;
    const first = text.split('\n', 1)[0]!.slice(0, 160);
    return { ...m, content: `[tool output held back — over the turn budget · ${text.length.toLocaleString('en-US')} chars · first line: ${first}] Re-run the tool if you still need it.` };
  });
  return { wire: out, stubbed };
}

/** The ladder of protections to give up, in order, when a turn is over budget (TURN-BUDGET-FLOOR). */
export const BUDGET_FLOOR_STEPS: ReadonlyArray<{ readonly step: string; readonly keepHumans: number; readonly keepToolResults?: number }> = [
  { step: 'keep-humans:3', keepHumans: 3 },
  { step: 'keep-humans:1', keepHumans: 1 },
  { step: 'keep-humans:0', keepHumans: 0 },
  { step: 'tool-results:last-4', keepHumans: 0, keepToolResults: 4 },
  { step: 'tool-results:last-1', keepHumans: 0, keepToolResults: 1 },
  { step: 'tool-results:none', keepHumans: 0, keepToolResults: 0 },
];

/**
 * Walk {@link BUDGET_FLOOR_STEPS} over one built wire: the first step whose trim fits wins. null = none fits (the caller
 * goes on to shrink the newest turn, then fails as before). `isHuman` indexes the built wire (stubbing keeps positions).
 */
export function applyBudgetFloor<T extends WireLike>(built: readonly T[], capTokens: number, measure: (messages: T[]) => number, isHuman: (index: number) => boolean):
  { step: string; trimmed: HumanPreservingTrim<T>; stubbed: number } | null {
  for (const floor of BUDGET_FLOOR_STEPS) {
    const stub = floor.keepToolResults === undefined ? { wire: [...built], stubbed: 0 } : stubTurnToolPayloads(built, floor.keepToolResults);
    const trimmed = trimKeepingRecentHumans(stub.wire, capTokens, measure, isHuman, floor.keepHumans);
    if (!trimmed.overBudget) return { step: floor.step, trimmed, stubbed: stub.stubbed };
  }
  return null;
}
