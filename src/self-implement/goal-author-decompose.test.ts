import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import * as llmDecomposeActual from '../harness/llm-decompose.js';
import * as adversarialPlanActual from '../harness/adversarial-plan.js';
import * as llmActual from '../llm.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetLiveDetailCacheForTesting, writeLiveDetail } from '../live/detail-switch.js';
import { setUserConfigOverlay } from '../user-config.js';

// ⭐ R-TST23 — mock.module 은 process-wide 레지스트리를 치환하므로, 퇴장길 afterAll 에서
//    원본 구현으로 되돌린다(아래 세 스냅샷은 namespace import 를 mock 투입 «전» 에 펼친 것).
const llmDecomposeOriginal = { ...llmDecomposeActual };
const adversarialPlanOriginal = { ...adversarialPlanActual };
const llmOriginal = { ...llmActual };

const originalSteps = ['inspect seam', 'implement red-team', 'verify regression', 'record evidence'];
const revisedSteps = ['inspect seam', 'implement red-team', 'verify regression', 'record evidence', 'check fail-open behavior'];
let decomposition = originalSteps;
let rationale: string | undefined = '파일별 책임을 나눠 독립 검증한다. 병합 전에 경계를 확인한다.';
let critique: { revisedSteps: string[]; issues: string[]; byAxis?: { scope: string[] } } | null = null;
let critiqueError: Error | undefined;
let critiqueCalls = 0;
let decompositionOptions: Record<string, unknown> | undefined;
let decomposeCallablePrompt: string | undefined;
let criticPrompt: string | undefined;
let captureStreamLlm = false;
const streamLlmCalls: { messages: unknown[]; opts: object | undefined }[] = [];
let stateRoot: string;
let originalStateDir: string | undefined;

mock.module('../harness/llm-decompose.js', () => ({
  llmDecomposeSteps: async (_objective: string, callable: unknown, options?: Record<string, unknown>) => {
    decompositionOptions = options;
    if (decomposeCallablePrompt !== undefined && typeof callable === 'function') {
      await (callable as (input: { prompt: string }) => Promise<{ text: string }>)({ prompt: decomposeCallablePrompt });
    }
    if (rationale !== undefined) (options?.onRationale as ((reason: string) => void) | undefined)?.(rationale);
    return decomposition;
  },
}));

mock.module('../harness/adversarial-plan.js', () => ({
  adversarialPlanCritique: async (_objective: string, _steps: string[], critic: unknown, _context?: unknown) => {
    critiqueCalls += 1;
    if (critiqueError) throw critiqueError;
    if (criticPrompt !== undefined && typeof critic === 'function') {
      await (critic as (prompt: string) => Promise<string>)(criticPrompt);
    }
    return critique;
  },
}));

// ⭐ AUTHOR-DECOMPOSE-KNOB — 쪼개기 callable ⊕ 비평 critic 이 부르는 streamLLM 의 실물 인자를 녹음한다.
//    캡처가 꺼져 있으면 실모듈에 그대로 위임한다(기존 시험은 지금과 한 칸도 다르지 않게).
mock.module('../llm.js', () => ({
  ...llmActual,
  streamLLM: async (...args: Parameters<typeof llmActual.streamLLM>) => {
    if (!captureStreamLlm) return llmActual.streamLLM(...args);
    streamLlmCalls.push({ messages: args[0], opts: args[2] });
    return 'MOCK STREAM LLM TEXT';
  },
}));

const { classifyShadowFirstSplit, createGoalAuthorDecomposeSteps, readRecentStepCountsFailOpen, SHADOW_FIRST_SPLIT_MARKER } = await import('./goal-author-decompose.js');
const { authorGoal } = await import('./goal-author.js');
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
  decomposeCallablePrompt = undefined;
  criticPrompt = undefined;
  captureStreamLlm = false;
  streamLlmCalls.length = 0;
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

