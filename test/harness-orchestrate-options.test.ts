import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildHarnessOrchestratePlan, runHarnessOrchestrateExecution, type HarnessOrchestrateExecutionPlan } from '../src/index.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const CLI = resolve(import.meta.dir, '..', 'bin', 'elanous.mjs');

function runCli(args: string[]): { code: number; out: string } {
  const result = spawnSync('bun', [CLI, '--test', ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'development' },
  });
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('elanous harness orchestrate — self orchestrate option parity', () => {
  it('--help exposes --auto-review and --decompose', () => {
    const result = runCli(['harness', 'orchestrate', '--help']);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('--auto-review');
    expect(result.out).toContain('--decompose');
  });

  it('omitting the new options preserves the existing default plan shape', () => {
    expect(buildHarnessOrchestratePlan(['one', 'two'], {})).toEqual({
      ok: true,
      goals: [{ feature: 'one' }, { feature: 'two' }],
      runtime: {},
      spec: {
        entrance: 'cli-harness-orchestrate',
        input: { text: 'one ;; two' },
        executor: { kind: 'self' },
        parallel: { goals: [{ feature: 'one' }, { feature: 'two' }] },
      },
    });
  });

  it('passes explicit --auto-review and --decompose values into preparation and execution', async () => {
    const plan = buildHarnessOrchestratePlan(['parent goal'], { autoReview: true, decompose: true });
    expect(plan.ok).toBe(true);
    const executionPlan = plan as HarnessOrchestrateExecutionPlan;
    expect(executionPlan.autoReview).toBe(true);
    expect(executionPlan.decompose).toBe(true);
    expect(executionPlan.goals).toEqual([{ feature: 'parent goal', autoReview: true }]);

    const seen: Array<{ decompose?: boolean; autoReview?: boolean }> = [];
    await runHarnessOrchestrateExecution(executionPlan, ['parent goal'], {
      prepareGoals: async (input) => {
        seen.push({ decompose: input.decompose, autoReview: input.autoReview });
        return { ok: true, goals: input.goals };
      },
      runCommand: async (input) => {
        expect(input.goals).toEqual([{ feature: 'parent goal', autoReview: true }]);
        return { ok: true, results: [], exitCode: 0 };
      },
      resolveRunIdentity: () => ({ runId: 'test-run', source: 'minted' }),
      saveRun: () => undefined,
      addParticipant: () => undefined,
      checkpointDependencies: () => undefined,
      resolveStart: ({ explicit }) => ({ concurrency: explicit, announcement: 'start' }),
      writeInfo: () => undefined,
      writeOutput: () => undefined,
      writeError: () => undefined,
      setExitCode: () => undefined,
      getEnv: () => undefined,
      setEnv: () => undefined,
      now: () => 1,
      pid: 123,
    });

    expect(seen).toEqual([{ decompose: true, autoReview: true }]);
  });

  it('still rejects options that are not attached to harness orchestrate by name', () => {
    const result = runCli(['harness', 'orchestrate', 'goal', '--fabric-decompose']);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain('unknown option');
    expect(result.out).toContain('--fabric-decompose');
  });
});
