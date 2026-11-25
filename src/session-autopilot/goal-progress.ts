// Goal-scoped, monotonic progress evidence. Unknown or incomparable observations fail closed.
// This deliberately does not infer progress from a global ledger fingerprint.
export interface ChecklistCountObservation {
  readonly goalId: string;
  readonly version: string;
  readonly status: string;
  readonly target: number;
  readonly count: number;
}

/** Only increasing the requested checklist count toward its own target establishes progress. */
export function checklistCountProgress(before: ChecklistCountObservation | undefined, after: ChecklistCountObservation | undefined): boolean {
  if (!before || !after || !before.goalId || !before.version || !before.status) return false;
  if (before.goalId !== after.goalId || before.version !== after.version || before.status !== after.status || before.target !== after.target) return false;
  if (![before.count, after.count, before.target].every(Number.isSafeInteger)) return false;
  if (before.count < 0 || after.count < 0 || before.target <= 0) return false;
  return before.count < before.target && after.count > before.count;
}

/** Keep the maximum, never the latest count: a fall and rebound cannot buy another continuation. */
export function observeChecklistHighWater(
  highWater: ChecklistCountObservation | undefined,
  observation: ChecklistCountObservation | undefined,
): { highWater: ChecklistCountObservation | undefined; progress: boolean } {
  if (!observation || !observation.goalId || !observation.version || !observation.status
    || !Number.isSafeInteger(observation.count) || observation.count < 0
    || !Number.isSafeInteger(observation.target) || observation.target <= 0) {
    return { highWater, progress: false };
  }
  if (!highWater) return { highWater: observation, progress: false };
  const progress = checklistCountProgress(highWater, observation);
  return { highWater: progress ? observation : highWater, progress };
}
