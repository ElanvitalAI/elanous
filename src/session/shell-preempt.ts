/**
 * RUNSHELL-BG-ENDS-TURN ① (대표 safeguard for the 60 s shell wait) — an urgent steer that lands while a shell call holds
 * the turn in its foreground wait detaches that command to the background at once (completion wake armed) so the turn
 * proceeds with the steer. Turn-local signal per session, like urgent-steer.ts; listeners receive no body.
 *
 * Urgency is structured only (the same fields the seat-mail steer path carries — never the sender name, never prose):
 *   - a person's typed line (a steer with no seat-mail source),
 *   - a crown directive relay (`crownDirective`),
 *   - decision mail (`intent: 'decision'` — the existing urgent steer) and alert mail (`intent: 'alert'` — ✋ hand raise,
 *     incident/P0 alerts normalise to this intent at post time).
 */
import type { PendingSeatMailSource } from './pending-input.js';

const listeners = new Map<string, Set<() => void>>();

export function onShellPreempt(sessionId: string, listener: () => void): () => void {
  const group = listeners.get(sessionId) ?? new Set<() => void>();
  group.add(listener);
  listeners.set(sessionId, group);
  return () => {
    group.delete(listener);
    if (group.size === 0) listeners.delete(sessionId);
  };
}

export function signalShellPreempt(sessionId: string): void {
  for (const listener of [...(listeners.get(sessionId) ?? [])]) listener();
}

/** Does this steer preempt a foreground shell wait? Structured fields only. */
export function steerPreemptsShell(seatMail: PendingSeatMailSource | undefined, urgent = false): boolean {
  if (urgent) return true;
  if (seatMail === undefined) return true; // a person's own typed line
  if (typeof seatMail.crownDirective === 'string' && seatMail.crownDirective.length > 0) return true;
  return seatMail.intent === 'decision' || seatMail.intent === 'alert';
}
