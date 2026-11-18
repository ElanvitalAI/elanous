/**
 * Seat-mail arrival wiring, pulled out of entry.ts so the busy/idle door is a seam.
 * A notice that lands while a turn is running stays queued. The idle door (injectKey)
 * opens only when nothing is running. This path never offers the running turn a steer.
 */

import { emitTurnLife } from '../debug/turn-life.js';

export interface SeatMailOnArrivedDeps {
  busy: () => boolean;
  injectKey: (key: unknown) => boolean | void;
  queueWake: unknown;
}

export function seatMailOnArrived(deps: SeatMailOnArrivedDeps): () => void {
  return () => {
    if (deps.busy()) {
      // OBSERVE-TURN-EVENT-LIFECYCLE — 바쁜 턴: 알림은 큐에 대기, 턴 끝의 노크가 연다(이 모듈은 관측만).
      try { emitTurnLife('turn-life:event-while-busy', { source: 'seat-mail', action: 'wait' }); } catch { /* observability is fail-open */ }
      return;
    }
    deps.injectKey(deps.queueWake);
  };
}
