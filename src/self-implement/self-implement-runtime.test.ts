// ⛔⭐⭐⭐ 관측 전용 스위치가 **TUI 경로에도** 걸리는지.
//
// 실측(2026-08-02): 스위치가 `boot/daemon-tools/self-implement.ts` 에만 있었고 **TUI 는 이 런타임을
// 탄다**. 그래서 「관측 전용」으로 재려던 코퍼스 측정이 **진짜 self-implement 런을 두 번 띄웠고**
// 사람이 손으로 죽였다(worktree 두 개 생성). ⇒ 만든 것이 닿지 않았다.
import { beforeEach, describe, expect, test, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { runSelfOrchestrateCliCommand, type OrchestrateCliInput } from '../self-dev/orchestrate-cli.js';
import {
  _setSelfImplementGoalAuthorForTesting,
  _setSelfImplementDecomposeForTesting,
  _setSelfImplementFabricDecomposeForTesting,
  _setSelfImplementFabricDecomposeConfigReaderForTesting,
  _setSelfImplementSeamsFactoryForTesting,
  _setSelfImplementCliCommandForTesting,
  _setSelfImplementOrchestrateCliCommandForTesting,
  _setSelfImplementOrchestrateForTesting,
  buildSelfImplementSpec,
  selfImplementRuntime,
  setSelfImplementApprover,
  setSelfImplementSoftStopSpaceObserver,
  type DocumentReferenceStatus,
} from './self-implement-runtime.js';
import { _setAutoOpenPrConfigReaderForTesting } from './auto-open-pr.js';
import { isObserveOnly, _setObserveOnlyConfigReaderForTesting } from './observe-only.js';
import type { DefaultSeamsOptions } from './seams.js';
import { runSelfImplementCliCommand, type SelfImplementCliOpts, type SingleRunSuperviseOptions } from './self-implement-cli.js';
import { runSelfImplement as runProductionSelfImplement } from './orchestrator.js';
import { buildSelfImplementDevSpec, planDevPipeline } from '../self-dev/dev-pipeline.js';
import { buildSelfImplementDaemonSpec, dispatchSelfImplement } from '../boot/daemon-tools/self-implement.js';
import { getUserConfig } from '../user-config.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import type { FeedbackEnvelope } from '../feedback/envelope.js';

const ctx = { surface: 'chat', sessionId: 's-1', signal: new AbortController().signal } as unknown as ToolRuntimeContext;
let goalDirectory: string;
let originalFabricDecompose: boolean;
let originalFabricDecomposeAutoPathThreshold: number | null;

beforeEach(() => {
  goalDirectory = mkdtempSync(join(tmpdir(), 'self-implement-runtime-'));
  const config = getUserConfig().tools.selfImplement;
  originalFabricDecompose = config.fabricDecompose;
  originalFabricDecomposeAutoPathThreshold = config.fabricDecomposeAutoPathThreshold;
  const goalFile = join(goalDirectory, 'goal.md');
  writeFileSync(goalFile, '- GoalId: 0123456789abcdef\n- GoalType: implement\n');
  _setSelfImplementGoalAuthorForTesting(async () => ({ path: goalFile }));
});

afterEach(() => {
  const config = getUserConfig().tools.selfImplement;
  config.fabricDecompose = originalFabricDecompose;
  config.fabricDecomposeAutoPathThreshold = originalFabricDecomposeAutoPathThreshold;
  _setAutoOpenPrConfigReaderForTesting();
  _setObserveOnlyConfigReaderForTesting();
  _setSelfImplementSeamsFactoryForTesting(null);
  _setSelfImplementCliCommandForTesting(null);
  _setSelfImplementOrchestrateCliCommandForTesting(null);
  _setSelfImplementDecomposeForTesting(null);
  _setSelfImplementFabricDecomposeForTesting(null);
  _setSelfImplementFabricDecomposeConfigReaderForTesting();
  _setSelfImplementOrchestrateForTesting(null);
  _setSelfImplementGoalAuthorForTesting(null);
  setSelfImplementApprover(null);
  setSelfImplementSoftStopSpaceObserver(null);
  rmSync(goalDirectory, { recursive: true, force: true });
});

describe('selfImplementRuntime — feature/goals 배타 계약', () => {
  test('스펙 루트는 유니온 없이 기존 필드 스키마와 unknown-field 거절을 보존한다', () => {
    const parameters = buildSelfImplementSpec().parameters as Record<string, unknown>;
    const properties = parameters.properties as Record<string, Record<string, unknown>>;

    expect(parameters).toMatchObject({ type: 'object', additionalProperties: false });
    expect(parameters.anyOf).toBeUndefined();
    expect(parameters.oneOf).toBeUndefined();
    expect(properties.feature).toMatchObject({ type: 'string' });
    expect(properties.goals).toMatchObject({ type: 'array', items: { type: 'string' }, minItems: 1 });
  });

  test('CLI-only 축 네 개를 툴 스펙에 추가하되 기존 15개 필드 이름을 보존한다', () => {
    const properties = buildSelfImplementSpec().parameters.properties as Record<string, Record<string, unknown>>;
    const beforeFields = [
      'feature', 'base', 'draft', 'ground', 'documentReferences', 'goals', 'auto_merge',
      'concurrency', 'deliverable', 'decompose', 'arcHint', 'fabric_decompose', 'target_paths',
      'supervise', 'supervise_rounds',
    ];

    expect(Object.keys(properties).filter(name => beforeFields.includes(name)).sort()).toEqual([...beforeFields].sort());
    expect(Object.keys(properties).length).toBeGreaterThan(15);
    expect(properties.observe_only).toEqual(expect.objectContaining({ type: 'boolean' }));
    expect(properties.plan).toEqual(expect.objectContaining({ type: 'boolean' }));
    expect(properties.open_pr).toEqual(expect.objectContaining({ type: 'boolean' }));
    expect(properties.max_wait).toEqual(expect.objectContaining({ type: 'integer', minimum: 1 }));
  });

  test('은퇴한 plan 키는 남기되 거부와 기본 goal-loop 대안을 안내하고 데몬도 같은 문면을 낸다', () => {
    const coreProperties = buildSelfImplementSpec().parameters.properties as Record<string, Record<string, unknown>>;
    const daemonProperties = buildSelfImplementDaemonSpec().parameters.properties as Record<string, Record<string, unknown>>;
    const description = coreProperties.plan.description as string;

    expect(coreProperties.plan).toEqual(expect.objectContaining({ type: 'boolean' }));
    expect(description).toMatch(/은퇴/);
    expect(description).toMatch(/거부/);
    expect(description).toMatch(/plan 없이/);
    expect(description).toMatch(/goal-loop.*기본/);
    expect(description).not.toMatch(/staged harness plan 경로를 사용/);
    expect(daemonProperties.plan.description).toBe(description);
  });

  test('feature와 goals가 모두 있거나 모두 없으면 두 이름을 밝히고 본체를 호출하지 않는다', async () => {
    let featureCalls = 0;
    let goalsCalls = 0;
    _setSelfImplementCliCommandForTesting(async () => {
      featureCalls += 1;
      throw new Error('feature execution must not start');
    });
    _setSelfImplementOrchestrateForTesting(async () => {
      goalsCalls += 1;
      throw new Error('goals execution must not start');
    });

    await expect(selfImplementRuntime.run({}, ctx)).rejects.toThrow('exactly one of `feature` or `goals` is required');
    await expect(selfImplementRuntime.run({ feature: 'single', goals: ['parallel'] }, ctx)).rejects.toThrow('exactly one of `feature` or `goals` is required');
    expect(featureCalls).toBe(0);
    expect(goalsCalls).toBe(0);
  });

  test('self가 아닌 중앙 CLI 결과는 observed output을 반환한다', async () => {
    _setSelfImplementCliCommandForTesting(async () => ({
      ok: true,
      kind: 'observed',
      source: 'default',
      exitCode: 0,
    }));

    const result = await selfImplementRuntime.run({ feature: 'single feature' }, ctx);

    expect(result).toMatchObject({ ok: true, output: '[self-implement] observed by central CLI' });
  });

  test('실행 원본 세션을 SelfImplement CLI의 명시 parentSessionId로 전달한다', async () => {
    let received: SelfImplementCliOpts | undefined;
    _setSelfImplementCliCommandForTesting(async (_feature, options) => {
      received = options;
      return { ok: true, kind: 'observed' } as never;
    });

    await selfImplementRuntime.run(
      { feature: 'delegated feature' },
      { ...ctx, sessionId: 'runtime-session', originSessionId: 'origin-session' },
    );

    expect(received?.parentSessionId).toBe('origin-session');
  });

  test('feature 단독과 goals 단독은 각각 기존 실행 본체로 전달한다', async () => {
    let receivedFeature: string | undefined;
    let receivedOptions: SelfImplementCliOpts | undefined;
    let receivedGoals: unknown;
    _setSelfImplementCliCommandForTesting(async (feature, options) => {
      receivedFeature = feature;
      receivedOptions = options;
      return { ok: true, kind: 'observed' } as never;
    });
    _setSelfImplementOrchestrateForTesting(async options => {
      receivedGoals = options;
      return [{ status: 'done', merged: false } as never];
    });

    const featureResult = await selfImplementRuntime.run({ feature: 'single feature' }, ctx);
    const goalsResult = await selfImplementRuntime.run({ goals: ['parallel goal'] }, ctx);

    expect(receivedFeature).toBe('single feature');
    expect(receivedOptions?.parentSessionId).toBe('s-1');
    expect(featureResult.ok).toBe(true);
    expect(receivedGoals).toEqual({ goals: [{ feature: 'parallel goal', autoMerge: false }] });
    expect(goalsResult.ok).toBe(true);
  });
});

describe('selfImplementRuntime — arcHint 분해 연결', () => {
  test('스펙은 선택적 2~6 arcHint를 노출한다', () => {
    const properties = buildSelfImplementSpec().parameters.properties as Record<string, unknown>;
    expect(properties.arcHint).toEqual(expect.objectContaining({ type: 'integer', minimum: 2, maximum: 6 }));
  });

  test('decompose=true의 arcHint를 분해 seam에 전달하고 orchestrateSelfDev를 재사용한다', async () => {
    let received: { feature: string; options: { arcHint?: number; observation?: { goalId?: string | null; runId?: string | null } } | undefined } | undefined;
    let orchestrated: unknown;
    _setSelfImplementDecomposeForTesting(async (feature, options) => {
      received = { feature, options };
      return {
        goals: [{ id: 'types', feature: 'Define types' }],
        decomposition: { recommendedMaxTasks: 6, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
      };
    });
    _setSelfImplementOrchestrateForTesting(async (options) => {
      orchestrated = options;
      return [{ status: 'done', merged: false } as never];
    });

    const result = await selfImplementRuntime.run({ goals: ['composite request'], decompose: true, arcHint: 3 }, ctx);

    expect(received).toEqual({ feature: 'composite request', options: { arcHint: 3, observation: { goalId: undefined, runId: null } } });
    expect(orchestrated).toMatchObject({ goals: [{ id: 'types', feature: 'Define types', autoMerge: false }] });
    expect(result.ok).toBe(true);
  });

  test('launch 선언 분해는 호출자 path 없이 기존 goal author의 canonical path를 전달한다', async () => {
    const originalRequest = ['원문 요청', '## 산출물을 어떻게 켜나', '- Entrypoint: apps/demo/server.ts', '- Port: 31415'].join('\n');
    let orchestrated: unknown;
    _setSelfImplementDecomposeForTesting(async () => ({
      goals: [{ id: 'part', feature: '분해된 골' }],
      decomposition: { recommendedMaxTasks: 1, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
    }));
    let authorDeps: { goalTitle?: string } | undefined;
    _setSelfImplementGoalAuthorForTesting(async (_ask, _cwd, deps) => {
      authorDeps = deps;
      return { path: '/repo/docs/goals/canonical-launch.md' };
    });
    _setSelfImplementOrchestrateForTesting(async (options) => { orchestrated = options; return [{ status: 'done', merged: false } as never]; });

    const result = await selfImplementRuntime.run({ goals: [originalRequest], decompose: true }, ctx);

    expect(result.ok).toBe(true);
    expect(authorDeps).toEqual({ goalTitle: 'SelfImplement deliverable' });
    expect(orchestrated).toMatchObject({
      deliverable: { document: originalRequest, attribution: 'all', goalPath: '/repo/docs/goals/canonical-launch.md' },
    });
  });

  test('arcHint 누락은 기존 분해 seam 호출을 보존하고 범위 밖 입력은 실행 전에 거부한다', async () => {
    let received: { options: { arcHint?: number; observation?: { goalId?: string | null; runId?: string | null } } | undefined } | undefined;
    _setSelfImplementDecomposeForTesting(async (_feature, options) => {
      received = { options };
      return {
        goals: [{ id: 'task', feature: 'Task' }],
        decomposition: { recommendedMaxTasks: 6, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
      };
    });
    _setSelfImplementOrchestrateForTesting(async () => [{ status: 'done', merged: false } as never]);

    await selfImplementRuntime.run({ goals: ['composite request'], decompose: true }, ctx);

    expect(received).toEqual({ options: { observation: { goalId: undefined, runId: null } } });
    await expect(selfImplementRuntime.run({ goals: ['composite request'], decompose: true, arcHint: 1 }, ctx)).rejects.toThrow('`arcHint` must be an integer from 2 to 6');
    await expect(selfImplementRuntime.run({ goals: ['composite request'], arcHint: 2 }, ctx)).rejects.toThrow('`arcHint` requires `decompose=true`');
  });
});

describe('selfImplementRuntime — Fabric 분해 opt-in', () => {
  test.each([
    [true, true, 'fabric', 'request'],
    [false, true, 'default', 'request'],
    [undefined, true, 'fabric', 'config'],
    [undefined, false, 'default', 'default'],
  ] as const)('공유 선택기는 요청=%s, 설정=%s를 %s/%s로 관측하고 해당 분해 seam을 선택한다', async (requestFabricDecompose, configEnabled, decomposer, source) => {
    let configReaderCalls = 0;
    _setSelfImplementFabricDecomposeConfigReaderForTesting(() => {
      configReaderCalls += 1;
      return { enabled: configEnabled, autoPathThreshold: null };
    });
    const logs: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'runtime.decomposer-selection') logs.push(data ?? {});
    }) as never);
    let legacyCalls = 0;
    let fabricCalls = 0;
    _setSelfImplementDecomposeForTesting(async () => {
      legacyCalls += 1;
      return { goals: [], decomposition: { recommendedMaxTasks: 0, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' } };
    });
    _setSelfImplementFabricDecomposeForTesting(async () => {
      fabricCalls += 1;
      return { status: 'decomposed', rfc: { arcs: [] } as never, goals: [], decompositions: [], omittedGoalCount: 0, budgetSkippedArcCount: 0, budgetLimited: false };
    });
    _setSelfImplementOrchestrateForTesting(async () => []);

    try {
      await selfImplementRuntime.run({ goals: ['composite'], decompose: true, ...(requestFabricDecompose === undefined ? {} : { fabric_decompose: requestFabricDecompose }) }, ctx);
    } finally {
      log.mockRestore();
    }

    expect(logs).toEqual([{ surface: 'chat', decomposer, source, normalizedPathCount: undefined, autoPathThreshold: null }]);
    expect(configReaderCalls).toBe(requestFabricDecompose === undefined ? 1 : 0);
    expect(fabricCalls).toBe(decomposer === 'fabric' ? 1 : 0);
    expect(legacyCalls).toBe(decomposer === 'default' ? 1 : 0);
  });

  test.each([
    [['src/a.ts', 'src/b.ts'], 'fabric', 'path-threshold'],
    [['src/a.ts'], 'default', 'default'],
  ] as const)('명시 요청과 설정이 없을 때 target_paths=%j는 %s/%s를 관측하고 해당 분해 seam을 선택한다', async (targetPaths, decomposer, source) => {
    const logs: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'runtime.decomposer-selection') logs.push(data ?? {});
    }) as never);
    let legacyCalls = 0;
    let fabricCalls = 0;
    _setSelfImplementFabricDecomposeConfigReaderForTesting(() => ({ enabled: false, autoPathThreshold: 2 }));
    _setSelfImplementDecomposeForTesting(async () => {
      legacyCalls += 1;
      return { goals: [], decomposition: { recommendedMaxTasks: 0, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' } };
    });
    _setSelfImplementFabricDecomposeForTesting(async () => {
      fabricCalls += 1;
      return { status: 'decomposed', rfc: { arcs: [] } as never, goals: [], decompositions: [], omittedGoalCount: 0, budgetSkippedArcCount: 0, budgetLimited: false };
    });
    _setSelfImplementOrchestrateForTesting(async () => []);

    try {
      await selfImplementRuntime.run({ goals: ['composite'], decompose: true, target_paths: targetPaths }, ctx);
    } finally {
      log.mockRestore();
    }

    expect(logs).toEqual([{
      surface: 'chat',
      decomposer,
      source,
      normalizedPathCount: targetPaths.length,
      autoPathThreshold: 2,
    }]);
    expect(fabricCalls).toBe(decomposer === 'fabric' ? 1 : 0);
    expect(legacyCalls).toBe(decomposer === 'default' ? 1 : 0);
  });

  test('명시 opt-in은 Fabric seam과 arcHint 옵션을 호출하고 기존 분해 seam은 우회한다', async () => {
    let legacyCalls = 0;
    let fabricOptions: { decomposeOptions?: { arcHint?: number } } | undefined;
    let orchestrated: unknown;
    _setSelfImplementDecomposeForTesting(async () => { legacyCalls += 1; throw new Error('legacy must not run'); });
    _setSelfImplementFabricDecomposeForTesting(async (_feature, options) => {
      fabricOptions = options;
      return { status: 'decomposed', rfc: { arcs: [] } as never, goals: [{ id: 'fabric', feature: 'Fabric task' }], decompositions: [], omittedGoalCount: 0, budgetSkippedArcCount: 0, budgetLimited: false };
    });
    _setSelfImplementOrchestrateForTesting(async options => { orchestrated = options; return []; });

    const result = await selfImplementRuntime.run({ goals: ['composite'], decompose: true, fabric_decompose: true, arcHint: 3 }, ctx);

    expect(legacyCalls).toBe(0);
    expect(fabricOptions).toEqual({ decomposeOptions: { arcHint: 3 } });
    expect(orchestrated).toMatchObject({ goals: [{ id: 'fabric', feature: 'Fabric task', autoMerge: false }] });
    expect(result.fabricDecomposition).toEqual({ status: 'decomposed', outcome: 'decomposed' });
  });

  test('Fabric이 정상 응답으로 서브태스크 0개를 반환할 때만 single-no-subtasks를 남긴다', async () => {
    let orchestrated: unknown;
    _setSelfImplementFabricDecomposeForTesting(async () => ({
      status: 'decomposed', rfc: { arcs: [] } as never, goals: [], decompositions: [], omittedGoalCount: 0, budgetSkippedArcCount: 0, budgetLimited: false,
    }));
    _setSelfImplementOrchestrateForTesting(async options => { orchestrated = options; return []; });

    const result = await selfImplementRuntime.run({ goals: ['composite'], decompose: true, fabric_decompose: true }, ctx);

    expect(result.fabricDecomposition).toEqual({ status: 'decomposed', outcome: 'single-no-subtasks' });
    expect(orchestrated).toEqual({
      goals: [],
      parentRequest: 'composite',
      deliverable: { document: 'composite', attribution: 'all' },
    });
  });

  test('opt-in이 없으면 기존 옵션형 분해 seam을 그대로 호출한다', async () => {
    let legacyCalls = 0;
    let fabricCalls = 0;
    _setSelfImplementDecomposeForTesting(async () => {
      legacyCalls += 1;
      return { goals: [], decomposition: { recommendedMaxTasks: 0, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'single-no-subtasks' } };
    });
    _setSelfImplementFabricDecomposeForTesting(async () => { fabricCalls += 1; throw new Error('fabric must not run'); });
    _setSelfImplementOrchestrateForTesting(async () => []);

    await selfImplementRuntime.run({ goals: ['composite'], decompose: true }, ctx);

    expect(legacyCalls).toBe(1);
    expect(fabricCalls).toBe(0);
  });

  test.each([
    ['missing-research-context', 'missing-research-context', true],
    ['grounding-empty', 'grounding-empty', true],
    ['authored-empty', 'authored-empty', true],
    ['grounding-failed', 'llm-failed', false],
    ['author-failed', 'llm-failed', false],
  ] as const)('Fabric %s 상태를 %s 반환값으로 보존하고 오케스트레이션을 중단한다', async (status, outcome, ok) => {
    const logs: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'runtime.fabric-decomposition') logs.push(data ?? {});
    }) as never);
    let orchestrateCalls = 0;
    _setSelfImplementFabricDecomposeForTesting(async () => status === 'authored-empty'
      ? { status, rfc: { arcs: [] } as never }
      : { status, message: `${status} reason` } as never);
    _setSelfImplementOrchestrateForTesting(async () => {
      orchestrateCalls += 1;
      return [];
    });
    try {
      const result = await selfImplementRuntime.run({ goals: ['composite'], decompose: true, fabric_decompose: true }, ctx);
      expect(result).toMatchObject({ ok, fabricDecomposition: { status, outcome } });
      expect(result.output).toContain(`Fabric decomposition ${status} (${outcome})`);
      if (status !== 'authored-empty') expect(result.output).toContain(`${status} reason`);
    } finally {
      log.mockRestore();
    }
    expect(orchestrateCalls).toBe(0);
    expect(logs).toContainEqual(expect.objectContaining({ status, outcome }));
  });
});

