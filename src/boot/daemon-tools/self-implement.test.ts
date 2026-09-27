// P0 — SelfImplement 막(SurfaceUx) 배선 헬퍼 검증(approvePr=confirm·onProgress=progress·base 무손상).
import { test, expect, describe, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setCreateGoalAuthorDecomposeStepsForTesting, _setObserveOnlyConfigReaderForTesting, _setRecentStepCountReaderForTesting, buildSelfImplementDaemonSpec, buildSelfImplementSurfaceSeams, dispatchSelfImplement, parseRecentStepCountsFromLogRows, readRecentStepCountsFromLogStore, resolveDispatchEntry } from './self-implement.js';
import { summarizeToolResult } from '../daemon-prompt-turn.js';
import type { SelfImplementResult, SelfImplementSeams } from '../../self-implement/orchestrator.js';
import type { DefaultSeamsOptions } from '../../self-implement/seams.js';
import type { SurfaceUx } from '../../agent/surface-ux/types.js';
import { setUserConfigOverlay } from '../../user-config.js';
import { _setAutoOpenPrConfigReaderForTesting } from '../../self-implement/auto-open-pr.js';
import { writeAuthoredGoal } from '../../self-implement/goal-author.js';
import { debug } from '../../debug/log.js';

afterEach(() => {
  _setAutoOpenPrConfigReaderForTesting();
  _setRecentStepCountReaderForTesting();
  _setCreateGoalAuthorDecomposeStepsForTesting();
});

function fakeUx(over: { confirmAnswer?: boolean; interactive?: boolean } = {}): SurfaceUx & { progressLog: { msg: string; phase?: string }[]; confirmReqs: string[] } {
  const progressLog: { msg: string; phase?: string }[] = [];
  const confirmReqs: string[] = [];
  const ux = {
    surface: 'acp' as const,
    interactive: over.interactive ?? true,
    async confirm(req: { prompt: string }) { confirmReqs.push(req.prompt); return over.confirmAnswer ?? true; },
    async question() { return null; },
    spillFile() {},
    progress(msg: string, opts?: { phase?: string }) { progressLog.push({ msg, ...(opts?.phase ? { phase: opts.phase } : {}) }); },
  } as unknown as SurfaceUx & { progressLog: { msg: string; phase?: string }[]; confirmReqs: string[] };
  Object.defineProperty(ux, 'progressLog', { get: () => progressLog });
  Object.defineProperty(ux, 'confirmReqs', { get: () => confirmReqs });
  return ux;
}

function fakeBase(over: Partial<SelfImplementSeams> = {}): SelfImplementSeams {
  return {
    async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
    async implement() { return { ok: true, summary: 's' }; },
    async gate() { return { passed: true }; },
    async openPr() { return { url: 'u', number: 1 }; },
    ...over,
  };
}

describe('resolveDispatchEntry — conservative entry fallback', () => {
  const ctx = (entry?: 'elanous-apparatus' | 'external-verbatim') => ({ cwd: '/tmp', signal: new AbortController().signal, ...(entry ? { entry } : {}) });

  test("ctx.entry='elanous-apparatus'면 elanous-apparatus", () => {
    expect(resolveDispatchEntry(ctx('elanous-apparatus'))).toBe('elanous-apparatus');
  });

  test('미지정이면 external-verbatim', () => {
    expect(resolveDispatchEntry(ctx())).toBe('external-verbatim');
  });

  test("ctx.entry='external-verbatim'이면 external-verbatim", () => {
    expect(resolveDispatchEntry(ctx('external-verbatim'))).toBe('external-verbatim');
  });
});

describe('SelfImplement daemon spec', () => {
  test('ground와 adversarialReview 파라미터를 boolean으로 노출하고 autoMerge를 노출하지 않는다', () => {
    const properties = buildSelfImplementDaemonSpec().parameters.properties as Record<string, { type?: string }>;
    expect(properties.ground?.type).toBe('boolean');
    expect(properties.adversarialReview?.type).toBe('boolean');
    expect(properties.autoMerge).toBeUndefined();
    expect(properties.completion).toBeUndefined();
  });

  test('하니스 표현은 도구 사용 시점과 조사·문장부호 변형까지 설명한다', () => {
    const description = buildSelfImplementDaemonSpec().description;
    for (const example of ['Use this tool when the user mentions the harness', '하니스로 개발', '하니스:', '하니스로 구현해줘', '하니스 구현', 'harness', 'self dev', 'particles or punctuation']) {
      expect(description).toContain(example);
    }
  });
});

