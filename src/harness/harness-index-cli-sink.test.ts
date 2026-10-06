import { setDefaultTimeout, beforeAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import * as orchestrateCli from '../self-dev/orchestrate-cli.js';
import { OLD_DOOR_STAMP_ENV } from '../self-dev/old-door.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const calls: string[] = [];
const outputs = {
  run: { output: 'run output', ok: true },
  orchestrate: { ok: true as const, results: [{ taskId: 'task-1', feature: 'objective', status: 'done' as const }], exitCode: 0 },
};
let observedRunOutcome: typeof outputs.run | undefined;
const orchestrateInputs: Array<Record<string, unknown>> = [];

mock.module('../domains/standalone-log-sink.js', () => ({
  registerStandaloneLogSink: async (surface: string) => { calls.push(`sink:${surface}`); },
}));
mock.module('../self-dev/harness-run-cli.js', () => ({
  HARNESS_RUN_DEPRECATION_HELP: 'deprecated: use elanous dev --implement <objective>',
  runHarnessRunCliCommand: async () => ({ ok: false, message: 'ℹ️  `elanous harness run`은 deprecated 입구입니다 — `elanous dev --implement <objective>`로 이행하세요.', exitCode: 1 }),
  applyHarnessRunOutcomeExit: (outcome: object) => {
    calls.push('action:run');
    observedRunOutcome = outcome as typeof outputs.run;
  },
}));
const orchestrateCliMock = {
  ...orchestrateCli,
  runSelfOrchestrateCliCommand: async (input: Record<string, unknown>) => {
    calls.push('action:orchestrate');
    orchestrateInputs.push(input);
    return outputs.orchestrate;
  },
};
mock.module('../self-dev/orchestrate-cli.js', () => orchestrateCliMock);
mock.module('../self-dev/orchestrate-harness.js', () => ({
  orchestrateHarness: async () => {
    calls.push('legacy:orchestrateHarness');
    return [];
  },
}));

let program: Command;

beforeAll(async () => {
  ({ program } = await import('../index.js'));
  program.exitOverride();
});

describe('production harness CLI sink wiring', () => {
  test('a real process rejects --domain with guidance to self orchestrate', () => {
    const result = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'harness', 'orchestrate', '--domain', 'web', 'objective'], {
      cwd: process.cwd(),
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;

    expect(result.exitCode).not.toBe(0);
    expect(output).toContain('--domain');
    expect(output).toContain('elanous self orchestrate');
  });

  test('both actual index orchestrate entrances parse equivalent goals and options into one shared-seam call each', async () => {
    calls.length = 0;
    orchestrateInputs.length = 0;
    const args = ['objective', '--concurrency', '4', '--auto-review', '--json'];
    await program.parseAsync(['node', 'elanous', 'harness', 'orchestrate', ...args]);
    // `self orchestrate` is closed to outside callers (OLD-DOOR-CLOSE) and exits the process; the harness stamp keeps
    // this in-process call on the internal entrance so the test runner survives.
    const stamp = process.env[OLD_DOOR_STAMP_ENV];
    process.env[OLD_DOOR_STAMP_ENV] = 'cli-self-orchestrate';
    try {
      await program.parseAsync(['node', 'elanous', 'self', 'orchestrate', ...args]);
    } finally {
      if (stamp === undefined) delete process.env[OLD_DOOR_STAMP_ENV];
      else process.env[OLD_DOOR_STAMP_ENV] = stamp;
    }

    expect(orchestrateInputs).toHaveLength(2);
    for (const input of orchestrateInputs) {
      expect(input).toMatchObject({
        goals: [{ feature: 'objective', autoReview: true }],
        concurrency: 4,
        runtime: {},
      });
    }
    expect(calls.filter((call) => call === 'action:orchestrate')).toHaveLength(2);
    expect(calls).not.toContain('legacy:orchestrateHarness');
  });

  test('self orchestrate accepts every established option without Commander unknown-option rejection', () => {
    const self = program.commands.find((command) => command.name() === 'self')!;
    const orchestrate = self.commands.find((command) => command.name() === 'orchestrate')!;
    const optionFlags = orchestrate.options.map((option) => option.flags);

    for (const option of ['--concurrency <n>', '--auto-merge', '--auto-review', '--open-pr', '--base <branch>', '--teardown', '--resume <runId>', '--board', '--decompose', '--max-tasks <n>', '--fabric-decompose', '--no-supervise', '--supervise-rounds <n>', '--json']) {
      expect(optionFlags).toContain(option);
    }
  });

  test('the actual index harness run and orchestrate actions each receive one preceding sink registration', async () => {
    calls.length = 0;
    orchestrateInputs.length = 0;
    observedRunOutcome = undefined;
    await program.parseAsync(['node', 'elanous', 'harness', 'run', 'objective']);
    await program.parseAsync(['node', 'elanous', 'harness', 'orchestrate', 'objective']);

    expect(calls).toHaveLength(4);
    expect(calls[0]).toStartWith('sink:');
    expect(calls[1]).toBe('action:run');
    expect(calls[2]).toStartWith('sink:');
    expect(calls[3]).toBe('action:orchestrate');
    expect(calls[0]).toBe(calls[2]);
    expect(calls).not.toContain('legacy:orchestrateHarness');
    expect(orchestrateInputs).toHaveLength(1);
    expect(orchestrateInputs[0]).toMatchObject({ goals: [{ feature: 'objective' }], runtime: {} });
    expect(observedRunOutcome).toBeDefined();
    expect(observedRunOutcome).toMatchObject({ ok: false, exitCode: 1 });
  });

  test('harness --help hides dogfood and run while keeping them invokable', () => {
    const harness = program.commands.find((command) => command.name() === 'harness')!;
    const help = harness.helpInformation();
    expect(help).not.toMatch(/^\s*dogfood\b/m);
    expect(help).not.toMatch(/^\s*run \[options\]/m);
    expect(help).toContain('orchestrate');
    const dogfood = harness.commands.find((command) => command.name() === 'dogfood');
    const run = harness.commands.find((command) => command.name() === 'run');
    expect(dogfood).toBeDefined();
    expect(run).toBeDefined();
  });

  test('orchestrate CLI mock export names cover every production-consumed name', () => {
    const mockNames = Object.keys(orchestrateCliMock);
    const consumed = productionConsumedOrchestrateCliNames();
    const missing = missingOrchestrateCliMockNames(mockNames, consumed);
    expect(missing, `mock is missing: ${missing.join(', ')}`).toEqual([]);

    const omitted = missingOrchestrateCliMockNames(
      mockNames.filter((name) => name !== 'resolveOrchestrateStart'),
      consumed,
    );
    expect(omitted).toContain('resolveOrchestrateStart');
  });
});

function productionConsumedOrchestrateCliNames(source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')): string[] {
  const consumed = new Set<string>();
  const importPattern = /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*await import\('\.\/self-dev\/orchestrate-cli\.js'\)/g;
  const memberPattern = /\(await import\('\.\/self-dev\/orchestrate-cli\.js'\)\)\.(\w+)/g;
  for (const match of source.matchAll(importPattern)) {
    for (const binding of match[1]!.split(',')) {
      const name = binding.trim().split(/\s+as\s+/)[0]?.trim();
      if (name) consumed.add(name);
    }
  }
  for (const match of source.matchAll(memberPattern)) consumed.add(match[1]!);
  return [...consumed];
}

function missingOrchestrateCliMockNames(mockNames: readonly string[], consumed: readonly string[]): string[] {
  return consumed.filter((name) => !mockNames.includes(name));
}
