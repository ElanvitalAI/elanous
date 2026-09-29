import { describe, expect, test } from 'bun:test';
import { program } from '../index.js';

describe('top-level start registration', () => {
  test('registers start exactly once at the production CLI entry with its surface and output options', () => {
    const starts = program.commands.filter((command) => command.name() === 'start');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.parent).toBe(program);
    expect(starts[0]!.options.map((option) => option.long)).toEqual(['--gui', '--tui', '--no-login', '--json']);
    expect(starts[0]!.helpInformation()).toContain('Discover LLM, ensure Nexus is healthy');
  });

  test('keeps adjacent existing commands registered as before', () => {
    const names = program.commands.map((command) => command.name());
    for (const name of ['control', 'hooks', 'setup', 'a2a']) {
      expect(names.filter((entry) => entry === name)).toHaveLength(1);
    }
    expect(names.indexOf('hooks')).toBeLessThan(names.indexOf('setup'));
    expect(names.indexOf('setup')).toBeLessThan(names.indexOf('start'));
    expect(names.indexOf('start')).toBeLessThan(names.indexOf('a2a'));
  });
});
