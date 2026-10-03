import { markdownSection, parseGoalType, tracedPathReferences, verbatimOriginalAsk } from '../self-implement/goal-author.js';
import { lookupLlmTierSpec } from '../model-tier/llm-tier-map.js';
import type { GoalType } from '../self-implement/goal-author.js';
import type { ModelTier } from '../model-tier/types.js';
import { ROLE_MODEL_DEFAULTS, type RoleLlmResolution } from '../user-config.js';

export interface DifficultySignals {
  targetPathCount: number;
  decisionSignalCount: number;
  expectedChangedFileCount: number | null;
  goalType: GoalType | null;
}

export type DifficultyLevel = 'small' | 'medium' | 'large';

/** Count declared target paths and authored decision signals without counting quoted run history. */
export function goalDifficultySignals(document: string): DifficultySignals {
  const ask = verbatimOriginalAsk(document);
  const targetLine = (ask ?? document).split(/\r?\n/)
    .map((line) => /^대상 경로:\s*(.+)$/.exec(line)?.[1])
    .find((line) => line !== undefined);
  const namedPaths = targetLine?.split(' · ').map((path) => path.trim().replace(/^`|`$/g, '')).filter(Boolean) ?? [];
  const paths = namedPaths.length ? namedPaths : tracedPathReferences(document).map(({ path }) => path);
  const signals = markdownSection(document, '판정 신호') ?? '';
  const candidates = signals.split(/\r?\n/).filter((line) => /^\s*- Candidate decision signal:\s*$/.test(line)).length;
  const expectedResults = signals.split(/\r?\n/).filter((line) => /^\s*- Expected result:\s*\S/.test(line)).length;
  const countLine = (ask ?? document).split(/\r?\n/).find((line) => /^\s*(?:-\s*)?(?:예상 (?:변경|바뀌는) 파일 수|Expected changed files(?: count)?):\s*\d+\s*$/i.test(line));
  const expectedChangedFileCount = countLine ? Number(countLine.split(':').at(-1)!.trim()) : null;
  return {
    targetPathCount: new Set(paths).size,
    decisionSignalCount: Math.max(candidates, expectedResults),
    expectedChangedFileCount,
    goalType: parseGoalType(document),
  };
}

export function classifyGoalDifficulty(signals: DifficultySignals): DifficultyLevel {
  const { targetPathCount, decisionSignalCount, expectedChangedFileCount, goalType } = signals;
  if (targetPathCount > 5 || decisionSignalCount > 5 || (expectedChangedFileCount ?? 0) > 5) return 'large';
  if (goalType === 'implement' && targetPathCount === 1 && decisionSignalCount === 1) return 'small';
  return 'medium';
}

/** Only the baseline role default is adjustable; explicit roleLlm and older config/env layers win. */
export function implementDifficultyTier(level: DifficultyLevel, role: RoleLlmResolution): ModelTier | undefined {
  if (role.source !== 'default') return undefined;
  return level === 'small' ? 'budget' : level === 'large' ? 'better' : ROLE_MODEL_DEFAULTS.implement.tier;
}

export function resolveImplementDifficulty(role: RoleLlmResolution, level: DifficultyLevel): RoleLlmResolution {
  const tier = implementDifficultyTier(level, role);
  return tier === undefined ? role : {
    ...role,
    model: lookupLlmTierSpec(role.provider, tier).model,
    tier,
  };
}
