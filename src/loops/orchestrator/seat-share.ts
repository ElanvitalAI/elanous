import type { ChecklistItem } from '../../release-loop/checklist.js';
import type { OrchestratorSeat } from '../../user-config.js';
import { calculateSeatBaseShares as budgetSeatBaseShares } from '../budget.js';

/** Existing orchestrator callers keep their signature; the resource loop owns the decision. */
export function calculateSeatBaseShares(input: {
  totalSlots: number;
  currentRound: readonly Pick<ChecklistItem, 'owner' | 'status'>[];
  nextRound: readonly Pick<ChecklistItem, 'owner' | 'status'>[];
  seatCaps: Readonly<Record<OrchestratorSeat, number>>;
}): Record<OrchestratorSeat, number> {
  return budgetSeatBaseShares(input);
}
