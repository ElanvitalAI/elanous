import { emitTurnLife } from '../debug/turn-life.js';

export type CapsuleCallOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'failed'; error: unknown }
  | { status: 'timeout' };

export type CapsuleCallStart<T> =
  | { state: 'completed'; outcome: CapsuleCallOutcome<T> }
  | { state: 'started'; capsuleId: string };

/**
 * Own an already-started operation. The same promise is observed after detachment; it is never restarted.
 * The caller owns durable result delivery and must keep the host alive until `onDone` settles.
 * A deadline reports timeout once; the adapter must supply cancellation if the underlying operation supports it.
 */
export function waitOrDetach<T>(options: {
  capsuleId: string;
  operation: Promise<T>;
  syncCapMs: number;
  deadlineMs: number;
  onDone: (outcome: CapsuleCallOutcome<T>) => void | Promise<void>;
  onTimeout?: () => void;
  onDeliveryError: (error: unknown, outcome: CapsuleCallOutcome<T>) => void;
  log?: (event: string, data: Record<string, unknown>) => void;
}): Promise<CapsuleCallStart<T>> {
  if (!options.capsuleId || !Number.isFinite(options.syncCapMs) || options.syncCapMs < 0
    || !Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
    throw new RangeError('capsule id and finite non-negative sync cap / positive deadline required');
  }
  return new Promise((resolve) => {
    let detached = false;
    let finished = false;
    const log = (event: string): void => {
      try { (options.log ?? emitTurnLife)(event, { capsuleId: options.capsuleId }); } catch { /* observational */ }
    };
    const syncTimer = setTimeout(() => {
      if (finished) return;
      detached = true;
      log('turn-life:capsule-detached');
      resolve({ state: 'started', capsuleId: options.capsuleId });
    }, options.syncCapMs);
    const deadlineTimer = setTimeout(() => {
      try { options.onTimeout?.(); } catch { /* timeout still settles */ }
      finish({ status: 'timeout' });
    }, options.deadlineMs);
    function finish(outcome: CapsuleCallOutcome<T>): void {
      if (finished) return;
      finished = true;
      clearTimeout(syncTimer);
      clearTimeout(deadlineTimer);
      if (!detached) { resolve({ state: 'completed', outcome }); return; }
      log('turn-life:capsule-completed');
      void Promise.resolve().then(() => options.onDone(outcome)).catch((error) => {
        try { options.onDeliveryError(error, outcome); } catch { /* caller's recovery also failed */ }
      });
    }
    options.operation.then((value) => finish({ status: 'ok', value }), (error) => finish({ status: 'failed', error }));
  });
}
