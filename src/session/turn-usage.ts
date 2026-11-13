import type { LLMUsage } from '../prompt-cache/types.js';

/** Provider telemetry for one runTurn invocation. Undefined means no provider
 * reported that field; estimates and cache counters never enter this total. */
export interface MeasuredTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export function createMeasuredTurnUsage() {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const accept = (usage: LLMUsage): void => {
    if (typeof usage.inputTokens === 'number' && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0
      && Number.isSafeInteger((inputTokens ?? 0) + usage.inputTokens)) {
      inputTokens = (inputTokens ?? 0) + usage.inputTokens;
    }
    if (typeof usage.outputTokens === 'number' && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0
      && Number.isSafeInteger((outputTokens ?? 0) + usage.outputTokens)) {
      outputTokens = (outputTokens ?? 0) + usage.outputTokens;
    }
  };
  const snapshot = (): MeasuredTurnUsage | undefined =>
    inputTokens === undefined && outputTokens === undefined ? undefined : {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
  return { accept, snapshot };
}
