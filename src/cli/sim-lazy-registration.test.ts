import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { delimiter, resolve, join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { simCli } from '../ux-sim/in-process-cli.js';

const index = new URL('../index.ts', import.meta.url).href;
const entry = resolve(import.meta.dir, '../../bin/elanous.mjs');
const cwd = resolve(import.meta.dir, '../..');
const simCommandLine = (output: string) => output.split('\n').find((line) => /^  sim\s/.test(line));

function run(args: string[]) {
  const script = `Bun.plugin({name:'sim-lazy-guard',setup(build){build.onLoad({filter:/[\\\\/]src[\\\\/]cli[\\\\/]sim-cli\\.ts$/,},()=>{throw Error('SIM_LOADED_FOR_OTHER_COMMAND')})}});\n` +
    `process.argv=['node','elanous',...${JSON.stringify(args)}];const {runCli}=await import(${JSON.stringify(index)});await runCli();`;
  return spawnSync(process.execPath, ['-e', script], { cwd, encoding: 'utf8', timeout: 45_000 });
}

function runEntry(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stateRoot?: string } = {}) {
  return simCli(args, { mode: 'spawn', allowPaths: [[], ['sim'], ['help', 'sim']], timeoutMs: 45_000, ...options });
}

function runWithReleaseRigBlocked(args: string[]) {
  const script = `Bun.plugin({name:'sim-rig-lazy-guard',setup(build){build.onLoad({filter:/[\\/]src[\\/]ux-sim[\\/]release-sim-rig\\.ts$/,},()=>{throw Error('SIM_RIG_LOADED_BEFORE_RUN')})}});\n` +
    `process.argv=['node',${JSON.stringify(entry)},...${JSON.stringify(args)}];const {runCli}=await import(${JSON.stringify(index)});await runCli();`;
  return spawnSync(process.execPath, ['-e', script], { cwd, encoding: 'utf8', timeout: 45_000 });
}

describe('lazy sim command registration', () => {
  test('sim command is present on the real root help entrypoint', async () => {
    const result = await runEntry(['--help']);
    expect({ status: result.exitCode, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(simCommandLine(result.stdout)).toBeDefined();
    expect(result.stdout.indexOf('  sim ')).toBeGreaterThan(result.stdout.indexOf('Commands:'));
  }, 180_000);
  test('root help succeeds from blank HOME and outside-Git cwd when rev-parse fails', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'elanous-help-no-git-'));
    try {
      const stubBin = join(directory, 'bin');
      const gitLog = join(directory, 'git.log');
      mkdirSync(stubBin);
      const gitStub = join(stubBin, 'git');
      writeFileSync(gitStub, [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$GIT_STUB_LOG"',
        '[ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ] && exit 1',
        'exit 0',
        '',
      ].join('\n'));
      chmodSync(gitStub, 0o755);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: directory,
        PATH: [stubBin, process.env.PATH ?? ''].filter(Boolean).join(delimiter),
        GIT_STUB_LOG: gitLog,
      };
      delete env.GIT_DIR;
      delete env.GIT_WORK_TREE;
      delete env.GIT_COMMON_DIR;
      const result = await runEntry(['--help'], { cwd: directory, env, stateRoot: join(directory, 'state') });
      expect({ status: result.exitCode, stderr: result.stderr }).toMatchObject({ status: 0 });
      expect(result.stdout).toContain('sim');
      expect(existsSync(gitLog)).toBe(true);
      expect(readFileSync(gitLog, 'utf8')).toContain('rev-parse HEAD');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
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
      const releaseRig = resolve(cwd, 'scenarios/ux-sim/release-sim-rig.yaml');
      const release = spawnSync(process.execPath, ['-e',
        `const { program } = await import(${JSON.stringify(index)});` +
        `process.argv=['node','elanous','sim','run',${JSON.stringify(releaseRig)}];await program.parseAsync(process.argv);`,
      ], { cwd, encoding: 'utf8', timeout: 45_000 });
      expect(release.status).toBe(2);
      expect(release.stderr).toContain('scenario runner requires --test isolated mode');
      expect(release.stderr).not.toContain('release simulation rig requires --test isolated mode');
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
  test('sim help registers without loading the release simulation rig', () => {
    const result = runWithReleaseRigBlocked(['sim', '--help']);
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(result.stdout).toContain('run <scenario-file>');
    expect(result.stderr).not.toContain('SIM_RIG_LOADED_BEFORE_RUN');
    const releaseRig = resolve(cwd, 'scenarios/ux-sim/release-sim-rig.yaml');
    const run = runWithReleaseRigBlocked(['--test', 'sim', 'run', releaseRig]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('SIM_RIG_LOADED_BEFORE_RUN');
  }, 60_000);
  test('selected help imports the registrar while unrelated help does not', () => {
    for (const args of [['sim', '--help'], ['help', 'sim'], ['--help'], ['--help-all']]) {
      const selected = run(args);
      expect(selected.status).not.toBe(0);
      expect(selected.stderr).toContain('SIM_LOADED_FOR_OTHER_COMMAND');
    }
    const unrelated = run(['logs', '--help']);
    expect({ status: unrelated.status, stderr: unrelated.stderr }).toMatchObject({ status: 0 });
    expect(unrelated.stdout).toContain('logs');
    expect(unrelated.stderr).not.toContain('SIM_LOADED_FOR_OTHER_COMMAND');
  }, 60_000);
});
