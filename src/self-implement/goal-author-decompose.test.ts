import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetLiveDetailCacheForTesting, writeLiveDetail } from '../live/detail-switch.js';
import { setUserConfigOverlay } from '../user-config.js';

const originalSteps = ['inspect seam', 'implement red-team', 'verify regression', 'record evidence'];
const revisedSteps = ['inspect seam', 'implement red-team', 'verify regression', 'record evidence', 'check fail-open behavior'];
let decomposition = originalSteps;
let rationale: string | undefined = '파일별 책임을 나눠 독립 검증한다. 병합 전에 경계를 확인한다.';
let critique: { revisedSteps: string[]; issues: string[]; byAxis?: { scope: string[] } } | null = null;
let critiqueError: Error | undefined;
let critiqueCalls = 0;
let decompositionOptions: Record<string, unknown> | undefined;
let stateRoot: string;
let originalStateDir: string | undefined;

mock.module('../harness/llm-decompose.js', () => ({
  llmDecomposeSteps: async (_objective: string, _callable: unknown, options?: Record<string, unknown>) => {
    decompositionOptions = options;
    if (rationale !== undefined) (options?.onRationale as ((reason: string) => void) | undefined)?.(rationale);
    return decomposition;
  },
}));

mock.module('../harness/adversarial-plan.js', () => ({
  adversarialPlanCritique: async () => {
    critiqueCalls += 1;
    if (critiqueError) throw critiqueError;
    return critique;
  },
}));

const { createGoalAuthorDecomposeSteps, readRecentStepCountsFailOpen } = await import('./goal-author-decompose.js');
const { runGoalAuthorCli } = await import('./goal-author-cli.js');
const {
  _setCreateGoalAuthorDecomposeStepsForTesting,
  _setRecentStepCountReaderForTesting,
  dispatchSelfImplement,
} = await import('../boot/daemon-tools/self-implement.js');

beforeEach(() => {
  originalStateDir = process.env.ELANOUS_STATE_DIR;
  stateRoot = mkdtempSync(join(tmpdir(), 'goal-author-decision-'));
  process.env.ELANOUS_STATE_DIR = stateRoot;
  resetLiveDetailCacheForTesting();
  decomposition = originalSteps;
  rationale = '파일별 책임을 나눠 독립 검증한다. 병합 전에 경계를 확인한다.';
  critique = null;
  critiqueError = undefined;
  critiqueCalls = 0;
  decompositionOptions = undefined;
  _setRecentStepCountReaderForTesting();
  _setCreateGoalAuthorDecomposeStepsForTesting();
  setUserConfigOverlay((config) => ({
    ...config,
    tools: { ...config.tools, selfImplement: { ...config.tools.selfImplement, observeOnly: false } },
  }));
});

afterEach(() => {
  _setRecentStepCountReaderForTesting();
  _setCreateGoalAuthorDecomposeStepsForTesting();
  setUserConfigOverlay(null);
  resetLiveDetailCacheForTesting();
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  rmSync(stateRoot, { recursive: true, force: true });
});

describe('recent step count reader fail-open semantics', () => {
  test('preserves a successful empty array while omitting a failed read', () => {
    const empty: readonly number[] = [];
    expect(readRecentStepCountsFailOpen(() => empty)).toBe(empty);
    expect(readRecentStepCountsFailOpen(() => { throw new Error('store unavailable'); })).toBeUndefined();
  });
});

