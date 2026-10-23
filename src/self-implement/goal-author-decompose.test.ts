import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import * as llmDecomposeActual from '../harness/llm-decompose.js';
import * as adversarialPlanActual from '../harness/adversarial-plan.js';
import * as llmActual from '../llm.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetLiveDetailCacheForTesting, writeLiveDetail } from '../live/detail-switch.js';
import { setUserConfigOverlay } from '../user-config.js';
import { parseAskTargetPathHintsResult } from '../self-dev/launch-preflight-text.js';
import { composeSliceHandText } from '../task-agent/tier-split.js';

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
let useRealDecompose = false;
const scriptedLlmReplies: string[] = [];
let stateRoot: string;
let originalStateDir: string | undefined;

mock.module('../harness/llm-decompose.js', () => ({
  llmDecomposeSteps: async (_objective: string, callable: unknown, options?: Record<string, unknown>) => {
    decompositionOptions = options;
    if (useRealDecompose) return llmDecomposeOriginal.llmDecomposeSteps(_objective, callable as Parameters<typeof llmDecomposeOriginal.llmDecomposeSteps>[1], options);
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
    if (scriptedLlmReplies.length) return scriptedLlmReplies.shift()!;
    if (JSON.stringify(args[0]).includes('GOAL_AUTHOR_SLICE_SIZE')) {
      const content = String((args[0][0] as { content?: unknown })?.content ?? '');
      const steps = JSON.parse(content.split('STEPS_JSON: ')[1] ?? '[]') as string[];
      return JSON.stringify({ slices: steps.map(() => ({ files: 1, actions: 1, newFiles: 0, tier: 'low' })) });
    }
    if (!captureStreamLlm) return llmActual.streamLLM(...args);
    streamLlmCalls.push({ messages: args[0], opts: args[2] });
    return 'MOCK STREAM LLM TEXT';
  },
}));

const { classifyShadowFirstSplit, COMPLETION_BOUNDARY_STEP_PREFIX, createGoalAuthorDecomposeSteps, decomposeGoal,
  decomposeToTierSizedSlices, parseCompletionBoundaryRows,
  readRecentStepCountsFailOpen, SHADOW_FIRST_SPLIT_MARKER } = await import('./goal-author-decompose.js');
const { authorGoal, writeAuthoredGoal } = await import('./goal-author.js');
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
  useRealDecompose = false;
  scriptedLlmReplies.length = 0;
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
    ['default with a successful empty read', {}, undefined, () => [] as readonly number[], ['recentStepCounts', 'repositoryRoot'], undefined],
    ['forced review with a successful read', { adversarialReview: true }, true, () => [3] as readonly number[], ['adversarialReview', 'recentStepCounts', 'repositoryRoot'], 'cli'],
    ['disabled review with a successful read', { disableAdversarialReview: true }, false, () => [3] as readonly number[], ['adversarialReview', 'recentStepCounts', 'repositoryRoot'], 'cli'],
    ['default with a failed read', {}, undefined, () => { throw new Error('log store unavailable'); }, ['repositoryRoot'], undefined],
    ['forced review with a failed read', { adversarialReview: true }, true, () => { throw new Error('log store unavailable'); }, ['adversarialReview', 'repositoryRoot'], 'cli'],
    ['disabled review with a failed read', { disableAdversarialReview: true }, false, () => { throw new Error('log store unavailable'); }, ['adversarialReview', 'repositoryRoot'], 'cli'],
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