describe('AUTHOR-DECOMPOSE-KNOB planning LLM selection', () => {
  test('routes the decompose and critic streamLLM calls through the roleLlm.planning model·effort when set', async () => {
    const savedEnvModel = process.env.ELANOUS_PROMPT_ENHANCE_MODEL;
    const savedEnvEffort = process.env.ELANOUS_PROMPT_ENHANCE_EFFORT;
    delete process.env.ELANOUS_PROMPT_ENHANCE_MODEL;
    delete process.env.ELANOUS_PROMPT_ENHANCE_EFFORT;
    setUserConfigOverlay((config) => ({
      ...config,
      tools: { ...config.tools, selfImplement: { ...config.tools.selfImplement, observeOnly: false } },
      // provider 를 명시해야 전역 provider 해석(자격 증명 필요)을 안 탄다 — 키 없는 게이트 Pod 에서 NoLlmProviderAvailableError(0.2.24 게이트).
      roleLlm: { ...config.roleLlm, planning: { provider: 'openai-codex', model: 'planning-knob-model', effort: 'medium' } },
    }));
    decomposeCallablePrompt = 'DECOMPOSE PROMPT MARKER';
    criticPrompt = 'CRITIC PROMPT MARKER';
    captureStreamLlm = true;
    try {
      const steps = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: true })('implement a robust goal author seam');
      expect(steps).toEqual(originalSteps);
      expect(streamLlmCalls.length).toBe(2);
      const [decomposeCall, criticCall] = streamLlmCalls;
      expect(decomposeCall?.messages).toEqual([{ role: 'user', content: 'DECOMPOSE PROMPT MARKER' }]);
      expect(decomposeCall?.opts).toStrictEqual({ model: 'planning-knob-model', reasoningEffort: 'medium' });
      expect(criticCall?.messages).toEqual([{ role: 'user', content: 'CRITIC PROMPT MARKER' }]);
      expect(criticCall?.opts).toStrictEqual({ model: 'planning-knob-model', reasoningEffort: 'medium' });
    } finally {
      captureStreamLlm = false;
      decomposeCallablePrompt = undefined;
      criticPrompt = undefined;
      if (savedEnvModel === undefined) delete process.env.ELANOUS_PROMPT_ENHANCE_MODEL;
      else process.env.ELANOUS_PROMPT_ENHANCE_MODEL = savedEnvModel;
      if (savedEnvEffort === undefined) delete process.env.ELANOUS_PROMPT_ENHANCE_EFFORT;
      else process.env.ELANOUS_PROMPT_ENHANCE_EFFORT = savedEnvEffort;
    }
  });

  test('keeps the default model and high effort for both calls when no planning knob is set', async () => {
    const savedEnvModel = process.env.ELANOUS_PROMPT_ENHANCE_MODEL;
    const savedEnvEffort = process.env.ELANOUS_PROMPT_ENHANCE_EFFORT;
    delete process.env.ELANOUS_PROMPT_ENHANCE_MODEL;
    delete process.env.ELANOUS_PROMPT_ENHANCE_EFFORT;
    setUserConfigOverlay((config) => {
      const roleLlm = { ...config.roleLlm };
      delete roleLlm.planning;
      return {
        ...config,
        tools: { ...config.tools, selfImplement: { ...config.tools.selfImplement, observeOnly: false } },
        roleLlm,
      };
    });
    decomposeCallablePrompt = 'DECOMPOSE PROMPT MARKER';
    criticPrompt = 'CRITIC PROMPT MARKER';
    captureStreamLlm = true;
    try {
      const steps = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: true })('implement a robust goal author seam');
      expect(steps).toEqual(originalSteps);
      expect(streamLlmCalls.length).toBe(2);
      for (const call of streamLlmCalls) {
        expect(call.opts).toStrictEqual({ reasoningEffort: 'high' });
      }
    } finally {
      captureStreamLlm = false;
      decomposeCallablePrompt = undefined;
      criticPrompt = undefined;
      if (savedEnvModel === undefined) delete process.env.ELANOUS_PROMPT_ENHANCE_MODEL;
      else process.env.ELANOUS_PROMPT_ENHANCE_MODEL = savedEnvModel;
      if (savedEnvEffort === undefined) delete process.env.ELANOUS_PROMPT_ENHANCE_EFFORT;
      else process.env.ELANOUS_PROMPT_ENHANCE_EFFORT = savedEnvEffort;
    }
  });

  test('routes the calls through ELANOUS_PROMPT_ENHANCE_MODEL/EFFORT ahead of the planning spec', async () => {
    const savedEnvModel = process.env.ELANOUS_PROMPT_ENHANCE_MODEL;
    const savedEnvEffort = process.env.ELANOUS_PROMPT_ENHANCE_EFFORT;
    process.env.ELANOUS_PROMPT_ENHANCE_MODEL = 'env-knob-model';
    process.env.ELANOUS_PROMPT_ENHANCE_EFFORT = 'low';
    setUserConfigOverlay((config) => ({
      ...config,
      tools: { ...config.tools, selfImplement: { ...config.tools.selfImplement, observeOnly: false } },
      roleLlm: { ...config.roleLlm, planning: { provider: 'openai-codex', model: 'planning-knob-model', effort: 'medium' } },
    }));
    decomposeCallablePrompt = 'DECOMPOSE PROMPT MARKER';
    criticPrompt = 'CRITIC PROMPT MARKER';
    captureStreamLlm = true;
    try {
      await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: true })('implement a robust goal author seam');
      expect(streamLlmCalls.length).toBe(2);
      for (const call of streamLlmCalls) {
        expect(call.opts).toStrictEqual({ model: 'env-knob-model', reasoningEffort: 'low' });
      }
    } finally {
      captureStreamLlm = false;
      decomposeCallablePrompt = undefined;
      criticPrompt = undefined;
      if (savedEnvModel === undefined) delete process.env.ELANOUS_PROMPT_ENHANCE_MODEL;
      else process.env.ELANOUS_PROMPT_ENHANCE_MODEL = savedEnvModel;
      if (savedEnvEffort === undefined) delete process.env.ELANOUS_PROMPT_ENHANCE_EFFORT;
      else process.env.ELANOUS_PROMPT_ENHANCE_EFFORT = savedEnvEffort;
    }
  });
});

