import { expect, test, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { CardStore } from '../task-cards/card-store.js';
import { budgetGate, placementGate, relationGate, memoryGate } from '../execution-loop/gates.js';
import type { DispatchTaskInput } from '../execution-loop/dispatch-task.js';
import type { SelfImplementResult, SelfImplementSeams } from '../self-implement/orchestrator.js';
import { runDevPipeline, type DevPipelineDeps, type DevPipelineSpec } from './dev-pipeline.js';

const base: DevPipelineSpec = { input: { text: 'Implement feature' }, humanReadableOutput: false };

function fakeDeps(calls: DispatchTaskInput[]): DevPipelineDeps {
  return {
    dispatchTask: async (input) => {
      calls.push(input);
      return { cardId: 'card-test', decisions: {} as never, mode: 'observe' };
    },
    runSelfImplement: async () => ({ ok: true } as SelfImplementResult),
    buildSelfImplementSeams: () => ({} as SelfImplementSeams),
    runChatTurn: async () => {},
    orchestrateSelfDev: async () => [],
  };
}

test('dispatch decision is made after planning, exactly once before the original execution', async () => {
  const order: string[] = [];
  const calls: DispatchTaskInput[] = [];
  const deps = fakeDeps(calls);
  deps.dispatchTask = async (input) => {
    order.push('dispatch');
    calls.push(input);
    return { cardId: 'card-test', decisions: {} as never, mode: 'observe' };
  };
  deps.runSelfImplement = async () => {
    order.push('execute');
    return { ok: true } as SelfImplementResult;
  };
  const result = await runDevPipeline(base, deps);
  expect(order).toEqual(['dispatch', 'execute']);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.spec).toBe(base);
  expect(result.kind).toBe('self');
  expect(result.plan.dispatch).toBe('self-mission');

  calls.length = 0;
  await expect(runDevPipeline({ ...base, input: { text: 'x' }, entrance: 'unregistered' as DevPipelineSpec['entrance'] }, deps))
    .rejects.toThrow(/알 수 없는 입구 id/);
  expect(calls).toHaveLength(0);
});

test('only the enumerated skip conditions omit the observation; other interactive and relaunch:false runs still dispatch', async () => {
  const calls: DispatchTaskInput[] = [];
  const deps = fakeDeps(calls);
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    if (category === 'execution-loop.gate') logs.push({ event, data: data ?? {} });
  }) as typeof debug.log);
  const priorDepth = process.env.ELANOUS_NEST_DEPTH;
  const priorRecorded = process.env.ELANOUS_DISPATCH_RECORDED;
  try {
    delete process.env.ELANOUS_NEST_DEPTH;
    delete process.env.ELANOUS_DISPATCH_RECORDED;
    await runDevPipeline({ ...base, context: 'interactive' }, deps);
    await runDevPipeline({ ...base, relaunch: false }, deps);
    process.env.ELANOUS_DISPATCH_RECORDED = '0';
    await runDevPipeline(base, deps);
    delete process.env.ELANOUS_DISPATCH_RECORDED;
    expect(calls).toHaveLength(3);

    process.env.ELANOUS_NEST_DEPTH = '1';
    await runDevPipeline({ ...base, context: 'interactive' }, deps);
    await runDevPipeline(base, deps);
    expect(calls).toHaveLength(4);
    delete process.env.ELANOUS_NEST_DEPTH;
    await runDevPipeline({ ...base, relaunch: true }, deps);
    await runDevPipeline({ ...base, parallel: { goals: [{ feature: 'goal' }] } }, deps);
    await runDevPipeline(base, { ...deps, skipDispatchTask: true });
    process.env.ELANOUS_DISPATCH_RECORDED = '1';
    await runDevPipeline(base, deps);
    expect(calls).toHaveLength(4);
    expect(logs.filter(({ event }) => event === 'dispatch-skipped').map(({ data }) => data.reason)).toEqual([
      'nested-interactive', 'relaunch', 'parallel-parent', 'skipDispatchTask', 'dispatch-recorded',
    ]);
  } finally {
    if (priorDepth === undefined) delete process.env.ELANOUS_NEST_DEPTH;
    else process.env.ELANOUS_NEST_DEPTH = priorDepth;
    if (priorRecorded === undefined) delete process.env.ELANOUS_DISPATCH_RECORDED;
    else process.env.ELANOUS_DISPATCH_RECORDED = priorRecorded;
    log.mockRestore();
  }
});

test('default dispatch completes its gate observation before the execution and return', async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const card = { id: 'card-default', goalId: 'goal-default', title: 'test', status: 'open', createdAt: new Date().toISOString(), sections: [] } as const;
  const sections: string[] = [];
  const store = {
    createCard: () => { started.resolve(); return card; },
    listCards: () => [card],
    appendSection: (_id: string, section: { key: string }) => { sections.push(section.key); return card; },
    close: () => {},
  } as unknown as CardStore;
  let executed = false;
  let returned = false;
  const run = runDevPipeline(base, {
    ...fakeDeps([]),
    dispatchTask: undefined,
    dispatchTaskDeps: {
      createStore: () => store,
      budgetGate: async (...args) => { await finish.promise; return budgetGate(...args); },
      placementGate,
      relationGate,
      memoryGate,
      emitDecision: () => {},
    },
    runSelfImplement: async () => { executed = true; return { ok: true } as SelfImplementResult; },
  }).then((result) => { returned = true; return result; });
  try {
    await started.promise;
    expect(executed).toBe(false);
    expect(returned).toBe(false);
    expect(sections).toHaveLength(0);
  } finally {
    finish.resolve();
  }
  const result = await run;
  expect(sections).toHaveLength(3);
  expect(executed).toBe(true);
  expect(returned).toBe(true);
  expect(result.kind).toBe('self');
});

test('dispatch errors are observed but do not stop the existing launch or alter the result', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  let launched = 0;
  try {
    const result = await runDevPipeline(base, {
      ...fakeDeps([]),
      dispatchTask: async () => { throw new Error('card unavailable'); },
      runSelfImplement: async () => { launched++; return { ok: true } as SelfImplementResult; },
    });
    expect(result.kind).toBe('self');
    expect(launched).toBe(1);
    expect(log).toHaveBeenCalledWith('execution-loop.gate', 'dispatch-unavailable', { reason: 'Error: card unavailable' });
  } finally { log.mockRestore(); }
});

test('the test-only switch skips only an uninjected default dispatch', async () => {
  const previous = process.env.ELANOUS_EXECUTION_LOOP_DISPATCH;
  process.env.ELANOUS_EXECUTION_LOOP_DISPATCH = 'off';
  const log = spyOn(debug, 'log');
  try {
    const calls: DispatchTaskInput[] = [];
    await runDevPipeline(base, fakeDeps(calls));
    expect(calls).toHaveLength(1);
    const { dispatchTask: _ignored, ...uninjected } = fakeDeps([]);
    await runDevPipeline(base, uninjected);
    expect(log.mock.calls.some(([category, event, data]) => category === 'execution-loop.gate' && event === 'dispatch-skipped'
      && (data as { reason?: string })?.reason === 'disabled')).toBe(true);
  } finally {
    log.mockRestore();
    if (previous === undefined) delete process.env.ELANOUS_EXECUTION_LOOP_DISPATCH;
    else process.env.ELANOUS_EXECUTION_LOOP_DISPATCH = previous;
  }
});
