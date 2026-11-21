// SAME-UID-SEAT-ISOLATION (0.3.32 P0, first slice): seats share one OS UID, so the kernel cannot tell them
// apart. The door can: a seat acting on a pane that ANOTHER seat owns is denied unless the owner shared it.
// Pure decider — no I/O. Ownership data is supplied by the transport via ControlTarget.ownerSeat/sharedWith.
import type { ControlTarget } from './control.js';

export interface SeatBoundaryDecision { readonly allow: boolean; readonly reason: string }

export function sameUidSeatBoundary(actorSeat: string | undefined, target: Pick<ControlTarget, 'ownerSeat' | 'sharedWith'>): SeatBoundaryDecision {
  if (!actorSeat) return { allow: true, reason: 'no-seat-actor' };
  // Ownership unknown keeps today's behavior; recorded as residual (fail-open until the registry fills it).
  if (!target.ownerSeat) return { allow: true, reason: 'ownership-unknown' };
  if (actorSeat === target.ownerSeat) return { allow: true, reason: 'same-seat' };
  // OP already commands every pane by the coded default rules (control.ts defaultDecision).
  if (actorSeat === 'OP') return { allow: true, reason: 'op-supervisor' };
  if (target.sharedWith?.includes(actorSeat)) return { allow: true, reason: 'shared-by-owner' };
  return { allow: false, reason: `same-uid seat boundary: pane owned by seat ${target.ownerSeat}, not shared with ${actorSeat}` };
}
