import { afterAll, beforeAll, describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSeams } from '../self-implement/seams.js';
import { pickImplementRoleForGoal, runHeadlessGoalLoopPty } from '../self-implement/headless-elanous-driver.js';
import { debug } from '../debug/log.js';
import { classifyGoalDifficulty, goalDifficultySignals, resolveImplementDifficulty } from './difficulty.js';
import { lookupLlmTierSpec } from '../model-tier/llm-tier-map.js';
import { buildUserConfig, clearLaunchRoleLlmOverrides, getUserConfig, resolveRoleLlm, setLaunchRoleLlmOverrides, setUserConfigOverlay } from '../user-config.js';

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

  test('config parses an opt-in boolean and defaults invalid values to off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'difficulty-config-'));
    try {
      for (const [raw, expected] of [[true, true], [false, false], ['true', false], [1, false]] as const) {
        const path = join(dir, 'config.json');
        writeFileSync(path, JSON.stringify({ harness: { difficultyPlacement: raw } }));
        expect(buildUserConfig(path).harness?.difficultyPlacement).toBe(expected);
      }
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ harness: {} }));
      expect(buildUserConfig(join(dir, 'config.json')).harness?.difficultyPlacement).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('opt-in picks three tiers on one provider and records the placement; off preserves the role model', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const provider = 'openai-codex';
    setUserConfigOverlay((c) => ({ ...c, llm: { ...c.llm, provider }, harness: { ...c.harness, difficultyPlacement: false },
      roleLlm: undefined, roleModels: undefined, roleModelTiers: undefined }));
    try {
      const cases = [
        { goal: document(['src/a.ts'], 1), difficulty: 'small', tier: 'budget' },
        { goal: document(['src/a.ts', 'src/b.ts'], 1), difficulty: 'medium', tier: 'better' },
        { goal: document(Array.from({ length: 6 }, (_, n) => `src/${n}.ts`), 1), difficulty: 'large', tier: 'best' },
      ] as const;
      const baseline = resolveRoleLlm('implement');
      for (const { goal } of cases) expect(pickImplementRoleForGoal(goal)).toEqual(baseline);
      expect(log).not.toHaveBeenCalledWith('harness.role-llm', 'difficulty-placement', expect.anything());
      setUserConfigOverlay((c) => ({ ...c, llm: { ...c.llm, provider }, harness: { ...c.harness, difficultyPlacement: true },
        roleLlm: undefined, roleModels: undefined, roleModelTiers: undefined }));
      for (const { goal, difficulty, tier } of cases) {
        const picked = pickImplementRoleForGoal(goal);
        expect(picked).toMatchObject({ provider, model: lookupLlmTierSpec(provider, tier).model, tier });
        expect(log).toHaveBeenCalledWith('harness.role-llm', 'difficulty-placement', { difficulty, tier, source: 'default' });
      }
      setUserConfigOverlay((c) => ({ ...c, llm: { ...c.llm, provider }, harness: { ...c.harness, difficultyPlacement: true },
        roleLlm: { implement: { model: 'configured-role', provider } } }));
      expect(pickImplementRoleForGoal(cases[0].goal)).toMatchObject({ source: 'config-role', model: 'configured-role' });
      setLaunchRoleLlmOverrides({ implement: { tier: 'best' } });
      expect(pickImplementRoleForGoal(cases[0].goal)).toMatchObject({ source: 'flag', tier: 'best' });
      expect(log.mock.calls.filter(([category, event]) => category === 'harness.role-llm' && event === 'difficulty-placement')).toHaveLength(3);
    } finally {
      clearLaunchRoleLlmOverrides();
      setUserConfigOverlay(null);
      log.mockRestore();
    }
  });

  test('the headless harness spawn relays the difficulty model; an explicit child choice wins', async () => {
    setUserConfigOverlay((c) => ({ ...c, llm: { ...c.llm, provider: 'openai-codex' }, harness: { ...c.harness, difficultyPlacement: true } }));
    const inheritedModel = process.env.ELANOUS_LLM_MODEL;
    delete process.env.ELANOUS_LLM_MODEL;
    try {
      const goal = document(['src/a.ts'], 1);
      const launch = async (childLlm?: { provider: string; model: string; source: 'flag' }) => {
        let env: Record<string, string> | undefined;
        await runHeadlessGoalLoopPty({
          binRoot: '/tmp/repo', cwd: '/tmp/difficulty-child', featurePrompt: 'decorated execution instructions',
          goalDocument: goal, ...(childLlm ? { childLlm } : {}),
          maxWaitSec: 1, maxHardWaitSec: 1, pollMs: 1, activityGraceSec: 100,
          ptyAvailable: () => true,
          spawn: ((options: { env: Record<string, string> }) => {
            env = options.env;
            let reads = 0;
            return { id: 'self_difficulty', write: () => {}, renderScreen: async () => 'working',
              renderScreenPng: async () => null, snapshot: () => 'working', drainDelta: () => '',
              isAlive: () => reads++ < 2, exitCode: 0, kill: () => {}, canWrite: () => true } as never;
          }) as never,
        });
        return env!;
      };
      const defaultRole = resolveRoleLlm('implement');
      setUserConfigOverlay((c) => ({ ...c, llm: { ...c.llm, provider: 'openai-codex' }, harness: { ...c.harness, difficultyPlacement: false } }));
      const off = await launch();
      expect(off.ELANOUS_LLM_PROVIDER).toBe(defaultRole.provider);
      expect(off.ELANOUS_LLM_MODEL).toBe(defaultRole.model);
      setUserConfigOverlay((c) => ({ ...c, llm: { ...c.llm, provider: 'openai-codex' }, harness: { ...c.harness, difficultyPlacement: true } }));
      if (defaultRole.source === 'default') {
        const automatic = await launch();
        expect(automatic.ELANOUS_LLM_PROVIDER).toBe(defaultRole.provider);
        expect(automatic.ELANOUS_LLM_MODEL).toBe(lookupLlmTierSpec(defaultRole.provider, 'budget').model);
      }
      setLaunchRoleLlmOverrides({ implement: { tier: 'best' } });
      try {
        const requested = resolveRoleLlm('implement');
        const fromRole = await launch();
        expect(fromRole.ELANOUS_LLM_MODEL).toBe(requested.model);
        expect(fromRole.ELANOUS_LLM_PROVIDER).toBe(requested.provider);
      } finally {
        clearLaunchRoleLlmOverrides();
      }
      const explicit = await launch({ provider: 'openai-codex', model: 'explicit-model', source: 'flag' });
      expect(explicit.ELANOUS_LLM_MODEL).toBe('explicit-model');
      expect(explicit.ELANOUS_LLM_PROVIDER).toBe('openai-codex');
    } finally {
      if (inheritedModel === undefined) delete process.env.ELANOUS_LLM_MODEL;
      else process.env.ELANOUS_LLM_MODEL = inheritedModel;
      setUserConfigOverlay(null);
    }
  });

  test('the sync fallback spawn relays the authored goal tier and preserves explicit roleLlm', async () => {
    setUserConfigOverlay((c) => ({ ...c, llm: { ...c.llm, provider: 'openai-codex' }, harness: { ...c.harness, difficultyPlacement: true } }));
    const cwd = mkdtempSync(join(tmpdir(), 'difficulty-fallback-'));
    const inheritedModel = process.env.ELANOUS_LLM_MODEL;
    delete process.env.ELANOUS_LLM_MODEL;
    const captured: Array<Record<string, string | undefined>> = [];
    try {
      const implementation = defaultSeams({
        ptyAvailable: () => false,
        spawnSync: ((_command: string, _argv: string[], options: { env?: Record<string, string | undefined> }) => {
          captured.push(options.env ?? {});
          return { stdout: '', stderr: '', status: 0, signal: null };
        }) as never,
      }).implement;
      const goal = document(['src/a.ts'], 1);
      setUserConfigOverlay((c) => ({ ...c, llm: { ...c.llm, provider: 'openai-codex' }, harness: { ...c.harness, difficultyPlacement: false } }));
      await implementation({ cwd, feature: goal, runId: 'run-difficulty-fallback' });
      const offRole = resolveRoleLlm('implement');
      expect(captured[0]?.ELANOUS_LLM_MODEL).toBe(offRole.model);
      setUserConfigOverlay((c) => ({ ...c, llm: { ...c.llm, provider: 'openai-codex' }, harness: { ...c.harness, difficultyPlacement: true } }));
      await implementation({ cwd, feature: goal, runId: 'run-difficulty-fallback' });
      const role = resolveRoleLlm('implement');
      if (role.source === 'default') {
        expect(captured[1]?.ELANOUS_LLM_MODEL).toBe(lookupLlmTierSpec(role.provider, 'budget').model);
      } else {
        expect(captured[1]?.ELANOUS_LLM_MODEL).toBe(role.model);
      }
      setLaunchRoleLlmOverrides({ implement: { tier: 'best' } });
      const configured = resolveRoleLlm('implement');
      await implementation({ cwd, feature: goal, runId: 'run-difficulty-fallback' });
      expect(captured[2]?.ELANOUS_LLM_MODEL).toBe(configured.model);
      expect(captured[2]?.ELANOUS_LLM_PROVIDER).toBe(configured.provider);
      await implementation({ cwd, feature: goal, runId: 'run-difficulty-fallback',
        childLlm: { provider: 'openai-codex', model: 'explicit-model', source: 'flag' } });
      expect(captured[3]?.ELANOUS_LLM_MODEL).toBe('explicit-model');
      expect(captured[3]?.ELANOUS_LLM_PROVIDER).toBe('openai-codex');
    } finally {
      clearLaunchRoleLlmOverrides();
      if (inheritedModel === undefined) delete process.env.ELANOUS_LLM_MODEL;
      else process.env.ELANOUS_LLM_MODEL = inheritedModel;
      rmSync(cwd, { recursive: true, force: true });
      setUserConfigOverlay(null);
    }
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