describe('goal-author production decompose config parity', () => {
  test.each([
    ['default with a successful empty read', {}, undefined, () => [] as readonly number[], ['recentStepCounts'], undefined],
    ['forced review with a successful read', { adversarialReview: true }, true, () => [3] as readonly number[], ['adversarialReview', 'recentStepCounts'], 'cli'],
    ['disabled review with a successful read', { disableAdversarialReview: true }, false, () => [3] as readonly number[], ['adversarialReview', 'recentStepCounts'], 'cli'],
    ['default with a failed read', {}, undefined, () => { throw new Error('log store unavailable'); }, [], undefined],
    ['forced review with a failed read', { adversarialReview: true }, true, () => { throw new Error('log store unavailable'); }, ['adversarialReview'], 'cli'],
    ['disabled review with a failed read', { disableAdversarialReview: true }, false, () => { throw new Error('log store unavailable'); }, ['adversarialReview'], 'cli'],
  ] as const)('passes identical shared option keys for %s', async (_name, cliOptions, daemonAdversarialReview, readRecentStepCounts, expectedKeys, cliSource) => {
    const cliConfigs: Record<string, unknown>[] = [];
    const daemonConfigs: Record<string, unknown>[] = [];

    await runGoalAuthorCli(['author goal'], { cwd: process.cwd(), ...cliOptions }, {
      recentStepCountReader: readRecentStepCounts,
      createDecomposeSteps: (_signal, config = {}) => {
        cliConfigs.push(config);
        return async () => [];
      },
      write: async () => ({ path: 'docs/goals/GOAL-cli.md', authored: { document: '', authorRunId: 'cli', facts: null, grounded: false } }),
    });

    _setRecentStepCountReaderForTesting(readRecentStepCounts);
    _setCreateGoalAuthorDecomposeStepsForTesting((_signal, config = {}) => {
      daemonConfigs.push(config);
      return async () => [];
    });
    await dispatchSelfImplement(
      { feature: 'author goal', ...(daemonAdversarialReview === undefined ? {} : { adversarialReview: daemonAdversarialReview }) },
      { cwd: process.cwd(), signal: new AbortController().signal, entry: 'elanous-apparatus', userText: 'author goal' },
      async () => ({ runId: 'daemon', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed' }),
      async () => ({ path: 'docs/goals/GOAL-daemon.md' }),
    );

    const sharedKeys = (config: Record<string, unknown> | undefined) => Object.keys(config ?? {})
      .filter((key) => key !== 'adversarialReviewSource')
      .sort();
    expect(sharedKeys(cliConfigs[0])).toEqual([...expectedKeys]);
    expect(sharedKeys(daemonConfigs[0])).toEqual([...expectedKeys]);
    expect(sharedKeys(cliConfigs[0])).toEqual(sharedKeys(daemonConfigs[0]));
    expect(cliConfigs[0]?.adversarialReviewSource).toBe(cliSource);
    expect(Object.hasOwn(cliConfigs[0] ?? {}, 'adversarialReviewSource')).toBe(cliSource !== undefined);
    expect(Object.hasOwn(daemonConfigs[0] ?? {}, 'adversarialReviewSource')).toBe(false);
  });
});

describe('runGoalAuthorCli recent step count observations', () => {
  const writeThroughDecompose: NonNullable<Parameters<typeof runGoalAuthorCli>[2]>['write'] = async (_ask, _cwd, deps) => {
    await deps?.decomposeSteps?.('implement a robust goal author seam');
    return { path: 'docs/goals/GOAL-cli.md', authored: { document: '', authorRunId: 'cli', facts: null, grounded: false } };
  };

  test('runGoalAuthorCli connects its default decomposition seam to the final PLAN decision', async () => {
    decomposition = ['파일 A', '파일 B', '시험'];
    writeLiveDetail({ scope: 'all', ttlMin: 30 }, { path: join(stateRoot, 'live', 'detail.json') });
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await runGoalAuthorCli(['author goal'], { cwd: process.cwd() }, {
        recentStepCountReader: () => [], write: writeThroughDecompose,
      });
      expect(log.mock.calls.filter(([category]) => category === 'harness.decision')).toEqual([[
        'harness.decision', 'decision', expect.objectContaining({
          kind: 'PLAN', what: '골을 조각 3개로 분해', target: '파일 A · 파일 B · 시험', paths: 3,
        }),
      ]]);
    } finally { log.mockRestore(); }
  });

  test('emits adversarial-threshold-unreachable for below-threshold CLI samples', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await runGoalAuthorCli(['author goal'], { cwd: process.cwd() }, {
        recentStepCountReader: () => [3, 2],
        write: writeThroughDecompose,
      });
      expect(log).toHaveBeenCalledWith('goal-author', 'adversarial-threshold-unreachable', expect.objectContaining({
        recentMaximum: 3,
        sampleSize: 2,
      }));
    } finally {
      log.mockRestore();
    }
  });

  test('suppresses adversarial-threshold-unreachable for threshold-reaching CLI samples', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await runGoalAuthorCli(['author goal'], { cwd: process.cwd() }, {
        recentStepCountReader: () => [3, 10],
        write: writeThroughDecompose,
      });
      expect(log).not.toHaveBeenCalledWith('goal-author', 'adversarial-threshold-unreachable', expect.anything());
    } finally {
      log.mockRestore();
    }
  });
});

