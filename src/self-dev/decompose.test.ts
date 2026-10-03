import { test, expect, describe } from 'bun:test';
import { debug } from '../debug/log.js';
import { gradePhaseCompletability } from '../autopilot/mission-phase-granularity.js';
import { deriveSelfDevArcsFromGrouping } from './arc-classify.js';
import {
  buildSelfDevDecomposePrompt,
  parseSelfDevDecomposition,
  foldRegistrationOnlyGoals,
  decomposeSelfDevGoal,
  FabricDecompositionRejectedError,
  inferHotPaths,
  SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH,
} from './decompose.js';

describe('inferHotPaths (G6 · 결정론 hotPaths 추론)', () => {
  test('src/docs/scripts 경로 추출·dedup', () => {
    const hp = inferHotPaths('src/harness/harness-seams.ts 를 고치고 docs/x.md 도. 또 src/harness/harness-seams.ts 재언급.');
    expect(hp).toEqual(['src/harness/harness-seams.ts', 'docs/x.md']); // dedup
  });
  test('산문에서 오탐 없음(top-dir+확장자 필요)', () => {
    expect(inferHotPaths('그냥 설명. 파일명 없음. foo.bar 같은 건 무시')).toEqual([]);
  });
});

describe('parseSelfDevDecomposition — G6 hotPaths 병합', () => {
  test('LLM hotPaths + feature 추론 경로 병합(dedup)', () => {
    const raw = '{"subtasks":[{"id":"a","feature":"src/a.ts 를 고쳐라","hotPaths":["src/b.ts"]}]}';
    const goals = parseSelfDevDecomposition(raw);
    expect(new Set(goals[0]!.hotPaths)).toEqual(new Set(['src/b.ts', 'src/a.ts'])); // LLM + 추론
  });
});

describe('buildSelfDevDecomposePrompt', () => {
  test('includes feature, cap, and STRICT JSON contract', () => {
    const p = buildSelfDevDecomposePrompt('build a widget', 4);
    expect(p).toContain('build a widget');
    expect(p).toContain('at most 4');
    expect(p).toContain('STRICT JSON');
    expect(p).toContain('dependsOn');
    expect(p).toContain('hotPaths');
    expect(p).toContain('goalType');
    expect(p).toContain('implement');
    expect(p).toContain('research');
    expect(p).toContain('document');
    expect(p).toContain('operate');
  });

  test('keeps minimal splitting subordinate to the concern-class split threshold', () => {
    const p = buildSelfDevDecomposePrompt('build a widget');
    const priorityRule = p.split('\n').find((line) => line.includes('Fewer is better'));

    expect(priorityRule).toContain('do NOT over-split');
    expect(priorityRule).toContain('mixes 3 or more concern classes');
    expect(priorityRule).toContain('split it into sibling sub-features');
    expect(priorityRule).toMatch(/investigate.*design.*add-one-unit.*wire-into-existing.*verify/);
  });

  test('keeps definition with registration or wiring for a handler, CLI command and graph node', () => {
    const prompt = buildSelfDevDecomposePrompt('Add a handler');
    expect(prompt).toContain('Keep a definition and its registration/wiring in the same sub-feature');
    expect(prompt).toContain('a handler with its route, a command with its CLI registration, a node with its graph/recipe entry');
  });

  test('places DEFINE FROM WIRE before self-contained work to prevent dead-code', () => {
    const p = buildSelfDevDecomposePrompt('build a widget');
    const defineFromWireRule = '- SEPARATE DEFINE FROM WIRE: adding a new function/type/export is a SEPARATE task from wiring it into an existing runtime call site. A task that both defines a new symbol AND integrates it across modules tends to leave dead-code (defined but never called) that fails integration gates. Pattern: (a) add the function + its unit test; then (b) a dependent task that wires it into the specific existing call site — name the exact `file.ts:function` to modify.';
    const selfContainedRule = '- Each sub-feature must be a self-contained, mergeable unit of work.';

    const defineFromWireIndex = p.indexOf(defineFromWireRule);
    const selfContainedIndex = p.indexOf(selfContainedRule);

    expect(defineFromWireIndex).toBeGreaterThanOrEqual(0);
    expect(selfContainedIndex).toBeGreaterThanOrEqual(0);
    expect(defineFromWireIndex).toBeLessThan(selfContainedIndex);
    expect(p).toContain('dead-code');
  });
});

describe('parseSelfDevDecomposition', () => {
  test('parses subtasks with deps + hotPaths', () => {
    const raw = '{"subtasks":[{"id":"a","feature":"do A","hotPaths":["x.ts"]},{"id":"b","feature":"do B","dependsOn":["a"]}]}';
    const goals = parseSelfDevDecomposition(raw);
    expect(goals.length).toBe(2);
    expect(goals[0]).toMatchObject({ id: 'a', feature: 'do A', hotPaths: ['x.ts'] });
    expect(goals[1]).toMatchObject({ id: 'b', feature: 'do B', dependsOn: ['a'] });
  });

  test('tolerates a ```json fence + surrounding prose', () => {
    const raw = 'Here you go:\n```json\n{"subtasks":[{"id":"a","feature":"only A"}]}\n```\nDone.';
    const goals = parseSelfDevDecomposition(raw);
    expect(goals.length).toBe(1);
    expect(goals[0]!.feature).toBe('only A');
  });

  test('accepts a bare array too', () => {
    const goals = parseSelfDevDecomposition('[{"id":"a","feature":"A"}]');
    expect(goals.length).toBe(1);
  });

  test('applies base/autoMerge defaults to every goal', () => {
    const goals = parseSelfDevDecomposition('{"subtasks":[{"id":"a","feature":"A"}]}', { base: 'origin/main', autoMerge: true });
    expect(goals[0]).toMatchObject({ base: 'origin/main', autoMerge: true });
  });

  test('drops subtasks with no feature; garbage → []', () => {
    expect(parseSelfDevDecomposition('{"subtasks":[{"id":"a"}]}')).toEqual([]);
    expect(parseSelfDevDecomposition('not json at all')).toEqual([]);
  });

  test('de-dupes colliding ids', () => {
    const goals = parseSelfDevDecomposition('{"subtasks":[{"id":"a","feature":"A1"},{"id":"a","feature":"A2"}]}');
    expect(goals.length).toBe(2);
    expect(new Set(goals.map((g) => g.id)).size).toBe(2);
  });

  test('carries only allowed goal types without defaulting or populating job kind', () => {
    const goals = parseSelfDevDecomposition(JSON.stringify({ subtasks: [
      { id: 'implement', feature: 'implement it', goalType: 'implement' },
      { id: 'research', feature: 'research it', goalType: 'research' },
      { id: 'document', feature: 'document it', goalType: 'document' },
      { id: 'operate', feature: 'operate it', goalType: 'operate' },
      { id: 'missing', feature: 'type omitted' },
      { id: 'invalid', feature: 'type rejected', goalType: 'deploy' },
    ] }));

    expect(goals.slice(0, 4).map((goal) => goal.goalType)).toEqual(['implement', 'research', 'document', 'operate']);
    for (const goal of goals.slice(0, 4)) expect(goal.kind).toBeUndefined();
    for (const goal of goals.slice(4)) {
      expect(goal.goalType).toBeUndefined();
      expect('goalType' in goal).toBe(false);
      expect(goal.kind).toBeUndefined();
    }
  });
});