describe('selfImplementRuntime — 관측 전용', () => {
  test('ON: 런을 시작하지 않고 호출 사실만 반환한다', async () => {
    _setObserveOnlyConfigReaderForTesting(() => true);
    const result = await selfImplementRuntime.run({ feature: 'D1-01 코퍼스 문항' }, ctx);
    expect(result.observed).toBe(true);
    expect(result.ok).toBe(true);
    // ⛔ 아무 노드도 안 돌았으므로 **단계가 없어야** 한다 — 없는 것을 있는 값으로 적으면
    //    «안 돌았다» 와 «어느 단계에서 끝났다» 가 같은 값이 된다.
    expect(result.stage).toBeUndefined();
    expect(result.node).toBeUndefined();
    expect(result.branch).toBeUndefined();
    expect(result.output).toContain('관측 전용');
  });

  test('goals도 관측 전용 관문 뒤에서 멈추고 병렬 실행기를 호출하지 않는다', async () => {
    _setObserveOnlyConfigReaderForTesting(() => true);
    let orchestrateCalls = 0;
    _setSelfImplementOrchestrateForTesting(async () => {
      orchestrateCalls += 1;
      throw new Error('orchestrator must not start');
    });

    const result = await selfImplementRuntime.run({ goals: ['A', 'B'] }, ctx);

    expect(result).toMatchObject({ ok: true, observed: true });
    expect(result.output).toContain('A · B');
    expect(orchestrateCalls).toBe(0);
  });

  test('records the enabled decision and its flag source', async () => {
    const previous = process.env.ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY;
    process.env.ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY = '1';
    const logs: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'runtime.observe-only-decision') logs.push(data ?? {});
    }) as never);
    try {
      await selfImplementRuntime.run({ feature: 'flag source' }, ctx);
    } finally {
      log.mockRestore();
      if (previous === undefined) delete process.env.ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY; else process.env.ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY = previous;
    }
    expect(logs).toContainEqual(expect.objectContaining({ observeOnly: true, observeOnlySource: 'flag' }));
  });

  test('⛔ fail-closed: config 조회가 실패하면 런을 시작하지 않고 오류를 전파한다', async () => {
    _setObserveOnlyConfigReaderForTesting(() => { throw new Error('observe-only config unavailable'); });
    await expect(selfImplementRuntime.run({ feature: 'fail-closed' }, ctx))
      .rejects.toThrow('observe-only config unavailable');
  });

  test('feature 검증은 관측 전용보다 앞선다 — 빈 feature 는 그대로 거부', async () => {
    _setObserveOnlyConfigReaderForTesting(() => true);
    await expect(selfImplementRuntime.run({ feature: '   ' }, ctx)).rejects.toThrow('`feature` is required');
  });

  test('요청 observe_only=true는 config off에서도 관측 전용 결정으로 전달되어 런을 시작하지 않는다', async () => {
    _setObserveOnlyConfigReaderForTesting(() => false);
    let cliCalls = 0;
    const logs: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'runtime.observe-only-decision') logs.push(data ?? {});
    }) as never);
    _setSelfImplementCliCommandForTesting(async () => {
      cliCalls += 1;
      throw new Error('runtime observe_only must stop before CLI execution');
    });
    try {
      const result = await selfImplementRuntime.run({ feature: 'request observe only', observe_only: true }, ctx);
      expect(result).toMatchObject({ ok: true, observed: true });
    } finally {
      log.mockRestore();
    }
    expect(cliCalls).toBe(0);
    expect(logs).toContainEqual(expect.objectContaining({ observeOnly: true, observeOnlySource: 'flag' }));
  });
});

