import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGoalDifficulty, goalDifficultySignals, resolveImplementDifficulty } from './difficulty.js';
import { lookupLlmTierSpec } from '../model-tier/llm-tier-map.js';
import { buildUserConfig, getUserConfig, resolveRoleLlm, saveUserConfig, setUserConfigOverlay } from '../user-config.js';

// Deterministic runs carry no ambient LLM credentials — pin a provider only when config left it on «auto».
beforeAll(() => setUserConfigOverlay((c) => (c.llm.provider === 'auto' ? { ...c, llm: { ...c.llm, provider: 'openai-codex' } } : c)));
afterAll(() => setUserConfigOverlay(null));


const document = (paths: string[], count: number, extra = '') => [
  'A goal', '- GoalType: implement', '',
  `대상 경로: ${paths.join(' · ')}`,
  '## 판정 신호',
  ...Array.from({ length: count }, (_, n) => [
    '- Candidate decision signal:',
    `  - Condition: case ${n}`,
    '  - Observation: run test',
    '  - Expected result: passes',
  ]).flat(),
  extra,
].join('\n');

function config() {
  const value = getUserConfig();
  return { ...value, llm: { ...value.llm, provider: 'local' as const, baseUrl: 'http://difficulty.invalid/v1' },
    roleLlm: undefined, roleModels: undefined, roleModelTiers: undefined };
}

describe('goal difficulty at implement launch', () => {
  test('one target path and one decision signal use budget', () => {
    const signals = goalDifficultySignals(document(['src/one.ts'], 1, '- Expected changed files: 1'));
    expect(signals).toEqual({ targetPathCount: 1, decisionSignalCount: 1, expectedChangedFileCount: 1, goalType: 'implement' });
    expect(classifyGoalDifficulty(signals)).toBe('small');
    const role = resolveImplementDifficulty(resolveRoleLlm('implement', { config: config() }), 'small');
    expect(role.tier).toBe('budget');
    expect(role.model).toBe(lookupLlmTierSpec('local', 'budget').model);
  });

  test('more than five target paths use best', () => {
    const signals = goalDifficultySignals(document(Array.from({ length: 6 }, (_, n) => `src/${n}.ts`), 1));
    expect(signals.targetPathCount).toBe(6);
    expect(classifyGoalDifficulty(signals)).toBe('large');
    expect(resolveImplementDifficulty(resolveRoleLlm('implement', { config: config() }), 'large').tier).toBe('best');
  });

  test('medium retains the current implement default and explicit roleLlm wins', () => {
    const signals = goalDifficultySignals(document(['src/a.ts', 'src/b.ts'], 1));
    expect(classifyGoalDifficulty(signals)).toBe('medium');
    const baseline = resolveRoleLlm('implement', { config: config() });
    expect(resolveImplementDifficulty(baseline, 'medium')).toEqual(baseline);
    const configured = resolveRoleLlm('implement', { config: { ...config(), roleLlm: { implement: { tier: 'best' } } } });
    expect(resolveImplementDifficulty(configured, 'small')).toEqual(configured);
    const flagged = resolveRoleLlm('implement', { config: config(), overrides: { implement: { tier: 'best' } } });
    expect(resolveImplementDifficulty(flagged, 'small')).toEqual(flagged);
    const pinned = resolveRoleLlm('implement', { config: {
      ...config(), roleLlm: { implement: { model: 'pinned-implement', provider: 'local' } },
    } });
    expect(resolveImplementDifficulty(pinned, 'small')).toEqual(pinned);
    const olderTier = resolveRoleLlm('implement', { config: { ...config(), roleModelTiers: { implement: 'best' } } });
    expect(resolveImplementDifficulty(olderTier, 'small')).toEqual(olderTier);
  });

  test('legacy placement setting is discarded on read and save without dropping neighboring config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'difficulty-retired-')); const path = join(dir, 'config.json');
    try {
      writeFileSync(path, JSON.stringify({ harness: { difficultyPlacement: true, defaultRepo: 'kept' } }));
      const cfg = buildUserConfig(path);
      expect(cfg.harness).not.toHaveProperty('difficultyPlacement');
      saveUserConfig(cfg, path);
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      expect(saved.harness).not.toHaveProperty('difficultyPlacement');
      expect(saved.harness.defaultRepo).toBe('kept');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('reads the authored signals in an existing goal document, not its quoted ask or run history', () => {
    const goal = readFileSync(new URL('../../docs/goals/GOAL-worktree-src-harness-harness-worktrees-ts-test-harness-worktrees-5dacfb5b-2026-08-03.txt', import.meta.url), 'utf8');
    expect(goalDifficultySignals(goal)).toEqual({
      targetPathCount: 3, decisionSignalCount: 1, expectedChangedFileCount: null, goalType: 'implement',
    });
    expect(classifyGoalDifficulty(goalDifficultySignals(goal))).toBe('medium');
  });

  test('a six-path authored goal without an ask block still selects large', () => {
    const goal = [
      'Goal', '- GoalType: implement', '', '## TRACED PATHS',
      ...Array.from({ length: 6 }, (_, n) => `${n + 1}. src/${n}.ts — read-verified`),
      '', '## 판정 신호', '- Candidate decision signal:', '  - Expected result: passes',
    ].join('\n');
    expect(goalDifficultySignals(goal).targetPathCount).toBe(6);
    expect(classifyGoalDifficulty(goalDifficultySignals(goal))).toBe('large');
  });

  test('other scale signals and missing information stay conservative', () => {
    expect(classifyGoalDifficulty(goalDifficultySignals(document(['src/a.ts'], 6)))).toBe('large');
    expect(classifyGoalDifficulty(goalDifficultySignals(document(['src/a.ts'], 1, '- Expected changed files: 6')))).toBe('large');
    expect(classifyGoalDifficulty(goalDifficultySignals(document(['src/a.ts'], 1, '- Expected changed files: 3')))).toBe('small');
    expect(classifyGoalDifficulty(goalDifficultySignals('plain text with src/a.ts'))).toBe('medium');
    expect(goalDifficultySignals(document(['src/a.ts'], 1, '예상 바뀌는 파일 수: 3')).expectedChangedFileCount).toBe(3);
    expect(goalDifficultySignals(document(['src/a.ts'], 1, '예상 바뀌는 파일 수: 3').replace('src/a.ts', 'src/a.ts · src/a.ts')).targetPathCount).toBe(1);
    expect(classifyGoalDifficulty(goalDifficultySignals(document(['src/a.ts'], 1).replace('GoalType: implement', 'GoalType: research')))).toBe('medium');
  });
});
