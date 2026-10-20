import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerPrCommands } from './pr-cli.js';
import { program } from '../index.js';

const cwd = resolve(import.meta.dir, '../..');
const entry = resolve(cwd, 'bin/elanous.mjs');
const index = resolve(cwd, 'src/index.ts');
const guard = `Bun.plugin({ setup(b) { b.onLoad({ filter: new RegExp('cli' + String.fromCharCode(47) + 'pr-cli[.]ts$') }, () => { throw new Error('PR_REGISTRAR_LOADED'); }); } });`;

function direct(args: string[], method: 'parse' | 'parseAsync' = 'parseAsync', guarded = false) {
  const script = `${guarded ? guard : ''} const { program } = await import(${JSON.stringify(index)});` +
    ` await program.${method}(${JSON.stringify(['node', 'elanous', ...args])});`;
  return spawnSync(process.execPath, ['-e', script], { cwd, encoding: 'utf8', timeout: 45_000 });
}

function installed(args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8', timeout: 45_000 });
}

describe('lazy PR command registration', () => {
  test('lightweight declaration exactly matches the executable registrar tree', () => {
    const full = new Command();
    registerPrCommands(full);
    const shape = (command: Command): unknown => ({
      name: command.name(), description: command.description(),
      options: command.options.map(option => ({ flags: option.flags, description: option.description, defaultValue: option.defaultValue, required: option.required })),
      children: command.commands.map(shape),
    });
    expect(shape(program.commands.find(command => command.name() === 'pr')!))
      .toEqual(shape(full.commands.find(command => command.name() === 'pr')!));
  });

  test('previously obtained PR shell and child references execute on direct parse', () => {
    for (const selected of ['child', 'shell']) {
      const script = `const { program } = await import(${JSON.stringify(index)});` +
        `const pr = program.commands.find(c => c.name() === 'pr');` +
        `const child = pr.commands.find(c => c.name() === 'land');` +
        `console.log('BEFORE=' + Boolean(child._actionHandler));` +
        `await ${selected === 'child' ? 'child' : 'pr'}.parseAsync(${JSON.stringify(selected === 'child' ? ['--pr', 'not-a-number', '--expected-head', 'invalid'] : ['land', '--pr', 'not-a-number', '--expected-head', 'invalid'])}, {from:'user'});` +
        `console.log('AFTER=' + Boolean(child._actionHandler));`;
      const result = spawnSync(process.execPath, ['-e', script], { cwd, encoding: 'utf8', timeout: 30_000 });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('BEFORE=false');
      expect(result.stdout).toContain('AFTER=false');
      expect(result.stderr).toContain('expected-head:');
    }
  }, 70_000);

  test('unrelated parse does not import PR, selected PR and root help do', () => {
    for (const args of [['logs', '--help'], ['help', 'logs'], ['--config-dir', 'pr', 'logs', '--help']]) {
      const unrelated = direct(args, 'parseAsync', true);
      expect(unrelated.status).toBe(0);
      expect(unrelated.stderr).not.toContain('PR_REGISTRAR_LOADED');
    }
    for (const args of [['pr', '--help'], ['help', 'pr'], ['--help'], ['--help-all'], ['--test', '--help-all'], ['help'], []]) {
      const selected = direct(args, 'parseAsync', true);
      expect(selected.status).not.toBe(0);
      expect(selected.stderr).toContain('PR_REGISTRAR_LOADED');
    }
  }, 120_000);

  test('preselection does not fire Commander option events twice', () => {
    for (const method of ['parse', 'parseAsync'] as const) {
      const script = `const { program } = await import(${JSON.stringify(index)});` +
        `let count = 0; program.on('option:test', () => count++);` +
        `program.exitOverride(); program.configureOutput({writeOut() {},writeErr() {}});` +
        `try { await program.${method}(['--test','--help'],{from:'user'}); } catch (e) {` +
        `if (e.code !== 'commander.helpDisplayed') throw e; } console.log(count);`;
      const child = spawnSync(process.execPath, ['-e', script], { cwd, encoding: 'utf8', timeout: 45_000 });
      expect(child.status).toBe(0);
      expect(child.stdout.trim()).toBe('1');
    }
  }, 100_000);

  test('installed and direct synchronous/asynchronous PR help remain equal', () => {
    const baseline = installed(['pr', '--help']);
    expect(baseline.status).toBe(0);
    for (const method of ['parse', 'parseAsync'] as const) {
      for (const args of [['pr', '--help'], ['help', 'pr'], ['--test', 'pr', '--help']]) {
        const actual = direct(args, method);
        expect(actual.status).toBe(0);
        expect(actual.stdout).toBe(baseline.stdout);
        expect(actual.stdout).toContain('land');
      }
    }
    expect(installed(['help', 'pr']).stdout).toBe(baseline.stdout);
  }, 180_000);
});
