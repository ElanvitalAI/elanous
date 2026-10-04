// SelfOrchestrate 런타임(D · front door) 테스트 — 실 서브프로세스 없이 orchestrate 코어를 주입.

import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig } from '../user-config.js';
import { selfOrchestrateRuntime, bindOrchestrateRunLedger, restoreOrchestrateCheckpointGoals, resolveOrchestrateRunIdentity, countOrchestrateResumeSkips, splitOrchestrateGoalTexts, normalizeOrchestrateRequest, buildOrchestrateDecomposePrepareArgs, buildSelfOrchestrateSpec, normalizeTargetPaths, observeDecomposerSelection, selectFabricDecomposer, prepareOrchestrateDecomposeGoals, FABRIC_DECOMPOSE_REQUIRES_DECOMPOSE_ERROR, _setDecomposeForTesting, _setFabricDecomposeConfigReaderForTesting, _setFabricDecomposeForTesting, _setGoalAuthorForTesting, _setOrchestrateCliCommandForTesting, _setOrchestrateForTesting } from './self-orchestrate-runtime.js';
import { runSelfOrchestrateCliCommand } from './orchestrate-cli.js';
import { orchestrateSelfDev, type OrchestrateSelfDevOptions } from './orchestrate.js';
import type { SelfDevRunParticipant, SelfDevRunState } from './run-store.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import { _setObserveOnlyConfigReaderForTesting } from '../self-implement/observe-only.js';
import { debug } from '../debug/log.js';

const ctx = { surface: 'tui' } as ToolRuntimeContext;

function loadSelfImplementConfig(raw: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-fabric-threshold-'));
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify(raw === undefined ? {} : { tools: { selfImplement: raw } }));
    return buildUserConfig(path).tools.selfImplement;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type DescriptionTerm = string | RegExp;

const sequentialRequestTerms: readonly DescriptionTerm[] = ['sequence', 'dependency', '순서', '의존', '선후'];
const verbatimSourceTerms: readonly DescriptionTerm[] = ['원문', '그대로', 'verbatim'];
const preSeparatedItemTerms: readonly DescriptionTerm[] = [/이미\s*분리/, /미리\s*나눈/, /독립(?:적인)?\s*(?:기능\/수정\s*)?항목/];

const previousToolDescription =
  'Autonomously develop MULTIPLE features/fixes IN PARALLEL — each goal runs as its own isolated ' +
  'git-worktree self-implement subprocess (coordinator↔executor cell roles), concurrency-capped. ' +
  'Per goal: headless coding agent + integrity gate + internal review. By DEFAULT worktree-only ' +
  '(no PR/merge) so you can inspect before promoting. Set auto_merge=true to merge review-clean ' +
  'goals to main (outward-facing — explicit opt-in). Use when the user wants several things built ' +
  'at once (e.g. "이것들 병렬로 구현해줘", "여러 개 동시에 개발해줘", "이 목록 다 만들어줘"). ' +
  'Long-running (minutes). For a SINGLE feature use SelfImplement instead.';
const previousGoalsDescription = '병렬 구현할 goal 목록. 각 항목 = 1개 기능/수정의 자연어 요청(각각 격리 worktree self-implement).';

function hasDescriptionTerm(description: string, terms: readonly DescriptionTerm[]): boolean {
  const normalized = description.toLowerCase();
  return terms.some((term) => typeof term === 'string' ? normalized.includes(term) : term.test(normalized));
}

afterEach(() => {
  _setDecomposeForTesting(null);
  _setFabricDecomposeConfigReaderForTesting();
  _setFabricDecomposeForTesting(null);
  _setGoalAuthorForTesting(null);
  _setOrchestrateCliCommandForTesting();
  _setOrchestrateForTesting(null);
});

