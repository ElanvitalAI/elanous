import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { installHarnessCliCommand } from './harness-cli-command.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repoRoot = resolve(import.meta.dir, '../..');
const elanousBin = join(repoRoot, 'bin/elanous.mjs');
const stackFramePattern = /(^|\n)\s+at\s+[^\n]+/;

function productionHarness(
  registerSink: (surface: string) => Promise<void>,
  deliverableVerify?: Parameters<typeof installHarnessCliCommand>[1]['deliverableVerify'],
  ask?: Parameters<typeof installHarnessCliCommand>[1]['ask'],
  say?: Parameters<typeof installHarnessCliCommand>[1]['say'],
  plan?: Parameters<typeof installHarnessCliCommand>[1]['plan'],
) {
  const program = new Command().exitOverride();
  const harnessCmd = installHarnessCliCommand(program, {
    registerSink,
    resolveSurface: async () => 'harness',
    deliverableVerify,
    ask,
    say,
    plan,
  });
  return { program, harnessCmd };
}

function installRepresentativeProductionActions(harnessCmd: Command, calls: string[], outputs: Record<string, object>, returned: Record<string, object | undefined>): void {
  for (const name of ['run-detached', 'run', 'orchestrate']) {
    harnessCmd.command(name).action(() => {
      calls.push(`action:${name}`);
      returned[name] = outputs[name]!;
      return outputs[name]! as unknown as void;
    });
  }
}

afterEach(() => {
  process.exitCode = 0;
});

async function captureConsoleError(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return lines;
}

type HarnessHelpCommand = {
  readonly name: string;
  readonly requiresArgument: boolean;
};

type ElanousCliRun = {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: Error | undefined;
  readonly output: string;
};

type HarnessEntranceMeasurement = {
  readonly helpVisible: readonly string[];
  readonly excludedNoArgumentCommands: readonly string[];
  readonly argumentRequiringCommands: readonly string[];
};

function runElanousCli(args: string[]): ElanousCliRun {
  const result = spawnSync('bun', [elanousBin, '--test', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 30_000,
  });
  return { status: result.status, signal: result.signal, error: result.error, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function expectCleanIntegerExit(run: ElanousCliRun): number {
  expect(run.error).toBeUndefined();
  expect(run.signal).toBeNull();
  expect(typeof run.status).toBe('number');
  return run.status as number;
}

function harnessHelpCommandRows(help: string): string[] {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'Commands:');
  expect(start).toBeGreaterThanOrEqual(0);
  const rows: string[] = [];
  const unparsedCommandRows: string[] = [];
  const commandRowPattern = /^  (?<signature>\S+(?:\s+(?:\[[^\]]+\]|<[^>]+>))*)(?:\s{2,}.+)?$/;
  const wrappedDescriptionPattern = /^ {4,}\S/;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    if (commandRowPattern.test(line)) {
      rows.push(line);
    } else if (!wrappedDescriptionPattern.test(line)) {
      unparsedCommandRows.push(line);
    }
  }
  if (unparsedCommandRows.length > 0) {
    throw new Error(`unparsed harness help command row(s):\n${unparsedCommandRows.join('\n')}`);
  }
  return rows;
}

function parseHarnessHelpCommands(help: string): HarnessHelpCommand[] {
  return harnessHelpCommandRows(help).map((row) => {
    const signature = row.trim().split(/\s{2,}/)[0]!;
    const name = signature.split(/\s+/)[0]!;
    return { name, requiresArgument: /<[^>]+>/.test(signature) };
  });
}

