import type { ChecklistItem } from '../../release-loop/checklist.js';
import type { OrchestratorSeat } from '../../user-config.js';

const SEATS: readonly OrchestratorSeat[] = ['OP', 'TC', 'MK', 'UX'];
type WorkCell = Pick<ChecklistItem, 'owner' | 'status'>;

/** Allocate whole base slots by remaining work; this calculation does not decide launches. */
export function calculateSeatBaseShares({ totalSlots, currentRound, nextRound, seatCaps }: {
  totalSlots: number;
  currentRound: readonly WorkCell[];
  nextRound: readonly WorkCell[];
  seatCaps: Readonly<Record<OrchestratorSeat, number>>;
}): Record<OrchestratorSeat, number> {
  if (!Number.isSafeInteger(totalSlots) || totalSlots < 0 ||
    SEATS.some(seat => !Number.isSafeInteger(seatCaps[seat]) || seatCaps[seat] < 0)) {
    throw new RangeError('totalSlots and seatCaps must be nonnegative safe integers');
  }
  const shares: Record<OrchestratorSeat, number> = { OP: 0, TC: 0, MK: 0, UX: 0 };
  const weights: Record<OrchestratorSeat, number> = { OP: 0, TC: 0, MK: 0, UX: 0 };
  for (const [cells, weight] of [[currentRound, 2], [nextRound, 1]] as const) {
    for (const cell of cells) {
      if (cell.status !== 'yellow') continue;
      const seat = cell.owner?.split('/')[0];
      if (SEATS.some(id => id === seat)) weights[seat as OrchestratorSeat] += weight;
    }
  }

  let available = Math.min(totalSlots, SEATS.reduce((sum, seat) => sum + seatCaps[seat], 0));
  let eligible = SEATS.filter(seat => weights[seat] > 0 && seatCaps[seat] > 0);
  while (available > 0 && eligible.length > 0) {
    const totalWeight = eligible.reduce((sum, seat) => sum + weights[seat], 0);
    const ideal = (seat: OrchestratorSeat) => available * weights[seat] / totalWeight;
    const capped = eligible.filter(seat => ideal(seat) >= seatCaps[seat]);
    if (capped.length > 0) {
      for (const seat of capped) {
        shares[seat] = seatCaps[seat];
        available -= seatCaps[seat];
      }
      eligible = eligible.filter(seat => !capped.includes(seat));
      continue;
    }
    const remainders = eligible.map(seat => ({ seat, exact: ideal(seat) }));
    for (const { seat, exact } of remainders) {
      shares[seat] = Math.floor(exact);
      available -= shares[seat];
    }
    remainders.sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)));
    for (const { seat } of remainders) {
      if (available === 0) break;
      shares[seat]++;
      available--;
    }
    break;
  }
  return shares;
}