describe('goal-author decomposition Live MAX decisions', () => {
  test.each([true, false])('three fragments with MAX %s retain the steps and emit only when on', async (enabled) => {
    decomposition = ['첫 조각', '둘째 조각', '셋째 조각'];
    if (enabled) writeLiveDetail({ scope: 'all', ttlMin: 30 }, { path: join(stateRoot, 'live', 'detail.json') });
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false })('implement a robust goal author seam');
      expect(result).toEqual(decomposition);
      const decisions = log.mock.calls.filter(([category]) => category === 'harness.decision');
      expect(decisions).toHaveLength(enabled ? 1 : 0);
      if (enabled) expect(decisions[0]).toEqual([
        'harness.decision', 'decision', expect.objectContaining({
          kind: 'PLAN', what: '골을 조각 3개로 분해', reason: '파일별 책임을 나눠 독립 검증한다.',
          purpose: '조각마다 독립 런으로 · 실패를 작게 가둔다', target: '첫 조각 · 둘째 조각 · 셋째 조각', paths: 3,
        }),
      ]);
    } finally { log.mockRestore(); }
  });

  test('single fragment reports why no split was needed', async () => {
    decomposition = ['한 조각'];
    rationale = '변경 범위가 한 파일에 머물러 별도 조각이 필요 없다. 단독 검증한다.';
    writeLiveDetail({ scope: 'all', ttlMin: 30 }, { path: join(stateRoot, 'live', 'detail.json') });
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      expect(await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false })('fix typo')).toEqual(['한 조각']);
      expect(log.mock.calls.filter(([category]) => category === 'harness.decision')).toEqual([[
        'harness.decision', 'decision', expect.objectContaining({
          kind: 'PLAN', what: '분해 안 함(한 조각)', reason: '변경 범위가 한 파일에 머물러 별도 조각이 필요 없다.',
          target: '한 조각', paths: 1,
        }),
      ]]);
    } finally { log.mockRestore(); }
  });

  test('missing generator rationale does not invent a decision reason', async () => {
    rationale = undefined;
    decomposition = ['첫 조각', '둘째 조각', '셋째 조각'];
    writeLiveDetail({ scope: 'all', ttlMin: 30 }, { path: join(stateRoot, 'live', 'detail.json') });
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      expect(await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false })('implement goal')).toEqual(decomposition);
      expect(log.mock.calls.filter(([category]) => category === 'harness.decision')).toHaveLength(0);
    } finally { log.mockRestore(); }
  });

  test('observation failure does not replace the proposed steps', async () => {
    decomposition = ['첫 조각', '둘째 조각', '셋째 조각'];
    writeLiveDetail({ scope: 'all', ttlMin: 30 }, { path: join(stateRoot, 'live', 'detail.json') });
    const log = spyOn(debug, 'log').mockImplementation((category) => {
      if (category === 'harness.decision') throw new Error('sink unavailable');
    });
    try {
      expect(await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false })('implement goal')).toEqual(decomposition);
    } finally { log.mockRestore(); }
  });

  test('adversarial revision without a final rationale retains steps but does not mislabel an issue as its reason', async () => {
    critique = { revisedSteps: ['개선 1', '개선 2'], issues: ['기존 조각의 파일 경계가 잘못됐다'] };
    writeLiveDetail({ scope: 'all', ttlMin: 30 }, { path: join(stateRoot, 'live', 'detail.json') });
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      expect(await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: true })('implement goal')).toEqual(critique.revisedSteps);
      expect(log.mock.calls.filter(([category]) => category === 'harness.decision')).toHaveLength(0);
    } finally { log.mockRestore(); }
  });

  test.each([true, false])('run-scoped MAX %s attributes the three final fragments to the authoring run', async (enabled) => {
    decomposition = ['첫 조각', '둘째 조각', '셋째 조각'];
    const runId = 'author-run-123';
    writeLiveDetail({ scope: enabled ? runId : 'other-run', ttlMin: 30 }, { path: join(stateRoot, 'live', 'detail.json') });
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      expect(await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false })('implement goal', { runId })).toEqual(decomposition);
      const decisions = log.mock.calls.filter(([category]) => category === 'harness.decision');
      expect(decisions).toHaveLength(enabled ? 1 : 0);
      if (enabled) expect(decisions[0]).toEqual([
        'harness.decision', 'decision', expect.objectContaining({
          kind: 'PLAN', what: '골을 조각 3개로 분해', reason: '파일별 책임을 나눠 독립 검증한다.',
          purpose: '조각마다 독립 런으로 · 실패를 작게 가둔다',
          target: '첫 조각 · 둘째 조각 · 셋째 조각', paths: 3, runId,
        }),
      ]);
    } finally { log.mockRestore(); }
  });
});

