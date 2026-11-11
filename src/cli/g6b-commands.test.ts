import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { program as entryProgram } from '../index.js';
import { registerOpsCommands } from './ops-cli.js';
import { registerPublishCommands } from './publish-cli.js';

// Captured from the pre-extraction src/index.ts Commander tree (including declaration order).
const before = {
  ops: [
    { name: 'ops', flags: [] },
    // SYNC1 ② (#22883) added `ops now-refresh` after the extraction.
    { name: 'now-refresh', flags: ['--once', '--dry-run', '--json'] },
    { name: 'status', flags: ['--json', '--all-instances', '--include-test', '-r', '--remote <name>'] },
    // OVW-CLI (0.2.21) added `ops overview` after `status`.
    { name: 'overview', flags: ['--json', '--watch [seconds]', '--since <window>', '--owner <owner>', '--version <v>'] },
    { name: 'health', flags: ['--json'] },
    { name: 'timeline', flags: ['--entity-type <t>', '--event <e>', '--since-hours <n>', '--limit <n>', '--json'] },
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

  test('real CLI root exposes one ops and publish tree in registration order', () => {
    const roots = entryProgram.commands.filter((command) => ['ops', 'publish'].includes(command.name()));
    expect(roots.map((command) => command.name())).toEqual(['ops', 'publish']);
    for (const command of roots) {
      expect([command, ...command.commands].map((entry) => ({
        name: entry.name(),
        flags: entry.options.map((option) => option.flags),
      }))).toEqual(before[command.name() as keyof typeof before]);
    }
  });
});
