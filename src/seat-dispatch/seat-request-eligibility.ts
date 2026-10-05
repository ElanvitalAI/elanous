export const DEFAULT_MAX_REQUEST_AGE_HOURS = 48;

export type SeatRequestEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'empty-body' | 'too-old' | 'slot-closed' };

/** Unknown/unreadable slot status does not establish that a slot has closed. */
export function seatRequestEligibility(
  request: { text: string; queuedAt: string },
  options: { now: Date; maxRequestAgeHours?: number; slotStatus?: string | null },
): SeatRequestEligibility {
  if (!request.text.trim()) return { eligible: false, reason: 'empty-body' };
  const maxAgeHours = options.maxRequestAgeHours ?? DEFAULT_MAX_REQUEST_AGE_HOURS;
  if (!Number.isFinite(maxAgeHours) || maxAgeHours < 0) throw new Error('invalid seat request max age hours');
  const age = options.now.getTime() - Date.parse(request.queuedAt);
  if (!Number.isFinite(age) || age > maxAgeHours * 60 * 60_000) return { eligible: false, reason: 'too-old' };
  if (options.slotStatus === 'green' || options.slotStatus === 'done') return { eligible: false, reason: 'slot-closed' };
  return { eligible: true };
}
