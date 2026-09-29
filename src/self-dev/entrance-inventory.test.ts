import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Command, Option } from 'commander';
import { collectCommandEntrances, renderCommandEntrances } from './entrance-inventory.js';
import { program } from '../index.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bin = resolve(repositoryRoot, 'bin/elanous.mjs');

describe('collectCommandEntrances', () => {
  test('recursively derives primary paths, aliases, direct options, and lexical ordering from a Commander tree', () => {
    const root = new Command();
    const zebra = root.command('zebra').description('zebra command').option('--zebra <value>', 'zebra option');
    const alpha = root.command('alpha').description('alpha command').alias('a').addOption(new Option('--hidden').hideHelp());
    alpha.command('nested').description('nested command').option('--nested', 'nested option');
    zebra.command('child').description('zebra child');

    expect(collectCommandEntrances(root)).toEqual([
      {
        path: ['alpha'], name: 'alpha', description: 'alpha command', aliases: ['a'],
        options: [{ flags: '--hidden', description: '' }],
      },
      {
        path: ['alpha', 'nested'], name: 'nested', description: 'nested command', aliases: [],
        options: [{ flags: '--nested', description: 'nested option' }],
      },
      {
        path: ['zebra'], name: 'zebra', description: 'zebra command', aliases: [],
        options: [{ flags: '--zebra <value>', description: 'zebra option' }],
      },
      {
        path: ['zebra', 'child'], name: 'child', description: 'zebra child', aliases: [], options: [],
      },
    ]);
  });

  test('reads a command added to the exported assembled program after source assembly', () => {
    const name = `inventory-test-${Date.now()}`;
    const added = program.command(name).description('runtime inventory test command');
    try {
      expect(collectCommandEntrances(program)).toContainEqual(expect.objectContaining({ path: [name], name }));
    } finally {
      (program.commands as Command[]).splice(program.commands.indexOf(added), 1);
    }
  });

  test('the CLI consumer reports the registered root-command count and the same inventory', () => {
    const result = spawnSync('bun', [bin, '--test', 'self', 'entrances', '--json'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NODE_ENV: 'test', ELANOUS_DEBUG_LEVEL: 'off' },
    });
    if (result.error) throw result.error;
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);

    const output = JSON.parse(result.stdout) as { rootCommandCount: number; entrances: ReturnType<typeof collectCommandEntrances> };
    expect(output.rootCommandCount).toBe(program.commands.length);
    expect(output.entrances).toEqual(collectCommandEntrances(program));
    expect(renderCommandEntrances(output.entrances, output.rootCommandCount)).toContain(`root commands: ${program.commands.length}`);
  }, 60_000);
});
