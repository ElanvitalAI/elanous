/**
 * SEAT-GRACEFUL-QUIT-CONTROL — the one place a seat-stop request reaches the running TUI.
 *
 * The control channel (pty_control_requests `seat-stop{migrate|quit|force}` · CX-12) calls `requestSeatStop`; the
 * running Next TUI registers the handler (entry.ts, the hot-file lease holder) and drives `createSeatControl`:
 * quit/migrate wait for the turn end, force aborts now. With no TUI registered the request is refused, never queued.
 * Ctrl+Q stays the last rung of the ladder (command migrate/quit → command force → key) and does not pass here.
 */
import type { SeatControlMode } from '../seat/seat-control.js';

export interface SeatStopRequest {
  readonly requestId: string;
  readonly mode: SeatControlMode;
}

export type SeatStopResult = 'waiting' | 'accepted' | 'missing-session' | 'already-requested' | 'no-tui' | 'failed';

type Handler = (request: SeatStopRequest) => Promise<SeatStopResult>;

let handler: Handler | null = null;

/** The running TUI registers itself; the returned function unregisters (only if it is still the registered one). */
export function setSeatStopHandler(next: Handler): () => void {
  handler = next;
  return () => { if (handler === next) handler = null; };
}

export async function requestSeatStop(request: SeatStopRequest): Promise<SeatStopResult> {
  const current = handler;
  if (!current) return 'no-tui';
  try { return await current(request); } catch { return 'failed'; }
}

/** The slice of `createSeatControl` the driver needs (CX-12 #38638). */
export interface SeatControlLike {
  request(mode: SeatControlMode, busy: boolean, session?: string): Promise<'waiting' | 'accepted' | 'missing-session' | 'already-requested'>;
  turnEnded(): Promise<void>;
}

/**
 * JUD #38658 ⓑ: once a stop is decided, no turn may open while the checkpoint (async disk I/O) runs — otherwise the
 * turn-end knocks reach the loop first, a new turn starts, the seat-stop key then waits on it, and Ctrl+Q · force are
 * stuck behind it. `stopping` is set synchronously (before any await) when a stop starts: at an idle request, or at the
 * turn end of a waiting quit/migrate. A failed checkpoint lifts it again (the seat keeps working).
 */
export function createSeatStopDriver(deps: { control: SeatControlLike; busy: () => boolean; capsulesActive?: () => boolean }) {
  let waiting = false;
  let stopping = false;
  return {
    async request(request: SeatStopRequest, session?: string): Promise<SeatStopResult> {
      const busy = deps.busy() || Boolean(deps.capsulesActive?.());
      const before = stopping;
      if (request.mode === 'force' || !busy) stopping = true;
      try {
        const result = await deps.control.request(request.mode, busy, session);
        if (result === 'waiting') waiting = true;
        if (result === 'missing-session' || result === 'already-requested') stopping = before;
        return result;
      } catch (error) {
        stopping = before;
        throw error;
      }
    },
    /** Call at the turn end (busy → false), before anything can knock the door. */
    async turnEnded(): Promise<void> {
      if (!waiting || deps.busy() || deps.capsulesActive?.()) return;
      waiting = false;
      stopping = true;
      try { await deps.control.turnEnded(); } catch (error) { stopping = false; throw error; }
    },
    allowsNewTurn: (): boolean => !stopping,
  };
}
