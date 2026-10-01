import { expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import type { DispatchTaskInput } from './dispatch-task.js';
import { runDevPipeline, type DevPipelineDeps, type DevPipelineSpec } from '../self-dev/dev-pipeline.js';
import type { SelfImplementResult, SelfImplementSeams } from '../self-implement/orchestrator.js';
import { dispatchRunDevHarness } from '../skills/tools/dev-harness.js';
import { installHarnessCliCommand } from '../harness/harness-cli-command.js';
import * as podDispatch from '../harness/harness-pod-dispatch.js';

const goal = 'Implement feature';
const spec: DevPipelineSpec = { input: { text: goal }, humanReadableOutput: false, entrance: 'cli-harness-say' };

function countingDeps(calls: DispatchTaskInput[]): DevPipelineDeps {
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

async function withDispatchEnv(run: () => Promise<void>): Promise<void> {
  const depth = process.env.ELANOUS_NEST_DEPTH;
  const recorded = process.env.ELANOUS_DISPATCH_RECORDED;
  const disabled = process.env.ELANOUS_EXECUTION_LOOP_DISPATCH;
  delete process.env.ELANOUS_NEST_DEPTH;
  delete process.env.ELANOUS_DISPATCH_RECORDED;
  delete process.env.ELANOUS_EXECUTION_LOOP_DISPATCH;
  try {
    await run();
  } finally {
    if (depth === undefined) delete process.env.ELANOUS_NEST_DEPTH;
    else process.env.ELANOUS_NEST_DEPTH = depth;
    if (recorded === undefined) delete process.env.ELANOUS_DISPATCH_RECORDED;
    else process.env.ELANOUS_DISPATCH_RECORDED = recorded;
    if (disabled === undefined) delete process.env.ELANOUS_EXECUTION_LOOP_DISPATCH;
    else process.env.ELANOUS_EXECUTION_LOOP_DISPATCH = disabled;
  }
}

test('harness say dispatches once through the production CLI handler', async () => withDispatchEnv(async () => {
  const calls: DispatchTaskInput[] = [];
  const { program, setRunDevAskFromGoalFileDepsForTesting } = await import('../index.js');
  const previousExitCode = process.exitCode;
  setRunDevAskFromGoalFileDepsForTesting({
    runSayLaunchFlow: async () => ({ kind: 'launch', goalFile: 'test-goal.md' }),
    loadDevPipeline: async () => ({
      runDevPipeline: (launchSpec) => runDevPipeline({ ...launchSpec, input: { text: goal }, humanReadableOutput: false, completion: 'worktree-only' }, countingDeps(calls)),
      devResultOk: () => true,
    }),
  });
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'say', goal, '--substrate', 'local', '--no-supervise']);
    expect(process.exitCode).toBe(previousExitCode);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ goalText: goal, spec: { entrance: 'cli-harness-say' } });
  } finally {
    setRunDevAskFromGoalFileDepsForTesting(undefined);
    process.exitCode = previousExitCode;
  }
}));

test('nested interactive child does not dispatch', async () => withDispatchEnv(async () => {
  const calls: DispatchTaskInput[] = [];
  process.env.ELANOUS_NEST_DEPTH = '1';
  await runDevPipeline({ ...spec, context: 'interactive' }, countingDeps(calls));
  expect(calls).toHaveLength(0);
}));

test('relaunch does not dispatch', async () => withDispatchEnv(async () => {
  const calls: DispatchTaskInput[] = [];
  await runDevPipeline({ ...spec, relaunch: true }, countingDeps(calls));
  expect(calls).toHaveLength(0);
}));

test('parallel parent does not dispatch', async () => withDispatchEnv(async () => {
  const calls: DispatchTaskInput[] = [];
  await runDevPipeline({ ...spec, parallel: { goals: [{ feature: goal }] } }, countingDeps(calls));
  expect(calls).toHaveLength(0);
}));

test('RunDevHarness in-process dispatches once', async () => withDispatchEnv(async () => {
  const calls: DispatchTaskInput[] = [];
  await dispatchRunDevHarness({ objective: goal }, undefined, {
    dispatchTask: async (input) => {
      calls.push(input);
      return { cardId: 'card-test', decisions: {} as never, mode: 'observe' };
    },
    runHarness: async () => ({ runId: 'run-test', ok: true, terminal: 'no-changes', rounds: 0, state: {} }),
    seamsFactory: () => ({} as SelfImplementSeams),
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ goalText: goal });
}));

test('Pod substrate records on host once and marker suppresses dispatch inside Pod', async () => withDispatchEnv(async () => {
  const hostCalls: DispatchTaskInput[] = [];
  const childCalls: DispatchTaskInput[] = [];
  const childEnvs: NodeJS.ProcessEnv[] = [];
  const realPodDispatch = podDispatch.dispatchHarnessOnPod;
  const pod = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation((input) =>
    realPodDispatch(input, { run: (_cmd, _args, env) => { childEnvs.push(env); return 0; } }));
  try {
    const program = new Command();
    installHarnessCliCommand(program, {
      registerSink: async () => {}, resolveSurface: async () => 'test',
      say: async () => { throw new Error('Pod host must not run local say'); },
      podDispatchTask: async (input) => {
        hostCalls.push(input);
        return { cardId: 'card-test', decisions: {} as never, mode: 'observe' };
      },
    });
    await program.parseAsync(['harness', 'say', goal, '--substrate', 'pod', '--pod-pool', 'test-pool'], { from: 'user' });
    expect(hostCalls).toHaveLength(1);
    expect(hostCalls[0]).toMatchObject({ goalText: goal });
    expect(childEnvs).toHaveLength(1);
    expect(childEnvs[0]?.ELANOUS_DISPATCH_RECORDED).toBe('1');
    process.env.ELANOUS_DISPATCH_RECORDED = childEnvs[0]!.ELANOUS_DISPATCH_RECORDED;
    await runDevPipeline(spec, countingDeps(childCalls));
    expect(childCalls).toHaveLength(0);
  } finally {
    pod.mockRestore();
  }
}));