describe('SelfOrchestrate 런타임 (D)', () => {
  test('spec — 병렬·goals 배열·auto_merge opt-in', () => {
    const spec = buildSelfOrchestrateSpec();
    expect(spec.name).toBe('SelfOrchestrate');
    expect((spec.parameters as { required: string[] }).required).toEqual(['goals']);
    expect((spec.parameters as { properties: Record<string, unknown> }).properties.auto_merge).toBeTruthy();
  });

  test('spec — 순서·의존 복합 요청과 decompose별 goals 입력 형태를 설명한다', () => {
    const spec = buildSelfOrchestrateSpec();
    const goalsDescription = (spec.parameters as { properties: { goals: { description: string } } }).properties.goals.description;
    const decomposeDescription = (spec.parameters as { properties: { decompose: { description: string } } }).properties.decompose.description;
    const dependentRequestTerms = ['순서', '의존', '선후'];
    const independentListTerms = ['독립', '나열', '목록', '분리'];

    expect(hasDescriptionTerm(spec.description, sequentialRequestTerms)).toBe(true);
    expect(hasDescriptionTerm(goalsDescription, verbatimSourceTerms)).toBe(true);
    expect(hasDescriptionTerm(goalsDescription, preSeparatedItemTerms)).toBe(true);
    expect(hasDescriptionTerm(decomposeDescription, dependentRequestTerms)).toBe(true);
    expect(hasDescriptionTerm(decomposeDescription, independentListTerms)).toBe(true);
  });

  test('spec — 수리 전 전체 도구·goals 설명은 같은 새 의미 판정 중 적어도 하나에 실패한다', () => {
    const previousChecks = [
      hasDescriptionTerm(previousToolDescription, sequentialRequestTerms),
      hasDescriptionTerm(previousGoalsDescription, verbatimSourceTerms),
      hasDescriptionTerm(previousGoalsDescription, preSeparatedItemTerms),
    ];

    expect(previousChecks.some((passes) => !passes)).toBe(true);
    expect(previousChecks).toEqual([false, false, false]);
  });

  test('spec — 분리·독립 의미 없이 항목들 또는 목록만 있는 goals 설명은 거부한다', () => {
    expect(hasDescriptionTerm('병렬 구현할 항목들 목록.', preSeparatedItemTerms)).toBe(false);
  });

  test('goals 배열 파싱 + 안전 기본(auto_merge 없음=worktree-only)', async () => {
    let captured: OrchestrateSelfDevOptions | null = null;
    _setOrchestrateForTesting(async (opts) => {
      captured = opts;
      return opts.goals.map((g, i) => ({ taskId: `t${i}`, feature: g.feature, status: 'done' as const, worktreePath: `/wt/${i}` }));
    });
    const r = await selfOrchestrateRuntime.run({ goals: ['A 구현', 'B 구현'] }, ctx);
    expect(captured!.goals.map((g) => g.feature)).toEqual(['A 구현', 'B 구현']);
    expect(captured!.goals.every((g) => g.autoMerge === undefined)).toBe(true);   // 안전 기본=병합 안 함
    expect(r.ok).toBe(true);
    expect(r.total).toBe(2);
    expect(r.done).toBe(2);
    expect(r.output).toContain('done 2');
  });

  test('429 usage_limit_reached 자식 실패는 단일 중앙 실행의 요청 동시성을 보존하고 이후 시작을 중단한다', async () => {
    const started: string[] = [];
    const stops: Record<string, unknown>[] = [];
    const centralCalls: Array<{ goals: number; concurrency: number | undefined }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (_category === 'self-dev.orchestrate' && event === 'runtime.stop-rate-limited') stops.push(data ?? {});
    }) as never);
    _setOrchestrateCliCommandForTesting((input) => {
      centralCalls.push({ goals: input.goals.length, concurrency: input.concurrency });
      return runSelfOrchestrateCliCommand(input, {
        executeReroute: async (_spec, runtime) => {
          const results = await orchestrateSelfDev({
            ...runtime,
            goals: input.goals,
            concurrency: input.concurrency,
            readScreenTail: () => ({ text: 'Codex API 429 usage_limit_reached', outcome: 'incomplete', path: '/rate-limited.screen' }),
            spawn: (job) => {
              const feature = job.feature.split('\n')[0]!;
              started.push(feature);
              return {
                address: `self-impl:${job.spaceId}`,
                done: Promise.resolve({
                  exitCode: 1,
                  output: '',
                  error: { code: 'CHILD_FAILED', message: 'child execution interrupted' },
                }),
              };
            },
          });
          return { results, exitCode: 1 };
        },
      });
    });

    try {
      const result = await selfOrchestrateRuntime.run({ goals: ['first', 'second', 'third'], concurrency: 2 }, ctx);
      expect(result.failed).toBe(2);
    } finally {
      log.mockRestore();
    }

    expect(centralCalls).toEqual([{ goals: 3, concurrency: 2 }]);
    expect(started).toHaveLength(2);
    expect(stops).toEqual([{ surface: 'tui', reason: 'rate-limited', remainingGoals: 1 }]);
  });

  test('일반 자식 실패는 단일 중앙 실행에서 기존처럼 다음 기능을 시작한다', async () => {
    const started: string[] = [];
    const centralCalls: Array<{ goals: number; concurrency: number | undefined }> = [];
    _setOrchestrateCliCommandForTesting((input) => {
      centralCalls.push({ goals: input.goals.length, concurrency: input.concurrency });
      return runSelfOrchestrateCliCommand(input, {
        executeReroute: async (_spec, runtime) => {
          const results = await orchestrateSelfDev({
            ...runtime,
            goals: input.goals,
            concurrency: input.concurrency,
            spawn: (job) => {
              const feature = job.feature.split('\n')[0]!;
              started.push(feature);
              return {
                address: `self-impl:${job.spaceId}`,
                done: Promise.resolve(feature === 'first'
                  ? { exitCode: 1, output: '', error: { code: 'CHILD_FAILED', message: 'ordinary build failure' } }
                  : { exitCode: 0, output: 'ok' }),
              };
            },
          });
          return { results, exitCode: 1 };
        },
      });
    });

    await selfOrchestrateRuntime.run({ goals: ['first', 'second'], concurrency: 1 }, ctx);

    expect(centralCalls).toEqual([{ goals: 2, concurrency: 1 }]);
    expect(started).toHaveLength(2);
    expect(started).toEqual(expect.arrayContaining(['first', 'second']));
  });

  test('decompose=true → 한 요청 원문을 분해하고 dependsOn·hotPaths를 보존해 전달한다', async () => {
    let decompositionInput = '';
    let captured: OrchestrateSelfDevOptions | null = null;
    _setDecomposeForTesting(async (feature) => {
      decompositionInput = feature;
      return {
        goals: [
          { id: 'research', feature: '조사', hotPaths: ['src/research.ts'] },
          { id: 'implement', feature: '구현', dependsOn: ['research'], hotPaths: ['src/implement.ts'] },
          { id: 'spec', feature: '점검 명세', dependsOn: ['implement'], hotPaths: ['test/implement.test.ts'] },
        ],
        decomposition: { recommendedMaxTasks: 3, actualTaskCount: 3, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
      };
    });
    _setOrchestrateForTesting(async (opts) => {
      captured = opts;
      return opts.goals.map((goal, i) => ({ taskId: `t${i}`, feature: goal.feature, status: 'done' as const }));
    });

    await selfOrchestrateRuntime.run({ goals: ['조사하고 그 결과로 구현하고 정기 점검 명세를 만든다'], decompose: true }, ctx);

    expect(decompositionInput).toBe('조사하고 그 결과로 구현하고 정기 점검 명세를 만든다');
    expect(captured!.goals).toEqual([
      { id: 'research', feature: '조사', hotPaths: ['src/research.ts'] },
      { id: 'implement', feature: '구현', dependsOn: ['research'], hotPaths: ['src/implement.ts'] },
      { id: 'spec', feature: '점검 명세', dependsOn: ['implement'], hotPaths: ['test/implement.test.ts'] },
    ]);
  });

  test('권고 상한 초과 기본 분해는 Fabric을 한 번 승격하고 그 조각을 실행하며 근거를 관측한다', async () => {
    const selections: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'runtime.decomposer-selection') selections.push(data ?? {});
    }) as never);
    let defaultCalls = 0;
    let fabricCalls = 0;
    let captured: OrchestrateSelfDevOptions | null = null;
    _setDecomposeForTesting(async () => {
      defaultCalls += 1;
      return {
        goals: [{ id: 'default', feature: 'default task' }],
        decomposition: { recommendedMaxTasks: 1, actualTaskCount: 2, truncatedAtHardMax: false, exceededRecommendedMax: true, outcome: 'decomposed' },
      };
    });
    _setFabricDecomposeForTesting(async () => {
      fabricCalls += 1;
      return { status: 'decomposed', rfc: { arcs: [] } as never, goals: [{ id: 'fabric', feature: 'fabric task' }, { id: 'fabric-verify', feature: 'verify task' }], decompositions: [], omittedGoalCount: 0, budgetSkippedArcCount: 0, budgetLimited: false };
    });
    _setOrchestrateForTesting(async (options) => { captured = options; return []; });

    try {
      await selfOrchestrateRuntime.run({ goals: ['composite'], decompose: true }, ctx);
    } finally {
      log.mockRestore();
    }

    expect(defaultCalls).toBe(1);
    expect(fabricCalls).toBe(1);
    expect(captured!.goals).toEqual([{ id: 'fabric', feature: 'fabric task' }, { id: 'fabric-verify', feature: 'verify task' }]);
    expect(selections).toEqual([
      { surface: 'tui', decomposer: 'default', source: 'default', normalizedPathCount: undefined, autoPathThreshold: 5 },
      { surface: 'tui', decomposer: 'fabric', source: 'post-threshold', normalizedPathCount: undefined, autoPathThreshold: 5 },
    ]);
  });

  test.each(['grounding-empty', 'missing-research-context'] as const)('권고 상한 초과 후 Fabric이 %s이면 기본 조각으로 폴백한다', async (status) => {
    let fabricCalls = 0;
    let captured: OrchestrateSelfDevOptions | null = null;
    _setDecomposeForTesting(async () => ({
      goals: [{ id: 'default', feature: 'default task' }],
      decomposition: { recommendedMaxTasks: 1, actualTaskCount: 2, truncatedAtHardMax: false, exceededRecommendedMax: true, outcome: 'decomposed' },
    }));
    _setFabricDecomposeForTesting(async () => {
      fabricCalls += 1;
      return status === 'grounding-empty'
        ? { status, message: 'no research', grounding: {} as never }
        : { status, message: 'no research' };
    });
    _setOrchestrateForTesting(async (options) => { captured = options; return []; });

    const result = await selfOrchestrateRuntime.run({ goals: ['composite'], decompose: true }, ctx);

    expect(fabricCalls).toBe(1);
    expect(captured!.goals).toEqual([{ id: 'default', feature: 'default task' }]);
    expect(result.fabricDecomposition).toMatchObject({ status });
  });

  test('권고 상한을 넘지 않으면 Fabric을 호출하지 않는다', async () => {
    let fabricCalls = 0;
    _setDecomposeForTesting(async () => ({
      goals: [{ id: 'default', feature: 'default task' }],
      decomposition: { recommendedMaxTasks: 2, actualTaskCount: 2, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
    }));
    _setFabricDecomposeForTesting(async () => { fabricCalls += 1; throw new Error('Fabric must not run'); });
    _setOrchestrateForTesting(async () => []);

    await selfOrchestrateRuntime.run({ goals: ['composite'], decompose: true }, ctx);

    expect(fabricCalls).toBe(0);
  });

  test('명시적·path-threshold Fabric 선택은 기본 분해와 사후 재승격을 하지 않는다', async () => {
    let defaultCalls = 0;
    let fabricCalls = 0;
    _setDecomposeForTesting(async () => {
      defaultCalls += 1;
      throw new Error('explicit Fabric must not run default decomposition');
    });
    _setFabricDecomposeForTesting(async () => {
      fabricCalls += 1;
      return { status: 'decomposed', rfc: { arcs: [] } as never, goals: [], decompositions: [], omittedGoalCount: 0, budgetSkippedArcCount: 0, budgetLimited: false };
    });
    _setOrchestrateForTesting(async () => []);

    await selfOrchestrateRuntime.run({ goals: ['explicit'], decompose: true, fabric_decompose: true }, ctx);
    _setFabricDecomposeConfigReaderForTesting(() => ({ enabled: false, autoPathThreshold: 1 }));
    await selfOrchestrateRuntime.run({ goals: ['path'], decompose: true, target_paths: ['src/path.ts'] }, ctx);

    expect(defaultCalls).toBe(0);
    expect(fabricCalls).toBe(2);
  });

  test('Fabric opt-in은 문자열 전용 기존 seam 대신 Fabric seam을 호출한다', async () => {
    let legacyCalls = 0;
    let fabricCalls = 0;
    let captured: OrchestrateSelfDevOptions | null = null;
    _setDecomposeForTesting(async () => { legacyCalls += 1; throw new Error('legacy must not run'); });
    _setFabricDecomposeForTesting(async request => {
      fabricCalls += 1;
      expect(request).toBe('first second');
      return { status: 'decomposed', rfc: { arcs: [] } as never, goals: [{ id: 'fabric', feature: 'Fabric task' }], decompositions: [], omittedGoalCount: 2, budgetSkippedArcCount: 0, budgetLimited: false };
    });
    _setOrchestrateForTesting(async options => { captured = options; return []; });

    const result = await selfOrchestrateRuntime.run({ goals: ['first', 'second'], decompose: true, fabric_decompose: true }, ctx);

    expect(legacyCalls).toBe(0);
    expect(fabricCalls).toBe(1);
    expect(captured).toMatchObject({ goals: [{ id: 'fabric', feature: 'Fabric task' }], parentRequest: 'first second' });
    expect(result.fabricDecomposition).toEqual({ status: 'decomposed', outcome: 'decomposed', omittedGoalCount: 2, budgetSkippedArcCount: 0, budgetLimited: false });
  });

  test('Fabric 설정 기본값은 요청이 없을 때만 적용되고 선택 출처를 관측한다', async () => {
    const selections: Record<string, unknown>[] = [];
    const invokes: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'runtime.decomposer-selection') selections.push(data ?? {});
      if (event === 'runtime.invoke') invokes.push(data ?? {});
    }) as never);
    let legacyCalls = 0;
    let fabricCalls = 0;
    _setDecomposeForTesting(async () => {
      legacyCalls += 1;
      return { goals: [], decomposition: { recommendedMaxTasks: 0, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' } };
    });
    _setFabricDecomposeForTesting(async () => {
      fabricCalls += 1;
      return { status: 'decomposed', rfc: { arcs: [] } as never, goals: [], decompositions: [], omittedGoalCount: 0, budgetSkippedArcCount: 0, budgetLimited: false };
    });
    _setOrchestrateForTesting(async () => []);

    try {
      _setFabricDecomposeConfigReaderForTesting(() => ({ enabled: false, autoPathThreshold: null }));
      await selfOrchestrateRuntime.run({ goals: ['default'], decompose: true }, ctx);
      _setFabricDecomposeConfigReaderForTesting(() => ({ enabled: true, autoPathThreshold: 5 }));
      await selfOrchestrateRuntime.run({ goals: ['config'], decompose: true }, ctx);
      await selfOrchestrateRuntime.run({ goals: ['request false'], decompose: true, fabric_decompose: false }, ctx);
      await selfOrchestrateRuntime.run({ goals: ['request true'], decompose: true, fabric_decompose: true }, ctx);
      await expect(selfOrchestrateRuntime.run({ goals: ['not decomposed'] }, ctx)).rejects.toThrow('`fabric_decompose` requires `decompose=true`');
      await expect(selfOrchestrateRuntime.run({ goals: ['request contract'], fabric_decompose: true }, ctx)).rejects.toThrow('`fabric_decompose` requires `decompose=true`');
    } finally {
      log.mockRestore();
    }

    expect(legacyCalls).toBe(2);
    expect(fabricCalls).toBe(2);
    expect(selections).toEqual([
      { surface: 'tui', decomposer: 'default', source: 'default', normalizedPathCount: undefined, autoPathThreshold: null },
      { surface: 'tui', decomposer: 'fabric', source: 'config', normalizedPathCount: undefined, autoPathThreshold: 5 },
      { surface: 'tui', decomposer: 'default', source: 'request', normalizedPathCount: undefined, autoPathThreshold: null },
      { surface: 'tui', decomposer: 'fabric', source: 'request', normalizedPathCount: undefined, autoPathThreshold: null },
    ]);
    expect(invokes).toEqual(expect.arrayContaining([
      expect.objectContaining({ decompose: true, fabricDecompose: false, fabricDecomposeSource: 'default' }),
      expect.objectContaining({ decompose: true, fabricDecompose: true, fabricDecomposeSource: 'config' }),
      expect.objectContaining({ decompose: true, fabricDecompose: false, fabricDecomposeSource: 'request' }),
      expect.objectContaining({ decompose: true, fabricDecompose: true, fabricDecomposeSource: 'request' }),
      expect.objectContaining({ decompose: false, fabricDecompose: true, fabricDecomposeSource: 'config' }),
      expect.objectContaining({ decompose: false, fabricDecompose: true, fabricDecomposeSource: 'request' }),
    ]));
  });

  test('런타임은 정규화된 대상 경로 수 문턱을 관측하고 명시 false를 우선한다', async () => {
    const selections: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'runtime.decomposer-selection') selections.push(data ?? {});
    }) as never);
    let legacyCalls = 0;
    let fabricCalls = 0;
    _setFabricDecomposeConfigReaderForTesting(() => ({ enabled: false, autoPathThreshold: 5 }));
    _setDecomposeForTesting(async () => {
      legacyCalls += 1;
      return { goals: [], decomposition: { recommendedMaxTasks: 0, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' } };
    });
    _setFabricDecomposeForTesting(async () => {
      fabricCalls += 1;
      return { status: 'decomposed', rfc: { arcs: [] } as never, goals: [], decompositions: [], omittedGoalCount: 0, budgetSkippedArcCount: 0, budgetLimited: false };
    });
    _setOrchestrateForTesting(async () => []);

    try {
      await selfOrchestrateRuntime.run({ goals: ['natural language only'], decompose: true, target_paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'] }, ctx);
      await selfOrchestrateRuntime.run({ goals: ['one composite request'], decompose: true, target_paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'] }, ctx);
      await selfOrchestrateRuntime.run({ goals: ['six paths'], decompose: true, target_paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'], fabric_decompose: false }, ctx);
    } finally {
      log.mockRestore();
    }

    expect(legacyCalls).toBe(2);
    expect(fabricCalls).toBe(1);
    expect(selections).toEqual([
      { surface: 'tui', decomposer: 'default', source: 'default', normalizedPathCount: 4, autoPathThreshold: 5 },
      { surface: 'tui', decomposer: 'fabric', source: 'path-threshold', normalizedPathCount: 5, autoPathThreshold: 5 },
      { surface: 'tui', decomposer: 'default', source: 'request', normalizedPathCount: 6, autoPathThreshold: null },
    ]);
  });

  test('정규화된 대상 경로 수가 문턱이면 선택 helper가 request·config보다 뒤에서 Fabric을 고른다', () => {
    expect(normalizeTargetPaths(['./src/a.ts', 'src/./a.ts', 'src/a.ts', 'src/b.ts'])).toEqual(['src/a.ts', 'src/b.ts']);
    expect(normalizeTargetPaths(['README', 'Dockerfile', 'Makefile', 'dir/file name', './src/../README'])).toEqual([
      'README', 'Dockerfile', 'Makefile', 'dir/file name',
    ]);
    expect(normalizeTargetPaths([])).toEqual([]);
    expect(normalizeTargetPaths(['src/a.ts', '../outside'])).toBeUndefined();
    expect(normalizeTargetPaths(['/abs/path'])).toBeUndefined();
    expect(normalizeTargetPaths(undefined)).toBeUndefined();
    const disabled = { enabled: false, autoPathThreshold: null };
    const thresholdFive = { enabled: false, autoPathThreshold: 5 };

    expect(selectFabricDecomposer(true, thresholdFive, 6)).toEqual({ decomposer: 'fabric', source: 'request' });
    expect(selectFabricDecomposer(false, thresholdFive, 6)).toEqual({ decomposer: 'default', source: 'request' });
    expect(selectFabricDecomposer(undefined, { enabled: true, autoPathThreshold: 5 }, 6)).toEqual({ decomposer: 'fabric', source: 'config' });
    expect(selectFabricDecomposer(undefined, thresholdFive, 4)).toEqual({ decomposer: 'default', source: 'default' });
    expect(selectFabricDecomposer(undefined, thresholdFive, 5)).toEqual({ decomposer: 'fabric', source: 'path-threshold' });
    expect(selectFabricDecomposer(undefined, thresholdFive, 6)).toEqual({ decomposer: 'fabric', source: 'path-threshold' });
    expect(selectFabricDecomposer(undefined, thresholdFive, undefined)).toEqual({ decomposer: 'default', source: 'default' });
    expect(selectFabricDecomposer(undefined, disabled, 6)).toEqual({ decomposer: 'default', source: 'default' });
  });

  test('raw user config는 Fabric 자동 문턱의 기본·유효값·null 비활성화·이상값 폴백을 파싱한다', () => {
    expect(loadSelfImplementConfig(undefined).fabricDecomposeAutoPathThreshold).toBe(5);
    expect(loadSelfImplementConfig({ fabricDecomposeAutoPathThreshold: 7 }).fabricDecomposeAutoPathThreshold).toBe(7);
    expect(loadSelfImplementConfig({ fabricDecomposeAutoPathThreshold: null }).fabricDecomposeAutoPathThreshold).toBeNull();
    for (const invalid of [-1, 0, 1.5, '5', true, {}]) {
      expect(loadSelfImplementConfig({ fabricDecomposeAutoPathThreshold: invalid }).fabricDecomposeAutoPathThreshold).toBe(5);
    }
  });

  test('명시적 Fabric true와 false는 config reader를 호출하지 않고 우선한다', async () => {
    let readerCalls = 0;
    _setFabricDecomposeConfigReaderForTesting(() => {
      readerCalls += 1;
      throw new Error('explicit request must not read config');
    });
    _setDecomposeForTesting(async () => ({ goals: [], decomposition: { recommendedMaxTasks: 0, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' } }));
    _setFabricDecomposeForTesting(async () => ({ status: 'decomposed', rfc: { arcs: [] } as never, goals: [], decompositions: [], omittedGoalCount: 0, budgetSkippedArcCount: 0, budgetLimited: false }));
    _setOrchestrateForTesting(async () => []);

    await selfOrchestrateRuntime.run({ goals: ['explicit on'], decompose: true, fabric_decompose: true }, ctx);
    await selfOrchestrateRuntime.run({ goals: ['explicit off'], decompose: true, fabric_decompose: false }, ctx);

    expect(readerCalls).toBe(0);
  });

  test('공용 observer는 CLI surface와 기존 이벤트명·필수 payload 및 경로 수/임계를 보존한다', () => {
    const entries: Array<{ category: string; event: string; data: Record<string, unknown> | undefined }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      entries.push({ category: _category, event, data });
    }) as never);

    try {
      observeDecomposerSelection('default', 'default', 'cli', undefined, 5);
      observeDecomposerSelection('default', 'default', 'cli', 0, 5);
      observeDecomposerSelection('default', 'default', 'cli', 3, 5);
      observeDecomposerSelection('fabric', 'path-threshold', 'cli', 6, 5);
    } finally {
      log.mockRestore();
    }

    expect(entries).toEqual([
      { category: 'self-dev.orchestrate', event: 'runtime.decomposer-selection', data: { surface: 'cli', decomposer: 'default', source: 'default', normalizedPathCount: undefined, autoPathThreshold: 5 } },
      { category: 'self-dev.orchestrate', event: 'runtime.decomposer-selection', data: { surface: 'cli', decomposer: 'default', source: 'default', normalizedPathCount: 0, autoPathThreshold: 5 } },
      { category: 'self-dev.orchestrate', event: 'runtime.decomposer-selection', data: { surface: 'cli', decomposer: 'default', source: 'default', normalizedPathCount: 3, autoPathThreshold: 5 } },
      { category: 'self-dev.orchestrate', event: 'runtime.decomposer-selection', data: { surface: 'cli', decomposer: 'fabric', source: 'path-threshold', normalizedPathCount: 6, autoPathThreshold: 5 } },
    ]);
  });

  test('분해기 선택은 성공·실패와 독립적으로 fabric/default를 각각 한 번 기록한다', async () => {
    const selections: Record<string, unknown>[] = [];
    const fabricOutcomes: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'runtime.decomposer-selection') selections.push(data ?? {});
      if (event === 'runtime.fabric-decomposition') fabricOutcomes.push(data ?? {});
    }) as never);
    let fabricCalls = 0;
    _setDecomposeForTesting(async () => ({
      goals: [],
      decomposition: { recommendedMaxTasks: 0, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' },
    }));
    _setFabricDecomposeForTesting(async () => {
      fabricCalls += 1;
      return fabricCalls === 1
        ? { status: 'decomposed', rfc: { arcs: [] } as never, goals: [], decompositions: [], omittedGoalCount: 0, budgetSkippedArcCount: 0, budgetLimited: false }
        : { status: 'grounding-empty', message: 'no grounding' } as never;
    });
    _setOrchestrateForTesting(async () => []);

    try {
      await selfOrchestrateRuntime.run({ goals: ['default'], decompose: true }, ctx);
      await selfOrchestrateRuntime.run({ goals: ['fabric'], decompose: true, fabric_decompose: true }, ctx);
      await selfOrchestrateRuntime.run({ goals: ['fabric failure'], decompose: true, fabric_decompose: true }, ctx);
      await selfOrchestrateRuntime.run({ goals: ['not decomposed'] }, ctx);
    } finally {
      log.mockRestore();
    }

    expect(selections).toEqual([
      { surface: 'tui', decomposer: 'default', source: 'default', normalizedPathCount: undefined, autoPathThreshold: 5 },
      { surface: 'tui', decomposer: 'fabric', source: 'request', normalizedPathCount: undefined, autoPathThreshold: null },
      { surface: 'tui', decomposer: 'fabric', source: 'request', normalizedPathCount: undefined, autoPathThreshold: null },
    ]);
    expect(fabricOutcomes).toEqual([
      { surface: 'tui', status: 'decomposed', outcome: 'single-no-subtasks', omittedGoalCount: 0, budgetSkippedArcCount: 0, budgetLimited: false, goals: 0 },
      { surface: 'tui', status: 'grounding-empty', outcome: 'grounding-empty', message: 'no grounding' },
    ]);
  });

  test.each([
    ['missing-research-context', 'missing-research-context', true],
    ['grounding-empty', 'grounding-empty', true],
    ['authored-empty', 'authored-empty', true],
    ['grounding-failed', 'llm-failed', false],
    ['author-failed', 'llm-failed', false],
  ] as const)('Fabric 미산출 %s 상태를 반환값으로 보존하고 오케스트레이션을 중단한다', async (status, outcome, ok) => {
    const logs: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'runtime.fabric-decomposition') logs.push(data ?? {});
    }) as never);
    let legacyCalls = 0;
    let orchestrateCalls = 0;
    _setDecomposeForTesting(async () => { legacyCalls += 1; throw new Error('legacy must not run'); });
    _setFabricDecomposeForTesting(async () => status === 'authored-empty'
      ? { status, rfc: { arcs: [] } as never }
      : { status, message: `${status} reason` } as never);
    _setOrchestrateForTesting(async () => {
      orchestrateCalls += 1;
      return [];
    });
    try {
      const result = await selfOrchestrateRuntime.run({ goals: ['composite'], decompose: true, fabric_decompose: true }, ctx);
      expect(result).toMatchObject({ ok, total: 0, done: 0, merged: 0, failed: 0, fabricDecomposition: { status, outcome } });
      expect(result.failed).toBeLessThanOrEqual(result.total);
      expect(result.output).toContain(`Fabric decomposition ${status} (${outcome})`);
      if (status !== 'authored-empty') expect(result.output).toContain(`${status} reason`);
    } finally {
      log.mockRestore();
    }
    expect(legacyCalls).toBe(0);
    expect(orchestrateCalls).toBe(0);
    expect(logs).toContainEqual(expect.objectContaining({ status, outcome }));
  });

  test('decompose=true → 원문 parentRequest를 재구성하지 않고 orchestrator에 전달한다', async () => {
    let captured: OrchestrateSelfDevOptions | null = null;
    _setDecomposeForTesting(async () => ({
      goals: [{ id: 'a', feature: 'first' }, { id: 'b', feature: 'second' }],
      decomposition: { recommendedMaxTasks: 2, actualTaskCount: 2, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
    }));
    _setOrchestrateForTesting(async (opts) => { captured = opts; return []; });

    await selfOrchestrateRuntime.run({ goals: ['  original composite', ' request  '], decompose: true }, ctx);

    expect(captured!.parentRequest).toBe('original composite request');
    expect(captured!.goals).toEqual([{ id: 'a', feature: 'first' }, { id: 'b', feature: 'second' }]);
  });

  test('분해 원문의 기동 선언은 기존 goal author가 만든 canonical path로 중앙 CLI까지 도달한다', async () => {
    const originalRequest = ['원문 요청', '## 산출물을 어떻게 켜나', '- Entrypoint: apps/demo/server.ts', '- Port: 31415'].join('\n');
    const canonicalGoalPath = '/repo/docs/goals/canonical-launch.md';
    const wiringEvents: { event: string; data: Record<string, unknown> }[] = [];
    const deliveredRuntimes: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (_category === 'self-dev.deliverable-wiring') wiringEvents.push({ event, data: data ?? {} });
    }) as never);
    _setDecomposeForTesting(async () => ({
      goals: [{ id: 'part', feature: '분해된 골' }],
      decomposition: { recommendedMaxTasks: 1, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
    }));
    _setGoalAuthorForTesting(async () => ({ path: canonicalGoalPath } as never));
    _setOrchestrateCliCommandForTesting((input) => runSelfOrchestrateCliCommand(input, {
      executeReroute: async (_spec, runtime) => {
        deliveredRuntimes.push(runtime);
        return { results: [{ taskId: 'part', feature: '분해된 골', status: 'done', merged: false } as never], exitCode: 0 };
      },
    }));

    try {
      const result = await selfOrchestrateRuntime.run({ goals: [originalRequest], decompose: true }, ctx);
      expect(result.ok).toBe(true);
    } finally {
      log.mockRestore();
    }

    expect(deliveredRuntimes).toEqual([expect.objectContaining({
      deliverableTargets: [{ taskId: 'part', target: 'http://127.0.0.1:31415/' }],
      verifyDeliverable: expect.any(Function),
    })]);
    expect(wiringEvents).toContainEqual({ event: 'wired', data: expect.objectContaining({ port: 31415, attribution: 'all', targetCount: 1 }) });
  });

  test('선언 없는 분해 원문은 이름 있는 skipped 사유를 남기며 중앙 실행을 계속한다', async () => {
    const wiringEvents: { event: string; data: Record<string, unknown> }[] = [];
    const deliveredRuntimes: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (_category === 'self-dev.deliverable-wiring') wiringEvents.push({ event, data: data ?? {} });
    }) as never);
    _setDecomposeForTesting(async () => ({
      goals: [{ id: 'part', feature: '분해된 골' }],
      decomposition: { recommendedMaxTasks: 1, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
    }));
    _setOrchestrateCliCommandForTesting((input) => runSelfOrchestrateCliCommand(input, {
      executeReroute: async (_spec, runtime) => {
        deliveredRuntimes.push(runtime);
        return { results: [{ taskId: 'part', feature: '분해된 골', status: 'done', merged: false } as never], exitCode: 0 };
      },
    }));

    try {
      const result = await selfOrchestrateRuntime.run({ goals: ['선언 없는 원문'], decompose: true }, ctx);
      expect(result.ok).toBe(true);
    } finally {
      log.mockRestore();
    }

    expect(deliveredRuntimes).toEqual([expect.not.objectContaining({ deliverableTargets: expect.anything() })]);
    expect(wiringEvents).toContainEqual({ event: 'skipped', data: expect.objectContaining({ reason: 'no-launch-declaration', goalIdCount: 1 }) });
  });

  test.each([
    {
      name: '형식이 틀린 선언',
      document: ['원문 요청', '## 산출물을 어떻게 켜나', '- Port: nope'].join('\n'),
      reason: 'invalid-launch-declaration',
    },
    {
      name: '포트 없는 선언',
      document: ['원문 요청', '## 산출물을 어떻게 켜나', '- Entrypoint: apps/demo/server.ts'].join('\n'),
      reason: 'no-port-declaration',
    },
  ])('$name은 다음 단계에 들어가지 않고 $reason을 관측한다', async ({ document, reason }) => {
    const wiringEvents: { event: string; data: Record<string, unknown> }[] = [];
    const deliveredRuntimes: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (_category === 'self-dev.deliverable-wiring') wiringEvents.push({ event, data: data ?? {} });
    }) as never);
    _setDecomposeForTesting(async () => ({
      goals: [{ id: 'part', feature: '분해된 골' }],
      decomposition: { recommendedMaxTasks: 1, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
    }));
    _setOrchestrateCliCommandForTesting((input) => runSelfOrchestrateCliCommand(input, {
      executeReroute: async (_spec, runtime) => {
        deliveredRuntimes.push(runtime);
        return { results: [{ taskId: 'part', feature: '분해된 골', status: 'done', merged: false } as never], exitCode: 0 };
      },
    }));

    try {
      const result = await selfOrchestrateRuntime.run({ goals: [document], decompose: true }, ctx);
      expect(result.ok).toBe(true);
    } finally {
      log.mockRestore();
    }

    expect(deliveredRuntimes).toEqual([expect.not.objectContaining({ deliverableTargets: expect.anything() })]);
    expect(wiringEvents).toContainEqual({ event: 'skipped', data: expect.objectContaining({ reason, goalIdCount: 1 }) });
  });

  test('decompose=false → 기존 goals를 그대로 전달하고 분해기를 부르지 않는다', async () => {
    let decomposeCalls = 0;
    let captured: OrchestrateSelfDevOptions | null = null;
    _setDecomposeForTesting(async () => {
      decomposeCalls += 1;
      throw new Error('disabled decomposition must not run');
    });
    _setOrchestrateForTesting(async (opts) => {
      captured = opts;
      return [];
    });

    await selfOrchestrateRuntime.run({ goals: ['A 구현', 'B 구현'] }, ctx);

    expect(decomposeCalls).toBe(0);
    expect(captured!.goals).toEqual([{ feature: 'A 구현' }, { feature: 'B 구현' }]);
  });

  test('auto_merge=true → 각 goal 에 autoMerge 전파(opt-in)', async () => {
    let captured: OrchestrateSelfDevOptions | null = null;
    _setOrchestrateForTesting(async (opts) => { captured = opts; return []; });
    await selfOrchestrateRuntime.run({ goals: ['X'], auto_merge: true, concurrency: 3 }, ctx);
    expect(captured!.goals[0]!.autoMerge).toBe(true);
    expect(captured!.concurrency).toBe(3);
  });

  test('빈 goals → 에러(요구)', async () => {
    let threw = false;
    try { await selfOrchestrateRuntime.run({ goals: [] }, ctx); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test('실패 goal 은 ok=false + parked 안내', async () => {
    _setOrchestrateForTesting(async (opts) => opts.goals.map((g, i) => ({
      taskId: `t${i}`, feature: g.feature, status: 'failed' as const, error: { code: 'SELF_IMPL_FAILED', message: 'x' },
    })));
    const r = await selfOrchestrateRuntime.run({ goals: ['fail one'] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.failed).toBe(1);
    expect(r.output).toContain('parked');
  });
});

describe('⛔ 관측 전용은 위임 계열 전체에 걸린다 — SelfImplement 하나만 막으면 형제가 샌다', () => {
  afterEach(() => {
    _setObserveOnlyConfigReaderForTesting();
    _setDecomposeForTesting(null);
    _setOrchestrateForTesting(null);
  });

  test('⭐ observeOnly 면 분해·오케스트레이션을 시작하지 않고 접수만 기록한다', async () => {
    _setObserveOnlyConfigReaderForTesting(() => true);
    let called = 0;
    let decomposeCalls = 0;
    _setDecomposeForTesting(async () => {
      decomposeCalls += 1;
      throw new Error('observe-only must not decompose');
    });
    _setOrchestrateForTesting(async () => { called += 1; return []; });
    const r = await selfOrchestrateRuntime.run({ goals: ['a', 'b'], decompose: true }, ctx);
    // ⛔ 실측(2026-08-02 F4): 관문이 없어 진짜 오케스트레이션이 돌았고, 턴이 안 닫혀
    //    `llm.tool-loop.slow-tool awaiting {tool: SelfOrchestrate}` 가 반복되며 코퍼스 측정이 멈췄다.
    expect(called).toBe(0);
    expect(decomposeCalls).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.total).toBe(0);
    expect(r.output).toContain('관측 전용');
  });

  test('⭐ observeOnly 가 아니면 종전대로 코어를 부른다(무회귀)', async () => {
    _setObserveOnlyConfigReaderForTesting(() => false);
    let called = 0;
    _setOrchestrateForTesting(async () => { called += 1; return []; });
    await selfOrchestrateRuntime.run({ goals: ['a'] }, ctx);
    expect(called).toBe(1);
  });
});

// ⭐⭐⭐ 2026-08-19 (P0) — NL 입구가 «중앙 관통 라인»을 탄다.
//   ⛔ 종전엔 orchestrateSelfDev 를 «직접» 불러 runDevPipeline 을 우회했고,
//     그래서 그 라인 위에 놓인 것들(completion·autoReview 결정 · 슈퍼바이저 스위치)을 «못 받았다».
//   📌 이 절은 「입구는 번역만 한다」를 값으로 물어 둔다 — 판정·루프는 중앙이 갖는다.
describe('NL SelfOrchestrate — 입구는 «번역»만 한다', () => {
  test('⭐ supervise 스위치를 «그대로» 중앙에 넘긴다', async () => {
    let captured: (OrchestrateSelfDevOptions & { supervise?: { rounds?: number } }) | null = null;
    _setOrchestrateForTesting(async (opts) => {
      captured = opts as never;
      return [];
    });
    await selfOrchestrateRuntime.run({ goals: ['x 구현'], supervise: true, supervise_rounds: 5 }, ctx);
    expect(captured!.supervise).toEqual({ rounds: 5 });
  });

  test('supervise 를 «안 주면» 스위치가 아예 안 실린다 — 기본 동작 무변경', async () => {
    let captured: (OrchestrateSelfDevOptions & { supervise?: unknown }) | null = null;
    _setOrchestrateForTesting(async (opts) => { captured = opts as never; return []; });
    await selfOrchestrateRuntime.run({ goals: ['x 구현'] }, ctx);
    expect(captured!.supervise).toBeUndefined();
  });

  test('supervise=true 인데 rounds 를 안 주면 «빈 객체» — 상한은 중앙 기본값이 정한다', async () => {
    let captured: (OrchestrateSelfDevOptions & { supervise?: unknown }) | null = null;
    _setOrchestrateForTesting(async (opts) => { captured = opts as never; return []; });
    await selfOrchestrateRuntime.run({ goals: ['x 구현'], supervise: true }, ctx);
    expect(captured!.supervise).toEqual({});
  });

  test('⭐ 툴 스펙이 스위치를 «선언»한다 — NL 이 표현할 수 없으면 능력이 없는 것과 같다', () => {
    const spec = buildSelfOrchestrateSpec();
    const props = (spec.parameters as { properties: Record<string, unknown> }).properties;
    expect(props.supervise).toBeDefined();
    expect(props.supervise_rounds).toBeDefined();
  });
test("⛔ «기본» 경로가 엔진을 직접 부르지 않는다 — 중앙 심 경유(주입 테스트는 이것을 못 본다)", () => {
    const src = readFileSync(join(import.meta.dir, "self-orchestrate-runtime.ts"), "utf-8");
    // 종전 형태: let orchestrateFn: OrchestrateFn = orchestrateSelfDev;
    // ⛔ 주석·import 까지 물지 않게 «대입문 전체»로 묻는다(첫 판이 주석을 세어 거짓 실패했다).
    expect(src).not.toMatch(/orchestrateFn(: OrchestrateFn)? = orchestrateSelfDev;/);
    expect(src).not.toMatch(/\?\? orchestrateSelfDev;/);
    expect(src).toMatch(/orchestrateFn: OrchestrateFn = centralOrchestrate/);
    expect(src).toContain("runSelfOrchestrateCliCommand");
  });
});

describe('orchestrate delimiter helpers — CLI 두 얼굴 공유 `;;` 문자열 규칙', () => {
  test('한 인자에 `;;` 가 있으면 그것으로 나뉘고 판정 신호의 두 입력이 같은 goal 배열을 낸다', () => {
    expect(splitOrchestrateGoalTexts(['a ;; b'])).toEqual(['a', 'b']);
    expect(splitOrchestrateGoalTexts(['a', 'b'])).toEqual(['a', 'b']);
  });

  test('`;;` 가 없으면 각 인자가 골 하나다', () => {
    expect(splitOrchestrateGoalTexts(['alpha', 'beta'])).toEqual(['alpha', 'beta']);
  });

  test('나뉜 각 골은 앞뒤 공백이 없고 빈 골은 버려진다', () => {
    expect(splitOrchestrateGoalTexts(['  alpha ;;  ;; beta  ;;   '])).toEqual(['alpha', 'beta']);
  });

  test('합치는 쪽은 `;;` 를 공백으로 바꾸고 배열과 이미 결합된 문자열에서 같은 결과를 낸다', () => {
    expect(normalizeOrchestrateRequest(['  alpha ;;', ' beta  '])).toBe('alpha    beta');
    expect(normalizeOrchestrateRequest('  alpha ;;  beta  ')).toBe('alpha    beta');
  });
});

describe('buildOrchestrateDecomposePrepareArgs — CLI 두 얼굴 공유 분해 준비 인자 조립', () => {
  test('여덟 플래그가 전부 꺼지고 json이면 플래그 키와 onInfo 키가 없다', () => {
    const onInfo = () => undefined;
    const args = buildOrchestrateDecomposePrepareArgs({
      request: 'goal',
      goals: [{ feature: 'goal' }],
      decompose: false,
      fabricDecompose: false,
      maxTasks: undefined,
      base: undefined,
      autoMerge: false,
      openPr: false,
      autoReview: false,
      json: true,
      onInfo,
    });

    expect(Object.keys(args).sort()).toEqual(['goals', 'request']);
  });

  test('여덟 플래그가 전부 켜지면 기존 준비 입력 키가 전부 실린다', () => {
    const onInfo = () => undefined;
    const goals = [{ feature: 'goal' }];
    const args = buildOrchestrateDecomposePrepareArgs({
      request: 'goal',
      goals,
      decompose: true,
      fabricDecompose: true,
      maxTasks: 4,
      base: 'main',
      autoMerge: true,
      openPr: true,
      autoReview: true,
      json: false,
      onInfo,
    });

    expect(args).toEqual({
      request: 'goal',
      goals,
      decompose: true,
      fabricDecompose: true,
      maxTasks: 4,
      base: 'main',
      autoMerge: true,
      openPr: true,
      autoReview: true,
      onInfo,
    });
  });

  test('json 이 참이면 onInfo 를 싣지 않고 거짓이면 넘겨준 함수를 그대로 싣는다', () => {
    const onInfo = () => undefined;
    const base = { request: 'goal', goals: [{ feature: 'goal' }] };

    expect(buildOrchestrateDecomposePrepareArgs({ ...base, json: true, onInfo })).not.toHaveProperty('onInfo');
    expect(buildOrchestrateDecomposePrepareArgs({ ...base, json: false, onInfo }).onInfo).toBe(onInfo);
  });
});

describe('restoreOrchestrateCheckpointGoals — CLI 두 얼굴 공유 체크포인트 복원 판단', () => {
  test('복원 판단 helper의 내부 입력·결과 타입을 공개 API로 export하지 않는다', () => {
    const src = readFileSync(join(import.meta.dir, 'self-orchestrate-runtime.ts'), 'utf-8');

    expect(src).not.toMatch(/export interface OrchestrateCheckpointRestore(?:Input|Result)/);
    expect(src).toMatch(/interface OrchestrateCheckpointRestoreInput/);
    expect(src).toMatch(/interface OrchestrateCheckpointRestoreResult/);
  });

  test('goal 원형이 있는 체크포인트면 그것을 정본으로 쓰고 기존 재개 문면을 그대로 낸다', () => {
    const checkpointGoals = [
      { id: 'root', feature: 'root goal' },
      { id: 'child', feature: 'child goal', dependsOn: ['root'] },
    ];
    const argumentGoals = [{ feature: 'argument goal' }];
    const messages: string[] = [];
    const prior = { runId: 'run-resume', createdAt: 1, updatedAt: 2, results: [], goals: checkpointGoals, pid: 3 } as SelfDevRunState;

    const restored = restoreOrchestrateCheckpointGoals({
      resume: 'run-resume',
      goals: argumentGoals,
      loadRun: (runId) => runId === 'run-resume' ? prior : null,
      onInfo: (message) => messages.push(message),
    });

    expect(restored).toEqual({ prior, goals: checkpointGoals });
    expect(messages).toEqual(['[self-dev] 재개 — 체크포인트의 goal 원형 2개 복원(의존성 1건)']);
  });

  test('goal 원형이 없는 옛 판 체크포인트면 인자 goals를 유지하고 기존 경고 문면을 그대로 낸다', () => {
    const argumentGoals = [{ feature: 'argument goal' }];
    const messages: string[] = [];
    const prior = { runId: 'legacy-run', createdAt: 1, updatedAt: 2, results: [], pid: 3 } as SelfDevRunState;

    const restored = restoreOrchestrateCheckpointGoals({
      resume: 'legacy-run',
      goals: argumentGoals,
      loadRun: (runId) => runId === 'legacy-run' ? prior : null,
      onInfo: (message) => messages.push(message),
    });

    expect(restored).toEqual({ prior, goals: argumentGoals });
    expect(messages).toEqual(['[self-dev] ⚠️ 이 체크포인트엔 goal 원형이 없다(옛 판) — 인자 goals 를 쓴다. 의존성은 복원되지 않는다']);
  });

  test('json 모드에서는 복원 판단은 같고 사람 문면만 내지 않는다', () => {
    const checkpointGoals = [{ feature: 'checkpoint goal' }];
    const messages: string[] = [];
    const prior = { runId: 'json-run', createdAt: 1, updatedAt: 2, results: [], goals: checkpointGoals, pid: 3 } as SelfDevRunState;

    const restored = restoreOrchestrateCheckpointGoals({
      resume: 'json-run',
      goals: [{ feature: 'argument goal' }],
      loadRun: () => prior,
      json: true,
      onInfo: (message) => messages.push(message),
    });

    expect(restored).toEqual({ prior, goals: checkpointGoals });
    expect(messages).toEqual([]);
  });
});

describe('countOrchestrateResumeSkips — CLI 두 얼굴 공유 재개 skip 집계', () => {
  test('classifyResumeDisposition 주입 판정만으로 착지 전과 같은 skip 수를 센다', () => {
    const results = [
      { taskId: 'landed', status: 'done', stage: 'merged', merged: true },
      { taskId: 'review-blocked', status: 'done', stage: 'review-blocked', merged: false },
      { taskId: 'legacy', status: 'done' },
      { taskId: 'failed-pr', status: 'failed', stage: 'pr-opened', merged: false },
    ] as const;
    const classify = (result: typeof results[number]) => {
      if (result.taskId === 'landed' || result.taskId === 'legacy') return 'skip' as const;
      if (result.taskId === 'failed-pr') return 'rerun-duplicate-risk' as const;
      return 'rerun' as const;
    };
    const beforeLandingCount = results.filter((result) => classify(result) === 'skip').length;

    expect(countOrchestrateResumeSkips(results, classify)).toBe(beforeLandingCount);
    expect(countOrchestrateResumeSkips(results, classify)).toBe(2);
  });
});

describe('resolveOrchestrateRunIdentity — CLI 두 얼굴 공유 run identity 해석', () => {
  test('resume 없음 경고·resolve 입력·env 기록·createdAt 결정을 한 자리에서 조립한다', () => {
    const messages: string[] = [];
    const envWrites: Array<{ key: string; value: string }> = [];
    const resolved = resolveOrchestrateRunIdentity({
      resume: 'missing-run',
      prior: null,
      harnessRunIdEnv: 'RUN_ENV',
      getEnv: (key) => key === 'RUN_ENV' ? 'inherited-run' : undefined,
      setEnv: (key, value) => envWrites.push({ key, value }),
      resolveRunIdentity: (input) => {
        expect(input).toEqual({ explicit: 'missing-run', inherited: 'inherited-run' });
        return { runId: 'missing-run', source: 'explicit' };
      },
      now: () => 1234,
      onInfo: (message) => messages.push(message),
    });

    expect(resolved).toEqual({ runId: 'missing-run', runIdSource: 'explicit', createdAt: 1234 });
    expect(envWrites).toEqual([{ key: 'RUN_ENV', value: 'missing-run' }]);
    expect(messages).toEqual(["[self-dev] ⚠️ resume run 'missing-run' 없음 — 전체 신규 실행"]);
  });

  test('prior가 있으면 createdAt을 보존하고 now·resume 없음 경고를 쓰지 않는다', () => {
    let nowCalls = 0;
    const messages: string[] = [];
    const prior = { createdAt: 777 };

    const resolved = resolveOrchestrateRunIdentity({
      resume: 'existing-run',
      prior,
      harnessRunIdEnv: 'RUN_ENV',
      getEnv: () => undefined,
      setEnv: () => {},
      resolveRunIdentity: () => ({ runId: 'existing-run', source: 'explicit' }),
      now: () => { nowCalls += 1; return 999; },
      onInfo: (message) => messages.push(message),
    });

    expect(resolved.createdAt).toBe(777);
    expect(nowCalls).toBe(0);
    expect(messages).toEqual([]);
  });

  test('json 모드에서는 resume 없음 경고 문면을 내지 않는다', () => {
    const messages: string[] = [];

    resolveOrchestrateRunIdentity({
      resume: 'missing-run',
      prior: null,
      json: true,
      harnessRunIdEnv: 'RUN_ENV',
      setEnv: () => {},
      resolveRunIdentity: () => ({ runId: 'missing-run', source: 'explicit' }),
      now: () => 1,
      onInfo: (message) => messages.push(message),
    });

    expect(messages).toEqual([]);
  });
});

describe('bindOrchestrateRunLedger — CLI 두 얼굴 공유 원장 기록', () => {
  test('착지 전 self 얼굴이 적던 run-state와 participant 값을 그대로 조립한다', () => {
    const saved: SelfDevRunState[] = [];
    const participants: Array<{ runId: string; participant: SelfDevRunParticipant }> = [];
    const goals = [{ id: 'g1', feature: 'goal-a', dependsOn: ['root'] }];
    const prior = { results: [{ taskId: 'old', feature: 'old', status: 'done' as const }], dependencies: { g1: ['root'] } };
    let nowValue = 2000;

    const { checkpoint } = bindOrchestrateRunLedger({
      saveRun: (state) => saved.push(state),
      addParticipant: (runId, participant) => participants.push({ runId, participant }),
      checkpointDependencies: (checkpointPrior, checkpointGoals) => {
        expect(checkpointPrior).toBe(prior);
        expect(checkpointGoals).toBe(goals);
        return checkpointPrior?.dependencies;
      },
    }, {
      runId: 'run-1',
      createdAt: 1000,
      prior,
      goals,
      pid: 4242,
      runIdSource: 'minted',
      now: () => nowValue,
    });
    expect(saved).toEqual([{
      runId: 'run-1',
      createdAt: 1000,
      updatedAt: 2000,
      results: [{ taskId: 'old', feature: 'old', status: 'done' }],
      dependencies: { g1: ['root'] },
      goals,
      pid: 4242,
    }]);
    expect(participants).toEqual([{
      runId: 'run-1',
      participant: { id: 'process:4242', kind: 'process', transports: [], registeredAt: 2000, runIdSource: 'minted' },
    }]);

    nowValue = 3000;
    checkpoint([{ taskId: 'new', feature: 'goal-a', status: 'done' }]);
    expect(saved[1]).toEqual({
      runId: 'run-1',
      createdAt: 1000,
      updatedAt: 3000,
      results: [{ taskId: 'new', feature: 'goal-a', status: 'done' }],
      dependencies: { g1: ['root'] },
      goals,
      pid: 4242,
    });
  });

  test('a stamped orchestrate launch writes seat beside the PID on every checkpoint', () => {
    const saved: SelfDevRunState[] = [];
    const { checkpoint } = bindOrchestrateRunLedger({ saveRun: (state) => saved.push(state),
      addParticipant: () => {}, checkpointDependencies: () => ({ goal: [] }) }, {
      runId: 'run-seat-orchestrate', createdAt: 1, prior: null, goals: [{ feature: 'goal' }],
      pid: 451, seat: 'UX', runIdSource: 'minted', now: () => 2,
    });
    checkpoint([{ taskId: 'goal', feature: 'goal', status: 'done' }]);
    expect(saved).toHaveLength(2);
    expect(saved.map(({ runId, pid, seat }) => ({ runId, pid, seat }))).toEqual([
      { runId: 'run-seat-orchestrate', pid: 451, seat: 'UX' },
      { runId: 'run-seat-orchestrate', pid: 451, seat: 'UX' },
    ]);
  });

  test('checkpoint와 participant 저장 실패를 같은 stage 이름으로 호출부에 넘긴다', () => {
    const failures: Array<{ stage: string; error: string }> = [];

    bindOrchestrateRunLedger({
      saveRun: () => { throw new Error('checkpoint denied'); },
      addParticipant: () => { throw new Error('participant denied'); },
      checkpointDependencies: () => ({ goal: [] }),
    }, {
      runId: 'run-2',
      createdAt: 1,
      prior: null,
      goals: [{ feature: 'goal' }],
      pid: 7,
      runIdSource: 'explicit',
      now: () => 9,
      onPersistenceFailure: (stage, error) => failures.push({ stage, error: error instanceof Error ? error.message : String(error) }),
    });

    expect(failures).toEqual([
      { stage: 'checkpoint', error: 'checkpoint denied' },
      { stage: 'participant', error: 'participant denied' },
    ]);
  });

  test('콜백 없는 self 경로는 checkpoint 저장 실패를 기존처럼 throw한다', () => {
    expect(() => bindOrchestrateRunLedger({
      saveRun: () => { throw new Error('checkpoint denied'); },
      addParticipant: () => {},
      checkpointDependencies: () => ({ goal: [] }),
    }, {
      runId: 'run-3',
      createdAt: 1,
      prior: null,
      goals: [{ feature: 'goal' }],
      pid: 7,
      runIdSource: 'explicit',
      now: () => 9,
    })).toThrow('checkpoint denied');
  });

  test('콜백 없는 self 경로는 participant 저장 실패를 기존처럼 throw한다', () => {
    expect(() => bindOrchestrateRunLedger({
      saveRun: () => {},
      addParticipant: () => { throw new Error('participant denied'); },
      checkpointDependencies: () => ({ goal: [] }),
    }, {
      runId: 'run-4',
      createdAt: 1,
      prior: null,
      goals: [{ feature: 'goal' }],
      pid: 7,
      runIdSource: 'explicit',
      now: () => 9,
    })).toThrow('participant denied');
  });
});

describe('prepareOrchestrateDecomposeGoals — CLI 공유 전처리', () => {
  test('분해 없이 분해기를 고르면 self 와 같은 문장·exit 2', async () => {
    const result = await prepareOrchestrateDecomposeGoals({
      request: 'goal',
      goals: [{ feature: 'goal' }],
      fabricDecompose: true,
    });
    expect(result).toEqual({
      ok: false,
      error: FABRIC_DECOMPOSE_REQUIRES_DECOMPOSE_ERROR,
      exitCode: 2,
    });
  });

  test('같은 maxTasks 입력을 fabric 어댑터에 같은 정규화 값으로 넘긴다', async () => {
    const captured: Array<number | undefined> = [];
    _setFabricDecomposeConfigReaderForTesting(() => ({ enabled: false, autoPathThreshold: null }));
    _setFabricDecomposeForTesting(async (_request, options) => {
      captured.push(options?.decomposeOptions?.maxTasks);
      return {
        status: 'decomposed',
        rfc: { arcs: [] } as never,
        goals: [{ feature: 'piece' }],
        decompositions: [],
        omittedGoalCount: 0,
        budgetSkippedArcCount: 0,
        budgetLimited: false,
      };
    });

    for (const maxTasks of ['3', 3] as const) {
      const result = await prepareOrchestrateDecomposeGoals({
        request: 'goal',
        goals: [{ feature: 'goal' }],
        decompose: true,
        fabricDecompose: true,
        maxTasks,
      });
      expect(result.ok).toBe(true);
    }
    expect(captured).toEqual([3, 3]);
  });

  test('maxTasks 하한·기본은 Math.max(1, Number(maxTasks) || 6)', async () => {
    const captured: Array<number | undefined> = [];
    _setDecomposeForTesting(async (_feature, options) => {
      captured.push(options?.maxTasks);
      return {
        goals: [{ feature: 'piece' }],
        decomposition: {
          recommendedMaxTasks: 1,
          actualTaskCount: 1,
          truncatedAtHardMax: false,
          exceededRecommendedMax: false,
          outcome: 'decomposed',
        },
      };
    });

    await prepareOrchestrateDecomposeGoals({ request: 'g', goals: [{ feature: 'g' }], decompose: true, maxTasks: '0' });
    await prepareOrchestrateDecomposeGoals({ request: 'g', goals: [{ feature: 'g' }], decompose: true, maxTasks: 'foo' });
    await prepareOrchestrateDecomposeGoals({ request: 'g', goals: [{ feature: 'g' }], decompose: true });
    expect(captured).toEqual([6, 6, undefined]);
  });

  test('openPr·autoReview 를 각 goal 에 얹는다', async () => {
    _setDecomposeForTesting(async () => ({
      goals: [{ feature: 'a' }, { feature: 'b', dependsOn: ['a'] }],
      decomposition: {
        recommendedMaxTasks: 2,
        actualTaskCount: 2,
        truncatedAtHardMax: false,
        exceededRecommendedMax: false,
        outcome: 'decomposed',
      },
    }));
    const result = await prepareOrchestrateDecomposeGoals({
      request: 'g',
      goals: [{ feature: 'g' }],
      decompose: true,
      openPr: true,
      autoReview: true,
    });
    expect(result).toEqual({
      ok: true,
      goals: [
        { feature: 'a', openPr: true, autoReview: true },
        { feature: 'b', dependsOn: ['a'], openPr: true, autoReview: true },
      ],
    });
  });

  test('selectFabricDecomposer 결과 모양을 줄이지 않는다', () => {
    expect(Object.keys(selectFabricDecomposer(true, { enabled: true, autoPathThreshold: null }, undefined)).sort())
      .toEqual(['decomposer', 'source']);
    expect(selectFabricDecomposer(true, { enabled: true, autoPathThreshold: null }, undefined))
      .toEqual({ decomposer: 'fabric', source: 'request' });
  });
});