describe('selfImplementRuntime — autoOpenPr 사전승인', () => {
  test('ON: injected approver보다 먼저 승인하고 config source를 기록한다', async () => {
    _setAutoOpenPrConfigReaderForTesting(() => true);
    const logs: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'runtime.auto-open-pr-decision') logs.push(data ?? {});
    }) as never);
    let injectedApproverCalls = 0;
    setSelfImplementApprover(async () => {
      injectedApproverCalls += 1;
      return false;
    });
    _setSelfImplementSeamsFactoryForTesting((options: DefaultSeamsOptions) => {
      expect(options.approvePr).toBeDefined();
      return {
        async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
        async implement() { return { ok: true, summary: 'implemented' }; },
        async gate() { return { passed: true }; },
        async openPr() { return { url: 'https://example.test/pr/1', number: 1 }; },
        approvePr: async (summary) => options.approvePr!({ branch: summary.branch, implSummary: summary.implSummary }),
      };
    });
    try {
      const result = await selfImplementRuntime.run({ feature: 'auto-open TUI' }, ctx);
      expect(result.stage).toBe('pr-opened');
    } finally {
      log.mockRestore();
    }
    expect(injectedApproverCalls).toBe(0);
    expect(logs).toContainEqual(expect.objectContaining({ autoOpenPr: true, autoOpenPrSource: 'config' }));
  });

  test('config read failure: fails closed to the injected approver and records config-error', async () => {
    _setAutoOpenPrConfigReaderForTesting(() => { throw new Error('auto-open-pr config unavailable'); });
    const logs: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'runtime.auto-open-pr-decision') logs.push(data ?? {});
    }) as never);
    let injectedApproverCalls = 0;
    setSelfImplementApprover(async () => {
      injectedApproverCalls += 1;
      return false;
    });
    _setSelfImplementSeamsFactoryForTesting((options: DefaultSeamsOptions) => ({
      async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
      async implement() { return { ok: true, summary: 'implemented' }; },
      async gate() { return { passed: true }; },
      async openPr() { return { url: 'https://example.test/pr/1', number: 1 }; },
      approvePr: async (summary) => options.approvePr!({ branch: summary.branch, implSummary: summary.implSummary }),
    }));
    try {
      const result = await selfImplementRuntime.run({ feature: 'config failure TUI approval' }, ctx);
      expect(result.stage).toBe('pr-declined');
    } finally {
      log.mockRestore();
    }
    expect(injectedApproverCalls).toBe(1);
    expect(logs).toContainEqual(expect.objectContaining({ autoOpenPr: false, autoOpenPrSource: 'config-error' }));
  });

  test('OFF: injected approver remains the only approval route', async () => {
    _setAutoOpenPrConfigReaderForTesting(() => false);
    let injectedApproverCalls = 0;
    setSelfImplementApprover(async () => {
      injectedApproverCalls += 1;
      return false;
    });
    _setSelfImplementSeamsFactoryForTesting((options: DefaultSeamsOptions) => ({
      async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
      async implement() { return { ok: true, summary: 'implemented' }; },
      async gate() { return { passed: true }; },
      async openPr() { return { url: 'https://example.test/pr/1', number: 1 }; },
      approvePr: async (summary) => options.approvePr!({ branch: summary.branch, implSummary: summary.implSummary }),
    }));
    const result = await selfImplementRuntime.run({ feature: 'manual TUI approval' }, ctx);
    expect(injectedApproverCalls).toBe(1);
    expect(result.stage).toBe('pr-declined');
  });
});

describe('selfImplementRuntime — 단일 런 슈퍼바이저 입력', () => {
  const cliOutcome = {
    ok: true as const,
    kind: 'observed' as const,
    source: 'default' as const,
    exitCode: 0,
  };

  test('툴 스펙은 슈퍼바이저 스위치와 재개 라운드 상한을 함께 선언한다', () => {
    const properties = buildSelfImplementSpec().parameters.properties as Record<string, unknown>;
    expect(properties.supervise).toEqual(expect.objectContaining({ type: 'boolean' }));
    expect(properties.supervise_rounds).toEqual(expect.objectContaining({ type: 'number' }));
  });

  test('supervise=true 요청은 중앙 CLI 심에 명시한 라운드 상한을 전달한다', async () => {
    let captured: (SelfImplementCliOpts & { supervise?: SingleRunSuperviseOptions }) | undefined;
    _setSelfImplementCliCommandForTesting(async (_feature, opts) => {
      captured = opts;
      return cliOutcome;
    });

    await selfImplementRuntime.run({ feature: '감독 런', supervise: true, supervise_rounds: 5 }, ctx);

    expect(captured!.supervise).toEqual({ rounds: 5 });
  });

  test('supervise=true에서 상한을 생략하면 빈 객체를 전달해 중앙 기본값을 보존한다', async () => {
    let captured: (SelfImplementCliOpts & { supervise?: SingleRunSuperviseOptions }) | undefined;
    _setSelfImplementCliCommandForTesting(async (_feature, opts) => {
      captured = opts;
      return cliOutcome;
    });

    await selfImplementRuntime.run({ feature: '기본 상한 감독 런', supervise: true }, ctx);

    expect(captured!.supervise).toEqual({});
  });

  test('스위치가 없거나 상한만 있으면 중앙 CLI 심에 supervise 옵션을 전달하지 않는다', async () => {
    const captured: Array<SelfImplementCliOpts & { supervise?: SingleRunSuperviseOptions }> = [];
    _setSelfImplementCliCommandForTesting(async (_feature, opts) => {
      captured.push(opts);
      return cliOutcome;
    });

    await selfImplementRuntime.run({ feature: '기본 오프 런' }, ctx);
    await selfImplementRuntime.run({ feature: '상한만 있는 런', supervise_rounds: 5 }, ctx);

    expect(captured).toHaveLength(2);
    expect(captured[0]).not.toHaveProperty('supervise');
    expect(captured[1]).not.toHaveProperty('supervise');
  });
});