describe('createGoalAuthorDecomposeSteps adversarial red-team', () => {
  test('selects the coarse profile for the goal-author LLM decomposition seam', async () => {
    await createGoalAuthorDecomposeSteps()('implement a robust goal author seam', { context: 'GOAL_AUTHOR_CONTEXT' });
    expect(decompositionOptions).toEqual(expect.objectContaining({
      context: 'GOAL_AUTHOR_CONTEXT',
      maxTasks: 6,
      promptProfile: 'goal-author-coarse',
    }));
  });

  test('returns injected revised steps and observes bounded issue samples', async () => {
    const longIssue = 'x'.repeat(61);
    critique = {
      revisedSteps,
      issues: ['[scope] add an unrequested production deployment', 'missing fail-open path', 'preserve surface', longIssue],
      byAxis: { scope: ['[scope] add an unrequested production deployment'] },
    };
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: true })('implement a robust goal author seam');
      expect(originalSteps.length).toBeGreaterThan(0);
      expect(critique!.issues.length).toBeGreaterThan(0);
      expect(result).toEqual(revisedSteps);
      expect(critiqueCalls).toBe(1);
      expect(log).toHaveBeenCalledWith('goal-author', 'adversarial-review', {
        surface: 'goal-author',
        heft: expect.any(String),
        adversarialReview: true,
        adversarialReviewSource: 'unknown',
        reviewEnabled: true,
        reviewForced: true,
        reviewEligible: false,
        reviewExecuted: true,
        reviewSkipReason: null,
      });
      expect(log).toHaveBeenCalledWith('goal-author', 'adversarial-revised', {
        surface: 'goal-author',
        heft: expect.any(String),
        steps: revisedSteps.length,
        issues: critique.issues.length,
        sample: ['[scope] add an unrequested production deployment', 'missing fail-open path', 'preserve surface'],
        byAxis: { scope: ['[scope] add an unrequested production deployment'] },
        reviewEnabled: true,
      });
    } finally {
      log.mockRestore();
    }
  });

  test('keeps original steps and observes sound issue sample', async () => {
    critique = { revisedSteps: [], issues: ['ask for explicit acceptance evidence'] };
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: true })('implement a robust goal author seam');
      expect(result).toEqual(originalSteps);
      expect(critiqueCalls).toBe(1);
      expect(log).toHaveBeenCalledWith('goal-author', 'adversarial-sound', {
        surface: 'goal-author',
        heft: expect.any(String),
        issues: 1,
        sample: ['ask for explicit acceptance evidence'],
        byAxis: { scope: [] },
        reviewEnabled: true,
      });
    } finally {
      log.mockRestore();
    }
  });

  test('observes an empty sample for sound verdicts without issues', async () => {
    critique = { revisedSteps: [], issues: [] };
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: true })('implement a robust goal author seam');
      expect(log).toHaveBeenCalledWith('goal-author', 'adversarial-sound', {
        surface: 'goal-author',
        heft: expect.any(String),
        issues: 0,
        sample: [],
        byAxis: { scope: [] },
        reviewEnabled: true,
      });
    } finally {
      log.mockRestore();
    }
  });

  test('skips review when explicitly disabled and observes the disabled state', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false, adversarialReviewSource: 'cli' })('implement a robust goal author seam');
      expect(result).toEqual(originalSteps);
      expect(critiqueCalls).toBe(0);
      expect(log).toHaveBeenCalledWith('goal-author', 'adversarial-review', {
        surface: 'goal-author',
        heft: expect.any(String),
        adversarialReview: false,
        adversarialReviewSource: 'cli',
        reviewEnabled: false,
        reviewForced: false,
        reviewEligible: false,
        reviewExecuted: false,
        reviewSkipReason: 'disabled',
      });
    } finally {
      log.mockRestore();
    }
  });

  test('keeps original steps and observes enabled review when the critic throws', async () => {
    critiqueError = new Error('critic unavailable');
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: true })('implement a robust goal author seam');
      expect(result).toEqual(originalSteps);
      expect(critiqueCalls).toBe(1);
      expect(log).toHaveBeenCalledWith('goal-author', 'adversarial-review', {
        surface: 'goal-author',
        heft: expect.any(String),
        adversarialReview: true,
        adversarialReviewSource: 'unknown',
        reviewEnabled: true,
        reviewForced: true,
        reviewEligible: false,
        reviewExecuted: true,
        reviewSkipReason: null,
      });
    } finally {
      log.mockRestore();
    }
  });

  test('runs the threshold-gated default review at the standard threshold', async () => {
    decomposition = Array.from({ length: 10 }, (_, index) => `step ${index + 1}`);
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await createGoalAuthorDecomposeSteps()('implement a robust goal author seam');
      expect(result).toEqual(decomposition);
      expect(critiqueCalls).toBe(1);
      expect(log).toHaveBeenCalledWith('goal-author', 'adversarial-review', {
        surface: 'goal-author',
        heft: 'standard',
        adversarialReview: null,
        adversarialReviewSource: 'default',
        reviewEnabled: true,
        reviewForced: false,
        reviewEligible: true,
        reviewExecuted: true,
        reviewSkipReason: null,
      });
    } finally {
      log.mockRestore();
    }
  });

  test('skips the enabled default review below the standard threshold', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await createGoalAuthorDecomposeSteps()('implement a robust goal author seam');
      expect(result).toEqual(originalSteps);
      expect(critiqueCalls).toBe(0);
      expect(log).toHaveBeenCalledWith('goal-author', 'adversarial-review', {
        surface: 'goal-author',
        heft: 'standard',
        adversarialReview: null,
        adversarialReviewSource: 'default',
        reviewEnabled: true,
        reviewForced: false,
        reviewEligible: false,
        reviewExecuted: false,
        reviewSkipReason: 'below-threshold',
      });
    } finally {
      log.mockRestore();
    }
  });

  test('forces review below the threshold when explicitly enabled without asserting an unknown source as default', async () => {
    decomposition = ['fix typo'];
    critique = { revisedSteps, issues: ['forced review'] };
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: true })('fix typo');
      expect(result).toEqual(revisedSteps);
      expect(critiqueCalls).toBe(1);
      expect(log).toHaveBeenCalledWith('goal-author', 'adversarial-review', {
        surface: 'goal-author',
        heft: expect.any(String),
        adversarialReview: true,
        adversarialReviewSource: 'unknown',
        reviewEnabled: true,
        reviewForced: true,
        reviewEligible: false,
        reviewExecuted: true,
        reviewSkipReason: null,
      });
    } finally {
      log.mockRestore();
    }
  });

  test.each([true, false])('records an unknown source for explicit %s outside CLI provenance', async (adversarialReview) => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await createGoalAuthorDecomposeSteps(undefined, { adversarialReview })('fix typo');
      expect(log).toHaveBeenCalledWith('goal-author', 'adversarial-review', expect.objectContaining({
        adversarialReview,
        adversarialReviewSource: 'unknown',
      }));
    } finally {
      log.mockRestore();
    }
  });

  test('disables review below the threshold when explicitly disabled without asserting an unknown source as default', async () => {
    decomposition = ['fix typo'];
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false })('fix typo');
      expect(result).toEqual(decomposition);
      expect(critiqueCalls).toBe(0);
      expect(log).toHaveBeenCalledWith('goal-author', 'adversarial-review', {
        surface: 'goal-author',
        heft: expect.any(String),
        adversarialReview: false,
        adversarialReviewSource: 'unknown',
        reviewEnabled: false,
        reviewForced: false,
        reviewEligible: false,
        reviewExecuted: false,
        reviewSkipReason: 'disabled',
      });
    } finally {
      log.mockRestore();
    }
  });

  test('reports an unreachable threshold when injected recent step counts stay below it', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await createGoalAuthorDecomposeSteps(undefined, { recentStepCounts: [1, 2, 2] })('implement a robust goal author seam');
      expect(log).toHaveBeenCalledWith('goal-author', 'adversarial-threshold-unreachable', {
        surface: 'goal-author',
        heft: 'standard',
        threshold: 10,
        recentMaximum: 2,
        sampleSize: 3,
      });
    } finally {
      log.mockRestore();
    }
  });

  test('does not report an unreachable threshold when injected recent step counts reach it', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await createGoalAuthorDecomposeSteps(undefined, { recentStepCounts: [2, 10] })('implement a robust goal author seam');
      expect(log).not.toHaveBeenCalledWith('goal-author', 'adversarial-threshold-unreachable', expect.anything());
    } finally {
      log.mockRestore();
    }
  });

  test('keeps the no-injection review observation byte-for-byte identical', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await createGoalAuthorDecomposeSteps()('implement a robust goal author seam');
      expect(log.mock.calls).toEqual([[
        'goal-author',
        'adversarial-review',
        {
          surface: 'goal-author',
          heft: 'standard',
          adversarialReview: null,
          adversarialReviewSource: 'default',
          reviewEnabled: true,
          reviewForced: false,
          reviewEligible: false,
          reviewExecuted: false,
          reviewSkipReason: 'below-threshold',
        },
      ]]);
    } finally {
      log.mockRestore();
    }
  });
});