describe('TIER-SIZED-DECOMPOSE fake-LLM L2', () => {
  const proposal = (titles: string[]) => JSON.stringify({ rationale: 'Implement each slice independently.',
    tasks: titles.map((title, index) => ({ index, title, surface: { kind: 'llm-direct', prompt: title } })) });
  const sizes = (slices: object[]) => JSON.stringify({ slices });

  test('DEVICE-FIRST-E4-LIVE: real decomposition callsite inserts device stage before a scripted feature slice', async () => {
    useRealDecompose = true;
    scriptedLlmReplies.push(proposal(['대상 경로: src/feature.ts · 동작: 기능 배선']), sizes([
      { files: 2, actions: 1, newFiles: 1, tier: 'low' },
      { files: 1, actions: 1, newFiles: 0, tier: 'low' },
    ]));
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await decomposeToTierSizedSlices('대상 경로: src/feature.ts · 완료 경계 증거 명령: bun test src/feature.test.ts\n필요한 장치: fault-synthetic', { repositoryRoot: process.cwd() });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.slices.map((slice) => slice.deviceFirst)).toEqual(['device-test', 'feature']);
        expect(result.slices[0]?.goal).toContain('src/ux-sim/fault-synthetic.ts');
        expect(result.slices[0]?.goal).toContain('신설: src/ux-sim/fault-synthetic.ts');
        expect(result.slices[0]?.goal).toContain('완료 경계 증거 명령: bun test src/ux-sim/fault-synthetic.test.ts');
        expect(result.slices[1]?.goal).toContain('선행: DEVICE-FIRST-STAGE 조각 착지 뒤 발사');
        expect(result.slices[1]?.goal).toContain('신규 시험(이 조각에서 먼저 신설) src/feature.test.ts');
        expect(result.slices[1]?.goal).toContain('피처 시험 bun test src/feature.test.ts를 구현 전에 RED로 확인');
      }
      expect(log).toHaveBeenCalledWith('self-implement.decompose', 'device-first-slice', expect.objectContaining({ firstSliceKind: 'device-test', deviceSource: 'goal', deviceExists: false, inventoryMeasured: true }));
    } finally { log.mockRestore(); }
  });

  test('DEVICE-FIRST-E4-LIVE: device inventory reads the target repository root', async () => {
    useRealDecompose = true;
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'device-first-target-'));
    mkdirSync(join(repositoryRoot, 'src/ux-sim'), { recursive: true });
    writeFileSync(join(repositoryRoot, 'src/ux-sim/fault-synthetic.ts'), 'export const device = true;\n');
    scriptedLlmReplies.push(proposal(['대상 경로: src/feature.ts · 동작: 기능 배선']), sizes([
      { files: 1, actions: 1, newFiles: 1, tier: 'low' },
      { files: 1, actions: 1, newFiles: 0, tier: 'low' },
    ]));
    try {
      const result = await decomposeToTierSizedSlices('대상 경로: src/feature.ts · 장치 우선\n쓸 장치: fault-synthetic', { repositoryRoot });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.slices[0]?.goal).toContain('기존 src/ux-sim/fault-synthetic.ts');
    } finally { rmSync(repositoryRoot, { recursive: true, force: true }); }
  });

  test('DEVICE-FIRST-E4-LIVE: a generic TDD goal does not invent a missing device path', async () => {
    useRealDecompose = true;
    scriptedLlmReplies.push(proposal(['대상 경로: src/index.ts · 동작: 기능 배선']), sizes([
      { files: 1, actions: 1, newFiles: 0, tier: 'low' },
    ]));
    const result = await decomposeToTierSizedSlices('대상 경로: src/index.ts · 완료 경계 증거 명령: bun test src/index.test.ts');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slices).toHaveLength(1);
      expect(result.slices[0]?.deviceFirst).toBeUndefined();
      expect(result.slices[0]?.goal).not.toContain('index-device.ts');
    }
  });

  test('a slice mentioning DEVICE-FIRST-STAGE without the operation is not a device test', async () => {
    useRealDecompose = true;
    scriptedLlmReplies.push(proposal(['대상 경로: src/feature.ts · 동작: 문서에 DEVICE-FIRST-STAGE 표기 보존']), sizes([
      { files: 1, actions: 1, newFiles: 0, tier: 'low' },
    ]));
    const result = await decomposeToTierSizedSlices('대상 경로: src/feature.ts · 동작: 문서 표기를 보존한다');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slices[0]?.deviceFirst).toBeUndefined();
  });

  test('missing size JSON derives only from explicit paths and action clauses', async () => {
    useRealDecompose = true;
    scriptedLlmReplies.push(
      proposal(['대상 경로: src/a.ts, src/a.test.ts · 동작: 연결 · 동작: 검증']),
      '{"slices":[{"tier":"medium"}]}',
    );
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      expect(await decomposeToTierSizedSlices('wire a and test it')).toEqual({ ok: true, redecomposed: 0,
        slices: [{ goal: '대상 경로: src/a.ts, src/a.test.ts · 동작: 연결 · 동작: 검증',
          files: 2, behaviours: 2, newFiles: 0, tier: '중' }] });
      expect(log).toHaveBeenCalledWith('goal-author.decompose', 'slice-sized', expect.objectContaining({
        sizeSource: 'derived', retry: 0,
      }));
    } finally { log.mockRestore(); }
  });

  test('restores basename target and new-file paths from the parent goal', async () => {
    useRealDecompose = true;
    scriptedLlmReplies.push(proposal([
      '대상 경로: precedent-lookup.ts · 동작: 조회 · 신규 경로: precedent-lookup.test.ts',
      '대상 경로: doctor-cli.ts · 동작: 배선',
    ]), sizes([
      { files: 2, actions: 1, newFiles: 1, tier: 'low' },
      { files: 1, actions: 1, newFiles: 0, tier: 'low' },
    ]));
    const result = await decomposeToTierSizedSlices('대상 경로: src/cli/doctor-cli.ts\n신설: src/self-implement/precedent-lookup.ts · src/self-implement/precedent-lookup.test.ts');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slices.map((slice) => slice.goal)).toEqual([
      '대상 경로: src/self-implement/precedent-lookup.ts · 동작: 조회 · 신규 경로: src/self-implement/precedent-lookup.test.ts',
      '대상 경로: src/cli/doctor-cli.ts · 동작: 배선',
    ]);
  });

  test('restores every basename in a multi-path target clause', async () => {
    useRealDecompose = true;
    scriptedLlmReplies.push(proposal(['대상 경로: a.ts · b.ts · 동작: 연결']),
      sizes([{ files: 2, actions: 1, newFiles: 0, tier: 'low' }]));
    const result = await decomposeToTierSizedSlices('대상 경로: src/a.ts · src/b.ts');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slices[0]?.goal).toBe('대상 경로: src/a.ts · src/b.ts · 동작: 연결');
  });

  test('keeps a root file and reads bulleted parent and slice paths', async () => {
    useRealDecompose = true;
    scriptedLlmReplies.push(proposal(['- 대상 경로: package.json · 작업: 검사\n- 신설: new.test.ts']),
      sizes([{ files: 2, actions: 1, newFiles: 1, tier: 'low' }]));
    const result = await decomposeToTierSizedSlices('- 대상 경로: package.json\n- 신설: src/new.test.ts');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slices[0]?.goal).toBe('- 대상 경로: package.json · 작업: 검사\n- 신설: src/new.test.ts');
  });

  test('omits ambiguous and absent basename slices and records each unresolved path', async () => {
    useRealDecompose = true;
    scriptedLlmReplies.push(proposal([
      '대상 경로: shared.ts · 동작: 충돌',
      '대상 경로: missing.ts · 동작: 누락',
      '대상 경로: src/cli/doctor-cli.ts · 동작: 배선',
    ]), sizes(Array.from({ length: 3 }, () => ({ files: 1, actions: 1, newFiles: 0, tier: 'low' }))));
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await decomposeToTierSizedSlices('대상 경로: src/a/shared.ts · src/b/shared.ts · src/cli/doctor-cli.ts');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.slices.map((slice) => slice.goal)).toEqual(['대상 경로: src/cli/doctor-cli.ts · 동작: 배선']);
      expect(log).toHaveBeenCalledWith('self-implement.decompose', 'slice-path-unresolved',
        { sliceIndex: 0, path: 'shared.ts', candidates: ['src/a/shared.ts', 'src/b/shared.ts'] });
      expect(log).toHaveBeenCalledWith('self-implement.decompose', 'slice-path-unresolved',
        { sliceIndex: 1, path: 'missing.ts', candidates: [] });
    } finally { log.mockRestore(); }
  });

  test('blocks the whole split when every basename path is unresolved', async () => {
    useRealDecompose = true;
    scriptedLlmReplies.push(proposal(['대상 경로: missing.ts · 동작: 누락']),
      sizes([{ files: 1, actions: 1, newFiles: 0, tier: 'low' }]));
    expect(await decomposeToTierSizedSlices('대상 경로: src/a.ts')).toEqual({ ok: false, reason: 'slice-path-unresolved' });
  });

  test('size JSON accepts the requested behaviours field', async () => {
    useRealDecompose = true;
    scriptedLlmReplies.push(proposal(['wire a']),
      sizes([{ files: 2, behaviours: 1, newFiles: 1, tier: 'low', unavoidableReason: null }]));
    expect(await decomposeToTierSizedSlices('wire a')).toEqual({ ok: true, redecomposed: 0,
      slices: [{ goal: 'wire a', files: 2, behaviours: 1, newFiles: 1, tier: '하' }] });
  });

  test('missing metadata without explicit path and action remains blocked after one retry', async () => {
    useRealDecompose = true;
    scriptedLlmReplies.push(proposal(['implement a feature']), '{}', proposal(['still vague']), '{}');
    expect(await decomposeToTierSizedSlices('build goal')).toEqual({ ok: false,
      reason: 'goal-author slice sizing: size metadata missing after one retry' });
  });

  test('public hand seam returns each final goal, tier, size and retry count', async () => {
    useRealDecompose = true;
    scriptedLlmReplies.push(
      proposal(['large slice']),
      sizes([{ files: 6, actions: 3, newFiles: 3, tier: 'high' }]),
      proposal(['small A', 'small B']),
      sizes([{ files: 3, actions: 2, newFiles: 1, tier: 'medium' },
        { files: 2, actions: 1, newFiles: 0, tier: 'low' }]),
    );
    expect(await decomposeToTierSizedSlices('build large goal')).toEqual({ ok: true, redecomposed: 1,
      slices: [{ goal: 'small A', files: 3, behaviours: 2, newFiles: 1, tier: '중' },
        { goal: 'small B', files: 2, behaviours: 1, newFiles: 0, tier: '하' }] });
  });

  test('an oversized first proposal is regenerated once into medium slices with observed sizes', async () => {
    useRealDecompose = true;
    scriptedLlmReplies.push(
      proposal(['large slice']),
      sizes([{ files: 6, actions: 3, newFiles: 3, tier: 'high' }]),
      proposal(['small A', 'small B']),
      sizes([{ files: 3, actions: 2, newFiles: 1, tier: 'medium' },
        { files: 2, actions: 1, newFiles: 0, tier: 'low' }]),
    );
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false })('build large goal');
      expect(result).toEqual(['small A', 'small B']);
      expect(scriptedLlmReplies).toHaveLength(0);
      expect(log).toHaveBeenCalledWith('goal-author.decompose', 'slice-sized', expect.objectContaining({
        retry: 1, slices: [expect.objectContaining({ files: 3, actions: 2, tier: 'medium' }),
          expect.objectContaining({ files: 2, actions: 1, tier: 'low' })],
      }));
      expect(log).toHaveBeenCalledWith('goal-author.decompose', 'slice-oversize', expect.objectContaining({
        retry: 0, indexes: [0], reasons: [null], sizeSource: 'planner-estimate',
      }));
    } finally { log.mockRestore(); }
  });

  test('an unavoidable high slice survives one retry only with its reason', async () => {
    useRealDecompose = true;
    scriptedLlmReplies.push(
      proposal(['inseparable integration']),
      sizes([{ files: 5, actions: 3, newFiles: 2, tier: 'high' }]),
      proposal(['inseparable integration']),
      sizes([{ files: 5, actions: 3, newFiles: 2, tier: 'high', unavoidableReason: 'shared transaction must change together' }]),
    );
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      expect(await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false })('build atomic integration'))
        .toEqual(['inseparable integration']);
      expect(log).toHaveBeenCalledWith('goal-author.decompose', 'slice-oversize', expect.objectContaining({
        retry: 1, reasons: ['shared transaction must change together'],
      }));
    } finally { log.mockRestore(); }
  });

  test('a high slice without an unavoidable reason fails after its single retry', async () => {
    useRealDecompose = true;
    scriptedLlmReplies.push(
      proposal(['large slice']),
      sizes([{ files: 5, actions: 3, newFiles: 2, tier: 'high' }]),
      proposal(['still large']),
      sizes([{ files: 5, actions: 3, newFiles: 2, tier: 'high', unavoidableReason: null }]),
    );
    await expect(createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false })('build large goal'))
      .rejects.toThrow('high slice lacks unavoidable reason after one retry');
    expect(scriptedLlmReplies).toHaveLength(0);
  });

  test('a revised adversarial plan keeps its sizing failure instead of falling back to the original', async () => {
    useRealDecompose = true;
    critique = { revisedSteps: ['revised large slice'], issues: ['scope too large'] };
    scriptedLlmReplies.push(
      proposal(['original slice']),
      sizes([{ files: 5, actions: 3, newFiles: 2, tier: 'high' }]),
      proposal(['still large']),
      sizes([{ files: 5, actions: 3, newFiles: 2, tier: 'high', unavoidableReason: null }]),
    );
    await expect(createGoalAuthorDecomposeSteps(undefined, { adversarialReview: true })('build large goal'))
      .rejects.toThrow('high slice lacks unavoidable reason after one retry');
    expect(scriptedLlmReplies).toHaveLength(0);
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
      maxTasks: 15,
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
      expect(log.mock.calls.filter(([category]) => category === 'goal-author')).toEqual([[
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
//    발동은 명시 표지 «분할: 그림자 먼저» 한 줄 ⊕ 자연어 요청(0.2.35 must-fix ① — 그림자 우선 어휘 ⊕ 분할 지시 어휘쌍)이다.
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
// 리뷰 r4~r6 자연어 반례의 짝 — 표지 없이 실제로 분할을 요청하는 문면(+)과 부정·거절·콜론형 문면(−)을 나란히 고정한다.
const NL_TRIGGER_ASKS = [
  '그림자 먼저 두 조각으로 분할해',
  '이 골은 그림자 먼저 분할해서 착지시킨다',
  'shadow first 로 나눠',
  'shadow-first split 두 조각으로 나누어',
  '이 골을 그림자 먼저 쪼개',
];
const NL_NON_TRIGGER_ASKS = [
  '그림자 먼저 분할해선 안 된다',
  '그림자 먼저로 나눠서는 안 된다',
  '그림자 먼저 쪼개는 것을 금지한다',
  '그림자 먼저 쪼개지 말라',
  '그림자 먼저로 쪼개지 않는다',
  '분할: 그림자 먼저로 나눠',
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
    expect(verdict.trigger).toBe('explicit-marker');
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

describe('AUTHOR-SHADOW-FIRST-SPLIT ① natural-language trigger (0.2.35 must-fix ①)', () => {
  test.each(NL_TRIGGER_ASKS)('a natural-language split request triggers without the marker line: %s', (ask) => {
    const verdict = classifyShadowFirstSplit(ask);
    if (verdict.kind !== 'shadow-first-split') throw new Error(`expected split, got ${verdict.kind}`);
    expect(verdict.trigger).toBe('natural-language');
    expect(verdict.pieces.map((piece) => piece.id)).toEqual(['shadow', 'live']);
    expect(verdict.pieces[1].dependsOn).toEqual(['shadow']);
  });

  test.each(NL_NON_TRIGGER_ASKS)('negated · refused · colon-form lines stay single-piece: %s', (ask) => {
    expect(classifyShadowFirstSplit(ask)).toEqual({ kind: 'single-piece' });
  });

  test('the r1~r6 counterexamples keep their trigger-free single-piece verdicts', () => {
    for (const ask of UNMARKED_ASKS) {
      expect(classifyShadowFirstSplit(ask)).toEqual({ kind: 'single-piece' });
    }
  });

  test('the seam logs trigger natural-language and the NL rationale on the same call path', async () => {
    captureStreamLlm = true;
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const steps = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: true })(NL_TRIGGER_ASKS[0]!, { runId: 'run-nl' });
      expect(steps).toHaveLength(2);
      expect(steps[0]).toStartWith('① 그림자');
      expect(steps[1]).toStartWith('② live 스위치');
      expect(decompositionOptions).toBeUndefined();
      expect(critiqueCalls).toBe(0);
      expect(streamLlmCalls).toHaveLength(0);
      expect(shadowFirstSplitLogs(log)).toEqual([[
        'goal-author', 'shadow-first-split', expect.objectContaining({ verdict: 'shadow-first-split', trigger: 'natural-language', pieces: ['shadow', 'live'], edges: 1, runId: 'run-nl' }),
      ]]);
    } finally { log.mockRestore(); }
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

// ⚠️ 범위: CLI 기본 seam → authorGoal 의 저작 문서(## STEPS)까지다. 파일 쓰기(write)는 stub — 디스크 출력은 아래 «disk proof» 블록이 맡는다.
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

  test('a natural-language ask (no marker line) is authored with shadow then live steps through the same CLI path', async () => {
    const documents: string[] = [];
    await runGoalAuthorCli([NL_TRIGGER_ASKS[0]!], { cwd: process.cwd(), disableAdversarialReview: true }, {
      recentStepCountReader: () => [], write: authorThroughGoalAuthor(documents),
    });
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

// ⭐ 디스크 실증: write stub 를 걷어낸다 — CLI 기본 writeFile 이 실물 writeAuthoredGoal 이 만든 경로에 실제 파일을 남기고,
// 그 파일을 다시 읽어 ## STEPS 두 줄을 확인한다. 임시 cwd 안에서만 쓰므로 저장소 docs/goals 는 건드리지 않는다.
describe('AUTHOR-SHADOW-FIRST-SPLIT ① disk proof (runGoalAuthorCli → default seam → writeAuthoredGoal → file on disk)', () => {
  const authorFacts = {
    grounded: true, context: '', files: ['src/example.ts'],
    persistentEvidence: ['src/example.ts:42 — authorGoal receives this Read-verified call path.'],
    codeFacts: ['[code:src/example.ts] exampleExport'], skillFacts: [], memoryFacts: [],
    documentFacts: ['docs/example.md'], refFacts: [], ptyFacts: [],
  };
  let writtenPaths: string[] = [];
  const writeThroughRealWriter = (cwd: string): NonNullable<Parameters<typeof runGoalAuthorCli>[2]>['write'] => async (ask, _cwd, deps) => {
    const result = await writeAuthoredGoal(ask, cwd, {
      ...deps,
      ground: async () => authorFacts,
      enhance: async (raw) => ({ original: raw, checklist: ['embed the exact ask in the authored document'], verbatimPreserved: true }),
      slugFn: async () => 'shadow-first-split',
    });
    writtenPaths.push(result.path);
    return result;
  };

  test('the marked ask leaves two ordered steps in a real goal file on disk', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-shadow-disk-'));
    writtenPaths = [];
    try {
      mkdirSync(join(cwd, 'docs', 'goals'), { recursive: true });
      await runGoalAuthorCli([MARKED_ASK], { cwd, disableAdversarialReview: true }, {
        recentStepCountReader: () => [], write: writeThroughRealWriter(cwd),
      });
      expect(writtenPaths).toHaveLength(1);
      const onDisk = readFileSync(writtenPaths[0]!, 'utf8');
      const lines = onDisk.split('\n');
      const start = lines.indexOf('## STEPS');
      expect(start).toBeGreaterThan(-1);
      expect(lines.slice(start + 1, start + 3)).toEqual([
        expect.stringMatching(/^- ① 그림자/),
        expect.stringMatching(/^- ② live 스위치 — 선행 = ①/),
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('an unmarked ask writes the unchanged LLM decomposition to disk', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-unmarked-disk-'));
    writtenPaths = [];
    try {
      mkdirSync(join(cwd, 'docs', 'goals'), { recursive: true });
      await runGoalAuthorCli([UNMARKED_ASKS[0]!], { cwd, disableAdversarialReview: true }, {
        recentStepCountReader: () => [], write: writeThroughRealWriter(cwd),
      });
      expect(writtenPaths).toHaveLength(1);
      const onDisk = readFileSync(writtenPaths[0]!, 'utf8');
      const lines = onDisk.split('\n');
      const start = lines.indexOf('## STEPS');
      expect(start).toBeGreaterThan(-1);
      expect(lines.slice(start + 1, start + 1 + originalSteps.length).map((line) => line.replace(/^- /, ''))).toEqual(originalSteps);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ⭐ DECOMPOSE-BOUNDARY-ONE-STEP — 완료 경계 3행(코드 · 실물 · 증거 명령)은 직렬 카드 셋이 아니라
//   «한 step ⊕ acceptance 3» 이다. 실측 UX 미션 두 건(ta-20261016-ddf426 · ta-20261016-179cbb)의 문면 형태를
//   입력 예시로 쓴다 — 그 골들이 손으로 닫힌 이유가 «경계 행마다 조각이 생김» 이었고, 이 시험이 그 재발을 잡는다.
const UX_MISSION_GOAL_DFF426 = `[UX] 대시보드 로그 창이 비어 보인다 — 원인 측정과 표시 보정

관측: 10-17 UX 미션 ta-20261016-ddf426. 로그 창이 «0건» 으로 보이지만 저장소에는 행이 있다.
요구: 표시 경로가 읽는 창과 실제 기록 창을 맞춘다.

- 완료 경계 코드: src/display/log-window.ts · src/display/log-window.test.ts
- 완료 경계 실물: 빈 상태 화면이 «0건» 대신 «창 밖 N건» 을 적는다 — 시험 무대 = fake-bin logs 창 고정.
- 완료 경계 증거 명령: bun test src/display/log-window.test.ts

보존 계약: 다른 화면의 기본 동작과 원장 형식은 지금과 같다.`;

const UX_MISSION_GOAL_179CBB = `[UX] 자동 완성 후보가 두 번 뜬다 — 중복 제거

관측: 10-17 UX 미션 ta-20261016-179cbb. 같은 후보가 두 줄로 뜬다.
요구: 후보 목록에서 같은 값을 한 번만 보여 준다.

1. 완료 경계 코드: src/ui/autocomplete.ts · src/ui/autocomplete.test.ts
2. 완료 경계 실물: 두 번 뜨던 후보가 한 줄 — 시험 무대 = ux-sim 스냅샷.
3. 완료 경계 증거 명령: bun test src/ui/autocomplete.test.ts

보존 계약: 키 바인딩·화면 전환 기본 동작은 그대로 둔다.`;

const UX_MISSION_GOALS: string[] = [UX_MISSION_GOAL_DFF426, UX_MISSION_GOAL_179CBB];

type GoalDecomposeResultOf = ReturnType<typeof decomposeGoal>;

// 판정선 그대로 — 경계 3행이 든 골은 step 1 ⊕ acceptance 3 이다.
function expectOneStepWithThreeAcceptance(result: GoalDecomposeResultOf): void {
  expect(result.steps).toHaveLength(1);
  expect(result.acceptance).toHaveLength(3);
}

describe('DECOMPOSE-BOUNDARY-ONE-STEP — 완료 경계 3행 = step 1 ⊕ acceptance 3', () => {
  test.each(UX_MISSION_GOALS)('the three boundary rows are parsed with their kind and verbatim value', (goal) => {
    const rows = parseCompletionBoundaryRows(goal);
    expect(rows.map((row) => row.kind)).toEqual(['code', 'live', 'evidence-command']);
    expect(rows[2]!.command).toBe(rows[2]!.text);
    expect(rows[0]!.paths).toHaveLength(2);
    expect(rows[1]!.paths).toEqual([]);
  });

  test.each(UX_MISSION_GOALS)('a goal with all three boundary rows becomes exactly one step with three acceptance rows', (goal) => {
    const result = decomposeGoal(goal);
    expect(result.bundled).toBe(true);
    expectOneStepWithThreeAcceptance(result);
    expect(result.steps[0]).toStartWith(COMPLETION_BOUNDARY_STEP_PREFIX);
    for (const row of result.rows) expect(result.steps[0]).toInclude(row.text);
    expect(result.acceptance).toEqual(result.rows.map((row) => `${row.label}: ${row.text}`));
  });

  // 반증 — 묶음을 빼면 같은 문면이 step 3 개가 되어 위 판정선(step 1 단언)이 fail 한다.
  test.each(UX_MISSION_GOALS)('with the bundling switch off the same goal degrades to three steps and the one-step assertion fails', (goal) => {
    const unbundled = decomposeGoal(goal, { bundling: false });
    expect(unbundled.steps).toHaveLength(3);
    expect(unbundled.acceptance).toEqual([]);
    expect(() => expectOneStepWithThreeAcceptance(unbundled)).toThrow();
  });

  test.each(UX_MISSION_GOALS)('code-less live and evidence rows survive as cards, not as steps', (goal) => {
    const result = decomposeGoal(goal);
    expect(result.cards.map((card) => card.kind)).toEqual(['step', 'acceptance', 'live', 'evidence']);
    const live = result.cards.find((card) => card.kind === 'live')!;
    const evidence = result.cards.find((card) => card.kind === 'evidence')!;
    expect(live.paths).toBeUndefined();
    expect(evidence.paths).toBeUndefined();
    expect(evidence.command).toBe(result.rows[2]!.text);
    expect(result.cards.find((card) => card.kind === 'acceptance')!.paths).toEqual(result.rows[0]!.paths);
  });

  test('the evidence card carries the exact evidence command of this run', () => {
    const evidence = decomposeGoal(`요구: 표시 보정
- 완료 경계 코드: src/self-implement/goal-author-decompose.ts · src/self-implement/goal-author-decompose.test.ts
- 완료 경계 실물: 경계 3행이 든 골 → step 1 ⊕ acceptance 3.
- 완료 경계 증거 명령: bun test src/self-implement/goal-author-decompose.test.ts`).cards
      .find((card) => card.kind === 'evidence')!;
    expect(evidence.command).toBe('bun test src/self-implement/goal-author-decompose.test.ts');
  });

  test('one or two boundary rows keep the unchanged path (no bundling, no steps)', () => {
    expect(decomposeGoal(`- 완료 경계 코드: src/a/b.ts\n- 완료 경계 실물: 화면에 한 줄`).bundled).toBe(false);
    expect(decomposeGoal(`- 완료 경계 코드: src/a/b.ts\n- 완료 경계 실물: 화면에 한 줄`).steps).toEqual([]);
    expect(decomposeGoal('경계 없음').rows).toEqual([]);
  });
});

describe('DECOMPOSE-BOUNDARY-ONE-STEP — production seam (createGoalAuthorDecomposeSteps)', () => {
  test('the folded RED action uses a test declared only by the evidence command', async () => {
    const goal = '- 완료 경계 코드: src/ui/autocomplete.ts\n- 완료 경계 실물: 후보가 한 줄로 보인다\n- 완료 경계 증거 명령: bun test test/autocomplete.integration.test.ts';
    const steps = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false })(goal);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toInclude('완료 경계에 적힌 test/autocomplete.integration.test.ts');
    expect(steps[0]).not.toInclude('src/ui/autocomplete-device.ts');
  });
  test('a boundary with no declared test path leaves RED target unmeasured', async () => {
    const goal = '- 완료 경계 코드: src/ui/autocomplete.ts\n- 완료 경계 실물: 후보가 한 줄로 보인다\n- 완료 경계 증거 명령: 검사 도구를 정해 실행한다';
    const steps = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false })(goal);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toInclude('시험 경로 미확정');
    expect(steps[0]).not.toInclude('완료 경계에 적힌 시험');
  });
  test.each(UX_MISSION_GOALS)('the seam returns one step and never calls the LLM decomposition', async (goal) => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const steps = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: true })(goal, { runId: 'run-boundary' });
      expect(steps).toHaveLength(1);
      expect(steps[0]).toInclude('완료 경계 증거 명령');
      expect(decompositionOptions).toBeUndefined();
      expect(critiqueCalls).toBe(0);
      expect(log.mock.calls.some((call) => call[1] === 'completion-boundary-bundled'
        && (call[2] as { verdict?: string }).verdict === 'one-step-three-acceptance')).toBe(true);
    } finally { log.mockRestore(); }
  });

  test('a goal with a partial boundary keeps the LLM decomposition', async () => {
    const steps = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false })(
      '- 완료 경계 코드: src/a/b.ts\n- 완료 경계 실물: 화면에 한 줄');
    expect(steps).toEqual(originalSteps);
    expect(decompositionOptions).toBeDefined();
  });

  test.each(UX_MISSION_GOALS)('the seam keeps the one-line step invariant without a repository root (folded device stage)', async (goal) => {
    const steps = await createGoalAuthorDecomposeSteps(undefined, { adversarialReview: false })(goal);
    expect(steps).toHaveLength(1);
    // root === undefined → 접힌 첫 동작 문면의 개행은 fold 단계에서 치환된다(«step 한 줄»).
    expect(steps[0]).not.toInclude('\n');
    // ⭐ must-fix — 접힌 경계 step 은 «구현 지시» 를 그대로 싣는다(acceptance 3행).
    expect(steps[0]).toInclude('완료 경계 코드');
    expect(steps[0]).toInclude('완료 경계 실물');
    expect(steps[0]).toInclude('완료 경계 증거 명령');
    // 장치 RED 는 «같은 런의 첫 동작» 으로 다시 쓴다 — 모순 문구는 없다.
    expect(steps[0]).toInclude('첫 동작(같은 런)');
    expect(steps[0]).toInclude('mock 무대 시험 RED');
    const declaredTest = parseCompletionBoundaryRows(goal)[0]!.paths.find((path) => path.endsWith('.test.ts'))!;
    expect(steps[0]).toInclude(`완료 경계에 적힌 ${declaredTest}`);
    expect(steps[0]).not.toInclude(declaredTest.replace(/\.test\.ts$/u, '-device.ts'));
    expect(steps[0]).not.toInclude('운영 코드 변경 0');
    expect(steps[0]).not.toInclude('선행:');
    // «동작: DEVICE-FIRST-STAGE» 표지가 남으면 publicSizedSlices 가 이 조각을 device-test 로 분류한다.
    expect(steps[0]).not.toInclude('동작: DEVICE-FIRST-STAGE');
  });
});

// ⭐ 경계 3행 골의 생산 소비자 — `decomposeToTierSizedSlices`(tier-split 기본 seam)는
//   경계 분기에서도 크기 메타를 받아야 한다. 우회하면 `ok:false · no sized slices` 로
//   `tasks hand --tier 상|특 --live` 의 tier-split 이 전부 막힌다(0.2.36 회귀).
describe('DECOMPOSE-BOUNDARY-ONE-STEP — production consumer (decomposeToTierSizedSlices)', () => {
  test.each(['', '게이트 격리 실패 조각\n'])('folded RED keeps the declared target paths as the handed slice first line', async (heading) => {
    const targets = 'scripts/release-loop/gate-node.ts · scripts/release-loop/gate-node.test.ts · src/task-orchestrator/surfaces/pod-pool.ts';
    const goal = `${heading}대상 경로: ${targets}\n남음: 격리 Job 발사를 lease 슬롯으로 제한한다.\n- 완료 경계 코드: ${targets}\n- 완료 경계 실물: mock 무대에서 동시 Job 상한을 관측한다.\n- 완료 경계 증거 명령: bun test scripts/release-loop/gate-node.test.ts`;
    const result = await decomposeToTierSizedSlices(goal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slices).toHaveLength(1);
    const sliceGoal = result.slices[0]!.goal;
    expect(sliceGoal.split('\n')[0]).toBe(`대상 경로: ${targets}`);
    expect(sliceGoal.match(/^대상 경로:/gmu)).toHaveLength(1);
    expect(parseAskTargetPathHintsResult(sliceGoal).paths).toEqual([
      'scripts/release-loop/gate-node.ts',
      'scripts/release-loop/gate-node.test.ts',
      'src/task-orchestrator/surfaces/pod-pool.ts',
    ]);
    expect(sliceGoal).toInclude('첫 동작(같은 런)');
    expect(sliceGoal).toInclude('완료 경계 코드');
    const handed = composeSliceHandText(sliceGoal, goal, { index: 1, total: 1, fromTier: '특', cid: 'GATE-ISOLATE-FANOUT-CAP' });
    expect(handed.split('\n')[0]).toBe(`대상 경로: ${targets}`);
    expect(parseAskTargetPathHintsResult(handed).paths).toHaveLength(3);
  });
  test.each(UX_MISSION_GOALS)('a three-row boundary goal sizes into exactly one slice with tier metadata', async (goal) => {
    const result = await decomposeToTierSizedSlices(goal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slices).toHaveLength(1);
    expect(result.redecomposed).toBe(0);
    const slice = result.slices[0]!;
    expect(['하', '중', '상']).toContain(slice.tier);
    expect(slice.files).toBeGreaterThanOrEqual(1);
    expect(slice.behaviours).toBe(1);
    expect(slice.goal).toInclude('완료 경계 코드');
    // ⭐ must-fix — 접힌 경계 조각은 «장치 시험 카드» 로 분류되지 않는다(device-first-deferred 회귀).
    //    deviceFirst 가 'device-test' 로 남으면 handTaskWithTierSplit 이 기능 카드를 0장으로 만든다.
    expect(slice.deviceFirst).toBeUndefined();
    expect(slice.goal).toInclude('첫 동작(같은 런)');
    expect(slice.goal).not.toInclude('운영 코드 변경 0');
    expect(slice.goal).not.toInclude('선행:');
    expect(slice.goal).not.toInclude('동작: DEVICE-FIRST-STAGE');
    expect(decompositionOptions).toBeUndefined();
    expect(critiqueCalls).toBe(0);
  });
});

// ⭐ 생산 호출 경로 실물: runGoalAuthorCli → 기본 seam → writeAuthoredGoal → 디스크의 골 파일.
describe('DECOMPOSE-BOUNDARY-ONE-STEP — production call path (runGoalAuthorCli → default seam → goal file on disk)', () => {
  const authorFacts = {
    grounded: true, context: '', files: ['src/display/log-window.ts'],
    persistentEvidence: ['src/display/log-window.ts:12 — authorGoal receives this Read-verified call path.'],
    codeFacts: ['[code:src/display/log-window.ts] logWindowRows'], skillFacts: [], memoryFacts: [],
    documentFacts: ['docs/example.md'], refFacts: [], ptyFacts: [],
  };
  test.each(UX_MISSION_GOALS)('the authored goal file carries exactly one step line holding the three acceptance rows', async (goal) => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-boundary-disk-'));
    try {
      mkdirSync(join(cwd, 'docs', 'goals'), { recursive: true });
      const written: string[] = [];
      await runGoalAuthorCli([goal], { cwd, disableAdversarialReview: true }, {
        recentStepCountReader: () => [],
        write: async (ask, writeCwd, deps) => {
          const result = await writeAuthoredGoal(ask, writeCwd, {
            ...deps,
            ground: async () => authorFacts,
            enhance: async (raw) => ({ original: raw, checklist: ['embed the exact ask in the authored document'], verbatimPreserved: true }),
            slugFn: async () => 'boundary-one-step',
          });
          if (result) written.push(result.path);
          return result;
        },
      });
      expect(written).toHaveLength(1);
      const lines = readFileSync(written[0]!, 'utf8').split('\n');
      const start = lines.indexOf('## STEPS');
      expect(start).toBeGreaterThan(-1);
      const stepLines: string[] = [];
      for (const line of lines.slice(start + 1)) {
        if (!line.startsWith('- ')) break;
        stepLines.push(line);
      }
      expect(stepLines).toHaveLength(1);
      expect(stepLines[0]).toInclude(COMPLETION_BOUNDARY_STEP_PREFIX);
      // 장치 RED 는 step 2 가 아니라 «같은 런의 첫 동작» 으로 접힌다(step 1 유지 · 모순 문구 0).
      expect(stepLines[0]).toInclude('첫 동작(같은 런)');
      expect(stepLines[0]).not.toInclude('운영 코드 변경 0');
      expect(stepLines[0]).not.toInclude('선행:');
      expect(stepLines[0]).not.toInclude('동작: DEVICE-FIRST-STAGE');
      expect(stepLines[0]).toInclude('완료 경계 코드');
      expect(stepLines[0]).toInclude('완료 경계 실물');
      expect(stepLines[0]).toInclude('완료 경계 증거 명령');
      expect(decompositionOptions).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