describe('selfImplementRuntime — 중앙 CLI 경유', () => {
  test('자연어 단일 런은 중앙 심에 다섯 NL 인자와 승인 통로를 싣고 최종 seam까지 보존하며 결과 형식을 유지한다', async () => {
    _setAutoOpenPrConfigReaderForTesting(() => false);
    const approver = async () => true;
    setSelfImplementApprover(approver);
    let calls = 0;
    let actualRuntimeSpec: import('../self-dev/dev-pipeline.js').DevPipelineSpec | undefined;
    _setSelfImplementCliCommandForTesting(async (feature, opts, deps) => {
      calls += 1;
      expect(feature).toBe('중앙 심 자연어 런');
      expect(opts).toMatchObject({
        parentSessionId: 'session-1',
        goalFile: join(goalDirectory, 'goal.md'),
        naturalLanguageDispatch: true,
      });
      expect(opts).not.toHaveProperty('autoMerge');
      expect(opts).not.toHaveProperty('openPr');
      expect(opts).not.toHaveProperty('autoReview');
      // Capture the exact spec emitted by the runtime's real CLI caller rather than
      // rebuilding a second spec inside this callback.
      await runSelfImplementCliCommand(feature, opts, {
        ...deps,
        executeReroute: async (spec) => {
          actualRuntimeSpec = spec;
          return {
            result: { runId: 'run-captured', ok: true, stage: 'pr-declined', node: 'open-pr', outcome: 'completed' } as never,
            exitCode: 0,
          };
        },
      });
      expect(actualRuntimeSpec).toBeDefined();
      const resolved = planDevPipeline(actualRuntimeSpec!);
      // 새 필드 생략은 central CLI spec에 request 값을 주입하지 않고, 기존 shared resolver가
      // 자연어 구현 경로의 기본값을 결정하게 둔다.
      expect(actualRuntimeSpec).not.toHaveProperty('completion');
      expect(actualRuntimeSpec).not.toHaveProperty('completionSource');
      expect(actualRuntimeSpec).not.toHaveProperty('autoReview');
      expect(actualRuntimeSpec).not.toHaveProperty('autoReviewSource');
      expect(resolved).toMatchObject({
        completion: 'auto-merge',
        completionSource: 'default',
        autoReview: true,
        autoReviewSource: 'default',
      });
      // ⛔⭐ 이 경로는 approver 를 opts 로 «넘기지 않는다» — 승인 통로는 seams.approvePr 하나다.
      //   이 파일 머리말의 fail-closed 계약상 orchestrator 는 completion 과 «무관하게» approvePr
      //   유무로 PR 을 연다. 그래서 approver 를 따로 넘기면 중앙 라인이 seams 를 보강해
      //   ***승인 심이 없어야 할 자리에 승인 심이 생긴다***(「골 문서 저작 실패…」 회귀가 그것을 잡는다).
      expect((opts as { approver?: unknown }).approver).toBeUndefined();
      expect(opts.documentReferences).toEqual([
        { path: 'README.md', result: expect.objectContaining({ kind: 'ok' }) },
      ]);
      // ⭐ 승인 통로는 «seams 를 통해» 닿아야 한다 — 주입된 approver 가 seamsFactory 를 거쳐
      //   approvePr 로 실린 것을 «실제로 호출해» 확인한다(「인자를 넘겼다」가 아니라 「동작한다」).
      const pipelineDeps = deps.pipelineDeps!;
      expect(pipelineDeps.approver).toBeUndefined();
      const seams = await pipelineDeps.buildSelfImplementSeams!({} as never);
      expect(await seams.approvePr!({} as never)).toBe(true);
      return {
        ok: true,
        kind: 'self',
        exitCode: 0,
        result: { runId: 'run-central', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed', prUrl: 'https://example.test/pr/1', prNumber: 1, branch: 'feature/central', worktreePath: '/wt/central' },
      };
    });

    const result = await selfImplementRuntime.run({ feature: '중앙 심 자연어 런', documentReferences: ['README.md'] }, { ...ctx, sessionId: 'session-1' });

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      stage: 'pr-opened',
      node: 'open-pr',
      prUrl: 'https://example.test/pr/1',
      prNumber: 1,
      branch: 'feature/central',
      worktreePath: '/wt/central',
    });
    expect(result.output).toContain('✅ draft PR: https://example.test/pr/1 (#1)');
  });

  test('plan·open_pr·max_wait 요청을 중앙 CLI 심까지 전달한다', async () => {
    let captured: SelfImplementCliOpts | undefined;
    _setSelfImplementCliCommandForTesting(async (_feature, opts) => {
      captured = opts;
      return { ok: true, kind: 'observed', source: 'default', exitCode: 0 };
    });

    const result = await selfImplementRuntime.run({
      feature: 'CLI only knobs',
      plan: true,
      open_pr: true,
      max_wait: 77,
    }, ctx);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      output: '[self-implement] observed by central CLI',
    }));
    expect(captured).toEqual(expect.objectContaining({
      plan: true,
      openPr: true,
      maxWait: '77',
      naturalLanguageDispatch: true,
    }));
  });

  test('새 필드를 생략하면 기존 중앙 CLI 전달 모양과 shared resolver 기본값을 보존한다', async () => {
    let captured: SelfImplementCliOpts | undefined;
    let actualRuntimeSpec: import('../self-dev/dev-pipeline.js').DevPipelineSpec | undefined;
    _setSelfImplementCliCommandForTesting(async (feature, opts, deps) => {
      captured = opts;
      await runSelfImplementCliCommand(feature, opts, {
        ...deps,
        executeReroute: async (spec) => {
          actualRuntimeSpec = spec;
          return {
            result: { runId: 'run-default', ok: true, stage: 'pr-declined', node: 'open-pr', outcome: 'completed' } as never,
            exitCode: 0,
          };
        },
      });
      return { ok: true, kind: 'observed', source: 'default', exitCode: 0 };
    });

    await selfImplementRuntime.run({ feature: 'default behavior' }, ctx);

    expect(captured).toEqual(expect.objectContaining({
      draft: true,
      naturalLanguageDispatch: true,
    }));
    expect(captured).not.toHaveProperty('observeOnly');
    expect(captured).not.toHaveProperty('plan');
    expect(captured).not.toHaveProperty('openPr');
    expect(captured).not.toHaveProperty('maxWait');
    expect(captured).not.toHaveProperty('runId');
    expect(actualRuntimeSpec).toBeDefined();
    expect(actualRuntimeSpec).not.toHaveProperty('completion');
    expect(actualRuntimeSpec).not.toHaveProperty('completionSource');
    expect(actualRuntimeSpec).not.toHaveProperty('autoReview');
    expect(actualRuntimeSpec).not.toHaveProperty('autoReviewSource');
    expect(planDevPipeline(actualRuntimeSpec!)).toMatchObject({
      completion: 'auto-merge',
      completionSource: 'default',
      autoReview: true,
      autoReviewSource: 'default',
    });
  });
});

