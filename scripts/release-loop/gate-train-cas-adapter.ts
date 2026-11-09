/** Thin adapter from the file-CAS receipt planner to the train gate's file lane. */
export type GateFilePlanLike<
  TMeasure extends { file: string } = { file: string },
  TReceipt extends { file: string; key: string; outcome: string } = { file: string; key: string; outcome: string },
> = { reuse: readonly TReceipt[]; measure: readonly TMeasure[] };

export type TrainGateCasLane =
  | { action: 'run-uncovered'; files: string[]; receiptKeys: string[]; knownNonPassingFiles: string[] }
  | { action: 'full-gate'; reason: string };

const HEX64 = /^[a-f0-9]{64}$/i;
const SAFE_REPO_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]+$/;

/**
 * Translate the canonical CAS planner output into the train runner's only input: files to measure.
 * The planner owns closure/image/key validation; this adapter checks only inventory shape and never
 * re-hashes or treats commit/base identity as a file receipt key.
 */
export function trainGateCasLane<TMeasure extends { file: string }, TReceipt extends { file: string; key: string; outcome: string }>(
  plan: GateFilePlanLike<TMeasure, TReceipt>, expectedFiles: readonly string[],
): TrainGateCasLane {
  if (!Array.isArray(plan?.reuse) || !Array.isArray(plan?.measure) || !expectedFiles.length)
    return { action: 'full-gate', reason: 'file-cas-plan-missing' };
  if (expectedFiles.some((file) => typeof file !== 'string' || !SAFE_REPO_PATH.test(file))
    || new Set(expectedFiles).size !== expectedFiles.length)
    return { action: 'full-gate', reason: 'file-cas-expected-inventory-invalid' };
  const expected = [...expectedFiles].sort();

  const reusedFiles: string[] = [];
  const receiptKeys: string[] = [];
  const knownNonPassingFiles: string[] = [];
  for (const row of plan.reuse) {
    if (!row || typeof row.file !== 'string' || !SAFE_REPO_PATH.test(row.file) || !HEX64.test(row.key)
      || !['pass', 'fail', 'error'].includes(row.outcome))
      return { action: 'full-gate', reason: 'file-cas-receipt-invalid' };
    reusedFiles.push(row.file);
    if (row.outcome === 'pass') receiptKeys.push(row.key.toLowerCase());
    else knownNonPassingFiles.push(row.file);
  }

  const measureFiles: string[] = [];
  for (const row of plan.measure) {
    if (!row || typeof row.file !== 'string' || !SAFE_REPO_PATH.test(row.file))
      return { action: 'full-gate', reason: 'file-cas-measure-entry-invalid' };
    measureFiles.push(row.file);
  }
  const all = [...reusedFiles, ...measureFiles];
  if (new Set(all).size !== all.length || all.length !== expectedFiles.length
    || [...all].sort().some((file, index) => file !== expected[index]))
    return { action: 'full-gate', reason: 'file-cas-inventory-mismatch' };

  // A matching failure/error receipt is useful evidence, but it is not a passing reuse. Re-run it
  // alongside missing files so the train can produce a fresh verdict instead of holding forever.
  return { action: 'run-uncovered', files: [...measureFiles, ...knownNonPassingFiles].sort(), receiptKeys: receiptKeys.sort(),
    knownNonPassingFiles: knownNonPassingFiles.sort() };
}
