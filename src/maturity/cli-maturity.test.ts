import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { program } from '../index';
import { buildUserConfig, parseCliHelpRole } from '../user-config';
import { FEATURE_MATURITY } from './feature-maturity';
import { cliRootMaturity, cliRootVisibleFor, filterCliRootHelp } from './cli-maturity';

function helpNames(command: Command): string[] {
  const lines = command.helpInformation().split('\n');
  const start = lines.findIndex(line => line.trim() === 'Commands:');
  return lines.slice(start + 1).filter(line => /^  [a-z]/.test(line)).map(line => line.trim().split(/[\s|]+/)[0]!).filter(name => name !== 'help');
}

const commands = program.commands;
const grades = FEATURE_MATURITY.cliRoot;
const names = commands.map(command => command.name());
const system = ['repro', 'run-detached', 'dogfood', 'run'];

describe('MAT1a CLI root maturity', () => {
  test('registered canonical names have exactly one grade and docs classify the stable set', () => {
    expect(new Set(names).size).toBe(names.length);
    for (const command of commands) expect(cliRootMaturity(command.name())).toBeDefined();
    expect(Object.keys(grades).sort()).toEqual([...names, ...system.filter(name => !names.includes(name))].sort());
    const doc = readFileSync(join(import.meta.dir, '../../release/public/docs/commands.md'), 'utf8');
    const documented = new Set([...doc.matchAll(/elanous ([a-z][a-z:-]*)/g)].map(match => match[1]));
    expect(documented.size).toBe(23);
    expect(names.filter(name => cliRootMaturity(name) === 'stable').sort())
      .toEqual(names.filter(name => documented.has(name) || commands.find(c => c.name() === name)!.aliases().some(alias => documented.has(alias))).sort());
    expect(Object.entries(grades).filter(([, grade]) => grade === 'system').map(([name]) => name).sort()).toEqual([...system].sort());
    for (const name of names) if (cliRootMaturity(name) !== 'stable' && cliRootMaturity(name) !== 'system')
      expect(cliRootMaturity(name)).toBe('beta');
  });

  test('ungraded newly registered command fails by name', () => {
    const root = new Command();
    root.command('ungraded');
    expect(() => filterCliRootHelp(root.commands, 'owner', false)).toThrow('cliRoot 에 등급 없는 명령: ungraded');
  });

  test('aliases inherit the grade and unknown commands fail closed', () => {
    expect(cliRootMaturity('update')).toBe(cliRootMaturity('self-update'));
    expect(cliRootMaturity('sched')).toBe(cliRootMaturity('scheduler'));
    for (const command of commands) for (const alias of command.aliases())
      expect(cliRootMaturity(alias)).toBe(cliRootMaturity(command.name()));
    expect(cliRootVisibleFor('not-a-command', 'owner', { showAll: true })).toBe(false);
    expect(cliRootMaturity('dogfood')).toBe('system');
    expect(cliRootVisibleFor('dogfood', 'owner', { showAll: true })).toBe(false);
  });

  test('real Commander help matches each role and --help-all, without losing executable commands', () => {
    for (const role of ['owner', 'contributor', 'general'] as const) for (const showAll of [false, true]) {
      const expected = names.filter(name => cliRootVisibleFor(name, role, { showAll }));
      const result = filterCliRootHelp(commands, role, showAll);
      expect(result).toEqual({ shown: expected.length, hidden: names.length - expected.length });
      expect(helpNames(program).sort()).toEqual(expected.sort());
    }
    filterCliRootHelp(commands, 'general', false);
    expect(commands.find(c => c.name() === 'pty')).toBeDefined();
    expect(program.options.some(option => option.long === '--help-all')).toBe(true);
    filterCliRootHelp(commands, 'owner', false);
  });

  test('real isolated CLI help switches roles, help-all, and direct hidden-command help', () => {
    const root = join(import.meta.dir, '../..');
    // A fresh checkout (Linux gate Pod) has no .elanous-test yet — mkdtemp needs the parent.
    mkdirSync(join(root, '.elanous-test'), { recursive: true });
    const dir = mkdtempSync(join(root, '.elanous-test/maturity-cli-'));
    const config = join(dir, 'config.json');
    const invoke = (...args: string[]) => spawnSync('bun', ['bin/elanous.mjs', `--test=${dir}`, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', XDG_CONFIG_HOME: '', ELANOUS_CONFIG_DIR: '', ELANOUS_STATE_DIR: dir },
    });
    try {
      writeFileSync(config, JSON.stringify({ cli: { helpRole: 'general' } }));
      const general = invoke('--help');
      expect(general.status).toBe(0);
      expect(general.stdout).toContain('  chat ');
      expect(general.stdout).not.toContain('  pty ');
      const listed = (output: string) => output.split('Commands:\n')[1]?.split('\n\n')[0]?.split('\n')
        .filter(line => /^  [a-z]/.test(line) && !line.startsWith('  help '))
        .map(line => line.trim().split(/[\s|]+/)[0]) ?? [];
      expect(listed(general.stdout).sort()).toEqual(names.filter(name => grades[name as keyof typeof grades] === 'stable').sort());
      writeFileSync(config, '{}');
      const owner = invoke('--help');
      expect(owner.status).toBe(0);
      expect(listed(owner.stdout).sort()).toEqual(names.filter(name => grades[name as keyof typeof grades] !== 'system').sort());
      writeFileSync(config, JSON.stringify({ cli: { helpRole: 'general' } }));
      const direct = invoke('pty', '--help');
      expect(direct.status).toBe(0);
      expect(direct.stdout).toContain('Usage:');
      const all = invoke('--help-all');
      expect(all.status).toBe(0);
      expect(all.stdout).toContain('  pty ');
      expect(all.stdout).not.toContain('  repro ');
      expect(listed(all.stdout).sort()).toEqual(names.filter(name => grades[name as keyof typeof grades] !== 'system').sort());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20000);

  test('config helpRole defaults to owner and accepts only three role values', () => {
    for (const raw of [null, false, [], {}, { helpRole: 'invalid' }]) expect(parseCliHelpRole(raw)).toBe('owner');
    for (const role of ['owner', 'contributor', 'general'] as const)
      expect(parseCliHelpRole({ helpRole: role })).toBe(role);
    const dir = mkdtempSync(join(tmpdir(), 'elanous-maturity-'));
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ cli: { helpRole: 'general' } }));
      expect(buildUserConfig(path).cli?.helpRole).toBe('general');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
