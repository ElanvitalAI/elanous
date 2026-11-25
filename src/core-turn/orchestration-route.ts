// DEMO-FANOUT-LIVE-OP-SEAT (0.3.36 P0 · demo-check 11-25 S2): an orchestration request — one that hands work to other
// agents (els tabs via ElsControl, subagents via Agent) — is not a research question. The research/grounding route used
// to take it whenever the text also said «research» («split into 3 research tabs»): the coordinator then answered by
// itself with no tool call, «미확인» and raw search links. The verdict here is structural, never a sentence classifier:
//   ① the caller is a coordinator seat (OP / the declared HQ coordinator) and an orchestration tool is in the live pool;
//   ② the person's text names an orchestration tool that is in the live pool (exact tool name, as a whole token).
//   ③ the caller runs in a worker pane another agent opened (ELANOUS_ELS_PARENT_PANE): its task has a return path.

/** Tools that hand work to other agents. The verdict only counts the ones actually in the turn's pool. */
export const ORCHESTRATION_TOOL_NAMES: ReadonlySet<string> = new Set(['ElsControl', 'Agent']);

export type OrchestrationSkipReason = 'orchestration-tool-named' | 'coordinator-orchestrates' | 'delegated-worker';

/** Whole tokens of the text (letters, digits, underscore) — the same split a tool name is written in. */
function tokens(text: string): ReadonlySet<string> {
  return new Set(text.split(/[^\p{L}\p{N}_]+/u).filter(Boolean));
}

/**
 * Why this turn skips the research route because it is an orchestration request, or null.
 * `coordinatorSeats` = the seats that coordinate (OP and the declared HQ coordinator); a seatless caller is never one.
 * `delegatedWorker` = this process runs in a pane another agent opened as its worker (els sets ELANOUS_ELS_PARENT_PANE):
 * its task carries a return path (mail the result back), which the text-only research route cannot take — the ordinary
 * tool loop researches with the same web tools and then reports.
 */
export function orchestrationSkipReason(
  userText: string | undefined,
  seat: string | null,
  toolNames: readonly string[],
  coordinatorSeats: ReadonlySet<string>,
  delegatedWorker = false,
): OrchestrationSkipReason | null {
  if (delegatedWorker) return 'delegated-worker';
  const pool = toolNames.filter((name) => ORCHESTRATION_TOOL_NAMES.has(name));
  if (pool.length === 0) return null;
  const words = tokens(userText ?? '');
  if (pool.some((name) => words.has(name))) return 'orchestration-tool-named';
  if (seat && coordinatorSeats.has(seat.toUpperCase())) return 'coordinator-orchestrates';
  return null;
}

/** OP always coordinates; federation.yaml / the els journal may name another HQ coordinator seat. Fail-open to OP alone. */
export function coordinatorSeatSet(declaredHq: () => string | undefined): ReadonlySet<string> {
  const seats = new Set(['OP']);
  try {
    const hq = declaredHq()?.trim().toUpperCase();
    if (hq) seats.add(hq);
  } catch { /* an unreadable declaration leaves OP as the one coordinator */ }
  return seats;
}
