import { debug } from '../debug/log.js';

/** One observation per harness node execution or loop tick, not per LLM request. */
export type ModelInputObservationTarget = {
  scope: 'harness-node' | 'loop-tick';
  nodeKind: string;
  graphId?: string;
  runId?: string;
  nodeId?: string;
  tickId?: string;
};

export type ModelInputObservation = ModelInputObservationTarget & (
  | { status: 'measured'; inputTokens: number }
  | { status: 'unmeasured'; inputTokens: null; reason: 'usage-unavailable' | 'invalid-usage' }
);

/**
 * Publish a single structured record at the execution boundary. Only provider-reported,
 * nonnegative integer counts are measurements; missing/invalid usage is never a zero.
 * The caller supplies the total across model calls for this execution, if available.
 */
export function observeModelInputTokens(
  target: ModelInputObservationTarget,
  inputTokens?: number | null,
): ModelInputObservation {
  const observation: ModelInputObservation = inputTokens === null || inputTokens === undefined
    ? { ...target, status: 'unmeasured', inputTokens: null, reason: 'usage-unavailable' }
    : Number.isSafeInteger(inputTokens) && inputTokens >= 0
      ? { ...target, status: 'measured', inputTokens }
      : { ...target, status: 'unmeasured', inputTokens: null, reason: 'invalid-usage' };

  try {
    debug.log('harness.model-input', 'recorded', observation);
  } catch { /* Logging must not interrupt the node or tick. */ }
  return observation;
}