describe('foldRegistrationOnlyGoals', () => {
  test('folds a route into its handler with unioned paths and one path-only event', async () => {
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data });
    }) as typeof debug.log;
    try {
      const result = await decomposeSelfDevGoal('add a handler', { llm: async () => JSON.stringify({ subtasks: [
        { id: 'a', feature: 'Implement handler', hotPaths: ['src/nexus/api/foo.ts'] },
        { id: 'b', feature: 'Register route', hotPaths: ['src/nexus/api/http-server.ts'], dependsOn: ['a'] },
      ] }) });
      expect(result.goals).toEqual([{ id: 'a', feature: 'Implement handler\nAlso register: Register route', hotPaths: ['src/nexus/api/foo.ts', 'src/nexus/api/http-server.ts'] }]);
      expect(events.filter(({ event }) => event === 'fold-registration')).toEqual([{
        category: 'self-dev.decompose', event: 'fold-registration',
        data: { from: 'b', into: 'a', files: ['src/nexus/api/http-server.ts'] },
      }]);
      expect(events.find(({ event }) => event === 'decomposition')?.data).toMatchObject({ foldedRegistration: 1 });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('rewires a downstream dependency and removes self references and duplicates', () => {
    expect(foldRegistrationOnlyGoals([
      { id: 'a', feature: 'Handler', hotPaths: ['src/nexus/api/foo.ts'], dependsOn: ['b'] },
      { id: 'b', feature: 'Route', hotPaths: ['src/nexus/api/http-server.ts'], dependsOn: ['a'] },
      { id: 'c', feature: 'Consumer', dependsOn: ['b', 'a'] },
    ])).toEqual([
      { id: 'a', feature: 'Handler\nAlso register: Route', hotPaths: ['src/nexus/api/foo.ts', 'src/nexus/api/http-server.ts'] },
      { id: 'c', feature: 'Consumer', dependsOn: ['a'] },
    ]);
  });

  test.each([
    ['non-registration path', ['src/index.ts', 'src/nexus/api/bar.ts'], ['a']],
    ['no dependency', ['src/index.ts'], []],
    ['multiple dependencies', ['src/telegram-commands.ts'], ['a', 'd']],
    ['unknown dependency', ['graphs/operate-loop.yaml'], ['absent']],
    ['empty paths', [], ['a']],
    ['non-yaml graph path', ['graphs/operate-loop.yml'], ['a']],
    ['nested non-graph path', ['other/graphs/operate-loop.yaml'], ['a']],
  ])('does not fold %s', async (_reason, hotPaths, dependsOn) => {
    const subtasks = [
      { id: 'a', feature: 'Handler', hotPaths: ['src/nexus/api/foo.ts'] },
      { id: 'b', feature: 'Registration', hotPaths, dependsOn },
      { id: 'd', feature: 'Second dependency', hotPaths: ['src/other.ts'] },
    ];
    const result = await decomposeSelfDevGoal('ordinary decomposition', {
      llm: async () => JSON.stringify({ subtasks }),
    });
    expect(result.goals.map((goal) => goal.id)).toEqual(['a', 'b', 'd']);
    expect(result.goals[1]?.hotPaths).toEqual(hotPaths.length ? hotPaths : undefined);
    expect(result.goals[1]?.feature).toBe('Registration');
    expect(result.goals[1]?.dependsOn).toEqual(dependsOn.filter((id) => id !== 'absent').length
      ? dependsOn.filter((id) => id !== 'absent') : undefined);
    expect(foldRegistrationOnlyGoals(subtasks)).toEqual(subtasks);
  });

  test('folds the allowlisted CLI, Telegram, and nested graph registrations', () => {
    for (const path of ['src/index.ts', 'src/telegram-commands.ts', 'graphs/operate-loop.yaml', 'graphs/nested/recipe.yaml']) {
      expect(foldRegistrationOnlyGoals([
        { id: 'a', feature: 'Definition', hotPaths: ['src/definition.ts'] },
        { id: 'b', feature: 'Registration', hotPaths: [path], dependsOn: ['a'] },
      ])).toEqual([{ id: 'a', feature: 'Definition\nAlso register: Registration', hotPaths: ['src/definition.ts', path] }]);
    }
  });

  test('folds chained registrations until no registration-only dependent remains', () => {
    expect(foldRegistrationOnlyGoals([
      { id: 'a', feature: 'Handler', hotPaths: ['src/nexus/api/foo.ts'] },
      { id: 'b', feature: 'Route', hotPaths: ['src/nexus/api/http-server.ts'], dependsOn: ['a'] },
      { id: 'c', feature: 'CLI', hotPaths: ['src/index.ts'], dependsOn: ['b'] },
      { id: 'd', feature: 'Consumer', dependsOn: ['c'] },
    ])).toEqual([
      { id: 'a', feature: 'Handler\nAlso register: Route\nAlso register: CLI', hotPaths: ['src/nexus/api/foo.ts', 'src/nexus/api/http-server.ts', 'src/index.ts'] },
      { id: 'd', feature: 'Consumer', dependsOn: ['a'] },
    ]);
  });

  test('preserves ordinary decomposition unchanged', () => {
    const goals = parseSelfDevDecomposition(JSON.stringify({ subtasks: [
      { id: 'a', feature: 'Implement handler', hotPaths: ['src/nexus/api/foo.ts'] },
      { id: 'b', feature: 'Implement service', hotPaths: ['src/nexus/api/bar.ts'], dependsOn: ['a'] },
    ] }));
    expect(foldRegistrationOnlyGoals(goals)).toEqual(goals);
  });

  test('explicit Fabric output is folded before final observation', async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data });
    }) as typeof debug.log;
    try {
      const result = await decomposeSelfDevGoal('fabric request', {
        decomposer: 'fabric',
        fabric: {
          context: { goal: 'unused', groundingContext: 'grounded context' },
          resolve: async () => 'unused',
          decompose: async () => ({
            status: 'decomposed',
            goals: [
              { id: 'a', feature: 'Handler', hotPaths: ['src/nexus/api/foo.ts'] },
              { id: 'b', feature: 'Route', hotPaths: ['src/nexus/api/http-server.ts'], dependsOn: ['a'] },
            ],
            decompositions: [], rfc: {} as never, omittedGoalCount: 0, budgetSkippedArcCount: 0, budgetLimited: false,
          }),
        },
      });
      expect(result.goals).toEqual([{ id: 'a', feature: 'Handler\nAlso register: Route', hotPaths: ['src/nexus/api/foo.ts', 'src/nexus/api/http-server.ts'] }]);
      expect(events.find(({ event }) => event === 'decomposition')?.data).toMatchObject({ foldedRegistration: 1 });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });
});

