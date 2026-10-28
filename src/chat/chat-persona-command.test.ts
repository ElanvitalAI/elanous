import { expect, test } from 'bun:test';
import { filterSlashCommands, SLASH_COMMANDS } from './index.js';

test('persona stays directly registered with removal suggestion but is hidden from the compact picker', () => {
  const persona = SLASH_COMMANDS.find((command) => command.name === 'persona');
  expect(persona?.hidden).toBe(true);
  expect(persona?.subcommands).toContain('-');
  const matches = filterSlashCommands('persona', SLASH_COMMANDS);
  expect(matches.map(({ name }) => name)).not.toContain('persona');
});