afterAll(() => {
  // ⭐ R-TST23 — 치환했던 세 모듈을 원본 구현으로 복구한다(mock.module 은 자동 복구되지 않는다).
  mock.module('../harness/llm-decompose.js', () => llmDecomposeOriginal);
  mock.module('../harness/adversarial-plan.js', () => adversarialPlanOriginal);
  mock.module('../llm.js', () => llmOriginal);
});

// ⭐ AUTHOR-SHADOW-FIRST-SPLIT ① — #27040 이 «분류기를 부르는 시험 0» 으로 수렴 실패했다.
//    발동은 명시 표지 «분할: 그림자 먼저» 한 줄뿐이다(OP 결정 10-15 — 자연어 감지 발동은 후속 개선).
//    여기 시험은 분류기 단독이 아니라 «실제 호출 경로»(runGoalAuthorCli → 기본 분해 seam → authorGoal 의 ## STEPS)를
//    통과해, 분기를 지우면 실패한다(표지 골에서 LLM 분해 mock 의 originalSteps 가 대신 나온다).
const MARKED_ASK = '대상 경로: src/task-agent/live-moves.ts\nTA 가 리뷰 통과 뒤 스스로 착지한다.\n분할: 그림자 먼저\n판정: 운영 원장에 TA 자가 착지가 실제로 1건 이상 일어난다.';
// 리뷰 r1~r6 의 자연어 반례 전부 — 표지가 없으므로 어느 것도 쪼개지지 않는다.
const UNMARKED_ASKS = [
  'TA 가 리뷰 통과 뒤 스스로 착지한다.\n판정: 운영 원장에 TA 자가 착지가 실제로 1건 이상 일어난다.',
  'TA 자가 착지 · 판정: 운영 원장에 실제로 1건',
  '자동 테스트 보강 · 죽은 코드 삭제 · 판정: 운영에서 실제로 장애 0건',
  'TA가 스스로 착지하도록 배선한다.\n설명: 운영에서 실제로 장애가 발생했다.\n판정: bun test src/task-agent/live-moves.test.ts → 0 fail',
  'TA가 스스로 착지하지 않게 막는다. 판정: 운영에서 실제로 자가 착지 0건',
  '대상: src/acceptance.test.ts\nTA가 스스로 착지한다.\n판정: 운영에서 실제로 1건',
  'TA 자가 착지 방지 · 판정: 운영에서 실제로 착지 0건',
  'live move 비활성화 · 판정: 운영에서 실제로 착지 0건',
  'TA가 스스로 착지한다. 판정: in production은 아직 확인하지 못함',
  'TA 자가 착지하지 말라.\n판정: 운영에서 실제로 착지 시도 1건 이상 차단',
  '죽은 코드 삭제 · 판정: bun test src/example.test.ts → 0 fail.',
];
// 표지와 «비슷하지만 정확한 꼴이 아닌» 문면 — 발동하지 않는다.
const NEAR_MISS_MARKER_ASKS = [
  'TA 착지 · 분할: 그림자 먼저',
  '분할: 그림자 먼저 하지 않는다',
  '설명에 «분할: 그림자 먼저» 표지를 언급한다',
  '분할 : 그림자먼저',
  '분할:그림자 먼저',
  '분할:   그림자 먼저',
  '  분할: 그림자 먼저',
  '분할: 그림자 먼저  ',
];