describe('deriveSelfDevArcsFromGrouping', () => {
  test('returns null rather than throwing for malformed group entries', () => {
    const tasks = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ];
    expect(deriveSelfDevArcsFromGrouping(
      tasks,
      [null, null] as unknown as never[],
      2,
    )).toBeNull();
  });
});

describe('decomposeSelfDevGoal (fake llm — no live model)', () => {
  test('returns the decomposed DAG from the llm seam', async () => {
    const llm = async () => '{"subtasks":[{"id":"t","feature":"types"},{"id":"c","feature":"consumer","dependsOn":["t"]}]}';
    const result = await decomposeSelfDevGoal('big feature', { llm });
    expect(result.goals.length).toBe(2);
    expect(result.goals[1]!.dependsOn).toEqual(['t']);
  });

  test('keeps the default decomposer selected and records that selection', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await decomposeSelfDevGoal('default request', {
        llm: async () => JSON.stringify({ subtasks: [{ id: 'default', feature: 'default goal' }] }),
      });
      expect(result.goals).toEqual([{ id: 'default', feature: 'default goal' }]);
      expect(events.filter(({ event }) => event === 'decomposition.decomposer-selection')).toEqual([
        { event: 'decomposition.decomposer-selection', data: { decomposer: 'default', goalId: null, goalIdStatus: 'unknown', runId: null } },
      ]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('uses the explicit Fabric decomposer with caller context and records the Fabric selection', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let calls = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await decomposeSelfDevGoal('fabric request', {
        decomposer: 'fabric',
        fabric: {
          context: { goal: 'unused', groundingContext: 'grounded context' },
          resolve: async () => 'unused',
          decompose: async (feature, context) => {
            calls++;
            expect(feature).toBe('fabric request');
            expect(context.groundingContext).toBe('grounded context');
            return { status: 'decomposed', goals: [{ id: 'fabric', feature: 'fabric goal' }], decompositions: [], rfc: {} as never, omittedGoalCount: 0, budgetSkippedArcCount: 0, budgetLimited: false };
          },
        },
      });
      expect(calls).toBe(1);
      expect(result.goals).toEqual([{ id: 'fabric', feature: 'fabric goal' }]);
      expect(result.decomposition.omittedGoalCount).toBe(0);
      expect(events.filter(({ event }) => event === 'decomposition.decomposer-selection')).toEqual([
        { event: 'decomposition.decomposer-selection', data: { decomposer: 'fabric', goalId: null, goalIdStatus: 'unknown', runId: null } },
      ]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('preserves Fabric omitted goal count through the general decomposition result', async () => {
    const result = await decomposeSelfDevGoal('fabric request', {
      decomposer: 'fabric',
      fabric: {
        context: { goal: 'unused', groundingContext: 'grounded context' },
        resolve: async () => 'unused',
        decompose: async () => ({
          status: 'decomposed',
          goals: [{ id: 'named-target', feature: 'Edit src/named-target.ts' }],
          decompositions: [],
          rfc: {} as never,
          omittedGoalCount: 1, budgetSkippedArcCount: 0, budgetLimited: false,
        }),
      },
    });

    expect(result.goals).toEqual([{ id: 'named-target', feature: 'Edit src/named-target.ts', hotPaths: ['src/named-target.ts'] }]);
    expect(result.decomposition.omittedGoalCount).toBe(1);
  });

  test('applies existing max-task, default, hot-path, and arc postprocessing to Fabric goals', async () => {
    const result = await decomposeSelfDevGoal('fabric request', {
      decomposer: 'fabric',
      maxTasks: 1,
      base: 'origin/main',
      autoMerge: false,
      arcHint: 2,
      arcLlm: async () => JSON.stringify({ arcs: [
        { name: 'first', tasks: [1], dependsOn: [] },
        { name: 'second', tasks: [2], dependsOn: [1] },
      ] }),
      fabric: {
        context: { goal: 'unused', groundingContext: 'grounded context' },
        resolve: async () => 'unused',
        decompose: async () => ({
          status: 'decomposed',
          goals: [
            { id: 'a', feature: 'Edit src/a.ts' },
            { id: 'b', feature: 'Edit src/b.ts' },
            { id: 'c', feature: 'excluded by hard max' },
          ],
          decompositions: [],
          rfc: {} as never,
          omittedGoalCount: 0, budgetSkippedArcCount: 0, budgetLimited: false,
        }),
      },
    });
    expect(result.decomposition).toEqual({
      recommendedMaxTasks: 1,
      actualTaskCount: 3,
      truncatedAtHardMax: true,
      exceededRecommendedMax: true,
      outcome: 'decomposed',
      omittedGoalCount: 0,
    });
    expect(result.goals).toEqual([
      { id: 'a', feature: 'Edit src/a.ts', hotPaths: ['src/a.ts'], base: 'origin/main', autoMerge: false },
      { id: 'b', feature: 'Edit src/b.ts', hotPaths: ['src/b.ts'], base: 'origin/main', autoMerge: false, dependsOn: ['a'] },
    ]);
    expect(result.arcs).toHaveLength(2);
  });

  test('normalizes an empty successful Fabric decomposition to the existing single-goal fallback', async () => {
    let defaultCalls = 0;
    const result = await decomposeSelfDevGoal('fabric request', {
      decomposer: 'fabric',
      llm: async () => { defaultCalls++; return JSON.stringify({ subtasks: [{ id: 'default', feature: 'must not run' }] }); },
      fabric: {
        context: { goal: 'unused', groundingContext: 'grounded context' },
        resolve: async () => 'unused',
        decompose: async () => ({ status: 'decomposed', goals: [], decompositions: [], rfc: {} as never, omittedGoalCount: 0, budgetSkippedArcCount: 0, budgetLimited: false }),
      },
    });

    expect(defaultCalls).toBe(0);
    expect(result).toEqual({
      goals: [{ id: '0', feature: 'fabric request' }],
      decomposition: {
        recommendedMaxTasks: 6,
        actualTaskCount: 0,
        truncatedAtHardMax: false,
        exceededRecommendedMax: false,
        outcome: 'single-no-subtasks',
        omittedGoalCount: 0,
      },
    });
  });

  test('rejects an explicit Fabric request without context instead of invoking the default decomposer', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let defaultCalls = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await expect(decomposeSelfDevGoal('rejected request', {
        decomposer: 'fabric',
        llm: async () => { defaultCalls++; return JSON.stringify({ subtasks: [{ id: 'fallback', feature: 'default fallback' }] }); },
      })).rejects.toMatchObject({
        name: 'FabricDecompositionRejectedError',
        result: { status: 'missing-research-context', message: 'explicit fabric decomposition requires fabric context and resolver' },
      } satisfies Partial<FabricDecompositionRejectedError>);
      expect(defaultCalls).toBe(0);
      expect(events.filter(({ event }) => event === 'decomposition.decomposer-selection')).toEqual([
        { event: 'decomposition.decomposer-selection', data: { decomposer: 'fabric-rejected', goalId: null, goalIdStatus: 'unknown', runId: null } },
      ]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('preserves a Fabric rejection instead of falling back while recording a distinct rejected selection', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    let calls = 0;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      let defaultCalls = 0;
      await expect(decomposeSelfDevGoal('rejected request', {
        decomposer: 'fabric',
        llm: async () => { defaultCalls++; return JSON.stringify({ subtasks: [{ id: 'fallback', feature: 'default fallback' }] }); },
        fabric: {
          context: { goal: 'unused', groundingContext: 'grounded context' },
          resolve: async () => 'unused',
          decompose: async () => {
            calls++;
            return { status: 'missing-research-context', message: 'adapter rejected context' };
          },
        },
      })).rejects.toMatchObject({
        name: 'FabricDecompositionRejectedError',
        result: { status: 'missing-research-context', message: 'adapter rejected context' },
      } satisfies Partial<FabricDecompositionRejectedError>);
      expect(calls).toBe(1);
      expect(defaultCalls).toBe(0);
      expect(events.filter(({ event }) => event === 'decomposition.decomposer-selection')).toEqual([
        { event: 'decomposition.decomposer-selection', data: { decomposer: 'fabric-rejected', goalId: null, goalIdStatus: 'unknown', runId: null } },
      ]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('preserves allowed, missing, and invalid goal types from the injected LLM', async () => {
    const llm = async () => JSON.stringify({ subtasks: [
      { id: 'research', feature: 'research first', goalType: 'research' },
      { id: 'missing', feature: 'implement next', dependsOn: ['research'] },
      { id: 'invalid', feature: 'write runbook', goalType: 'unknown', dependsOn: ['missing'] },
    ] });
    const result = await decomposeSelfDevGoal('research, implement, and document', { llm });

    expect(result.goals.map((goal) => goal.goalType)).toEqual(['research', undefined, undefined]);
    expect(result.goals[1]).toEqual({ id: 'missing', feature: 'implement next', dependsOn: ['research'] });
    expect(result.goals[2]).toEqual({ id: 'invalid', feature: 'write runbook', dependsOn: ['missing'] });
    expect(result.decomposition).toEqual({
      recommendedMaxTasks: 6,
      actualTaskCount: 3,
      truncatedAtHardMax: false,
      exceededRecommendedMax: false,
      outcome: 'decomposed',
    });
  });

  test('hard-caps a model response at twice the recommendation and logs its metadata', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const llm = async () => JSON.stringify({ subtasks: Array.from({ length: 9 }, (_, i) => ({
        id: `task-${i}`,
        feature: `task ${i}`,
        ...(i === 0 ? { dependsOn: ['task-8'] } : {}),
      })) });
      const result = await decomposeSelfDevGoal('big feature', { llm, maxTasks: 3 });
      expect(result.goals).toHaveLength(6);
      expect(result.goals[0]).toEqual({ id: 'task-0', feature: 'task 0' });
      expect(result.goals.flatMap((goal) => goal.dependsOn ?? [])).not.toContain('task-8');
      expect(result.decomposition).toEqual({
        recommendedMaxTasks: 3,
        actualTaskCount: 9,
        truncatedAtHardMax: true,
        exceededRecommendedMax: true,
        outcome: 'decomposed',
      });
      const data = events.find(({ category, event }) => (
        category === 'self-dev' && event === 'decomposition'
      ))!.data;
      expect(data).toMatchObject(result.decomposition);
      expect(data.subtasks).toEqual(Array.from({ length: 6 }, (_, i) => ({
        id: `task-${i}`,
        dependsOn: [],
        feature: `task ${i}`,
        featureTruncated: false,
        pathGrounding: { candidateStatus: 'no-candidates', candidateCount: 0, missingCount: 0 },
      })));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('names omitted and empty goal IDs as unknown without replacing either event family', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      for (const observation of [undefined, { goalId: '' }, { event: 'prelaunch-decomposition', goalId: '' }]) {
        await decomposeSelfDevGoal('unknown identity request', {
          llm: async () => JSON.stringify({ subtasks: [{ id: 'one', feature: 'one piece' }] }),
          ...(observation === undefined ? {} : { observation }),
        });
      }
      expect(events.filter(({ event }) => event.endsWith('.goal-id-unknown'))).toEqual([
        { event: 'decomposition.goal-id-unknown', data: { goalId: null, goalIdStatus: 'unknown', runId: null } },
        { event: 'decomposition.goal-id-unknown', data: { goalId: null, goalIdStatus: 'unknown', runId: null } },
        { event: 'prelaunch-decomposition.goal-id-unknown', data: { goalId: null, goalIdStatus: 'unknown', runId: null } },
      ]);
      expect(events.some(({ event }) => event === 'decomposition')).toBe(true);
      expect(events.some(({ event }) => event === 'prelaunch-decomposition')).toBe(true);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('carries caller goal and run identities on selection and final observations', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await decomposeSelfDevGoal('identified request', {
        llm: async () => JSON.stringify({ subtasks: [{ id: 'one', feature: 'one piece' }] }),
        observation: { goalId: '0123456789abcdef', runId: 'run-123' },
      });
      expect(events.filter(({ event }) => event === 'decomposition.decomposer-selection' || event === 'decomposition')).toEqual([
        { event: 'decomposition.decomposer-selection', data: { decomposer: 'default', goalId: '0123456789abcdef', goalIdStatus: 'known', runId: 'run-123' } },
        expect.objectContaining({
          event: 'decomposition',
          data: expect.objectContaining({ goalId: '0123456789abcdef', runId: 'run-123' }),
        }),
      ]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('logs ordered subtask identities and two dependency edges', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await decomposeSelfDevGoal('DAG', { llm: async () => JSON.stringify({ subtasks: [
        { id: 'types', feature: 'Define shared types' },
        { id: 'service', feature: 'Implement service', dependsOn: ['types'] },
        { id: 'ui', feature: 'Render UI', dependsOn: ['types'] },
      ] }) });
      const data = events.find(({ category, event }) => category === 'self-dev' && event === 'decomposition')!.data;
      expect(data).toMatchObject(result.decomposition);
      expect(data.subtasks).toEqual([
        { id: 'types', dependsOn: [], feature: 'Define shared types', featureTruncated: false, pathGrounding: { candidateStatus: 'no-candidates', candidateCount: 0, missingCount: 0 } },
        { id: 'service', dependsOn: ['types'], feature: 'Implement service', featureTruncated: false, pathGrounding: { candidateStatus: 'no-candidates', candidateCount: 0, missingCount: 0 } },
        { id: 'ui', dependsOn: ['types'], feature: 'Render UI', featureTruncated: false, pathGrounding: { candidateStatus: 'no-candidates', candidateCount: 0, missingCount: 0 } },
      ]);
      expect((data.subtasks as Array<{ dependsOn: string[] }>).flatMap(({ dependsOn }) => dependsOn)).toHaveLength(2);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('uses a caller-provided observation name without changing decomposition output', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await decomposeSelfDevGoal('launch recommendation', {
        llm: async () => JSON.stringify({ subtasks: [{ id: 'one', feature: 'one piece' }] }),
        observation: { category: 'self-dev', event: 'launch-decomposition' },
      });
      expect(result.decomposition.outcome).toBe('decomposed');
      expect(events).toContainEqual(expect.objectContaining({
        category: 'self-dev', event: 'launch-decomposition', data: expect.objectContaining({ actualTaskCount: 1 }),
      }));
      expect(events.some(({ event }) => event === 'decomposition')).toBe(false);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('omits subtasks and logs zero size grades for an empty decomposition', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await decomposeSelfDevGoal('atomic feature', { llm: async () => JSON.stringify({ subtasks: [] }) });
      const data = events.find(({ category, event }) => category === 'self-dev' && event === 'decomposition')!.data;
      expect(data).toMatchObject(result.decomposition);
      expect(data).toMatchObject({
        tooLargeSubtaskCount: 0,
        tooSmallSubtaskCount: 0,
        hasMultipleTooLargeSubtasks: false,
      });
      expect(data).not.toHaveProperty('subtasks');
      expect(data).not.toHaveProperty('gradeRationales');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('logs original-feature SSOT size grades while preserving bounded observation text and returned goals', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    const oversizedFeature = `${'x'.repeat(SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH)} investigate, design, implement`;
    const secondOversizedFeature = `${'y'.repeat(SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH)} investigate, design, implement`;
    const subtasks = [
      { id: 'large-one', feature: oversizedFeature },
      { id: 'large-two', feature: secondOversizedFeature },
      { id: 'small', feature: 'implement' },
    ];
    const expectedGrades = subtasks.map(({ id, feature }) => gradePhaseCompletability({ id, title: feature, prompt: feature, acceptance: [] }));
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await decomposeSelfDevGoal('sizing request', { llm: async () => JSON.stringify({ subtasks }) });
      const data = events.find(({ category, event }) => category === 'self-dev' && event === 'decomposition')!.data;
      expect(result.goals).toEqual(subtasks);
      expect(data).toMatchObject({
        tooLargeSubtaskCount: expectedGrades.filter(({ verdict }) => verdict === 'too_large').length,
        tooSmallSubtaskCount: expectedGrades.filter(({ verdict }) => verdict === 'too_small').length,
        hasMultipleTooLargeSubtasks: true,
      });
      expect(data.subtasks).toEqual([
        { id: 'large-one', dependsOn: [], feature: oversizedFeature.slice(0, SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH), featureTruncated: true, pathGrounding: { candidateStatus: 'no-candidates', candidateCount: 0, missingCount: 0 } },
        { id: 'large-two', dependsOn: [], feature: secondOversizedFeature.slice(0, SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH), featureTruncated: true, pathGrounding: { candidateStatus: 'no-candidates', candidateCount: 0, missingCount: 0 } },
        { id: 'small', dependsOn: [], feature: 'implement', featureTruncated: false, pathGrounding: { candidateStatus: 'no-candidates', candidateCount: 0, missingCount: 0 } },
      ]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('grounds original feature paths before truncation without changing returned goals', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    const feature = `${'x'.repeat(SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH)} src/present.ts src/missing.ts`;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await decomposeSelfDevGoal('path grounding', {
        llm: async () => JSON.stringify({ subtasks: [{ id: 'paths', feature }] }),
        pathGrounding: {
          repoRoot: '/repo',
          probe: (path) => path === '/repo/src/present.ts' ? 'present' : 'missing',
        },
      });
      const data = events.find(({ category, event }) => category === 'self-dev' && event === 'decomposition')!.data;
      expect(result.goals).toEqual([{ id: 'paths', feature, hotPaths: ['src/present.ts', 'src/missing.ts'] }]);
      expect(data.subtasks).toEqual([{
        id: 'paths',
        dependsOn: [],
        feature: feature.slice(0, SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH),
        featureTruncated: true,
        pathGrounding: { candidateStatus: 'checked', candidateCount: 2, missingCount: 1 },
      }]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('logs per-subtask grade rationale so a reader can check why too_large/too_small was assigned', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    const oversizedFeature = `${'x'.repeat(SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH)} investigate, design, implement`;
    const secondOversizedFeature = `${'y'.repeat(SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH)} investigate, design, implement`;
    const subtasks = [
      { id: 'large-one', feature: oversizedFeature },
      { id: 'large-two', feature: secondOversizedFeature },
      { id: 'small', feature: 'implement' },
    ];
    const expectedGrades = subtasks.map(({ id, feature }) => gradePhaseCompletability({
      id,
      title: feature,
      prompt: feature,
      acceptance: [],
    }));
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await decomposeSelfDevGoal('sizing rationale', { llm: async () => JSON.stringify({ subtasks }) });
      const data = events.find(({ category, event }) => category === 'self-dev' && event === 'decomposition')!.data;
      expect(data).toEqual(expect.objectContaining({
        tooLargeSubtaskCount: expectedGrades.filter(({ verdict }) => verdict === 'too_large').length,
        tooSmallSubtaskCount: expectedGrades.filter(({ verdict }) => verdict === 'too_small').length,
        hasMultipleTooLargeSubtasks: true,
        subtasks: [
          { id: 'large-one', dependsOn: [], feature: oversizedFeature.slice(0, SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH), featureTruncated: true, pathGrounding: { candidateStatus: 'no-candidates', candidateCount: 0, missingCount: 0 } },
          { id: 'large-two', dependsOn: [], feature: secondOversizedFeature.slice(0, SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH), featureTruncated: true, pathGrounding: { candidateStatus: 'no-candidates', candidateCount: 0, missingCount: 0 } },
          { id: 'small', dependsOn: [], feature: 'implement', featureTruncated: false, pathGrounding: { candidateStatus: 'no-candidates', candidateCount: 0, missingCount: 0 } },
        ],
      }));
      expect(data.gradeRationales).toEqual(expectedGrades.map((grade, index) => ({
        id: subtasks[index]!.id,
        verdict: grade.verdict,
        input: {
          promptLength: subtasks[index]!.feature.trim().length,
          acceptanceCount: 0,
          sizeSignals: grade.sizeSignals,
        },
        concerns: grade.concerns,
        conjunctions: grade.conjunctions,
        oversizeFactors: grade.oversizeFactors,
        completabilityScore: grade.completabilityScore,
        reason: grade.reason,
      })));
      const rationales = data.gradeRationales as Array<Record<string, unknown>>;
      expect(rationales.map(({ id, verdict }) => ({ id, verdict }))).toEqual([
        { id: 'large-one', verdict: 'too_large' },
        { id: 'large-two', verdict: 'too_large' },
        { id: 'small', verdict: 'too_small' },
      ]);
      expect(rationales[0]).toEqual(expect.objectContaining({
        input: expect.objectContaining({
          promptLength: oversizedFeature.trim().length,
          acceptanceCount: 0,
          sizeSignals: {},
        }),
        concerns: expect.arrayContaining(['investigate', 'design', 'implement']),
        conjunctions: expect.any(Number),
        oversizeFactors: expect.any(Array),
        reason: expect.stringMatching(/과대/),
      }));
      expect((rationales[0] as { conjunctions: number }).conjunctions).toBeGreaterThanOrEqual(1);
      expect((rationales[0] as { oversizeFactors: string[] }).oversizeFactors.length).toBeGreaterThan(0);
      expect(rationales[2]).toEqual(expect.objectContaining({
        input: { promptLength: 'implement'.length, acceptanceCount: 0, sizeSignals: {} },
        reason: expect.stringMatching(/과소/),
      }));
      expect((rationales[2] as { input: { promptLength: number } }).input.promptLength).toBeLessThan(120);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('logs bounded subtask text with explicit truncation state', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const feature = 'x'.repeat(SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH + 1);
      await decomposeSelfDevGoal('long text', { llm: async () => JSON.stringify({ subtasks: [
        { id: 'short', feature: 'Short text' },
        { id: 'long', feature },
      ] }) });
      const data = events.find(({ category, event }) => category === 'self-dev' && event === 'decomposition')!.data;
      expect(data.subtasks).toEqual([
        { id: 'short', dependsOn: [], feature: 'Short text', featureTruncated: false, pathGrounding: { candidateStatus: 'no-candidates', candidateCount: 0, missingCount: 0 } },
        {
          id: 'long',
          dependsOn: [],
          feature: feature.slice(0, SELF_DEV_DECOMPOSITION_FEATURE_MAX_LENGTH),
          featureTruncated: true,
          pathGrounding: { candidateStatus: 'no-candidates', candidateCount: 0, missingCount: 0 },
        },
      ]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('hard-caps raw output before validation, without backfilling invalid leading entries', async () => {
    const llm = async () => JSON.stringify({ subtasks: [
      { id: 'invalid' },
      { id: 'first', feature: 'first valid task' },
      { id: 'second', feature: 'second valid task' },
      { id: 'third', feature: 'third valid task' },
      { id: 'outside', feature: 'must not be backfilled from beyond hard cap' },
      { id: 'outside-two', feature: 'also beyond hard cap' },
    ] });
    const result = await decomposeSelfDevGoal('big feature', { llm, maxTasks: 2 });
    expect(result.goals.map((goal) => goal.id)).toEqual(['first', 'second', 'third']);
    expect(result.goals).toHaveLength(3);
    expect(result.decomposition).toEqual({
      recommendedMaxTasks: 2,
      actualTaskCount: 6,
      truncatedAtHardMax: true,
      exceededRecommendedMax: true,
      outcome: 'decomposed',
    });
  });

  test('preserves raw count and pre-validation cap when a capped entry is null', async () => {
    const llm = async () => JSON.stringify({ subtasks: [
      { id: 'first', feature: 'first valid task' },
      null,
      { id: 'second', feature: 'second valid task' },
      { id: 'third', feature: 'third valid task' },
      { id: 'outside', feature: 'must not backfill the null entry' },
    ] });
    const result = await decomposeSelfDevGoal('big feature', { llm, maxTasks: 2 });
    expect(result.goals.map((goal) => goal.id)).toEqual(['first', 'second', 'third']);
    expect(result.goals).toHaveLength(3);
    expect(result.decomposition).toEqual({
      recommendedMaxTasks: 2,
      actualTaskCount: 5,
      truncatedAtHardMax: true,
      exceededRecommendedMax: true,
      outcome: 'decomposed',
    });
  });

  test('preserves a response above the recommendation but within the hard cap', async () => {
    const llm = async () => JSON.stringify({ subtasks: Array.from({ length: 4 }, (_, i) => ({ id: `task-${i}`, feature: `task ${i}` })) });
    const result = await decomposeSelfDevGoal('big feature', { llm, maxTasks: 3 });
    expect(result.goals).toHaveLength(4);
    expect(result.decomposition).toEqual({
      recommendedMaxTasks: 3,
      actualTaskCount: 4,
      truncatedAtHardMax: false,
      exceededRecommendedMax: true,
      outcome: 'decomposed',
    });
  });

  test('keeps the existing array result within the recommendation', async () => {
    const llm = async () => '{"subtasks":[{"id":"a","feature":"A"},{"id":"b","feature":"B"}]}';
    const result = await decomposeSelfDevGoal('big feature', { llm, maxTasks: 3 });
    expect(result.goals).toEqual([{ id: 'a', feature: 'A' }, { id: 'b', feature: 'B' }]);
    expect(result.decomposition).toEqual({
      recommendedMaxTasks: 3,
      actualTaskCount: 2,
      truncatedAtHardMax: false,
      exceededRecommendedMax: false,
      outcome: 'decomposed',
    });
  });

  test.each([0, -1, Number.NaN, 1.5])('rejects invalid maxTasks %p', async (maxTasks) => {
    const llm = async () => '{"subtasks":[{"id":"a","feature":"A"}]}';
    await expect(decomposeSelfDevGoal('big feature', { llm, maxTasks })).rejects.toThrow('maxTasks must be a positive integer');
  });

  // 🚨 73차 — 「LLM 이 답했는데 조각이 0」과 「LLM 호출이 실패」는 «다른 사건»이다.
  //   ⛔ 종전엔 둘 다 actualTaskCount:0 으로만 남아 바깥에서 구분이 불가능했고,
  //     그래서 「너무 큰 골이 안 쪼개진 채 발사」된 원인을 사후에 못 밝혔다(`[T]` 실패 B).
  test('llm 이 답했는데 서브태스크가 없으면 single-no-subtasks 로 «갈린다»', async () => {
    const llm = async () => JSON.stringify({ subtasks: [] });
    const result = await decomposeSelfDevGoal('whole thing', { llm });
    expect(result.goals).toEqual([{ id: '0', feature: 'whole thing' }]);
    expect(result.decomposition).toMatchObject({ actualTaskCount: 0, outcome: 'single-no-subtasks' });
    expect(result.decomposition).not.toHaveProperty('error');
  });

  test('llm error → single-goal fallback (whole feature) and logs zero output metadata', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const llm = async () => { throw new Error('model down'); };
      const result = await decomposeSelfDevGoal('whole thing', { llm });
      expect(result.goals).toEqual([{ id: '0', feature: 'whole thing' }]);
      expect(result.decomposition).toEqual({
        recommendedMaxTasks: 6,
        actualTaskCount: 0,
        truncatedAtHardMax: false,
        exceededRecommendedMax: false,
        // ⭐ 73차 — 「쪼갤 필요가 없었다」와 ***「쪼개려다 실패했다」***를 다른 값으로.
        //   ⛔ 종전엔 둘 다 actualTaskCount:0 이라 바깥에서 «구분이 불가능»했다.
        outcome: 'llm-failed',
        error: 'model down',
      });
      const event = events.find(({ category, event }) => category === 'self-dev' && event === 'decomposition');
      expect(event?.data).toMatchObject({
        ...result.decomposition,
        tooLargeSubtaskCount: 0,
        tooSmallSubtaskCount: 0,
        hasMultipleTooLargeSubtasks: false,
      });
      expect(event?.data).not.toHaveProperty('subtasks');
      expect(event?.data).not.toHaveProperty('gradeRationales');
      expect(event?.data.error).toBe('model down');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('empty/garbage decomposition → single-goal fallback', async () => {
    const llm = async () => 'sorry I cannot';
    const result = await decomposeSelfDevGoal('whole thing', { llm, base: 'origin/main' });
    expect(result.goals).toEqual([{ id: '0', feature: 'whole thing', base: 'origin/main' }]);
  });

  test('without an explicit arcHint makes one decomposition LLM call and preserves the flat result', async () => {
    let calls = 0;
    const result = await decomposeSelfDevGoal('whole thing', {
      llm: async () => {
        calls++;
        return JSON.stringify({ subtasks: [{ id: 'a', feature: 'A' }, { id: 'b', feature: 'B' }] });
      },
    });
    expect(calls).toBe(1);
    expect(result).toEqual({
      goals: [{ id: 'a', feature: 'A' }, { id: 'b', feature: 'B' }],
      decomposition: { recommendedMaxTasks: 6, actualTaskCount: 2, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
    });
  });

  test('explicit arcHint adds validated arcs and records task membership and inter-arc dependencies', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const llm = async (prompt: string) => prompt.startsWith('Group the decomposed')
        ? JSON.stringify({ arcs: [
          { name: 'Foundation', intent: 'types', tasks: [1], dependsOn: [] },
          { name: 'Delivery', intent: 'consumer', tasks: [2, 3], dependsOn: [1] },
        ] })
        : JSON.stringify({ subtasks: [
          { id: 'types', feature: 'Define types' },
          { id: 'service', feature: 'Implement service', dependsOn: ['types'] },
          { id: 'ui', feature: 'Render UI', dependsOn: ['service'] },
        ] });
      const result = await decomposeSelfDevGoal('whole thing', { llm, arcHint: 3 });
      const data = events.find(({ category, event }) => category === 'self-dev' && event === 'decomposition')!.data;
      expect(result.arcs).toEqual([
        { id: 'arc-1', name: 'Foundation', intent: 'types', taskIds: ['types'], dependsOn: [] },
        { id: 'arc-2', name: 'Delivery', intent: 'consumer', taskIds: ['service', 'ui'], dependsOn: ['arc-1'] },
      ]);
      expect(result.hintDeviation).toEqual({ requested: 3, actual: 2 });
      expect(data.arcs).toEqual(result.arcs);
      expect(data.hintDeviation).toEqual({ requested: 3, actual: 2 });
      expect(result.goals[1]!.dependsOn).toEqual(['types']);
      expect(result.goals[2]!.dependsOn).toEqual(['service', 'types']);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('without arcHint preserves decomposition observation without arc fields', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await decomposeSelfDevGoal('whole thing', {
        llm: async () => JSON.stringify({ subtasks: [{ id: 'a', feature: 'A' }, { id: 'b', feature: 'B' }] }),
      });
      const data = events.find(({ category, event }) => category === 'self-dev' && event === 'decomposition')!.data;
      expect(data).not.toHaveProperty('arcs');
      expect(data).not.toHaveProperty('hintDeviation');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test.each([
    ['missing coverage', [{ name: 'one', tasks: [1], dependsOn: [] }, { name: 'two', tasks: [2], dependsOn: [] }]],
    ['duplicate task', [{ name: 'one', tasks: [1, 2], dependsOn: [] }, { name: 'two', tasks: [2, 3], dependsOn: [] }]],
    ['unknown task', [{ name: 'one', tasks: [1], dependsOn: [] }, { name: 'two', tasks: [2, 4], dependsOn: [] }]],
    ['cycle', [{ name: 'one', tasks: [1], dependsOn: [2] }, { name: 'two', tasks: [2, 3], dependsOn: [1] }]],
    ['task ordering conflict', [{ name: 'one', tasks: [1], dependsOn: [] }, { name: 'two', tasks: [2, 3], dependsOn: [] }]],
  ])('invalid arc grouping (%s) falls back to the existing flat result', async (_reason, arcs) => {
    const llm = async (prompt: string) => prompt.startsWith('Group the decomposed')
      ? JSON.stringify({ arcs })
      : JSON.stringify({ subtasks: [
        { id: 'types', feature: 'Define types' },
        { id: 'service', feature: 'Implement service', dependsOn: ['types'] },
        { id: 'ui', feature: 'Render UI', dependsOn: ['service'] },
      ] });
    const result = await decomposeSelfDevGoal('whole thing', { llm, arcHint: 2 });
    expect(result.goals.map((goal) => goal.id)).toEqual(['types', 'service', 'ui']);
    expect(result.arcs).toBeUndefined();
    expect(result.hintDeviation).toBeUndefined();
  });

  test('classification LLM failure and invalid arcHint preserve or reject at their respective boundary', async () => {
    const result = await decomposeSelfDevGoal('whole thing', {
      llm: async () => JSON.stringify({ subtasks: [{ id: 'a', feature: 'A' }, { id: 'b', feature: 'B' }] }),
      arcHint: 2,
      arcLlm: async () => { throw new Error('classifier down'); },
    });
    expect(result.arcs).toBeUndefined();
    await expect(decomposeSelfDevGoal('whole thing', { llm: async () => '{}', arcHint: 1 })).rejects.toThrow('arcHint must be an integer from 2 to 6');
    await expect(decomposeSelfDevGoal('whole thing', { llm: async () => '{}', arcHint: 7 })).rejects.toThrow('arcHint must be an integer from 2 to 6');
  });
});
