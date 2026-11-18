/**
 * Seat-mail arrival wiring, pulled out of entry.ts so the busy/idle door is a seam.
 * A notice that lands while a turn is running stays queued. The idle door (injectKey)
 * opens only when nothing is running. This path never offers the running turn a steer.
 */

export interface SeatMailOnArrivedDeps {
  busy: () => boolean;
  injectKey: (key: unknown) => boolean | void;
  queueWake: unknown;
}

export function seatMailOnArrived(deps: SeatMailOnArrivedDeps): () => void {
  return () => {
    if (deps.busy()) return;
    deps.injectKey(deps.queueWake);
  };
}
