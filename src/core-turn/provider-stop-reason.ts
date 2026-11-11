import type { CoreTurnStopReason } from './types.js';

export function coreStopReasonFromProvider(aborted: boolean, finishReason?: string): CoreTurnStopReason {
  if (aborted) return 'aborted';
  return finishReason === 'length' || finishReason === 'max_tokens' ? 'max_turns' : 'end_turn';
}