describe('dispatchSelfImplement — result addressability', () => {
  beforeEach(() => setUserConfigOverlay((config) => ({
    ...config,
    tools: { ...config.tools, selfImplement: { ...config.tools.selfImplement, observeOnly: false } },
  })));

  afterEach(() => setUserConfigOverlay(null));

  test('preserves the runner runId through the tool payload and conversation renderer', async () => {
    const expected: SelfImplementResult = {
      runId: 'run-tool-result-addressable',
      ok: true,
      stage: 'pr-opened',
      node: 'open-pr',
      outcome: 'completed',
    };
    const result = await dispatchSelfImplement(
      { feature: 'surface result addressability' },
      { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus' },
      async () => expected,
    );
    expect(result).toEqual(expected);
    const payload = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(payload.runId).toBe(expected.runId);
    expect(summarizeToolResult(payload)).toBe(`run ${expected.runId} — elanous self run ${expected.runId}`);
  });

  test('default runner passes through the central CLI seam with one approval seam and unchanged result', async () => {
    const expected: SelfImplementResult = {
      runId: 'run-daemon-central', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
    };
    let calls = 0;
    const result = await dispatchSelfImplement(
      { feature: 'daemon central seam', base: 'main', draft: false, ground: true },
      { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus', sessionId: 'acp-session' },
      undefined,
      undefined,
      async (feature, opts, deps) => {
        calls += 1;
        expect(feature).toBe('daemon central seam');
        expect(opts).toMatchObject({
          base: 'main', draft: false, ground: true, parentSessionId: 'acp-session', entry: 'elanous-apparatus',
          naturalLanguageDispatch: true, openPr: true,
        });
        expect(opts.approver).toBeUndefined();
        expect(deps.pipelineDeps?.approver).toBeUndefined();
        const seams = await deps.pipelineDeps?.buildSelfImplementSeams?.({} as never);
        expect(seams?.approvePr).toBeDefined();
        return { ok: true, kind: 'self', exitCode: 0, result: expected };
      },
    );
    expect(calls).toBe(1);
    expect(result).toEqual(expected);
  });

  test('caller-only autoMerge reaches both CLI and runner paths while args cannot enable it', async () => {
    const expected: SelfImplementResult = {
      runId: 'run-caller-auto-merge', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
    };
    await dispatchSelfImplement(
      { feature: 'caller auto merge', autoMerge: true },
      { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus' },
      undefined,
      undefined,
      async (_feature, opts) => {
        expect(opts.autoMerge).toBeUndefined();
        expect(opts.autoReview).toBeUndefined();
        return { ok: true, kind: 'self', exitCode: 0, result: expected };
      },
    );
    let runOpts: import('../../self-implement/orchestrator.js').SelfImplementOptions | undefined;
    await dispatchSelfImplement(
      { feature: 'caller auto merge' },
      { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus', autoMerge: true },
      async (opts) => { runOpts = opts; return expected; },
    );
    expect(runOpts?.autoMerge).toBe(true);
    expect(runOpts?.autoReview).toBe(true);
    expect(runOpts).toHaveProperty('autoReview', true);
    await dispatchSelfImplement(
      { feature: 'caller auto merge' },
      { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus' },
      async (opts) => {
        expect(opts.autoMerge).toBeUndefined();
        expect(opts.autoReview).toBeUndefined();
        expect(Object.hasOwn(opts, 'autoReview')).toBe(false);
        return expected;
      },
    );
    await dispatchSelfImplement(
      { feature: 'caller auto merge' },
      { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus', autoMerge: true },
      undefined,
      undefined,
      async (_feature, opts) => {
        expect(opts.autoMerge).toBe(true);
        expect(opts.autoReview).toBe(true);
        expect(opts).toHaveProperty('autoReview', true);
        return { ok: true, kind: 'self', exitCode: 0, result: expected };
      },
    );
    await dispatchSelfImplement(
      { feature: 'caller auto merge' },
      { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus', autoMerge: false },
      undefined,
      undefined,
      async (_feature, opts) => {
        expect(opts.autoMerge).toBe(false);
        expect(opts.autoReview).toBeUndefined();
        return { ok: true, kind: 'self', exitCode: 0, result: expected };
      },
    );
  });

  test('dispatch log reports autoReview only for a caller-requested autoMerge', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const expected: SelfImplementResult = {
      runId: 'run-review-observation', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
    };
    try {
      for (const autoMerge of [true, undefined] as const) {
        await dispatchSelfImplement(
          { feature: 'review observation' },
          { cwd: '/tmp', signal: new AbortController().signal, ...(autoMerge ? { autoMerge } : {}) },
          async () => expected,
        );
      }
      const dispatches = log.mock.calls
        .filter(([category, event]) => category === 'daemon-tools.self-implement' && event === 'dispatch');
      expect(dispatches.map(([, , data]) => (data as { autoReview?: boolean }).autoReview)).toEqual([true, undefined]);
    } finally {
      log.mockRestore();
    }
  });

  test('default runner retains isolated config and state seams through the central pipeline', async () => {
    const expected: SelfImplementResult = {
      runId: 'run-daemon-isolation', ok: true, stage: 'pr-declined', node: 'open-pr', outcome: 'completed',
    };
    let finalSeams: SelfImplementSeams | undefined;
    let seamOptions: DefaultSeamsOptions | undefined;
    await dispatchSelfImplement(
      { feature: 'daemon isolation preservation' },
      { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus' },
      undefined,
      undefined,
      async (_feature, _opts, deps) => {
        finalSeams = await deps.pipelineDeps?.buildSelfImplementSeams?.({} as never);
        return { ok: true, kind: 'self', exitCode: 0, result: expected };
      },
      (options) => {
        seamOptions = options;
        return fakeBase();
      },
    );
    expect(seamOptions?.configDir).toEqual(expect.any(String));
    expect(seamOptions?.stateDir).toEqual(expect.any(String));
    expect(seamOptions?.configDir).toBe(seamOptions?.stateDir);
    expect(finalSeams?.createWorktree).toBeDefined();
  });

  test('records and forwards the dispatch session id without changing natural-language provenance', async () => {
    const expected: SelfImplementResult = {
      runId: 'run-session-attribution', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
    };
    const sessionId = 'acp-parent-session';
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let received: import('../../self-implement/orchestrator.js').SelfImplementOptions | undefined;
    try {
      await dispatchSelfImplement(
        { feature: 'session attribution' },
        { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus', sessionId },
        async (opts) => {
          received = opts;
          return expected;
        },
      );
      expect(received).toEqual(expect.objectContaining({
        feature: 'session attribution', parentSessionId: sessionId, naturalLanguageDispatch: true,
      }));
      const dispatch = log.mock.calls.find(([category, event]) => category === 'daemon-tools.self-implement' && event === 'dispatch');
      expect(dispatch?.[2]).toEqual(expect.objectContaining({ sessionId }));
    } finally {
      log.mockRestore();
    }
  });

  test('records harness mention state without adding another original-text field', async () => {
    const expected: SelfImplementResult = {
      runId: 'run-harness-mention', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
    };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await dispatchSelfImplement(
        { feature: 'harness mention' },
        { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus', userText: '하니스로 구현해줘!' },
        async () => expected,
        async () => ({ path: '/goal' }),
      );
      await dispatchSelfImplement(
        { feature: 'plain mention' },
        { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus', userText: '그냥 구현해줘' },
        async () => expected,
        async () => ({ path: '/goal' }),
      );
      await dispatchSelfImplement(
        { feature: 'absent mention' },
        { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus' },
        async () => expected,
      );
      const dispatches = log.mock.calls
        .filter(([category, event]) => category === 'daemon-tools.self-implement' && event === 'dispatch')
        .map(([, , data]) => (data as { harnessMention?: string }).harnessMention);
      expect(dispatches).toEqual(['matched', 'not-matched', 'absent']);
    } finally {
      log.mockRestore();
    }
  });

  test('records an absent dispatch session id as null without forwarding a parent session', async () => {
    const expected: SelfImplementResult = {
      runId: 'run-no-session-attribution', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
    };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let received: import('../../self-implement/orchestrator.js').SelfImplementOptions | undefined;
    try {
      await dispatchSelfImplement(
        { feature: 'absent session attribution' },
        { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus' },
        async (opts) => {
          received = opts;
          return expected;
        },
      );
      expect(received?.parentSessionId).toBeUndefined();
      const dispatch = log.mock.calls.find(([category, event]) => category === 'daemon-tools.self-implement' && event === 'dispatch');
      expect(dispatch?.[2]).toEqual(expect.objectContaining({ sessionId: null }));
    } finally {
      log.mockRestore();
    }
  });

  test('authors the multi-line user text verbatim, keeps feature as title, and forwards its goal file', async () => {
    const expected: SelfImplementResult = {
      runId: 'run-natural-language-provenance', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
    };
    const cwd = mkdtempSync(join(tmpdir(), 'self-implement-dispatch-'));
    const original = '첫째 제약: 원문 보존\n둘째 배경: 여러 줄도 유지\n셋째 조건: 요약 금지';
    let received: import('../../self-implement/orchestrator.js').SelfImplementOptions | undefined;
    try {
      await dispatchSelfImplement(
        { feature: 'natural language provenance' },
        { cwd, signal: new AbortController().signal, entry: 'elanous-apparatus', userText: original },
        async (opts) => {
          received = opts;
          return expected;
        },
        (ask, authorCwd, deps) => writeAuthoredGoal(ask, authorCwd, {
          ground: async () => ({
            grounded: false, context: '', files: [], persistentEvidence: [], codeFacts: [], skillFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [],
          }),
          enhance: async (verbatimAsk) => ({ original: verbatimAsk, checklist: [], verbatimPreserved: true }),
          slugFn: async () => 'dispatch',
          ...deps,
          decomposeSteps: undefined,
        }),
      );
      expect(received).toEqual(expect.objectContaining({ feature: 'natural language provenance', naturalLanguageDispatch: true }));
      expect(received?.goalFile).toStartWith(join(cwd, '.elanous', 'goals', 'GOAL-dispatch-'));
      const document = readFileSync(received!.goalFile!, 'utf8');
      expect(document.split('\n', 1)[0]).toBe('natural language provenance');
      expect(document).toContain(`Original ask (verbatim, unmodified):\n\`\`\`\n${original}\n\`\`\``);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('forwards authored-goal start and end progress through the unchanged surface UX seam', async () => {
    const expected: SelfImplementResult = {
      runId: 'run-goal-author-progress', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
    };
    const progress: string[] = [];
    await dispatchSelfImplement(
      { feature: 'goal author progress' },
      {
        cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus', userText: 'author this goal',
        emitFeedback: (event) => {
          if (event.kind === 'tool.progress') progress.push(...event.payload.lines);
        },
      },
      async () => expected,
      async (_ask, _cwd, authorDeps) => {
        authorDeps?.onProgress?.('ground', 'start');
        authorDeps?.onProgress?.('ground', 'end');
        return { path: '/goal' };
      },
    );
    expect(progress.slice(0, 2)).toEqual(['goal-author ground started', 'goal-author ground ended']);
    expect(progress).toHaveLength(3);
    expect(progress[2]).toContain('goal-author authored goal');
  });

  test('emits one authored summary with the human-readable goal filename and existing authoring facts', async () => {
    const expected: SelfImplementResult = {
      runId: 'run-goal-author-summary', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
    };
    const progress: string[] = [];
    await dispatchSelfImplement(
      { feature: 'goal author summary' },
      {
        cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus', userText: 'author this goal',
        emitFeedback: (event) => {
          if (event.kind === 'tool.progress') progress.push(...event.payload.lines);
        },
      },
      async () => expected,
      async () => ({ path: '/tmp/docs/goals/GOAL-readable-name.md' }),
    );
    const summaries = progress.filter((line) => line.includes('GOAL-readable-name.md'));
    expect(summaries).toEqual(['goal-author authored GOAL-readable-name.md (present; 16 chars; truncated=false)']);
    expect(summaries[0]).not.toContain('/tmp/docs/goals/');
  });

  test('emits an explicit not-authored summary when no goal source exists', async () => {
    const expected: SelfImplementResult = {
      runId: 'run-goal-author-skipped', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
    };
    const progress: string[] = [];
    await dispatchSelfImplement(
      { feature: 'goal author skipped' },
      {
        cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus',
        emitFeedback: (event) => {
          if (event.kind === 'tool.progress') progress.push(...event.payload.lines);
        },
      },
      async () => expected,
    );
    expect(progress).toEqual(['goal-author not authored (absent; no goal source)']);
  });

  test('continues the harness when the goal-author summary feedback throws', async () => {
    const expected: SelfImplementResult = {
      runId: 'run-goal-author-feedback-failure', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
    };
    const result = await dispatchSelfImplement(
      { feature: 'goal author feedback failure' },
      {
        cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus', userText: 'author this goal',
        emitFeedback: () => { throw new Error('display unavailable'); },
      },
      async () => expected,
      async () => ({ path: '/tmp/GOAL-feedback-failure.md' }),
    );
    expect(result).toEqual(expected);
  });

  test('keeps the legacy runner input when user text is absent', async () => {
    const expected: SelfImplementResult = {
      runId: 'run-no-user-text', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
    };
    let received: import('../../self-implement/orchestrator.js').SelfImplementOptions | undefined;
    let authored = false;
    await dispatchSelfImplement(
      { feature: 'legacy natural language dispatch' },
      { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus' },
      async (opts) => {
        received = opts;
        return expected;
      },
      async () => {
        authored = true;
        return { path: '/must-not-be-authored' };
      },
    );
    expect(authored).toBe(false);
    expect(received).toEqual(expect.objectContaining({ feature: 'legacy natural language dispatch', naturalLanguageDispatch: true }));
    expect(received?.goalFile).toBeUndefined();
  });
});

describe('recent step-count reader seam', () => {
  test('parses valid stepCount values and treats [] as a successful empty read', () => {
    expect(parseRecentStepCountsFromLogRows([])).toEqual([]);
    expect(parseRecentStepCountsFromLogRows([
      { data: JSON.stringify({ stepCount: 9 }) },
      { data: JSON.stringify({ stepCount: 3 }) },
      { data: JSON.stringify({ stepCount: 'nope' }) },
      { data: JSON.stringify({ other: 1 }) },
      { data: 'not-json' },
      { data: null },
      { data: JSON.stringify({ stepCount: Number.NaN }) },
    ])).toEqual([9, 3]);
  });

  test('default reader queries latest-first goal-steps-decomposed events with the store default limit', () => {
    const queries: unknown[] = [];
    const counts = readRecentStepCountsFromLogStore(() => ({
      query: (q?: { events?: string[]; limit?: number; afterId?: number }) => {
        queries.push(q);
        return [
          { data: JSON.stringify({ stepCount: 7 }) },
          { data: JSON.stringify({ stepCount: 4 }) },
        ];
      },
    }));
    expect(queries).toEqual([{ events: ['goal-steps-decomposed'] }]);
    expect((queries[0] as { limit?: number }).limit).toBeUndefined();
    expect((queries[0] as { afterId?: number }).afterId).toBeUndefined();
    expect(counts).toEqual([7, 4]);
  });

  test('default reader throws when the log store is unavailable instead of returning []', () => {
    expect(() => readRecentStepCountsFromLogStore(() => null)).toThrow('log store unavailable');
  });
});

describe('dispatchSelfImplement — recentStepCounts wiring', () => {
  const expected: SelfImplementResult = {
    runId: 'run-recent-step-counts', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
  };

  beforeEach(() => setUserConfigOverlay((config) => ({
    ...config,
    tools: { ...config.tools, selfImplement: { ...config.tools.selfImplement, observeOnly: false } },
  })));

  afterEach(() => setUserConfigOverlay(null));

  test('forwards the injected recent step-count array to decompose-step creation', async () => {
    const recentStepCounts = [9, 4, 2];
    const signal = new AbortController().signal;
    const configs: Array<{ adversarialReview?: boolean; recentStepCounts?: readonly number[] }> = [];
    _setRecentStepCountReaderForTesting(() => recentStepCounts);
    _setCreateGoalAuthorDecomposeStepsForTesting((receivedSignal, config) => {
      expect(receivedSignal).toBe(signal);
      configs.push(config ?? {});
      return async () => ['one'];
    });
    let authorCalls = 0;
    let receivedOnProgress: unknown;
    await dispatchSelfImplement(
      { feature: 'forward recent step counts', adversarialReview: true },
      { cwd: '/tmp', signal, entry: 'elanous-apparatus', userText: 'author this goal' },
      async () => expected,
      async (_ask, _cwd, deps) => {
        authorCalls += 1;
        receivedOnProgress = deps?.onProgress;
        expect(typeof deps?.decomposeSteps).toBe('function');
        return { path: '/goal' };
      },
    );
    expect(authorCalls).toBe(1);
    expect(typeof receivedOnProgress).toBe('function');
    expect(configs).toHaveLength(1);
    expect(configs[0]?.adversarialReview).toBe(true);
    expect(Object.hasOwn(configs[0] ?? {}, 'adversarialReviewSource')).toBe(false);
    expect(configs[0]?.recentStepCounts).toBe(recentStepCounts);
  });

  test('omits recentStepCounts and continues authoring when the reader throws', async () => {
    const configs: Array<{ adversarialReview?: boolean; recentStepCounts?: readonly number[] }> = [];
    _setRecentStepCountReaderForTesting(() => {
      throw new Error('log store unavailable');
    });
    _setCreateGoalAuthorDecomposeStepsForTesting((_signal, config) => {
      configs.push(config ?? {});
      return async () => ['one'];
    });
    let authorCalls = 0;
    const result = await dispatchSelfImplement(
      { feature: 'reader failure fail-open' },
      { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus', userText: 'author this goal' },
      async () => expected,
      async (_ask, _cwd, deps) => {
        authorCalls += 1;
        expect(typeof deps?.onProgress).toBe('function');
        return { path: '/goal' };
      },
    );
    expect(result).toEqual(expected);
    expect(authorCalls).toBe(1);
    expect(configs).toHaveLength(1);
    expect(configs[0]).toEqual({});
    expect(Object.hasOwn(configs[0] ?? {}, 'recentStepCounts')).toBe(false);
    expect(Object.hasOwn(configs[0] ?? {}, 'adversarialReview')).toBe(false);
    expect(Object.hasOwn(configs[0] ?? {}, 'adversarialReviewSource')).toBe(false);
  });

  test('forwards an empty recent step-count array distinctly from a read failure', async () => {
    const empty: readonly number[] = [];
    const configs: Array<{ adversarialReview?: boolean; recentStepCounts?: readonly number[] }> = [];
    _setRecentStepCountReaderForTesting(() => empty);
    _setCreateGoalAuthorDecomposeStepsForTesting((_signal, config) => {
      configs.push(config ?? {});
      return async () => ['one'];
    });
    await dispatchSelfImplement(
      { feature: 'empty recent step counts' },
      { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus', userText: 'author this goal' },
      async () => expected,
      async () => ({ path: '/goal' }),
    );
    expect(configs).toHaveLength(1);
    expect(Object.hasOwn(configs[0] ?? {}, 'recentStepCounts')).toBe(true);
    expect(configs[0]?.recentStepCounts).toBe(empty);
    expect(configs[0]?.recentStepCounts).toEqual([]);
  });
});

describe('dispatchSelfImplement — observe-only', () => {
  const ctx = { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus' as const };

  test('ON: dispatch 기록 후 runner를 시작하지 않고 호출 사실만 반환한다', async () => {
    let calls = 0;
    setUserConfigOverlay((config) => ({
      ...config,
      tools: { ...config.tools, selfImplement: { ...config.tools.selfImplement, observeOnly: true } },
    }));
    try {
      const result = await dispatchSelfImplement(
        { feature: 'D1-01 observe-only probe' },
        ctx,
        async () => {
          calls += 1;
          throw new Error('runner must not start in observe-only mode');
        },
      );
      expect(result).toEqual({ observed: true });
      expect(calls).toBe(0);
    } finally {
      setUserConfigOverlay(null);
    }
  });

  test('OFF: existing runner invocation and result payload are unchanged', async () => {
    const expected: SelfImplementResult = {
      runId: 'run-observe-only-disabled', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
    };
    let calls = 0;
    setUserConfigOverlay((config) => ({
      ...config,
      tools: { ...config.tools, selfImplement: { ...config.tools.selfImplement, observeOnly: false } },
    }));
    try {
      const result = await dispatchSelfImplement({ feature: 'legacy run' }, ctx, async () => {
        calls += 1;
        return expected;
      });
      expect(result).toEqual(expected);
      expect(calls).toBe(1);
    } finally {
      setUserConfigOverlay(null);
    }
  });

  test('config 조회 실패: runner를 시작하지 않고 오류를 전파한다', async () => {
    let calls = 0;
    _setObserveOnlyConfigReaderForTesting(() => {
      throw new Error('observe-only config unavailable');
    });
    try {
      await expect(dispatchSelfImplement({ feature: 'fail-closed config read' }, ctx, async () => {
        calls += 1;
        throw new Error('runner must not start when config read fails');
      })).rejects.toThrow('observe-only config unavailable');
      expect(calls).toBe(0);
    } finally {
      _setObserveOnlyConfigReaderForTesting();
    }
  });
});

describe('daemon natural-language dispatch entry wiring', () => {
  test('three daemon dispatch contexts explicitly use elanous-apparatus', () => {
    const root = join(import.meta.dir, '..');
    for (const file of ['daemon-runtime.ts', 'daemon-prompt-turn.ts', 'daemon-multi-llm-runtime.ts']) {
      expect(readFileSync(join(root, file), 'utf8')).toContain("entry: 'elanous-apparatus'");
    }
  });
});

describe('buildSelfImplementSurfaceSeams — 막 배선', () => {
  // ⚠️ 아래 두 테스트는 **confirm 경로**를 검증한다 → operator 사전승인(autoOpenPr)을
  //   명시적으로 끈다. 안 끄면 config 기본값(ON·대표 결정)이 confirm 을 건너뛴다.
  test('approvePr ← ux.confirm(승인 버튼·yes)', async () => {
    const ux = fakeUx({ confirmAnswer: true });
    const seams = buildSelfImplementSurfaceSeams(fakeBase(), ux, false);
    const ok = await seams.approvePr!({ branch: 'self-impl/x', implSummary: '구현 요약' });
    expect(ok).toBe(true);
    expect(ux.confirmReqs[0]).toContain('self-impl/x');
  });

  test('★ fail-closed — 사전승인 OFF + confirm no(채널 없음 등) → PR 안 열림(false)', async () => {
    const ux = fakeUx({ confirmAnswer: false, interactive: false });
    const seams = buildSelfImplementSurfaceSeams(fakeBase(), ux, false);
    expect(await seams.approvePr!({ branch: 'b', implSummary: 's' })).toBe(false);
  });

  // ── ⭐ operator 사전 승인 (config `tools.selfImplement.autoOpenPr` · 기본 ON) ──
  // CLI 는 `--open-pr` 플래그가 곧 사람의 명시 승인이라 무인 진행이 되는데, 툴 경로엔
  // 등가물이 없어 무인 시 **완성 산출이 worktree 에 좌초**했다. 이 노브가 그 갭을 닫는다
  // (승인 주체는 사람 유지·시점만 앞당김 — LLM 자기승인 아님).
  test('사전승인 ON → confirm 을 아예 묻지 않고 통과', async () => {
    const ux = fakeUx({ confirmAnswer: false, interactive: true });   // confirm 은 no 를 낼 것
    const seams = buildSelfImplementSurfaceSeams(fakeBase(), ux, true);
    expect(await seams.approvePr!({ branch: 'self-impl/x', implSummary: 's' })).toBe(true);
    expect(ux.confirmReqs).toHaveLength(0);   // 사람을 안 붙잡는다
  });

  test('사전승인 ON 이어도 무인(채널 없음) 컨텍스트에서 동일하게 통과', async () => {
    const ux = fakeUx({ confirmAnswer: false, interactive: false });
    const seams = buildSelfImplementSurfaceSeams(fakeBase(), ux, true);
    expect(await seams.approvePr!({ branch: 'b', implSummary: 's' })).toBe(true);
  });

  // ⭐ must-fix(리뷰 #5463): 위 3건은 boolean 을 **주입**해 검증하므로 실제 무인 경로
  //   (getUserConfig → resolveAutoOpenPr → approvePr)를 우회한다. 인자 **없이** 불러
  //   프로덕션 배선 자체를 탄다 — seam 은 배선돼야 의미가 있다.
  test('★ 인자 미주입 = 실제 config 배선을 탄다(config ON → confirm 미호출)', async () => {
    setUserConfigOverlay((config) => ({
      ...config,
      tools: { ...config.tools, selfImplement: { ...config.tools.selfImplement, autoOpenPr: true } },
    }));
    try {
      const ux = fakeUx({ confirmAnswer: false, interactive: true });
      const seams = buildSelfImplementSurfaceSeams(fakeBase(), ux);   // ← 3번째 인자 없음
      expect(await seams.approvePr!({ branch: 'wired', implSummary: 's' })).toBe(true);
      expect(ux.confirmReqs).toHaveLength(0);
    } finally {
      setUserConfigOverlay(null);
    }
  });

  test('★ 인자 미주입 = 실제 config의 명시 OFF를 읽어 confirm으로 복귀한다', async () => {
    setUserConfigOverlay((config) => ({
      ...config,
      tools: { ...config.tools, selfImplement: { ...config.tools.selfImplement, autoOpenPr: false } },
    }));
    try {
      const ux = fakeUx({ confirmAnswer: false, interactive: true });
      const seams = buildSelfImplementSurfaceSeams(fakeBase(), ux);
      expect(await seams.approvePr!({ branch: 'wired-off', implSummary: 's' })).toBe(false);
      expect(ux.confirmReqs).toHaveLength(1);
    } finally {
      setUserConfigOverlay(null);
    }
  });

  test('config 조회 실패는 공용 판정에서 fail-closed 되어 confirm으로 복귀한다', async () => {
    _setAutoOpenPrConfigReaderForTesting(() => { throw new Error('auto-open-pr config unavailable'); });
    const ux = fakeUx({ confirmAnswer: false, interactive: true });
    const seams = buildSelfImplementSurfaceSeams(fakeBase(), ux);
    expect(await seams.approvePr!({ branch: 'config-error', implSummary: 's' })).toBe(false);
    expect(ux.confirmReqs).toHaveLength(1);
  });

  // should-fix(리뷰 #5463): 사전승인은 **개설까지만** — 병합 게이트를 건드리지 않는다.
  test('autoOpenPr 는 병합 seam 을 손대지 않는다(mergePr 무손상)', async () => {
    const base = fakeBase();
    const withMerge: SelfImplementSeams = { ...base, mergePr: async () => ({ merged: true }) };
    const seams = buildSelfImplementSurfaceSeams(withMerge, fakeUx(), true);
    // 병합 seam 은 그대로 전달될 뿐, 사전승인이 병합을 유발하지 않는다.
    expect(seams.mergePr).toBe(withMerge.mergePr);
    // 사전승인이 없던 병합 seam 을 만들어내지도 않는다.
    expect(buildSelfImplementSurfaceSeams(base, fakeUx(), true).mergePr).toBeUndefined();
  });

  test('사전승인 OFF 면 종전대로 confirm 결과를 따른다(무회귀)', async () => {
    const yes = buildSelfImplementSurfaceSeams(fakeBase(), fakeUx({ confirmAnswer: true }), false);
    expect(await yes.approvePr!({ branch: 'b', implSummary: 's' })).toBe(true);
    const no = buildSelfImplementSurfaceSeams(fakeBase(), fakeUx({ confirmAnswer: false }), false);
    expect(await no.approvePr!({ branch: 'b', implSummary: 's' })).toBe(false);
  });

  test('onProgress ← ux.progress · phase 매핑(start/delta/end)', () => {
    const ux = fakeUx();
    const seams = buildSelfImplementSurfaceSeams(fakeBase(), ux);
    seams.onProgress!({ stage: 'start', message: '시작' });
    seams.onProgress!({ stage: 'implementing', message: '구현중' });
    seams.onProgress!({ stage: 'pr-opened', message: 'PR' });
    seams.onProgress!({ stage: 'gate-failed', message: '게이트실패' });
    expect(ux.progressLog).toEqual([
      { msg: '시작', phase: 'start' },
      { msg: '구현중', phase: 'delta' },
      { msg: 'PR', phase: 'end' },
      { msg: '게이트실패', phase: 'end' },
    ]);
  });

  test('base seam(worktree/implement/gate/openPr) 무손상 passthrough', async () => {
    const ux = fakeUx();
    const seams = buildSelfImplementSurfaceSeams(fakeBase(), ux);
    expect((await seams.createWorktree({ branch: 'b' })).path).toBe('/wt/b');
    expect((await seams.implement({ cwd: '/wt/b', feature: 'f', runId: 'run-test' })).ok).toBe(true);
    expect((await seams.gate('/wt/b')).passed).toBe(true);
  });
});
