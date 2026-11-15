/** Bound a train worker stop to one observed host and slot. No process discovery or signal occurs here. */
export interface TrainWorkerIdentity {
  host: string;
  slot: number;
  pid: number;
  startToken: string;
}

export interface TrainStopScope extends TrainWorkerIdentity {
  reason: string;
}

export interface TrainStopAdapter {
  observe(host: string, slot: number): Promise<TrainWorkerIdentity | undefined>;
  /** Atomically verify this full identity at the signal boundary; never signal a bare PID. */
  stopIfCurrent(scope: TrainStopScope): Promise<boolean>;
}

const HOST = /^[a-z][a-z0-9-]{0,62}$/u;
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/u;

function validWorker(value: TrainWorkerIdentity): boolean {
  return HOST.test(value.host) && Number.isSafeInteger(value.slot) && value.slot > 0
    && value.slot <= 99 && Number.isSafeInteger(value.pid) && value.pid > 0
    && TOKEN.test(value.startToken);
}

/** The expected identity must come from an earlier trusted observation, never a loose PID search. */
export function planTrainStopScope(expected: TrainWorkerIdentity, reason: string): TrainStopScope {
  if (!validWorker(expected) || !reason.trim()) throw new Error('invalid train stop identity or reason');
  return { ...expected, reason: reason.trim() };
}

/** Reobserve immediately before stopping; a replaced process or slot fails closed. */
export async function stopTrainSlot(scope: TrainStopScope, adapter: TrainStopAdapter): Promise<boolean> {
  if (!validWorker(scope) || !scope.reason.trim()) throw new Error('invalid train stop scope');
  const current = await adapter.observe(scope.host, scope.slot);
  if (!current || !validWorker(current) || current.host !== scope.host || current.slot !== scope.slot
    || current.pid !== scope.pid || current.startToken !== scope.startToken) return false;
  return adapter.stopIfCurrent(scope);
}