describe('selfImplementRuntime — 다중 골 중앙 CLI 경유', () => {
  test('다중 골은 중앙 심에 goals·concurrency·빈 runtime을 싣고 중앙 결과 형식을 보존한다', async () => {
    let centralInput: unknown;
    _setSelfImplementOrchestrateCliCommandForTesting(async (input) => {
      centralInput = input;
      return {
        ok: true,
        exitCode: 0,
        results: [{ status: 'done', merged: false, summary: 'central output' } as never],
      };
    });

    const deliverable = {
      document: ['# 골', '', '## 산출물을 어떻게 켜나', '', '- Entrypoint: apps/demo/server.ts', '- Port: 31415', ''].join('\n'),
      attribution: 'last' as const,
    };
    const result = await selfImplementRuntime.run({ goals: ['첫 골', '둘째 골'], concurrency: 3, deliverable }, ctx);

    expect(centralInput).toEqual({
      goals: [{ feature: '첫 골', autoMerge: false }, { feature: '둘째 골', autoMerge: false }],
      concurrency: 3,
      deliverable: { ...deliverable, goalPath: join(goalDirectory, 'goal.md') },
      runtime: {},
    });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(result.output).toBe('[self-implement] parallel 1 goal · done 1');
  });

  test('다중 골의 감독과 라운드 상한을 중앙 실행기까지 전달하고 수신·전달 관측을 남긴다', async () => {
    let centralInput: OrchestrateCliInput | undefined;
    const invokeEvents: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (_category === 'self-implement' && event === 'runtime.invoke') invokeEvents.push(data ?? {});
    }) as never);
    _setSelfImplementOrchestrateCliCommandForTesting(async input => {
      centralInput = input;
      return { ok: true, exitCode: 0, results: [{ status: 'done', merged: false } as never] };
    });

    try {
      await expect(selfImplementRuntime.run({
        goals: ['첫 골', '둘째 골'],
        supervise: true,
        supervise_rounds: 4,
      }, ctx)).resolves.toEqual(expect.objectContaining({ ok: true }));
    } finally {
      log.mockRestore();
    }

    expect(centralInput).toEqual(expect.objectContaining({
      goals: [{ feature: '첫 골', autoMerge: false }, { feature: '둘째 골', autoMerge: false }],
      supervise: { rounds: 4 },
      runtime: {},
    }));
    expect(invokeEvents).toContainEqual(expect.objectContaining({
      goals: 2,
      receivedSupervise: true,
      receivedSuperviseRounds: 4,
      forwardedSupervise: true,
      forwardedSuperviseRounds: 4,
    }));
  });

  test('다중 골에서 감독이 꺼졌거나 상한만 있으면 중앙 실행기에 감독을 전달하지 않는다', async () => {
    const centralInputs: OrchestrateCliInput[] = [];
    _setSelfImplementOrchestrateCliCommandForTesting(async input => {
      centralInputs.push(input);
      return { ok: true, exitCode: 0, results: [{ status: 'done', merged: false } as never] };
    });

    await selfImplementRuntime.run({ goals: ['감독 비활성'], supervise: false, supervise_rounds: 4 }, ctx);
    await selfImplementRuntime.run({ goals: ['상한만 제공'], supervise_rounds: 4 }, ctx);

    expect(centralInputs).toHaveLength(2);
    expect(centralInputs[0]).not.toHaveProperty('supervise');
    expect(centralInputs[1]).not.toHaveProperty('supervise');
  });

  test.each([
    ['base', { base: 'main' }, '`base` is only supported with `feature`'],
    ['draft', { draft: false }, '`draft` is only supported with `feature`'],
    ['ground', { ground: true }, '`ground` is only supported with `feature`'],
    ['documentReferences', { documentReferences: ['README.md'] }, '`documentReferences` is only supported with `feature`'],
  ] as const)('다중 골의 단일 요청 전용 %s는 이름과 이유를 밝히고 중앙 실행 전에 거부한다', async (_field, incompatible, message) => {
    let centralCalls = 0;
    _setSelfImplementOrchestrateCliCommandForTesting(async () => {
      centralCalls += 1;
      return { ok: true, exitCode: 0, results: [] };
    });

    await expect(selfImplementRuntime.run({ goals: ['병렬 골'], ...incompatible }, ctx)).rejects.toThrow(message);
    expect(centralCalls).toBe(0);
  });

  test('분해된 유일 원문의 기동 선언을 기본 중앙 CLI가 소비해 wired를 기록한다', async () => {
    const originalRequest = ['원문 요청', '## 산출물을 어떻게 켜나', '- Entrypoint: apps/demo/server.ts', '- Port: 31415'].join('\n');
    const wiringEvents: { event: string; data: Record<string, unknown> }[] = [];
    const deliveredRuntimes: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (_category === 'self-dev.deliverable-wiring') wiringEvents.push({ event, data: data ?? {} });
    }) as never);
    _setSelfImplementDecomposeForTesting(async () => ({
      goals: [{ id: 'part', feature: '분해된 골' }],
      decomposition: { recommendedMaxTasks: 1, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
    }));
    _setSelfImplementOrchestrateCliCommandForTesting((input) => runSelfOrchestrateCliCommand(input, {
      executeReroute: async (_spec, runtime) => {
        deliveredRuntimes.push(runtime);
        return { results: [{ status: 'done', merged: false } as never], exitCode: 0 };
      },
    }));

    try {
      const result = await selfImplementRuntime.run({
        goals: [originalRequest],
        decompose: true,
        deliverable: { document: originalRequest, attribution: 'all' },
      }, ctx);
      expect(result.ok).toBe(true);
    } finally {
      log.mockRestore();
    }

    expect(deliveredRuntimes).toEqual([expect.objectContaining({
      deliverableTargets: [{ taskId: 'part', target: 'http://127.0.0.1:31415/' }],
    })]);
    expect(wiringEvents).toContainEqual({ event: 'wired', data: expect.objectContaining({ port: 31415, attribution: 'all', targetCount: 1 }) });
  });

  test('명시 deliverable은 기본 중앙 CLI에서 분해 원문 fallback보다 우선한다', async () => {
    const originalRequest = ['원문 선언', '## 산출물을 어떻게 켜나', '- Entrypoint: apps/original.ts', '- Port: 31415'].join('\n');
    const explicitDeliverable = {
      document: ['명시 선언', '## 산출물을 어떻게 켜나', '- Entrypoint: apps/explicit.ts', '- Port: 4173'].join('\n'),
      attribution: 'last' as const,
      goalPath: '/repo/goals/explicit.md',
    };
    const deliveredRuntimes: Record<string, unknown>[] = [];
    _setSelfImplementDecomposeForTesting(async () => ({
      goals: [{ id: 'part', feature: '분해된 골' }],
      decomposition: { recommendedMaxTasks: 1, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
    }));
    _setSelfImplementOrchestrateCliCommandForTesting((input) => runSelfOrchestrateCliCommand(input, {
      executeReroute: async (_spec, runtime) => {
        deliveredRuntimes.push(runtime);
        return { results: [{ status: 'done', merged: false } as never], exitCode: 0 };
      },
    }));

    await selfImplementRuntime.run({ goals: [originalRequest], decompose: true, deliverable: explicitDeliverable }, ctx);

    expect(deliveredRuntimes).toEqual([expect.objectContaining({
      deliverableTargets: [{ taskId: 'part', target: 'http://127.0.0.1:4173/' }],
    })]);
  });

  test('선언 없는 분해 원문은 기본 중앙 CLI가 이름 있는 skipped 사유를 남기며 실행을 유지한다', async () => {
    const wiringEvents: { event: string; data: Record<string, unknown> }[] = [];
    const deliveredRuntimes: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (_category === 'self-dev.deliverable-wiring') wiringEvents.push({ event, data: data ?? {} });
    }) as never);
    _setSelfImplementDecomposeForTesting(async () => ({
      goals: [{ id: 'part', feature: '분해된 골' }],
      decomposition: { recommendedMaxTasks: 1, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
    }));
    _setSelfImplementOrchestrateCliCommandForTesting((input) => runSelfOrchestrateCliCommand(input, {
      executeReroute: async (_spec, runtime) => {
        deliveredRuntimes.push(runtime);
        return { results: [{ status: 'done', merged: false } as never], exitCode: 0 };
      },
    }));

    try {
      const result = await selfImplementRuntime.run({ goals: ['선언 없는 원문'], decompose: true }, ctx);
      expect(result.ok).toBe(true);
    } finally {
      log.mockRestore();
    }

    expect(deliveredRuntimes).toEqual([expect.not.objectContaining({ deliverableTargets: expect.anything() })]);
    expect(wiringEvents).toContainEqual({ event: 'skipped', data: expect.objectContaining({ reason: 'no-launch-declaration', goalIdCount: 1 }) });
  });

  test('분해 골도 중앙 심에 전달하고 중앙 실패 결과를 기존 실패 응답으로 보존한다', async () => {
    _setSelfImplementDecomposeForTesting(async () => ({
      goals: [{ id: 'part', feature: '분해된 골' }],
      decomposition: { recommendedMaxTasks: 1, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
    }));
    let centralInput: unknown;
    _setSelfImplementOrchestrateCliCommandForTesting(async (input) => {
      centralInput = input;
      return { ok: false, exitCode: 1, message: 'central stop reason' };
    });

    await expect(selfImplementRuntime.run({ goals: ['복합 골'], decompose: true }, ctx)).rejects.toThrow('central stop reason');
    expect(centralInput).toEqual({
      goals: [{ id: 'part', feature: '분해된 골', autoMerge: false }],
      parentRequest: '복합 골',
      deliverable: { document: '복합 골', attribution: 'all' },
      runtime: {},
    });
  });

  // ⛔⭐⭐ 리뷰(#10375)가 「두 원문 골로 parentRequest 를 단언하라」를 must-fix 로 냈는데,
  //   ***이 경로에서는 원리상 불가***하다 — `decompose=true` 는 골을 「정확히 하나」로 강제한다.
  //   ⇒ 그래서 그 회귀 «대신» ***그 계약 자체를 문다***. 가드가 사라지면 이 테스트가 깨져서 알려준다.
  //   📍 참고 구현(self-orchestrate-runtime.ts)에는 이 가드가 «없다» — 두 경로의 계약이 다르다.
  test('decompose 는 원문 골이 «여럿»이면 거부한다 (그래서 parentRequest 계보 유실이 원리상 없다)', async () => {
    _setSelfImplementDecomposeForTesting(async () => ({
      goals: [{ id: 'part', feature: '분해된 골' }],
      decomposition: { recommendedMaxTasks: 1, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
    }));
    let centralCalled = false;
    _setSelfImplementOrchestrateCliCommandForTesting(async () => {
      centralCalled = true;
      return { ok: true, exitCode: 0, results: [] };
    });

    await expect(selfImplementRuntime.run({ goals: ['첫 원문 골', '둘째 원문 골'], decompose: true }, ctx))
      .rejects.toThrow('requires exactly one composite goal');
    // ⛔ 거부는 «중앙 심에 닿기 전»이어야 한다 — 닿은 뒤 거부하면 절반 실행된다.
    expect(centralCalled).toBe(false);
  });
});

