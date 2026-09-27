import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { registerOpsCommands } from './ops-cli.js';
import { registerPublishCommands } from './publish-cli.js';

// Captured from the pre-extraction src/index.ts Commander tree (including declaration order).
const before = {
  ops: [
    { name: 'ops', flags: [] },
    { name: 'status', flags: ['--json', '--all-instances', '--include-test', '-r', '--remote <name>'] },
    { name: 'health', flags: ['--json'] },
    { name: 'timeline', flags: ['--entity-type <t>', '--event <e>', '--since-hours <n>', '--limit <n>', '--json'] },
    { name: 'mission', flags: ['--json'] },
    { name: 'mission-log', flags: ['-n, --lines <n>', '--json'] },
    { name: 'build', flags: ['--stop', '--all', '--follow', '--tail <n>', '--json'] },
  ],
  publish: [
    { name: 'publish', flags: [] },
    { name: 'gc', flags: ['--root <dir>', '--json'] },
    { name: 'catalog', flags: ['--root <dir>', '--json'] },
    { name: 'file', flags: ['--json'] },
  ],
};

describe('G6b extracted command registration', () => {
  test('preserves top-level and subcommand order and option flags', () => {
    const program = new Command();
    registerOpsCommands(program);
    registerPublishCommands(program);
    expect(program.commands.map((command) => command.name())).toEqual(['ops', 'publish']);
    for (const command of program.commands) {
      expect([command, ...command.commands].map((entry) => ({
        name: entry.name(),
        flags: entry.options.map((option) => option.flags),
      }))).toEqual(before[command.name() as keyof typeof before]);
    }
  });

  test('index delegates registration instead of retaining inline ops/publish blocks', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/program\.command\(['"](?:ops|publish)['"]\)/);
    expect((source.match(/^registerOpsCommands\(program\);$/gm) ?? []).length).toBe(1);
    expect((source.match(/^registerPublishCommands\(program\);$/gm) ?? []).length).toBe(1);
    expect(source.indexOf('registerOpsCommands(program);')).toBeLessThan(source.indexOf('registerPublishCommands(program);'));
    expect(source.indexOf('registerPublishCommands(program);')).toBeGreaterThan(source.indexOf("autopilotCmd.command('negotiate <id> <phase>')"));
  });
});
