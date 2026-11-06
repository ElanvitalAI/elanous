import { describe, expect, test } from 'bun:test';
import { gradePhaseCompletability } from '../autopilot/mission-phase-granularity.js';
import { debug } from '../debug/log.js';
import type {
  GoalAuthoringGroundingDeps,
  GoalAuthoringGroundingResult,
} from '../self-implement/goal-authoring-grounding.js';
import type { SelfDevDecomposition } from './decompose.js';
import {
  decomposeFabricRequest,
  decomposeSelfDevGoalWithFabric,
} from './fabric-decompose-adapter.js';

const authoredRfc = [
  '# RFC — Fabric adapter',
  '```work-breakdown',
  '### 아크 1: Define adapter',
  '- [ ] Add the adapter module — Export the fabric seam.',
  '### 아크 2: Verify adapter',
  '- [ ] Add focused tests',
  '```',
].join('\n');

const decomposition = (goals: SelfDevDecomposition['goals']): SelfDevDecomposition => ({
  goals,
  decomposition: {
    recommendedMaxTasks: 6,
    actualTaskCount: goals.length,
    truncatedAtHardMax: false,
    exceededRecommendedMax: false,
    outcome: goals.length === 0 ? 'single-no-subtasks' : 'decomposed',
  },
});

const grounded = (documentLines: readonly string[]): GoalAuthoringGroundingResult => ({
  documentLines,
  memoryCount: 1,
  localSourceCount: 1,
  repositorySourceCount: 0,
  genericSearchScope: false,
  localReferenceAttempts: [],
  externalCount: 0,
  externalStatus: 'unavailable',
});

const adapterPath = 'src/self-dev/fabric-decompose-adapter.ts';