describe('selfImplementRuntime — 자연어 dispatch 출처', () => {
  test('자연어 런은 골 문서 경로와 natural-language-dispatch 출처를 함께 원장에 기록한다', async () => {
    const starts: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'start') starts.push(data ?? {});
    }) as never);
    _setSelfImplementGoalAuthorForTesting(async (ask, cwd, deps) => {
      expect(ask).toBe('골 문서가 필요한 자연어 런');
      expect(cwd).toBe(process.cwd());
      expect(deps).toBeUndefined();
      return { path: join(goalDirectory, 'goal.md') };
    });
    _setSelfImplementSeamsFactoryForTesting(() => ({
      async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
      async implement() { return { ok: true, summary: 'implemented' }; },
      async gate() { return { passed: true }; },
      async openPr() { return { url: 'https://example.test/pr/1', number: 1 }; },
    }));
    try {
      await selfImplementRuntime.run({ feature: '골 문서가 필요한 자연어 런' }, ctx);
    } finally {
      log.mockRestore();
    }
    expect(starts).toContainEqual(expect.objectContaining({
      goalFile: join(goalDirectory, 'goal.md'),
      goalSource: 'natural-language-dispatch',
    }));
  });

  test('자연어 런은 ask에서 뽑은 제목만 goalTitle로 넘기고 관측한다', async () => {
    const ask = ['대상 경로: src/a.ts', '제목: 무언가를 고친다', '', '본문'].join('\n');
    let received: { goalTitle?: string } | undefined;
    const authored: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'runtime.goal-authored') authored.push(data ?? {});
    }) as never);
    _setSelfImplementGoalAuthorForTesting(async (feature, _cwd, deps) => {
      expect(feature).toBe(ask);
      received = deps;
      return { path: join(goalDirectory, 'goal.md') };
    });
    _setSelfImplementSeamsFactoryForTesting(() => ({
      async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
      async implement() { return { ok: true, summary: 'implemented' }; },
      async gate() { return { passed: true }; },
      async openPr() { return { url: 'https://example.test/pr/1', number: 1 }; },
    }));
    try {
      await selfImplementRuntime.run({ feature: ask }, ctx);
    } finally {
      log.mockRestore();
    }
    expect(received).toEqual({ goalTitle: '무언가를 고친다' });
    expect(authored).toContainEqual(expect.objectContaining({
      goalFile: join(goalDirectory, 'goal.md'),
      authored: true,
      goalTitlePassed: true,
    }));
  });

  test('자연어 런은 제목 줄이 없으면 goalTitle을 생략하고 관측값이 다르다', async () => {
    const ask = ['대상 경로: src/a.ts', '', '본문'].join('\n');
    let received: { goalTitle?: string } | undefined = { goalTitle: 'sentinel' };
    const authored: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'runtime.goal-authored') authored.push(data ?? {});
    }) as never);
    _setSelfImplementGoalAuthorForTesting(async (_feature, _cwd, deps) => {
      received = deps;
      return { path: join(goalDirectory, 'goal.md') };
    });
    _setSelfImplementSeamsFactoryForTesting(() => ({
      async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
      async implement() { return { ok: true, summary: 'implemented' }; },
      async gate() { return { passed: true }; },
      async openPr() { return { url: 'https://example.test/pr/1', number: 1 }; },
    }));
    try {
      await selfImplementRuntime.run({ feature: ask }, ctx);
    } finally {
      log.mockRestore();
    }
    expect(received).toBeUndefined();
    expect(authored).toContainEqual(expect.objectContaining({
      goalFile: join(goalDirectory, 'goal.md'),
      authored: true,
      goalTitlePassed: false,
    }));
  });

  test('저작기가 goalTitle을 거부해도 예외가 밖으로 새지 않고 폴백한다', async () => {
    const ask = ['대상 경로: src/a.ts', '제목: 무언가를 고친다', '', '본문'].join('\n');
    const logs: { event: string; data: Record<string, unknown> }[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      logs.push({ event, data: data ?? {} });
    }) as never);
    _setSelfImplementGoalAuthorForTesting(async (_feature, _cwd, deps) => {
      if (deps?.goalTitle !== undefined) throw new Error('goalTitle must contain non-whitespace text');
      return { path: join(goalDirectory, 'goal.md') };
    });
    _setSelfImplementSeamsFactoryForTesting(() => ({
      async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
      async implement() { return { ok: true, summary: 'implemented' }; },
      async gate() { return { passed: true }; },
      async openPr() { return { url: 'https://example.test/pr/1', number: 1 }; },
    }));
    try {
      const result = await selfImplementRuntime.run({ feature: ask }, ctx);
      expect(result.stage).toBe('pr-declined');
      expect(result.output).toContain('⚠️ 골 문서 저작 실패(실행은 계속됨): goalTitle must contain non-whitespace text');
    } finally {
      log.mockRestore();
    }
    expect(logs).toContainEqual({
      event: 'runtime.goal-author-failed',
      data: { error: 'goalTitle must contain non-whitespace text', goalTitlePassed: true },
    });
  });

  // ⭐⭐ 리뷰 should-fix(#10350) — 위 「중앙 심 경유」 테스트는 중앙 심을 «mock» 하므로
  //   실제 runSelfImplementCliCommand 가 pipelineDeps.buildSelfImplementSeams 와 openPr 을
  //   ***정말로 소비하는지***는 못 본다. 그래서 mock «없이» 그 fail-closed 연결을 한 쌍으로 고정한다.
  //   ⛔ 이 쌍이 깨지면 「승인 심이 없는데 PR 이 열린다」가 다시 통과한다(#10348 이 그랬다).
  test('mock 없이 — 승인 심이 없으면 seams.openPr 이 «불리지 않는다»', async () => {
    let openPrCalls = 0;
    _setSelfImplementGoalAuthorForTesting(async () => ({ path: join(goalDirectory, 'goal.md') }));
    _setAutoOpenPrConfigReaderForTesting(() => false);
    setSelfImplementApprover(null);                 // ⇒ approvePr 없음 ⇒ seams 에 승인 심이 안 생긴다
    _setSelfImplementSeamsFactoryForTesting(() => ({
      async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
      async implement() { return { ok: true, summary: 'implemented' }; },
      async gate() { return { passed: true }; },
      async openPr() { openPrCalls += 1; return { url: 'https://example.test/pr/1', number: 1 }; },
    }));
    const result = await selfImplementRuntime.run({ feature: '승인 없음' }, ctx);
    expect(openPrCalls).toBe(0);
    expect(result.stage).not.toBe('pr-opened');
  });

  // ⭐⭐⭐ #10348 이 «정확히» 깨진 상황 — approver 는 «주입돼 있는데» seamsFactory 가 그것을
  //   무시해 seams 에 승인 심이 «없는» 경우. 초판은 approver 를 opts/pipelineDeps 로 따로 넘겨
  //   중앙 라인이 seams 를 보강하게 만들었고, 그래서 ***승인 심 없이 PR 이 열렸다***.
  //   ⛔ 이 테스트가 그 중복 경로를 «문다» — approver 를 따로 넘기면 여기서 깨진다.
  test('mock 없이 — approver 가 있어도 seams 가 승인 심을 안 가지면 openPr 이 «불리지 않는다»', async () => {
    let openPrCalls = 0;
    _setSelfImplementGoalAuthorForTesting(async () => ({ path: join(goalDirectory, 'goal.md') }));
    _setAutoOpenPrConfigReaderForTesting(() => false);
    setSelfImplementApprover(async () => true);     // 주입은 «있다»
    _setSelfImplementSeamsFactoryForTesting(() => ({ // 그러나 factory 가 그것을 «무시»한다
      async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
      async implement() { return { ok: true, summary: 'implemented' }; },
      async gate() { return { passed: true }; },
      async openPr() { openPrCalls += 1; return { url: 'https://example.test/pr/1', number: 1 }; },
    }));
    const result = await selfImplementRuntime.run({ feature: 'approver 있으나 seams 없음' }, ctx);
    expect(openPrCalls).toBe(0);
    expect(result.stage).not.toBe('pr-opened');
  });

  test('mock 없이 — 승인 심이 있으면 seams.openPr 이 «불린다»', async () => {
    let openPrCalls = 0;
    _setSelfImplementGoalAuthorForTesting(async () => ({ path: join(goalDirectory, 'goal.md') }));
    _setAutoOpenPrConfigReaderForTesting(() => false);
    setSelfImplementApprover(async () => true);     // ⇒ seamsFactory 인자로 approvePr 가 들어간다
    _setSelfImplementSeamsFactoryForTesting((o) => ({
      async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
      async implement() { return { ok: true, summary: 'implemented' }; },
      async gate() { return { passed: true }; },
      async openPr() { openPrCalls += 1; return { url: 'https://example.test/pr/1', number: 1 }; },
      ...(o.approvePr ? { approvePr: o.approvePr } : {}),
    }));
    const result = await selfImplementRuntime.run({ feature: '승인 있음' }, ctx);
    expect(openPrCalls).toBe(1);
    expect(result.stage).toBe('pr-opened');
  });

  test('골 문서 저작 실패는 실행을 막지 않고 관측 가능한 실패를 남긴다', async () => {
    const logs: { event: string; data: Record<string, unknown> }[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      logs.push({ event, data: data ?? {} });
    }) as never);
    _setSelfImplementGoalAuthorForTesting(async () => { throw new Error('goal author unavailable'); });
    _setSelfImplementSeamsFactoryForTesting(() => ({
      async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
      async implement() { return { ok: true, summary: 'implemented' }; },
      async gate() { return { passed: true }; },
      async openPr() { return { url: 'https://example.test/pr/1', number: 1 }; },
    }));
    try {
      const result = await selfImplementRuntime.run({ feature: '저작 실패도 진행' }, ctx);
      expect(result.stage).toBe('pr-declined');
      expect(result.output).toContain('⚠️ 골 문서 저작 실패(실행은 계속됨): goal author unavailable');
    } finally {
      log.mockRestore();
    }
    expect(logs).toContainEqual({ event: 'runtime.goal-author-failed', data: { error: 'goal author unavailable', goalTitlePassed: false } });
    expect(logs).toContainEqual(expect.objectContaining({
      event: 'start',
      data: expect.objectContaining({ goalSource: 'natural-language-dispatch', goalFile: null }),
    }));
  });

  test('CLI/daemon 어댑터는 기존 골 문서 전달과 자연어 출처를 보존한다', async () => {
    let received: import('./orchestrator.js').SelfImplementOptions | undefined;
    await dispatchSelfImplement(
      { feature: 'CLI authoring regression' },
      { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus', userText: 'CLI authoring regression' } as never,
      async (options) => {
        received = options;
        return { runId: 'run-cli', ok: true, stage: 'pr-declined', node: 'open-pr', outcome: 'completed' };
      },
      async () => ({ path: '/goals/cli.md' }),
    );
    expect(received).toEqual(expect.objectContaining({
      goalFile: '/goals/cli.md',
      naturalLanguageDispatch: true,
    }));
  });

  test('TUI/dashboard 자연어 런을 natural-language-dispatch로 기록한다', async () => {
    const starts: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'start') starts.push(data ?? {});
    }) as never);
    _setSelfImplementSeamsFactoryForTesting(() => ({
      async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
      async implement() { return { ok: true, summary: 'implemented' }; },
      async gate() { return { passed: true }; },
      async openPr() { return { url: 'https://example.test/pr/1', number: 1 }; },
    }));
    try {
      await selfImplementRuntime.run({ feature: 'TUI 자연어 출처' }, ctx);
    } finally {
      log.mockRestore();
    }
    expect(starts).toContainEqual(expect.objectContaining({ goalSource: 'natural-language-dispatch' }));
  });
});

