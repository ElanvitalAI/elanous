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

type Shape = { name: string; flags: string[] };

const shapeOf = (command: Command): Shape[] => [command, ...command.commands].map((entry) => ({
  name: entry.name(),
  flags: entry.options.map((option) => option.flags),
}));

/** Every captured entry is still present, in the captured order, with its captured flags. Later additions are allowed. */
function expectCapturedOrderKept(actual: Shape[], captured: Shape[]): void {
  let cursor = 0;
  for (const want of captured) {
    const at = actual.findIndex((entry, index) => index >= cursor && entry.name === want.name);
    expect({ name: want.name, found: at !== -1 }).toEqual({ name: want.name, found: true });
    const flags = actual[at]!.flags;
    expect(want.flags.filter((flag) => !flags.includes(flag))).toEqual([]);
    cursor = at + 1;
  }
}

describe('G6b extracted command registration', () => {
  test('extracted ops and publish registration keeps the pre-extraction commands in order with their flags', () => {
    const program = new Command();
    registerOpsCommands(program);
    registerPublishCommands(program);
    expect(program.commands.map((command) => command.name())).toEqual(['ops', 'publish']);
    for (const command of program.commands) {
      expectCapturedOrderKept(shapeOf(command), before[command.name() as keyof typeof before]);
    }
  });

  test('real CLI root exposes exactly one ops and one publish tree that keep the captured commands and flags', () => {
    const roots = entryProgram.commands.filter((command) => ['ops', 'publish'].includes(command.name()));
    expect(roots.map((command) => command.name())).toEqual(['ops', 'publish']);
    for (const command of roots) {
      const shape = shapeOf(command);
      // One registration per subcommand: a second register call would repeat every captured name.
      for (const want of before[command.name() as keyof typeof before]) {
        expect({ name: want.name, count: shape.filter((entry) => entry.name === want.name).length }).toEqual({ name: want.name, count: 1 });
      }
      expectCapturedOrderKept(shape, before[command.name() as keyof typeof before]);
    }
  });
});