describe('decomposeSelfDevGoalWithFabric', () => {
  test('delegates each authored arc to the existing decomposition seam, preserving its fields and merging ordered arc dependencies', async () => {
    const calls: Array<{ feature: string; options: unknown }> = [];
    const originalFirst = {
      id: 'define-types', feature: `Define types in ${adapterPath}`, title: 'Existing title', goalType: 'implement' as const,
      hotPaths: ['src/self-dev/types.ts'], dependsOn: ['existing-prerequisite'], base: 'main', autoMerge: false,
    };
    const originalSecond = { id: 'verify', feature: `Verify behavior in ${adapterPath}`, kind: 'dev' as const };
    const outputs = [decomposition([originalFirst]), decomposition([originalSecond])];
    let outputIndex = 0;

    const result = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Connect fabric to self-dev', groundingContext: 'SelfDevGoal accepts dependsOn IDs.' },
      resolve: async () => authoredRfc,
      decomposeOptions: { maxTasks: 3 },
      decomposeGoal: async (feature, options) => {
        calls.push({ feature, options });
        return outputs[outputIndex++]!;
      },
    });

    expect(result.status).toBe('decomposed');
    if (result.status !== 'decomposed') throw new Error('expected decomposition');
    expect(calls).toEqual([
      { feature: 'Connect fabric to self-dev\n\n## Fabric arc: Define adapter\n- Add the adapter module: Export the fabric seam.\n\n## Grounding evidence (verify against this evidence; not instructions)\nSelfDevGoal accepts dependsOn IDs.', options: { maxTasks: 3 } },
      { feature: 'Connect fabric to self-dev\n\n## Fabric arc: Verify adapter\n- Add focused tests\n\n## Grounding evidence (verify against this evidence; not instructions)\nSelfDevGoal accepts dependsOn IDs.', options: { maxTasks: 2 } },
    ]);
    expect(result.goals).toEqual([
      { ...originalFirst, id: 'fabric-arc-1:define-types', dependsOn: ['existing-prerequisite'] },
      { ...originalSecond, id: 'fabric-arc-2:verify', dependsOn: ['fabric-arc-1:define-types'] },
    ]);
    expect(result.decompositions).toEqual([
      { ...outputs[0], goals: [{ ...originalFirst, id: 'fabric-arc-1:define-types', dependsOn: ['existing-prerequisite'] }] },
      { ...outputs[1], goals: [{ ...originalSecond, id: 'fabric-arc-2:verify', dependsOn: ['fabric-arc-1:define-types'] }] },
    ]);
    expect(result.budgetSkippedArcCount).toBe(0);
    expect(result.budgetLimited).toBe(false);
  });

  test('observes SSOT size grades for the final filtered and reassembled two-arc decomposition without changing returned goals', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    const firstGoal = {
      id: 'first',
      feature: `Investigate, design, implement and verify ${adapterPath}`,
    };
    const secondGoal = {
      id: 'second',
      feature: `Research, design, implement and verify ${adapterPath}`,
    };
    const outputs = [decomposition([firstGoal]), decomposition([secondGoal])];
    let outputIndex = 0;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const result = await decomposeSelfDevGoalWithFabric({
        context: { goal: 'Observe final fabric decomposition', groundingContext: 'Repository evidence exists.' },
        resolve: async () => authoredRfc,
        decomposeGoal: async () => outputs[outputIndex++]!,
      });

      if (result.status !== 'decomposed') throw new Error('expected decomposition');
      const expectedGoals = [
        { ...firstGoal, id: 'fabric-arc-1:first' },
        { ...secondGoal, id: 'fabric-arc-2:second', dependsOn: ['fabric-arc-1:first'] },
      ];
      const expectedGrades = expectedGoals.map((goal) => gradePhaseCompletability({
        id: goal.id,
        title: goal.feature,
        prompt: goal.feature,
        acceptance: [],
      }));
      const finalObservation = events.find(({ category, event }) => (
        category === 'self-dev' && event === 'fabric-decomposition'
      ))?.data;

      expect(result.goals).toEqual(expectedGoals);
      expect(finalObservation).toEqual({
        actualTaskCount: expectedGoals.length,
        tooLargeSubtaskCount: expectedGrades.filter(({ verdict }) => verdict === 'too_large').length,
        tooSmallSubtaskCount: expectedGrades.filter(({ verdict }) => verdict === 'too_small').length,
        hasMultipleTooLargeSubtasks: expectedGrades.filter(({ verdict }) => verdict === 'too_large').length >= 2,
      });
      expect(events.filter(({ event }) => event === 'fabric-decomposition')).toHaveLength(1);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('keeps the existing arc feature unchanged when no grounding context is present', async () => {
    const features: string[] = [];

    await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Connect fabric to self-dev', researchContext: 'RFC authoring research only.' },
      resolve: async () => authoredRfc,
      decomposeGoal: async (feature) => {
        features.push(feature);
        return decomposition([{ id: 'implement', feature: `Implement ${adapterPath}` }]);
      },
    });

    expect(features).toEqual([
      'Connect fabric to self-dev\n\n## Fabric arc: Define adapter\n- Add the adapter module: Export the fabric seam.',
      'Connect fabric to self-dev\n\n## Fabric arc: Verify adapter\n- Add focused tests',
    ]);
  });

  test('records no budget limitation when the final arc exactly consumes the total budget', async () => {
    const calls: unknown[] = [];
    const result = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Exact fabric budget', groundingContext: 'Repository evidence exists.' },
      resolve: async () => authoredRfc,
      decomposeOptions: { maxTasks: 2 },
      decomposeGoal: async (_feature, callOptions) => {
        calls.push(callOptions);
        return decomposition([{ id: 'kept', feature: `Update ${adapterPath}` }]);
      },
    });

    if (result.status !== 'decomposed') throw new Error('expected decomposition');
    expect(calls).toEqual([{ maxTasks: 2 }, { maxTasks: 1 }]);
    expect(result.goals).toHaveLength(2);
    expect(result.budgetSkippedArcCount).toBe(0);
    expect(result.budgetLimited).toBe(false);
  });

  test('uses one cumulative budget, passes the remaining budget to each arc, and skips later arcs after exhaustion', async () => {
    const threeArcRfc = authoredRfc.replace('```work-breakdown', '```work-breakdown\n### 아크 3: Finish adapter\n- [ ] Finish focused tests');
    const options = { maxTasks: 3, base: 'main' };
    const calls: Array<{ options: unknown }> = [];
    const result = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Budget fabric goals', groundingContext: 'Repository evidence exists.' },
      resolve: async () => threeArcRfc,
      decomposeOptions: options,
      decomposeGoal: async (_feature, callOptions) => {
        calls.push({ options: callOptions });
        return decomposition([
          { id: 'first', feature: `Update ${adapterPath}` },
          { id: 'second', feature: 'Update src/self-dev/fabric-decompose-adapter.test.ts' },
        ]);
      },
    });

    if (result.status !== 'decomposed') throw new Error('expected decomposition');
    expect(result.goals).toHaveLength(3);
    expect(calls).toEqual([
      { options: { maxTasks: 3, base: 'main' } },
      { options: { maxTasks: 1, base: 'main' } },
    ]);
    expect(calls[0]!.options).not.toBe(options);
    expect(options).toEqual({ maxTasks: 3, base: 'main' });
    expect(result.budgetSkippedArcCount).toBe(1);
    expect(result.budgetLimited).toBe(true);
  });

  test('keeps all goals and explicit zero budget metadata when the cumulative budget is not exhausted', async () => {
    const threeArcRfc = authoredRfc.replace('```work-breakdown', '```work-breakdown\n### 아크 3: Finish adapter\n- [ ] Finish focused tests');
    const result = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Budget fabric goals', groundingContext: 'Repository evidence exists.' },
      resolve: async () => threeArcRfc,
      decomposeOptions: { maxTasks: 10 },
      decomposeGoal: async () => decomposition([
        { id: 'first', feature: `Update ${adapterPath}` },
        { id: 'second', feature: 'Update src/self-dev/fabric-decompose-adapter.test.ts' },
      ]),
    });

    if (result.status !== 'decomposed') throw new Error('expected decomposition');
    expect(result.goals).toHaveLength(6);
    expect(result.budgetSkippedArcCount).toBe(0);
    expect(result.budgetLimited).toBe(false);
  });

  test('uses the decomposition default budget, handles an initial zero budget, and only charges retained goals', async () => {
    const threeArcRfc = authoredRfc.replace('```work-breakdown', '```work-breakdown\n### 아크 3: Finish adapter\n- [ ] Finish focused tests');
    const defaultCallOptions: unknown[] = [];
    const defaultResult = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Default fabric budget', groundingContext: 'Repository evidence exists.' },
      resolve: async () => threeArcRfc,
      decomposeGoal: async (_feature, callOptions) => {
        defaultCallOptions.push(callOptions);
        return decomposition([{ id: 'kept', feature: `Update ${adapterPath}` }]);
      },
    });
    const zeroCalls: unknown[] = [];
    const zeroResult = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Zero fabric budget', groundingContext: 'Repository evidence exists.' },
      resolve: async () => threeArcRfc,
      decomposeOptions: { maxTasks: 0 },
      decomposeGoal: async (_feature, callOptions) => {
        zeroCalls.push(callOptions);
        return decomposition([]);
      },
    });
    const filteredResult = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Filtered fabric budget', groundingContext: 'Repository evidence exists.' },
      resolve: async () => authoredRfc,
      decomposeOptions: { maxTasks: 1 },
      decomposeGoal: async () => decomposition([
        { id: 'omitted', feature: 'Update src/not-a-real-file.ts' },
        { id: 'kept', feature: `Update ${adapterPath}` },
      ]),
    });

    if (defaultResult.status !== 'decomposed' || zeroResult.status !== 'decomposed' || filteredResult.status !== 'decomposed') throw new Error('expected decompositions');
    expect(defaultCallOptions).toEqual([{ maxTasks: 6 }, { maxTasks: 5 }, { maxTasks: 4 }]);
    expect(defaultResult.budgetSkippedArcCount).toBe(0);
    expect(defaultResult.budgetLimited).toBe(false);
    expect(zeroCalls).toEqual([]);
    expect(zeroResult.goals).toEqual([]);
    expect(zeroResult.budgetSkippedArcCount).toBe(3);
    expect(zeroResult.budgetLimited).toBe(true);
    expect(filteredResult.goals).toHaveLength(1);
    expect(filteredResult.omittedGoalCount).toBe(1);
    expect(filteredResult.budgetSkippedArcCount).toBe(1);
    expect(filteredResult.budgetLimited).toBe(true);
  });

  test('normalizes negative and fractional total budgets to zero before calling the decomposition seam', async () => {
    const threeArcRfc = authoredRfc.replace('```work-breakdown', '```work-breakdown\n### 아크 3: Finish adapter\n- [ ] Finish focused tests');
    const negativeOptions = { maxTasks: -1, base: 'main' };
    const fractionalOptions = { maxTasks: 0.5, base: 'main' };
    const negativeCalls: unknown[] = [];
    const fractionalCalls: unknown[] = [];
    const negativeResult = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Negative fabric budget', groundingContext: 'Repository evidence exists.' },
      resolve: async () => threeArcRfc,
      decomposeOptions: negativeOptions,
      decomposeGoal: async (_feature, callOptions) => {
        negativeCalls.push(callOptions);
        return decomposition([{ id: 'must-not-run', feature: `Update ${adapterPath}` }]);
      },
    });
    const fractionalResult = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Fractional fabric budget', groundingContext: 'Repository evidence exists.' },
      resolve: async () => threeArcRfc,
      decomposeOptions: fractionalOptions,
      decomposeGoal: async (_feature, callOptions) => {
        fractionalCalls.push(callOptions);
        return decomposition([{ id: 'must-not-run', feature: `Update ${adapterPath}` }]);
      },
    });

    if (negativeResult.status !== 'decomposed' || fractionalResult.status !== 'decomposed') throw new Error('expected decompositions');
    expect(negativeCalls).toEqual([]);
    expect(fractionalCalls).toEqual([]);
    expect(negativeOptions).toEqual({ maxTasks: -1, base: 'main' });
    expect(fractionalOptions).toEqual({ maxTasks: 0.5, base: 'main' });
    for (const result of [negativeResult, fractionalResult]) {
      expect(result.goals).toEqual([]);
      expect(result.budgetSkippedArcCount).toBe(3);
      expect(result.budgetLimited).toBe(true);
    }
  });

  test('retains the adapter-level total cap when a decomposition seam returns more than its requested hard limit', async () => {
    const result = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Hard cap fabric goals', groundingContext: 'Repository evidence exists.' },
      resolve: async () => authoredRfc,
      decomposeOptions: { maxTasks: 3 },
      decomposeGoal: async () => decomposition([
        { id: 'one', feature: `Update ${adapterPath}` },
        { id: 'two', feature: `Update ${adapterPath}` },
        { id: 'three', feature: `Update ${adapterPath}` },
        { id: 'four', feature: `Update ${adapterPath}` },
      ]),
    });

    if (result.status !== 'decomposed') throw new Error('expected decomposition');
    expect(result.goals).toHaveLength(3);
    expect(result.budgetSkippedArcCount).toBe(1);
    expect(result.budgetLimited).toBe(true);
  });

  test('records budget limitation when the final arc returns more executable goals than its remaining budget', async () => {
    const outputs = [
      decomposition([{ id: 'first', feature: `Update ${adapterPath}` }]),
      decomposition([
        { id: 'second', feature: `Update ${adapterPath}` },
        { id: 'third', feature: `Update ${adapterPath}` },
        { id: 'fourth', feature: `Update ${adapterPath}` },
      ]),
    ];
    let outputIndex = 0;
    const result = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Final arc budget truncation', groundingContext: 'Repository evidence exists.' },
      resolve: async () => authoredRfc,
      decomposeOptions: { maxTasks: 3 },
      decomposeGoal: async () => outputs[outputIndex++]!,
    });

    if (result.status !== 'decomposed') throw new Error('expected decomposition');
    expect(result.goals).toHaveLength(3);
    expect(result.decompositions[1]!.goals).toHaveLength(2);
    expect(result.budgetSkippedArcCount).toBe(0);
    expect(result.budgetLimited).toBe(true);
  });

  test('prunes dependencies on same-arc goals removed by the total budget while preserving prior-arc dependencies', async () => {
    const outputs = [
      decomposition([{ id: 'prior', feature: `Update ${adapterPath}` }]),
      decomposition([
        { id: 'kept', feature: `Update ${adapterPath}`, dependsOn: ['removed'] },
        { id: 'removed', feature: `Update ${adapterPath}` },
      ]),
    ];
    let outputIndex = 0;
    const result = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Prune truncated dependencies', groundingContext: 'Repository evidence exists.' },
      resolve: async () => authoredRfc,
      decomposeOptions: { maxTasks: 2 },
      decomposeGoal: async () => outputs[outputIndex++]!,
    });

    if (result.status !== 'decomposed') throw new Error('expected decomposition');
    expect(result.goals).toEqual([
      { id: 'fabric-arc-1:prior', feature: `Update ${adapterPath}` },
      { id: 'fabric-arc-2:kept', feature: `Update ${adapterPath}`, dependsOn: ['fabric-arc-1:prior'] },
    ]);
    expect(result.decompositions[1]!.goals).toEqual([
      { id: 'fabric-arc-2:kept', feature: `Update ${adapterPath}`, dependsOn: ['fabric-arc-1:prior'] },
    ]);
    const ids = new Set(result.goals.map((goal) => goal.id));
    expect(result.goals.every((goal) => (goal.dependsOn ?? []).every((dependency) => ids.has(dependency)))).toBe(true);
    expect(result.budgetLimited).toBe(true);
  });

  test('namespaces duplicate local IDs and remaps local dependencies into a valid cross-arc DAG', async () => {
    const outputs = [
      decomposition([
        { id: 'types', feature: `Define types in ${adapterPath}` },
        { id: 'service', feature: `Implement service in ${adapterPath}`, dependsOn: ['types'] },
      ]),
      decomposition([
        { id: 'types', feature: `Verify types in ${adapterPath}` },
        { id: 'service', feature: `Verify service in ${adapterPath}`, dependsOn: ['types'] },
      ]),
    ];
    let outputIndex = 0;

    const result = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Connect fabric to self-dev', groundingContext: 'SelfDevGoal IDs form a DAG.' },
      resolve: async () => authoredRfc,
      decomposeGoal: async () => outputs[outputIndex++]!,
    });

    expect(result.status).toBe('decomposed');
    if (result.status !== 'decomposed') throw new Error('expected decomposition');
    expect(result.goals.map((goal) => goal.id)).toEqual([
      'fabric-arc-1:types',
      'fabric-arc-1:service',
      'fabric-arc-2:types',
      'fabric-arc-2:service',
    ]);
    expect(new Set(result.goals.map((goal) => goal.id)).size).toBe(result.goals.length);
    expect(result.goals.map((goal) => goal.dependsOn ?? [])).toEqual([
      [],
      ['fabric-arc-1:types'],
      ['fabric-arc-1:types', 'fabric-arc-1:service'],
      ['fabric-arc-2:types', 'fabric-arc-1:types', 'fabric-arc-1:service'],
    ]);
    const ids = new Set(result.goals.map((goal) => goal.id));
    expect(result.goals.every((goal) => (goal.dependsOn ?? []).every((dependency) => ids.has(dependency) && dependency !== goal.id))).toBe(true);
  });

  test('retains only existing repository-file goals, counts direct and dependent omissions, and preserves valid dependencies', async () => {
    const result = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Filter fabric goals', groundingContext: 'Repository evidence exists.' },
      resolve: async () => authoredRfc,
      decomposeGoal: async () => decomposition([
        { id: 'keep', feature: 'Implement the API symbol', hotPaths: [adapterPath] },
        { id: 'placeholder', feature: 'Implement the existing published symbol' },
        { id: 'missing', feature: 'Update src/missing.ts handler()' },
        { id: 'directory', feature: 'Update src/self-dev' },
        { id: 'outside', feature: 'Update ../../outside.ts' },
        { id: 'dependent', feature: `Test ${adapterPath}`, dependsOn: ['missing'] },
      ]),
    });

    expect(result.status).toBe('decomposed');
    if (result.status !== 'decomposed') throw new Error('expected decomposition');
    expect(result.goals).toEqual([
      { id: 'fabric-arc-1:keep', feature: 'Implement the API symbol', hotPaths: [adapterPath] },
      { id: 'fabric-arc-2:keep', feature: 'Implement the API symbol', hotPaths: [adapterPath], dependsOn: ['fabric-arc-1:keep'] },
    ]);
    expect(result.decompositions.map((entry) => entry.goals)).toEqual([
      [{ id: 'fabric-arc-1:keep', feature: 'Implement the API symbol', hotPaths: [adapterPath] }],
      [{ id: 'fabric-arc-2:keep', feature: 'Implement the API symbol', hotPaths: [adapterPath], dependsOn: ['fabric-arc-1:keep'] }],
    ]);
    expect(result.decompositions.map((entry) => entry.decomposition)).toEqual([
      { recommendedMaxTasks: 6, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
      { recommendedMaxTasks: 6, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
    ]);
    expect(result.omittedGoalCount).toBe(10);
    const ids = new Set(result.goals.map((goal) => goal.id));
    expect(result.goals.every((goal) => (goal.dependsOn ?? []).every((dependency) => ids.has(dependency)))).toBe(true);
  });

  test('recalculates an all-omitted arc decomposition from its empty retained goals', async () => {
    const result = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Omit fabric goals', groundingContext: 'Repository evidence exists.' },
      resolve: async () => '# RFC — One arc\n```work-breakdown\n### 아크 1: Omit\n- [ ] Omit invalid task\n```',
      decomposeGoal: async () => decomposition([{ id: 'missing', feature: 'Update src/missing.ts handler()' }]),
    });

    expect(result.status).toBe('decomposed');
    if (result.status !== 'decomposed') throw new Error('expected decomposition');
    expect(result.goals).toEqual([]);
    expect(result.omittedGoalCount).toBe(1);
    expect(result.decompositions).toEqual([{
      goals: [],
      decomposition: {
        recommendedMaxTasks: 6,
        actualTaskCount: 0,
        truncatedAtHardMax: false,
        exceededRecommendedMax: false,
        outcome: 'single-no-subtasks',
      },
    }]);
  });

  test('preserves every goal and records zero omissions when all goals name existing repository files', async () => {
    const result = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Keep fabric goals', groundingContext: 'Repository evidence exists.' },
      resolve: async () => authoredRfc,
      decomposeGoal: async () => decomposition([
        { id: 'adapter', feature: `Implement ${adapterPath}` },
        { id: 'test', feature: 'Implement src/self-dev/fabric-decompose-adapter.test.ts', dependsOn: ['adapter'] },
      ]),
    });

    expect(result.status).toBe('decomposed');
    if (result.status !== 'decomposed') throw new Error('expected decomposition');
    expect(result.goals).toHaveLength(4);
    expect(result.omittedGoalCount).toBe(0);
  });

  test('rejects missing research context before authoring or decomposition seams are called', async () => {
    let authorCalls = 0;
    let decomposeCalls = 0;
    const result = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Connect fabric to self-dev' },
      resolve: async () => { authorCalls += 1; return authoredRfc; },
      decomposeGoal: async () => { decomposeCalls += 1; return decomposition([]); },
    });

    expect(result).toEqual({
      status: 'missing-research-context',
      message: 'fabric decomposition requires groundingContext or researchContext',
    });
    expect(authorCalls).toBe(0);
    expect(decomposeCalls).toBe(0);
  });

  test('keeps an authored empty arc list distinct from fabric authoring failure without relabeling either as decomposition failure', async () => {
    const empty = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Atomic task', researchContext: 'Research says this is atomic.' },
      resolve: async () => '# RFC — Atomic\nNo work breakdown.',
      decomposeGoal: async () => { throw new Error('must not decompose empty arcs'); },
    });
    const failed = await decomposeSelfDevGoalWithFabric({
      context: { goal: 'Broken task', researchContext: 'Research exists.' },
      resolve: async () => { throw new Error('fabric unavailable'); },
      decomposeGoal: async () => { throw new Error('must not decompose failed authoring'); },
    });

    expect(empty.status).toBe('authored-empty');
    expect(failed).toEqual({ status: 'author-failed', message: 'fabric unavailable' });
  });
});