describe('selfImplementRuntime — 문서 참조', () => {
  function installSuccessfulSeams(onImplement: (feature: string, input: { documentReferences?: readonly DocumentReferenceStatus[] }) => void): void {
    _setSelfImplementSeamsFactoryForTesting(() => ({
      async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
      async implement(input) { onImplement(input.feature, input); return { ok: true, summary: 'implemented' }; },
      async gate() { return { passed: true }; },
      async openPr() { return { url: 'https://example.test/pr/1', number: 1 }; },
      async approvePr() { return true; },
    }));
  }

  test('문서 지목이 없는 요청은 기존 feature를 그대로 실행 옵션에 전달한다', async () => {
    const feature = '평범한 구현 요청';
    const starts: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'start') starts.push(data ?? {});
    }) as never);
    installSuccessfulSeams(() => {});
    try {
      await selfImplementRuntime.run({ feature }, ctx);
    } finally {
      log.mockRestore();
    }
    expect(starts.some(start => start.feature === feature)).toBe(true);
  });

  test('저장소 안 문서 참조는 해석 결과 그대로 실행 경로에 전달한다', async () => {
    let received: { documentReferences?: readonly DocumentReferenceStatus[] } | undefined;
    installSuccessfulSeams((_feature, input) => { received = input; });

    await selfImplementRuntime.run({ feature: 'README.md를 참고해 구현해줘' }, ctx);

    expect(received?.documentReferences).toEqual([
      { path: 'README.md', result: expect.objectContaining({ kind: 'ok' }) },
    ]);
  });

  test.each([
    ['README.md를 참고해 구현해줘', '📄 참조 문서: README.md'],
    ['design/spec.md를 참고해 구현해줘', '⚠️ 참조 문서 design/spec.md: missing'],
  ])('자연어 %s에서 저장소 상대 문서를 자동 감지하고 원문 feature를 보존한다', async (feature, statusLine) => {
    const starts: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'start') starts.push(data ?? {});
    }) as never);
    installSuccessfulSeams(() => {});
    try {
      const result = await selfImplementRuntime.run({ feature }, ctx);
      expect(result.output).toContain(statusLine);
    } finally {
      log.mockRestore();
    }
    expect(starts).toContainEqual(expect.objectContaining({ feature }));
  });

  test('명시 documentReferences의 복수 문서와 미발견 문서를 비차단으로 구분해 보여 준다', async () => {
    installSuccessfulSeams(() => {});
    const result = await selfImplementRuntime.run({
      feature: '문서 참조 구현',
      documentReferences: ['README.md', 'docs/does-not-exist.md'],
    }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('📄 참조 문서: README.md');
    expect(result.output).toContain('⚠️ 참조 문서 docs/does-not-exist.md: missing');
  });

  test('자연어의 없는 경로와 상대·절대 저장소 밖 경로는 실행을 막지 않고 상태만 남긴다', async () => {
    const feature = 'missing/plan.md와 ../outside.md 및 /tmp/spec.md를 참고해 구현';
    const starts: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'start') starts.push(data ?? {});
    }) as never);
    installSuccessfulSeams(() => {});
    let result;
    try {
      result = await selfImplementRuntime.run({ feature }, ctx);
    } finally {
      log.mockRestore();
    }
    expect(starts.some(start => start.feature === feature)).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('⚠️ 참조 문서 missing/plan.md: missing');
    expect(result.output).toContain('⚠️ 참조 문서 ../outside.md: outside-repository');
    expect(result.output).toContain('⚠️ 참조 문서 /tmp/spec.md: outside-repository');
    expect(result.output).not.toContain('⚠️ 참조 문서 tmp/spec.md: missing');
  });

  test('저장소 밖 문서 참조는 실행 경로에 전달하지 않는다', async () => {
    let received: { documentReferences?: readonly DocumentReferenceStatus[] } | undefined;
    installSuccessfulSeams((_feature, input) => { received = input; });

    await selfImplementRuntime.run({ feature: '../outside.md를 참고해 구현' }, ctx);

    expect(received).not.toHaveProperty('documentReferences');
  });

  test('비문자열 런타임 입력은 실행 전에 거부한다', async () => {
    installSuccessfulSeams(() => { throw new Error('implementation must not start'); });
    await expect(selfImplementRuntime.run({ feature: 1 } as never, ctx)).rejects.toThrow('`feature` must be a string');
    await expect(selfImplementRuntime.run({ feature: 'valid', base: false } as never, ctx)).rejects.toThrow('`base` must be a string');
    await expect(selfImplementRuntime.run({ feature: 'valid', draft: 'false' } as never, ctx)).rejects.toThrow('`draft` must be a boolean');
    await expect(selfImplementRuntime.run({ feature: 'valid', ground: 'true' } as never, ctx)).rejects.toThrow('`ground` must be a boolean');
    await expect(selfImplementRuntime.run({ feature: 'valid', documentReferences: ['README.md', 1] } as never, ctx)).rejects.toThrow('`documentReferences` must be an array of strings');
  });

  test('관측 전용도 해석 성공과 미발견 상태를 보이고 실행하지 않는다', async () => {
    _setObserveOnlyConfigReaderForTesting(() => true);
    const result = await selfImplementRuntime.run({
      feature: 'README.md와 missing/plan.md를 참고해줘',
    }, ctx);
    expect(result.observed).toBe(true);
    expect(result.stage).toBeUndefined();
    expect(result.output).toContain('📄 참조 문서: README.md');
    expect(result.output).toContain('⚠️ 참조 문서 missing/plan.md: missing');
  });
});

describe('관측 전용 판정의 출처는 하나다', () => {
  // ⭐ 이 검사가 이 수리의 핵심이다 — 두 경로가 **각자** config 를 읽으면 언젠가 갈리고,
  //   갈린 그 순간이 «스위치를 켰는데 런이 돌았다» 다(2026-08-02 실측).
  test('observe-only.ts 의 seam 하나가 TUI 경로와 daemon 경로를 **함께** 바꾼다', async () => {
    _setObserveOnlyConfigReaderForTesting(() => true);
    expect(isObserveOnly()).toBe(true);

    const viaRuntime = await selfImplementRuntime.run({ feature: '한 출처 검사' }, ctx);
    expect(viaRuntime.observed).toBe(true);

    let daemonRunnerCalls = 0;
    const viaDaemon = await dispatchSelfImplement(
      { feature: '한 출처 검사' },
      { cwd: '/tmp', signal: new AbortController().signal, entry: 'elanous-apparatus' } as never,
      async () => { daemonRunnerCalls += 1; throw new Error('runner must not start'); },
    );
    expect(viaDaemon).toEqual({ observed: true });
    expect(daemonRunnerCalls).toBe(0);
  });
});

describe('selfImplementRuntime — foreground ESC stop target', () => {
  test('TUI call receives its created space; other surfaces and missing call ids do not register targets', async () => {
    const seen: Array<[string, string]> = [];
    const optionsSeen: DefaultSeamsOptions[] = [];
    setSelfImplementSoftStopSpaceObserver((id, space) => seen.push([id, space]));
    _setAutoOpenPrConfigReaderForTesting(() => false);
    _setSelfImplementSeamsFactoryForTesting((options) => {
      optionsSeen.push(options);
      return {
        async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
        async implement() { return { ok: true, summary: 'implemented' }; },
        async gate() { return { passed: true }; },
        async openPr() { return { url: 'https://example.test/pr/1', number: 1 }; },
        ...(options.onSoftStopSpaceReady ? { onSoftStopSpaceReady: options.onSoftStopSpaceReady } : {}),
      };
    });
    await selfImplementRuntime.run({ feature: 'foreground stop' }, { ...ctx, surface: 'tui', toolCallId: 'call-stop' });
    expect(optionsSeen[0]?.onSoftStopSpaceReady).toBeDefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe('call-stop');
    expect(seen[0]![1]).toBeTruthy();
    await selfImplementRuntime.run({ feature: 'another surface' }, { ...ctx, surface: 'chat', toolCallId: 'call-other' });
    await selfImplementRuntime.run({ feature: 'no call id' }, { ...ctx, surface: 'tui', toolCallId: undefined });
    expect(seen).toHaveLength(1);
    expect(optionsSeen.slice(1).every(options => options.onSoftStopSpaceReady === undefined)).toBe(true);
  });
});

describe('selfImplementRuntime — harness progress wiring', () => {
  function installProgressSeams(onFactory?: (options: DefaultSeamsOptions) => void): void {
    _setAutoOpenPrConfigReaderForTesting(() => false);
    setSelfImplementApprover(null);
    _setSelfImplementSeamsFactoryForTesting((options) => {
      onFactory?.(options);
      return {
        async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
        async implement() { return { ok: true, summary: 'implemented' }; },
        async gate() { return { passed: true }; },
        async openPr() { return { url: 'https://example.test/pr/1', number: 1 }; },
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.approvePr ? { approvePr: options.approvePr } : {}),
      };
    });
  }

  test('호출자 싱크가 없으면 onProgress 를 주입하지 않아 delivered 는 실제 소비만 센다', async () => {
    let factoryOptions: DefaultSeamsOptions | undefined;
    const deliveries: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'progress-delivery') deliveries.push(data ?? {});
    }) as never);
    installProgressSeams((options) => { factoryOptions = options; });
    try {
      const result = await selfImplementRuntime.run({ feature: '진행 싱크 없음' }, ctx);
      expect(result.stage).toBeDefined();
    } finally {
      log.mockRestore();
    }
    expect(factoryOptions?.onProgress).toBeUndefined();
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries[0]).toEqual(expect.objectContaining({ delivered: 0, callbackFailed: 0 }));
    expect(deliveries[0]!.unwired as number).toBeGreaterThan(0);
  });

  test('호출자 싱크가 있으면 받은 이벤트 수와 progress-delivery.delivered 가 어긋나지 않는다', async () => {
    const received: FeedbackEnvelope[] = [];
    const deliveries: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'progress-delivery') deliveries.push(data ?? {});
    }) as never);
    installProgressSeams();
    const wiredCtx = {
      ...ctx,
      toolCallId: 'call-progress',
      emitFeedback: (env: FeedbackEnvelope) => { received.push(env); },
    } as ToolRuntimeContext;
    try {
      await selfImplementRuntime.run({ feature: '진행 싱크 있음' }, wiredCtx);
    } finally {
      log.mockRestore();
    }
    expect(received.length).toBeGreaterThan(0);
    expect(received.every(env => env.kind === 'tool.progress')).toBe(true);
    expect(deliveries[0]).toEqual(expect.objectContaining({ unwired: 0, callbackFailed: 0 }));
    expect(deliveries[0]!.delivered).toBe(received.length);
  });

  test('호출자 싱크가 예외를 던져도 런은 죽지 않고 callbackFailed 만 오른다', async () => {
    const deliveries: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'progress-delivery') deliveries.push(data ?? {});
    }) as never);
    installProgressSeams();
    const throwingCtx = {
      ...ctx,
      emitFeedback: () => { throw new Error('progress sink unavailable'); },
    } as ToolRuntimeContext;
    try {
      const result = await selfImplementRuntime.run({ feature: '진행 싱크 예외' }, throwingCtx);
      expect(result.stage).toBeDefined();
      expect(result.stage).not.toBe('aborted');
    } finally {
      log.mockRestore();
    }
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries[0]).toEqual(expect.objectContaining({ delivered: 0, unwired: 0 }));
    expect(deliveries[0]!.callbackFailed as number).toBeGreaterThan(0);
  });

  test('이 골이 더한 onProgress 배선을 지우면 위 검사가 그 결손을 잡는다', () => {
    const source = readFileSync(new URL('./self-implement-runtime.ts', import.meta.url), 'utf8');
    expect(source).toContain('onProgress: resolveHarnessProgressSink(ctx)');
    expect(source).toMatch(/seamsFactory\(\{[\s\S]*onProgress: resolveHarnessProgressSink\(ctx\),/);
  });
});

