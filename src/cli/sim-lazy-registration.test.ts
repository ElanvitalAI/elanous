import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const entry = resolve(import.meta.dir, '../../bin/elanous.mjs');
const index = new URL('../index.ts', import.meta.url).href;
const cwd = resolve(import.meta.dir, '../..');
const simCommandLine = (output: string) => output.split('\n').find((line) => /^  sim\s/.test(line));

function run(args: string[], forbidSim = false) {
  const script = `Bun.plugin({name:'sim-lazy-guard',setup(build){build.onLoad({filter:/[\\\\/]src[\\\\/]cli[\\\\/]sim-cli\\.ts$/,},()=>{throw Error('SIM_LOADED_FOR_OTHER_COMMAND')})}});\n` +
    `process.argv=['node',${JSON.stringify(entry)},...${JSON.stringify(args)}];const {runCli}=await import(${JSON.stringify(index)});await runCli();`;
  return spawnSync(process.execPath, forbidSim ? ['-e', script] : [entry, ...args], {
    cwd, encoding: 'utf8', timeout: 45_000,
  });
}

describe('lazy sim command registration', () => {
  test('selected sim and all root help modes retain the command', () => {
    for (const args of [['sim', '--help'], ['help', 'sim'], ['--help'], ['--help-all'], ['--help', '-h'], ['-h', '--help']]) {
      const result = run(args);
      expect({ args, status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
      expect(result.stdout).toContain('sim');
      if (args[0]?.startsWith('-')) {
        expect(simCommandLine(result.stdout)).toBeDefined();
        expect(result.stdout.indexOf('  sim ')).toBeGreaterThan(result.stdout.indexOf('Commands:'));
      }
    }
    const canonicalHelp = run(['--help']);
    for (const flags of [['--help', '-h'], ['-h', '--help']]) {
      expect(run(flags).stdout).toBe(canonicalHelp.stdout);
    }
  }, 180_000);
  test('exported Commander program supports sim run without runCli', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'elanous-sim-direct-'));
    const missing = resolve(directory, 'missing-scenario.yaml');
    try {
      const script = `const { program } = await import(${JSON.stringify(index)});` +
        `process.argv=['node','elanous','sim','run',${JSON.stringify(missing)}];await program.parseAsync(process.argv);`;
      const child = spawnSync(process.execPath, ['-e', script], {
        cwd, encoding: 'utf8', timeout: 45_000,
      });
      expect(child.status).toBe(2);
      expect(child.stderr).toContain('sim run:');
      expect(child.stderr).toContain('scenario runner requires --test isolated mode');
      expect(child.stderr).not.toContain("unknown command 'run'");
      const sync = spawnSync(process.execPath, ['-e',
        `const { program } = await import(${JSON.stringify(index)});` +
        `process.argv=['node','elanous','sim','run',${JSON.stringify(missing)}];program.parse(process.argv);`,
      ], { cwd, encoding: 'utf8', timeout: 45_000 });
      expect(sync.status).toBe(2);
      expect(sync.stderr).toContain('scenario runner requires --test isolated mode');
      expect(sync.stderr).not.toContain("unknown command 'run'");
      for (const source of ['parse', 'parseAsync'] as const) {
        const rootHelp = spawnSync(process.execPath, ['-e',
          `const { program } = await import(${JSON.stringify(index)});` +
          `await program.${source}(['--test','--help'],{from:'user'});`,
        ], { cwd, encoding: 'utf8', timeout: 45_000 });
        expect(rootHelp.status).toBe(0);
        expect(simCommandLine(rootHelp.stdout)).toBeDefined();
        const simHelp = spawnSync(process.execPath, ['-e',
          `const { program } = await import(${JSON.stringify(index)});` +
          `await program.${source}(['--test','sim','--help'],{from:'user'});`,
        ], { cwd, encoding: 'utf8', timeout: 45_000 });
        expect(simHelp.status).toBe(0);
        expect(simHelp.stdout).toContain('run <scenario-file>');
        const selected = spawnSync(process.execPath, ['-e',
          `const { program } = await import(${JSON.stringify(index)});` +
          `await program.${source}(['--','sim','run',${JSON.stringify(missing)}],{from:'user'});`,
        ], { cwd, encoding: 'utf8', timeout: 45_000 });
        expect(selected.status).toBe(2);
        expect(selected.stderr).toContain('scenario runner requires --test isolated mode');
        expect(selected.stderr).not.toContain("unknown command 'run'");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
  test('selected help imports the registrar while unrelated help does not', () => {
    for (const args of [['sim', '--help'], ['help', 'sim'], ['--help'], ['--help-all']]) {
      const selected = run(args, true);
      expect(selected.status).not.toBe(0);
      expect(selected.stderr).toContain('SIM_LOADED_FOR_OTHER_COMMAND');
    }
    const unrelated = run(['logs', '--help'], true);
    expect({ status: unrelated.status, stderr: unrelated.stderr }).toMatchObject({ status: 0 });
    expect(unrelated.stdout).toContain('logs');
    expect(unrelated.stderr).not.toContain('SIM_LOADED_FOR_OTHER_COMMAND');
  }, 60_000);
});