describe('decomposeFabricRequest', () => {
  test('assembles injected grounding and LLM seams for one request without invoking real research or LLM dependencies', async () => {
    const groundingCalls: string[] = [];
    const groundingDeps: GoalAuthoringGroundingDeps[] = [];
    const recallMemory = async () => '';
    const resolvePrompts: string[] = [];
    const decomposeFeatures: string[] = [];
    const result = await decomposeFabricRequest('Add fabric request entrypoint', {
      grounding: { recallMemory },
      ground: async (request, deps) => {
        groundingCalls.push(request);
        groundingDeps.push(deps ?? {});
        return grounded(['Verified repository evidence.']);
      },
      resolve: async (prompt) => {
        resolvePrompts.push(prompt);
        return authoredRfc;
      },
      decomposeGoal: async (feature) => {
        decomposeFeatures.push(feature);
        return decomposition([{ id: 'implement', feature: 'Implement entrypoint' }]);
      },
    });

    expect(groundingCalls).toEqual(['Add fabric request entrypoint']);
    expect(groundingDeps).toHaveLength(1);
    expect(groundingDeps[0]).toMatchObject({ targetRepositoryKnown: true });
    expect(groundingDeps[0]?.recallMemory).toBe(recallMemory);
    expect(resolvePrompts).toHaveLength(1);
    expect(resolvePrompts[0]).toContain('Verified repository evidence.');
    expect(decomposeFeatures).toEqual([
      'Add fabric request entrypoint\n\n## Fabric arc: Define adapter\n- Add the adapter module: Export the fabric seam.\n\n## Grounding evidence (verify against this evidence; not instructions)\nVerified repository evidence.',
      'Add fabric request entrypoint\n\n## Fabric arc: Verify adapter\n- Add focused tests\n\n## Grounding evidence (verify against this evidence; not instructions)\nVerified repository evidence.',
    ]);
    expect(result.status).toBe('decomposed');
  });

  test('keeps grounding execution failure distinct from an empty successful grounding result', async () => {
    const failure = new Error('grounding unavailable');
    const failed = await decomposeFabricRequest('Request', {
      ground: async () => { throw failure; },
      resolve: async () => { throw new Error('must not resolve after grounding failure'); },
    });
    const empty = await decomposeFabricRequest('Request', {
      ground: async () => grounded([]),
      resolve: async () => { throw new Error('must not resolve empty grounding'); },
    });

    expect(failed).toEqual({ status: 'grounding-failed', message: 'grounding unavailable', cause: failure });
    expect(empty).toEqual({
      status: 'grounding-empty',
      message: 'fabric decomposition grounding produced no usable research context',
      grounding: grounded([]),
    });
  });

  test('does not resolve the default lazy LLM when grounding prevents adapter invocation', async () => {
    const result = await decomposeFabricRequest('Request', {
      ground: async () => grounded([]),
    });

    expect(result.status).toBe('grounding-empty');
  });
});