describe('selfImplementRuntime — opt-in non-blocking return', () => {
  async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for harness seam');
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }

  function installGatedCli(): {
    started: () => boolean;
    completed: () => boolean;
    release: () => void;
    receivedRunId: () => string | undefined;
  } {
    let started = false;
    let completed = false;
    let receivedRunId: string | undefined;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    _setSelfImplementCliCommandForTesting(async (_feature, opts) => {
      receivedRunId = opts.runId;
      started = true;
      await gate;
      completed = true;
      return {
        ok: true,
        kind: 'self',
        exitCode: 0,
        result: {
          runId: opts.runId ?? 'run-unidentified',
          ok: true,
          stage: 'pr-declined',
          node: 'open-pr',
          outcome: 'completed',
        },
      };
    });
    return {
      started: () => started,
      completed: () => completed,
      release: () => release(),
      receivedRunId: () => receivedRunId,
    };
  }

  test('스위치를 주지 않으면 하니스가 끝난 뒤에 값이 돌아온다', async () => {
    const harness = installGatedCli();
    const pending = selfImplementRuntime.run({ feature: '블로킹 기본' }, ctx);
    let resolved = false;
    void pending.then(() => { resolved = true; });
    await waitUntil(harness.started);
    expect(harness.completed()).toBe(false);
    expect(resolved).toBe(false);
    expect(harness.receivedRunId()).toBeUndefined();
    harness.release();
    const result = await pending;
    expect(harness.completed()).toBe(true);
    expect(resolved).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.stage).toBe('pr-declined');
    expect(result.runId).toBeUndefined();
    expect(result.invocationMode).toBeUndefined();
    expect(harness.receivedRunId()).toBeUndefined();
  });

  test('스위치를 켜면 하니스가 도는 중에 runId가 든 값이 돌아온다', async () => {
    const harness = installGatedCli();
    try {
      const result = await selfImplementRuntime.run({ feature: '즉시 반환', non_blocking: true }, ctx);
      expect(harness.completed()).toBe(false);
      expect(result.ok).toBe(true);
      expect(result.invocationMode).toBe('non-blocking');
      expect(result.runId).toEqual(expect.stringMatching(/^run-/));
      expect(result.output).toContain(result.runId!);
      await waitUntil(harness.started);
      expect(harness.completed()).toBe(false);
      expect(harness.receivedRunId()).toBe(result.runId);
    } finally {
      harness.release();
      await waitUntil(harness.completed);
    }
  });

  test('스위치를 켜고 호출자가 먼저 끝나도 주입한 하니스는 완료까지 간다', async () => {
    const harness = installGatedCli();
    const result = await selfImplementRuntime.run({ feature: '백그라운드 완주', non_blocking: true }, ctx);
    expect(harness.completed()).toBe(false);
    expect(result.runId).toBeDefined();
    await waitUntil(harness.started);
    expect(harness.receivedRunId()).toBe(result.runId);
    harness.release();
    await waitUntil(harness.completed);
    expect(harness.completed()).toBe(true);
    expect(harness.receivedRunId()).toBe(result.runId);
  });

  test('호출 방식은 runtime.invocation-mode 관측에 blocking/non-blocking 값으로 구별된다', async () => {
    const modes: Record<string, unknown>[] = [];
    const received: Array<string | undefined> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'runtime.invocation-mode') modes.push(data ?? {});
    }) as never);
    _setSelfImplementCliCommandForTesting(async (_feature, opts) => {
      received.push(opts.runId);
      return {
        ok: true,
        kind: 'observed',
        source: 'default',
        exitCode: 0,
      };
    });
    try {
      await selfImplementRuntime.run({ feature: '관측 블로킹' }, ctx);
      const nonBlocking = await selfImplementRuntime.run({ feature: '관측 비블로킹', non_blocking: true }, ctx);
      await waitUntil(() => received.length >= 2);
      expect(modes).toContainEqual(expect.objectContaining({ mode: 'blocking' }));
      expect(modes).toContainEqual(expect.objectContaining({ mode: 'non-blocking', runId: nonBlocking.runId }));
      expect(received[0]).toBeUndefined();
      expect(received[1]).toBe(nonBlocking.runId);
    } finally {
      log.mockRestore();
    }
  });

  test('이 골이 더한 비블로킹 분기를 지우면 위 검사가 그 결손을 잡는다', () => {
    const source = readFileSync(new URL('./self-implement-runtime.ts', import.meta.url), 'utf8');
    expect(source).toContain("debug.log('self-implement', 'runtime.invocation-mode'");
    expect(source).toContain('if (nonBlocking)');
    expect(source).toContain("invocationMode: 'non-blocking'");
    expect(source).toContain('const drive = async (runId?: string)');
    expect(source).toContain('void drive(runId)');
    expect(source).toMatch(/non_blocking:\s*\{\s*type:\s*'boolean'/);
  });

  function installFakeHarnessSeams(): void {
    _setAutoOpenPrConfigReaderForTesting(() => false);
    setSelfImplementApprover(null);
    _setSelfImplementSeamsFactoryForTesting((options: DefaultSeamsOptions) => ({
      async createWorktree({ branch }) { return { path: `/wt/${branch}`, branch }; },
      async implement() { return { ok: true, summary: 'implemented' }; },
      async gate() { return { passed: true }; },
      async openPr() { return { url: 'https://example.test/pr/1', number: 1 }; },
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.approvePr ? { approvePr: options.approvePr } : {}),
    }));
  }

  function captureProductionObservationWriter(): {
    runIds: string[];
    completed: () => boolean;
    restore: () => void;
  } {
    const runIds: string[] = [];
    let completed = false;
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category !== 'self-implement') return;
      if (event === 'progress-delivery-outcome' && typeof data?.runId === 'string') runIds.push(data.runId);
      if (event === 'runtime.non-blocking-completed' || event === 'runtime.non-blocking-failed') completed = true;
    }) as never);
    return { runIds, completed: () => completed, restore: () => log.mockRestore() };
  }

  test('non_blocking 반환 runId·주입 CLI runId·하니스 관측 runId 가 하나다', async () => {
    installFakeHarnessSeams();
    const writer = captureProductionObservationWriter();
    let receivedRunId: string | undefined;
    _setSelfImplementCliCommandForTesting(async (feature, opts, deps) => {
      receivedRunId = opts.runId;
      return runSelfImplementCliCommand(feature, opts, {
        ...deps,
        pipelineDeps: {
          ...deps.pipelineDeps,
          runSelfImplement: (options) => runProductionSelfImplement(options),
        },
      });
    });
    try {
      const result = await selfImplementRuntime.run({ feature: '손잡이 일치', non_blocking: true }, ctx);
      await waitUntil(() => writer.runIds.length > 0, 5000);
      expect(result.runId).toMatch(/^run-/);
      const returnedRunId = result.runId;
      if (typeof returnedRunId !== 'string') throw new Error('expected returned runId');
      expect(receivedRunId).toBe(returnedRunId);
      expect(writer.runIds[0]).toBe(returnedRunId);
      expect(new Set(writer.runIds)).toEqual(new Set([returnedRunId]));
    } finally {
      await waitUntil(writer.completed, 5000).catch(() => undefined);
      writer.restore();
    }
  });

  test('스위치를 주지 않으면 반환 키 집합에 runId·invocationMode 가 없다', async () => {
    _setSelfImplementCliCommandForTesting(async () => ({
      ok: true,
      kind: 'self',
      exitCode: 0,
      result: {
        runId: 'run-blocking-internal',
        ok: true,
        stage: 'pr-declined',
        node: 'open-pr',
        outcome: 'completed',
      },
    }));
    const result = await selfImplementRuntime.run({ feature: '블로킹 키 집합' }, ctx);
    expect(Object.keys(result).sort()).toEqual(['node', 'ok', 'output', 'stage']);
    expect(result).not.toHaveProperty('runId');
    expect(result).not.toHaveProperty('invocationMode');
  });

  test('runId 전달을 끊으면 반환 식별자와 production writer 입력이 갈린다', async () => {
    installFakeHarnessSeams();
    const writer = captureProductionObservationWriter();
    _setSelfImplementCliCommandForTesting(async (feature, opts, deps) => {
      const { runId: _dropped, ...disconnected } = opts;
      return runSelfImplementCliCommand(feature, disconnected, {
        ...deps,
        pipelineDeps: {
          ...deps.pipelineDeps,
          runSelfImplement: (options) => runProductionSelfImplement(options),
        },
      });
    });
    try {
      const result = await selfImplementRuntime.run({ feature: '연결 단절', non_blocking: true }, ctx);
      await waitUntil(() => writer.runIds.length > 0, 5000);
      expect(result.runId).toMatch(/^run-/);
      const returnedRunId = result.runId;
      if (typeof returnedRunId !== 'string') throw new Error('expected returned runId');
      expect(writer.runIds[0]).not.toBe(returnedRunId);
    } finally {
      await waitUntil(writer.completed, 5000).catch(() => undefined);
      writer.restore();
    }
  });
});
