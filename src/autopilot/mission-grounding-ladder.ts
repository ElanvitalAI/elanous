import { groundMissionInCodebase } from './mission-codebase-gate.js';
import {
  adaptiveGround as sharedAdaptiveGround,
  type GroundingDeps,
  type GroundingResult,
} from '../harness/grounding/mission-grounding-ladder.js';

export * from '../harness/grounding/mission-grounding-ladder.js';

/** Autopilot compatibility boundary supplies its fabric-owned skim provider. */
export function adaptiveGround(
  query: string,
  context: { seedFiles?: string[]; acceptance?: string[]; symbols?: string[] } = {},
  deps: Partial<GroundingDeps> = {},
): Promise<GroundingResult> {
  return sharedAdaptiveGround(query, context, {
    ...deps,
    ground: deps.ground ?? ((goal) => groundMissionInCodebase(goal, {
      ...deps.codebaseGrounding,
      ...(deps.searchTerms ? { searchTerms: deps.searchTerms } : {}),
    })),
  });
}
