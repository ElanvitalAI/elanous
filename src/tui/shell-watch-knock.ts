/**
 * TURN-FUNDAMENTAL O1 — parent TUI seam for background shell watch lines (TC #92447 · TC-H-CX-2 인계 #92526 · 자식 #38775 짝).
 * A background RunShell watch match (capsuleId `shell-watch:…`) becomes ONE queued notice and ONE knock on the
 * idle door, so a person sees `감시 줄: …` without opening a turn themselves. Same pattern as capsule-done-knock
 * (CAPSULE-B1): the notice is the doorbell; the queue dedupes by notice text, and this seam additionally dedupes
 * per capsule so a replayed progress frame never knocks twice. Later matches from the same watch stay silent —
 * the capsule keeps running and its completion arrives through the CAPSULE-B1 door.
 *
 * Pure module: no entry.ts import. The entry wiring (notice source id `event-watch`) lands separately after the
 * HOT-FILE-LEASE handover — patch seat-state/TC-H-CX-2/evidence/o1-scratch-entry.patch, real-PTY test
 * o1-parent-next-tui-pty.test.ts.
 */
import type { CapsuleEvent } from '../turn-capsule/contract.js';
import { emitTurnLife } from '../debug/turn-life.js';

export interface ShellWatchKnockDeps {
  readonly sessionId: string;
  /** Subscribes to the seat's CapsuleEvent stream; returns the unsubscribe. */
  readonly subscribe: (sessionId: string, listener: (event: CapsuleEvent) => void) => () => void;
  /** Queues the notice text; falsy = already queued (duplicate). */
  readonly enqueue: (text: string, at: number) => unknown;
  readonly knock: () => void;
}

/** Returns the unsubscribe. */
export function wireShellWatchKnock(deps: ShellWatchKnockDeps): () => void {
  const seen = new Set<string>();
  return deps.subscribe(deps.sessionId, (event) => {
    if (event.type !== 'capsule-progress') return;
    if (event.kind !== 'shell' || !event.capsuleId.startsWith('shell-watch:')) return;
    if (event.sessionId !== deps.sessionId) return;
    if (seen.has(event.capsuleId)) return;
    seen.add(event.capsuleId);
    const queued = deps.enqueue(`감시 줄: ${event.line}`, event.at);
    emitTurnLife('turn-life:event-arrived', {
      sessionId: deps.sessionId, capsuleId: event.capsuleId, source: 'watch', queued: Boolean(queued),
    });
    if (queued) deps.knock();
  });
}
