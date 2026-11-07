import { assessPrLandTypecheckDrift } from '../cli/pr-land-heavy-remote.js';
import { classifyPrLandRefusal } from '../cli/pr-land-refusal.js';

export interface PrLandDriftGateScenario {
  main: string;
  output: string;
  refusal: string;
}

/** Replays the production pinned-main diagnostic parser and refusal classifier without SSH. */
export function simulatePrLandDriftGate(scenario: PrLandDriftGateScenario) {
  const typecheckDrift = assessPrLandTypecheckDrift(scenario.output, scenario.main);
  return { typecheckDrift, refusal: classifyPrLandRefusal(scenario.refusal, { typecheckDrift }) };
}