function measureHarnessEntranceContract(help: string, runCommandWithoutArguments: (name: string) => ElanousCliRun): HarnessEntranceMeasurement {
  const commands = parseHarnessHelpCommands(help);
  expect(commands.length).toBeGreaterThan(0);

  const helpVisible = commands.map((command) => command.name);
  const excludedNoArgumentCommands = commands
    .filter((command) => !command.requiresArgument)
    .map((command) => command.name);
  const argumentRequiringCommands = commands.filter((command) => command.requiresArgument);

  if (excludedNoArgumentCommands.length === 0) {
    throw new Error('harness entrance contract found no no-argument commands to exclude');
  }
  console.info(`harness entrance contract excludes no-argument commands from no-arg failure checks: ${excludedNoArgumentCommands.join(', ')}`);
  expect(argumentRequiringCommands.length).toBeGreaterThan(0);

  for (const command of argumentRequiringCommands) {
    const run = runCommandWithoutArguments(command.name);
    const status = expectCleanIntegerExit(run);
    expect(status).not.toBe(0);
    expect(run.output).not.toMatch(stackFramePattern);
  }

  return {
    helpVisible,
    excludedNoArgumentCommands,
    argumentRequiringCommands: argumentRequiringCommands.map((command) => command.name),
  };
}

describe('harness CLI sink hook', () => {
  test('production harness installer runs the sink once before every formerly action-owned command and preserves each action output', async () => {
    const calls: string[] = [];
    const outputs = {
      'run-detached': { output: 'detached' },
      run: { output: 'run' },
      orchestrate: { output: 'orchestrate' },
    };
    const returned: Record<string, object | undefined> = {};
    const { program, harnessCmd } = productionHarness(async (surface) => { calls.push(`sink:${surface}`); });
    installRepresentativeProductionActions(harnessCmd, calls, outputs, returned);

    for (const name of Object.keys(outputs)) {
      await program.parseAsync(['node', 'elanous', 'harness', name]);
    }

    expect(calls).toEqual([
      'sink:harness', 'action:run-detached',
      'sink:harness', 'action:run',
      'sink:harness', 'action:orchestrate',
    ]);
    expect(returned).toEqual(outputs);
  });

  test('production harness installer delegates deliverable-verify with the supplied goal path', async () => {
    const output: string[] = [];
    const { program, harnessCmd } = productionHarness(async () => {}, {
      readGoal: async (path) => {
        expect(path).toBe('/goals/installed.md');
        return '# Goal\n\n## 산출물을 어떻게 켜나\nPort: 4312\n';
      },
      verify: async () => ({ ok: true, url: 'http://127.0.0.1:4312', findings: [] }),
      write: (text) => output.push(text),
    });

    expect(harnessCmd.commands.map((command) => command.name())).toContain('deliverable-verify');
    await program.parseAsync(['node', 'elanous', 'harness', 'deliverable-verify', '/goals/installed.md']);
    expect(output.join('')).toContain('[deliverable verify] /goals/installed.md');
  });

  test('sink registration failure is fail-open and the production Commander action completes with its output', async () => {
    const calls: string[] = [];
    const output = { output: 'preserved despite sink failure' };
    let returned: typeof output | undefined;
    const { program, harnessCmd } = productionHarness(async () => {
      calls.push('sink');
      throw new Error('sink unavailable');
    });
    harnessCmd.command('run').action(() => {
      calls.push('action:run');
      returned = output;
      return output as unknown as void;
    });

    const result = await program.parseAsync(['node', 'elanous', 'harness', 'run']);

    expect(calls).toEqual(['sink', 'action:run']);
    expect(returned).toBe(output);
    expect(result).toBe(program);
  });

  test('ask is absent from harness subcommands when no ask handler is injected', () => {
    const { harnessCmd } = productionHarness(async () => {});
    const names = harnessCmd.commands.map((command) => command.name());
    expect(names).not.toContain('ask');
    expect(names).toContain('deliverable-verify');
  });

  test('ask is present on harness subcommands only when an ask handler is injected', () => {
    const { harnessCmd } = productionHarness(async () => {}, undefined, async () => {});
    const names = harnessCmd.commands.map((command) => command.name());
    expect(names).toContain('ask');
    expect(names).toContain('deliverable-verify');
  });

  test('injected ask forwards the received goal path unchanged with default options and still runs the sink first', async () => {
    const calls: string[] = [];
    const received: Array<{ path: string; opts: object }> = [];
    const goalPath = '/goals/exact path.md';
    const { program } = productionHarness(
      async (surface) => { calls.push(`sink:${surface}`); },
      undefined,
      async (path, opts) => {
        calls.push('ask');
        received.push({ path, opts });
      },
    );

    await program.parseAsync(['node', 'elanous', 'harness', 'ask', goalPath]);

    expect(received).toEqual([{ path: goalPath, opts: { supervise: true, supervisorSource: 'default' } }]);
    expect(calls).toEqual(['sink:harness', 'ask']);
  });

  test('ask help exposes exactly the landed launch knobs (a new option must be added here on purpose)', () => {
    const { harnessCmd } = productionHarness(async () => {}, undefined, async () => {});
    const ask = harnessCmd.commands.find((command) => command.name() === 'ask');

    expect(ask?.options.map((option) => option.long)).toEqual([
      '--json',
      '--base',
      '--no-auto-merge',
      '--merge-by-host',
      '--observe-only',
      '--no-supervise',
      '--dry-run',
      '--nested-elanous',
      '--target',
      '--yes',
      '--correlation',
      '--seat',
      '--no-queue',
      '--goal-type',
      '--force-preflight',
      '--force-gate',
      '--child-llm-provider',
      '--child-llm-model',
      '--child-llm-effort',
      '--substrate',
      '--pod-pool',
      '--pod-memory',
      '--after',
      '--source',
    ]);
  });

  test('injected ask forwards the four promoted dev knobs', async () => {
    const received: Array<{ path: string; opts: object }> = [];
    const { program } = productionHarness(
      async () => {},
      undefined,
      async (path, opts) => { received.push({ path, opts }); },
    );

    await program.parseAsync(['node', 'elanous', 'harness', 'ask', '--json', '--base', 'main', '--no-auto-merge', '--observe-only', '/goals/goal.md']);

    expect(received).toEqual([{ path: '/goals/goal.md', opts: { json: true, base: 'main', autoMerge: false, observeOnly: true, supervise: true, supervisorSource: 'default' } }]);
  });

  test('ask rejects unpromoted dev knobs by name', async () => {
    const { program } = productionHarness(async () => {}, undefined, async () => {});

    await expect(program.parseAsync(['node', 'elanous', 'harness', 'ask', '--plan', '/goals/goal.md'])).rejects.toThrow(/unknown option '--plan'/i);
  });

  test('injected ask without the required goal path ends with a non-zero Commander rejection', async () => {
    let called = 0;
    const { program } = productionHarness(async () => {}, undefined, async () => { called += 1; });

    await expect(program.parseAsync(['node', 'elanous', 'harness', 'ask'])).rejects.toThrow(/missing required argument/i);
    expect(called).toBe(0);
  });

  test('say is absent from harness subcommands when no say handler is injected', () => {
    const { harnessCmd } = productionHarness(async () => {});
    const names = harnessCmd.commands.map((command) => command.name());
    expect(names).not.toContain('say');
    expect(names).not.toContain('ask');
    expect(names).toContain('deliverable-verify');
  });

  test('say is present on harness subcommands only when a say handler is injected', () => {
    const { harnessCmd } = productionHarness(async () => {}, undefined, undefined, async () => {});
    const names = harnessCmd.commands.map((command) => command.name());
    expect(names).toContain('say');
    expect(names).not.toContain('ask');
    expect(names).toContain('deliverable-verify');
  });

  test('injected say forwards every received sentence word with default options and still runs the sink first', async () => {
    const calls: string[] = [];
    const received: Array<{ words: string[]; opts: object }> = [];
    const { program } = productionHarness(
      async (surface) => { calls.push(`sink:${surface}`); },
      undefined,
      undefined,
      async (words, opts) => {
        calls.push('say');
        received.push({ words, opts });
      },
    );

    await program.parseAsync(['node', 'elanous', 'harness', 'say', 'write', 'the', 'goal']);

    expect(received).toEqual([{ words: ['write', 'the', 'goal'], opts: { supervise: true, supervisorSource: 'default' } }]);
    expect(calls).toEqual(['sink:harness', 'say']);
  });

  test('say help exposes exactly the landed launch knobs (a new option must be added here on purpose)', () => {
    const { harnessCmd } = productionHarness(async () => {}, undefined, undefined, async () => {});
    const say = harnessCmd.commands.find((command) => command.name() === 'say');

    expect(say?.options.map((option) => option.long)).toEqual([
      '--json',
      '--base',
      '--no-auto-merge',
      '--merge-by-host',
      '--observe-only',
      '--no-supervise',
      '--dry-run',
      '--nested-elanous',
      '--target',
      '--yes',
      '--correlation',
      '--seat',
      '--no-queue',
      '--goal-type',
      '--force-preflight',
      '--force-gate',
      '--child-llm-provider',
      '--child-llm-model',
      '--child-llm-effort',
      '--substrate',
      '--pod-pool',
      '--pod-memory',
      '--after',
      '--source',
      '--author-grade',
    ]);
  });

  test('injected say forwards the four promoted dev knobs', async () => {
    const received: Array<{ words: string[]; opts: object }> = [];
    const { program } = productionHarness(
      async () => {},
      undefined,
      undefined,
      async (words, opts) => { received.push({ words, opts }); },
    );

    await program.parseAsync(['node', 'elanous', 'harness', 'say', '--json', '--base', 'release', '--no-auto-merge', '--observe-only', 'write', 'goal']);

    expect(received).toEqual([{ words: ['write', 'goal'], opts: { json: true, base: 'release', autoMerge: false, observeOnly: true, supervise: true, supervisorSource: 'default' } }]);
  });

  test('injected say without the required sentence ends with a non-zero Commander rejection', async () => {
    let called = 0;
    const { program } = productionHarness(async () => {}, undefined, undefined, async () => { called += 1; });

    await expect(program.parseAsync(['node', 'elanous', 'harness', 'say'])).rejects.toThrow(/missing required argument/i);
    expect(called).toBe(0);
  });

  test('plan without an injected handler is registered and dispatches to the default RFC path', async () => {
    const calls: string[] = [];
    const program = new Command().exitOverride();
    const harnessCmd = installHarnessCliCommand(program, {
      registerSink: async (surface) => { calls.push(`sink:${surface}`); },
      resolveSurface: async () => 'harness',
      planRfc: async (sentence, opts) => {
        calls.push(`rfc:${sentence}:${opts?.dryRun}`);
        return { path: 'docs/RFC-test.md', markdown: '# RFC', openQuestions: [], dryRun: false };
      },
    });
    const names = harnessCmd.commands.map((command) => command.name());

    expect(names).toContain('plan');
    expect(names).not.toContain('ask');
    expect(names).not.toContain('say');
    expect(harnessCmd.helpInformation()).toMatch(/^\s+plan \[options\] <sentence\.\.\.>/m);
    await program.parseAsync(['node', 'elanous', 'harness', 'plan', 'write', 'the', 'plan']);
    expect(calls).toEqual(['sink:harness', 'rfc:write the plan:false']);
  });

  test('plan is present on harness help commands only when a plan handler is injected', () => {
    const { harnessCmd } = productionHarness(async () => {}, undefined, undefined, undefined, async () => {});
    const help = harnessCmd.helpInformation();
    const names = harnessCmd.commands.map((command) => command.name());

    expect(names).toContain('plan');
    expect(names).not.toContain('ask');
    expect(names).not.toContain('say');
    expect(help).toMatch(/^\s+plan \[options\] <sentence\.\.\.>/m);
  });

  test('injected plan forwards every received sentence word with default options and still runs the sink first', async () => {
    const calls: string[] = [];
    const received: Array<{ words: string[]; opts: object }> = [];
    const { program } = productionHarness(
      async (surface) => { calls.push(`sink:${surface}`); },
      undefined,
      undefined,
      undefined,
      async (words, opts) => {
        calls.push('plan');
        received.push({ words, opts });
      },
    );

    await program.parseAsync(['node', 'elanous', 'harness', 'plan', 'write', 'the', 'plan']);

    expect(received).toEqual([{ words: ['write', 'the', 'plan'], opts: { supervise: true, supervisorSource: 'default', dryRun: false } }]);
    expect(calls).toEqual(['sink:harness', 'plan']);
  });

  test('plan help shares the ask/say common launch knobs and adds only role-llm', () => {
    const { harnessCmd } = productionHarness(async () => {}, undefined, async () => {}, async () => {}, async () => {});
    const options = (name: string) => harnessCmd.commands.find((command) => command.name() === name)!.options.map((option) => option.long);
    const common = options('ask').slice(0, 7);

    expect(options('say').slice(0, 7)).toEqual(common);
    expect(common).toEqual(['--json', '--base', '--no-auto-merge', '--merge-by-host', '--observe-only', '--no-supervise', '--dry-run']);
    // `--nested-elanous`(#24386 깊이 0 정책)는 ask/say/plan 공통 발사 손잡이다.
    expect(options('plan')).toEqual([...common, '--nested-elanous', '--role-llm']);
  });

  test('injected plan forwards common launch knobs and the repeated plan-specific role-llm values', async () => {
    const received: Array<{ words: string[]; opts: object }> = [];
    const { program } = productionHarness(
      async () => {},
      undefined,
      undefined,
      undefined,
      async (words, opts) => { received.push({ words, opts }); },
    );

    await program.parseAsync(['node', 'elanous', 'harness', 'plan', '--json', '--base', 'release', '--no-auto-merge', '--observe-only', '--role-llm', 'planning=grok/best', '--role-llm', 'review=anthropic', 'write', 'plan']);

    expect(received).toEqual([{ words: ['write', 'plan'], opts: { json: true, base: 'release', autoMerge: false, observeOnly: true, supervise: true, supervisorSource: 'default', roleLlm: ['planning=grok/best', 'review=anthropic'], dryRun: false } }]);
  });

  test('injected plan without the required sentence ends with a non-zero Commander rejection', async () => {
    let called = 0;
    const { program } = productionHarness(async () => {}, undefined, undefined, undefined, async () => { called += 1; });

    await expect(program.parseAsync(['node', 'elanous', 'harness', 'plan'])).rejects.toThrow(/missing required argument/i);
    expect(called).toBe(0);
  });

  test('injected ask failure prints one human-readable line without stack frames and leaves a non-zero exit code', async () => {
    const error = Object.assign(new Error("ENOENT: no such file or directory, open '/tmp/nope.md'"), {
      stack: "Error: hidden\n    at runAskLaunchFlow (dev-pipeline.ts:1554:1)\n    at harness-cli-command.ts:33:1",
    });
    const { program } = productionHarness(async () => {}, undefined, async () => { throw error; });

    const lines = await captureConsoleError(() => program.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/nope.md']));

    expect(lines).toEqual(["❌ ENOENT: no such file or directory, open '/tmp/nope.md'"]);
    expect(lines.join('\n')).not.toContain(' at ');
    expect(process.exitCode).toBe(1);
  });

  test('injected say and plan failures use the same one-line human-readable error surface as ask', async () => {
    const askLines: string[][] = [];
    const sayLines: string[][] = [];
    const planLines: string[][] = [];
    const failure = () => { throw new Error('goal author rejected empty request\n    at dev-pipeline.ts:1554:1'); };
    const askProgram = productionHarness(async () => {}, undefined, async () => failure()).program;
    const sayProgram = productionHarness(async () => {}, undefined, undefined, async () => failure()).program;
    const planProgram = productionHarness(async () => {}, undefined, undefined, undefined, async () => failure()).program;

    askLines.push(await captureConsoleError(() => askProgram.parseAsync(['node', 'elanous', 'harness', 'ask', '/tmp/bad.md'])));
    process.exitCode = 0;
    sayLines.push(await captureConsoleError(() => sayProgram.parseAsync(['node', 'elanous', 'harness', 'say', 'bad'])));
    process.exitCode = 0;
    planLines.push(await captureConsoleError(() => planProgram.parseAsync(['node', 'elanous', 'harness', 'plan', 'bad'])));

    expect(askLines[0]).toEqual(['❌ goal author rejected empty request']);
    expect(sayLines[0]).toEqual(askLines[0]);
    expect(planLines[0]).toEqual(askLines[0]);
    expect(planLines[0]).toHaveLength(1);
    expect(planLines[0]!.join('\n')).not.toMatch(/(^|\n)\s*at\s/m);
    expect(planLines[0]!.join('\n')).not.toContain('dev-pipeline.ts:1554:1');
    expect(process.exitCode).toBe(1);
  });

  test('live harness help-derived entrance contract covers every argument-requiring subcommand without a hand-maintained list', () => {
    const helpRun = runElanousCli(['harness', '--help']);
    expect(expectCleanIntegerExit(helpRun)).toBe(0);

    const measured = measureHarnessEntranceContract(helpRun.output, (name) => runElanousCli(['harness', name]));

    expect(measured.helpVisible).not.toContain('Canonical');
    expect(measured.helpVisible).not.toContain('Unset');
    expect(measured.helpVisible).toEqual(Array.from(new Set(measured.helpVisible)));
    expect(measured.argumentRequiringCommands).toContain('deliverable-verify');
    expect(measured.excludedNoArgumentCommands.length).toBeGreaterThan(0);
  }, 60_000);   // CLI 를 서브명령마다 띄운다 — 부하 높은 기계에서 15초는 19초로 넘었다(2026-09-26 load 285)

  test('help-derived entrance measurement automatically reaches a newly help-visible argument-requiring subcommand and reports no-argument exclusions', () => {
    const help = [
      'Usage: elanous harness [options] [command]',
      '',
      'Commands:',
      '  alpha [options] <goal-path>  requires a goal path',
      '  dotted.alias <input>         command names with dots are still measured',
      '  beta [options]               no required arguments',
      '  dynamic-new <input>          added after this test was written',
      '    Canonical description line wraps without becoming a command',
      '    Unset description line wraps without becoming a command',
      '',
    ].join('\n');
    const invoked: string[] = [];

    const measured = measureHarnessEntranceContract(help, (name) => {
      invoked.push(name);
      return { status: 1, signal: null, error: undefined, output: `error: missing required argument for ${name}\n` };
    });

    expect(measured.helpVisible).toEqual(['alpha', 'dotted.alias', 'beta', 'dynamic-new']);
    expect(measured.excludedNoArgumentCommands).toEqual(['beta']);
    expect(measured.argumentRequiringCommands).toEqual(['alpha', 'dotted.alias', 'dynamic-new']);
    expect(invoked).toEqual(['alpha', 'dotted.alias', 'dynamic-new']);
  });

  test('help-derived entrance parser fails on unparsed command-section rows instead of silently dropping them', () => {
    const help = [
      'Usage: elanous harness [options] [command]',
      '',
      'Commands:',
      '  valid <input>  measured',
      ' - invalid command indentation',
      '',
    ].join('\n');

    expect(() => parseHarnessHelpCommands(help)).toThrow(/unparsed harness help command row\(s\):\n - invalid command indentation/);
  });

  // Boundary: this automated contract measures only help visibility, no-argument non-zero exits,
  // and stack-frame suppression for argument-requiring harness subcommands. Actual mission execution
  // and parity remain manual entrance-verification checks by design, not automated assertions here.
});