function shadowFirstSplitLogs(log: { mock: { calls: unknown[][] } }): unknown[][] {
  return log.mock.calls.filter(([category, event]) => category === 'goal-author' && event === 'shadow-first-split');
}

describe('AUTHOR-SHADOW-FIRST-SPLIT ① explicit-marker classifier', () => {
  test('the marker line splits into shadow → live with one predecessor edge', () => {
    const verdict = classifyShadowFirstSplit(MARKED_ASK);
    if (verdict.kind !== 'shadow-first-split') throw new Error(`expected split, got ${verdict.kind}`);
    expect(verdict.pieces.map((piece) => piece.id)).toEqual(['shadow', 'live']);
    expect(verdict.pieces[0].dependsOn).toEqual([]);
    expect(verdict.pieces[1].dependsOn).toEqual(['shadow']);
    expect(verdict.pieces.reduce((edges, piece) => edges + piece.dependsOn.length, 0)).toBe(1);
    expect(verdict.pieces[0].step).toContain('«기록만»');
    expect(verdict.pieces[1].step).toContain('선행 = ①');
  });

  test('the marker must be a whole line exactly (no leading/trailing whitespace); only a CRLF line ending is tolerated', () => {
    expect(classifyShadowFirstSplit(`골 문면\r\n${SHADOW_FIRST_SPLIT_MARKER}\r\n판정: x`).kind).toBe('shadow-first-split');
    expect(classifyShadowFirstSplit(SHADOW_FIRST_SPLIT_MARKER).kind).toBe('shadow-first-split');
  });

  test('a lone CR not followed by LF is not a line ending — the marker does not trigger (r8 regression)', () => {
    expect(classifyShadowFirstSplit(`${SHADOW_FIRST_SPLIT_MARKER}\r`)).toEqual({ kind: 'single-piece' });
    expect(classifyShadowFirstSplit(`골 문면\n${SHADOW_FIRST_SPLIT_MARKER}\r판정: x`)).toEqual({ kind: 'single-piece' });
  });

  test.each(UNMARKED_ASKS)('no marker → single-piece for any wording (r1~r6 counterexamples): %s', (ask) => {
    expect(classifyShadowFirstSplit(ask)).toEqual({ kind: 'single-piece' });
  });

  test.each(NEAR_MISS_MARKER_ASKS)('a near-miss of the exact marker form does not trigger: %s', (ask) => {
    expect(classifyShadowFirstSplit(ask)).toEqual({ kind: 'single-piece' });
  });
});

