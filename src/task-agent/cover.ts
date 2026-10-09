import type { NextActionKind } from './actions.js';

type CoverVerb = 'land' | 'review' | 'retry' | 'green';
export interface CoverRow {
  verb: CoverVerb;
  /** null means the TASK-AGENT action source could not be fully read. */
  byTaskAgent: number | null;
  /** Total work by all seats; null when no independent denominator is available. */
  total: number | null;
  /** TASK-AGENT events observed for this verb, including non-done outcomes; null if unreadable. */
  observedActions: number | null;
  ratio: number | null;
  state: 'measured' | 'no-denominator' | 'unreadable';
  /** Non-shadow action events, including failures; null if the action source is incomplete. */
  liveActions: number | null;
  /** Shadow action events; null if the action source is incomplete. */
  shadowActions: number | null;
  /** A transition is observable only with an independent denominator and a completed TA action. */
  stewardTransition: 'observed' | 'not-observed' | 'unmeasured';
}

/** null means the source could not be read; [] means it was read and had no matching events. */
export interface TaskAgentCoverInput {
  taskAgentActions: readonly { kind: NextActionKind; result: string }[] | null;
  allLands: readonly { step: string; ok: boolean }[] | null;
  /** A source reached the query safety limit; its aggregate is not known to be complete. */
  truncated?: { taskAgentActions: boolean; allLands: boolean };
}

/** Only land has an independent denominator. The other three verbs have no hand-work source yet. */
export function measureTaskAgentCover(input: TaskAgentCoverInput): CoverRow[] {
  const verbs: CoverVerb[] = ['land', 'review', 'retry', 'green'];
  return verbs.map((verb) => {
    const actions = input.taskAgentActions?.filter((action) => action.kind === verb);
    const actionsUnreadable = actions === undefined || input.truncated?.taskAgentActions === true;
    const byTaskAgent = actionsUnreadable ? null : actions.filter((action) => action.result === 'done').length;
    const observedActions = actionsUnreadable ? null : actions.length;
    const liveActions = actionsUnreadable ? null : actions.filter((action) => action.result !== 'shadow').length;
    const shadowActions = actionsUnreadable ? null : actions.filter((action) => action.result === 'shadow').length;
    const counts = { liveActions, shadowActions };
    if (verb !== 'land') return {
      verb, byTaskAgent, total: null, observedActions, ratio: null,
      state: actionsUnreadable ? 'unreadable' : 'no-denominator',
      ...counts, stewardTransition: 'unmeasured' as const,
    };
    const total = input.allLands === null || input.truncated?.allLands
      ? null : input.allLands.filter((land) => land.step === 'merge' && land.ok === true).length;
    const state = actionsUnreadable || total === null ? 'unreadable'
      : total === 0 ? 'no-denominator' : 'measured';
    const ratio = state === 'measured' && byTaskAgent !== null && total !== null ? byTaskAgent / total : null;
    return { verb, byTaskAgent, total, observedActions, ratio, state, ...counts,
      stewardTransition: ratio === null ? 'unmeasured' : byTaskAgent !== null && byTaskAgent > 0 ? 'observed' : 'not-observed',
    };
  });
}

/** A single human-readable line per verb; unknown numbers are never rendered as zero. */
export function formatTaskAgentCover(row: CoverRow): string {
  const value = (count: number | null): string => count === null ? '-' : String(count);
  return `${row.verb}: TA ${value(row.byTaskAgent)}/${value(row.total)} (${row.ratio === null ? '-' : `${(row.ratio * 100).toFixed(1)}%`}) · live ${value(row.liveActions)} · shadow ${value(row.shadowActions)} · steward-transition ${row.stewardTransition}`;
}
