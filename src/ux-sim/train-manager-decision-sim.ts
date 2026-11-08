import { planTrainDecisions, type TrainDecisionInput, type TrainDecisionResult } from '../loops/train/decisions.js';

/** Run one train-manager tick against a fake world snapshot using the production decision core. */
export function simulateTrainManagerDecision(input: TrainDecisionInput): TrainDecisionResult {
  return planTrainDecisions(input);
}