describe('AUTHOR-SHADOW-FIRST-SPLIT ① decomposition seam', () => {
  test('a marked goal returns the two pieces without calling the LLM decomposition or the critic', async () => {
    captureStreamLlm = true;
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const steps = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: true })(MARKED_ASK, { runId: 'run-shadow' });
      expect(steps).toHaveLength(2);
      expect(steps[0]).toStartWith('① 그림자');
      expect(steps[1]).toStartWith('② live 스위치');
      expect(decompositionOptions).toBeUndefined();
      expect(critiqueCalls).toBe(0);
      expect(streamLlmCalls).toHaveLength(0);
      expect(shadowFirstSplitLogs(log)).toEqual([[
        'goal-author', 'shadow-first-split', expect.objectContaining({ verdict: 'shadow-first-split', trigger: 'explicit-marker', pieces: ['shadow', 'live'], edges: 1, runId: 'run-shadow' }),
      ]]);
    } finally { log.mockRestore(); }
  });

  test.each(UNMARKED_ASKS)('an unmarked goal keeps the LLM decomposition with no shadow-first-split observation: %s', async (ask) => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      expect(await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false })(ask)).toEqual(originalSteps);
      expect(decompositionOptions).toBeDefined();
      expect(shadowFirstSplitLogs(log)).toEqual([]);
    } finally { log.mockRestore(); }
  });

  test('a marker only in grounding context does not split', async () => {
    expect(await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false })(UNMARKED_ASKS[0]!, {
      context: SHADOW_FIRST_SPLIT_MARKER,
    })).toEqual(originalSteps);
  });
});

// ⚠️ 범위: CLI 기본 seam → authorGoal 의 저작 문서(## STEPS)까지다. 파일 쓰기(write)는 stub — 디스크 출력은 이 시험이 증명하지 않는다.
describe('AUTHOR-SHADOW-FIRST-SPLIT ① production call path (runGoalAuthorCli → default seam → authorGoal ## STEPS · write stubbed)', () => {
  const authorFacts = {
    grounded: true, context: '', files: ['src/example.ts'],
    persistentEvidence: ['src/example.ts:42 — authorGoal receives this Read-verified call path.'],
    codeFacts: ['[code:src/example.ts] exampleExport'], skillFacts: [], memoryFacts: [],
    documentFacts: ['docs/example.md'], refFacts: [], ptyFacts: [],
  };
  const authorThroughGoalAuthor = (documents: string[]): NonNullable<Parameters<typeof runGoalAuthorCli>[2]>['write'] => async (ask, _cwd, deps) => {
    const authored = await authorGoal(ask, {
      ...deps,
      ground: async () => authorFacts,
      enhance: async (raw) => ({ original: raw, checklist: ['embed the exact ask in the authored document'], verbatimPreserved: true }),
      slugFn: async () => 'shadow-first-split',
    });
    documents.push(authored.document);
    return { path: 'docs/goals/GOAL-shadow.md', authored };
  };
  const stepsSection = (document: string): string[] => {
    const lines = document.split('\n');
    const start = lines.indexOf('## STEPS');
    if (start < 0) return [];
    const out: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith('- ')) break;
      out.push(line.slice(2));
    }
    return out;
  };

  test('a marked ask is authored with shadow then live steps and no LLM decomposition call', async () => {
    const documents: string[] = [];
    await runGoalAuthorCli([MARKED_ASK], { cwd: process.cwd(), disableAdversarialReview: true }, {
      recentStepCountReader: () => [], write: authorThroughGoalAuthor(documents),
    });
    expect(documents).toHaveLength(1);
    const steps = stepsSection(documents[0]!);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toStartWith('① 그림자');
    expect(steps[1]).toStartWith('② live 스위치 — 선행 = ①');
    expect(decompositionOptions).toBeUndefined();
  });

  test.each(UNMARKED_ASKS)('an unmarked ask is authored with the unchanged LLM decomposition (one piece stays one piece): %s', async (ask) => {
    decomposition = ['한 조각'];
    const documents: string[] = [];
    await runGoalAuthorCli([ask], { cwd: process.cwd(), disableAdversarialReview: true }, {
      recentStepCountReader: () => [], write: authorThroughGoalAuthor(documents),
    });
    expect(stepsSection(documents[0]!)).toEqual(['한 조각']);
    expect(decompositionOptions).toBeDefined();
  });

  test('an unmarked ask keeps a multi-piece LLM decomposition unchanged', async () => {
    const documents: string[] = [];
    await runGoalAuthorCli([UNMARKED_ASKS[0]!], { cwd: process.cwd(), disableAdversarialReview: true }, {
      recentStepCountReader: () => [], write: authorThroughGoalAuthor(documents),
    });
    expect(stepsSection(documents[0]!)).toEqual(originalSteps);
  });
});
